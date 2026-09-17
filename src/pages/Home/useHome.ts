import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { getPocketBaseUrl } from "@/lib/pb"
import { getAuthHeaders } from "@/lib/auth"
import { getLocalAccount, onLocalAccountChange, type LocalAccount } from "@/lib/localAuth"
import {
  buildProjectZip,
  downloadProjectBlob,
  extractExportedCanvases,
  rehostExternalMedia,
  unpackProjectZip,
  type PackedCanvas,
} from "@/lib/projectPack"

/** 与 PB canvases collection 字段一一对应 (snake_case, 禁改名) */
export interface CanvasRecord {
  id: string
  title: string
  is_deleted: boolean
  thumbnail_url: string
  canvas_data: CanvasData | null
  created: string
  updated: string
}

export interface CanvasData {
  version: number
  cards: unknown[]
  [key: string]: unknown
}

const API_BASE = `${getPocketBaseUrl()}/api/canvases`

function freshCanvasData(): CanvasData {
  return { version: 1, cards: [] }
}

/** 老版 JSON 导入的防护上限 */
const MAX_JSON_FILE_BYTES = 64 * 1024 * 1024
const MAX_IMPORT_CANVASES = 200
const MAX_CARDS_PER_CANVAS = 2000

/** 异常画布文档的安全兜底 */
function safeEmptyDocument(): Record<string, unknown> {
  return { version: 1, cards: [], connections: [], view: { x: 0, y: 0, scale: 1 } }
}

/** 必须是普通对象(非 null / 非数组 / 非 Date 等)才允许直接入库, 否则替换成安全空文档 */
function isPlainDocument(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
}

/**
 * 老版 JSON 结构防护: 校验并就地规整画布数据。
 * canvas_data 非普通对象 -> 安全空文档; cards/connections/logs/pendingJobs 非数组 -> 空数组。
 * 返回 false 表示某个画布卡片数超限, 整个导入应拒绝。
 */
function sanitizeIncomingCanvases(canvases: PackedCanvas[]): boolean {
  for (const canvas of canvases) {
    if (!isPlainDocument(canvas.canvas_data)) {
      canvas.canvas_data = safeEmptyDocument()
      continue
    }
    const doc = canvas.canvas_data
    // cards 必须存在且为数组, 缺失或类型不对都补空数组
    if (!Array.isArray(doc.cards)) doc.cards = []
    for (const key of ["connections", "logs", "pendingJobs"] as const) {
      if (key in doc && !Array.isArray(doc[key])) doc[key] = []
    }
    if ((doc.cards as unknown[]).length > MAX_CARDS_PER_CANVAS) return false
  }
  return true
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    ...init,
  })
  if (!res.ok) {
    let msg = "操作失败, 请稍后再试"
    try {
      const body = await res.json()
      if (body && typeof body.message === "string" && body.message) msg = body.message
    } catch {
      /* 保留默认文案 */
    }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export function useHome() {
  const navigate = useNavigate()

  const [canvasList, setCanvasList] = useState<CanvasRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [canLoadMore, setCanLoadMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // 站内账号 / 钱包
  const [account, setAccount] = useState<LocalAccount | null>(() => getLocalAccount())
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const [walletAdmin, setWalletAdmin] = useState(false)
  const [authDialog, setAuthDialog] = useState<null | "login" | "recharge">(null)

  useEffect(() => {
    return onLocalAccountChange((acc) => {
      setAccount(acc)
      if (!acc) {
        setWalletBalance(null)
        setWalletAdmin(false)
      }
    })
  }, [])

  const refreshWallet = useCallback(async () => {
    if (!getLocalAccount()) {
      setWalletBalance(null)
      setWalletAdmin(false)
      return
    }
    try {
      const res = await fetch(`${getPocketBaseUrl()}/api/wallet/me`, { headers: { ...getAuthHeaders() } })
      if (res.status === 401) {
        setWalletBalance(null)
        return
      }
      const data = (await res.json()) as { ok?: boolean; balance?: number; is_admin?: boolean }
      if (data.ok) {
        setWalletBalance(typeof data.balance === "number" ? data.balance : 0)
        setWalletAdmin(!!data.is_admin)
      }
    } catch {
      /* 钱包拉取失败不阻塞 */
    }
  }, [])

  useEffect(() => {
    Promise.resolve().then(refreshWallet)
  }, [account?.id, refreshWallet])

  const handleAuthSuccess = useCallback(() => {
    setAccount(getLocalAccount())
    setAuthDialog(null)
    void refreshWallet()
  }, [refreshWallet])

  const openRecharge = useCallback(() => {
    if (!getLocalAccount()) {
      setAuthDialog("login")
      return
    }
    setAuthDialog("recharge")
  }, [])

  const [trashOpen, setTrashOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<CanvasRecord | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [renaming, setRenaming] = useState(false)

  const activeCanvases = useMemo(
    () => canvasList.filter((c) => !c.is_deleted),
    [canvasList],
  )
  const trashCanvases = useMemo(
    () => canvasList.filter((c) => c.is_deleted),
    [canvasList],
  )

  const CANVAS_PAGE_SIZE = 50
  const canvasesPageRef = useRef(1)

  const loadCanvases = useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)
    canvasesPageRef.current = 1
    try {
      const data = await apiFetch<{ items: CanvasRecord[]; totalItems?: number; totalPages?: number }>(
        `?page=1&perPage=${CANVAS_PAGE_SIZE}`,
      )
      const items = Array.isArray(data.items) ? data.items : []
      setCanvasList(items)
      setCanLoadMore(typeof data.totalPages === "number" ? data.totalPages > 1 : items.length >= CANVAS_PAGE_SIZE)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "画布列表加载失败")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const loadMoreCanvases = useCallback(async () => {
    if (loadingMore || !canLoadMore) return
    setLoadingMore(true)
    try {
      const nextPage = canvasesPageRef.current + 1
      const data = await apiFetch<{ items: CanvasRecord[]; totalPages?: number }>(
        `?page=${nextPage}&perPage=${CANVAS_PAGE_SIZE}`,
      )
      const items = Array.isArray(data.items) ? data.items : []
      canvasesPageRef.current = nextPage
      setCanvasList((prev) => {
        const seen = new Set(prev.map((c) => c.id))
        return [...prev, ...items.filter((c) => !seen.has(c.id))]
      })
      setCanLoadMore(typeof data.totalPages === "number" ? nextPage < data.totalPages : items.length >= CANVAS_PAGE_SIZE)
    } catch {
      toast.error("加载更多失败, 请稍后重试")
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, canLoadMore])

  useEffect(() => {
    Promise.resolve().then(loadCanvases)
  }, [loadCanvases])

  const createCanvas = useCallback(async () => {
    if (creating) return
    if (!getLocalAccount()) {
      setAuthDialog("login")
      toast.message("请先登录后再新建画布")
      return
    }
    setCreating(true)
    try {
      const record = await apiFetch<CanvasRecord>("", {
        method: "POST",
        body: JSON.stringify({
          title: "未命名画布",
          is_deleted: false,
          thumbnail_url: "",
          canvas_data: freshCanvasData(),
        }),
      })
      toast.success("新画布已创建")
      navigate(`/canvas/${record.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建画布失败")
      setCreating(false)
    }
  }, [creating, navigate])

  const openCanvas = useCallback(
    async (canvas: CanvasRecord) => {
      navigate(`/canvas/${canvas.id}`)
      try {
        // 轻触一下记录, 让「最后更新」反映最近打开时间
        await apiFetch<CanvasRecord>(`/${canvas.id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: canvas.title }),
        })
      } catch {
        /* 打开不受影响 */
      }
    },
    [navigate],
  )

  const startRename = useCallback((canvas: CanvasRecord) => {
    setRenameTarget(canvas)
    setRenameValue(canvas.title)
  }, [])

  const submitRename = useCallback(async () => {
    if (!renameTarget || renaming) return
    const nextTitle = renameValue.trim()
    if (!nextTitle) {
      toast.error("画布名称不能为空")
      return
    }
    setRenaming(true)
    try {
      const updated = await apiFetch<CanvasRecord>(`/${renameTarget.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: nextTitle }),
      })
      setCanvasList((prev) =>
        prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)),
      )
      toast.success("已重命名")
      setRenameTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重命名失败")
    } finally {
      setRenaming(false)
    }
  }, [renameTarget, renameValue, renaming])

  const moveToTrash = useCallback(async (canvas: CanvasRecord) => {
    setBusyId(canvas.id)
    try {
      const updated = await apiFetch<CanvasRecord>(`/${canvas.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_deleted: true }),
      })
      setCanvasList((prev) =>
        prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)),
      )
      toast.success("已移入回收站")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    } finally {
      setBusyId(null)
    }
  }, [])

  const restoreCanvas = useCallback(async (canvas: CanvasRecord) => {
    setBusyId(canvas.id)
    try {
      const updated = await apiFetch<CanvasRecord>(`/${canvas.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_deleted: false }),
      })
      setCanvasList((prev) =>
        prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)),
      )
      toast.success("画布已恢复")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "恢复失败")
    } finally {
      setBusyId(null)
    }
  }, [])

  const purgeCanvas = useCallback(async (canvas: CanvasRecord) => {
    setBusyId(canvas.id)
    try {
      await apiFetch<{ ok: boolean }>(`/${canvas.id}`, { method: "DELETE" })
      setCanvasList((prev) => prev.filter((c) => c.id !== canvas.id))
      toast.success("已彻底删除")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "彻底删除失败")
    } finally {
      setBusyId(null)
    }
  }, [])

  // 导出: zip 打包全部画布结构 + 缩略图 + 原图文件(自包含, 离线可携带)
  const exportingRef = useRef(false)
  const exportProject = useCallback(async () => {
    if (activeCanvases.length === 0) {
      toast.error("还没有可导出的画布")
      return
    }
    if (exportingRef.current) return
    exportingRef.current = true
    const toastId = toast.loading("正在打包画布与图片…")
    try {
      const blob = await buildProjectZip(
        activeCanvases.map((c) => ({
          title: c.title,
          thumbnail_url: c.thumbnail_url,
          canvas_data: c.canvas_data,
        })),
        ({ done, total }) => {
          if (total > 0) {
            toast.loading(`正在打包图片 ${done}/${total}`, { id: toastId })
          }
        },
      )
      const now = new Date()
      const pad = (n: number) => String(n).padStart(2, "0")
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
      downloadProjectBlob(blob, `canvas-project-${stamp}.zip`)
      toast.success("项目已导出(含全部原图)", { id: toastId })
    } catch {
      toast.error("导出失败, 请稍后再试", { id: toastId })
    } finally {
      exportingRef.current = false
    }
  }, [activeCanvases])

  // 导入: zip(新版, 含原图文件)或 JSON(老版导出文件)均可
  const importProjectFile = useCallback(
    async (file: File) => {
      let toastId: string | number | undefined
      try {
        const isZip = /\.zip$/i.test(file.name) || file.type.includes("zip")
        let incoming: PackedCanvas[]
        // 老版 JSON 的外链转存失败数; zip 分支沿用其内部静默回退策略
        let mediaFailedCount = 0
        if (isZip) {
          toastId = toast.loading("正在解压并导入项目…")
          incoming = await unpackProjectZip(file, ({ done, total }) => {
            toast.loading(`正在上传图片 ${done}/${total}`, { id: toastId })
          })
        } else {
          // 读取前先挡超大文件, 避免把几十 MB 文本灌进内存
          if (file.size > MAX_JSON_FILE_BYTES) {
            toast.error("项目文件过大（上限 64MB），请拆分后导入")
            return
          }
          const text = await file.text()
          incoming = extractExportedCanvases(JSON.parse(text))
          if (incoming.length > MAX_IMPORT_CANVASES) {
            toast.error("项目包含画布过多（上限 200 个）")
            return
          }
          if (!sanitizeIncomingCanvases(incoming)) {
            toast.error("单个画布内容过多（上限 2000 个卡片）")
            return
          }
          // 老版 JSON 里的平台临时链接 24 小时即过期, 入库前把外链统一转存为永久链接
          toastId = toast.loading("正在转存图片…")
          const rehosted = await rehostExternalMedia(incoming, ({ done, total }) => {
            if (total > 0) toast.loading(`正在转存图片 ${done}/${total}`, { id: toastId })
          })
          incoming = rehosted.canvases
          mediaFailedCount = rehosted.failedCount
        }
        const valid = incoming.filter(
          (item) => item && typeof item.title === "string" && item.title.trim(),
        )
        if (valid.length === 0) {
          toast.error("文件里没有可导入的画布", toastId ? { id: toastId } : undefined)
          return
        }
        setCreating(true)
        const created = await Promise.all(
          valid.map((item) =>
            apiFetch<CanvasRecord>("", {
              method: "POST",
              body: JSON.stringify({
                title: item.title.trim().slice(0, 120),
                is_deleted: false,
                thumbnail_url:
                  typeof item.thumbnail_url === "string"
                    ? item.thumbnail_url.slice(0, 500)
                    : "",
                canvas_data:
                  item.canvas_data && typeof item.canvas_data === "object"
                    ? item.canvas_data
                    : freshCanvasData(),
              }),
            }),
          ),
        )
        setCanvasList((prev) => [...created, ...prev])
        toast.success(`已导入 ${created.length} 个画布`, toastId ? { id: toastId } : undefined)
        if (mediaFailedCount > 0) {
          const loginHint = getLocalAccount() ? "" : "，请先登录后重试"
          toast.warning(
            `已导入 ${created.length} 个画布，${mediaFailedCount} 个图片/媒体转存失败，可能在 24 小时后无法显示，请重新生成或替换${loginHint}`,
          )
        }
      } catch (err) {
        // 压缩包防护抛出的 SyntaxError 带中文拒绝原因, 直接展示; JSON.parse 失败仍是「文件格式不对」
        const isChineseSyntaxError =
          err instanceof SyntaxError && !!err.message && /[一-鿿]/.test(err.message)
        toast.error(
          isChineseSyntaxError
            ? err.message
            : err instanceof SyntaxError
              ? "文件格式不对, 请选择项目导出的文件"
              : err instanceof Error
                ? err.message
                : "导入失败",
          toastId ? { id: toastId } : undefined,
        )
      } finally {
        setCreating(false)
      }
    },
    [],
  )

  return {
    activeCanvases,
    trashCanvases,
    isLoading,
    loadingMore,
    canLoadMore,
    loadMoreCanvases,
    loadError,
    creating,
    busyId,
    trashOpen,
    setTrashOpen,
    renameTarget,
    renameValue,
    setRenameValue,
    renaming,
    createCanvas,
    openCanvas,
    startRename,
    submitRename,
    cancelRename: () => setRenameTarget(null),
    moveToTrash,
    restoreCanvas,
    purgeCanvas,
    exportProject,
    importProjectFile,
    reload: loadCanvases,
    // 账号 / 钱包 / 弹窗
    account,
    setAccount,
    walletBalance,
    walletAdmin,
    refreshWallet,
    authDialog,
    setAuthDialog,
    handleAuthSuccess,
    openRecharge,
  }
}
