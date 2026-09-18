import { describe, it, expect } from 'vitest'
import type { CanvasCardData } from './canvasTypes'
import {
  groupMemberIdsFor,
  isGroupCollapsedIn,
  groupsTouchedBySelection,
  applyGroupSelection,
  applyUngroup,
  applyGroupCollapsed,
} from './canvasGroup'

const card = (over: Record<string, unknown>): CanvasCardData =>
  ({ id: over.id ?? 'c', kind: over.kind ?? 'generate', x: 0, y: 0, w: 100, h: 100, ...over }) as unknown as CanvasCardData

const cards = [
  card({ id: 'a', groupId: 'g1', groupName: 'A组' }),
  card({ id: 'b', groupId: 'g1' }),
  card({ id: 'c', groupId: 'g2' }),
  card({ id: 'solo' }),
]

describe('groupMemberIdsFor', () => {
  it('无组只返回自身；有组返回全部成员（按卡片顺序）', () => {
    expect(groupMemberIdsFor('solo', cards)).toEqual(['solo'])
    expect(groupMemberIdsFor('a', cards)).toEqual(['a', 'b'])
  })
  it('找不到卡也返回自身', () => {
    expect(groupMemberIdsFor('nope', cards)).toEqual(['nope'])
  })
})

describe('isGroupCollapsedIn', () => {
  const withChip = [...cards, card({ id: 'b2', groupId: 'g1', groupCollapsed: true })]
  it('任一成员带收纳标记即收纳；空组号不收纳', () => {
    expect(isGroupCollapsedIn('g1', cards)).toBe(false)
    expect(isGroupCollapsedIn('g1', withChip)).toBe(true)
    expect(isGroupCollapsedIn(undefined, withChip)).toBe(false)
  })
})

describe('groupsTouchedBySelection', () => {
  it('收集选中卡片涉及的组号，去重且按出现顺序', () => {
    expect(groupsTouchedBySelection(['a', 'b', 'c', 'solo'], cards)).toEqual(['g1', 'g2'])
    expect(groupsTouchedBySelection(['solo'], cards)).toEqual([])
  })
})

describe('applyGroupSelection', () => {
  it('给选中卡写入组号与默认组名（不覆盖已有组名）', () => {
    const out = applyGroupSelection(cards, ['c', 'solo'], 'newg')
    const c = out.find(x => x.id === 'c')
    const solo = out.find(x => x.id === 'solo')
    const a = out.find(x => x.id === 'a')
    expect(c).toMatchObject({ groupId: 'newg', groupName: '新建组' })
    expect(solo).toMatchObject({ groupId: 'newg', groupName: '新建组' })
    // 未选中不变
    expect(a).toMatchObject({ groupId: 'g1', groupName: 'A组' })
    // 不可变：源数组与源对象不被改
    expect(cards.find(x => x.id === 'solo')?.groupId).toBeUndefined()
  })
})

describe('applyUngroup', () => {
  it('清除命中组的组号/组名/收纳标记', () => {
    const gids = new Set(['g1'])
    const out = applyUngroup(cards, gids)
    expect(out.find(x => x.id === 'a')?.groupId).toBeUndefined()
    expect(out.find(x => x.id === 'a')?.groupName).toBeUndefined()
    expect(out.find(x => x.id === 'a')?.groupCollapsed).toBeUndefined()
    expect(out.find(x => x.id === 'c')).toMatchObject({ groupId: 'g2' })
    expect(out.find(x => x.id === 'solo')).toBe(cards[3])
  })
})

describe('applyGroupCollapsed', () => {
  it('收纳写 true，恢复清成 undefined', () => {
    const collapsed = applyGroupCollapsed(cards, 'g1', true)
    expect(collapsed.find(x => x.id === 'a')?.groupCollapsed).toBe(true)
    expect(collapsed.find(x => x.id === 'b')?.groupCollapsed).toBe(true)
    const restored = applyGroupCollapsed(collapsed, 'g1', false)
    expect(restored.find(x => x.id === 'a')?.groupCollapsed).toBeUndefined()
  })
})
