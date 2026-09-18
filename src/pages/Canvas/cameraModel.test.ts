import { describe, expect, it } from 'vitest'
import {
  CAMERA_NOT_SPECIFIED,
  cameraBodyOf,
  cameraFocalOption,
  cameraFocalsFor,
  cameraLensesForBody,
  cameraMountOf,
  cameraTitleFromLetter,
  DEFAULT_CAMERA_CONFIG,
  nextCameraLetter,
  reconcileConfigForBody,
  reconcileConfigForLens,
  sanitizeCameraConfig,
} from './cameraModel'

// 样板测试：覆盖摄影机字典的兼容校正与命名规则。
// 这些纯函数是后续把摄影机逻辑从超大文件抽出时的行为基线——抽离前后该文件应全绿。

const xl2BodyId = 'panavision_xl2'
const iphoneBodyId = 'apple_iphone_pro'
const cookeLensId = 'cooke_s4i'

describe('机身 × 镜头挂载表', () => {
  it('潘那维申 XL2 只能挂自家镜头（历史 Cooke 误配不应再出现在列表里）', () => {
    const lenses = cameraLensesForBody(xl2BodyId)
    expect(lenses.length).toBeGreaterThan(0)
    expect(lenses.some(l => l.id === cookeLensId)).toBe(false)
  })

  it('iPhone 机身只挂手机三摄', () => {
    const lenses = cameraLensesForBody(iphoneBodyId)
    expect(lenses.map(l => l.id)).toEqual(['iphone_pro_cam'])
  })

  it('挂不上的机身×镜头组合 cameraMountOf 返回 undefined', () => {
    expect(cameraMountOf(xl2BodyId, cookeLensId)).toBeUndefined()
    expect(cameraMountOf(xl2BodyId, cameraLensesForBody(xl2BodyId)[0].id)).toBeDefined()
  })

  it('未知机身回落第一台机身，不抛错', () => {
    expect(cameraBodyOf('__not_exist__').id).toBe(cameraBodyOf('').id)
  })
})

describe('sanitizeCameraConfig 清洗校正', () => {
  it('非法机身/镜头/焦段/光圈全部回落到默认合法值', () => {
    const cfg = sanitizeCameraConfig({
      bodyId: '__bad_body__',
      lensId: '__bad_lens__',
      focalValue: '99999mm',
      apertureValue: 'T99',
      toneId: '__bad_tone__',
      effectIds: ['__bad_effect__'],
    })
    expect(cfg.bodyId).toBe(DEFAULT_CAMERA_CONFIG.bodyId)
    expect(cameraMountOf(cfg.bodyId, cfg.lensId)).toBeDefined()
    expect(cameraFocalsFor(cfg.bodyId, cfg.lensId)).toContain(cfg.focalValue)
    expect(cfg.effectIds).toEqual([])
  })

  it('镜头不属于机身时，自动切到该机身第一支镜头（旧 XL2+Cooke 配置的清洗路径）', () => {
    const cfg = sanitizeCameraConfig({ bodyId: xl2BodyId, lensId: cookeLensId })
    expect(cfg.lensId).toBe(cameraLensesForBody(xl2BodyId)[0].id)
  })

  it('「不指定」焦段对任何组合都合法，应被保留', () => {
    const cfg = sanitizeCameraConfig({ bodyId: xl2BodyId, focalValue: CAMERA_NOT_SPECIFIED })
    expect(cfg.focalValue).toBe(CAMERA_NOT_SPECIFIED)
  })

  it('空输入返回默认配置', () => {
    expect(sanitizeCameraConfig(null)).toEqual(DEFAULT_CAMERA_CONFIG)
    expect(sanitizeCameraConfig(undefined)).toEqual(DEFAULT_CAMERA_CONFIG)
  })
})

describe('切机身/切镜头重配', () => {
  it('切到挂不住当前镜头的机身时，自动换镜头', () => {
    const start = sanitizeCameraConfig({ bodyId: 'arri_535b', lensId: cookeLensId })
    expect(start.lensId).toBe(cookeLensId)
    const moved = reconcileConfigForBody(start, xl2BodyId)
    expect(cameraMountOf(xl2BodyId, moved.lensId)).toBeDefined()
    expect(moved.lensId).not.toBe(cookeLensId)
  })

  it('切到仍挂同一镜头的机身时保留镜头', () => {
    const start = sanitizeCameraConfig({ bodyId: 'arri_535b' })
    const lensId = start.lensId
    // 找一台也能挂这支镜头的其它机身
    const other = ['arri_435', 'arri_16sr3'].find(b =>
      cameraLensesForBody(b).some(l => l.id === lensId),
    )
    expect(other).toBeDefined()
    const moved = reconcileConfigForBody(start, other as string)
    expect(moved.lensId).toBe(lensId)
  })

  it('切镜头后焦段按新组合重新校验（焦段不属于新组合则回落）', () => {
    const start = sanitizeCameraConfig({ bodyId: 'arri_535b', lensId: cookeLensId })
    const next = cameraLensesForBody(start.bodyId).find(l => l.id !== start.lensId)!
    const moved = reconcileConfigForLens(start, next.id)
    expect(cameraFocalsFor(moved.bodyId, moved.lensId)).toContain(moved.focalValue)
  })
})

describe('焦段选项提示词', () => {
  it('焦段提示词固定格式，非法值不生成画面描述', () => {
    expect(cameraFocalOption('35').prompt).toBe('35 焦距')
    expect(cameraFocalOption(CAMERA_NOT_SPECIFIED).desc).toBe('')
  })
})

describe('摄影机自动命名', () => {
  it('取当前未使用的最前字母', () => {
    expect(nextCameraLetter([])).toBe('A')
    expect(nextCameraLetter(['摄影机A'])).toBe('B')
    expect(nextCameraLetter(['摄影机A', '摄影机B', '摄影机C'])).toBe('D')
  })

  it('非标准命名与额外占用集合都被正确跳过', () => {
    expect(nextCameraLetter(['随便的名字'], new Set(['摄影机A']))).toBe('B')
  })

  it('标题格式稳定', () => {
    expect(cameraTitleFromLetter('C')).toBe('摄影机C')
  })
})
