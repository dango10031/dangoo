import { describe, it, expect } from 'vitest'
import type { CanvasCardData, CanvasConnection } from './canvasTypes'
import { resolveMergeInputs, collectExportItemsFor } from './canvasCollect'

const card = (over: Record<string, unknown>): CanvasCardData =>
  ({ id: over.id ?? 'c', kind: over.kind ?? 'generate', ...over }) as unknown as CanvasCardData

const conn = (fromId: string, toId: string): CanvasConnection => ({ id: `${fromId}-${toId}`, fromId, toId })

describe('resolveMergeInputs', () => {
  const merge = card({ id: 'm', kind: 'merge' })
  const full = card({ id: 'full', url: 'full.jpg' })
  const full2 = card({ id: 'full2', url: 'full2.jpg' })
  const patch = card({
    id: 'patch',
    url: 'patch.jpg',
    cropContext: { version: 2, source: { fingerprint: 'fp' } },
  })
  const videoish = card({ id: 'v', kind: 'video', url: 'v.mp4' })

  it('缺完整原图报错', () => {
    const out = resolveMergeInputs('m', [merge, patch], [conn('patch', 'm')])
    expect(out.error).toBe('请连接一张完整原图')
    expect(out.original).toBeUndefined()
  })

  it('缺局部修改图报错', () => {
    const out = resolveMergeInputs('m', [merge, full], [conn('full', 'm')])
    expect(out.error).toBe('请连接至少一张提取的局部修改图')
    expect(out.original?.url).toBe('full.jpg')
  })

  it('多张原图取第一张，局部图按连线顺序保留', () => {
    const out = resolveMergeInputs(
      'm',
      [merge, full, full2, patch],
      [conn('full', 'm'), conn('patch', 'm'), conn('full2', 'm')],
    )
    expect(out.error).toBeUndefined()
    expect(out.original?.url).toBe('full.jpg')
    expect(out.patches.map(p => p.url)).toEqual(['patch.jpg'])
  })

  it('局部图超过 16 张报错', () => {
    const cards = [merge, full]
    const conns = [conn('full', 'm')]
    for (let i = 0; i < 17; i += 1) {
      cards.push(card({ id: `p${i}`, url: `p${i}.jpg`, cropContext: { version: 2 } }))
      conns.push(conn(`p${i}`, 'm'))
    }
    const out = resolveMergeInputs('m', cards, conns)
    expect(out.error).toBe('一次最多融合 16 张局部图')
  })

  it('视频卡与无 url 卡不参与', () => {
    const noUrl = card({ id: 'n', url: '' })
    const out = resolveMergeInputs('m', [merge, videoish, noUrl, full], [conn('v', 'm'), conn('n', 'm'), conn('full', 'm')])
    expect(out.error).toBe('请连接至少一张提取的局部修改图')
    expect(out.original?.url).toBe('full.jpg')
  })
})

describe('collectExportItemsFor', () => {
  const cards = [
    card({ id: 'a', title: '猫', results: [
      { itemStatus: 'success', url: 'http://x/a1.jpg' },
      { itemStatus: 'running', url: '' },
      { itemStatus: 'success', url: 'http://x/a2.jpg', title: '第二张' },
    ] }),
    card({ id: 'b', prompt: '狗', url: 'http://x/b.jpg' }),
    card({ id: 'v', kind: 'video', url: 'http://x/v.mp4', results: [{ itemStatus: 'success', url: 'http://x/v2.mp4', isVideo: true }] }),
    card({ id: 'empty' }),
  ]

  it('成功结果优先（含命名），无结果才取主图，按选中顺序', () => {
    const out = collectExportItemsFor(['a', 'b', 'empty'], cards, u => u)
    expect(out).toEqual([
      { url: 'http://x/a1.jpg', name: '猫-1', isVideo: false },
      { url: 'http://x/a2.jpg', name: '第二张', isVideo: false },
      { url: 'http://x/b.jpg', name: '狗', isVideo: false },
    ])
  })

  it('视频结果带 isVideo，视频卡主图也是视频', () => {
    const out = collectExportItemsFor(['v'], cards, u => u)
    expect(out).toEqual([{ url: 'http://x/v2.mp4', name: '生成图片-1', isVideo: true }])
    const onlyMain = collectExportItemsFor(['v'], [card({ id: 'v', kind: 'video', url: 'http://x/v.mp4' })], u => u)
    expect(onlyMain[0]).toMatchObject({ url: 'http://x/v.mp4', isVideo: true })
  })

  it('只留 http(s)、去重，站内链经 toAbsolute 转绝对地址后保留', () => {
    const cs = [
      card({ id: 'a', results: [{ itemStatus: 'success', url: 'http://x/a.jpg' }] }),
      card({ id: 'b', url: 'http://x/a.jpg' }),
      card({ id: 'c', url: '/api/files/c.jpg' }),
      card({ id: 'd', url: 'blob:local' }),
    ]
    const out = collectExportItemsFor(['a', 'b', 'c', 'd'], cs, u =>
      u.startsWith('/api/files/') ? `http://host${u}` : u,
    )
    expect(out.map(i => i.url)).toEqual(['http://x/a.jpg', 'http://host/api/files/c.jpg'])
  })
})
