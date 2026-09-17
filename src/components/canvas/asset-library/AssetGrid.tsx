import { useRef, useState } from 'react'
import { ImagePlus, Loader2, Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { useCanvas } from '@/pages/Canvas/useCanvas'
import { ASSET_DND_CARD, type AssetLibEntry } from './assetLib'
import { AssetGridCard } from './AssetGridCard'
import { PresetWorkflowCard, WorkflowGridCard } from './WorkflowGridCard'

type CanvasVm = ReturnType<typeof useCanvas>
type Scope = 'project' | 'global'
export type AssetGridMode = 'images' | 'workflows'

/**
 * 资产网格 + 放区: 正方形缩略图网格;
 * 图片页签空态虚线引导「选中后点上方按钮保存」(2026-09 卡片拖柄已移除, 统一走头部保存按钮);
 * 工作流页签只展示工作流卡, 不接收卡片拖入(工作流只能由头部按钮保存)。
 */
export function AssetGrid({
  p,
  scope,
  folderId,
  entries,
  loading,
  mode = 'images',
  hasMore = false,
  loadingMore = false,
  onLoadMore,
}: {
  p: CanvasVm
  scope: Scope
  folderId: string
  entries: AssetLibEntry[]
  loading: boolean
  mode?: AssetGridMode
  /** 全局库服务端还有更多页(项目库内嵌随画布走, 不传) */
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const depthRef = useRef(0)
  const busyRef = useRef(false)
  const workflowMode = mode === 'workflows'

  function isCardDrag(e: React.DragEvent) {
    return !workflowMode && Array.from(e.dataTransfer?.types ?? []).includes(ASSET_DND_CARD)
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    depthRef.current = 0
    setDragOver(false)
    if (busyRef.current || workflowMode) return
    let cardIds: string[] | undefined
    try {
      const payload = JSON.parse(e.dataTransfer.getData(ASSET_DND_CARD) || '{}') as { cardIds?: string[] }
      cardIds = Array.isArray(payload.cardIds) ? payload.cardIds : undefined
    } catch {
      cardIds = undefined
    }
    if (!cardIds?.length) return
    busyRef.current = true
    try {
      await p.handleDropCardsToLibrary(cardIds, scope, folderId)
    } finally {
      busyRef.current = false
    }
  }

  const empty = entries.length === 0

  return (
    <div
      ref={setScrollRoot}
      className="relative min-h-0 flex-1 overflow-y-auto p-3"
      onDragEnter={e => {
        if (!isCardDrag(e)) return
        e.preventDefault()
        depthRef.current += 1
        setDragOver(true)
      }}
      onDragOver={e => {
        if (!isCardDrag(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        depthRef.current = Math.max(0, depthRef.current - 1)
        if (depthRef.current === 0) setDragOver(false)
      }}
      onDrop={handleDrop}
    >
      {loading ? (
        <div className="flex h-32 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          <span className="text-xs">加载中…</span>
        </div>
      ) : empty ? (
        workflowMode ? (
          <div className="flex h-full min-h-56 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border/80 bg-muted/20 p-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Workflow className="h-6 w-6" />
            </span>
            <p className="text-xs leading-relaxed text-muted-foreground">
              在画布上选中一组连了线的节点
              <br />
              点上方「保存选中节点为工作流」
            </p>
          </div>
        ) : (
          <div
            className={cn(
              'flex h-full min-h-56 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center transition-colors',
              dragOver ? 'border-primary bg-primary/10' : 'border-border/80 bg-muted/20',
            )}
          >
            <span className={cn('flex h-12 w-12 items-center justify-center rounded-full transition-colors', dragOver ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
              <ImagePlus className="h-6 w-6" />
            </span>
            <p className="text-xs leading-relaxed text-muted-foreground">
              选中画布上的图片或视频
              <br />
              点上方「保存选中节点为资产」存入这里
            </p>
          </div>
        )
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {entries.map(entry =>
            workflowMode ? (
              entry.preset ? (
                <PresetWorkflowCard key={entry.key} entry={entry} />
              ) : (
                <WorkflowGridCard key={entry.key} p={p} entry={entry} />
              )
            ) : (
              <AssetGridCard key={entry.key} p={p} entry={entry} scrollRoot={scrollRoot} />
            ),
          )}
        </div>
      )}

      {/* 全局库服务端分页: 非空且还有下一页时显示加载更多(项目库内嵌随画布走, 不分页) */}
      {!loading && !empty && hasMore && onLoadMore && (
        <div className="flex justify-center pt-3">
          <button
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
            className="h-8 rounded-lg border border-border bg-card px-4 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-60"
          >
            {loadingMore ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}

      {dragOver && !empty && (
        <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-[1px]">
          <p className="rounded-full bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground shadow-lg">
            松手保存到{folderId ? '当前文件夹' : scope === 'project' ? '项目资产库' : '全局资产库'}
          </p>
        </div>
      )}
    </div>
  )
}
