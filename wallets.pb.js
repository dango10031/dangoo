/// <reference path="../pb_data/types.d.ts" />
// pb_hooks/wallets.pb.js — 业务 collection + REST CRUD 路由 (self-contained)
//
// 由 mcp__rh-pb-hooks__install_business_collection 装. 不要直接 Read+Write 这个文件.
// 业务字段: user_email:email, balance:number, held:number, is_admin:bool, total_recharged:number, total_consumed:number
// 路由: get
// list filter 字段: (none)
// list 默认排序: -created

onBootstrap(function (e) {
  e.next()
  try {
    var existing = null
    try { existing = $app.findCollectionByNameOrId("wallets") } catch (_) { existing = null }
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
      addField({ name: 'user_email', type: 'email', required: true })
      addField({ name: 'balance', type: 'number' })
      addField({ name: 'held', type: 'number' })
      addField({ name: 'is_admin', type: 'bool' })
      addField({ name: 'total_recharged', type: 'number' })
      addField({ name: 'total_consumed', type: 'number' })
      addField({ name: "created", type: "autodate", onCreate: true })
      addField({ name: "updated", type: "autodate", onCreate: true, onUpdate: true })
      if (changed) {
        $app.save(existing)
        try { $app.logger().info("wallets collection upgraded") } catch (_) {}
      }
    } else {
      var col = new Collection({
        type: "base",
        name: "wallets",
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        fields: [
          { name: 'user_email', type: 'email', required: true },
          { name: 'balance', type: 'number' },
          { name: 'held', type: 'number' },
          { name: 'is_admin', type: 'bool' },
          { name: 'total_recharged', type: 'number' },
          { name: 'total_consumed', type: 'number' },
          { name: "created", type: "autodate", onCreate: true },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        ],
      })
      $app.save(col)
      try { $app.logger().info("wallets collection created") } catch (_) {}
    }
  } catch (err) {
    try { $app.logger().error("wallets bootstrap: " + String(err && err.message || err)) } catch (_) {}
  }
})

// GET /api/wallets/{id}
routerAdd("GET", "/api/wallets/{id}", function (e) {
  try {
    function normEmail(s) { return String(s || "").trim().toLowerCase() }
    var authEmail = normEmail(e.get("authEmail") || "")
    if (!authEmail) return e.json(401, { ok: false, error: "login_required", code: "LOGIN_REQUIRED", message: "请先登录" })
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required" })
    var rec = null
    try { rec = $app.findRecordById("wallets", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "not_found" })
    if (normEmail(rec.get("user_email")) !== authEmail) return e.json(404, { error: "not_found" })
    return e.json(200, rec.publicExport())
  } catch (err) {
    try { $app.logger().error("wallet get: " + String(err && err.message || err)) } catch (_) {}
    return e.json(500, { error: "get_failed", message: "查询失败, 请稍后再试" })
  }
})
