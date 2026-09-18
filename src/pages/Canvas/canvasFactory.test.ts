import { describe, it, expect } from 'vitest'
import {
  createNewCard,
  NEW_CARD_SIZE,
  NEW_CARD_KINDS,
  createUploadImageCard,
  createUploadVideoCard,
  UPLOAD_IMAGE_MAX,
  UPLOAD_VIDEO_MAX,
} from './canvasFactory'
import { sanitizeCameraConfig, DEFAULT_CAMERA_CONFIG } from './cameraModel'

const at = { id: 'n1', x: 100, y: 200 }

describe('NEW_CARD_SIZE / NEW_CARD_KINDS', () => {
  it('七类节点都登记了尺寸', () => {
    expect([...NEW_CARD_KINDS].sort()).toEqual(
      ['agent', 'camera', 'generate', 'layer', 'loop', 'merge', 'replicate'].sort(),
    )
    NEW_CARD_KINDS.forEach(k => {
      expect(NEW_CARD_SIZE[k].w).toBeGreaterThan(0)
      expect(NEW_CARD_SIZE[k].h).toBeGreaterThan(0)
    })
  })
})

describe('createNewCard', () => {
  it('生成节点: 空提示词/空参考图/默认参数/320x180', () => {
    const c = createNewCard('generate', at)
    expect(c).toMatchObject({ id: 'n1', kind: 'generate', x: 100, y: 200, w: 320, h: 180 })
    expect(c.prompt).toBe('')
    expect(c.refUrls).toEqual([])
    expect(c.genParams).toBeTruthy()
  })

  it('分层 / 复刻 / 智能体 / 循环 / 融合各自带默认状态与既有尺寸', () => {
    expect(createNewCard('layer', at)).toMatchObject({ kind: 'layer', w: 380, h: 540 })
    expect(createNewCard('layer', at).layerState).toBeTruthy()
    expect(createNewCard('replicate', at)).toMatchObject({ kind: 'replicate', w: 460, h: 620 })
    expect(createNewCard('replicate', at).repState).toBeTruthy()
    expect(createNewCard('agent', at)).toMatchObject({ kind: 'agent', w: 500, h: 600, prompt: '' })
    expect(createNewCard('agent', at).agentState).toBeTruthy()
    expect(createNewCard('loop', at)).toMatchObject({ kind: 'loop', w: 420, h: 560 })
    expect(createNewCard('loop', at).loopState).toBeTruthy()
    expect(createNewCard('merge', at)).toMatchObject({ kind: 'merge', w: 240, h: 300 })
    expect(createNewCard('merge', at).mergeState).toBeTruthy()
  })

  it('摄影机: 标题与本机配置经 extra 注入, 360x200', () => {
    const cameraState = sanitizeCameraConfig(DEFAULT_CAMERA_CONFIG)
    const c = createNewCard('camera', at, { title: '摄影机A', cameraState })
    expect(c).toMatchObject({ kind: 'camera', w: 360, h: 200, title: '摄影机A' })
    expect(c.cameraState).toBe(cameraState)
  })

  it('位置与 id 原样落位', () => {
    const c = createNewCard('generate', { id: 'z9', x: -50, y: 0 })
    expect(c.id).toBe('z9')
    expect(c.x).toBe(-50)
    expect(c.y).toBe(0)
  })
})

describe('createUploadImageCard', () => {
  it('生成节点 520x560，blob 预览 + 运行态 + 图生图默认参数', () => {
    const c = createUploadImageCard({ id: 'u1', x: 10, y: 20 }, 'blob:img')
    expect(c).toMatchObject({
      id: 'u1', kind: 'generate', x: 10, y: 20, w: 520, h: 560,
      url: 'blob:img', prompt: '', refUrls: [], jobStatus: 'running',
    })
    expect(c.errorMsg).toBeUndefined()
    expect(c.genParams).toBeTruthy()
  })
  it('每次生成独立参数对象', () => {
    expect(createUploadImageCard({ id: 'a', x: 0, y: 0 }, 'b').genParams)
      .not.toBe(createUploadImageCard({ id: 'b', x: 0, y: 0 }, 'b').genParams)
  })
})

describe('createUploadVideoCard', () => {
  it('视频卡 320x360，blob 预览，标题取文件名', () => {
    const c = createUploadVideoCard({ id: 'v1', x: 30, y: 40 }, 'blob:vid', 'demo.mov')
    expect(c).toMatchObject({
      id: 'v1', kind: 'video', x: 30, y: 40, w: 320, h: 360,
      url: 'blob:vid', title: 'demo.mov',
    })
  })
})

describe('上传批量上限常量', () => {
  it('图片 30 张 / 视频 10 个', () => {
    expect(UPLOAD_IMAGE_MAX).toBe(30)
    expect(UPLOAD_VIDEO_MAX).toBe(10)
  })
})
