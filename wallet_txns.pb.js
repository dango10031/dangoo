/// <reference path="../pb_data/types.d.ts" />
// pb_hooks/wallet_txns.pb.js — 业务 collection + REST CRUD 路由 (self-contained)
//
// 由 mcp__rh-pb-hooks__install_business_collection 装. 不要直接 Read+Write 这个文件.
// 业务字段: user_email:email, kind:text, amount:number, balance_after:number, ref:text, model:text, note:text, status:text
// 路由: get
// list filter 字段: (none)
// list 默认排序: -created

onBootstrap(function (e) {
  e.next()
  try {
    var existing = null
    try { existing = $app.findCollectionByNameOrId("wallet_txns") } catch (_) { existing = null }
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
      addField({ name: 'kind', type: 'text', required: true, max: 32 })
      addField({ name: 'amount', type: 'number', required: true })
      addField({ name: 'balance_after', type: 'number' })
      addField({ name: 'ref', type: 'text', max: 128 })
      addField({ name: 'model', type: 'text', max: 128 })
      addField({ name: 'note', type: 'text', max: 256 })
      addField({ name: 'status', type: 'text', max: 32 })
      addField({ name: "created", type: "autodate", onCreate: true })
      addField({ name: "updated", type: "autodate", onCreate: true, onUpdate: true })
      if (changed) {
        $app.save(existing)
        try { $app.logger().info("wallet_txns collection upgraded") } catch (_) {}
      }
    } else {
      var col = new Collection({
        type: "base",
        name: "wallet_txns",
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        fields: [
          { name: 'user_email', type: 'email', required: true },
          { name: 'kind', type: 'text', required: true, max: 32 },
          { name: 'amount', type: 'number', required: true },
          { name: 'balance_after', type: 'number' },
          { name: 'ref', type: 'text', max: 128 },
          { name: 'model', type: 'text', max: 128 },
          { name: 'note', type: 'text', max: 256 },
          { name: 'status', type: 'text', max: 32 },
          { name: "created", type: "autodate", onCreate: true },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        ],
      })
      $app.save(col)
      try { $app.logger().info("wallet_txns collection created") } catch (_) {}
    }
  } catch (err) {
    try { $app.logger().error("wallet_txns bootstrap: " + String(err && err.message || err)) } catch (_) {}
  }
})

// GET /api/wallet_txns/{id}
routerAdd("GET", "/api/wallet_txns/{id}", function (e) {
  try {
    function normEmail(s) { return String(s || "").trim().toLowerCase() }
    var authEmail = normEmail(e.get("authEmail") || "")
    if (!authEmail) return e.json(401, { ok: false, error: "login_required", code: "LOGIN_REQUIRED", message: "请先登录" })
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required" })
    var rec = null
    try { rec = $app.findRecordById("wallet_txns", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "not_found" })
    if (normEmail(rec.get("user_email")) !== authEmail) return e.json(404, { error: "not_found" })
    return e.json(200, rec.publicExport())
  } catch (err) {
    try { $app.logger().error("wallet txn get: " + String(err && err.message || err)) } catch (_) {}
    return e.json(500, { error: "get_failed", message: "查询失败, 请稍后再试" })
  }
})
