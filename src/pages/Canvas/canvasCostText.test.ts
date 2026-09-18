import { describe, expect, it } from 'vitest'
import {
  aiAppCostText,
  BATCH_IMAGE_CONFIRM_LIMIT,
  priceKeyFor,
  priceNoteForJobs,
  priceTextForModel,
  stdCostText,
  summarizeImageJobs,
} from './canvasCostText'

describe('priceKeyFor', () => {
  it('视频按分辨率/时长区分档位', () => {
    // seedance 系视频 key 含时长
    const key = priceKeyFor('minimax-h3-text-to-video', { resolution: '1k', videoDuration: '8' })
    expect(key).toBe('minimax-h3-text-to-video|1k|8')
  })

  it('图片按分辨率/质量/比例区分档位', () => {
    const key = priceKeyFor('nano-banana-pro', { resolution: '2k', quality: 'high', aspectRatio: '16:9' })
    expect(key).toBe('nano-banana-pro|2k|high|16:9')
  })

  it('缺省参数有稳定兜底', () => {
    expect(priceKeyFor('nano-banana-pro')).toBe('nano-banana-pro|1k|medium|1:1')
  })
})

describe('priceTextForModel', () => {
  it('AI 应用渠道按固定单价 × 次数显示 / 次', () => {
    expect(priceTextForModel('wan-2.2-i2v-ai-app', 1)).toBe('¥0.80 / 次')
    expect(priceTextForModel('wan-2.2-i2v-ai-app', 3)).toBe('¥2.40 / 次')
  })

  it('count 为 0 按 1 次计（文案不出现 ¥0）', () => {
    expect(priceTextForModel('wan-2.2-i2v-ai-app', 0)).toBe('¥0.80 / 次')
  })

  it('图片单张显示 / 张，多张带数量', () => {
    const one = priceTextForModel('nano-banana2', 1, { resolution: '1k' })
    const many = priceTextForModel('nano-banana2', 4, { resolution: '1k' })
    expect(one).toContain('/ 张')
    expect(many).toContain('/ 4 张')
    expect(one).toContain('¥0.27')
  })

  it('未知模型回退按实际扣费，不返回空串', () => {
    expect(priceTextForModel('__unknown_model__', 1)).toBe('按实际扣费')
  })
})

describe('stdCostText', () => {
  it('优先站内真实扣费额', () => {
    expect(stdCostText({ chargeAmount: 1.23 })).toBe('¥1.23')
  })

  it('无扣费额时回退上游成本', () => {
    expect(stdCostText({ usage: { thirdPartyConsumeMoney: '0.88' } })).toBe('¥0.88')
  })

  it('两者皆无返回传入的空值', () => {
    expect(stdCostText(null)).toBe('')
    expect(stdCostText(undefined, '免费')).toBe('免费')
  })

  it('扣费额 0 不算有效花费', () => {
    expect(stdCostText({ chargeAmount: 0, usage: { thirdPartyConsumeMoney: '1' } })).toBe('¥1')
  })
})

describe('aiAppCostText', () => {
  it('正数价格格式化为两位小数', () => {
    expect(aiAppCostText(8)).toBe('¥8.00')
    expect(aiAppCostText(0.5)).toBe('¥0.50')
  })

  it('空/零/负数返回 undefined（不展示花费行）', () => {
    expect(aiAppCostText(undefined)).toBeUndefined()
    expect(aiAppCostText(null)).toBeUndefined()
    expect(aiAppCostText(0)).toBeUndefined()
  })
})

describe('summarizeImageJobs', () => {
  it('只汇总图片任务，标记是否含视频，金额分位取整', () => {
    const r = summarizeImageJobs([
      { model: 'nano-banana2', count: 2, params: { resolution: '1k' } },
      { model: 'wan-2.2-i2v-ai-app', count: 1 },
    ])
    expect(r.imageCount).toBe(2)
    expect(r.imageTotal).toBe(0.54)
    expect(r.hasVideo).toBe(true)
  })

  it('空数组给零值', () => {
    expect(summarizeImageJobs([])).toEqual({ imageTotal: 0, imageCount: 0, hasVideo: false })
  })

  it('阈值常量为 8 元', () => {
    expect(BATCH_IMAGE_CONFIRM_LIMIT).toBe(8)
  })
})

describe('priceNoteForJobs', () => {
  it('全部能计价时给总额与数量', () => {
    const jobs = [{ model: 'nano-banana2', count: 2, params: { resolution: '1k' } }]
    expect(priceNoteForJobs(jobs)).toBe('共 2 张 · ¥0.54')
  })

  it('含无法计价的任务时回退按实际扣费', () => {
    const jobs = [{ model: '__unknown__', count: 1 }]
    expect(priceNoteForJobs(jobs)).toBe('共 1 张 · 按实际扣费')
  })

  it('视频任务用「个」作单位', () => {
    const jobs = [{ model: 'wan-2.2-i2v-ai-app', count: 3 }]
    expect(priceNoteForJobs(jobs)).toContain('共 3 个')
  })
})
