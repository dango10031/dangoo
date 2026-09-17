/// <reference path="../pb_data/types.d.ts" />
// pb_hooks/indextts2.pb.js — RunningHub AI 应用中转模板
//
// 使用方式 (禁止手动 Read + Write 本模板):
//   调 MCP mcp__rh-pb-hooks__install_ai_app(vibex_app_id, manifest)。
//   它在服务端填占位符 (VIBEX_APP_ID / WEBAPP_ID / SLUG / NODE_INFO_TEMPLATE /
//   SAFE_SCHEMA / BUILD_NODE_INFO_BODY 等, 此处故意不写双花括号: 否则全局替换会把多行
//   映射代码注进本注释行, 头一行被注释吞掉、其余行裸露到顶层引用未定义变量), 写到
//   pb_hooks 目录下的 <slug>.pb.js, PB 自动热重载。manifest 由 nodeInfoList 归一得到(见 rh-app skill)。
//
// 约束:
//   - 每个 routerAdd 内部就地定义 helper，禁止跨文件共享 helper，避免 Goja 并发污染
//   - AI 应用媒体节点写上传响应 fileName，不写标准模型 download_url
//   - /run submit-only，最终结果由 /poll 单次查询推进

onBootstrap(function (e) {
  e.next()
  try {
    var existing = null
    try { existing = $app.findCollectionByNameOrId("aigc_tasks") } catch (_) { existing = null }
    if (existing) {
      try {
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
        addField({ name: "rating", type: "number", min: 0, max: 5 })
        addField({ name: "favorite", type: "bool" })
        addField({ name: "category", type: "text", max: 32 })
        addField({ name: "note", type: "text", max: 1000 })
        addField({ name: "created", type: "autodate", onCreate: true })
        addField({ name: "updated", type: "autodate", onCreate: true, onUpdate: true })
        addField({ name: "consume_money", type: "text", max: 64 })
        addField({ name: "consume_coins", type: "text", max: 64 })
        addField({ name: "task_cost_time", type: "text", max: 64 })
        addField({ name: "third_party_consume_money", type: "text", max: 64 })
        if (changed) $app.save(existing)
      } catch (schemaErr) {
        try { $app.logger().error("aigc_tasks schema upgrade: " + String(schemaErr && schemaErr.message || schemaErr)) } catch (_) {}
      }
    } else {
      var col = new Collection({
        type: "base", name: "aigc_tasks",
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        fields: [
          { name: "task_id", type: "text", required: true, max: 160 },
          { name: "rh_user_id", type: "text", max: 160 },
          { name: "rh_task_id", type: "text", max: 160 },
          { name: "model_name", type: "text", required: true, max: 64 },
          { name: "page", type: "text", max: 64 },
          { name: "prompt", type: "text", max: 5000 },
          { name: "status", type: "text", required: true, max: 32 },
          { name: "result_url", type: "text", max: 2048 },
          { name: "error_message", type: "text", max: 4000 },
          { name: "rating", type: "number", min: 0, max: 5 },
          { name: "favorite", type: "bool" },
          { name: "category", type: "text", max: 32 },
          { name: "note", type: "text", max: 1000 },
          { name: "created", type: "autodate", onCreate: true },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
          { name: "consume_money", type: "text", max: 64 },
          { name: "consume_coins", type: "text", max: 64 },
          { name: "task_cost_time", type: "text", max: 64 },
          { name: "third_party_consume_money", type: "text", max: 64 },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_aigc_tasks_task_id ON aigc_tasks (task_id)"],
      })
      $app.save(col)
      try { $app.logger().info("aigc_tasks created") } catch (_) {}
    }
  } catch (err) {
    try { $app.logger().error("aigc_tasks bootstrap: " + String(err && err.message || err)) } catch (_) {}
  }
})

routerAdd("GET", "/api/aigc/ai-app/indextts2/schema", function (e) {
  // SAFE_SCHEMA 只含前端渲染表单需要的安全字段, 由 install_ai_app 从 manifest 注入。
  // 绝不含 nodeId / fieldName / webappId / RunningHub 端点。
  var SAFE_SCHEMA = {"version": "rh-ai-app.v1", "slug": "indextts2", "model": "ai-app-indextts2", "title": "IndexTTS 2 语音克隆", "intent": "text-to-speech", "fields": [{"key": "node174_select", "label": "情绪模式选择", "type": "select", "required": false, "group": "basic", "defaultValue": "8", "options": [{"label": "input8", "value": "8", "description": "自定义情绪"}, {"label": "input7", "value": "7", "description": "励志演讲"}, {"label": "input6", "value": "6", "description": "情感电台"}, {"label": "input5", "value": "5", "description": "自然谈话"}, {"label": "input4", "value": "4", "description": "直播带货-快"}, {"label": "input3", "value": "3", "description": "直播带货-高"}, {"label": "input2", "value": "2", "description": "正常口播-女"}, {"label": "input1", "value": "1", "description": "正常口播-男"}], "description": "情绪模式选择"}, {"key": "node185_value", "label": "情绪强度调节（0.0-1.6）", "type": "number", "required": false, "group": "advanced", "defaultValue": "0.6000000000000001", "description": "情绪强度调节（0.0-1.6）"}, {"key": "node187_value", "label": "语速调节（每次0.5非必要不动）", "type": "number", "required": false, "group": "basic", "defaultValue": "1.0000000000000002", "description": "语速调节（每次0.5非必要不动）"}, {"key": "referenceAudio", "label": "需要克隆的音频", "type": "audio", "required": false, "group": "basic", "defaultValue": "7f2ec8aa081f73ff74c094fb0521cf22cf386a54fe8a8277a3c60b569830f3ac.mp3", "description": "需要克隆的音频"}, {"key": "referenceAudio2", "label": "自定义情绪参考音频", "type": "audio", "required": false, "group": "basic", "defaultValue": "e8da6bb87f75ef8f23d6b3d9cb1f9fb17d93020580c45d5dad34a480f4b24486.mp3", "description": "自定义情绪参考音频"}, {"key": "text", "label": "文本输入", "type": "textarea", "required": false, "group": "advanced", "defaultValue": "在这个充满无限可能的时代，你的每一个梦想都值得被尊重与追逐。不要害怕前路茫茫，因为最耀眼的风景往往隐藏在人迹罕至之处。", "description": "文本输入"}], "outputs": {"expectedTypes": ["audio"], "render": "audio"}}

  return e.json(200, SAFE_SCHEMA)
})

routerAdd("POST", "/api/aigc/ai-app/indextts2/upload", function (e) {
  function readKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function responseText(res) { return (res && typeof res.raw === "string") ? res.raw : "" }
  function responseJson(res) { var raw = responseText(res); try { return JSON.parse(raw) } catch (_) { return null } }
  function isRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0
      || s.indexOf("APIKEY_INVALID") >= 0
      || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf("user not exist") >= 0
      || s.indexOf('"code":301') >= 0
      || s.indexOf('"errorCode":"806"') >= 0
      || s.indexOf('"errorCode":"412"') >= 0
      || s.indexOf("ApiKey verification error") >= 0
      || s.indexOf("apiKey is required") >= 0
  }
  function base64ToBytes(s) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    var cleaned = String(s || "").replace(/[^A-Za-z0-9+/=]/g, "")
    var out = []
    for (var i = 0; i < cleaned.length; i += 4) {
      var c1 = chars.indexOf(cleaned.charAt(i))
      var c2 = chars.indexOf(cleaned.charAt(i + 1))
      var c3 = chars.indexOf(cleaned.charAt(i + 2))
      var c4 = chars.indexOf(cleaned.charAt(i + 3))
      if (c1 < 0 || c2 < 0) break
      out.push((c1 << 2) | (c2 >> 4))
      if (c3 >= 0) out.push(((c2 & 15) << 4) | (c3 >> 2))
      if (c4 >= 0) out.push(((c3 & 3) << 6) | c4)
    }
    return out
  }
  function extFromMime(mime, fallback) {
    var m = String(mime || "")
    if (m.indexOf("png") >= 0) return "png"
    if (m.indexOf("jpeg") >= 0 || m.indexOf("jpg") >= 0) return "jpg"
    if (m.indexOf("webp") >= 0) return "webp"
    if (m.indexOf("mp4") >= 0) return "mp4"
    if (m.indexOf("mpeg") >= 0 || m.indexOf("mp3") >= 0) return "mp3"
    if (m.indexOf("wav") >= 0) return "wav"
    return fallback || "bin"
  }

  try {
    var key = readKey(e)
    if (!key) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期, 请用右上角按钮重新登录" })

    // fileType 优先取 query (?fileType=video), 再取 multipart 表单字段, 最后 JSON body 兜底。
    // query 是普通 JS 对象, 用 query["fileType"] 取值, 不是 URLSearchParams, 没有 .get()。
    var fileType = ""
    try { var q = e.requestInfo().query || {}; if (q["fileType"]) fileType = String(q["fileType"]) } catch (_) {}

    // 主通道: 浏览器原生 FormData 二进制直传 → Go 侧 $filesystem.fileFromMultipart() 直接拿文件,
    // 完全跳过 JS 侧 base64 解码。Goja(单线程)逐字符解码几十 MB 视频会锁死整个 PB → 502/524,
    // 二进制直传由 Go 处理, 速度远超 JS 循环, 是大文件(视频/音频)的唯一正路。
    var rhFile = null
    var filename = ""
    try {
      try { e.request.parseMultipartForm(64 << 20) } catch (_) {}
      var mf = e.request.multipartForm
      if (mf && mf.file && mf.file["file"] && mf.file["file"].length) {
        var fh = mf.file["file"][0]
        if (!fileType && mf.value && mf.value["fileType"] && mf.value["fileType"].length) {
          fileType = String(mf.value["fileType"][0])
        }
        filename = String((fh && fh.filename) || ("upload-" + new Date().getTime()))
        rhFile = $filesystem.fileFromMultipart(fh)
      }
    } catch (_) { rhFile = null }

    // 兜底通道: 老前端/小图仍可能发 JSON { dataUrl, fileType }(base64 dataURL)。
    // 仅当 multipart 没拿到文件时才走这里, 此时 body 未被消费, requestInfo().body 安全。
    if (!rhFile) {
      var body = {}
      try { body = e.requestInfo().body || {} } catch (_) {}
      if (!fileType && body.fileType) fileType = String(body.fileType)
      var dataUrl = String(body.dataUrl || "")
      var match = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
      if (!match) return e.json(400, { error: "invalid_upload", message: "上传文件格式不正确" })
      var ft0 = String(fileType || "image").toLowerCase()
      filename = String(body.filename || ("upload-" + new Date().getTime() + "." + extFromMime(match[1], ft0 === "image" ? "png" : "bin")))
      var bytes = base64ToBytes(match[2])
      rhFile = $filesystem.fileFromBytes(bytes, filename)
    }

    fileType = String(fileType || "image").toLowerCase()
    if (fileType !== "image" && fileType !== "audio" && fileType !== "video") fileType = "image"

    var form = new FormData()
    form.append("file", rhFile)
    var res = $http.send({
      url: "https://www.runninghub.cn/openapi/v2/media/upload/binary",
      method: "POST",
      headers: { "Authorization": "Bearer " + key },
      body: form,
      timeout: 60,
    })
    var raw = responseText(res)
    if (isRhAuthErr(raw)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期, 请用右上角按钮重新登录" })
    if (!res || res.statusCode < 200 || res.statusCode >= 300) return e.json(502, { error: "rh_upload_failed", message: raw || ("RH HTTP " + (res ? res.statusCode : 0)), fingerprint: String(raw || "rh_upload_failed").substring(0, 80) })
    var parsed = responseJson(res)
    var fileName = parsed && (parsed.fileName || (parsed.data && (parsed.data.fileName || parsed.data.filename)))
    if (!fileName) return e.json(502, { error: "rh_upload_bad_response", message: raw, fingerprint: raw.substring(0, 80) })
    return e.json(200, { ok: true, fileName: String(fileName) })
  } catch (err) {
    var msg = String(err && err.message || err)
    if (isRhAuthErr(msg)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期, 请用右上角按钮重新登录" })
    return e.json(500, { error: "ai_app_upload_error", message: msg, fingerprint: msg.substring(0, 80) })
  }
})

routerAdd("POST", "/api/aigc/ai-app/indextts2/run", function (e) {
  var VIBEX_APP_ID = "app-ca81449e917d4660aa213c5c13d47008"
  var WEBAPP_ID = "2073652333510217729"
  var MODEL = "ai-app-indextts2"
  var NODE_INFO_TEMPLATE = [{"nodeId": "174", "fieldName": "select", "fieldValue": "8"}, {"nodeId": "185", "fieldName": "value", "fieldValue": "0.6000000000000001"}, {"nodeId": "187", "fieldName": "value", "fieldValue": "1.0000000000000002"}, {"nodeId": "82", "fieldName": "audio", "fieldValue": "7f2ec8aa081f73ff74c094fb0521cf22cf386a54fe8a8277a3c60b569830f3ac.mp3"}, {"nodeId": "180", "fieldName": "audio", "fieldValue": "e8da6bb87f75ef8f23d6b3d9cb1f9fb17d93020580c45d5dad34a480f4b24486.mp3"}, {"nodeId": "53", "fieldName": "text", "fieldValue": "在这个充满无限可能的时代，你的每一个梦想都值得被尊重与追逐。不要害怕前路茫茫，因为最耀眼的风景往往隐藏在人迹罕至之处。"}]

  function readKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function responseText(res) { return (res && typeof res.raw === "string") ? res.raw : "" }
  function responseJson(res) { var raw = responseText(res); try { return JSON.parse(raw) } catch (_) { return null } }
  function isRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0
      || s.indexOf("APIKEY_INVALID") >= 0
      || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf("user not exist") >= 0
      || s.indexOf('"code":301') >= 0
      || s.indexOf('"errorCode":"806"') >= 0
      || s.indexOf('"errorCode":"412"') >= 0
      || s.indexOf("ApiKey verification error") >= 0
      || s.indexOf("apiKey is required") >= 0
  }
  // 用户身份 = 服务端 RH API Key(环境变量, owner 计费)的稳定指纹, 与 /history 查询用同一函数。
  function keyFingerprint(k) {
    var s = String(k || "")
    if (!s) return ""
    var h1 = 0x811c9dc5 >>> 0, h2 = 0x1000193 >>> 0
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      h1 = ((h1 ^ c) >>> 0); h1 = (h1 * 16777619) >>> 0
      h2 = ((h2 + c) >>> 0); h2 = (h2 * 2246822519) >>> 0
    }
    function hex8(n) { var x = (n >>> 0).toString(16); while (x.length < 8) x = "0" + x; return x }
    return hex8(h1) + hex8(h2)
  }
  function ensureColl() {
    function upgradeExisting(col) {
      try {
        var changed = false
        function hasField(name) {
          try { return !!col.fields.getByName(name) } catch (_) {}
          try {
            for (var i = 0; i < col.fields.length; i++) {
              if (String(col.fields[i].name) === String(name)) return true
            }
          } catch (_) {}
          return false
        }
        function addField(def) {
          if (hasField(def.name)) return
          try { col.fields.add(new Field(def)); changed = true } catch (_) {}
        }
        addField({ name: "rating", type: "number", min: 0, max: 5 })
        addField({ name: "favorite", type: "bool" })
        addField({ name: "category", type: "text", max: 32 })
        addField({ name: "note", type: "text", max: 1000 })
        addField({ name: "created", type: "autodate", onCreate: true })
        addField({ name: "updated", type: "autodate", onCreate: true, onUpdate: true })
        addField({ name: "consume_money", type: "text", max: 64 })
        addField({ name: "consume_coins", type: "text", max: 64 })
        addField({ name: "task_cost_time", type: "text", max: 64 })
        addField({ name: "third_party_consume_money", type: "text", max: 64 })
        if (changed) $app.save(col)
      } catch (_) {}
      return col
    }
    try { return upgradeExisting($app.findCollectionByNameOrId("aigc_tasks")) } catch (_) {}
    var col = new Collection({
      type: "base", name: "aigc_tasks",
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
        { name: "task_id", type: "text", required: true, max: 160 },
        { name: "rh_user_id", type: "text", max: 160 },
        { name: "rh_task_id", type: "text", max: 160 },
        { name: "model_name", type: "text", required: true, max: 64 },
        { name: "page", type: "text", max: 64 },
        { name: "prompt", type: "text", max: 5000 },
        { name: "status", type: "text", required: true, max: 32 },
        { name: "result_url", type: "text", max: 2048 },
        { name: "error_message", type: "text", max: 4000 },
        { name: "rating", type: "number", min: 0, max: 5 },
        { name: "favorite", type: "bool" },
        { name: "category", type: "text", max: 32 },
        { name: "note", type: "text", max: 1000 },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        { name: "consume_money", type: "text", max: 64 },
        { name: "consume_coins", type: "text", max: 64 },
        { name: "task_cost_time", type: "text", max: 64 },
        { name: "third_party_consume_money", type: "text", max: 64 },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_aigc_tasks_task_id ON aigc_tasks (task_id)"],
    })
    $app.save(col)
    return $app.findCollectionByNameOrId("aigc_tasks")
  }
  function newJobId() { return "rhapp-" + new Date().getTime() + "-" + Math.random().toString(16).slice(2, 10) }
  function cloneNodeInfo() { return JSON.parse(JSON.stringify(NODE_INFO_TEMPLATE || [])) }
  function setNodeValue(nodes, nodeId, fieldName, value) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      if (String(n.nodeId) === String(nodeId) && String(n.fieldName) === String(fieldName)) n.fieldValue = value
    }
  }
  function buildNodeInfoList(body) {
    var nodes = cloneNodeInfo()
    // 字段映射由 install_ai_app 从 manifest 注入(每个字段一条 setNodeValue, 必填项缺失 throw)。
    var __v0 = (body["node174_select"] === undefined || body["node174_select"] === null) ? "8" : body["node174_select"]
    setNodeValue(nodes, "174", "select", (__v0 === undefined || __v0 === null) ? "" : String(__v0))
    var __v1 = (body["node185_value"] === undefined || body["node185_value"] === null) ? "0.6000000000000001" : body["node185_value"]
    setNodeValue(nodes, "185", "value", (__v1 === undefined || __v1 === null) ? "" : String(__v1))
    var __v2 = (body["node187_value"] === undefined || body["node187_value"] === null) ? "1.0000000000000002" : body["node187_value"]
    setNodeValue(nodes, "187", "value", (__v2 === undefined || __v2 === null) ? "" : String(__v2))
    var __v3 = (body["referenceAudio"] === undefined || body["referenceAudio"] === null) ? "7f2ec8aa081f73ff74c094fb0521cf22cf386a54fe8a8277a3c60b569830f3ac.mp3" : body["referenceAudio"]
    setNodeValue(nodes, "82", "audio", (__v3 === undefined || __v3 === null) ? "" : String(__v3))
    var __v4 = (body["referenceAudio2"] === undefined || body["referenceAudio2"] === null) ? "e8da6bb87f75ef8f23d6b3d9cb1f9fb17d93020580c45d5dad34a480f4b24486.mp3" : body["referenceAudio2"]
    setNodeValue(nodes, "180", "audio", (__v4 === undefined || __v4 === null) ? "" : String(__v4))
    var __v5 = (body["text"] === undefined || body["text"] === null) ? "在这个充满无限可能的时代，你的每一个梦想都值得被尊重与追逐。不要害怕前路茫茫，因为最耀眼的风景往往隐藏在人迹罕至之处。" : body["text"]
    setNodeValue(nodes, "53", "text", (__v5 === undefined || __v5 === null) ? "" : String(__v5))
    return nodes
  }
  function promptTipsError(data) {
    try {
      var tipsRaw = data && (data.promptTips || (data.data && data.data.promptTips))
      if (!tipsRaw) return null
      var tips = typeof tipsRaw === "string" ? JSON.parse(tipsRaw) : tipsRaw
      if (tips && tips.node_errors) {
        var s = JSON.stringify(tips.node_errors)
        if (s && s !== "{}") return tips.node_errors
      }
    } catch (_) {}
    return null
  }
  // 上报任务到 VibeX control 收益看板 (self-contained, fail-soft, 绝不抛错/阻断业务)
  function reportTaskIndex(f) {
    try {
      var base = ($os.getenv("VIBEX_CONTROL_URL") || "").replace(/\/+$/, "")
      var appId = (f && f.app_id) || $os.getenv("VIBEX_APP_ID")
      if (!base || !appId || !f || !f.task_id) return
      var headers = { "Content-Type": "application/json" }
      var tok = $os.getenv("VIBEX_TASK_INDEX_TOKEN")
      if (tok) headers.Authorization = "Bearer " + tok
      $http.send({
        url: base + "/api/app-task-index/upsert", method: "POST", headers: headers,
        body: JSON.stringify({
          app_id: appId, snapshot_id: f.snapshot_id || $os.getenv("VIBEX_PUBLISH_SNAPSHOT_ID") || null,
          task_id: String(f.task_id), rh_user_id: f.rh_user_id || null, rh_task_id: f.rh_task_id || null,
          status: f.status || "running", error_message: f.error_message || null,
        }),
        timeout: 5,
      })
    } catch (_) {}
  }

  // RH 并发上限(共享 key 同时只能跑有限个任务): 官方错误码 421 TASK_QUEUE_MAXED,
  // 另一族接口是 1520 Concurrency limit reached。不识别的话会落进通用 502,
  // 前端显示"网络或服务器繁忙"误导用户以为服务挂了(实际是上一个任务还没跑完)。
  function isRhBusyErr(raw) {
    var s = String(raw || "")
    return s.indexOf("TASK_QUEUE_MAXED") >= 0
      || s.indexOf('"code":421') >= 0
      || s.indexOf('"code":1520') >= 0
      || s.indexOf("Concurrency limit reached") >= 0
  }

  try {
    var key = readKey(e)
    if (!key) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期, 请用右上角按钮重新登录" })
    var body = e.requestInfo().body || {}
    var nodeInfoList = buildNodeInfoList(body)
    var payload = { nodeInfoList: nodeInfoList, appCode: "vibex", instanceType: "plus" }
    var res = $http.send({
      url: "https://www.runninghub.cn/openapi/v2/run/ai-app/" + encodeURIComponent(WEBAPP_ID),
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify(payload),
      timeout: 60,
    })
    var raw = responseText(res)
    if (isRhAuthErr(raw)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期, 请用右上角按钮重新登录" })
    if (isRhBusyErr(raw)) return e.json(429, { error: "rh_task_queue_maxed", message: "上一个任务还在生成中, 请等它完成后再试", fingerprint: "rh_task_queue_maxed" })
    if (!res || res.statusCode < 200 || res.statusCode >= 300) return e.json(502, { error: "rh_ai_app_run_http_error", message: raw || ("RH HTTP " + (res ? res.statusCode : 0)), fingerprint: String(raw || "rh_ai_app_run_http_error").substring(0, 80) })
    var parsed = responseJson(res)
    if (!parsed) return e.json(502, { error: "rh_ai_app_run_bad_json", message: raw, fingerprint: raw.substring(0, 80) })
    if (isRhAuthErr(JSON.stringify(parsed))) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期, 请用右上角按钮重新登录" })
    var nodeErrors = promptTipsError(parsed)
    if (nodeErrors) return e.json(400, { ok: false, version: "rh-ai-app.v1", state: "failed", error: { code: "RH_NODE_ERRORS", message: "输入参数未通过 RunningHub 校验", retryable: false, taskId: "", failedNode: nodeErrors } })
    var taskId = parsed && parsed.taskId
    if (!taskId && parsed && parsed.data) taskId = parsed.data.taskId || parsed.data.task_id
    if (!taskId && parsed.taskId) taskId = parsed.taskId
    if (!taskId) return e.json(502, { error: "rh_ai_app_run_bad_response", message: raw, fingerprint: raw.substring(0, 80) })
    var jobId = newJobId()
    try {
      var coll = ensureColl()
      var rec = new Record(coll)
      rec.set("task_id", jobId)
      rec.set("rh_user_id", keyFingerprint(readKey(e)))
      rec.set("rh_task_id", String(taskId))
      rec.set("model_name", MODEL)
      rec.set("page", String(body.page || ""))
      rec.set("prompt", String(body.prompt || "").substring(0, 5000))
      rec.set("status", "running")
      try { rec.set("charge_ref", String(e.get("chargeRef") || "")) } catch (_) {}
      try { rec.set("user_email", String(e.get("authEmail") || "")) } catch (_) {}
      $app.save(rec)
    } catch (_) {}
    reportTaskIndex({ task_id: jobId, rh_task_id: String(taskId), rh_user_id: keyFingerprint(readKey(e)), status: "running" })
    // AI 应用任务被 RH 受理: 结算预扣(held->settled), 计入真实成本; 管理员旁路不动站内余额。
    try {
      var chargeRef = String(e.get("chargeRef") || "")
      var chargeAdmin = !!e.get("chargeAdmin")
      if (chargeRef) {
        var heldTxn = $app.findFirstRecordByFilter("wallet_txns", "ref = {:r} && status = 'held'", { r: chargeRef })
        if (heldTxn) { heldTxn.set("status", "settled"); heldTxn.set("note", String(heldTxn.get("note") || "").replace("预扣", "扣费")); $app.save(heldTxn) }
        if (!chargeAdmin) {
          var em = String(e.get("authEmail") || "").trim().toLowerCase()
          if (em) {
            var wRec = $app.findFirstRecordByFilter("wallets", "user_email = {:em}", { em: em })
            var amt = Number(e.get("chargeAmount") || 0)
            if (wRec && amt > 0) { wRec.set("total_consumed", Math.round(Number(wRec.get("total_consumed") || 0) * 100 + amt * 100) / 100); $app.save(wRec) }
          }
        }
      }
    } catch (settleErr) { try { $app.logger().error("ai-app charge settle: " + String(settleErr && settleErr.message || settleErr)) } catch (_) {} }
    return e.json(200, { ok: true, version: "rh-ai-app.v1", state: "running", job: { jobId: jobId, taskId: String(taskId), state: "running" }, outputs: [], results: [] })
  } catch (err) {
    var msg = String(err && err.message || err)
    if (isRhAuthErr(msg)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期, 请用右上角按钮重新登录" })
    // v11: 前端把提交字段包进 `inputs: {...}` 是最高频的接入错误(见 app-b649b74300f0477b9a9da1f7ea4c1811
    // postmortem —— buildNodeInfoList 只读 body 顶层 key, 包了一层 inputs 必然导致必填项校验失败)。不用
    // 猜字段名, "抛的是必填项缺失 + body.inputs 恰好是个对象"就足以断定是这个模式, 换成可操作的 400 而不是
    // 含糊的 500, 省掉排查者去读这个文件反推真因的那几十秒。
    if (msg.indexOf("缺少必填项") === 0 && typeof body !== "undefined" && body && typeof body.inputs === "object" && body.inputs !== null) {
      return e.json(400, {
        error: "ai_app_run_bad_body_shape",
        message: "提交参数不能包在 inputs 对象里, 必须平铺在请求体顶层(字段名与 GET /schema 返回的 fields[].key 一致)。" + msg,
        fingerprint: "ai_app_run_inputs_wrapper",
      })
    }
    return e.json(500, { error: "ai_app_run_error", message: msg, fingerprint: msg.substring(0, 80) })
  }
})

// 价格预估: AI 应用没有固定单价, 尝试用和 /run 相同的 nodeInfoList 调 RH 的 price-preview
// 端点; RunningHub 官方文档未明确覆盖 AI 应用这条路径, 任何失败(包括路径不存在)都优雅降级成
// { ok: false }, 前端只应隐藏价格徽标、改显示"按 RunningHub 实际扣费", 不阻塞 /run 提交。
routerAdd("POST", "/api/aigc/ai-app/indextts2/price-preview", function (e) {
  var WEBAPP_ID = "2073652333510217729"
  var NODE_INFO_TEMPLATE = [{"nodeId": "174", "fieldName": "select", "fieldValue": "8"}, {"nodeId": "185", "fieldName": "value", "fieldValue": "0.6000000000000001"}, {"nodeId": "187", "fieldName": "value", "fieldValue": "1.0000000000000002"}, {"nodeId": "82", "fieldName": "audio", "fieldValue": "7f2ec8aa081f73ff74c094fb0521cf22cf386a54fe8a8277a3c60b569830f3ac.mp3"}, {"nodeId": "180", "fieldName": "audio", "fieldValue": "e8da6bb87f75ef8f23d6b3d9cb1f9fb17d93020580c45d5dad34a480f4b24486.mp3"}, {"nodeId": "53", "fieldName": "text", "fieldValue": "在这个充满无限可能的时代，你的每一个梦想都值得被尊重与追逐。不要害怕前路茫茫，因为最耀眼的风景往往隐藏在人迹罕至之处。"}]

  function readKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function responseText(res) { return (res && typeof res.raw === "string") ? res.raw : "" }
  function responseJson(res) { var raw = responseText(res); try { return JSON.parse(raw) } catch (_) { return null } }
  function isRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0 || s.indexOf("APIKEY_INVALID") >= 0 || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf("user not exist") >= 0 || s.indexOf('"code":301') >= 0
      || s.indexOf('"errorCode":"806"') >= 0 || s.indexOf('"errorCode":"412"') >= 0
      || s.indexOf("ApiKey verification error") >= 0 || s.indexOf("apiKey is required") >= 0
  }
  function cloneNodeInfo() { return JSON.parse(JSON.stringify(NODE_INFO_TEMPLATE || [])) }
  function setNodeValue(nodes, nodeId, fieldName, value) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i]
      if (String(n.nodeId) === String(nodeId) && String(n.fieldName) === String(fieldName)) n.fieldValue = value
    }
  }
  function buildNodeInfoList(body) {
    var nodes = cloneNodeInfo()
    var __v0 = (body["node174_select"] === undefined || body["node174_select"] === null) ? "8" : body["node174_select"]
    setNodeValue(nodes, "174", "select", (__v0 === undefined || __v0 === null) ? "" : String(__v0))
    var __v1 = (body["node185_value"] === undefined || body["node185_value"] === null) ? "0.6000000000000001" : body["node185_value"]
    setNodeValue(nodes, "185", "value", (__v1 === undefined || __v1 === null) ? "" : String(__v1))
    var __v2 = (body["node187_value"] === undefined || body["node187_value"] === null) ? "1.0000000000000002" : body["node187_value"]
    setNodeValue(nodes, "187", "value", (__v2 === undefined || __v2 === null) ? "" : String(__v2))
    var __v3 = (body["referenceAudio"] === undefined || body["referenceAudio"] === null) ? "7f2ec8aa081f73ff74c094fb0521cf22cf386a54fe8a8277a3c60b569830f3ac.mp3" : body["referenceAudio"]
    setNodeValue(nodes, "82", "audio", (__v3 === undefined || __v3 === null) ? "" : String(__v3))
    var __v4 = (body["referenceAudio2"] === undefined || body["referenceAudio2"] === null) ? "e8da6bb87f75ef8f23d6b3d9cb1f9fb17d93020580c45d5dad34a480f4b24486.mp3" : body["referenceAudio2"]
    setNodeValue(nodes, "180", "audio", (__v4 === undefined || __v4 === null) ? "" : String(__v4))
    var __v5 = (body["text"] === undefined || body["text"] === null) ? "在这个充满无限可能的时代，你的每一个梦想都值得被尊重与追逐。不要害怕前路茫茫，因为最耀眼的风景往往隐藏在人迹罕至之处。" : body["text"]
    setNodeValue(nodes, "53", "text", (__v5 === undefined || __v5 === null) ? "" : String(__v5))
    return nodes
  }

  try {
    var key = readKey(e)
    if (!key) return e.json(200, { ok: false, message: "rh_login_required" })
    var body = e.requestInfo().body || {}
    var nodeInfoList = null
    try { nodeInfoList = buildNodeInfoList(body) } catch (_) { nodeInfoList = null }
    if (!nodeInfoList) return e.json(200, { ok: false, message: "invalid_params" })
    var payload = { nodeInfoList: nodeInfoList, appCode: "vibex", instanceType: "plus" }
    var res = $http.send({
      url: "https://www.runninghub.cn/openapi/v2/price-preview/run/ai-app/" + encodeURIComponent(WEBAPP_ID),
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify(payload),
      timeout: 15,
    })
    var raw = responseText(res)
    if (isRhAuthErr(raw)) return e.json(200, { ok: false, message: "rh_login_required" })
    if (!res || res.statusCode < 200 || res.statusCode >= 300) return e.json(200, { ok: false, message: "price_preview_unavailable" })
    var parsed = responseJson(res)
    if (!parsed || parsed.errorCode) return e.json(200, { ok: false, message: (parsed && parsed.errorMessage) || "price_preview_unavailable" })
    return e.json(200, {
      ok: true,
      estimatedPrice: parsed.estimatedPrice,
      currency: parsed.currency || "CNY",
      priceText: parsed.priceText || "",
      freeLimit: !!parsed.freeLimit,
      isFreeThisCall: !!parsed.isFreeThisCall,
    })
  } catch (err) {
    return e.json(200, { ok: false, message: "price_preview_error" })
  }
})

routerAdd("POST", "/api/aigc/ai-app/indextts2/jobs/{jobId}/poll", function (e) {
  var MODEL = "ai-app-indextts2"

  function readKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function responseText(res) { return (res && typeof res.raw === "string") ? res.raw : "" }
  function responseJson(res) { var raw = responseText(res); try { return JSON.parse(raw) } catch (_) { return null } }
  function isRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0
      || s.indexOf("APIKEY_INVALID") >= 0
      || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf("user not exist") >= 0
      || s.indexOf('"code":301') >= 0
      || s.indexOf('"errorCode":"806"') >= 0
      || s.indexOf('"errorCode":"412"') >= 0
      || s.indexOf("ApiKey verification error") >= 0
      || s.indexOf("apiKey is required") >= 0
  }
  function normalizeOutputUrl(rawUrl) {
    if (!rawUrl) return rawUrl
    var u = String(rawUrl)
    var idx = u.indexOf("myqcloud.com/")
    if (idx >= 0) u = "https://rh-images.xiaoyaoyou.com/" + u.substring(idx + "myqcloud.com/".length)
    var qIdx = u.indexOf("?")
    var path = qIdx >= 0 ? u.substring(0, qIdx) : u
    var query = qIdx >= 0 ? u.substring(qIdx) : ""
    try { path = encodeURI(decodeURI(path)) } catch (_) { path = path.replace(/ /g, "%20") }
    return path + query
  }
  function outputType(item, url) {
    var t = String((item && (item.outputType || item.fileType)) || "").toLowerCase()
    var u = String(url || "").toLowerCase().split("?")[0]
    if (t.indexOf("png") >= 0 || t.indexOf("jpg") >= 0 || t.indexOf("jpeg") >= 0 || t.indexOf("webp") >= 0 || u.match(/\.(png|jpg|jpeg|webp|gif)$/)) return "image"
    if (t.indexOf("mp4") >= 0 || t.indexOf("mov") >= 0 || t.indexOf("webm") >= 0 || u.match(/\.(mp4|mov|webm)$/)) return "video"
    if (t.indexOf("mp3") >= 0 || t.indexOf("wav") >= 0 || t.indexOf("m4a") >= 0 || u.match(/\.(mp3|wav|m4a)$/)) return "audio"
    if (t.indexOf("txt") >= 0 || t.indexOf("text") >= 0 || (item && item.text)) return "text"
    return "file"
  }
  function normalizeOutputs(data, taskId) {
    var arr = data && (data.results || data.data)
    if (!arr || !Array.isArray(arr)) return []
    var out = []
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i]
      var url = item && (item.url || item.fileUrl || item.imageUrl)
      if (!url && typeof item === "string") url = item
      if (!url && item && item.text) {
        out.push({ id: "out-" + i, type: "text", url: "", text: String(item.text), fileType: item.outputType || item.fileType, filename: item.fileName, nodeId: item.nodeId, taskId: taskId })
        continue
      }
      if (!url) continue
      var normalized = normalizeOutputUrl(url)
      out.push({ id: "out-" + i, type: outputType(item, normalized), url: normalized, text: item && item.text, fileType: item && (item.outputType || item.fileType), filename: item && item.fileName, nodeId: item && item.nodeId, taskId: taskId })
    }
    return out
  }
  // 上报任务到 VibeX control 收益看板 (self-contained, fail-soft)
  function reportTaskIndex(f) {
    try {
      var base = ($os.getenv("VIBEX_CONTROL_URL") || "").replace(/\/+$/, "")
      var appId = (f && f.app_id) || $os.getenv("VIBEX_APP_ID")
      if (!base || !appId || !f || !f.task_id) return
      var headers = { "Content-Type": "application/json" }
      var tok = $os.getenv("VIBEX_TASK_INDEX_TOKEN")
      if (tok) headers.Authorization = "Bearer " + tok
      $http.send({
        url: base + "/api/app-task-index/upsert", method: "POST", headers: headers,
        body: JSON.stringify({
          app_id: appId, snapshot_id: f.snapshot_id || $os.getenv("VIBEX_PUBLISH_SNAPSHOT_ID") || null,
          task_id: String(f.task_id), rh_user_id: f.rh_user_id || null, rh_task_id: f.rh_task_id || null,
          status: f.status || "running", error_message: f.error_message || null,
        }),
        timeout: 5,
      })
    } catch (_) {}
  }
  // RH /openapi/v2/query 终态响应里的 usage 是真实扣费明细 (thirdPartyConsumeMoney 通常是实付
  // 金额, consumeMoney/consumeCoins 常为 null)。全部按字符串落库/返回, 避免精度问题。
  function extractUsage(data) {
    var u = (data && data.usage) || {}
    function s(v) { return (v === undefined || v === null) ? null : String(v) }
    return {
      consumeMoney: s(u.consumeMoney),
      consumeCoins: s(u.consumeCoins),
      taskCostTime: s(u.taskCostTime),
      thirdPartyConsumeMoney: s(u.thirdPartyConsumeMoney),
    }
  }

  // 任务终态失败: 按 charge_ref 幂等自动退款 (refund 流水去重; 管理员测试走 refund_admin 冲销)。
  function settleFailure(rec) {
    try {
      var ref = ""
      try { ref = String(rec.getString("charge_ref") || "") } catch (_) { ref = "" }
      if (!ref) return
      var txn = null
      try { txn = $app.findFirstRecordByFilter("wallet_txns", "ref = {:r} && (kind = 'gen' || kind = 'gen_admin')", { r: ref }) } catch (_) { txn = null }
      if (!txn) return
      var kind = String(txn.get("kind") || "")
      var refundRef = "refund:" + ref
      var dup = null
      try { dup = $app.findFirstRecordByFilter("wallet_txns", "ref = {:r} && (kind = 'refund' || kind = 'refund_admin')", { r: refundRef }) } catch (_) { dup = null }
      if (dup) return
      var amt = Math.abs(Number(txn.get("amount") || 0))
      var em = String(txn.get("user_email") || "").trim().toLowerCase()
      if (kind === "gen") {
        var w = null
        try { w = $app.findFirstRecordByFilter("wallets", "user_email = {:em}", { em: em }) } catch (_) { w = null }
        var bal = w ? Number(w.get("balance") || 0) : 0
        if (w) {
          var nb = Math.round((bal + amt) * 100) / 100
          w.set("balance", nb)
          w.set("total_consumed", Math.round(Math.max(0, Number(w.get("total_consumed") || 0) - amt) * 100) / 100)
          $app.save(w); bal = nb
        }
        var t1 = new Record($app.findCollectionByNameOrId("wallet_txns"))
        t1.set("user_email", em); t1.set("kind", "refund"); t1.set("amount", Math.round(amt * 100) / 100)
        t1.set("balance_after", Math.round(bal * 100) / 100); t1.set("ref", refundRef)
        t1.set("model", String(txn.get("model") || "")); t1.set("note", "任务失败自动退款"); t1.set("status", "done")
        $app.save(t1)
      } else {
        var t2 = new Record($app.findCollectionByNameOrId("wallet_txns"))
        t2.set("user_email", em); t2.set("kind", "refund_admin"); t2.set("amount", Math.round(amt * 100) / 100)
        t2.set("balance_after", 0); t2.set("ref", refundRef)
        t2.set("model", String(txn.get("model") || "")); t2.set("note", "任务失败·冲销实扣RH"); t2.set("status", "done")
        $app.save(t2)
      }
    } catch (ferr) { try { $app.logger().error("ai-app settle failure: " + String(ferr && ferr.message || ferr)) } catch (_) {} }
  }

  try {
    var key = readKey(e)
    if (!key) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期, 请用右上角按钮重新登录" })
    var userEmail = String(e.get("authEmail") || "").trim().toLowerCase()
    if (!userEmail) return e.json(401, { error: "login_required", message: "请先登录" })
    var jobId = e.request.pathValue("jobId")
    if (!jobId) return e.json(400, { error: "job_id_required", message: "缺少任务 ID" })
    var rec = null
    try { rec = $app.findFirstRecordByFilter("aigc_tasks", "task_id = {:tid} && user_email = {:email}", { tid: jobId, email: userEmail }) } catch (_) {}
    if (!rec) return e.json(404, { error: "job_not_found", message: "任务不存在或已过期" })
    var taskId = rec.getString("rh_task_id")
    if (!taskId) return e.json(500, { error: "no_rh_task_id", message: "任务缺少 RunningHub taskId", fingerprint: "no_rh_task_id" })
    var res = $http.send({
      url: "https://www.runninghub.cn/openapi/v2/query",
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({ taskId: taskId }),
      timeout: 30,
    })
    var raw = responseText(res)
    if (isRhAuthErr(raw)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期, 请用右上角按钮重新登录" })
    if (!res || res.statusCode >= 500) return e.json(200, { ok: true, version: "rh-ai-app.v1", state: "running", job: { jobId: jobId, taskId: taskId, state: "running" }, outputs: [], results: [] })
    var data = responseJson(res)
    if (!data) return e.json(200, { ok: true, version: "rh-ai-app.v1", state: "running", job: { jobId: jobId, taskId: taskId, state: "running" }, outputs: [], results: [] })
    if (isRhAuthErr(JSON.stringify(data))) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期, 请用右上角按钮重新登录" })
    var status = String(data && data.status || "").toUpperCase()
    var usage = extractUsage(data)
    if (status === "SUCCESS") {
      var outputs = normalizeOutputs(data, taskId)
      try {
        rec.set("status", "success"); if (outputs[0] && outputs[0].url) rec.set("result_url", outputs[0].url.substring(0, 2048))
        rec.set("consume_money", usage.consumeMoney || ""); rec.set("consume_coins", usage.consumeCoins || "")
        rec.set("task_cost_time", usage.taskCostTime || ""); rec.set("third_party_consume_money", usage.thirdPartyConsumeMoney || "")
        $app.save(rec)
      } catch (_) {}
      reportTaskIndex({ task_id: jobId, rh_task_id: taskId, rh_user_id: rec.getString("rh_user_id"), status: "success" })
      return e.json(200, { ok: true, version: "rh-ai-app.v1", state: "succeeded", job: { jobId: jobId, taskId: taskId, state: "succeeded" }, outputs: outputs, results: outputs, usage: usage })
    }
    if (status === "QUEUED" || status === "RUNNING" || status === "CREATE" || status === "PROCESSING" || !status) {
      var state = status === "QUEUED" ? "queued" : "running"
      return e.json(200, { ok: true, version: "rh-ai-app.v1", state: state, job: { jobId: jobId, taskId: taskId, state: state }, outputs: [], results: [] })
    }
    if (status === "FAILED" || status === "CANCEL") {
      var reason = data && data.failedReason
      var msg = data && data.errorMessage || reason && (reason.exception_message || reason.exceptionMessage || reason.node_name) || "RunningHub 任务失败"
      try {
        rec.set("status", "failed"); rec.set("error_message", String(msg).substring(0, 4000))
        rec.set("consume_money", usage.consumeMoney || ""); rec.set("consume_coins", usage.consumeCoins || "")
        rec.set("task_cost_time", usage.taskCostTime || ""); rec.set("third_party_consume_money", usage.thirdPartyConsumeMoney || "")
        $app.save(rec)
      } catch (_) {}
      reportTaskIndex({ task_id: jobId, rh_task_id: taskId, rh_user_id: rec.getString("rh_user_id"), status: "failed", error_message: String(msg) })
      settleFailure(rec)
      return e.json(200, { ok: false, version: "rh-ai-app.v1", state: "failed", job: { jobId: jobId, taskId: taskId, state: "failed" }, outputs: [], results: [], error: { code: data && data.errorCode || "RH_AI_APP_FAILED", message: String(msg), retryable: false, taskId: taskId, failedNode: reason || null }, usage: usage })
    }
    return e.json(200, { ok: true, version: "rh-ai-app.v1", state: "running", job: { jobId: jobId, taskId: taskId, state: "running" }, outputs: [], results: [], raw: data })
  } catch (err) {
    var msg = String(err && err.message || err)
    if (isRhAuthErr(msg)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期, 请用右上角按钮重新登录" })
    try { $app.logger().error("ai_app_poll_transient: " + msg) } catch (_) {}
    return e.json(200, { ok: true, version: "rh-ai-app.v1", state: "running", outputs: [], results: [] })
  }
})

routerAdd("POST", "/api/aigc/ai-app/indextts2/history", function (e) {
  var MODEL = "ai-app-indextts2"

  function readKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  // 用户身份 = API Key 的稳定指纹, 必须和 /run 写入时用的同一个函数, 否则查不到自己的历史。
  function keyFingerprint(k) {
    var s = String(k || "")
    if (!s) return ""
    var h1 = 0x811c9dc5 >>> 0, h2 = 0x1000193 >>> 0
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      h1 = ((h1 ^ c) >>> 0); h1 = (h1 * 16777619) >>> 0
      h2 = ((h2 + c) >>> 0); h2 = (h2 * 2246822519) >>> 0
    }
    function hex8(n) { var x = (n >>> 0).toString(16); while (x.length < 8) x = "0" + x; return x }
    return hex8(h1) + hex8(h2)
  }
  function safeString(r, name) { try { return r.getString(name) } catch (_) { return "" } }
  function safeBool(r, name) { try { return !!r.getBool(name) } catch (_) { return false } }
  function safeNumber(r, name) { try { return Number(r.get(name) || 0) || 0 } catch (_) { return 0 } }
  function isRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0
      || s.indexOf("APIKEY_INVALID") >= 0
      || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf("user not exist") >= 0
      || s.indexOf('"code":301') >= 0
      || s.indexOf('"errorCode":"806"') >= 0
      || s.indexOf('"errorCode":"412"') >= 0
      || s.indexOf("ApiKey verification error") >= 0
      || s.indexOf("apiKey is required") >= 0
  }
  function normalizeOutputUrl(rawUrl) {
    if (!rawUrl) return rawUrl
    var u = String(rawUrl)
    var idx = u.indexOf("myqcloud.com/")
    if (idx >= 0) u = "https://rh-images.xiaoyaoyou.com/" + u.substring(idx + "myqcloud.com/".length)
    var qIdx = u.indexOf("?")
    var path = qIdx >= 0 ? u.substring(0, qIdx) : u
    var query = qIdx >= 0 ? u.substring(qIdx) : ""
    try { path = encodeURI(decodeURI(path)) } catch (_) { path = path.replace(/ /g, "%20") }
    return path + query
  }
  function extractUsage(data) {
    var u = (data && data.usage) || {}
    function s(v) { return (v === undefined || v === null) ? null : String(v) }
    return {
      consumeMoney: s(u.consumeMoney),
      consumeCoins: s(u.consumeCoins),
      taskCostTime: s(u.taskCostTime),
      thirdPartyConsumeMoney: s(u.thirdPartyConsumeMoney),
    }
  }
  // 上报任务到 VibeX control 收益看板 (self-contained, fail-soft), 与 /run、/poll 路由行为一致。
  function reportTaskIndex(f) {
    try {
      var base = ($os.getenv("VIBEX_CONTROL_URL") || "").replace(/\/+$/, "")
      var appId = (f && f.app_id) || $os.getenv("VIBEX_APP_ID")
      if (!base || !appId || !f || !f.task_id) return
      var headers = { "Content-Type": "application/json" }
      var tok = $os.getenv("VIBEX_TASK_INDEX_TOKEN")
      if (tok) headers.Authorization = "Bearer " + tok
      $http.send({
        url: base + "/api/app-task-index/upsert", method: "POST", headers: headers,
        body: JSON.stringify({
          app_id: appId, snapshot_id: f.snapshot_id || $os.getenv("VIBEX_PUBLISH_SNAPSHOT_ID") || null,
          task_id: String(f.task_id), rh_user_id: f.rh_user_id || null, rh_task_id: f.rh_task_id || null,
          status: f.status || "running", error_message: f.error_message || null,
        }),
        timeout: 5,
      })
    } catch (_) {}
  }
  // 懒对账: 关页/刷新期间没有浏览器在 poll 时, /jobs/{jobId}/poll (唯一写终态的地方) 就没人调用,
  // aigc_tasks 记录会永远停在 running —— 哪怕 RH 那边任务早就跑完了。这里在用户自己打开历史列表时,
  // 用他自己请求带的 key 顺带把 stale running 记录的真实终态补上, 逻辑跟 /jobs/{jobId}/poll 完全一致
  // (成功查usage/结果URL, 失败查errorMessage), 避免记录变成永远转圈的幽灵。
  // 只处理本页 status=="running" 且 updated 超过 30s 的记录, 最多 3 条 (串行请求 RH), 防止一页里
  // 混进很多 stale 记录时拖慢 /history 响应 —— 没处理到的等下次打开历史 (或 resumeAiAppJob) 再对账。
  // RH /query 对已被清理/过期的任务不会返回 status=FAILED, 而是返回错误文案 (无 status 字段)。
  // 这类记录必须写成 failed, 否则永远卡 running —— 恰恰是"隔天才回来看历史"这种最需要对账的场景。
  // 只认明确的 not-found/expired 标记, 瞬时错误 (限流/5xx 文案) 不能误判成终态。
  function isRhTaskGone(raw) {
    var s = String(raw || "").toLowerCase()
    return s.indexOf("task not found") >= 0 || s.indexOf("task not exist") >= 0
      || s.indexOf("task_not_found") >= 0 || s.indexOf("task_not_exist") >= 0
      || s.indexOf("任务不存在") >= 0 || s.indexOf("已过期") >= 0 || s.indexOf("task expired") >= 0
  }
  // 任务终态失败: 按 charge_ref 幂等自动退款 (refund 流水去重; 管理员测试走 refund_admin 冲销)。
  function settleFailure(rec) {
    try {
      var ref = ""
      try { ref = String(rec.getString("charge_ref") || "") } catch (_) { ref = "" }
      if (!ref) return
      var txn = null
      try { txn = $app.findFirstRecordByFilter("wallet_txns", "ref = {:r} && (kind = 'gen' || kind = 'gen_admin')", { r: ref }) } catch (_) { txn = null }
      if (!txn) return
      var kind = String(txn.get("kind") || "")
      var refundRef = "refund:" + ref
      var dup = null
      try { dup = $app.findFirstRecordByFilter("wallet_txns", "ref = {:r} && (kind = 'refund' || kind = 'refund_admin')", { r: refundRef }) } catch (_) { dup = null }
      if (dup) return
      var amt = Math.abs(Number(txn.get("amount") || 0))
      var em = String(txn.get("user_email") || "").trim().toLowerCase()
      if (kind === "gen") {
        var w = null
        try { w = $app.findFirstRecordByFilter("wallets", "user_email = {:em}", { em: em }) } catch (_) { w = null }
        var bal = w ? Number(w.get("balance") || 0) : 0
        if (w) {
          var nb = Math.round((bal + amt) * 100) / 100
          w.set("balance", nb)
          w.set("total_consumed", Math.round(Math.max(0, Number(w.get("total_consumed") || 0) - amt) * 100) / 100)
          $app.save(w); bal = nb
        }
        var t1 = new Record($app.findCollectionByNameOrId("wallet_txns"))
        t1.set("user_email", em); t1.set("kind", "refund"); t1.set("amount", Math.round(amt * 100) / 100)
        t1.set("balance_after", Math.round(bal * 100) / 100); t1.set("ref", refundRef)
        t1.set("model", String(txn.get("model") || "")); t1.set("note", "任务失败自动退款"); t1.set("status", "done")
        $app.save(t1)
      } else {
        var t2 = new Record($app.findCollectionByNameOrId("wallet_txns"))
        t2.set("user_email", em); t2.set("kind", "refund_admin"); t2.set("amount", Math.round(amt * 100) / 100)
        t2.set("balance_after", 0); t2.set("ref", refundRef)
        t2.set("model", String(txn.get("model") || "")); t2.set("note", "任务失败·冲销实扣RH"); t2.set("status", "done")
        $app.save(t2)
      }
    } catch (ferr) { try { $app.logger().error("ai-app settle failure: " + String(ferr && ferr.message || ferr)) } catch (_) {} }
  }

  function reconcileStaleRunning(records, key) {
    if (!key) return
    var handled = 0
    for (var i = 0; i < records.length && handled < 3; i++) {
      var rec = records[i]
      try {
        if (rec.getString("status") !== "running") continue
        var rhTaskId = rec.getString("rh_task_id")
        if (!rhTaskId) continue
        // PB autodate 字符串是 "2006-01-02 15:04:05.000Z" (空格分隔, 非 ISO); Goja 的 Date 不保证
        // 能解析这种格式, 必须先归一化成 ISO。解析失败按 stale 处理 (fail-open, 最坏多查一次 RH),
        // 绝不能按"跳过"处理 —— 否则解析一旦失败, 懒对账整体静默失效。
        var updatedMs = NaN
        try { updatedMs = new Date(String(rec.getString("updated") || "").replace(" ", "T")).getTime() } catch (_) {}
        if (!isNaN(updatedMs) && Date.now() - updatedMs < 30000) continue
        handled++

        var res = $http.send({
          url: "https://www.runninghub.cn/openapi/v2/query", method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: rhTaskId }), timeout: 15,
        })
        var rawBody = (res && typeof res.raw === "string") ? res.raw : ""
        if (isRhAuthErr(rawBody)) continue // 登录态过期留给用户主动操作时再报 412, 这里不动记录
        if (!res || res.statusCode < 200 || res.statusCode >= 300) continue
        var data = null; try { data = JSON.parse(rawBody) } catch (_) {}
        if (!data) continue

        var taskStatus = String(data.status || "RUNNING").toUpperCase()
        if (taskStatus !== "SUCCESS" && taskStatus !== "FAILED" && taskStatus !== "CANCEL") {
          // RH 端任务已不存在/过期 → 写 failed 终态, 不再让它永远转圈
          if (!data.status && isRhTaskGone(rawBody)) {
            var goneMsg = String(data.errorMessage || data.msg || data.message || "任务不存在或已过期").substring(0, 4000)
            rec.set("status", "failed")
            rec.set("error_message", goneMsg)
            $app.save(rec)
            reportTaskIndex({ task_id: rec.getString("task_id"), rh_task_id: rhTaskId, rh_user_id: rec.getString("rh_user_id"), status: "failed", error_message: goneMsg })
            settleFailure(rec)
          }
          continue
        }
        var usage = extractUsage(data)
        if (taskStatus === "SUCCESS") {
          var arr = (data.results || data.data) || []
          var outUrl = ""
          var hasText = false
          for (var j = 0; j < arr.length; j++) {
            var it = arr[j]
            var u = (it && (it.url || it.fileUrl || it.imageUrl)) || ""
            if (!u && typeof it === "string") u = it
            if (u) { outUrl = normalizeOutputUrl(u); break }
            if (it && it.text) hasText = true
          }
          if (!outUrl && !hasText) continue
          rec.set("status", "success"); if (outUrl) rec.set("result_url", outUrl.substring(0, 2048))
          rec.set("consume_money", usage.consumeMoney || ""); rec.set("consume_coins", usage.consumeCoins || "")
          rec.set("task_cost_time", usage.taskCostTime || ""); rec.set("third_party_consume_money", usage.thirdPartyConsumeMoney || "")
          $app.save(rec)
          reportTaskIndex({ task_id: rec.getString("task_id"), rh_task_id: rhTaskId, rh_user_id: rec.getString("rh_user_id"), status: "success" })
        } else {
          var reason = data.failedReason
          var errMsg = String(data.errorMessage || (reason && (reason.exception_message || reason.exceptionMessage || reason.node_name)) || data.errorCode || "RunningHub 任务失败")
          rec.set("status", "failed"); rec.set("error_message", errMsg.substring(0, 4000))
          rec.set("consume_money", usage.consumeMoney || ""); rec.set("consume_coins", usage.consumeCoins || "")
          rec.set("task_cost_time", usage.taskCostTime || ""); rec.set("third_party_consume_money", usage.thirdPartyConsumeMoney || "")
          $app.save(rec)
          reportTaskIndex({ task_id: rec.getString("task_id"), rh_task_id: rhTaskId, rh_user_id: rec.getString("rh_user_id"), status: "failed", error_message: errMsg })
          settleFailure(rec)
        }
      } catch (_) { /* 单条对账失败不影响其它记录 / 主流程, 保持 running 下次再试 */ }
    }
  }

  try {
    var userId = keyFingerprint(readKey(e))
    if (!userId) return e.json(200, { ok: true, items: [], page: 1, perPage: 0 })
    var userEmail = String(e.get("authEmail") || "").trim().toLowerCase()
    if (!userEmail) return e.json(401, { error: "login_required", message: "请先登录" })

    // POST + 走 callAigc/callAiApp(服务端代理注入 RH API Key/用户标识); 不要前端裸 fetch /api/aigc(发布扫描会拦)。
    // page / perPage 从 body 取, query 仅作兜底。
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    var query = {}
    try { query = e.requestInfo().query || {} } catch (_) {}
    var page = parseInt(String(body.page || query.page || "1"), 10); if (!page || page < 1) page = 1
    var perPage = parseInt(String(body.perPage || query.perPage || "20"), 10); if (!perPage || perPage < 1) perPage = 20
    if (perPage > 100) perPage = 100

    var filters = ["rh_user_id = {:uid}", "user_email = {:email}", "model_name = {:m}"]
    var params = { uid: userId, email: userEmail, m: MODEL }
    if (body.favorite === true || body.favorite === "true") filters.push("favorite = true")
    if (body.status) { filters.push("status = {:status}"); params.status = String(body.status) }
    if (body.category) { filters.push("category = {:category}"); params.category = String(body.category).substring(0, 32) }
    var minRating = parseInt(String(body.minRating || "0"), 10)
    if (minRating > 0) { filters.push("rating >= {:minRating}"); params.minRating = minRating }
    var sort = "-created"
    if (body.sort === "oldest") sort = "created"
    if (body.sort === "rating") sort = "-rating,-created"
    if (body.sort === "favorite") sort = "-favorite,-created"

    var records = []
    try {
      records = $app.findRecordsByFilter(
        "aigc_tasks",
        filters.join(" && "),
        sort,
        perPage,
        (page - 1) * perPage,
        params
      ) || []
    } catch (_) { records = [] }

    reconcileStaleRunning(records, readKey(e))

    var items = []
    for (var i = 0; i < records.length; i++) {
      var r = records[i]
      items.push({
        jobId: r.getString("task_id"),
        taskId: r.getString("rh_task_id"),
        status: r.getString("status"),
        page: r.getString("page"),
        prompt: r.getString("prompt"),
        resultUrl: r.getString("result_url"),
        errorMessage: r.getString("error_message"),
        rating: safeNumber(r, "rating"),
        favorite: safeBool(r, "favorite"),
        category: safeString(r, "category"),
        note: safeString(r, "note"),
        created: r.getString("created"),
        updated: r.getString("updated"),
        consumeMoney: safeString(r, "consume_money"),
        consumeCoins: safeString(r, "consume_coins"),
        taskCostTime: safeString(r, "task_cost_time"),
        thirdPartyConsumeMoney: safeString(r, "third_party_consume_money"),
      })
    }
    return e.json(200, { ok: true, items: items, page: page, perPage: perPage })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "ai_app_history_error", message: msg, fingerprint: msg.substring(0, 80) })
  }
})

routerAdd("POST", "/api/aigc/ai-app/indextts2/history/{jobId}/update", function (e) {
  var MODEL = "ai-app-indextts2"

  function readKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function keyFingerprint(k) {
    var s = String(k || "")
    if (!s) return ""
    var h1 = 0x811c9dc5 >>> 0, h2 = 0x1000193 >>> 0
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      h1 = ((h1 ^ c) >>> 0); h1 = (h1 * 16777619) >>> 0
      h2 = ((h2 + c) >>> 0); h2 = (h2 * 2246822519) >>> 0
    }
    function hex8(n) { var x = (n >>> 0).toString(16); while (x.length < 8) x = "0" + x; return x }
    return hex8(h1) + hex8(h2)
  }
  function safeString(r, name) { try { return r.getString(name) } catch (_) { return "" } }
  function safeBool(r, name) { try { return !!r.getBool(name) } catch (_) { return false } }
  function safeNumber(r, name) { try { return Number(r.get(name) || 0) || 0 } catch (_) { return 0 } }

  try {
    var userId = keyFingerprint(readKey(e))
    if (!userId) return e.json(412, { error: "rh_login_required", message: "请用右上角按钮登录 RunningHub" })
    var userEmail = String(e.get("authEmail") || "").trim().toLowerCase()
    if (!userEmail) return e.json(401, { error: "login_required", message: "请先登录" })
    var jobId = e.request.pathValue("jobId")
    var rec = null
    try { rec = $app.findFirstRecordByFilter("aigc_tasks", "task_id = {:tid} && rh_user_id = {:uid} && user_email = {:email} && model_name = {:m}", { tid: jobId, uid: userId, email: userEmail, m: MODEL }) } catch (_) {}
    if (!rec) return e.json(404, { error: "history_not_found", message: "记录不存在或已删除" })

    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    if (body.rating !== undefined) {
      var rating = Number(body.rating || 0)
      if (rating < 0 || rating > 5 || Math.floor(rating) !== rating) return e.json(400, { error: "invalid_rating", message: "评分必须是 1-5, 或 0 表示清空" })
      rec.set("rating", rating)
    }
    if (body.favorite !== undefined) rec.set("favorite", !!body.favorite)
    if (body.category !== undefined) rec.set("category", String(body.category || "").substring(0, 32))
    if (body.note !== undefined) rec.set("note", String(body.note || "").substring(0, 1000))
    $app.save(rec)
    return e.json(200, {
      ok: true,
      item: {
        jobId: rec.getString("task_id"), taskId: rec.getString("rh_task_id"), status: rec.getString("status"),
        page: rec.getString("page"), prompt: rec.getString("prompt"), resultUrl: rec.getString("result_url"),
        errorMessage: rec.getString("error_message"), rating: safeNumber(rec, "rating"), favorite: safeBool(rec, "favorite"),
        category: safeString(rec, "category"), note: safeString(rec, "note"), created: rec.getString("created"), updated: rec.getString("updated"),
        consumeMoney: safeString(rec, "consume_money"), consumeCoins: safeString(rec, "consume_coins"),
        taskCostTime: safeString(rec, "task_cost_time"), thirdPartyConsumeMoney: safeString(rec, "third_party_consume_money"),
      },
    })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "ai_app_history_update_error", message: msg, fingerprint: msg.substring(0, 80) })
  }
})

routerAdd("POST", "/api/aigc/ai-app/indextts2/history/{jobId}/delete", function (e) {
  var MODEL = "ai-app-indextts2"

  function readKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function keyFingerprint(k) {
    var s = String(k || "")
    if (!s) return ""
    var h1 = 0x811c9dc5 >>> 0, h2 = 0x1000193 >>> 0
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      h1 = ((h1 ^ c) >>> 0); h1 = (h1 * 16777619) >>> 0
      h2 = ((h2 + c) >>> 0); h2 = (h2 * 2246822519) >>> 0
    }
    function hex8(n) { var x = (n >>> 0).toString(16); while (x.length < 8) x = "0" + x; return x }
    return hex8(h1) + hex8(h2)
  }

  try {
    var userId = keyFingerprint(readKey(e))
    if (!userId) return e.json(412, { error: "rh_login_required", message: "请用右上角按钮登录 RunningHub" })
    var userEmail = String(e.get("authEmail") || "").trim().toLowerCase()
    if (!userEmail) return e.json(401, { error: "login_required", message: "请先登录" })
    var jobId = e.request.pathValue("jobId")
    var rec = null
    try { rec = $app.findFirstRecordByFilter("aigc_tasks", "task_id = {:tid} && rh_user_id = {:uid} && user_email = {:email} && model_name = {:m}", { tid: jobId, uid: userId, email: userEmail, m: MODEL }) } catch (_) {}
    if (!rec) return e.json(404, { error: "history_not_found", message: "记录不存在或已删除" })
    $app.delete(rec)
    return e.json(200, { ok: true, deleted: true, jobId: jobId })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "ai_app_history_delete_error", message: msg, fingerprint: msg.substring(0, 80) })
  }
})
