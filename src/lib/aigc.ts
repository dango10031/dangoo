import { getPocketBaseUrl } from "./pb"
import { getAuthHeaders } from "./auth"

export async function fileToDataUrl(f: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(f)
  })
}

export interface AigcOutput {
  url: string
  type: "image" | "video" | "audio" | "3d" | "file"
}

export interface AigcSubmitResponse {
  ok: boolean
  taskId: string
  rhTaskId?: string
  status?: "running" | "queued" | "success" | "failed"
  model?: string
  /** 站内真实扣费额(元), 由后端按统一用户价计算回传; 与界面预估价同口径 */
  chargeAmount?: number | null
  error?: string
  errorCode?: string
  message?: string
}

// 兼容早期 scaffold 版 aigc.ts 的响应包络类型 (callAigc<AigcResponse<X>> 形式的存量页面代码)。
// 新代码不需要它: 标准模型直接用 AigcSubmitResponse / callAigcAndPoll, AI 应用用 AiAppRunResponse。
export interface AigcResponse<T = unknown> {
  taskId: string
  task_id?: string
  rhTaskId?: string
  results: T[]
  outputs: AigcOutput[]
}

export interface AigcPollResponse {
  ok: boolean
  taskId: string
  status: "RUNNING" | "QUEUED" | "SUCCESS" | "FAILED" | "CANCEL"
  outputs?: AigcOutput[]
  model?: string
  error?: string
  message?: string
  usage?: AigcUsage
  /** 站内真实扣费额(元), 由后端回传 */
  chargeAmount?: number | null
}

// 真实扣费明细, 来自 RH /openapi/v2/query 终态响应的 usage 字段 (只在 SUCCESS/FAILED 等终态出现)。
// thirdPartyConsumeMoney 通常是实付金额; consumeMoney/consumeCoins 常为 null。全部按字符串处理,
// 避免浮点精度问题 —— 展示时直接拼 "¥" + thirdPartyConsumeMoney, 不要 parseFloat 再格式化。
export interface AigcUsage {
  consumeMoney: string | null
  consumeCoins: string | null
  taskCostTime: string | null
  thirdPartyConsumeMoney: string | null
}

// 价格预估响应。标准模型 endpoint 有真实单价, 通常 ok:true; AI 应用没有固定单价, RH price-preview
// 端点未必覆盖, 失败一律 ok:false —— 调用方应隐藏价格徽标而不是报错阻塞生成按钮。
export interface AigcPricePreview {
  ok: boolean
  estimatedPrice?: number
  currency?: string
  priceText?: string
  freeLimit?: boolean
  isFreeThisCall?: boolean
  message?: string
}

// 标量参数契约 (来自 aigc_models_index.json, 经 GET /api/aigc/models 透出)。enum 存在时必须渲染成
// select/segmented 控件且用 default 预选; required=true 的参数不允许隐藏或写死常量。
export interface AigcScalarParam {
  name: string
  type?: "string" | "bool" | "number"
  required?: boolean
  enum?: string[]
  default?: string | number | boolean
}

// 媒体输入契约。multiple=true 必须用 uploadAigcMediaFiles 支持多图/多文件上传 (上限 max_num),
// 不能只做单图 uploadAigcMedia —— 图生图/图编辑类模型的 imageUrls 常见 max_num 5~10。
export interface AigcMediaParam {
  name: string
  type?: "image" | "video" | "audio" | "zip"
  required?: boolean
  multiple?: boolean
  max_num?: number
  accept?: string
  max_size?: number
}

export interface AigcModelInfo {
  model: string
  endpoint: string
  output_type: "image" | "video" | "audio" | "3d" | "file"
  primary_input?: { name: string; required?: boolean } | null
  scalar_params?: AigcScalarParam[]
  media_params?: AigcMediaParam[]
}

export interface AigcSuccess {
  status: "success"
  taskId: string
  rhTaskId?: string
  outputs: AigcOutput[]
  url: string
  model?: string
  // 真实扣费明细 (来自 RH usage), 结果详情面板默认展示 taskId + usage.thirdPartyConsumeMoney。
  usage?: AigcUsage
  // 站内真实扣费额(元), 由后端按统一用户价回传, 展示「本次花费」优先取它
  chargeAmount?: number | null
}

export interface AigcFailure {
  status: "failed"
  taskId?: string
  error: string
  /**
   * errorKind 是稳定的英文枚举, 页面层按这个分支显示中文文案:
   * - submit:         提交任务失败 (网络/服务器繁忙)
   * - poll:           轮询任务状态失败 (临时上游错)
   * - timeout:        超过 deadline 仍没出结果
   * - aborted:        被 AbortSignal 取消
   * - login_required: 412 / 401 SANDBOX_TOKEN_REQUIRED 等, 引导用户登录 RunningHub
   * - insufficient_balance: RH 账户余额不足, 重试不解决, 引导充值
   * - content_audit:  内容审核未通过 (RH 内容安全规则拦截), 重试同 prompt 也救不回, 让用户换措辞
   * - task_failed:    其他业务失败 (上游模型推理失败 / 参数无效等)
   */
  errorKind:
    | "submit"
    | "poll"
    | "timeout"
    | "aborted"
    | "login_required"
    | "insufficient_balance"
    | "content_audit"
    | "task_failed"
  needsLogin?: boolean
  /** 站内账户余额不足, 引导充值 */
  needsRecharge?: boolean
  usage?: AigcUsage
}

export type AigcResult = AigcSuccess | AigcFailure

const LOGIN_REQUIRED_ZH = "请先登录后再生成"

const AIGC_ERROR_MESSAGES_ZH: Record<AigcFailure["errorKind"], string> = {
  submit: "提交生成任务失败 (网络或服务器繁忙), 请稍后重试",
  poll: "查询生成结果失败, 请稍后重试",
  timeout: "AI 生成超时 (可能服务器繁忙), 请稍后重试",
  aborted: "已取消",
  login_required: LOGIN_REQUIRED_ZH,
  insufficient_balance: "余额不足, 请充值后再生成",
  content_audit: "内容审核未通过",
  task_failed: "生成失败, 请稍后重试或换个 prompt",
}

// callAigcAndPoll 在没有真实上游文案时会把 error 设成这些内部占位字符串 (见本文件 poll 循环),
// 拼进 base 文案只会重复自己, 应该跳过。
const AIGC_ERROR_PLACEHOLDER_VALUES = new Set([
  "aborted",
  "submit failed",
  "poll timeout",
  "task_failed",
  "rh_login_required",
  "login_required",
])

// 前端请求层抛出的内部错误串(如 "AIGC /api/aigc/ai-app/wan22/run failed: HTTP 502")
// 不能展示给用户: 暴露内部路由/实现细节, 也不是可操作信息。判断是否属于这类技术细节。
function isInternalTechnicalMessage(raw: unknown): boolean {
  const s = String(raw ?? "")
  if (!s) return false
  return (
    /\/api\/aigc\//i.test(s) ||
    /\bfailed:\s*HTTP\s*\d{3}/i.test(s) ||
    /\b(?:submit|poll)\s+HTTP\s*\d{3}/i.test(s) ||
    /\b(?:AIGC|AI app|AIGC upload|AI app upload)\b[^]{0,120}\bHTTP\s*\d{3}/i.test(s) ||
    /^\s*at\s+[\w.<]|[\w$]+\s*\([^)]*:\d+:\d+\)/.test(s) // JS 堆栈帧
  )
}

function authFailureHaystack(...parts: unknown[]): string {
  return parts
    .map((part) => {
      if (part == null) return ""
      if (typeof part === "string") return part
      try {
        return JSON.stringify(part)
      } catch {
        return String(part)
      }
    })
    .join(" ")
    .toLowerCase()
}

// 发布沙箱未登录 → control 401 {detail:{code:"SANDBOX_TOKEN_REQUIRED"}};
// RH key/登录态失效 → hook 412 rh_login_required。两者都要引导登录, 不能落成"网络繁忙"。
function isLoginRequiredSignal(status: number, ...parts: unknown[]): boolean {
  if (status === 412 || status === 401) return true
  const hay = authFailureHaystack(...parts)
  return (
    hay.includes("sandbox_token_required") ||
    hay.includes("sandbox_api_key_missing") ||
    hay.includes("rh_login_required") ||
    hay.includes("login_required") ||
    hay.includes("登录态已过期") ||
    hay.includes("请先登录")
  )
}

function loginRequiredFailure(opts?: { taskId?: string; error?: string }): AigcFailure {
  return {
    status: "failed",
    taskId: opts?.taskId,
    errorKind: "login_required",
    error: opts?.error || "rh_login_required",
    needsLogin: true,
  }
}

// AigcFailure → 中文详情的默认安全格式化。对**所有** errorKind (不只 content_audit /
// insufficient_balance) 都会把 RunningHub 返回的真实原因拼在中文文案后面, 除非它是内部占位符
// 或者跟本地化文案完全一样。页面 hook 处理失败分支时应该直接调用这个函数, 不要自己写一份
// errorKind 白名单去挑着拼 result.error —— 白名单漏掉的分支 (最常见就是 task_failed) 会把
// RunningHub 的真实报错吞掉, 只剩一句通用文案, 用户看不出实际失败原因 (比如 "音频时长过短")。
// login_required 只展示引导文案, 不拼 SANDBOX_TOKEN_REQUIRED 之类的技术码。
export function formatAigcFailureMessage(result: AigcFailure): string {
  const base = AIGC_ERROR_MESSAGES_ZH[result.errorKind] || "生成失败, 请重试"
  if (result.errorKind === "login_required") return base
  const raw = result.error
  if (
    raw &&
    !AIGC_ERROR_PLACEHOLDER_VALUES.has(raw) &&
    raw !== base &&
    !isInternalTechnicalMessage(raw)
  ) {
    return `${base}: ${raw}`
  }
  return base
}

// 一条历史任务 (来自 pb_hooks 的 /api/aigc/history, 按当前 RH 用户过滤).
export interface AigcHistoryItem {
  jobId: string
  taskId: string
  status: string // running | success | failed
  page: string
  prompt: string
  resultUrl: string // 成功任务的 RH CDN URL, 失败/进行中为空串
  errorMessage: string
  rating: number
  favorite: boolean
  category: string
  note: string
  created: string
  updated: string
  // 提交时用的 RH 模型短名 (resumeAigcJob 恢复轮询时用它判断视频/音频类模型要用 30 分钟 deadline)。
  model: string
  // 真实扣费明细 (落库快照, 由 /jobs/<id>/poll 拿到终态时写入)。可能是空串 (usage 未知/未落库)。
  consumeMoney: string
  consumeCoins: string
  taskCostTime: string
  thirdPartyConsumeMoney: string
}

export interface AigcHistoryQuery {
  page?: number
  perPage?: number
  status?: string
  favorite?: boolean
  category?: string
  minRating?: number
  sort?: "newest" | "oldest" | "rating" | "favorite"
  signal?: AbortSignal
}

export type AigcHistoryPatch = Partial<Pick<AigcHistoryItem, "rating" | "favorite" | "category" | "note">>

// 哪些模型需要 30 分钟级 deadline 而不是 8 分钟. 视频 / 音频 / 3D 这类重任务都按长跑处理.
function _isLongRunningModel(modelName: string): boolean {
  const m = modelName.toLowerCase()
  return (
    m.includes("seedance") ||
    m.includes("sparkvideo") ||
    m.includes("happyhorse") ||
    m.includes("video") ||
    m.includes("audio") ||
    m.includes("music") ||
    m.includes("mureka") ||
    m.includes("song") ||
    m.includes("3d") ||
    m.includes("mesh") ||
    m.includes("hunyuan3d") ||
    m.includes("meshy") ||
    m.includes("marble")
  )
}

function buildHeaders(): Record<string, string> {
  // B1 沙箱域(*.apps.vibex.cn)上 getAuthHeaders() 返回 X-Vibex-Scoped-Token;
  // 老域返回空对象, 零影响。
  const headers: Record<string, string> = { "Content-Type": "application/json", ...getAuthHeaders() }
  return headers
}

// 提交幂等键: 优先随机 UUID, 老环境(无 crypto.randomUUID)退化为时间戳+随机串。
// 同一 callAigcAndPoll 的 3 次 submit 重试共用一个键; 后端按登录身份 + idemKey 去重。
function makeIdemKey(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`
}

// 老代际后端兼容 (发布刷新契约, rh_vc_deploy 依赖 "legacyAigcRoutes" 这个标记判断
// 本模板可以安全刷进老 app):
// 2026-07-01 aa25af8 之前的 aigc.pb.js 注册的是按模型分路由
// (/api/aigc/<model>/submit|jobs/{id}/poll|history...), 没有扁平路由。发布刷新
// 只换前端 lib、不动 app 已装的 pb_hooks, 所以扁平路由 404 时自动降级到按模型
// 路由并记住 (同一个后端只有一种代际)。新后端永远不会命中 404, 零开销。
// upload / price-preview / models 是新代际才有的路由, 老页面代码不会调用, 不降级。
let legacyAigcRoutes: boolean | null = null

function aigcRouteUrl(flat: string, legacy: string | null): string {
  const base = getPocketBaseUrl()
  return `${base}${legacyAigcRoutes === true && legacy ? legacy : flat}`
}

// 探测式 fetch: 扁平路由 404 且代际未定时, 改打老代际路由重试一次并记住结果;
// 重试仍 404 (后端两种路由都没有) 则复位探测状态并原样返回 404。
async function fetchAigcRoute(flat: string, legacy: string | null, init: RequestInit): Promise<Response> {
  let res = await fetch(aigcRouteUrl(flat, legacy), init)
  if (res.status === 404 && legacyAigcRoutes === null && legacy) {
    legacyAigcRoutes = true
    res = await fetch(aigcRouteUrl(flat, legacy), init)
    if (res.status === 404) legacyAigcRoutes = null
  }
  return res
}

function classifySubmitBusinessError(data: Partial<AigcSubmitResponse> | null, fallback = ""): AigcFailure | null {
  const code = String(data?.errorCode || "")
  const rawError = String(data?.error || "")
  const message = String(data?.message || fallback || rawError || "")
  const detailCode = String(
    (data as { detail?: { code?: string } | string } | null)?.detail &&
      typeof (data as { detail?: { code?: string } | string }).detail === "object"
      ? ((data as { detail?: { code?: string } }).detail?.code || "")
      : (data as { detail?: string } | null)?.detail || "",
  )
  if (isLoginRequiredSignal(0, code, rawError, message, detailCode, fallback, data)) {
    return loginRequiredFailure({ error: "rh_login_required" })
  }
  const hay = `${code} ${rawError} ${message}`.toLowerCase()
  if (
    rawError === "rh_insufficient_balance" ||
    code === "605" ||
    hay.includes("insufficient") ||
    hay.includes("balance") ||
    hay.includes("余额") ||
    hay.includes("点数") ||
    hay.includes("积分")
  ) {
    return { status: "failed", errorKind: "insufficient_balance", error: message || "余额不足", needsRecharge: true }
  }
  if (
    rawError === "rh_content_audit" ||
    /content security audit|内容安全审查|内容审查|审核未通过|content moderation/i.test(message)
  ) {
    return { status: "failed", errorKind: "content_audit", error: message || "内容审核未通过" }
  }
  if (rawError || code || message) {
    return { status: "failed", errorKind: "submit", error: message || rawError || "submit failed" }
  }
  return null
}

// 单次 submit, 不 poll. 多数页面应使用 callAigcAndPoll, 它已内置 poll 循环 + 错误映射.
// 直接用本函数的场景: 用户希望非阻塞提交后自己手工 poll (例如把 taskId 存 PB 后异步处理).
// 泛型默认 AigcSubmitResponse; 存量代码 callAigc<AigcResponse<X>>(...) 也兼容。
export async function callAigc<T = AigcSubmitResponse>(path: string, body: unknown): Promise<T> {
  const base = getPocketBaseUrl()
  const url = `${base}${path.startsWith("/") ? path : "/" + path}`
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: buildHeaders(),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw Object.assign(new Error(`AIGC ${path} failed: HTTP ${res.status}`), {
      status: res.status,
      body: text,
    })
  }
  return (await res.json()) as T
}

// AI 应用 (rh-app) 异步 job 形态的薄封装: run / jobs/<id>/poll / upload / history 都是 POST,
// 返回 envelope 跟标准模型不同 (rh-ai-app.v1)。复用 callAigc 的 buildHeaders + __pb 代理,
// 只放开返回类型, 由调用方按 AiAppRunResponse / AiAppUploadResponse 等断言。
// 前端**禁止**裸 fetch /api/aigc (发布 publish-aigc-auth-scan 会拦), AI 应用一律走这个。
export async function callAiApp<T>(path: string, body: unknown): Promise<T> {
  return (await callAigc(path, body)) as unknown as T
}

// AI 应用 (rh-app) 的输出条目, 来自 /run 与 /jobs/<id>/poll 的 outputs/results。
export interface AiAppOutput {
  id?: string
  type: "image" | "video" | "audio" | "text" | "file"
  url: string
  text?: string
  fileType?: string
  filename?: string
  nodeId?: string
}

// AI 应用 run/poll 的统一响应包络 (version: rh-ai-app.v1)。
// usage 只在终态 (succeeded/failed) 出现, 是真实扣费明细。
export interface AiAppRunResponse {
  ok: boolean
  version: "rh-ai-app.v1"
  state: "queued" | "running" | "succeeded" | "failed" | "partial"
  job?: { jobId: string; taskId: string; state: string }
  outputs?: AiAppOutput[]
  results?: AiAppOutput[]
  usage?: AigcUsage
  error?: { code: string; message: string; retryable: boolean; taskId?: string; failedNode?: unknown }
}

export interface AiAppUploadResponse {
  ok: boolean
  fileName: string
}

export interface AigcUploadResponse {
  ok: boolean
  type: string
  download_url: string
  downloadUrl: string
  fileName: string
  size?: string
}

// upload 的老代际路由是 /api/aigc/media/upload (返回 { ok, downloadUrl }), 新代际是
// /api/aigc/upload。发布刷新只换前端 lib、不动 app 已装的 pb_hooks, 老后端上新路由
// 404 (真实事故: app-bcbdf4c8 老 hook + 刷新后新 lib, 上传全 404) —— 与
// legacyAigcRoutes 同理探测降级并记住。rh_vc_deploy 依赖 "legacyAigcUploadRoute"
// 这个标记判断本模板可以安全刷进老代际后端的 app。
let legacyAigcUploadRoute: boolean | null = null

const AIGC_UPLOAD_FILE_TYPES = ["image", "audio", "video", "zip"] as const
type AigcUploadFileType = (typeof AIGC_UPLOAD_FILE_TYPES)[number]

// 契约兼容 (勿删): 老世代 lib 的签名是 uploadAigcMedia(file, filename) => Promise<string
// (URL)>, 而新世代是 (file, fileType) => Promise<AigcUploadResponse>。发布刷新只换本
// 文件、不动 app 页面代码, 老页面拿新 lib 会把响应对象塞进 image_url → RH/火山侧
// "content[N].image_url is invalid" (真实事故: app-bcbdf4c8 刷新后当天 190 个该错误)。
// 打包器不做类型检查, 这种同名不同契约的漂移不会在构建期暴露, 只能运行时多态:
// 第二参不在 fileType 白名单里 → 判定为老契约的 filename, 走老行为返回纯 URL 字符串。
export async function uploadAigcMedia(file: File | Blob, fileType?: AigcUploadFileType): Promise<AigcUploadResponse>
export async function uploadAigcMedia(file: File | Blob, legacyFilename: string): Promise<string>
export async function uploadAigcMedia(
  file: File | Blob,
  second: string = "image",
): Promise<AigcUploadResponse | string> {
  const legacyCall = !(AIGC_UPLOAD_FILE_TYPES as readonly string[]).includes(second)
  const legacyFilename = legacyCall ? second : ""
  const fileType: AigcUploadFileType = legacyCall
    ? (AIGC_UPLOAD_FILE_TYPES.find((t) => file.type.startsWith(`${t}/`)) ?? "image")
    : (second as AigcUploadFileType)
  const base = getPocketBaseUrl()
  const headers: Record<string, string> = { ...getAuthHeaders() }
  const doPost = (path: string) => {
    const form = new FormData()
    form.append("fileType", fileType)
    if (legacyFilename) form.append("file", file, legacyFilename)
    else form.append("file", file)
    return fetch(`${base}${path}`, { method: "POST", credentials: "include", headers, body: form })
  }
  let res = await doPost(legacyAigcUploadRoute === true ? "/api/aigc/media/upload" : "/api/aigc/upload")
  if (res.status === 404 && legacyAigcUploadRoute === null) {
    legacyAigcUploadRoute = true
    res = await doPost("/api/aigc/media/upload")
    if (res.status === 404) legacyAigcUploadRoute = null
  }
  if (res.status === 412 || res.status === 401) {
    // 老契约调用方靠 .status === 412 识别"需要重新登录"; 401 SANDBOX_TOKEN_* 归一成 412 保兼容。
    throw Object.assign(new Error("login_required"), { status: 412 })
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw Object.assign(new Error(`AIGC upload failed: HTTP ${res.status}`), {
      status: res.status,
      body: text,
    })
  }
  const data = (await res.json()) as AigcUploadResponse
  // 老路由只返回 { ok, downloadUrl }; 补齐新契约字段, 让两代后端对调用方无差别。
  if (!data.download_url && data.downloadUrl) data.download_url = data.downloadUrl
  if (!data.downloadUrl && data.download_url) data.downloadUrl = data.download_url
  if (!data.fileName) data.fileName = legacyFilename || (file instanceof File ? file.name : "upload.bin")
  if (legacyCall) return data.downloadUrl || data.download_url || ""
  return data
}

// AI 应用媒体上传: 浏览器原生 FormData 把文件以二进制直传给后端, 后端用 Go 原生
// $filesystem.fileFromMultipart() 拿文件, 完全跳过 base64。**视频/音频/大图必须走这个**——
// 不要再用 fileToDataUrl 把几十 MB 视频转 base64 塞 JSON: Goja 单线程逐字符解码会锁死 PB → 502/524。
// 本文件是 publish-aigc-auth-scan 的唯一豁免文件, 这里裸 fetch 合规;
// 不要手动设 Content-Type, 让浏览器自动带 multipart boundary (buildHeaders 会设 json, 故这里手搓 header)。
export async function uploadAiAppMedia(
  slug: string,
  file: File,
  fileType: "image" | "audio" | "video",
): Promise<AiAppUploadResponse> {
  const base = getPocketBaseUrl()
  const url = `${base}/api/aigc/ai-app/${slug}/upload?fileType=${encodeURIComponent(fileType)}`
  const headers: Record<string, string> = { ...getAuthHeaders() }
  const form = new FormData()
  form.append("fileType", fileType)
  form.append("file", file)
  const res = await fetch(url, { method: "POST", credentials: "include", headers, body: form })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw Object.assign(new Error(`AI app upload failed: HTTP ${res.status}`), {
      status: res.status,
      body: text,
    })
  }
  return (await res.json()) as AiAppUploadResponse
}

/**
 * 轮询间隔等待: 页面切到后台标签时拉长到 30s 一轮(50 个任务并跑时, 旧实现隐藏后仍保持
 * 每秒十几次请求), 回到前台立刻醒来补查; 被 abort 时 reject AbortError 由调用方处理。
 */
function pollWait(intervalMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timers: ReturnType<typeof setTimeout>[] = []
    const cleanup = () => {
      timers.forEach(clearTimeout)
      document.removeEventListener('visibilitychange', onVisible)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('aborted', 'AbortError'))
    }
    const onVisible = () => {
      if (!document.hidden) {
        cleanup()
        resolve()
      }
    }
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    signal?.addEventListener('abort', onAbort)
    document.addEventListener('visibilitychange', onVisible)
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        timers.push(setTimeout(tick, Math.max(intervalMs, 30000)))
      } else {
        cleanup()
        resolve()
      }
    }
    timers.push(setTimeout(tick, intervalMs))
  })
}

// 共享 poll 循环, 被 callAigcAndPoll (提交后立即 poll) 和 resumeAigcJob (对已有 jobId 恢复 poll,
// 例如页面挂载时接着跑 loadAigcHistory() 里状态还是 running 的任务) 复用 —— 两者的轮询/超时/错误
// 映射语义必须完全一致, 不要各写一份容易漂移。
// opts.rhTaskId / opts.model 只用于成功时回填 AigcSuccess.rhTaskId/model 展示字段, 不影响请求本身
// (poll 请求只需要 jobId/taskId, 后端会自己查表拿 rh_task_id)。
async function pollAigcToResult(
  taskId: string,
  opts: {
    pollIntervalMs?: number
    deadlineMs?: number
    signal?: AbortSignal
    rhTaskId?: string
    model?: string
    chargeAmount?: number | null
  },
): Promise<AigcResult> {
  const defaultDeadline = _isLongRunningModel(opts.model || "") ? 30 * 60_000 : 8 * 60_000
  const pollFlat = `/api/aigc/jobs/${encodeURIComponent(taskId)}/poll`
  // 老代际 poll 路由带模型名; resume 场景 item.model 缺失时无法构造, 降级不可用
  const pollLegacy = opts.model
    ? `/api/aigc/${encodeURIComponent(opts.model)}/jobs/${encodeURIComponent(taskId)}/poll`
    : null
  const deadline = Date.now() + (opts.deadlineMs ?? defaultDeadline)
  let interval = opts.pollIntervalMs ?? 2500

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      return { status: "failed", taskId, errorKind: "aborted", error: "aborted" }
    }
    try {
      await pollWait(interval, opts.signal)
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') {
        return { status: "failed", taskId, errorKind: "aborted", error: "aborted" }
      }
      throw e
    }
    interval = Math.min(interval + 500, 5000)

    let pollRes: Response
    try {
      pollRes = await fetchAigcRoute(pollFlat, pollLegacy, {
        method: "POST",
        credentials: "include",
        headers: buildHeaders(),
        body: "{}",
        signal: opts.signal,
      })
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError"
      if (aborted) {
        return { status: "failed", taskId, errorKind: "aborted", error: "aborted" }
      }
      // 网络抖动 / PB 重启窗口 → 当作 RUNNING, 继续 poll
      continue
    }

    if (pollRes.status === 412 || pollRes.status === 401) {
      const data = (await pollRes.json().catch(() => ({}))) as { error?: string; message?: string }
      return loginRequiredFailure({ taskId, error: data.message || data.error || "rh_login_required" })
    }
    // 两种代际路由都 404 = 后端根本没有这个 poll 路由, 快速失败, 不要空转到 deadline
    if (pollRes.status === 404) {
      return { status: "failed", taskId, errorKind: "poll", error: "poll route not found (HTTP 404)" }
    }
    if (!pollRes.ok) continue // 5xx / 其它 4xx 当瞬时, 继续 poll

    const data = (await pollRes.json().catch(() => ({}))) as AigcPollResponse
    const status = String(data.status || "RUNNING").toUpperCase()
    if (status === "SUCCESS") {
      const outputs = data.outputs || []
      const first = outputs.find((o) => !o.type || o.type === "image" || o.type === "video") || outputs[0]
      return {
        status: "success",
        taskId,
        rhTaskId: opts.rhTaskId,
        outputs,
        url: first?.url || "",
        model: data.model || opts.model,
        usage: data.usage,
        chargeAmount: typeof data.chargeAmount === "number" ? data.chargeAmount : opts.chargeAmount ?? null,
      }
    }
    if (status === "FAILED" || status === "CANCEL") {
      const errMsg = (data.error || data.message || "task_failed") as string
      // RH 内容审核失败的固定特征 — 重试同 prompt 救不回, 必须用 content_audit 让前端
      // 显示"换个表达试试", 不能跟普通 poll 错混在一起
      const isContentAudit =
        /content security audit|内容安全审查|内容审查|审核未通过|content moderation/i.test(errMsg)
      return {
        status: "failed",
        taskId,
        errorKind: isContentAudit ? "content_audit" : "task_failed",
        error: errMsg,
        usage: data.usage,
      }
    }
    // RUNNING / QUEUED → 继续 loop
  }

  return { status: "failed", taskId, errorKind: "timeout", error: "poll timeout" }
}

// 提交 + 自动 poll, 一次调用拿到出图 / 视频 URL. 失败 / 超时 / 412 全部返回结构化 AigcResult, **不 throw**.
//
// 模型代码只需要:
//   const r = await callAigcAndPoll("nano-banana-pro", { prompt, ... })
//   if (r.status === "success") { /* r.url, r.outputs */ } else { /* r.error, r.errorKind, r.needsLogin? */ }
//
// modelName: RH 模型短名 (必须在后端 ALLOWED_MODELS 中)
//   实际请求路径: /api/aigc/submit(body.model) + /api/aigc/jobs/<taskId>/poll
// body: 模型专属字段, 跟 rh-openapi reference 对齐.
//   常见字段:
//     - prompt: string (文生图必填)
//     - aspectRatio: "1:1" | "3:4" | "16:9" 等
//     - resolution: "1k" | "2k" | "4k"  (具体取值看 reference)
//     - imageUrls: string[]  (图生图 / 图编辑必填, use uploadAigcMedia(file).downloadUrl or another public URL)
//     - duration / generateAudio / ratio / realPersonMode  (视频特有, 看 seedance reference)
//     - page: string  (推荐传页面 slug, 用于审计)
// opts.pollIntervalMs: 默认 2500ms, 每次 +500 至 5000ms 上限
// opts.deadlineMs: 默认 8 分钟 (image, 给 BananaPro 4k / 多参考图 + RH 队列繁忙留余量), **视频/音频/3D 模型自动延长到 30 分钟** (按 modelName 识别 seedance/sparkvideo/happyhorse/video/audio/music/3d/mesh 等)
// opts.signal: AbortSignal, 中止时 result 为 { status: "failed", errorKind: "aborted" }
export async function callAigcAndPoll(
  modelName: string,
  body: unknown,
  opts?: { pollIntervalMs?: number; deadlineMs?: number; signal?: AbortSignal; onAccepted?: (taskId: string) => void },
): Promise<AigcResult> {
  const submitFlat = `/api/aigc/submit`
  const submitLegacy = `/api/aigc/${encodeURIComponent(modelName)}/submit`
  // 幂等键: 同一逻辑提交(含本函数内 3 次网络重试)复用同一 idemKey, 后端按登录身份+键去重,
  // 双击/重试窗口内不会产生两笔扣费。不同逻辑调用各自新生成, 调用方无需也无法传入。
  const idemKey = makeIdemKey()
  const submitBody = { ...((body || {}) as Record<string, unknown>), model: modelName, idemKey }

  // submit 撞 PB 热重载窗口 (1-2 秒) 时会拿到 connection refused / 5xx,
  // 这时不能直接 return failed (用户体验是"点生成没反应"), 等 1.5s retry, 最多 3 次.
  // 跟 poll 阶段的 fetch throw → continue 兜底对齐.
  let submitRes: Response | null = null
  let lastSubmitErr = ""
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts?.signal?.aborted) {
      return { status: "failed", errorKind: "aborted", error: "aborted" }
    }
    try {
      const r = await fetchAigcRoute(submitFlat, submitLegacy, {
        method: "POST",
        credentials: "include",
        headers: buildHeaders(),
        body: JSON.stringify(submitBody),
        signal: opts?.signal,
      })
      // 412 (登录态过期) 和 4xx (业务错) 不重试 — 重试也救不回来
      if (r.status === 412 || (r.status >= 400 && r.status < 500)) {
        submitRes = r
        break
      }
      // 5xx → 大概率 PB 热重载窗口或上游瞬时错, 重试
      if (!r.ok) {
        const text = await r.text().catch(() => "")
        lastSubmitErr = `submit HTTP ${r.status} ${text.slice(0, 200)}`
        if (attempt < 2) {
          await new Promise((res) => setTimeout(res, 1500))
          continue
        }
        submitRes = r
        break
      }
      // 2xx → 成功
      submitRes = r
      break
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError"
      if (aborted) {
        return { status: "failed", errorKind: "aborted", error: "aborted" }
      }
      // 网络层错误 (connection refused / PB 进程没起 / DNS 等), 大概率 PB 热重载窗口
      lastSubmitErr = String((e as Error)?.message || e)
      if (attempt < 2) {
        await new Promise((res) => setTimeout(res, 1500))
        continue
      }
      return { status: "failed", errorKind: "submit", error: lastSubmitErr }
    }
  }

  if (!submitRes) {
    return { status: "failed", errorKind: "submit", error: lastSubmitErr || "submit failed" }
  }

  if (submitRes.status === 412 || submitRes.status === 401) {
    const text = await submitRes.text().catch(() => "")
    let data: { error?: string; message?: string; detail?: { code?: string } | string }
    try {
      data = JSON.parse(text || "{}") as typeof data
    } catch {
      data = {}
    }
    if (isLoginRequiredSignal(submitRes.status, text, data, data.detail)) {
      return loginRequiredFailure({ error: data.message || data.error || "rh_login_required" })
    }
  }
  if (!submitRes.ok) {
    const text = await submitRes.text().catch(() => "")
    let data: Partial<AigcSubmitResponse> | null
    try {
      data = JSON.parse(text || "{}") as Partial<AigcSubmitResponse>
    } catch {
      data = null
    }
    if (isLoginRequiredSignal(submitRes.status, text, data)) {
      return loginRequiredFailure({ error: "rh_login_required" })
    }
    const businessErr = classifySubmitBusinessError(data, text.slice(0, 200))
    if (businessErr) return businessErr
    return {
      status: "failed",
      errorKind: "submit",
      error: `submit HTTP ${submitRes.status} ${text.slice(0, 200)}`,
    }
  }

  const sub = (await submitRes.json()) as AigcSubmitResponse
  const taskId = sub.taskId
  if (!taskId) {
    const businessErr = classifySubmitBusinessError(sub)
    if (businessErr) return businessErr
    return { status: "failed", errorKind: "submit", error: "submit returned no taskId" }
  }

  // 任务被真正受理(拿到内部 jobId)即刻回调, 调用方可在开始轮询前持久化该 ID,
  // 用于刷新后精确续轮询, 不再只靠提示词猜测历史任务归属。
  try {
    opts?.onAccepted?.(taskId)
  } catch {
    /* 回调异常不得影响轮询主流程 */
  }

  return pollAigcToResult(taskId, {
    pollIntervalMs: opts?.pollIntervalMs,
    deadlineMs: opts?.deadlineMs,
    signal: opts?.signal,
    rhTaskId: sub.rhTaskId,
    model: sub.model || modelName,
    chargeAmount: sub.chargeAmount,
  })
}

// 恢复一个已提交、还没跑到终态的任务的 poll —— 用于页面挂载 (或用户手动点开"进行中"任务) 时,
// 把 loadAigcHistory() 里 status === "running" 的历史项接着跑完, 而不是让它在浏览器刷新/关闭重开后
// 就再也没人推进 (RH 那边任务其实早就跑完了, 只是没人来 poll 把结果写回 aigc_tasks)。
//
// 页面标准用法 (挂载时):
//   const items = await loadAigcHistory("nano-banana-pro")
//   const runningItems = items.filter((it) => it.status === "running")
//   runningItems.forEach((it) => {
//     // 先把 it 渲染成"进行中"卡片, 再后台续跑:
//     resumeAigcJob(it).then((r) => { /* 更新这张卡片: success → url, failed → error */ })
//   })
//
// 跟 callAigcAndPoll 的核心区别: 不需要重新 submit, 直接对已有 jobId 继续 poll。如果 RH 那边
// 早已完成, 第一次 poll 就会拿到终态并顺带把 PB 记录写成 success/failed —— 不会因为"用户来晚了"
// 就丢结果。deadline 仍按 item.model 是否为视频/音频等长任务模型选 8/30 分钟, 不是"从任务提交时刻
// 算起还剩多久", 而是"从这次 resume 调用开始, 最多再等这么久", 所以对一个已经跑了很久的任务重新
// resume 也不会立刻超时。
export async function resumeAigcJob(
  item: { jobId: string; model?: string },
  opts?: { pollIntervalMs?: number; deadlineMs?: number; signal?: AbortSignal },
): Promise<AigcResult> {
  return pollAigcToResult(item.jobId, {
    pollIntervalMs: opts?.pollIntervalMs,
    deadlineMs: opts?.deadlineMs,
    signal: opts?.signal,
    model: item.model,
  })
}

// ============ AI 应用 (rh-app) 的提交/轮询/恢复 helper, 与标准模型的 callAigcAndPoll /
// resumeAigcJob / formatAigcFailureMessage 完全对称。页面不要自己写 while poll 循环。 ============

export interface AiAppPollOpts {
  // 默认 3000ms, 与旧版 useAiAppPage 模板行为一致
  pollIntervalMs?: number
  // 默认 60 分钟 (AI 应用是整条 workflow, 常远慢于单模型调用)
  deadlineMs?: number
  signal?: AbortSignal
  /** 任务被受理拿到 jobId 后即刻回调(开始轮询前), 供调用方持久化以支持刷新精确恢复 */
  onAccepted?: (jobId: string) => void
}

function aiAppFailure(code: string, message: string, jobId: string, retryable = false): AiAppRunResponse {
  return {
    ok: false,
    version: "rh-ai-app.v1",
    state: "failed",
    job: { jobId, taskId: "", state: "failed" },
    outputs: [],
    results: [],
    error: { code, message, retryable },
  }
}

// 共享 poll 循环, 被 callAiAppAndPoll (提交后立即 poll) 和 resumeAiAppJob (对已有 jobId 恢复 poll)
// 复用。终态一律以 AiAppRunResponse 形式返回, **不 throw**:
// - 超时       → error.code = "TIMEOUT"
// - 连续断网   → error.code = "NETWORK"
// - 取消       → error.code = "ABORTED"
// - 412/401/登录错 → error.code = "RH_LOGIN_REQUIRED" (页面据此翻 needsRhLogin)
async function pollAiAppToResult(slug: string, jobId: string, opts?: AiAppPollOpts): Promise<AiAppRunResponse> {
  const interval = opts?.pollIntervalMs ?? 3000
  const deadline = Date.now() + (opts?.deadlineMs ?? 60 * 60_000)
  let consecutiveFails = 0
  while (true) {
    if (opts?.signal?.aborted) return aiAppFailure("ABORTED", "已取消", jobId)
    if (Date.now() > deadline) return aiAppFailure("TIMEOUT", "生成超时, 请重试", jobId, true)
    try {
      await pollWait(interval, opts?.signal)
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return aiAppFailure("ABORTED", "已取消", jobId)
      throw e
    }
    try {
      const pollRes = await callAiApp<AiAppRunResponse>(`/api/aigc/ai-app/${slug}/jobs/${encodeURIComponent(jobId)}/poll`, {})
      consecutiveFails = 0
      if (pollRes.state === "succeeded" || pollRes.state === "failed" || pollRes.state === "partial") {
        return pollRes
      }
      // queued / running → 继续 loop
    } catch (e) {
      const status = Number((e as { status?: number })?.status || 0)
      const body = String((e as { body?: string })?.body || "")
      const msg = String((e as Error)?.message || e)
      if ((e as { name?: string })?.name === "AbortError") return aiAppFailure("ABORTED", "已取消", jobId)
      if (isLoginRequiredSignal(status, msg, body)) {
        return aiAppFailure("RH_LOGIN_REQUIRED", LOGIN_REQUIRED_ZH, jobId)
      }
      consecutiveFails++
      if (consecutiveFails >= 5) {
        return aiAppFailure("NETWORK", "网络连接不稳定, 请检查网络后重试", jobId, true)
      }
    }
  }
}

// 提交 AI 应用 run + 自动 poll 到终态, 一次调用拿到 outputs。失败/超时/412 全部返回结构化
// AiAppRunResponse (state === "failed" + error), **不 throw**。
// 页面标准用法:
//   const r = await callAiAppAndPoll(SLUG, runBody)
//   if (r.state === "succeeded") { /* r.outputs, r.usage */ }
//   else { setErrorMsg(formatAiAppFailureMessage(r)); if (r.error?.code === "RH_LOGIN_REQUIRED") setNeedsRhLogin(true) }
export async function callAiAppAndPoll(slug: string, body: unknown, opts?: AiAppPollOpts): Promise<AiAppRunResponse> {
  let submitRes: AiAppRunResponse
  try {
    submitRes = await callAiApp<AiAppRunResponse>(`/api/aigc/ai-app/${slug}/run`, body)
  } catch (e) {
    const status = Number((e as { status?: number })?.status || 0)
    const errBody = String((e as { body?: string })?.body || "")
    const msg = String((e as Error)?.message || e)
    if (isLoginRequiredSignal(status, msg, errBody)) {
      return aiAppFailure("RH_LOGIN_REQUIRED", LOGIN_REQUIRED_ZH, "")
    }
    return aiAppFailure("SUBMIT_FAILED", msg || "提交失败, 请重试", "", true)
  }
  if (
    submitRes.error?.code?.startsWith("APIKEY") ||
    isLoginRequiredSignal(0, submitRes.error?.code, submitRes.error?.message)
  ) {
    return aiAppFailure("RH_LOGIN_REQUIRED", LOGIN_REQUIRED_ZH, "")
  }
  const jobId = submitRes.job?.jobId
  if (!jobId) {
    // 同步完成 (部分 AI 应用 run 直接带 outputs 返回终态)
    if (submitRes.state === "succeeded" || submitRes.state === "failed") return submitRes
    return aiAppFailure(submitRes.error?.code || "SUBMIT_FAILED", submitRes.error?.message || "提交失败, 请重试", "", true)
  }
  try {
    opts?.onAccepted?.(jobId)
  } catch {
    /* 回调异常不得影响轮询主流程 */
  }
  return pollAiAppToResult(slug, jobId, opts)
}

// 恢复一个已提交、还没跑到终态的 AI 应用任务的 poll —— 用于页面挂载 (或用户手动点开"进行中"任务)
// 时, 把 history 里 status === "running" 的历史项接着跑完, 而不是让它在浏览器刷新/关闭重开后
// 就再也没人推进 (RH 那边任务其实早就跑完了, 只是没人来 poll 把结果写回 aigc_tasks)。
// 页面标准用法 (挂载时):
//   const r = await callAiApp<{ ok: boolean; items?: AigcHistoryItem[] }>(`/api/aigc/ai-app/${SLUG}/history`, {})
//   r.items?.filter((it) => it.status === "running").forEach((it) => {
//     // 先把 it 渲染成"进行中"卡片, 再后台续跑:
//     resumeAiAppJob(SLUG, it).then((res) => { /* 更新这张卡片: succeeded → url, failed → error */ })
//   })
// deadline 从这次 resume 调用开始计, 对已跑很久的任务重新 resume 不会立刻超时。
export async function resumeAiAppJob(
  slug: string,
  item: { jobId: string },
  opts?: AiAppPollOpts,
): Promise<AiAppRunResponse> {
  return pollAiAppToResult(slug, item.jobId, opts)
}

const AI_APP_ERROR_MESSAGES_ZH: Record<string, string> = {
  RH_LOGIN_REQUIRED: LOGIN_REQUIRED_ZH,
  TIMEOUT: "AI 生成超时 (可能服务器繁忙), 请稍后重试",
  NETWORK: "网络连接不稳定, 请检查网络后重试",
  ABORTED: "已取消",
  SUBMIT_FAILED: "提交生成任务失败 (网络或服务器繁忙), 请稍后重试",
}

// AiAppRunResponse 失败分支 → 中文详情的默认安全格式化, 镜像 formatAigcFailureMessage。
// 对**所有**错误码都把 RunningHub 返回的真实原因拼在中文文案后面 (除非与基础文案重复), 不做
// 白名单挑着拼 —— 白名单漏掉的分支会把 RH 真实报错 (如 "音频时长过短") 吞掉。
// 页面处理失败分支时直接调用这个函数, 不要自己按 error.code 写一份映射。
// RH_LOGIN_REQUIRED / SANDBOX_TOKEN_* 只展示登录引导, 不拼技术码。
export function formatAiAppFailureMessage(res: AiAppRunResponse): string {
  const code = String(res.error?.code || "")
  const raw = String(res.error?.message || "")
  const hay = `${code} ${raw}`.toLowerCase()
  let base = AI_APP_ERROR_MESSAGES_ZH[code] || ""
  if (!base) {
    if (code.startsWith("APIKEY") || isLoginRequiredSignal(0, code, raw)) base = AI_APP_ERROR_MESSAGES_ZH.RH_LOGIN_REQUIRED
    else if (hay.includes("insufficient") || hay.includes("balance") || hay.includes("余额") || hay.includes("点数") || hay.includes("积分")) base = "余额不足, 请充值后再生成"
    else if (/content security audit|内容安全审查|内容审查|审核未通过|content moderation/i.test(raw)) base = "内容审核未通过"
    else base = "生成失败, 请稍后重试或换个 prompt"
  }
  if (base === AI_APP_ERROR_MESSAGES_ZH.RH_LOGIN_REQUIRED) return base
  if (raw && raw !== base && !isInternalTechnicalMessage(raw)) return `${base}: ${raw}`
  return base
}

// 加载当前 RH 用户在该模型下的历史任务 (默认按 -created 倒序). 用于页面挂载时恢复历史:
// 把最近一张成功结果 (status === "success" && resultUrl) 恢复到主展示区, 避免刷新后空白。
//   const items = await loadAigcHistory("nano-banana-pro")
//   const last = items.find((it) => it.status === "success" && it.resultUrl)
//   if (last) setResultUrl(last.resultUrl)
// 失败时返回 [] (不 throw), 让页面优雅降级到空历史。
export async function loadAigcHistory(
  modelName: string,
  opts?: AigcHistoryQuery,
): Promise<AigcHistoryItem[]> {
  try {
    const res = await fetchAigcRoute(`/api/aigc/history`, `/api/aigc/${encodeURIComponent(modelName)}/history`, {
      method: "POST",
      credentials: "include",
      headers: buildHeaders(),
      body: JSON.stringify({
        page: opts?.page ?? 1,
        perPage: opts?.perPage ?? 20,
        status: opts?.status,
        favorite: opts?.favorite,
        category: opts?.category,
        minRating: opts?.minRating,
        sort: opts?.sort,
        model: modelName,
      }),
      signal: opts?.signal,
    })
    if (!res.ok) return []
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; items?: AigcHistoryItem[] }
    return Array.isArray(data.items) ? data.items : []
  } catch {
    return []
  }
}

export async function updateAigcHistoryItem(
  modelName: string,
  jobId: string,
  patch: AigcHistoryPatch,
): Promise<AigcHistoryItem | null> {
  const res = await fetchAigcRoute(
    `/api/aigc/history/${encodeURIComponent(jobId)}/update`,
    `/api/aigc/${encodeURIComponent(modelName)}/history/${encodeURIComponent(jobId)}/update`,
    {
      method: "POST",
      credentials: "include",
      headers: buildHeaders(),
      body: JSON.stringify({ ...patch, model: modelName }),
    },
  )
  if (!res.ok) return null
  const data = (await res.json().catch(() => ({}))) as { item?: AigcHistoryItem }
  return data.item || null
}

export async function deleteAigcHistoryItem(modelName: string, jobId: string): Promise<boolean> {
  const res = await fetchAigcRoute(
    `/api/aigc/history/${encodeURIComponent(jobId)}/delete`,
    `/api/aigc/${encodeURIComponent(modelName)}/history/${encodeURIComponent(jobId)}/delete`,
    {
      method: "POST",
      credentials: "include",
      headers: buildHeaders(),
      body: JSON.stringify({ model: modelName }),
    },
  )
  if (!res.ok) return false
  const data = (await res.json().catch(() => ({}))) as { deleted?: boolean }
  return !!data.deleted
}

export async function listAigcModels(): Promise<AigcModelInfo[]> {
  const res = await fetch(`${getPocketBaseUrl()}/api/aigc/models`, {
    method: "GET",
    credentials: "include",
    headers: buildHeaders(),
  })
  if (!res.ok) return []
  const data = (await res.json().catch(() => ({}))) as { models?: AigcModelInfo[] }
  return Array.isArray(data.models) ? data.models : []
}

// listAigcModels() 的便捷查找: 拿到单个模型的参数契约 (scalar_params 的 enum/required/default,
// media_params 的 multiple/max_num), 用于页面挂载时驱动分辨率/比例/多图上传等控件的渲染。
// 找不到时返回 null —— 调用方应回退到"只渲染主文本输入", 不要因此崩溃或整页报错。
export async function getAigcModelInfo(modelName: string): Promise<AigcModelInfo | null> {
  const models = await listAigcModels()
  return models.find((m) => m.model === modelName) || null
}

// 多图/多文件上传的标准通路 —— media_params.multiple=true 的参数 (如图生图 imageUrls) 必须走这个,
// 不能只接单图。逐个错峰 (~300ms) 发起, 避免同一时刻打满 /api/aigc/upload; 单个文件上传失败会被
// 跳过而不是让整批失败。opts.maxCount 通常传契约里的 max_num, 超出的文件直接截断丢弃。
// 返回的 downloadUrl 顺序对应输入 files 里成功项的相对顺序 (失败项被过滤掉, 不占位)。
export async function uploadAigcMediaFiles(
  files: File[],
  fileType: "image" | "audio" | "video" | "zip" = "image",
  opts?: { maxCount?: number },
): Promise<string[]> {
  const capped = opts?.maxCount ? files.slice(0, opts.maxCount) : files
  const results = await Promise.all(
    capped.map(
      (file, i) =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            uploadAigcMedia(file, fileType)
              .then((res) => resolve(res.downloadUrl || ""))
              .catch(() => resolve(""))
          }, i * 300)
        }),
    ),
  )
  return results.filter((url) => !!url)
}

// 把 price-preview 响应格式化成徽标文案。RH 有时只回 estimatedPrice、不回 priceText ——
// **禁止**页面只判断 `r.ok && r.priceText`(实测会永远落到"按实际扣费"/假"预估中")。
// 返回 null = 本次拿不到价, View 用「按实际扣费」降级, 绝不能用「费用预估中」当失败兜底。
export function formatAigcPricePreview(r: AigcPricePreview | null | undefined): string | null {
  if (!r || !r.ok) return null
  if (r.isFreeThisCall) return "本次免费"
  const text = typeof r.priceText === "string" ? r.priceText.trim() : ""
  if (text) return text
  if (typeof r.estimatedPrice === "number" && Number.isFinite(r.estimatedPrice)) {
    const currency = (r.currency || "CNY").trim() || "CNY"
    return `约 ${r.estimatedPrice} ${currency}`
  }
  return null
}

// 标准模型价格预估: body 跟提交 callAigcAndPoll(modelName, body) 时完全一样的参数即可 (会自动加
// model 字段)。**从不 throw**, 网络错误/端点不存在/模型不允许都归一成 { ok: false }。
// 页面用法: 参数变化时设 priceLoading=true → debounce (~500ms) 调本函数 →
// setPriceText(formatAigcPricePreview(r)) → finally priceLoading=false。
// View 徽标三态: priceLoading?'预估中':(priceText||'按实际扣费')。绝不能因为预估失败挡住生成。
export async function previewAigcPrice(
  modelName: string,
  body: unknown,
): Promise<AigcPricePreview> {
  try {
    const base = getPocketBaseUrl()
    const res = await fetch(`${base}/api/aigc/price-preview`, {
      method: "POST",
      credentials: "include",
      headers: buildHeaders(),
      body: JSON.stringify({ ...((body || {}) as Record<string, unknown>), model: modelName }),
    })
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
    return (await res.json().catch(() => ({ ok: false }))) as AigcPricePreview
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message || e) }
  }
}

// AI 应用价格预估: body 跟提交 callAiApp(.../run, body) 时完全一样的参数 (manifest.fields[].key
// 逐个平铺在顶层)。AI 应用没有固定单价, RH price-preview 端点未必覆盖这类任务, 失败(含 404)一律
// 归一成 { ok: false } —— 页面应隐藏价格徽标, 改显示"按 RunningHub 实际扣费", 不阻塞提交。
export async function previewAiAppPrice(slug: string, body: unknown): Promise<AigcPricePreview> {
  try {
    return await callAiApp<AigcPricePreview>(`/api/aigc/ai-app/${slug}/price-preview`, body)
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message || e) }
  }
}

export async function updateAiAppHistoryItem(
  slug: string,
  jobId: string,
  patch: AigcHistoryPatch,
): Promise<AigcHistoryItem | null> {
  const res = await callAiApp<{ ok: boolean; item?: AigcHistoryItem }>(
    `/api/aigc/ai-app/${slug}/history/${encodeURIComponent(jobId)}/update`,
    patch,
  )
  return res.item || null
}

export async function deleteAiAppHistoryItem(slug: string, jobId: string): Promise<boolean> {
  const res = await callAiApp<{ ok: boolean; deleted?: boolean }>(
    `/api/aigc/ai-app/${slug}/history/${encodeURIComponent(jobId)}/delete`,
    {},
  )
  return !!res.deleted
}

/**
 * 跨域结果图/视频下载。直接用 a.href + a.download 对跨域 URL 无效(浏览器忽略
 * download 属性, 退化成新标签打开), 必须先 fetch 拿 blob, 再用本地 blob URL 触发下载。
 */
export async function downloadAigcResult(url: string, filename?: string): Promise<void> {
  try {
    const res = await fetch(url)
    const blob = await res.blob()
    const ext = blob.type.includes("video")
      ? "mp4"
      : blob.type.includes("png")
      ? "png"
      : "jpg"
    const name = filename ?? `result-${Date.now()}.${ext}`
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = blobUrl
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
  } catch {
    window.open(url, "_blank") // 兜底: 至少能看到
  }
}

// ---- 历史代际兼容导出（新代码不要使用, 上传请用 uploadAigcMedia / uploadAiAppMedia）----
// 2026-06 一代 lib 的页面代码 import { uploadRefImage(s) }（base64 dataURL 上传）。
// 发布刷新（rh_vc_deploy 把旧 lib 刷成本模板）要求本文件导出面是全部历史拷贝的
// 超集，否则 vite build 失败触发回滚保险丝，连 rhLogin.ts 一起退回旧版，沙箱域
// (*.apps.vibex.cn) 登录态直接失效（真实事故: prompt.apps.vibex.cn）。这里用当前
// 上传链路实现同签名薄包装：dataURL → File → uploadAigcMedia（multipart）。
export async function uploadRefImage(
  dataUrl: string,
): Promise<{ download_url: string; fileName: string }> {
  const blob = await (await fetch(dataUrl)).blob()
  const ext = (blob.type.split("/")[1] || "png").split("+")[0]
  const file = new File([blob], `ref-${Date.now()}.${ext}`, { type: blob.type || "image/png" })
  const res = await uploadAigcMedia(file, "image")
  return { download_url: res.download_url || res.downloadUrl || "", fileName: res.fileName || "" }
}

// 批量版本: 与老签名一致, 并发上传, 任意一张失败整体抛错。
export async function uploadRefImages(
  dataUrls: string[],
): Promise<Array<{ download_url: string; fileName: string }>> {
  return Promise.all(dataUrls.map((u) => uploadRefImage(u)))
}

// 相对路径 → 当前 origin 绝对 URL（老代际导出, persistMediaUrl 依赖）。
export function toAbsoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  if (typeof window === "undefined") return path
  return `${window.location.origin}${path}`
}

// 老代际"外链落地到 PB media_assets"接口（/api/media/persist 是老 pb_hooks 路由,
// 发布刷新不动 app 已装的 hooks, 所以端点仍在）。失败一律返回原 URL 不阻塞主流程。
export async function persistMediaUrl(url: string, kind: string): Promise<string> {
  if (!url) return url
  if (url.includes("/api/files/media_assets/")) return toAbsoluteUrl(url)
  const base = getPocketBaseUrl()
  try {
    const res = await fetch(`${base}/api/media/persist`, {
      method: "POST",
      credentials: "include",
      headers: buildHeaders(),
      body: JSON.stringify({ url, kind }),
    })
    if (!res.ok) return url
    const data = (await res.json().catch(() => null)) as { ok?: boolean; url?: string } | null
    if (data?.ok && data.url) return toAbsoluteUrl(`${base}${data.url}`)
  } catch {
    // 落地失败时先用原 URL 不阻塞主流程
  }
  return url
}

export async function persistMediaUrls(urls: string[], kind: string): Promise<string[]> {
  return Promise.all(urls.map((u) => persistMediaUrl(u, kind)))
}
