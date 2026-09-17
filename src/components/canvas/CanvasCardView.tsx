import { memo, useEffect, useRef, useState } from 'react'
import { useLatestRef } from '@/hooks/useLatestRef'
import {
  AudioLines,
  Blend,
  Bot,
  Brush,
  Clapperboard,
  Camera,
  Copy,
  Crop,
  Download,
  Eye,
  FolderPlus,
  ImageOff,
  Layers,
  LayoutGrid,
  LayoutTemplate,
  Loader2,
  PersonStanding,
  Plus,
  RefreshCw,
  Repeat,
  Scissors,
  Sparkles,
  StickyNote,
  Trash2,
  Video,
  Wand2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { RefThumbRow } from '@/components/canvas/NodeBarShared'
import { useLod } from '@/components/canvas/useLod'
import { AgentNodeBody } from '@/components/canvas/AgentNodeBody'
import { LoopNodeBody } from '@/components/canvas/LoopNodeBody'
import { LayerNodeBody } from '@/components/canvas/LayerNodeBody'
import { MergeNodeBody } from '@/components/canvas/MergeNodeBody'
import { ReplicateNodeBody } from '@/components/canvas/ReplicateNodeBody'
import { TtsNodeBody } from '@/components/canvas/TtsNodeBody'
import { MotionNodeBody } from '@/components/canvas/MotionNodeBody'
import { VsrNodeBody } from '@/components/canvas/VsrNodeBody'
import { PolishNodeBody } from '@/components/canvas/PolishNodeBody'
import { CameraNodeBody } from '@/components/canvas/CameraNodeBody'
import { CardExportDock } from '@/components/canvas/CardExportDock'
import { TagMenuButton } from '@/components/canvas/tags/TagMenuButton'
import { CardTagPill } from '@/components/canvas/tags/CardTagPill'
import { GenerateNodeResults } from '@/components/canvas/GenerateNodeResults'
import { MODEL_LABELS } from '@/pages/Canvas/useCanvas'
import type { CanvasCardData } from '@/pages/Canvas/useCanvas'
import type { ConnectionSide, RepSlot } from '@/pages/Canvas/canvasTypes'
import { useCanvasVm } from '@/components/canvas/canvasRuntime'
import { mediaSrc } from '@/lib/media'

const KIND_LABEL: Record<CanvasCardData['kind'], string> = {
  prompt: '提示词节点',
  generate: '生成节点',
  result: '结果卡',
  video: '视频卡',
  layer: '图片分层节点',
  replicate: '图片复刻节点',
  polish: '润色节点',
  agent: 'Agent 节点',
  loop: '循环节点',
  merge: '图像融合节点',
  tts: '语音克隆节点',
  motion: '动作迁移节点',
  vsr: '视频高清修复节点',
  camera: '摄影机节点',
}

function CardActionButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}

/**
 * LOD 换档 / 本地预览换云端地址时, 旧图保持显示直到新图加载完成再替换, 全程无空白闪烁。
 * 放大切回原图时若原始 URL 临时加载失败(签名波动等), 按 fallbacks(320→96 缓存缩略图)逐级兜底,
 * 不再直接显示裂图; 链中每一级都先预加载成功才替换。
 */
function LodImg({
  src,
  fallback,
  fallbacks,
  alt,
  className,
  style,
  onDoubleClick,
}: {
  src?: string
  fallback?: string
  fallbacks?: string[]
  alt: string
  className: string
  style?: React.CSSProperties
  onDoubleClick?: (e: React.MouseEvent<HTMLImageElement>) => void
}) {
  const [shown, setShown] = useState(src || fallback)
  // 回退链每渲染引用可能不同, 经 ref 读取, effect 只在主 src 变化(换档/换图)时重走
  const chainRef = useLatestRef([src, ...(fallbacks ?? []), fallback].filter((u): u is string => !!u))
  useEffect(() => {
    let alive = true
    let i = 0
    const tryNext = () => {
      const u = chainRef.current[i]
      if (!u) return
      const im = new Image()
      im.onload = () => {
        if (alive) setShown(u)
      }
      im.onerror = () => {
        if (alive) {
          i += 1
          if (i < chainRef.current.length) tryNext()
        }
      }
      im.src = u
    }
    tryNext()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])
  return (
    <img
      src={shown}
      alt={alt}
      className={className}
      style={style}
      draggable={false}
      onDoubleClick={onDoubleClick}
    />
  )
}

/** 生成节点自带图片位已并入生成条缩略图行, 未选中时卡片只显示图片本身 */

function CanvasCardViewImpl({ card, selected, scale, tiny, slotHover = null, snapHover = null }: { card: CanvasCardData; selected: boolean; scale: number; tiny?: boolean; slotHover?: { cardId: string; slot: RepSlot } | null; snapHover?: ConnectionSide | null }) {
  // 视图模型走稳定上下文(ref), 卡片只在 card/selected/缩放档位 变化时重渲染, 平移/拖其他卡不重渲染。
  // scale 是三档值(0.25/0.65/1)而非连续缩放, 滚轮连续缩放停顿时不会再让全部可见卡整卡重渲染;
  // tiny 是精确的 ≤35% 布尔, 只驱动点击热区外扩, 变化频次同样只有跨阈值一次。
  const p = useCanvasVm()
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const uploadPressedRef = useRef(false)
  const uploadStartRef = useRef<{ x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  // 真实渲染尺寸由舞台统一的几何注册表观测回写, 每卡不再自建 ResizeObserver
  // 连线加号端口: 选中或鼠标经过卡片时显示(端口按钮是子节点, 移到端口上不会触发 mouseleave)
  const [connHover, setConnHover] = useState(false)
  const modelLabel = card.model ? MODEL_LABELS[card.model] ?? card.model : ''
  const connectorSize = Math.min(48, Math.max(24, 24 / scale))
  const connectorOffset = connectorSize / 2
  const busy = card.jobStatus === 'queued' || card.jobStatus === 'running'
  const lod = useLod(card.url, scale)
  // 布局尺寸按原图自然尺寸固定, LOD 换档只换像素不换大小;
  // 图片再小也给一个最小展示宽度, 避免几十像素的小图/加载失败时缩成一个破图小点
  const MIN_IMAGE_CARD_W = 240
  const lodW = lod.nw
    ? Math.max(MIN_IMAGE_CARD_W, Math.min(card.w, lod.nw))
    : undefined
  const lodH = lodW && lod.nw && lod.nh ? Math.round(lodW * (lod.nh / lod.nw)) : undefined

  const header = (
    <div
      className="flex h-8 shrink-0 cursor-grab items-center justify-between border-b border-border/60 bg-muted/40 px-2 active:cursor-grabbing"
      onDoubleClick={e => e.stopPropagation()}
    >
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {card.kind === 'generate' && <Sparkles className="h-3 w-3 text-primary" />}
        {card.kind === 'video' && <Video className="h-3 w-3 text-primary" />}
        {card.kind === 'prompt' && <StickyNote className="h-3 w-3 text-primary" />}
        {card.kind === 'layer' && <Layers className="h-3 w-3 text-primary" />}
        {card.kind === 'replicate' && <LayoutTemplate className="h-3 w-3 text-primary" />}
        {card.kind === 'polish' && <Wand2 className="h-3 w-3 text-primary" />}
        {card.kind === 'agent' && <Bot className="h-3 w-3 text-primary" />}
        {card.kind === 'loop' && <Repeat className="h-3 w-3 text-primary" />}
        {card.kind === 'merge' && <Blend className="h-3 w-3 text-primary" />}
        {card.kind === 'tts' && <AudioLines className="h-3 w-3 text-primary" />}
        {card.kind === 'motion' && <PersonStanding className="h-3 w-3 text-primary" />}
        {card.kind === 'vsr' && <Clapperboard className="h-3 w-3 text-primary" />}
        {card.kind === 'camera' && <Camera className="h-3 w-3 text-primary" />}
        {KIND_LABEL[card.kind]}
        {card.kind === 'camera' && card.title && <span className="font-medium text-card-foreground">· {card.title}</span>}
        {card.costText && (card.kind === 'result' || card.kind === 'video' || (card.kind === 'generate' && Array.isArray(card.results) && card.results.length > 0)) && (
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{card.costText}</span>
        )}
      </span>
      <span className="flex items-center">
        {/* 标签入口: 有头部的卡(含视频/语音等)都可打标; 纯图卡走悬浮工具条 */}
        <TagMenuButton cardId={card.id} variant="bare" />
        {card.url && (
          <CardActionButton title={card.kind === 'video' ? '预览播放' : '预览大图'} onClick={() => p.handlePreviewCard(card.id)}>
            <Eye className="h-3.5 w-3.5" />
          </CardActionButton>
        )}
        {card.url && card.kind !== 'video' && (
          <>
            <CardActionButton title="裁剪" onClick={() => p.openImageEditor(card.id, 'crop')}>
              <Crop className="h-3.5 w-3.5" />
            </CardActionButton>
            <CardActionButton title="画笔标注" onClick={() => p.openImageEditor(card.id, 'draw')}>
              <Brush className="h-3.5 w-3.5" />
            </CardActionButton>
            <CardActionButton title="宫格切分" onClick={() => p.openImageEditor(card.id, 'grid')}>
              <LayoutGrid className="h-3.5 w-3.5" />
            </CardActionButton>
            <CardActionButton title="提取选区（裁出局部图用于融合）" onClick={() => p.openImageEditor(card.id, 'extract')}>
              <Scissors className="h-3.5 w-3.5" />
            </CardActionButton>
          </>
        )}
        {card.kind === 'prompt' && (
          <CardActionButton title="转为生成节点(带参数条)" onClick={() => p.handleConvertToGenerate(card.id)}>
            <Wand2 className="h-3.5 w-3.5" />
          </CardActionButton>
        )}
        <CardActionButton title="复制卡片" onClick={() => p.handleDuplicateCard(card.id)}>
          <Copy className="h-3.5 w-3.5" />
        </CardActionButton>
        <CardActionButton title="删除卡片" onClick={() => p.handleDeleteCards([card.id])}>
          <Trash2 className="h-3.5 w-3.5" />
        </CardActionButton>
      </span>
    </div>
  )

  let body: React.ReactNode = null

  if (card.kind === 'prompt') {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <textarea
          value={card.prompt ?? ''}
          placeholder="写提示词… 输入 @ 从素材库选参考图"
          onChange={e => {
            const prev = card.prompt ?? ''
            const next = e.target.value
            p.updateCard(card.id, { prompt: next })
            if (next.length === prev.length + 1 && next.endsWith('@')) p.handleOpenAssetPicker(card.id)
          }}
          onPointerDown={e => e.stopPropagation()}
          onDoubleClick={e => e.stopPropagation()}
          className="min-h-0 flex-1 resize-none bg-transparent p-2 font-sans text-sm text-card-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <RefThumbRow p={p} card={card} />
      </div>
    )
  }

  if (card.kind === 'generate') {
    const hasResults = Array.isArray(card.results) && card.results.length > 0
    if (hasResults) {
      body = (
        <div className="relative flex h-auto min-h-0 flex-none flex-col p-2" style={{ width: card.w }}>
          <GenerateNodeResults p={p} card={card} />
        </div>
      )
    } else {
    body = (
      <div className={`relative flex min-h-0 flex-col ${card.url ? 'h-auto flex-none' : 'h-full flex-1'}`}>
        {card.url ? (
          lodW && lodH ? (
            <div className="relative w-fit" style={{ width: lodW }}>
              <div className="overflow-hidden rounded-lg" style={{ width: lodW, height: lodH }}>
                <LodImg
                  src={lod.src}
                  fallback={card.url}
                  fallbacks={lod.fallbacks}
                  alt={card.prompt || '图片'}
                  className="h-full w-full object-contain"
                  onDoubleClick={e => {
                    e.stopPropagation()
                    p.handlePreviewCard(card.id)
                  }}
                />
              </div>
            </div>
          ) : lod.nw === 0 ? (
            // 图片解码失败(不支持的格式如 TIFF / 链接失效): 给固定大小的友好占位,
            // 不再把浏览器破图图标按原始尺寸渲染成一个很小的破卡片
            <div className="flex w-60 max-w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-card p-4" style={{ minHeight: 180 }}>
              <ImageOff className="h-6 w-6 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">图片无法显示</p>
              <p className="text-[11px] text-muted-foreground/70">请换成 JPG / PNG / WEBP 格式后重新上传</p>
            </div>
          ) : (
            <div className="flex h-36 w-60 max-w-full items-center justify-center rounded-lg border border-border bg-card">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )
        ) : p.upstreamImageUrls(card.id).length > 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border bg-card p-2" onDoubleClick={e => e.stopPropagation()}>
            <div className="flex aspect-video w-40 max-w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-2 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-full border border-primary/40 bg-background text-lg text-primary">↦</div>
              <p className="text-sm font-semibold text-card-foreground">已连接上游输入</p>
              <p className="text-xs text-muted-foreground">运行时将使用上游节点的图片</p>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border bg-card p-2">
            <div
              className="flex aspect-video max-w-full cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border bg-background/40 p-2 text-center transition-colors hover:border-primary hover:bg-primary/5"
              style={{ width: 136 }}
              onPointerDown={e => {
                e.stopPropagation()
                // 记录起点: 只有「原地按下并抬起」才算点击上传; 移动超过 6px 视为在拖卡片, 不弹文件框
                uploadPressedRef.current = true
                uploadStartRef.current = { x: e.clientX, y: e.clientY }
              }}
              onPointerUp={e => {
                e.stopPropagation()
                const s = uploadStartRef.current
                const moved = s ? Math.hypot(e.clientX - s.x, e.clientY - s.y) > 6 : false
                if (uploadPressedRef.current && !moved) uploadInputRef.current?.click()
                uploadPressedRef.current = false
                uploadStartRef.current = null
              }}
              onPointerCancel={() => {
                uploadPressedRef.current = false
                uploadStartRef.current = null
              }}
              onDoubleClick={e => e.stopPropagation()}
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-muted text-lg text-muted-foreground">↥</div>
              <p className="text-sm font-semibold text-card-foreground">生成节点</p>
              <p className="text-xs text-muted-foreground">拖拽 / 粘贴 / 点击上传</p>
              <input
                ref={uploadInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => {
                  void p.handleSetNodeImage(card.id, e.target.files?.[0] ?? null)
                  e.target.value = ''
                }}
              />
              <button
                type="button"
                className="sr-only"
                onClick={() => uploadInputRef.current?.click()}
              >
                选择图片
              </button>
            </div>
          </div>
        )}
        {busy && <Loader2 className="absolute right-1 top-1 h-4 w-4 animate-spin text-primary" />}
      </div>
    )
    }
  }

  if (card.kind === 'layer') {
    body = <LayerNodeBody p={p} card={card} />
  }

  if (card.kind === 'replicate') {
    body = <ReplicateNodeBody p={p} card={card} externalHoverSlot={slotHover} />
  }

  if (card.kind === 'polish') {
    body = <PolishNodeBody p={p} card={card} />
  }

  if (card.kind === 'agent') {
    body = <AgentNodeBody p={p} card={card} />
  }

  if (card.kind === 'loop') {
    body = <LoopNodeBody p={p} card={card} />
  }

  if (card.kind === 'merge') {
    body = <MergeNodeBody p={p} card={card} />
  }

  if (card.kind === 'tts') {
    body = <TtsNodeBody p={p} card={card} />
  }

  if (card.kind === 'motion') {
    body = <MotionNodeBody p={p} card={card} />
  }

  if (card.kind === 'vsr') {
    body = <VsrNodeBody p={p} card={card} />
  }

  if (card.kind === 'camera') {
    body = <CameraNodeBody p={p} card={card} />
  }

  if (card.kind === 'result') {
    if (busy) {
      body = (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3 text-center">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
          <p className="text-sm text-card-foreground">{card.jobStatus === 'queued' ? '排队中…' : '生成中…'}</p>
          {modelLabel && <p className="text-xs text-muted-foreground">{modelLabel}</p>}
        </div>
      )
    } else if (card.jobStatus === 'failed') {
      body = (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3 text-center">
          <p className="text-xs leading-relaxed text-destructive">{card.errorMsg ?? '生成失败'}</p>
          <Button size="sm" variant="outline" className="text-foreground" onClick={() => p.handleRetryCard(card.id)}>
            <RefreshCw className="h-3.5 w-3.5" />
            单独重试
          </Button>
        </div>
      )
    } else if (card.cropContext) {
      // 局部选区卡: 与生成节点统一为纯图样式——无顶部横条/底部栏, 左上角浮动小标签, hover 浮现编辑/删除入口
      // 图片自然尺寸量到前先渲染固定占位: 否则容器 0 宽会被回写进卡片数据, 图片 max-width 跟着变 0 永远不显示
      const patchTag = (
        <span className="pointer-events-none absolute left-1.5 top-1.5 z-10 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
          {card.title || '局部选区'}
        </span>
      )
      body = lodW && lodH ? (
        <div className="relative w-fit" style={{ width: lodW }}>
          <div className="overflow-hidden rounded-lg" style={{ width: lodW, height: lodH }}>
            <LodImg
              src={lod.src}
              fallback={card.url}
              fallbacks={lod.fallbacks}
              alt={card.title || '局部选区'}
              className="h-full w-full object-contain"
              onDoubleClick={e => {
                e.stopPropagation()
                p.handlePreviewCard(card.id)
              }}
            />
          </div>
          {patchTag}
        </div>
      ) : lod.nw === 0 ? (
        <div className="relative flex w-60 max-w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-card p-4" style={{ minHeight: 180 }}>
          <ImageOff className="h-6 w-6 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">图片无法显示</p>
          <p className="text-[11px] text-muted-foreground/70">请换成 JPG / PNG / WEBP 格式后重新上传</p>
          {patchTag}
        </div>
      ) : (
        <div className="flex h-36 w-60 max-w-full items-center justify-center rounded-lg border border-border bg-card">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )
    } else {
      // 结果卡与生成节点结果(图三样式)统一: 无顶部横条/底部操作栏, 纯图, 编辑入口收进卡片上方操作坞, 点击图预览
      body = !card.url ? (
        <div className="flex h-36 w-60 max-w-full items-center justify-center rounded-lg border border-border bg-card">
          <p className="text-xs text-muted-foreground">暂无结果</p>
        </div>
      ) : lodW && lodH ? (
        <div className="relative w-fit" style={{ width: lodW }}>
          <div className="overflow-hidden rounded-lg" style={{ width: lodW, height: lodH }}>
            <LodImg
              src={lod.src}
              fallback={card.url}
              fallbacks={lod.fallbacks}
              alt={card.prompt ?? '生成结果'}
              className="h-full w-full object-contain"
              onDoubleClick={e => {
                e.stopPropagation()
                p.handlePreviewCard(card.id)
              }}
            />
          </div>
        </div>
      ) : lod.nw === 0 ? (
        <div className="relative flex w-60 max-w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border bg-card p-4" style={{ minHeight: 180 }}>
          <ImageOff className="h-6 w-6 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">图片无法显示</p>
          <p className="text-[11px] text-muted-foreground/70">请换成 JPG / PNG / WEBP 格式后重新上传</p>
        </div>
      ) : (
        <div className="flex h-36 w-60 max-w-full items-center justify-center rounded-lg border border-border bg-card">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )
    }
  }

  if (card.kind === 'video') {
    if (busy) {
      body = (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3 text-center">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
          <p className="text-sm text-card-foreground">{card.jobStatus === 'queued' ? '排队中…' : '视频生成中…'}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">视频生成通常需要几分钟, 可以先做别的</p>
          {modelLabel && <p className="text-xs text-muted-foreground">{modelLabel}</p>}
        </div>
      )
    } else if (card.jobStatus === 'failed') {
      body = (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3 text-center">
          <p className="text-xs leading-relaxed text-destructive">{card.errorMsg ?? '视频生成失败'}</p>
          <Button size="sm" variant="outline" className="text-foreground" onClick={() => p.handleRetryCard(card.id)}>
            <RefreshCw className="h-3.5 w-3.5" />
            单独重试
          </Button>
        </div>
      )
    } else {
      body = (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 bg-muted/30" onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
            {card.url ? <video src={mediaSrc(card.url)} controls preload="metadata" className="h-full w-full object-contain" /> : null}
          </div>
          <div
            className="flex cursor-grab items-center justify-between gap-1 border-t border-border/60 px-2 py-1.5 active:cursor-grabbing"
            onDoubleClick={e => e.stopPropagation()}
          >
            <span className="truncate text-xs text-muted-foreground" title={card.taskId ?? ''}>
              {modelLabel || '生成视频'}
            </span>
            <span className="flex items-center">
              <CardActionButton title="下载视频" onClick={() => p.handleDownloadCard(card.id)}>
                <Download className="h-3.5 w-3.5" />
              </CardActionButton>
              <CardActionButton title="存素材库" onClick={() => p.handleSaveCardToAssets(card.id)}>
                <FolderPlus className="h-3.5 w-3.5" />
              </CardActionButton>
            </span>
          </div>
        </div>
      )
    }
  }

  // 有图片/有结果时保持画布上的纯图展示；空节点需要保留卡片边界和上传入口，避免首次点空白后变成狭长空框。
  const genHasContent = card.kind === 'generate' && (!!card.url || (Array.isArray(card.results) && card.results.length > 0))
  // 结果卡(含局部选区/融合/宫格切图等)统一纯图展示: 无顶栏/底栏, 选中时才出框/端口
  const resultBare = card.kind === 'result' && !busy && card.jobStatus !== 'failed' && !!card.url
  const bareChrome = !selected && (genHasContent || resultBare)
  // 连接端口: 生成/Agent/循环/融合两侧都可接线(产出结果+接收输入); 结果图片卡只向外输出(可拖线到生成/融合当参考图或局部图); 润色/分层/复刻只接收上游图片输入
  const isNodeCard = card.kind === 'generate' || card.kind === 'agent' || card.kind === 'loop' || card.kind === 'merge'
  const connOutput = isNodeCard || card.kind === 'result'
  const connInput = isNodeCard || card.kind === 'polish' || card.kind === 'layer' || card.kind === 'replicate'
  // 卡片上方的操作坞(图片编辑 + 标签 + 外部软件导出)是否在场:
  // 结果卡/视频卡有 url 即可用; 生成节点含上传图位(card.url, 图生图的上传图也走这里)或任一成功结果项。
  // 选中常显、悬停即现; 坞顶边与卡片顶边贴合(top-0 -translate-y-full), 鼠标上移不会穿过间隙导致闪烁。
  const dockHasMedia =
    card.kind === 'result' || card.kind === 'video'
      ? !!card.url
      : card.kind === 'generate' &&
        (!!card.url ||
          (Array.isArray(card.results) && card.results.some(r => r.itemStatus === 'success' && r.url)))
  // 已有成品(图片/视频/成功结果)就允许导出, 不受残留的顶层忙碌/失败态影响,
  // 避免上传或任务状态没收口时工具坞整个消失(历史数据可能卡在 running)。
  const showExportDock = (selected || connHover) && dockHasMedia

  return (
    <div
      ref={rootRef}
      data-card-id={card.id}
      className={`group absolute flex select-none flex-col text-card-foreground transition-shadow duration-150 ${
        bareChrome
          ? 'overflow-visible'
          : `overflow-visible rounded-xl border bg-card shadow-md ${selected ? 'border-primary ring-2 ring-primary' : 'border-border hover:shadow-lg'}`
      }`}
      style={{
        left: card.x,
        top: card.y,
        // 纯图卡随图片真实宽度自适应; 保留 card.w 上限(生成节点结果图按 card.w-16 内边距布局)。
        // 上限带 240 下限: 加载骨架/手动缩到更小会把 card.w 回写成小于图片最小展示宽 240,
        // 不夹下限白框会被限死而图片按 240 渲染, 视觉上图片撑破边框。
        width: genHasContent || resultBare ? 'fit-content' : card.w,
        maxWidth: genHasContent || resultBare ? `${Math.max(card.w > 0 ? card.w : MIN_IMAGE_CARD_W, MIN_IMAGE_CARD_W)}px` : undefined,
        // 空生成节点(无上传图/无结果)高度必须跟随内容: 早期版本参数面板内嵌在卡片里, 存量数据的
        // card.h 被撑到 540/560/620; 面板改为浮层后真实内容只有约 180, 若仍按旧 card.h 占位,
        // 卡片底部会留一大段透明空白, 浮层面板被定位到透明区底部, 视觉上节点与面板「上下断开」。
        ...(card.kind === 'generate' && !genHasContent
          ? { height: 'auto' as const, minHeight: Math.min(180, card.h || 180) }
          : {
              height:
                genHasContent || resultBare
                  ? 'auto'
                  : card.kind === 'replicate' || card.kind === 'merge' || card.kind === 'tts' || card.kind === 'motion' || card.kind === 'vsr' || card.kind === 'camera'
                    ? 'auto'
                    : card.h,
            }),
        // 标签胶囊/导出菜单/连线端口都悬浮在卡片边界外, 卡片紧密叠放时会被后渲染的相邻卡整块盖住。
        // 悬停抬一层、选中抬两层, 交互中的卡连同卡外元素永远在最上面; 静止时保持文档顺序不引入额外重绘。
        zIndex: selected ? 30 : connHover ? 20 : undefined,
      }}
      onPointerDown={e => p.onCardPointerDown(e, card.id)}
      onMouseEnter={() => setConnHover(true)}
      onMouseLeave={() => setConnHover(false)}
      onDoubleClick={e => {
        e.stopPropagation()
        // 双击落在控件(按钮/输入/连线端口等)上时不触发卡片级行为
        const t = e.target as HTMLElement
        if (t.closest('button, input, textarea, select, a, video, [role="separator"], [contenteditable="true"]')) return
        if (card.kind === 'generate') {
          // 纯图结果(无展开参数面板的图)双击直接预览; 节点空白区双击才展开/收起参数面板
          const genResultBare = genHasContent
          if (genResultBare && card.url) {
            p.handlePreviewCard(card.id)
          } else {
            p.handleToggleNodePanel(card.id)
          }
        } else if (card.url) {
          // 结果/局部/融合等纯图卡: 整块双击预览, 不依赖两次点击都精确命中 <img>
          p.handlePreviewCard(card.id)
        }
      }}
    >
      {/* 低缩放(≤0.35)热区: 节点缩到指甲盖大时, 四边外扩屏幕 10px 的透明覆盖层,
          点节点附近即可选中/拖动。absolute 定位不进布局流, offsetWidth/Height 与连线几何不受影响;
          z-0 压在卡片内容之下, 不挡按钮/输入; 连线端口 z-30 且仅选中/悬停时出现, 优先级更高 */}
      {tiny && (() => {
        const expand = 10 / scale - 10
        return (
          <div
            aria-hidden
            className="pointer-events-auto absolute z-0 rounded-xl"
            style={{
              left: -expand,
              top: -expand,
              width: `calc(100% + ${expand * 2}px)`,
              height: `calc(100% + ${expand * 2}px)`,
            }}
            onPointerDown={e => p.onCardPointerDown(e, card.id)}
            onDoubleClick={e => {
              e.stopPropagation()
              if (card.kind === 'generate') p.handleToggleNodePanel(card.id)
            }}
          />
        )
      })()}
      {card.kind !== 'generate' && !resultBare && header}
      {body}
      {/* 媒体卡(生成结果/结果图/视频)上方的操作坞: 编辑/标签/删除 + 剪映/PS/AI 导出 */}
      {showExportDock && <CardExportDock card={card} />}
      {/* 标签胶囊在根级统一渲染: 悬浮在卡片外上方右侧, 与卡片不接触 */}
      <CardTagPill card={card} />
      {connInput && (selected || connHover || snapHover === 'left') && (
        <button
          type="button"
          aria-label="从左侧连接节点"
          className={`absolute z-30 flex touch-none items-center justify-center rounded-full border-2 shadow-md transition-[background-color,box-shadow] duration-100 ${
            snapHover === 'left'
              ? 'border-primary bg-primary text-primary-foreground shadow-[0_0_0_6px_hsl(var(--primary)/0.18)]'
              : 'border-primary bg-background text-primary hover:scale-110'
          }`}
          style={{ width: connectorSize, height: connectorSize, left: -connectorOffset, top: '50%', transform: `translateY(-50%) scale(${snapHover === 'left' ? 1.25 : 1})` }}
          onPointerDown={e => p.startConnection(e, card.id, 'left')}
        >
          <Plus style={{ width: connectorSize * 0.58, height: connectorSize * 0.58 }} />
        </button>
      )}
      {connOutput && (selected || connHover || snapHover === 'right') && (
        <button
          type="button"
          aria-label="从右侧连接节点"
          className={`absolute z-30 flex touch-none items-center justify-center rounded-full border-2 shadow-md transition-[background-color,box-shadow] duration-100 ${
            snapHover === 'right'
              ? 'border-primary bg-primary text-primary-foreground shadow-[0_0_0_6px_hsl(var(--primary)/0.18)]'
              : 'border-primary bg-background text-primary hover:scale-110'
          }`}
          style={{ width: connectorSize, height: connectorSize, right: -connectorOffset, top: '50%', transform: `translateY(-50%) scale(${snapHover === 'right' ? 1.25 : 1})` }}
          onPointerDown={e => p.startConnection(e, card.id, 'right')}
        >
          <Plus style={{ width: connectorSize * 0.58, height: connectorSize * 0.58 }} />
        </button>
      )}
      {(card.kind === 'generate' || card.kind === 'polish' || card.kind === 'layer' || card.kind === 'replicate' || card.kind === 'agent' || card.kind === 'loop' || card.kind === 'merge') && !bareChrome && (
        <div
          role="separator"
          aria-label="调整节点大小"
          title="拖拽调整大小"
          className="absolute bottom-0 right-0 z-30 flex h-5 w-5 cursor-nwse-resize items-end justify-end rounded-br-xl p-1 text-muted-foreground/70 hover:text-primary"
          onPointerDown={e => p.startResize(e, card.id)}
        >
          <svg viewBox="0 0 10 10" className="h-2.5 w-2.5">
            <path d="M9 3 L9 9 L3 9 M9 6 L6 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </div>
      )}
    </div>
  )
}

/**
 * memo: 平移/框选/拖其他卡时, card 引用未变的卡片全部跳过重渲染。
 * card 为不可变更新(改动会产生新对象), selected/scale 为原始值, 浅比较即可。
 */
export const CanvasCardView = memo(CanvasCardViewImpl)
