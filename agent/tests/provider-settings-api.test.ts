import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRuntime } from '../src/core/runtime.js';
import { SqliteStore } from '../src/core/store.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { ProviderRegistry } from '../src/providers/index.js';
import { ProviderSettingsManager } from '../src/server/provider-settings.js';
import { createAgentServer } from '../src/server/server.js';
import type { Provider, ProviderEvent, ProviderRequest } from '../src/contracts/index.js';

test('provider settings API protects owner, origins and secrets; new turns use saved configuration', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-settings-http-'));
  const store = new SqliteStore();
  const registry = new ProviderRegistry();
  const platformProvider = {
    id: 'dangoo-platform', revision: 'platform', listPlatformModels: () => ['old-model', 'new-model'],
    capabilities: () => ({ contextWindow: 16000, maxOutputTokens: 500, tools: true, vision: false, parallelTools: true }),
    stream: async function* (): AsyncGenerator<ProviderEvent> { yield { type: 'done', reason: 'stop' }; },
  } as Provider;
  const settings = new ProviderSettingsManager(join(directory, 'provider.json'), {
    providerId: 'dangoo-platform', model: 'old-model',
  }, registry, platformProvider);
  const requests: Array<{ model: string; providerModel: string }> = [];
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(settings, 'provider', (candidate?: { providerId: string; model: string }): Provider => {
    const config = candidate ?? settings.read();
    return {
      id: config.providerId, revision: `revision-${config.model}`,
      capabilities: () => ({ contextWindow: 16000, maxOutputTokens: 500, tools: true, vision: false, parallelTools: true }),
      stream: async function* (request: ProviderRequest): AsyncGenerator<ProviderEvent> {
        requests.push({ model: request.model, providerModel: config.model });
        if (config.model === 'old-model') await blocked;
        yield { type: 'text.delta', text: 'Done' };
        yield { type: 'done', reason: 'stop' };
      },
    };
  });
  const runtime = new AgentRuntime({ store, providers: registry, tools: new ToolRegistry() });
  await runtime.ready();
  const server = createAgentServer(runtime, {
    tokens: { owner: { ownerId: 'alice' }, other: { ownerId: 'bob' } },
    defaultPrincipal: { ownerId: 'alice' }, providerSettings: settings, configured: () => settings.configured,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, body?: unknown, token = 'owner', origin?: string) => fetch(`${base}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await request('settings/provider', undefined, 'other')).status, 403);
    assert.equal((await request('settings/provider', { apiKey: 'stolen' }, 'other')).status, 403);
    assert.equal((await request('settings/provider', { apiKey: 'stolen' }, 'owner', 'https://evil.example')).status, 403);
    assert.equal((await fetch(`${base}/api/settings/provider`)).status, 401);
    const saved = await request('settings/provider', { providerId: 'dangoo-platform', model: 'old-model', baseUrl: 'https://provider.example/v1' }, 'owner', base);
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get('cache-control'), 'no-store');
    assert.equal(saved.headers.get('access-control-allow-origin'), base);
    const savedBody = await saved.text();
    assert.equal(savedBody.includes('fixture-secret'), false);
    assert.equal(JSON.parse(savedBody).configured, true);
    assert.deepEqual(JSON.parse(savedBody).platformModels, ['old-model', 'new-model']);
    const legacyEndpoint = await request('settings/provider', { baseUrl: 'https://evil.example/v1' });
    assert.equal(legacyEndpoint.status, 200);
    assert.equal(settings.read().model, 'old-model');
    assert.equal((await (await fetch(`${base}/health`)).json() as { configured: boolean }).configured, true);
    const created = await request('sessions', { canvasId: 'canvas' });
    assert.equal(created.status, 201);
    const { session } = await created.json() as { session: { id: string } };
    const first = await request(`sessions/${session.id}/messages`, { text: 'first', requestId: 'first' });
    assert.equal(first.status, 202);
    const firstRun = (await first.json() as { run: { id: string } }).run;
    const firstSnapshot = store.getRunSnapshot(firstRun.id);
    assert.equal(JSON.stringify(firstSnapshot).includes('fixture-secret'), false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, [{ model: 'old-model', providerModel: 'old-model' }]);
    assert.equal((await request('settings/provider', { model: 'new-model' })).status, 200);
    assert.equal(runtime.getSession(session.id).model, 'old-model');
    assert.deepEqual(store.getRunSnapshot(firstRun.id), firstSnapshot);
    release!();
    for (let attempt = 0; attempt < 100 && store.getActiveRun(session.id); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(store.getActiveRun(session.id), undefined);
    const second = await request(`sessions/${session.id}/messages`, { text: 'second', requestId: 'second' });
    assert.equal(second.status, 202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, [
      { model: 'old-model', providerModel: 'old-model' },
      { model: 'new-model', providerModel: 'new-model' },
    ]);
    assert.equal(runtime.getSession(session.id).model, 'new-model');
    assert.equal(JSON.stringify(runtime.getSessionState(session.id)).includes('fixture-secret'), false);
  } finally {
    release!();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
