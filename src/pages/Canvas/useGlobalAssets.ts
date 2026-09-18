import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getPocketBaseUrl } from '@/lib/pb'
import { getAuthHeaders } from '@/lib/auth'
import type { AssetItem, GlobalAssetFolder, ProjectAssetMember, WorkflowDoc } from './canvasTypes'

const ASSETS_API = `${getPocketBaseUrl()}/api/assets`
const ASSET_FOLDERS_API = `${getPocketBaseUrl()}/api/asset_folders`
const PAGE_SIZE = 50

export interface CreateAssetInput {
  name: string
  url: string
  source: string
  mediaType?: 'image' | 'video' | 'group' | 'workflow'
  folder?: string
  images?: ProjectAssetMember[] | { workflow: WorkflowDoc }
}

export interface UseGlobalAssetsOptions {
  /** 当前登录账号标识（邮箱），未登录时不加载 */
  ownerKey?: string
}

/**
 * 账号全局素材库的数据层：素材列表分页累积、记录创建、素材/文件夹的增删改名。
 * 从 useCanvas 抽出，只管服务端数据与本地列表；素材如何落到画布、存选中节点等交互仍在 useCanvas。
 */
export function useGlobalAssets({ ownerKey }: UseGlobalAssetsOptions) {
  const [assets, setAssets] = useState<AssetItem[]>([])
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [assetsLoadingMore, setAssetsLoadingMore] = useState(false)
  const [assetsHasMore, setAssetsHasMore] = useState(false)
  const [assetsTotal, setAssetsTotal] = useState(0)
  const assetsPageRef = useRef(1)

  const [globalFolders, setGlobalFolders] = useState<GlobalAssetFolder[]>([])
  const [foldersLoading, setFoldersLoading] = useState(false)

  // 素材首页：跟随账号加载，并响应「全部产物」批量入库后的广播刷新
  useEffect(() => {
    if (!ownerKey) return
    let active = true
    const loadFirstPage = async () => {
      setAssetsLoading(true)
      assetsPageRef.current = 1
      try {
        const res = await fetch(`${ASSETS_API}?page=1&perPage=${PAGE_SIZE}`, { headers: { ...getAuthHeaders() } })
        if (!res.ok) throw new Error('list failed')
        const data = (await res.json()) as { items?: AssetItem[]; totalItems?: number; totalPages?: number }
        if (!active) return
        setAssets(Array.isArray(data.items) ? data.items : [])
        setAssetsTotal(typeof data.totalItems === 'number' ? data.totalItems : 0)
        setAssetsHasMore(
          typeof data.totalPages === 'number' ? data.totalPages > 1 : (data.items?.length ?? 0) >= PAGE_SIZE,
        )
      } catch {
        // 素材库加载失败不阻塞画布
      } finally {
        if (active) setAssetsLoading(false)
      }
    }
    void loadFirstPage()
    const onAssetsChanged = () => { void loadFirstPage() }
    window.addEventListener('dangoo:assets-changed', onAssetsChanged)
    return () => {
      active = false
      window.removeEventListener('dangoo:assets-changed', onAssetsChanged)
    }
  }, [ownerKey])

  // 全局文件夹：跟随账号加载（数量少，一次拉满 200）
  useEffect(() => {
    if (!ownerKey) {
      Promise.resolve().then(() => setGlobalFolders([]))
      return
    }
    let active = true
    ;(async () => {
      setFoldersLoading(true)
      try {
        const res = await fetch(`${ASSET_FOLDERS_API}?page=1&perPage=200`, { headers: { ...getAuthHeaders() } })
        if (!res.ok) throw new Error('list failed')
        const data = await res.json()
        if (active) setGlobalFolders(Array.isArray(data.items) ? data.items : [])
      } catch {
        // 文件夹加载失败不阻塞面板
      } finally {
        if (active) setFoldersLoading(false)
      }
    })()
    return () => { active = false }
  }, [ownerKey])

  /** 加载下一页全局资产，追加到列表（按 id 去重） */
  async function loadMoreGlobalAssets() {
    if (assetsLoadingMore || !assetsHasMore || !ownerKey) return
    setAssetsLoadingMore(true)
    try {
      const nextPage = assetsPageRef.current + 1
      const res = await fetch(`${ASSETS_API}?page=${nextPage}&perPage=${PAGE_SIZE}`, { headers: { ...getAuthHeaders() } })
      if (!res.ok) throw new Error('list failed')
      const data = (await res.json()) as { items?: AssetItem[]; totalPages?: number }
      const items = Array.isArray(data.items) ? data.items : []
      assetsPageRef.current = nextPage
      setAssets(prev => {
        const seen = new Set(prev.map(a => a.id))
        return [...prev, ...items.filter(a => !seen.has(a.id))]
      })
      setAssetsHasMore(typeof data.totalPages === 'number' ? nextPage < data.totalPages : items.length >= PAGE_SIZE)
    } catch {
      toast.error('加载更多素材失败, 请稍后重试')
    } finally {
      setAssetsLoadingMore(false)
    }
  }

  /** 在全局库创建一条素材记录（失败返回 null，由调用方提示） */
  async function createAssetRecord(input: CreateAssetInput): Promise<AssetItem | null> {
    try {
      const res = await fetch(ASSETS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          rh_user_id: ownerKey ?? '',
          name: input.name.slice(0, 120) || '未命名素材',
          url: input.url,
          media_type: input.mediaType ?? 'image',
          source: input.source,
          folder: input.folder ?? '',
          images: input.images,
        }),
      })
      if (!res.ok) return null
      return (await res.json()) as AssetItem
    } catch {
      return null
    }
  }

  function prependAsset(rec: AssetItem) {
    setAssets(prev => [rec, ...prev])
  }

  async function handleRenameGlobalAsset(assetId: string, displayName: string) {
    const trimmed = displayName.trim().slice(0, 120)
    if (!trimmed) return
    try {
      const res = await fetch(`${ASSETS_API}/${assetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) throw new Error('rename asset failed')
      setAssets(prev => prev.map(a => (a.id === assetId ? { ...a, name: trimmed } : a)))
    } catch {
      toast.error('重命名失败, 请重试')
    }
  }

  async function handleDeleteGlobalAsset(assetId: string) {
    try {
      const res = await fetch(`${ASSETS_API}/${assetId}`, { method: 'DELETE', headers: { ...getAuthHeaders() } })
      if (!res.ok) throw new Error('delete asset failed')
      setAssets(prev => prev.filter(a => a.id !== assetId))
    } catch {
      toast.error('删除失败, 请重试')
    }
  }

  /** 全局库新建文件夹，返回新文件夹 id；取消/失败返回 null */
  async function createGlobalFolder(displayName: string): Promise<string | null> {
    const trimmed = displayName.trim().slice(0, 100)
    if (!trimmed) {
      toast.error('文件夹名称不能为空')
      return null
    }
    try {
      const res = await fetch(ASSET_FOLDERS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ name: trimmed }),
      })
      if (res.status === 412) return 'UNAUTHORIZED'
      if (!res.ok) throw new Error('create folder failed')
      const rec = (await res.json()) as GlobalAssetFolder
      setGlobalFolders(prev => [...prev, rec])
      toast.success('已新建文件夹')
      return rec.id
    } catch {
      toast.error('新建文件夹失败, 请重试')
      return null
    }
  }

  async function renameGlobalFolder(folderId: string, displayName: string) {
    const trimmed = displayName.trim().slice(0, 100)
    if (!trimmed) {
      toast.error('文件夹名称不能为空')
      return
    }
    try {
      const res = await fetch(`${ASSET_FOLDERS_API}/${folderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) throw new Error('rename folder failed')
      setGlobalFolders(prev => prev.map(f => (f.id === folderId ? { ...f, name: trimmed } : f)))
    } catch {
      toast.error('重命名失败, 请重试')
    }
  }

  /** 删全局文件夹：夹内资产 folder 字段置空（逐条 PATCH，失败保留原值），不删资产本身 */
  async function deleteGlobalFolder(folderId: string) {
    try {
      const res = await fetch(`${ASSET_FOLDERS_API}/${folderId}`, { method: 'DELETE', headers: { ...getAuthHeaders() } })
      if (!res.ok) throw new Error('delete folder failed')
      setGlobalFolders(prev => prev.filter(f => f.id !== folderId))
      setAssets(prev => {
        prev
          .filter(a => a.folder === folderId)
          .forEach(a => {
            void fetch(`${ASSETS_API}/${a.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
              body: JSON.stringify({ folder: '' }),
            }).catch(() => {})
          })
        return prev.map(a => (a.folder === folderId ? { ...a, folder: '' } : a))
      })
      toast.success('文件夹已删除, 资产已移到未分类')
    } catch {
      toast.error('删除文件夹失败, 请重试')
    }
  }

  return {
    assets, setAssets,
    assetsLoading, assetsLoadingMore, assetsHasMore, assetsTotal,
    globalFolders, foldersLoading,
    loadMoreGlobalAssets,
    createAssetRecord, prependAsset,
    handleRenameGlobalAsset, handleDeleteGlobalAsset,
    createGlobalFolder, renameGlobalFolder, deleteGlobalFolder,
  }
}
