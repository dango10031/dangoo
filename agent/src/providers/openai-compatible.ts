import type {
  ContentPart,
  Message,
  ModelCapabilities,
  Provider,
  ProviderEvent,
  ProviderRequest,
  ToolSpec,
  Usage,
} from '../contracts/index.js';

/*
 * This module is an independent TypeScript adaptation of the behaviour used by
 * Codex's model-provider and SSE layers (the source locations are
 * codex-rs/model-provider/src/provider.rs and codex-api/src/sse).  It does not
 * copy the Rust implementation or depend on Codex authentication/state.
 */

export type ProviderErrorKind =
  | 'aborted'
  | 'auth'
  | 'capability'
  | 'content'
  | 'invalid_request'
  | 'network'
  | 'rate_limit'
  | 'schema'
  | 'server'
  | 'size'
  | 'unknown';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** Stable aliases for callers that use error.code/category terminology. */
  readonly code: ProviderErrorKind;
  readonly category: ProviderErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly beforeOutput: boolean;

  constructor(
    message: string,
    options: {
      kind?: ProviderErrorKind;
      status?: number;
      retryable?: boolean;
      beforeOutput?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = options.kind ?? 'unknown';
    this.code = this.kind;
    this.category = this.kind;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.beforeOutput = options.beforeOutput ?? true;
    // Do not retain raw provider/network errors: they can contain URLs or
    // request headers. Diagnostics stay bounded and credential-free.
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause instanceof Error ? options.cause.name : 'provider failure';
    }
  }
}

export type CredentialResolver =
  | string
  | (() => string | undefined | Promise<string | undefined>)
  | { resolve(): string | undefined | Promise<string | undefined> };

export interface OpenAICompatibleCapabilities {
  contextWindow?: number;
  maxOutputTokens?: number;
  tools?: boolean;
  vision?: boolean;
  parallelTools?: boolean;
}

export interface OpenAICompatibleProviderOptions {
  /** Stable business provider identity. */
  id?: string;
  /** Endpoint root, for example https://open.bigmodel.cn/api/paas/v4. */
  baseUrl: string;
  /** Defaults to the Chat Completions endpoint below baseUrl. */
  endpoint?: string;
  /** The configured default model (GLM-5.3-Flash can be supplied here). */
  model?: string;
  /** A secret reference or resolver. Values are kept private and are never in diagnostics. */
  credential?: CredentialResolver;
  /** Alias retained for local tests and simple adapters; never exposed in snapshots. */
  apiKey?: string;
  /** Explicit capability declaration. Unknown features default to false. */
  capabilities?: OpenAICompatibleCapabilities | Record<string, OpenAICompatibleCapabilities>;
  modelCapabilities?: Record<string, OpenAICompatibleCapabilities>;
  /** Provider-specific JSON fields, such as a deliberately disabled reasoning mode. */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxToolArgumentBytes?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export interface OpenAIChatRequest {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  stream: true;
  stream_options: { include_usage: true };
  max_tokens: number;
  temperature?: number;
  [key: string]: unknown;
}

type OpenAIChoice = {
  index?: number;
  delta?: {
    content?: unknown;
    role?: string;
    tool_calls?: unknown;
    function_call?: unknown;
  };
  finish_reason?: unknown;
};

function textDeltas(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  const texts: string[] = [];
  for (const part of value) {
    if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
      if (part.text) texts.push(part.text);
    } else if (isRecord(part) && (part.type === 'image_url' || part.type === 'image')) {
      throw new ProviderError('Provider returned an unsupported assistant image output', {
        kind: 'capability',
        retryable: false,
        beforeOutput: false,
      });
    }
  }
  return texts;
}

type ToolAccumulator = {
  choiceIndex: number;
  toolIndex: number;
  id: string;
  name: string;
  arguments: string;
  emitted: boolean;
};

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT = 8_192;
const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOOL_ARGUMENT_BYTES = 2 * 1024 * 1024;

function stableHash(value: string): string {
  // FNV-1a is sufficient for a revision label; it is not used as a security hash.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function bytesOf(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeJson(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? 'null' : result;
  } catch {
    return 'null';
  }
}

function strictJson(value: unknown, label: string): string {
  try {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error('undefined');
    return result;
  } catch {
    throw new ProviderError(`${label} is not valid JSON`, { kind: 'schema', retryable: false });
  }
}

function redact(value: string, secret?: string): string {
  let result = value;
  if (secret && secret.length > 0) result = result.split(secret).join('[REDACTED]');
  // Keep provider diagnostics useful while preventing common bearer/key forms
  // from crossing into user-visible errors or event payloads.
  result = result.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]');
  result = result.replace(/\b(?:sk|key|token)[-_][A-Za-z0-9._~-]{8,}\b/gi, '[REDACTED]');
  return result.length > 800 ? `${result.slice(0, 800)}…` : result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentHasImage(content: ContentPart[]): boolean {
  return content.some((part) => part.type === 'image' || part.type === 'asset');
}

function mapContent(content: ContentPart[], role: Message['role']): unknown {
  if (content.length === 0) return role === 'assistant' ? '' : '';
  const mapped = content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') {
      if (!part.url || typeof part.url !== 'string') {
        throw new ProviderError('Image content has no usable URL', {
          kind: 'invalid_request',
          retryable: false,
        });
      }
      return {
        type: 'image_url',
        image_url: { url: part.url, detail: 'auto' },
      };
    }
    // AssetRef is deliberately not converted to an arbitrary path or URL. The
    // Dangoo asset gateway must resolve it before a provider request.
    throw new ProviderError('Asset references must be resolved before provider input', {
      kind: 'invalid_request',
      retryable: false,
    });
  });
  // OpenAI accepts a string for plain text and an array for multimodal input.
  if (mapped.length === 1 && mapped[0] && (mapped[0] as { type?: string }).type === 'text') {
    return (mapped[0] as { text: string }).text;
  }
  return mapped;
}

function mapMessage(message: Message): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: mapContent(message.content, message.role),
  };
  if (message.role === 'assistant' && message.toolCalls?.length) {
    result.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: safeJson(call.arguments),
      },
    }));
  }
  if (message.role === 'tool') {
    if (!message.callId) {
      throw new ProviderError('Tool result is missing callId', {
        kind: 'invalid_request',
        retryable: false,
      });
    }
    result.tool_call_id = message.callId;
  }
  return result;
}

function mapToolTextMessage(message: Message): Record<string, unknown> {
  if (!message.callId) {
    throw new ProviderError('Tool result is missing callId', {
      kind: 'invalid_request',
      retryable: false,
    });
  }
  const text = message.content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  return { role: 'tool', content: text, tool_call_id: message.callId };
}

function toolImageLabel(message: Message, part: Extract<ContentPart, { type: 'image' }>): string {
  const asset = part.asset
    ? ` asset=${part.asset.assetId}@${part.asset.version}${part.asset.role ? ` role=${part.asset.role}` : ''}`
    : '';
  return `[tool_result callId=${message.callId ?? 'unknown'}${asset}]`;
}

/**
 * Chat Completions tool messages accept textual output. A tool-produced image
 * is carried in one following user multimodal message, after the complete
 * contiguous tool-result block, so the next assistant turn can inspect it.
 */
function mapMessages(messages: Message[]): unknown[] {
  const result: unknown[] = [];
  let pendingImages: Array<{ message: Message; part: Extract<ContentPart, { type: 'image' }> }> = [];
  const flushImages = () => {
    if (pendingImages.length === 0) return;
    const content: unknown[] = [];
    for (const { message, part } of pendingImages) {
      if (!part.url) {
        throw new ProviderError('Tool image has no usable URL', {
          kind: 'invalid_request',
          retryable: false,
        });
      }
      content.push({ type: 'text', text: toolImageLabel(message, part) });
      content.push({ type: 'image_url', image_url: { url: part.url, detail: 'auto' } });
    }
    result.push({ role: 'user', content });
    pendingImages = [];
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      result.push(mapToolTextMessage(message));
      for (const part of message.content) {
        if (part.type === 'image') pendingImages.push({ message, part });
        else if (part.type === 'asset') {
          throw new ProviderError('Asset references must be resolved before provider input', {
            kind: 'invalid_request',
            retryable: false,
          });
        }
      }
      continue;
    }
    flushImages();
    result.push(mapMessage(message));
  }
  flushImages();
  return result;
}

function mapTool(tool: ToolSpec): Record<string, unknown> {
  if (!tool.name || !tool.revision || !isRecord(tool.inputSchema)) {
    throw new ProviderError('Invalid tool schema', { kind: 'schema', retryable: false });
  }
  strictJson(tool.inputSchema, 'Tool schema');
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function normalizeCapabilities(
  value: OpenAICompatibleCapabilities | undefined,
): ModelCapabilities {
  return {
    contextWindow: Math.max(1, value?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
    maxOutputTokens: Math.max(1, value?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT),
    tools: value?.tools ?? false,
    vision: value?.vision ?? false,
    parallelTools: value?.parallelTools ?? false,
  };
}

function classifyStatus(status: number): {
  kind: ProviderErrorKind;
  retryable: boolean;
} {
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false };
  if (status === 408 || status === 409 || status === 425) {
    return { kind: 'network', retryable: true };
  }
  if (status === 429) return { kind: 'rate_limit', retryable: true };
  if (status >= 500 && status <= 599) return { kind: 'server', retryable: true };
  if (status >= 400 && status <= 499) {
    return { kind: 'invalid_request', retryable: false };
  }
  return { kind: 'unknown', retryable: false };
}

export function classifyProviderStatus(status: number): {
  kind: ProviderErrorKind;
  retryable: boolean;
} {
  return classifyStatus(status);
}

function reasonToDoneReason(reason: unknown): 'stop' | 'tool_calls' | 'length' {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_calls';
  if (reason === 'length' || reason === 'max_tokens') return 'length';
  return 'stop';
}

function usageFrom(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const input = value.prompt_tokens ?? value.input_tokens;
  const output = value.completion_tokens ?? value.output_tokens;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  const cached = value.prompt_tokens_details;
  let cachedTokens: number | undefined;
  if (isRecord(cached) && typeof cached.cached_tokens === 'number') {
    cachedTokens = cached.cached_tokens;
  } else if (typeof value.cached_tokens === 'number') {
    cachedTokens = value.cached_tokens;
  }
  return cachedTokens === undefined
    ? { inputTokens: input, outputTokens: output }
    : { inputTokens: input, outputTokens: output, cachedTokens };
}

function errorMessageFromBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error) && typeof error.message === 'string') return error.message;
      if (typeof parsed.message === 'string') return parsed.message;
    }
  } catch {
    // The body is diagnostic only; retain a bounded redacted excerpt below.
  }
  return body || 'Provider request failed';
}

function abortError(signal: AbortSignal): ProviderError {
  return new ProviderError('Provider request aborted', {
    kind: 'aborted',
    retryable: false,
    beforeOutput: true,
    cause: signal.reason,
  });
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const onTimer = () => signal.removeEventListener('abort', onAbort);
    // Removing the listener after a normal delay avoids retaining a turn's
    // signal while a retrying stream continues.
    setTimeout(onTimer, ms);
  });
}

async function* bodyChunks(body: unknown): AsyncGenerator<Uint8Array> {
  if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body as AsyncIterable<unknown>) {
      if (typeof chunk === 'string') yield new TextEncoder().encode(chunk);
      else if (chunk instanceof Uint8Array) yield chunk;
      else if (chunk instanceof ArrayBuffer) yield new Uint8Array(chunk);
      else throw new ProviderError('Provider returned an invalid stream chunk', { kind: 'schema' });
    }
    return;
  }
  const stream = body as ReadableStream<Uint8Array> | null;
  if (!stream || typeof stream.getReader !== 'function') {
    throw new ProviderError('Provider returned no response stream', { kind: 'network', retryable: true });
  }
  const reader = stream.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        throw new ProviderError('Provider returned an invalid stream chunk', { kind: 'schema' });
      }
      yield item.value;
    }
  } finally {
    reader.releaseLock();
  }
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly revision: string;
  /** Public default model for host session creation; callers may still override per turn. */
  readonly model: string;
  private readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly defaultModel: string;
  // ECMAScript private fields keep credentials and caller headers out of
  // JSON serialization, snapshots, and accidental diagnostics.
  readonly #credential?: CredentialResolver;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #extraBody: Readonly<Record<string, unknown>>;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly capabilitiesConfig:
    | OpenAICompatibleCapabilities
    | Readonly<Record<string, OpenAICompatibleCapabilities>>;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly maxToolArgumentBytes: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(options: OpenAICompatibleProviderOptions);
  constructor(id: string, options: Omit<OpenAICompatibleProviderOptions, 'id'>);
  constructor(
    optionsOrId: OpenAICompatibleProviderOptions | string,
    maybeOptions?: Omit<OpenAICompatibleProviderOptions, 'id'>,
  ) {
    const options: OpenAICompatibleProviderOptions =
      typeof optionsOrId === 'string' ? { ...maybeOptions!, id: optionsOrId } : optionsOrId;
    if (!options || typeof options.baseUrl !== 'string' || options.baseUrl.trim() === '') {
      throw new TypeError('OpenAI-compatible provider requires a baseUrl');
    }
    this.id = options.id?.trim() || 'openai-compatible';
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.endpoint = options.endpoint?.replace(/^\/+|\/+$/g, '') || 'chat/completions';
    this.defaultModel = options.model?.trim() || 'glm-5.3-flash';
    this.model = this.defaultModel;
    this.#credential = options.credential ?? options.apiKey;
    this.#headers = Object.freeze({ ...(options.headers ?? {}) });
    this.#extraBody = Object.freeze({ ...(options.extraBody ?? {}) });
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.capabilitiesConfig = Object.freeze({ ...(options.capabilities ?? {}) });
    if (options.modelCapabilities) {
      this.capabilitiesConfig = Object.freeze({
        ...options.modelCapabilities,
      });
    }
    this.maxRequestBytes = Math.max(1, options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES);
    this.maxResponseBytes = Math.max(1, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    this.maxToolArgumentBytes = Math.max(
      1,
      options.maxToolArgumentBytes ?? DEFAULT_MAX_TOOL_ARGUMENT_BYTES,
    );
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 150);
    this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, options.retryMaxDelayMs ?? 2_000);
    const revisionInput = safeJson({
      id: this.id,
      baseUrl: this.baseUrl,
      endpoint: this.endpoint,
      model: this.defaultModel,
      capabilities: this.capabilitiesConfig,
      extraBody: this.#extraBody,
    });
    this.revision = `openai-chat-${stableHash(revisionInput)}`;
    Object.freeze(this);
  }

  capabilities(model: string): ModelCapabilities {
    const config = this.capabilitiesConfig;
    const modelConfig = config as Readonly<Record<string, OpenAICompatibleCapabilities>>;
    const value =
      !('contextWindow' in config) && model && isRecord(modelConfig[model])
        ? modelConfig[model]
        : (config as OpenAICompatibleCapabilities);
    return Object.freeze(normalizeCapabilities(value));
  }

  /** Build the provider-native request for diagnostics and adapter contract tests. */
  buildRequest(request: ProviderRequest): OpenAIChatRequest {
    const model = request.model || this.defaultModel;
    const caps = this.capabilities(model);
    const hasImage = request.messages.some((message) => contentHasImage(message.content));
    if (hasImage && !caps.vision) {
      throw new ProviderError(`Model ${model} does not declare image input capability`, {
        kind: 'capability',
        retryable: false,
      });
    }
    if (request.tools.length > 0 && !caps.tools) {
      throw new ProviderError(`Model ${model} does not declare tool calling capability`, {
        kind: 'capability',
        retryable: false,
      });
    }
    const messages = mapMessages(request.messages);
    const tools = request.tools.length > 0 ? request.tools.map(mapTool) : undefined;
    const payload: OpenAIChatRequest = {
      ...this.#extraBody,
      model,
      messages,
      ...(tools ? { tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: Math.max(1, Math.min(request.maxOutputTokens, caps.maxOutputTokens)),
    };
    if (!Number.isFinite(request.maxOutputTokens) || request.maxOutputTokens <= 0) {
      throw new ProviderError('maxOutputTokens must be a positive finite number', {
        kind: 'invalid_request',
        retryable: false,
      });
    }
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    const serialized = strictJson(payload, 'Provider request');
    if (bytesOf(serialized) > this.maxRequestBytes) {
      throw new ProviderError('Provider request exceeds the configured byte limit', {
        kind: 'size',
        retryable: false,
      });
    }
    return payload;
  }

  requestUrl(): string {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(this.endpoint)) return this.endpoint;
    if (/\/(?:chat\/completions|completions)$/i.test(this.baseUrl)) return this.baseUrl;
    return `${this.baseUrl}/${this.endpoint}`;
  }

  stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    // Nested async generators cannot close over `this` from method scope.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return (async function* streamWithRetry(): AsyncGenerator<ProviderEvent> {
      // Validate and size-check before the first network attempt. This also
      // catches unsupported image/tool capabilities without a retry loop.
      const payload = self.buildRequest(request);
      let attempt = 0;
      while (true) {
        if (request.signal.aborted) throw abortError(request.signal);
        let outputStarted = false;
        try {
          for await (const event of self.streamAttempt(request, payload)) {
            if (event.type === 'text.delta' || event.type === 'tool.call') outputStarted = true;
            yield event;
          }
          return;
        } catch (error) {
          const normalized = self.normalizeError(error, outputStarted, request.signal);
          if (
            normalized.retryable &&
            normalized.beforeOutput &&
            !outputStarted &&
            attempt < self.maxRetries
          ) {
            const delay = Math.min(
              self.retryMaxDelayMs,
              self.retryBaseDelayMs * 2 ** attempt,
            );
            attempt += 1;
            await sleepWithAbort(delay, request.signal);
            continue;
          }
          throw normalized;
        }
      }
    })();
  }

  private async resolveCredential(): Promise<string | undefined> {
    const credential = this.#credential;
    if (!credential) return undefined;
    if (typeof credential === 'string') return credential;
    if (typeof credential === 'function') return credential();
    return credential.resolve();
  }

  private async *streamAttempt(
    request: ProviderRequest,
    payload: OpenAIChatRequest,
  ): AsyncGenerator<ProviderEvent> {
    const credential = await this.resolveCredential();
    if (request.signal.aborted) throw abortError(request.signal);
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      ...this.#headers,
    };
    if (credential) headers.Authorization = `Bearer ${credential}`;
    let response: Response;
    try {
      response = await this.fetcher(this.requestUrl(), {
        method: 'POST',
        redirect: 'error',
        headers,
        body: safeJson(payload),
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal.aborted) throw abortError(request.signal);
      throw new ProviderError('Provider network request failed', {
        kind: 'network',
        retryable: true,
        beforeOutput: true,
        cause: error,
      });
    }
    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        // Keep the status classification even if an error body cannot be read.
      }
      const classification = classifyStatus(response.status);
      throw new ProviderError(redact(errorMessageFromBody(body), credential), {
        kind: classification.kind,
        status: response.status,
        retryable: classification.retryable,
        beforeOutput: true,
      });
    }
    let responseBytes = 0;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    const accumulators = new Map<string, ToolAccumulator>();
    const finishedChoices = new Set<number>();
    let usageEmitted = false;
    let doneEmitted = false;
    let finishSeen = false;
    let finalReason: 'stop' | 'tool_calls' | 'length' = 'stop';
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const provider = this;

    const processEvent = async function* (raw: string): AsyncGenerator<ProviderEvent> {
      const dataLines: string[] = [];
      for (const line of raw.replace(/\r/g, '').split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join('\n');
      if (data === '[DONE]') {
        if (accumulators.size > 0 && finalReason === 'stop') finalReason = 'tool_calls';
        for (const event of flushToolCalls(accumulators, provider.maxToolArgumentBytes)) yield event;
        if (!doneEmitted) {
          doneEmitted = true;
          yield { type: 'done', reason: finalReason };
        }
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch (error) {
        throw new ProviderError('Provider SSE event is not valid JSON', {
          kind: 'schema',
          retryable: false,
          beforeOutput: true,
          cause: error,
        });
      }
      if (!isRecord(parsed)) {
        throw new ProviderError('Provider SSE event must be an object', {
          kind: 'schema',
          retryable: false,
        });
      }
      if (isRecord(parsed.error)) {
        const message =
          typeof parsed.error.message === 'string' ? parsed.error.message : 'Provider stream error';
        const status = typeof parsed.error.status === 'number'
          ? parsed.error.status
          : typeof parsed.error.code === 'number'
            ? parsed.error.code
            : undefined;
        const code = typeof parsed.error.code === 'string' ? parsed.error.code.toLowerCase() : '';
        const classification = status
          ? classifyStatus(status)
          : code.includes('rate')
            ? { kind: 'rate_limit' as const, retryable: true }
            : code.includes('timeout') || code.includes('overload')
              ? { kind: 'network' as const, retryable: true }
              : { kind: 'unknown' as const, retryable: false };
        throw new ProviderError(redact(message, credential), {
          kind: classification.kind,
          status,
          retryable: classification.retryable,
          beforeOutput: true,
        });
      }
      const usage = usageFrom(parsed.usage);
      if (usage && !usageEmitted) {
        usageEmitted = true;
        yield { type: 'usage', usage };
      }
      if (!Array.isArray(parsed.choices)) return;
      for (const rawChoice of parsed.choices) {
        if (!isRecord(rawChoice)) {
          throw new ProviderError('Provider choice has an invalid shape', { kind: 'schema' });
        }
        const choice = rawChoice as unknown as OpenAIChoice;
        const choiceIndex = typeof choice.index === 'number' ? choice.index : 0;
        const delta = isRecord(choice.delta) ? choice.delta : undefined;
        if (delta) for (const text of textDeltas(delta.content)) yield { type: 'text.delta', text };
        if (delta) {
          const rawCalls = delta.tool_calls ?? delta.function_call;
          const calls = Array.isArray(rawCalls) ? rawCalls : rawCalls ? [rawCalls] : [];
          for (let ordinal = 0; ordinal < calls.length; ordinal += 1) {
            const rawCall = calls[ordinal];
            if (!isRecord(rawCall)) {
              throw new ProviderError('Provider tool delta has an invalid shape', {
                kind: 'schema',
              });
            }
            const toolIndex =
              typeof rawCall.index === 'number' ? rawCall.index : delta.tool_calls ? ordinal : 0;
            const key = `${choiceIndex}:${toolIndex}`;
            const current =
              accumulators.get(key) ?? {
                choiceIndex,
                toolIndex,
                id: `call_${choiceIndex}_${toolIndex}`,
                name: '',
                arguments: '',
                emitted: false,
              };
            if (typeof rawCall.id === 'string' && rawCall.id.length > 0) current.id = rawCall.id;
            const functionDelta = isRecord(rawCall.function)
              ? rawCall.function
              : rawCall;
            if (typeof functionDelta.name === 'string') current.name += functionDelta.name;
            if (typeof functionDelta.arguments === 'string') {
              current.arguments += functionDelta.arguments;
              if (bytesOf(current.arguments) > provider.maxToolArgumentBytes) {
                throw new ProviderError('Tool arguments exceed the configured byte limit', {
                  kind: 'size',
                  retryable: false,
                  beforeOutput: true,
                });
              }
            }
            accumulators.set(key, current);
          }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          finishSeen = true;
          finalReason = reasonToDoneReason(choice.finish_reason);
          if (!finishedChoices.has(choiceIndex)) {
            finishedChoices.add(choiceIndex);
            for (const event of flushToolCallsForChoice(
              accumulators,
              choiceIndex,
              provider.maxToolArgumentBytes,
            )) yield event;
          }
          if (choice.finish_reason === 'content_filter') {
            throw new ProviderError('Provider rejected the generated content', {
              kind: 'content',
              retryable: false,
              beforeOutput: false,
            });
          }
        }
      }
    };

    for await (const chunk of bodyChunks(response.body)) {
      if (request.signal.aborted) throw abortError(request.signal);
      responseBytes += chunk.byteLength;
      if (responseBytes > this.maxResponseBytes) {
        throw new ProviderError('Provider response exceeds the configured byte limit', {
          kind: 'size',
          retryable: false,
          beforeOutput: true,
        });
      }
      try {
        buffer += decoder.decode(chunk, { stream: true });
      } catch (error) {
        throw new ProviderError('Provider stream contains invalid UTF-8', {
          kind: 'schema',
          retryable: false,
          beforeOutput: true,
          cause: error,
        });
      }
      let separator = findSseSeparator(buffer);
      while (separator) {
        const raw = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        for await (const event of processEvent(raw)) yield event;
        separator = findSseSeparator(buffer);
      }
    }
    try {
      buffer += decoder.decode();
    } catch (error) {
      throw new ProviderError('Provider stream contains incomplete UTF-8', {
        kind: 'schema',
        retryable: false,
        beforeOutput: true,
        cause: error,
      });
    }
    if (buffer.trim()) {
      for await (const event of processEvent(buffer)) yield event;
    }
    for (const event of flushToolCalls(accumulators, provider.maxToolArgumentBytes)) yield event;
    if (!doneEmitted) {
      if (!finishSeen) {
        throw new ProviderError('Provider stream ended before a completion marker', {
          kind: 'network',
          retryable: true,
          beforeOutput: true,
        });
      }
      doneEmitted = true;
      yield { type: 'done', reason: finalReason };
    }
  }

  private normalizeError(error: unknown, outputStarted: boolean, signal: AbortSignal): ProviderError {
    if (error instanceof ProviderError) {
      return new ProviderError(redact(error.message), {
        kind: error.kind,
        status: error.status,
        retryable: error.retryable,
        beforeOutput: !outputStarted && error.beforeOutput,
        cause: error,
      });
    }
    if (signal.aborted) return abortError(signal);
    return new ProviderError('Provider stream failed', {
      kind: 'network',
      retryable: true,
      beforeOutput: !outputStarted,
      cause: error,
    });
  }
}

function findSseSeparator(value: string): { index: number; length: number } | undefined {
  const lf = value.indexOf('\n\n');
  const crlf = value.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return undefined;
  if (lf < 0) return { index: crlf, length: 4 };
  if (crlf < 0 || lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function flushToolCalls(
  accumulators: Map<string, ToolAccumulator>,
  maxBytes: number,
): ProviderEvent[] {
  return [...accumulators.values()]
    .sort((a, b) => a.choiceIndex - b.choiceIndex || a.toolIndex - b.toolIndex)
    .flatMap((accumulator) => flushAccumulator(accumulator, maxBytes));
}

function flushToolCallsForChoice(
  accumulators: Map<string, ToolAccumulator>,
  choiceIndex: number,
  maxBytes: number,
): ProviderEvent[] {
  return [...accumulators.values()]
    .filter((item) => item.choiceIndex === choiceIndex)
    .sort((a, b) => a.toolIndex - b.toolIndex)
    .flatMap((accumulator) => flushAccumulator(accumulator, maxBytes));
}

function flushAccumulator(accumulator: ToolAccumulator, maxBytes: number): ProviderEvent[] {
  if (accumulator.emitted) return [];
  accumulator.emitted = true;
  if (!accumulator.name) {
    throw new ProviderError('Provider tool call has no function name', {
      kind: 'schema',
      retryable: false,
      beforeOutput: true,
    });
  }
  if (bytesOf(accumulator.arguments) > maxBytes) {
    throw new ProviderError('Tool arguments exceed the configured byte limit', {
      kind: 'size',
      retryable: false,
      beforeOutput: true,
    });
  }
  let args: unknown = {};
  try {
    if (accumulator.arguments.trim()) args = JSON.parse(accumulator.arguments);
  } catch (error) {
    throw new ProviderError('Provider returned invalid JSON tool arguments', {
      kind: 'schema',
      retryable: false,
      beforeOutput: true,
      cause: error,
    });
  }
  return [
    {
      type: 'tool.call',
      call: {
        id: accumulator.id,
        name: accumulator.name,
        arguments: args,
      },
    },
  ];
}
