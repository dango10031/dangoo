/// <reference path="../pb_data/types.d.ts" />
// pb_hooks/asset_folders.pb.js — 业务 collection + REST CRUD 路由 (self-contained)
//
// 由 mcp__rh-pb-hooks__install_business_collection 装. 不要直接 Read+Write 这个文件.
// 业务字段: name:text, rh_user_id:text
// 路由: list,get,create,update,delete
// list filter 字段: rh_user_id
// list 默认排序: -created

onBootstrap(function (e) {
  e.next()
  try {
    var existing = null
    try { existing = $app.findCollectionByNameOrId("asset_folders") } catch (_) { existing = null }
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
      addField({ name: 'name', type: 'text', required: true, max: 100 })
      addField({ name: 'rh_user_id', type: 'text', required: true, max: 64 })
      addField({ name: "created", type: "autodate", onCreate: true })
      addField({ name: "updated", type: "autodate", onCreate: true, onUpdate: true })
      if (changed) {
        $app.save(existing)
        try { $app.logger().info("asset_folders collection upgraded") } catch (_) {}
      }
    } else {
      var col = new Collection({
        type: "base",
        name: "asset_folders",
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        fields: [
          { name: 'name', type: 'text', required: true, max: 100 },
          { name: 'rh_user_id', type: 'text', required: true, max: 64 },
          { name: "created", type: "autodate", onCreate: true },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        ],
      })
      $app.save(col)
      try { $app.logger().info("asset_folders collection created") } catch (_) {}
    }
  } catch (err) {
    try { $app.logger().error("asset_folders bootstrap: " + String(err && err.message || err)) } catch (_) {}
  }
})

// GET /api/asset_folders?page=1&perPage=50&sort=-created&rh_user_id=...
routerAdd("GET", "/api/asset_folders", function (e) {
  function ensureCollLocal() {
    try { return $app.findCollectionByNameOrId("asset_folders") } catch (_) {}
    var col = new Collection({
      type: "base",
      name: "asset_folders",
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
          { name: 'name', type: 'text', required: true, max: 100 },
          { name: 'rh_user_id', type: 'text', required: true, max: 64 },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    })
    $app.save(col)
    return $app.findCollectionByNameOrId("asset_folders")
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
    var fparams = { me: me }
    var records = $app.findRecordsByFilter("asset_folders", "rh_user_id = {:me}", sort, perPage, (page - 1) * perPage, fparams)
    var items = []
    for (var i = 0; i < records.length; i++) {
      items.push(records[i].publicExport())
    }
    var totalItems = 0
    try { totalItems = $app.countRecords("asset_folders", "rh_user_id = {:me}", fparams) } catch (_) { totalItems = items.length }
    var totalPages = perPage > 0 ? Math.ceil(totalItems / perPage) : 1
    return e.json(200, { items: items, page: page, perPage: perPage, totalItems: totalItems, totalPages: totalPages })
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("asset_folders list: " + msg) } catch (_) {}
    return e.json(500, { error: "list_failed", message: msg, fingerprint: msg.substring(0, 80) })
  }
})
// GET /api/asset_folders/{id}
routerAdd("GET", "/api/asset_folders/{id}", function (e) {
  try {
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required" })
    var rec = null
    try { rec = $app.findRecordById("asset_folders", id) } catch (_) { rec = null }
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
// POST /api/asset_folders  body 字段: name, rh_user_id
routerAdd("POST", "/api/asset_folders", function (e) {
  function ensureCollLocal() {
    try { return $app.findCollectionByNameOrId("asset_folders") } catch (_) {}
    var col = new Collection({
      type: "base",
      name: "asset_folders",
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
          { name: 'name', type: 'text', required: true, max: 100 },
          { name: 'rh_user_id', type: 'text', required: true, max: 64 },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    })
    $app.save(col)
    return $app.findCollectionByNameOrId("asset_folders")
  }
  try {
    var coll = ensureCollLocal()
    var body = e.requestInfo().body || {}
    var meC = ""
    try { meC = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!meC) return e.json(412, { error: "login_required", message: "请先登录后再新建文件夹" })
    var folderName = body.name === undefined || body.name === null ? "" : String(body.name).trim().slice(0, 100)
    if (!folderName) return e.json(400, { error: "name_required", message: "文件夹名称不能为空" })
    var rec = new Record(coll)
    rec.set("name", folderName)
    rec.set("rh_user_id", meC)
    $app.save(rec)
    return e.json(200, rec.publicExport())
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("asset_folders create: " + msg) } catch (_) {}
    return e.json(500, { error: "create_failed", message: msg, fingerprint: msg.substring(0, 80) })
  }
})
// PATCH /api/asset_folders/{id}  body 字段同 POST, 只更新 body 里出现的字段
routerAdd("PATCH", "/api/asset_folders/{id}", function (e) {
  try {
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required" })
    var rec = null
    try { rec = $app.findRecordById("asset_folders", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "not_found" })
    var meU = ""
    try { meU = String(e.get("authEmail") || "").trim().toLowerCase() } catch (_) {}
    if (!meU || String(rec.get("rh_user_id")) !== meU) return e.json(404, { error: "not_found" })
    var body = e.requestInfo().body || {}
    // 属主不可改: 忽略 body 里的 rh_user_id
    if ("name" in body) {
      var nextName = body.name === undefined || body.name === null ? "" : String(body.name).trim().slice(0, 100)
      if (nextName) rec.set("name", nextName)
    }
    $app.save(rec)
    return e.json(200, rec.publicExport())
  } catch (err) {
    var msg = String(err && err.message || err)
    return e.json(500, { error: "update_failed", message: msg, fingerprint: msg.substring(0, 80) })
  }
})
// DELETE /api/asset_folders/{id}
routerAdd("DELETE", "/api/asset_folders/{id}", function (e) {
  try {
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required" })
    var rec = null
    try { rec = $app.findRecordById("asset_folders", id) } catch (_) { rec = null }
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
