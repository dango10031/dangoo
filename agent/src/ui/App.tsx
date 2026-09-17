import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgentClient } from './client';
import { FloatingAgentChat } from './FloatingAgentChat';
import { useLatestRef } from './useLatestRef';
import type { AssetCardData, HostBridge, Selection } from './types';
import { assetKey } from './types';
import './demo.css';

interface DemoNode {
  id: string;
  title: string;
  subtitle: string;
  kind: 'image' | 'type' | 'palette';
  real?: boolean;
  prompt?: string;
  asset?: AssetCardData;
}

const DEMO_ASSETS: AssetCardData[] = [
  { ref: { assetId: 'demo-product-01', version: 2, role: 'reference' }, name: '产品原图', kind: 'image', source: '本画布', status: 'ready' },
  { ref: { assetId: 'demo-palette-01', version: 1, role: 'reference' }, name: '暖沙色板', kind: 'image', source: '本画布', status: 'ready' },
];

const DEMO_NODES: DemoNode[] = [
  { id: 'node-product', title: '产品原图', subtitle: '参考素材 · v2', kind: 'image', asset: DEMO_ASSETS[0] },
  { id: 'node-direction', title: '春季视觉方向', subtitle: '文案与构图提示', kind: 'type' },
  { id: 'node-palette', title: '暖沙色板', subtitle: '配色参考 · v1', kind: 'palette', asset: DEMO_ASSETS[1] },
];

interface ServiceState {
  state: 'checking' | 'ready' | 'unavailable' | 'unconfigured';
  providerId?: string;
  providerName?: string;
  model?: string;
  message?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readServiceConfig(value: unknown): { providerId?: string; providerName?: string; model?: string; configured?: boolean } {
  const source = record(value);
  const provider = record(source.provider ?? source.providerConfig);
  const providers = Array.isArray(source.providers) ? source.providers : [];
  const firstProvider = record(providers[0]);
  const providerId = typeof source.providerId === 'string' ? source.providerId : typeof provider.id === 'string' ? provider.id : typeof firstProvider.id === 'string' ? firstProvider.id : undefined;
  const providerName = typeof source.providerName === 'string' ? source.providerName : typeof provider.name === 'string' ? provider.name : typeof firstProvider.name === 'string' ? firstProvider.name : providerId;
  const model = typeof source.model === 'string' ? source.model : typeof provider.model === 'string' ? provider.model : typeof firstProvider.model === 'string' ? firstProvider.model : undefined;
  const configured = typeof source.configured === 'boolean' ? source.configured : typeof source.ready === 'boolean' ? source.ready : undefined;
  return { providerId, providerName, model, configured };
}

function readCanvasNodes(value: unknown): DemoNode[] {
  const source = record(value);
  const raw = Array.isArray(source.nodes) ? source.nodes : Array.isArray(record(source.snapshot).nodes) ? record(source.snapshot).nodes as unknown[] : [];
  return raw.flatMap((item, index): DemoNode[] => {
    const node = record(item);
    if (typeof node.id !== 'string' || !node.id) return [];
    const data = record(node.data);
    const kindValue = node.kind ?? data.kind;
    const kind: DemoNode['kind'] = kindValue === 'type' || kindValue === 'text' || kindValue === 'prompt' ? 'type' : kindValue === 'palette' ? 'palette' : index % 3 === 1 ? 'type' : index % 3 === 2 ? 'palette' : 'image';
    const fallback = DEMO_NODES[index % DEMO_NODES.length]!;
    const prompt = typeof data.prompt === 'string' ? data.prompt : undefined;
    const title = typeof data.title === 'string' ? data.title : typeof data.name === 'string' ? data.name : typeof data.label === 'string' ? data.label : prompt ?? fallback.title;
    const subtitle = typeof data.subtitle === 'string' ? data.subtitle : prompt && prompt !== title ? prompt : `画布节点 · ${String(kind).toUpperCase()}`;
    return [{ id: node.id, title, subtitle, kind, real: true, prompt }];
  });
}

function DemoArtwork({ node, selected }: { node: DemoNode; selected: boolean }) {
  return <button type="button" className={`demo-node demo-node--${node.kind}${selected ? ' demo-node--selected' : ''}`}>
    <span className="demo-node__top"><span className="demo-node__handle" /><span>{node.kind === 'image' ? 'IMAGE' : node.kind === 'type' ? 'TEXT' : 'PALETTE'}</span><span className="demo-node__menu">•••</span></span>
    {node.real ? <span className="demo-real-art"><small>{node.kind === 'type' ? 'PROMPT NODE' : 'CANVAS NODE'}</small><strong>{node.kind === 'type' ? node.prompt ?? node.title : node.title}</strong></span> : <span className="demo-node__art">
      {node.kind === 'image' ? <svg viewBox="0 0 240 145" role="img" aria-label="演示产品构图"><defs><linearGradient id="demo-sky" x1="0" x2="1"><stop offset="0" stopColor="#d6c2a1" /><stop offset="1" stopColor="#f3e6d2" /></linearGradient><linearGradient id="demo-box" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#a97f53" /><stop offset="1" stopColor="#624b3c" /></linearGradient></defs><rect width="240" height="145" fill="url(#demo-sky)" /><circle cx="190" cy="34" r="25" fill="#f8e3bd" opacity=".6" /><ellipse cx="115" cy="119" rx="73" ry="12" fill="#685448" opacity=".26" /><path d="M67 99 72 47l80-13 15 58-50 18Z" fill="url(#demo-box)" /><path d="m72 47 49 18 31-31" fill="#d0a67a" opacity=".74" /><path d="m121 65-4 45" stroke="#f2d6ad" strokeWidth="2" opacity=".72" /><path d="M95 54c8 5 20 8 30 11" stroke="#fff1d7" strokeWidth="2" opacity=".8" /><path d="M32 113c21-7 38-9 57-8" stroke="#f8efe1" strokeWidth="7" opacity=".48" /></svg> : node.kind === 'type' ? <span className="demo-type-art"><em>quiet</em><strong>FORM<br />&amp; LIGHT</strong><small>spring study / 04</small></span> : <span className="demo-palette-art"><i /><i /><i /><i /><i /></span>}
    </span>}
    <span className="demo-node__copy"><strong>{node.title}</strong><small>{node.subtitle}</small></span>
  </button>;
}

function ServiceDot({ state }: { state: ServiceState['state'] }) {
  return <span className={`demo-service-dot demo-service-dot--${state}`} aria-hidden="true" />;
}

export function App() {
  const client = useMemo(() => new AgentClient({ baseUrl: '/api' }), []);
  const [service, setService] = useState<ServiceState>({ state: 'checking' });
  const [canvasNodes, setCanvasNodes] = useState<DemoNode[]>([]);
  const [canvasRevision, setCanvasRevision] = useState<number>();
  const [selectedNodeId, setSelectedNodeId] = useState('node-product');
  const [locatedNodeId, setLocatedNodeId] = useState<string>();
  const [previewAsset, setPreviewAsset] = useState<AssetCardData>();
  const [agentOpen, setAgentOpen] = useState(true);
  const selectedRef = useLatestRef(selectedNodeId);
  const canvasNodesRef = useLatestRef(canvasNodes);
  const canvasRevisionRef = useLatestRef(canvasRevision);

  const refreshCanvas = useCallback(async () => {
    try {
      const canvasSnapshot = await client.getCanvas('demo-canvas');
      const loadedNodes = readCanvasNodes(canvasSnapshot);
      setCanvasNodes(loadedNodes);
      const revision = record(canvasSnapshot).revision;
      if (typeof revision === 'number') setCanvasRevision(revision);
      setSelectedNodeId((current) => loadedNodes.some((node) => node.id === current) || !loadedNodes.length ? current : loadedNodes[0]!.id);
    } catch {
      // Keep the last known canvas while a transient refresh fails.
    }
  }, [client]);
  const refreshCanvasRef = useLatestRef(refreshCanvas);

  const refreshService = useCallback(async () => {
    setService((current) => ({ ...current, state: 'checking', message: undefined }));
    try {
      const [health, capabilities] = await Promise.all([client.health(), client.capabilities()]);
      const healthConfig = readServiceConfig(health);
      const capabilityConfig = readServiceConfig(capabilities);
      const configured = healthConfig.configured ?? capabilityConfig.configured ?? true;
      setService({
        state: configured ? 'ready' : 'unconfigured',
        providerId: capabilityConfig.providerId ?? healthConfig.providerId,
        providerName: capabilityConfig.providerName ?? healthConfig.providerName,
        model: capabilityConfig.model ?? healthConfig.model,
        message: configured ? undefined : 'Agent 服务待配置',
      });
      await refreshCanvas();
    } catch (error) {
      if (import.meta.env.DEV) console.error('[Dangoo Agent] service check failed', error instanceof Error ? error.message : String(error));
      setService({ state: 'unavailable', message: error instanceof Error ? error.message : 'Agent 服务不可用' });
    }
  }, [client, refreshCanvas]);

  useEffect(() => { void Promise.resolve().then(refreshService); }, [refreshService]);
  useEffect(() => {
    if (!locatedNodeId) return;
    const timer = window.setTimeout(() => setLocatedNodeId(undefined), 1200);
    return () => window.clearTimeout(timer);
  }, [locatedNodeId]);

  const hostBridge = useMemo<HostBridge>(() => ({
    contractVersion: '1.0.0',
    canvasId: 'demo-canvas',
    getSelection: (): Selection => {
      const node = canvasNodesRef.current.find((item) => item.id === selectedRef.current);
      // The SVG cards are deterministic demo material. They are deliberately not
      // sent as asset refs until the host has registered a real AssetRecord.
      return { nodeIds: node ? [node.id] : [], assets: [], revision: canvasRevisionRef.current };
    },
    locateNode: (nodeId) => {
      setSelectedNodeId(nodeId);
      setLocatedNodeId(nodeId);
    },
    previewAsset: (ref) => {
      const asset = DEMO_ASSETS.find((item) => assetKey(item.ref) === assetKey(ref));
      if (asset) setPreviewAsset(asset);
    },
    onCanvasChanged: () => { void refreshCanvasRef.current(); },
  }), [selectedRef, canvasNodesRef, canvasRevisionRef, refreshCanvasRef]);

  const displayNodes = canvasNodes.length ? canvasNodes : DEMO_NODES;

  return <main className="demo-app">
    <header className="demo-topbar"><div className="demo-wordmark"><span className="demo-wordmark__mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 13.6 9l5.6 2-5.6 2L12 19.2 10.4 13 4.8 11l5.6-2L12 2.8Z" /></svg></span><span>DANGOO</span><small>CANVAS</small></div><nav className="demo-nav"><button type="button">画布</button><button type="button">资产</button><button type="button" className="demo-nav__active">Agent</button></nav><div className="demo-topbar__right"><span className="demo-user-dot" />Chen · 创作空间</div></header>
    <section className="demo-workspace">
      <aside className="demo-sidebar"><div className="demo-sidebar__head"><span>作品集</span><button type="button" aria-label="新增作品">＋</button></div><div className="demo-project demo-project--active"><span className="demo-project__thumb" /><div><strong>春季产品视觉</strong><small>刚刚编辑</small></div><span className="demo-project__dots">•••</span></div><div className="demo-sidebar__group">最近使用</div><div className="demo-project"><span className="demo-project__thumb demo-project__thumb--rose" /><div><strong>光的练习 · 04</strong><small>昨天</small></div></div><div className="demo-project"><span className="demo-project__thumb demo-project__thumb--blue" /><div><strong>包装静物研究</strong><small>周一</small></div></div><div className="demo-sidebar__bottom"><span className="demo-avatar">C</span><span>个人空间</span><button type="button" aria-label="更多设置">•••</button></div></aside>
      <section className="demo-canvas-shell"><div className="demo-canvas-toolbar"><div><span className="demo-breadcrumb">作品集 / 春季产品视觉</span><h1>春季产品视觉</h1></div><div className="demo-canvas-actions"><span className="demo-save-state"><ServiceDot state={service.state} />{service.state === 'ready' ? '已连接' : service.state === 'checking' ? '连接中' : '待连接'}</span><button type="button" className="demo-action-button" onClick={() => setAgentOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 13.6 9l5.6 2-5.6 2L12 19.2 10.4 13 4.8 11l5.6-2L12 2.8Z" /></svg>Agent</button><button type="button" className="demo-icon-action" aria-label="更多画布操作">•••</button></div></div><div className="demo-canvas"><div className="demo-canvas__grid" />{canvasNodes.length ? null : <div className="demo-canvas__note"><span>SPRING STUDY</span><strong>Material / warmth</strong><small>{displayNodes.length} nodes · 演示素材</small></div>}{canvasNodes.length ? null : <><div className="demo-connector demo-connector--one" /><div className="demo-connector demo-connector--two" /></>}{displayNodes.map((node, index) => <div key={node.id} className={`demo-node-wrap demo-node-wrap--${index === 0 ? 'node-product' : index === 1 ? 'node-direction' : 'node-palette'}${locatedNodeId === node.id ? ' demo-node-wrap--located' : ''}`} onClick={() => setSelectedNodeId(node.id)}><DemoArtwork node={node} selected={selectedNodeId === node.id} /></div>)}<div className="demo-canvas__label">{canvasNodes.length ? '当前画布节点' : '演示画布 · 素材仅用于交互展示'}</div></div><div className="demo-canvas-footer"><span><span className="demo-key">⌘</span> 点击节点查看引用</span><span>100%</span><span>画布修订 {canvasNodes.length ? canvasRevision ?? '—' : '演示'}</span></div></section>
      <aside className="demo-asset-rail"><div className="demo-asset-rail__head"><div><span className="demo-breadcrumb">当前画布</span><h2>资产</h2></div><button type="button" aria-label="关闭资产面板">×</button></div><div className="demo-asset-filter"><span>本画布产出</span><button type="button">筛选 <span>⌄</span></button></div><div className="demo-asset-hero"><div className="demo-asset-hero__art"><div className="demo-asset-hero__orb" /><div className="demo-asset-hero__box" /></div><strong>产品原图</strong><small>参考素材 · v2</small><button type="button" onClick={() => setSelectedNodeId('node-product')}>选中引用</button></div><div className="demo-asset-rail__section"><span>色彩参考</span><div className="demo-swatch-row"><i /><i /><i /><i /><i /></div></div><div className="demo-asset-rail__footer"><span>资产库</span><button type="button">打开资产库 <span>↗</span></button></div></aside>
    </section>
    <FloatingAgentChat client={client} hostBridge={hostBridge} canvasId="demo-canvas" avoidRight={220} defaultOpen={agentOpen} open={agentOpen} onOpenChange={setAgentOpen} serviceConfigured={service.state === 'ready'} serviceState={service.state} serviceConfig={{ providerId: service.providerId, providerName: service.providerName, model: service.model }} />
    {previewAsset ? <div className="demo-preview-backdrop" role="presentation" onClick={() => setPreviewAsset(undefined)}><section className="demo-preview" role="dialog" aria-modal="true" aria-label="资产预览" onClick={(event) => event.stopPropagation()}><button type="button" className="demo-preview__close" onClick={() => setPreviewAsset(undefined)} aria-label="关闭预览">×</button><div className="demo-preview__art"><div className="demo-preview__orb" /><div className="demo-preview__box" /></div><strong>{previewAsset.name}</strong><small>{previewAsset.ref.assetId} · v{previewAsset.ref.version}</small></section></div> : null}
  </main>;
}

export default App;
