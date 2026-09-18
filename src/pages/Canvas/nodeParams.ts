// 生成节点的参数选择 / 提交体构建 / 日志快照纯函数。
// 从 useCanvas 抽出：只依赖模型契约类型、价表常量与图片尺寸读取，不持有画布状态。
import type { AigcModelInfo } from '@/lib/aigc'
import { isPersistedMediaUrl, toRhMediaUrl, toRhMediaUrls } from '@/lib/media'
import { loadImageNatural } from '@/components/canvas/imageEdit/localPatch'
import type { GenNodeParams } from './canvasTypes'
import {
  AI_APP_FIRST_FRAME_KEY,
  DEFAULT_MOTION_PROMPT,
  MOTION_APP_SLUG,
  MULTIMODAL_VIDEO_MODEL,
  TTS_APP_SLUG,
  VSR_APP_SLUG,
  aiAppFramesOf,
  aiAppLongEdgeOf,
  aiAppSlugOf,
  channelFamilyOf,
  modelKindOf,
} from './canvasModels'

/** 从模型契约的枚举参数里取首选值；枚举不含首选时回落默认值/首个枚举，empty 视为不送 */
export function pickParamValue(info: AigcModelInfo | null, paramName: string, preferred: string): string | null {
  const sp = info?.scalar_params?.find(p => p.name === paramName)
  if (!sp) return null
  if (sp.enum && sp.enum.length) {
    if (sp.enum.includes(preferred)) return preferred
    const fallback = sp.default !== undefined ? String(sp.default) : sp.enum[0]
    return fallback === 'empty' ? null : fallback
  }
  return preferred
}

/** 比例提交值: empty 不送; adaptive 在渠道枚举支持时送原值, 否则省略参数让平台自定比例(对齐官网自适应语义); 其余值走 pickParamValue */
export function aspectRatioForBody(info: AigcModelInfo | null, preferred: string): string | null {
  if (preferred === 'empty') return null
  if (preferred === 'adaptive') {
    const sp = info?.scalar_params?.find(p => p.name === 'aspectRatio')
    return sp?.enum?.includes('adaptive') ? 'adaptive' : null
  }
  return pickParamValue(info, 'aspectRatio', preferred)
}

/** 把图片真实宽高匹配到渠道支持的最接近比例枚举(对数距离); 超出渠道极端比例(1:3~3:1)返回 null */
export function matchAspectRatioEnum(enumValues: string[] | undefined, width: number, height: number): string | null {
  if (!enumValues || !width || !height) return null
  const target = width / height
  let best: { v: string; d: number } | null = null
  for (const raw of enumValues) {
    const m = /^(\d+(?:\.\d+)?)\s*[:xX]\s*(\d+(?:\.\d+)?)$/.exec(raw)
    if (!m) continue
    const ratio = Number(m[1]) / Number(m[2])
    if (!Number.isFinite(ratio) || ratio <= 0) continue
    const d = Math.abs(Math.log(ratio / target))
    if (!best || d < best.d) best = { v: raw, d }
  }
  // 偏差超过一档(如 16:9 配 3:4)说明图片比例超出渠道档位, 不强行指定, 交平台处理
  if (!best || best.d > 0.45) return null
  return best.v
}

/**
 * 自适应 + 有参考图: 读参考图真实尺寸, 匹配渠道支持的最接近比例并显式提交,
 * 保证图生图(尤其局部选区图与原图比例不一致时)出图跟随参考图而不是平台默认 3:4;
 * 读尺寸失败/超宽高比/渠道无比例参数时回退普通自适应语义。
 */
export async function resolveAdaptiveRatio(
  info: AigcModelInfo | null,
  preferred: string | undefined,
  refUrls: string[],
): Promise<string | null> {
  // 官网系「自适应」在不同渠道枚举里可能叫 adaptive 或 empty, 两种都按自适应处理
  if (preferred !== 'adaptive' && preferred !== 'empty') return aspectRatioForBody(info, preferred ?? '16:9')
  const sp = info?.scalar_params?.find(p => p.name === 'aspectRatio')
  // 渠道原生支持 adaptive 时优先交给平台(平台通常会参考输入图)
  if (sp?.enum?.includes('adaptive')) return 'adaptive'
  const refUrl = refUrls[0]
  if (!sp?.enum || !refUrl) return null
  try {
    const { naturalWidth, naturalHeight } = await loadImageNatural(refUrl)
    return matchAspectRatioEnum(sp.enum, naturalWidth, naturalHeight)
  } catch {
    return null
  }
}

/** 提交体骨架：提示词 + 契约里所有非 empty 默认参数 + 参考图数组 */
export function buildBodyWithDefaults(
  info: AigcModelInfo | null,
  promptText: string,
  refUrls: string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt: promptText }
  for (const sp of info?.scalar_params ?? []) {
    if (sp.default !== undefined && String(sp.default) !== 'empty') body[sp.name] = sp.default
  }
  if (refUrls.length) body.imageUrls = refUrls
  return body
}

/** 一段文字看起来是不是文件名（带图片/视频扩展名） */
export function looksLikeFileName(text: string): boolean {
  return /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|mp4|mov)$/i.test(text.trim())
}

/** 图生视频提示词: 卡片上有用户写的运动描述就用, 只有文件名/空则给中性运动描述 */
export function resolveI2vPrompt(raw?: string): string {
  const text = (raw ?? '').trim()
  return text && !looksLikeFileName(text) ? text : DEFAULT_MOTION_PROMPT
}

/** 各图生视频渠道首帧字段名不同 (firstFrameUrl / imageUrl), 以契约 media_params 为准 */
export function firstFrameFieldName(info: AigcModelInfo | null): string {
  const names = (info?.media_params ?? []).map(m => m.name)
  if (names.includes('firstFrameUrl')) return 'firstFrameUrl'
  if (names.includes('imageUrl')) return 'imageUrl'
  return 'firstFrameUrl'
}

/** 生成日志模型/任务名: 优先渠道家族中文名, 其次原始 slug */
export function logModelLabel(model: string): string {
  return channelFamilyOf(model)?.label || model
}

/** 生成日志平台名：各专用 AI 应用给中文名，标准渠道统一标 RunningHub */
export function logPlatformOf(model: string): string {
  const appSlug = aiAppSlugOf(model)
  if (appSlug === 'wan22' || appSlug === 'wan22hq') return 'WAN 2.2 AI 应用'
  if (model === TTS_APP_SLUG) return 'IndexTTS 2 AI 应用'
  if (model === MOTION_APP_SLUG) return 'Animate V9 AI 应用'
  if (model === VSR_APP_SLUG) return 'SeedVR2 AI 应用'
  return 'RunningHub'
}

/** 提交快照(用于日志详情): 去掉 AI 应用首帧内部字段, 避免把内部占位透给用户 */
export function sanitizeLogBody(
  body: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!body) return undefined
  const out: Record<string, unknown> = {}
  Object.keys(body).forEach(k => {
    if (k === AI_APP_FIRST_FRAME_KEY) return
    const v = body[k]
    if (v === undefined) return
    out[k] = v
  })
  return out
}

/** 按节点自身参数构建标准渠道的 run body; body 形态由模型 kind（文/图生图、文/图生视频）决定 */
export function buildNodeRunBody(
  params: GenNodeParams,
  promptText: string,
  refUrls: string[],
  info: AigcModelInfo | null,
): Record<string, unknown> {
  const kind = modelKindOf(params.model)
  const body: Record<string, unknown> = { prompt: promptText }
  if (kind === 't2v' || kind === 'i2v') {
    const resVal = pickParamValue(info, 'resolution', params.resolution ?? '1k')
    if (resVal !== null) body.resolution = resVal
    const durParam = info?.scalar_params?.find(sp => sp.name === 'duration')
    if (durParam) {
      const preferred = params.videoDuration ?? '5'
      if (durParam.enum && durParam.enum.length) {
        const v = durParam.enum.includes(preferred) ? preferred : String(durParam.default ?? durParam.enum[0])
        body.duration = durParam.type === 'number' ? Number(v) : v
      } else if (durParam.type === 'number') {
        const n = Number(preferred)
        body.duration = Number.isFinite(n) && n >= 1 ? Math.round(Math.min(30, n)) : Number(durParam.default ?? 6)
      }
    }
    const ratioVal = pickParamValue(info, 'ratio', params.videoRatio ?? 'adaptive')
    if (ratioVal !== null) body.ratio = ratioVal
    const arVal = pickParamValue(info, 'aspectRatio', params.videoRatio ?? 'adaptive')
    if (arVal !== null && arVal !== 'empty') body.aspectRatio = arVal
    // 全能参考模型统一用 imageUrls(数组, 最多9张); 其余 i2v 渠道用各自的首帧字段
    if (params.model === MULTIMODAL_VIDEO_MODEL) {
      if (refUrls.length) body.imageUrls = refUrls
    } else if (kind === 'i2v' && refUrls.length) {
      body[firstFrameFieldName(info)] = refUrls[0]
    }
  } else {
    const resVal = pickParamValue(info, 'resolution', params.resolution ?? '1k')
    if (resVal !== null) body.resolution = resVal
    const arVal = aspectRatioForBody(info, params.aspectRatio ?? '1:1')
    if (arVal !== null) body.aspectRatio = arVal
    const qVal = pickParamValue(info, 'quality', params.quality ?? 'medium')
    if (qVal !== null) body.quality = qVal
    if (kind === 'i2i' && refUrls.length) body.imageUrls = refUrls
  }
  return body
}

/** AI 应用渠道提交体: 按应用 slug 分支把业务字段平铺在请求体顶层; 首帧先走内部字段, 提交前再上传换 fileName */
export function buildAiAppRunBody(
  runModel: string,
  promptText: string,
  genParams: GenNodeParams | undefined,
  firstFrame: string,
): Record<string, unknown> {
  if (aiAppSlugOf(runModel) === 'wan22hq') {
    return {
      text: promptText,
      node438_value: String(aiAppLongEdgeOf(genParams?.aiAppLongEdge)),
      node446_value: String(aiAppFramesOf(genParams?.aiAppFrames)),
      [AI_APP_FIRST_FRAME_KEY]: firstFrame,
    }
  }
  return {
    text: promptText,
    node51_value: String(aiAppLongEdgeOf(genParams?.aiAppLongEdge)),
    [AI_APP_FIRST_FRAME_KEY]: firstFrame,
  }
}

/** 把提交体里所有「本应用永久文件」字段值换成平台可访问的媒体地址（字符串或字符串数组），并发处理 */
export async function bodyWithRhUrls(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...body }
  await Promise.all(
    Object.keys(out).map(async k => {
      const v = out[k]
      if (typeof v === 'string') {
        if (isPersistedMediaUrl(v)) out[k] = await toRhMediaUrl(v)
      } else if (Array.isArray(v)) {
        const arr = v.filter((x): x is string => typeof x === 'string')
        if (arr.length && arr.some(u => isPersistedMediaUrl(u))) out[k] = await toRhMediaUrls(arr)
      }
    }),
  )
  return out
}
