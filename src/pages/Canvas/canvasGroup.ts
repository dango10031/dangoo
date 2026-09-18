// 分组 / 选择集的纯函数：从卡片快照推导组 id 集合，或对卡片数组做不可变的组变换。
// 从 useCanvas 抽出：不碰 state / uid / DOM，组号（uid）由调用方传入，便于单测注入固定值。
import type { CanvasCardData } from './canvasTypes'

/** 一张卡所属组内的全部成员 id（按卡片顺序）；无组或找不到卡时只返回自身 */
export function groupMemberIdsFor(cardId: string, cards: CanvasCardData[]): string[] {
  const gid = cards.find(c => c.id === cardId)?.groupId
  if (!gid) return [cardId]
  return cards.filter(c => c.groupId === gid).map(c => c.id)
}

/** 组是否处于收纳态：任一成员带 groupCollapsed 标记即收纳；空组号恒为否 */
export function isGroupCollapsedIn(gid: string | undefined, cards: CanvasCardData[]): boolean {
  if (!gid) return false
  return cards.some(c => c.groupId === gid && c.groupCollapsed)
}

/** 选中卡片涉及到的全部组号：去重，按在卡片数组里首次出现的顺序 */
export function groupsTouchedBySelection(selectedIds: string[], cards: CanvasCardData[]): string[] {
  const sel = new Set(selectedIds)
  const gids: string[] = []
  cards.forEach(c => {
    if (c.groupId && sel.has(c.id) && !gids.includes(c.groupId)) gids.push(c.groupId)
  })
  return gids
}

/** 新建分组：给选中卡写入组号；已有组名保留，否则给默认名「新建组」。返回新数组，不改源 */
export function applyGroupSelection(
  cards: CanvasCardData[],
  selectedIds: string[],
  gid: string,
): CanvasCardData[] {
  const sel = new Set(selectedIds)
  return cards.map(c =>
    sel.has(c.id) ? { ...c, groupId: gid, groupName: c.groupName ?? '新建组' } : c,
  )
}

/** 解散分组：命中组的组号 / 组名 / 收纳标记全部清除；无关卡保持同一引用 */
export function applyUngroup(cards: CanvasCardData[], gids: Set<string>): CanvasCardData[] {
  return cards.map(c =>
    c.groupId && gids.has(c.groupId)
      ? { ...c, groupId: undefined, groupName: undefined, groupCollapsed: undefined }
      : c,
  )
}

/** 设置一组的收纳态：收纳写 true，恢复清成 undefined（与历史存储形态一致） */
export function applyGroupCollapsed(
  cards: CanvasCardData[],
  gid: string,
  collapsed: boolean,
): CanvasCardData[] {
  return cards.map(c => (c.groupId === gid ? { ...c, groupCollapsed: collapsed || undefined } : c))
}
