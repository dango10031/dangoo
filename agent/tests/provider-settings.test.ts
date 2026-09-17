import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '../src/providers/index.js';
import { ProviderSettingsManager } from '../src/server/provider-settings.js';

test('provider settings persist privately, redact reads and retain immutable running snapshots', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-settings-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'provider.json');
  const defaults = { providerId: 'glm', model: 'glm-5.3-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '' };
  const registry = new ProviderRegistry();
  const settings = new ProviderSettingsManager(file, defaults, registry);
  settings.save({ apiKey: 'fixture-private-key' });
  const snapshot = registry.snapshot();
  const previous = snapshot.get('glm');
  assert.equal(settings.read().hasKey, true);
  assert.equal(JSON.stringify(settings.read()).includes('fixture-private-key'), false);
  settings.save({ model: 'next-model' });
  assert.equal(snapshot.get('glm'), previous);
  assert.notEqual(registry.get('glm'), previous);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).apiKey, 'fixture-private-key');
  assert.throws(() => settings.save({ baseUrl: 'https://different.example/v1' }), /重新填写/);
  assert.throws(() => settings.save({ baseUrl: 'http://different.example', apiKey: 'new' }), /HTTPS/);
  const restored = new ProviderSettingsManager(file, defaults, new ProviderRegistry());
  assert.equal(restored.read().model, 'next-model');
  assert.equal(restored.configured, true);
  settings.save({ baseUrl: 'https://different.example/v1', apiKey: 'replacement-key' });
  const moved = new ProviderSettingsManager(file, defaults, new ProviderRegistry());
  assert.equal(moved.read().baseUrl, 'https://different.example/v1');
  assert.equal(JSON.stringify(moved.provider()).includes('replacement-key'), false);
});

if (process.platform !== 'win32') {
  test('provider settings file permissions are private on POSIX', (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-settings-permissions-'));
    t.after(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const file = join(directory, 'provider.json');
    const defaults = { providerId: 'glm', model: 'glm-5.3-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '' };
    const settings = new ProviderSettingsManager(file, defaults, new ProviderRegistry());
    settings.save({ apiKey: 'fixture-private-key' });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    chmodSync(file, 0o644);
    const moved = new ProviderSettingsManager(file, defaults, new ProviderRegistry());
    assert.equal(moved.read().hasKey, true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
}

test('connection failures redact provider errors and testing does not persist candidate settings', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-settings-test-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const registry = new ProviderRegistry();
  const settings = new ProviderSettingsManager(join(directory, 'provider.json'), {
    providerId: 'glm', model: 'old-model', baseUrl: 'https://provider.example/v1', apiKey: 'fixture-secret',
  }, registry);
  const initial = settings.read();
  t.mock.method(settings, 'provider', () => ({
    stream: async function* () {
      yield { type: 'done', reason: 'stop' };
      throw new Error('upstream echoed fixture-secret');
    },
  }));
  await assert.rejects(settings.test({ model: 'candidate' }), (error: Error) => {
    assert.match(error.message, /连接测试失败/);
    assert.equal(error.message.includes('fixture-secret'), false);
    return true;
  });
  assert.deepEqual(settings.read(), initial);
  assert.deepEqual(registry.list(), []);
  await assert.rejects(settings.test({ baseUrl: 'https://other.example/v1' }), /重新填写/);
  await assert.rejects(settings.test({ baseUrl: 'https://name:password@provider.example/v1', apiKey: 'replacement' }), /HTTPS/);
});
