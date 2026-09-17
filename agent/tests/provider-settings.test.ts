import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '../src/contracts/index.js';
import { ProviderRegistry } from '../src/providers/index.js';
import { ProviderSettingsManager } from '../src/server/provider-settings.js';

const platformProvider = {
  id: 'dangoo-platform',
  revision: 'platform',
  capabilities: () => ({ contextWindow: 16000, maxOutputTokens: 500, tools: true, vision: false, parallelTools: true }),
  stream: async function* () { yield { type: 'done', reason: 'stop' }; },
  listPlatformModels: () => ['next-model'],
} as Provider;

test('provider settings persist only platform model selection and redact secrets', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-settings-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, 'provider.json');
  const defaults = { providerId: 'dangoo-platform' as const, model: 'next-model' };
  const settings = new ProviderSettingsManager(file, defaults, new ProviderRegistry(), platformProvider);
  assert.deepEqual(settings.read().platformModels, ['next-model']);
  settings.save({ providerId: 'dangoo-platform', model: 'next-model' });
  assert.equal(settings.read().configured, true);
  assert.throws(() => settings.save({ providerId: 'glm', model: 'next-model' }), /仅支持/);
  settings.save({ model: 'next-model' });
  assert.equal(settings.read().model, 'next-model');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).providerId, 'dangoo-platform');
});

if (process.platform !== 'win32') {
  test('provider settings file permissions are private on POSIX', (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-settings-permissions-'));
    t.after(async () => {
      await rm(directory, { recursive: true, force: true });
    });
    const file = join(directory, 'provider.json');
    const settings = new ProviderSettingsManager(file, {
      providerId: 'dangoo-platform', model: 'next-model',
    }, new ProviderRegistry(), platformProvider);
    settings.save({ providerId: 'dangoo-platform', model: 'next-model' });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    chmodSync(file, 0o644);
    const moved = new ProviderSettingsManager(file, {
      providerId: 'dangoo-platform', model: 'next-model',
    }, new ProviderRegistry(), platformProvider);
    assert.equal(moved.read().model, 'next-model');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
}
