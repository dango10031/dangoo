import { useEffect, useRef, useState } from 'react'
import { useLatestRef } from '@/hooks/useLatestRef'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { getBasename, pb } from '@/lib/pb'
import { getAuthHeaders } from '@/lib/auth'
import { createHostAgentFetch } from './authFetch'
import type { useCanvas } from '@/pages/Canvas/useCanvas'

type AssetRef = { assetId: string; version: number; role?: 'reference' | 'edit_source' | 'result' }
type MountOptions = {
  baseUrl: string
  canvasId: string
  clientOptions: { fetchImpl: typeof fetch }
  hostBridge: {
    contractVersion: string
    canvasId: string
    getSelection(): { nodeIds: string[]; assets: AssetRef[] }
    beforeSend(): Promise<void>
    locateNode(id: string): void
    previewAsset(ref: AssetRef): void
    onCanvasChanged(revision: number): void
  }
}
type AgentModule = { mountAgentChat(element: HTMLElement, options: MountOptions): (() => void) | { unmount(): void } }

/** The host mounts a separately built UI; it never imports the Agent runtime. */
export function AgentPanel({ vm }: { vm: ReturnType<typeof useCanvas> }) {
  const { id = '' } = useParams()
  const element = useRef<HTMLDivElement>(null)
  const latest = useLatestRef(vm)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [authToken, setAuthToken] = useState(() => pb.authStore.isValid ? pb.authStore.token : '')
  useEffect(() => pb.authStore.onChange(() => {
    setAuthToken(pb.authStore.isValid ? pb.authStore.token : '')
  }, true), [])
  const appBase = getBasename().replace(/\/$/, '')
  const moduleUrl = (import.meta.env.VITE_DANGOO_AGENT_MODULE_URL as string | undefined) || `${appBase}/agent/dangoo-agent-widget.js`
  const baseUrl = (import.meta.env.VITE_DANGOO_AGENT_API_URL as string | undefined) || `${appBase}/agent-api`
  useEffect(() => {
    if (!moduleUrl || !element.current || !id || !authToken) return
    let disposed = false
    let unmount: (() => void) | undefined
    setError(false)
    const start = async () => {
      const url = new URL(moduleUrl, window.location.href)
      // Executable UI modules must be served by this application deployment.
      if (url.origin !== window.location.origin) throw new Error('Agent UI must be same-origin')
      if (new URL(baseUrl, window.location.href).origin !== window.location.origin) throw new Error('Agent API must be same-origin')
      const module = await import(/* @vite-ignore */ url.href) as AgentModule
      if (disposed || !element.current) return
      const mounted = module.mountAgentChat(element.current, {
        baseUrl, canvasId: id,
        clientOptions: {
          fetchImpl: createHostAgentFetch({
            origin: window.location.href,
            isCurrent: () => !disposed && pb.authStore.isValid && pb.authStore.token === authToken,
            getHeaders: getAuthHeaders,
            onUnauthorized: () => { pb.authStore.clear(); latest.current.setAuthDialog('login') },
            fetch: window.fetch.bind(window),
          }),
        },
        hostBridge: {
          contractVersion: '1.0.0', canvasId: id,
          beforeSend: () => {
            if (disposed || !pb.authStore.isValid || pb.authStore.token !== authToken) return Promise.reject(new Error('请先登录'))
            return latest.current.prepareAgentTurn()
          },
          getSelection: () => ({
            nodeIds: [...latest.current.selectedIds],
            assets: latest.current.cards.filter(c => latest.current.selectedIds.includes(c.id)).flatMap(c => {
              const ref = (c as unknown as { assetRef?: AssetRef }).assetRef
              return ref && ref.assetId && Number.isSafeInteger(ref.version) ? [{ ...ref }] : []
            }),
          }),
          locateNode: nodeId => {
            const card = latest.current.cards.find(c => c.id === nodeId)
            if (!card) return
            latest.current.focusAgentNode(nodeId)
            const target = document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(nodeId)}"]`)
            target?.animate([{ outline: '2px solid #c69c59' }, { outline: '2px solid transparent' }], { duration: 900 })
          },
          previewAsset: ref => {
            const card = latest.current.cards.find(c => {
              const own = (c as unknown as { assetRef?: AssetRef }).assetRef
              return own?.assetId === ref.assetId && own.version === ref.version
            })
            if (card) latest.current.handlePreviewCard(card.id)
          },
          onCanvasChanged: revision => { void latest.current.syncAgentRevision(revision).catch(() => toast.error('画布更新读取失败')) },
        },
      })
      unmount = typeof mounted === 'function' ? mounted : () => mounted.unmount()
    }
    void start().catch(() => { if (!disposed) setError(true) })
    return () => { disposed = true; unmount?.() }
  }, [moduleUrl, baseUrl, id, retry, authToken, latest])
  if (!moduleUrl) return null
  return <>
    <div ref={element} />
    {!authToken && <button className="fixed bottom-6 right-6 z-50 rounded-full border bg-background px-4 py-2 text-xs shadow-sm" onClick={() => latest.current.setAuthDialog('login')}>登录后使用 Agent</button>}
    {error && <button className="fixed bottom-6 right-6 z-50 rounded-full border bg-background px-4 py-2 text-xs shadow-sm" onClick={() => setRetry(value => value + 1)}>Agent 加载失败 · 重试</button>}
  </>
}
