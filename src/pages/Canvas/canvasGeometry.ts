// 画布几何 / 视口数学的纯函数内核。
// 从 useCanvas 抽出：只做确定性数值计算，不碰 React state、不读 DOM、不读网络，
// 便于单测覆盖。useCanvas 里的同名包装函数负责取当前 viewport / 舞台尺寸后调用这里。
import type { CanvasCardData, CanvasViewport } from './canvasTypes'

/** 收纳态分组芯片的固定外框尺寸 */
export const COLLAPSED_CHIP_W = 176
export const COLLAPSED_CHIP_H = 52

/** 视口缩放允许的范围（与原交互一致） */
export const MIN_SCALE = 0.1
export const MAX_SCALE = 2.5

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** 屏幕客户端坐标 -> 画布逻辑坐标（含舞台容器偏移与视口缩放） */
export function clientToCanvasCoords(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  viewport: CanvasViewport,
): Point {
  return {
    x: (clientX - rect.left - viewport.x) / viewport.scale,
    y: (clientY - rect.top - viewport.y) / viewport.scale,
  }
}

/** 新卡片在视口中心附近的生成位置（原中心偏移 130/90 的逻辑保持不变） */
export function centerSpawnCoords(viewport: CanvasViewport, stage: Size): Point {
  const cw = stage.width || 900
  const ch = stage.height || 600
  return {
    x: (cw / 2 - viewport.x) / viewport.scale - 130,
    y: (ch / 2 - viewport.y) / viewport.scale - 90,
  }
}

/**
 * 以给定客户端点为锚点缩放视口。缩放比会被夹在 [MIN_SCALE, MAX_SCALE]，
 * 再用实际生效比例反推平移量，保证锚点处内容在缩放前后不跳动。
 */
export function zoomViewport(
  prev: CanvasViewport,
  factor: number,
  anchor: Point,
): CanvasViewport {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor))
  const k = scale / prev.scale
  return {
    scale,
    x: anchor.x - (anchor.x - prev.x) * k,
    y: anchor.y - (anchor.y - prev.y) * k,
  }
}

/**
 * 把一组节点居中并缩放到舞台视野内。无节点（或无舞台尺寸）时回默认视图。
 * pad 为四周留白；空内容或尺寸异常时 scale 仍被夹在范围内。
 */
export function frameViewport(
  items: Pick<CanvasCardData, 'x' | 'y' | 'w' | 'h'>[],
  stage: Size,
  pad = 80,
): CanvasViewport {
  if (!items.length || stage.width <= 0 || stage.height <= 0) {
    return { x: 80, y: 80, scale: 1 }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  items.forEach(c => {
    minX = Math.min(minX, c.x)
    minY = Math.min(minY, c.y)
    maxX = Math.max(maxX, c.x + c.w)
    maxY = Math.max(maxY, c.y + c.h)
  })
  const vw = stage.width
  const vh = stage.height
  const w = Math.max(1, maxX - minX)
  const h = Math.max(1, maxY - minY)
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((vw - pad * 2) / w, (vh - pad * 2) / h)))
  const x = (vw - w * scale) / 2 - minX * scale
  const y = (vh - h * scale) / 2 - minY * scale
  return { x, y, scale }
}

export type AlignMode = 'left' | 'top' | 'hdist' | 'vdist' | 'grid'

export interface CardBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** 对齐/分布：返回每张卡需要覆盖的 {x?,y?} 补丁；少于 2 张返回空表 */
export function alignmentPatch(sel: CardBox[], mode: AlignMode): Map<string, { x?: number; y?: number }> {
  const patch = new Map<string, { x?: number; y?: number }>()
  if (sel.length < 2) return patch
  if (mode === 'left' || mode === 'top') {
    const v = mode === 'left' ? Math.min(...sel.map(c => c.x)) : Math.min(...sel.map(c => c.y))
    sel.forEach(c => patch.set(c.id, mode === 'left' ? { x: v } : { y: v }))
  } else if (mode === 'hdist' || mode === 'vdist') {
    const horiz = mode === 'hdist'
    const sorted = [...sel].sort((a, b) => (horiz ? a.x - b.x : a.y - b.y))
    const first = horiz ? sorted[0].x : sorted[0].y
    const last = horiz ? sorted[sorted.length - 1].x : sorted[sorted.length - 1].y
    // 首尾重合时退化为按最大尺寸+间隔依次排开
    const gap = Math.max(...sel.map(c => (horiz ? c.w : c.h))) + 60
    let step = last > first ? (last - first) / (sorted.length - 1) : gap
    // 横向/纵向等距: 都把卡片之间的「空白间隔」放宽为当前的 2 倍
    // (等宽/等高卡片下精确翻倍; 尺寸不一时按最大卡片尺寸近似)。
    if (last > first) {
      const maxCardSize = Math.max(...sel.map(c => (horiz ? c.w : c.h)))
      const curGap = Math.max(0, step - maxCardSize)
      step = step + curGap
    }
    sorted.forEach((c, i) => {
      const v = Math.round(first + step * i)
      patch.set(c.id, horiz ? { x: v } : { y: v })
    })
  } else {
    const cols = Math.ceil(Math.sqrt(sel.length))
    const cw = Math.max(...sel.map(c => c.w)) + 60
    const ch = Math.max(...sel.map(c => c.h)) + 60
    const ox = Math.min(...sel.map(c => c.x))
    const oy = Math.min(...sel.map(c => c.y))
    ;[...sel]
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .forEach((c, i) => patch.set(c.id, { x: ox + (i % cols) * cw, y: oy + Math.floor(i / cols) * ch }))
  }
  return patch
}

/** 收纳态分组芯片的居中外框；组内无卡片返回 null */
export function groupChipBounds(
  members: Array<{ x: number; y: number; w: number; h: number }>,
): { x: number; y: number; w: number; h: number } | null {
  if (!members.length) return null
  const left = Math.min(...members.map(c => c.x))
  const right = Math.max(...members.map(c => c.x + c.w))
  const top = Math.min(...members.map(c => c.y))
  const bottom = Math.max(...members.map(c => c.y + c.h))
  return {
    x: (left + right) / 2 - COLLAPSED_CHIP_W / 2,
    y: (top + bottom) / 2 - COLLAPSED_CHIP_H / 2,
    w: COLLAPSED_CHIP_W,
    h: COLLAPSED_CHIP_H,
  }
}

/** 网络信息（saveData / rtt），由调用方传入，纯函数不直接读 navigator */
export interface NetHint {
  saveData?: boolean
  rtt?: number
}

/**
 * 自动保存防抖时长（毫秒）。
 * 视图类 600；全文类按卡片规模递增，弱网再加 300（封顶 1500），小画布回落到 600。
 */
export function saveDebounceMs(kind: 'full' | 'view', cardCount: number, net?: NetHint): number {
  if (kind === 'view') return 600
  let delay = 900
  if (cardCount > 400) delay += 500
  else if (cardCount > 120) delay += 250
  if (net?.saveData || (typeof net?.rtt === 'number' && net.rtt >= 400)) {
    delay = Math.min(1500, delay + 300)
  }
  if (cardCount <= 30) delay = Math.min(delay, 600)
  return delay
}

/** 批量拖入资产时每张卡相对落点的右下阶梯步长（与原上传行为一致） */
export const UPLOAD_CASCADE_STEP = 40

/**
 * 多文件拖入的级联落点：第 idx 张相对首个落点往右下各退 idx 个步长，
 * 批量资产呈阶梯叠放，不会完全盖住第一张。
 */
export function cascadeDropPos(origin: Point, idx: number, step: number = UPLOAD_CASCADE_STEP): Point {
  return { x: origin.x + idx * step, y: origin.y + idx * step }
}

/** 计算「卡片几何签名」只依赖的最小字段 */
export interface CardGeometryLike {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * 卡片数据的「几何签名」: 仅由每张卡的 id 与 x/y/w/h、卡片数量/顺序决定。
 * 用途: 卡片数据每次提交(打字改提示词、任务状态、结果 url 等)都会触发舞台 effect,
 * 但只有几何字段或卡片集合变化才需要全量 DOM 几何同步(querySelectorAll + offset 读取的强制布局);
 * 签名不变即可跳过。真正的渲染尺寸变化(图片加载、面板展开)由 ResizeObserver 增量兜底, 不依赖这里。
 */
export function geometrySignature(cards: readonly CardGeometryLike[]): string {
  let s = `${cards.length};`
  for (let i = 0; i < cards.length; i += 1) {
    const c = cards[i]
    s += `${i}:${c.id}:${c.x},${c.y},${c.w},${c.h};`
  }
  return s
}

/** 连线签名只依赖的最小结构 */
export interface ConnectionLike {
  id: string
  fromId: string
  toId: string
  toSlot?: string
}

/**
 * 为每张参与连线的卡片算一个「连接签名」: 只汇总与该卡直接相连(作为起点或终点)的连线,
 * 含连线 id/对端 id/槽位。用途: 卡片对象引用未变、但连线增删时, 让真正受影响的卡片
 * (融合输入/空生成节点上游图/复刻/分层/循环等连线派生内容)精确重渲染;
 * 不相关的卡片签名不变, memo 依旧跳过。不传整张连线表给每张卡。
 */
export function connectionSignatures(connections: readonly ConnectionLike[]): Map<string, string> {
  const partsById = new Map<string, string[]>()
  const append = (id: string, part: string) => {
    const arr = partsById.get(id)
    if (arr) arr.push(part)
    else partsById.set(id, [part])
  }
  connections.forEach(c => {
    const part = `${c.id}:${c.fromId}>${c.toId}:${c.toSlot ?? ''}`
    append(c.fromId, part)
    append(c.toId, part)
  })
  const sig = new Map<string, string>()
  partsById.forEach((parts, id) => {
    // 连线增删与 setState 同序, 排序仅为同一集合的输出稳定
    parts.sort()
    sig.set(id, parts.join('|'))
  })
  return sig
}
