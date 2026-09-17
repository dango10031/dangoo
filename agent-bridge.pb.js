/// <reference path="../pb_data/types.d.ts" />
routerAdd("POST", "/api/agent-bridge/v1/wallet-quote", function (e) {
  return e.json(503, { error: "WALLET_PRICING_UNAVAILABLE" })
})
// Business bridge only. Agent runtime, providers and UI live in the separate dangoo-agent project.
routerAdd("GET", "/api/agent-bridge/v1/identity", function (e) {
  // The existing wallet middleware validates the PB token and account status.
  // Identity must never come from a request body or an unverified JWT payload.
  var owner = String(e.get("authEmail") || "").trim().toLowerCase()
  if (!owner) return e.json(401, { error: "AUTH_REQUIRED" })
  return e.json(200, { ownerId: owner })
})
onBootstrap(function (e) {
  e.next()
  require(__hooks + "/lib/agent-jobs.cjs").bootstrap()
  try { $app.findCollectionByNameOrId("agent_canvas_operations"); return } catch (_) {}
  $app.save(new Collection({
    type: "base", name: "agent_canvas_operations",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: "owner", type: "text", required: true, max: 190 },
      { name: "canvas", type: "text", required: true, max: 128 },
      { name: "operation_id", type: "text", required: true, max: 128 },
      { name: "request_hash", type: "text", required: true, max: 128 },
      { name: "result", type: "json" },
      { name: "created", type: "autodate", onCreate: true }
    ],
    indexes: ["CREATE UNIQUE INDEX agent_canvas_operation_unique ON agent_canvas_operations (owner, canvas, operation_id)"]
  }))
})

routerAdd("GET", "/api/agent-bridge/v1/capabilities", function (e) {
  if (!e.get("authEmail")) return e.json(401, { error: "AUTH_REQUIRED" })
  var api = require(__hooks + "/lib/agent-canvas.cjs")
  var jobs = require(__hooks + "/lib/agent-jobs.cjs").enabled()
  return e.json(200, { contractVersion: "1.0.0", revision: "dangoo-bridge-2", nodes: api.NODE_CATALOG.map(function(n) { return Object.assign({}, n, { runnable: jobs && n.kind === "generate" }) }),
    operations: api.SUPPORTED_OPERATIONS, jobs: jobs, assets: false })
})

routerAdd("POST", "/api/agent-bridge/v1/canvases/{id}/quotes", function(e) { return require(__hooks + "/lib/agent-jobs.cjs").handle(e, "quote") })
routerAdd("GET", "/api/agent-bridge/v1/canvases/{id}/image-models", function(e) { return require(__hooks + "/lib/agent-jobs.cjs").handle(e, "models") })
routerAdd("GET", "/api/agent-bridge/v1/canvases/{id}/quotes/{jobId}", function(e) { return require(__hooks + "/lib/agent-jobs.cjs").handle(e, "quote_get") })
routerAdd("POST", "/api/agent-bridge/v1/canvases/{id}/quotes/{jobId}/approve", function(e) { return require(__hooks + "/lib/agent-jobs.cjs").handle(e, "approve") })
routerAdd("POST", "/api/agent-bridge/v1/canvases/{id}/jobs", function(e) { return require(__hooks + "/lib/agent-jobs.cjs").handle(e, "run") })
routerAdd("GET", "/api/agent-bridge/v1/canvases/{id}/jobs/{jobId}", function(e) { return require(__hooks + "/lib/agent-jobs.cjs").handle(e, "get") })
routerAdd("GET", "/api/agent-bridge/v1/canvases/{id}/job-operations/{operationId}", function(e) { return require(__hooks + "/lib/agent-jobs.cjs").handle(e, "operation") })

routerAdd("GET", "/api/agent-bridge/v1/canvases/{id}", function (e) {
  var owner = String(e.get("authEmail") || "").trim().toLowerCase()
  if (!owner) return e.json(401, { error: "AUTH_REQUIRED" })
  var record
  try { record = $app.findRecordById("canvases", e.request.pathValue("id")) } catch (_) {}
  if (!record || String(record.get("rh_user_id")) !== owner || record.getBool("is_deleted")) return e.json(404, { error: "CANVAS_NOT_FOUND" })
  var doc
  try { doc = JSON.parse(String(record.get("canvas_data")) || "{}") } catch (_) { return e.json(422, { error: "INVALID_CANVAS_DATA" }) }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return e.json(422, { error: "INVALID_CANVAS_DATA" })
  var api = require(__hooks + "/lib/agent-canvas.cjs")
  return e.json(200, api.fromDangoo(record.id, doc))
})

routerAdd("GET", "/api/agent-bridge/v1/canvases/{id}/operations/{operationId}", function (e) {
  var owner = String(e.get("authEmail") || "").trim().toLowerCase()
  if (!owner) return e.json(401, { error: "AUTH_REQUIRED" })
  var canvasId = e.request.pathValue("id")
  var record
  try { record = $app.findRecordById("canvases", canvasId) } catch (_) {}
  if (!record || String(record.get("rh_user_id")) !== owner || record.getBool("is_deleted")) return e.json(404, { error: "CANVAS_NOT_FOUND" })
  var prior = $app.findRecordsByFilter("agent_canvas_operations", "owner = {:o} && canvas = {:c} && operation_id = {:i}", "", 1, 0,
    { o: owner, c: canvasId, i: e.request.pathValue("operationId") })
  return e.json(200, prior.length ? JSON.parse(String(prior[0].get("result"))) : null)
})

routerAdd("POST", "/api/agent-bridge/v1/canvases/{id}/operations", function (e) {
  var owner = String(e.get("authEmail") || "").trim().toLowerCase()
  if (!owner) return e.json(401, { error: "AUTH_REQUIRED" })
  var canvasId = e.request.pathValue("id")
  var body = e.requestInfo().body || {}
  if (!/^[\w.-]{1,128}$/.test(String(body.operationId || "")) ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      !Array.isArray(body.operations) || !body.operations.length || body.operations.length > 100) return e.json(400, { error: "INVALID_OPERATION" })
  function canonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value)
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
    return "{" + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ":" + canonical(value[key]) }).join(",") + "}"
  }
  var serialized = canonical({ expectedRevision: body.expectedRevision, operations: body.operations })
  if (serialized.length > 512000) return e.json(413, { error: "REQUEST_TOO_LARGE" })
  var hash = $security.sha256(serialized)
  var api = require(__hooks + "/lib/agent-canvas.cjs")
  var outcome
  try {
    $app.runInTransaction(function (txApp) {
      var record
      try { record = txApp.findRecordById("canvases", canvasId) } catch (_) {}
      if (!record || String(record.get("rh_user_id")) !== owner || record.getBool("is_deleted")) throw new Error("CANVAS_NOT_FOUND")
      var prior = txApp.findRecordsByFilter("agent_canvas_operations", "owner = {:o} && canvas = {:c} && operation_id = {:i}", "", 1, 0,
        { o: owner, c: canvasId, i: body.operationId })
      if (prior.length) {
        if (String(prior[0].get("request_hash")) !== hash) throw new Error("IDEMPOTENCY_CONFLICT")
        outcome = JSON.parse(String(prior[0].get("result")))
        return
      }
      var doc = JSON.parse(String(record.get("canvas_data")) || "{}")
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("INVALID_CANVAS_DATA")
      var snapshot = api.fromDangoo(canvasId, doc)
      if (snapshot.revision !== body.expectedRevision) throw new Error("REVISION_CONFLICT")
      var next = api.applyCanvasOperations(snapshot, body.operations)
      record.set("canvas_data", api.toDangoo(doc, next))
      txApp.save(record)
      outcome = { operationId: body.operationId, revision: next.revision }
      var receipt = new Record(txApp.findCollectionByNameOrId("agent_canvas_operations"))
      receipt.set("owner", owner); receipt.set("canvas", canvasId); receipt.set("operation_id", body.operationId)
      receipt.set("request_hash", hash); receipt.set("result", outcome)
      txApp.save(receipt)
    })
    return e.json(200, outcome)
  } catch (err) {
    var code = String(err && err.code || err && err.message || "BRIDGE_ERROR")
    var status = code === "CANVAS_NOT_FOUND" ? 404 : (code === "REVISION_CONFLICT" || code === "IDEMPOTENCY_CONFLICT") ? 409 : code === "INVALID_OPERATION" ? 400 : 500
    if (status === 500) code = "BRIDGE_ERROR"
    return e.json(status, { error: code })
  }
})
