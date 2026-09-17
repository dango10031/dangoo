import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useStore } from 'zustand'
import { toast } from 'sonner'
import { getAuthHeaders } from '@/lib/auth'
import {
  clearLocalSnapshot,
  deleteStaleSnapshot,
  listStaleSnapshots,
  putConflictBackup,
  putLocalSnapshot,
  takeConflictBackup,
  type LocalCanvasSnapshot,
} from '@/lib/canvasLocalSnapshot'
import { onCanvasMessage, postCanvasMessage } from '@/lib/canvasBroadcast'
import { acquireCloudSlot, tryAcquireCloudSlot } from '@/lib/cloudSaveQueue'
import { getMediaUploadInflight } from '@/lib/media'
import { getPocketBaseUrl } from '@/lib/pb'
import type { CanvasCardData, CanvasDoc, PendingJobRecord } from './canvasTypes'
import type { CanvasDocumentStore } from './canvasDocumentStore'

const CANVASES_API = `${getPocketBaseUrl()}/api/canvases`
const RETRY_BACKOFF_MS = [1000, 3000, 10000, 30000, 60000]
const KEEPALIVE_BODY_LIMIT = 60_000

export type CanvasSaveState = 'idle' | 'editing' | 'local' | 'saving' | 'saved' | 'error' | 'conflict'
export type SaveConflictValue = { canvasId: string; serverRev: number } | null
export type LocalRestoreValue = {
  canvasId: string
  snapshot: LocalCanvasSnapshot
  originSessionId: string
  differsFromCloud: boolean
} | null

interface UseCanvasSaveOptions {
  canvasId?: string
  documentStore: CanvasDocumentStore
  lastCanvasIdRef: MutableRefObject<string | null>
  sessionTokenRef: MutableRefObject<number>
  suppressContentSaveRef: MutableRefObject<number>
  suppressViewSaveRef: MutableRefObject<number>
  buildPersistCards: (cards: CanvasCardData[]) => CanvasCardData[]
  applyServerDoc: (
    rec: { title?: string; canvas_data?: unknown },
    id: string,
    sessionToken: number,
    opts?: { suppressSave?: boolean },
  ) => { docCards: CanvasCardData[]; pending: PendingJobRecord[] }
  resumeRestoredJobs: (cards: CanvasCardData[], pending: PendingJobRecord[], sessionToken: number) => void
  setDocLoaded: Dispatch<SetStateAction<boolean>>
  setAuthDialog: Dispatch<SetStateAction<null | 'login' | 'recharge'>>
}

function cyrb53Hex(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

function currentSessionId(): string {
  try {
    const key = 'rh-canvas-session'
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const id = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

export function useCanvasSave({
  canvasId,
  documentStore,
  lastCanvasIdRef,
  sessionTokenRef,
  suppressContentSaveRef,
  suppressViewSaveRef,
  buildPersistCards,
  applyServerDoc,
  resumeRestoredJobs,
  setDocLoaded,
  setAuthDialog,
}: UseCanvasSaveOptions) {
  const docLoaded = useStore(documentStore, state => state.docLoaded)
  const cards = useStore(documentStore, state => state.cards)
  const connections = useStore(documentStore, state => state.connections)
  const viewport = useStore(documentStore, state => state.viewport)
  const canvasTitle = useStore(documentStore, state => state.canvasTitle)
  const pendingJobs = useStore(documentStore, state => state.pendingJobs)
  const genLogs = useStore(documentStore, state => state.genLogs)
  const projectAssets = useStore(documentStore, state => state.projectAssets)
  const [saveState, setSaveState] = useState<CanvasSaveState>('idle')
  const saveConflictRef = useRef<SaveConflictValue>(null)
  const [saveConflict, setSaveConflictState] = useState<SaveConflictValue>(null)
  const setSaveConflict = (value: SaveConflictValue | ((previous: SaveConflictValue) => SaveConflictValue)) => {
    setSaveConflictState(previous => {
      const next = typeof value === 'function' ? value(previous) : value
      saveConflictRef.current = next
      return next
    })
  }
  const [browserSessionId] = useState(() => currentSessionId())
  const [localRestore, setLocalRestoreState] = useState<LocalRestoreValue>(null)
  const localRestoreRef = useRef<LocalRestoreValue>(null)
  const setLocalRestore = (value: LocalRestoreValue | ((previous: LocalRestoreValue) => LocalRestoreValue)) => {
    setLocalRestoreState(previous => {
      const next = typeof value === 'function' ? value(previous) : value
      localRestoreRef.current = next
      return next
    })
  }
  const cloudPendingAtRestoreRef = useRef<PendingJobRecord[]>([])
  const [conflictBackupAvailable, setConflictBackupAvailable] = useState(false)
  const retryTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const retryStepRef = useRef<Record<string, number>>({})
  const resolvingConflictRef = useRef<Set<string>>(new Set())

  function isActiveCanvas(id: string) {
    return documentStore.getState().activeCanvasId === id
  }

  function isActiveCanvasSession(id: string, token: number) {
    return isActiveCanvas(id) && sessionTokenRef.current === token
  }

  function requestQuickFullSave(requireCardId?: string) {
    const targetCanvasId = lastCanvasIdRef.current || canvasId
    if (!targetCanvasId || !docLoaded) return
    setTimeout(() => {
      const bucket = documentStore.getBucket(targetCanvasId)
      if (!bucket) return
      if (requireCardId && !bucket.cards.some(card => card.id === requireCardId)) return
      const marks = saveDirtyRef.current[targetCanvasId] || { full: false, view: false }
      marks.full = true
      saveDirtyRef.current[targetCanvasId] = marks
      if (saveTimerRef.current[targetCanvasId]) clearTimeout(saveTimerRef.current[targetCanvasId])
      saveTimerRef.current[targetCanvasId] = setTimeout(() => {
        delete saveTimerRef.current[targetCanvasId]
        void sendPersist(targetCanvasId)
      }, 250)
    }, 0)
  }

  function flushAfterMediaSaved(cardId: string) {
    requestQuickFullSave(cardId)
  }
  // ---------- 自动保存: 串行单飞 + 最新快照合并 + 视图拆分 + 乐观锁 + 本地双写兜底 ----------
  // 每次变化只在桶里标记 dirty, 实际请求严格串行; 上一笔完成后再取最新快照发送,
  // 从机制上保证后发永远不早于先发; 后端按 canvas_data.rev 乐观锁再兜底一层。
  // 全量内容在发送前同步写入 IndexedDB, 云端确认后删除: 崩溃/强杀/断网关机也能下次恢复。
  const saveTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const saveInFlightRef = useRef<Record<string, boolean>>({})
  const saveDirtyRef = useRef<Record<string, { full: boolean; view: boolean }>>({})
  // 各画布「待同步内容是否已安全落本地盘」: 关页原生确认只在盘上也没有时才弹
  const localSafeRef = useRef<Record<string, boolean>>({})
  // 各画布是否有全量(内容)请求正在途中: 卸载瞬间 dirty 已被消费, 靠它判断内容风险
  const inFlightFullRef = useRef<Record<string, boolean>>({})
  // 各画布「下一笔全量保存强制覆盖乐观锁」一次性标记(崩溃恢复接管后使用)
  const pendingForceRef = useRef<Record<string, boolean>>({})

  /** 排掉某画布的待发主动重试定时器 */
  function clearRetryTimer(id: string) {
    if (retryTimerRef.current[id]) {
      clearTimeout(retryTimerRef.current[id])
      delete retryTimerRef.current[id]
    }
  }

  /** 失败后按指数退避安排一次主动重试(1s→3s→10s→30s→60s 封顶, ±20% 抖动), 无需用户再操作 */
  function scheduleRetry(targetCanvasId: string) {
    if (retryTimerRef.current[targetCanvasId]) return
    if (saveConflictRef.current?.canvasId === targetCanvasId) return
    const step = Math.min(retryStepRef.current[targetCanvasId] ?? 0, RETRY_BACKOFF_MS.length - 1)
    const base = RETRY_BACKOFF_MS[step]
    retryStepRef.current[targetCanvasId] = step + 1
    // eslint-disable-next-line react-hooks/purity -- 指数退避只在失败回调里调度，抖动刻意跨进程隔离重试
    const jitter = base * 0.2 * (2 * Math.random() - 1)
    retryTimerRef.current[targetCanvasId] = setTimeout(() => {
      delete retryTimerRef.current[targetCanvasId]
      const marks = saveDirtyRef.current[targetCanvasId]
      if (!marks?.full && !marks?.view) return
      if (navigator.onLine === false) return // online 事件会再触发
      void sendPersist(targetCanvasId)
    }, Math.max(300, base + jitter))
  }

  /** 全量内容在发云端前先落本地盘; 失败返回 false(顶栏不能显示「本地已存」) */
  async function writeLocalSnapshotBeforeSend(targetCanvasId: string, baseRev: number, doc: CanvasDoc, title: string): Promise<boolean> {
    try {
      const snap: LocalCanvasSnapshot = {
        rev: baseRev,
        title,
        doc: doc as unknown as Record<string, unknown>,
        savedAt: Date.now(),
        sessionId: browserSessionId,
      }
      return await putLocalSnapshot(targetCanvasId, browserSessionId, snap)
    } catch {
      return false
    }
  }

  async function sendPersist(targetCanvasId: string, opts?: { keepalive?: boolean; force?: boolean }) {
    const bucket = documentStore.getBucket(targetCanvasId)
    if (!bucket) return
    const marks = saveDirtyRef.current[targetCanvasId]
    if (!marks || (!marks.full && !marks.view)) return
    // 单飞: 同一画布同一时刻只有一个在途 PATCH, 完成后检查 dirty 决定是否补发最新快照
    if (saveInFlightRef.current[targetCanvasId]) return
    // 冲突挂起/恢复弹窗未决时不自动发, 避免覆盖别处新版本或打断用户选择
    if (saveConflictRef.current?.canvasId === targetCanvasId) return
    if (localRestoreRef.current?.canvasId === targetCanvasId) return
    if (resolvingConflictRef.current.has(targetCanvasId)) return
    saveInFlightRef.current[targetCanvasId] = true
    const wantFull = marks.full
    const wantView = marks.view
    const wantForce = !!opts?.force || !!pendingForceRef.current[targetCanvasId]
    // 网络失败后的重试链路不带调用参数; 先登记 force, 成功后再移除,
    // 否则用户显式选择覆盖后一次断线就会退回普通保存并再次冲突。
    if (wantForce) pendingForceRef.current[targetCanvasId] = true
    if (wantFull) inFlightFullRef.current[targetCanvasId] = true
    if (isActiveCanvas(targetCanvasId)) armSavingFlash(targetCanvasId)
    saveDirtyRef.current[targetCanvasId] = { full: false, view: false }
    const baseRev = bucket.rev || 0
    let localLanded = false
    let fullDoc: CanvasDoc | null = null
    if (wantFull) {
      // 全量保存携带当时最新视图; 版本号(rev)由服务端统一分配, 这里只传基线供乐观锁校验
      fullDoc = {
        version: 1,
        cards: buildPersistCards(bucket.cards),
        connections: bucket.connections,
        view: bucket.viewport,
        pendingJobs: bucket.pending,
        projectAssets: bucket.projectAssets,
        logs: bucket.logs.slice(0, 500),
      }
      // 先落本地兜底盘再排队等云槽: 等槽期间页面被终止也不丢(崩溃恢复的唯一来源)
      localLanded = await writeLocalSnapshotBeforeSend(targetCanvasId, baseRev, fullDoc, bucket.title)
      localSafeRef.current[targetCanvasId] = localSafeRef.current[targetCanvasId] || localLanded
    }
    // 全局并发槽: 卸载抢发不排队, 平时多画布最多 2 笔在途
    const releaseSlot = opts?.keepalive ? tryAcquireCloudSlot() : await acquireCloudSlot()
    // 序列化一次: 同时拿到请求体大小(keepalive 64KB 判定)与内容指纹(幂等键)
    let body: Record<string, unknown>
    if (wantFull) {
      body = {
        title: bucket.title,
        canvas_data: fullDoc,
        canvas_rev: baseRev,
        // 409 冲突后用户显式选择「用我的版本覆盖」时带上, 服务端跳过基线校验但仍自增 rev
        ...(wantForce ? { canvas_force: true } : {}),
      }
    } else {
      // 纯视图变化(平移/缩放)只发视图, 不重写画布内容, 避免拖动画布也产生整文档写入
      body = {
        canvas_data: { view: bucket.viewport },
        canvas_view_only: true,
        canvas_rev: baseRev,
      }
    }
    const bodyText = JSON.stringify(body)
    // 幂等键: 按内容指纹生成, 同内容网络重试复用(服务端命中回放, 消除响应丢失导致的伪 409);
    // force 覆盖与纯视角不幂等(语义上每次都应真实处理)
    const idemKey = wantFull && !wantForce ? `c-${cyrb53Hex(bodyText)}` : ''
    // 卸载路径 + 全量体超过 keepalive 上限: 浏览器会静默丢弃, 不强发。
    // 页面仍存活(SPA 路由离开)时 1.2s 后走普通请求补发; 真正终止时靠本地快照下次打开恢复。
    if (opts?.keepalive && wantFull && bodyText.length > KEEPALIVE_BODY_LIMIT) {
      const cur3 = saveDirtyRef.current[targetCanvasId] || { full: false, view: false }
      cur3.full = true
      saveDirtyRef.current[targetCanvasId] = cur3
      if (!retryTimerRef.current[targetCanvasId]) {
        retryTimerRef.current[targetCanvasId] = setTimeout(() => {
          delete retryTimerRef.current[targetCanvasId]
          void sendPersist(targetCanvasId)
        }, 1200)
      }
      if (isActiveCanvas(targetCanvasId)) setSaveState(localSafeRef.current[targetCanvasId] ? 'local' : 'error')
      releaseSlot()
      saveInFlightRef.current[targetCanvasId] = false
      delete inFlightFullRef.current[targetCanvasId]
      return
    }
    try {
      const res = await fetch(`${CANVASES_API}/${targetCanvasId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
          ...(idemKey ? { 'X-Idempotency-Key': idemKey } : {}),
        },
        body: bodyText,
        keepalive: !!opts?.keepalive,
      })
      if (res.ok) {
        const updated = (await res.json().catch(() => null)) as { canvas_data?: { rev?: number } } | null
        const serverRev = Number(updated?.canvas_data?.rev ?? 0)
        const b = documentStore.getBucket(targetCanvasId)
        // 只增不减(同上, 防止任何晚到响应把基线拉回旧版本)
        if (b && serverRev > b.rev) documentStore.setBucketRevision(targetCanvasId, serverRev)
        clearRetryTimer(targetCanvasId)
        retryStepRef.current[targetCanvasId] = 0
        // 云端确认: 内容快照已无用, 清本地盘
        if (wantFull) {
          void clearLocalSnapshot(targetCanvasId, browserSessionId)
          localSafeRef.current[targetCanvasId] = false
          if (wantForce) delete pendingForceRef.current[targetCanvasId]
          // 通知同浏览器其它标签页: 云端有新版本了
          postCanvasMessage({ type: 'canvas-saved', canvasId: targetCanvasId, rev: serverRev, fromSession: browserSessionId })
        }
        if (isActiveCanvas(targetCanvasId)) {
          const stillDirty = saveDirtyRef.current[targetCanvasId]
          setSaveState(stillDirty?.full || stillDirty?.view ? 'saving' : 'saved')
        }
      } else if (res.status === 409) {
        // 内容保存版本冲突(多标签/多设备同开)。绝不再用本地旧快照自动重放 —— 那会静默覆盖别处的新内容。
        // 保留本次改动(重标 dirty, 基线不前移到新版本, 否则会被当成最新而误覆盖),
        // 弹出冲突选择让用户决定「加载最新 / 强制覆盖」。
        let serverRev = 0
        try {
          const conflict = (await res.json().catch(() => null)) as { canvas_rev?: number } | null
          serverRev = Number(conflict?.canvas_rev ?? 0) || 0
        } catch {
          /* 忽略冲突体解析失败 */
        }
        const cur = saveDirtyRef.current[targetCanvasId] || { full: false, view: false }
        if (wantFull) cur.full = true
        if (wantView && !wantFull) cur.view = true
        saveDirtyRef.current[targetCanvasId] = cur
        if (wantFull) localSafeRef.current[targetCanvasId] = localSafeRef.current[targetCanvasId] || localLanded
        clearRetryTimer(targetCanvasId)
        if (isActiveCanvas(targetCanvasId) && wantFull) {
          setSaveState('conflict')
          setSaveConflict(prev => prev ?? { canvasId: targetCanvasId, serverRev })
        }
      } else if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 412) {
        // 登录过期/失效: 改动必须留住待登录后续存, 顶栏标红并弹登录, 不能只悄悄置一个灰字。
        // 本地已落盘的内容显示「本地已存·待同步」, 让用户知道崩溃也不丢; 不落盘才是失败红标。
        const cur = saveDirtyRef.current[targetCanvasId] || { full: false, view: false }
        if (wantFull) cur.full = true
        if (wantView && !wantFull) cur.view = true
        saveDirtyRef.current[targetCanvasId] = cur
        if (wantFull) localSafeRef.current[targetCanvasId] = localSafeRef.current[targetCanvasId] || localLanded
        clearRetryTimer(targetCanvasId)
        if (isActiveCanvas(targetCanvasId)) {
          setSaveState(wantFull && localSafeRef.current[targetCanvasId] ? 'local' : 'error')
          setAuthDialog('login')
          toast.error('登录已过期, 改动尚未同步, 请重新登录后会自动续存')
        }
      } else {
        // 其它 5xx/400: 保留改动, 进入指数退避主动重试, 顶栏按本地落盘情况区分状态
        const cur2 = saveDirtyRef.current[targetCanvasId] || { full: false, view: false }
        if (wantFull) cur2.full = true
        if (wantView && !wantFull) cur2.view = true
        saveDirtyRef.current[targetCanvasId] = cur2
        if (wantFull) localSafeRef.current[targetCanvasId] = localSafeRef.current[targetCanvasId] || localLanded
        if (isActiveCanvas(targetCanvasId)) {
          setSaveState(wantFull && localSafeRef.current[targetCanvasId] ? 'local' : 'error')
        }
        scheduleRetry(targetCanvasId)
      }
    } catch {
      // 网络失败: 重新标记待保存, 指数退避主动重试 + online 事件双保险, 不丢改动
      const cur = saveDirtyRef.current[targetCanvasId] || { full: false, view: false }
      if (wantFull) cur.full = true
      if (wantView && !wantFull) cur.view = true
      saveDirtyRef.current[targetCanvasId] = cur
      if (wantFull) localSafeRef.current[targetCanvasId] = localSafeRef.current[targetCanvasId] || localLanded
      if (isActiveCanvas(targetCanvasId)) {
        setSaveState(wantFull && localSafeRef.current[targetCanvasId] ? 'local' : 'error')
      }
      scheduleRetry(targetCanvasId)
    } finally {
      releaseSlot()
      saveInFlightRef.current[targetCanvasId] = false
      if (wantFull) delete inFlightFullRef.current[targetCanvasId]
      // 链式补发会重新 arm 闪烁定时器; 终态(成功/冲突)则取消, 避免已保存后闪一下「同步中」
      const stillDirty = !!(saveDirtyRef.current[targetCanvasId]?.full || saveDirtyRef.current[targetCanvasId]?.view)
      if (!stillDirty) cancelSavingFlash(targetCanvasId)
      // 409 冲突已挂起等用户选择时, 绝不自动补发(否则又用旧快照覆盖); 其余情况有待发改动则串行补发最新快照
      const conflictPending = saveConflictRef.current?.canvasId === targetCanvasId
      const restorePending = localRestoreRef.current?.canvasId === targetCanvasId
      if (!conflictPending && !restorePending && stillDirty) void sendPersist(targetCanvasId)
    }
  }

  /** 立即把防抖中未落库的改动发出去(切画布/卸载前调用) */
  function flushPersistNow(targetCanvasId?: string) {
    const id = targetCanvasId ?? canvasId
    if (!id) return
    if (saveTimerRef.current[id]) {
      clearTimeout(saveTimerRef.current[id])
      delete saveTimerRef.current[id]
    }
    // 冲突挂起时不允许普通 flush 覆盖, 必须用户先做选择
    if (saveConflictRef.current?.canvasId === id) return
    void sendPersist(id)
  }

  /** 冲突选择一: 加载别处已保存的最新版; 本地未同步改动先备份, 提供一次「取回我的版本」 */
  async function resolveConflictReload() {
    const conflict = saveConflictRef.current
    if (!conflict) return
    const id = conflict.canvasId
    const token = sessionTokenRef.current
    if (!isActiveCanvasSession(id, token) || resolvingConflictRef.current.has(id)) return
    resolvingConflictRef.current.add(id)
    // 覆盖前把本地待发内容备份一份(只保留最近一次), 误选后可取回
    const hadLocalChanges = !!(saveDirtyRef.current[id]?.full || saveDirtyRef.current[id]?.view)
    saveDirtyRef.current[id] = { full: false, view: false }
    let backupWritten = !hadLocalChanges
    if (hadLocalChanges) {
      const b = documentStore.getBucket(id)
      if (b) {
        try {
          await putConflictBackup(id, {
            rev: b.rev || 0,
            title: b.title,
            doc: {
              version: 1,
              cards: buildPersistCards(b.cards),
              connections: b.connections,
              view: b.viewport,
              pendingJobs: b.pending,
              projectAssets: b.projectAssets,
              logs: b.logs.slice(0, 500),
            },
            savedAt: Date.now(),
            sessionId: browserSessionId,
            serverRev: conflict.serverRev,
            backedAt: Date.now(),
          })
          setConflictBackupAvailable(true)
          backupWritten = true
        } catch {
          backupWritten = false
        }
      }
    }
    try {
      if (!isActiveCanvasSession(id, token)) return
      if (!backupWritten) {
        saveDirtyRef.current[id] = { full: true, view: false }
        setSaveConflict(conflict)
        setSaveState('conflict')
        toast.error('本地改动备份失败, 未加载云端版本, 请检查浏览器存储空间后重试')
        return
      }
      const res = await fetch(`${CANVASES_API}/${id}`, { headers: { ...getAuthHeaders() } })
      if (!res.ok) throw new Error('reload failed')
      const rec = await res.json()
      if (!isActiveCanvasSession(id, token)) return
      if (saveDirtyRef.current[id]?.full || saveDirtyRef.current[id]?.view) {
        setSaveState('conflict')
        toast.message('检测到冲突处理期间有新编辑, 已保留新编辑, 请重新选择处理方式')
        return
      }
      const { docCards, pending } = applyServerDoc(rec, id, token, { suppressSave: true })
      delete pendingForceRef.current[id]
      setSaveConflict(null)
      localSafeRef.current[id] = false
      clearRetryTimer(id)
      setDocLoaded(true)
      resumeRestoredJobs(docCards, pending, token)
      setSaveState('saved')
      toast.success(hadLocalChanges ? '已加载最新版本, 本地改动已保留, 顶栏可取回' : '已加载最新版本')
    } catch {
      if (!isActiveCanvasSession(id, token)) return
      // 拉取失败: 保留冲突态让用户可重试, 不静默
      setSaveConflict({ canvasId: id, serverRev: conflict.serverRev })
      toast.error('加载最新版本失败, 请检查网络后重试')
    } finally {
      resolvingConflictRef.current.delete(id)
    }
  }

  /** 冲突误选撤销: 取出刚才备份的本地版本并强制覆盖回去(只保留一次机会) */
  async function restoreConflictBackup() {
    const id = documentStore.getState().activeCanvasId || lastCanvasIdRef.current || canvasId
    if (!id) return
    const token = sessionTokenRef.current
    const backup = await takeConflictBackup(id)
    if (!isActiveCanvasSession(id, token)) {
      if (backup) await putConflictBackup(id, backup)
      return
    }
    if (!backup) {
      toast.error('没有可取回的本地版本')
      return
    }
    setConflictBackupAvailable(false)
    const rec = { title: backup.title, canvas_data: backup.doc }
    const { docCards, pending } = applyServerDoc(rec, id, token, { suppressSave: true })
    setDocLoaded(true)
    resumeRestoredJobs(docCards, pending, token)
    const b = documentStore.getBucket(id)
    if (b && backup.serverRev > b.rev) documentStore.setBucketRevision(id, backup.serverRev)
    saveDirtyRef.current[id] = { full: true, view: false }
    if (saveTimerRef.current[id]) {
      clearTimeout(saveTimerRef.current[id])
      delete saveTimerRef.current[id]
    }
    setSaveState('saving')
    void sendPersist(id, { force: true })
    toast.success('已取回你的本地版本, 正在覆盖同步')
  }

  function dismissConflictBackup() {
    setConflictBackupAvailable(false)
  }

  /** 崩溃恢复选择一: 以云端为准, 丢弃本地快照(同时清掉同画布其它陈旧快照) */
  async function discardLocalRestore() {
    const r = localRestoreRef.current
    if (!r) return
    const token = sessionTokenRef.current
    setLocalRestore(null)
    const { canvasId: id, originSessionId } = r
    await deleteStaleSnapshot(id, originSessionId)
    // 同画布若还残留别的崩溃标签页快照, 一并清掉, 避免下次打开再弹
    const rest = await listStaleSnapshots(id, browserSessionId)
    for (const s of rest) await deleteStaleSnapshot(id, s.originSessionId)
    if (!isActiveCanvasSession(id, token)) return
    // 内存里已灌的是云端文档, 补续它携带的生成任务轮询
    const cloudCards = documentStore.getState().cards
    resumeRestoredJobs(cloudCards, cloudPendingAtRestoreRef.current, token)
    cloudPendingAtRestoreRef.current = []
    setSaveState('saved')
    toast.success('已使用云端最新版本, 本地未同步内容已清除')
  }

  /**
   * 崩溃恢复选择二: 把本地快照灌入画布, 随后走常规防抖保存(带 force,
   * 快照基线可能落后云端, 属于用户显式选择覆盖)。
   */
  function acceptLocalRestore() {
    const r = localRestoreRef.current
    if (!r) return
    const { canvasId: id, snapshot, originSessionId } = r
    setLocalRestore(null)
    cloudPendingAtRestoreRef.current = []
    const { docCards, pending } = applyServerDoc(
      { title: snapshot.title, canvas_data: snapshot.doc },
      id,
      sessionTokenRef.current,
      // 不抑制保存 effect: 灌入后让常规防抖链路在 900ms 后自动发最新桶, 避开时序依赖
    )
    resumeRestoredJobs(docCards, pending, sessionTokenRef.current)
    pendingForceRef.current[id] = true
    localSafeRef.current[id] = true
    // 接管后该快照归当前会话所有: 旧会话键删除, 正常保存成功后会清当前会话键
    void deleteStaleSnapshot(id, originSessionId)
    toast.success('已恢复未保存的改动, 稍后将自动同步到云端')
  }

  /** 崩溃恢复弹窗挂起期间不做选择, 快照留在本机下次再问 */
  function deferLocalRestore() {
    setLocalRestore(null)
    cloudPendingAtRestoreRef.current = []
    setSaveState('local')
    toast.message('未保存的改动仍保留在本机, 下次打开这个画布可再次选择恢复')
  }

  /** 冲突选择二: 用本地版本强制覆盖别处的新内容(用户显式确认, 服务端 canvas_force 跳过基线校验) */
  function resolveConflictOverwrite() {
    const conflict = saveConflictRef.current
    setSaveConflict(null)
    if (!conflict) return
    const id = conflict.canvasId
    // 把本地基线对齐到服务端 rev, 再带 force 发一次最新全量
    const b = documentStore.getBucket(id)
    if (b && conflict.serverRev > b.rev) documentStore.setBucketRevision(id, conflict.serverRev)
    saveDirtyRef.current[id] = { full: true, view: false }
    if (saveTimerRef.current[id]) {
      clearTimeout(saveTimerRef.current[id])
      delete saveTimerRef.current[id]
    }
    setSaveState('saving')
    void sendPersist(id, { force: true })
  }

  // 「同步中」字样延迟显示: 请求 300ms 内完成不切换状态, 避免快速保存时顶栏频闪
  const savingFlashTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  function armSavingFlash(id: string) {
    if (savingFlashTimerRef.current[id]) clearTimeout(savingFlashTimerRef.current[id])
    savingFlashTimerRef.current[id] = setTimeout(() => {
      delete savingFlashTimerRef.current[id]
      if (saveInFlightRef.current[id] && isActiveCanvas(id) && !saveConflictRef.current) setSaveState('saving')
    }, 300)
  }
  function cancelSavingFlash(id: string) {
    if (savingFlashTimerRef.current[id]) {
      clearTimeout(savingFlashTimerRef.current[id])
      delete savingFlashTimerRef.current[id]
    }
  }

  /**
   * 动态防抖时长:
   * - 视图拖动 0.6s, 不受规模影响(请求体很小);
   * - 内容保存按画布卡片数(120/400 两档)与网络信息(saveData/弱网 rtt)在 0.9–1.5s 浮动,
   *   小画布好网最低 0.6s, 让大画布弱网下少排队、少发大请求。
   */
  function saveDebounceMs(kind: 'full' | 'view', cardCount: number): number {
    if (kind === 'view') return 600
    let delay = 900
    if (cardCount > 400) delay += 500
    else if (cardCount > 120) delay += 250
    try {
      const conn = (navigator as Navigator & { connection?: { saveData?: boolean; rtt?: number } }).connection
      if (conn?.saveData || (typeof conn?.rtt === 'number' && conn.rtt >= 400)) delay = Math.min(1500, delay + 300)
    } catch {
      /* 无网络信息用默认 */
    }
    if (cardCount <= 30) delay = Math.min(delay, 600)
    return delay
  }

  function scheduleSave(kind: 'full' | 'view') {
    if (!docLoaded || !canvasId) return
    // 崩溃恢复弹窗未决: 改动标记照常累积, 但不抢状态、不调度发送(用户选择后再发)
    if (localRestoreRef.current?.canvasId === canvasId) return
    const marks = saveDirtyRef.current[canvasId] || { full: false, view: false }
    if (kind === 'full') marks.full = true
    else if (!marks.full) marks.view = true
    saveDirtyRef.current[canvasId] = marks
    // 冲突弹窗挂起期间继续累积改动, 但不抢状态、不调度发送(用户选择后再发最新快照)
    if (saveConflictRef.current?.canvasId === canvasId) return
    // 用户有新操作: 退避重试从 1s 重新起步
    clearRetryTimer(canvasId)
    retryStepRef.current[canvasId] = 0
    setSaveState('editing')
    if (saveTimerRef.current[canvasId]) clearTimeout(saveTimerRef.current[canvasId])
    const delay = saveDebounceMs(kind === 'view' && !marks.full ? 'view' : 'full', documentStore.getState().cards.length)
    saveTimerRef.current[canvasId] = setTimeout(() => {
      delete saveTimerRef.current[canvasId]
      void sendPersist(canvasId)
    }, delay)
  }

  // 内容变化: 全量保存(程序灌入服务端文档的一拍跳过, 避免打开/同步后无意义回存)
  useEffect(() => {
    const timers = saveTimerRef.current
    if (suppressContentSaveRef.current > 0) {
      suppressContentSaveRef.current -= 1
      return
    }
    scheduleSave('full')
    return () => {
      if (canvasId && timers[canvasId]) {
        clearTimeout(timers[canvasId])
        delete timers[canvasId]
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, connections, canvasTitle, pendingJobs, genLogs, projectAssets, docLoaded, canvasId])

  // 视图变化(平移/缩放): 只保存视图(程序灌入服务端文档的一拍跳过)
  useEffect(() => {
    const timers = saveTimerRef.current
    if (suppressViewSaveRef.current > 0) {
      suppressViewSaveRef.current -= 1
      return
    }
    scheduleSave('view')
    return () => {
      if (canvasId && timers[canvasId]) {
        clearTimeout(timers[canvasId])
        delete timers[canvasId]
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, docLoaded, canvasId])

  // 卸载路径专用: 不等防抖, 直接把当前最新全量快照写入本地盘(崩溃恢复的兜底来源)
  async function dumpLocalSnapshotNow(id: string): Promise<boolean> {
    const b = documentStore.getBucket(id)
    if (!b) return false
    try {
      const ok = await writeLocalSnapshotBeforeSend(
        id,
        b.rev || 0,
        {
          version: 1,
          cards: buildPersistCards(b.cards),
          connections: b.connections,
          view: b.viewport,
          pendingJobs: b.pending,
          projectAssets: b.projectAssets,
          logs: b.logs.slice(0, 500),
        } as CanvasDoc,
        b.title,
      )
      if (ok) localSafeRef.current[id] = true
      return ok
    } catch {
      return false
    }
  }

  // 关页/切后台/切画布多通道保存, 尽量消除最后几笔改动的丢失窗口(读 ref, 不依赖首次渲染闭包):
  //  - visibilitychange=hidden(切后台/最小化/移动端切 App, 关页前大多先触发): 页面尚未终止,
  //    先把最新全量快照写本地盘, 再用普通 fetch 提前 flush(不受 keepalive 64KB 限制);
  //  - pagehide(关标签/跳走): 发起本地写盘后再补一笔 keepalive(≤64KB 请求浏览器卸载后继续发完),
  //    发不出去也有盘上快照, 下次打开提示恢复;
  //  - React cleanup(SPA 内路由离开, 如返回首页): 先落盘再 keepalive。
  // 冲突挂起中不强发(避免覆盖别处的新版本)。
  useEffect(() => {
    function clearTimers() {
      Object.keys(saveTimerRef.current).forEach(id => {
        if (saveTimerRef.current[id]) clearTimeout(saveTimerRef.current[id])
      })
      Object.keys(retryTimerRef.current).forEach(id => {
        if (retryTimerRef.current[id]) clearTimeout(retryTimerRef.current[id])
      })
      Object.keys(savingFlashTimerRef.current).forEach(id => {
        if (savingFlashTimerRef.current[id]) clearTimeout(savingFlashTimerRef.current[id])
      })
    }
    function targetId() {
      return lastCanvasIdRef.current
    }
    function marksOf(id: string | null) {
      if (!id) return null
      if (saveConflictRef.current?.canvasId === id) return null
      return saveDirtyRef.current[id] ?? null
    }
    async function onHidden() {
      const id = targetId()
      const m = marksOf(id)
      if (!id || !m || (!m.full && !m.view)) return
      clearTimers()
      // 防抖窗口里的最新内容先落盘(hidden 后页面通常不会立刻终止, 事务来得及完成)
      if (m.full && !localSafeRef.current[id]) await dumpLocalSnapshotNow(id)
      void sendPersist(id)
    }
    function onPageHide() {
      const id = targetId()
      const m = marksOf(id)
      if (!id || !m || (!m.full && !m.view)) return
      clearTimers()
      if (m.full && !localSafeRef.current[id]) void dumpLocalSnapshotNow(id)
      void sendPersist(id, { keepalive: true })
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPageHide)
      clearTimers()
      // eslint-disable-next-line react-hooks/exhaustive-deps -- SPA 卸载时必须读取当前画布，而不是挂载时的 ID
      const lastId = lastCanvasIdRef.current
      const m = lastId ? marksOf(lastId) : null
      if (!lastId || !m || (!m.full && !m.view)) return
      // SPA 内路由离开: JS 环境仍存活, 先落盘再抢发
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 卸载兜底必须读取最新的本地安全标记
      if (m.full && !localSafeRef.current[lastId]) {
        void dumpLocalSnapshotNow(lastId).then(ok => {
          if (ok) void sendPersist(lastId, { keepalive: true })
        })
      } else {
        void sendPersist(lastId, { keepalive: true })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 关页原生拦截只在「内容有丢失风险」时弹: 内容待发/全量在途且本地盘也没有, 或冲突待选择。
  // 本地已存(断网也能恢复)、纯视角变化、已保存、空闲均不打扰。
  useEffect(() => {
    const id = canvasId
    function onBeforeUnload(ev: BeforeUnloadEvent) {
      if (!id) return
      if (saveConflictRef.current?.canvasId === id) {
        ev.preventDefault()
        ev.returnValue = '画布存在待处理的版本冲突, 确定离开吗?'
        return
      }
      if (localRestoreRef.current) return
      const m = saveDirtyRef.current[id]
      const contentAtRisk = (!!m?.full || inFlightFullRef.current[id]) && !localSafeRef.current[id]
      // 有文件仍在上传: 全新卡首传若此刻终止, 永久链接还没写回, 再进来就是无图空卡
      const uploadInFlight = getMediaUploadInflight() > 0
      if (contentAtRisk || uploadInFlight) {
        ev.preventDefault()
        ev.returnValue = uploadInFlight
          ? '图片还在上传中, 现在离开可能丢失图片, 确定离开吗?'
          : '有改动尚未保存, 确定离开吗?'
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [canvasId])

  // 网络恢复 / 定时退避双保险: 从离线回到在线, 立刻把所有画布的待发改动补发一次
  useEffect(() => {
    function onOnline() {
      Object.keys(saveDirtyRef.current).forEach(id => {
        const m = saveDirtyRef.current[id]
        if (!m || (!m.full && !m.view)) return
        if (saveConflictRef.current?.canvasId === id) return
        if (localRestoreRef.current?.canvasId === id) return
        if (saveInFlightRef.current[id]) return
        clearRetryTimer(id)
        retryStepRef.current[id] = 0
        if (saveTimerRef.current[id]) {
          clearTimeout(saveTimerRef.current[id])
          delete saveTimerRef.current[id]
        }
        void sendPersist(id)
      })
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 同浏览器多标签协同: 别的标签保存了同一画布——
  // 本标签没有未同步改动就静默拉到最新(消掉绝大多数保存时 409); 有未同步改动则提前弹出冲突选择。
  useEffect(() => {
    return onCanvasMessage(msg => {
      if (msg.type !== 'canvas-saved' || !isActiveCanvas(msg.canvasId)) return
      if (msg.fromSession === browserSessionId) return
      if (saveConflictRef.current || localRestoreRef.current) return
      const id = msg.canvasId
      const token = sessionTokenRef.current
      const b = documentStore.getBucket(id)
      if (!b) return
      // 版本不新于本地基线: 旧消息/自己的回声, 忽略
      if (msg.rev && b.rev >= msg.rev) return
      const m = saveDirtyRef.current[id]
      const pendingLocal = !!(m?.full || m?.view) || !!saveTimerRef.current[id] || saveInFlightRef.current[id]
      if (pendingLocal) {
        // 本地有未同步内容且云端已被别的标签推进: 提前挂冲突, 不等保存时才发现
        if (!saveInFlightRef.current[id]) {
          setSaveState('conflict')
          setSaveConflict(prev => prev ?? { canvasId: id, serverRev: msg.rev || b.rev + 1 })
        }
        return
      }
      // 本地干净: 静默同步
      void (async () => {
        try {
          const res = await fetch(`${CANVASES_API}/${id}`, { headers: { ...getAuthHeaders() } })
          if (!res.ok) return
          const rec = await res.json()
          if (!isActiveCanvasSession(id, token)) return
          if (saveConflictRef.current || localRestoreRef.current) return
          const m2 = saveDirtyRef.current[id]
          if (m2?.full || m2?.view || saveTimerRef.current[id]) return
          applyServerDoc(rec, id, token, { suppressSave: true })
        } catch {
          /* 静默同步失败不打扰, 乐观锁在保存时兜底 */
        }
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId])

  function resumeAfterAuth() {
    try {
      const id = lastCanvasIdRef.current || canvasId
      if (!id) return
      const marks = saveDirtyRef.current[id]
      if (!marks?.full && !marks?.view) return
      if (saveTimerRef.current[id]) {
        clearTimeout(saveTimerRef.current[id])
        // eslint-disable-next-line react-hooks/immutability -- 事件回调里清理本画布的一次性保存定时器
        delete saveTimerRef.current[id]
      }
      clearRetryTimer(id)
      retryStepRef.current[id] = 0
      setSaveState('saving')
      void sendPersist(id)
    } catch {
      // 续存失败由下一次编辑或重试链路继续处理。
    }
  }

  return {
    saveState,
    setSaveState,
    saveConflict,
    resolveConflictReload,
    resolveConflictOverwrite,
    restoreConflictBackup,
    dismissConflictBackup,
    localRestore,
    setLocalRestore,
    acceptLocalRestore,
    discardLocalRestore,
    deferLocalRestore,
    conflictBackupAvailable,
    flushPersistNow,
    requestQuickFullSave,
    flushAfterMediaSaved,
    resumeAfterAuth,
    browserSessionId,
    cloudPendingAtRestoreRef,
  }
}
