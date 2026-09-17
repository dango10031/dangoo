import { useEffect, useState } from 'react';
import type { AgentClientLike, ProviderSettingsView } from './types';

export function ProviderSettings({ client, onSaved, onClose }: { client: AgentClientLike; onSaved(value: ProviderSettingsView): void; onClose(): void }) {
  const [value, setValue] = useState<ProviderSettingsView>();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'test' | 'save'>();
  const [notice, setNotice] = useState('');
  const unsupported = !client.providerSettings;
  useEffect(() => {
    let active = true;
    if (!client.providerSettings) return;
    void client.providerSettings().then(result => { if (active) setValue(result); }).catch(() => { if (active) setNotice('配置读取失败'); });
    return () => { active = false; };
  }, [client]);
  const submit = async (mode: 'test' | 'save') => {
    if (!value) return;
    setBusy(mode); setNotice('');
    const input = { providerId: value.providerId, model: value.model, baseUrl: value.baseUrl, apiKey: key || undefined };
    try {
      if (mode === 'test') { await client.testProviderSettings!(input); setNotice('连接成功'); }
      else { const saved = await client.saveProviderSettings!(input); setValue(saved); setKey(''); onSaved(saved); setNotice('已保存'); }
    } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(undefined); }
  };
  return <section className="agent-popover agent-settings" aria-label="Agent 设置">
    <div className="agent-popover__head"><strong>模型配置</strong><button type="button" className="agent-text-button" onClick={onClose}>完成</button></div>
    {value && <form className="agent-settings-form" onSubmit={event => { event.preventDefault(); void submit('save'); }}>
      <label>Provider<input value={value.providerId} disabled={!!busy} onChange={event => setValue({ ...value, providerId: event.target.value })} /></label>
      <label>模型<input value={value.model} disabled={!!busy} onChange={event => setValue({ ...value, model: event.target.value })} /></label>
      <label>API 地址<input type="url" value={value.baseUrl} disabled={!!busy} onChange={event => setValue({ ...value, baseUrl: event.target.value })} /></label>
      <label>API 密钥<input type="password" autoComplete="new-password" value={key} placeholder={value.hasKey ? '已配置 · 输入以更换' : '填写密钥'} disabled={!!busy} onChange={event => setKey(event.target.value)} /></label>
      <div className="agent-wait-actions"><button type="button" className="agent-button" disabled={!!busy} onClick={() => void submit('test')}>{busy === 'test' ? '测试中' : '测试连接'}</button><button type="submit" className="agent-button agent-button--primary" disabled={!!busy}>{busy === 'save' ? '保存中' : '保存'}</button></div>
    </form>}
    {(unsupported || notice) && <p role="status" className="agent-setting-note">{unsupported ? '当前服务不支持配置' : notice}</p>}
  </section>;
}
