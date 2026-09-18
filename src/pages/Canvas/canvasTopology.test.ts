import { describe, it, expect } from 'vitest'
import type { CanvasCardData, CanvasConnection } from './canvasTypes'
import {
  cardShowsVideo,
  buildInboundImageMap,
  isNodeOwnResult,
  effectiveRefUrlsFor,
  effectiveLayerSourceFor,
  resolveRepSlotSourcesFor,
  effectiveRepSlotsFor,
} from './canvasTopology'

const genCard = (over: Partial<CanvasCardData>): CanvasCardData =>
  ({ id: over.id ?? 'x', kind: over.kind ?? 'image', url: over.url, ...over }) as CanvasCardData

const conn = (id: string, fromId: string, toId: string, toSlot?: string): CanvasConnection =>
  ({ id, fromId, toId, toSlot }) as CanvasConnection

describe('cardShowsVideo', () => {
  it('老视频卡 / 当前结果是视频 / 普通图', () => {
    expect(cardShowsVideo(undefined)).toBe(false)
    expect(cardShowsVideo(genCard({ id: 'v', kind: 'video', url: 'a.mp4' }))).toBe(true)
    expect(cardShowsVideo(genCard({ id: 'g', url: 'i.jpg', results: [{ isVideo: true }] as CanvasCardData['results'] }))).toBe(true)
    expect(cardShowsVideo(genCard({ id: 'g', url: 'i.jpg', results: [{ isVideo: false, url: 'i.jpg' }] as CanvasCardData['results'] }))).toBe(false)
  })
})

describe('buildInboundImageMap', () => {
  it('按 toId 收集上游图片并去重，跳过视频结果', () => {
    const cards = [
      genCard({ id: 'img1', url: '1.jpg' }),
      genCard({ id: 'img2', url: '2.jpg' }),
      genCard({ id: 'vid', kind: 'video', url: 'v.mp4' }),
    ]
    const conns = [
      conn('c1', 'img1', 'node'),
      conn('c2', 'img2', 'node'),
      conn('c3', 'img1', 'node'), // 重复
      conn('c4', 'vid', 'node'), // 视频不作图片参考
    ]
    const map = buildInboundImageMap(cards, conns)
    expect(map.get('node')).toEqual(['1.jpg', '2.jpg'])
  })
  it('当前主看结果为视频的生成节点也被跳过', () => {
    const cards = [genCard({ id: 'g', url: 'r.mp4', results: [{ isVideo: true }] as CanvasCardData['results'] })]
    const map = buildInboundImageMap(cards, [conn('c', 'g', 'n')])
    expect(map.get('n')).toBeUndefined()
  })
})

describe('isNodeOwnResult', () => {
  it('主图等于某条成功结果才算自引用', () => {
    const own = genCard({ id: 'a', url: 'r.jpg', results: [{ itemStatus: 'success', url: 'r.jpg' }] })
    expect(isNodeOwnResult(own)).toBe(true)
    const upload = genCard({ id: 'b', url: 'u.jpg', results: [{ itemStatus: 'success', url: 'r.jpg' }] })
    expect(isNodeOwnResult(upload)).toBe(false)
    const pending = genCard({ id: 'c', url: 'r.jpg', results: [{ itemStatus: 'running', url: 'r.jpg' }] })
    expect(isNodeOwnResult(pending)).toBe(false)
  })
})

describe('effectiveRefUrlsFor', () => {
  it('上传主图置顶 + 参考行 + 上游，去重并封顶 9', () => {
    const card = genCard({
      id: 'n',
      url: 'own.jpg',
      refUrls: ['r1.jpg', 'own.jpg', 'r2.jpg'],
      results: [{ itemStatus: 'success', url: 'other.jpg' }],
    })
    const up = ['u1.jpg', 'r1.jpg', 'u2.jpg']
    const out = effectiveRefUrlsFor(card, up)
    expect(out[0]).toBe('own.jpg')
    expect(out).toContain('r1.jpg')
    expect(out).toContain('u1.jpg')
    expect(new Set(out).size).toBe(out.length) // 无重复
    expect(out.length).toBeLessThanOrEqual(9)
  })
  it('结果主图不自引用，只取参考行和上游', () => {
    const card = genCard({
      id: 'n',
      url: 'res.jpg',
      results: [{ itemStatus: 'success', url: 'res.jpg' }],
      refUrls: ['a.jpg'],
    })
    const out = effectiveRefUrlsFor(card, ['b.jpg'])
    expect(out).toEqual(['a.jpg', 'b.jpg'])
    expect(out).not.toContain('res.jpg')
  })
  it('超过 9 张时截断', () => {
    const card = genCard({ id: 'n', refUrls: Array.from({ length: 20 }, (_, i) => `r${i}.jpg`) })
    expect(effectiveRefUrlsFor(card, []).length).toBe(9)
  })
})

describe('effectiveLayerSourceFor', () => {
  it('上传图优先于上游', () => {
    expect(effectiveLayerSourceFor(genCard({ layerState: { sourceUrl: 'up.jpg' } } as Partial<CanvasCardData>), 'in.jpg')).toBe('up.jpg')
    expect(effectiveLayerSourceFor(genCard({}), 'in.jpg')).toBe('in.jpg')
    expect(effectiveLayerSourceFor(undefined, undefined)).toBeNull()
  })
})

describe('resolveRepSlotSourcesFor / effectiveRepSlotsFor', () => {
  const repCard = (rep: Record<string, unknown>) =>
    genCard({ id: 'rep', repState: rep as unknown as CanvasCardData['repState'] })

  it('槽位上传优先于连线', () => {
    const cards = [repCard({ frontUrl: 'upload.jpg' }), genCard({ id: 'up', url: 'conn.jpg' })]
    const conns = [conn('c', 'up', 'rep', 'front')]
    const src = resolveRepSlotSourcesFor(cards[0], cards, conns)
    expect(src.front).toEqual({ kind: 'upload', slot: 'front', url: 'upload.jpg' })
  })

  it('连到指定槽的线优先于通用线', () => {
    const cards = [repCard({}), genCard({ id: 'a', url: 'a.jpg' }), genCard({ id: 'b', url: 'b.jpg' })]
    const conns = [conn('g', 'b', 'rep'), conn('s', 'a', 'rep', 'front')]
    const src = resolveRepSlotSourcesFor(cards[0], cards, conns)
    expect(src.front?.url).toBe('a.jpg')
  })

  it('无槽通用线按槽顺序兜底，背面无来源时借用正面', () => {
    const cards = [repCard({}), genCard({ id: 'a', url: 'a.jpg' })]
    const conns = [conn('g', 'a', 'rep')]
    const slots = effectiveRepSlotsFor(cards[0], cards, conns)
    expect(slots.front).toBe('a.jpg')
    expect(slots.back).toBe('a.jpg') // 借用正面
    expect(slots.logo).toBeNull()
    expect(slots.qr).toBeNull()
  })

  it('两张通用线时背面拿到第二张而非借用', () => {
    const cards = [repCard({}), genCard({ id: 'a', url: 'a.jpg' }), genCard({ id: 'b', url: 'b.jpg' })]
    const conns = [conn('g1', 'a', 'rep'), conn('g2', 'b', 'rep')]
    const slots = effectiveRepSlotsFor(cards[0], cards, conns)
    expect(slots.front).toBe('a.jpg')
    expect(slots.back).toBe('b.jpg')
  })
})
