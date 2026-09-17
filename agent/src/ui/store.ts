import { eventPayload, eventSequence } from './sse';
import type {
  AgentEventView,
  AgentSessionView,
  AgentStore,
  AgentStoreAction,
  AgentStoreOptions,
  AgentStoreState,
  AssetCardData,
  ChatMessage,
  JobCardData,
  RunView,
  Selection,
  SseEnvelope,
  ToolStep,
} from './types';
import {
  asAgentEvent,
  assetKey,
  messageFromUnknown,
  recordValue,
  runFromUnknown,
  stringValue,
  textFromContent,
  toAssetCard,
  waitFromUnknown,
  isHiddenThoughtEvent,
} from './types';
import { selectionWithAttachments } from './types';

const INITIAL_STATE: AgentStoreState = {
  messages: [],
  events: [],
  tools: [],
  jobs: [],
  runs: {},
  registeredAssets: [],
  draft: '',
  attachments: [],
  connection: 'idle',
  lastSequence: 0,
  unreadCount: 0,
  nearBottom: true,
  compacting: false,
};

let idCounter = 0;

export function createUiId(prefix: string): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    // Some embedded browsers expose crypto without randomUUID.
  }
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function dataRecord(event: AgentEventView): Record<string, unknown> {
  return recordValue(event.data.data) ?? event.data;
}

function friendlyToolName(value: string): string {
  const key = value.toLowerCase().replace(/[-\s]/g, '_');
  const labels: Record<string, string> = {
    asset_view: '查看参考图',
    asset_search: '查找素材',
    canvas_read: '读取画布',
    canvas_apply: '更新画布',
    node_create: '创建节点',
    node_update: '更新节点',
    node_layout: '整理布局',
    node_run: '提交生成',
    job_wait: '等待生成',
  };
  return labels[key] ?? value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stepFromEvent(event: AgentEventView, existing?: ToolStep): ToolStep | undefined {
  const data = dataRecord(event);
  const id = stringValue(data.toolCallId ?? data.callId ?? data.itemId ?? data.id) ?? existing?.id;
  if (!id) return undefined;
  const rawName = stringValue(data.name ?? data.tool ?? data.operation) ?? existing?.name ?? 'tool';
  let state: ToolStep['state'] = existing?.state ?? 'running';
  if (event.type === 'tool.completed') state = 'completed';
  if (event.type === 'tool.failed') state = 'failed';
  if (event.type === 'input.required') state = 'waiting';
  const startedAt = existing?.startedAt ?? numberValue(data.startedAt ?? data.timestamp ?? event.createdAt);
  const completedAt = numberValue(data.completedAt ?? event.createdAt);
  const durationMs = numberValue(data.durationMs) ?? (startedAt && completedAt ? Math.max(0, completedAt - startedAt) : existing?.durationMs);
  const result = recordValue(data.result);
  const resultData = recordValue(result?.data);
  const asset = toAssetCard(data.asset ?? data.resultAsset ?? resultData?.ref ?? result?.asset);
  return {
    id,
    name: rawName,
    label: stringValue(data.label ?? data.summary ?? data.description) ?? existing?.label ?? friendlyToolName(rawName),
    target: stringValue(data.target ?? data.nodeName ?? data.assetName) ?? existing?.target,
    state,
    startedAt,
    completedAt: event.type === 'tool.completed' || event.type === 'tool.failed' ? completedAt : existing?.completedAt,
    durationMs,
    error: stringValue(data.error ?? data.message) ?? existing?.error,
    nodeId: stringValue(data.nodeId) ?? existing?.nodeId,
    asset: asset ?? existing?.asset,
  };
}

function jobState(value: unknown): JobCardData['state'] {
  if (value === 'queued' || value === 'created' || value === 'submitting' || value === 'submitted') return 'queued';
  if (value === 'running') return 'running';
  if (value === 'succeeded' || value === 'completed' || value === 'stored' || value === 'applied') return 'succeeded';
  if (value === 'failed') return 'failed';
  if (value === 'canceled' || value === 'cancelled' || value === 'stopped') return 'canceled';
  return 'unknown';
}

function jobFromEvent(event: AgentEventView, existing?: JobCardData): JobCardData | undefined {
  const data = dataRecord(event);
  const source = recordValue(data.job) ?? data;
  const id = stringValue(source.jobId ?? source.id ?? source.runId) ?? existing?.id;
  if (!id) return undefined;
  const resultValues = Array.isArray(source.results) ? source.results : Array.isArray(source.assets) ? source.assets : source.result ? [source.result] : [];
  const resultAssets = resultValues.map(toAssetCard).filter((item): item is AssetCardData => Boolean(item));
  return {
    id,
    label: stringValue(source.label ?? source.name ?? source.nodeName) ?? existing?.label ?? '生成任务',
    state: jobState(source.state ?? source.status),
    index: numberValue(source.index ?? source.position) ?? existing?.index,
    total: numberValue(source.total ?? source.count) ?? existing?.total,
    resultAssets: resultAssets.length > 0 ? resultAssets : existing?.resultAssets ?? [],
    nodeId: stringValue(source.nodeId) ?? existing?.nodeId,
    error: stringValue(source.error ?? source.message) ?? existing?.error,
    updatedAt: numberValue(source.updatedAt ?? event.createdAt),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  const index = items.findIndex((item) => item.id === value.id);
  if (index < 0) return [...items, value];
  const next = items.slice();
  next[index] = value;
  return next;
}

function upsertAsset(items: AssetCardData[], value: AssetCardData): AssetCardData[] {
  const key = assetKey(value.ref);
  const index = items.findIndex((item) => assetKey(item.ref) === key);
  if (index < 0) return [...items, value];
  const next = items.slice();
  next[index] = { ...next[index], ...value };
  return next;
}

function addOrMergeMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const exactId = messages.findIndex((item) => item.id === message.id);
  let index = exactId;
  if (index < 0 && message.role === 'user' && message.requestId) {
    // A requestId is the durable client/server idempotency key. Prefer it over
    // runId because multiple supplemental messages may share one active run.
    index = messages.findIndex((item) => item.role === 'user' && item.pending === true && item.requestId === message.requestId && (!message.text || item.text === message.text));
  }
  if (index < 0) {
    index = messages.findIndex((item) => (
      item.role === 'user' && message.role === 'user' && item.pending === true &&
      message.runId !== undefined && item.runId === message.runId &&
      (!message.text || item.text === message.text)
    ) || (
      item.role === 'assistant' && message.role === 'assistant' && item.streaming === true && message.runId !== undefined && item.runId === message.runId
    ));
  }
  if (index < 0) return [...messages, message];
  const next = messages.slice();
  next[index] = {
    ...next[index],
    ...message,
    pending: message.pending === true ? next[index].pending : false,
    text: message.text || next[index].text,
    attachments: message.attachments.length > 0 ? message.attachments : next[index].attachments,
  };
  return next;
}

function assistantMessageId(data: Record<string, unknown>, fallbackRunId?: string): string {
  return stringValue(data.messageId ?? data.itemId ?? data.assistantMessageId) ?? `assistant:${fallbackRunId ?? 'current'}`;
}

function runForEvent(state: AgentStoreState, event: AgentEventView): AgentStoreState {
  const data = dataRecord(event);
  const source = recordValue(data.run) ?? data;
  const run = runFromUnknown({ ...source, id: source.runId ?? source.id, state: source.state ?? source.status ?? event.type.replace(/^run\./, '') }, state.session?.id ?? '');
  if (!run) return state;
  const runs = { ...state.runs, [run.id]: run };
  const isFinal = ['completed', 'partial', 'stopped', 'failed'].includes(run.state);
  return {
    ...state,
    runs,
    activeRunId: isFinal ? (state.activeRunId === run.id ? undefined : state.activeRunId) : run.id,
    pendingInput: run.wait ?? (isFinal ? undefined : state.pendingInput),
    messages: isFinal ? state.messages.map(message => message.runId === run.id ? { ...message, streaming: false } : message) : state.messages,
    error: run.state === 'stopped' ? undefined : run.error ?? (run.state === 'failed' ? state.error : undefined),
  };
}

export function applyAgentEvent(state: AgentStoreState, event: AgentEventView): AgentStoreState {
  if (isHiddenThoughtEvent(event.type)) return state;
  if (event.sequence > 0 && event.sequence <= state.lastSequence) return state;
  let next: AgentStoreState = {
    ...state,
    events: [...state.events, event].slice(-800),
    lastSequence: Math.max(state.lastSequence, event.sequence),
  };
  const data = dataRecord(event);
  switch (event.type) {
    case 'message.accepted': {
      const candidate = messageFromUnknown(data.message ?? data, stringValue(data.messageId) ?? `user:${event.sequence}`);
      if (candidate) {
        const runId = stringValue(data.runId);
        const requestId = stringValue(data.requestId);
        next.messages = addOrMergeMessage(next.messages, { ...candidate, ...(runId ? { runId } : {}), ...(requestId ? { requestId } : {}), pending: false });
      }
      break;
    }
    case 'assistant.delta':
    case 'message.delta': {
      const id = assistantMessageId(data, stringValue(data.runId));
      const delta = textFromContent(data.delta ?? data.text ?? data.content);
      if (delta) {
        const current = next.messages.find((item) => item.id === id);
        if (current) {
          next.messages = next.messages.map((item) => item.id === id ? { ...item, text: item.text + delta, streaming: true, runId: stringValue(data.runId) ?? item.runId } : item);
        } else {
          next.messages = [...next.messages, { id, role: 'assistant', text: delta, attachments: [], createdAt: event.createdAt, streaming: true, runId: stringValue(data.runId) }];
        }
        if (!next.nearBottom) next.unreadCount += 1;
      }
      break;
    }
    case 'assistant.message': {
      const candidate = messageFromUnknown(data.message ?? data, assistantMessageId(data, stringValue(data.runId)));
      if (candidate) next.messages = addOrMergeMessage(next.messages, { ...candidate, streaming: false, runId: stringValue(data.runId) });
      break;
    }
    case 'message.completed':
      next.messages = next.messages.map((item) => item.id === stringValue(data.messageId) ? { ...item, streaming: false } : item);
      break;
    case 'run.updated':
    case 'run.completed':
    case 'run.partial':
    case 'run.stopped':
    case 'run.failed':
      next = runForEvent(next, event);
      if (event.type === 'run.failed') next.error = stringValue(data.error ?? data.message) ?? '任务失败';
      break;
    case 'tool.call.received':
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed': {
      const step = stepFromEvent(event, next.tools.find((item) => item.id === stringValue(data.toolCallId ?? data.callId ?? data.id)));
      if (step) next.tools = upsertById(next.tools, step).slice(-120);
      break;
    }
    case 'job.updated': {
      const job = jobFromEvent(event, next.jobs.find((item) => item.id === stringValue(data.jobId ?? data.id)));
      if (job) next.jobs = upsertById(next.jobs, job).slice(-120);
      break;
    }
    case 'asset.registered': {
      const asset = toAssetCard(data.asset ?? data);
      if (asset) next.registeredAssets = upsertAsset(next.registeredAssets, asset).slice(-160);
      break;
    }
    case 'input.required': {
      const input = waitFromUnknown(data.wait ?? data.input ?? data);
      if (input) next.pendingInput = input;
      // input.required is emitted before the next run.updated in the runtime;
      // expose the waiting state immediately so the reply card is actionable.
      const runId = stringValue(data.runId);
      next = runForEvent(next, { ...event, data: { ...event.data, runId, state: 'waiting_user', wait: input } });
      break;
    }
    case 'context.compacting':
      next.compacting = true;
      break;
    case 'context.compacted':
      next.compacting = false;
      break;
    case 'canvas.changed':
      // Canvas state belongs to the host. The UI records the event for a small status row only.
      break;
    default:
      break;
  }
  return next;
}

export function reduceAgentStore(state: AgentStoreState, action: AgentStoreAction): AgentStoreState {
  switch (action.type) {
    case 'session.loaded':
      return {
        ...state,
        session: action.session,
        ...(action.messages ? { messages: action.messages } : {}),
        events: action.events ?? [],
        tools: [],
        jobs: [],
        runs: {},
        activeRunId: undefined,
        pendingInput: undefined,
        registeredAssets: [],
        connection: 'idle',
        unreadCount: 0,
        compacting: false,
        lastSentText: undefined,
        lastSentSelection: undefined,
        lastSequence: action.sequence ?? state.lastSequence,
        error: undefined,
      };
    case 'session.reset':
      return { ...INITIAL_STATE };
    case 'message.added':
      return { ...state, messages: addOrMergeMessage(state.messages, action.message), error: undefined };
    case 'message.linked':
      return {
        ...state,
        messages: state.messages.map((message) => message.id === action.id
          ? { ...message, runId: action.runId, ...(action.requestId ? { requestId: action.requestId } : {}), pending: message.pending === false ? false : true }
          : message),
      };
    case 'message.delta': {
      const existing = state.messages.find((message) => message.id === action.id);
      if (!existing) {
        return { ...state, messages: [...state.messages, { id: action.id, role: 'assistant', text: action.text, attachments: [], createdAt: action.createdAt ?? Date.now(), streaming: true }] };
      }
      return { ...state, messages: state.messages.map((message) => message.id === action.id ? { ...message, text: message.text + action.text, streaming: true } : message) };
    }
    case 'message.finalized':
      return { ...state, messages: action.id ? state.messages.map((message) => message.id === action.id ? { ...message, streaming: false } : message) : state.messages.map((message) => ({ ...message, streaming: false })) };
    case 'event.received':
      return applyAgentEvent(state, action.event);
    case 'connection.changed':
      return { ...state, connection: action.state, error: action.error ?? (action.state === 'error' ? state.error : undefined) };
    case 'draft.changed':
      return { ...state, draft: action.draft };
    case 'attachment.added':
      return state.attachments.some((item) => assetKey(item.ref) === assetKey(action.attachment.ref))
        ? state
        : { ...state, attachments: [...state.attachments, action.attachment] };
    case 'attachment.removed':
      return { ...state, attachments: state.attachments.filter((item) => assetKey(item.ref) !== action.key) };
    case 'attachments.replaced':
      return { ...state, attachments: action.attachments };
    case 'run.upserted':
      return runForEvent(state, { id: `run:${action.run.id}`, sequence: 0, type: 'run.updated', createdAt: action.run.updatedAt ?? Date.now(), data: { run: action.run } });
    case 'input.required':
      return { ...state, pendingInput: action.input };
    case 'input.cleared':
      return !action.id || state.pendingInput?.id === action.id ? { ...state, pendingInput: undefined } : state;
    case 'tool.upserted':
      return { ...state, tools: upsertById(state.tools, action.tool) };
    case 'job.upserted':
      return { ...state, jobs: upsertById(state.jobs, action.job) };
    case 'asset.registered':
      return { ...state, registeredAssets: upsertAsset(state.registeredAssets, action.asset) };
    case 'compact.changed':
      return { ...state, compacting: action.compacting };
    case 'unread.cleared':
      return { ...state, unreadCount: 0 };
    case 'near-bottom.changed':
      return { ...state, nearBottom: action.value, unreadCount: action.value ? 0 : state.unreadCount };
    case 'error.changed':
      return { ...state, error: action.error };
    default:
      return state;
  }
}

function eventFromEnvelope(envelope: SseEnvelope, fallbackSequence: number): AgentEventView | undefined {
  const payload = eventPayload(envelope);
  const source = recordValue(payload) ?? {};
  const type = stringValue(envelope.event) ?? stringValue(source.type ?? source.event);
  if (!type) return undefined;
  const payloadData = recordValue(source.data) ?? source;
  const data: Record<string, unknown> = { ...payloadData };
  for (const key of ['sessionId', 'runId', 'turnId', 'itemId', 'jobId']) {
    if (source[key] !== undefined && data[key] === undefined) data[key] = source[key];
  }
  const event = asAgentEvent({
    ...source,
    type,
    data,
    sequence: eventSequence(envelope) ?? source.sequence ?? fallbackSequence,
    eventId: envelope.id,
  }, fallbackSequence);
  return event;
}

export function sessionFromUnknown(value: unknown, fallbackCanvasId: string): AgentSessionView | undefined {
  const source = recordValue(value);
  if (!source) return undefined;
  const nested = recordValue(source.session);
  const session = nested ?? source;
  const id = stringValue(session.id ?? session.sessionId);
  if (!id) return undefined;
  return {
    id,
    canvasId: stringValue(session.canvasId ?? recordValue(session.scope)?.canvasId) ?? fallbackCanvasId,
    createdAt: numberValue(session.createdAt),
    providerId: stringValue(session.providerId),
    model: stringValue(session.model),
    state: (stringValue(session.state) as AgentSessionView['state']) ?? 'idle',
  };
}

export function sessionsFromUnknown(value: unknown, fallbackCanvasId: string): AgentSessionView[] {
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(recordValue(value)?.sessions)
      ? recordValue(value)?.sessions as unknown[]
      : [];
  const seen = new Set<string>();
  return raw
    .map((item) => sessionFromUnknown(item, fallbackCanvasId))
    .filter((item): item is AgentSessionView => item !== undefined)
    .filter((item) => item.canvasId === fallbackCanvasId)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

function toolResultRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const text = textFromContent(value.content);
  if (!text) return undefined;
  try {
    return recordValue(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function historicalToolSteps(rawMessages: unknown[]): ToolStep[] {
  const steps = new Map<string, ToolStep>();
  for (const item of rawMessages) {
    const source = recordValue(item);
    if (!source) continue;
    if (source.role === 'assistant' && Array.isArray(source.toolCalls)) {
      for (const rawCall of source.toolCalls) {
        const call = recordValue(rawCall);
        const id = stringValue(call?.id);
        if (!id) continue;
        const name = stringValue(call?.name) ?? 'tool';
        const args = recordValue(call?.arguments);
        steps.set(id, {
          id,
          name,
          label: friendlyToolName(name),
          target: stringValue(args?.nodeId ?? args?.assetId),
          state: 'running',
          startedAt: numberValue(source.createdAt),
        });
      }
    }
    if (source.role !== 'tool') continue;
    const callId = stringValue(source.callId);
    if (!callId) continue;
    const result = toolResultRecord(source);
    const error = recordValue(result?.error);
    const contentAsset = Array.isArray(source.content)
      ? source.content.map(toAssetCard).find((asset): asset is AssetCardData => Boolean(asset))
      : undefined;
    const existing = steps.get(callId);
    steps.set(callId, {
      id: callId,
      name: existing?.name ?? 'tool',
      label: existing?.label ?? '工具调用',
      target: existing?.target,
      state: error ? 'failed' : 'completed',
      startedAt: existing?.startedAt,
      completedAt: numberValue(source.createdAt),
      durationMs: existing?.startedAt && numberValue(source.createdAt) ? Math.max(0, numberValue(source.createdAt)! - existing.startedAt) : undefined,
      error: stringValue(error?.message) ?? stringValue(result?.error),
      asset: toAssetCard(result?.asset ?? result?.ref) ?? contentAsset,
    });
  }
  return [...steps.values()];
}

function historicalJobs(rawMessages: unknown[]): JobCardData[] {
  const jobs = new Map<string, JobCardData>();
  for (const item of rawMessages) {
    const source = recordValue(item);
    if (!source || source.role !== 'tool') continue;
    const result = toolResultRecord(source);
    const candidate = recordValue(result?.job) ?? result;
    const id = stringValue(candidate?.id);
    const nodeId = stringValue(candidate?.nodeId);
    const status = stringValue(candidate?.state ?? candidate?.status);
    if (!id || !nodeId || !status || jobState(status) === 'unknown') continue;
    const results = Array.isArray(candidate?.results) ? candidate.results : Array.isArray(candidate?.assets) ? candidate.assets : [];
    const resultAssets = results.map(toAssetCard).filter((asset): asset is AssetCardData => Boolean(asset));
    jobs.set(id, {
      id,
      label: stringValue(candidate?.label ?? candidate?.name) ?? '生成任务',
      state: jobState(status),
      resultAssets,
      nodeId,
      error: stringValue(candidate?.error),
      updatedAt: numberValue(candidate?.updatedAt ?? source.createdAt),
    });
  }
  return [...jobs.values()];
}

function snapshotFromUnknown(value: unknown, fallbackCanvasId: string): { session?: AgentSessionView; messages: ChatMessage[]; events: AgentEventView[]; runs: RunView[]; tools: ToolStep[]; jobs: JobCardData[]; sequence: number } {
  const source = recordValue(value) ?? {};
  const session = sessionFromUnknown(value, fallbackCanvasId);
  const rawMessages = Array.isArray(source.messages) ? source.messages : Array.isArray(recordValue(source.session)?.messages) ? recordValue(source.session)?.messages as unknown[] : [];
  const messages = rawMessages.map((item, index) => messageFromUnknown(item, `history:${index}`)).filter((item): item is ChatMessage => Boolean(item));
  const rawEvents = Array.isArray(source.events) ? source.events : Array.isArray(recordValue(source.session)?.events) ? recordValue(source.session)?.events as unknown[] : [];
  const events = rawEvents.map((item, index) => {
    if (typeof item === 'string') return eventFromEnvelope({ data: item }, index + 1);
    const event = asAgentEvent(item, index + 1);
    return event;
  }).filter((item): item is AgentEventView => Boolean(item)).sort((a, b) => a.sequence - b.sequence);
  const sequence = numberValue(source.lastSequence ?? source.sequence ?? source.eventSequence) ?? events.at(-1)?.sequence ?? 0;
  const rawRuns = Array.isArray(source.runs) ? source.runs : [];
  const latest = source.latestRun ? [source.latestRun] : [];
  const runs = [...rawRuns, ...latest].map((item) => runFromUnknown(item, session?.id ?? '')).filter((item): item is RunView => Boolean(item));
  return { session, messages, events, runs, tools: historicalToolSteps(rawMessages), jobs: historicalJobs(rawMessages), sequence };
}

export function createAgentStore(options: AgentStoreOptions): AgentStore {
  let state: AgentStoreState = { ...INITIAL_STATE };
  const listeners = new Set<() => void>();
  let streamController: AbortController | undefined;
  let destroyed = false;
  let destroyTimer: ReturnType<typeof setTimeout> | undefined;
  let sending = false;
  let retryRequest: { text: string; selection: Selection; requestId: string; skillNames?: string[] } | undefined;
  let loadGeneration = 0;

  const notify = () => listeners.forEach((listener) => listener());
  const dispatch = (action: AgentStoreAction) => {
    if (destroyed) return;
    const next = reduceAgentStore(state, action);
    if (next !== state) {
      state = next;
      notify();
    }
  };

  const stopEvents = () => {
    streamController?.abort();
    streamController = undefined;
  };

  const startEvents = (sessionId = state.session?.id) => {
    if (!sessionId || destroyed) return;
    stopEvents();
    const controller = new AbortController();
    streamController = controller;
    dispatch({ type: 'connection.changed', state: 'connecting' });
    const stream = options.client.recoverEvents
      ? options.client.recoverEvents(sessionId, {
        after: state.lastSequence,
        signal: controller.signal,
        maxReconnects: options.maxReconnects,
        onRecovery: (sequence) => dispatch({ type: 'connection.changed', state: 'recovering', error: `正在恢复事件 ${sequence}` }),
      })
      : undefined;
    void (async () => {
      try {
        const events = stream ?? await options.client.streamEvents(sessionId, state.lastSequence, controller.signal);
        dispatch({ type: 'connection.changed', state: 'connected' });
        for await (const envelope of events) {
          if (controller.signal.aborted) return;
          const event = eventFromEnvelope(envelope, state.lastSequence + 1);
          if (event) {
            if (event.type === 'canvas.changed') {
              const changed = dataRecord(event);
              const revision = numberValue(changed.revision);
              if (revision !== undefined) options.hostBridge.onCanvasChanged?.(revision);
            }
            dispatch({ type: 'event.received', event });
          }
        }
        if (!controller.signal.aborted) dispatch({ type: 'connection.changed', state: 'offline' });
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : '事件连接中断';
          dispatch({ type: 'connection.changed', state: 'error', error: message });
        }
      }
    })();
  };

  const loadSession = async (sessionId: string) => {
    const generation = ++loadGeneration;
    stopEvents();
    retryRequest = undefined;
    try {
      const payload = await options.client.getSession(sessionId);
      if (destroyed || generation !== loadGeneration) return;
      const snapshot = snapshotFromUnknown(payload, options.canvasId);
      if (!snapshot.session) {
        dispatch({ type: 'error.changed', error: '会话响应缺少会话 ID' });
        return;
      }
      if (snapshot.session.canvasId !== options.canvasId) {
        dispatch({ type: 'error.changed', error: '会话不属于当前画布' });
        return;
      }
      // Replay the snapshot events to rebuild derived tool/run/job state. The event list
      // itself is also rebuilt by the reducer, so each event appears exactly once.
      dispatch({ type: 'session.loaded', session: snapshot.session, messages: snapshot.messages, sequence: 0 });
      for (const run of snapshot.runs) dispatch({ type: 'run.upserted', run });
      for (const tool of snapshot.tools) dispatch({ type: 'tool.upserted', tool });
      for (const job of snapshot.jobs) dispatch({ type: 'job.upserted', job });
      for (const event of snapshot.events) {
        dispatch({ type: 'event.received', event });
      }
      if (state.lastSequence < snapshot.sequence) {
        state = { ...state, lastSequence: snapshot.sequence };
        notify();
      }
      startEvents(sessionId);
    } catch (error) {
      dispatch({ type: 'connection.changed', state: 'error', error: error instanceof Error ? error.message : '无法读取会话' });
    }
  };

  const resetSession = () => {
    loadGeneration += 1;
    stopEvents();
    retryRequest = undefined;
    dispatch({ type: 'session.reset' });
  };

  let sessionPromise: Promise<void> | undefined;
  const ensureSession = async () => {
    if (state.session) return;
    if (!sessionPromise) sessionPromise = (async () => {
      const created = await options.client.createSession({ canvasId: options.canvasId, providerId: options.providerId, model: options.model });
      const session = sessionFromUnknown(created, options.canvasId);
      if (!session || session.canvasId !== options.canvasId) throw new Error('无法读取当前画布会话');
      await loadSession(session.id);
      if (!state.session || state.session.id !== session.id) throw new Error('无法恢复当前画布会话');
    })().finally(() => { sessionPromise = undefined; });
    await sessionPromise;
  };

  const resume = () => {
    if (destroyTimer !== undefined) {
      clearTimeout(destroyTimer);
      destroyTimer = undefined;
    }
    destroyed = false;
  };

  const sendMessageInternal = async (text: string, skillNames = options.skillNames, selectionOverride?: Selection, requestIdOverride?: string) => {
    const trimmed = text.trim();
    if (!trimmed || destroyed || sending) return;
    sending = true;
    let sessionId = state.session?.id;
    let frozenSelection: Selection | undefined;
    let optimisticMessageId: string | undefined;
    const isRetry = Boolean(selectionOverride && requestIdOverride);
    const requestId = requestIdOverride ?? createUiId('request');
    try {
      if (selectionOverride) {
        frozenSelection = { ...selectionOverride, nodeIds: [...selectionOverride.nodeIds], assets: selectionOverride.assets.map((asset) => ({ ...asset })) };
      } else {
        const beforeSend = (options.hostBridge as typeof options.hostBridge & { beforeSend?: () => void | Promise<void> }).beforeSend;
        if (beforeSend) await beforeSend();
        if (destroyed || destroyTimer !== undefined) return;
        // Freeze the host selection only after the host confirms its latest canvas revision.
        const selected = selectionWithAttachments(options.hostBridge.getSelection(), state.attachments);
        frozenSelection = { ...selected, nodeIds: [...selected.nodeIds], assets: selected.assets.map((asset) => ({ ...asset })) };
      }
      const selection = frozenSelection;
      if (!selection) throw new Error('无法读取当前画布选择');
      if (!sessionId) {
        await ensureSession();
        if (destroyed || destroyTimer !== undefined) return;
        sessionId = state.session!.id;
      }
      if (!isRetry) {
        const attachments = state.attachments.map((attachment) => ({ ...attachment, ref: { ...attachment.ref } }));
        const message: ChatMessage = {
          id: createUiId('user'), role: 'user', text: trimmed, attachments, createdAt: Date.now(),
          ...(state.activeRunId ? { runId: state.activeRunId } : {}), requestId, pending: true,
        };
        optimisticMessageId = message.id;
        dispatch({ type: 'message.added', message });
        dispatch({ type: 'draft.changed', draft: '' });
        dispatch({ type: 'attachments.replaced', attachments: [] });
      } else {
        const prior = [...state.messages].reverse().find((message) => message.role === 'user' && message.text === trimmed);
        if (prior?.failed) {
          optimisticMessageId = prior.id;
          dispatch({ type: 'message.added', message: { ...prior, failed: false, pending: true, requestId } });
        }
      }
      dispatch({ type: 'error.changed', error: undefined });
      state = { ...state, lastSentText: trimmed, lastSentSelection: selection };
      const frozenSkillNames = skillNames?.length ? [...skillNames] : skillNames;
      const response = await options.client.sendMessage(sessionId, { text: trimmed, selection, ...(frozenSkillNames?.length ? { skillNames: frozenSkillNames } : {}) }, requestId);
      const source = recordValue(response) ?? {};
      const run = runFromUnknown(source.run ?? source, sessionId);
      if (run) {
        dispatch({ type: 'run.upserted', run });
        const pending = [...state.messages].reverse().find((message) => message.role === 'user' && message.pending === true && message.requestId === requestId);
        if (pending) dispatch({ type: 'message.linked', id: pending.id, runId: run.id, requestId });
      }
      retryRequest = undefined;
      startEvents(sessionId);
    } catch (error) {
      if (frozenSelection) retryRequest = { text: trimmed, selection: frozenSelection, requestId, skillNames: skillNames ? [...skillNames] : undefined };
      dispatch({ type: 'error.changed', error: error instanceof Error ? error.message : '发送失败，请重试' });
      const last = optimisticMessageId ? state.messages.find((message) => message.id === optimisticMessageId) : undefined;
      if (last) dispatch({ type: 'message.added', message: { ...last, failed: true, pending: false } });
    } finally {
      sending = false;
    }
  };

  const stopActiveRun = async () => {
    const runId = state.activeRunId;
    if (!runId) return;
    try {
      await options.client.stopRun(runId);
      const run = state.runs[runId];
      if (run) dispatch({ type: 'run.upserted', run: { ...run, state: 'stopped', updatedAt: Date.now() } });
    } catch (error) {
      dispatch({ type: 'error.changed', error: error instanceof Error ? error.message : '停止失败' });
    }
  };

  const reply = async (input: { text: string; waitId: string }) => {
    const runId = state.activeRunId;
    if (!runId || !input.text.trim()) return;
    try {
      dispatch({ type: 'input.cleared', id: input.waitId });
      await options.client.replyRun(runId, { text: input.text, waitId: input.waitId });
      startEvents(state.session?.id);
    } catch (error) {
      dispatch({ type: 'error.changed', error: error instanceof Error ? error.message : '回复失败' });
    }
  };

  const compact = async () => {
    if (!state.session?.id || state.compacting) return;
    dispatch({ type: 'compact.changed', compacting: true });
    try {
      await options.client.compact(state.session.id);
      startEvents(state.session.id);
    } catch (error) {
      dispatch({ type: 'compact.changed', compacting: false });
      dispatch({ type: 'error.changed', error: error instanceof Error ? error.message : '整理上下文失败' });
    }
  };

  const retryLastMessage = async () => {
    if (retryRequest) await sendMessageInternal(retryRequest.text, retryRequest.skillNames, retryRequest.selection, retryRequest.requestId);
    else if (state.lastSentText) await sendMessageInternal(state.lastSentText);
  };

  if (options.sessionId) void loadSession(options.sessionId);

  return {
    getState: () => state,
    subscribe(listener) {
      if (destroyTimer !== undefined) {
        clearTimeout(destroyTimer);
        destroyTimer = undefined;
        destroyed = false;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    loadSession,
    ensureSession,
    resetSession,
    startEvents,
    stopEvents,
    sendMessage: (text, skillNames) => sendMessageInternal(text, skillNames),
    stopActiveRun,
    reply,
    compact,
    retryLastMessage,
    setDraft: (value) => dispatch({ type: 'draft.changed', draft: value }),
    addAttachment: (attachment) => dispatch({ type: 'attachment.added', attachment }),
    removeAttachment: (ref) => dispatch({ type: 'attachment.removed', key: assetKey(ref) }),
    clearUnread: () => dispatch({ type: 'unread.cleared' }),
    setNearBottom: (value) => dispatch({ type: 'near-bottom.changed', value }),
    resume,
    destroy: () => {
      stopEvents();
      if (destroyTimer !== undefined) clearTimeout(destroyTimer);
      // React StrictMode performs an effect cleanup followed immediately by a
      // second subscription. Deferring final disposal lets that probe reuse the
      // same external store without losing the in-flight session recovery.
      destroyTimer = setTimeout(() => {
        destroyTimer = undefined;
        loadGeneration += 1;
        destroyed = true;
        listeners.clear();
      }, 0);
    },
  };
}

export function eventEnvelopeFromUnknown(value: unknown, sequenceHint = 1): AgentEventView | undefined {
  if (typeof value === 'string') return eventFromEnvelope({ data: value }, sequenceHint);
  return asAgentEvent(value, sequenceHint);
}
