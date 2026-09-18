import { describe, it, expect } from 'vitest'
import type { CanvasCardData } from './canvasTypes'
import {
  normalizeRestoredCards,
  buildPersistCards,
  classifyPersistHttpStatus,
  shouldChainNextPersist,
} from './canvasPersist'

// 测试只喂局部字段，整体经 unknown 转成卡片类型，避免逐嵌套状态补全所有必填字段
const card = (over: Record<string, unknown>): CanvasCardData =>
  ({ id: over.id ?? 'c', kind: over.kind ?? 'generate', ...over }) as unknown as CanvasCardData

const item = (over: Record<string, unknown>): NonNullable<CanvasCardData['results']>[number] =>
  over as unknown as NonNullable<CanvasCardData['results']>[number]

describe('normalizeRestoredCards', () => {
  it('顶层 running/queued：有成品收 success，无成品清 undefined', () => {
    const [withResult, noResult] = normalizeRestoredCards([
      card({ id: 'a', jobStatus: 'running', url: 'r.jpg' }),
      card({ id: 'b', jobStatus: 'queued' }),
    ])
    expect(withResult.jobStatus).toBe('success')
    expect(noResult.jobStatus).toBeUndefined()
  })

  it('generate：无在途记录的 queued 结果标失败可重试', () => {
    const [c] = normalizeRestoredCards([
      card({
        id: 'g',
        url: '',
        results: [item({ itemStatus: 'queued', url: '' })],
      }),
    ])
    expect(c.results?.[0].itemStatus).toBe('failed')
    expect(c.results?.[0].errorMsg).toContain('刷新时中断')
  })

  it('generate：有在途记录时 running 转 queued、queued 保留交续轮询', () => {
    const inflight = new Set(['g:0'])
    const [c] = normalizeRestoredCards(
      [card({ id: 'g', url: '', results: [item({ itemStatus: 'running', url: '' })] })],
      inflight,
    )
    expect(c.results?.[0].itemStatus).toBe('queued')
    expect(c.results?.[0].errorMsg).toBeUndefined()
  })

  it('generate：active 下标越界被钳制，主图同步为成功结果', () => {
    const [c] = normalizeRestoredCards([
      card({
        id: 'g',
        activeResultIndex: 5,
        results: [
          { itemStatus: 'failed', url: '' },
          { itemStatus: 'success', url: 'ok.jpg' },
        ],
      }),
    ])
    expect(c.activeResultIndex).toBe(1)
    expect(c.url).toBe('ok.jpg')
  })

  it('generate：空节点补默认 16:9，但有参考图/显式自适应时不强写', () => {
    const [empty, withImg, adaptive] = normalizeRestoredCards([
      card({ id: 'a', url: '', genParams: { model: 'm', count: 1 } }),
      card({ id: 'b', url: 'ref.jpg', genParams: { model: 'm', count: 1 } }),
      card({ id: 'c', url: '', genParams: { model: 'm', count: 1, aspectRatio: 'adaptive' } }),
    ])
    expect(empty.genParams?.aspectRatio).toBe('16:9')
    // 默认参数本身带 16:9，有参考图但未显式选比例时同样落到 16:9
    expect(withImg.genParams?.aspectRatio).toBe('16:9')
    expect(adaptive.genParams?.aspectRatio).toBe('adaptive')
  })

  it('老 image 节点升级为 generate，文件名式提示词清空', () => {
    const [a, b] = normalizeRestoredCards([
      card({ id: 'a', kind: 'image', prompt: 'IMG_2048.JPG' }),
      card({ id: 'b', kind: 'image', prompt: '一只猫在屋顶' }),
    ])
    expect(a.kind).toBe('generate')
    expect(a.prompt).toBe('')
    expect(b.prompt).toBe('一只猫在屋顶')
  })

  it('layer：中断的分层任务标失败(中断层保留原抠图地址，非中断层清空)', () => {
    const [c] = normalizeRestoredCards([
      card({
        id: 'l',
        kind: 'layer',
        layerState: {
          stage: 'generating',
          layers: [
            { genStatus: 'running', cutoutUrl: 'blob:x' },
            { genStatus: 'ready', cutoutUrl: 'blob:y' },
          ],
        },
      }),
    ])
    expect(c.layerState?.stage).toBe('ready')
    expect(c.layerState?.layers[0].genStatus).toBe('failed')
    expect(c.layerState?.layers[0].cutoutUrl).toBe('blob:x')
    expect(c.layerState?.layers[1].cutoutUrl).toBeNull()
  })

  it('replicate：运行中的正/背面标失败，分析中阶段回退', () => {
    const [c] = normalizeRestoredCards([
      card({
        id: 'r',
        kind: 'replicate',
        repState: {
          stage: 'generating',
          frontPrompt: '正面文案',
          jobStatus: { front: 'running', back: 'queued' },
        },
      }),
    ])
    expect(c.repState?.stage).toBe('ready')
    expect(c.repState?.jobStatus?.front).toBe('failed')
    expect(c.repState?.jobStatus?.back).toBe('failed')
  })

  it('tts/motion/vsr：blob 本地链接恢复时清空', () => {
    const [tts, motion, vsr] = normalizeRestoredCards([
      card({ id: 't', kind: 'tts', ttsState: { resultUrl: 'blob:abc' } }),
      card({ id: 'm', kind: 'motion', motionState: { refImageUrl: 'blob:x' } }),
      card({ id: 'v', kind: 'vsr', vsrState: { videoUrl: 'blob:y' } }),
    ])
    expect(tts.ttsState?.resultUrl).toBeUndefined()
    expect(motion.motionState?.refImageUrl).toBeUndefined()
    expect(motion.motionState?.refImageName).toBeUndefined()
    expect(vsr.vsrState?.videoUrl).toBeUndefined()
  })
})

describe('buildPersistCards', () => {
  it('分层临时抠图地址不入库', () => {
    const [c] = buildPersistCards([
      card({ id: 'l', kind: 'layer', layerState: { layers: [{ cutoutUrl: '/api/files/x' }] } }),
    ])
    expect(c.layerState?.layers[0].cutoutUrl).toBeNull()
  })

  it('全新卡 blob 主图剥空入库，running 降为 queued', () => {
    const [c] = buildPersistCards([card({ id: 'n', url: 'blob:new', jobStatus: 'running' })])
    expect(c.url).toBe('')
    expect(c.jobStatus).toBe('queued')
  })

  it('blob 在途但有上一版永久媒体时回退旧 url 与结果', () => {
    const oldResults = [{ itemStatus: 'success', url: 'old.jpg' }] as unknown as CanvasCardData['results']
    const map = new Map([['n', { url: 'old.jpg', results: oldResults }]])
    const [c] = buildPersistCards([card({ id: 'n', url: 'blob:tmp', jobStatus: 'running' })], map)
    expect(c.url).toBe('old.jpg')
    expect(c.results).toBe(oldResults)
  })

  it('tts/motion/vsr 槽位 blob 清空且非 blob 不受影响', () => {
    const [tts, motion] = buildPersistCards([
      card({ id: 't', kind: 'tts', ttsState: { resultUrl: 'blob:z', cloneAudioUrl: '/api/files/keep' } }),
      card({ id: 'm', kind: 'motion', motionState: { refVideoUrl: 'blob:v', refImageUrl: '/api/files/img' } }),
    ])
    expect(tts.ttsState?.resultUrl).toBeUndefined()
    expect(tts.ttsState?.cloneAudioUrl).toBe('/api/files/keep')
    expect(motion.motionState?.refVideoUrl).toBeUndefined()
    expect(motion.motionState?.refVideoName).toBeUndefined()
    expect(motion.motionState?.refImageUrl).toBe('/api/files/img')
  })

  it('普通卡片原样返回', () => {
    const src = card({ id: 'g', url: '/api/files/a.jpg', prompt: 'x' })
    const [out] = buildPersistCards([src])
    expect(out).toBe(src)
  })
})

describe('classifyPersistHttpStatus', () => {
  it('2xx 归为成功', () => {
    expect(classifyPersistHttpStatus(200)).toBe('ok')
    expect(classifyPersistHttpStatus(204)).toBe('ok')
  })
  it('409 归为冲突', () => {
    expect(classifyPersistHttpStatus(409)).toBe('conflict')
  })
  it('401/403/404/412 归为登录/权限失效', () => {
    for (const s of [401, 403, 404, 412]) expect(classifyPersistHttpStatus(s)).toBe('auth')
  })
  it('5xx 与其余 4xx 归为退避重试', () => {
    for (const s of [400, 413, 500, 502, 503, 504]) expect(classifyPersistHttpStatus(s)).toBe('retry')
  })
})

describe('shouldChainNextPersist', () => {
  const base = { stillDirty: true, conflictPending: false, restorePending: false }
  it('仅成功且期间有新改动时立即补发', () => {
    expect(shouldChainNextPersist({ ...base, outcome: 'ok' })).toBe(true)
  })
  it('成功但无新改动不补发', () => {
    expect(shouldChainNextPersist({ ...base, outcome: 'ok', stillDirty: false })).toBe(false)
  })
  it('冲突挂起时一律不补发(等用户选择)', () => {
    expect(shouldChainNextPersist({ ...base, outcome: 'conflict', conflictPending: true })).toBe(false)
    expect(shouldChainNextPersist({ ...base, outcome: 'ok', conflictPending: true })).toBe(false)
  })
  it('登录失效不补发(等重新登录续存)', () => {
    expect(shouldChainNextPersist({ ...base, outcome: 'auth' })).toBe(false)
  })
  it('临时失败不补发(等退避定时器或 online 事件)', () => {
    expect(shouldChainNextPersist({ ...base, outcome: 'retry' })).toBe(false)
  })
  it('本地恢复弹窗未决时不补发', () => {
    expect(shouldChainNextPersist({ ...base, outcome: 'ok', restorePending: true })).toBe(false)
  })
})
