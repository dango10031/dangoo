import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SkillMetadata, SkillRegistryLike, SkillSnapshot } from '../contracts/index.js';

/*
 * This is a clean TypeScript rewrite of the lifecycle and precedence behaviour
 * described by Codex core-skills/src/model.rs, loader.rs, service.rs and
 * injection.rs. It intentionally has no Codex home-directory, plugin, account,
 * or executor dependency; Dangoo owns approved roots and resource access.
 */

export type DangooSkillScope = SkillMetadata['scope'] | 'canvas';

export interface SkillRootSpec {
  path: string;
  scope: DangooSkillScope;
  /** Optional stable root identity for replacing a previous discovery result. */
  id?: string;
}

export interface SkillPackageInput {
  name: string;
  description: string;
  revision?: string;
  scope?: DangooSkillScope;
  enabled?: boolean;
  implicit?: boolean;
  dependencies?: string[];
  content: string;
  path?: string;
  rootPath?: string;
  resources?: Record<string, string | Uint8Array>;
}

export interface SkillRegistrationInput {
  metadata: SkillMetadata;
  content: string;
  resources?: Record<string, string | Uint8Array>;
}

export interface SkillRegistryOptions {
  roots?: SkillRootSpec[];
  packages?: SkillPackageInput[];
  maxDepth?: number;
  maxFilesPerRoot?: number;
  maxSkillBytes?: number;
  maxResourceBytes?: number;
}

export interface SkillResolveOptions {
  revision?: string;
  explicit?: boolean;
  implicit?: boolean;
}

export interface SkillDiscoveryError {
  path: string;
  message: string;
}

export interface SkillDiscoveryResult {
  readonly snapshot: SkillSnapshot;
  readonly discovered: readonly SkillMetadata[];
  readonly errors: readonly SkillDiscoveryError[];
}

export class SkillRegistryError extends Error {
  readonly code:
    | 'invalid_metadata'
    | 'not_found'
    | 'disabled'
    | 'ambiguous'
    | 'dependency'
    | 'path'
    | 'resource'
    | 'size';

  constructor(message: string, code: SkillRegistryError['code']) {
    super(message);
    this.name = 'SkillRegistryError';
    this.code = code;
  }
}

interface StoredSkill {
  readonly key: string;
  readonly metadata: SkillMetadata;
  readonly scope: DangooSkillScope;
  readonly content: string;
  readonly contentHash: string;
  readonly packageRoot?: string;
  readonly filePath?: string;
  readonly resources: ReadonlyMap<string, string>;
  /** True when discovery read the package inventory for this snapshot. */
  readonly resourcesComplete: boolean;
  readonly originRoot?: string;
}

interface SnapshotRecord {
  readonly byKey: ReadonlyMap<string, StoredSkill>;
  readonly byName: ReadonlyMap<string, readonly StoredSkill[]>;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_SKILL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

function hash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return 'null';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freezeMetadata(metadata: SkillMetadata): SkillMetadata {
  const dependencies = Object.freeze([...metadata.dependencies]);
  return Object.freeze({ ...metadata, dependencies }) as SkillMetadata;
}

function scopePriority(scope: DangooSkillScope): number {
  switch (scope) {
    case 'canvas':
      return 400;
    case 'workspace':
      return 300;
    case 'user':
      return 200;
    case 'builtin':
      return 100;
    default:
      return 0;
  }
}

function scopeFrom(value: unknown, fallback: DangooSkillScope): DangooSkillScope {
  if (value === undefined) return fallback;
  if (value === 'builtin' || value === 'workspace' || value === 'user' || value === 'canvas') {
    return value;
  }
  throw new SkillRegistryError('Skill scope must be builtin, workspace, user, or canvas', 'invalid_metadata');
}

function booleanFrom(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : value === true;
}

function dependenciesFrom(value: unknown): string[] {
  if (value === undefined) return [];
  if (isRecord(value)) {
    // Codex-style manifests commonly nest tool/skill dependencies under a
    // `tools` key. The registry records stable dependency names and leaves
    // execution to the host's registered tool layer.
    return dependenciesFrom(value.skills ?? value.dependencies ?? value.tools);
  }
  if (!Array.isArray(value)) throw new SkillRegistryError('Skill dependencies must be an array', 'invalid_metadata');
  const output: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) output.push(item.trim());
    else if (isRecord(item)) {
      const name = item.name ?? item.id ?? item.value ?? item.skill;
      if (typeof name === 'string' && name.trim()) output.push(name.trim());
      else throw new SkillRegistryError('Skill dependency has no name', 'invalid_metadata');
    } else {
      throw new SkillRegistryError('Skill dependency has an invalid shape', 'invalid_metadata');
    }
  }
  return [...new Set(output)];
}

function frontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const normalized = content.replace(/^\uFEFF/, '');
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) throw new SkillRegistryError('Skill file is missing YAML frontmatter', 'invalid_metadata');
  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch {
    throw new SkillRegistryError('Skill YAML frontmatter is invalid', 'invalid_metadata');
  }
  if (!isRecord(data)) throw new SkillRegistryError('Skill YAML frontmatter must be an object', 'invalid_metadata');
  return { data, body: normalized.slice(match[0].length) };
}

function ensureWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizedResourcePath(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) {
    throw new SkillRegistryError('Invalid skill resource path', 'path');
  }
  const portable = relativePath.replaceAll('\\', '/');
  if (portable.startsWith('/') || /^[A-Za-z]:/.test(portable)) {
    throw new SkillRegistryError('Skill resource path must be relative', 'path');
  }
  const parts = portable.split('/');
  if (parts.some((part) => part === '..')) {
    throw new SkillRegistryError('Skill resource path escapes its package', 'path');
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new SkillRegistryError('Skill resource path escapes its package', 'path');
  }
  return normalized;
}

function metadataFromPackage(input: SkillPackageInput, contentHash: string): SkillMetadata {
  if (!input.name || typeof input.name !== 'string' || !input.name.trim() || input.name.includes('/') || input.name.includes('\\')) {
    throw new SkillRegistryError('Skill name must be a non-empty identifier', 'invalid_metadata');
  }
  if (!input.description || typeof input.description !== 'string') {
    throw new SkillRegistryError('Skill description is required', 'invalid_metadata');
  }
  const revision = input.revision?.trim() || `content-${contentHash}`;
  const scope = input.scope ?? 'workspace';
  if (!['builtin', 'workspace', 'user', 'canvas'].includes(scope)) {
    throw new SkillRegistryError('Skill scope is invalid', 'invalid_metadata');
  }
  const metadata = freezeMetadata({
    name: input.name.trim(),
    description: input.description.trim(),
    revision,
    scope: scope as SkillMetadata['scope'],
    enabled: input.enabled ?? true,
    implicit: input.implicit ?? true,
    dependencies: dependenciesFrom(input.dependencies),
    path: input.path ?? input.rootPath ?? input.name,
  });
  // `SkillMetadata` is the stable public contract. contentHash is an additive
  // catalog field used to distinguish same-version hot updates without
  // changing that contract's required fields.
  return freezeMetadata({ ...metadata, contentHash } as SkillMetadata & { contentHash: string });
}

function mapRecords(records: Iterable<StoredSkill>): SnapshotRecord {
  const byKey = new Map<string, StoredSkill>();
  const byName = new Map<string, readonly StoredSkill[]>();
  for (const record of records) {
    byKey.set(record.key, record);
    const list = [...(byName.get(record.metadata.name) ?? []), record];
    byName.set(record.metadata.name, list);
  }
  for (const [name, list] of byName) {
    const sorted = [...list].sort((a, b) => {
      const priority = scopePriority(b.scope) - scopePriority(a.scope);
      return priority || a.metadata.revision.localeCompare(b.metadata.revision) || a.key.localeCompare(b.key);
    });
    byName.set(name, Object.freeze(sorted));
  }
  return { byKey, byName };
}

export class SkillRegistry implements SkillRegistryLike {
  private readonly records = new Map<string, StoredSkill>();
  private readonly roots: SkillRootSpec[];
  private readonly rootRecordKeys = new Map<string, Set<string>>();
  private readonly snapshotStates = new WeakMap<SkillSnapshot, SnapshotRecord>();
  private readonly history = new Map<string, SkillSnapshot>();
  private discoveryErrors: SkillDiscoveryError[] = [];
  private current: SkillSnapshot;
  private snapshotCounter = 0;
  private readonly maxDepth: number;
  private readonly maxFilesPerRoot: number;
  private readonly maxSkillBytes: number;
  private readonly maxResourceBytes: number;

  constructor(options?: SkillRegistryOptions | SkillPackageInput[]) {
    const normalized = Array.isArray(options) ? { packages: options } : options ?? {};
    this.roots = [...(normalized.roots ?? [])].map((root) => ({ ...root }));
    this.maxDepth = Math.max(0, normalized.maxDepth ?? DEFAULT_MAX_DEPTH);
    this.maxFilesPerRoot = Math.max(1, normalized.maxFilesPerRoot ?? DEFAULT_MAX_FILES);
    this.maxSkillBytes = Math.max(1, normalized.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES);
    this.maxResourceBytes = Math.max(1, normalized.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES);
    for (const pkg of normalized.packages ?? []) this.register(pkg);
    this.current = this.makeSnapshot();
  }

  snapshot(): SkillSnapshot {
    return this.current;
  }

  errors(): readonly SkillDiscoveryError[] {
    return Object.freeze(this.discoveryErrors.slice());
  }

  register(input: SkillPackageInput | SkillMetadata | SkillRegistrationInput, content?: string, resources?: Record<string, string | Uint8Array>): SkillSnapshot {
    const packageInput = this.toPackageInput(input, content, resources);
    const bytes = new TextEncoder().encode(packageInput.content).byteLength;
    if (bytes > this.maxSkillBytes) throw new SkillRegistryError('Skill body exceeds the configured byte limit', 'size');
    const contentHash = hash(`${stableJson(packageInput)}\n${packageInput.content}`);
    const metadata = metadataFromPackage(packageInput, contentHash);
    const packageRoot = packageInput.rootPath ? path.resolve(packageInput.rootPath) : undefined;
    const filePath = packageInput.path ? path.resolve(packageInput.path) : undefined;
    const resourceMap = new Map<string, string>();
    for (const [resourcePath, value] of Object.entries(packageInput.resources ?? {})) {
      const normalizedPath = normalizedResourcePath(resourcePath);
      const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
      if (new TextEncoder().encode(text).byteLength > this.maxResourceBytes) {
        throw new SkillRegistryError('Skill resource exceeds the configured byte limit', 'size');
      }
      resourceMap.set(normalizedPath, text);
    }
    const scope = (metadata.scope as DangooSkillScope) || 'workspace';
    const key = `${metadata.name}\0${scope}\0${metadata.revision}\0${filePath ?? metadata.path}`;
    const record: StoredSkill = Object.freeze({
      key,
      metadata,
      scope,
      content: packageInput.content,
      contentHash,
      packageRoot,
      filePath,
      resources: resourceMap,
      resourcesComplete: packageInput.resources !== undefined,
      originRoot: packageRoot,
    });
    this.records.set(key, record);
    this.invalidateCaches();
    return this.current;
  }

  update(input: SkillPackageInput | SkillMetadata | SkillRegistrationInput, content?: string, resources?: Record<string, string | Uint8Array>): SkillSnapshot {
    return this.register(input, content, resources);
  }

  disable(name: string, revision?: string): SkillSnapshot {
    this.setEnabled(name, false, revision);
    return this.current;
  }

  enable(name: string, revision?: string): SkillSnapshot {
    this.setEnabled(name, true, revision);
    return this.current;
  }

  remove(name: string, revision?: string): SkillSnapshot {
    for (const [key, record] of this.records) {
      if (record.metadata.name === name && (!revision || record.metadata.revision === revision)) this.records.delete(key);
    }
    this.invalidateCaches();
    return this.current;
  }

  /** Explicit cache invalidation for an admin UI after editing a skill package. */
  invalidate(): SkillSnapshot {
    this.invalidateCaches();
    return this.current;
  }

  async discover(): Promise<SkillDiscoveryResult> {
    const allErrors: SkillDiscoveryError[] = [];
    const discovered: SkillMetadata[] = [];
    for (const root of this.roots) {
      const rootId = root.id ?? path.resolve(root.path);
      const previous = this.rootRecordKeys.get(rootId);
      if (previous) for (const key of previous) this.records.delete(key);
      const keys = new Set<string>();
      this.rootRecordKeys.set(rootId, keys);
      let canonicalRoot: string;
      try {
        canonicalRoot = await fs.realpath(root.path);
      } catch {
        allErrors.push({ path: root.path, message: 'Skill root cannot be resolved' });
        continue;
      }
      let fileCount = 0;
      const files = await this.findSkillFiles(canonicalRoot, canonicalRoot, 0, () => {
        if (fileCount >= this.maxFilesPerRoot) return false;
        fileCount += 1;
        return true;
      }, allErrors);
      for (const file of files) {
        try {
          const bytes = await fs.readFile(file);
          if (bytes.byteLength > this.maxSkillBytes) throw new SkillRegistryError('Skill body exceeds the configured byte limit', 'size');
          const raw = bytes.toString('utf8');
          const parsed = frontmatter(raw);
          const data = parsed.data;
          const name = data.name;
          const description = data.description;
          if (typeof name !== 'string' || !name.trim()) throw new SkillRegistryError('Skill name is required', 'invalid_metadata');
          if (typeof description !== 'string' || !description.trim()) throw new SkillRegistryError('Skill description is required', 'invalid_metadata');
          const contentHash = hash(raw);
          const input: SkillPackageInput = {
            name: name.trim(),
            description: description.trim(),
            revision: typeof (data.revision ?? data.version) === 'string' ? String(data.revision ?? data.version) : undefined,
            scope: scopeFrom(data.scope, root.scope),
            enabled: booleanFrom(data.enabled, true),
            implicit: booleanFrom(data.implicit ?? (isRecord(data.policy) ? data.policy.allow_implicit_invocation : undefined), true),
            dependencies: dependenciesFrom(data.dependencies ?? data.tools),
            content: parsed.body,
            path: file,
            rootPath: path.dirname(file),
            resources: await this.readPackageResources(path.dirname(file), file, canonicalRoot, allErrors),
          };
          const packageBytes = new TextEncoder().encode(input.content).byteLength;
          if (packageBytes > this.maxSkillBytes) throw new SkillRegistryError('Skill body exceeds the configured byte limit', 'size');
          const metadata = metadataFromPackage(input, contentHash);
          const record = this.recordFromInput(input, metadata, contentHash, canonicalRoot);
          this.records.set(record.key, record);
          keys.add(record.key);
          discovered.push(record.metadata);
        } catch (error) {
          allErrors.push({ path: file, message: error instanceof Error ? error.message : 'Skill could not be loaded' });
        }
      }
    }
    this.discoveryErrors = allErrors;
    this.invalidateCaches();
    return Object.freeze({ snapshot: this.current, discovered: Object.freeze(discovered.slice()), errors: Object.freeze(allErrors.slice()) });
  }

  discoverRoots(): Promise<SkillDiscoveryResult> {
    return this.discover();
  }

  /** Import a filesystem package root and immediately publish its new snapshot. */
  async importDirectory(rootPath: string, scope: DangooSkillScope = 'workspace'): Promise<SkillDiscoveryResult> {
    const existing = this.roots.find((root) => path.resolve(root.path) === path.resolve(rootPath));
    if (existing) existing.scope = scope;
    else this.roots.push({ path: rootPath, scope });
    return this.discover();
  }

  activate(name: string, revision?: string): SkillSnapshot {
    return this.enable(name, revision);
  }

  deactivate(name: string, revision?: string): SkillSnapshot {
    return this.disable(name, revision);
  }

  revisions(name: string, snapshot: SkillSnapshot = this.current): string[] {
    const state = this.stateFor(snapshot);
    return [...new Set((state.byName.get(this.parseName(name).name) ?? []).map((record) => record.metadata.revision))].sort();
  }

  readSkill(name: string, snapshot?: SkillSnapshot): Promise<string> {
    return this.read(name, snapshot);
  }

  resolve(name: string, snapshot?: SkillSnapshot, options?: SkillResolveOptions): SkillMetadata;
  resolve(name: string, options?: SkillResolveOptions, snapshot?: SkillSnapshot): SkillMetadata;
  resolve(
    name: string,
    snapshotOrOptions?: SkillSnapshot | SkillResolveOptions,
    optionsOrSnapshot?: SkillResolveOptions | SkillSnapshot,
  ): SkillMetadata {
    const parsed = this.parseName(name);
    const isSnapshot = (value: unknown): value is SkillSnapshot =>
      isRecord(value) && typeof value.revision === 'string' && Array.isArray(value.skills);
    let actualSnapshot: SkillSnapshot | undefined = isSnapshot(snapshotOrOptions)
      ? snapshotOrOptions
      : isSnapshot(optionsOrSnapshot)
        ? optionsOrSnapshot
        : undefined;
    let actualOptions: SkillResolveOptions = (!isSnapshot(snapshotOrOptions) && snapshotOrOptions
      ? snapshotOrOptions
      : !isSnapshot(optionsOrSnapshot) && optionsOrSnapshot
        ? optionsOrSnapshot
        : {}) as SkillResolveOptions;
    if (!actualSnapshot && parsed.revision) actualOptions = { ...actualOptions, revision: parsed.revision };
    if (!actualSnapshot) actualSnapshot = this.current;
    const record = this.resolveRecord(parsed.name, actualSnapshot, actualOptions);
    return record.metadata;
  }

  catalog(snapshot: SkillSnapshot = this.current): string {
    const state = this.stateFor(snapshot);
    const rows = [...state.byKey.values()]
      .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name) || scopePriority(b.scope) - scopePriority(a.scope) || a.metadata.revision.localeCompare(b.metadata.revision))
      .map((record) => ({
        name: record.metadata.name,
        description: record.metadata.description,
        revision: record.metadata.revision,
        contentHash: record.contentHash,
        scope: record.scope,
        enabled: record.metadata.enabled,
        implicit: record.metadata.implicit,
        dependencies: [...record.metadata.dependencies],
        available: record.metadata.enabled && this.dependenciesAvailable(record, state, new Set()),
      }));
    return JSON.stringify({ revision: snapshot.revision, skills: rows }, null, 2);
  }

  async read(name: string, snapshot: SkillSnapshot = this.current): Promise<string> {
    const record = this.resolveRecord(this.parseName(name).name, snapshot, {
      revision: this.parseName(name).revision,
      explicit: true,
    });
    return record.content;
  }

  async resource(name: string, relativePath: string, snapshot: SkillSnapshot = this.current): Promise<string> {
    const parsed = this.parseName(name);
    const record = this.resolveRecord(parsed.name, snapshot, { revision: parsed.revision, explicit: true });
    const safePath = normalizedResourcePath(relativePath);
    const cached = record.resources.get(safePath);
    if (cached !== undefined) return cached;
    if (record.resourcesComplete) throw new SkillRegistryError('Skill resource is not present in this snapshot', 'resource');
    if (!record.packageRoot || !record.filePath) throw new SkillRegistryError('Skill resource is unavailable', 'resource');
    const candidate = path.resolve(record.packageRoot, ...safePath.split('/'));
    if (!ensureWithin(record.packageRoot, candidate)) throw new SkillRegistryError('Skill resource escapes its package', 'path');
    let realCandidate: string;
    try {
      realCandidate = await fs.realpath(candidate);
    } catch {
      throw new SkillRegistryError('Skill resource does not exist', 'resource');
    }
    if (!ensureWithin(record.packageRoot, realCandidate)) throw new SkillRegistryError('Skill resource symlink escapes its package', 'path');
    const bytes = await fs.readFile(realCandidate);
    if (bytes.byteLength > this.maxResourceBytes) throw new SkillRegistryError('Skill resource exceeds the configured byte limit', 'size');
    return bytes.toString('utf8');
  }

  list(options: SkillResolveOptions = {}, snapshot: SkillSnapshot = this.current): SkillMetadata[] {
    const state = this.stateFor(snapshot);
    const result: SkillMetadata[] = [];
    for (const [name] of state.byName) {
      try {
        const record = this.resolveRecord(name, snapshot, options);
        if (!result.some((item) => item.name === record.metadata.name)) result.push(record.metadata);
      } catch {
        // Ambiguous and unavailable skills remain visible in catalog with reason.
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  private setEnabled(name: string, enabled: boolean, revision?: string): void {
    let found = false;
    for (const [key, record] of this.records) {
      if (record.metadata.name !== name || (revision && record.metadata.revision !== revision)) continue;
      found = true;
      const metadata = freezeMetadata({ ...record.metadata, enabled });
      this.records.set(key, Object.freeze({ ...record, metadata }));
    }
    if (!found) throw new SkillRegistryError(`Skill ${name} was not found`, 'not_found');
    this.invalidateCaches();
  }

  private parseName(value: string): { name: string; revision?: string } {
    const input = value.trim();
    const at = input.lastIndexOf('@');
    if (at > 0) return { name: input.slice(0, at), revision: input.slice(at + 1) };
    return { name: input };
  }

  private stateFor(snapshot: SkillSnapshot): SnapshotRecord {
    const state = this.snapshotStates.get(snapshot);
    if (state) return state;
    const known = this.history.get(snapshot.revision);
    if (known) return this.snapshotStates.get(known)!;
    throw new SkillRegistryError('Skill snapshot is not owned by this registry', 'not_found');
  }

  private resolveRecord(name: string, snapshot: SkillSnapshot, options: SkillResolveOptions): StoredSkill {
    const state = this.stateFor(snapshot);
    const candidates = [...(state.byName.get(name) ?? [])].filter((record) => record.metadata.enabled);
    if (options.revision) {
      const exact = candidates.filter((record) => record.metadata.revision === options.revision);
      if (exact.length === 0) throw new SkillRegistryError(`Skill ${name}@${options.revision} is unavailable`, 'not_found');
      return this.chooseCandidate(name, exact);
    }
    const eligible = candidates.filter((record) => options.implicit !== true || record.metadata.implicit);
    if (eligible.length === 0) {
      const all = state.byName.get(name) ?? [];
      if (all.some((record) => !record.metadata.enabled)) throw new SkillRegistryError(`Skill ${name} is disabled`, 'disabled');
      throw new SkillRegistryError(`Skill ${name} was not found`, 'not_found');
    }
    const chosen = this.chooseCandidate(name, eligible);
    if (!this.dependenciesAvailable(chosen, state, new Set())) {
      throw new SkillRegistryError(`Skill ${name} has unavailable dependencies`, 'dependency');
    }
    return chosen;
  }

  private chooseCandidate(name: string, candidates: readonly StoredSkill[]): StoredSkill {
    const highest = Math.max(...candidates.map((candidate) => scopePriority(candidate.scope)));
    const samePriority = candidates.filter((candidate) => scopePriority(candidate.scope) === highest);
    if (samePriority.length > 1) throw new SkillRegistryError(`Skill ${name} is ambiguous at one scope`, 'ambiguous');
    return samePriority[0];
  }

  private dependenciesAvailable(record: StoredSkill, state: SnapshotRecord, stack: Set<string>): boolean {
    if (stack.has(record.metadata.name)) return false;
    stack.add(record.metadata.name);
    for (const dependency of record.metadata.dependencies) {
      const parsed = this.parseName(dependency);
      const candidates = [...(state.byName.get(parsed.name) ?? [])].filter((item) => item.metadata.enabled);
      const matching = parsed.revision ? candidates.filter((item) => item.metadata.revision === parsed.revision) : candidates;
      if (matching.length === 0) return false;
      let resolved: StoredSkill;
      try {
        resolved = this.chooseCandidate(parsed.name, matching);
      } catch {
        return false;
      }
      if (!this.dependenciesAvailable(resolved, state, new Set(stack))) return false;
    }
    return true;
  }

  private makeSnapshot(): SkillSnapshot {
    const state = mapRecords(this.records.values());
    this.snapshotCounter += 1;
    const rows = [...state.byKey.values()].map((record) => `${record.key}@${record.contentHash}@${record.metadata.enabled ? 1 : 0}`).sort();
    const revision = `skills-${this.snapshotCounter}-${hash(rows.join('|'))}`;
    const metadata = Object.freeze(
      [...state.byKey.values()]
        .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name) || a.key.localeCompare(b.key))
        .map((record) => record.metadata),
    ) as readonly SkillMetadata[];
    const snapshot = Object.freeze({ revision, skills: metadata }) as SkillSnapshot;
    this.snapshotStates.set(snapshot, state);
    this.history.set(revision, snapshot);
    return snapshot;
  }

  private invalidateCaches(): void {
    this.current = this.makeSnapshot();
  }

  private toPackageInput(input: SkillPackageInput | SkillMetadata | SkillRegistrationInput, content?: string, resources?: Record<string, string | Uint8Array>): SkillPackageInput {
    if ('metadata' in input && input.metadata) {
      return {
        name: input.metadata.name,
        description: input.metadata.description,
        revision: input.metadata.revision,
        scope: input.metadata.scope as DangooSkillScope,
        enabled: input.metadata.enabled,
        implicit: input.metadata.implicit,
        dependencies: [...input.metadata.dependencies],
        content: input.content,
        path: input.metadata.path,
        resources: resources ?? input.resources,
      };
    }
    if ('content' in input) {
      const packageInput = input as SkillPackageInput;
      return { ...packageInput, resources: resources ?? packageInput.resources };
    }
    if (content === undefined) throw new SkillRegistryError('Skill content is required', 'invalid_metadata');
    return {
      name: input.name,
      description: input.description,
      revision: input.revision,
      scope: input.scope,
      enabled: input.enabled,
      implicit: input.implicit,
      dependencies: [...input.dependencies],
      content,
      path: input.path,
      resources,
    };
  }

  private recordFromInput(input: SkillPackageInput, metadata: SkillMetadata, contentHash: string, originRoot?: string): StoredSkill {
    const rootPath = input.rootPath ? path.resolve(input.rootPath) : undefined;
    const filePath = input.path ? path.resolve(input.path) : undefined;
    const resourceMap = new Map<string, string>();
    for (const [resourcePath, value] of Object.entries(input.resources ?? {})) {
      const safePath = normalizedResourcePath(resourcePath);
      resourceMap.set(safePath, typeof value === 'string' ? value : new TextDecoder().decode(value));
    }
    const scope = (metadata.scope as DangooSkillScope) || 'workspace';
    const key = `${metadata.name}\0${scope}\0${metadata.revision}\0${filePath ?? metadata.path}`;
    return Object.freeze({
      key,
      metadata,
      scope,
      content: input.content,
      contentHash,
      packageRoot: rootPath,
      filePath,
      resources: resourceMap,
      resourcesComplete: input.resources !== undefined,
      originRoot,
    });
  }

  private async findSkillFiles(root: string, current: string, depth: number, count: () => boolean, errors: SkillDiscoveryError[]): Promise<string[]> {
    if (depth > this.maxDepth) {
      errors.push({ path: current, message: 'Skill discovery depth limit reached' });
      return [];
    }
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      errors.push({ path: current, message: 'Skill directory cannot be read' });
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.findSkillFiles(root, candidate, depth + 1, count, errors)));
      } else if (entry.isFile() && /^skill\.md$/i.test(entry.name)) {
        if (!count()) {
          errors.push({ path: candidate, message: 'Skill discovery file limit reached' });
          continue;
        }
        try {
          const real = await fs.realpath(candidate);
          if (ensureWithin(root, real)) files.push(real);
          else errors.push({ path: candidate, message: 'Skill symlink escapes its approved root' });
        } catch {
          errors.push({ path: candidate, message: 'Skill file cannot be resolved' });
        }
      }
    }
    return files;
  }

  private async readPackageResources(packageRoot: string, skillFile: string, approvedRoot: string, errors: SkillDiscoveryError[]): Promise<Record<string, string>> {
    const resources: Record<string, string> = {};
    const walk = async (directory: string, depth = 0): Promise<void> => {
      if (depth > this.maxDepth) {
        errors.push({ path: directory, message: 'Skill resource depth limit reached' });
        return;
      }
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        errors.push({ path: directory, message: 'Skill resource directory cannot be read' });
        return;
      }
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (candidate === skillFile || entry.name.toLowerCase() === 'skill.md') continue;
        if (entry.isDirectory()) {
          await walk(candidate, depth + 1);
          continue;
        }
        if (entry.isSymbolicLink()) {
          try {
            const real = await fs.realpath(candidate);
            if (!ensureWithin(packageRoot, real) || !ensureWithin(approvedRoot, real)) {
              errors.push({ path: candidate, message: 'Skill resource symlink escapes its approved root' });
              continue;
            }
            const linked = await fs.stat(real);
            if (linked.isDirectory()) {
              await walk(candidate, depth + 1);
              continue;
            }
            if (!linked.isFile()) continue;
            const bytes = await fs.readFile(real);
            if (bytes.byteLength > this.maxResourceBytes) {
              errors.push({ path: candidate, message: 'Skill resource exceeds the configured byte limit' });
              continue;
            }
            const relative = path.relative(packageRoot, candidate).split(path.sep).join('/');
            resources[normalizedResourcePath(relative)] = bytes.toString('utf8');
          } catch {
            errors.push({ path: candidate, message: 'Skill resource symlink cannot be read' });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const real = await fs.realpath(candidate);
          if (!ensureWithin(packageRoot, real) || !ensureWithin(approvedRoot, real)) {
            errors.push({ path: candidate, message: 'Skill resource symlink escapes its approved root' });
            continue;
          }
          const bytes = await fs.readFile(real);
          if (bytes.byteLength > this.maxResourceBytes) {
            errors.push({ path: candidate, message: 'Skill resource exceeds the configured byte limit' });
            continue;
          }
          const relative = path.relative(packageRoot, candidate).split(path.sep).join('/');
          resources[normalizedResourcePath(relative)] = bytes.toString('utf8');
        } catch {
          errors.push({ path: candidate, message: 'Skill resource cannot be read' });
        }
      }
    };
    await walk(packageRoot);
    return resources;
  }
}
