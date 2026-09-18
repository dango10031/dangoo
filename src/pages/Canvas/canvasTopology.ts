

// useCanvas 里保留同名薄包装与「按引用变化重建索引」的记忆化缓存。
import type { CanvasCardData, CanvasConnection, RepSlot } from './canvasTypes'
import { REP_SLOTS } from './canvasTypes'

export const EMPTY_STRINGS: readonly string[] = []

/** 卡片主图是否为视频结果（生成节点看当前 active 结果项，老视频卡看 kind） */
export function cardShowsVideo(card: CanvasCardData | undefined): boolean {
  if (!card) return false
  if (card.kind === 'video') return true
  const idx = card.activeResultIndex ?? 0
  return !!card.results?.[idx]?.isVideo
}

/**
 * 重建「入边图片索引」：toId → 去重后的上游图片 url 列表。
 * 视频结果不作图片参考。按 cards/connections 引用变化一次性重建，查询 O(1)。
 */
export function buildInboundImageMap(
  cards: CanvasCardData[],
  connections: CanvasConnection[],
): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const imageById = new Map<string, string | undefined>()
  cards.forEach(c => imageById.set(c.id, !cardShowsVideo(c) ? c.url : undefined))
  connections.forEach(conn => {
    const url = imageById.get(conn.fromId)
    if (!url) return
    const arr = map.get(conn.toId)
    if (!arr) map.set(conn.toId, [url])
    else if (!arr.includes(url)) arr.push(url)
  })
  return map
}

/** 节点主图是否为「本节点自己生成出的结果」而非用户放到图片位的参考图 */
export function isNodeOwnResult(card: CanvasCardData): boolean {
  const u = card.url
  if (!u || cardShowsVideo(card)) return false
  return (card.results ?? []).some(r => r && r.itemStatus === 'success' && r.url === u)
}

/**
 * 生效参考图：节点图片位的图作第一张参考（图生视频时即首帧），
 * 其余参考图行顺排，上游连线节点的图追加其后，总数封顶 9。
 * 主图若是本节点刚生成的结果则不能自引用，只有上传图（不等于任何成功结果）才作自身参考。
 */
export function effectiveRefUrlsFor(card: CanvasCardData, upstream: readonly string[]): string[] {
  const ownUrl = card.url && !cardShowsVideo(card) && !isNodeOwnResult(card) ? card.url : undefined
  const own = ownUrl
    ? [ownUrl, ...(card.refUrls ?? []).filter(u => u !== ownUrl)]
    : [...(card.refUrls ?? [])]
  const ups = upstream.filter(u => !own.includes(u))
  return [...own, ...ups].slice(0, 9)
}

/** 分层节点有效原图：上传优先，未上传时承接第一张上游连线图 */
export function effectiveLayerSourceFor(
  card: CanvasCardData | undefined,
  firstUpstream: string | undefined,
): string | null {
  return card?.layerState?.sourceUrl ?? firstUpstream ?? null
}

/** 某个图片槽当前显示图片的真实来源：本地上传 / 某条连线（含无槽位的通用连线兜底） */
export type RepSlotSource =
  | { kind: 'upload'; slot: RepSlot; url: string }
  | { kind: 'conn'; connId: string; url: string }
  | null

/**
 * 解析四个图片槽各自的有效来源：槽位上传 > 连到该槽的线 > 无槽通用线按序兜底。
 * 背面无来源时借用正面来源（只传/只连一张也能跑）。
 */
export function resolveRepSlotSourcesFor(
  card: CanvasCardData | undefined,
  cards: CanvasCardData[],
  connections: CanvasConnection[],
): Record<RepSlot, RepSlotSource> {
  const rs = card?.repState
  const uploaded: Record<RepSlot, string | null> = {
    front: rs?.frontUrl ?? null,
    back: rs?.backUrl ?? null,
    logo: rs?.logoUrl ?? null,
    qr: rs?.qrUrl ?? null,
  }
  const bySlot: Record<RepSlot, RepSlotSource[]> = { front: [], back: [], logo: [], qr: [] }
  const generic: RepSlotSource[] = []
  connections.forEach(conn => {
    if (conn.toId !== card?.id) return
    const up = cards.find(c => c.id === conn.fromId)
    if (!up?.url || cardShowsVideo(up)) return
    const src: RepSlotSource = { kind: 'conn', connId: conn.id, url: up.url }
    if (conn.toSlot) {
      if (!bySlot[conn.toSlot].some(s => s?.url === src.url)) bySlot[conn.toSlot].push(src)
    } else if (!generic.some(s => s?.url === src.url)) {
      generic.push(src)
    }
  })
  const result: Record<RepSlot, RepSlotSource> = { front: null, back: null, logo: null, qr: null }
  let genericIdx = 0
  REP_SLOTS.forEach(slot => {
    const up = uploaded[slot]
    result[slot] = up ? { kind: 'upload', slot, url: up } : bySlot[slot][0] ?? generic[genericIdx++] ?? null
  })
  // 背面无自己的来源时借用正面（展示为「背面·同正面」），换位时按用户看到的这张图处理
  if (!result.back && result.front) result.back = result.front
  return result
}

/** 复刻节点四个图片槽位的有效图片 url（槽位上传 > 槽位连线 > 通用连线兜底；背面复用正面） */
export function effectiveRepSlotsFor(
  card: CanvasCardData | undefined,
  cards: CanvasCardData[],
  connections: CanvasConnection[],
): Record<RepSlot, string | null> {
  const sources = resolveRepSlotSourcesFor(card, cards, connections)
  return {
    front: sources.front?.url ?? null,
    back: sources.back?.url ?? null,
    logo: sources.logo?.url ?? null,
    qr: sources.qr?.url ?? null,
  }
}

/**
 * 收集直连上游的文本（Agent 取其输出、空输出回退 prompt；其余节点取 prompt），
 * 按入边连线顺序排列，去首尾空白，空白文本跳过。供 Agent / Loop 拼接上游上下文。
 */
export function collectUpstreamTextsFor(
  cardId: string,
  cards: CanvasCardData[],
  connections: CanvasConnection[],
): string[] {
  const texts: string[] = []
  connections
    .filter(c => c.toId === cardId)
    .forEach(conn => {
      const up = cards.find(c => c.id === conn.fromId)
      if (!up) return
      const t = up.kind === 'agent' ? (up.agentState?.output || up.prompt || '') : (up.prompt ?? '')
      if (t.trim()) texts.push(t.trim())
    })
  return texts
}

export interface LoopTask {
  prompt: string
  /** true = 来自 Agent 表格的一行；false = 来自 Agent 文本按行拆分 */
  rowDriven: boolean
}

/**
 * Loop 任务推导：只看直连的 Agent 上游。
 * - 表格模式：每个启用行把非空单元格拼成「列名: 值」多行，一行一个任务；
 * - 文本模式：输出（空则回退 prompt）按空行拆分，剥掉行首序号（1. / 1) / 1、），非空行各一个任务。
 */
export function deriveLoopTasksFor(
  cardId: string,
  cards: CanvasCardData[],
  connections: CanvasConnection[],
): LoopTask[] {
  const tasks: LoopTask[] = []
  connections
    .filter(c => c.toId === cardId)
    .forEach(conn => {
      const up = cards.find(c => c.id === conn.fromId)
      if (!up || up.kind !== 'agent' || !up.agentState) return
      const st = up.agentState
      if (st.tableMode) {
        st.tableRows.forEach(row => {
          if (row.enabled === false) return
          const lines = st.tableColumns
            .map(col => ({ name: col.name, value: (row.cells[col.id] ?? '').trim() }))
            .filter(v => v.value)
          if (lines.length) tasks.push({ prompt: lines.map(v => `${v.name}: ${v.value}`).join('\n'), rowDriven: true })
        })
      } else {
        const text = (st.output || up.prompt || '').trim()
        if (!text) return
        text
          .split(/\n+/)
          .map(t => t.replace(/^\s*\d+\s*[.、)）]\s*/, '').trim())
          .filter(Boolean)
          .forEach(pt => tasks.push({ prompt: pt, rowDriven: false }))
      }
    })
  return tasks
}

/**
 * Loop 节点共享参考图: 节点自身入边图 + 每个直连 Agent 上游的入边图, 去重合并后最多 9 张,
 * 透传给该 Loop 拆出的每个任务。非 Agent 上游不做二级展开。
 */
export function deriveLoopSharedRefsFor(
  cardId: string,
  cards: CanvasCardData[],
  connections: CanvasConnection[],
): string[] {
  const inbound = buildInboundImageMap(cards, connections)
  const set = new Set<string>()
  ;(inbound.get(cardId) ?? []).forEach(u => set.add(u))
  connections
    .filter(c => c.toId === cardId)
    .forEach(c => {
      const up = cards.find(x => x.id === c.fromId)
      if (up?.kind === 'agent') (inbound.get(up.id) ?? []).forEach(u => set.add(u))
    })
  return [...set].slice(0, 9)
}
