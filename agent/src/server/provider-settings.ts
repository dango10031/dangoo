import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ProviderRegistry } from '../providers/index.js';
import type { Provider } from '../contracts/index.js';

export interface ProviderSettings {
  providerId: 'dangoo-platform';
  model: string;
}

export class ProviderSettingsManager {
  private current: ProviderSettings;
  constructor(private path: string, defaults: ProviderSettings, private registry: ProviderRegistry, private platformProvider?: Provider) {
    if (!existsSync(path)) {
      this.current = defaults;
      return;
    }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (!this.platformProvider) {
      this.current = defaults;
    } else {
      const model = typeof raw.model === 'string' ? raw.model : defaults.model;
      const allowed = this.platformProvider.listPlatformModels?.() ?? [];
      this.current = this.validate({ providerId: 'dangoo-platform', model: allowed.includes(model) ? model : defaults.model }, defaults);
    }
    if ('baseUrl' in raw || 'apiKey' in raw) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.current), { mode: 0o600 });
      renameSync(temporary, path);
    }
    if (existsSync(path)) chmodSync(path, 0o600);
  }
  get configured() {
    return Boolean(this.platformProvider) && this.current.model.length > 0
      && (this.platformProvider?.listPlatformModels?.() ?? []).includes(this.current.model);
  }
  read() {
    return { ...this.current, configured: this.configured, platformModels: this.platformProvider?.listPlatformModels?.() ?? [] };
  }
  provider() {
    if (!this.platformProvider) throw new Error('平台模型不可用');
    return this.platformProvider;
  }
  private validate(input: Record<string, unknown>, prior = this.current): ProviderSettings {
    const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : prior.providerId;
    if (!this.platformProvider || providerId !== 'dangoo-platform') throw new Error('仅支持 Dangoo 平台模型');
    const model = typeof input.model === 'string' ? input.model.trim() : prior.model;
    const models = this.platformProvider.listPlatformModels?.() ?? [];
    if (!models.length) throw new Error('平台模型不可用');
    if (!models.includes(model)) throw new Error('请选择平台模型');
    return { providerId: 'dangoo-platform', model };
  }
  save(input: Record<string, unknown>) {
    const next = this.validate(input);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.current = next;
    this.registry.upsert(this.provider());
    return this.read();
  }
}
