import { useCallback, useEffect, useState } from 'react'
import { getPocketBaseUrl } from '@/lib/pb'
import { getAuthHeaders } from '@/lib/auth'
import { getLocalAccount, onLocalAccountChange } from '@/lib/localAuth'
import type { GenLogEntry } from '@/pages/Canvas/canvasTypes'
import {
  hashString,
  normalizeUrlKey,
  type CanvasesPage,
  type GeneratedAsset,
} from './generatedAssetsTypes'

const CANVASES_API = `${getPocketBaseUrl()}/api/canvases`
const PAGE_SIZE = 50
/** 上限保护: 最多聚合最近 200 个画布 */
export const MAX_CANVASES = 200
const MAX_PAGES = MAX_CANVASES / PAGE_SIZE

interface SessionCache {
  assets: GeneratedAsset[]
  canvasesCount: number
  truncated: boolean
}

// 会话级缓存: 切走分区再回来瞬时显示; 点刷新按钮才重新聚合
let sessionCache: SessionCache | null = null
let inflight: Promise<SessionCache> | null = null

function isCollectibleOutput(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string') return false
  const url = rawUrl.trim()
  if (!url) return false
  // blob: 本地链接刷新即失效, 不收录; data: 不视作历史产物
  if (url.startsWith('blob:') || url.startsWith('data:')) return false
  return true
}

/** 把一页画布的 success 日志展开成产物项 */
function expandCanvasLogs(
  canvasId: string,
  canvasTitle: string,
  logs: GenLogEntry[],
  sink: Map<string, GeneratedAsset>,
) {
  for (const log of logs) {
    if (!log || log.status !== 'success' || !Array.isArray(log.outputs)) continue
    const outputs = log.outputs
    for (const out of outputs) {
      if (!out || !isCollectibleOutput(out.url)) continue
      const kind = out.kind === 'video' || out.kind === 'audio' ? out.kind : 'image'
      const createdAt = typeof log.createdAt === 'number' ? log.createdAt : 0
      const key = normalizeUrlKey(out.url)
      const prev = sink.get(key)
      // 同 url 去重: 保留 createdAt 最新一条, 项目/提示词归属以最新一次为准
      if (prev && prev.createdAt >= createdAt) continue
      sink.set(key, {
        id: hashString(`${canvasId}|${key}`),
        url: out.url,
        kind,
        canvasId,
        canvasTitle: canvasTitle || '未命名画布',
        nodeType: log.nodeType || '',
        model: log.model || '',
        prompt: log.prompt || '',
        createdAt,
        runMs: typeof log.runMs === 'number' ? log.runMs : 0,
        costText: log.costText || '',
      })
    }
  }
}

async function aggregateAllAssets(): Promise<SessionCache> {
  if (inflight) return inflight
  inflight = (async () => {
    const merged = new Map<string, GeneratedAsset>()
    let canvasesCount = 0
    let truncated = false
    let page = 1
    for (;;) {
      // 注意: 回收站过滤只能传 0/1——服务端把字符串 "false" 当成无过滤值,
      // 会拼出恒假条件返回 0 条(首页因此干脆不传在本地过滤)。这里用 0 让分页总数也准确。
      const res = await fetch(
        `${CANVASES_API}?page=${page}&perPage=${PAGE_SIZE}&sort=-updated&is_deleted=0`,
        { headers: { ...getAuthHeaders() } },
      )
      if (!res.ok) throw new Error('画布列表加载失败')
      const data = (await res.json()) as CanvasesPage
      const items = Array.isArray(data.items) ? data.items : []
      for (const canvas of items) {
        if (!canvas || typeof canvas.id !== 'string' || canvas.is_deleted) continue
        canvasesCount += 1
        const logs = canvas.canvas_data?.logs
        if (Array.isArray(logs)) expandCanvasLogs(canvas.id, canvas.title || '未命名画布', logs, merged)
      }
      const totalPages = typeof data.totalPages === 'number' ? data.totalPages : 0
      const hasMore = totalPages > 0 ? page < totalPages : items.length >= PAGE_SIZE
      if (!hasMore || page >= MAX_PAGES) {
        if (hasMore && page >= MAX_PAGES) truncated = true
        break
      }
      page += 1
    }
    const assets = Array.from(merged.values()).sort((a, b) => b.createdAt - a.createdAt)
    const result: SessionCache = { assets, canvasesCount, truncated }
    sessionCache = result
    return result
  })()
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

/** 清空会话缓存(登录账号切换后旧产物不该残留) */
export function clearGeneratedAssetsCache() {
  sessionCache = null
}

export interface GeneratedAssetsVm {
  assets: GeneratedAsset[]
  loading: boolean
  /** 已至少成功聚合过一次(用于切回分区时先显缓存再后台静默刷新) */
  loaded: boolean
  error: string | null
  loggedIn: boolean
  canvasesCount: number
  truncated: boolean
  refreshing: boolean
  refresh: () => void
}

/**
 * 分页拉取当前账号全部未删除画布, 展开 logs 里 success 产物并按 url 去重。
 * 懒加载(由分区 active 时触发); 会话内缓存, 支持手动刷新。
 */
export function useGeneratedAssets(active: boolean): GeneratedAssetsVm {
  const [loggedIn, setLoggedIn] = useState<boolean>(() => !!getLocalAccount())
  const [assets, setAssets] = useState<GeneratedAsset[]>(() => sessionCache?.assets ?? [])
  const [canvasesCount, setCanvasesCount] = useState<number>(() => sessionCache?.canvasesCount ?? 0)
  const [truncated, setTruncated] = useState<boolean>(() => sessionCache?.truncated ?? false)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => onLocalAccountChange(acc => setLoggedIn(!!acc)), [])

  const runLoad = useCallback(async (isRefresh: boolean) => {
    if (!getLocalAccount()) {
      sessionCache = null
      setAssets([])
      setCanvasesCount(0)
      setTruncated(false)
      return
    }
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const result = await aggregateAllAssets()
      setAssets(result.assets)
      setCanvasesCount(result.canvasesCount)
      setTruncated(result.truncated)
    } catch {
      setError('作品列表加载失败, 请检查网络后重试')
    } finally {
      if (isRefresh) setRefreshing(false)
      else setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void Promise.resolve().then(() => {
      if (!loggedIn) {
        sessionCache = null
        setAssets([])
        return
      }
      if (sessionCache) {
        setAssets(sessionCache.assets)
        setCanvasesCount(sessionCache.canvasesCount)
        setTruncated(sessionCache.truncated)
        return
      }
      void runLoad(false)
    })
  }, [active, loggedIn, runLoad])

  const refresh = useCallback(() => {
    sessionCache = null
    void runLoad(true)
  }, [runLoad])

  return {
    assets,
    loading,
    loaded: !!sessionCache,
    error,
    loggedIn,
    canvasesCount,
    truncated,
    refreshing,
    refresh,
  }
}
