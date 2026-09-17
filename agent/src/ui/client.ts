import { createSessionEventStream, parseSsePayload } from './sse';
import type { AgentClientLike, ApiError, Selection, SseEnvelope, ProviderSettingsInput, ProviderSettingsView } from './types';

export interface AgentClientOptions {
  /** Defaults to the local Agent service behind the Vite /api proxy. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Called for each request. Tokens are intentionally never persisted by this client. */
  getAuthToken?: () => string | undefined | Promise<string | undefined>;
  headers?: HeadersInit;
  maxReconnects?: number;
  reconnectDelayMs?: number;
}

export interface CreateSessionInput {
  canvasId: string;
  providerId?: string;
  model?: string;
}

export interface SendMessageInput {
  text: string;
  selection: Selection;
  skillNames?: string[];
}

export interface SessionEventsOptions {
  after?: number;
  signal?: AbortSignal;
  maxReconnects?: number;
  reconnectDelayMs?: number;
  onRecovery?: (nextSequence: number) => void;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function makeApiError(response: Response, details: unknown): ApiError {
  const message = typeof details === 'object' && details && 'message' in details && typeof details.message === 'string'
    ? details.message
    : `Agent 服务请求失败（${response.status}）`;
  const error = new Error(message) as ApiError;
  error.status = response.status;
  error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
  error.details = details;
  return error;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('已取消', 'AbortError'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class AgentClient implements AgentClientLike {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAuthToken?: AgentClientOptions['getAuthToken'];
  private readonly extraHeaders?: HeadersInit;
  private readonly defaultMaxReconnects: number;
  private readonly defaultReconnectDelayMs: number;

  constructor(options: AgentClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api';
    // Native fetch is an IDL method in some browsers and throws when detached
    // from `window`. Keep custom test/host implementations untouched.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.getAuthToken = options.getAuthToken;
    this.extraHeaders = options.headers;
    this.defaultMaxReconnects = options.maxReconnects ?? 4;
    this.defaultReconnectDelayMs = options.reconnectDelayMs ?? 500;
  }

  private async headers(accept?: string): Promise<Headers> {
    const result = new Headers(this.extraHeaders);
    result.set('Accept', accept ?? 'application/json');
    const token = await this.getAuthToken?.();
    if (token) result.set('Authorization', `Bearer ${token}`);
    return result;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers = await this.headers();
    const incoming = new Headers(init.headers);
    incoming.forEach((value, key) => headers.set(key, value));
    const response = await this.fetchImpl(joinUrl(this.baseUrl, path), { ...init, headers });
    const body = await readResponseBody(response);
    if (!response.ok) throw makeApiError(response, body);
    return body;
  }

  health(): Promise<unknown> {
    return this.request('/health');
  }

  providerSettings() { return this.request('/settings/provider') as Promise<ProviderSettingsView>; }
  saveProviderSettings(input: ProviderSettingsInput) { return this.request('/settings/provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) as Promise<ProviderSettingsView>; }

  capabilities(): Promise<unknown> {
    return this.request('/capabilities');
  }

  getCanvas(canvasId: string): Promise<unknown> {
    return this.request(`/canvas?canvasId=${encodeURIComponent(canvasId)}`);
  }

  createSession(input: CreateSessionInput): Promise<unknown> {
    return this.request('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  listSessions(canvasId?: string): Promise<unknown> {
    const suffix = canvasId ? `?canvasId=${encodeURIComponent(canvasId)}` : '';
    return this.request(`/sessions${suffix}`);
  }

  getSession(sessionId: string): Promise<unknown> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  sendMessage(sessionId: string, input: SendMessageInput, requestId?: string): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (requestId) headers['Idempotency-Key'] = requestId;
    const body = requestId ? { ...input, requestId } : input;
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  async streamEvents(sessionId: string, after: number, signal?: AbortSignal): Promise<AsyncIterable<SseEnvelope>> {
    const response = await this.fetchImpl(joinUrl(this.baseUrl, `/sessions/${encodeURIComponent(sessionId)}/events?after=${Math.max(0, Math.floor(after))}`), {
      headers: await this.headers('text/event-stream'),
      signal,
    });
    if (!response.ok) {
      const body = await readResponseBody(response);
      throw makeApiError(response, body);
    }
    if (!response.body) throw new Error('Agent 事件流没有响应体');
    return createSessionEventStream(response.body, signal);
  }

  stopRun(runId: string): Promise<unknown> {
    return this.request(`/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
  }

  replyRun(runId: string, input: { text: string; waitId: string }): Promise<unknown> {
    return this.request(`/runs/${encodeURIComponent(runId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  compact(sessionId: string): Promise<unknown> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/compact`, { method: 'POST' });
  }

  /**
   * Reconnects an event stream and asks the session snapshot to fill a sequence gap.
   * Consumers receive only strictly increasing, already parsed events.
   */
  recoverEvents(sessionId: string, options: SessionEventsOptions = {}): AsyncIterable<SseEnvelope> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const client = this;
    const maxReconnects = options.maxReconnects ?? this.defaultMaxReconnects;
    const delayMs = options.reconnectDelayMs ?? this.defaultReconnectDelayMs;
    return (async function* recover(): AsyncGenerator<SseEnvelope> {
      let last = Math.max(0, Math.floor(options.after ?? 0));
      let reconnects = 0;
      while (true) {
        try {
          const stream = await client.streamEvents(sessionId, last, options.signal);
          for await (const envelope of stream) {
            const sequence = sequenceFromEnvelope(envelope);
            if (sequence !== undefined && sequence <= last) continue;
            if (sequence !== undefined && sequence > last + 1) {
              const snapshot = await client.getSession(sessionId);
              const history = historyFromSnapshot(snapshot)
                .filter((item) => {
                  const itemSequence = sequenceFromEnvelope(item);
                  return itemSequence !== undefined && itemSequence > last;
                })
                .sort((a, b) => (sequenceFromEnvelope(a) ?? 0) - (sequenceFromEnvelope(b) ?? 0));
              for (const item of history) {
                const itemSequence = sequenceFromEnvelope(item);
                if (itemSequence === undefined || itemSequence <= last) continue;
                if (itemSequence > last + 1) throw new Error(`事件序号缺口：${last + 1}–${itemSequence - 1}`);
                last = itemSequence;
                options.onRecovery?.(last);
                yield item;
              }
              // The current runtime state endpoint may expose only eventSequence.
              // Re-open the SSE cursor to replay the missing durable events when the
              // snapshot has no embedded event list.
              if (sequence > last + 1) {
                const replay = await client.streamEvents(sessionId, last, options.signal);
                for await (const item of replay) {
                  const itemSequence = sequenceFromEnvelope(item);
                  if (itemSequence === undefined || itemSequence <= last) continue;
                  if (itemSequence >= sequence) break;
                  if (itemSequence > last + 1) throw new Error(`事件序号缺口：${last + 1}–${itemSequence - 1}`);
                  last = itemSequence;
                  options.onRecovery?.(last);
                  yield item;
                }
              }
              if (sequence > last + 1) throw new Error(`事件序号缺口：${last + 1}–${sequence - 1}`);
            }
            if (sequence !== undefined) last = sequence;
            yield envelope;
          }
          // A server may close an SSE stream after a deploy. Reconnect with the cursor.
          if (reconnects >= maxReconnects) return;
          reconnects += 1;
          await wait(delayMs * Math.min(reconnects, 4), options.signal);
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (reconnects >= maxReconnects) throw error;
          reconnects += 1;
          await wait(delayMs * Math.min(reconnects, 4), options.signal);
        }
      }
    })();
  }
}

export function sequenceFromEnvelope(envelope: SseEnvelope): number | undefined {
  const payload = envelope.json ?? parseSsePayload(envelope.data);
  if (payload && typeof payload === 'object') {
    const source = payload as Record<string, unknown>;
    const value = source.sequence ?? source.seq;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  if (envelope.id && /^\d+$/.test(envelope.id)) return Number(envelope.id);
  return undefined;
}

export function historyFromSnapshot(snapshot: unknown): SseEnvelope[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const source = snapshot as Record<string, unknown>;
  const raw = Array.isArray(source.events)
    ? source.events
    : source.session && typeof source.session === 'object' && Array.isArray((source.session as Record<string, unknown>).events)
      ? (source.session as Record<string, unknown>).events as unknown[]
      : [];
  return raw.flatMap((item): SseEnvelope[] => {
    if (!item || typeof item !== 'object') return [];
    const event = item as Record<string, unknown>;
    const data = typeof event.data === 'string' ? event.data : JSON.stringify(event);
    const json = typeof event.data === 'string' ? parseSsePayload(event.data) : event;
    return [{
      id: typeof event.id === 'string' ? event.id : typeof event.sequence === 'number' ? String(event.sequence) : undefined,
      event: typeof event.type === 'string' ? event.type : typeof event.event === 'string' ? event.event : undefined,
      data,
      json,
    }];
  });
}
