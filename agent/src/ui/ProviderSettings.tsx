import { useEffect, useState } from 'react';
import type { AgentClientLike, ProviderSettingsInput, ProviderSettingsView } from './types';

export function ProviderSettings({ client, onSaved, onClose }: { client: AgentClientLike; onSaved(value: ProviderSettingsView): void; onClose(): void }) {
  const [value, setValue] = useState<ProviderSettingsView>();
  const [busy, setBusy] = useState<'save'>();
  const [notice, setNotice] = useState('');
  const unsupported = !client.providerSettings;
  useEffect(() => {
    let active = true;
    if (!client.providerSettings) return;
    void client.providerSettings().then(result => { if (active) setValue(result); }).catch(() => { if (active) setNotice('配置读取失败'); });
    return () => { active = false; };
  }, [client]);
  const submit = async (mode: 'save') => {
    if (!value) return;
    setBusy(mode); setNotice('');
    const input: ProviderSettingsInput = { providerId: 'dangoo-platform', model: value.model };
    try {
      const saved = await client.saveProviderSettings!(input);
      setValue(saved); onSaved(saved); setNotice('已保存');
    } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(undefined); }
  };
  return <section className="agent-popover agent-settings" aria-label="Agent 设置">
    <div className="agent-popover__head"><strong>模型配置</strong><button type="button" className="agent-text-button" onClick={onClose}>完成</button></div>
    {value && <form className="agent-settings-form" onSubmit={event => { event.preventDefault(); void submit('save'); }}>
      <label>模型
        <select value={value.model} disabled={!!busy || !value.platformModels?.length} onChange={event => setValue({ ...value, model: event.target.value })}>
          {(value.platformModels ?? []).map(model => <option key={model} value={model}>{model}</option>)}
        </select>
      </label>
      {!value.platformModels?.length && <p className="agent-setting-note">平台模型不可用</p>}
      <div className="agent-wait-actions"><button type="submit" className="agent-button agent-button--primary" disabled={!!busy || !value.platformModels?.length}>{busy === 'save' ? '保存中' : '保存'}</button></div>
    </form>}
    {(unsupported || notice) && <p role="status" className="agent-setting-note">{unsupported ? '当前服务不支持配置' : notice}</p>}
  </section>;
}
