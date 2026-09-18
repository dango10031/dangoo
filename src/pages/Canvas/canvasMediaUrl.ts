// AI 应用 / 标准任务返回结果中的媒体地址提取，以及历史文档里部署前缀的剥离。
// 全部为无状态纯函数，从 useCanvas 抽出。
import type { AiAppRunResponse } from '@/lib/aigc'
import { canonicalMediaPath } from '@/lib/media'

type MediaOutput = { type?: string; url?: string }

function pickMediaUrl(res: AiAppRunResponse, wantType: 'audio' | 'video', exts: RegExp): string {
  const all: MediaOutput[] = [...(res.outputs ?? []), ...(res.results ?? [])]
  const hit =
    all.find(o => o?.type === wantType && o.url) ??
    all.find(o => exts.test(o.url || '')) ??
    all.find(o => o.url)
  return hit?.url ?? ''
}

/** 语音克隆结果音频地址：优先 type=audio，其次按音频扩展名兜底 */
export function ttsAudioUrl(res: AiAppRunResponse): string {
  return pickMediaUrl(res, 'audio', /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i)
}

/** 动作迁移 / 视频高清修复结果视频地址：优先 type=video，其次按视频扩展名兜底 */
export function motionVideoUrl(res: AiAppRunResponse): string {
  return pickMediaUrl(res, 'video', /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i)
}

/** 通用 AI 应用视频结果地址：只认 type=video，再退任意一条有 url 的产物 */
export function aiAppVideoUrl(res: AiAppRunResponse): string {
  const all: MediaOutput[] = [...(res.outputs ?? []), ...(res.results ?? [])]
  const video = all.find(o => o?.type === 'video' && o.url) ?? all.find(o => o.url)
  return video?.url ?? ''
}

/**
 * 递归剥掉历史文档里写死的同域后端文件前缀（/__pb/api/files/...），
 * 还原成裸规范路径，避免换了访问前缀后旧链接失效。
 */
export function stripDeployedPrefix(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.includes('/__pb/api/files/') ? canonicalMediaPath(value) : value
  }
  if (Array.isArray(value)) return value.map(v => stripDeployedPrefix(v))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>)) {
      out[k] = stripDeployedPrefix((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}
