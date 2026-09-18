import { describe, expect, it } from 'vitest'
import type { AigcModelInfo } from '@/lib/aigc'
import {
  aspectRatioForBody,
  buildAiAppRunBody,
  buildBodyWithDefaults,
  buildNodeRunBody,
  bodyWithRhUrls,
  firstFrameFieldName,
  looksLikeFileName,
  matchAspectRatioEnum,
  pickParamValue,
  resolveI2vPrompt,
  sanitizeLogBody,
} from './nodeParams'
import { AI_APP_FIRST_FRAME_KEY, DEFAULT_MOTION_PROMPT } from './canvasModels'
import type { GenNodeParams } from './canvasTypes'

function infoWith(overrides: Partial<AigcModelInfo> = {}): AigcModelInfo {
  return {
    scalar_params: [],
    media_params: [],
    ...overrides,
  } as unknown as AigcModelInfo
}

describe('pickParamValue', () => {
  it('无契约参数返回 null', () => {
    expect(pickParamValue(null, 'aspectRatio', '16:9')).toBeNull()
  })

  it('枚举包含首选值时用首选', () => {
    const info = infoWith({
      scalar_params: [{ name: 'aspectRatio', enum: ['1:1', '16:9', '4:3'], default: '1:1' }],
    })
    expect(pickParamValue(info, 'aspectRatio', '16:9')).toBe('16:9')
  })

  it('枚举不含首选时回落默认值', () => {
    const info = infoWith({
      scalar_params: [{ name: 'aspectRatio', enum: ['1:1', '16:9'], default: '1:1' }],
    })
    expect(pickParamValue(info, 'aspectRatio', '99:1')).toBe('1:1')
  })

  it('默认值是 empty 时回落 null（表示不送该参数）', () => {
    const info = infoWith({
      scalar_params: [{ name: 'aspectRatio', enum: ['empty', '1:1'], default: 'empty' }],
    })
    expect(pickParamValue(info, 'aspectRatio', '99:1')).toBeNull()
  })

  it('非枚举参数直接采用首选值', () => {
    const info = infoWith({ scalar_params: [{ name: 'prompt' }] })
    expect(pickParamValue(info, 'prompt', '你好')).toBe('你好')
  })
})

describe('aspectRatioForBody', () => {
  it('empty 一律返回 null', () => {
    expect(aspectRatioForBody(null, 'empty')).toBeNull()
  })

  it('adaptive 仅在渠道枚举支持时保留，否则省略', () => {
    const support = infoWith({ scalar_params: [{ name: 'aspectRatio', enum: ['adaptive', '1:1'] }] })
    const unsupport = infoWith({ scalar_params: [{ name: 'aspectRatio', enum: ['1:1'] }] })
    expect(aspectRatioForBody(support, 'adaptive')).toBe('adaptive')
    expect(aspectRatioForBody(unsupport, 'adaptive')).toBeNull()
  })
})

describe('matchAspectRatioEnum', () => {
  it('返回与目标宽高比最接近的枚举', () => {
    const enums = ['1:1', '16:9', '9:16', '4:3']
    expect(matchAspectRatioEnum(enums, 1920, 1080)).toBe('16:9')
    expect(matchAspectRatioEnum(enums, 1080, 1920)).toBe('9:16')
    expect(matchAspectRatioEnum(enums, 1000, 1000)).toBe('1:1')
  })

  it('支持 x 分隔与小数比例', () => {
    expect(matchAspectRatioEnum(['16x9', '1x1'], 1920, 1080)).toBe('16x9')
    expect(matchAspectRatioEnum(['2.39:1', '1:1'], 2390, 1000)).toBe('2.39:1')
  })

  it('比例超出渠道档位（对数偏差过大）返回 null', () => {
    // 3:1 的图，渠道只有 1:1 / 16:9 —— 偏差超 0.45，不强配
    expect(matchAspectRatioEnum(['1:1', '16:9'], 3000, 1000)).toBeNull()
  })

  it('空枚举或零尺寸返回 null', () => {
    expect(matchAspectRatioEnum(undefined, 100, 100)).toBeNull()
    expect(matchAspectRatioEnum(['1:1'], 0, 100)).toBeNull()
  })
})

describe('buildBodyWithDefaults', () => {
  it('写入提示词、非 empty 默认参数、参考图', () => {
    const info = infoWith({
      scalar_params: [
        { name: 'quality', default: 'high' },
        { name: 'ratio', default: 'empty' },
      ],
    })
    const body = buildBodyWithDefaults(info, '画一只猫', ['http://a/1.jpg'])
    expect(body).toEqual({ prompt: '画一只猫', quality: 'high', imageUrls: ['http://a/1.jpg'] })
  })

  it('无参考图时不带 imageUrls；契约为空时只有 prompt', () => {
    expect(buildBodyWithDefaults(null, 'hi', [])).toEqual({ prompt: 'hi' })
  })
})

describe('文件名识别与图生视频提示词', () => {
  it('识别常见图片/视频文件名', () => {
    expect(looksLikeFileName('photo.JPG')).toBe(true)
    expect(looksLikeFileName('clip.mp4')).toBe(true)
    expect(looksLikeFileName('  a.png  ')).toBe(true)
    expect(looksLikeFileName('一只猫在奔跑')).toBe(false)
  })

  it('有效描述原样返回；空串/文件名回退中性运动描述', () => {
    expect(resolveI2vPrompt('镜头缓慢推进')).toBe('镜头缓慢推进')
    expect(resolveI2vPrompt('')).toBe(DEFAULT_MOTION_PROMPT)
    expect(resolveI2vPrompt('a.mp4')).toBe(DEFAULT_MOTION_PROMPT)
    expect(resolveI2vPrompt(undefined)).toBe(DEFAULT_MOTION_PROMPT)
  })
})

describe('firstFrameFieldName', () => {
  it('优先 firstFrameUrl，其次 imageUrl，缺省 firstFrameUrl', () => {
    expect(firstFrameFieldName(infoWith({ media_params: [{ name: 'imageUrl' }] }))).toBe('imageUrl')
    expect(firstFrameFieldName(infoWith({ media_params: [{ name: 'firstFrameUrl' }] }))).toBe('firstFrameUrl')
    expect(firstFrameFieldName(null)).toBe('firstFrameUrl')
  })
})

describe('sanitizeLogBody', () => {
  it('剔除首帧内部字段与 undefined 值', () => {
    const out = sanitizeLogBody({
      prompt: '猫',
      __aiAppFirstFrameUrl: '内部占位',
      ratio: '1:1',
      dropped: undefined,
    })
    expect(out).toEqual({ prompt: '猫', ratio: '1:1' })
  })

  it('空入参返回 undefined', () => {
    expect(sanitizeLogBody(undefined)).toBeUndefined()
  })
})

function genParams(over: Partial<GenNodeParams> = {}): GenNodeParams {
  return { model: 'nano-banana2', count: 1, ...over }
}

function contract(over: Partial<AigcModelInfo> = {}): AigcModelInfo {
  return {
    scalar_params: [
      { name: 'resolution', enum: ['1k', '2k'], default: '1k' },
      { name: 'aspectRatio', enum: ['1:1', '16:9', 'empty'], default: '1:1' },
      { name: 'quality', enum: ['low', 'medium', 'high'], default: 'medium' },
    ],
    media_params: [{ name: 'imageUrls' }],
    ...over,
  } as unknown as AigcModelInfo
}

describe('buildNodeRunBody 图片', () => {
  it('文生图：提示词 + 枚举参数，无图不带 imageUrls', () => {
    const body = buildNodeRunBody(genParams({ resolution: '2k', aspectRatio: '16:9', quality: 'high' }), '猫', [], contract())
    expect(body).toMatchObject({ prompt: '猫', resolution: '2k', aspectRatio: '16:9', quality: 'high' })
    expect(body.imageUrls).toBeUndefined()
  })

  it('图生图：参考图写入 imageUrls；枚举外的偏好值回落默认', () => {
    const body = buildNodeRunBody(genParams({ model: 'nano-banana2-gemini31flash-image-to-image-channel-low-price', resolution: '8k' }), '改图', ['http://x/a.jpg'], contract())
    expect(body.imageUrls).toEqual(['http://x/a.jpg'])
    expect(body.resolution).toBe('1k')
  })
})

describe('buildNodeRunBody 视频', () => {
  const videoContract = contract({
    scalar_params: [
      { name: 'resolution', enum: ['1k', '2k'], default: '1k' },
      { name: 'duration', enum: ['5', '10'], default: '5', type: 'string' },
      { name: 'ratio', enum: ['adaptive', '16:9'], default: 'adaptive' },
      { name: 'aspectRatio', enum: ['adaptive', '16:9', 'empty'], default: 'adaptive' },
    ],
    media_params: [{ name: 'firstFrameUrl' }],
  })

  it('文生视频带时长/比例，不写首帧', () => {
    const body = buildNodeRunBody(genParams({ model: 'seedance-2.5', videoDuration: '10', videoRatio: '16:9' }), '推镜', [], videoContract)
    expect(body.prompt).toBe('推镜')
    expect(body.duration).toBe('10')
    expect(body.ratio).toBe('16:9')
    expect(body.firstFrameUrl).toBeUndefined()
  })

  it('图生视频首帧走契约声明的字段名', () => {
    const body = buildNodeRunBody(genParams({ model: 'seedance-2-5-image-to-video-token' }), '动起来', ['http://x/f.jpg'], videoContract)
    expect(body.firstFrameUrl).toBe('http://x/f.jpg')
  })

  it('全能参考模型用 imageUrls 数组承载首帧', () => {
    const body = buildNodeRunBody(genParams({ model: 'seedance2-0-multimodal-video' }), '动', ['http://x/f.jpg', 'http://x/g.jpg'], videoContract)
    expect(body.imageUrls).toEqual(['http://x/f.jpg', 'http://x/g.jpg'])
    expect(body.firstFrameUrl).toBeUndefined()
  })

  it('数字类型时长参数输出 number 并夹到 30 秒以内', () => {
    const numContract = contract({
      scalar_params: [{ name: 'resolution', enum: ['1k'], default: '1k' }, { name: 'duration', type: 'number', default: 6 }],
      media_params: [{ name: 'firstFrameUrl' }],
    })
    const body = buildNodeRunBody(genParams({ model: 'seedance-2.5', videoDuration: '99' }), '动', [], numContract)
    expect(body.duration).toBe(30)
  })
})

describe('buildAiAppRunBody', () => {
  it('wan22 标准版只带 text/node51/首帧内部字段', () => {
    const body = buildAiAppRunBody('wan-2.2-i2v-ai-app', '海浪', undefined, 'http://x/f.jpg')
    expect(body.text).toBe('海浪')
    expect(body.node51_value).toBe('1280')
    expect(body[AI_APP_FIRST_FRAME_KEY]).toBe('http://x/f.jpg')
    expect(body.node438_value).toBeUndefined()
  })

  it('wan22hq 高质量版多带总帧数字段', () => {
    const body = buildAiAppRunBody('wan-2.2-i2v-hq-ai-app', '海浪', { model: 'x', count: 1, aiAppLongEdge: 1024, aiAppFrames: 121 }, 'http://x/f.jpg')
    expect(body.node438_value).toBe('1024')
    expect(body.node446_value).toBe('121')
  })
})

describe('bodyWithRhUrls', () => {
  it('非本应用持久化的链接原样保留（不发起转换）', async () => {
    const body = { prompt: '猫', imageUrls: ['http://rh-images.xiaoyaoyou.com/x/output/a.jpg'], flag: true }
    const out = await bodyWithRhUrls(body)
    expect(out).toEqual(body)
  })

  it('不修改原 body（返回新对象）', async () => {
    const body = { prompt: 'x' }
    const out = await bodyWithRhUrls(body)
    expect(out).not.toBe(body)
    expect(out).toEqual(body)
  })
})
