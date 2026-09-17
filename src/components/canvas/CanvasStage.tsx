import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  Archive,
  Copy,
  Crosshair,
  Eye,
  EyeOff,
  LayoutGrid,
  LocateFixed,
  Plus,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { CanvasAddMenu } from '@/components/canvas/CanvasAddMenu'
import { CanvasCardView } from '@/components/canvas/CanvasCardView'
import { BatchGenerateNodeBar, GenerateNodeBar } from '@/components/canvas/GenerateNodeBar'
import { ImagePlus } from 'lucide-react'
import { extractImageFilesFromDrop } from '@/lib/dropFiles'
import { preloadLod } from '@/components/canvas/useLod'
import { useCanvasVm, type CanvasVm, type ViewBounds } from '@/components/canvas/canvasRuntime'
import type { CanvasCardData } from '@/pages/Canvas/useCanvas'
import type { CanvasConnection } from '@/pages/Canvas/canvasTypes'

/*
 * react-hooks/refs: CanvasStage 是画布手势/几何快速路径的性能边界。
 * CanvasVm 刻意保持稳定引用，内部同时携带 DOM ref、几何 registry、
 * 最新数据快照和事件函数；本文件的很多“渲染期读取”都是读当前提交快照
 * 或注册 ref 到 DOM，不是用 ref 的变更驱动 React 重渲染。
 * 此豁免只限本文件，不能扩散到普通业务组件。
 */
/* eslint-disable react-hooks/refs */

/** 卡片包围盒与可见矩形是否相交(含容差); 兜底尺寸与 CanvasCardShell 一致 */
function intersectsBounds(card: CanvasCardData, b: ViewBounds): boolean {
  const w = card.w || 208
  const h = card.h || 144
  return card.x < b.x + b.w && card.x + w > b.x && card.y < b.y + b.h && card.y + h > b.y
}

/**
 * 与视口无关、必须始终完整挂载的卡片(在不在屏幕里都不许换成轻量壳):
 * ① 排队/生成中的标准生成节点; ② 分层节点正在分析/生图; ③ 复刻节点正在分析/生图。
 * 这类卡片内部带轮询态/进度 UI, 卸载只是省内存但会打断可见反馈, 数量也少(在跑的任务有限)。
 */
function isCardBusy(card: CanvasCardData): boolean {
  if (card.jobStatus === 'running' || card.jobStatus === 'queued') return true
  if (card.kind === 'layer') {
    const st = card.layerState?.stage
    return st === 'analyzing' || st === 'generating'
  }
  if (card.kind === 'replicate') {
    const st = card.repState?.stage
    return st === 'analyzing' || st === 'generating'
  }
  if (card.kind === 'tts') {
    const st = card.ttsState?.jobStatus
    return st === 'queued' || st === 'running'
  }
  if (card.kind === 'motion') {
    const st = card.motionState?.jobStatus
    return st === 'queued' || st === 'running'
  }
  if (card.kind === 'vsr') {
    const st = card.vsrState?.jobStatus
    return st === 'queued' || st === 'running'
  }
  return false
}

/**
 * 组外框快速拖动跟随: 拖动快速路径下卡片位置只写 DOM(不触发 React 渲染),
 * 组外框靠订阅几何版本号用 transform 跟随被拖成员, 拖动结束(成员恢复状态驱动后)自动复位为 0。
 * 关键: 可见边框和组名画在外框 div(本组件的父层)上, transform 写在本组件这个透明子层上
 * 视觉完全不可见——必须写到 parentElement(外框本身), 否则表现为拖动时卡片走了、框停在原地。
 */
type DragDeltaReader = {
  version: number
  subscribe: (fn: () => void) => () => void
  getDragDelta: (id: string) => { x: number; y: number }
}
const GroupFrameFollow = memo(function GroupFrameFollow({
  memberIds,
  registry,
}: {
  memberIds: string[]
  registry: DragDeltaReader
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useSyncExternalStore(
    cb => registry.subscribe(cb),
    () => registry.version,
    () => 0,
  )
  let dx = 0
  let dy = 0
  for (const id of memberIds) {
    const d = registry.getDragDelta(id)
    if (d.x || d.y) {
      dx = d.x
      dy = d.y
      break
    }
  }
  // 只在位移变化时写外框 transform: 无依赖数组会让任何舞台提交(拉线/打字)都重写一遍
  useLayoutEffect(() => {
    const frame = ref.current?.parentElement
    if (frame) frame.style.transform = dx || dy ? `translate(${dx}px, ${dy}px)` : ''
  }, [dx, dy])
  return <div ref={ref} className="pointer-events-none absolute inset-0" aria-hidden />
})

/**
 * 视口外卡片的轻量壳: 只占位置让几何注册表/连线/框选正常工作,
 * 不挂 img/video 与任何节点内嵌组件——超大画布下的图片解码与 DOM 节点数被压到近场量级。
 * 卡片被滚动到近场边界前(1 个视口外扩)就会换成完整挂载, 用户看不到挂载过程,
 * 快速反向往回甩时也不会露出未挂载的空区。
 * 低缩放全局视图下, 近场边界附近的壳卡也要能直接点选/拖动, 否则会出现
 * 「鼠标在节点上却点不中」; 壳内没有图片/重组件, 全部可交互也没有性能成本。
 * 兜底尺寸与完整卡片的骨架占位(208×144)保持一致, 避免 0 宽脏数据卡进场瞬间跳尺寸。
 */
const CanvasCardShell = memo(function CanvasCardShell({ card, busy = false }: { card: CanvasCardData; busy?: boolean }) {
  const p = useCanvasVm()
  return (
    <div
      data-card-id={card.id}
      className="absolute cursor-pointer"
      style={{ left: card.x, top: card.y, width: card.w || 208, height: card.h || 144 }}
      onPointerDown={e => p.onCardPointerDown(e, card.id)}
      onDoubleClick={e => e.stopPropagation()}
    >
      {/* 离屏运行中的任务: 壳上一枚状态点即可表达「还在跑」, 不必为此把整棵重组件树挂到视口外
          (旧实现强制完整挂载, 50~500 任务时离屏子树与缩略图构建会形成资源尖峰) */}
      {busy && (
        <span className="absolute -right-1 -top-1 z-10 h-3 w-3 rounded-full border-2 border-background bg-primary">
          <span className="absolute inset-0 animate-ping rounded-full bg-primary/60" />
        </span>
      )}
    </div>
  )
})

/** 渲染期一次性构建的查找索引: 消除逐卡 O(n) 的 find/filter/includes 扫描 */
interface StageIndex {
  cardById: Map<string, CanvasCardData>
  cardsByGroup: Map<string, CanvasCardData[]>
  collapsedGroups: Set<string>
  /** 收纳小卡矩形按组缓存 */
  chipRects: Map<string, { x: number; y: number; w: number; h: number }>
}

const COLLAPSED_CHIP_W = 176
const COLLAPSED_CHIP_H = 52

function buildStageIndex(cards: CanvasVm['cards']): StageIndex {
  const cardById = new Map<string, CanvasCardData>()
  const cardsByGroup = new Map<string, CanvasCardData[]>()
  const collapsedGroups = new Set<string>()
  cards.forEach(c => {
    cardById.set(c.id, c)
    if (c.groupId) {
      const arr = cardsByGroup.get(c.groupId) ?? []
      arr.push(c)
      cardsByGroup.set(c.groupId, arr)
      if (c.groupCollapsed) collapsedGroups.add(c.groupId)
    }
  })
  const chipRects = new Map<string, { x: number; y: number; w: number; h: number }>()
  collapsedGroups.forEach(gid => {
    const arr = cardsByGroup.get(gid)
    if (!arr || !arr.length) return
    const left = Math.min(...arr.map(c => c.x))
    const right = Math.max(...arr.map(c => c.x + c.w))
    const top = Math.min(...arr.map(c => c.y))
    const bottom = Math.max(...arr.map(c => c.y + c.h))
    chipRects.set(gid, {
      x: (left + right) / 2 - COLLAPSED_CHIP_W / 2,
      y: (top + bottom) / 2 - COLLAPSED_CHIP_H / 2,
      w: COLLAPSED_CHIP_W,
      h: COLLAPSED_CHIP_H,
    })
  })
  return { cardById, cardsByGroup, collapsedGroups, chipRects }
}

/** 组外框几何(展开态外扩 36 / 收纳态固定小卡), 连线锚点与渲染共用 */
function groupFrame(arr: CanvasCardData[], chip: { x: number; y: number; w: number; h: number } | undefined) {
  if (chip) {
    return { left: chip.x, top: chip.y, right: chip.x + chip.w, bottom: chip.y + chip.h, collapsed: true as const }
  }
  return {
    left: Math.min(...arr.map(c => c.x)) - 36,
    top: Math.min(...arr.map(c => c.y)) - 36,
    right: Math.max(...arr.map(c => c.x + c.w)) + 36,
    bottom: Math.max(...arr.map(c => c.y + c.h)) + 36,
    collapsed: false as const,
  }
}

/** 单条连线: memo 后, 拖卡/resize 快速路径升几何版本号时, 端点不受影响的线直接跳过重渲染 */
const ConnectionPath = memo(function ConnectionPath({
  conn,
  idx,
  scaleBucket,
}: {
  conn: CanvasConnection
  idx: StageIndex
  /** 缩放档位(0.25/0.65/1), 只用于命中带宽度, 连续缩放不逐帧重渲染 */
  scaleBucket: number
}) {
  const p = useCanvasVm()
  const registry = p.geometryRef.current
  // 端点级订阅: 快照只包含两端卡片各自的几何版本号, 拖动别的卡时本组件快照不变、直接跳过渲染
  const fromCard = idx.cardById.get(conn.fromId)
  const toCard = idx.cardById.get(conn.toId)
  const fromVersionKey = fromCard?.groupId && idx.collapsedGroups.has(fromCard.groupId) ? `g:${fromCard.groupId}` : conn.fromId
  const toVersionKey = toCard?.groupId && idx.collapsedGroups.has(toCard.groupId) ? `g:${toCard.groupId}` : conn.toId
  useSyncExternalStore(
    cb => registry.subscribe(cb),
    () => {
      // 收纳态组锚点: 组成员任一变化都影响小卡位置, 退化为订阅全局版本(收纳组引用线数量很少)
      if (fromVersionKey[0] === 'g' || toVersionKey[0] === 'g') return registry.version
      return registry.getRectVersion(conn.fromId) * 1_000_003 + registry.getRectVersion(conn.toId)
    },
    () => 0,
  )
  // 手动双击兜底: 舞台框选手势的指针捕获可能让浏览器不合成原生 dblclick,
  // 这里与卡片双击一致, 用两次 click 的时间窗(≤350ms)自己判定。删除按 id 过滤是幂等的,
  // 手动判定与随后到达的原生 dblclick 都调到也只是再过滤一次, 无副作用, 故不做去重锁。
  // hook 必须在任何提前 return 之前调用, 否则端点矩形缺失首帧会触发 hooks 数量不一致崩溃。
  const lastClickRef = useRef(0)
  /** 收纳小卡矩形: 拖动快速路径期间从注册表实测成员几何实时算, 不能用 idx 里的数据坐标(松手才更新) */
  const liveChipRect = (gid: string) => {
    const arr = idx.cardsByGroup.get(gid)
    if (!arr?.length) return idx.chipRects.get(gid) ?? null
    let left = Infinity
    let right = -Infinity
    let top = Infinity
    let bottom = -Infinity
    for (const c of arr) {
      const r = registry.getRect(c.id)
      if (!r) return idx.chipRects.get(gid) ?? null
      left = Math.min(left, r.x)
      right = Math.max(right, r.x + r.w)
      top = Math.min(top, r.y)
      bottom = Math.max(bottom, r.y + r.h)
    }
    if (left === Infinity) return idx.chipRects.get(gid) ?? null
    return {
      x: (left + right) / 2 - COLLAPSED_CHIP_W / 2,
      y: (top + bottom) / 2 - COLLAPSED_CHIP_H / 2,
      w: COLLAPSED_CHIP_W,
      h: COLLAPSED_CHIP_H,
    }
  }
  const rectOf = (id: string) => {
    const card = idx.cardById.get(id)
    if (card?.groupId && idx.collapsedGroups.has(card.groupId)) return liveChipRect(card.groupId)
    // 实测矩形优先; 尚未测量到时回退卡片数据坐标, 保证连线层已判可见时这里绝不返回空而不画线。
    // 几何同步后版本号自增会触发重渲染, 端点随即对齐到实测值。
    const measured = registry.getRect(id)
    if (measured) return measured
    if (!card) return null
    return { x: card.x, y: card.y, w: card.w || 208, h: card.h || (card.kind === 'generate' ? 180 : 144) }
  }
  const a = rectOf(conn.fromId)
  // 所有连线视觉上统一进入目标卡左侧输入端口(中点); toSlot 只决定图片归属, 不影响线条显示。
  // 展开态永远锚到具体卡片端口; 只有组收纳成小卡时 rectOf 才退化为小卡矩形(多线天然汇聚)。
  const b = rectOf(conn.toId)
  if (!a || !b) return null
  const sx = a.x + a.w
  const sy = a.y + a.h / 2
  const ex = b.x
  const ey = b.y + b.h / 2
  const d = `M ${sx} ${sy} C ${sx + 80} ${sy}, ${ex - 80} ${ey}, ${ex} ${ey}`
  const disconnect = (ev: { stopPropagation: () => void }) => {
    ev.stopPropagation()
    p.handleDisconnect(conn.id)
  }
  return (
    <g className="cursor-pointer">
      {/* 透明命中区: 1:1 时 26px 方便双击断开; 低缩放下收窄, 避免宽带盖住密布的小节点
          导致「看着点在节点上、实际抓到连线」。pointerdown 拦下避免舞台捕获指针 */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.min(26, Math.max(10, 26 / Math.sqrt(Math.max(scaleBucket, 0.2))))}
        pointerEvents="stroke"
        className="pointer-events-auto cursor-pointer"
        onPointerDown={ev => ev.stopPropagation()}
        onClick={ev => {
          ev.stopPropagation()
          const now = ev.timeStamp
          if (now - lastClickRef.current <= 350) disconnect(ev)
          lastClickRef.current = now
        }}
        onDoubleClick={ev => disconnect(ev)}
      >
        <title>双击断开连接</title>
      </path>
      <path d={d} fill="none" stroke="hsl(var(--primary))" strokeWidth="2" opacity="0.65" className="pointer-events-none" />
    </g>
  )
})

/**
 * 节点间持久连接线: 端点读几何注册表(单一 rAF 维护的真实渲染矩形),
 * 卡片拖动/尺寸变化由注册表通知重绘, 不再每卡建 ResizeObserver、不再 querySelector/find。
 * 层本身只做过滤与挂载, 几何变化由每条线的 memo 子组件各自重算, 拖动一张卡不再重算全部连线。
 */
const ConnectionLayer = memo(function ConnectionLayer({
  connections,
  idx,
  bounds,
  focusIds,
  scaleBucket,
}: {
  /** 连线数据本身必须作为 prop: 新建/吸附/删除连线只改 connections、不碰 cards,
   *  若只靠 memo 的其它参数(idx/bounds/focusIds/scaleBucket), 它们引用全不变会导致
   *  本层被缓存跳过、新线不画(表现为要再点一下卡片才冒出来)。 */
  connections: CanvasConnection[]
  idx: StageIndex
  bounds: ViewBounds
  /** 聚焦连线模式下的选中节点集合; 非 null 时只画与集合内节点直接相连的线 */
  focusIds: Set<string> | null
  scaleBucket: number
}) {
  // 连线视口剔除: 取两端包围盒的并集与视口判定相交。
  // 不能要求两个端点卡各自都在视口附近——放大后一屏只覆盖很小一片画布,
  // 长线两端可以分别落在屏幕两侧好几屏之外、线段中段却横穿视口(旧逻辑会把这种线整条剔除, 画面上线条中段消失)。
  // 包围盒相交是宽松判定(拐角错过视口的线会被多画), 但绝不会漏画可见线段。
  const endpointBox = useCallback(
    (id: string): { x: number; y: number; w: number; h: number } | null => {
      const card = idx.cardById.get(id)
      if (!card) return null
      if (card.groupId && idx.collapsedGroups.has(card.groupId)) {
        return idx.chipRects.get(card.groupId) ?? null
      }
      return { x: card.x, y: card.y, w: card.w || 208, h: card.h || 144 }
    },
    [idx],
  )
  const connectionVisible = useCallback(
    (fromId: string, toId: string) => {
      const a = endpointBox(fromId)
      const b = endpointBox(toId)
      if (!a || !b) return false
      const minX = Math.min(a.x, b.x)
      const minY = Math.min(a.y, b.y)
      const maxX = Math.max(a.x + a.w, b.x + b.w)
      const maxY = Math.max(a.y + a.h, b.y + b.h)
      return minX < bounds.x + bounds.w && maxX > bounds.x && minY < bounds.y + bounds.h && maxY > bounds.y
    },
    [endpointBox, bounds],
  )
  if (connections.length === 0) return null
  return (
    <svg className="absolute left-0 top-0 h-px w-px overflow-visible">
      {connections.map(conn => {
        // 聚焦连线模式: 仅保留与选中节点直接相连(上游或下游)的线
        if (focusIds && !focusIds.has(conn.fromId) && !focusIds.has(conn.toId)) return null
        // 两端包围盒并集与视口不相交才不渲染(放大后长线段中段横穿屏幕也保留)
        if (!connectionVisible(conn.fromId, conn.toId)) return null
        return <ConnectionPath key={conn.id} conn={conn} idx={idx} scaleBucket={scaleBucket} />
      })}
    </svg>
  )
})

/** 组名输入: 局部草稿, 失焦/回车才一次性写回(旧实现每按一键全量改写整组卡片并触发保存) */
function GroupRenameInput({ groupId, initial }: { groupId: string; initial: string }) {
  const p = useCanvasVm()
  const [draft, setDraft] = useState(initial)
  return (
    <input
      autoFocus
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onBlur={() => p.handleRenameGroup(groupId, draft.trim() || '组')}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      className="pointer-events-auto absolute left-3 top-2 h-6 w-32 rounded-md border border-primary/60 bg-background px-2 text-xs text-card-foreground outline-none"
    />
  )
}

function ZoomControls({ p }: { p: CanvasVm }) {
  return (
    <div
      className="absolute bottom-4 left-4 z-20 flex items-center gap-0.5 rounded-lg border border-border bg-card p-1 shadow-lg"
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <button
        title="缩小"
        onClick={() => p.zoomBy(1 / 1.2)}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ZoomOut className="h-4 w-4" />
      </button>
      <span className="w-12 text-center text-xs text-muted-foreground">{Math.round(p.viewport.scale * 100)}%</span>
      <button
        title="放大"
        onClick={() => p.zoomBy(1.2)}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ZoomIn className="h-4 w-4" />
      </button>
      <button
        title="回到内容中心 (F)"
        onClick={p.handleFrameContent}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <LocateFixed className="h-4 w-4" />
      </button>
      <button
        title="重置视图 (100%)"
        onClick={p.handleZoomReset}
        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Crosshair className="h-4 w-4" />
      </button>
      <div className="mx-0.5 h-4 w-px bg-border" />
      <button
        title={p.focusConnections ? '显示全部连线' : '隐藏连线（仅显示选中节点的上下游）'}
        onClick={() => p.setFocusConnections(v => !v)}
        className={`rounded p-1.5 transition-colors ${
          p.focusConnections
            ? 'bg-primary/10 text-primary hover:bg-primary/20'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
      >
        {p.focusConnections ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
}


/**
 * 单生成节点的参数浮层面板: 吸附在节点正下方(画布坐标, 随节点移动/缩放)。
 * 端点几何与连线一样订阅几何注册表: 展开瞬间卡片高度可能刚从历史大值回写、拖动、resize
 * 都会让矩形变化, 这里逐帧跟随, 不会读到过期矩形而与节点「上下断开」。
 * 展开与否由 editNodeId 决定(非融合输入选中即展开, 融合输入默认收起、手动展开)。
 */
const EditNodePanel = memo(function EditNodePanel({ p, idx }: { p: CanvasVm; idx: StageIndex }) {
  const registry = p.geometryRef.current
  const editCard =
    p.selectedIds.length === 1 && p.editNodeId === p.selectedIds[0]
      ? idx.cardById.get(p.editNodeId)
      : undefined
  // 订阅该卡几何版本(挂载即同步一次, 覆盖展开瞬间矩形尚未注册的帧序竞争)
  useLayoutEffect(() => {
    if (editCard) registry.syncFromDom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editCard?.id])
  useSyncExternalStore(
    cb => registry.subscribe(cb),
    () => (editCard ? registry.getRectVersion(editCard.id) : 0),
    () => 0,
  )
  if (!editCard || editCard.kind !== 'generate') return null
  const r = registry.getRect(editCard.id)
  const nw = r ? r.w : editCard.w
  const cx = (r ? r.x : editCard.x) + nw / 2
  const bottom = r ? r.y + r.h : editCard.y + editCard.h
  return (
    <div
      className="absolute z-40 overflow-hidden rounded-xl border border-primary bg-card shadow-2xl"
      style={{ left: cx, top: bottom + 8, width: 760, transform: 'translateX(-50%)' }}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <GenerateNodeBar p={p} card={editCard} />
    </div>
  )
})

export function CanvasStage({ p }: { p: CanvasVm }) {
  const { viewport } = p
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  // 拖拽悬停反馈：计数避免子元素 dragenter/leave 抖动导致遮罩闪烁
  const [dragActive, setDragActive] = useState(false)
  const dragDepthRef = useRef(0)
  // 几何注册表挂到变换层, 连线层/尺寸回写统一从它读几何
  const registry = p.geometryRef.current
  const probe = p.probeRef.current
  useEffect(() => {
    const content = p.contentRef.current
    if (!content) return
    registry.attach(content, (cardId, w, h) => p.syncCardSize(cardId, w, h))
    return () => registry.detach()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.contentRef, registry])
  // 视口探测器挂到舞台根(读屏幕尺寸); 用绘制前 effect 首帧就能拿到真实视口尺寸,
  // 避免第一帧按零面积矩形只挂选中卡、下一帧再补挂的闪白
  useLayoutEffect(() => {
    const stage = p.stageRef.current
    if (!stage) return
    probe.attach(stage, p.viewport)
    return () => probe.detach()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probe])
  useSyncExternalStore(
    cb => probe.subscribe(cb),
    () => probe.version,
    () => 0,
  )
  // 仅在卡片数据提交后做全量几何同步(连线与卡片同帧); 选中/拉线/视图等无关提交不再触发
  // querySelectorAll + 全量 offset 读取的强制布局扫描(那是打字/拉线时的主要固定开销之一)。
  // 拖卡与 resize 走几何注册表的增量快速路径, 尺寸变化由 ResizeObserver 兜底, 不依赖这里。
  useLayoutEffect(() => {
    registry.syncFromDom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.cards])

  // 查找索引只随卡片数据重建: 选中态/视图变化不重建, 连线层 memo 才能真正跳过无关重渲染
  const cards = p.cards
  const idx = useMemo(() => buildStageIndex(cards), [cards])
  const selectedSet = useMemo(() => new Set(p.selectedIds), [p.selectedIds])
  // 近场/连线矩形: 把最新视图(可能新于 React 状态: 平移快速路径)静默同步给探测器后取外扩矩形。
  // 近场外扩 1 个视口: 不仅提前挂载, 还保证快速反向往回甩时屏幕始终落在已挂载区内不露空;
  // 连线按同一矩形裁剪(引用也共享), 连线层 memo 在选中/编辑等无关变化时不会被带着重渲染
  const { nearBounds, lineBounds } = useMemo(() => {
    probe.hintViewport(viewport)
    const b = probe.bounds(1.0)
    return { nearBounds: b, lineBounds: b }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport.x, viewport.y, viewport.scale, probe.version])
  // 完整挂载集合: 选中卡 / 设置面板展开的编辑卡 / 拖线悬停的目标槽卡(槽高亮需要复刻卡挂载) /
  // 与视口相交(含 1 视口外扩)的卡。运行中的离屏卡不再强制挂载——壳上的状态点足够表达进度,
  // 结果回写发生在数据层, 卡滚回近场时自然看到终态; 这让 50~500 任务并跑时离屏重组件树保持为 0。
  const connectionHoverCardId = p.connectionDraft?.hoverSlot?.cardId
  const nearIds = useMemo(() => {
    const set = new Set<string>()
    cards.forEach(c => {
      if (selectedSet.has(c.id) || intersectsBounds(c, nearBounds)) set.add(c.id)
    })
    if (p.editNodeId) set.add(p.editNodeId)
    if (connectionHoverCardId) set.add(connectionHoverCardId)
    return set
  }, [cards, nearBounds, selectedSet, p.editNodeId, connectionHoverCardId])
  // 近场卡片后台预热 LOD 缩略图(滚回/缩小时直接命中), 只预热近场不全画布
  useEffect(() => {
    preloadLod(p.cards.filter(c => nearIds.has(c.id)).map(c => c.url))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nearIds])
  // 缩放档位: 卡片内的图片 LOD(<0.45 / <0.9)、点击热区(<0.35)、端口与连线命中尺寸都是档位型逻辑。
  // 传档位而不是连续缩放值, memo 卡片只在跨档位时重渲染——滚轮连续缩放后停顿时不再整卡重渲染。
  const scaleBucket = viewport.scale < 0.45 ? 0.25 : viewport.scale < 0.9 ? 0.65 : 1
  const grid = Math.max(12, Math.round(26 * viewport.scale))
  return (
    <div
      ref={p.stageRef}
      className="absolute inset-0 touch-none select-none overflow-hidden bg-background"
      style={{
        backgroundImage:
          'radial-gradient(circle, color-mix(in srgb, var(--foreground) 14%, transparent) 1px, transparent 1px)',
        backgroundSize: `${grid}px ${grid}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        cursor: p.spacePanning ? 'grabbing' : 'grab',
      }}
      onPointerDown={p.onStagePointerDown}
      onPointerMove={p.onStagePointerMove}
      onPointerUp={p.onStagePointerUp}
      onPointerCancel={p.onStagePointerCancel}
      onDoubleClick={p.onStageDoubleClick}
      onAuxClick={e => {
        // 中键(滚轮按下)用于抓手平移: 阻止 Chrome/Firefox 中键自动滚动图标
        if (e.button === 1) e.preventDefault()
      }}
      onDragEnter={e => {
        // 只在拖入文件时显示反馈（避免拖选文字等也高亮）
        if (!e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0) return
        e.preventDefault()
        dragDepthRef.current += 1
        setDragActive(true)
      }}
      onDragOver={e => {
        // 必须 preventDefault 才能触发 drop；Safari 还需显式指定 effectAllowed
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
        if (dragDepthRef.current === 0) setDragActive(false)
      }}
      onDrop={e => {
        e.preventDefault()
        e.stopPropagation()
        dragDepthRef.current = 0
        setDragActive(false)
        const x = e.clientX
        const y = e.clientY
        // 资产面板拖回画布优先: 资产/卡片 DnD 不是外部文件, 不走上传逻辑
        if (p.handleStageAssetDrop(e, x, y)) return
        void (async () => {
          const files = await extractImageFilesFromDrop(e, 30)
          if (files.length) void p.handleUploadImageFiles(files, x, y)
        })()
      }}
    >
      <div
        ref={p.contentRef}
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          transformOrigin: '0 0',
        }}
      >
        <ConnectionLayer
          connections={p.connections}
          idx={idx}
          bounds={lineBounds}
          focusIds={p.focusConnections ? selectedSet : null}
          scaleBucket={scaleBucket}
        />
        {/* 组外框: 同组节点共享一个圆角包围盒, 选中整组时高亮; 几何全部读预建索引 */}
        {[...idx.cardsByGroup.entries()].map(([gid, arr]) => {
          // 整组都在近场外(且无选中成员)则不挂外框; 组框命中区随卡进场再出现
          if (!arr.some(c => selectedSet.has(c.id) || intersectsBounds(c, nearBounds))) return null
          const ids = arr.map(c => c.id)
          const chip = idx.chipRects.get(gid)
          const selected = arr.every(c => selectedSet.has(c.id))
          // 收纳态: 成员隐藏, 只渲染一枚轻量小卡(图标+组名+恢复), 连线/拖拽/引用保持
          if (chip) {
            const size = Math.min(40, Math.max(22, 22 / viewport.scale))
            return (
              <div
                key={gid}
                className={`absolute flex cursor-grab select-none items-center justify-center gap-2 rounded-2xl border-2 px-3 shadow-md active:cursor-grabbing ${selected ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}
                style={{ left: chip.x, top: chip.y, width: chip.w, height: chip.h }}
                onPointerDown={e => p.onGroupPointerDown(e, ids)}
                onDoubleClick={e => {
                  e.stopPropagation()
                  p.setGroupCollapsed(gid, false)
                }}
              >
                <Archive className="h-4 w-4 shrink-0 text-primary" />
                <span className="max-w-24 truncate text-xs font-semibold text-card-foreground">
                  {arr[0].groupName || '组'}
                </span>
                <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {arr.length}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded-md bg-primary/15 px-2 py-0.5 text-xs text-primary transition-colors hover:bg-primary/25"
                  onPointerDown={e => e.stopPropagation()}
                  onDoubleClick={e => e.stopPropagation()}
                  onClick={() => p.setGroupCollapsed(gid, false)}
                >
                  恢复
                </button>
                {selected && (
                  <>
                    <button
                      type="button"
                      aria-label="从组左侧连接节点"
                      className="absolute flex touch-none items-center justify-center rounded-full border-2 border-primary bg-background text-primary shadow-md transition-transform hover:scale-110"
                      style={{ width: size, height: size, left: -size / 2, top: '50%', transform: 'translateY(-50%)' }}
                      onPointerDown={e => p.startGroupConnection(e, ids, 'left')}
                    >
                      <Plus style={{ width: size * 0.58, height: size * 0.58 }} />
                    </button>
                    <button
                      type="button"
                      aria-label="从组右侧连接节点"
                      className="absolute flex touch-none items-center justify-center rounded-full border-2 border-primary bg-background text-primary shadow-md transition-transform hover:scale-110"
                      style={{ width: size, height: size, right: -size / 2, top: '50%', transform: 'translateY(-50%)' }}
                      onPointerDown={e => p.startGroupConnection(e, ids, 'right')}
                    >
                      <Plus style={{ width: size * 0.58, height: size * 0.58 }} />
                    </button>
                  </>
                )}
              </div>
            )
          }
          const f = groupFrame(arr, undefined)
          return (
            <div
              key={gid}
              className={`absolute cursor-grab select-none rounded-2xl border-2 active:cursor-grabbing ${selected ? 'border-primary/80 bg-primary/5' : 'border-border bg-muted/15'}`}
              style={{ left: f.left, top: f.top, width: f.right - f.left, height: f.bottom - f.top }}
              onPointerDown={e => p.onGroupPointerDown(e, arr.map(c => c.id))}
              onDoubleClick={e => e.stopPropagation()}
            >
              {/* 快速拖动期间成员只移动 DOM, 组框用 transform 跟随, 松手状态提交后复位 */}
              <GroupFrameFollow memberIds={ids} registry={registry} />
              {renamingGroup === gid ? (
                <GroupRenameInput groupId={gid} initial={arr[0].groupName ?? ''} />
              ) : (
                <span
                  title="双击重命名"
                  onPointerDown={e => e.stopPropagation()}
                  onDoubleClick={e => {
                    e.stopPropagation()
                    setRenamingGroup(gid)
                  }}
                  className="pointer-events-auto absolute left-3 top-2 cursor-text text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {arr[0].groupName || '组'}
                </span>
              )}
            </div>
          )
        })}
        {p.cards
          .filter(card => !(card.groupId && idx.collapsedGroups.has(card.groupId)))
          .map(card =>
            nearIds.has(card.id) ? (
              <CanvasCardView
                key={card.id}
                card={card}
                selected={selectedSet.has(card.id)}
                scale={scaleBucket}
                tiny={viewport.scale <= 0.35}
                slotHover={
                  p.connectionDraft?.hoverSlot?.cardId === card.id ? p.connectionDraft.hoverSlot : null
                }
                snapHover={
                  p.connectionDraft?.snapCardId === card.id ? p.connectionDraft.snapSide ?? null : null
                }
              />
            ) : (
              <CanvasCardShell key={card.id} card={card} busy={isCardBusy(card)} />
            ),
          )}
        {/* 框选矩形: 常驻一层, 拖动期间由手势直接写样式, 零 React 渲染 */}
        <div
          ref={p.marqueeLayerRef}
          className="pointer-events-none absolute hidden rounded-sm border border-primary bg-primary/10"
        />
        {/* 拉线草稿: 常驻一层, 跟鼠标期间由手势直接写 d 属性(零 React 提交); 默认隐藏, 起拖时显示。
            z 必须高于选中卡(z-30)/组框端口(z-40), 否则跟手线被源卡等元素整段盖住, 看着像不跟鼠标。 */}
        <svg className="pointer-events-none absolute left-0 top-0 z-50 hidden h-px w-px overflow-visible">
          <path
            ref={p.draftPathRef}
            d=""
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth="2"
            opacity="0.65"
          />
        </svg>
        <CanvasAddMenu p={p} />
        <EditNodePanel p={p} idx={idx} />
        {(() => {
          // 多选浮动工具条: 对齐 / 打组 / 解组 / 复制 / 收纳
          const sel = p.selectedIds.map(id => idx.cardById.get(id)).filter((c): c is CanvasCardData => !!c)
          if (sel.length < 2) return null
          // 收纳组成员按小卡边界定位工具条
          const rOf = (c: CanvasCardData) => (c.groupId ? idx.chipRects.get(c.groupId) ?? c : c)
          const left = Math.min(...sel.map(c => rOf(c).x))
          const right = Math.max(...sel.map(c => rOf(c).x + rOf(c).w))
          const top = Math.min(...sel.map(c => rOf(c).y))
          const cx = (left + right) / 2
          const gids = new Set(sel.map(c => c.groupId).filter((g): g is string => !!g))
          const isSingleGroup = gids.size === 1 && sel.every(c => !!c.groupId)
          const collapsed = isSingleGroup && idx.collapsedGroups.has(sel[0].groupId as string)
          // 收纳态不弹工具条, 只能通过小卡上的「恢复」展开; 恢复后工具条照常
          if (collapsed) return null
          // 组外框顶部有 36 留白, 工具条要越过外框再往上, 避免压住框线和组名; 收纳小卡无外框
          const framePad = gids.size > 0 && !collapsed ? 36 : 0
          return (
            <div
              className="absolute z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-card px-2 py-1.5 shadow-xl"
              style={{ left: cx, top: top - framePad - 56 }}
              onPointerDown={e => e.stopPropagation()}
              onDoubleClick={e => e.stopPropagation()}
            >
              <span className="flex items-center gap-0.5">
                {(
                  [
                    ['left', AlignStartVertical, '左对齐'],
                    ['top', AlignStartHorizontal, '顶对齐'],
                    ['hdist', AlignHorizontalSpaceAround, '横向等距分布'],
                    ['vdist', AlignVerticalSpaceAround, '纵向等距分布'],
                    ['grid', LayoutGrid, '网格整理'],
                  ] as const
                ).map(([mode, Icon, title]) => (
                  <button
                    key={mode}
                    type="button"
                    title={title}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => p.alignSelection(mode)}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                ))}
              </span>
              <span className="h-4 w-px bg-border" />
              {!isSingleGroup && (
                <button
                  type="button"
                  className="whitespace-nowrap rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  onClick={p.handleGroupSelection}
                >
                  打组
                </button>
              )}
              {isSingleGroup && <GroupRenameInputInline groupId={sel[0].groupId as string} initial={sel[0].groupName ?? ''} />}
              {gids.size > 0 && (
                <button
                  type="button"
                  className="whitespace-nowrap rounded-lg border border-border/60 bg-muted/40 px-3 py-1 text-xs text-card-foreground transition-colors hover:border-primary hover:text-primary"
                  onClick={p.handleUngroupSelection}
                >
                  解组
                </button>
              )}
              <button
                type="button"
                title="复制选中的全部节点与组内连线"
                className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-border/60 bg-muted/40 px-3 py-1 text-xs text-card-foreground transition-colors hover:border-primary hover:text-primary"
                onClick={p.handleDuplicateSelection}
              >
                <Copy className="h-3 w-3" />
                复制
              </button>
              {isSingleGroup && !collapsed && (
                <button
                  type="button"
                  title="收起组内节点, 画布只显示组名小卡"
                  className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-border/60 bg-muted/40 px-3 py-1 text-xs text-card-foreground transition-colors hover:border-primary hover:text-primary"
                  onClick={() => p.handleCollapseSelection(true)}
                >
                  <Archive className="h-3 w-3" />
                  收纳
                </button>
              )}
              {isSingleGroup && collapsed && (
                <button
                  type="button"
                  className="whitespace-nowrap rounded-lg border border-border/60 bg-muted/40 px-3 py-1 text-xs text-card-foreground transition-colors hover:border-primary hover:text-primary"
                  onClick={() => p.handleCollapseSelection(false)}
                >
                  恢复
                </button>
              )}
            </div>
          )
        })()}
        {(() => {
          // 整组加号: 选中完整一组时, 组包围盒左右出现连接点, 拖出的新节点引用整组
          const sel = p.selectedIds.map(id => idx.cardById.get(id)).filter((c): c is CanvasCardData => !!c)
          if (sel.length < 2) return null
          const gid = sel[0].groupId
          if (!gid || !sel.every(c => c.groupId === gid)) return null
          // 收纳态小卡自带左右加号, 这里不再叠加
          if (idx.collapsedGroups.has(gid)) return null
          const all = idx.cardsByGroup.get(gid) ?? []
          if (all.length !== sel.length) return null
          const f = groupFrame(all, undefined)
          const cy = (f.top + f.bottom) / 2
          const ids = all.map(c => c.id)
          const size = Math.min(48, Math.max(24, 24 / viewport.scale))
          return (
            <>
              <button
                type="button"
                aria-label="从组左侧连接节点"
                className="absolute z-40 flex touch-none items-center justify-center rounded-full border-2 border-primary bg-background text-primary shadow-md transition-transform hover:scale-110"
                style={{ width: size, height: size, left: f.left - size / 2, top: cy, transform: 'translateY(-50%)' }}
                onPointerDown={e => p.startGroupConnection(e, ids, 'left')}
              >
                <Plus style={{ width: size * 0.58, height: size * 0.58 }} />
              </button>
              <button
                type="button"
                aria-label="从组右侧连接节点"
                className="absolute z-40 flex touch-none items-center justify-center rounded-full border-2 border-primary bg-background text-primary shadow-md transition-transform hover:scale-110"
                style={{ width: size, height: size, left: f.right - size / 2, top: cy, transform: 'translateY(-50%)' }}
                onPointerDown={e => p.startGroupConnection(e, ids, 'right')}
              >
                <Plus style={{ width: size * 0.58, height: size * 0.58 }} />
              </button>
            </>
          )
        })()}
      </div>

      {(() => {
        // 底部批量设置/生成条: 收纳态的组不参与批量操作, 不弹出
        const selGen = p.selectedIds
          .map(id => idx.cardById.get(id))
          .filter((c): c is CanvasCardData => !!c && c.kind === 'generate')
        if (selGen.length < 2) return null
        if (selGen.some(c => c.groupId && idx.collapsedGroups.has(c.groupId))) return null
        return (
          <div className="absolute bottom-4 left-1/2 z-40 w-[min(760px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-primary bg-card shadow-2xl">
            <BatchGenerateNodeBar p={p} />
          </div>
        )
      })()}

      {p.cards.length === 0 && !p.addMenuPos && !dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="max-w-md rounded-2xl border border-dashed border-border bg-card/80 p-8 text-center shadow-lg backdrop-blur">
            <h2 className="text-xl font-bold text-foreground">开始创作</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              双击画布空白处, 在双击位置创建生成 / Agent / Loop / 润色 / 分层 / 复刻节点;
              生成节点可选传一张图, 配合提示词与参数出图或出视频。双击生成节点可打开设置面板,
              框选多个节点可批量设置并批量运行, 滚轮缩放画布。
            </p>
          </div>
        </div>
      )}

      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-primary bg-card/90 px-12 py-10 shadow-2xl">
            <ImagePlus className="h-12 w-12 text-primary" />
            <p className="text-lg font-semibold text-foreground">松开即可放入图片</p>
            <p className="text-sm text-muted-foreground">支持 PNG / JPEG / WEBP 等, 可一次拖入多张或整个文件夹</p>
          </div>
        </div>
      )}

      <ZoomControls p={p} />
    </div>
  )
}

/** 多选工具条里的组名输入: 局部草稿, 失焦/回车才一次性写回整组 */
function GroupRenameInputInline({ groupId, initial }: { groupId: string; initial: string }) {
  return <GroupRenameInput groupId={groupId} initial={initial} />
}
