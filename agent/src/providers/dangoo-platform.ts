import type {
  ContentPart,
  Message,
  ModelCapabilities,
  Provider,
  ProviderEvent,
  ProviderRequest,
  Scope,
  ToolCall,
  ToolSpec,
} from '../contracts/index.js';
import { ProviderError, classifyProviderStatus } from './openai-compatible.js';

export interface DangooPlatformProviderOptions {
  baseUrl: string;
  tokenForScope(scope: Scope): string;
  authHeader?: 'Authorization' | 'X-Pb-Auth';
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  pollDeadlineMs?: number;
}

type PlatformCapabilities = ModelCapabilities & { supportsTemperature: boolean };

const PLATFORM_CAPABILITIES: Record<string, PlatformCapabilities> = {
  'doubao-seed-2.0-lite': { contextWindow: 128_000, maxOutputTokens: 8_192, tools: true, vision: true, parallelTools: false, supportsTemperature: true },
  'gemini-3.5-flash': { contextWindow: 128_000, maxOutputTokens: 8_192, tools: true, vision: true, parallelTools: false, supportsTemperature: true },
  'qwen3.8-max': { contextWindow: 128_000, maxOutputTokens: 8_192, tools: true, vision: true, parallelTools: false, supportsTemperature: true },
  'qwen3.8-flash-next': { contextWindow: 128_000, maxOutputTokens: 16_384, tools: true, vision: true, parallelTools: false, supportsTemperature: true },
  'gemini-3.8-flash': { contextWindow: 128_000, maxOutputTokens: 16_384, tools: true, vision: true, parallelTools: false, supportsTemperature: true },
  'doubao-seed-2.1-pro': { contextWindow: 128_000, maxOutputTokens: 16_384, tools: true, vision: true, parallelTools: false, supportsTemperature: true },
};

const DEFAULT_CAPABILITIES: PlatformCapabilities = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  tools: true,
  vision: true,
  parallelTools: false,
  supportsTemperature: true,
};

type OpenAiMessage = Record<string, unknown>;
type OpenAiContent = string | Array<Record<string, unknown>>;
type OpenAiResponse = {
  choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export class DangooPlatformProvider implements Provider {
  readonly id = 'dangoo-platform';
  readonly revision = 'dangoo-platform-llm-v1';
  private readonly base: URL;
  private readonly authHeader: 'Authorization' | 'X-Pb-Auth';
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: DangooPlatformProviderOptions) {
    this.base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
    const local = this.base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(this.base.hostname);
    if (this.base.protocol !== 'https:' && !local) throw new ProviderError('平台模型接口必须使用 HTTPS 或本机地址', { kind: 'invalid_request' });
    this.authHeader = options.authHeader ?? 'Authorization';
    this.fetcher = options.fetch ?? fetch;
  }

  capabilities(model: string): ModelCapabilities {
    const { supportsTemperature: _ignored, ...capabilities } = PLATFORM_CAPABILITIES[model] ?? DEFAULT_CAPABILITIES;
    return capabilities;
  }

  listPlatformModels(): string[] {
    return Object.keys(PLATFORM_CAPABILITIES);
  }

  scoped(scope: Scope): Provider {
    return new ScopedDangooPlatformProvider(this, scope);
  }

  stream(): AsyncIterable<ProviderEvent> {
    throw new ProviderError('平台模型 Provider 必须先绑定当前会话范围', { kind: 'invalid_request' });
  }

  async *streamScoped(scope: Scope, request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const response = await this.complete(scope, request);
    const choice = response.choices?.[0];
    const text = choice?.message?.content;
    const textContent = typeof text === 'string' ? text : Array.isArray(text) ? text.filter(isTextPart).map(part => part.text).join('') : '';
    if (textContent) yield { type: 'text.delta', text: textContent };

    const calls = platformToolCalls(choice?.message?.tool_calls);
    for (const call of calls) yield { type: 'tool.call', call };

    if (response.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: response.usage.prompt_tokens ?? 0,
          outputTokens: response.usage.completion_tokens ?? 0,
        },
      };
    }
    yield { type: 'done', reason: calls.length ? 'tool_calls' : finishReason(choice?.finish_reason) };
  }

  private async complete(scope: Scope, request: ProviderRequest): Promise<OpenAiResponse> {
    const token = this.options.tokenForScope(scope).trim();
    if (!token) throw new ProviderError('请先登录后再使用 Agent', { kind: 'auth', retryable: false });
    const modelConfig = PLATFORM_CAPABILITIES[request.model];
    const requestId = `agent-${randomRequestId()}`;
    const payload = {
      model: request.model,
      messages: request.messages.map(mapMessage),
      tools: request.tools.length ? request.tools.map(mapTool) : undefined,
      tool_choice: request.tools.length ? 'auto' : undefined,
      max_tokens: Math.max(16, Math.min(request.maxOutputTokens, modelConfig?.maxOutputTokens ?? 16_384)),
      temperature: modelConfig?.supportsTemperature ? request.temperature : undefined,
      request_id: requestId,
      page: 'agent-runtime',
    };
    try {
      const response = await this.fetcher(new URL('api/llm/chat', this.base), {
        method: 'POST',
        redirect: 'error',
        headers: this.headers(token),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000),
      });
      if (response.ok) return await response.json() as OpenAiResponse;
      if (response.status === 429) throw new ProviderError('模型请求过于频繁，请稍后重试', { kind: 'rate_limit', retryable: true, status: 429 });
      if (![502, 503, 504].includes(response.status)) throw await this.platformError(response.status);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (request.signal.aborted) throw aborted(request.signal.reason);
    }
    return await this.poll(token, requestId, request.signal);
  }

  private async poll(token: string, requestId: string, signal: AbortSignal): Promise<OpenAiResponse> {
    const interval = this.options.pollIntervalMs ?? 2_000;
    const deadline = Date.now() + (this.options.pollDeadlineMs ?? 7 * 60_000);
    while (Date.now() < deadline) {
      if (signal.aborted) throw aborted(signal.reason);
      await new Promise(resolve => setTimeout(resolve, interval));
      try {
        const response = await this.fetcher(new URL('api/llm/poll', this.base), {
          method: 'POST',
          redirect: 'error',
          headers: this.headers(token),
          body: JSON.stringify({ request_id: requestId }),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          const data = await response.json() as OpenAiResponse & { ok?: boolean; status?: string };
          if (data.ok === true) return data;
          if (data.status === 'failed') throw new ProviderError('平台模型任务执行失败', { kind: 'server', retryable: true });
          continue;
        }
        if (response.status === 401) throw new ProviderError('登录状态已过期，请重新登录', { kind: 'auth', retryable: false, status: 401 });
        if (response.status === 404 || ![429, 502, 503, 504].includes(response.status)) throw await this.platformError(response.status);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
      }
    }
    throw new ProviderError('平台模型任务超时', { kind: 'network', retryable: true });
  }

  private async platformError(status: number): Promise<ProviderError> {
    return new ProviderError(`平台模型请求失败 (${status})`, {
      ...classifyProviderStatus(status),
      retryable: [429, 500, 502, 503, 504].includes(status),
      status,
    });
  }

  private headers(token: string): HeadersInit {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authHeader === 'Authorization') headers.Authorization = `Bearer ${token}`;
    else headers['X-Pb-Auth'] = token;
    return headers;
  }
}

class ScopedDangooPlatformProvider implements Provider {
  readonly id: string;
  readonly revision: string;

  constructor(private readonly parent: DangooPlatformProvider, private readonly scope: Scope) {
    this.id = parent.id;
    this.revision = parent.revision;
  }

  capabilities(model: string): ModelCapabilities { return this.parent.capabilities(model); }
  scoped(scope: Scope): Provider { return new ScopedDangooPlatformProvider(this.parent, scope); }
  listPlatformModels(): string[] { return this.parent.listPlatformModels(); }
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent> { return this.parent.streamScoped(this.scope, request); }
}

function finishReason(value: string | undefined): 'stop' | 'tool_calls' | 'length' {
  return value === 'length' ? 'length' : value === 'tool_calls' ? 'tool_calls' : 'stop';
}

function isTextPart(value: unknown): value is { text: string } {
  return typeof value === 'object' && value !== null && 'text' in value && typeof (value as { text?: unknown }).text === 'string';
}

function mapMessage(message: Message): OpenAiMessage {
  if (message.role === 'tool') {
    if (!message.callId) throw new ProviderError('工具结果缺少调用 ID', { kind: 'schema', retryable: false });
    return { role: 'tool', tool_call_id: message.callId, content: mapContent(message.content) };
  }
  const result: OpenAiMessage = { role: message.role, content: mapContent(message.content) };
  if (message.role === 'assistant' && message.toolCalls?.length) {
    result.tool_calls = message.toolCalls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: stringifyArguments(call.arguments) },
    }));
  }
  return result;
}

function mapContent(content: ContentPart[]): OpenAiContent {
  if (content.length === 0) return '';
  const mapped = content.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image' && part.url) return { type: 'image_url', image_url: { url: part.url, detail: 'auto' } };
    throw new ProviderError('Agent 会话包含未解析的资产引用', { kind: 'invalid_request', retryable: false });
  });
  return mapped.length === 1 && mapped[0]?.type === 'text' ? String(mapped[0].text) : mapped;
}

function mapTool(tool: ToolSpec): Record<string, unknown> {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
}

function stringifyArguments(value: unknown): string {
  try { return JSON.stringify(value ?? {}); } catch { return '{}'; }
}

function platformToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const func = record.function && typeof record.function === 'object' ? record.function as Record<string, unknown> : null;
    const id = typeof record.id === 'string' ? record.id : '';
    const name = func && typeof func.name === 'string' ? func.name : '';
    if (!id || !name) continue;
    let args: unknown;
    try {
      const raw = func && typeof func.arguments === 'string' ? func.arguments : '';
      args = raw ? JSON.parse(raw) : {};
    } catch {
      throw new ProviderError('平台模型返回的工具参数不是有效 JSON', { kind: 'schema', retryable: false });
    }
    calls.push({ id, name, arguments: args });
  }
  return calls;
}

function randomRequestId(): string {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function aborted(reason: unknown): ProviderError {
  return new ProviderError('模型请求已中止', {
    kind: 'aborted',
    retryable: false,
    beforeOutput: false,
    cause: reason instanceof Error ? reason : undefined,
  });
}
