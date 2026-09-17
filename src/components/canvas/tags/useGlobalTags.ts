import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { getPocketBaseUrl } from '@/lib/pb'
import { getAuthHeaders } from '@/lib/auth'
import {
  CONTENT_TEMPLATE_DEFS,
  TAG_TEMPLATES,
  builtinTagDef,
  isBuiltinSlug,
  makeCustomSlug,
  normalizeHex,
  type CanvasTagDef,
} from './tagModel'

// 账号级全局标签数据层: 画布 VM 挂载时调用一次, 卡片胶囊/浮层经模块订阅拿最新值。
// 标签记录随账号走; 卡片只存 slug, 即使库记录拉取失败, 内置 slug 也有前端兜底定义。

const TAGS_API = `${getPocketBaseUrl()}/api/canvas_tags`
const PAGE_SIZE = 200

interface TagsStore {
  version: number
  ownerKey: string
  loaded: boolean
  loading: boolean
  tags: CanvasTagDef[]
  /** 本会话(+localStorage)显式删除的内置 slug, 删除后不再用内置常量兜底显示 */
  deletedBuiltins: Set<string>
}

let store: TagsStore = {
  version: 0,
  ownerKey: '',
  loaded: false,
  loading: false,
  tags: [],
  deletedBuiltins: new Set(),
}
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function bump() {
  store = { ...store, version: store.version + 1 }
  listeners.forEach(fn => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function getVersion(): number {
  return store.version
}

function deletedStorageKey(ownerKey: string): string {
  return `canvas-tag-deleted:${ownerKey}`
}

function loadDeletedBuiltins(ownerKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(deletedStorageKey(ownerKey))
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function rememberDeletedBuiltin(ownerKey: string, slug: string) {
  const next = new Set(loadDeletedBuiltins(ownerKey))
  next.add(slug)
  try {
    localStorage.setItem(deletedStorageKey(ownerKey), JSON.stringify([...next]))
  } catch {
    // localStorage 不可用时仅本会话生效
  }
  store = { ...store, deletedBuiltins: next }
}

function forgetDeletedBuiltin(ownerKey: string, slug: string) {
  const next = loadDeletedBuiltins(ownerKey)
  next.delete(slug)
  try {
    localStorage.setItem(deletedStorageKey(ownerKey), JSON.stringify([...next]))
  } catch {
    // 忽略
  }
  store = { ...store, deletedBuiltins: next }
}

interface TagRow {
  id?: string
  name?: string
  color?: string
  slug?: string
  template?: string
  sort?: number
}

function mapRow(row: TagRow): CanvasTagDef | null {
  if (!row || typeof row.slug !== 'string' || !row.slug) return null
  const color = normalizeHex(typeof row.color === 'string' ? row.color : '')
  if (!color) return null
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : '未命名标签',
    color,
    slug: row.slug,
    template: typeof row.template === 'string' ? row.template : '',
    sort: typeof row.sort === 'number' && Number.isFinite(row.sort) ? row.sort : 0,
  }
}

function isAuthExpired(status: number): boolean {
  return status === 401 || status === 403 || status === 412
}

async function fetchList(): Promise<CanvasTagDef[]> {
  const res = await fetch(`${TAGS_API}?page=1&perPage=${PAGE_SIZE}`, { headers: { ...getAuthHeaders() } })
  if (!res.ok) throw Object.assign(new Error(`list ${res.status}`), { status: res.status })
  const data = (await res.json()) as { items?: TagRow[] }
  const rows = Array.isArray(data.items) ? data.items : []
  return rows.map(mapRow).filter((d): d is CanvasTagDef => !!d)
}

async function postTag(def: Omit<CanvasTagDef, 'id'>): Promise<CanvasTagDef | null> {
  const res = await fetch(TAGS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ name: def.name, color: def.color, slug: def.slug, template: def.template ?? '', sort: def.sort }),
  })
  if (!res.ok) throw Object.assign(new Error(`create ${res.status}`), { status: res.status })
  const row = (await res.json()) as TagRow
  return mapRow({ ...def, ...row })
}

/** 同步读: 已知 slug 的标签定义(先查库, 再查内置常量兜底; 自定义 slug 查不到返回 null) */
export function getTagDefNow(slug: string | null | undefined): CanvasTagDef | null {
  if (!slug) return null
  const live = store.tags.find(t => t.slug === slug)
  if (live) return live
  if (store.deletedBuiltins.has(slug)) return null
  return builtinTagDef(slug)
}

/** 排序后的全部标签(库标签 + 未删除的内置兜底, 按 sort/名称) */
export function allTagsNow(): CanvasTagDef[] {
  const bySlug = new Map<string, CanvasTagDef>()
  store.tags.forEach(t => bySlug.set(t.slug, t))
  CONTENT_TEMPLATE_DEFS.concat(TAG_TEMPLATES.ecommerce.defs).forEach(d => {
    if (!bySlug.has(d.slug) && !store.deletedBuiltins.has(d.slug)) bySlug.set(d.slug, d)
  })
  return [...bySlug.values()].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/** 卡片胶囊等组件订阅标签版本号, 标签增删改后自动重渲染 */
export function useTagsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion)
}

export interface GlobalTagsApi {
  tagsLoading: boolean
  tags: CanvasTagDef[]
  getTagDef: (slug: string | null | undefined) => CanvasTagDef | null
  createTag: (draft: { name: string; color: string }) => Promise<CanvasTagDef | null>
  updateTag: (id: string, patch: { name?: string; color?: string }) => Promise<boolean>
  deleteTag: (id: string) => Promise<boolean>
  applyTemplate: (kind: 'content' | 'ecommerce') => Promise<number>
}

/**
 * 账号级全局标签数据 hook(由画布 VM 调用)。
 * onAuthExpired: 401/403/412 时交回 VM 走全站统一的登录弹窗, hook 内不自己弹框。
 */
export function useGlobalTags(ownerKey: string | null | undefined, onAuthExpired?: () => void): GlobalTagsApi {
  const version = useSyncExternalStore(subscribe, getVersion, getVersion)

  useEffect(() => {
    if (!ownerKey) return
    let cancelled = false
    // 切账号: 重置缓存重新拉取
    if (store.ownerKey !== ownerKey) {
      store = {
        version: store.version + 1,
        ownerKey,
        loaded: false,
        loading: false,
        tags: [],
        deletedBuiltins: loadDeletedBuiltins(ownerKey),
      }
      listeners.forEach(fn => fn())
      inflight = null
    }
    const ensure = async () => {
      if (store.loaded || store.loading) {
        if (store.loading && inflight) await inflight
        return
      }
      store = { ...store, loading: true }
      const job = (async () => {
        try {
          const rows = await fetchList()
          if (cancelled) return
          store = { ...store, tags: rows }
          // 库为空: 首次使用自动注入「内容创作」全套; 失败静默降级为内置常量兜底
          if (rows.length === 0) {
            const seeded: CanvasTagDef[] = []
            for (const def of CONTENT_TEMPLATE_DEFS) {
              try {
                const rec = await postTag(def)
                if (rec) seeded.push(rec)
              } catch {
                // 单条注入失败不阻断其余, 内置常量仍兜底渲染
              }
            }
            if (!cancelled) store = { ...store, tags: seeded }
          }
          if (!cancelled) store = { ...store, loaded: true, loading: false }
        } catch (err) {
          if (!cancelled) {
            const status = (err as { status?: number })?.status
            if (status && isAuthExpired(status)) onAuthExpired?.()
            // 拉取失败不阻塞画布: 内置标签常量照常可用
            store = { ...store, loaded: true, loading: false }
          }
        }
      })()
      inflight = job
      await job
      inflight = null
      if (!cancelled) bump()
    }
    void ensure()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey])

  return useMemo<GlobalTagsApi>(() => {
    void version // 版本号触发 store 快照重建，避免全局 store 变化后返回旧标签列表
    const handleAuthErr = (err: unknown): boolean => {
      const status = (err as { status?: number })?.status
      if (status && isAuthExpired(status)) {
        onAuthExpired?.()
        return true
      }
      return false
    }

    const createTag: GlobalTagsApi['createTag'] = async draft => {
      if (!ownerKey) return null
      const name = draft.name.trim()
      const color = normalizeHex(draft.color)
      if (!name || !color) return null
      const maxSort = store.tags.reduce((m, t) => Math.max(m, t.sort), -1)
      const def = { name, color, slug: makeCustomSlug(), template: '', sort: maxSort + 1 }
      try {
        const rec = (await postTag(def)) ?? { ...def, id: undefined }
        // 服务端未回 id(离线/异常)时也在本地会话中可用, 刷新后由库记录接管
        store = { ...store, tags: [...store.tags, rec] }
        bump()
        return rec
      } catch (err) {
        if (!handleAuthErr(err)) toast.error('标签创建失败, 请重试')
        return null
      }
    }

    const updateTag: GlobalTagsApi['updateTag'] = async (id, patch) => {
      const body: Record<string, string> = {}
      if (patch.name !== undefined) {
        const name = patch.name.trim()
        if (!name) return false
        body.name = name
      }
      if (patch.color !== undefined) {
        const color = normalizeHex(patch.color)
        if (!color) return false
        body.color = color
      }
      try {
        const res = await fetch(`${TAGS_API}/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw Object.assign(new Error(`update ${res.status}`), { status: res.status })
        try {
          const updated = mapRow((await res.json()) as TagRow)
          if (updated?.id) {
            store = { ...store, tags: store.tags.map(t => (t.id === id ? { ...t, ...updated, id: t.id } : t)) }
            bump()
            return true
          }
        } catch {
          // 服务端未回 JSON 时走本地补丁兜底
        }
        store = {
          ...store,
          tags: store.tags.map(t => (t.id === id ? { ...t, color: body.color ?? t.color, name: body.name ?? t.name } : t)),
        }
        bump()
        return true
      } catch (err) {
        if (!handleAuthErr(err)) toast.error('标签保存失败, 请重试')
        return false
      }
    }

    const deleteTag: GlobalTagsApi['deleteTag'] = async id => {
      const target = store.tags.find(t => t.id === id)
      try {
        const res = await fetch(`${TAGS_API}/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { ...getAuthHeaders() },
        })
        if (!res.ok && res.status !== 404) throw Object.assign(new Error(`delete ${res.status}`), { status: res.status })
        if (ownerKey && target && isBuiltinSlug(target.slug)) rememberDeletedBuiltin(ownerKey, target.slug)
        store = {
          ...store,
          tags: store.tags.filter(t => t.id !== id),
          deletedBuiltins: target && isBuiltinSlug(target.slug) ? new Set(store.deletedBuiltins).add(target.slug) : store.deletedBuiltins,
        }
        bump()
        return true
      } catch (err) {
        if (!handleAuthErr(err)) toast.error('标签删除失败, 请重试')
        return false
      }
    }

    const applyTemplate: GlobalTagsApi['applyTemplate'] = async kind => {
      if (!ownerKey) return 0
      const tpl = TAG_TEMPLATES[kind]
      const existingNames = new Set(store.tags.map(t => t.name))
      const missing = tpl.defs.filter(d => !existingNames.has(d.name))
      if (!missing.length) return 0
      let added = 0
      let baseSort = store.tags.reduce((m, t) => Math.max(m, t.sort), -1) + 1
      const nextTags = [...store.tags]
      for (const def of missing) {
        try {
          // 同名缺失说明库记录不存在; 若内置 slug 曾被用户删除后又加模板, 解除删除记忆
          forgetDeletedBuiltin(ownerKey, def.slug)
          const rec = await postTag({ ...def, sort: baseSort })
          if (rec) {
            nextTags.push(rec)
            added += 1
            baseSort += 1
          }
        } catch (err) {
          if (isAuthExpired((err as { status?: number })?.status ?? 0)) {
            onAuthExpired?.()
            return added
          }
        }
      }
      store = { ...store, tags: nextTags }
      bump()
      return added
    }

    return {
      tagsLoading: store.loading,
      tags: allTagsNow(),
      getTagDef: getTagDefNow,
      createTag,
      updateTag,
      deleteTag,
      applyTemplate,
    }
  }, [version, ownerKey, onAuthExpired])
}
