/// <reference path="../pb_data/types.d.ts" />
// 站内账号核心：统一鉴权 / 封禁 / 余额扣费 / 充值 / 管理 / 限流（全局守卫，须最先加载）
//
// 安全模型（唯一入口，所有需登录/花钱的自定义路由都由本文件顶部的全局守卫统一把关）：
//   1) 登录/注册限流：按可信 IP (e.realIP, 不吃伪造 X-Forwarded-For) 写 auth_limits 表计数
//   2) 认证：只认真正验签的 PB users token (findAuthRecordByToken)，解析出用户后必查 status
//   3) 封禁：users.status === 'banned' 一律拒绝（即使 token 未过期）
//   4) 花钱：生成类路由先冻结余额再放行，失败自动退款；价格以服务端 FLOOR 为准
// 已认证用户通过 e.set 传给后续 handler（authId/authEmail/authAdmin/authUser），handler 不再自行解析 token。
//
// Goja 硬约束：每个 routerAdd/routerUse 回调是隔离作用域，所需常量/helper 一律就地内联。

// 所有 users 写入统一使用规范化邮箱。
// 数据库唯一索引负责并发场景的最终兜底；这里负责消除大小写/首尾空格
// 导致的“看起来不同、实际是同一账号”。
onRecordValidate(function (e) {
  try {
    var email = String(e.record.get("email") || "").trim().toLowerCase()
    if (email) {
      e.record.set("email", email)
      e.record.set("email_norm", email)
    }
  } catch (err) {
    try { $app.logger().error("users email normalize: " + String(err && err.message || err)) } catch (_) {}
  }
  e.next()
}, "users")

// ============================================================
// bootstrap：幂等补字段 + 建限流表
// ============================================================
onBootstrap(function (e) {
  e.next()
  try {
    // users 集合补 status/email_norm，并确保规范化邮箱具备数据库级唯一约束。
    try {
      var uc = $app.findCollectionByNameOrId("users")
      var uChanged = false
      var uHasStatus = false
      var uHasEmailNorm = false
      for (var ui = 0; ui < uc.fields.length; ui++) {
        if (String(uc.fields[ui].name) === "status") uHasStatus = true
        if (String(uc.fields[ui].name) === "email_norm") uHasEmailNorm = true
      }
      if (!uHasStatus) { uc.fields.add(new Field({ name: "status", type: "text", max: 16 })); uChanged = true }
      if (!uHasEmailNorm) {
        uc.fields.add(new Field({ name: "email_norm", type: "text", max: 190 }))
        uChanged = true
      }

      // 迁移历史用户的规范邮箱。冲突账号不自动合并，避免误删或改变用户归属；
      // 它们会使唯一索引创建失败，并在日志中留下明确的人工处理信号。
      var migrationConflicts = 0
      var migrationChanged = 0
      var seenEmails = {}
      var userOffset = 0
      for (;;) {
        var userPage = []
        try {
          userPage = $app.findRecordsByFilter("users", "", "created", 500, userOffset)
        } catch (_) { userPage = [] }
        if (!userPage.length) break
        for (var upi = 0; upi < userPage.length; upi++) {
          var ur = userPage[upi]
          var rawEmail = String(ur.get("email") || "").trim()
          var normalizedEmail = rawEmail.toLowerCase()
          if (!normalizedEmail) continue
          var userId = String(ur.id || "")
          if (seenEmails[normalizedEmail] && seenEmails[normalizedEmail] !== userId) {
            migrationConflicts++
            continue
          }
          seenEmails[normalizedEmail] = userId
          var storedNorm = String(ur.get("email_norm") || "")
          if (rawEmail !== normalizedEmail || storedNorm !== normalizedEmail) {
            try {
              ur.set("email", normalizedEmail)
              ur.set("email_norm", normalizedEmail)
              $app.save(ur)
              migrationChanged++
            } catch (migrationErr) {
              migrationConflicts++
              try {
                $app.logger().error(
                  "users email migration conflict for " + normalizedEmail + ": " +
                  String(migrationErr && migrationErr.message || migrationErr)
                )
              } catch (_) {}
            }
          }
        }
        if (userPage.length < 500) break
        userOffset += userPage.length
      }

      var hasEmailNormUniqueIndex = false
      try {
        for (var uii = 0; uii < uc.indexes.length; uii++) {
          var indexSql = String(uc.indexes[uii] || "").toLowerCase()
          if (indexSql.indexOf("unique index") >= 0 && /\(\s*email_norm\s*\)/.test(indexSql)) {
            hasEmailNormUniqueIndex = true
            break
          }
        }
      } catch (_) {}

      if (!hasEmailNormUniqueIndex) {
        if (typeof uc.addIndex === "function") {
          uc.addIndex("idx_users_email_norm", true, "email_norm", "")
        } else {
          if (!uc.indexes) uc.indexes = []
          uc.indexes.push("CREATE UNIQUE INDEX idx_users_email_norm ON users (email_norm)")
        }
        uChanged = true
      }

      if (uChanged || migrationChanged > 0) {
        try {
          $app.save(uc)
          try {
            $app.logger().info(
              "users schema ready: normalized email + unique email_norm index; migrated " +
              String(migrationChanged) + " records"
            )
          } catch (_) {}
        } catch (schemaErr) {
          // 典型原因是历史数据中已经存在大小写重复邮箱。
          // 不吞掉事实：后续每次启动都会重试，并在日志中明确提示需人工清理。
          try {
            $app.logger().error(
              "users schema integrity FAILED: cannot enforce unique email_norm index; " +
              "migration conflicts=" + String(migrationConflicts) + "; " +
              String(schemaErr && schemaErr.message || schemaErr)
            )
          } catch (_) {}
        }
      } else if (migrationConflicts > 0) {
        try {
          $app.logger().error(
            "users email migration found " + String(migrationConflicts) +
            " normalized duplicate(s); manual cleanup required"
          )
        } catch (_) {}
      }
    } catch (uerr) { try { $app.logger().error("users status field: " + String(uerr && uerr.message || uerr)) } catch (_) {} }

    // aigc_tasks 补 charge_ref（关联扣费流水, 供异步失败精准退款）与 user_email（看板按用户统计）
    try {
      var tc = $app.findCollectionByNameOrId("aigc_tasks")
      var tChanged = false, tHasCr = false, tHasEm = false
      for (var ti = 0; ti < tc.fields.length; ti++) {
        if (String(tc.fields[ti].name) === "charge_ref") tHasCr = true
        if (String(tc.fields[ti].name) === "user_email") tHasEm = true
      }
      if (!tHasCr) { tc.fields.add(new Field({ name: "charge_ref", type: "text", max: 128 })); tChanged = true }
      if (!tHasEm) { tc.fields.add(new Field({ name: "user_email", type: "text", max: 190 })); tChanged = true }
      if (tChanged) $app.save(tc)
    } catch (terr) { try { $app.logger().error("aigc_tasks fields: " + String(terr && terr.message || terr)) } catch (_) {} }

    // 站内通知表
    var nc = null
    try { nc = $app.findCollectionByNameOrId("notifications") } catch (_) { nc = null }
    if (!nc) {
      nc = new Collection({
        type: "base", name: "notifications",
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        fields: [
          { name: "user_email", type: "text", required: true, max: 190 },
          { name: "kind", type: "text", max: 32 },
          { name: "title", type: "text", max: 128 },
          { name: "body", type: "text", max: 512 },
          { name: "amount", type: "number" },
          { name: "balance_after", type: "number" },
          { name: "read", type: "bool" },
          { name: "created", type: "autodate", onCreate: true },
        ],
      })
      $app.save(nc)
    } else {
      // 幂等补 created 字段（旧表可能漏建）
      var nChanged = false, nHasCreated = false
      for (var ni2 = 0; ni2 < nc.fields.length; ni2++) { if (String(nc.fields[ni2].name) === "created") nHasCreated = true }
      if (!nHasCreated) { nc.fields.add(new Field({ name: "created", type: "autodate", onCreate: true })); nChanged = true }
      if (nChanged) $app.save(nc)
    }

    // 限流表
    var lc = null
    try { lc = $app.findCollectionByNameOrId("auth_limits") } catch (_) { lc = null }
    if (!lc) {
      lc = new Collection({
        type: "base", name: "auth_limits",
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        fields: [
          { name: "bucket", type: "text", required: true, max: 64 },
          { name: "count", type: "number", min: 0 },
          { name: "reset_at", type: "number" },
        ],
      })
      $app.save(lc)
    }
  } catch (err) {
    try { $app.logger().error("wallet bootstrap: " + String(err && err.message || err)) } catch (_) {}
  }
})

// ============================================================
// 唯一全局守卫：限流 → 认证 → 封禁 → 管理员 → 余额扣费
// ============================================================
routerUse(function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }
  function nowMs() { return new Date().getTime() }

  var FLOOR = {
    // 固定价图片渠道: GPT Image 2 低价(文生/图生同价, 不分分辨率)
    // 其余图片模型: gpt-image-2 官方走 IMAGE_TIER_PRICE(画质×分辨率),
    // Nano Banana 2 / PRO 各档走 IMAGE_RES_PRICE(按分辨率), 均不在此表。
    "gpt-image-2-0-text-to-image-channel-low-price": 15/100,
    "gpt-image-2-0-edit-channel-low-price": 15/100,
    // MiniMax H3: 固定按次一口价(成本 0.48 + 加价, 与时长/分辨率无关)
    "minimax-h3-text-to-video": 58/100, "minimax-h3-image-to-video-first-last-frame": 58/100,
  }
  // 仅按分辨率 1k/2k/4k 三档的图片渠道「用户实付价」(元/张, 已含加价; 文生/图生同价)。
  // 分辨率缺失/非法归一到 1k(提交体由合约默认值总会带分辨率)。
  var IMAGE_RES_PRICE = {
    // Nano Banana 2 官方(+20%): 底价 0.49/0.74/0.99
    "nano-banana2-gemini31flash-text-to-image-official-stable": { "1k": 59/100, "2k": 89/100, "4k": 119/100 },
    "nano-banana2-gemini31flash-image-to-image-official-stable": { "1k": 59/100, "2k": 89/100, "4k": 119/100 },
    // Nano Banana 2 低价(+40%): 底价 0.19/0.19/0.30
    "nano-banana2": { "1k": 27/100, "2k": 27/100, "4k": 42/100 },
    "nano-banana2-gemini31flash-image-to-image-channel-low-price": { "1k": 27/100, "2k": 27/100, "4k": 42/100 },
    // Nano Banana PRO 官方(+20%): 底价 0.8/1.0/1.5(已取消 8k)
    "nano-banana-pro-text-to-image-ultra-official-stable": { "1k": 96/100, "2k": 120/100, "4k": 180/100 },
    "nano-banana-pro-edit-ultra-official-stable": { "1k": 96/100, "2k": 120/100, "4k": 180/100 },
    // Nano Banana PRO 低价(+20%): 底价 0.4/0.4/0.5
    "nano-banana-pro": { "1k": 48/100, "2k": 48/100, "4k": 60/100 },
    "nano-banana-pro-edit-channel-low-price": { "1k": 48/100, "2k": 48/100, "4k": 60/100 },
  }
  // GPT Image 2 官方稳定(文生/图生同价): 按画质 low/medium/high × 分辨率 1k/2k/4k 九档的「用户实付价」(元/张, 已含 +20%)。
  // 档位与提交体 resolution/quality 一一对应, 参数非法时归一到 medium/1k(与前端缺省同), 不存在低价参数刷高档图的套利。
  var IMAGE_TIER_PRICE = {
    "gpt-image-2": {
      "low":    { "1k": 7/100,  "2k": 7/100,  "4k": 23/100 },
      "medium": { "1k": 46/100, "2k": 91/100, "4k": 136/100 },
      "high":   { "1k": 167/100, "2k": 332/100, "4k": 499/100 },
    },
    "gpt-image-2-image-to-image-official-stable": {
      "low":    { "1k": 7/100,  "2k": 7/100,  "4k": 23/100 },
      "medium": { "1k": 46/100, "2k": 91/100, "4k": 136/100 },
      "high":   { "1k": 167/100, "2k": 332/100, "4k": 499/100 },
    },
  }
  // 视频「每用户单价 × 秒」矩阵(元/秒, 已含创作者加价), 与前端 videoBasePrice 同口径。
  // 覆盖按时长计费渠道(Mini / Seedance 2.0 / 全能参考 / Grok / Seedance 2.5), 实扣 = 每秒价 × 时长 × 数量。
  // 旧旗舰 slug(seedance-2 / seedance2-0-image-to-video)一并并入。
  var VIDEO_PER_SEC = {
    // Seedance 2.0 Mini
    "seedance-2-0-mini-text-to-video": { "480p": 0.36, "720p": 0.72, "1080p": 1.06, "2k": 1.22, "4k": 1.48 },
    "seedance-2-0-mini-image-to-video": { "480p": 0.36, "720p": 0.72, "1080p": 1.06, "2k": 1.22, "4k": 1.48 },
    // Seedance 2.0(旧旗舰/图生/全能参考同价)
    "seedance-2": { "480p": 0.72, "720p": 1.44, "1080p": 1.78, "native1080p": 3.6, "2k": 1.94, "4k": 2.2, "native4k": 7.2 },
    "seedance2-0-image-to-video": { "480p": 0.72, "720p": 1.44, "1080p": 1.78, "native1080p": 3.6, "2k": 1.94, "4k": 2.2, "native4k": 7.2 },
    "seedance2-0-multimodal-video": { "480p": 0.72, "720p": 1.44, "1080p": 1.78, "native1080p": 3.6, "2k": 1.94, "4k": 2.2, "native4k": 7.2 },
    // Seedance 2.5 token 计费: 官方每秒价 +20%
    "seedance-2.5": { "480p": 1.01, "720p": 2.27, "native1080p": 4.04, "1080p": 2.65, "2k": 2.77, "4k": 3.02 },
    "seedance-2-5-image-to-video-token": { "480p": 1.01, "720p": 2.27, "native1080p": 4.04, "1080p": 2.65, "2k": 2.77, "4k": 3.02 },
    // Grok Imagine v1.5(图生 720p 官方 0.95, 加价取整后为 1.14)
    "xai-grok-imagine-video-v1-5-text-to-video-official-stable": { "480p": 0.67, "720p": 1.18, "1080p": 2.1 },
    "xai-grok-imagine-video-v1-5-image-to-video-official-stable": { "480p": 0.67, "720p": 1.14, "1080p": 2.1 },
  }
  // 兼容收费函数内的旧变量名
  var TOKEN_VIDEO_PER_SEC = VIDEO_PER_SEC
  // AI 应用渠道(无标准 FLOOR 单价)的站内定价, 也是防刷底价(忽略客户端可伪造的 __unitPrice)。
  // wan22 按创作者定价: 每次运行向用户收 0.80 站内额度, 成功实扣/失败自动退回。
  // wan22hq 预设已下线, 底价保留给已存画布/自存工作流里的存量节点。
  var AI_APP_FLOOR = { "ai-app": 50/100, "ai-app-wan22": 80/100, "ai-app-wan22hq": 80/100, "ai-app-indextts2": 50/100, "ai-app-animatev9": 800/100 }
  var FLOOR_FALLBACK = 30/100
  // 同一 AI 应用按提交体内枚举字段动态计价(如视频高清修复: SeedVR2 3.00 / FlashVSR 1.50)。
  // field = 提交体平铺 key, prices 按字符串取值, 取不到用 fallback(fail-closed, 绝不收 0)。
  var AI_APP_VARIANT = {
    "ai-app-videovsr": { field: "node108_select", prices: { "1": 300/100, "2": 150/100 }, fallback: 300/100 },
  }

  function pathStr() {
    var p = ""
    try { p = String((e.request && e.request.url && e.request.url.path) || "") } catch (_) { p = "" }
    if (!p) { try { p = String((e.request && e.request.URL && e.request.URL.Path) || "") } catch (_) {} }
    return p
  }
  function methodStr() { try { return String((e.request && e.request.method) || "").toUpperCase() } catch (_) { return "" } }
  function clientIP() {
    try { var ip = String(e.realIP() || ""); if (ip) return ip } catch (_) {}
    try { return String(e.remoteIP() || "0") } catch (_) { return "0" }
  }

  var path = pathStr()
  var method = methodStr()

  // ---- 业务表原生集合 CRUD 一律封禁 ----
  // 前端只经下方自定义路由(强登录+属主+服务端定价)访问数据, 绝不直连 PocketBase 原生
  // /api/collections/<表>/records。平台对多数业务表默认封原生接口, 但后装/迁移过的集合
  // (如 canvas_tags)可能漏过那层默认保护——曾实测被登录用户经原生接口匿名写脏标签。
  // 这里在统一中间件最前面显式封死, 只放行 users 自服务(注册/登录/改本人资料, 另有受控字段拦截)
  // 与平台系统鉴权表。文件下载 /api/files/... 不经过此规则。
  try {
    var cm = path.match(/^\/api\/collections\/([^/]+)\/records(?:\/|$)/)
    if (cm) {
      var collName = String(cm[1] || "")
      var NATIVE_ALLOWED = {
        users: 1,
        _superusers: 1,
        _externalAuths: 1,
        _authOrigins: 1,
        _mfas: 1,
        _otps: 1,
      }
      if (!NATIVE_ALLOWED[collName]) {
        e.json(403, { ok: false, code: "FORBIDDEN", error: "native_collection_forbidden", message: "不允许的访问方式" })
        return
      }
    }
  } catch (nativeErr) {
    try { $app.logger().error("native collection guard: " + String(nativeErr && nativeErr.message || nativeErr)) } catch (_) {}
    e.json(403, { ok: false, code: "FORBIDDEN", error: "guard_error", message: "访问被安全策略拒绝" })
    return
  }

  // ---- 限流：登录 / 注册（PB 内置鉴权路由）----
  // 邮箱只参与计算，不写入限流表，避免日志/数据库继续扩散账号信息。
  function stableHash(s) {
    var x = String(s || "")
    var h1 = 0x811c9dc5 >>> 0, h2 = 0x1000193 >>> 0
    for (var hi = 0; hi < x.length; hi++) {
      var c = x.charCodeAt(hi)
      h1 = ((h1 ^ c) >>> 0); h1 = (h1 * 16777619) >>> 0
      h2 = ((h2 + c) >>> 0); h2 = (h2 * 2246822519) >>> 0
    }
    function hex8(n) { var y = (n >>> 0).toString(16); while (y.length < 8) y = "0" + y; return y }
    return hex8(h1) + hex8(h2)
  }
  function bumpLimit(bucket, maxN, windowMs) {
    var nowL = nowMs()
    var lr = null
    try { lr = $app.findFirstRecordByFilter("auth_limits", "bucket = {:b}", { b: bucket }) } catch (_) { lr = null }
    if (!lr) {
      lr = new Record($app.findCollectionByNameOrId("auth_limits"))
      lr.set("bucket", bucket); lr.set("count", 1); lr.set("reset_at", nowL + windowMs)
      $app.save(lr)
      return { over: false, retryAfter: Math.ceil(windowMs / 1000) }
    }
    var resetAt = Number(lr.get("reset_at") || 0)
    var cnt = Number(lr.get("count") || 0)
    if (nowL >= resetAt) { cnt = 0; resetAt = nowL + windowMs }
    cnt = cnt + 1
    lr.set("count", cnt); lr.set("reset_at", resetAt)
    $app.save(lr)
    return { over: cnt > maxN, retryAfter: Math.max(1, Math.ceil((resetAt - nowL) / 1000)) }
  }

  var isLoginRoute = path === "/api/collections/users/auth-with-password"
  var isRegisterRoute = path === "/api/collections/users/records" && method === "POST"
  if (isLoginRoute || isRegisterRoute) {
    var limits = []
    var ip = clientIP()
    if (isLoginRoute) {
      limits.push({ bucket: "login:" + ip, max: 12, window: 60000 })
    } else {
      var registerEmail = ""
      try { registerEmail = normEmail((e.requestInfo().body || {}).email) } catch (_) { registerEmail = "" }
      limits.push({ bucket: "register-ip-min:" + ip, max: 5, window: 60000 })
      limits.push({ bucket: "register-ip-hour:" + ip, max: 15, window: 3600000 })
      if (registerEmail) {
        var emailHash = stableHash(registerEmail)
        var combinedHash = stableHash(ip + "|" + registerEmail)
        limits.push({ bucket: "register-email-min:" + emailHash, max: 3, window: 60000 })
        limits.push({ bucket: "register-ip-email-min:" + combinedHash, max: 3, window: 60000 })
      }
    }

    for (var li = 0; li < limits.length; li++) {
      var spec = limits[li]
      var result = null
      try { result = bumpLimit(spec.bucket, spec.max, spec.window) } catch (lerr) {
        try { $app.logger().error("auth rate limit storage: " + String(lerr && lerr.message || lerr)) } catch (_) {}
        e.json(503, { code: "RATE_LIMIT_UNAVAILABLE", error: "rate_limit_unavailable", message: "安全检查暂不可用, 请稍后再试" })
        return
      }
      if (result.over) {
        e.json(429, {
          code: "TOO_MANY_REQUESTS", error: "rate_limited",
          message: "操作过于频繁, 请稍后再试", retryAfter: result.retryAfter,
        })
        return
      }
    }
  }

  // ---- users 自助更新受控字段保护 ----
  // users 是 auth 集合, 平台放行其原生自服务接口; updateRule 为本人可改, 但封禁状态 status
  // 等受控字段不能由本人经 PATCH /api/collections/users/records/{id} 修改, 否则被封用户可自行
  // 解封(本运行时未注入 onRecordUpdateRequest, 故在统一中间件里拦)。管理员封禁走服务端自定义
  // 路由($app.save, 不经此 HTTP 路径), 不受影响。只拦"确实改了受控字段"的请求, 正常改昵称放行。
  try {
    var usersSelfUpdate = method === "PATCH" && /^\/api\/collections\/users\/records\/[^/]+$/.test(path)
    if (usersSelfUpdate) {
      var uBody = e.requestInfo().body || {}
      var uGuarded = ["status", "verified", "email_norm", "is_admin"]
      var uChanged = false
      var uTargetId = decodeURIComponent(path.split("/").pop() || "")
      var uOld = null
      try { uOld = $app.findRecordById("users", uTargetId) } catch (_) { uOld = null }
      for (var ug = 0; ug < uGuarded.length; ug++) {
        var gk = uGuarded[ug]
        if (gk in uBody) {
          var nv = uBody[gk]
          var ov = uOld ? uOld.get(gk) : undefined
          // 布尔/空值按字符串归一比较; 目标旧记录不存在则保守拦截受控字段写入
          if (!uOld || String(nv) !== String(ov)) { uChanged = true; break }
        }
      }
      if (uChanged) {
        e.json(403, { ok: false, code: "FORBIDDEN", error: "field_protected", message: "该字段不允许自行修改" })
        return
      }
    }
  } catch (guardErr) {
    // 判定自身出错时保守拒绝, 避免防护被异常绕过
    try { $app.logger().error("users self-update guard: " + String(guardErr && guardErr.message || guardErr)) } catch (_) {}
    e.json(403, { ok: false, code: "FORBIDDEN", error: "guard_error", message: "资料更新被安全策略拒绝" })
    return
  }

  // ---- 路由分类 ----
  var isAuthRead = path.indexOf("/api/wallet/") === 0
  var isNotifApi = path.indexOf("/api/notifications") === 0
  var isRechargeApi = path.indexOf("/api/recharges") === 0
  var isAdminApi = path.indexOf("/api/admin/") === 0
  var isGenSubmit = path.indexOf("/api/aigc/submit") === 0
  var isAgentQuote = path === "/api/agent-bridge/v1/wallet-quote" && method === "POST"
  var isAiAppRun = path.indexOf("/api/aigc/ai-app/") === 0 && /\/run$/.test(path)
  var isLlmChat = path.indexOf("/api/llm/chat") === 0
  var isLlmPoll = path.indexOf("/api/llm/poll") === 0

  // 需登录的业务接口（非生成类）
  var protectedAny = false
  if (path.indexOf("/api/agent-bridge/v1/") === 0) protectedAny = true
  try {
    if (path === "/api/aigc/upload" || path === "/api/aigc/history" ||
        path === "/api/aigc/price-preview" ||
        path.indexOf("/api/aigc/history/") === 0 ||
        path.indexOf("/api/aigc/jobs/") === 0) protectedAny = true
    if (path.indexOf("/api/aigc/ai-app/") === 0) {
      if (/\/(upload|history|price-preview)$/.test(path) || /\/jobs\/[^/]+\/poll$/.test(path) ||
          /\/history\/[^/]+\/(update|delete)$/.test(path)) protectedAny = true
    }
    if (path === "/api/media/persist" || path === "/api/media/rh-url" || path === "/api/media/save-remote" || path === "/api/media/result-urls") protectedAny = true
    // 素材/画布列表 GET 对未登录放行: handler 会返回空集合, 首页据此显示空状态+登录引导;
    // 写操作(POST)与单条记录(/{id})仍必须登录, 且 handler 内部还有属主校验。
    if (path === "/api/assets" && method !== "GET") protectedAny = true
    if (/^\/api\/assets\/[^/]+$/.test(path)) protectedAny = true
    if (path === "/api/canvases" && method !== "GET") protectedAny = true
    if (/^\/api\/canvases\/[^/]+$/.test(path)) protectedAny = true
    // 全局账号级标签: 新建必须登录; 单条读写改删必须登录(handler 内再做属主校验)。
    // 标签列表 GET 走 optionalAuth(匿名空集合, 登录用户只拿本人的), 见下方。
    if (path === "/api/canvas_tags" && method !== "GET") protectedAny = true
    if (/^\/api\/canvas_tags\/[^/]+$/.test(path)) protectedAny = true
  } catch (_) {}

  // 可选认证: 列表 GET 匿名可看(空集合), 但带了合法令牌就要识别身份, 这样登录用户
  // 才能看到自己的画布/素材; 令牌非法或账号被封仍然拒绝, 不做"静默当游客"。
  var optionalAuth = false
  try {
    if (method === "GET" && (path === "/api/assets" || path === "/api/canvases" || path === "/api/canvas_tags")) optionalAuth = true
  } catch (_) {}

  var needAuth = isAuthRead || isNotifApi || isRechargeApi || isAdminApi || isGenSubmit || isAiAppRun ||
    isLlmChat || isLlmPoll || protectedAny
  var needCharge = isGenSubmit || isAiAppRun

  // ---- 取令牌：真验签，拒绝伪造/过期 token ----
  // 兼容两种凭证形态：网关还原后的 Authorization（PB SDK 裸令牌，无 Bearer 前缀）、
  // 直连/透传场景的 "Bearer <jwt>"，以及 X-Pb-Auth。统一剥掉可选的 Bearer 前缀。
  var token = ""
  try {
    var h = (e.requestInfo() || {}).headers || {}
    var auth = String(
      h["Authorization"] || h["authorization"] ||
      h["X-Pb-Auth"] || h["x-pb-auth"] || h["x_pb_auth"] || ""
    ).trim()
    if (auth.indexOf("Bearer ") === 0) auth = auth.slice(7).trim()
    token = auth
  } catch (_) { token = "" }

  if (!needAuth && !optionalAuth) { e.next(); return }
  if (!token) {
    // 匿名访问列表: 放行, handler 返回空集合; 其余接口必须登录
    if (optionalAuth) { e.next(); return }
    e.json(401, { ok: false, error: "login_required", code: "LOGIN_REQUIRED", message: "请先登录后再操作" })
    return
  }
  var user = null
  try { user = $app.findAuthRecordByToken(token) } catch (_) { user = null }
  if (!user) {
    e.json(401, { ok: false, error: "login_required", code: "LOGIN_REQUIRED", message: "登录已过期, 请重新登录" })
    return
  }
  // ---- 封禁状态：取自数据库用户记录，不看 token 文本 ----
  var userStatus = ""
  try { userStatus = String(user.get("status") || "") } catch (_) { userStatus = "" }
  if (userStatus === "banned") {
    e.json(403, { ok: false, error: "account_banned", code: "ACCOUNT_BANNED", message: "账号已被停用, 如有疑问请联系管理员" })
    return
  }

  var email = normEmail(user.get("email") || "")
  var uid = String(user.id || "")

  // ---- 管理员：只从数据库钱包记录 / 邮箱白名单读，绝不取自 token 字段 ----
  var ADMIN_EMAILS = [
    "244638579@qq.com",
  ]
  function walletRec(em) {
    var rec = null
    try { rec = $app.findRecordsByFilter("wallets", "user_email = {:em}", "", 1, 0, { em: em })[0] } catch (_) { rec = null }
    return rec
  }
  // ---- 测试账号: 不扣站内余额, 生成直扣创作者 RH 额度; 无管理后台权限 ----
  var TEST_EMAILS = [
    "892384629@qq.com",
  ]
  var isAdmin = false
  for (var ai = 0; ai < ADMIN_EMAILS.length; ai++) { if (normEmail(ADMIN_EMAILS[ai]) === email) { isAdmin = true; break } }
  var isTest = false
  for (var ti = 0; ti < TEST_EMAILS.length; ti++) { if (normEmail(TEST_EMAILS[ti]) === email) { isTest = true; break } }
  var myWallet = walletRec(email)
  if (!isAdmin && myWallet && myWallet.get("is_admin")) isAdmin = true

  try {
    e.set("authId", uid)
    e.set("authEmail", email)
    e.set("authAdmin", !!isAdmin)
    e.set("authUser", user)
  } catch (_) {}

  // ---- 管理接口：统一在此拦截非管理员 ----
  if (isAdminApi && !isAdmin) {
    e.json(403, { ok: false, error: "forbidden", code: "FORBIDDEN", message: "仅管理员可访问" })
    return
  }

  // ---- 已认证操作的频控: 防登录后高频刷上传/文本生成耗尽创作者 RH 额度 ----
  // LLM 文本: 每分钟 20 次 + 每小时 200 次; 媒体上传(标准/AIGC/AI应用): 每分钟 60 次
  // (前端单批最多 30 张, 24 会让第 25 张起 429 留空节点; 60 完整覆盖一整批)。
  var isUploadRoute = path === "/api/media/persist" || path === "/api/aigc/upload" ||
    (path.indexOf("/api/aigc/ai-app/") === 0 && /\/upload$/.test(path))
  var rateSpecs = []
  if (isLlmChat) {
    rateSpecs.push({ bucket: "llm-min:" + uid, max: 20, window: 60000 })
    rateSpecs.push({ bucket: "llm-hour:" + uid, max: 200, window: 3600000 })
  }
  if (isUploadRoute) rateSpecs.push({ bucket: "up-min:" + uid, max: 60, window: 60000 })
  // 花钱的生成提交也要限频: 框选批量可能一次提交几十个任务(正常使用),
  // 阈值放宽到 120/分、1000/时, 挡的是脚本爆破, 不挡正常批量。
  if (isGenSubmit) {
    rateSpecs.push({ bucket: "gen-min:" + uid, max: 120, window: 60000 })
    rateSpecs.push({ bucket: "gen-hour:" + uid, max: 1000, window: 3600000 })
  }
  // AI 应用 run 每应用路由每用户 30/分、300/时(单次出片/出片慢, 正常用量远低于此)。
  if (isAiAppRun) {
    rateSpecs.push({ bucket: "airun-min:" + uid, max: 30, window: 60000 })
    rateSpecs.push({ bucket: "airun-hour:" + uid, max: 300, window: 3600000 })
  }
  for (var ri3 = 0; ri3 < rateSpecs.length; ri3++) {
    var rs3 = rateSpecs[ri3]
    var rl3 = null
    try { rl3 = bumpLimit(rs3.bucket, rs3.max, rs3.window) } catch (rle) {
      try { $app.logger().error("op rate limit storage: " + String(rle && rle.message || rle)) } catch (_) {}
      e.json(503, { code: "RATE_LIMIT_UNAVAILABLE", error: "rate_limit_unavailable", message: "安全检查暂不可用, 请稍后再试", fingerprint: "rl_storage" })
      return
    }
    if (rl3.over) {
      e.json(429, {
        code: "TOO_MANY_REQUESTS", error: "rate_limited",
        message: "操作过于频繁, 请稍后再试", retryAfter: rl3.retryAfter,
      })
      return
    }
  }

  // ---- LLM：仅需登录，不扣费 ----
  if (isLlmChat || isLlmPoll) { e.next(); return }
  // ---- 其余非生成类登录接口：放行 ----
  if (!needCharge && !isAgentQuote) { e.next(); return }

  // ---- 生成类：余额门 ----
  // fail-closed 计价: 只认服务端已知渠道。
  //   1) FLOOR 固定单价的标准图片/视频渠道;
  //   2) Seedance 2.5 按分辨率/时长动态计价;
  //   3) AI 应用渠道取安全底价(绝不低于 AI_APP_FLOOR, 忽略客户端可伪造的 __unitPrice);
  //   4) 其余未知 model 一律拒绝 —— 防止漏配底价的新渠道被 0.30 兜底近乎免费刷。
  function chargeAmount(model, body) {
    model = String(model || "")
    var count = parseInt(body && (body.count || body.__count) || 1, 10)
    if (!(count > 0)) count = 1
    if (count > 20) count = 20
    // GPT Image 2 官方: 按画质×分辨率九档; quality/resolution 非法值归一到 medium/1k(与前端缺省同)
    var tier = IMAGE_TIER_PRICE[model]
    if (tier) {
      var q = String(body && body.quality || "medium").toLowerCase()
      if (q !== "low" && q !== "medium" && q !== "high") q = "medium"
      var ir = String(body && body.resolution || "1k").toLowerCase()
      if (ir !== "1k" && ir !== "2k" && ir !== "4k") ir = "1k"
      var tierPrice = (tier[q] && tier[q][ir]) || tier.medium["1k"]
      return { count: count, amount: round2(tierPrice * count), known: true }
    }
    // Nano Banana 2 / PRO 各档: 仅按分辨率分档; 分辨率非法归一 1k
    var resPrice = IMAGE_RES_PRICE[model]
    if (resPrice) {
      var rr = String(body && body.resolution || "1k").toLowerCase()
      if (rr !== "1k" && rr !== "2k" && rr !== "4k") rr = "1k"
      var rp = resPrice[rr] || resPrice["1k"]
      return { count: count, amount: round2(rp * count), known: true }
    }
    var unit = FLOOR[model]
    if (unit) return { count: count, amount: round2(unit * count), known: true }
    var tv = TOKEN_VIDEO_PER_SEC[model]
    if (tv) {
      var res = String(body && (body.resolution || "") || "720p").toLowerCase()
      var perSec = tv[res]
      if (perSec === undefined) perSec = tv["720p"]
      var sec = parseInt(body && body.duration, 10)
      if (!(sec > 0)) sec = 5
      if (sec > 30) sec = 30
      return { count: count, amount: round2(perSec * sec * count), known: true }
    }
    if (Object.prototype.hasOwnProperty.call(AI_APP_FLOOR, model)) {
      return { count: count, amount: round2(AI_APP_FLOOR[model] * count), known: true }
    }
    // 同应用多档价: 按提交体枚举字段取价, 未配置的模型值按 fallback 收(fail-closed)
    var variant = AI_APP_VARIANT[model]
    if (variant) {
      var vVal = String((body && body[variant.field]) || "")
      var vPrice = variant.prices[vVal]
      if (!(vPrice > 0)) vPrice = variant.fallback
      return { count: count, amount: round2(vPrice * count), known: true }
    }
    return { count: count, amount: 0, known: false }
  }
  function ensureWallet(em) {
    var rec = walletRec(em)
    if (rec) return rec
    // 管理员只能来自白名单邮箱或后台显式标记; 新注册用户一律普通身份,
    // 禁止"第一个钱包自动当管理员"(否则任何抢注者都会拿到经营后台)。
    var firstAdmin = false
    for (var bi = 0; bi < ADMIN_EMAILS.length; bi++) { if (normEmail(ADMIN_EMAILS[bi]) === em) { firstAdmin = true; break } }
    rec = new Record($app.findCollectionByNameOrId("wallets"))
    rec.set("user_email", em); rec.set("balance", 0); rec.set("held", 0)
    rec.set("is_admin", !!firstAdmin); rec.set("total_recharged", 0); rec.set("total_consumed", 0)
    $app.save(rec)
    return rec
  }
  function writeTxn(em, kind, amount, ref, model, note, status, balAfter) {
    try {
      var t = new Record($app.findCollectionByNameOrId("wallet_txns"))
      t.set("user_email", normEmail(em)); t.set("kind", String(kind || ""))
      t.set("amount", round2(amount)); t.set("balance_after", round2(balAfter))
      t.set("ref", String(ref || "").substring(0, 128)); t.set("model", String(model || "").substring(0, 128))
      t.set("note", String(note || "").substring(0, 256)); t.set("status", String(status || "done"))
      $app.save(t)
    } catch (terr) { try { $app.logger().error("wallet txn: " + String(terr && terr.message || terr)) } catch (_) {} }
  }

  var body = {}
  try { body = e.requestInfo().body || {} } catch (_) { body = {} }
  var model = ""
  if (isAiAppRun) {
    // AI 应用一律按路由路径里的渠道 slug 定价, 绝不读 body.model/modelName——
    // 处理器只按固定 webappId 出站, 客户端塞便宜模型名可把高价应用压到 6 分钱(伪装攻击)。
    // 配了专属价的应用取专属价(含变档价), 没配的一律走通用 ai-app 安全底价。
    try {
      var aiSlug = path.replace(/^\/api\/aigc\/ai-app\//, "").replace(/\/run$/, "")
      var aiKey = "ai-app-" + aiSlug
      if (aiSlug && (Object.prototype.hasOwnProperty.call(AI_APP_FLOOR, aiKey) || Object.prototype.hasOwnProperty.call(AI_APP_VARIANT, aiKey))) {
        model = aiKey
      } else {
        model = "ai-app"
      }
    } catch (_) {
      model = "ai-app"
    }
  } else {
    model = String(body.model || body.modelName || "")
  }
  var charge = chargeAmount(model, body)
  // fail-closed: 未知渠道不允许用 0.30 兜底价提交, 必须先在服务端配置真实底价。
  if (!charge.known) {
    e.json(400, { ok: false, error: "model_not_priced", code: "MODEL_NOT_PRICED", message: "该生成渠道暂不可用, 请重新选择渠道", fingerprint: "unknown_model" })
    return
  }

  if (isAgentQuote) {
    e.json(200, { ok: true, estimatedPrice: charge.amount, currency: "CNY", priceText: "¥" + Number(charge.amount).toFixed(2), isFreeThisCall: charge.amount === 0 })
    return
  }

  if (body.agentMaxCharge !== undefined && (!(Number(body.agentMaxCharge) >= 0) || charge.amount > Number(body.agentMaxCharge))) {
    e.json(409, { error: "price_changed", message: "当前价格高于已确认金额，请重新报价" })
    return
  }

  try { delete body.__unitPrice } catch (_) {}
  try { delete body.unitPrice } catch (_) {}
  try { delete body.__count } catch (_) {}
  try { delete body.__clientRef } catch (_) {}

  var clientRef = "gen_" + nowMs() + "_" + Math.floor(Math.random() * 1e6)
  var wallet = ensureWallet(email)
  var balance = Number(wallet.get("balance") || 0)

  // 请求被下游拒绝(模型未启用/参数错/排队满 429/上游 5xx)时 held 永远不会被置 settled,
  // 当场退回, 不再只靠管理员看板 5 分钟清扫; 受理成功的 held 已在处理器内置 settled, 这里查不到即跳过。
  function releaseUnacceptedHeld(adminPath) {
    try {
      var h = $app.findFirstRecordByFilter("wallet_txns", "ref = {:r} && status = 'held'", { r: clientRef })
      if (!h) return
      h.set("status", "void"); $app.save(h)
      if (adminPath) {
        var balA = 0
        try { var wA = $app.findFirstRecordByFilter("wallets", "user_email = {:em}", { em: email }); if (wA) balA = Number(wA.get("balance") || 0) } catch (_) {}
        var va = new Record($app.findCollectionByNameOrId("wallet_txns"))
        va.set("user_email", email); va.set("kind", "void_admin"); va.set("amount", round2(charge.amount))
        va.set("balance_after", round2(balA)); va.set("ref", "void:" + clientRef)
        va.set("model", model); va.set("note", "未受理·冲销"); va.set("status", "done")
        $app.save(va)
        return
      }
      var b2 = round2(Number(wallet.get("balance") || 0) + charge.amount)
      wallet.set("balance", b2)
      $app.save(wallet)
      var v = new Record($app.findCollectionByNameOrId("wallet_txns"))
      v.set("user_email", email); v.set("kind", "void"); v.set("amount", round2(charge.amount))
      v.set("balance_after", b2); v.set("ref", "void:" + clientRef)
      v.set("model", model); v.set("note", "未受理自动退回"); v.set("status", "done")
      $app.save(v)
    } catch (herr) { try { $app.logger().error("held auto-release: " + String(herr && herr.message || herr)) } catch (_) {} }
  }

  // 统一先记一笔 held(待结算)预扣, 处理器通过 e.get 拿到 clientRef,
  // 任务被 RH 真正受理后置 settled(计入成本); 请求结束仍 held 则当场退回(见 releaseUnacceptedHeld)。
  // 异步失败(扣费后任务跑挂)由 /api/wallet/refund 结算退款。
  if (isAdmin || isTest) {
    // 管理员/测试账号旁路: 不校验/不扣站内余额, 调用直接实扣创作者 RH 账户; held 仅用于受理后成本记账
    writeTxn(email, "gen_admin", -charge.amount, clientRef, model, (isAdmin ? "管理员测试·实扣RH " : "测试账号·直扣RH ") + "x" + charge.count, "held", balance)
    try { e.set("chargeRef", clientRef); e.set("chargeAdmin", true); e.set("chargeAmount", charge.amount) } catch (_) {}
    e.next()
    releaseUnacceptedHeld(true)
    return
  }

  // ---- 普通用户: 站内余额门 ----
  if (balance < charge.amount) {
    e.json(402, { ok: false, error: "insufficient_balance", code: "INSUFFICIENT_BALANCE", message: "余额不足, 请充值后再生成", balance: round2(balance), need: charge.amount })
    return
  }
  var newBalance = round2(balance - charge.amount)
  wallet.set("balance", newBalance)
  $app.save(wallet)
  writeTxn(email, "gen", -charge.amount, clientRef, model, "生成预扣 x" + charge.count, "held", newBalance)
  try { e.set("chargeRef", clientRef); e.set("chargeAdmin", false); e.set("chargeAmount", charge.amount) } catch (_) {}

  e.next()
  releaseUnacceptedHeld(false)
})

// ============================================================
// 我的钱包（身份来自守卫 e.get；首次开户判定管理员）
// ============================================================
routerAdd("GET", "/api/wallet/me", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }
  var ADMIN_EMAILS = [
    "244638579@qq.com",
  ]
  try {
    var email = normEmail(e.get("authEmail") || "")
    var name = ""
    try { var u0 = e.get("authUser"); if (u0) name = String(u0.get("name") || "") } catch (_) {}
    var w = null
    try { w = $app.findRecordsByFilter("wallets", "user_email = {:em}", "", 1, 0, { em: email })[0] } catch (_) { w = null }
    var balance = 0, held = 0, tr = 0, tc = 0, admin = false, banned = false
    try {
      var uu = e.get("authUser")
      if (uu) banned = String(uu.get("status") || "") === "banned"
    } catch (_) {}
    if (w) {
      balance = Number(w.get("balance") || 0); held = Number(w.get("held") || 0)
      tr = Number(w.get("total_recharged") || 0); tc = Number(w.get("total_consumed") || 0)
      admin = !!w.get("is_admin")
    } else {
      // 新注册用户开户一律普通身份, 管理员只认白名单邮箱(下方循环兜底)。
      admin = false
      w = new Record($app.findCollectionByNameOrId("wallets"))
      w.set("user_email", email); w.set("balance", 0); w.set("held", 0)
      w.set("is_admin", false); w.set("total_recharged", 0); w.set("total_consumed", 0)
      $app.save(w)
    }
    for (var i = 0; i < ADMIN_EMAILS.length; i++) { if (normEmail(ADMIN_EMAILS[i]) === email) admin = true }
    return e.json(200, {
      ok: true, email: email, name: name, banned: banned,
      balance: round2(balance), held: round2(held), is_admin: !!admin,
      total_recharged: round2(tr), total_consumed: round2(tc),
    })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "wallet_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 异步任务失败退款
// ============================================================
routerAdd("POST", "/api/wallet/refund", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }
  function getWallet(email) {
    var rec = null
    try { rec = $app.findRecordsByFilter("wallets", "user_email = {:em}", "", 1, 0, { em: email })[0] } catch (_) { rec = null }
    if (rec) return rec
    rec = new Record($app.findCollectionByNameOrId("wallets"))
    rec.set("user_email", email); rec.set("balance", 0); rec.set("held", 0)
    rec.set("is_admin", false); rec.set("total_recharged", 0); rec.set("total_consumed", 0)
    $app.save(rec)
    return rec
  }
  function writeTxn(email, kind, amount, ref, model, note, balAfter) {
    try {
      var t = new Record($app.findCollectionByNameOrId("wallet_txns"))
      t.set("user_email", normEmail(email)); t.set("kind", String(kind || ""))
      t.set("amount", round2(amount)); t.set("balance_after", round2(balAfter))
      t.set("ref", String(ref || "").substring(0, 128)); t.set("model", String(model || "").substring(0, 128))
      t.set("note", String(note || "").substring(0, 256)); t.set("status", "done")
      $app.save(t)
    } catch (_) {}
  }
  try {
    var email = normEmail(e.get("authEmail") || "")
    if (!email) return e.json(401, { ok: false, error: "login_required", code: "LOGIN_REQUIRED", message: "请先登录" })
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    var clientRef = String(body.ref || body.clientRef || "").substring(0, 128)
    var taskId = String(body.taskId || body.jobId || "").substring(0, 128)

    // 安全红线: 手动退款必须能证明"有一笔属于本人、且确实失败的任务"。
    // 旧实现允许空 body 扫最近一笔未退扣费直接退 —— 成功任务也能退, 等于生成永久免费。已封死:
    //   1) 必须带任务编号(本地 aigc_tasks id);  2) 任务归属本人;  3) 任务状态确为 failed。
    // 无任务的预扣在守卫里请求被拒时已当场退回(void), 不应再走这里。
    if (!taskId) {
      return e.json(400, { ok: false, error: "task_id_required", message: "缺少任务编号, 无法退款", fingerprint: "no_task" })
    }
    var task = null
    try { task = $app.findRecordById("aigc_tasks", taskId) } catch (_) { task = null }
    if (!task) return e.json(404, { ok: false, error: "task_not_found", message: "任务不存在或已过期", fingerprint: "no_task" })
    if (String(task.get("user_email") || "") !== email) {
      return e.json(404, { ok: false, error: "task_not_found", message: "任务不存在或已过期", fingerprint: "owner" })
    }
    if (String(task.get("status") || "") !== "failed") {
      return e.json(200, { ok: false, error: "task_not_failed", message: "任务未失败, 无法退款" })
    }

    // 定位扣费: 只认该失败任务自己的 charge_ref; 拿不到则查本人那笔未退的 held/settled 扣费。
    // 绝不允许"扫最近一笔任意扣费"。
    var taskRef = String(task.get("charge_ref") || "")
    if (taskRef && !clientRef) clientRef = taskRef
    var chargeKinds = "(kind = 'gen' || kind = 'gen_admin')"
    var genTxn = null
    if (clientRef) {
      try {
        genTxn = $app.findRecordsByFilter("wallet_txns",
          "user_email = {:em} && " + chargeKinds + " && ref = {:r} && (status = 'held' || status = 'settled')",
          "-created", 1, 0, { em: email, r: clientRef })[0]
      } catch (_) { genTxn = null }
    }
    if (!genTxn && taskRef) {
      try {
        genTxn = $app.findRecordsByFilter("wallet_txns",
          "user_email = {:em} && " + chargeKinds + " && ref = {:r} && (status = 'held' || status = 'settled')",
          "-created", 1, 0, { em: email, r: taskRef })[0]
      } catch (_) { genTxn = null }
    }
    if (!genTxn) return e.json(200, { ok: false, error: "no_charge", message: "该任务没有可退的扣费记录" })

    var srcKind = String(genTxn.get("kind") || "")
    var isAdminCharge = srcKind === "gen_admin"
    var refundKind = isAdminCharge ? "refund_admin" : "refund"
    var refundRef = "refund:" + String(genTxn.get("ref") || "")
    try {
      var dup = $app.findRecordsByFilter("wallet_txns", "user_email = {:em} && kind = {:k} && ref = {:r}", "-created", 1, 0, { em: email, k: refundKind, r: refundRef })[0]
      if (dup) return e.json(200, { ok: true, already: true, message: "已退款" })
    } catch (_) {}

    var amount = Math.abs(Number(genTxn.get("amount") || 0))
    var w = getWallet(email)
    try { genTxn.set("status", "refunded"); $app.save(genTxn) } catch (_) {}
    if (isAdminCharge) {
      // 管理员旁路没扣站内余额: 只写一笔对冲流水, 不动钱包
      var balNow = round2(Number(w.get("balance") || 0))
      writeTxn(email, "refund_admin", amount, refundRef, String(genTxn.get("model") || ""), "生成失败·冲销实扣RH", balNow)
      return e.json(200, { ok: true, refunded: 0, balance: balNow, real_cost_reversed: round2(amount) })
    }
    var b = round2(Number(w.get("balance") || 0) + amount)
    w.set("balance", b)
    w.set("total_consumed", round2(Math.max(0, Number(w.get("total_consumed") || 0) - amount)))
    $app.save(w)
    writeTxn(email, "refund", amount, refundRef, String(genTxn.get("model") || ""), "生成失败退款", b)
    return e.json(200, { ok: true, refunded: round2(amount), balance: b })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "refund_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 站内通知：列表（含未读数）
// ============================================================
routerAdd("GET", "/api/notifications", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  try {
    var email = normEmail(e.get("authEmail") || "")
    if (!email) return e.json(401, { ok: false, error: "login_required", code: "LOGIN_REQUIRED", message: "请先登录" })
    var recs = []
    try { recs = $app.findRecordsByFilter("notifications", "user_email = {:em}", "-created", 50, 0, { em: email }) } catch (_) { recs = [] }
    var items = []
    var unread = 0
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i]
      var isRead = false
      try { isRead = !!r.get("read") } catch (_) {}
      if (!isRead) unread += 1
      items.push({
        id: r.id, kind: String(r.get("kind") || "system"),
        title: String(r.get("title") || ""), body: String(r.get("body") || ""),
        amount: Number(r.get("amount") || 0), balance_after: Number(r.get("balance_after") || 0),
        read: isRead, created: r.getString("created"),
      })
    }
    return e.json(200, { ok: true, items: items, unread: unread })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "notif_failed", message: "操作失败, 请稍后重试" })
  }
})

// 标记单条已读 / 全部已读
routerAdd("POST", "/api/notifications/read", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  try {
    var email = normEmail(e.get("authEmail") || "")
    if (!email) return e.json(401, { ok: false, error: "login_required", code: "LOGIN_REQUIRED", message: "请先登录" })
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    var id = String(body.id || "")
    if (id) {
      var one = null
      try { one = $app.findRecordById("notifications", id) } catch (_) { one = null }
      if (one && normEmail(one.get("user_email")) === email) { one.set("read", true); $app.save(one) }
    } else {
      var rs = []
      try { rs = $app.findRecordsByFilter("notifications", "user_email = {:em} && read = false", "", 200, 0, { em: email }) } catch (_) { rs = [] }
      for (var i = 0; i < rs.length; i++) { try { rs[i].set("read", true); $app.save(rs[i]) } catch (_) {} }
    }
    return e.json(200, { ok: true })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "notif_read_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 我的充值申请列表
// ============================================================
routerAdd("GET", "/api/recharges/my", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  try {
    var email = normEmail(e.get("authEmail") || "")
    if (!email) return e.json(401, { ok: false, error: "login_required", code: "LOGIN_REQUIRED", message: "请先登录" })
    var items = []
    try {
      var recs = $app.findRecordsByFilter("recharge_requests", "user_email = {:em}", "-created", 50, 0, { em: email })
      for (var i = 0; i < recs.length; i++) items.push(recs[i].publicExport())
    } catch (_) {}
    return e.json(200, { ok: true, items: items })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "list_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 提交充值申请
// ============================================================
routerAdd("POST", "/api/recharges", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }
  try {
    var email = normEmail(e.get("authEmail") || "")
    if (!email) return e.json(401, { ok: false, error: "login_required", code: "LOGIN_REQUIRED", message: "请先登录" })
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    var amount = Number(body.amount || 0)
    if (!(amount > 0)) return e.json(400, { ok: false, error: "bad_amount", message: "充值金额必须大于 0" })
    if (amount > 100000) return e.json(400, { ok: false, error: "bad_amount", message: "单笔金额过大" })

    var r = new Record($app.findCollectionByNameOrId("recharge_requests"))
    r.set("user_email", email); r.set("amount", round2(amount))
    r.set("pay_method", String(body.pay_method || "wechat").substring(0, 32))
    r.set("note", String(body.note || "").substring(0, 256))
    r.set("status", "pending"); r.set("reviewed_by", ""); r.set("review_note", "")
    $app.save(r)
    return e.json(200, { ok: true, id: r.id, message: "充值申请已提交, 到账后管理员会为你加额度" })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "recharge_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 管理端：总览（管理员身份已由守卫校验；附封禁态）
// ============================================================
routerAdd("GET", "/api/admin/overview", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }
  try {
    var wallets = []
    try {
      var wl = $app.findRecordsByFilter("wallets", "id != ''", "-created", 200, 0)
      for (var i = 0; i < wl.length; i++) {
        var wem = normEmail(wl[i].get("user_email"))
        var banned = false
        try {
          var urec = $app.findFirstRecordByFilter("users", "email = {:em}", { em: wem })
          if (urec && String(urec.get("status") || "") === "banned") banned = true
        } catch (_) {}
        wallets.push({
          id: wl[i].id, email: wl[i].get("user_email"), balance: round2(wl[i].get("balance")),
          held: round2(wl[i].get("held")), is_admin: !!wl[i].get("is_admin"), banned: banned,
          total_recharged: round2(wl[i].get("total_recharged")), total_consumed: round2(wl[i].get("total_consumed")),
        })
      }
    } catch (_) {}
    var pending = []
    try {
      var pl = $app.findRecordsByFilter("recharge_requests", "status = 'pending'", "-created", 100, 0)
      for (var j = 0; j < pl.length; j++) pending.push(pl[j].publicExport())
    } catch (_) {}
    var recentTxns = []
    try {
      var tl = $app.findRecordsByFilter("wallet_txns", "id != ''", "-created", 100, 0)
      for (var k = 0; k < tl.length; k++) recentTxns.push(tl[k].publicExport())
    } catch (_) {}
    return e.json(200, { ok: true, wallets: wallets, pending: pending, recent_txns: recentTxns })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "admin_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 管理端：真实成本看板（按扣费/退款流水净额统计；管理员旁路实扣 RH 也计入）
// ============================================================
routerAdd("GET", "/api/admin/costs", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }
  function nowTs() { return new Date().getTime() }
  function dayKey(d) {
    var y = d.getFullYear()
    var m = ("0" + (d.getMonth() + 1)).slice(-2)
    var day = ("0" + d.getDate()).slice(-2)
    return y + "-" + m + "-" + day
  }
  function prevIso(days) {
    var d = new Date(nowTs() - days * 86400000)
    return dayKey(d) + " 00:00:00.000Z"
  }
  function spaceIso(ms) {
    var d = new Date(ms)
    var p2 = function (n) { return n < 10 ? "0" + n : "" + n }
    var p3 = function (n) { return n < 10 ? "00" + n : (n < 100 ? "0" + n : "" + n) }
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " +
      p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "." + p3(d.getMilliseconds()) + "Z"
  }
  try {
    // 分页拉全量扣费/退款流水（量小可接受；分页 500）
    var all = []
    var page = 1
    for (;;) {
      var batch = []
      try { batch = $app.findRecordsByFilter("wallet_txns", "kind = 'gen' || kind = 'gen_admin' || kind = 'refund' || kind = 'refund_admin'", "-created", 500, (page - 1) * 500) } catch (_) { batch = [] }
      if (!batch || !batch.length) break
      for (var bi = 0; bi < batch.length; bi++) all.push(batch[bi])
      if (batch.length < 500) break
      page += 1
      if (page > 40) break
    }

    // 清扫悬挂 held: 请求在本地被拒(模型未启用/参数错/上游 502)时没有任务、也永不结算,
    // 超过 5 分钟仍 held 视为未真正受理——普通用户退回站内余额并写 void, 管理员只写 void_admin。
    var voidCutoff = spaceIso(nowTs() - 5 * 60000)
    var voidedRefs = {}
    for (var vi = 0; vi < all.length; vi++) {
      var vt = all[vi]
      if (String(vt.get("status") || "") !== "held") continue
      var vCreated = vt.getString("created")
      if (vCreated >= voidCutoff) continue // 太新, 可能还在受理中
      var vRef = String(vt.get("ref") || "")
      if (refundedOrVoid(all, vRef)) continue
      var vKind = String(vt.get("kind") || "")
      var vAmt = Math.abs(Number(vt.get("amount") || 0))
      var vEm = normEmail(vt.get("user_email"))
      try {
        if (vKind === "gen") {
          var vw = null
          try { vw = $app.findFirstRecordByFilter("wallets", "user_email = {:em}", { em: vEm }) } catch (_) { vw = null }
          if (vw) {
            vw.set("balance", round2(Number(vw.get("balance") || 0) + vAmt))
            $app.save(vw)
          }
          var vx1 = new Record($app.findCollectionByNameOrId("wallet_txns"))
          vx1.set("user_email", vEm); vx1.set("kind", "void"); vx1.set("amount", round2(vAmt))
          vx1.set("balance_after", vw ? round2(vw.get("balance")) : 0); vx1.set("ref", "void:" + vRef)
          vx1.set("model", String(vt.get("model") || "")); vx1.set("note", "未受理自动退回"); vx1.set("status", "done")
          $app.save(vx1)
        } else {
          var vx2 = new Record($app.findCollectionByNameOrId("wallet_txns"))
          vx2.set("user_email", vEm); vx2.set("kind", "void_admin"); vx2.set("amount", round2(vAmt))
          vx2.set("balance_after", 0); vx2.set("ref", "void:" + vRef)
          vx2.set("model", String(vt.get("model") || "")); vx2.set("note", "未受理·冲销"); vx2.set("status", "done")
          $app.save(vx2)
        }
        vt.set("status", "void"); $app.save(vt)
        voidedRefs[vRef] = true
      } catch (vwerr) { try { $app.logger().error("held void: " + String(vwerr && vwerr.message || vwerr)) } catch (_) {} }
    }
    function refundedOrVoid(list, ref) {
      for (var z = 0; z < list.length; z++) {
        var kk = String(list[z].get("kind") || "")
        var rr = String(list[z].get("ref") || "")
        if ((kk === "refund" || kk === "refund_admin" || kk === "void" || kk === "void_admin") &&
            (rr === "refund:" + ref || rr === "void:" + ref)) return true
      }
      return false
    }

    var monthStart = dayKey(new Date()).slice(0, 7) + "-01 00:00:00.000Z"
    var todayStart = dayKey(new Date()) + " 00:00:00.000Z"
    var d7Start = prevIso(6)

    var totals = { all: 0, month: 0, today: 0, d7: 0 }
    var split = { admin: 0, user: 0 }
    var callsAll = 0, callsMonth = 0
    var refundedRefs = {}
    var byModel = {}
    var byDay = {}
    var byEmail = {}

    // 退款 / 作废冲销记录（按其 ref 反查扣费，统计时作负向；成功数里剔除被退的扣费）
    var reverseRefs = {}
    for (var ri = 0; ri < all.length; ri++) {
      var kd0 = String(all[ri].get("kind") || "")
      if (kd0 === "refund" || kd0 === "refund_admin" || kd0 === "void" || kd0 === "void_admin") {
        reverseRefs[String(all[ri].get("ref") || "")] = kd0
      }
    }
    // 扣费 ref -> 是否管理员/模型，便于把冲销归到正确分桶
    var chargeMeta = {}
    for (var ci = 0; ci < all.length; ci++) {
      var ck = String(all[ci].get("kind") || "")
      if (ck === "gen" || ck === "gen_admin") {
        chargeMeta[String(all[ci].get("ref") || "")] = { admin: ck === "gen_admin", model: String(all[ci].get("model") || "") || "其他" }
      }
    }

    // 先累加负向冲销（退款/作废），保证净成本正确
    for (var xi = 0; xi < all.length; xi++) {
      var xt = all[xi]
      var xkind = String(xt.get("kind") || "")
      var isReverse = xkind === "refund" || xkind === "refund_admin" || xkind === "void" || xkind === "void_admin"
      if (!isReverse) continue
      var xamt = Math.abs(Number(xt.get("amount") || 0))
      var xcreated = xt.getString("created")
      var xref = String(xt.get("ref") || "")
      var meta = chargeMeta[xref] || {}
      var xAdmin = xkind === "refund_admin" || xkind === "void_admin" || !!meta.admin
      var xModel = String(xt.get("model") || "") || meta.model || "其他"
      if (xcreated >= monthStart) { totals.month -= xamt; if (xAdmin) split.admin -= xamt; else split.user -= xamt }
      if (xcreated >= todayStart) totals.today -= xamt
      if (xcreated >= d7Start) totals.d7 -= xamt
      totals.all -= xamt
      if (!byModel[xModel]) byModel[xModel] = { cost: 0, calls: 0 }
      byModel[xModel].cost -= xamt
      if (xcreated >= d7Start) { var xdk = xcreated.slice(0, 10); byDay[xdk] = (byDay[xdk] || 0) - xamt }
    }

    // 仅累加 settled（真正受理并扣费）的扣费流水；held/void 不计成本
    for (var i = 0; i < all.length; i++) {
      var t = all[i]
      var kind = String(t.get("kind") || "")
      if (kind !== "gen" && kind !== "gen_admin") continue
      if (String(t.get("status") || "") !== "settled") continue
      var amt = Math.abs(Number(t.get("amount") || 0))
      var created = t.getString("created")
      var model = String(t.get("model") || "") || "其他"
      var em = normEmail(t.get("user_email"))
      var inMonth = created >= monthStart
      var inToday = created >= todayStart
      var in7 = created >= d7Start
      var ref = String(t.get("ref") || "")
      var wasReversed = !!reverseRefs["refund:" + ref]

      callsAll += 1
      if (inMonth) callsMonth += 1
      totals.all += amt
      if (inMonth) totals.month += amt
      if (inToday) totals.today += amt
      if (in7) totals.d7 += amt
      if (kind === "gen_admin") split.admin += amt; else split.user += amt

      if (!byModel[model]) byModel[model] = { cost: 0, calls: 0 }
      byModel[model].cost += amt
      if (!wasReversed) byModel[model].calls += 1

      if (created >= d7Start) {
        var dk = created.slice(0, 10)
        if (!byDay[dk]) byDay[dk] = 0
        byDay[dk] += amt
      }
      if (!byEmail[em]) byEmail[em] = { cost: 0, calls: 0 }
      byEmail[em].cost += amt
      if (!wasReversed) byEmail[em].calls += 1
    }

    var modelsArr = []
    for (var mk in byModel) modelsArr.push({ model: mk, cost: round2(byModel[mk].cost), calls: byModel[mk].calls })
    modelsArr.sort(function (a, b) { return b.cost - a.cost })

    var daysArr = []
    for (var d = 6; d >= 0; d--) {
      var key = dayKey(new Date(nowTs() - d * 86400000))
      daysArr.push({ day: key, cost: round2(byDay[key] || 0) })
    }

    var emailArr = []
    for (var ek in byEmail) emailArr.push({ email: ek, cost: round2(byEmail[ek].cost), calls: byEmail[ek].calls })
    emailArr.sort(function (a, b) { return b.cost - a.cost })

    // 退款成功笔数(只数 refund*, 不含未受理的 void*); 成功调用 = 已结算 - 被退
    var refundCount = 0
    for (var rk in reverseRefs) {
      if (reverseRefs[rk] === "refund" || reverseRefs[rk] === "refund_admin") refundCount += 1
    }
    var successAll = Math.max(0, callsAll - refundCount)

    return e.json(200, {
      ok: true,
      total_cost: round2(totals.all),
      month_cost: round2(totals.month),
      today_cost: round2(totals.today),
      last7_cost: round2(totals.d7),
      admin_cost: round2(split.admin),
      user_cost: round2(split.user),
      calls_total: callsAll,
      calls_month: callsMonth,
      success_total: successAll,
      refunded_total: refundCount,
      by_model: modelsArr.slice(0, 12),
      by_day: daysArr,
      top_users: emailArr.slice(0, 10),
      note: "按应用内统一单价统计的真实生成成本净额(失败任务已冲销), 与创作者 RunningHub 账户实扣口径一致; 具体单价以 RunningHub 控制台为准。",
    })
  } catch (err) {
    var emsg = String(err && err.message || err)
    return e.json(500, { error: "costs_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 管理端：经营看板（任意时间范围）
//   body: { range:'today'|'yesterday'|'7d'|'30d'|'6m'|'1y'|'all'|'custom',
//           start?: 'YYYY-MM-DD', end?: 'YYYY-MM-DD' }
//   口径: 调用次数/任务状态来自 aigc_tasks; 真实消耗来自 settled 扣费流水净额(失败冲销);
//         客户充值来自 approved recharge_requests; 站内钱包余额合计来自 wallets。
// ============================================================
routerAdd("POST", "/api/admin/stats", function (e) {
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }
  function pad(n) { return n < 10 ? "0" + n : "" + n }
  function isoStart(y, m, d) { return y + "-" + pad(m + 1) + "-" + pad(d) + " 00:00:00.000Z" }
  function dayKeyOf(dt) { return dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate()) }
  function monthKeyOf(dt) { return dt.getFullYear() + "-" + pad(dt.getMonth() + 1) }
  function pad3(n) { return n < 10 ? "00" + n : (n < 100 ? "0" + n : "" + n) }
  function spaceIso(ms) {
    var d = new Date(ms)
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + pad3(d.getMilliseconds()) + "Z"
  }
  try {
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    var range = String(body.range || "today")
    var now = new Date()
    var startMs = 0, endMs = now.getTime() + 86400000, haveStart = true
    var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

    if (range === "today") { startMs = todayStart }
    else if (range === "yesterday") { startMs = todayStart - 86400000; endMs = todayStart }
    else if (range === "7d") { startMs = todayStart - 6 * 86400000 }
    else if (range === "30d") { startMs = todayStart - 29 * 86400000 }
    else if (range === "6m") { startMs = todayStart - 182 * 86400000 }
    else if (range === "1y") { startMs = todayStart - 365 * 86400000 }
    else if (range === "custom") {
      var s = String(body.start || ""), en = String(body.end || "")
      if (s) { var sp = s.split("-"); startMs = new Date(Number(sp[0]), Number(sp[1]) - 1, Number(sp[2])).getTime() } else { haveStart = false }
      if (en) { var ep = en.split("-"); endMs = new Date(Number(ep[0]), Number(ep[1]) - 1, Number(ep[2])).getTime() + 86400000 }
    } else { haveStart = false } // all

    var startIso = haveStart ? spaceIso(startMs) : ""
    var endIso = spaceIso(endMs)
    function inRange(created) {
      var c = String(created || "")
      if (haveStart && c < startIso) return false
      if (c >= endIso) return false
      return true
    }

    function allRecords(coll) {
      var out = [], pg = 1
      for (;;) {
        var b = []
        try { b = $app.findRecordsByFilter(coll, "id != ''", "-created", 500, (pg - 1) * 500) } catch (_) { b = [] }
        if (!b.length) break
        for (var i = 0; i < b.length; i++) out.push(b[i])
        if (b.length < 500) break
        pg += 1; if (pg > 60) break
      }
      return out
    }

    // ---- 任务：调用次数 / 状态 / 按模型 / 按用户 / 趋势 ----
    var tasks = allRecords("aigc_tasks")
    var callTotal = 0, stSuccess = 0, stFailed = 0, stRunning = 0
    var byModel = {}, byUser = {}, trend = {}
    var spanDays = haveStart ? Math.max(1, Math.round((endMs - startMs) / 86400000)) : 30
    var trendByMonth = spanDays > 90
    for (var ti = 0; ti < tasks.length; ti++) {
      var t = tasks[ti]
      var tc = t.getString("created")
      if (!inRange(tc)) continue
      callTotal += 1
      var tst = String(t.get("status") || "running")
      if (tst === "success") stSuccess += 1
      else if (tst === "failed") stFailed += 1
      else stRunning += 1
      var mk = String(t.get("model_name") || "其他")
      if (!byModel[mk]) byModel[mk] = { calls: 0, success: 0, failed: 0 }
      byModel[mk].calls += 1
      if (tst === "success") byModel[mk].success += 1; else if (tst === "failed") byModel[mk].failed += 1
      var ue = String(t.get("user_email") || "").trim().toLowerCase() || "(未知用户)"
      if (!byUser[ue]) byUser[ue] = { calls: 0, success: 0, failed: 0 }
      byUser[ue].calls += 1
      if (tst === "success") byUser[ue].success += 1; else if (tst === "failed") byUser[ue].failed += 1
      var tk = trendByMonth ? tc.slice(0, 7) : tc.slice(0, 10)
      trend[tk] = (trend[tk] || 0) + 1
    }

    // ---- 流水：真实消耗净额(settled 扣费 - 退款/作废), 分管理员/用户 ----
    var txns = allRecords("wallet_txns")
    var netCost = 0, adminCost = 0, userCost = 0, trendCost = {}
    var refundedRefs = {}
    for (var ri2 = 0; ri2 < txns.length; ri2++) {
      var kk = String(txns[ri2].get("kind") || "")
      if (kk === "refund" || kk === "refund_admin") refundedRefs[String(txns[ri2].get("ref") || "")] = true
    }
    for (var xi = 0; xi < txns.length; xi++) {
      var x = txns[xi]
      var xc = x.getString("created")
      if (!inRange(xc)) continue
      var xk = String(x.get("kind") || "")
      var xamt = Math.abs(Number(x.get("amount") || 0))
      var xkey = trendByMonth ? xc.slice(0, 7) : xc.slice(0, 10)
      if (xk === "gen" || xk === "gen_admin") {
        if (String(x.get("status") || "") !== "settled") continue
        netCost += xamt
        if (xk === "gen_admin") adminCost += xamt; else userCost += xamt
        trendCost[xkey] = (trendCost[xkey] || 0) + xamt
      } else if (xk === "refund" || xk === "refund_admin") {
        netCost -= xamt
        if (xk === "refund_admin") adminCost -= xamt; else userCost -= xamt
        trendCost[xkey] = (trendCost[xkey] || 0) - xamt
      }
    }

    // ---- 充值：客户真实到账(approved) ----
    var rechargeTotal = 0
    try {
      var reqs = allRecords("recharge_requests")
      for (var qi = 0; qi < reqs.length; qi++) {
        if (String(reqs[qi].get("status") || "") !== "approved") continue
        if (!inRange(reqs[qi].getString("created"))) continue
        rechargeTotal += Number(reqs[qi].get("amount") || 0)
      }
    } catch (_) {}

    // ---- 站内钱包余额合计（当前值, 不按时间过滤）----
    var walletSum = 0
    try {
      var ws = allRecords("wallets")
      for (var wi = 0; wi < ws.length; wi++) walletSum += Number(ws[wi].get("balance") || 0)
    } catch (_) {}

    // ---- 趋势序列（补齐空桶）----
    var trendArr = []
    if (haveStart && range !== "all") {
      if (trendByMonth) {
        var cur = new Date(startMs)
        for (var guard = 0; guard < 24; guard++) {
          var mkey = monthKeyOf(cur)
          if (new Date(cur.getFullYear(), cur.getMonth(), 1).getTime() >= endMs) break
          trendArr.push({ bucket: mkey, calls: trend[mkey] || 0, cost: round2(trendCost[mkey] || 0) })
          cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1)
        }
      } else {
        for (var d = 0; d < spanDays && d < 400; d++) {
          var dd = new Date(startMs + d * 86400000)
          var dkey = dayKeyOf(dd)
          trendArr.push({ bucket: dkey.slice(5), calls: trend[dkey] || 0, cost: round2(trendCost[dkey] || 0) })
        }
      }
    } else {
      for (var ek in trend) trendArr.push({ bucket: ek, calls: trend[ek] || 0, cost: round2(trendCost[ek] || 0) })
      trendArr.sort(function (a, b) { return a.bucket < b.bucket ? -1 : 1 })
    }

    var modelArr = []
    for (var mm in byModel) modelArr.push({ model: mm, calls: byModel[mm].calls, success: byModel[mm].success, failed: byModel[mm].failed })
    modelArr.sort(function (a, b) { return b.calls - a.calls })
    var userArr = []
    for (var um in byUser) userArr.push({ email: um, calls: byUser[um].calls, success: byUser[um].success, failed: byUser[um].failed })
    userArr.sort(function (a, b) { return b.calls - a.calls })

    return e.json(200, {
      ok: true, range: range, start: haveStart ? dayKeyOf(new Date(startMs)) : null, end: dayKeyOf(new Date(endMs - 1)),
      calls_total: callTotal,
      status: { success: stSuccess, failed: stFailed, running: stRunning },
      net_cost: round2(netCost), admin_cost: round2(adminCost), user_cost: round2(userCost),
      recharge_total: round2(rechargeTotal), wallet_balance_sum: round2(walletSum),
      trend: trendArr,
      by_model: modelArr.slice(0, 20),
      top_users: userArr.slice(0, 20),
      note: "消耗为按应用内统一单价统计的真实生成成本净额(失败已冲销), 与 RunningHub 实扣口径一致; 具体单价以 RunningHub 控制台为准。",
    })
  } catch (err) {
    var m = String(err && err.message || err)
    return e.json(500, { error: "stats_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 管理端：单用户明细下钻（沿用时间范围）
//   body: { email, range, start?, end? }
// ============================================================
routerAdd("POST", "/api/admin/user-stats", function (e) {
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }
  function pad(n) { return n < 10 ? "0" + n : "" + n }
  function dayKeyOf(dt) { return dt.getFullYear() + "-" + pad(dt.getMonth() + 1) + "-" + pad(dt.getDate()) }
  function pad3(n) { return n < 10 ? "00" + n : (n < 100 ? "0" + n : "" + n) }
  function spaceIso(ms) {
    var d = new Date(ms)
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + pad3(d.getMilliseconds()) + "Z"
  }
  try {
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    var email = String(body.email || "").trim().toLowerCase()
    if (!email) return e.json(400, { ok: false, error: "email_required", message: "缺少用户邮箱" })

    var u = null
    try { u = $app.findFirstRecordByFilter("users", "email = {:em}", { em: email }) } catch (_) { u = null }
    if (!u) return e.json(200, { ok: true, found: false, email: email, message: "该邮箱还没有注册账号" })

    // 时间范围
    var range = String(body.range || "all")
    var now = new Date()
    var startMs = 0, endMs = now.getTime() + 86400000, haveStart = false
    var todayStart0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    if (range === "today") { startMs = todayStart0; haveStart = true }
    else if (range === "yesterday") { startMs = todayStart0 - 86400000; endMs = todayStart0; haveStart = true }
    else if (range === "7d") { startMs = todayStart0 - 6 * 86400000; haveStart = true }
    else if (range === "30d") { startMs = todayStart0 - 29 * 86400000; haveStart = true }
    else if (range === "6m") { startMs = todayStart0 - 182 * 86400000; haveStart = true }
    else if (range === "1y") { startMs = todayStart0 - 365 * 86400000; haveStart = true }
    else if (range === "custom") {
      var sp = String(body.start || "").split("-"), ep2 = String(body.end || "").split("-")
      if (sp.length === 3) { startMs = new Date(Number(sp[0]), Number(sp[1]) - 1, Number(sp[2])).getTime(); haveStart = true }
      if (ep2.length === 3) endMs = new Date(Number(ep2[0]), Number(ep2[1]) - 1, Number(ep2[2])).getTime() + 86400000
    }
    var startIso = haveStart ? spaceIso(startMs) : ""
    var endIso = spaceIso(endMs)
    function inRange(c) { c = String(c || ""); return (!haveStart || c >= startIso) && c < endIso }

    // 钱包（当前快照）
    var w = null
    try { w = $app.findFirstRecordByFilter("wallets", "user_email = {:em}", { em: email }) } catch (_) { w = null }

    function findByUser(coll) {
      var out = [], pg = 1
      for (;;) {
        var b = []
        try { b = $app.findRecordsByFilter(coll, "user_email = {:em}", "-created", 500, (pg - 1) * 500, { em: email }) } catch (_) { b = [] }
        if (!b.length) break
        for (var i = 0; i < b.length; i++) out.push(b[i])
        if (b.length < 500) break
        pg += 1; if (pg > 40) break
      }
      return out
    }

    // 任务
    var tasks = findByUser("aigc_tasks")
    var callTotal = 0, stS = 0, stF = 0, stR = 0, byModel = {}, recentTasks = []
    for (var ti = 0; ti < tasks.length; ti++) {
      var t = tasks[ti]
      var tc = t.getString("created")
      if (!inRange(tc)) continue
      callTotal += 1
      var tst = String(t.get("status") || "running")
      if (tst === "success") stS += 1; else if (tst === "failed") stF += 1; else stR += 1
      var mk = String(t.get("model_name") || "其他")
      if (!byModel[mk]) byModel[mk] = { calls: 0, success: 0, failed: 0 }
      byModel[mk].calls += 1
      if (tst === "success") byModel[mk].success += 1; else if (tst === "failed") byModel[mk].failed += 1
      if (recentTasks.length < 30) recentTasks.push({
        id: String(t.get("task_id") || ""), model: mk, status: tst,
        prompt: String(t.get("prompt") || "").substring(0, 80),
        cost: String(t.get("third_party_consume_money") || t.get("consume_money") || ""),
        created: tc,
      })
    }

    // 流水（区间净成本 + 全部最近流水）
    var txns = findByUser("wallet_txns")
    var netCost = 0, adminCost = 0
    var refundRefs = {}
    for (var ri = 0; ri < txns.length; ri++) {
      if (String(txns[ri].get("kind") || "") === "refund" || String(txns[ri].get("kind") || "") === "refund_admin")
        refundRefs[String(txns[ri].get("ref") || "")] = true
    }
    var recentTxns = []
    for (var xi = 0; xi < txns.length; xi++) {
      var x = txns[xi]
      var xc = x.getString("created")
      var xk = String(x.get("kind") || "")
      if (recentTxns.length < 30) recentTxns.push({
        kind: xk, amount: round2(x.get("amount")), note: String(x.get("note") || ""),
        model: String(x.get("model") || ""), status: String(x.get("status") || ""), created: xc,
      })
      if (!inRange(xc)) continue
      var xa = Math.abs(Number(x.get("amount") || 0))
      if (xk === "gen_admin") { if (String(x.get("status") || "") === "settled") { netCost += xa; adminCost += xa } }
      else if (xk === "gen") { if (String(x.get("status") || "") === "settled") netCost += xa }
      else if (xk === "refund" || xk === "refund_admin") { netCost -= xa; if (xk === "refund_admin") adminCost -= xa }
    }

    // 区间充值到账
    var recharge = 0
    try {
      var reqs = findByUser("recharge_requests")
      for (var qi = 0; qi < reqs.length; qi++) {
        if (String(reqs[qi].get("status") || "") !== "approved") continue
        if (inRange(reqs[qi].getString("created"))) recharge += Number(reqs[qi].get("amount") || 0)
      }
    } catch (_) {}

    var modelArr = []
    for (var mm in byModel) modelArr.push({ model: mm, calls: byModel[mm].calls, success: byModel[mm].success, failed: byModel[mm].failed })
    modelArr.sort(function (a, b) { return b.calls - a.calls })

    return e.json(200, {
      ok: true, found: true, email: email,
      name: String(u.get("name") || ""),
      banned: String(u.get("status") || "") === "banned",
      is_admin: w ? !!w.get("is_admin") : false,
      created: u.getString("created"),
      wallet: {
        balance: w ? round2(w.get("balance")) : 0,
        total_recharged: w ? round2(w.get("total_recharged")) : 0,
        total_consumed: w ? round2(w.get("total_consumed")) : 0,
      },
      range: range, start: haveStart ? dayKeyOf(new Date(startMs)) : null, end: dayKeyOf(new Date(endMs - 1)),
      calls_total: callTotal,
      status: { success: stS, failed: stF, running: stR },
      net_cost: round2(netCost), admin_cost: round2(adminCost),
      recharge_in_range: round2(recharge),
      by_model: modelArr,
      recent_tasks: recentTasks,
      recent_txns: recentTxns,
    })
  } catch (err) {
    var emsg = String(err && err.message || err)
    return e.json(500, { error: "user_stats_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 管理端：通过充值申请
// ============================================================
routerAdd("POST", "/api/admin/recharges/{id}/approve", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }
  function notify(em, kind, title, body, amount, balAfter) {
    try {
      var n = new Record($app.findCollectionByNameOrId("notifications"))
      n.set("user_email", normEmail(em)); n.set("kind", kind); n.set("title", title)
      n.set("body", body); n.set("amount", Number(amount) || 0); n.set("balance_after", Number(balAfter) || 0); n.set("read", false)
      $app.save(n)
    } catch (_) {}
  }
  function getWallet(em) {
    var rec = null
    try { rec = $app.findRecordsByFilter("wallets", "user_email = {:em}", "", 1, 0, { em: em })[0] } catch (_) { rec = null }
    if (rec) return rec
    rec = new Record($app.findCollectionByNameOrId("wallets"))
    rec.set("user_email", em); rec.set("balance", 0); rec.set("held", 0)
    rec.set("is_admin", false); rec.set("total_recharged", 0); rec.set("total_consumed", 0)
    $app.save(rec); return rec
  }
  try {
    var adminEmail = normEmail(e.get("authEmail") || "")
    var id = e.request.pathValue("id")
    var rec = null
    try { rec = $app.findRecordById("recharge_requests", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { ok: false, error: "not_found", message: "申请不存在" })
    if (String(rec.get("status") || "") !== "pending") return e.json(400, { ok: false, error: "already_handled", message: "该申请已处理" })

    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    var targetEmail = normEmail(rec.get("user_email") || "")
    var amount = Number(body.amount || rec.get("amount") || 0)
    if (!(amount > 0)) return e.json(400, { ok: false, error: "bad_amount", message: "金额无效" })

    var w = getWallet(targetEmail)
    var b = round2(Number(w.get("balance") || 0) + amount)
    w.set("balance", b)
    w.set("total_recharged", round2(Number(w.get("total_recharged") || 0) + amount))
    $app.save(w)
    try {
      var t = new Record($app.findCollectionByNameOrId("wallet_txns"))
      t.set("user_email", targetEmail); t.set("kind", "recharge"); t.set("amount", round2(amount))
      t.set("balance_after", round2(b)); t.set("ref", "recharge:" + rec.id); t.set("model", "")
      t.set("note", "充值到账(管理员审核)"); t.set("status", "done"); $app.save(t)
    } catch (_) {}

    rec.set("status", "approved"); rec.set("reviewed_by", adminEmail)
    rec.set("review_note", String(body.note || "已到账").substring(0, 256))
    $app.save(rec)
    notify(targetEmail, "recharge", "充值已到账 +¥" + round2(amount),
      "你提交的 ¥" + round2(amount) + " 充值已审核通过并到账, 当前余额 ¥" + round2(b), amount, b)
    return e.json(200, { ok: true, balance: b })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "approve_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 管理端：拒绝充值申请
// ============================================================
routerAdd("POST", "/api/admin/recharges/{id}/reject", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  try {
    var adminEmail = normEmail(e.get("authEmail") || "")
    var id = e.request.pathValue("id")
    var rec = null
    try { rec = $app.findRecordById("recharge_requests", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { ok: false, error: "not_found", message: "申请不存在" })
    if (String(rec.get("status") || "") !== "pending") return e.json(400, { ok: false, error: "already_handled", message: "该申请已处理" })

    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    rec.set("status", "rejected"); rec.set("reviewed_by", adminEmail)
    rec.set("review_note", String(body.note || "未查到到账").substring(0, 256))
    $app.save(rec)
    return e.json(200, { ok: true })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "reject_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 管理端：按邮箱查询用户余额/状态（用户不存在与无钱包要区分清楚）
// ============================================================
routerAdd("POST", "/api/admin/wallets/lookup", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }
  try {
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    var target = normEmail(body.email || "")
    if (!target) return e.json(400, { ok: false, error: "email_required", message: "请输入用户邮箱" })

    var u = null
    try { u = $app.findFirstRecordByFilter("users", "email = {:em}", { em: target }) } catch (_) { u = null }
    if (!u) return e.json(200, { ok: true, found: false, email: target, message: "该邮箱还没有注册账号" })

    var w = null
    try { w = $app.findRecordsByFilter("wallets", "user_email = {:em}", "", 1, 0, { em: target })[0] } catch (_) { w = null }
    return e.json(200, {
      ok: true, found: true, email: target,
      name: String(u.get("name") || ""),
      balance: w ? round2(w.get("balance")) : 0,
      total_recharged: w ? round2(w.get("total_recharged")) : 0,
      total_consumed: w ? round2(w.get("total_consumed")) : 0,
      is_admin: w ? !!w.get("is_admin") : false,
      banned: String(u.get("status") || "") === "banned",
      created: u.getString("created"),
    })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "lookup_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 管理端：手动调整额度
// ============================================================
routerAdd("POST", "/api/admin/wallets/adjust", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  function round2(n) { return Math.round(Number(n || 0) * 100) / 100 }
  function nowMs() { return new Date().getTime() }
  function notify(em, kind, title, body, amount, balAfter) {
    try {
      var n = new Record($app.findCollectionByNameOrId("notifications"))
      n.set("user_email", normEmail(em)); n.set("kind", kind); n.set("title", title)
      n.set("body", body); n.set("amount", Number(amount) || 0); n.set("balance_after", Number(balAfter) || 0); n.set("read", false)
      $app.save(n)
    } catch (_) {}
  }
  function getWallet(em) {
    var rec = null
    try { rec = $app.findRecordsByFilter("wallets", "user_email = {:em}", "", 1, 0, { em: em })[0] } catch (_) { rec = null }
    if (rec) return rec
    rec = new Record($app.findCollectionByNameOrId("wallets"))
    rec.set("user_email", em); rec.set("balance", 0); rec.set("held", 0)
    rec.set("is_admin", false); rec.set("total_recharged", 0); rec.set("total_consumed", 0)
    $app.save(rec); return rec
  }
  try {
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    var targetEmail = normEmail(body.email || "")
    var delta = Number(body.amount || 0)
    if (!targetEmail) return e.json(400, { ok: false, error: "email_required", message: "缺少用户邮箱" })
    if (!(delta !== 0)) return e.json(400, { ok: false, error: "bad_amount", message: "调整金额不能为 0" })
    var targetUser = null
    try { targetUser = $app.findFirstRecordByFilter("users", "email = {:em}", { em: targetEmail }) } catch (_) { targetUser = null }
    if (!targetUser) return e.json(404, { ok: false, error: "user_not_found", message: "该邮箱还没有注册账号, 无法调整" })

    var w = getWallet(targetEmail)
    var b = round2(Number(w.get("balance") || 0) + delta)
    if (b < 0) b = 0
    w.set("balance", b)
    if (delta > 0) w.set("total_recharged", round2(Number(w.get("total_recharged") || 0) + delta))
    $app.save(w)
    try {
      var t = new Record($app.findCollectionByNameOrId("wallet_txns"))
      t.set("user_email", targetEmail); t.set("kind", delta > 0 ? "admin_add" : "admin_sub"); t.set("amount", round2(delta))
      t.set("balance_after", round2(b)); t.set("ref", "adjust:" + nowMs()); t.set("model", "")
      t.set("note", String(body.note || "管理员调整").substring(0, 256)); t.set("status", "done"); $app.save(t)
    } catch (_) {}
    var adjNote = String(body.note || "").trim()
    if (delta > 0) {
      notify(targetEmail, "admin_add", "额度已增加 +¥" + round2(delta),
        "管理员为你的账户增加了 ¥" + round2(delta) + (adjNote ? "(备注: " + adjNote + ")" : "") + ", 当前余额 ¥" + round2(b), delta, b)
    } else {
      notify(targetEmail, "admin_sub", "额度已扣减 -¥" + round2(Math.abs(delta)),
        "管理员扣减了 ¥" + round2(Math.abs(delta)) + (adjNote ? "(备注: " + adjNote + ")" : "") + ", 当前余额 ¥" + round2(b), delta, b)
    }
    return e.json(200, { ok: true, balance: b })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "adjust_failed", message: "操作失败, 请稍后重试" })
  }
})

// ============================================================
// 管理端：封禁 / 解封用户（写 users.status）
// ============================================================
routerAdd("POST", "/api/admin/users/set-status", function (e) {
  function normEmail(s) { return String(s || "").trim().toLowerCase() }
  try {
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    var targetEmail = normEmail(body.email || "")
    var ban = body.status === "banned"
    if (!targetEmail) return e.json(400, { ok: false, error: "email_required", message: "缺少用户邮箱" })
    var selfEmail = normEmail(e.get("authEmail") || "")
    if (selfEmail === targetEmail && ban) {
      return e.json(400, { ok: false, error: "self_ban", message: "不能停用自己的账号" })
    }
    var target = null
    try { target = $app.findFirstRecordByFilter("users", "email = {:em}", { em: targetEmail }) } catch (_) { target = null }
    if (!target) return e.json(404, { ok: false, error: "not_found", message: "用户不存在" })
    target.set("status", ban ? "banned" : "")
    $app.save(target)
    return e.json(200, { ok: true, email: targetEmail, status: ban ? "banned" : "active" })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "set_status_failed", message: "操作失败, 请稍后重试" })
  }
})
