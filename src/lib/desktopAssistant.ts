/**
 * Dangoo 本地助手（桌面端）客户端
 *
 * 助手是跑在用户本机的小程序(默认 http://127.0.0.1:19527),
 * 负责把网页选中的图片/视频一键导入剪映专业版,
 * 或把图片导入 Photoshop / Illustrator。
 * 网页通过 fetch 调用本机回环地址; 助手用 Origin 白名单做了 CORS 限制。
 */

export const ASSISTANT_PORTS = [19527, 19528, 19529]
// 助手启动时会同步检测剪映、Photoshop、Illustrator，首次 health 可能需要几秒。
const HEALTH_TIMEOUT_MS = 5000
const IMPORT_TIMEOUT_MS = 10 * 60 * 1000 // 含下载+转码+桌面自动化, 给足

export type AssistantHealth = {
  ok: boolean
  port: number | null
  version?: string
  jianying?: {
    running?: boolean
    platform_supported?: boolean
    code?: string
    message?: string
  }
  photoshop?: AssistantAdobeHealth
  illustrator?: AssistantAdobeHealth
}

export type AssistantImportItem = { url: string; name?: string }
export type AdobeApplication = 'photoshop' | 'illustrator'
export type AssistantAdobeHealth = {
  running?: boolean
  platform_supported?: boolean
  has_document?: boolean
  code?: string
  message?: string
}

export type AssistantImportResult = {
  ok: boolean
  code: string
  message?: string
  imported?: Array<{ name: string; ext: string }>
  failed?: Array<{ code?: string; error?: string; url?: string }>
  attempted?: number
}

function base(port: number): string {
  return `http://127.0.0.1:${port}`
}

async function fetchWithTimeout(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 本机存活探测。特意用 XMLHttpRequest 而不是 fetch：
 * 预览运行时监控会给全局 fetch 打补丁, 把每一次网络失败(含助手未运行时
 * 对 127.0.0.1 探测的连接拒绝)都上报成红色运行时错误, 每 5 秒 ×3 端口持续刷屏。
 * XHR 不经过那个补丁, 助手没开只是这里静默判负, 不再污染错误面板。
 */
function probeHealth(port: number, timeoutMs: number): Promise<AssistantHealth | null> {
  return new Promise(resolve => {
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', `${base(port)}/health`, true)
      xhr.timeout = timeoutMs
      const done = (val: AssistantHealth | null) => {
        try { xhr.onreadystatechange = null } catch { /* noop */ }
        resolve(val)
      }
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return
        if (xhr.status < 200 || xhr.status >= 300) return done(null)
        let data: { ok?: boolean; version?: string; jianying?: unknown; photoshop?: unknown; illustrator?: unknown } | null
        try { data = JSON.parse(xhr.responseText) } catch { data = null }
        if (!data?.ok) return done(null)
        done({
          ok: true,
          port,
          version: data.version,
          jianying: (data.jianying ?? {}) as AssistantHealth['jianying'],
          photoshop: (data.photoshop ?? {}) as AssistantHealth['photoshop'],
          illustrator: (data.illustrator ?? {}) as AssistantHealth['illustrator'],
        })
      }
      xhr.ontimeout = () => done(null)
      xhr.onerror = () => done(null) // 端口无服务, 预期内, 不上报
      xhr.send()
    } catch {
      resolve(null)
    }
  })
}

/** 探测本机助手是否在运行, 顺便带回剪映/Adobe 状态。任一可用端口命中即视为在线。 */
export async function detectAssistant(): Promise<AssistantHealth> {
  for (const port of ASSISTANT_PORTS) {
    const hit = await probeHealth(port, HEALTH_TIMEOUT_MS)
    if (hit) return hit
  }
  return { ok: false, port: null }
}

/** 错误码 → 面向用户的中文说明 */
export function assistantErrorText(code?: string, message?: string): string {
  switch (code) {
    case 'app_not_running':
      return '没有检测到剪映：请先打开剪映专业版并进入一个工程'
    case 'activation_failed':
      return '无法激活剪映窗口：请关闭其它置顶窗口后重试'
    case 'import_dialog_timeout':
    case 'import_timeout':
      return '剪映没有完成导入：请确认已进入工程（停在剪辑界面而非首页），且没有弹出确认框'
    case 'filename_input_not_found':
    case 'open_button_not_found':
      return '剪映导入窗口异常：请手动关掉弹框后重试'
    case 'ffmpeg_unavailable':
      return '该视频需要转码但本机未找到 FFmpeg，请安装 FFmpeg 或改用 mp4 视频'
    case 'transcode_failed':
    case 'transcode_timeout':
      return '视频转码失败，请换一个视频或检查 FFmpeg'
    case 'url_not_allowed':
      return '素材地址不在允许范围内'
    case 'unsupported_format':
      return '素材格式不支持（图片/mp4/mov/m4v/webm）'
    case 'file_too_large':
      return '素材过大，超过助手允许的大小'
    case 'download_failed':
      return '素材下载失败，请检查网络后重试'
    case 'busy':
      return '助手正忙：上一个导入还在进行'
    case 'no_media':
      return '没有可导入的素材'
    case 'invalid_application':
      return '不支持的 Adobe 应用'
    case 'no_active_document':
      return '请先在目标 Adobe 应用中打开一个文档或画板'
    case 'invalid_image':
      return '图片文件损坏或格式无效'
    case 'image_not_found':
      return '图片文件不存在'
    case 'partial_failure':
      return message || '部分素材导入失败'
    case 'timeout':
      return 'Adobe 响应超时，请确认目标应用没有弹窗并重试'
    case 'powershell_unavailable':
      return '本机缺少 Windows PowerShell，无法连接 Adobe'
    case 'adobe_error':
      return message || 'Adobe 导入失败，请确认目标应用已打开并重试'
    case 'unsupported_platform':
      return '本地助手目前仅支持 Windows'
    case 'too_many_items':
      return '单次导入素材数量超限'
    default:
      return message || '导入失败，请确认剪映已打开并进入工程后重试'
  }
}

/** 调助手批量导入剪映。health 为之前探测到的在线状态。 */
export async function importToJianying(port: number, items: AssistantImportItem[]): Promise<AssistantImportResult> {
  const res = await fetchWithTimeout(
    `${base(port)}/api/jianying/import`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    },
    IMPORT_TIMEOUT_MS,
  )
  const data = await res.json().catch(() => null)
  if (!data) return { ok: false, code: 'bad_response', message: '助手返回异常' }
  return data as AssistantImportResult
}

/** 调助手把图片批量导入 Photoshop 或 Illustrator。 */
export async function importToAdobe(
  port: number,
  application: AdobeApplication,
  items: AssistantImportItem[],
): Promise<AssistantImportResult> {
  const res = await fetchWithTimeout(
    `${base(port)}/api/adobe/import`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ application, items }),
    },
    IMPORT_TIMEOUT_MS,
  )
  const data = await res.json().catch(() => null)
  if (!data) return { ok: false, code: 'bad_response', message: '助手返回异常' }
  return data as AssistantImportResult
}
