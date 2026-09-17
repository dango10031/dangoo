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

// src/adapters/pocketbase-mapping.ts
var pocketbase_mapping_exports = {};
__export(pocketbase_mapping_exports, {
  NODE_CATALOG: () => NODE_CATALOG,
  SUPPORTED_OPERATIONS: () => SUPPORTED_OPERATIONS,
  applyCanvasOperations: () => applyCanvasOperations,
  fromDangoo: () => fromDangoo,
  toDangoo: () => toDangoo
});
module.exports = __toCommonJS(pocketbase_mapping_exports);

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
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
var kinds = ["prompt", "generate", "polish", "result", "video", "layer", "replicate", "agent", "loop", "merge", "tts", "motion", "vsr", "camera"];
var NODE_CATALOG = kinds.map((kind) => ({ kind, name: kind, description: `Dangoo ${kind} \u8282\u70B9\uFF1B\u6267\u884C\u80FD\u529B\u4EE5\u670D\u52A1\u7AEF\u63E1\u624B\u4E3A\u51C6`, runnable: false, parameters: { type: "object", properties: { title: { type: "string", maxLength: 160 }, prompt: { type: "string", maxLength: 24e3 }, model: { type: "string", maxLength: 120 }, width: { type: "number", minimum: 64, maximum: 4096 }, height: { type: "number", minimum: 64, maximum: 4096 } }, additionalProperties: false } }));
var SUPPORTED_OPERATIONS = ["create", "update", "delete", "duplicate", "connect", "disconnect", "layout", "group", "ungroup"];
var GENERATION_PARAMETERS = { type: "object", properties: { model: { type: "string", maxLength: 120 }, resolution: { enum: ["1k", "2k", "4k"] }, aspectRatio: { type: "string", maxLength: 16 }, quality: { enum: ["low", "medium", "high"] }, count: { const: 1 } }, additionalProperties: false };
for (const node of NODE_CATALOG) if (node.kind === "generate") node.parameters.properties.genParams = GENERATION_PARAMETERS;
var writable = /* @__PURE__ */ new Set(["title", "prompt", "model", "width", "height", "genParams"]);
var invalid = (message) => {
  throw new IntegrationError("INVALID_OPERATION", message);
};
var finite = (n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e6;
var id = (s) => typeof s === "string" && /^[\w.-]{1,128}$/.test(s);
function applyCanvasOperations(source, changes) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > 100) invalid("\u6BCF\u6B21\u4E8B\u52A1\u987B\u5305\u542B 1\u2013100 \u4E2A\u64CD\u4F5C\uFF1B\u5927\u4EFB\u52A1\u53EF\u5206\u6279\u3002");
  const doc = clone(source);
  const node = (nodeId) => {
    var _a;
    return (_a = doc.nodes.find((n) => n.id === nodeId)) != null ? _a : invalid(`\u8282\u70B9\u4E0D\u5B58\u5728: ${nodeId}`);
  };
  const patch = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid("patch \u5FC5\u987B\u4E3A\u5BF9\u8C61");
    for (const [key, v] of Object.entries(value)) {
      if (!writable.has(key)) invalid(`\u4E0D\u5141\u8BB8\u5199\u5165\u5B57\u6BB5: ${key}`);
      if (["title", "prompt", "model"].includes(key) && (typeof v !== "string" || v.length > (key === "prompt" ? 24e3 : 160))) invalid("\u6587\u672C\u5B57\u6BB5\u4E0D\u5408\u6CD5");
      if (["width", "height"].includes(key) && (!finite(v) || Number(v) < 64 || Number(v) > 4096)) invalid("\u5C3A\u5BF8\u4E0D\u5408\u6CD5");
      if (key === "genParams") {
        if (!v || typeof v !== "object" || Array.isArray(v)) invalid("\u751F\u6210\u53C2\u6570\u5FC5\u987B\u4E3A\u5BF9\u8C61");
        for (const [name, value2] of Object.entries(v)) {
          if (!Object.prototype.hasOwnProperty.call(GENERATION_PARAMETERS.properties, name)) invalid("\u4E0D\u652F\u6301\u7684\u751F\u6210\u53C2\u6570");
          if (name === "count") {
            if (value2 !== 1) invalid("\u5F53\u524D\u53EA\u652F\u6301\u5355\u5F20\u751F\u6210");
          } else if (typeof value2 !== "string" || value2.length > 120) invalid("\u751F\u6210\u53C2\u6570\u683C\u5F0F\u9519\u8BEF");
          if (name === "resolution" && !["1k", "2k", "4k"].includes(String(value2))) invalid("\u5206\u8FA8\u7387\u4E0D\u652F\u6301");
          if (name === "quality" && !["low", "medium", "high"].includes(String(value2))) invalid("\u8D28\u91CF\u4E0D\u652F\u6301");
        }
      }
    }
    return clone(value);
  };
  for (const op of changes) {
    if (!op || typeof op !== "object" || !SUPPORTED_OPERATIONS.includes(op.type)) invalid("\u5F53\u524D\u6865\u63A5\u4E0D\u652F\u6301\u8BE5\u64CD\u4F5C");
    switch (op.type) {
      case "create": {
        const n = op.node;
        if (!n || !id(n.id) || doc.nodes.some((x) => x.id === n.id) || !kinds.includes(n.kind) || !finite(n.x) || !finite(n.y)) invalid("\u65B0\u8282\u70B9 ID\u3001\u7C7B\u578B\u6216\u4F4D\u7F6E\u4E0D\u5408\u6CD5");
        doc.nodes.push({ id: n.id, kind: n.kind, x: n.x, y: n.y, data: patch(n.data) });
        break;
      }
      case "update":
        Object.assign(node(op.nodeId).data, patch(op.patch));
        break;
      case "delete":
        node(op.nodeId);
        doc.nodes = doc.nodes.filter((n) => n.id !== op.nodeId);
        doc.edges = doc.edges.filter((e) => e.from !== op.nodeId && e.to !== op.nodeId);
        break;
      case "duplicate": {
        if (!id(op.newId) || doc.nodes.some((n2) => n2.id === op.newId) || !finite(op.x) || !finite(op.y)) invalid("\u526F\u672C ID \u6216\u4F4D\u7F6E\u4E0D\u5408\u6CD5");
        const n = clone(node(op.nodeId));
        n.id = op.newId;
        n.x = op.x;
        n.y = op.y;
        n.data = Object.fromEntries(Object.entries(n.data).filter(([k]) => writable.has(k)));
        doc.nodes.push(n);
        break;
      }
      case "connect": {
        const e = op.edge;
        if (!e || !id(e.id) || doc.edges.some((x) => x.id === e.id) || e.from === e.to) invalid("\u8FDE\u7EBF\u4E0D\u5408\u6CD5");
        node(e.from);
        node(e.to);
        if (doc.edges.some((x) => x.from === e.from && x.to === e.to)) invalid("\u91CD\u590D\u8FDE\u7EBF");
        const seen = /* @__PURE__ */ new Set();
        const reaches = (a) => {
          if (a === e.from) return true;
          if (seen.has(a)) return false;
          seen.add(a);
          return doc.edges.filter((x) => x.from === a).some((x) => reaches(x.to));
        };
        if (reaches(e.to)) invalid("\u8FDE\u7EBF\u4F1A\u5F62\u6210\u73AF");
        doc.edges.push(clone(e));
        break;
      }
      case "disconnect":
        if (!doc.edges.some((e) => e.id === op.edgeId)) invalid("\u8FDE\u7EBF\u4E0D\u5B58\u5728");
        doc.edges = doc.edges.filter((e) => e.id !== op.edgeId);
        break;
      case "layout":
        if (!Array.isArray(op.positions)) invalid("\u7F3A\u5C11\u4F4D\u7F6E\u5217\u8868");
        for (const p of op.positions) {
          if (!finite(p.x) || !finite(p.y)) invalid("\u4F4D\u7F6E\u4E0D\u5408\u6CD5");
          Object.assign(node(p.nodeId), { x: p.x, y: p.y });
        }
        break;
      case "group":
        if (!id(op.id) || !Array.isArray(op.nodeIds) || !op.nodeIds.length) invalid("\u5206\u7EC4\u4E0D\u5408\u6CD5");
        for (const n of op.nodeIds) node(n).data.groupId = op.id;
        break;
      case "ungroup":
        for (const n of doc.nodes) if (n.data.groupId === op.id) delete n.data.groupId;
        break;
    }
  }
  doc.revision++;
  return doc;
}

// src/adapters/pocketbase-mapping.ts
function fromDangoo(canvasId, doc) {
  const cards = Array.isArray(doc.cards) ? doc.cards : [];
  return { canvasId, revision: Number(doc.rev) || 0, nodes: cards.map((raw) => {
    const _a = raw, { id: id2, kind, x, y } = _a, data = __objRest(_a, ["id", "kind", "x", "y"]);
    return { id: String(id2), kind: String(kind), x: Number(x), y: Number(y), data };
  }), edges: (Array.isArray(doc.connections) ? doc.connections : []).map((raw) => {
    const e = raw;
    return { id: String(e.id), from: String(e.fromId), to: String(e.toId) };
  }) };
}
function toDangoo(current, snapshot) {
  const priorEdges = Array.isArray(current.connections) ? current.connections : [];
  return __spreadProps(__spreadValues({}, current), { rev: snapshot.revision, cards: snapshot.nodes.map((node) => {
    var _b, _c;
    const _a = node.data, { width, height } = _a, data = __objRest(_a, ["width", "height"]);
    return __spreadProps(__spreadValues({}, data), { id: node.id, kind: node.kind, x: node.x, y: node.y, w: (_b = width != null ? width : data.w) != null ? _b : 288, h: (_c = height != null ? height : data.h) != null ? _c : 200 });
  }), connections: snapshot.edges.map((e) => __spreadProps(__spreadValues({}, priorEdges.find((old) => old.id === e.id)), { id: e.id, fromId: e.from, toId: e.to })) });
}
