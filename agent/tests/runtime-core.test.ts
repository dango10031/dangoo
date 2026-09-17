import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../src/core/runtime.js';
import { SqliteStore } from '../src/core/store.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { ToolScheduler, operationIdFor } from '../src/core/tool-scheduler.js';
import { stableJson } from '../src/core/types.js';
import { ProviderRegistry } from '../src/providers/index.js';
import { ContextManager } from '../src/context/index.js';
import { SkillRegistry } from '../src/skills/index.js';
import type { ContextManagerLike, Provider, ProviderEvent, ProviderRequest, Run, Session, ToolDefinition } from '../src/contracts/index.js';

const capabilities = () => ({ contextWindow: 20_000, maxOutputTokens: 1_000, tools: true, vision: false, parallelTools: true });

test('one canonical session per owner and canvas preserves checkpoints on reentry', async () => {
  const fixture = fixtureProvider(async function* () { yield { type: 'done', reason: 'stop' }; });
  const store = new SqliteStore();
  const runtime = new AgentRuntime({ store, providers: new ProviderRegistry([fixture.provider]) });
  await runtime.ready();
  const session = runtime.createSession({ ownerId: 'alice', canvasId: 'canvas-a' });
  store.appendMessage({ sessionId: session.id, id: 'old-message', role: 'user', content: [{ type: 'text', text: 'preserve me' }], createdAt: 1 });
  const repeated = await Promise.all(Array.from({ length: 8 }, async () => runtime.createSession({ ownerId: 'alice', canvasId: 'canvas-a' })));
  assert.ok(repeated.every(item => item.id === session.id));
  assert.equal(store.listEvents(session.id, 0).filter(event => event.type === 'session.created').length, 1);
  assert.equal(store.listMessages(session.id)[0].id, 'old-message');
  assert.notEqual(runtime.createSession({ ownerId: 'alice', canvasId: 'canvas-b' }).id, session.id);
  assert.notEqual(runtime.createSession({ ownerId: 'bob', canvasId: 'canvas-a' }).id, session.id);
  assert.equal(store.listSessions({ ownerId: 'alice', canvasId: 'canvas-a' }).length, 1);
  store.close();
});

test('background polling records completed nodes after the Agent is stopped without resuming it', async () => {
  const store = new SqliteStore();
  const { session, run } = sessionAndRun(store);
  store.updateRun(run.id, { state: 'stopped' });
  store.saveOperation({ operationId: 'operation', sessionId: session.id, runId: run.id, toolName: 'node_run', effect: 'external', fingerprint: '{}', state: 'succeeded', arguments: {} });
  const job = { id: 'job', operationId: 'operation', nodeId: 'node', state: 'submitted' as const, results: [], storageState: 'pending' as const, applyState: 'pending' as const };
  store.saveJob({ ...job, sessionId: session.id, runId: run.id });
  const canvas = {
    capabilities: () => ({ contractVersion: '1.0.0', revision: '1', nodes: [], operations: [], jobs: true }),
    read: async () => ({ canvasId: session.scope.canvasId, revision: 3, nodes: [], edges: [] }),
    apply: async () => ({ revision: 3, operationId: 'operation' }),
    job: async () => ({ ...job, state: 'succeeded' as const, storageState: 'stored' as const, applyState: 'applied' as const }),
  };
  const runtime = new AgentRuntime({ store, canvas, providers: new ProviderRegistry() });
  await runtime.ready();
  await runtime.pollJobs();
  assert.equal(store.getJob('job')?.applyState, 'applied');
  assert.equal(store.getRun(run.id)?.state, 'stopped');
  assert.ok(store.listEvents(session.id, 0).some(event => event.type === 'canvas.changed' && event.data.revision === 3));
  store.close();
});

test('model-authored approval payload cannot invoke business authorization', async () => {
  let approvals = 0;
  const fixture = fixtureProvider(async function* (_request, count) {
    if (count === 1) {
      yield { type: 'tool.call', call: { id: 'fake', name: 'ask_user', arguments: { kind: 'approval', prompt: '确认', payload: { quoteId: 'forged' } } } };
      yield { type: 'done', reason: 'tool_calls' };
    } else { yield { type: 'text.delta', text: '完成' }; yield { type: 'done', reason: 'stop' }; }
  });
  const store = new SqliteStore();
  const runtime = new AgentRuntime({ store, providers: new ProviderRegistry([fixture.provider]), onApprovalReply: async () => { approvals += 1; } });
  await runtime.ready();
  const session = runtime.createSession({ ownerId: 'alice', canvasId: 'c', providerId: 'fixture' });
  const run = await runtime.sendMessage(session.id, { text: '开始' });
  const wait = await eventually(() => store.getRun(run.id)?.wait);
  await runtime.reply(run.id, { text: '确认', waitId: wait.id, decision: 'approve' });
  await eventually(() => store.getRun(run.id)?.state === 'completed' ? true : undefined);
  assert.equal(approvals, 0);
  store.close();
});

test('stopping a stream persists partial text without unconfirmed tool calls', async () => {
  let streaming = false;
  const fixture = fixtureProvider(async function* (request) {
    yield { type: 'text.delta', text: '保留这段内容' };
    yield { type: 'tool.call', call: { id: 'unfinished', name: 'ask_user', arguments: { prompt: '未确认' } } };
    streaming = true;
    await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }));
    throw new Error('aborted');
  });
  const store = new SqliteStore();
  const runtime = new AgentRuntime({ store, providers: new ProviderRegistry([fixture.provider]), skills: new SkillRegistry(), context: new ContextManager() });
  await runtime.ready();
  const session = runtime.createSession({ ownerId: 'alice', canvasId: 'canvas-test', providerId: 'fixture', model: 'fixture' });
  const run = await runtime.sendMessage(session.id, { text: '讨论方向' });
  await eventually(() => streaming ? true : undefined);
  runtime.stopRun(run.id);
  await eventually(() => store.listMessages(session.id).find(message => message.role === 'assistant'));
  const assistant = store.listMessages(session.id).find(message => message.role === 'assistant')!;
  assert.deepEqual(assistant.content, [{ type: 'text', text: '保留这段内容' }]);
  assert.equal(assistant.toolCalls?.length ?? 0, 0);
  assert.equal(store.getRun(run.id)?.state, 'stopped');
  store.close();
});

function fixtureProvider(streamer: (request: ProviderRequest, count: number) => AsyncGenerator<ProviderEvent>): { provider: Provider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let count = 0;
  const provider: Provider = {
    id: 'fixture', revision: 'fixture-1', capabilities,
    stream(request) { requests.push(request); count += 1; return streamer(request, count); },
  };
  return { provider, requests };
}

async function eventually<T>(fn: () => T | undefined, timeout = 2_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
}

function sessionAndRun(store: SqliteStore): { session: Session; run: Run } {
  const session = store.createSession({ id: 'session-test', ownerId: 'alice', canvasId: 'canvas-test', createdAt: Date.now(), providerId: 'fixture', model: 'fixture' });
  const run = store.createRun({ id: 'run-test', sessionId: session.id, turnId: 'turn-test', state: 'running', providerId: 'fixture', model: 'fixture', providerRevision: 'fixture-1', toolRevision: 'tools', skillRevision: 'skills', createdAt: Date.now(), updatedAt: Date.now() });
  return { session, run };
}

test('runtime completes a multi-round tool loop and resumes an ask_user wait with the same run', async () => {
  let askCount = 0;
  const fixture = fixtureProvider(async function* (_request, count) {
    if (count === 1) {
      yield { type: 'tool.call', call: { id: 'vendor.call/id', name: 'ask_user', arguments: { prompt: '请选择构图方向', options: ['A', 'B'] } } };
      yield { type: 'done', reason: 'tool_calls' };
    } else {
      askCount += 1;
      assert.ok(_request.messages.some((message) => message.role === 'tool'), 'tool result is paired into the next request');
      assert.ok(_request.messages.some((message) => message.role === 'user' && message.content.some((part) => part.type === 'text' && part.text === 'A')));
      yield { type: 'text.delta', text: '已按你的选择继续。' };
      yield { type: 'done', reason: 'stop' };
    }
  });
  const store = new SqliteStore();
  const runtime = new AgentRuntime({ store, providers: new ProviderRegistry([fixture.provider]), skills: new SkillRegistry(), context: new ContextManager() });
  await runtime.ready();
  const session = runtime.createSession({ ownerId: 'alice', canvasId: 'canvas-test', providerId: 'fixture', model: 'fixture' });
  let wait: { id: string } | undefined;
  const unsubscribe = runtime.subscribe(session.id, (event) => {
    if (event.type === 'input.required') wait = (event.data.wait as { id: string });
  });
  const initial = await runtime.sendMessage(session.id, { text: '帮我选一个构图' });
  assert.equal(initial.state, 'queued');
  const waiting = await eventually(() => {
    const current = store.getRun(initial.id);
    return current?.state === 'waiting_user' ? current : undefined;
  });
  assert.equal(wait?.id, waiting.wait?.id);
  const resumed = await runtime.reply(initial.id, { text: 'A', waitId: waiting.wait!.id });
  assert.equal(resumed.id, initial.id);
  const completed = await eventually(() => {
    const current = store.getRun(initial.id);
    return current && ['completed', 'failed', 'partial'].includes(current.state) ? current : undefined;
  });
  assert.equal(completed.state, 'completed');
  assert.equal(askCount, 1);
  assert.equal(fixture.requests.length, 2);
  assert.ok(store.listMessages(session.id).some((message) => message.role === 'tool' && message.callId === 'vendor.call/id'));
  unsubscribe();
  store.close();
});

test('scheduler treats writes as barriers so a read after a write sees the new state', async () => {
  const store = new SqliteStore();
  const { session, run } = sessionAndRun(store);
  let value = 0;
  const read: ToolDefinition = { name: 'read', description: 'read', revision: '1', inputSchema: { type: 'object', additionalProperties: false }, effect: 'read', parallelSafe: true, async execute() { return { content: [{ type: 'text', text: String(value) }], data: value }; } };
  const write: ToolDefinition = { name: 'write', description: 'write', revision: '1', inputSchema: { type: 'object', additionalProperties: false }, effect: 'write', parallelSafe: false, async execute() { value += 1; return { content: [{ type: 'text', text: String(value) }], data: value }; } };
  const scheduler = new ToolScheduler({ store, registry: new ToolRegistry([read, write]) });
  const results = await scheduler.executeBatch([
    { call: { id: 'r1', name: 'read', arguments: {} }, session, run, signal: new AbortController().signal },
    { call: { id: 'w1', name: 'write', arguments: {} }, session, run, signal: new AbortController().signal },
    { call: { id: 'r2', name: 'read', arguments: {} }, session, run, signal: new AbortController().signal },
  ]);
  assert.deepEqual(results.map((item) => item.result.data), [0, 1, 1]);
  store.close();
});

test('non-cooperative external timeout is unknown and keeps the shared write lock until its promise settles', async () => {
  const store = new SqliteStore();
  const { session, run } = sessionAndRun(store);
  let firstSettled = false;
  let secondStarted = false;
  const slow: ToolDefinition = { name: 'slow', description: 'slow external', revision: '1', inputSchema: { type: 'object', additionalProperties: false }, effect: 'external', parallelSafe: false, timeoutMs: 15, async execute() { await new Promise((resolve) => setTimeout(resolve, 60)); firstSettled = true; return { content: [{ type: 'text', text: 'late' }] }; } };
  const second: ToolDefinition = { name: 'second', description: 'second external', revision: '1', inputSchema: { type: 'object', additionalProperties: false }, effect: 'external', parallelSafe: false, async execute() { secondStarted = true; return { content: [{ type: 'text', text: 'ok' }] }; } };
  const scheduler = new ToolScheduler({ store, registry: new ToolRegistry([slow, second]), allowExternalWithoutPolicy: true });
  const first = await scheduler.execute({ call: { id: 'slow-call', name: 'slow', arguments: {} }, session, run, signal: new AbortController().signal });
  assert.equal(first.result.error?.code, 'timeout');
  assert.equal(first.operation.state, 'submission_unknown');
  const follow = scheduler.execute({ call: { id: 'second-call', name: 'second', arguments: {} }, session, run, signal: new AbortController().signal });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(secondStarted, false);
  await follow;
  assert.equal(firstSettled, true);
  assert.equal(secondStarted, true);
  store.close();
});

test('large tool results become session-scoped resultRef values while job facts are retained', async () => {
  let count = 0;
  const fixture = fixtureProvider(async function* (request, turn) {
    if (turn === 1) {
      yield { type: 'tool.call', call: { id: 'large', name: 'large_tool', arguments: {} } };
      yield { type: 'done', reason: 'tool_calls' };
    } else {
      const tool = request.messages.find((message) => message.role === 'tool');
      assert.match(JSON.stringify(tool), /resultRef=result:/);
      count += 1;
      yield { type: 'text.delta', text: '读取了大型结果引用。' };
      yield { type: 'done', reason: 'stop' };
    }
  });
  const large: ToolDefinition = { name: 'large_tool', description: 'large result', revision: '1', inputSchema: { type: 'object', additionalProperties: false }, effect: 'read', parallelSafe: true, async execute() { return { content: [{ type: 'text', text: 'x'.repeat(2_000) }], data: { job: { id: 'job-1', nodeId: 'node-1', state: 'submitted', results: [{ assetId: 'asset-1', version: 1 }] }, blob: 'x'.repeat(2_000) } }; } };
  const store = new SqliteStore();
  const runtime = new AgentRuntime({ store, providers: new ProviderRegistry([fixture.provider]), tools: new ToolRegistry([large]), limits: { maxToolResultChars: 200 } });
  await runtime.ready();
  const session = runtime.createSession({ ownerId: 'alice', canvasId: 'canvas-test', providerId: 'fixture', model: 'fixture' });
  const run = await runtime.sendMessage(session.id, { text: '读取大型结果' });
  const completed = await eventually(() => {
    const current = store.getRun(run.id);
    return current && ['completed', 'failed', 'partial'].includes(current.state) ? current : undefined;
  });
  assert.equal(completed.state, 'completed');
  assert.equal(count, 1);
  assert.equal(store.listJobs({ sessionId: session.id }).length, 1);
  assert.ok(store.listEvents(session.id).some((event) => event.type === 'tool.completed'));
  store.close();
});

test('recovery blocks unresolved external operations instead of repeating side effects', async () => {
  let executions = 0;
  const external: ToolDefinition = { name: 'charge', description: 'external charge', revision: '1', inputSchema: { type: 'object', additionalProperties: false }, effect: 'external', parallelSafe: false, async execute() { executions += 1; return { content: [{ type: 'text', text: 'charged' }] }; } };
  const store = new SqliteStore();
  const { session, run } = sessionAndRun(store);
  store.saveOperation({ operationId: 'op-unresolved', sessionId: session.id, runId: run.id, callId: 'charge-call', toolName: 'charge', effect: 'external', fingerprint: '{}', state: 'running', arguments: {} });
  const runtime = new AgentRuntime({ store, providers: new ProviderRegistry([fixtureProvider(async function* () { yield { type: 'done', reason: 'stop' }; }).provider]), tools: new ToolRegistry([external]), skills: new SkillRegistry(), context: new ContextManager() });
  await runtime.ready();
  assert.equal(executions, 0);
  assert.equal(store.getOperation('op-unresolved')?.state, 'submission_unknown');
  assert.equal(store.getRun(run.id)?.state, 'waiting_user');
  store.close();
});

test('compact persists the context boundary and does not consume a supplemental message that arrives during summarization', async () => {
  let compactStarted!: () => void;
  const started = new Promise<void>((resolve) => { compactStarted = resolve; });
  let releaseCompact!: () => void;
  const compactGate = new Promise<void>((resolve) => { releaseCompact = resolve; });
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const context: ContextManagerLike = {
    estimate: (messages) => messages.length,
    prepare: (state) => state.messages,
    needsCompact: () => false,
    exceedsWindow: () => false,
    compact: async (state) => {
      compactStarted();
      await compactGate;
      return { state: { ...state, messages: [], summary: 'summary', summaryVersion: state.summaryVersion + 1 }, changed: true };
    },
  };
  const fixture = fixtureProvider(async function* () {
    await providerGate;
    yield { type: 'done', reason: 'stop' };
  });
  const store = new SqliteStore();
  const runtime = new AgentRuntime({ store, providers: new ProviderRegistry([fixture.provider]), context, skills: new SkillRegistry() });
  await runtime.ready();
  const session = runtime.createSession({ ownerId: 'alice', canvasId: 'canvas-test', providerId: 'fixture', model: 'fixture' });
  const compacting = runtime.compact(session.id);
  await started;
  const run = await runtime.sendMessage(session.id, { text: 'during compact' });
  const user = store.listMessages(session.id).find((message) => message.role === 'user');
  assert.ok(user);
  releaseCompact();
  await compacting;
  const checkpoint = store.getLatestCheckpoint(session.id);
  assert.equal(checkpoint?.lastMessageOrdinal, 0);
  assert.equal(checkpoint?.state.messages.some((message) => message.id === user?.id), false);
  assert.equal(store.listMessages(session.id).some((message) => message.id === user?.id), true);
  runtime.stopRun(run.id);
  releaseProvider();
  await eventually(() => ['stopped', 'completed', 'partial', 'failed'].includes(store.getRun(run.id)?.state ?? '') ? store.getRun(run.id) : undefined);
  store.close();
});

test('a wait pauses the remaining tool calls durably and approval denial never executes the pending write', async () => {
  let writes = 0;
  const write: ToolDefinition = { name: 'write_after_approval', description: 'write after approval', revision: '1', inputSchema: { type: 'object', additionalProperties: false }, effect: 'write', parallelSafe: false, async execute() { writes += 1; return { content: [{ type: 'text', text: 'written' }] }; } };
  const fixture = fixtureProvider(async function* (request, count) {
    if (count === 1) {
      yield { type: 'tool.call', call: { id: 'ask-approval', name: 'ask_user', arguments: { prompt: '允许写入吗？', kind: 'approval' } } };
      yield { type: 'tool.call', call: { id: 'pending-write', name: 'write_after_approval', arguments: {} } };
      yield { type: 'done', reason: 'tool_calls' };
    } else {
      assert.equal(request.messages.filter((message) => message.role === 'tool').length, 2);
      yield { type: 'text.delta', text: '已按你的决定处理。' };
      yield { type: 'done', reason: 'stop' };
    }
  });
  const store = new SqliteStore();
  const runtime = new AgentRuntime({ store, providers: new ProviderRegistry([fixture.provider]), tools: new ToolRegistry([write]), skills: new SkillRegistry(), context: new ContextManager() });
  await runtime.ready();
  const session = runtime.createSession({ ownerId: 'alice', canvasId: 'canvas-test', providerId: 'fixture', model: 'fixture' });
  const run = await runtime.sendMessage(session.id, { text: '请先问我再写入' });
  const waiting = await eventually(() => store.getRun(run.id)?.state === 'waiting_user' ? store.getRun(run.id) : undefined);
  assert.equal(writes, 0);
  assert.equal(store.listPendingCalls(run.id).map((item) => item.call.id).join(','), 'pending-write');
  assert.equal(store.listEvents(session.id).some((event) => event.type === 'tool.started' && event.data.toolCallId === 'pending-write'), false);
  await runtime.reply(run.id, { text: '拒绝', waitId: waiting.wait!.id, decision: 'deny' });
  const completed = await eventually(() => ['completed', 'failed', 'partial'].includes(store.getRun(run.id)?.state ?? '') ? store.getRun(run.id) : undefined);
  assert.equal(completed.state, 'completed');
  assert.equal(writes, 0);
  assert.equal(store.listPendingCalls(run.id).length, 0);
  assert.ok(store.listMessages(session.id).some((message) => message.callId === 'pending-write'));
  store.close();
});

test('restart restores a wait committed just before the pending-call barrier and never invokes the provider first', async () => {
  let providerCalls = 0;
  let writes = 0;
  const write: ToolDefinition = { name: 'write_after_restart', description: 'write after restart approval', revision: '1', inputSchema: { type: 'object', additionalProperties: false }, effect: 'write', parallelSafe: false, async execute() { writes += 1; return { content: [{ type: 'text', text: 'written' }] }; } };
  const provider: Provider = {
    id: 'fixture', revision: 'fixture-1', capabilities,
    stream(request) {
      providerCalls += 1;
      assert.ok(request.messages.some((message) => message.role === 'tool' && message.callId === 'ask-restart'));
      return (async function* () {
        yield { type: 'text.delta', text: '已恢复。' };
        yield { type: 'done', reason: 'stop' };
      })();
    },
  };
  const store = new SqliteStore();
  const toolRegistry = new ToolRegistry([write]);
  const skillRegistry = new SkillRegistry();
  const session = store.createSession({ id: 'session-restart', ownerId: 'alice', canvasId: 'canvas-test', createdAt: Date.now(), providerId: 'fixture', model: 'fixture' });
  const run = store.createRun({ id: 'run-restart', sessionId: session.id, turnId: 'turn-restart', state: 'running', providerId: 'fixture', model: 'fixture', providerRevision: 'fixture-1', toolRevision: toolRegistry.snapshot().revision, skillRevision: skillRegistry.snapshot().revision, createdAt: Date.now(), updatedAt: Date.now() });
  store.appendMessage({ id: 'assistant-restart', sessionId: session.id, runId: run.id, role: 'assistant', content: [], toolCalls: [
    { id: 'ask-restart', name: 'ask_user', arguments: { prompt: '允许继续吗？', kind: 'approval' } },
    { id: 'write-restart', name: 'write_after_restart', arguments: {} },
  ] });
  const wait = { kind: 'approval' as const, id: 'wait:restart', prompt: '允许继续吗？' };
  const waitResult = { content: [{ type: 'text' as const, text: wait.prompt }], wait };
  store.saveOperation({ operationId: 'op-restart-wait', sessionId: session.id, runId: run.id, callId: 'ask-restart', toolName: 'ask_user', effect: 'read', fingerprint: '{"arguments":{},"name":"ask_user"}', state: 'succeeded', arguments: { prompt: wait.prompt, kind: 'approval' }, result: waitResult });
  const runtime = new AgentRuntime({ store, providers: new ProviderRegistry([provider]), tools: toolRegistry, skills: skillRegistry, context: new ContextManager() });
  await runtime.ready();
  assert.equal(providerCalls, 0);
  assert.equal(store.getRun(run.id)?.state, 'waiting_user');
  assert.deepEqual(store.listPendingCalls(run.id).map((item) => item.call.id), ['write-restart']);
  assert.ok(store.findToolMessage(session.id, run.id, 'ask-restart'));
  await runtime.reply(run.id, { text: '拒绝', waitId: wait.id, decision: 'deny' });
  const completed = await eventually(() => ['completed', 'failed', 'partial'].includes(store.getRun(run.id)?.state ?? '') ? store.getRun(run.id) : undefined);
  assert.equal(completed.state, 'completed');
  assert.equal(providerCalls, 1);
  assert.equal(writes, 0);
  store.close();
});

test('restart reconciliation undefined or thrown blocks the run with an explicit submission_unknown result', async () => {
  for (const mode of ['undefined', 'throw'] as const) {
    let providerCalls = 0;
    let reconciliations = 0;
    const external: ToolDefinition = {
      name: `external_${mode}`,
      description: 'unresolved external',
      revision: '1',
      inputSchema: { type: 'object', additionalProperties: false },
      effect: 'external',
      parallelSafe: false,
      async execute() { throw new Error('must not execute'); },
      reconcile: async () => { reconciliations += 1; if (mode === 'throw') throw new Error('receipt service unavailable'); return undefined; },
    };
    const provider: Provider = {
      id: `recovery-${mode}`,
      revision: '1',
      capabilities,
      async *stream() { providerCalls += 1; yield { type: 'done', reason: 'stop' }; },
    };
    const store = new SqliteStore();
    const tools = new ToolRegistry([external]);
    const skills = new SkillRegistry();
    const session = store.createSession({ id: `session-${mode}`, ownerId: 'alice', canvasId: 'canvas-test', createdAt: Date.now(), providerId: provider.id, model: 'fixture' });
    const run = store.createRun({ id: `run-${mode}`, sessionId: session.id, turnId: `turn-${mode}`, state: 'queued', providerId: provider.id, model: 'fixture', providerRevision: '1', toolRevision: tools.snapshot().revision, skillRevision: skills.snapshot().revision, createdAt: Date.now(), updatedAt: Date.now() });
    const operationId = operationIdFor(run.id, `external-call-${mode}`);
    store.saveOperation({ operationId, sessionId: session.id, runId: run.id, callId: `external-call-${mode}`, toolName: external.name, effect: 'external', fingerprint: stableJsonForTest(external.name), state: 'running', arguments: {} });
    const runtime = new AgentRuntime({ store, providers: new ProviderRegistry([provider]), tools, skills, context: new ContextManager() });
    await runtime.ready();
    assert.equal(providerCalls, 0);
    assert.equal(reconciliations, 1);
    assert.equal(store.getOperation(operationId)?.state, 'submission_unknown');
    assert.equal(store.getRun(run.id)?.state, 'waiting_user');
    assert.ok(store.findToolMessage(session.id, run.id, `external-call-${mode}`));
    assert.ok(store.listEvents(session.id).some((event) => event.type === 'operation.reconciliation_required'));
    store.close();
  }
});

function stableJsonForTest(value: string): string {
  return stableJson({ name: value, arguments: {} });
}

test('a question reply replans pending writes instead of executing arguments chosen before the answer', async () => {
  let writes = 0;
  const write: ToolDefinition = { name: 'choose_color', description: 'choose color', revision: '1', inputSchema: { type: 'object' }, effect: 'write', parallelSafe: false, async execute() { writes++; return { content: [] }; } };
  const fixture = fixtureProvider(async function* (request, count) {
    if (count === 1) {
      yield { type: 'tool.call', call: { id: 'ask', name: 'ask_user', arguments: { prompt: '选蓝色还是红色？' } } };
      yield { type: 'tool.call', call: { id: 'premature-red', name: 'choose_color', arguments: { color: 'red' } } };
      yield { type: 'done', reason: 'tool_calls' };
    } else {
      assert.ok(request.messages.some(m => m.role === 'user' && m.content.some(p => p.type === 'text' && p.text.includes('蓝色'))));
      assert.ok(request.messages.some(m => m.callId === 'premature-red'));
      yield { type: 'done', reason: 'stop' };
    }
  });
  const store = new SqliteStore();
  const runtime = new AgentRuntime({ store, providers: new ProviderRegistry([fixture.provider]), tools: new ToolRegistry([write]), skills: new SkillRegistry() });
  await runtime.ready();
  const session = runtime.createSession({ ownerId: 'alice', canvasId: 'canvas-test' });
  const run = await runtime.sendMessage(session.id, { text: '先问我的颜色偏好' });
  const waiting = await eventually(() => store.getRun(run.id)?.wait);
  await runtime.reply(run.id, { waitId: waiting.id, text: '蓝色' });
  await eventually(() => store.getRun(run.id)?.state === 'completed' ? true : undefined);
  assert.equal(writes, 0);
  store.close();
});
