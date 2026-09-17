import { getPocketBaseUrl } from "./pb"
import { getAuthHeaders } from "./auth"

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }

export interface LlmMessage {
  role: "system" | "user" | "assistant"
  content: string | LlmContentPart[]
}

export interface LlmCallOptions {
  messages: LlmMessage[]
  page?: string
  max_tokens?: number
  temperature?: number
  signal?: AbortSignal
  request_id?: string
}

export interface LlmCallResult {
  ok: boolean
  status: "success" | "failed" | "running" | "pending" | "not_found"
  text: string
  error?: string
  model?: string
  usage?: unknown
  needsLogin?: boolean
}

export interface LlmModelInfo {
  model: string
  rh_model_id: string
  max_tokens: number
  timeout_s: number
  supports_temperature: boolean
}

const CHAT_ABORT_MS = 25000
const POLL_INTERVAL_MS = 3000
const POLL_ATTEMPTS = 200

// 老代际后端兼容 (发布刷新契约, rh_vc_deploy 依赖 "legacyLlmRoutes" 这个标记判断
// 本模板可以安全刷进老 app):
// 2026-07-01 aa25af8 之前的 llm.pb.js 注册的是按模型分路由
// (/api/llm/<model>/chat|poll), 没有扁平路由 /api/llm/chat|poll。
// 发布刷新只换前端 lib、不动 app 已装的 pb_hooks, 所以扁平路由 404 时自动降级
// 到按模型路由并记住结果 (同一个后端只有一种代际)。新后端永远不会命中 404,
// 这个分支零开销。
let legacyLlmRoutes: boolean | null = null

function llmUrl(kind: "chat" | "poll", modelName: string): string {
  const base = getPocketBaseUrl()
  return legacyLlmRoutes === true
    ? `${base}/api/llm/${encodeURIComponent(modelName)}/${kind}`
    : `${base}/api/llm/${kind}`
}

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return "req-" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2, 10)
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...getAuthHeaders() }
  return headers
}

async function pollOnce(modelName: string, requestId: string): Promise<LlmCallResult> {
  let res: Response
  try {
    res = await fetch(llmUrl("poll", modelName), {
      method: "POST",
      credentials: "include",
      headers: buildHeaders(),
      body: JSON.stringify({ request_id: requestId }),
    })
  } catch {
    return { ok: false, status: "running", text: "", error: "" }
  }
  if (res.status === 412) {
    return { ok: false, status: "failed", text: "", error: "rh_login_required", needsLogin: true }
  }
  // 路由不存在 (代际不匹配/后端没装 llm hook) 时立刻走 3 次 not_found 快速失败,
  // 不要按瞬时故障无限轮询。
  if (res.status === 404) return { ok: false, status: "not_found", text: "", error: "" }
  if (!res.ok) return { ok: false, status: "running", text: "", error: "" }
  const data = await res.json().catch(() => ({}))
  return {
    ok: !!data.ok,
    status: data.status || "running",
    text: data.text || "",
    error: data.error || "",
    model: data.model,
  }
}

export async function callLlmWithFallback(modelName: string, opts: LlmCallOptions): Promise<LlmCallResult> {
  const requestId = opts.request_id || uuid()
  const payload: Record<string, unknown> = {
    model: modelName,
    messages: opts.messages,
    page: opts.page || "",
    max_tokens: opts.max_tokens,
    request_id: requestId,
  }
  if (opts.temperature !== undefined && opts.temperature !== null && !/gpt-?5/i.test(modelName)) {
    payload.temperature = opts.temperature
  }

  const ctrl = new AbortController()
  const timeoutId = window.setTimeout(() => ctrl.abort(), CHAT_ABORT_MS)
  if (opts.signal) opts.signal.addEventListener("abort", () => ctrl.abort())

  let initialFailed: boolean
  try {
    let res = await fetch(llmUrl("chat", modelName), {
      method: "POST",
      credentials: "include",
      headers: buildHeaders(),
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    if (res.status === 404 && legacyLlmRoutes === null) {
      // 扁平路由不存在 → 老代际后端, 降级重试按模型路由。
      legacyLlmRoutes = true
      res = await fetch(llmUrl("chat", modelName), {
        method: "POST",
        credentials: "include",
        headers: buildHeaders(),
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
      if (res.status === 404) {
        // 两种代际都 404: 后端根本没装这个模型的 llm 路由, 快速失败, 不进 poll。
        legacyLlmRoutes = null
        return { ok: false, status: "failed", text: "", error: "not_found" }
      }
    }
    window.clearTimeout(timeoutId)
    if (res.status === 412) {
      return { ok: false, status: "failed", text: "", error: "rh_login_required", needsLogin: true }
    }
    if (res.ok) {
      const data = await res.json().catch(() => ({}))
      return {
        ok: !!data.ok,
        status: data.status || "success",
        text: data.text || "",
        error: data.error || "",
        model: data.model,
        usage: data.usage,
      }
    }
    initialFailed = true
  } catch {
    initialFailed = true
  } finally {
    window.clearTimeout(timeoutId)
  }

  if (!initialFailed) return { ok: false, status: "failed", text: "", error: "unknown" }

  let notFoundCount = 0
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const r = await pollOnce(modelName, requestId)
    if (r.needsLogin) return r
    if (r.status === "success") return r
    if (r.status === "failed") return r
    if (r.status === "not_found") {
      notFoundCount++
      if (notFoundCount >= 3) return { ok: false, status: "failed", text: "", error: "not_found" }
    } else {
      notFoundCount = 0
    }
  }
  return { ok: false, status: "failed", text: "", error: "timeout" }
}

export async function listLlmModels(): Promise<LlmModelInfo[]> {
  const res = await fetch(`${getPocketBaseUrl()}/api/llm/models`, {
    method: "GET",
    credentials: "include",
    headers: buildHeaders(),
  })
  if (!res.ok) return []
  const data = (await res.json().catch(() => ({}))) as { models?: LlmModelInfo[] }
  return Array.isArray(data.models) ? data.models : []
}
