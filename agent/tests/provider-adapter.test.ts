import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider, ProviderRegistry, ProviderError } from '../src/providers/index.js';
import type { Message, ProviderRequest, ToolSpec } from '../src/contracts/index.js';

function request(messages: Message[], tools: ToolSpec[] = []): ProviderRequest {
  return {
    model: 'glm-5.3-flash',
    messages,
    tools,
    signal: new AbortController().signal,
    maxOutputTokens: 200,
  };
}

function responseFor(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('OpenAI-compatible adapter reassembles UTF-8 text and multiple indexed tools', async () => {
  const events = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '你' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'bar', arguments: '{"x":' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'foo', arguments: '{"y":2}' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '3}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 6 } })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const body = responseFor(events);
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://provider/v4',
    model: 'glm-5.3-flash',
    apiKey: 'secret-value',
    capabilities: { contextWindow: 1_000, maxOutputTokens: 200, tools: true, vision: true, parallelTools: true },
    fetch: async (_url, init) => {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer secret-value');
      assert.equal(String(init?.body).includes('secret-value'), false);
      return body;
    },
  });
  assert.equal(JSON.stringify(provider).includes('secret-value'), false);
  const result = [];
  for await (const event of provider.stream(request([{ id: 'u', role: 'user', content: [{ type: 'text', text: 'go' }], createdAt: 1 }], [
    { name: 'foo', description: '', inputSchema: { type: 'object' }, revision: '1' },
    { name: 'bar', description: '', inputSchema: { type: 'object' }, revision: '1' },
  ]))) result.push(event);
  assert.deepEqual(result.filter((event) => event.type === 'text.delta').map((event) => event.type === 'text.delta' && event.text), ['你', '好']);
  const calls = result.filter((event) => event.type === 'tool.call').map((event) => event.type === 'tool.call' && event.call);
  assert.deepEqual(calls, [
    { id: 'a', name: 'foo', arguments: { y: 2 } },
    { id: 'b', name: 'bar', arguments: { x: 3 } },
  ]);
  assert.deepEqual(result.find((event) => event.type === 'usage'), { type: 'usage', usage: { inputTokens: 4, outputTokens: 6 } });
  assert.deepEqual(result.at(-1), { type: 'done', reason: 'tool_calls' });
});

test('tool images are emitted after the complete contiguous tool block', () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://provider/v4',
    capabilities: { contextWindow: 1_000, maxOutputTokens: 200, tools: true, vision: true },
  });
  const assistant: Message = { id: 'a', role: 'assistant', content: [], toolCalls: [{ id: 'c1', name: 'one', arguments: {} }, { id: 'c2', name: 'two', arguments: {} }], createdAt: 1 };
  const payload = provider.buildRequest(request([
    assistant,
    { id: 'r1', role: 'tool', callId: 'c1', content: [{ type: 'image', url: 'https://asset/1', asset: { assetId: 'asset-1', version: 2, role: 'reference' } }], createdAt: 2 },
    { id: 'r2', role: 'tool', callId: 'c2', content: [{ type: 'text', text: 'done' }], createdAt: 3 },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'next' }], createdAt: 4 },
  ], []));
  const messages = payload.messages as Array<Record<string, unknown>>;
  assert.equal(messages[1].role, 'tool');
  assert.equal(messages[2].role, 'tool');
  assert.equal(messages[3].role, 'user');
  assert.match(JSON.stringify(messages[3]), /c1/);
  assert.match(JSON.stringify(messages[3]), /asset-1/);
});

test('provider registry keeps old revisions immutable across replacement', () => {
  const p1 = new OpenAICompatibleProvider({ baseUrl: 'http://one', id: 'x' });
  const registry = new ProviderRegistry([p1]);
  const first = registry.snapshot();
  const p2 = new OpenAICompatibleProvider({ baseUrl: 'http://two', id: 'x' });
  registry.update(p2);
  assert.equal(first.providers[0], p1);
  assert.equal(registry.snapshot().providers[0], p2);
  assert.notEqual(first.revision, registry.snapshot().revision);
});

test('retry happens before output, and errors never echo the credential', async () => {
  let attempts = 0;
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://provider/v4',
    apiKey: 'secret-value',
    maxRetries: 1,
    retryBaseDelayMs: 0,
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) return new Response('{"error":{"message":"temporary"}}', { status: 503 });
      return responseFor(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']);
    },
  });
  const result = [];
  for await (const event of provider.stream(request([{ id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], createdAt: 1 }]))) result.push(event);
  assert.equal(attempts, 2);
  assert.deepEqual(result.at(-1), { type: 'done', reason: 'stop' });
  const failing = new OpenAICompatibleProvider({ baseUrl: 'http://provider/v4', apiKey: 'secret-value', maxRetries: 0, fetch: async () => new Response('secret-value', { status: 401 }) });
  await assert.rejects(async () => {
    for await (const _event of failing.stream(request([{ id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], createdAt: 1 }]))) { /* consume */ }
  }, (error: unknown) => error instanceof ProviderError && !String(error).includes('secret-value') && error.kind === 'auth');
});

test('truncated SSE without finish marker is classified as an incomplete stream', async () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: 'http://provider/v4',
    maxRetries: 0,
    fetch: async () => responseFor(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']),
  });
  await assert.rejects(async () => {
    for await (const _event of provider.stream(request([{ id: 'u', role: 'user', content: [{ type: 'text', text: 'x' }], createdAt: 1 }]))) { /* consume */ }
  }, (error: unknown) => error instanceof ProviderError && error.kind === 'network' && error.beforeOutput === false);
});
