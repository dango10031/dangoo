/// <reference path="../pb_data/types.d.ts" />
// pb_hooks/canvases.pb.js — 业务 collection + REST CRUD 路由 (self-contained)
//
// 由 mcp__rh-pb-hooks__install_business_collection 装. 不要直接 Read+Write 这个文件.
// 业务字段: title:text, is_deleted:bool, thumbnail_url:text, canvas_data:json
// 路由: list,get,create,update,delete
// list filter 字段: is_deleted
// list 默认排序: -updated

onBootstrap(function (e) {
  e.next()
  try {
    var existing = null
    try { existing = $app.findCollectionByNameOrId("canvases") } catch (_) { existing = null }
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
      function addField(def) {
        if (hasField(def.name)) return
        try { existing.fields.add(new Field(def)); changed = true } catch (_) {}
      }
      addField({ name: 'title', type: 'text', required: true, max: 120 })
      addField({ name: 'is_deleted', type: 'bool' })
      addField({ name: 'thumbnail_url', type: 'text', max: 500 })
      addField({ name: 'canvas_data', type: 'json' })
      addField({ name: 'rh_user_id', type: 'text', max: 64 })
      addField({ name: "created", type: "autodate", onCreate: true })
      addField({ name: "updated", type: "autodate", onCreate: true, onUpdate: true })
      if (changed) {
        $app.save(existing)
        try { $app.logger().info("canvases collection upgraded") } catch (_) {}
      }
    } else {
      var col = new Collection({
        type: "base",
        name: "canvases",
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        fields: [
          { name: 'title', type: 'text', required: true, max: 120 },
          { name: 'is_deleted', type: 'bool' },
          { name: 'thumbnail_url', type: 'text', max: 500 },
          { name: 'canvas_data', type: 'json' },
          { name: 'rh_user_id', type: 'text', max: 64 },
          { name: "created", type: "autodate", onCreate: true },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        ],
      })
      $app.save(col)
      try { $app.logger().info("canvases collection created") } catch (_) {}
    }
    // 幂等键集合(内容保存去重, 10 分钟 TTL, 由保存逻辑惰性清理)
    try {
      var idemCol = null
      try { idemCol = $app.findCollectionByNameOrId("canvas_idem") } catch (_) { idemCol = null }
      if (!idemCol) {
        $app.save(new Collection({
          type: "base",
          name: "canvas_idem",
          listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
          fields: [
            { name: 'owner', type: 'text', max: 120 },
            { name: 'idem_key', type: 'text', max: 80 },
            { name: 'canvas_id', type: 'text', max: 40 },
            { name: 'rev', type: 'number' },
            { name: 'expire_at', type: 'number' },
          ],
        }))
        try { $app.logger().info("canvas_idem collection created") } catch (_) {}
      }
    } catch (ierr) {
      try { $app.logger().error("canvas_idem bootstrap: " + String(ierr && ierr.message || ierr)) } catch (_) {}
    }
    // 归属回填(严格一次性, 发布安全): 仅在「纯遗留态」执行——当前不存在任何已归属画布
    // (说明从未做过归属)、素材库恰好唯一创作者、且确有无主画布时, 才把无主画布归给他。
    // 一旦库里出现任意已归属画布(迁移已发生过 / 已是多用户正式环境), 永远跳过,
    // 杜绝发布重启后把他人无主历史画布误划到某个用户名下造成数据混乱。只加字段不改内容。
    try {
      var ownedAny = $app.findRecordsByFilter("canvases", "rh_user_id != ''", "", 1, 0)
      if (!ownedAny || ownedAny.length === 0) {
        var ownerIds = {}
        var ownerCount = 0
        var aset = $app.findRecordsByFilter("assets", "rh_user_id != ''", "", 200, 0)
        for (var ai = 0; ai < aset.length; ai++) {
          var oid = String(aset[ai].get("rh_user_id") || "")
          if (oid && !ownerIds[oid]) { ownerIds[oid] = 1; ownerCount += 1 }
        }
        if (ownerCount === 1) {
          var onlyOwner = ""
          for (var ok in ownerIds) onlyOwner = ok
          var orphans = $app.findRecordsByFilter("canvases", "rh_user_id = ''", "", 500, 0)
          for (var oi = 0; oi < orphans.length; oi++) {
            orphans[oi].set("rh_user_id", onlyOwner)
            $app.save(orphans[oi])
          }
          if (orphans.length) { try { $app.logger().info("canvases backfilled owner x" + orphans.length) } catch (_) {} }
        }
      }
    } catch (_) {}
  } catch (err) {
    try { $app.logger().error("canvases bootstrap: " + String(err && err.message || err)) } catch (_) {}
  }
})

// GET /api/canvases?page=1&perPage=50&sort=-created&is_deleted=...
routerAdd("GET", "/api/canvases", function (e) {
  function ensureCollLocal() {
    try { return $app.findCollectionByNameOrId("canvases") } catch (_) {}
    var col = new Collection({
      type: "base",
      name: "canvases",
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
          { name: 'title', type: 'text', required: true, max: 120 },
          { name: 'is_deleted', type: 'bool' },
          { name: 'thumbnail_url', type: 'text', max: 500 },
          { name: 'canvas_data', type: 'json' },
          { name: 'rh_user_id', type: 'text', max: 64 },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    })
    $app.save(col)
    return $app.findCollectionByNameOrId("canvases")
  }
  try {
    ensureCollLocal()
    var info = e.requestInfo()
    var query = info.query || {}
    var page = parseInt(String(query.page || "1"), 10) || 1
    var perPage = parseInt(String(query.perPage || "50"), 10) || 50
    if (perPage > 200) perPage = 200
    var sort = String(query.sort || "-updated")
    // 按账号隔离: 只认平台注入的登录 ID, 未登录返回空列表; 禁止 query 自报身份
    var me = ""
    try { me = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!me) return e.json(200, { items: [], page: page, perPage: perPage, totalItems: 0 })
    var filterParts = ["rh_user_id = {:me}"]
    var params = { me: me }
    if (query.is_deleted !== undefined && query.is_deleted !== "") {
      filterParts.push("is_deleted = {:is_deleted}")
      params.is_deleted = String(query.is_deleted)
    }
    var filter = filterParts.length > 0 ? filterParts.join(" && ") : ""
    var records = filter
      ? $app.findRecordsByFilter("canvases", filter, sort, perPage, (page - 1) * perPage, params)
      : $app.findRecordsByFilter("canvases", "", sort, perPage, (page - 1) * perPage)
    var items = []
    for (var i = 0; i < records.length; i++) {
      items.push(records[i].publicExport())
    }
    // 真实总数(不是当页条数), 供前端分页/加载更多
    var totalItems = 0
    try {
      totalItems = filter
        ? $app.countRecords("canvases", filter, params)
        : $app.countRecords("canvases", "")
    } catch (_) { totalItems = items.length }
    var totalPages = perPage > 0 ? Math.ceil(totalItems / perPage) : 1
    return e.json(200, { items: items, page: page, perPage: perPage, totalItems: totalItems, totalPages: totalPages })
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("canvases list: " + msg) } catch (_) {}
    return e.json(500, { error: "list_failed", message: "操作失败, 请稍后重试" })
  }
})
// GET /api/canvases/{id}
routerAdd("GET", "/api/canvases/{id}", function (e) {
  try {
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required" })
    var rec = null
    try { rec = $app.findRecordById("canvases", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "not_found" })
    var meG = ""
    try { meG = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    // 画布仅属主可读, 防止 ID 枚举泄露内容
    if (!meG || String(rec.get("rh_user_id")) !== meG) return e.json(404, { error: "not_found" })
    return e.json(200, rec.publicExport())
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "get_failed", message: "操作失败, 请稍后重试" })
  }
})
// POST /api/canvases  body 字段: title, is_deleted, thumbnail_url, canvas_data
routerAdd("POST", "/api/canvases", function (e) {
  function ensureCollLocal() {
    try { return $app.findCollectionByNameOrId("canvases") } catch (_) {}
    var col = new Collection({
      type: "base",
      name: "canvases",
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
          { name: 'title', type: 'text', required: true, max: 120 },
          { name: 'is_deleted', type: 'bool' },
          { name: 'thumbnail_url', type: 'text', max: 500 },
          { name: 'canvas_data', type: 'json' },
          { name: 'rh_user_id', type: 'text', max: 64 },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    })
    $app.save(col)
    return $app.findCollectionByNameOrId("canvases")
  }
  try {
    var coll = ensureCollLocal()
    var body = e.requestInfo().body || {}
    var meC = ""
    try { meC = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!meC) return e.json(412, { error: "login_required", message: "请先登录后再创建画布" })
    var rec = new Record(coll)
    rec.set("title", body.title === undefined || body.title === null ? "" : String(body.title))
    rec.set("is_deleted", !!body.is_deleted)
    rec.set("thumbnail_url", body.thumbnail_url === undefined || body.thumbnail_url === null ? "" : String(body.thumbnail_url))
    rec.set("canvas_data", body.canvas_data)
    rec.set("rh_user_id", meC)
    $app.save(rec)
    return e.json(200, rec.publicExport())
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("canvases create: " + msg) } catch (_) {}
    return e.json(500, { error: "create_failed", message: "操作失败, 请稍后重试" })
  }
})
// 幂等存储(canvas_idem 集合持久化): 解决「服务端已保存成功但响应丢失,
// 客户端重试被乐观锁误判 409」的伪冲突。10 分钟 TTL, 保存时惰性清理。
// 不能用进程级变量: Goja 每个路由回调在独立执行环境运行, 文件级变量不跨请求共享。

// PATCH /api/canvases/{id}  body 字段同 POST, 只更新 body 里出现的字段
routerAdd("PATCH", "/api/canvases/{id}", function (e) {
  // Manual saves and Agent commands must serialize the read/check/write together.
  var outcome = null
  function respond(status, data) { return { status: status, data: data } }
  try {
    $app.runInTransaction(function (txApp) {
      outcome = (function ($app) {

  try {
    var id = e.request.pathValue("id")
    if (!id) return respond(400, { error: "id_required" })
    var rec = null
    try { rec = $app.findRecordById("canvases", id) } catch (_) { rec = null }
    if (!rec) return respond(404, { error: "not_found" })
    var meU = ""
    try { meU = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!meU || String(rec.get("rh_user_id")) !== meU) return respond(404, { error: "not_found" })
    var body = e.requestInfo().body || {}
    // 幂等: 仅内容保存(非纯视角)带 X-Idempotency-Key。命中本用户 10 分钟内同键直接回放上次成功结果
    var idemKey = ""
    try {
      // 网关注入后请求头键统一为小写下划线形态(如 x_idempotency_key), 兼容连字符/驼峰写法
      var ih = (e.requestInfo() || {}).headers || {}
      idemKey = String(ih["x_idempotency_key"] || ih["X-Idempotency-Key"] || ih["x-idempotency-key"] || "").trim()
    } catch (_) { idemKey = "" }
    var idemRecId = ""
    if (idemKey && body.canvas_view_only !== true) {
      try {
        var idemRecs = $app.findRecordsByFilter("canvas_idem", "owner = {:o} && idem_key = {:k}", "", 1, 0, { o: meU, k: idemKey })
        if (idemRecs && idemRecs.length > 0) {
          var idemHit = idemRecs[0]
          if (String(idemHit.get("canvas_id")) === id && Number(idemHit.get("expire_at") || 0) > new Date().getTime()) {
            return respond(200, rec.publicExport())
          }
        }
        // 记录行 id 供保存成功后更新(不存在则新建), 避免同键重复落多行
        if (idemRecs && idemRecs.length > 0) idemRecId = idemRecs[0].id
      } catch (iErr) { idemRecId = ""; try { $app.logger().error("idem lookup FAIL: " + String(iErr && iErr.message || iErr)) } catch (_) {} }
    }
    if ("title" in body) rec.set("title", body.title === undefined || body.title === null ? "" : String(body.title))
    if ("is_deleted" in body) rec.set("is_deleted", !!body.is_deleted)
    if ("thumbnail_url" in body) rec.set("thumbnail_url", body.thumbnail_url === undefined || body.thumbnail_url === null ? "" : String(body.thumbnail_url))
    if ("canvas_data" in body) {
      var incoming = body.canvas_data || {}
      // 乐观锁: 前端带 canvas_rev 时, 必须等于服务端当前 rev, 否则 409(旧快照不许覆盖新内容)。
      // rev 存在 canvas_data 内随文档走, 不新增集合字段, 老文档首次保存从 1 起算。
      // PB JSVM 里 json 字段 rec.get() 返回 Go 包装对象, 直接 .rev 取不到 → serverRev 恒为 0,
      // 客户端带 canvas_rev>=1 的保存就会永久 409。
      // String() 强转拿到原始 JSON 文本再解析, 保证乐观锁基线正确(纯视图合并同样用它, 避免把包装对象并进文档)。
      var current = {}
      try { current = JSON.parse(String(rec.get("canvas_data")) || "{}") } catch (_) { current = {} }
      if (current === null || current === undefined || typeof current !== "object" || Array.isArray(current)) current = {}
      var serverRev = parseInt(current.rev, 10) || 0
      var merged
      if (body.canvas_view_only === true) {
        // 纯视图保存(平移/缩放位置)是每端瞬态数据, 只合并 view 字段不碰内容:
        // 基线落后也无覆盖风险, 直接接受不再返回 409(多标签同开时频繁冲突会把 409 冒给用户)
        // 纯视图保存(平移/缩放): 只合并 view, 绝不触碰卡片/连线/任务等内容字段
        merged = current
        if (incoming && typeof incoming.view === "object") merged = Object.assign({}, current, { view: incoming.view })
      } else if (body.canvas_force === true) {
        // 显式「强制覆盖」: 用户在 409 冲突弹窗里主动选择用自己的版本覆盖, 跳过基线校验但仍自增 rev 并留痕。
        merged = incoming
        try { $app.logger().info("canvas force overwrite id=" + String(id) + " base=" + String(body.canvas_rev) + " server=" + String(serverRev) + " by=" + String(meU)) } catch (_) {}
      } else {
        // 内容保存必须带 canvas_rev: 不带(可绕过乐观锁的旧调用方/异常请求)直接 400, 带了但落后一律 409,
        // 由前端让用户在「加载最新 / 强制覆盖」间二选一, 杜绝旧快照静默覆盖新内容。
        if (!Object.prototype.hasOwnProperty.call(body, "canvas_rev")) {
          return respond(400, { error: "revision_required", message: "缺少版本号, 请刷新后再保存", canvas_rev: serverRev })
        }
        var baseRev2 = parseInt(body.canvas_rev, 10) || 0
        if (baseRev2 !== serverRev) {
          return respond(409, { error: "revision_conflict", message: "画布已在别处更新, 请刷新后再保存", canvas_rev: serverRev })
        }
        merged = incoming
      }
      var nextRev = (parseInt(merged.rev, 10) || serverRev || 0) + 1
      if (nextRev <= serverRev) nextRev = serverRev + 1
      if (merged && typeof merged === "object") {
        try { delete merged.rev } catch (_) {}
        merged.rev = nextRev
      }
      rec.set("canvas_data", merged)
    }
    $app.save(rec)
    // 内容保存成功后登记幂等键(持久化), 响应丢失时客户端同体重试直接回放, 不再报 409
    if (idemKey && body.canvas_view_only !== true) {
      try {
        var idemSavedRev = 0
        try { idemSavedRev = parseInt(JSON.parse(String(rec.get("canvas_data")) || "{}").rev, 10) || 0 } catch (_) {}
        var idemExpireAt = new Date().getTime() + 600000
        var idemRecObj = null
        if (idemRecId) {
          try { idemRecObj = $app.findRecordById("canvas_idem", idemRecId) } catch (_) { idemRecObj = null }
        }
        if (idemRecObj) {
          idemRecObj.set("canvas_id", id)
          idemRecObj.set("rev", idemSavedRev)
          idemRecObj.set("expire_at", idemExpireAt)
          $app.save(idemRecObj)
        } else {
          idemRecObj = new Record($app.findCollectionByNameOrId("canvas_idem"))
          idemRecObj.set("owner", meU)
          idemRecObj.set("idem_key", idemKey)
          idemRecObj.set("canvas_id", id)
          idemRecObj.set("rev", idemSavedRev)
          idemRecObj.set("expire_at", idemExpireAt)
          $app.save(idemRecObj)
        }
        // 惰性清理本用户过期幂等行(每次内容保存顺带执行, 量很小)
        try {
          var staleIdem = $app.findRecordsByFilter("canvas_idem", "owner = {:o} && expire_at < {:n}", "", 10, 0, { o: meU, n: new Date().getTime() })
          for (var di = 0; di < staleIdem.length; di++) { try { $app.delete(staleIdem[di]) } catch (_) {} }
        } catch (_) {}
      } catch (idemWErr) {
        try { $app.logger().error("idem register FAIL: " + String(idemWErr && idemWErr.message || idemWErr)) } catch (_) {}
      }
    }
    return respond(200, rec.publicExport())
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("canvases update FAIL: " + msg + " stack=" + String(err && err.stack || "").slice(0, 500)) } catch (_) {}
    return respond(500, { error: "update_failed", message: "操作失败, 请稍后重试", fingerprint: String(msg).slice(0, 80) })
  }

      })(txApp)
      if (!outcome || outcome.status >= 400) throw new Error("canvas_transaction_aborted")
    })
  } catch (_) {
    if (!outcome || outcome.status < 400) outcome = { status: 500, data: { error: "update_failed" } }
  }
  return e.json(outcome.status, outcome.data)
})
// DELETE /api/canvases/{id}
routerAdd("DELETE", "/api/canvases/{id}", function (e) {
  try {
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required" })
    var rec = null
    try { rec = $app.findRecordById("canvases", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "not_found" })
    var meD = ""
    try { meD = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!meD || String(rec.get("rh_user_id")) !== meD) return e.json(404, { error: "not_found" })
    $app.delete(rec)
    // 删除画布后做一次本用户维度的永久媒体垃圾回收(尽力而为, 失败不影响删除响应):
    // 扫该用户所有存活画布(含回收站, 可恢复不能回收)+全局素材里仍被引用的 /api/files/media_files/<id>/,
    // 只删「零引用且创建超过 7 天宽限期」的 media_files(PB 删记录连带删物理文件);
    // 宽限期覆盖刚上传未保存、在途自动保存的文件, 共享文件只要还有一处引用就不回收。
    try {
      var gme = meD
      var glive = {}
      var gKey = "/api/files/media_files/"
      function gScanText(text) {
        var s = String(text || "")
        if (!s) return
        var idx = 0
        for (;;) {
          var at = s.indexOf(gKey, idx)
          if (at < 0) break
          var rest = s.substring(at + gKey.length)
          var slash = rest.indexOf("/")
          if (slash > 0 && slash <= 40) {
            var mid = rest.substring(0, slash)
            if (/^[a-z0-9]{5,40}$/i.test(mid)) glive[mid] = 1
          }
          idx = at + gKey.length
        }
      }
      function gScanDeep(val, depth) {
        if (depth > 8 || val === null || val === undefined) return
        var t = typeof val
        if (t === "string") { gScanText(val); return }
        if (t === "number" || t === "boolean") return
        if (Array.isArray(val)) { for (var gi = 0; gi < val.length; gi++) gScanDeep(val[gi], depth + 1); return }
        if (t === "object") { for (var gk in val) { if (Object.prototype.hasOwnProperty.call(val, gk)) gScanDeep(val[gk], depth + 1) } }
      }
      var gcvs = $app.findRecordsByFilter("canvases", "rh_user_id = {:gme}", "", 1000, 0, { gme: gme })
      for (var gci = 0; gci < gcvs.length; gci++) {
        try { gScanText(String(gcvs[gci].get("thumbnail_url") || "")) } catch (_) {}
        try { gScanDeep(JSON.parse(String(gcvs[gci].get("canvas_data")) || "{}"), 0) } catch (_) {}
      }
      var gasts = $app.findRecordsByFilter("assets", "rh_user_id = {:gme}", "", 2000, 0, { gme: gme })
      for (var gai = 0; gai < gasts.length; gai++) {
        try { gScanText(String(gasts[gai].get("url") || "")) } catch (_) {}
        try { gScanDeep(JSON.parse(String(gasts[gai].get("images")) || "null"), 0) } catch (_) {}
      }
      var gCutoff = new Date().getTime() - 7 * 24 * 60 * 60 * 1000
      var gRemoved = 0
      for (var goff = 0; ; goff += 500) {
        var gmrecs = $app.findRecordsByFilter("media_files", "user_email = {:gme}", "", 500, goff, { gme: gme })
        for (var gmi = 0; gmi < gmrecs.length; gmi++) {
          var gmr = gmrecs[gmi]
          if (glive[gmr.id]) continue
          var gOld = false
          try { gOld = new Date(String(gmr.get("created") || "")).getTime() < gCutoff } catch (_) { gOld = false }
          if (!gOld) continue
          try { $app.delete(gmr); gRemoved += 1 } catch (_) {}
        }
        if (gmrecs.length < 500) break
      }
      if (gRemoved > 0) { try { $app.logger().info("media GC user=" + gme + " removed=" + gRemoved) } catch (_) {} }
    } catch (gcerr) {
      try { $app.logger().error("media gc after canvas delete: " + String(gcerr && gcerr.message || gcerr)) } catch (_) {}
    }
    return e.json(200, { ok: true })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "delete_failed", message: "操作失败, 请稍后重试", fingerprint: msg.substring(0, 80) })
  }
})
