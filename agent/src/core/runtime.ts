import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ContextManagerLike,
  ContextState,
  ContentPart,
  Provider,
  ProviderRegistryLike,
  Run,
  Selection,
  Session,
  SkillRegistryLike,
  SkillSnapshot,
  ToolCall,
  ToolDefinition,
  ToolRegistryLike,
  ToolResult,
  ToolSpec,
  WaitRequest,
  AssetGateway,
} from '../contracts/index.js';
import { ContextManager } from '../context/index.js';
import { SkillRegistry } from '../skills/index.js';
import { KeyedMutex } from './mutex.js';
import { SqliteStore } from './store.js';
import { ToolRegistry } from './tool-registry.js';
import { ToolScheduler, operationIdFor, type ToolExecutionRequestWithEmit } from './tool-scheduler.js';
import { DEFAULT_RUNTIME_LIMITS, now, type RuntimeLimits, stableJson } from './types.js';
import type { CanvasGateway } from '../contracts/index.js';

const RESULT_READ_SPEC: ToolSpec = {
  name: 'result_read',
  description: '分页读取本会话中被截断的大型工具结果。只能读取当前会话返回的 resultRef。',
  revision: '1',
  inputSchema: {
    type: 'object',
    properties: { resultRef: { type: 'string', minLength: 1, maxLength: 256 }, cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } },
    required: ['resultRef'],
    additionalProperties: false,
  },
};

const ASK_USER_SPEC: ToolSpec = {
  name: 'ask_user',
  description: '在需要真实用户信息、选择或批准时暂停运行并提问。',
  revision: '1',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 2_000 },
      options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, maxItems: 20 },
      kind: { enum: ['question', 'approval'] },
      payload: { type: 'object', additionalProperties: true },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
};

const SKILL_READ_SPEC: ToolSpec = {
  name: 'skill_read',
  description: '读取已注册且已冻结版本的 Skill 正文或包内资源；不能读取任意系统路径。',
  revision: '1',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 160 }, resource: { type: 'string', minLength: 1, maxLength: 512 } },
    required: ['name'],
    additionalProperties: false,
  },
};

const RUNTIME_BUILTIN_SPECS = [RESULT_READ_SPEC, ASK_USER_SPEC, SKILL_READ_SPEC] as const;

export interface SendMessageInput {
  text: string;
  selection?: Selection;
  skillNames?: string[];
  requestId?: string;
}

export interface CreateSessionInput {
  ownerId: string;
  canvasId: string;
  providerId?: string;
  model?: string;
}

export interface AgentRuntimeOptions {
  store?: SqliteStore;
  providers?: ProviderRegistryLike;
  providerRegistry?: ProviderRegistryLike;
  tools?: ToolRegistryLike | ToolRegistry | readonly ToolDefinition[];
  toolRegistry?: ToolRegistryLike | ToolRegistry;
  skills?: SkillRegistryLike;
  skillRegistry?: SkillRegistryLike;
  context?: ContextManagerLike;
  contextManager?: ContextManagerLike;
  canvas?: CanvasGateway;
  canvasGateway?: CanvasGateway;
  assets?: AssetGateway;
  systemPrompt?: string;
  model?: string;
  limits?: Partial<RuntimeLimits>;
  parallelism?: number;
  beforeToolExecute?: import('./tool-scheduler.js').ToolSchedulerOptions['beforeExecute'];
  afterToolExecute?: import('./tool-scheduler.js').ToolSchedulerOptions['afterExecute'];
  allowExternalWithoutPolicy?: boolean;
  onApprovalReply?: (run: Run, wait: WaitRequest, decision: 'approve' | 'deny') => Promise<void>;
}

export interface SessionState {
  session: Session;
  runs: Run[];
  latestRun?: Run;
  messages: import('../contracts/index.js').Message[];
  eventSequence: number;
}

interface FrozenRunSnapshot {
  provider: Provider;
  providerRevision: string;
  toolsRevision: string;
  tools: readonly ToolDefinition[];
  skillsRevision: string;
  skills: SkillSnapshot;
  skillCatalog: string;
  skillContents: Map<string, string>;
  skillsCompatible: boolean;
}

interface PersistedToolDescriptor {
  name: string;
  description: string;
  revision: string;
  inputSchema: Record<string, unknown>;
  effect: ToolDefinition['effect'];
  parallelSafe: boolean;
  timeoutMs?: number;
}

interface PersistedRunSnapshot {
  version: 1;
  provider: { id: string; revision: string; model: string };
  tools: PersistedToolDescriptor[];
  skills: readonly Record<string, unknown>[];
  skillCatalog: string;
  skillContents: Record<string, string>;
}

interface RuntimeListener {
  (event: AgentEvent): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string {
  try {
    const output = JSON.stringify(value);
    return output === undefined ? 'null' : output;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Durable, provider-neutral Agent loop. It owns session ordering, turn state,
 * event replay and recovery while business side effects remain injected tools.
 */
export class AgentRuntime {
  readonly store: SqliteStore;
  readonly providers: ProviderRegistryLike;
  readonly skills: SkillRegistryLike;
  readonly context: ContextManagerLike;
  readonly tools: ToolRegistry;
  readonly canvas?: CanvasGateway;
  readonly assets?: AssetGateway;
  readonly limits: RuntimeLimits;
  private readonly beforeToolExecute?: import('./tool-scheduler.js').ToolSchedulerOptions['beforeExecute'];
  private readonly afterToolExecute?: import('./tool-scheduler.js').ToolSchedulerOptions['afterExecute'];
  private readonly allowExternalWithoutPolicy: boolean;
  private readonly onApprovalReply?: AgentRuntimeOptions['onApprovalReply'];
  private pollingJobs = false;
  private readonly parallelism: number;

  private readonly systemPrompt: string;
  private readonly toolSource: ToolRegistryLike;
  private readonly sessionDispatch = new KeyedMutex();
  private readonly runLocks = new KeyedMutex();
  private readonly canvasLocks = new KeyedMutex();
  private readonly canvasSideEffects = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<RuntimeListener>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly snapshots = new Map<string, FrozenRunSnapshot>();
  private readonly activeSchedulers = new Map<string, ToolScheduler>();
  private readonly recoveryPromise: Promise<void>;

  constructor(options: AgentRuntimeOptions) {
    this.store = options.store ?? new SqliteStore();
    this.providers = options.providers ?? options.providerRegistry ?? (() => { throw new Error('ProviderRegistryLike is required'); })();
    this.skills = options.skills ?? options.skillRegistry ?? new SkillRegistry();
    this.context = options.context ?? options.contextManager ?? new ContextManager();
    this.canvas = options.canvas ?? options.canvasGateway;
    this.assets = options.assets;
    this.limits = { ...DEFAULT_RUNTIME_LIMITS, ...(options.limits ?? {}) };
    this.beforeToolExecute = options.beforeToolExecute;
    this.onApprovalReply = options.onApprovalReply;
    this.afterToolExecute = options.afterToolExecute;
    this.allowExternalWithoutPolicy = options.allowExternalWithoutPolicy ?? false;
    this.parallelism = Math.max(1, Math.min(64, Math.floor(options.parallelism ?? 4)));
    this.systemPrompt = options.systemPrompt ?? '你是 Dangoo 画布里的艺术创作 Agent。遵守用户约束，使用已注册工具完成可验证的画布操作；不要伪造看过的资产、任务结果、费用或权限。工具返回的对象版本和资产引用是事实，遇到歧义或需要授权时询问用户。';
    const source = options.tools ?? options.toolRegistry ?? [];
    if (source instanceof ToolRegistry) {
      this.tools = source;
      this.toolSource = source;
    } else if (Array.isArray(source)) {
      this.tools = new ToolRegistry(source);
      this.toolSource = this.tools;
    } else if (typeof source === 'object' && source !== null && 'snapshot' in source) {
      this.tools = new ToolRegistry(source.snapshot().tools);
      this.toolSource = source;
    } else {
      this.tools = new ToolRegistry();
      this.toolSource = this.tools;
    }
    this.recoveryPromise = this.recover();
  }

  async ready(): Promise<void> {
    await this.recoveryPromise;
  }

  createSession(input: CreateSessionInput): Session {
    if (!input.ownerId || !input.canvasId) throw new Error('ownerId and canvasId are required');
    const providerId = input.providerId ?? this.providers.list()[0]?.id;
    if (!providerId) throw new Error('No provider is configured');
    const provider = this.providers.get(providerId);
    const model = input.model ?? this.defaultModel(provider);
    provider.capabilities(model); // Fail fast for malformed provider/model configuration.
    this.syncTools();
    const id = randomUUID();
    const session = this.store.createSession({ id, ownerId: input.ownerId, canvasId: input.canvasId, createdAt: now(), providerId, model });
    if (session.id !== id) return session;
    this.store.saveCheckpoint({ id: randomUUID(), sessionId: session.id, state: { messages: [], summaryVersion: 0, pinned: {}, viewedAssets: [] }, summaryVersion: 0, createdAt: now() });
    this.publish(session.id, { type: 'session.created', data: { session } });
    return session;
  }

  getSession(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  listSessions(scope?: { ownerId?: string; canvasId?: string }): Session[] {
    return this.store.listSessions(scope);
  }

  getSessionState(sessionId: string): SessionState {
    const session = this.getSession(sessionId);
    const runs = this.store.listRuns(sessionId);
    const latest = runs[0];
    return { session, runs, latestRun: latest, messages: this.store.listMessages(sessionId), eventSequence: this.store.latestEventSequence(sessionId) };
  }

  getHistory(sessionId: string, options: { after?: number; limit?: number } = {}): import('../contracts/index.js').Message[] {
    this.getSession(sessionId);
    return this.store.listMessages(sessionId, options);
  }

  getEvents(sessionId: string, after = 0, limit = 1_000): AgentEvent[] {
    this.getSession(sessionId);
    return this.store.listEvents(sessionId, after, limit);
  }

  subscribe(sessionId: string, listener: RuntimeListener, after = 0): () => void {
    this.getSession(sessionId);
    let listeners = this.listeners.get(sessionId);
    if (!listeners) { listeners = new Set(); this.listeners.set(sessionId, listeners); }
    const delivered = new Set<number>();
    const deliver: RuntimeListener = (event) => {
      if (event.sequence <= after || delivered.has(event.sequence)) return;
      delivered.add(event.sequence);
      listener(event);
    };
    listeners.add(deliver);
    // Register before replay so events are never lost. Sequence-based clients
    // can safely discard a duplicate if one is committed during this loop.
    let cursor = after;
    while (true) {
      const page = this.store.listEvents(sessionId, cursor, 1_000);
      for (const event of page) deliver(event);
      if (page.length < 1_000) break;
      const next = page.at(-1)?.sequence ?? cursor;
      if (next <= cursor) break;
      cursor = next;
    }
    return () => {
      listeners?.delete(deliver);
      if (listeners && listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  async sendMessage(sessionId: string, input: SendMessageInput): Promise<Run> {
    this.validateText(input.text);
    const selection = this.validateSelection(input.selection);
    const skillNames = this.validateSkillNames(input.skillNames);
    this.getSession(sessionId);
    return this.sessionDispatch.runExclusive(sessionId, async () => {
      if (input.requestId) {
        const existing = this.store.findRequest(sessionId, input.requestId);
        if (existing) return existing;
      }
      const active = this.store.getActiveRun(sessionId);
      if (active) {
        if (input.requestId) {
          const attached = this.store.attachRequest(sessionId, input.requestId, active.id);
          if (attached && attached.id !== active.id) return attached;
        }
        const message = this.appendUserMessage(sessionId, active.id, input.text, selection);
        this.publish(sessionId, { runId: active.id, turnId: active.turnId, type: 'message.accepted', data: { message, requestId: input.requestId, supplemental: true } });
        return active;
      }
      this.syncTools();
      const session = this.getSession(sessionId);
      const provider = this.providers.get(session.providerId);
      const toolSnapshot = this.toolSource.snapshot();
      const skillSnapshot = this.skills.snapshot();
      const initialSnapshot: FrozenRunSnapshot = {
        provider,
        providerRevision: provider.revision,
        toolsRevision: toolSnapshot.revision,
        tools: toolSnapshot.tools,
        skillsRevision: skillSnapshot.revision,
        skills: skillSnapshot,
        skillCatalog: this.skills.catalog(skillSnapshot),
        skillContents: new Map(),
        skillsCompatible: true,
      };
      let run: Run;
      try {
        run = this.store.createRun({
          id: randomUUID(), sessionId, turnId: randomUUID(), state: 'queued', providerId: session.providerId, model: session.model,
          providerRevision: provider.revision, toolRevision: toolSnapshot.revision, skillRevision: skillSnapshot.revision, createdAt: now(), updatedAt: now(),
          requestId: input.requestId, selection, skillNames, snapshot: this.serializeSnapshot(initialSnapshot),
        });
      } catch (error) {
        // A second runtime process may win the request-key race between the
        // lookup above and the INSERT. The failed transaction leaves no
        // orphan run; return the durable winner when available.
        const existing = input.requestId ? this.store.findRequest(sessionId, input.requestId) : undefined;
        if (existing) return existing;
        throw error;
      }
      this.snapshots.set(run.id, initialSnapshot);
      const message = this.appendUserMessage(sessionId, run.id, input.text, selection);
      this.publish(sessionId, { runId: run.id, turnId: run.turnId, type: 'message.accepted', data: { message, requestId: input.requestId } });
      this.publishRun(run);
      this.scheduleRun(run.id);
      return run;
    });
  }

  async pollJobs(): Promise<void> {
    if (this.pollingJobs || !this.canvas?.job) return;
    this.pollingJobs = true;
    try {
      for (const saved of this.store.listJobs().filter(job => ['created', 'submitting', 'submitted', 'running', 'submission_unknown'].includes(job.state) || (job.state === 'succeeded' && job.storageState !== 'stored'))) {
        try {
          const session = this.getSession(saved.sessionId);
          const job = await this.canvas.job(session.scope, saved.id);
          this.store.saveJob({ ...saved, ...job });
          this.publish(session.id, { runId: saved.runId, type: 'job.updated', data: { job } });
          if (job.applyState === 'applied' && saved.applyState !== 'applied') {
            const canvas = await this.canvas.read(session.scope);
            this.publish(session.id, { runId: saved.runId, type: 'canvas.changed', data: { canvasId: session.scope.canvasId, revision: canvas.revision } });
          }
          const run = saved.runId ? this.store.getRun(saved.runId) : undefined;
          if (run?.state === 'waiting_jobs') {
            const outstanding = this.store.listJobs({ runId: run.id, activeOnly: true });
            if (!outstanding.length) {
              const jobs = this.store.listJobs({ runId: run.id });
              if (jobs.every(item => item.state !== 'succeeded' || item.storageState === 'stored')) {
                this.store.appendMessage({ id: randomUUID(), sessionId: session.id, runId: run.id, role: 'system', content: [{ type: 'text', text: `节点任务最新状态：${JSON.stringify(jobs.map(item => ({ id: item.id, nodeId: item.nodeId, state: item.state, storageState: item.storageState, applyState: item.applyState })))}` }] });
                await this.resumeRun(run.id);
              }
            }
          }
        } catch { /* A transient business outage leaves the durable job available for the next poll. */ }
      }
    } finally { this.pollingJobs = false; }
  }

  async reply(runId: string, input: { text: string; waitId: string; decision?: 'approve' | 'deny' }): Promise<Run> {
    this.validateText(input.text);
    if (!input.waitId || input.waitId.length > 256) throw new Error('waitId is required');
    const known = this.store.getRun(runId);
    if (!known) throw new Error(`Run not found: ${runId}`);
    return this.sessionDispatch.runExclusive(known.sessionId, async () => {
      const run = this.store.getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      if (run.state !== 'waiting_user' || !run.wait || run.wait.id !== input.waitId) throw new Error('Run is not waiting for this reply');
      if (run.wait.payload?.requiresSnapshotRecovery === true) {
        await this.snapshotFor(run);
      }
      if (run.wait.payload && run.wait.payload.requiresReconciliation === true) {
        const reconciled = await this.reconcileRun(run);
        if (!reconciled) throw new Error('外部操作仍未完成对账，不能恢复 Agent run');
      }
      const pending = this.store.listPendingCalls(run.id);
      const decision = run.wait.kind === 'approval' ? (input.decision ?? this.approvalDecision(input.text)) : undefined;
      if (run.wait.kind === 'approval' && decision === undefined) {
        throw new Error('approval wait requires decision=approve or decision=deny');
      }
      if (run.wait.kind === 'approval' && decision) {
        const trusted = this.store.listOperations({ runId: run.id }).some(operation => operation.toolName !== 'ask_user' && operation.result?.wait?.id === run.wait!.id);
        if (trusted) await this.onApprovalReply?.(run, run.wait, decision);
      }
      if (run.wait.kind === 'approval' && decision === 'deny' && pending.length > 0) {
        await this.deferPendingCalls(run, pending, input.text);
      } else if (run.wait.kind === 'question' && pending.length > 0) {
        await this.deferPendingCalls(run, pending, input.text, false);
      }
      const message = this.appendUserMessage(run.sessionId, run.id, input.text);
      this.store.clearPendingWait(run.id);
      this.store.updateRun(run.id, { state: 'queued', wait: undefined });
      const next = this.store.getRun(run.id)!;
      this.publish(next.sessionId, { runId: next.id, turnId: next.turnId, type: 'message.accepted', data: { message, replyTo: input.waitId, ...(decision ? { decision } : {}) } });
      this.publishRun(next);
      this.scheduleRun(next.id);
      return next;
    });
  }

  /** Wakes a waiting-jobs run after the injected business job service has been reconciled. */
  async resumeRun(runId: string): Promise<Run> {
    const known = this.store.getRun(runId);
    if (!known) throw new Error(`Run not found: ${runId}`);
    return this.sessionDispatch.runExclusive(known.sessionId, async () => {
      const run = this.store.getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      if (run.state !== 'waiting_jobs') throw new Error('Run is not waiting for jobs');
      this.store.clearPendingWait(run.id);
      this.store.updateRun(run.id, { state: 'queued', wait: undefined });
      const next = this.store.getRun(run.id)!;
      this.publishRun(next);
      this.scheduleRun(next.id);
      return next;
    });
  }

  stopRun(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    this.store.updateRun(runId, { stopRequested: true });
    this.controllers.get(runId)?.abort();
    this.activeSchedulers.get(runId)?.cancelRun(runId);
    const current = this.store.getRun(runId)!;
    if (['queued', 'waiting_user', 'waiting_jobs', 'compacting'].includes(current.state)) {
      this.store.clearPendingWait(runId);
      this.store.clearPendingCalls(runId);
      this.transition(runId, 'stopped', undefined, '用户已停止后续 Agent 操作');
    } else this.publishRun(current);
    return this.store.getRun(runId)!;
  }

  async compact(sessionId: string, runId?: string): Promise<ContextState> {
    const session = this.getSession(sessionId);
    return this.runLocks.runExclusive(sessionId, async () => {
      const run = runId ? this.store.getRun(runId) : this.store.getActiveRun(sessionId);
      const provider = run ? (await this.snapshotFor(run)).provider : this.providers.get(session.providerId);
      // Capture the exact message boundary used to build the compacting
      // context. Messages arriving while the provider summarizes are kept
      // after this checkpoint and will be picked up by the next load.
      const boundary = this.store.lastMessageOrdinal(sessionId);
      const state = this.loadState(sessionId, boundary);
      const before = run?.state;
      if (run) this.transition(run.id, 'compacting');
      this.publish(sessionId, { runId: run?.id, turnId: run?.turnId, type: 'context.compacting', data: { manual: true } });
      const controller = new AbortController();
      let result: { state: ContextState; changed: boolean; reason?: string };
      try { result = await this.context.compact(state, provider, session.model, controller.signal); }
      catch (error) { result = { state, changed: false, reason: errorMessage(error) }; }
      if (result.changed) this.saveState(sessionId, result.state, run?.id, boundary);
      this.publish(sessionId, { runId: run?.id, turnId: run?.turnId, type: 'context.compacted', data: { changed: result.changed, reason: result.reason } });
      if (run && before && before !== 'compacting') this.transition(run.id, before);
      return result.state;
    });
  }

  capabilities(): Record<string, unknown> {
    const providers = this.providers.list().map((provider) => ({ ...provider, model: this.defaultModel(this.providers.get(provider.id)) }));
    const toolSnapshot = this.toolSource.snapshot();
    const skillSnapshot = this.skills.snapshot();
    return {
      contractVersion: '1.0.0',
      providers,
      tools: [...toolSnapshot.tools.map((tool) => ({ name: tool.name, description: tool.description, revision: tool.revision, effect: tool.effect })), ...RUNTIME_BUILTIN_SPECS.map((tool) => ({ name: tool.name, description: tool.description, revision: tool.revision, effect: 'read' }))],
      skills: skillSnapshot.skills,
      canvas: this.canvas?.capabilities(),
    };
  }

  async readCanvas(scope: { ownerId: string; canvasId: string }): Promise<unknown> {
    if (!this.canvas) throw new Error('Canvas gateway is unavailable');
    return this.canvas.read(scope);
  }

  async recover(): Promise<void> {
    // First reconcile durable tool operations without invoking the model. An
    // unresolved external effect remains visible and is never re-submitted.
    const blockedRuns = new Set<string>();
    this.restoreInterruptedWaits(blockedRuns);
    const unfinished = this.store.listUnfinishedOperations();
    for (const operation of unfinished) {
      if (!operation.runId) continue;
      const run = this.store.getRun(operation.runId);
      const session = this.store.getSession(operation.sessionId);
      if (!run || !session) continue;
      let frozen: FrozenRunSnapshot;
      try {
        frozen = await this.snapshotFor(run);
      } catch (error) {
        blockedRuns.add(run.id);
        if (operation.effect !== 'read') this.markUnresolvedOperation(operation, run, session, errorMessage(error));
        this.markSnapshotUnavailable(run, errorMessage(error));
        continue;
      }
      const definition = frozen.tools.find((tool) => tool.name === operation.toolName);
      if (operation.effect !== 'read' && !definition?.reconcile) {
        blockedRuns.add(run.id);
        this.markUnresolvedOperation(operation, run, session, '当前工具版本没有可用的 reconcile 实现。');
        continue;
      }
      const registry = new ToolRegistry(definition ? [definition] : []);
      const scheduler = this.makeScheduler(run, registry);
      const request: ToolExecutionRequestWithEmit = { call: { id: operation.callId ?? operation.operationId, name: operation.toolName, arguments: operation.arguments }, session, run, signal: new AbortController().signal, emit: (type, data) => this.publish(session.id, { runId: run.id, turnId: run.turnId, type, data }) };
      const recovered = await scheduler.execute(request);
      if (!recovered.result.error) {
        this.appendRecoveredToolResult(session.id, run.id, request.call.id, recovered.result);
        this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'operation.reconciled', data: { operationId: operation.operationId } });
      } else if (operation.effect !== 'read') {
        blockedRuns.add(run.id);
        this.markUnresolvedOperation(operation, run, session, recovered.result.error.message);
      }
    }
    for (const session of this.store.listSessions()) {
      for (const run of this.store.listRuns(session.id, 1_000)) {
        const pendingWait = this.store.getPendingWait(run.id);
        if (pendingWait && !['completed', 'partial', 'stopped', 'failed'].includes(run.state)) {
          // A process can die after the scheduler has durably parked a wait but
          // before the runtime updates agent_runs. Restore that boundary first;
          // scheduling the provider here could submit the suffix before the
          // user has answered it.
          blockedRuns.add(run.id);
          if (run.state !== (pendingWait.kind === 'jobs' ? 'waiting_jobs' : 'waiting_user') || run.wait?.id !== pendingWait.id) {
            const state = pendingWait.kind === 'jobs' ? 'waiting_jobs' : 'waiting_user';
            this.transition(run.id, state, pendingWait);
            this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'input.required', data: { wait: pendingWait, recovered: true } });
          }
          continue;
        }
        if (blockedRuns.has(run.id)) continue;
        if (run.state === 'waiting_user' && run.wait?.payload?.requiresReconciliation === true) {
          this.store.updateRun(run.id, { state: 'queued', wait: undefined });
        }
        if (['queued', 'running', 'compacting'].includes(run.state)) this.scheduleRun(run.id);
      }
    }
  }

  /** Restore a wait if the process died after the operation result was
   * committed but before the scheduler/runtime wait transaction completed. */
  private restoreInterruptedWaits(blockedRuns: Set<string>): void {
    for (const operation of this.store.listOperations()) {
      const result = operation.result;
      const wait = result?.wait;
      if (!wait || !operation.runId) continue;
      const run = this.store.getRun(operation.runId);
      const session = this.store.getSession(operation.sessionId);
      if (!run || !session || ['completed', 'partial', 'stopped', 'failed'].includes(run.state)) continue;
      const callId = operation.callId ?? operation.operationId;
      const existingMessage = this.store.findToolMessage(session.id, run.id, callId);
      const hadPendingWait = Boolean(this.store.getPendingWait(run.id));
      // A persisted tool message means this wait already crossed the runtime
      // boundary and was answered/continued. Do not resurrect old ask_user
      // results on every later process restart.
      if (!hadPendingWait && existingMessage && (run.wait || this.store.hasUserMessageAfterTool(session.id, run.id, callId))) continue;
      if (!hadPendingWait) {
        const suffix = this.store.listToolCallSuffix(run.id, callId);
        const selection = this.store.getRunInput(run.id).selection;
        this.store.persistPendingWait({
          runId: run.id,
          sessionId: session.id,
          wait,
          calls: suffix.map((call) => ({ call, selection })),
        });
      }
      if (!existingMessage) {
        const message = this.store.appendMessage({ id: randomUUID(), sessionId: session.id, runId: run.id, role: 'tool', content: result.content, callId });
        this.publish(session.id, {
          runId: run.id,
          turnId: run.turnId,
          type: result.error ? 'tool.failed' : 'tool.completed',
          data: { toolCallId: callId, name: operation.toolName, operationId: operation.operationId, result, success: !result.error, recovered: true, messageId: message.id },
        });
      }
      blockedRuns.add(run.id);
    }
  }

  private markUnresolvedOperation(operation: import('./types.js').StoredOperation, run: Run, session: Session, reason: string): void {
    const callId = operation.callId ?? operation.operationId;
    const result: ToolResult = {
      content: [{ type: 'text', text: `工具 ${operation.toolName} 的提交结果未知，已暂停恢复：${reason}` }],
      error: { code: 'operation_reconciliation_required', message: reason },
    };
    this.store.saveOperation({
      operationId: operation.operationId,
      sessionId: session.id,
      runId: run.id,
      callId,
      toolName: operation.toolName,
      effect: operation.effect,
      fingerprint: operation.fingerprint,
      state: 'submission_unknown',
      arguments: operation.arguments,
      result,
      error: result.error,
    });
    const message = this.appendRecoveredToolResult(session.id, run.id, callId, result);
    if (message) this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'tool.failed', data: { toolCallId: callId, name: operation.toolName, operationId: operation.operationId, result, success: false, reconciliationRequired: true, messageId: message.id } });
    const wait: WaitRequest = {
      kind: 'question',
      id: `reconcile:${operation.operationId}`,
      prompt: `上一次工具操作 ${operation.toolName} 的外部结果未知。完成业务服务对账后才能继续。`,
      payload: { requiresReconciliation: true, operationId: operation.operationId, toolName: operation.toolName },
    };
    if (run.state !== 'waiting_user' || run.wait?.id !== wait.id) this.transition(run.id, 'waiting_user', wait);
    this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'operation.reconciliation_required', data: { operationId: operation.operationId, toolName: operation.toolName, state: 'submission_unknown', reason } });
  }

  private async reconcileRun(run: Run): Promise<boolean> {
    const session = this.getSession(run.sessionId);
    const snapshot = await this.snapshotFor(run);
    const operations = this.store.listOperations({ runId: run.id, states: ['pending', 'running', 'submission_unknown'] }).filter((operation) => operation.effect !== 'read');
    let complete = true;
    for (const operation of operations) {
      const definition = snapshot.tools.find((tool) => tool.name === operation.toolName);
      if (!definition?.reconcile) {
        complete = false;
        this.markUnresolvedOperation(operation, run, session, '当前工具版本没有可用的 reconcile 实现。');
        continue;
      }
      const scheduler = this.makeScheduler(run, new ToolRegistry([definition]));
      const callId = operation.callId ?? operation.operationId;
      const request: ToolExecutionRequestWithEmit = {
        call: { id: callId, name: operation.toolName, arguments: operation.arguments },
        session,
        run,
        selection: this.store.getRunInput(run.id).selection,
        signal: new AbortController().signal,
        emit: (type, data) => this.publish(session.id, { runId: run.id, turnId: run.turnId, type, data }),
      };
      const recovered = await scheduler.execute(request);
      if (recovered.result.error) {
        complete = false;
        this.markUnresolvedOperation(operation, run, session, recovered.result.error.message);
        continue;
      }
      this.appendRecoveredToolResult(session.id, run.id, callId, recovered.result);
      this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'operation.reconciled', data: { operationId: operation.operationId, onReply: true } });
    }
    return complete && this.store.listOperations({ runId: run.id, states: ['pending', 'running', 'submission_unknown'] }).every((operation) => operation.effect === 'read');
  }

  private scheduleRun(runId: string): void {
    const run = this.store.getRun(runId);
    if (!run || this.controllers.has(runId)) return;
    void this.runLocks.runExclusive(run.sessionId, () => this.executeRun(runId)).catch((error) => {
      const current = this.store.getRun(runId);
      if (current && !['completed', 'partial', 'stopped', 'failed'].includes(current.state)) this.failRun(current, errorMessage(error));
    });
  }

  private async executeRun(runId: string): Promise<void> {
    const initial = this.store.getRun(runId);
    if (!initial) return;
    const session = this.getSession(initial.sessionId);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const run = initial;
    try {
      if (this.store.isStopRequested(runId)) { this.transition(runId, 'stopped', undefined, '用户已停止'); return; }
      const durableWait = this.store.getPendingWait(run.id);
      if (durableWait) {
        const waitingState = durableWait.kind === 'jobs' ? 'waiting_jobs' : 'waiting_user';
        if (run.state !== waitingState || run.wait?.id !== durableWait.id) {
          this.transition(run.id, waitingState, durableWait);
          this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'input.required', data: { wait: durableWait, recovered: true } });
        }
        return;
      }
      const snapshot = await this.snapshotFor(run);
      this.transition(runId, 'running');
      let state = this.loadRunState(session.id, run);
      const pending = this.store.listPendingCalls(run.id);
      if (pending.length > 0) {
        const requests: ToolExecutionRequestWithEmit[] = pending.map((item) => ({
          call: item.call,
          session,
          run,
          selection: item.selection ?? this.store.getRunInput(run.id).selection,
          signal: controller.signal,
          emit: (type, data) => this.publish(session.id, { runId: run.id, turnId: run.turnId, type, data: { ...data, toolCallId: item.call.id, resumed: true } }),
        }));
        const pendingBatch = await this.executeToolBatch(run, session, state, snapshot, requests);
        state = pendingBatch.state;
        if (pendingBatch.wait) {
          this.saveState(session.id, state, run.id);
          this.transition(run.id, pendingBatch.wait.kind === 'jobs' ? 'waiting_jobs' : 'waiting_user', pendingBatch.wait);
          this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'input.required', data: { wait: pendingBatch.wait } });
          return;
        }
        this.saveState(session.id, state, run.id);
        state = this.loadRunState(session.id, run);
      }
      for (let modelTurn = 0; modelTurn < this.limits.maxModelTurns; modelTurn += 1) {
        if (controller.signal.aborted || this.store.isStopRequested(runId)) throw new AbortError('run stopped');
        const capabilities = snapshot.provider.capabilities(run.model);
        const system = await this.systemForRun(snapshot, this.store.getRunInput(run.id).skillNames, controller.signal, session.id, run);
        const toolSpecs = capabilities.tools ? this.toolSpecs(snapshot.tools) : [];
        if (this.context.needsCompact(state, capabilities, system, toolSpecs)) {
          const compactBoundary = this.store.lastMessageOrdinal(session.id);
          state = this.loadRunState(session.id, run, compactBoundary);
          state = await this.compactForRun(run, snapshot.provider, state, controller.signal, compactBoundary);
          // A supplemental user message may have arrived while the summary
          // provider was running. The checkpoint boundary makes it visible on
          // this reload without resurrecting compacted history.
          state = this.loadRunState(session.id, run);
          if (this.context.exceedsWindow(state, capabilities, system, toolSpecs)) throw new Error('Context remains over provider budget after compact');
        }
        const prepared = this.context.prepare(state, system, capabilities, toolSpecs);
        const messages = await this.resolveProviderMessages(prepared, session.scope, controller.signal);
        const stream = snapshot.provider.stream({ model: run.model, messages, tools: toolSpecs, signal: controller.signal, maxOutputTokens: capabilities.maxOutputTokens });
        let text = '';
        const calls: ToolCall[] = [];
        let finish: 'stop' | 'tool_calls' | 'length' | undefined;
        let sawDone = false;
        let streamError: unknown;
        let streamFailed = false;
        try {
          for await (const event of stream) {
            if (controller.signal.aborted) throw new AbortError('provider stream aborted');
            if (event.type === 'text.delta') {
              text += event.text;
              if (event.text) this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'assistant.delta', data: { text: event.text } });
            } else if (event.type === 'tool.call') {
              if (!calls.some((existing) => existing.id === event.call.id)) calls.push(this.normalizeToolCall(event.call));
              this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'tool.call.received', data: { toolCallId: event.call.id, name: event.call.name } });
            } else if (event.type === 'usage') {
              this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'usage', data: { usage: event.usage } });
            } else if (event.type === 'done') { finish = event.reason; sawDone = true; }
          }
        } catch (error) {
          // A provider can terminate the iterable by throwing after emitting
          // useful text or a partial tool block. Keep that evidence in the
          // durable transcript before marking the run partial/failed below.
          streamFailed = true;
          streamError = error;
        }
        const acceptedCalls = sawDone && !streamFailed && !controller.signal.aborted ? calls : [];
        if (text || acceptedCalls.length) {
          const assistant = this.store.appendMessage({ id: randomUUID(), sessionId: session.id, runId: run.id, role: 'assistant', content: text ? [{ type: 'text', text }] : [], toolCalls: acceptedCalls.length ? acceptedCalls : undefined });
          state.messages.push(assistant);
          this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'assistant.message', data: { message: assistant } });
        }
        if (controller.signal.aborted) throw new AbortError('provider stream aborted');
        if (streamFailed) {
          const message = errorMessage(streamError);
          this.transition(run.id, text || calls.length ? 'partial' : 'failed', undefined, message);
          return;
        }
        if (!sawDone) {
          this.transition(run.id, 'partial', undefined, 'Provider 流在 done 事件前结束，未执行未确认的工具调用');
          return;
        }
        if (!calls.length) {
          const latest = this.loadState(session.id);
          const knownUsers = new Set(state.messages.filter((message) => message.role === 'user').map((message) => message.id));
          const supplemental = latest.messages.some((message) => message.role === 'user' && !knownUsers.has(message.id));
          if (supplemental) { state = this.loadRunState(session.id, run); continue; }
          if (finish === 'length') { this.transition(run.id, 'partial', undefined, '模型输出达到上限，已保留当前进度'); return; }
          this.saveState(session.id, this.loadRunState(session.id, run), run.id);
          this.transition(run.id, 'completed');
          return;
        }
        const requests: ToolExecutionRequestWithEmit[] = calls.map((call) => ({
          call,
          session,
          run,
          selection: this.store.getRunInput(run.id).selection,
          signal: controller.signal,
          emit: (type, data) => this.publish(session.id, { runId: run.id, turnId: run.turnId, type, data: { ...data, toolCallId: call.id } }),
        }));
        const batch = await this.executeToolBatch(run, session, state, snapshot, requests);
        state = batch.state;
        const wait = batch.wait;
        if (wait) {
          this.saveState(session.id, state, run.id);
          this.transition(run.id, wait.kind === 'jobs' ? 'waiting_jobs' : 'waiting_user', wait);
          this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'input.required', data: { wait } });
          return;
        }
        this.saveState(session.id, state, run.id);
        state = this.loadRunState(session.id, run);
      }
      this.transition(run.id, 'partial', undefined, `模型回合超过可配置上限 ${this.limits.maxModelTurns}`);
    } catch (error) {
      if (error instanceof AbortError || controller.signal.aborted || this.store.isStopRequested(runId)) this.transition(runId, 'stopped', undefined, '已停止后续 Agent 操作');
      else if (error instanceof SnapshotUnavailableError) {
        const current = this.store.getRun(runId);
        if (current) this.markSnapshotUnavailable(current, error.message);
      }
      else this.failRun(this.store.getRun(runId)!, errorMessage(error));
    } finally {
      this.controllers.delete(runId);
      this.activeSchedulers.delete(runId);
      const final = this.store.getRun(runId);
      if (final && ['completed', 'partial', 'stopped', 'failed'].includes(final.state)) {
        this.saveState(session.id, this.loadRunState(session.id, final), final.id);
      }
    }
  }

  private markSnapshotUnavailable(run: Run, reason: string): void {
    const wait: WaitRequest = {
      kind: 'question',
      id: `snapshot:${run.id}`,
      prompt: '当前运行依赖的 provider/tool/skill 版本无法恢复。恢复兼容版本或重新发起会话后才能继续。',
      payload: { requiresSnapshotRecovery: true, error: reason },
    };
    if (run.state !== 'waiting_user' || run.wait?.id !== wait.id) this.transition(run.id, 'waiting_user', wait, reason);
    this.publish(run.sessionId, { runId: run.id, turnId: run.turnId, type: 'input.required', data: { wait, recoveryRequired: true } });
  }

  private async compactForRun(run: Run, provider: Provider, state: ContextState, signal: AbortSignal, boundary = this.store.lastMessageOrdinal(run.sessionId)): Promise<ContextState> {
    this.transition(run.id, 'compacting');
    this.publish(run.sessionId, { runId: run.id, turnId: run.turnId, type: 'context.compacting', data: { automatic: true } });
    let result: { state: ContextState; changed: boolean; reason?: string };
    try { result = await this.context.compact(state, provider, run.model, signal); }
    catch (error) { result = { state, changed: false, reason: errorMessage(error) }; }
    if (result.changed) this.saveState(run.sessionId, result.state, run.id, boundary);
    this.publish(run.sessionId, { runId: run.id, turnId: run.turnId, type: 'context.compacted', data: { changed: result.changed, reason: result.reason } });
    this.transition(run.id, 'running');
    return result.state;
  }

  private async snapshotFor(run: Run): Promise<FrozenRunSnapshot> {
    const existing = this.snapshots.get(run.id);
    if (existing) return existing;
    this.syncTools();
    let provider: Provider;
    try { provider = this.providers.get(run.providerId); }
    catch { throw new SnapshotUnavailableError(`Provider ${run.providerId} is unavailable for run ${run.id}`); }
    const persisted = this.store.getRunSnapshot<PersistedRunSnapshot>(run.id);
    if (provider.revision !== run.providerRevision) throw new SnapshotUnavailableError(`Provider revision ${run.providerRevision} is unavailable for run ${run.id}`);
    const toolSnapshot = this.toolSource.snapshot();
    let tools: readonly ToolDefinition[];
    if (persisted?.version === 1 && Array.isArray(persisted.tools)) {
      const byName = new Map(toolSnapshot.tools.map((tool) => [tool.name, tool]));
      const restored: ToolDefinition[] = [];
      for (const descriptor of persisted.tools) {
        const current = byName.get(descriptor.name);
        if (!current || !this.sameToolDescriptor(current, descriptor)) throw new SnapshotUnavailableError(`Tool implementation ${descriptor.name}@${descriptor.revision} is unavailable for run ${run.id}`);
        restored.push(current);
      }
      tools = restored;
    } else {
      if (toolSnapshot.revision !== run.toolRevision) throw new SnapshotUnavailableError(`Tool revision ${run.toolRevision} is unavailable for run ${run.id}`);
      tools = toolSnapshot.tools;
    }
    const skills = this.skills.snapshot();
    const skillContents = new Map<string, string>(Object.entries(persisted?.version === 1 && persisted.skillContents && typeof persisted.skillContents === 'object' ? persisted.skillContents : {}));
    const skillsCompatible = skills.revision === run.skillRevision || !persisted || persisted.version !== 1
      ? skills.revision === run.skillRevision
      : this.sameSkillMetadata(skills, persisted.skills);
    const selectedNames = this.store.getRunInput(run.id).skillNames;
    if (!skillsCompatible && selectedNames.some((name) => !skillContents.has(name.split('@')[0]))) {
      throw new SnapshotUnavailableError(`Skill revision ${run.skillRevision} cannot be restored for run ${run.id}`);
    }
    const frozen: FrozenRunSnapshot = {
      provider,
      providerRevision: provider.revision,
      toolsRevision: run.toolRevision,
      tools,
      skillsRevision: run.skillRevision,
      skills,
      skillCatalog: persisted?.version === 1 && typeof persisted.skillCatalog === 'string' ? persisted.skillCatalog : this.skills.catalog(skills),
      skillContents,
      skillsCompatible,
    };
    this.snapshots.set(run.id, frozen);
    return frozen;
  }

  private serializeSnapshot(snapshot: FrozenRunSnapshot): PersistedRunSnapshot {
    return {
      version: 1,
      provider: { id: snapshot.provider.id, revision: snapshot.providerRevision, model: this.defaultModel(snapshot.provider) },
      tools: snapshot.tools.map((tool) => ({ name: tool.name, description: tool.description, revision: tool.revision, inputSchema: tool.inputSchema, effect: tool.effect, parallelSafe: tool.parallelSafe, ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }) })),
      skills: snapshot.skills.skills.map((skill) => ({ ...skill, dependencies: [...skill.dependencies] })),
      skillCatalog: snapshot.skillCatalog,
      skillContents: Object.fromEntries(snapshot.skillContents),
    };
  }

  private sameToolDescriptor(tool: ToolDefinition, descriptor: PersistedToolDescriptor): boolean {
    return tool.name === descriptor.name && tool.description === descriptor.description && tool.revision === descriptor.revision
      && tool.effect === descriptor.effect && tool.parallelSafe === descriptor.parallelSafe
      && (tool.timeoutMs ?? undefined) === (descriptor.timeoutMs ?? undefined)
      && stableJson(tool.inputSchema) === stableJson(descriptor.inputSchema);
  }

  private sameSkillMetadata(snapshot: SkillSnapshot, persisted: readonly Record<string, unknown>[]): boolean {
    if (!Array.isArray(persisted) || snapshot.skills.length !== persisted.length) return false;
    const current = snapshot.skills.map((skill) => ({ ...skill, dependencies: [...skill.dependencies] })).sort((a, b) => a.name.localeCompare(b.name) || a.revision.localeCompare(b.revision));
    const saved = persisted.map((skill) => ({ ...skill, dependencies: Array.isArray(skill.dependencies) ? [...skill.dependencies] : [] })).sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.revision).localeCompare(String(b.revision)));
    return stableJson(current) === stableJson(saved);
  }

  private makeScheduler(run: Run, registry: ToolRegistry): ToolScheduler {
    return new ToolScheduler({
      store: this.store,
      registry,
      limits: this.limits,
      parallelism: this.parallelism,
      locks: this.canvasLocks,
      sideEffects: this.canvasSideEffects,
      beforeExecute: this.beforeToolExecute,
      afterExecute: this.afterToolExecute,
      allowExternalWithoutPolicy: this.allowExternalWithoutPolicy,
      special: async (request, operationId) => this.specialTool(request, operationId),
    });
  }

  private async executeToolBatch(
    run: Run,
    session: Session,
    state: ContextState,
    snapshot: FrozenRunSnapshot,
    requests: readonly ToolExecutionRequestWithEmit[],
  ): Promise<{ state: ContextState; wait?: WaitRequest }> {
    const scheduler = this.makeScheduler(run, new ToolRegistry(snapshot.tools));
    this.activeSchedulers.set(run.id, scheduler);
    try {
      const results = await scheduler.executeBatch(requests);
      let wait: WaitRequest | undefined;
      for (const execution of results) {
        // Inspect the complete durable result before applying the model-facing
        // size cap, so job IDs and asset references are never lost.
        this.recordJobFromResult(execution.operationId, session.id, run.id, execution.result);
        this.addViewedAssets(state, execution.result);
        const modelResult = this.persistResultReference(session.id, run.id, execution.operationId, execution.result);
        const existing = this.store.findToolMessage(session.id, run.id, execution.call.id);
        const message = existing ?? this.store.appendMessage({ id: randomUUID(), sessionId: session.id, runId: run.id, role: 'tool', content: modelResult.content, callId: execution.call.id });
        if (!state.messages.some((item) => item.id === message.id)) state.messages.push(message);
        this.publish(session.id, {
          runId: run.id,
          turnId: run.turnId,
          type: modelResult.error ? 'tool.failed' : 'tool.completed',
          data: { toolCallId: execution.call.id, name: execution.call.name, result: modelResult, operationId: execution.operationId, success: !modelResult.error, replayed: Boolean(existing) },
        });
        if (!wait && modelResult.wait) wait = modelResult.wait;
      }
      if (!wait) {
        this.store.clearPendingCalls(run.id);
        this.store.clearPendingWait(run.id);
      }
      return { state, wait };
    } finally {
      this.activeSchedulers.delete(run.id);
    }
  }

  private async deferPendingCalls(run: Run, pending: ReturnType<SqliteStore['listPendingCalls']>, reason: string, approvalDenied = true): Promise<void> {
    const session = this.getSession(run.sessionId);
    const snapshot = await this.snapshotFor(run);
    for (const item of pending) {
      const operationId = operationIdFor(run.id, item.call.id);
      const definition = snapshot.tools.find((tool) => tool.name === item.call.name);
      const fingerprint = stableJson({ name: item.call.name, arguments: item.call.arguments });
      const denied: ToolResult = {
        content: [{ type: 'text', text: approvalDenied ? `用户拒绝执行工具 ${item.call.name}：${reason}` : `工具 ${item.call.name} 尚未执行。请结合用户的新答复重新确定操作参数：${reason}` }],
        error: { code: approvalDenied ? 'approval_denied' : 'replan_after_user_reply', message: approvalDenied ? '用户未批准该工具操作。' : '用户已补充信息，请重新规划剩余调用。' },
      };
      const existing = this.store.getOperation(operationId);
      if (!existing || ['pending', 'canceled'].includes(existing.state)) {
        this.store.saveOperation({ operationId, sessionId: session.id, runId: run.id, callId: item.call.id, toolName: item.call.name, effect: definition?.effect ?? 'read', fingerprint, state: 'failed', arguments: item.call.arguments, result: denied, error: denied.error });
      }
      const message = this.store.findToolMessage(session.id, run.id, item.call.id) ?? this.store.appendMessage({ id: randomUUID(), sessionId: session.id, runId: run.id, role: 'tool', content: denied.content, callId: item.call.id });
      this.publish(session.id, { runId: run.id, turnId: run.turnId, type: 'tool.failed', data: { toolCallId: item.call.id, name: item.call.name, result: denied, operationId, success: false, ...(approvalDenied ? { approval: 'denied' } : {}), messageId: message.id } });
    }
    this.store.clearPendingCalls(run.id);
  }

  private approvalDecision(text: string): 'approve' | 'deny' | undefined {
    const normalized = text.trim().toLocaleLowerCase();
    if (['approve', 'approved', 'yes', 'y', 'allow', 'ok', '允许', '同意', '确认'].includes(normalized)) return 'approve';
    if (['deny', 'denied', 'no', 'n', 'reject', 'rejected', '拒绝', '不允许', '不同意', '取消'].includes(normalized)) return 'deny';
    return undefined;
  }

  private async specialTool(request: { call: ToolCall; session: Session; run: Run }, operationId: string): Promise<ToolResult | undefined> {
    if (request.call.name === 'result_read') {
      const args = asRecord(request.call.arguments);
      const ref = safeString(args?.resultRef);
      if (!ref) return { content: [{ type: 'text', text: 'resultRef is required' }], error: { code: 'invalid_result_ref', message: 'resultRef is required' } };
      const page = this.store.readResult(ref, request.session.id, typeof args?.cursor === 'number' ? args.cursor : 0, typeof args?.limit === 'number' ? args.limit : 100);
      if (!page) return { content: [{ type: 'text', text: 'Result reference is missing, expired, or belongs to another session' }], error: { code: 'result_not_found', message: 'Result reference is missing, expired, or belongs to another session' } };
      return { content: [{ type: 'text', text: safeJson(page.value) }], data: { resultRef: ref, nextCursor: page.nextCursor, createdAt: page.createdAt } };
    }
    if (request.call.name === 'ask_user') {
      const args = asRecord(request.call.arguments);
      const prompt = safeString(args?.prompt).trim();
      if (!prompt) return { content: [{ type: 'text', text: 'prompt is required' }], error: { code: 'invalid_question', message: 'prompt is required' } };
      const kind = args?.kind === 'approval' ? 'approval' : 'question';
      const options = Array.isArray(args?.options) ? args.options.filter((item): item is string => typeof item === 'string').slice(0, 20) : undefined;
      const payload = asRecord(args?.payload);
      const wait: WaitRequest = { kind, id: `wait:${operationId}`, prompt, options, payload };
      return { content: [{ type: 'text', text: prompt }], wait };
    }
    if (request.call.name === 'skill_read') {
      const args = asRecord(request.call.arguments);
      const name = safeString(args?.name).trim();
      if (!name) return { content: [{ type: 'text', text: 'name is required' }], error: { code: 'invalid_skill_name', message: 'name is required' } };
      const frozen = this.snapshots.get(request.run.id);
      const snapshot = frozen?.skills ?? this.skills.snapshot();
      try {
        const resource = args?.resource;
        const parsedName = name.split('@')[0];
        let value = typeof resource === 'string' && resource.length > 0 ? undefined : frozen?.skillContents.get(parsedName);
        if (value === undefined) {
          if (frozen && !frozen.skillsCompatible) throw new SnapshotUnavailableError(`Skill ${name} 的冻结正文无法恢复`);
          value = typeof resource === 'string' && resource.length > 0
            ? await this.skills.resource(name, resource, snapshot)
            : await this.skills.read(name, snapshot);
          if (frozen && (!resource || typeof resource !== 'string')) {
            frozen.skillContents.set(parsedName, value);
            this.store.saveRunSnapshot(request.run.id, this.serializeSnapshot(frozen));
          }
        }
        const metadata = snapshot.skills.find((skill) => skill.name === name);
        return { content: [{ type: 'text', text: value }], data: { name, revision: metadata?.revision, resource: typeof resource === 'string' ? resource : undefined } };
      } catch (error) {
        return { content: [{ type: 'text', text: `Skill ${name} is unavailable: ${errorMessage(error)}` }], error: { code: 'skill_unavailable', message: errorMessage(error) } };
      }
    }
    return undefined;
  }

  private persistResultReference(sessionId: string, runId: string, operationId: string, result: ToolResult): ToolResult {
    let serialized: string;
    try { serialized = JSON.stringify(result) ?? ''; } catch { serialized = '[unserializable result]'; }
    if (serialized.length <= this.limits.maxToolResultChars) return result;
    const ref = `result:${sessionId}:${operationId}:${randomUUID()}`;
    this.store.saveResult(ref, sessionId, result, operationId);
    const summary = result.error ? `工具返回错误 ${result.error.code}: ${result.error.message}` : '工具结果较大，已保存为可分页回读记录。';
    return { content: [{ type: 'text', text: `${summary} resultRef=${ref}` }], data: { resultRef: ref, truncated: true, bytes: serialized.length }, error: result.error, wait: result.wait };
  }

  private async resolveProviderMessages(messages: import('../contracts/index.js').Message[], scope: { ownerId: string; canvasId: string }, signal: AbortSignal): Promise<import('../contracts/index.js').Message[]> {
    const resolved: import('../contracts/index.js').Message[] = [];
    for (const message of messages) {
      const content: ContentPart[] = [];
      for (const part of message.content) {
        if (signal.aborted) throw new AbortError('run stopped');
        if (part.type === 'asset' || (part.type === 'image' && part.asset)) {
          const ref = part.type === 'asset' ? part.ref : part.asset!;
          if (!this.assets?.available) throw new Error(`资产 ${ref.assetId}@${ref.version} 当前不可用，无法安全发送给模型`);
          const access = await this.assets.view(scope, ref);
          if (access.kind === 'image') content.push({ type: 'image', url: access.url, mimeType: access.mimeType, asset: ref });
          else content.push({ type: 'text', text: `资产 ${ref.assetId}@${ref.version} 类型为 ${access.kind}，当前模型输入不支持直接查看。` });
          continue;
        }
        content.push({ ...part });
      }
      resolved.push({ ...message, content });
    }
    return resolved;
  }

  private addViewedAssets(state: ContextState, result: ToolResult): void {
    const refs: Array<{ assetId: string; version: number; role?: 'reference' | 'edit_source' | 'result' }> = [];
    const data = asRecord(result.data);
    const candidate = data?.ref;
    if (candidate && typeof candidate === 'object' && typeof (candidate as Record<string, unknown>).assetId === 'string' && Number.isInteger((candidate as Record<string, unknown>).version)) refs.push(candidate as { assetId: string; version: number; role?: 'reference' | 'edit_source' | 'result' });
    for (const part of result.content) if (part.type === 'image' && part.asset) refs.push(part.asset);
    const existing = new Set(state.viewedAssets.map((ref) => `${ref.assetId}@${ref.version}`));
    for (const ref of refs) {
      const key = `${ref.assetId}@${ref.version}`;
      if (!existing.has(key)) { state.viewedAssets.push({ ...ref }); existing.add(key); }
    }
  }

  private recordJobFromResult(operationId: string, sessionId: string, runId: string, result: ToolResult): void {
    const data = asRecord(result.data);
    const candidate = asRecord(data?.job) ?? (data && typeof data.id === 'string' && typeof data.state === 'string' ? data : undefined);
    if (!candidate || typeof candidate.id !== 'string' || typeof candidate.nodeId !== 'string' || typeof candidate.state !== 'string') return;
    const states = ['created', 'submitting', 'submitted', 'running', 'succeeded', 'failed', 'canceled', 'submission_unknown'] as const;
    if (!states.includes(candidate.state as typeof states[number])) return;
    this.store.saveJob({
      id: candidate.id,
      operationId,
      sessionId,
      runId,
      nodeId: candidate.nodeId,
      state: candidate.state as typeof states[number],
      remoteId: typeof candidate.remoteId === 'string' ? candidate.remoteId : undefined,
      results: Array.isArray(candidate.results) ? candidate.results as Array<{ assetId: string; version: number; role?: 'reference' | 'edit_source' | 'result' }> : [],
      storageState: ['pending', 'stored', 'failed'].includes(String(candidate.storageState)) ? candidate.storageState as 'pending' | 'stored' | 'failed' : 'pending',
      applyState: ['pending', 'applied', 'conflict', 'target_missing'].includes(String(candidate.applyState)) ? candidate.applyState as 'pending' | 'applied' | 'conflict' | 'target_missing' : 'pending',
      error: typeof candidate.error === 'string' ? candidate.error : undefined,
    });
  }

  private appendRecoveredToolResult(sessionId: string, runId: string, callId: string, result: ToolResult): import('../contracts/index.js').Message {
    const existing = this.store.findToolMessage(sessionId, runId, callId);
    if (existing) return this.store.updateMessageContent(existing.id, result.content) ?? existing;
    return this.store.appendMessage({ id: randomUUID(), sessionId, runId, role: 'tool', content: result.content, callId });
  }

  private appendUserMessage(sessionId: string, runId: string, text: string, _selection?: Selection): import('../contracts/index.js').Message {
    const content: ContentPart[] = [{ type: 'text', text }];
    return this.store.appendMessage({ id: randomUUID(), sessionId, runId, role: 'user', content });
  }

  private loadState(sessionId: string, boundary?: number): ContextState {
    const checkpoint = this.store.getLatestCheckpoint(sessionId);
    const all = this.store.listMessages(sessionId, boundary === undefined ? {} : { before: boundary });
    if (!checkpoint) return { messages: all, summaryVersion: 0, pinned: {}, viewedAssets: [] };
    const retained = checkpoint.state.messages.map((message) => ({ ...message, content: message.content.map((part) => ({ ...part })) }));
    const known = new Set(retained.map((message) => message.id));
    const lastOrdinal = checkpoint.lastMessageOrdinal ?? 0;
    for (const message of this.store.listMessages(sessionId, boundary === undefined ? { after: lastOrdinal } : { after: lastOrdinal, before: boundary })) {
      if (!known.has(message.id)) { retained.push(message); known.add(message.id); }
    }
    return { ...checkpoint.state, messages: retained, pinned: { ...checkpoint.state.pinned }, viewedAssets: [...checkpoint.state.viewedAssets] };
  }

  private loadRunState(sessionId: string, run: Run, boundary?: number): ContextState {
    const state = this.loadState(sessionId, boundary);
    const input = this.store.getRunInput(run.id);
    state.pinned = { ...state.pinned, activeSelection: input.selection ?? null, activeSkillNames: input.skillNames, runId: run.id, provider: `${run.providerId}@${run.providerRevision}` };
    return state;
  }

  private saveState(sessionId: string, state: ContextState, runId?: string, lastMessageOrdinal?: number): void {
    this.store.saveCheckpoint({ id: randomUUID(), sessionId, runId, state, summaryVersion: state.summaryVersion, createdAt: now(), lastMessageOrdinal: lastMessageOrdinal ?? this.store.lastMessageOrdinal(sessionId) });
  }

  private async systemForRun(snapshot: FrozenRunSnapshot, names: string[], signal: AbortSignal, sessionId: string, run: Run): Promise<string> {
    const sections = [this.systemPrompt];
    const catalog = snapshot.skillCatalog || this.skills.catalog(snapshot.skills);
    if (catalog) sections.push(`当前可用 Skill：\n${catalog}`);
    let snapshotChanged = false;
    for (const name of names) {
      if (signal.aborted) throw new AbortError('run stopped');
      try {
        const parsedName = name.split('@')[0];
        let body = snapshot.skillContents.get(parsedName);
        if (body === undefined) {
          if (!snapshot.skillsCompatible) throw new SnapshotUnavailableError(`Skill ${name} 的冻结正文无法恢复`);
          body = await this.skills.read(name, snapshot.skills);
          snapshot.skillContents.set(parsedName, body);
          snapshotChanged = true;
        }
        sections.push(`Skill ${name}（已冻结版本）：\n${body}`);
        this.publish(sessionId, { runId: run.id, turnId: run.turnId, type: 'skill.loaded', data: { name, revision: snapshot.skills.skills.find((skill) => skill.name === name)?.revision } });
      } catch (error) {
        this.publish(sessionId, { runId: run.id, turnId: run.turnId, type: 'skill.unavailable', data: { name, error: errorMessage(error) } });
        throw new Error(`Skill ${name} is unavailable in the frozen snapshot: ${errorMessage(error)}`, { cause: error });
      }
    }
    if (snapshotChanged) this.store.saveRunSnapshot(run.id, this.serializeSnapshot(snapshot));
    return sections.join('\n\n');
  }

  private toolSpecs(tools: readonly ToolDefinition[]): ToolSpec[] {
    return [...tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, revision: tool.revision })), ...RUNTIME_BUILTIN_SPECS];
  }

  private syncTools(): void {
    if (this.toolSource === this.tools) return;
    const source = this.toolSource.snapshot().tools;
    const names = new Set(source.map((tool) => tool.name));
    for (const existing of this.tools.list()) if (!names.has(existing.name)) this.tools.unregister(existing.name);
    for (const definition of source) {
      if (this.tools.has(definition.name)) this.tools.unregister(definition.name);
      this.tools.register(definition);
    }
  }

  private transition(runId: string, state: Run['state'], wait?: WaitRequest, error?: string): Run {
    const run = this.store.updateRun(runId, { state, wait, error });
    this.publishRun(run);
    if (state === 'completed') this.publish(run.sessionId, { runId, turnId: run.turnId, type: 'run.completed', data: { state } });
    else if (state === 'partial') this.publish(run.sessionId, { runId, turnId: run.turnId, type: 'run.partial', data: { state, error } });
    else if (state === 'stopped') this.publish(run.sessionId, { runId, turnId: run.turnId, type: 'run.stopped', data: { state, error } });
    else if (state === 'failed') this.publish(run.sessionId, { runId, turnId: run.turnId, type: 'run.failed', data: { state, error } });
    return run;
  }

  private failRun(run: Run, error: string): void {
    if (['completed', 'partial', 'stopped', 'failed'].includes(run.state)) return;
    this.transition(run.id, 'failed', undefined, error);
  }

  private publishRun(run: Run): void {
    this.publish(run.sessionId, { runId: run.id, turnId: run.turnId, type: 'run.updated', data: { state: run.state, wait: run.wait, error: run.error, updatedAt: run.updatedAt, providerId: run.providerId, model: run.model } });
  }

  private publish(sessionId: string, input: { runId?: string; turnId?: string; type: string; data: Record<string, unknown> }): AgentEvent {
    const event = this.store.appendEvent({ sessionId, runId: input.runId, turnId: input.turnId, type: input.type, data: input.data });
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try { listener(event); } catch { /* one broken SSE client cannot stop the runtime */ }
    }
    return event;
  }

  private normalizeToolCall(call: ToolCall): ToolCall {
    if (typeof call.arguments !== 'string') return call;
    try { return { ...call, arguments: JSON.parse(call.arguments) }; }
    catch { return { ...call, arguments: { __invalidArguments: call.arguments } }; }
  }

  private defaultModel(provider: Provider): string {
    const candidate = (provider as Provider & { model?: unknown }).model;
    return typeof candidate === 'string' && candidate ? candidate : 'default';
  }

  private validateText(text: string): void {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('text is required');
    if (text.length > this.limits.maxMessageChars) throw new Error(`text exceeds ${this.limits.maxMessageChars} characters`);
  }

  private validateSelection(selection?: Selection): Selection | undefined {
    if (!selection) return undefined;
    if (!Array.isArray(selection.nodeIds) || !Array.isArray(selection.assets)) throw new Error('selection must contain nodeIds and assets arrays');
    if (selection.nodeIds.length + selection.assets.length > this.limits.maxSelectionItems) throw new Error('selection is too large');
    for (const id of selection.nodeIds) if (typeof id !== 'string' || !id) throw new Error('selection node id is invalid');
    for (const ref of selection.assets) if (!ref || typeof ref.assetId !== 'string' || !Number.isInteger(ref.version) || ref.version < 1) throw new Error('selection asset reference is invalid');
    return { nodeIds: [...selection.nodeIds], assets: selection.assets.map((ref) => ({ ...ref })), revision: selection.revision };
  }

  private validateSkillNames(names?: string[]): string[] {
    if (!names) return [];
    if (!Array.isArray(names) || names.length > 100) throw new Error('skillNames is invalid');
    return names.map((name) => { if (typeof name !== 'string' || !name || name.length > 160) throw new Error('skill name is invalid'); return name; });
  }
}

class AbortError extends Error {
  constructor(message: string) { super(message); this.name = 'AbortError'; }
}

class SnapshotUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotUnavailableError'; }
}

export { RESULT_READ_SPEC, ASK_USER_SPEC };
