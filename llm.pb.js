/// <reference path="../pb_data/types.d.ts" />
// pb_hooks/llm.pb.js — RunningHub LLM 中转 (self-contained, 单路由 + allowlist, 含超时降级)
//
// 路由约定:
//   POST /api/llm/chat   body.model=<rh-model-short>
//   POST /api/llm/poll   body.request_id=<same request_id>
//   GET  /api/llm/models 返回本 hook 允许使用的模型清单
//
// ⚠️ 这个文件由 mcp__rh-pb-hooks__install_llm_template 装到目标路径,
//    模型**不要直接 Read+Write** 这个模板. 流程:
//
//   场景 A — 首次写:
//     mcp__rh-pb-hooks__install_llm_template(vibex_app_id="app-xxxx", model_overrides=None)
//
//   场景 B — 加新模型:
//     mcp__rh-pb-hooks__add_llm_model(...) 只追加 ALLOWED_MODELS, 不新增路由.
//
//   场景 C — 复用现有模型:
//     0 后端改动. 前端 callLlmWithFallback("<rh-model-short>", { messages, page })
//
// 稳定性契约:
//   /chat 仍是同步 $http.send, 但客户端会提前放弃等待并转 /poll; 本 handler 必须继续跑完并写 llm_jobs.
//   不要把 timeout_s 调低到前端 poll 预算以下; 慢模型输出长度要用 max_tokens 控制延迟.
//
// 字段名注意:
//   - PB 不允许字段名叫 model (跟 PB Record 内置属性冲突) → 表字段用 model_name.
//   - 不要默认给 LLM payload 加 temperature。GPT-5.5 等模型不支持该参数。
//     只有前端显式传 temperature 且 cfg.supports_temperature=true 时才透传。

var ALLOWED_MODELS = {"doubao-seed-2.0-lite":{"rh_model_id":"bytedance/doubao-seed-2.0-lite","max_tokens":8192,"timeout_s":600,"supports_temperature":true},"gemini-3.5-flash":{"rh_model_id":"google/gemini-3.5-flash","max_tokens":8192,"timeout_s":600,"supports_temperature":true},"qwen3.8-max":{"rh_model_id":"qwen/qwen3.8-max","max_tokens":8192,"timeout_s":600,"supports_temperature":true},"qwen3.8-flash-next":{"rh_model_id":"qwen/qwen3.8-flash-next","max_tokens":16384,"timeout_s":600,"supports_temperature":true},"gemini-3.8-flash":{"rh_model_id":"google/gemini-3.8-flash","max_tokens":16384,"timeout_s":600,"supports_temperature":true},"doubao-seed-2.1-pro":{"rh_model_id":"bytedance/doubao-seed-2.1-pro","max_tokens":16384,"timeout_s":600,"supports_temperature":true}}
var LLM_BASE = "https://llm.runninghub.cn"
var LLM_APP_CODE = "vibex"

onBootstrap(function (e) {
  e.next()
  try {
    var existing = null
    try { existing = $app.findCollectionByNameOrId("llm_jobs") } catch (_) { existing = null }
    if (!existing) {
      var col = new Collection({
        type: "base", name: "llm_jobs",
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        fields: [
          { name: "request_id", type: "text", required: true, max: 160 },
          { name: "model_name", type: "text", required: true, max: 80 },
          { name: "page", type: "text", max: 64 },
          { name: "status", type: "text", required: true, max: 32 },
          { name: "result_text", type: "text", max: 80000 },
          { name: "error_message", type: "text", max: 4000 },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_llm_jobs_request_id ON llm_jobs (request_id)"],
      })
      $app.save(col)
      try { $app.logger().info("llm_jobs created") } catch (_) {}
    } else {
      var changed = false
      function hasField(name) {
        try { return !!existing.fields.getByName(name) } catch (_) {}
        try {
          for (var i = 0; i < existing.fields.length; i++) {
            if (String(existing.fields[i].name) === String(name)) return true
          }
        } catch (_) {}
        return false
      }
      function addField(def) {
        if (hasField(def.name)) return
        try { existing.fields.add(new Field(def)); changed = true } catch (_) {}
      }
      addField({ name: "tool_calls_json", type: "text", max: 200000 })
      addField({ name: "finish_reason", type: "text", max: 32 })
      if (changed) {
        $app.save(existing)
        try { $app.logger().info("llm_jobs fields upgraded") } catch (_) {}
      }
    }
  } catch (err) {
    try { $app.logger().error("llm_jobs bootstrap: " + String(err && err.message || err)) } catch (_) {}
  }
})

routerAdd("GET", "/api/llm/models", function (e) {
  try {
    var allowedModels = {"doubao-seed-2.0-lite":{"rh_model_id":"bytedance/doubao-seed-2.0-lite","max_tokens":8192,"timeout_s":600,"supports_temperature":true},"gemini-3.5-flash":{"rh_model_id":"google/gemini-3.5-flash","max_tokens":8192,"timeout_s":600,"supports_temperature":true},"qwen3.8-max":{"rh_model_id":"qwen/qwen3.8-max","max_tokens":8192,"timeout_s":600,"supports_temperature":true},"qwen3.8-flash-next":{"rh_model_id":"qwen/qwen3.8-flash-next","max_tokens":16384,"timeout_s":600,"supports_temperature":true},"gemini-3.8-flash":{"rh_model_id":"google/gemini-3.8-flash","max_tokens":16384,"timeout_s":600,"supports_temperature":true},"doubao-seed-2.1-pro":{"rh_model_id":"bytedance/doubao-seed-2.1-pro","max_tokens":16384,"timeout_s":600,"supports_temperature":true}}
    var items = []
    for (var key in allowedModels) {
      if (!Object.prototype.hasOwnProperty.call(allowedModels, key)) continue
      var cfg = allowedModels[key] || {}
      items.push({
        model: key,
        rh_model_id: cfg.rh_model_id || "",
        max_tokens: cfg.max_tokens || 8192,
        timeout_s: cfg.timeout_s || 600,
        supports_temperature: !!cfg.supports_temperature,
      })
    }
    return e.json(200, { ok: true, models: items })
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("llm_models_error: " + msg) } catch (_) {}
    return e.json(500, { error: "llm_models_error", message: "模型列表暂时不可用" })
  }
})

routerAdd("POST", "/api/llm/chat", function (e) {
  function readKey(ev) {
    return $os.getenv("RH_LLM_API_KEY") || $os.getenv("RH_API_KEY") || ""
  }
  function isRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0 || s.indexOf("APIKEY_INVALID") >= 0 || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf('"errorCode":"806"') >= 0 || s.indexOf('"errorCode":"412"') >= 0
  }
  function ensureLlmJobsColl() {
    try { return $app.findCollectionByNameOrId("llm_jobs") } catch (_) {}
    var col = new Collection({
      type: "base", name: "llm_jobs",
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
        { name: "request_id", type: "text", required: true, max: 160 },
        { name: "model_name", type: "text", required: true, max: 80 },
        { name: "page", type: "text", max: 64 },
        { name: "status", type: "text", required: true, max: 32 },
        { name: "result_text", type: "text", max: 80000 },
        { name: "error_message", type: "text", max: 4000 },
        { name: "tool_calls_json", type: "text", max: 200000 },
        { name: "finish_reason", type: "text", max: 32 },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_llm_jobs_request_id ON llm_jobs (request_id)"],
    })
    $app.save(col)
    return $app.findCollectionByNameOrId("llm_jobs")
  }
  function scopedRequestId(userId, requestId) {
    return String(userId || "") + ":" + String(requestId || "")
  }
  function findOrCreateJob(coll, storageRequestId, modelName, page) {
    var rec = null
    try { rec = $app.findFirstRecordByFilter("llm_jobs", "request_id = {:r}", { r: storageRequestId }) } catch (_) {}
    if (!rec) {
      rec = new Record(coll)
      rec.set("request_id", storageRequestId)
      rec.set("model_name", modelName)
      rec.set("page", page || "")
      rec.set("status", "pending")
      $app.save(rec)
    }
    return rec
  }
  // 上报访客自付 LLM 消耗到 VibeX control 收益看板 (self-contained, fail-soft, 绝不抛错/阻断业务)
  function reportLlmIndex(f) {
    try {
      var base = ($os.getenv("VIBEX_CONTROL_URL") || "").replace(/\/+$/, "")
      var appId = $os.getenv("VIBEX_APP_ID")
      if (!base || !appId || !f || !f.rh_request_id) return
      var headers = { "Content-Type": "application/json" }
      var tok = $os.getenv("VIBEX_TASK_INDEX_TOKEN")
      if (tok) headers.Authorization = "Bearer " + tok
      $http.send({
        url: base + "/api/app-llm-index/upsert", method: "POST", headers: headers,
        body: JSON.stringify({
          app_id: appId, snapshot_id: $os.getenv("VIBEX_PUBLISH_SNAPSHOT_ID") || null,
          rh_request_id: String(f.rh_request_id), rh_user_id: f.rh_user_id || null,
          model_name: f.model_name || null,
          prompt_tokens: f.prompt_tokens || 0, completion_tokens: f.completion_tokens || 0, total_tokens: f.total_tokens || 0,
          charged_amount: (f.charged_amount != null && f.charged_amount !== "") ? String(f.charged_amount) : "0",
          currency: f.currency || "CNY", status: f.status || "success",
        }),
        timeout: 5,
      })
    } catch (_) {}
  }

  var requestId = ""
  var jobRec = null

  try {
    var allowedModels = {"doubao-seed-2.0-lite":{"rh_model_id":"bytedance/doubao-seed-2.0-lite","max_tokens":8192,"timeout_s":600,"supports_temperature":true},"gemini-3.5-flash":{"rh_model_id":"google/gemini-3.5-flash","max_tokens":8192,"timeout_s":600,"supports_temperature":true},"qwen3.8-max":{"rh_model_id":"qwen/qwen3.8-max","max_tokens":8192,"timeout_s":600,"supports_temperature":true},"qwen3.8-flash-next":{"rh_model_id":"qwen/qwen3.8-flash-next","max_tokens":16384,"timeout_s":600,"supports_temperature":true},"gemini-3.8-flash":{"rh_model_id":"google/gemini-3.8-flash","max_tokens":16384,"timeout_s":600,"supports_temperature":true},"doubao-seed-2.1-pro":{"rh_model_id":"bytedance/doubao-seed-2.1-pro","max_tokens":16384,"timeout_s":600,"supports_temperature":true}}
    var llmBase = "https://llm.runninghub.cn"
    var llmAppCode = "vibex"
    var key = readKey(e)
    if (!key) return e.json(412, { error: "rh_login_required", message: "请用右上角按钮登录 RunningHub" })

    var body = e.requestInfo().body || {}
    var modelName = String(body.model || "").trim()
    var cfg = modelName ? allowedModels[modelName] : null
    if (!cfg) return e.json(400, { error: "model_not_allowed", message: "LLM 模型未在服务端 allowlist 中启用", model: modelName })

    var messages = body.messages
    if (!messages || !messages.length) return e.json(400, { error: "messages_required", message: "缺少 messages" })

    requestId = String(body.request_id || "").trim()
    if (!requestId) return e.json(400, { error: "request_id_required", message: "缺少 request_id (前端必须生成唯一 ID 传入, 用于超时后查询)" })
    if (requestId.length > 120) return e.json(400, { error: "request_id_too_long", message: "request_id 过长" })
    var authId = String(e.get("authId") || "")
    if (!authId) return e.json(401, { error: "login_required", message: "请先登录" })
    var storageRequestId = scopedRequestId(authId, requestId)

    var page = String(body.page || "")
    var coll = ensureLlmJobsColl()
    jobRec = findOrCreateJob(coll, storageRequestId, modelName, page)

    var existingStatus = jobRec.getString("status")
    if (existingStatus === "success" || existingStatus === "failed") {
      return e.json(200, {
        ok: existingStatus === "success",
        cached: true, status: existingStatus,
        text: jobRec.getString("result_text"),
        error: jobRec.getString("error_message"),
        model: jobRec.getString("model_name"),
      })
    }

    jobRec.set("status", "running")
    $app.save(jobRec)

    // 安全红线: 输出长度只认服务端 allowlist 的上限, 客户端传入值一律钳制到 [16, cfg.max_tokens],
    // 防止 owner 计费下有人传超大 max_tokens 拉长输出刷创作者额度。
    var maxTokens = Number(body.max_tokens || cfg.max_tokens || 8192)
    if (!maxTokens || maxTokens < 16) maxTokens = 8192
    var capTokens = Number(cfg.max_tokens || 8192)
    if (maxTokens > capTokens) maxTokens = capTokens
    var timeoutS = Number(cfg.timeout_s || 600)
    if (!timeoutS || timeoutS < 600) timeoutS = 600
    var payload = {
      model: String(cfg.rh_model_id || ""),
      messages: messages,
      max_tokens: maxTokens,
      stream: false,
    }
    if (body.tools && body.tools.length) payload.tools = body.tools
    if (body.temperature !== undefined && body.temperature !== null && cfg.supports_temperature === true) {
      payload.temperature = body.temperature
    }

    var res = $http.send({
      url: llmBase + "/v1/chat/completions", method: "POST",
      // X-LLM-Include-Billing 让响应体带 billing.charged_amount (本次平台现金/元), 用于收益看板归属
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "x-rh-llm-app-code": llmAppCode, "X-LLM-Include-Billing": "true" },
      body: JSON.stringify(payload), timeout: timeoutS,
    })
    var rawBody = (res && typeof res.raw === "string") ? res.raw : ""

    if ((res && res.statusCode === 401) || isRhAuthErr(rawBody)) {
      jobRec.set("status", "failed"); jobRec.set("error_message", "rh_login_required"); $app.save(jobRec)
      return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期" })
    }
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      try { $app.logger().error("llm_upstream_http_error status=" + String(res ? res.statusCode : 0) + " body_length=" + String(rawBody.length)) } catch (_) {}
      jobRec.set("status", "failed"); jobRec.set("error_message", "llm_failed"); $app.save(jobRec)
      return e.json(502, { error: "llm_failed", message: "语言模型服务暂时不可用, 请稍后重试" })
    }
    var parsed = null; try { parsed = JSON.parse(rawBody) } catch (_) {}
    if (!parsed || !parsed.choices || !parsed.choices[0]) {
      try { $app.logger().error("llm_upstream_bad_response body_length=" + String(rawBody.length)) } catch (_) {}
      jobRec.set("status", "failed"); jobRec.set("error_message", "llm_bad_response"); $app.save(jobRec)
      return e.json(502, { error: "llm_bad_response", message: "语言模型返回异常, 请稍后重试" })
    }

    var text = (parsed.choices[0].message && parsed.choices[0].message.content) || ""
    var toolCalls = (parsed.choices[0].message && parsed.choices[0].message.tool_calls) || []
    var finishReason = parsed.choices[0].finish_reason || ""
    jobRec.set("status", "success")
    jobRec.set("result_text", text.substring(0, 80000))
    jobRec.set("tool_calls_json", toolCalls.length ? JSON.stringify(toolCalls) : "")
    jobRec.set("finish_reason", String(finishReason || "").substring(0, 32))
    $app.save(jobRec)

    // 上报访客自付 LLM 消耗 (仅已发布 app 生效; billing 来自 X-LLM-Include-Billing 响应)
    try {
      var billing = parsed.billing || {}
      var usage = parsed.usage || {}
      reportLlmIndex({
        rh_request_id: billing.request_id || parsed.id || requestId,
        rh_user_id: String(body.rh_user_id || "") || null,
        model_name: modelName,
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
        total_tokens: usage.total_tokens || 0,
        charged_amount: billing.charged_amount,
        currency: billing.currency || "CNY",
        status: "success",
      })
    } catch (_) {}

    return e.json(200, { ok: true, status: "success", model: modelName, text: text, tool_calls: toolCalls, finish_reason: finishReason, usage: parsed.usage || null })
  } catch (err) {
    var msg = String(err && err.message || err)
    if (jobRec) {
      try { jobRec.set("status", "failed"); jobRec.set("error_message", "llm_error"); $app.save(jobRec) } catch (_) {}
    }
    if (isRhAuthErr(msg)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期" })
    try { $app.logger().error("llm_error: " + msg) } catch (_) {}
    return e.json(500, { error: "llm_error", message: "语言模型请求失败, 请稍后重试" })
  }
})

routerAdd("POST", "/api/llm/poll", function (e) {
  try {
    var body = e.requestInfo().body || {}
    var requestId = String(body.request_id || "").trim()
    if (!requestId) return e.json(400, { error: "request_id_required" })
    if (requestId.length > 120) return e.json(400, { error: "request_id_too_long" })
    var authId = String(e.get("authId") || "")
    if (!authId) return e.json(401, { error: "login_required" })
    var storageRequestId = authId + ":" + requestId

    var rec = null
    try { rec = $app.findFirstRecordByFilter("llm_jobs", "request_id = {:r}", { r: storageRequestId }) } catch (_) {}
    if (!rec) return e.json(200, { ok: false, status: "not_found" })

    var status = rec.getString("status")
    return e.json(200, {
      ok: status === "success",
      status: status,
      text: status === "success" ? rec.getString("result_text") : "",
      tool_calls: status === "success" ? (rec.getString("tool_calls_json") ? JSON.parse(rec.getString("tool_calls_json")) : []) : [],
      finish_reason: status === "success" ? rec.getString("finish_reason") : "",
      error: status === "failed" ? rec.getString("error_message") : "",
      model: rec.getString("model_name"),
    })
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("llm_poll_error: " + msg) } catch (_) {}
    return e.json(500, { error: "poll_error", message: "查询失败, 请稍后重试" })
  }
})
