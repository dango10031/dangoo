/// <reference path="../pb_data/types.d.ts" />
// pb_hooks/media.pb.js — 画布媒体文件持久化存储 + RH 临时链接换取 (self-contained)
//
// 背景: RH media/upload 返回的 COS 签名链接 24 小时过期, 隔天画布全部裂图。
// 本路由把文件落到应用自己的存储(永久链接, 公开读), 前端展示用永久地址;
// 提交 AI 任务时经 /api/media/rh-url 用永久链接换取 RH 临时上传链接。

onBootstrap(function (e) {
  e.next()
  try {
    var existing = null
    try { existing = $app.findCollectionByNameOrId("media_files") } catch (_) { existing = null }
    if (existing) {
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
      if (!hasField("user_email")) {
        try { existing.fields.add(new Field({ name: "user_email", type: "text", max: 200 })); changed = true } catch (_) {}
      }
      if (String(existing.listRule) !== "null" && existing.listRule !== null) {
        try { existing.set("listRule", null); changed = true } catch (_) {}
      }
      // viewRule 必须同样为 null(公开): 文件下载 /api/files 按此规则鉴权, <img>/<video>
      // 标签带不上登录头。空字符串 "" 在 PB 语义里=要求已认证, 会让刷新后的永久链接全部 403 裂图。
      if (String(existing.viewRule) !== "null" && existing.viewRule !== null) {
        try { existing.set("viewRule", null); changed = true } catch (_) {}
      }
      if (changed) {
        $app.save(existing)
        try { $app.logger().info("media_files collection upgraded") } catch (_) {}
      }
    } else {
      var col = new Collection({
        type: "base",
        name: "media_files",
        // 公开读: 画布缩略图/结果图免登录直接加载; 写走自定义路由(经平台代理鉴权)
        listRule: null,
        viewRule: null,
        createRule: null,
        updateRule: null,
        deleteRule: null,
        fields: [
          { name: "file", type: "file", required: true, maxSelect: 1 },
          { name: "media_type", type: "text", max: 20 },
          { name: "user_email", type: "text", max: 200 },
          { name: "created", type: "autodate", onCreate: true },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        ],
      })
      $app.save(col)
      try { $app.logger().info("media_files collection created") } catch (_) {}
    }
  } catch (err) {
    try { $app.logger().error("media_files bootstrap: " + String(err && err.message || err)) } catch (_) {}
  }
})

// POST /api/media/persist  multipart: file=二进制, fileType=image/video/audio
// 返回 { ok, url, mediaType } — url 为本应用存储下的永久公开链接
routerAdd("POST", "/api/media/persist", function (e) {
  function resp(code, obj) { return e.json(code, obj) }
  try {
    var fh = null
    var fileType = "image"
    try {
      try { e.request.parseMultipartForm(64 << 20) } catch (_) {}
      var mf = e.request.multipartForm
      if (mf && mf.value && mf.value["fileType"] && mf.value["fileType"].length) fileType = String(mf.value["fileType"][0] || "image")
      if (mf && mf.file && mf.file["file"] && mf.file["file"].length) {
        fh = mf.file["file"][0]
      }
    } catch (_) { fh = null }
    if (!fh) return resp(400, { error: "invalid_upload", message: "请使用 multipart/form-data 上传 file 字段", fingerprint: "no_file" })
    fileType = String(fileType || "image").toLowerCase()
    if (["image", "audio", "video", "zip"].indexOf(fileType) < 0) fileType = "image"

    var coll
    try { coll = $app.findCollectionByNameOrId("media_files") } catch (err) {
      return resp(500, { error: "media_coll_missing", message: "媒体存储未就绪, 请稍后重试", fingerprint: "no_coll" })
    }

    // 文件名: 去掉中文/空格等非 ascii 安全字符, 保留扩展名, 前缀加随机段防冲突
    var rawName = ""
    try { rawName = String(fh.filename || fh.name || "upload.bin") } catch (_) { rawName = "upload.bin" }
    var ext = ""
    var dot = rawName.lastIndexOf(".")
    if (dot >= 0) ext = rawName.substring(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 10)

    // 安全红线: 扩展名白名单 + 大小上限。文件与应用同域、viewRule 公开读,
    // 若放行 .html/.svg(可内嵌 <script>), 别人点开链接即在本域执行脚本、窃取登录态(存储型 XSS)。
    // 因此只收图片/视频/音频/压缩包的安全格式, svg/html/htm/js/mhtml/xml 等一律拒绝。
    var ALLOWED_EXT = {
      image: { jpg: 1, jpeg: 1, png: 1, webp: 1, gif: 1, bmp: 1, avif: 1, heic: 1, heif: 1, tif: 1, tiff: 1 },
      video: { mp4: 1, webm: 1, mov: 1, m4v: 1, mkv: 1 },
      audio: { mp3: 1, wav: 1, m4a: 1, aac: 1, ogg: 1, flac: 1 },
      zip: { zip: 1 },
    }
    var MAX_BYTES_BY_TYPE = { image: 20 * 1024 * 1024, video: 100 * 1024 * 1024, audio: 30 * 1024 * 1024, zip: 64 * 1024 * 1024 }
    var extAllowed = ALLOWED_EXT[fileType]
    if (!extAllowed || !extAllowed[ext]) {
      return resp(400, { error: "file_type_not_allowed", message: "不支持的文件类型, 请上传图片/视频/音频文件", fingerprint: "ext_" + fileType })
    }
    try {
      var fsize = 0
      try { fsize = Number(fh.size || (fh.header && fh.header.ContentLength) || 0) || 0 } catch (_) { fsize = 0 }
      var sizeCap = MAX_BYTES_BY_TYPE[fileType] || 0
      if (fsize > 0 && sizeCap > 0 && fsize > sizeCap) {
        return resp(413, { error: "file_too_large", message: "文件过大, 已超过大小上限", fingerprint: "size_" + fileType })
      }
    } catch (_) {}

    var safe = "mf_" + Math.random().toString(36).slice(2, 10) + new Date().getTime().toString(36) + (ext ? "." + ext : "")

    var rec = new Record(coll)
    var f = $filesystem.fileFromMultipart(fh)
    rec.set("file", f, safe)
    rec.set("media_type", fileType)
    try { rec.set("user_email", String(e.get("authEmail") || "").trim().toLowerCase()) } catch (_) {}
    $app.save(rec)

    var fileName = rec.get("file")
    var url = "/api/files/media_files/" + rec.id + "/" + fileName
    return resp(200, { ok: true, url: url, mediaType: fileType })
  } catch (err) {
    var msg = String(err && err.message || err)
    return resp(500, { error: "media_persist_failed", message: "文件保存失败, 请稍后重试" })
  }
})

// POST /api/media/rh-url  JSON: { url }
// 永久链接(本应用 /api/files/...) -> 转发给 RH 换取 24h 临时上传链接;
// 已经是 RH/COS 临时链接的原样透传(老数据或直接传入的场景)。
routerAdd("POST", "/api/media/rh-url", function (e) {
  function localForwardRhHeaders(ev, base) {
    var out = {}
    for (var k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k] }
    try {
      var h = ev.requestInfo().headers || {}
      function pick(a, b, c) { return h[a] || h[b] || h[c] || "" }
      var app = pick("x_rh_vibex_app", "X-RH-Vibex-App", "x-rh-vibex-app")
      var tkt = pick("x_rh_vibex_ticket", "X-RH-Vibex-Ticket", "x-rh-vibex-ticket")
      var sig = pick("x_rh_vibex_sign", "X-RH-Vibex-Sign", "x-rh-vibex-sign")
      if (app) out["X-RH-Vibex-App"] = String(app)
      if (tkt) out["X-RH-Vibex-Ticket"] = String(tkt)
      if (sig) out["X-RH-Vibex-Sign"] = String(sig)
    } catch (_) {}
    return out
  }
  function localReadKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function localIsRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0 || s.indexOf("APIKEY_INVALID") >= 0 || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf("user not exist") >= 0 || s.indexOf('"code":301') >= 0
      || s.indexOf('"errorCode":"806"') >= 0 || s.indexOf('"errorCode":"412"') >= 0
  }
  function localResponseText(res) { return (res && typeof res.raw === "string") ? res.raw : "" }
  function localResponseJson(res) { var raw = localResponseText(res); try { return JSON.parse(raw) } catch (_) { return null } }
  try {
    var key = localReadKey(e)
    if (!key) return e.json(412, { error: "rh_login_required", message: "请用右上角按钮登录 RunningHub", fingerprint: "no_key" })

    var body = e.requestInfo().body || {}
    var url = body && body.url ? String(body.url) : ""
    if (!url) return e.json(400, { error: "bad_request", message: "缺少 url", fingerprint: "no_url" })

    // 非本应用存储的链接直接透传(RH/COS 临时链接由调用方负责有效性)
    if (url.indexOf("/api/files/media_files/") < 0) {
      return e.json(200, { ok: true, url: url })
    }

    // 完整地址或相对路径都按片段定位: .../api/files/media_files/<recordId>/<fileName>
    var seg = url.split("?")[0].split("/")
    var mfIdx = -1
    for (var si = 0; si < seg.length; si++) {
      if (seg[si] === "media_files") { mfIdx = si; break }
    }
    if (mfIdx < 0 || mfIdx + 1 >= seg.length) {
      return e.json(400, { error: "bad_media_url", message: "媒体链接格式不正确", fingerprint: "parse" })
    }
    var recId = seg[mfIdx + 1]
    var rec = null
    var coll = null
    try { rec = $app.findRecordById("media_files", recId) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "media_not_found", message: "媒体文件不存在, 请重新上传", fingerprint: "no_rec" })
    // 属主核验: 本应用存储的媒体仅属主可换取临时链接; 老记录无属主标记则不再允许提交生成
    var meRh = ""
    try { meRh = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    var recOwner = String(rec.get("user_email") || "").trim().toLowerCase()
    if (!meRh || !recOwner || recOwner !== meRh) return e.json(404, { error: "media_not_found", message: "媒体文件不存在, 请重新上传", fingerprint: "no_owner" })
    try { coll = $app.findCollectionByNameOrId("media_files") } catch (_) { coll = null }
    var fileName = rec.get("file")
    if (!fileName) return e.json(404, { error: "media_file_gone", message: "媒体文件丢失, 请重新上传", fingerprint: "no_file_field" })

    // PB 附件落盘路径: <dataDir>/storage/<collection.id(已带 pbc_ 前缀)>/<recordId>/<fileName>
    var filePath = $app.dataDir() + "/storage/" + (coll ? String(coll.id) : "media_files") + "/" + rec.id + "/" + fileName
    var sf = $filesystem.fileFromPath(filePath)
    var form = new FormData()
    form.append("file", sf)
    form.append("apiKey", key)
    var res = $http.send({
      url: "https://www.runninghub.cn/openapi/v2/media/upload/binary",
      method: "POST",
      headers: localForwardRhHeaders(e, { "Authorization": "Bearer " + key }),
      body: form,
      timeout: 60,
    })
    var raw = localResponseText(res)
    if (localIsRhAuthErr(raw)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期", fingerprint: "auth" })
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      var em = raw || ("RH HTTP " + (res ? res.statusCode : 0))
      return e.json(502, { error: "rh_upload_failed", message: "媒体换取临时链接失败", fingerprint: "rh_upload_failed" })
    }
    var parsed = localResponseJson(res)
    var data = parsed && parsed.data ? parsed.data : parsed
    var downloadUrl = data && (data.download_url || data.downloadUrl)
    if (!downloadUrl) return e.json(502, { error: "rh_upload_bad_response", message: "媒体换取临时链接失败", fingerprint: "rh_upload_bad_response" })
    return e.json(200, { ok: true, url: String(downloadUrl) })
  } catch (err) {
    var msg = String(err && err.message || err)
    if (localIsRhAuthErr(msg)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期", fingerprint: "auth" })
    return e.json(500, { error: "rh_url_failed", message: "媒体换取临时链接失败", fingerprint: "rh_url_failed" })
  }
})


// POST /api/media/save-remote  body: { url, mediaType? }
// 后端代下载远程图片/音频/视频并落为本应用永久文件(绕开浏览器 CORS——前端直连平台
// 签名图床常被跨域拦截, 转存失败会把 24h 过期临时链接静默入库, 隔天整批复裂图)。
// 需要登录; 仅允许平台/可信域名, 防 SSRF; 返回环境无关裸路径 /api/files/media_files/...
routerAdd("POST", "/api/media/save-remote", function (e) {
  try {
    var email = ""
    try { email = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!email) return e.json(412, { error: "login_required", message: "请先登录后再操作" })

    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) { body = {} }
    var srcUrl = body.url ? String(body.url) : ""
    var mediaType = String(body.mediaType || "image").toLowerCase()
    if (["image", "audio", "video"].indexOf(mediaType) < 0) mediaType = "image"
    if (!/^https?:\/\//i.test(srcUrl)) {
      return e.json(400, { error: "bad_remote_url", message: "仅支持 http(s) 远程地址" })
    }
    // 已经是本应用永久链接, 无需转存, 剥掉前缀返回裸路径
    var pfIdx = srcUrl.indexOf("/api/files/media_files/")
    if (pfIdx >= 0) {
      return e.json(200, { ok: true, url: srcUrl.substring(pfIdx) })
    }

    var ALLOWED_HOST_SUFFIXES = ["xiaoyaoyou.com", "myqcloud.com", "runninghub.cn", "runninghub.com"]
    var host = ""
    try {
      var m = srcUrl.match(/^https?:\/\/([^\/:?#]+)/i)
      host = m ? m[1].toLowerCase() : ""
    } catch (_) { host = "" }
    var hostOk = false
    for (var hi = 0; hi < ALLOWED_HOST_SUFFIXES.length; hi++) {
      var suf = ALLOWED_HOST_SUFFIXES[hi]
      if (host === suf || host.indexOf("." + suf) === host.length - suf.length - 1) { hostOk = true; break }
    }
    if (!hostOk) return e.json(400, { error: "host_not_allowed", message: "素材来源域名不在允许范围内" })

    var CAPS = { image: 20 * 1024 * 1024, audio: 30 * 1024 * 1024, video: 100 * 1024 * 1024 }
    var EXT_BY_TYPE = {
      image: { jpg: 1, jpeg: 1, png: 1, webp: 1, gif: 1, bmp: 1, avif: 1 },
      audio: { mp3: 1, wav: 1, m4a: 1, aac: 1, ogg: 1, flac: 1 },
      video: { mp4: 1, webm: 1, mov: 1, m4v: 1, mkv: 1 },
    }
    var resp = $http.send({ url: srcUrl, method: "GET", timeout: 60 })
    if (!resp || resp.statusCode < 200 || resp.statusCode >= 300) {
      return e.json(502, { error: "remote_download_failed", message: "远程素材下载失败", fingerprint: "dl_fail" })
    }
    // Goja $http 二进制响应体在 resp.body(数字索引的字节序列); raw 是字符串会破坏非 UTF-8 字节。
    var bytes = null
    try { if (resp.body && typeof resp.body.length === "number") bytes = resp.body } catch (_) { bytes = null }
    if (!bytes || bytes.length === 0) {
      return e.json(502, { error: "remote_read_failed", message: "远程素材读取失败(无字节)", fingerprint: "read_bytes" })
    }
    if (bytes.length > CAPS[mediaType]) return e.json(413, { error: "file_too_large", message: "素材超过大小上限", fingerprint: "size_remote" })

    // 扩展名: URL 路径优先, 其次响应 content-type(header 值可能是数组)
    var ext = ""
    var pathPart = srcUrl.split("?")[0]
    var dot = pathPart.lastIndexOf(".")
    if (dot >= 0) ext = pathPart.substring(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "").substring(0, 6)
    if (!ext || !EXT_BY_TYPE[mediaType][ext]) {
      var ctRaw = ""
      try {
        var ctv = resp.headers && (resp.headers["Content-Type"] || resp.headers["content-type"])
        ctRaw = Array.isArray(ctv) ? String(ctv[0] || "") : String(ctv || "")
      } catch (_) { ctRaw = "" }
      var cm = ctRaw.toLowerCase().match(/\/([a-z0-9]+)/)
      if (cm) {
        var g = cm[1].replace("jpeg", "jpg").replace("mpeg", "mp3")
        if (EXT_BY_TYPE[mediaType][g]) ext = g
      }
    }
    if (!ext) ext = mediaType === "audio" ? "mp3" : mediaType === "video" ? "mp4" : "jpg"

    var coll = $app.findCollectionByNameOrId("media_files")
    var safeName = "rf_" + new Date().getTime().toString(36) + Math.random().toString(36).slice(2, 8) + "." + ext
    var rf = $filesystem.fileFromBytes(bytes, safeName)
    var rec = new Record(coll)
    rec.set("file", rf, safeName)
    rec.set("media_type", mediaType)
    rec.set("user_email", email)
    $app.save(rec)
    var savedName = rec.get("file")
    return e.json(200, { ok: true, url: "/api/files/media_files/" + rec.id + "/" + savedName, mediaType: mediaType })
  } catch (err) {
    try { $app.logger().error("save-remote: " + String(err && err.message || err)) } catch (_) {}
    return e.json(500, { error: "save_remote_failed", message: "远程素材转存失败, 请稍后重试", fingerprint: "save_remote" })
  }
})



// POST /api/media/result-urls  body: { taskIds: string[] }
// 只读「本账号」AI 任务历史里留存的成品 CDN 地址(无外部调用)。用于打开画布时自愈:
// 旧版本把永久成品图转存到了会随环境重置丢失的本地文件存储, 裂图后凭卡片上的 taskId
// 找回平台永久公开 CDN 地址。仅返回本人成功且有 result_url 的任务, 上限 100 条。
routerAdd("POST", "/api/media/result-urls", function (e) {
  try {
    var email = ""
    try { email = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!email) return e.json(412, { error: "login_required", message: "请先登录后再操作" })
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) { body = {} }
    var rawIds = body.taskIds
    var ids = []
    if (Array.isArray(rawIds)) {
      for (var ii = 0; ii < rawIds.length && ids.length < 100; ii++) {
        var sv = String(rawIds[ii] == null ? "" : rawIds[ii])
        // taskId 仅允许任务号安全字符, 顺带当注入白名单
        if (sv && /^[A-Za-z0-9._-]{4,120}$/.test(sv) && ids.indexOf(sv) < 0) ids.push(sv)
      }
    }
    if (!ids.length) return e.json(200, { ok: true, urls: {} })
    var out = {}
    for (var k = 0; k < ids.length; k++) {
      var rec = null
      try {
        rec = $app.findFirstRecordByFilter(
          "aigc_tasks",
          "task_id = {:tid} && user_email = {:email} && status = 'success'",
          { tid: ids[k], email: email }
        )
      } catch (_) { rec = null }
      if (rec) {
        var ru = String(rec.get("result_url") || "")
        if (ru) out[ids[k]] = ru
      }
    }
    return e.json(200, { ok: true, urls: out })
  } catch (err) {
    try { $app.logger().error("result-urls: " + String(err && err.message || err)) } catch (_) {}
    return e.json(500, { error: "result_urls_failed", message: "成品图读取失败, 请稍后重试", fingerprint: "result_urls" })
  }
})
