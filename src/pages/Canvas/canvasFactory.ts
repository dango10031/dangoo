

// 这里统一构造与默认尺寸，新建 / 粘贴 / 拖入等路径共用同一份尺寸定义。
// 摄影机标题依赖当前画布已用字母、配置依赖本机存储，均由调用方算好后经 camera 入参注入。
import {
  defaultAgentState,
  defaultLayerState,
  defaultLoopState,
  defaultMergeState,
  defaultRepState,
  type CanvasCardData,
  type CardKind,
} from './canvasTypes'
import { defaultGenParams, defaultImageGenParams } from './canvasModels'
import type { CameraConfig } from './cameraModel'

/** 走统一工厂的节点类型（结果卡 / 上传卡等由专门流程创建，不在此列） */
export const NEW_CARD_KINDS = [
  'generate',
  'layer',
  'replicate',
  'agent',
  'loop',
  'merge',
  'camera',
] as const satisfies readonly CardKind[]

export type NewCardKind = (typeof NEW_CARD_KINDS)[number]

/** 各类新建节点的默认尺寸：唯一事实来源 */
export const NEW_CARD_SIZE: Record<NewCardKind, { w: number; h: number }> = {
  generate: { w: 320, h: 180 },
  layer: { w: 380, h: 540 },
  replicate: { w: 460, h: 620 },
  agent: { w: 500, h: 600 },
  loop: { w: 420, h: 560 },
  merge: { w: 240, h: 300 },
  camera: { w: 360, h: 200 },
}

export interface NewCardPos {
  id: string
  x: number
  y: number
}

/** 摄影机额外字段：标题字母与本机默认配置由调用方实时计算后注入 */
export interface NewCardExtra {
  title?: string
  cameraState?: CameraConfig
}

/** 构造一张新建默认卡片：id / 位置原样落位，类型专属默认状态现取（每次独立对象） */
export function createNewCard(kind: NewCardKind, pos: NewCardPos, extra: NewCardExtra = {}): CanvasCardData {
  const { w, h } = NEW_CARD_SIZE[kind]
  const base = { id: pos.id, kind, x: pos.x, y: pos.y, w, h } as CanvasCardData
  switch (kind) {
    case 'generate':
      return { ...base, prompt: '', refUrls: [], genParams: defaultGenParams() }
    case 'layer':
      return { ...base, layerState: defaultLayerState() }
    case 'replicate':
      return { ...base, repState: defaultRepState() }
    case 'agent':
      return { ...base, prompt: '', agentState: defaultAgentState() }
    case 'loop':
      return { ...base, loopState: defaultLoopState() }
    case 'merge':
      return { ...base, mergeState: defaultMergeState() }
    case 'camera':
      return { ...base, title: extra.title, cameraState: extra.cameraState }
  }
}

/** 拖入图片落卡尺寸与批量上限（与原上传行为一致） */
export const UPLOAD_IMAGE_CARD_SIZE = { w: 520, h: 560 }
export const UPLOAD_IMAGE_MAX = 30
/** 拖入视频落卡尺寸与批量上限 */
export const UPLOAD_VIDEO_CARD_SIZE = { w: 320, h: 360 }
export const UPLOAD_VIDEO_MAX = 10

/**
 * 拖入图片的落卡：生成节点，先用本地 blob 链接预览、标记运行中，
 * 默认选中首个图生图渠道；永久链接由调用方上传成功后替换。
 */
export function createUploadImageCard(pos: NewCardPos, localUrl: string): CanvasCardData {
  return {
    id: pos.id,
    kind: 'generate',
    x: pos.x,
    y: pos.y,
    w: UPLOAD_IMAGE_CARD_SIZE.w,
    h: UPLOAD_IMAGE_CARD_SIZE.h,
    url: localUrl,
    prompt: '',
    refUrls: [],
    genParams: defaultImageGenParams(),
    jobStatus: 'running',
    errorMsg: undefined,
  }
}

/** 拖入视频的落卡：可播放视频卡，标题取文件名；同样先用本地 blob 链接预览 */
export function createUploadVideoCard(pos: NewCardPos, localUrl: string, fileName: string): CanvasCardData {
  return {
    id: pos.id,
    kind: 'video',
    x: pos.x,
    y: pos.y,
    w: UPLOAD_VIDEO_CARD_SIZE.w,
    h: UPLOAD_VIDEO_CARD_SIZE.h,
    url: localUrl,
    title: fileName,
  }
}
