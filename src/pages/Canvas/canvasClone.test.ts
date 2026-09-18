import { describe, it, expect } from 'vitest'
import type { CanvasCardData, CanvasConnection } from './canvasTypes'
import {
  cloneCard,
  cloneCardBatch,
  rebuildInnerConnections,
  rebuildPasteConnections,
  connectionsWithoutCards,
  selectionWithoutCards,
  stripPasteRuntime,
} from './canvasClone'

let seq = 0
const fixedId = (): string => `id${++seq}`

const card = (over: Record<string, unknown>): CanvasCardData =>
  ({ id: 'c', kind: 'generate', x: 0, y: 0, ...over }) as unknown as CanvasCardData

const conn = (id: string, fromId: string, toId: string, toSlot?: string): CanvasConnection =>
  ({ id, fromId, toId, ...(toSlot ? { toSlot } : {}) }) as CanvasConnection

describe('cloneCard', () => {
  it('深拷贝、新 id、偏移、剥离顶层运行态与专用节点结果', () => {
    const src = card({
      id: 'a',
      x: 10,
      y: 20,
      jobStatus: 'running',
      taskId: 't',
      errorMsg: 'e',
      costText: '¥1',
      ttsState: { resultUrl: 'a.mp3', remoteTaskId: 'rt', jobStatus: 'running' },
    })
    const copy = cloneCard(src, 'a2', 32, 32)
    expect(copy.id).toBe('a2')
    expect(copy.x).toBe(42)
    expect(copy.y).toBe(52)
    expect(copy.taskId).toBeUndefined()
    expect(copy.jobStatus).toBeUndefined()
    expect(copy.ttsState?.resultUrl).toBeUndefined()
    expect(copy.ttsState?.remoteTaskId).toBeUndefined()
    expect(copy.ttsState?.jobStatus).toBe('idle')
    // 深拷贝：改副本不影响源
    copy.x = 999
    expect(src.x).toBe(10)
  })
})

describe('cloneCardBatch', () => {
  it('建立 id/group 映射，粘贴时清在途结果与过程态', () => {
    const sources = [
      card({ id: 'a', groupId: 'g1', results: [{ itemStatus: 'running' }, { itemStatus: 'success', url: 'ok.jpg' }] }),
      card({ id: 'b', groupId: 'g1' }),
    ]
    const { copies, idMap, gidMap } = cloneCardBatch(sources, fixedId, 48, 48, { resetResults: true })
    expect(copies).toHaveLength(2)
    expect(idMap.size).toBe(2)
    // 同组映射到同一个新 groupId
    expect(copies[0].groupId).toBe(copies[1].groupId)
    expect(copies[0].groupId).toBe(gidMap.get('g1'))
    // 在途结果被丢弃，成品保留，下标钳制
    expect(copies[0].results).toHaveLength(1)
    expect(copies[0].results?.[0].url).toBe('ok.jpg')
  })

  it('普通复制不剥离结果列表', () => {
    const sources = [card({ id: 'a', results: [{ itemStatus: 'running' }] })]
    const { copies } = cloneCardBatch(sources, fixedId, 48, 48)
    expect(copies[0].results).toHaveLength(1)
  })
})

describe('stripPasteRuntime', () => {
  it('复刻在途正背面置空闲但成品保留，分层阶段回落', () => {
    const c = card({
      repState: {
        stage: 'generating',
        frontPrompt: 'fp',
        frontUrl: 'f.jpg',
        jobStatus: { front: 'running', back: 'success' },
      },
      layerState: { stage: 'analyzing' },
      mergeState: { running: true, error: 'x' },
      polishState: { jobStatus: 'failed', errorMsg: 'err' },
      agentState: { jobStatus: 'running', errorMsg: 'err' },
    })
    stripPasteRuntime(c)
    expect(c.repState?.stage).toBe('ready')
    expect(c.repState?.jobStatus.front).toBe('idle')
    expect(c.repState?.jobStatus.back).toBe('success')
    expect(c.repState?.frontUrl).toBe('f.jpg')
    expect(c.layerState?.stage).toBe('idle')
    expect(c.mergeState?.running).toBe(false)
    expect(c.mergeState?.error).toBeNull()
    expect(c.polishState?.jobStatus).toBe('idle')
    expect(c.agentState?.jobStatus).toBe('idle')
  })
})

describe('rebuildInnerConnections', () => {
  it('只重建两端都在集合内的连线', () => {
    const idMap = new Map([['a', 'a2'], ['b', 'b2']])
    const conns = [conn('x', 'a', 'b'), conn('y', 'a', 'out')]
    const out = rebuildInnerConnections(conns, idMap, fixedId)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ fromId: 'a2', toId: 'b2' })
    expect(out[0].id).toBeTruthy()
  })
})

describe('rebuildPasteConnections', () => {
  const stored = [
    { fromId: 'a', toId: 'b' },
    { fromId: 'a', toId: 'out' },
    { fromId: 'out2', toId: 'b' },
  ]
  it('内部连线两端映射，外部连线只映射复制端', () => {
    const idMap = new Map([['a', 'a2'], ['b', 'b2']])
    const out = rebuildPasteConnections(stored, idMap, fixedId)
    const byFromTo = new Map(out.map(c => [`${c.fromId}>${c.toId}`, c]))
    expect(byFromTo.has('a2>b2')).toBe(true)
    expect(byFromTo.has('a2>out')).toBe(true)
    expect(byFromTo.has('out2>b2')).toBe(true)
  })
  it('与现有连线和批内去重、过滤自连', () => {
    const idMap = new Map([['a', 'a2'], ['b', 'b2']])
    const existing = [conn('e', 'a2', 'b2')]
    const dup = [
      { fromId: 'a', toId: 'b' }, // 与现有重复
      { fromId: 'a', toId: 'b' }, // 批内重复
      { fromId: 'a', toId: 'b', toSlot: 'front' as const }, // 不同槽，保留
      { fromId: 'a', toId: 'a' }, // 映射后自连，过滤
    ]
    const out = rebuildPasteConnections(dup, idMap, fixedId, existing)
    expect(out).toHaveLength(1)
    expect(out[0].toSlot).toBe('front')
  })
})

describe('删除清理', () => {
  it('连线任一端命中即删，选中态剔除', () => {
    const conns = [conn('1', 'a', 'b'), conn('2', 'b', 'c'), conn('3', 'x', 'y')]
    const idSet = new Set(['b'])
    expect(connectionsWithoutCards(conns, idSet).map(c => c.id)).toEqual(['3'])
    expect(selectionWithoutCards(['a', 'b', 'c'], idSet)).toEqual(['a', 'c'])
  })
})
