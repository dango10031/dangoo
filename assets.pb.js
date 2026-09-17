/// <reference path="../pb_data/types.d.ts" />
// pb_hooks/assets.pb.js — 业务 collection + REST CRUD 路由 (self-contained)
//
// 由 mcp__rh-pb-hooks__install_business_collection 装. 不要直接 Read+Write 这个文件.
// 业务字段: rh_user_id:text, name:text, url:url, media_type:text, width:number, height:number, source:text, folder:text, images:json
// 路由: list,get,create,update,delete
// list filter 字段: rh_user_id
// list 默认排序: -created

onBootstrap(function (e) {
  e.next()
  try {
    var existing = null
    try { existing = $app.findCollectionByNameOrId("assets") } catch (_) { existing = null }
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
      addField({ name: 'rh_user_id', type: 'text', required: true, max: 64 })
      addField({ name: 'name', type: 'text', max: 200 })
      addField({ name: 'url', type: 'url', required: true, max: 2000 })
      addField({ name: 'media_type', type: 'text', max: 20 })
      addField({ name: 'width', type: 'number', min: 0 })
      addField({ name: 'height', type: 'number', min: 0 })
      addField({ name: 'source', type: 'text', max: 100 })
      addField({ name: 'folder', type: 'text', max: 64 })
      addField({ name: 'images', type: 'json' })
      addField({ name: "created", type: "autodate", onCreate: true })
      addField({ name: "updated", type: "autodate", onCreate: true, onUpdate: true })
      if (changed) {
        $app.save(existing)
        try { $app.logger().info("assets collection upgraded") } catch (_) {}
      }
    } else {
      var col = new Collection({
        type: "base",
        name: "assets",
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        fields: [
          { name: 'rh_user_id', type: 'text', required: true, max: 64 },
          { name: 'name', type: 'text', max: 200 },
          { name: 'url', type: 'url', required: true, max: 2000 },
          { name: 'media_type', type: 'text', max: 20 },
          { name: 'width', type: 'number', min: 0 },
          { name: 'height', type: 'number', min: 0 },
          { name: 'source', type: 'text', max: 100 },
          { name: 'folder', type: 'text', max: 64 },
          { name: 'images', type: 'json' },
          { name: "created", type: "autodate", onCreate: true },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        ],
      })
      $app.save(col)
      try { $app.logger().info("assets collection created") } catch (_) {}
    }
  } catch (err) {
    try { $app.logger().error("assets bootstrap: " + String(err && err.message || err)) } catch (_) {}
  }
})

// GET /api/assets?page=1&perPage=50&sort=-created&rh_user_id=...
routerAdd("GET", "/api/assets", function (e) {
  function ensureCollLocal() {
    try { return $app.findCollectionByNameOrId("assets") } catch (_) {}
    var col = new Collection({
      type: "base",
      name: "assets",
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
          { name: 'rh_user_id', type: 'text', required: true, max: 64 },
          { name: 'name', type: 'text', max: 200 },
          { name: 'url', type: 'url', required: true, max: 2000 },
          { name: 'media_type', type: 'text', max: 20 },
          { name: 'width', type: 'number', min: 0 },
          { name: 'height', type: 'number', min: 0 },
          { name: 'source', type: 'text', max: 100 },
          { name: 'folder', type: 'text', max: 64 },
          { name: 'images', type: 'json' },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    })
    $app.save(col)
    return $app.findCollectionByNameOrId("assets")
  }
  try {
    ensureCollLocal()
    var info = e.requestInfo()
    var query = info.query || {}
    var page = parseInt(String(query.page || "1"), 10) || 1
    var perPage = parseInt(String(query.perPage || "50"), 10) || 50
    if (perPage > 200) perPage = 200
    var sort = String(query.sort || "-created")
    // 按账号隔离: 只认平台注入的登录 ID, 未登录返回空列表; query 不再作为身份依据
    var me = ""
    try { me = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!me) return e.json(200, { items: [], page: page, perPage: perPage, totalItems: 0 })
    var params = { me: me }
    var filter = "rh_user_id = {:me}"
    // 文件夹筛选: folder=<id> 精确匹配; folder=uncategorized 只看未分类
    var folderQuery = query.folder === undefined || query.folder === null ? "" : String(query.folder)
    if (folderQuery === "uncategorized") {
      filter = "rh_user_id = {:me} && folder = {:empty}"
      params.empty = ""
    } else if (folderQuery) {
      filter = "rh_user_id = {:me} && folder = {:folder}"
      params.folder = folderQuery
    }
    var records = $app.findRecordsByFilter("assets", filter, sort, perPage, (page - 1) * perPage, params)
    var items = []
    for (var i = 0; i < records.length; i++) {
      items.push(records[i].publicExport())
    }
    // 真实总数(全量满足筛选的记录数), 不能用当页 items.length —— 否则第 51 条起前端永远翻不到
    var totalItems = 0
    try { totalItems = $app.countRecords("assets", filter, params) } catch (_) { totalItems = items.length }
    var totalPages = perPage > 0 ? Math.ceil(totalItems / perPage) : 1
    return e.json(200, { items: items, page: page, perPage: perPage, totalItems: totalItems, totalPages: totalPages })
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("assets list: " + msg) } catch (_) {}
    return e.json(500, { error: "list_failed", message: msg, fingerprint: msg.substring(0, 80) })
  }
})
// GET /api/assets/{id}
routerAdd("GET", "/api/assets/{id}", function (e) {
  try {
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required" })
    var rec = null
    try { rec = $app.findRecordById("assets", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "not_found" })
    var meG = ""
    try { meG = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!meG || String(rec.get("rh_user_id")) !== meG) return e.json(404, { error: "not_found" })
    return e.json(200, rec.publicExport())
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "get_failed", message: msg, fingerprint: msg.substring(0, 80) })
  }
})
// POST /api/assets  body 字段: rh_user_id, name, url, media_type, width, height, source, folder, images
routerAdd("POST", "/api/assets", function (e) {
  function ensureCollLocal() {
    try { return $app.findCollectionByNameOrId("assets") } catch (_) {}
    var col = new Collection({
      type: "base",
      name: "assets",
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
          { name: 'rh_user_id', type: 'text', required: true, max: 64 },
          { name: 'name', type: 'text', max: 200 },
          { name: 'url', type: 'url', required: true, max: 2000 },
          { name: 'media_type', type: 'text', max: 20 },
          { name: 'width', type: 'number', min: 0 },
          { name: 'height', type: 'number', min: 0 },
          { name: 'source', type: 'text', max: 100 },
          { name: 'folder', type: 'text', max: 64 },
          { name: 'images', type: 'json' },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    })
    $app.save(col)
    return $app.findCollectionByNameOrId("assets")
  }
  try {
    var coll = ensureCollLocal()
    var body = e.requestInfo().body || {}
    var meC = ""
    try { meC = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!meC) return e.json(412, { error: "login_required", message: "请先登录后再保存素材" })
    // 站内相对链接补成绝对网址(url 字段只收绝对地址); 域名优先用网关转发头
    function absUrl(u) {
      var s = String(u == null ? "" : u).trim()
      if (!s) return ""
      if (/^https?:\/\//i.test(s) || s.indexOf("data:") === 0 || s.indexOf("blob:") === 0) return s
      if (s.charAt(0) !== "/") s = "/" + s
      var proto = "http", host = ""
      try {
        var hh = e.requestInfo().headers || {}
        var xp = String(hh["x-forwarded-proto"] || "").split(",")[0].trim()
        var xh = String(hh["x-forwarded-host"] || "").split(",")[0].trim()
        if (xp) proto = xp
        if (xh) host = xh
      } catch (_) {}
      if (!host) { try { host = String(e.request.host || "") } catch (_) {} }
      return host ? (proto + "://" + host + s) : s
    }
    var rec = new Record(coll)
    rec.set("rh_user_id", meC)
    rec.set("name", body.name === undefined || body.name === null ? "" : String(body.name))
    rec.set("url", absUrl(body.url))
    rec.set("media_type", body.media_type === undefined || body.media_type === null ? "" : String(body.media_type))
    rec.set("width", (body.width === undefined || body.width === null) ? 0 : Number(body.width))
    rec.set("height", (body.height === undefined || body.height === null) ? 0 : Number(body.height))
    rec.set("source", body.source === undefined || body.source === null ? "" : String(body.source))
    rec.set("folder", body.folder === undefined || body.folder === null ? "" : String(body.folder))
    rec.set("images", body.images)
    $app.save(rec)
    return e.json(200, rec.publicExport())
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("assets create: " + msg) } catch (_) {}
    return e.json(500, { error: "create_failed", message: msg, fingerprint: msg.substring(0, 80) })
  }
})
// PATCH /api/assets/{id}  body 字段同 POST, 只更新 body 里出现的字段
routerAdd("PATCH", "/api/assets/{id}", function (e) {
  try {
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required" })
    var rec = null
    try { rec = $app.findRecordById("assets", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "not_found" })
    var meU = ""
    try { meU = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!meU || String(rec.get("rh_user_id")) !== meU) return e.json(404, { error: "not_found" })
    var body = e.requestInfo().body || {}
    // 站内相对链接补成绝对网址(同 POST)
    function absUrlP(u) {
      var s = String(u == null ? "" : u).trim()
      if (!s) return ""
      if (/^https?:\/\//i.test(s) || s.indexOf("data:") === 0 || s.indexOf("blob:") === 0) return s
      if (s.charAt(0) !== "/") s = "/" + s
      var proto = "http", host = ""
      try {
        var hh = e.requestInfo().headers || {}
        var xp = String(hh["x-forwarded-proto"] || "").split(",")[0].trim()
        var xh = String(hh["x-forwarded-host"] || "").split(",")[0].trim()
        if (xp) proto = xp
        if (xh) host = xh
      } catch (_) {}
      if (!host) { try { host = String(e.request.host || "") } catch (_) {} }
      return host ? (proto + "://" + host + s) : s
    }
    // 属主不可改: 忽略 body 里的 rh_user_id
    if ("name" in body) rec.set("name", body.name === undefined || body.name === null ? "" : String(body.name))
    if ("url" in body) rec.set("url", absUrlP(body.url))
    if ("media_type" in body) rec.set("media_type", body.media_type === undefined || body.media_type === null ? "" : String(body.media_type))
    if ("width" in body) rec.set("width", (body.width === undefined || body.width === null) ? 0 : Number(body.width))
    if ("height" in body) rec.set("height", (body.height === undefined || body.height === null) ? 0 : Number(body.height))
    if ("source" in body) rec.set("source", body.source === undefined || body.source === null ? "" : String(body.source))
    if ("folder" in body) rec.set("folder", body.folder === undefined || body.folder === null ? "" : String(body.folder))
    if ("images" in body) rec.set("images", body.images)
    $app.save(rec)
    return e.json(200, rec.publicExport())
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "update_failed", message: msg, fingerprint: msg.substring(0, 80) })
  }
})
// DELETE /api/assets/{id}
routerAdd("DELETE", "/api/assets/{id}", function (e) {
  try {
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required" })
    var rec = null
    try { rec = $app.findRecordById("assets", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "not_found" })
    var meD = ""
    try { meD = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!meD || String(rec.get("rh_user_id")) !== meD) return e.json(404, { error: "not_found" })
    $app.delete(rec)
    return e.json(200, { ok: true })
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "delete_failed", message: msg, fingerprint: msg.substring(0, 80) })
  }
})
