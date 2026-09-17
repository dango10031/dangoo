import { useEffect, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Film,
  Loader2,
  Music,
  Save,
} from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { getBasename } from '@/lib/pb'
import { mediaSrc } from '@/lib/media'
import { toast } from 'sonner'
import {
  formatAssetTime,
  formatRunDuration,
  KIND_LABEL,
  type GeneratedAsset,
} from './generatedAssetsTypes'

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className="flex items-start gap-2 text-xs leading-5">
      <span className="w-14 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-card-foreground">{value}</span>
    </div>
  )
}

/** 「全部产物」全屏预览: 左主区播放/大图, 右信息栏, 底部操作, 左右切换上一个/下一个 */
export function GeneratedAssetPreviewDialog({
  asset,
  index,
  total,
  saving,
  onClose,
  onPrev,
  onNext,
  onSave,
  onCopyLink,
  onDownload,
}: {
  asset: GeneratedAsset | null
  index: number
  total: number
  saving: boolean
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onSave: (asset: GeneratedAsset) => void
  onCopyLink: (asset: GeneratedAsset) => void
  onDownload: (asset: GeneratedAsset) => void
}) {
  const src = asset ? mediaSrc(asset.url) : undefined
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null)
  const copiedPrompt = !!asset && copiedPromptId === asset.id

  useEffect(() => {
    if (!asset) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') onPrev()
      if (e.key === 'ArrowRight') onNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [asset, onPrev, onNext])

  async function copyPrompt() {
    if (!asset?.prompt) return
    try {
      await navigator.clipboard.writeText(asset.prompt)
      setCopiedPromptId(asset.id)
      toast.success('提示词已复制')
      setTimeout(() => setCopiedPromptId(current => current === asset.id ? null : current), 1500)
    } catch {
      toast.error('复制失败, 请手动复制')
    }
  }

  function openProject() {
    if (!asset) return
    const base = getBasename()
    window.open(`${base === '/' ? '' : base}/canvas/${asset.canvasId}`, '_blank', 'noopener,noreferrer')
  }

  return (
    <Dialog open={!!asset} onOpenChange={v => !v && onClose()}>
      <DialogContent className="flex max-h-[88vh] w-[min(960px,94vw)] flex-col gap-0 overflow-hidden border-border bg-card p-0 sm:rounded-2xl md:flex-row">
        {asset && (
          <>
            {/* 左主区 */}
            <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/85 p-4 md:min-h-[60vh]">
              {asset.kind === 'image' && (
                <img
                  src={src}
                  alt={asset.prompt || '生成图片'}
                  className="max-h-[55vh] w-auto max-w-full rounded-lg object-contain shadow-xl md:max-h-[78vh]"
                />
              )}
              {asset.kind === 'video' && (
                <video
                  src={src}
                  controls
                  autoPlay
                  className="max-h-[55vh] w-full max-w-full rounded-lg shadow-xl md:max-h-[78vh]"
                />
              )}
              {asset.kind === 'audio' && (
                <div className="flex w-full max-w-md flex-col items-center gap-6 py-10">
                  <span className="flex h-24 w-24 items-center justify-center rounded-full bg-primary/15 text-primary shadow-inner">
                    <Music className="h-11 w-11" />
                  </span>
                  <audio src={src} controls autoPlay className="w-full" />
                  <p className="text-xs text-white/70">{asset.prompt || '语音作品'}</p>
                </div>
              )}

              {total > 1 && (
                <>
                  <button
                    type="button"
                    onClick={onPrev}
                    title="上一个(←)"
                    className="absolute left-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-primary"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={onNext}
                    title="下一个(→)"
                    className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-primary"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </>
              )}
            </div>

            {/* 右信息栏 */}
            <div className="flex w-full shrink-0 flex-col gap-3 border-t border-border p-4 md:w-72 md:border-l md:border-t-0">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-card-foreground">
                {asset.kind === 'video' ? (
                  <Film className="h-4 w-4 text-primary" />
                ) : (
                  <Music className="h-4 w-4 text-primary" />
                )}
                {KIND_LABEL[asset.kind]}详情
                <span className="ml-auto text-xs font-normal text-muted-foreground">
                  {index + 1} / {total}
                </span>
              </div>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                <div className="flex items-start gap-2 text-xs leading-5">
                  <span className="w-14 shrink-0 text-muted-foreground">所属项目</span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium text-card-foreground">{asset.canvasTitle}</p>
                    <button
                      type="button"
                      onClick={openProject}
                      className="mt-0.5 inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      打开项目
                    </button>
                  </div>
                </div>
                <InfoRow label="节点类型" value={asset.nodeType} />
                <InfoRow label="模型" value={asset.model} />
                <InfoRow label="生成时间" value={formatAssetTime(asset.createdAt)} />
                <InfoRow label="耗时" value={formatRunDuration(asset.runMs)} />
                <InfoRow label="费用" value={asset.costText} />

                <div className="flex items-start gap-2 pt-1 text-xs leading-5">
                  <span className="w-14 shrink-0 pt-0.5 text-muted-foreground">提示词</span>
                  <div className="min-w-0 flex-1">
                    <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-2 text-card-foreground">
                      {asset.prompt || '（无提示词记录）'}
                    </p>
                    {asset.prompt && (
                      <button
                        type="button"
                        onClick={() => void copyPrompt()}
                        className="mt-1 inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-primary"
                      >
                        {copiedPrompt ? '已复制' : (
                          <>
                            <Copy className="h-3 w-3" />
                            复制提示词
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* 底部操作 */}
              <div className="flex shrink-0 items-center gap-2 border-t border-border pt-3">
                <button
                  type="button"
                  onClick={() => onDownload(asset)}
                  className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-border bg-card px-2 py-2 text-xs font-medium text-card-foreground transition-colors hover:border-primary hover:text-primary"
                >
                  <Download className="h-3.5 w-3.5" />
                  下载
                </button>
                <button
                  type="button"
                  onClick={() => onCopyLink(asset)}
                  className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-border bg-card px-2 py-2 text-xs font-medium text-card-foreground transition-colors hover:border-primary hover:text-primary"
                >
                  <Copy className="h-3.5 w-3.5" />
                  复制链接
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => onSave(asset)}
                  className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary px-2 py-2 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  存素材库
                </button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
