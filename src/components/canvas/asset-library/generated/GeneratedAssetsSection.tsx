import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ImageOff, Loader2, LogIn, RefreshCw, SearchX, Sparkles } from 'lucide-react'
import type { useCanvas } from '@/pages/Canvas/useCanvas'
import { cn } from '@/lib/utils'
import { useGeneratedAssets, MAX_CANVASES } from './useGeneratedAssets'
import {
  copyAssetLink,
  downloadAsset,
  downloadAssetsZip,
  estimateTotalBytes,
  ZIP_COUNT_LIMIT,
  ZIP_SIZE_LIMIT_BYTES,
  type ZipProgress,
} from './assetDownload'
import { saveGeneratedAssets, toastSaveResult } from './saveGeneratedAsset'
import { GeneratedAssetFilters } from './GeneratedAssetFilters'
import { ProjectChips } from './ProjectChips'
import { GeneratedAssetBulkBar } from './GeneratedAssetBulkBar'
import { GeneratedAssetCard } from './GeneratedAssetCard'
import { GeneratedAssetPreviewDialog } from './GeneratedAssetPreviewDialog'
import { ZipConfirmDialog } from './ZipConfirmDialog'
import { ZipProgressBar } from './ZipProgressBar'
import type {
  AssetKindFilter,
  AssetSortOrder,
  GeneratedAsset,
} from './generatedAssetsTypes'

type CanvasVm = ReturnType<typeof useCanvas>
const PAGE_ITEM_COUNT = 60

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-3 gap-2 p-3">
      {Array.from({ length: 9 }).map((_, i) => (
        <div
          key={i}
          className="aspect-square animate-pulse rounded-xl border border-border bg-muted/50"
          style={{ animationDelay: `${i * 60}ms` }}
        />
      ))}
    </div>
  )
}

function LoginEmpty({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-primary">
        <LogIn className="h-6 w-6" />
      </span>
      <p className="text-xs leading-relaxed text-muted-foreground">登录后查看你的全部作品</p>
      <button
        type="button"
        onClick={onLogin}
        className="rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
      >
        去登录
      </button>
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ImageOff className="h-6 w-6" />
      </span>
      <p className="text-xs text-muted-foreground">作品列表加载失败, 请稍后再试</p>
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-card-foreground transition-colors hover:border-primary hover:text-primary"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        重新加载
      </button>
    </div>
  )
}

function NoAssetsEmpty() {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-primary">
        <Sparkles className="h-6 w-6" />
      </span>
      <p className="text-xs leading-relaxed text-muted-foreground">
        还没有生成过任何作品
        <br />
        去画布里生成第一张吧
      </p>
    </div>
  )
}

function NoResultState({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex h-full min-h-56 flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX className="h-6 w-6" />
      </span>
      <p className="text-xs text-muted-foreground">没有符合条件的产物</p>
      <button
        type="button"
        onClick={onClear}
        className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-card-foreground transition-colors hover:border-primary hover:text-primary"
      >
        清除筛选条件
      </button>
    </div>
  )
}

/**
 * 「全部产物」分区: 纯前端聚合视图——
 * 分页拉取全部未删除画布, 展开成功日志产物, 支持筛选/搜索/项目/多选/详情/批量存库与 ZIP 下载。
 */
export function GeneratedAssetsSection({ p }: { p: CanvasVm }) {
  const data = useGeneratedAssets(true)

  const [kindFilter, setKindFilter] = useState<AssetKindFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [projectId, setProjectId] = useState('')
  const [sortOrder, setSortOrder] = useState<AssetSortOrder>('newest')
  const filterKey = [kindFilter, keyword, projectId, sortOrder].join('\0')
  const [visiblePage, setVisiblePage] = useState({ key: filterKey, count: PAGE_ITEM_COUNT })
  const visibleCount = visiblePage.key === filterKey ? visiblePage.count : PAGE_ITEM_COUNT

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set)
  const [savingBulk, setSavingBulk] = useState(false)

  const [previewId, setPreviewId] = useState<string | null>(null)
  const [savingPreview, setSavingPreview] = useState(false)

  const [zipConfirm, setZipConfirm] = useState<{ assets: GeneratedAsset[]; estimatedBytes: number | null } | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [zipProgress, setZipProgress] = useState<ZipProgress | null>(null)
  const cancelZipRef = useRef(false)

  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)

  // 类型数量角标: 基于「项目筛选 + 关键词」后的集合(不受类型 tab 自身影响), 与 chip 语义一致
  const searched = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return data.assets.filter(a => {
      if (projectId && a.canvasId !== projectId) return false
      if (!kw) return true
      return (
        a.prompt.toLowerCase().includes(kw) ||
        a.model.toLowerCase().includes(kw) ||
        a.canvasTitle.toLowerCase().includes(kw) ||
        a.nodeType.toLowerCase().includes(kw)
      )
    })
  }, [data.assets, keyword, projectId])

  const typeCounts = useMemo(
    () => ({
      all: searched.length,
      image: searched.filter(a => a.kind === 'image').length,
      video: searched.filter(a => a.kind === 'video').length,
      audio: searched.filter(a => a.kind === 'audio').length,
    }),
    [searched],
  )

  const filtered = useMemo(() => {
    const list = kindFilter === 'all' ? searched : searched.filter(a => a.kind === kindFilter)
    return sortOrder === 'newest' ? list : [...list].sort((a, b) => a.createdAt - b.createdAt)
  }, [searched, kindFilter, sortOrder])

  // 数据集刷新后, 清掉已不存在的选中项与详情
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setSelectedIds(prev => {
        const next = new Set<string>()
        for (const id of prev) if (data.assets.some(a => a.id === id)) next.add(id)
        return next
      })
      if (previewId && !data.assets.some(a => a.id === previewId)) setPreviewId(null)
    })
    return () => { active = false }
  }, [data.assets, previewId])

  const visibleAssets = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount])

  const previewAsset = useMemo(
    () => (previewId ? filtered.find(a => a.id === previewId) ?? null : null),
    [previewId, filtered],
  )
  const previewIndex = previewAsset ? filtered.findIndex(a => a.id === previewAsset.id) : -1

  function clearFilters() {
    setKindFilter('all')
    setKeyword('')
    setProjectId('')
    setSortOrder('newest')
  }

  function toggleSelect(asset: GeneratedAsset) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(asset.id)) next.delete(asset.id)
      else next.add(asset.id)
      return next
    })
  }

  function selectAllFiltered() {
    setSelectedIds(new Set(filtered.map(a => a.id)))
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  // 选中项在「当前筛选序列」里的映射(批量操作按当前排序)
  const selectedAssets = useMemo(
    () => filtered.filter(a => selectedIds.has(a.id)),
    [filtered, selectedIds],
  )

  async function handleSaveMany(assets: GeneratedAsset[]) {
    if (!assets.length) return
    if (!data.loggedIn) {
      p.setAuthDialog('login')
      return
    }
    try {
      const result = await saveGeneratedAssets(assets)
      if (result.loginRequired) {
        p.setAuthDialog('login')
        return
      }
      toastSaveResult(result)
    } catch {
      toast.error('存入素材库失败, 请稍后重试')
    }
  }

  async function handleSaveOne(asset: GeneratedAsset) {
    if (!data.loggedIn) {
      p.setAuthDialog('login')
      return
    }
    setSavingIds(prev => new Set(prev).add(asset.id))
    try {
      await handleSaveMany([asset])
    } finally {
      setSavingIds(prev => {
        const next = new Set(prev)
        next.delete(asset.id)
        return next
      })
    }
  }

  async function handleSaveSelected() {
    if (savingBulk || selectedAssets.length === 0) return
    setSavingBulk(true)
    try {
      await handleSaveMany(selectedAssets)
      setSelectedIds(new Set())
    } finally {
      setSavingBulk(false)
    }
  }

  async function handleDownloadOne(asset: GeneratedAsset) {
    const ok = await downloadAsset(asset)
    if (ok) toast.success('开始下载')
  }

  function stepPreview(delta: number) {
    if (filtered.length === 0) return
    const cur = previewIndex >= 0 ? previewIndex : 0
    const next = (cur + delta + filtered.length) % filtered.length
    setPreviewId(filtered[next].id)
  }

  async function requestZip(assets: GeneratedAsset[]) {
    if (!assets.length || zipProgress) return
    // 数量超阈值: 先估算体积再弹确认; 数量未超但含视频/音频也轻量探一下, 超 2GB 仍确认
    const overCount = assets.length > ZIP_COUNT_LIMIT
    const hasHeavy = assets.some(a => a.kind !== 'image')
    let estimated: number | null = null
    if (overCount || hasHeavy) {
      setEstimating(true)
      try {
        estimated = await estimateTotalBytes(assets)
      } catch {
        estimated = null
      } finally {
        setEstimating(false)
      }
    }
    if (overCount || (estimated !== null && estimated > ZIP_SIZE_LIMIT_BYTES)) {
      setZipConfirm({ assets, estimatedBytes: estimated })
      return
    }
    void runZip(assets)
  }

  function confirmZip() {
    if (!zipConfirm) return
    const assets = zipConfirm.assets
    setZipConfirm(null)
    void runZip(assets)
  }

  async function runZip(assets: GeneratedAsset[]) {
    cancelZipRef.current = false
    setZipProgress({ done: 0, total: assets.length, failed: 0 })
    toast.loading(`开始打包 ${assets.length} 个文件`)
    const failed = await downloadAssetsZip(assets, {
      onProgress: prog => {
        if (!cancelZipRef.current) setZipProgress(prog)
      },
      shouldContinue: () => !cancelZipRef.current,
    })
    setZipProgress(null)
    if (cancelZipRef.current) {
      toast.message('已取消打包')
      return
    }
    if (failed > 0) toast.warning(`${failed} 个文件下载失败已跳过, 其余已打包`)
    else toast.success('打包完成, 已开始下载')
  }

  const hasAnyFilter = kindFilter !== 'all' || !!keyword.trim() || !!projectId

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-2.5">
        <h2 className="text-sm font-semibold text-card-foreground">全部产物</h2>
        <span className="text-[11px] text-muted-foreground">{data.assets.length} 项</span>
        <div className="flex-1" />
        <button
          type="button"
          title="重新聚合所有画布的产物"
          onClick={data.refresh}
          disabled={data.loading || data.refreshing}
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-primary disabled:opacity-50"
        >
          <RefreshCw className={cn('h-4 w-4', data.refreshing && 'animate-spin')} />
        </button>
      </div>

      {data.loggedIn && data.assets.length > 0 && (
        <>
          <GeneratedAssetFilters
            kindFilter={kindFilter}
            onKindChange={setKindFilter}
            keyword={keyword}
            onKeywordChange={setKeyword}
            sortOrder={sortOrder}
            onSortChange={setSortOrder}
            counts={typeCounts}
          />
          <ProjectChips assets={searched} selectedProjectId={projectId} onSelect={setProjectId} />
        </>
      )}

      {selectedAssets.length > 0 && (
        <GeneratedAssetBulkBar
          selectedCount={selectedAssets.length}
          resultCount={filtered.length}
          saving={savingBulk}
          packing={!!zipProgress}
          onSelectAll={selectAllFiltered}
          onSaveSelected={() => void handleSaveSelected()}
          onZipSelected={() => void requestZip(selectedAssets)}
          onCancel={clearSelection}
        />
      )}

      <div ref={setScrollRoot} className="relative min-h-0 flex-1 overflow-y-auto">
        {!data.loggedIn ? (
          <LoginEmpty onLogin={() => p.setAuthDialog('login')} />
        ) : data.loading && data.assets.length === 0 ? (
          <SkeletonGrid />
        ) : data.error && data.assets.length === 0 ? (
          <ErrorState onRetry={data.refresh} />
        ) : !data.loading && data.assets.length === 0 && !data.error ? (
          <NoAssetsEmpty />
        ) : filtered.length === 0 ? (
          <NoResultState onClear={clearFilters} />
        ) : (
          <div className="grid grid-cols-3 gap-2 p-3">
            {visibleAssets.map(asset => (
              <GeneratedAssetCard
                key={asset.id}
                asset={asset}
                selected={selectedIds.has(asset.id)}
                busy={savingIds.has(asset.id)}
                scrollRoot={scrollRoot}
                onOpen={a => setPreviewId(a.id)}
                onToggleSelect={toggleSelect}
                onSave={a => void handleSaveOne(a)}
                onCopyLink={a => void copyAssetLink(a)}
                onDownload={a => void handleDownloadOne(a)}
              />
            ))}
          </div>
        )}

        {!data.loading && filtered.length > visibleCount && (
          <div className="flex justify-center pb-3 pt-1">
            <button
              type="button"
              onClick={() => setVisiblePage({ key: filterKey, count: visibleCount + PAGE_ITEM_COUNT })}
              className="h-8 rounded-lg border border-border bg-card px-4 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              加载更多(剩余 {filtered.length - visibleCount} 项)
            </button>
          </div>
        )}

        {data.refreshing && data.assets.length > 0 && (
          <div className="pointer-events-none sticky bottom-2 flex justify-center">
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground shadow-md">
              <Loader2 className="h-3 w-3 animate-spin text-primary" />
              正在刷新…
            </span>
          </div>
        )}
      </div>

      {data.truncated && (
        <div className="shrink-0 border-t border-border/70 px-3 py-1.5">
          <p className="text-[10px] text-muted-foreground">仅显示最近 {MAX_CANVASES} 个项目的产物</p>
        </div>
      )}
      {data.loggedIn && !data.truncated && data.assets.length > 0 && (
        <div className="shrink-0 border-t border-border/70 px-3 py-1.5">
          <p className="text-[10px] text-muted-foreground">
            来自 {data.canvasesCount} 个项目{hasAnyFilter ? ` · 筛选出 ${filtered.length} 项` : ''}
          </p>
        </div>
      )}

      {zipProgress && (
        <ZipProgressBar
          progress={zipProgress}
          onCancel={() => {
            cancelZipRef.current = true
          }}
        />
      )}

      <ZipConfirmDialog
        open={!!zipConfirm}
        count={zipConfirm?.assets.length ?? 0}
        estimatedBytes={zipConfirm?.estimatedBytes ?? null}
        estimating={estimating}
        onCancel={() => setZipConfirm(null)}
        onConfirm={confirmZip}
      />

      <GeneratedAssetPreviewDialog
        asset={previewAsset}
        index={previewIndex < 0 ? 0 : previewIndex}
        total={filtered.length}
        saving={savingPreview}
        onClose={() => setPreviewId(null)}
        onPrev={() => stepPreview(-1)}
        onNext={() => stepPreview(1)}
        onSave={async asset => {
          setSavingPreview(true)
          try {
            await handleSaveOne(asset)
          } finally {
            setSavingPreview(false)
          }
        }}
        onCopyLink={a => void copyAssetLink(a)}
        onDownload={a => void handleDownloadOne(a)}
      />
    </div>
  )
}
