import type { LlmCallResult } from '@/lib/llm'
import { persistMedia, isPersistedMediaUrl, isDurableOutputMediaUrl } from '@/lib/media'
import { getPocketBaseUrl } from '@/lib/pb'
import { getAuthHeaders } from '@/lib/auth'

/** 经后端代下载把远程平台临时链接转成本应用永久文件, 返回裸路径; 失败抛错 */
async function saveRemoteViaServer(url: string, mediaType: 'image' | 'video' | 'audio'): Promise<string | null> {
  const res = await fetch(`${getPocketBaseUrl()}/api/media/save-remote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ url, mediaType }),
  })
  if (res.status === 412 || res.status === 401) {
    throw Object.assign(new Error('login_required'), { status: 412 })
  }
  if (!res.ok) throw new Error(`save-remote HTTP ${res.status}`)
  const data = await res.json().catch(() => null)
  return data?.url ? String(data.url) : null
}
import type { CropContext } from '@/components/canvas/imageEdit/localPatch'
import type { CanvasCardData } from './canvasTypes'
import { LLM_ERROR_ZH, modelKindOf } from './canvasModels'
export { modelKindOf }

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/**
 * 上下文继承: 收集一批上游卡里非空的 cropContext;
 * contextId 全部相同 → 继承该上下文(局部图多轮改图后仍是同一局部);
 * 出现 ≥2 种不同 contextId → 冲突返回 null(不继承, 避免把混合图融合回错误原图);
 * 没有 → null(完整图边界)。
 */
export function inheritCropContext(upstreamCards: CanvasCardData[]): CropContext | null {
  const ctxs = upstreamCards.map(c => c.cropContext).filter((c): c is CropContext => !!c && c.version === 2)
  if (!ctxs.length) return null
  const first = ctxs[0].contextId
  return ctxs.every(c => c.contextId === first) ? ctxs[0] : null
}

export function llmErrorText(res: LlmCallResult): string {
  if (res.error && LLM_ERROR_ZH[res.error]) return LLM_ERROR_ZH[res.error]
  return res.error || '生成失败, 请重试'
}

export async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const runnerCount = Math.max(1, Math.min(limit, queue.length))
  const runners = Array.from({ length: runnerCount }, async () => {
    while (queue.length > 0) {
      const next = queue.shift()
      if (!next) break
      await worker(next)
    }
  })
  await Promise.all(runners)
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 远程媒体转存到本应用存储, 返回本地永久链接。
 * - 平台「输入上传」临时签名链(myqcloud/input/openapi?q-sign-*)约 24h 后 403, 必须转存;
 * - 但平台 AI「成品输出」(rh-images.xiaoyaoyou.com/.../output/, 图/音频/视频都在此)是无签名
 *   长期公开对象, 比会随环境重置丢失的本地文件存储更可靠, 原样保留、绝不转存
 *   (旧版本误把成品图转存到本地, 正是「再进画布图没了」黑卡的根因)。
 * 非媒体/失败一律回传原链接(不影响展示)。
 */
const VIDEO_PERSIST_MAX_BYTES = 60 * 1024 * 1024
const AUDIO_PERSIST_MAX_BYTES = 30 * 1024 * 1024

export async function persistRemoteImage(url: string, kind?: 'image' | 'video' | 'audio'): Promise<string> {
  if (!url || isPersistedMediaUrl(url)) return url
  // 永久公开的 AI 成品(图/音频/视频): 不转存, 继续用稳定 CDN 地址
  if (isDurableOutputMediaUrl(url)) return url
  // 优先走后端代下载转存: 浏览器直连平台签名图床常被 CORS 拦截导致静默失败,
  // 把 24h 过期临时链接存进画布, 隔天整批复裂图。后端无跨域限制, 最可靠。
  const mediaType = kind ?? (/\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(url) ? 'audio' : /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(url) ? 'video' : 'image')
  try {
    const saved = await saveRemoteViaServer(url, mediaType)
    if (saved) return saved
  } catch {
    // 落到下面的浏览器直连兜底
  }
  const looksImage = /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(url)
  const looksVideo = /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)
  const looksAudio = /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(url)
  if (!kind && !looksImage && !looksVideo && !looksAudio) return url
  try {
    const resp = await fetch(url, { mode: 'cors' })
    if (!resp.ok) return url
    const blob = await resp.blob()
    if (kind === 'audio' || blob.type.startsWith('audio/') || (looksAudio && !blob.type.startsWith('image/') && !blob.type.startsWith('video/'))) {
      if (!blob.size || blob.size > AUDIO_PERSIST_MAX_BYTES) return url
      const ext = blob.type.split('/')[1]?.replace('mpeg', 'mp3') || 'mp3'
      const file = new File([blob], `result-${new Date().getTime().toString(36)}.${ext}`, { type: blob.type || 'audio/mpeg' })
      return await persistMedia(file, 'audio')
    }
    const asVideo =
      blob.type.startsWith('video/') ||
      ((kind === 'video' || looksVideo) && !blob.type.startsWith('image/'))
    if (asVideo) {
      if (!blob.size || blob.size > VIDEO_PERSIST_MAX_BYTES) return url
      const ext = blob.type.split('/')[1] || 'mp4'
      const file = new File([blob], `result-${new Date().getTime().toString(36)}.${ext}`, { type: blob.type || 'video/mp4' })
      return await persistMedia(file, 'video')
    }
    if (!blob.type.startsWith('image/')) return url
    const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const file = new File([blob], `result-${new Date().getTime().toString(36)}.${ext}`, { type: blob.type })
    return await persistMedia(file, 'image')
  } catch {
    return url
  }
}

export async function urlToDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('读取图片失败'))
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

export function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = url
  })
}

/** 本地抠图: 生成图指定纯白背景, 前端按四角取色把背景扣成透明 */
export async function cutoutWhiteBackground(url: string): Promise<string | null> {
  try {
    const img = await loadImageEl(url)
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (!w || !h) return null
    const cvs = document.createElement('canvas')
    cvs.width = w
    cvs.height = h
    const ctx = cvs.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0)
    const imgData = ctx.getImageData(0, 0, w, h)
    const px = imgData.data
    const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4]
    let br = 0
    let bg = 0
    let bb = 0
    corners.forEach(i => {
      br += px[i]
      bg += px[i + 1]
      bb += px[i + 2]
    })
    br /= corners.length
    bg /= corners.length
    bb /= corners.length
    const tol = 46
    for (let i = 0; i < px.length; i += 4) {
      const dr = px[i] - br
      const dg = px[i + 1] - bg
      const db = px[i + 2] - bb
      const dist = Math.sqrt(dr * dr + dg * dg + db * db)
      if (dist < tol) px[i + 3] = 0
      else if (dist < tol * 1.7) px[i + 3] = Math.round(255 * ((dist - tol) / (tol * 0.7)))
    }
    ctx.putImageData(imgData, 0, 0)
    return cvs.toDataURL('image/png')
  } catch {
    return null
  }
}

export function parseLooseJsonArray(text: string): Array<Record<string, unknown>> | null {
  const cleaned = text.replace(/```(json)?/gi, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1))
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : null
  } catch {
    return null
  }
}

export function parseLooseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function downloadDataUrl(dataUrl: string, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/** 读取本地视频时长（秒），读不到返回 null；专用于上传前的时长校验 */
export function readVideoDuration(file: File): Promise<number | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    const done = (val: number | null) => {
      URL.revokeObjectURL(url)
      resolve(val)
    }
    video.onloadedmetadata = () => {
      const d = video.duration
      done(Number.isFinite(d) && d > 0 ? d : null)
    }
    video.onerror = () => done(null)
    video.src = url
  })
}

/** Agent 表格模式结果解析：从大模型回复里抽 {"rows":[...]}，失败返回空数组 */
export function parseAgentTableRows(text: string): Array<{ id?: string; cells?: Record<string, unknown> }> {
  const raw = text.replace(/```json|```/g, '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { rows?: Array<{ id?: string; cells?: Record<string, unknown> }> }
    return Array.isArray(obj.rows) ? obj.rows : []
  } catch {
    return []
  }
}
