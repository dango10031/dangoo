"use strict";
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __objRest = (source, exclude) => {
  var target = {};
  for (var prop in source)
    if (__hasOwnProp.call(source, prop) && exclude.indexOf(prop) < 0)
      target[prop] = source[prop];
  if (source != null && __getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(source)) {
      if (exclude.indexOf(prop) < 0 && __propIsEnum.call(source, prop))
        target[prop] = source[prop];
    }
  return target;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/jobs/pocketbase.ts
var pocketbase_exports = {};
__export(pocketbase_exports, {
  bootstrap: () => bootstrap,
  enabled: () => enabled,
  handle: () => handle
});
module.exports = __toCommonJS(pocketbase_exports);

// src/adapters/assets.ts
var IntegrationError = class extends Error {
  constructor(code, message, retryable = false, status) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.name = "IntegrationError";
  }
};

// src/adapters/canvas-operations.ts
var kinds = ["prompt", "generate", "polish", "result", "video", "layer", "replicate", "agent", "loop", "merge", "tts", "motion", "vsr", "camera"];
var NODE_CATALOG = kinds.map((kind) => ({ kind, name: kind, description: `Dangoo ${kind} \u8282\u70B9\uFF1B\u6267\u884C\u80FD\u529B\u4EE5\u670D\u52A1\u7AEF\u63E1\u624B\u4E3A\u51C6`, runnable: false, parameters: { type: "object", properties: { title: { type: "string", maxLength: 160 }, prompt: { type: "string", maxLength: 24e3 }, model: { type: "string", maxLength: 120 }, width: { type: "number", minimum: 64, maximum: 4096 }, height: { type: "number", minimum: 64, maximum: 4096 } }, additionalProperties: false } }));
var GENERATION_PARAMETERS = { type: "object", properties: { model: { type: "string", maxLength: 120 }, resolution: { enum: ["1k", "2k", "4k"] }, aspectRatio: { type: "string", maxLength: 16 }, quality: { enum: ["low", "medium", "high"] }, count: { const: 1 } }, additionalProperties: false };
for (const node of NODE_CATALOG) if (node.kind === "generate") node.parameters.properties.genParams = GENERATION_PARAMETERS;

// src/adapters/pocketbase-mapping.ts
function fromDangoo(canvasId, doc) {
  const cards = Array.isArray(doc.cards) ? doc.cards : [];
  return { canvasId, revision: Number(doc.rev) || 0, nodes: cards.map((raw) => {
    const _a = raw, { id, kind, x, y } = _a, data = __objRest(_a, ["id", "kind", "x", "y"]);
    return { id: String(id), kind: String(kind), x: Number(x), y: Number(y), data };
  }), edges: (Array.isArray(doc.connections) ? doc.connections : []).map((raw) => {
    const e = raw;
    return { id: String(e.id), from: String(e.fromId), to: String(e.toId) };
  }) };
}

// src/jobs/node-input.ts
function imageNodeInput(snapshot, nodeId, models, families2) {
  var _a, _b, _c, _d, _e;
  const node = snapshot.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== "generate") throw new IntegrationError("NODE_NOT_RUNNABLE", "\u5F53\u524D\u4EC5\u652F\u6301\u6807\u51C6\u56FE\u7247\u751F\u6210\u8282\u70B9");
  const d = node.data, params = (_a = d.genParams) != null ? _a : {};
  if (Number((_b = params.count) != null ? _b : 1) !== 1) throw new IntegrationError("UNSUPPORTED_NODE_OPTIONS", "\u8BF7\u5C06\u8282\u70B9\u751F\u6210\u6570\u91CF\u8BBE\u4E3A 1");
  if (d.cameraSnapshot || d.cameraNodeId || d.cropContext || params.transparentBg) throw new IntegrationError("UNSUPPORTED_NODE_OPTIONS", "\u6B64\u8282\u70B9\u542B\u6682\u672A\u63A5\u5165\u7684\u6444\u5F71\u673A\u3001\u9009\u533A\u6216\u900F\u660E\u80CC\u666F\u53C2\u6570\uFF0C\u8BF7\u4F7F\u7528\u753B\u5E03\u539F\u6709\u751F\u6210\u6309\u94AE");
  const incoming = snapshot.edges.filter((e) => e.to === nodeId).map((e) => snapshot.nodes.find((n) => n.id === e.from)).filter(Boolean);
  const prompts = incoming.filter((n) => n.kind === "prompt").map((n) => String(n.data.prompt || "")).filter(Boolean);
  const prompt = [...prompts, String(d.prompt || "")].filter(Boolean).join("\n");
  if (!prompt.trim()) throw new IntegrationError("PROMPT_REQUIRED", "\u751F\u6210\u8282\u70B9\u6216\u4E0A\u6E38\u63D0\u793A\u8BCD\u8282\u70B9\u9700\u8981\u63D0\u793A\u8BCD");
  const ownResults = Array.isArray(d.results) ? d.results : [];
  const ownUrl = typeof d.url === "string" && !ownResults.some((r) => r.url === d.url && r.itemStatus === "success") ? d.url : void 0;
  const refs = [ownUrl, ...Array.isArray(d.refUrls) ? d.refUrls : [], ...incoming.filter((n) => {
    var _a2;
    return n.kind !== "video" && !(Array.isArray(n.data.results) && ((_a2 = n.data.results[Number(n.data.activeResultIndex) || 0]) == null ? void 0 : _a2.isVideo));
  }).map((n) => n.data.url)].filter((v) => typeof v === "string" && !!v);
  const imageUrls = Array.from(new Set(refs)).slice(0, 9);
  if (imageUrls.some((u) => !/^https?:\/\//.test(u) && !u.startsWith("/api/files/media_files/"))) throw new IntegrationError("REFERENCE_UNAVAILABLE", "\u53C2\u8003\u56FE\u9700\u8981\u5148\u4FDD\u5B58\u5230\u753B\u5E03\u5A92\u4F53\u5B58\u50A8");
  const selected = String(params.model || d.model || "");
  const family = families2.find((f) => f.key === selected || f.i2 === selected || f.t2 === selected);
  const model = family ? imageUrls.length ? family.i2 : family.t2 : selected;
  const info = model ? models[model] : void 0;
  if (!model || !info || info.output_type !== "image") throw new IntegrationError("MODEL_NOT_SUPPORTED", "\u8BF7\u9009\u62E9\u5DF2\u542F\u7528\u7684\u6807\u51C6\u56FE\u7247\u6A21\u578B");
  if (((_c = info.media_params) == null ? void 0 : _c.some((p) => p.required)) && !imageUrls.length) throw new IntegrationError("REFERENCE_REQUIRED", "\u6B64\u6A21\u578B\u9700\u8981\u53C2\u8003\u56FE\u7247");
  const body = { model, prompt, page: "canvas-agent" };
  for (const p of (_d = info.scalar_params) != null ? _d : []) {
    const value = (_e = params[p.name]) != null ? _e : p.default;
    if (value === void 0 || value === "empty") continue;
    if (p.enum && !p.enum.includes(value)) throw new IntegrationError("INVALID_NODE_PARAMETER", `\u8282\u70B9\u53C2\u6570 ${p.name} \u4E0D\u5728\u6A21\u578B\u652F\u6301\u8303\u56F4`);
    body[p.name] = value;
  }
  if (imageUrls.length) body.imageUrls = imageUrls;
  return { nodeId, revision: snapshot.revision, body };
}
function applyImageResult(doc, nodeId, operationId, result) {
  const cards = Array.isArray(doc.cards) ? doc.cards : [];
  const card = cards.find((c) => c.id === nodeId);
  if (!card) return { doc, applyState: "target_missing" };
  if (card.kind !== "generate") return { doc, applyState: "conflict" };
  const items = Array.isArray(card.results) ? card.results : [];
  if (items.some((r) => r.agentOperationId === operationId)) return { doc, applyState: "applied" };
  const item = __spreadProps(__spreadValues({}, result), { agentOperationId: operationId, itemStatus: "success", isVideo: false });
  const next = __spreadProps(__spreadValues({}, card), { results: [...items, item] });
  if (!items.length && !card.url) {
    next.url = result.url;
    next.activeResultIndex = 0;
    next.jobStatus = "success";
  }
  return { doc: __spreadProps(__spreadValues({}, doc), { rev: (Number(doc.rev) || 0) + 1, cards: cards.map((c) => c.id === nodeId ? next : c) }), applyState: "applied" };
}

// src/jobs/pocketbase.ts
var collection = "agent_node_jobs";
var families = [
  ["gpt-image-2", "gpt-image-2-image-to-image-official-stable"],
  ["gpt-image-2-0-text-to-image-channel-low-price", "gpt-image-2-0-edit-channel-low-price"],
  ["nano-banana2-gemini31flash-text-to-image-official-stable", "nano-banana2-gemini31flash-image-to-image-official-stable"],
  ["nano-banana2", "nano-banana2-gemini31flash-image-to-image-channel-low-price"],
  ["nano-banana-pro-text-to-image-ultra-official-stable", "nano-banana-pro-edit-ultra-official-stable"],
  ["nano-banana-pro", "nano-banana-pro-edit-channel-low-price"]
].map(([key, i2]) => ({ key, t2: key, i2, media: "image" }));
var json = (r, key) => JSON.parse(String(r.get(key) || "null"));
var fail = (code) => {
  throw new Error(code);
};
function enabled() {
  return /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(String($os.getenv("AGENT_AIGC_INTERNAL_URL") || ""));
}
function bootstrap() {
  try {
    $app.findCollectionByNameOrId(collection);
    return;
  } catch (e) {
  }
  $app.save(new Collection({
    type: "base",
    name: collection,
    listRule: null,
    viewRule: null,
    createRule: null,
    updateRule: null,
    deleteRule: null,
    fields: [{ name: "owner", type: "text", required: true, max: 190 }, { name: "canvas", type: "text", required: true, max: 128 }, { name: "operation_id", type: "text", max: 128 }, { name: "payload", type: "json" }, { name: "created", type: "autodate", onCreate: true }],
    indexes: ["CREATE UNIQUE INDEX agent_node_job_operation ON agent_node_jobs (owner, canvas, operation_id) WHERE operation_id != ''"]
  }));
}
function canvas(app, id, owner) {
  let r;
  try {
    r = app.findRecordById("canvases", id);
  } catch (e) {
  }
  if (!r || String(r.get("rh_user_id")) !== owner || r.getBool("is_deleted")) fail("CANVAS_NOT_FOUND");
  return r;
}
function owned(app, id, owner, canvasId) {
  let r;
  try {
    r = app.findRecordById(collection, id);
  } catch (e) {
  }
  if (!r || String(r.get("owner")) !== owner || String(r.get("canvas")) !== canvasId) fail("JOB_NOT_FOUND");
  return r;
}
function request(e, path, body) {
  if (!enabled()) fail("GENERATION_NOT_CONFIGURED");
  const input = e.requestInfo().headers || {};
  const headers = { "Content-Type": "application/json" };
  for (const [target, keys] of Object.entries({ Authorization: ["authorization", "Authorization"], Cookie: ["cookie", "Cookie"], "X-RH-Vibex-App": ["x_rh_vibex_app", "x-rh-vibex-app"], "X-RH-Vibex-Ticket": ["x_rh_vibex_ticket", "x-rh-vibex-ticket"], "X-RH-Vibex-Sign": ["x_rh_vibex_sign", "x-rh-vibex-sign"] })) {
    for (const key of keys) if (input[key]) {
      headers[target] = String(input[key]);
      break;
    }
  }
  const response = $http.send({ url: String($os.getenv("AGENT_AIGC_INTERNAL_URL")) + path, method: body === void 0 ? "GET" : "POST", headers, body: body === void 0 ? "" : JSON.stringify(body), timeout: 65 });
  let result;
  try {
    result = JSON.parse(response.raw);
  } catch (e2) {
    fail("AIGC_INVALID_RESPONSE");
  }
  if (response.statusCode < 200 || response.statusCode >= 300 || result.error && result.ok !== true) fail("AIGC_REQUEST_FAILED");
  return result;
}
function publicJob(record, p) {
  return { id: record.id, operationId: p.operationId || "", nodeId: p.nodeId, state: p.state, remoteId: p.remoteId, results: [], storageState: p.storageState || "pending", applyState: p.applyState || "pending", error: p.error, revision: p.appliedRevision, outputUrl: p.outputUrl };
}
function persist(record, p, app = $app) {
  record.set("payload", p);
  app.save(record);
}
function summarize(record, p) {
  return { id: record.id, nodeId: p.nodeId, expectedRevision: p.revision, model: p.body.model, prompt: p.body.prompt, referenceCount: (p.body.imageUrls || []).length, price: p.price, expiresAt: p.expiresAt, approved: p.approved === true };
}
function handle(e, action) {
  var _a, _b;
  try {
    const owner = String(e.get("authEmail") || "").trim().toLowerCase();
    if (!owner) return e.json(401, { error: "AUTH_REQUIRED" });
    const canvasId = e.request.pathValue("id"), body = e.requestInfo().body || {};
    const current = canvas($app, canvasId, owner);
    if (action === "models") {
      const catalogue = request(e, "/api/aigc/models");
      return e.json(200, { models: (catalogue.models || []).filter((m) => m.output_type === "image").map((m) => ({ model: m.model, parameters: m.scalar_params, referenceRequired: (m.media_params || []).some((p2) => p2.required) })), families });
    }
    if (action === "quote") {
      const doc = json(current, "canvas_data");
      if (Number(doc.rev || 0) !== body.expectedRevision) fail("REVISION_CONFLICT");
      const catalogue = request(e, "/api/aigc/models");
      const models = catalogue.models || catalogue;
      const indexed = Array.isArray(models) ? Object.fromEntries(models.map((m) => [m.name || m.model, m])) : models;
      const input = imageNodeInput(fromDangoo(canvasId, doc), String(body.nodeId), indexed, families);
      if (Array.isArray(input.body.imageUrls)) input.body.imageUrls = input.body.imageUrls.map((url) => request(e, "/api/media/rh-url", { url }).url);
      const price = request(e, "/api/agent-bridge/v1/wallet-quote", input.body);
      if (price.ok !== true) fail("PRICE_UNAVAILABLE");
      const rec2 = new Record($app.findCollectionByNameOrId(collection));
      rec2.set("owner", owner);
      rec2.set("canvas", canvasId);
      rec2.set("operation_id", "");
      const payload = __spreadProps(__spreadValues({}, input), { price, expiresAt: Date.now() + 10 * 60 * 1e3, approved: false, state: "created" });
      persist(rec2, payload);
      return e.json(200, summarize(rec2, payload));
    }
    if (action === "operation") {
      const matches = $app.findRecordsByFilter(collection, "owner = {:o} && canvas = {:c} && operation_id = {:i}", "", 1, 0, { o: owner, c: canvasId, i: e.request.pathValue("operationId") });
      return e.json(200, matches.length ? publicJob(matches[0], json(matches[0], "payload")) : null);
    }
    const jobId = String(body.quoteId || e.request.pathValue("jobId") || "");
    let rec = owned($app, jobId, owner, canvasId), p = json(rec, "payload");
    if (action === "quote_get") return e.json(200, summarize(rec, p));
    if (action === "approve") {
      $app.runInTransaction((app) => {
        rec = owned(app, jobId, owner, canvasId);
        p = json(rec, "payload");
        if (p.state !== "created" || p.expiresAt < Date.now()) fail("QUOTE_EXPIRED");
        if (Number(json(canvas(app, canvasId, owner), "canvas_data").rev || 0) !== p.revision) fail("REVISION_CONFLICT");
        p.approved = true;
        persist(rec, p, app);
      });
      return e.json(200, summarize(rec, p));
    }
    if (action === "run") {
      if (!/^[\w.-]{1,128}$/.test(String(body.operationId || ""))) fail("INVALID_OPERATION");
      let submit = false;
      $app.runInTransaction((app) => {
        rec = owned(app, jobId, owner, canvasId);
        p = json(rec, "payload");
        if (body.nodeId !== p.nodeId || body.expectedRevision !== p.revision) fail("QUOTE_MISMATCH");
        if (p.operationId) {
          if (p.operationId !== body.operationId) fail("IDEMPOTENCY_CONFLICT");
          return;
        }
        if (!p.approved) fail("APPROVAL_REQUIRED");
        if (p.expiresAt < Date.now()) fail("QUOTE_EXPIRED");
        if (Number(json(canvas(app, canvasId, owner), "canvas_data").rev || 0) !== p.revision) fail("REVISION_CONFLICT");
        p.operationId = body.operationId;
        p.state = "submitting";
        rec.set("operation_id", body.operationId);
        persist(rec, p, app);
        submit = true;
      });
      if (submit) {
        try {
          const accepted = request(e, "/api/aigc/submit", __spreadProps(__spreadValues({}, p.body), { idemKey: p.operationId, agentMaxCharge: p.price.estimatedPrice }));
          if (!accepted.taskId) fail("SUBMISSION_UNKNOWN");
          p.remoteId = String(accepted.taskId);
          p.state = "submitted";
          p.chargeAmount = accepted.chargeAmount;
          persist(rec, p);
        } catch (e2) {
          p.state = "submission_unknown";
          p.error = "\u63D0\u4EA4\u7ED3\u679C\u672A\u77E5\uFF0C\u5C06\u6309\u64CD\u4F5C\u8BB0\u5F55\u5BF9\u8D26\uFF0C\u7981\u6B62\u81EA\u52A8\u91CD\u8BD5";
          persist(rec, p);
        }
      }
      return e.json(200, publicJob(rec, p));
    }
    if (action === "get") {
      if (p.state === "submitting" || p.state === "submission_unknown") {
        const matches = $app.findRecordsByFilter("aigc_tasks", "user_email = {:o} && idem_key = {:i} && model_name = {:m}", "-created", 2, 0, { o: owner, i: p.operationId, m: p.body.model });
        if (matches.length === 1) {
          p.remoteId = String(matches[0].get("task_id"));
          p.state = "submitted";
          delete p.error;
          persist(rec, p);
        } else {
          p.state = "submission_unknown";
          persist(rec, p);
          return e.json(200, publicJob(rec, p));
        }
      }
      if (p.remoteId && ["submitted", "running"].includes(p.state)) {
        const remote = request(e, "/api/aigc/jobs/" + encodeURIComponent(p.remoteId) + "/poll", {});
        const state = String(remote.status || "").toUpperCase();
        if (state === "FAILED" || state === "CANCEL") {
          p.state = "failed";
          p.error = "\u8282\u70B9\u751F\u6210\u5931\u8D25";
        } else if (state === "SUCCESS" && ((_b = (_a = remote.outputs) == null ? void 0 : _a[0]) == null ? void 0 : _b.url)) {
          p.state = "succeeded";
          p.remoteOutput = String(remote.outputs[0].url);
        } else p.state = "running";
        persist(rec, p);
      }
      if (p.state === "succeeded" && p.storageState !== "stored") {
        try {
          const media = request(e, "/api/media/save-remote", { url: p.remoteOutput, mediaType: "image" });
          if (!media.url) fail("STORAGE_FAILED");
          p.outputUrl = media.url;
          p.storageState = "stored";
          delete p.error;
        } catch (e2) {
          p.storageState = "failed";
          p.error = "\u56FE\u7247\u5DF2\u751F\u6210\uFF0C\u6C38\u4E45\u5B58\u50A8\u5C1A\u672A\u5B8C\u6210\uFF0C\u53EF\u518D\u6B21\u67E5\u8BE2\u91CD\u8BD5\u8F6C\u5B58";
        }
        persist(rec, p);
      }
      if (p.state === "succeeded" && p.storageState === "stored" && p.applyState !== "applied") {
        $app.runInTransaction((app) => {
          rec = owned(app, jobId, owner, canvasId);
          p = json(rec, "payload");
          if (p.applyState === "applied") return;
          const target = canvas(app, canvasId, owner), doc = json(target, "canvas_data");
          const applied = applyImageResult(doc, p.nodeId, p.operationId, { url: p.outputUrl, model: p.body.model, promptText: p.body.prompt, taskId: p.remoteId, costText: p.chargeAmount ? "\xA5" + Number(p.chargeAmount).toFixed(2) : "" });
          p.applyState = applied.applyState;
          if (applied.doc !== doc) {
            target.set("canvas_data", applied.doc);
            app.save(target);
          }
          p.appliedRevision = applied.doc.rev;
          persist(rec, p, app);
        });
      }
      return e.json(200, publicJob(rec, p));
    }
    fail("INVALID_ACTION");
  } catch (err) {
    const raw = String(err.code || err.message || "BRIDGE_ERROR");
    const code = /^[A-Z_]+$/.test(raw) ? raw : "BRIDGE_ERROR";
    return e.json(code.endsWith("NOT_FOUND") ? 404 : ["REVISION_CONFLICT", "IDEMPOTENCY_CONFLICT", "QUOTE_EXPIRED"].includes(code) ? 409 : code === "APPROVAL_REQUIRED" ? 403 : 400, { error: code });
  }
}
