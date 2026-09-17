import type {
  AgentEvent,
  AssetRef,
  HostBridge,
  JobRecord,
  Run,
  RunState,
  Selection,
  Session,
  WaitRequest,
} from '../contracts/index';

export type { AssetRef, HostBridge, Selection };

export interface ApiError extends Error {
  status?: number;
  retryable?: boolean;
  details?: unknown;
}

export interface AgentClientLike {
  providerSettings?(): Promise<ProviderSettingsView>;
  saveProviderSettings?(input: ProviderSettingsInput): Promise<ProviderSettingsView>;
  health(): Promise<unknown>;
  capabilities(): Promise<unknown>;
  createSession(input: { canvasId: string; providerId?: string; model?: string }): Promise<unknown>;
  listSessions(canvasId?: string): Promise<unknown>;
  getSession(sessionId: string): Promise<unknown>;
  sendMessage(
    sessionId: string,
    input: { text: string; selection: Selection; skillNames?: string[] },
    requestId?: string,
  ): Promise<unknown>;
  streamEvents(sessionId: string, after: number, signal?: AbortSignal): Promise<AsyncIterable<SseEnvelope>>;
  recoverEvents?(sessionId: string, options?: { after?: number; signal?: AbortSignal; maxReconnects?: number; reconnectDelayMs?: number; onRecovery?: (nextSequence: number) => void }): AsyncIterable<SseEnvelope>;
  stopRun(runId: string): Promise<unknown>;
  replyRun(runId: string, input: { text: string; waitId: string }): Promise<unknown>;
  compact(sessionId: string): Promise<unknown>;
}

export interface ProviderSettingsInput { providerId: 'dangoo-platform'; model: string; }
export interface ProviderSettingsView extends ProviderSettingsInput { configured?: boolean; platformModels?: string[]; }

export interface SseEnvelope {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
  json?: unknown;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'recovering' | 'offline' | 'error';

export interface AssetCardData {
  ref: AssetRef;
  name: string;
  kind?: 'image' | 'video' | 'audio';
  thumbnailUrl?: string;
  source?: string;
  status?: 'ready' | 'missing' | 'uploading' | 'failed';
  description?: string;
}

export interface ChatAttachment extends AssetCardData {
  role?: AssetRef['role'];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  attachments: ChatAttachment[];
  createdAt: number;
  /** Runtime correlation fields stay in memory so an optimistic user row can be reconciled. */
  runId?: string;
  requestId?: string;
  pending?: boolean;
  streaming?: boolean;
  failed?: boolean;
}

export type ToolStepState = 'running' | 'completed' | 'failed' | 'waiting';

export interface ToolStep {
  id: string;
  name: string;
  label: string;
  target?: string;
  state: ToolStepState;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  nodeId?: string;
  asset?: AssetCardData;
}

export type UiJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'unknown';

export interface JobCardData {
  id: string;
  label: string;
  state: UiJobState;
  index?: number;
  total?: number;
  resultAssets: AssetCardData[];
  nodeId?: string;
  error?: string;
  updatedAt?: number;
}

export interface PendingInput {
  id: string;
  kind: 'question' | 'approval' | 'jobs';
  prompt: string;
  options?: string[];
  jobIds?: string[];
  payload?: Record<string, unknown>;
}

export interface RunView {
  id: string;
  sessionId: string;
  turnId?: string;
  state: RunState;
  providerId?: string;
  model?: string;
  error?: string;
  wait?: PendingInput;
  updatedAt?: number;
}

export interface AgentEventView {
  id: string;
  sequence: number;
  type: string;
  createdAt: number;
  data: Record<string, unknown>;
}

export interface AgentSessionView {
  id: string;
  canvasId: string;
  createdAt?: number;
  providerId?: string;
  model?: string;
  state?: RunState | 'idle';
}

export interface AgentStoreState {
  session?: AgentSessionView;
  messages: ChatMessage[];
  events: AgentEventView[];
  tools: ToolStep[];
  jobs: JobCardData[];
  runs: Record<string, RunView>;
  activeRunId?: string;
  pendingInput?: PendingInput;
  registeredAssets: AssetCardData[];
  draft: string;
  attachments: ChatAttachment[];
  connection: ConnectionState;
  lastSequence: number;
  unreadCount: number;
  nearBottom: boolean;
  lastSentText?: string;
  lastSentSelection?: Selection;
  error?: string;
  compacting: boolean;
}

export type AgentStoreAction =
  | { type: 'session.loaded'; session: AgentSessionView; messages?: ChatMessage[]; events?: AgentEventView[]; sequence?: number }
  | { type: 'session.reset' }
  | { type: 'message.added'; message: ChatMessage }
  | { type: 'message.linked'; id: string; runId: string; requestId?: string }
  | { type: 'message.delta'; id: string; text: string; createdAt?: number }
  | { type: 'message.finalized'; id?: string }
  | { type: 'event.received'; event: AgentEventView }
  | { type: 'connection.changed'; state: ConnectionState; error?: string }
  | { type: 'draft.changed'; draft: string }
  | { type: 'attachment.added'; attachment: ChatAttachment }
  | { type: 'attachment.removed'; key: string }
  | { type: 'attachments.replaced'; attachments: ChatAttachment[] }
  | { type: 'run.upserted'; run: RunView }
  | { type: 'input.required'; input: PendingInput }
  | { type: 'input.cleared'; id?: string }
  | { type: 'tool.upserted'; tool: ToolStep }
  | { type: 'job.upserted'; job: JobCardData }
  | { type: 'asset.registered'; asset: AssetCardData }
  | { type: 'compact.changed'; compacting: boolean }
  | { type: 'unread.cleared' }
  | { type: 'near-bottom.changed'; value: boolean }
  | { type: 'error.changed'; error?: string };

export interface AgentStore {
  getState(): AgentStoreState;
  subscribe(listener: () => void): () => void;
  dispatch(action: AgentStoreAction): void;
  loadSession(sessionId: string): Promise<void>;
  ensureSession(): Promise<void>;
  resetSession(): void;
  startEvents(sessionId?: string): void;
  stopEvents(): void;
  sendMessage(text: string, skillNames?: string[]): Promise<void>;
  stopActiveRun(): Promise<void>;
  reply(input: { text: string; waitId: string }): Promise<void>;
  compact(): Promise<void>;
  retryLastMessage(): Promise<void>;
  setDraft(value: string): void;
  addAttachment(attachment: ChatAttachment): void;
  removeAttachment(ref: AssetRef): void;
  clearUnread(): void;
  setNearBottom(value: boolean): void;
  resume(): void;
  destroy(): void;
}

export interface AgentStoreOptions {
  client: AgentClientLike;
  hostBridge: HostBridge;
  canvasId: string;
  sessionId?: string;
  providerId?: string;
  model?: string;
  skillNames?: string[];
  maxReconnects?: number;
}

export interface FloatingAgentChatProps {
  client?: AgentClientLike;
  hostBridge: HostBridge;
  canvasId?: string;
  sessionId?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  serviceConfigured?: boolean;
  serviceState?: 'checking' | 'ready' | 'unavailable' | 'unconfigured';
  serviceConfig?: { providerId?: string; providerName?: string; model?: string };
  /** Width reserved by a host side rail so the floating panel starts beside it on wide screens. */
  avoidRight?: number;
  initialAttachments?: ChatAttachment[];
  onResolveAttachment?: (file: File) => Promise<ChatAttachment | undefined>;
  className?: string;
}

export interface SnapshotLike {
  session?: unknown;
  messages?: unknown[];
  events?: unknown[];
  sequence?: number;
  lastSequence?: number;
  [key: string]: unknown;
}

export function assetKey(ref: Pick<AssetRef, 'assetId' | 'version' | 'role'>): string {
  return `${ref.assetId}@${ref.version}:${ref.role ?? ''}`;
}

export function selectionWithAttachments(selection: Selection, attachments: readonly ChatAttachment[]): Selection {
  const assets = [...selection.assets];
  const seen = new Set(assets.map(assetKey));
  for (const attachment of attachments) {
    const key = assetKey(attachment.ref);
    if (!seen.has(key)) {
      seen.add(key);
      assets.push(attachment.ref);
    }
  }
  return { ...selection, nodeIds: [...new Set(selection.nodeIds)], assets };
}

export function runFromUnknown(value: unknown, fallbackSessionId: string): RunView | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const id = stringValue(source.id ?? source.runId);
  if (!id) return undefined;
  const state = runStateValue(source.state ?? source.status) ?? 'running';
  const wait = waitFromUnknown(source.wait ?? source.input ?? source.pendingInput);
  return {
    id,
    sessionId: stringValue(source.sessionId) ?? fallbackSessionId,
    turnId: stringValue(source.turnId),
    state,
    providerId: stringValue(source.providerId),
    model: stringValue(source.model),
    error: stringValue(source.error),
    wait,
    updatedAt: numberValue(source.updatedAt ?? source.createdAt),
  };
}

export function waitFromUnknown(value: unknown): PendingInput | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const id = stringValue(source.id ?? source.waitId ?? source.pendingInputId);
  const prompt = stringValue(source.prompt ?? source.question ?? source.message);
  const kind = source.kind === 'approval' || source.kind === 'jobs' ? source.kind : 'question';
  if (!id || !prompt) return undefined;
  const options = Array.isArray(source.options) ? source.options.filter((item): item is string => typeof item === 'string') : undefined;
  const jobIds = Array.isArray(source.jobIds) ? source.jobIds.filter((item): item is string => typeof item === 'string') : undefined;
  const payload = source.payload && typeof source.payload === 'object' ? source.payload as Record<string, unknown> : undefined;
  return { id, kind, prompt, options, jobIds, payload };
}

export function runStateValue(value: unknown): RunState | undefined {
  const state = stringValue(value) as RunState | undefined;
  if (!state) return undefined;
  const allowed: RunState[] = ['queued', 'running', 'waiting_user', 'waiting_jobs', 'compacting', 'completed', 'partial', 'stopped', 'failed'];
  return allowed.includes(state) ? state : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function toAssetCard(value: unknown): AssetCardData | undefined {
  const source = recordValue(value);
  if (!source) return undefined;
  const refSource = recordValue(source.ref ?? source.asset ?? source);
  if (!refSource) return undefined;
  const assetId = stringValue(refSource.assetId ?? refSource.id);
  const version = numberValue(refSource.version) ?? 1;
  if (!assetId) return undefined;
  const role = refSource.role === 'reference' || refSource.role === 'edit_source' || refSource.role === 'result' ? refSource.role : undefined;
  const kind = refSource.mediaType === 'video' || refSource.mediaType === 'audio' ? refSource.mediaType : 'image';
  const status = source.status === 'missing' || source.status === 'uploading' || source.status === 'failed' ? source.status : 'ready';
  return {
    ref: { assetId, version, ...(role ? { role } : {}) },
    name: stringValue(source.name ?? source.title ?? refSource.name) ?? assetId,
    kind,
    thumbnailUrl: safeHttpUrl(stringValue(source.thumbnailUrl ?? source.thumbnail ?? source.url)),
    source: stringValue(source.source ?? source.origin),
    status,
    description: stringValue(source.description),
  };
}

export function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(textFromContent).filter(Boolean).join('');
  }
  const source = recordValue(value);
  if (!source) return '';
  if (typeof source.text === 'string') return source.text;
  if (typeof source.content === 'string') return source.content;
  return '';
}

export function messageFromUnknown(value: unknown, fallbackId: string): ChatMessage | undefined {
  const source = recordValue(value);
  if (!source) return undefined;
  if (source.role === 'tool') return undefined;
  const id = stringValue(source.id ?? source.messageId) ?? fallbackId;
  const role = source.role === 'user' || source.role === 'system' ? source.role : 'assistant';
  const text = textFromContent(source.text ?? source.content ?? source.message);
  const rawAttachments = Array.isArray(source.attachments) ? source.attachments : Array.isArray(source.content) ? source.content : [];
  const attachments = rawAttachments.map(toAssetCard).filter((item): item is AssetCardData => Boolean(item));
  if (role === 'assistant' && !text && attachments.length === 0) return undefined;
  return {
    id,
    role,
    text,
    attachments,
    createdAt: numberValue(source.createdAt ?? source.timestamp) ?? Date.now(),
    streaming: Boolean(source.streaming),
    failed: Boolean(source.failed),
  };
}

export function isHiddenThoughtEvent(type: string): boolean {
  const normalized = type.toLowerCase();
  return normalized.includes('reasoning') || normalized.includes('thinking') || normalized.includes('thought') || normalized.includes('chain_of_thought');
}

export function asAgentEvent(value: unknown, fallbackSequence = 0): AgentEventView | undefined {
  const source = recordValue(value);
  if (!source) return undefined;
  const type = stringValue(source.type ?? source.event ?? source.name);
  if (!type || isHiddenThoughtEvent(type)) return undefined;
  const sequence = numberValue(source.sequence ?? source.seq ?? source.id) ?? fallbackSequence;
  const data = recordValue(source.data) ?? source;
  const id = stringValue(source.itemId ?? source.eventId ?? source.id) ?? `${type}:${sequence}`;
  return { id, sequence, type, createdAt: numberValue(source.createdAt ?? source.timestamp) ?? Date.now(), data };
}

// Kept as type-only imports above to make the UI package usable in host builds that tree-shake contracts.
export type { AgentEvent, JobRecord, Run, Session, WaitRequest };
