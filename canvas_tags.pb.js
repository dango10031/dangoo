/// <reference path="../pb_data/types.d.ts" />
// pb_hooks/canvas_tags.pb.js — 账号级标签 collection + REST CRUD 路由 (self-contained)
//
// 安全模型:
//  - 标签是「账号级」数据, 每个账号各自一套(首次使用由前端播种内置标签), 不跨账号共享。
//  - 集合五条规则全部为空串(仅超级用户可走 PocketBase 原生集合接口增删改查),
//    外部一律只能走下面的自定义路由; 自定义路由强制登录 + 按登录邮箱(owner_email)属主过滤。
//  - 写接口在网关登录守卫(protectedAny)之外再做一次 handler 内属主校验, 双保险。
// 业务字段: name:text, color:text, slug:text, template:text, sort:number, owner_email:text
//
// 注意(Goja 运行时约束): 每个 routerAdd 回调是独立执行环境, 文件级 function/常量不跨回调共享,
// 故下面所有路由都在回调内部就地定义工具函数。存量库的 owner_email 字段与规则收紧由发布迁移
// 保证; 全新部署由 onBootstrap 建表。

onBootstrap(function (e) {
  e.next()
  try {
    var bc = null
    try { bc = $app.findCollectionByNameOrId("canvas_tags") } catch (_) { bc = null }
    if (bc) {
      // 存量库自愈: 补字段 + 收紧规则
      var bch = false
      function bHas(name) {
        try { for (var i = 0; i < bc.fields.length; i++) { if (String(bc.fields[i].name) === String(name)) return true } } catch (_) {}
        return false
      }
      function bAdd(def) { if (!bHas(def.name)) { try { bc.fields.add(new Field(def)); bch = true } catch (_) {} } }
      bAdd({ name: 'name', type: 'text', required: true, max: 24 })
      bAdd({ name: 'color', type: 'text', required: true, max: 7 })
      bAdd({ name: 'slug', type: 'text', max: 64 })
      bAdd({ name: 'template', type: 'text', max: 32 })
      bAdd({ name: 'sort', type: 'number' })
      bAdd({ name: 'owner_email', type: 'text', max: 200 })
      if (bc.listRule !== "" || bc.viewRule !== "" || bc.createRule !== "" || bc.updateRule !== "" || bc.deleteRule !== "") {
        bc.set("listRule", ""); bc.set("viewRule", ""); bc.set("createRule", ""); bc.set("updateRule", ""); bc.set("deleteRule", "")
        bch = true
      }
      if (bch) $app.save(bc)
      return
    }
    bc = new Collection({
      type: "base", name: "canvas_tags",
      listRule: "", viewRule: "", createRule: "", updateRule: "", deleteRule: "",
      fields: [
        { name: 'name', type: 'text', required: true, max: 24 },
        { name: 'color', type: 'text', required: true, max: 7 },
        { name: 'slug', type: 'text', max: 64 },
        { name: 'template', type: 'text', max: 32 },
        { name: 'sort', type: 'number' },
        { name: 'owner_email', type: 'text', max: 200 },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      ],
    })
    $app.save(bc)
  } catch (err) {
    try { $app.logger().error("canvas_tags bootstrap: " + String(err && err.message || err)) } catch (_) {}
  }
})

// GET /api/canvas_tags?page=1&perPage=50&sort=-created
// 未登录返回空集合(首页/画布据此显示内置兜底标签)。
// 登录用户可见 = 本人账号的标签 + 「公共历史标签」(owner_email 为空的存量标签:
// 账号隔离改造前创建的内置/用户标签, 卡片仍按 slug 引用, 绝不能因隔离而从老用户视野消失)。
// 管理员可读全部(含空 owner)。只放宽「读」, 公共标签的改/删仍仅管理员(见 PATCH/DELETE)。
routerAdd("GET", "/api/canvas_tags", function (e) {
  try {
    function normEmail(s) { return String(s || "").trim().toLowerCase() }
    function isAdmin(em) { return normEmail("244638579@qq.com") === em }
    var info = e.requestInfo()
    var query = info.query || {}
    var page = parseInt(String(query.page || "1"), 10) || 1
    var perPage = parseInt(String(query.perPage || "50"), 10) || 50
    if (perPage > 200) perPage = 200
    var sort = String(query.sort || "-created")
    var me = ""
    try { me = normEmail(e.get("authEmail") || "") } catch (_) {}
    if (!me) return e.json(200, { items: [], page: page, perPage: perPage, totalItems: 0, totalPages: 1 })
    // 普通用户: 本人标签 + 无主公共标签; 管理员: 全部
    var filter = isAdmin(me) ? "owner_email != '' || owner_email = ''" : "(owner_email = {:me} || owner_email = '')"
    var params = isAdmin(me) ? {} : { me: me }
    var records = $app.findRecordsByFilter("canvas_tags", filter, sort, perPage, (page - 1) * perPage, params)
    var items = []
    for (var i = 0; i < records.length; i++) items.push(records[i].publicExport())
    var totalItems = 0
    try { totalItems = $app.countRecords("canvas_tags", filter, params) } catch (_) { totalItems = items.length }
    var totalPages = perPage > 0 ? Math.ceil(totalItems / perPage) : 1
    return e.json(200, { items: items, page: page, perPage: perPage, totalItems: totalItems, totalPages: totalPages })
  } catch (err) {
    try { $app.logger().error("canvas_tags list: " + String(err && err.message || err)) } catch (_) {}
    return e.json(500, { error: "list_failed", message: "标签加载失败, 请稍后重试", fingerprint: "tags_list" })
  }
})

// GET /api/canvas_tags/{id} —— 属主或管理员可读; owner 为空的公共历史标签对所有登录用户可读。
// 非属主的「有主」标签统一 404 防 ID 枚举。
routerAdd("GET", "/api/canvas_tags/{id}", function (e) {
  try {
    function normEmail(s) { return String(s || "").trim().toLowerCase() }
    function isAdmin(em) { return normEmail("244638579@qq.com") === em }
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required", message: "缺少标签 id" })
    var rec = null
    try { rec = $app.findRecordById("canvas_tags", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "not_found", message: "标签不存在" })
    var meG = ""
    try { meG = normEmail(e.get("authEmail") || "") } catch (_) {}
    if (!meG) return e.json(412, { error: "login_required", message: "请先登录后再操作" })
    var owner = normEmail(rec.get("owner_email") || "")
    if (!isAdmin(meG) && owner !== "" && owner !== meG) {
      return e.json(404, { error: "not_found", message: "标签不存在" })
    }
    return e.json(200, rec.publicExport())
  } catch (err) {
    return e.json(500, { error: "get_failed", message: "标签加载失败, 请稍后重试", fingerprint: "tags_get" })
  }
})

// POST /api/canvas_tags  body: name, color, slug, template, sort —— 必须登录, 强制属主=本人
routerAdd("POST", "/api/canvas_tags", function (e) {
  try {
    function normEmail(s) { return String(s || "").trim().toLowerCase() }
    var me = ""
    try { me = normEmail(e.get("authEmail") || "") } catch (_) {}
    if (!me) return e.json(412, { error: "login_required", message: "请先登录后再创建标签" })
    var coll
    try { coll = $app.findCollectionByNameOrId("canvas_tags") } catch (_) { coll = null }
    if (!coll) return e.json(500, { error: "coll_missing", message: "标签服务未就绪, 请稍后重试", fingerprint: "tags_coll" })
    var body = e.requestInfo().body || {}
    var rec = new Record(coll)
    rec.set("name", body.name === undefined || body.name === null ? "" : String(body.name))
    rec.set("color", body.color === undefined || body.color === null ? "" : String(body.color))
    rec.set("slug", body.slug === undefined || body.slug === null ? "" : String(body.slug))
    rec.set("template", body.template === undefined || body.template === null ? "" : String(body.template))
    rec.set("sort", (body.sort === undefined || body.sort === null) ? 0 : Number(body.sort))
    // 属主永远取自登录态, 忽略任何客户端自报
    rec.set("owner_email", me)
    $app.save(rec)
    return e.json(200, rec.publicExport())
  } catch (err) {
    try { $app.logger().error("canvas_tags create: " + String(err && err.message || err)) } catch (_) {}
    return e.json(500, { error: "create_failed", message: "标签创建失败, 请稍后重试", fingerprint: "tags_create" })
  }
})

// PATCH /api/canvas_tags/{id} —— 必须登录且为属主, 不允许改 owner_email
routerAdd("PATCH", "/api/canvas_tags/{id}", function (e) {
  try {
    function normEmail(s) { return String(s || "").trim().toLowerCase() }
    var me = ""
    try { me = normEmail(e.get("authEmail") || "") } catch (_) {}
    if (!me) return e.json(412, { error: "login_required", message: "请先登录后再操作" })
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required", message: "缺少标签 id" })
    var rec = null
    try { rec = $app.findRecordById("canvas_tags", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "not_found", message: "标签不存在" })
    if (normEmail(rec.get("owner_email") || "") !== me) {
      return e.json(404, { error: "not_found", message: "标签不存在" })
    }
    var body = e.requestInfo().body || {}
    if ("name" in body) rec.set("name", body.name === undefined || body.name === null ? "" : String(body.name))
    if ("color" in body) rec.set("color", body.color === undefined || body.color === null ? "" : String(body.color))
    if ("slug" in body) rec.set("slug", body.slug === undefined || body.slug === null ? "" : String(body.slug))
    if ("template" in body) rec.set("template", body.template === undefined || body.template === null ? "" : String(body.template))
    if ("sort" in body) rec.set("sort", (body.sort === undefined || body.sort === null) ? 0 : Number(body.sort))
    // 属主不可经此接口变更(忽略 body.owner_email)
    rec.set("owner_email", me)
    $app.save(rec)
    return e.json(200, rec.publicExport())
  } catch (err) {
    return e.json(500, { error: "update_failed", message: "标签保存失败, 请稍后重试", fingerprint: "tags_update" })
  }
})

// DELETE /api/canvas_tags/{id} —— 必须登录且为属主
routerAdd("DELETE", "/api/canvas_tags/{id}", function (e) {
  try {
    function normEmail(s) { return String(s || "").trim().toLowerCase() }
    var me = ""
    try { me = normEmail(e.get("authEmail") || "") } catch (_) {}
    if (!me) return e.json(412, { error: "login_required", message: "请先登录后再操作" })
    var id = e.request.pathValue("id")
    if (!id) return e.json(400, { error: "id_required", message: "缺少标签 id" })
    var rec = null
    try { rec = $app.findRecordById("canvas_tags", id) } catch (_) { rec = null }
    if (!rec) return e.json(404, { error: "not_found", message: "标签不存在" })
    if (normEmail(rec.get("owner_email") || "") !== me) {
      return e.json(404, { error: "not_found", message: "标签不存在" })
    }
    $app.delete(rec)
    return e.json(200, { ok: true })
  } catch (err) {
    return e.json(500, { error: "delete_failed", message: "标签删除失败, 请稍后重试", fingerprint: "tags_delete" })
  }
})
