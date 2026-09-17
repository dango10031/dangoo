/// <reference path="../pb_data/types.d.ts" />
// @vibex-protocol: markup/1
// pb_hooks/aigc.pb.js — RunningHub AIGC 标准模型中转 (self-contained, 单路由 + allowlist)
//
// 上面那行协议标记 + 下面各处的 localForwardRhHeaders 是「创作者自主定价」的发布
// 审计判据: 标记声明意图, 而真正被检查的是 "X-RH-Vibex-Ticket" 这个字面量确实出现在
// 请求头构造里。只认注释会被旧模板复制粘贴骗过, 只认函数定义会被一个从没被调用的
// 空壳骗过 —— 那正是"配了系数一分不加"的静默失效来源。判定结果决定后台能否配 >0。
//
// 路由约定:
//   GET  /api/aigc/models
//   POST /api/aigc/upload                         multipart file -> RH download_url
//   POST /api/aigc/submit                         body.model=<rh-model-short>
//   POST /api/aigc/jobs/{jobId}/poll
//   POST /api/aigc/history                         body.model 可选
//   POST /api/aigc/history/{jobId}/update
//   POST /api/aigc/history/{jobId}/delete
//
// ⚠️ 这个文件由 mcp__rh-pb-hooks__install_aigc_template / install_aigc_routes 装到目标路径。
//    加模型只更新 ALLOWED_MODELS, 不新增 per-model routerAdd。
//
// 业务字段 (book_id / order_id 等) 必须新建独立 collection 用 task_id 外键关联,
// **禁止**往 aigc_tasks 加业务字段 (会逼模型绕开 MCP 自己 Write).
//
// 字段名注意:
//   - PB 不允许字段名叫 model (跟 PB Record 内置属性冲突) → 表字段用 model_name。
//   - 前端传 body.model, 后端用 ALLOWED_MODELS[model] 校验并读取 endpoint/payload 契约。

// Published and dev containers inject the current app id. Keep the rendered
// literal only as a local-export fallback so Remix copies follow their runtime.
var VIBEX_APP_ID = $os.getenv("VIBEX_APP_ID") || "app-ca81449e917d4660aa213c5c13d47008"
var ALLOWED_MODELS = {"gpt-image-2":{"endpoint":"rhart-image-g-2-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-0-text-to-image-channel-low-price":{"endpoint":"rhart-image-g-2/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2-gemini31flash-text-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"21:9"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2":{"endpoint":"rhart-image-n-g31-flash/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"]}],"media_params":[]},"nano-banana-pro-text-to-image-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/text-to-image-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"3:4"}],"media_params":[]},"nano-banana-pro":{"endpoint":"rhart-image-n-pro/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-image-to-image-official-stable":{"endpoint":"rhart-image-g-2-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":50}]},"gpt-image-2-0-edit-channel-low-price":{"endpoint":"rhart-image-g-2/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana2-gemini31flash-image-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":14,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana2-gemini31flash-image-to-image-channel-low-price":{"endpoint":"rhart-image-n-g31-flash/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana-pro-edit-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/edit-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"empty"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana-pro-edit-channel-low-price":{"endpoint":"rhart-image-n-pro/edit","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"seedance-2-0-mini-text-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"webSearch","required":false,"type":"bool","default":false},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[]},"seedance-2":{"endpoint":"rhart-video/sparkvideo-2.0/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true}],"media_params":[]},"seedance-2.5":{"endpoint":"bytedance/seedance-2.5-token/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[]},"xai-grok-imagine-video-v1-5-text-to-video-official-stable":{"endpoint":"rhart-video-g-official/text-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"aspectRatio","required":false,"type":"string","enum":["16:9","1:1","9:16","3:2","2:3"],"default":"16:9"},{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p"],"default":"720p"}],"media_params":[]},"minimax-h3-text-to-video":{"endpoint":"minimax/hailuo-h3/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"ratio","required":false,"type":"string","enum":["21:9","16:9","4:3","1:1","3:4","9:16"],"default":"16:9"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[]},"seedance2-0-multimodal-video":{"endpoint":"rhart-video/sparkvideo-2.0/multimodal-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"imageUrls","type":"image","required":false,"multiple":true,"max_num":9,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"videoUrls","type":"video","required":false,"multiple":true,"max_num":3,"accept":"[\"MP4\"]","max_size":50},{"name":"audioUrls","type":"audio","required":false,"multiple":true,"max_num":3,"accept":"[\"MP3\",\"WAV\"]","max_size":50}]},"seedance-2-0-mini-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"realPersonMode","required":false,"type":"bool","default":true},{"name":"conversionSlots","required":false,"type":"string","enum":["all","firstFrameUrl","lastFrameUrl"],"default":"all"},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance2-0-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance-2-5-image-to-video-token":{"endpoint":"bytedance/seedance-2.5-token/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30}]},"xai-grok-imagine-video-v1-5-image-to-video-official-stable":{"endpoint":"rhart-video-g-official/image-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"resolution","required":true,"type":"string","enum":["480p","720p"],"default":"720p"}],"media_params":[{"name":"imageUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":100}]},"minimax-h3-image-to-video-first-last-frame":{"endpoint":"minimax/hailuo-h3/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]}}

onBootstrap(function (e) {
  e.next()
  try {
    var existing = null
    try { existing = $app.findCollectionByNameOrId("aigc_tasks") } catch (_) { existing = null }
    if (existing) {
      try {
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
        addField({ name: "rating", type: "number", min: 0, max: 5 })
        addField({ name: "favorite", type: "bool" })
        addField({ name: "category", type: "text", max: 32 })
        addField({ name: "note", type: "text", max: 1000 })
        addField({ name: "created", type: "autodate", onCreate: true })
        addField({ name: "updated", type: "autodate", onCreate: true, onUpdate: true })
        addField({ name: "consume_money", type: "text", max: 64 })
        addField({ name: "consume_coins", type: "text", max: 64 })
        addField({ name: "task_cost_time", type: "text", max: 64 })
        addField({ name: "third_party_consume_money", type: "text", max: 64 })
        addField({ name: "user_email", type: "text", max: 255 })
        addField({ name: "idem_key", type: "text", max: 128 })
        addField({ name: "charge_amount", type: "number" })
        if (changed) $app.save(existing)
      } catch (schemaErr) {
        try { $app.logger().error("aigc_tasks schema upgrade: " + String(schemaErr && schemaErr.message || schemaErr)) } catch (_) {}
      }
    } else {
      var col = new Collection({
        type: "base", name: "aigc_tasks",
        listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
        fields: [
          { name: "task_id", type: "text", required: true, max: 160 },
          { name: "rh_user_id", type: "text", max: 160 },
          { name: "user_email", type: "text", max: 255 },
          { name: "rh_task_id", type: "text", max: 160 },
          { name: "model_name", type: "text", required: true, max: 64 },
          { name: "page", type: "text", max: 64 },
          { name: "prompt", type: "text", max: 5000 },
          { name: "status", type: "text", required: true, max: 32 },
          { name: "result_url", type: "text", max: 2048 },
          { name: "error_message", type: "text", max: 4000 },
          { name: "rating", type: "number", min: 0, max: 5 },
          { name: "favorite", type: "bool" },
          { name: "category", type: "text", max: 32 },
          { name: "note", type: "text", max: 1000 },
          { name: "created", type: "autodate", onCreate: true },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
          { name: "consume_money", type: "text", max: 64 },
          { name: "consume_coins", type: "text", max: 64 },
          { name: "task_cost_time", type: "text", max: 64 },
          { name: "third_party_consume_money", type: "text", max: 64 },
          { name: "idem_key", type: "text", max: 128 },
          { name: "charge_amount", type: "number" },
        ],
        indexes: ["CREATE UNIQUE INDEX idx_aigc_tasks_task_id ON aigc_tasks (task_id)"],
      })
      $app.save(col)
      try { $app.logger().info("aigc_tasks created") } catch (_) {}
    }
  } catch (err) {
    try { $app.logger().error("aigc_tasks bootstrap: " + String(err && err.message || err)) } catch (_) {}
  }
})

function listAllowedModels() {
  var items = []
  for (var key in ALLOWED_MODELS) {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_MODELS, key)) continue
    var cfg = ALLOWED_MODELS[key] || {}
    items.push({
      model: key,
      endpoint: cfg.endpoint || "",
      output_type: cfg.output_type || "image",
      primary_input: cfg.primary_input || null,
      scalar_params: cfg.scalar_params || [],
      media_params: cfg.media_params || [],
    })
  }
  return items
}

function readKey(ev) {
  return $os.getenv("RH_API_KEY") || ""
}

function responseText(res) { return (res && typeof res.raw === "string") ? res.raw : "" }
function responseJson(res) { var raw = responseText(res); try { return JSON.parse(raw) } catch (_) { return null } }

function newTaskId() { return "task-" + new Date().getTime() + "-" + Math.random().toString(16).slice(2, 10) }

function keyFingerprint(k) {
  var s = String(k || "")
  if (!s) return ""
  var h1 = 0x811c9dc5 >>> 0, h2 = 0x1000193 >>> 0
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i)
    h1 = ((h1 ^ c) >>> 0); h1 = (h1 * 16777619) >>> 0
    h2 = ((h2 + c) >>> 0); h2 = (h2 * 2246822519) >>> 0
  }
  function hex8(n) { var x = (n >>> 0).toString(16); while (x.length < 8) x = "0" + x; return x }
  return hex8(h1) + hex8(h2)
}

function isRhAuthErr(raw) {
  var s = String(raw || "")
  return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0 || s.indexOf("APIKEY_INVALID") >= 0 || s.indexOf("TOKEN_INVALID") >= 0
    || s.indexOf("user not exist") >= 0 || s.indexOf('"code":301') >= 0
    || s.indexOf('"errorCode":"806"') >= 0 || s.indexOf('"errorCode":"412"') >= 0
}

function mapRhBizErr(parsed, raw) {
  var p = parsed || {}
  var code = String(p.errorCode || p.code || p.errCode || "")
  var msg = String(p.errorMsg || p.errorMessage || p.message || p.msg || p.error || raw || "")
  var hay = (code + " " + msg + " " + String(raw || "")).toLowerCase()
  if (code === "605" || hay.indexOf("insufficient") >= 0 || hay.indexOf("balance") >= 0 || hay.indexOf("余额") >= 0 || hay.indexOf("点数") >= 0 || hay.indexOf("积分") >= 0) {
    return { error: "rh_insufficient_balance", errorCode: code || "605", message: "RunningHub 账户余额不足" }
  }
  if (hay.indexOf("content security audit") >= 0 || hay.indexOf("content moderation") >= 0 || hay.indexOf("内容安全审查") >= 0 || hay.indexOf("内容审查") >= 0 || hay.indexOf("审核未通过") >= 0) {
    return { error: "rh_content_audit", errorCode: code, message: "内容审核未通过" }
  }
  if (code || msg) return { error: "rh_submit_failed", errorCode: code, message: "RunningHub 提交失败, 请稍后重试" }
  return null
}

function ensureColl() {
  try { return $app.findCollectionByNameOrId("aigc_tasks") } catch (_) {}
  var col = new Collection({
    type: "base", name: "aigc_tasks",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: "task_id", type: "text", required: true, max: 160 },
      { name: "rh_user_id", type: "text", max: 160 },
      { name: "user_email", type: "text", max: 255 },
      { name: "rh_task_id", type: "text", max: 160 },
      { name: "model_name", type: "text", required: true, max: 64 },
      { name: "page", type: "text", max: 64 },
      { name: "prompt", type: "text", max: 5000 },
      { name: "status", type: "text", required: true, max: 32 },
      { name: "result_url", type: "text", max: 2048 },
      { name: "error_message", type: "text", max: 4000 },
      { name: "rating", type: "number", min: 0, max: 5 },
      { name: "favorite", type: "bool" },
      { name: "category", type: "text", max: 32 },
      { name: "note", type: "text", max: 1000 },
      { name: "created", type: "autodate", onCreate: true },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
      { name: "consume_money", type: "text", max: 64 },
      { name: "consume_coins", type: "text", max: 64 },
      { name: "task_cost_time", type: "text", max: 64 },
      { name: "third_party_consume_money", type: "text", max: 64 },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_aigc_tasks_task_id ON aigc_tasks (task_id)"],
  })
  $app.save(col)
  return $app.findCollectionByNameOrId("aigc_tasks")
}

function buildPayload(cfg, body) {
  var payload = { appCode: "vibex", vibexAppId: VIBEX_APP_ID }
  var inputText = String(body.prompt || body.text || body.description || body.lyrics || "").trim()
  var primary = cfg.primary_input || null
  if (primary && primary.name) {
    var pname = String(primary.name)
    inputText = String(body[pname] || "").trim()
    if (primary.required && !inputText) {
      return { error: { status: 400, body: { error: "input_required", message: "请输入内容" } } }
    }
    if (inputText.length > 8000) inputText = inputText.substring(0, 8000)
    payload[pname] = inputText
  } else {
    if (inputText.length > 8000) inputText = inputText.substring(0, 8000)
  }

  var params = cfg.scalar_params || cfg.params || []
  for (var i = 0; i < params.length; i++) {
    var p = params[i] || {}
    var name = String(p.name || "")
    if (!name) continue
    var ptype = String(p.type || "string")
    var val
    if (ptype === "bool") {
      val = (body[name] === undefined || body[name] === null) ? !!p.default : !!body[name]
    } else if (ptype === "number") {
      val = (body[name] === undefined || body[name] === null) ? Number(p.default || 0) : Number(body[name])
    } else {
      val = String((body[name] === undefined || body[name] === null || body[name] === "") ? (p.default || "") : body[name])
      if (p.enum && p.enum.length && p.enum.indexOf(val) < 0) val = String(p.default || p.enum[0] || "")
    }
    if (ptype === "string" && !p.required && val === "empty") continue
    if (p.wire === "list") {
      payload[name] = Array.isArray(body[name]) ? body[name] : (val ? [val] : [])
    } else {
      payload[name] = val
    }
  }

  var media = cfg.media_params || []
  function cleanMediaUrl(v) {
    var s = String(v || "").trim()
    if (!s) return ""
    if (s.indexOf("data:") === 0) return null
    if (!/^https?:\/\//i.test(s)) return null
    return s
  }
  for (var j = 0; j < media.length; j++) {
    var m = media[j] || {}
    var mname = String(m.name || "")
    if (!mname) continue
    if (m.multiple) {
      if (m.required && (!Array.isArray(body[mname]) || !body[mname].length)) {
        return { error: { status: 400, body: { error: "media_required", message: "缺少必填媒体 " + mname } } }
      }
      if (Array.isArray(body[mname]) && body[mname].length) {
        var cleaned = []
        for (var mi = 0; mi < body[mname].length; mi++) {
          var cu = cleanMediaUrl(body[mname][mi])
          if (cu === null) return { error: { status: 400, body: { error: "media_url_required", message: "请先上传媒体并传入可访问的 URL: " + mname } } }
          if (cu) cleaned.push(cu)
        }
        if (cleaned.length) payload[mname] = cleaned
      }
    } else {
      if (m.required && !body[mname]) {
        return { error: { status: 400, body: { error: "media_required", message: "缺少必填媒体 " + mname } } }
      }
      if (body[mname]) {
        var su = cleanMediaUrl(body[mname])
        if (su === null) return { error: { status: 400, body: { error: "media_url_required", message: "请先上传媒体并传入可访问的 URL: " + mname } } }
        if (su) payload[mname] = su
      }
    }
  }

  if (cfg.payload_fields) {
    for (var extra in cfg.payload_fields) {
      if (Object.prototype.hasOwnProperty.call(cfg.payload_fields, extra)) payload[extra] = cfg.payload_fields[extra]
    }
  }
  return { payload: payload, input_text: inputText }
}

function normalizeOutputUrl(rawUrl) {
  if (!rawUrl) return rawUrl
  var u = String(rawUrl)
  var idx = u.indexOf("myqcloud.com/")
  if (idx >= 0) u = "https://rh-images.xiaoyaoyou.com/" + u.substring(idx + "myqcloud.com/".length)
  var qIdx = u.indexOf("?"); var path = qIdx >= 0 ? u.substring(0, qIdx) : u; var query = qIdx >= 0 ? u.substring(qIdx) : ""
  try { path = encodeURI(decodeURI(path)) } catch (_) {}
  return path + query
}

function reportTaskIndex(f) {
  try {
    var base = ($os.getenv("VIBEX_CONTROL_URL") || "").replace(/\/+$/, "")
    var appId = (f && f.app_id) || $os.getenv("VIBEX_APP_ID")
    if (!base || !appId || !f || !f.task_id) return
    var headers = { "Content-Type": "application/json" }
    var tok = $os.getenv("VIBEX_TASK_INDEX_TOKEN")
    if (tok) headers.Authorization = "Bearer " + tok
    $http.send({
      url: base + "/api/app-task-index/upsert", method: "POST", headers: headers,
      body: JSON.stringify({
        app_id: appId, snapshot_id: f.snapshot_id || $os.getenv("VIBEX_PUBLISH_SNAPSHOT_ID") || null,
        task_id: String(f.task_id), rh_user_id: f.rh_user_id || null, rh_task_id: f.rh_task_id || null,
        status: f.status || "running", error_message: f.error_message || null,
      }),
      timeout: 5,
    })
  } catch (_) {}
}

function safeString(r, name) { try { return r.getString(name) } catch (_) { return "" } }
function safeBool(r, name) { try { return !!r.getBool(name) } catch (_) { return false } }
function safeNumber(r, name) { try { return Number(r.get(name) || 0) || 0 } catch (_) { return 0 } }

function itemFromRecord(rec) {
  return {
    jobId: rec.getString("task_id"),
    taskId: rec.getString("rh_task_id"),
    status: rec.getString("status"),
    page: rec.getString("page"),
    prompt: rec.getString("prompt"),
    resultUrl: rec.getString("result_url"),
    errorMessage: rec.getString("error_message"),
    rating: safeNumber(rec, "rating"),
    favorite: safeBool(rec, "favorite"),
    category: safeString(rec, "category"),
    note: safeString(rec, "note"),
    created: rec.getString("created"),
    updated: rec.getString("updated"),
    model: rec.getString("model_name"),
    consumeMoney: safeString(rec, "consume_money"),
    consumeCoins: safeString(rec, "consume_coins"),
    taskCostTime: safeString(rec, "task_cost_time"),
    thirdPartyConsumeMoney: safeString(rec, "third_party_consume_money"),
  }
}

routerAdd("GET", "/api/aigc/models", function (e) {
  try {
    var allowedModels = {"gpt-image-2":{"endpoint":"rhart-image-g-2-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-0-text-to-image-channel-low-price":{"endpoint":"rhart-image-g-2/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2-gemini31flash-text-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"21:9"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2":{"endpoint":"rhart-image-n-g31-flash/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"]}],"media_params":[]},"nano-banana-pro-text-to-image-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/text-to-image-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"3:4"}],"media_params":[]},"nano-banana-pro":{"endpoint":"rhart-image-n-pro/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-image-to-image-official-stable":{"endpoint":"rhart-image-g-2-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":50}]},"gpt-image-2-0-edit-channel-low-price":{"endpoint":"rhart-image-g-2/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana2-gemini31flash-image-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":14,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana2-gemini31flash-image-to-image-channel-low-price":{"endpoint":"rhart-image-n-g31-flash/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana-pro-edit-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/edit-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"empty"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana-pro-edit-channel-low-price":{"endpoint":"rhart-image-n-pro/edit","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"seedance-2-0-mini-text-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"webSearch","required":false,"type":"bool","default":false},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[]},"seedance-2":{"endpoint":"rhart-video/sparkvideo-2.0/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true}],"media_params":[]},"seedance-2.5":{"endpoint":"bytedance/seedance-2.5-token/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[]},"xai-grok-imagine-video-v1-5-text-to-video-official-stable":{"endpoint":"rhart-video-g-official/text-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"aspectRatio","required":false,"type":"string","enum":["16:9","1:1","9:16","3:2","2:3"],"default":"16:9"},{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p"],"default":"720p"}],"media_params":[]},"minimax-h3-text-to-video":{"endpoint":"minimax/hailuo-h3/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"ratio","required":false,"type":"string","enum":["21:9","16:9","4:3","1:1","3:4","9:16"],"default":"16:9"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[]},"seedance2-0-multimodal-video":{"endpoint":"rhart-video/sparkvideo-2.0/multimodal-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"imageUrls","type":"image","required":false,"multiple":true,"max_num":9,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"videoUrls","type":"video","required":false,"multiple":true,"max_num":3,"accept":"[\"MP4\"]","max_size":50},{"name":"audioUrls","type":"audio","required":false,"multiple":true,"max_num":3,"accept":"[\"MP3\",\"WAV\"]","max_size":50}]},"seedance-2-0-mini-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"realPersonMode","required":false,"type":"bool","default":true},{"name":"conversionSlots","required":false,"type":"string","enum":["all","firstFrameUrl","lastFrameUrl"],"default":"all"},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance2-0-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance-2-5-image-to-video-token":{"endpoint":"bytedance/seedance-2.5-token/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30}]},"xai-grok-imagine-video-v1-5-image-to-video-official-stable":{"endpoint":"rhart-video-g-official/image-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"resolution","required":true,"type":"string","enum":["480p","720p"],"default":"720p"}],"media_params":[{"name":"imageUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":100}]},"minimax-h3-image-to-video-first-last-frame":{"endpoint":"minimax/hailuo-h3/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]}}
    var items = []
    for (var key in allowedModels) {
      if (!Object.prototype.hasOwnProperty.call(allowedModels, key)) continue
      var cfg = allowedModels[key] || {}
      items.push({
        model: key,
        endpoint: cfg.endpoint || "",
        output_type: cfg.output_type || "image",
        primary_input: cfg.primary_input || null,
        scalar_params: cfg.scalar_params || [],
        media_params: cfg.media_params || [],
      })
    }
    return e.json(200, { ok: true, models: items })
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("aigc_models_error: " + msg) } catch (_) {}
    return e.json(500, { error: "aigc_models_error", message: "模型列表暂时不可用" })
  }
})

routerAdd("POST", "/api/aigc/upload", function (e) {
  // 每个 routerAdd 处理器是独立作用域, 看不到顶层函数 (本文件里 localReadKey /
  // allowedModels 全都重复定义就是这个原因), 所以透传 helper 也得各带一份。
  function localForwardRhHeaders(ev, base) {
    var out = {}
    for (var k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k] }
    try {
      var h = ev.requestInfo().headers || {}
      function pick(a, b, c) { return h[a] || h[b] || h[c] || "" }
      var app = pick("x_rh_vibex_app", "X-RH-Vibex-App", "x-rh-vibex-app")
      var tkt = pick("x_rh_vibex_ticket", "X-RH-Vibex-Ticket", "x-rh-vibex-ticket")
      var sig = pick("x_rh_vibex_sign", "X-RH-Vibex-Sign", "x-rh-vibex-sign")
      if (app) out["X-RH-Vibex-App"] = String(app)
      if (tkt) out["X-RH-Vibex-Ticket"] = String(tkt)
      if (sig) out["X-RH-Vibex-Sign"] = String(sig)
    } catch (_) {}
    return out
  }
  function localReadKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function localIsRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0 || s.indexOf("APIKEY_INVALID") >= 0 || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf("user not exist") >= 0 || s.indexOf('"code":301') >= 0
      || s.indexOf('"errorCode":"806"') >= 0 || s.indexOf('"errorCode":"412"') >= 0
  }
  function localResponseText(res) { return (res && typeof res.raw === "string") ? res.raw : "" }
  function localResponseJson(res) { var raw = localResponseText(res); try { return JSON.parse(raw) } catch (_) { return null } }
  try {
    var key = localReadKey(e)
    if (!key) return e.json(412, { error: "rh_login_required", message: "请用右上角按钮登录 RunningHub" })

    var rhFile = null
    var fileType = "image"
    try {
      try { e.request.parseMultipartForm(64 << 20) } catch (_) {}
      var mf = e.request.multipartForm
      if (mf && mf.value && mf.value["fileType"] && mf.value["fileType"].length) fileType = String(mf.value["fileType"][0] || "image")
      if (mf && mf.file && mf.file["file"] && mf.file["file"].length) {
        rhFile = $filesystem.fileFromMultipart(mf.file["file"][0])
      }
    } catch (_) { rhFile = null }
    if (!rhFile) return e.json(400, { error: "invalid_upload", message: "请使用 multipart/form-data 上传 file 字段" })

    fileType = String(fileType || "image").toLowerCase()
    if (["image", "audio", "video", "zip"].indexOf(fileType) < 0) fileType = "image"

    var form = new FormData()
    form.append("file", rhFile)
    form.append("apiKey", key)
    var res = $http.send({
      url: "https://www.runninghub.cn/openapi/v2/media/upload/binary",
      method: "POST",
      headers: localForwardRhHeaders(e, { "Authorization": "Bearer " + key }),
      body: form,
      timeout: 60,
    })
    var raw = localResponseText(res)
    if (localIsRhAuthErr(raw)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期" })
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      try { $app.logger().error("rh_upload_http_error status=" + String(res ? res.statusCode : 0) + " body_length=" + String(raw.length)) } catch (_) {}
      return e.json(502, { error: "rh_upload_failed", message: "上传服务暂时不可用, 请稍后重试" })
    }
    var parsed = localResponseJson(res)
    var data = parsed && parsed.data ? parsed.data : parsed
    var downloadUrl = data && (data.download_url || data.downloadUrl)
    var fileName = data && (data.fileName || data.filename)
    if (!downloadUrl) {
      try { $app.logger().error("rh_upload_bad_response body_length=" + String(raw.length)) } catch (_) {}
      return e.json(502, { error: "rh_upload_bad_response", message: "上传服务返回异常, 请稍后重试" })
    }
    return e.json(200, {
      ok: true,
      type: data && data.type ? String(data.type) : fileType,
      download_url: String(downloadUrl),
      downloadUrl: String(downloadUrl),
      fileName: fileName ? String(fileName) : "",
      size: data && data.size ? String(data.size) : "",
    })
  } catch (err) {
    var msg = String(err && err.message || err)
    if (localIsRhAuthErr(msg)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期" })
    try { $app.logger().error("aigc_upload_error: " + msg) } catch (_) {}
    return e.json(500, { error: "aigc_upload_error", message: "上传失败, 请稍后重试" })
  }
})

routerAdd("POST", "/api/aigc/submit", function (e) {
  // 计价真正发生的入口, 票据在这里最关键: 丢了它 RH 认不出 app, 系数恒为 0。
  function localForwardRhHeaders(ev, base) {
    var out = {}
    for (var k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k] }
    try {
      var h = ev.requestInfo().headers || {}
      function pick(a, b, c) { return h[a] || h[b] || h[c] || "" }
      var app = pick("x_rh_vibex_app", "X-RH-Vibex-App", "x-rh-vibex-app")
      var tkt = pick("x_rh_vibex_ticket", "X-RH-Vibex-Ticket", "x-rh-vibex-ticket")
      var sig = pick("x_rh_vibex_sign", "X-RH-Vibex-Sign", "x-rh-vibex-sign")
      if (app) out["X-RH-Vibex-App"] = String(app)
      if (tkt) out["X-RH-Vibex-Ticket"] = String(tkt)
      if (sig) out["X-RH-Vibex-Sign"] = String(sig)
    } catch (_) {}
    return out
  }
  function localReadKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function localNewTaskId() { return "task-" + new Date().getTime() + "-" + Math.random().toString(16).slice(2, 10) }
  function localKeyFingerprint(k) {
    var s = String(k || "")
    if (!s) return ""
    var h1 = 0x811c9dc5 >>> 0, h2 = 0x1000193 >>> 0
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      h1 = ((h1 ^ c) >>> 0); h1 = (h1 * 16777619) >>> 0
      h2 = ((h2 + c) >>> 0); h2 = (h2 * 2246822519) >>> 0
    }
    function hex8(n) { var x = (n >>> 0).toString(16); while (x.length < 8) x = "0" + x; return x }
    return hex8(h1) + hex8(h2)
  }
  function localIsRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0 || s.indexOf("APIKEY_INVALID") >= 0 || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf("user not exist") >= 0 || s.indexOf('"code":301') >= 0
      || s.indexOf('"errorCode":"806"') >= 0 || s.indexOf('"errorCode":"412"') >= 0
  }
  function localMapRhBizErr(parsed, raw) {
    var p = parsed || {}
    var code = String(p.errorCode || p.code || p.errCode || "")
    var msg = String(p.errorMsg || p.errorMessage || p.message || p.msg || p.error || raw || "")
    var hay = (code + " " + msg + " " + String(raw || "")).toLowerCase()
    if (code === "605" || hay.indexOf("insufficient") >= 0 || hay.indexOf("balance") >= 0 || hay.indexOf("余额") >= 0 || hay.indexOf("点数") >= 0 || hay.indexOf("积分") >= 0) {
      return { error: "rh_insufficient_balance", errorCode: code || "605", message: "RunningHub 账户余额不足" }
    }
    if (hay.indexOf("content security audit") >= 0 || hay.indexOf("content moderation") >= 0 || hay.indexOf("内容安全审查") >= 0 || hay.indexOf("内容审查") >= 0 || hay.indexOf("审核未通过") >= 0) {
      return { error: "rh_content_audit", errorCode: code, message: "内容审核未通过" }
    }
    if (code || msg) return { error: "rh_submit_failed", errorCode: code, message: "RunningHub 提交失败, 请稍后重试" }
    return null
  }
  function localEnsureColl() {
    try { return $app.findCollectionByNameOrId("aigc_tasks") } catch (_) {}
    var col = new Collection({
      type: "base", name: "aigc_tasks",
      listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
      fields: [
        { name: "task_id", type: "text", required: true, max: 160 },
        { name: "rh_user_id", type: "text", max: 160 },
        { name: "user_email", type: "text", max: 255 },
        { name: "rh_task_id", type: "text", max: 160 },
        { name: "model_name", type: "text", required: true, max: 64 },
        { name: "page", type: "text", max: 64 },
        { name: "prompt", type: "text", max: 5000 },
        { name: "status", type: "text", required: true, max: 32 },
        { name: "result_url", type: "text", max: 2048 },
        { name: "error_message", type: "text", max: 4000 },
        { name: "rating", type: "number", min: 0, max: 5 },
        { name: "favorite", type: "bool" },
        { name: "category", type: "text", max: 32 },
        { name: "note", type: "text", max: 1000 },
        { name: "created", type: "autodate", onCreate: true },
        { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        { name: "consume_money", type: "text", max: 64 },
        { name: "consume_coins", type: "text", max: 64 },
        { name: "task_cost_time", type: "text", max: 64 },
        { name: "third_party_consume_money", type: "text", max: 64 },
        { name: "idem_key", type: "text", max: 128 },
        { name: "charge_amount", type: "number" },
      ],
      indexes: ["CREATE UNIQUE INDEX idx_aigc_tasks_task_id ON aigc_tasks (task_id)"],
    })
    $app.save(col)
    return $app.findCollectionByNameOrId("aigc_tasks")
  }
  function localBuildPayload(cfg, body) {
    var payload = { appCode: "vibex", vibexAppId: $os.getenv("VIBEX_APP_ID") || "app-ca81449e917d4660aa213c5c13d47008" }
    var inputText = String(body.prompt || body.text || body.description || body.lyrics || "").trim()
    var primary = cfg.primary_input || null
    if (primary && primary.name) {
      var pname = String(primary.name)
      inputText = String(body[pname] || "").trim()
      if (primary.required && !inputText) {
        return { error: { status: 400, body: { error: "input_required", message: "请输入内容" } } }
      }
      if (inputText.length > 8000) inputText = inputText.substring(0, 8000)
      payload[pname] = inputText
    } else {
      if (inputText.length > 8000) inputText = inputText.substring(0, 8000)
    }
    var params = cfg.scalar_params || cfg.params || []
    for (var i = 0; i < params.length; i++) {
      var p = params[i] || {}
      var name = String(p.name || "")
      if (!name) continue
      var ptype = String(p.type || "string")
      var val
      if (ptype === "bool") {
        val = (body[name] === undefined || body[name] === null) ? !!p.default : !!body[name]
      } else if (ptype === "number") {
        val = (body[name] === undefined || body[name] === null) ? Number(p.default || 0) : Number(body[name])
      } else {
        val = String((body[name] === undefined || body[name] === null || body[name] === "") ? (p.default || "") : body[name])
        if (p.enum && p.enum.length && p.enum.indexOf(val) < 0) val = String(p.default || p.enum[0] || "")
      }
      if (ptype === "string" && !p.required && val === "empty") continue
      if (p.wire === "list") {
        payload[name] = Array.isArray(body[name]) ? body[name] : (val ? [val] : [])
      } else {
        payload[name] = val
      }
    }
    var media = cfg.media_params || []
    function cleanMediaUrl(v) {
      var s = String(v || "").trim()
      if (!s) return ""
      if (s.indexOf("data:") === 0) return null
      if (!/^https?:\/\//i.test(s)) return null
      return s
    }
    for (var j = 0; j < media.length; j++) {
      var m = media[j] || {}
      var mname = String(m.name || "")
      if (!mname) continue
      if (m.multiple) {
        if (m.required && (!Array.isArray(body[mname]) || !body[mname].length)) {
          return { error: { status: 400, body: { error: "media_required", message: "缺少必填媒体 " + mname } } }
        }
        if (Array.isArray(body[mname]) && body[mname].length) {
          var cleaned = []
          for (var mi = 0; mi < body[mname].length; mi++) {
            var cu = cleanMediaUrl(body[mname][mi])
            if (cu === null) return { error: { status: 400, body: { error: "media_url_required", message: "请先上传媒体并传入可访问的 URL: " + mname } } }
            if (cu) cleaned.push(cu)
          }
          if (cleaned.length) payload[mname] = cleaned
        }
      } else {
        if (m.required && !body[mname]) {
          return { error: { status: 400, body: { error: "media_required", message: "缺少必填媒体 " + mname } } }
        }
        if (body[mname]) {
          var su = cleanMediaUrl(body[mname])
          if (su === null) return { error: { status: 400, body: { error: "media_url_required", message: "请先上传媒体并传入可访问的 URL: " + mname } } }
          if (su) payload[mname] = su
        }
      }
    }
    if (cfg.payload_fields) {
      for (var extra in cfg.payload_fields) {
        if (Object.prototype.hasOwnProperty.call(cfg.payload_fields, extra)) payload[extra] = cfg.payload_fields[extra]
      }
    }
    return { payload: payload, input_text: inputText }
  }
  function localReportTaskIndex(f) {
    try {
      var base = ($os.getenv("VIBEX_CONTROL_URL") || "").replace(/\/+$/, "")
      var appId = (f && f.app_id) || $os.getenv("VIBEX_APP_ID")
      if (!base || !appId || !f || !f.task_id) return
      var headers = { "Content-Type": "application/json" }
      var tok = $os.getenv("VIBEX_TASK_INDEX_TOKEN")
      if (tok) headers.Authorization = "Bearer " + tok
      $http.send({
        url: base + "/api/app-task-index/upsert", method: "POST", headers: headers,
        body: JSON.stringify({
          app_id: appId, snapshot_id: f.snapshot_id || $os.getenv("VIBEX_PUBLISH_SNAPSHOT_ID") || null,
          task_id: String(f.task_id), rh_user_id: f.rh_user_id || null, rh_task_id: f.rh_task_id || null,
          status: f.status || "running", error_message: f.error_message || null,
        }),
        timeout: 5,
      })
    } catch (_) {}
  }
  try {
    var allowedModels = {"gpt-image-2":{"endpoint":"rhart-image-g-2-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-0-text-to-image-channel-low-price":{"endpoint":"rhart-image-g-2/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2-gemini31flash-text-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"21:9"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2":{"endpoint":"rhart-image-n-g31-flash/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"]}],"media_params":[]},"nano-banana-pro-text-to-image-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/text-to-image-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"3:4"}],"media_params":[]},"nano-banana-pro":{"endpoint":"rhart-image-n-pro/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-image-to-image-official-stable":{"endpoint":"rhart-image-g-2-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":50}]},"gpt-image-2-0-edit-channel-low-price":{"endpoint":"rhart-image-g-2/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana2-gemini31flash-image-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":14,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana2-gemini31flash-image-to-image-channel-low-price":{"endpoint":"rhart-image-n-g31-flash/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana-pro-edit-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/edit-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"empty"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana-pro-edit-channel-low-price":{"endpoint":"rhart-image-n-pro/edit","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"seedance-2-0-mini-text-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"webSearch","required":false,"type":"bool","default":false},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[]},"seedance-2":{"endpoint":"rhart-video/sparkvideo-2.0/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true}],"media_params":[]},"seedance-2.5":{"endpoint":"bytedance/seedance-2.5-token/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[]},"xai-grok-imagine-video-v1-5-text-to-video-official-stable":{"endpoint":"rhart-video-g-official/text-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"aspectRatio","required":false,"type":"string","enum":["16:9","1:1","9:16","3:2","2:3"],"default":"16:9"},{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p"],"default":"720p"}],"media_params":[]},"minimax-h3-text-to-video":{"endpoint":"minimax/hailuo-h3/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"ratio","required":false,"type":"string","enum":["21:9","16:9","4:3","1:1","3:4","9:16"],"default":"16:9"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[]},"seedance2-0-multimodal-video":{"endpoint":"rhart-video/sparkvideo-2.0/multimodal-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"imageUrls","type":"image","required":false,"multiple":true,"max_num":9,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"videoUrls","type":"video","required":false,"multiple":true,"max_num":3,"accept":"[\"MP4\"]","max_size":50},{"name":"audioUrls","type":"audio","required":false,"multiple":true,"max_num":3,"accept":"[\"MP3\",\"WAV\"]","max_size":50}]},"seedance-2-0-mini-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"realPersonMode","required":false,"type":"bool","default":true},{"name":"conversionSlots","required":false,"type":"string","enum":["all","firstFrameUrl","lastFrameUrl"],"default":"all"},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance2-0-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance-2-5-image-to-video-token":{"endpoint":"bytedance/seedance-2.5-token/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30}]},"xai-grok-imagine-video-v1-5-image-to-video-official-stable":{"endpoint":"rhart-video-g-official/image-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"resolution","required":true,"type":"string","enum":["480p","720p"],"default":"720p"}],"media_params":[{"name":"imageUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":100}]},"minimax-h3-image-to-video-first-last-frame":{"endpoint":"minimax/hailuo-h3/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]}}
    var key = localReadKey(e)
    if (!key) return e.json(412, { error: "rh_login_required", message: "请用右上角按钮登录 RunningHub" })
    var body = e.requestInfo().body || {}
    var modelName = String(body.model || "").trim()
    var cfg = modelName ? allowedModels[modelName] : null
    if (!cfg) return e.json(400, { error: "model_not_allowed", message: "AIGC 模型未在服务端 allowlist 中启用", model: modelName })

    // 提交幂等: 前端在 body 顶层带 idemKey(<uid>-<uuid>)。同账号同 idemKey 已成功受理过的任务
    // (running/queued/success) 直接回放第一次的响应(同一 taskId), 不重建任务、不再调 RH。
    // 本次请求守卫已做的 held 预扣, 因这里直接返回、处理器不会置 settled, 请求结束时由守卫的
    // releaseUnacceptedHeld 自动 void 冲销 —— 重复提交不产生第二个 RH 任务, 也不会多扣一次。
    // 只对已受理任务去重; 首任务 failed 时允许用同一 idemKey 重新提交。
    var idemKey = String(body.idemKey || "").trim().substring(0, 128)
    if (idemKey) {
      var idemEmail = String(e.get("authEmail") || "").trim().toLowerCase()
      if (idemEmail) {
        // 运行时自愈补列: 老库若 bootstrap 未补成功, 这里幂等补一次 idem_key / charge_amount, 失败不阻断主流程。
        try {
          var idemCol0 = $app.findCollectionByNameOrId("aigc_tasks")
          var idemHas = false, chargeHas0 = false
          for (var ii = 0; ii < idemCol0.fields.length; ii++) {
            var fnm = String(idemCol0.fields[ii].name)
            if (fnm === "idem_key") idemHas = true
            if (fnm === "charge_amount") chargeHas0 = true
          }
          if (!idemHas) { idemCol0.fields.add(new Field({ name: "idem_key", type: "text", max: 128 })) }
          if (!chargeHas0) { idemCol0.fields.add(new Field({ name: "charge_amount", type: "number" })) }
          if (!idemHas || !chargeHas0) $app.save(idemCol0)
        } catch (_) {}
        var idemPrev = null
        try {
          idemPrev = $app.findFirstRecordByFilter(
            "aigc_tasks",
            "user_email = {:em} && idem_key = {:ik} && model_name = {:m} && (status = 'running' || status = 'queued' || status = 'success')",
            "-created",
            1, 0,
            { em: idemEmail, ik: idemKey, m: modelName }
          )
        } catch (_) { idemPrev = null }
        if (idemPrev) {
          try { $app.logger().info("submit idempotent replay idemKey=" + idemKey + " task=" + idemPrev.getString("task_id")) } catch (_) {}
          return e.json(200, { ok: true, taskId: idemPrev.getString("task_id"), rhTaskId: idemPrev.getString("rh_task_id"), status: idemPrev.getString("status") || "running", model: modelName, idempotent: true, chargeAmount: Number(idemPrev.get("charge_amount") || 0) || null })
        }
      }
    }

    var built = localBuildPayload(cfg, body)
    if (built.error) return e.json(built.error.status, built.error.body)
    var payload = built.payload
    var inputText = built.input_text || ""
    var endpoint = String(cfg.endpoint || "")
    if (!endpoint) return e.json(500, { error: "model_endpoint_missing", message: "模型 endpoint 未配置", fingerprint: modelName })
    if (endpoint.charAt(0) !== "/") endpoint = "/openapi/v2/" + endpoint.replace(/^\/?openapi\/v2\//, "")

    var res = $http.send({
      url: "https://www.runninghub.cn" + endpoint, method: "POST",
      headers: localForwardRhHeaders(e, { "Authorization": "Bearer " + key, "Content-Type": "application/json" }),
      body: JSON.stringify(payload), timeout: 30,
    })
    var rawBody = (res && typeof res.raw === "string") ? res.raw : ""
    if (localIsRhAuthErr(rawBody)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期" })
    // RH 并发上限(421 TASK_QUEUE_MAXED / 1520): 上一个任务没跑完时的重复提交,
    // 必须给"请稍候"而不是落进 502"网络或服务器繁忙"。
    if (rawBody.indexOf("TASK_QUEUE_MAXED") >= 0 || rawBody.indexOf('"code":421') >= 0 || rawBody.indexOf('"code":1520') >= 0 || rawBody.indexOf("Concurrency limit reached") >= 0) {
      return e.json(429, { error: "rh_task_queue_maxed", message: "上一个任务还在生成中, 请等它完成后再试", fingerprint: "rh_task_queue_maxed" })
    }
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      try { $app.logger().error("rh_submit_http_error status=" + String(res ? res.statusCode : 0) + " body_length=" + String(rawBody.length)) } catch (_) {}
      return e.json(502, { error: "rh_submit_failed", message: "生成服务暂时不可用, 请稍后重试" })
    }
    var parsed = null; try { parsed = JSON.parse(rawBody) } catch (_) {}
    if (!parsed || !parsed.taskId) {
      var bizErr = localMapRhBizErr(parsed, rawBody)
      if (bizErr) return e.json(200, bizErr)
      try { $app.logger().error("rh_submit_bad_response body_length=" + String(rawBody.length)) } catch (_) {}
      return e.json(502, { error: "rh_submit_bad_response", message: "生成服务返回异常, 请稍后重试" })
    }
    var rhTaskId = String(parsed.taskId); var localTaskId = localNewTaskId()
    try {
      var coll = localEnsureColl()
      var rec = new Record(coll)
      rec.set("task_id", localTaskId); rec.set("rh_task_id", rhTaskId); rec.set("model_name", modelName)
      rec.set("rh_user_id", localKeyFingerprint(key))
      rec.set("page", String(body.page || "")); rec.set("prompt", inputText); rec.set("status", "running")
      try { rec.set("charge_ref", String(e.get("chargeRef") || "")) } catch (_) {}
      try { rec.set("user_email", String(e.get("authEmail") || "")) } catch (_) {}
      if (idemKey) { try { rec.set("idem_key", idemKey) } catch (_) {} }
      // 站内实际扣费额(守卫按统一用户价计算), 供前端「本次花费」与日志展示, 与界面预估价同口径
      try { var settleAmt = Number(e.get("chargeAmount") || 0) || 0; if (settleAmt > 0) rec.set("charge_amount", settleAmt) } catch (_) {}
      $app.save(rec)
    } catch (_) {}
    localReportTaskIndex({ task_id: localTaskId, rh_task_id: rhTaskId, rh_user_id: localKeyFingerprint(key), status: "running" })
    // 任务被 RH 真正受理: 结算预扣流水(held->settled), 此笔才计入真实成本;
    // 普通用户同时累加累计消费, 管理员旁路不动站内余额。本地校验失败的请求在到达这里之前已被拦, 不会结算。
    try {
      var chargeRef = String(e.get("chargeRef") || "")
      var chargeAdmin = !!e.get("chargeAdmin")
      if (chargeRef) {
        var heldTxn = $app.findFirstRecordByFilter("wallet_txns", "ref = {:r} && status = 'held'", { r: chargeRef })
        if (heldTxn) {
          heldTxn.set("status", "settled")
          var prevNote = String(heldTxn.get("note") || "").replace("预扣", "扣费")
          heldTxn.set("note", prevNote)
          $app.save(heldTxn)
        }
        if (!chargeAdmin) {
          var em = String(e.get("authEmail") || "").trim().toLowerCase()
          if (em) {
            var wRec = $app.findFirstRecordByFilter("wallets", "user_email = {:em}", { em: em })
            if (wRec) {
              var amt = Number(e.get("chargeAmount") || 0)
              if (amt > 0) { wRec.set("total_consumed", Math.round(Number(wRec.get("total_consumed") || 0) * 100 + amt * 100) / 100); $app.save(wRec) }
            }
          }
        }
      }
    } catch (settleErr) { try { $app.logger().error("charge settle: " + String(settleErr && settleErr.message || settleErr)) } catch (_) {} }
    return e.json(200, { ok: true, taskId: localTaskId, rhTaskId: rhTaskId, status: "running", model: modelName, chargeAmount: Number(e.get("chargeAmount") || 0) || null })
  } catch (err) {
    var msg = String(err && err.message || err)
    if (localIsRhAuthErr(msg)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期" })
    try { $app.logger().error("aigc_submit_error: " + msg) } catch (_) {}
    return e.json(500, { error: "aigc_submit_error", message: "提交生成任务失败, 请稍后重试" })
  }
})

// 价格预估: 用和 /submit 完全相同的 payload 构造逻辑, 换成 RH 的 price-preview 端点
// (POST /openapi/v2/price-preview/<原端点>)。任何失败都返回 { ok: false }, 不抛错、不 412
// 阻塞生成流程 —— 前端只应隐藏价格徽标, 不应因为预估失败拦住用户点击生成按钮。
routerAdd("POST", "/api/aigc/price-preview", function (e) {
  // 预估价必须和实扣同口径: 这里丢票据会变成"预览显示原价、实际扣上浮价",
  // 是直接可见的资损争议, 比少赚严重。
  try {
  function localForwardRhHeaders(ev, base) {
    var out = {}
    for (var k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k] }
    try {
      var h = ev.requestInfo().headers || {}
      function pick(a, b, c) { return h[a] || h[b] || h[c] || "" }
      var app = pick("x_rh_vibex_app", "X-RH-Vibex-App", "x-rh-vibex-app")
      var tkt = pick("x_rh_vibex_ticket", "X-RH-Vibex-Ticket", "x-rh-vibex-ticket")
      var sig = pick("x_rh_vibex_sign", "X-RH-Vibex-Sign", "x-rh-vibex-sign")
      if (app) out["X-RH-Vibex-App"] = String(app)
      if (tkt) out["X-RH-Vibex-Ticket"] = String(tkt)
      if (sig) out["X-RH-Vibex-Sign"] = String(sig)
    } catch (_) {}
    return out
  }
  function localReadKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function localIsRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0 || s.indexOf("APIKEY_INVALID") >= 0 || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf("user not exist") >= 0 || s.indexOf('"code":301') >= 0
      || s.indexOf('"errorCode":"806"') >= 0 || s.indexOf('"errorCode":"412"') >= 0
  }
  function localBuildPayload(cfg, body) {
    var payload = { appCode: "vibex", vibexAppId: $os.getenv("VIBEX_APP_ID") || "app-ca81449e917d4660aa213c5c13d47008" }
    var inputText = String(body.prompt || body.text || body.description || body.lyrics || "").trim()
    var primary = cfg.primary_input || null
    if (primary && primary.name) {
      var pname = String(primary.name)
      inputText = String(body[pname] || "").trim()
      if (inputText.length > 8000) inputText = inputText.substring(0, 8000)
      payload[pname] = inputText
    } else {
      if (inputText.length > 8000) inputText = inputText.substring(0, 8000)
    }
    var params = cfg.scalar_params || cfg.params || []
    for (var i = 0; i < params.length; i++) {
      var p = params[i] || {}
      var name = String(p.name || "")
      if (!name) continue
      var ptype = String(p.type || "string")
      var val
      if (ptype === "bool") {
        val = (body[name] === undefined || body[name] === null) ? !!p.default : !!body[name]
      } else if (ptype === "number") {
        val = (body[name] === undefined || body[name] === null) ? Number(p.default || 0) : Number(body[name])
      } else {
        val = String((body[name] === undefined || body[name] === null || body[name] === "") ? (p.default || "") : body[name])
        if (p.enum && p.enum.length && p.enum.indexOf(val) < 0) val = String(p.default || p.enum[0] || "")
      }
      if (ptype === "string" && !p.required && val === "empty") continue
      if (p.wire === "list") {
        payload[name] = Array.isArray(body[name]) ? body[name] : (val ? [val] : [])
      } else {
        payload[name] = val
      }
    }
    var media = cfg.media_params || []
    function cleanMediaUrl(v) {
      var s = String(v || "").trim()
      if (!s) return ""
      if (s.indexOf("data:") === 0) return null
      if (!/^https?:\/\//i.test(s)) return null
      return s
    }
    for (var j = 0; j < media.length; j++) {
      var m = media[j] || {}
      var mname = String(m.name || "")
      if (!mname) continue
      if (m.multiple) {
        if (Array.isArray(body[mname]) && body[mname].length) {
          var cleaned = []
          for (var mi = 0; mi < body[mname].length; mi++) {
            var cu = cleanMediaUrl(body[mname][mi])
            if (cu) cleaned.push(cu)
          }
          if (cleaned.length) payload[mname] = cleaned
        }
      } else if (body[mname]) {
        var su = cleanMediaUrl(body[mname])
        if (su) payload[mname] = su
      }
    }
    if (cfg.payload_fields) {
      for (var extra in cfg.payload_fields) {
        if (Object.prototype.hasOwnProperty.call(cfg.payload_fields, extra)) payload[extra] = cfg.payload_fields[extra]
      }
    }
    return payload
  }
    var allowedModels = {"gpt-image-2":{"endpoint":"rhart-image-g-2-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-0-text-to-image-channel-low-price":{"endpoint":"rhart-image-g-2/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2-gemini31flash-text-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"21:9"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2":{"endpoint":"rhart-image-n-g31-flash/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"]}],"media_params":[]},"nano-banana-pro-text-to-image-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/text-to-image-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"3:4"}],"media_params":[]},"nano-banana-pro":{"endpoint":"rhart-image-n-pro/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-image-to-image-official-stable":{"endpoint":"rhart-image-g-2-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":50}]},"gpt-image-2-0-edit-channel-low-price":{"endpoint":"rhart-image-g-2/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana2-gemini31flash-image-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":14,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana2-gemini31flash-image-to-image-channel-low-price":{"endpoint":"rhart-image-n-g31-flash/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana-pro-edit-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/edit-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"empty"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana-pro-edit-channel-low-price":{"endpoint":"rhart-image-n-pro/edit","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"seedance-2-0-mini-text-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"webSearch","required":false,"type":"bool","default":false},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[]},"seedance-2":{"endpoint":"rhart-video/sparkvideo-2.0/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true}],"media_params":[]},"seedance-2.5":{"endpoint":"bytedance/seedance-2.5-token/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[]},"xai-grok-imagine-video-v1-5-text-to-video-official-stable":{"endpoint":"rhart-video-g-official/text-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"aspectRatio","required":false,"type":"string","enum":["16:9","1:1","9:16","3:2","2:3"],"default":"16:9"},{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p"],"default":"720p"}],"media_params":[]},"minimax-h3-text-to-video":{"endpoint":"minimax/hailuo-h3/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"ratio","required":false,"type":"string","enum":["21:9","16:9","4:3","1:1","3:4","9:16"],"default":"16:9"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[]},"seedance2-0-multimodal-video":{"endpoint":"rhart-video/sparkvideo-2.0/multimodal-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"imageUrls","type":"image","required":false,"multiple":true,"max_num":9,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"videoUrls","type":"video","required":false,"multiple":true,"max_num":3,"accept":"[\"MP4\"]","max_size":50},{"name":"audioUrls","type":"audio","required":false,"multiple":true,"max_num":3,"accept":"[\"MP3\",\"WAV\"]","max_size":50}]},"seedance-2-0-mini-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"realPersonMode","required":false,"type":"bool","default":true},{"name":"conversionSlots","required":false,"type":"string","enum":["all","firstFrameUrl","lastFrameUrl"],"default":"all"},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance2-0-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance-2-5-image-to-video-token":{"endpoint":"bytedance/seedance-2.5-token/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30}]},"xai-grok-imagine-video-v1-5-image-to-video-official-stable":{"endpoint":"rhart-video-g-official/image-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"resolution","required":true,"type":"string","enum":["480p","720p"],"default":"720p"}],"media_params":[{"name":"imageUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":100}]},"minimax-h3-image-to-video-first-last-frame":{"endpoint":"minimax/hailuo-h3/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]}}
    var key = localReadKey(e)
    if (!key) return e.json(200, { ok: false, message: "rh_login_required" })
    var body = e.requestInfo().body || {}
    var modelName = String(body.model || "").trim()
    var cfg = modelName ? allowedModels[modelName] : null
    if (!cfg) return e.json(200, { ok: false, message: "model_not_allowed" })
    var endpoint = String(cfg.endpoint || "")
    if (!endpoint) return e.json(200, { ok: false, message: "model_endpoint_missing" })
    if (endpoint.charAt(0) !== "/") endpoint = "/openapi/v2/" + endpoint.replace(/^\/?openapi\/v2\//, "")
    var previewEndpoint = endpoint.replace("/openapi/v2/", "/openapi/v2/price-preview/")
    var payload = localBuildPayload(cfg, body)

    var res = $http.send({
      url: "https://www.runninghub.cn" + previewEndpoint, method: "POST",
      headers: localForwardRhHeaders(e, { "Authorization": "Bearer " + key, "Content-Type": "application/json" }),
      body: JSON.stringify(payload), timeout: 15,
    })
    var rawBody = (res && typeof res.raw === "string") ? res.raw : ""
    if (localIsRhAuthErr(rawBody)) return e.json(200, { ok: false, message: "rh_login_required" })
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      return e.json(200, { ok: false, message: "price_preview_unavailable" })
    }
    var parsed = null; try { parsed = JSON.parse(rawBody) } catch (_) {}
    if (!parsed || parsed.errorCode) {
      return e.json(200, { ok: false, message: "price_preview_unavailable" })
    }
    return e.json(200, {
      ok: true,
      estimatedPrice: parsed.estimatedPrice,
      currency: parsed.currency || "CNY",
      priceText: parsed.priceText || "",
      freeLimit: !!parsed.freeLimit,
      isFreeThisCall: !!parsed.isFreeThisCall,
    })
  } catch (err) {
    return e.json(200, { ok: false, message: "price_preview_error" })
  }
})

routerAdd("POST", "/api/aigc/jobs/{jobId}/poll", function (e) {
  function localReadKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function localIsRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0 || s.indexOf("APIKEY_INVALID") >= 0 || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf("user not exist") >= 0 || s.indexOf('"code":301') >= 0
      || s.indexOf('"errorCode":"806"') >= 0 || s.indexOf('"errorCode":"412"') >= 0
  }
  function localNormalizeOutputUrl(rawUrl) {
    if (!rawUrl) return rawUrl
    var u = String(rawUrl)
    var idx = u.indexOf("myqcloud.com/")
    if (idx >= 0) u = "https://rh-images.xiaoyaoyou.com/" + u.substring(idx + "myqcloud.com/".length)
    var qIdx = u.indexOf("?"); var path = qIdx >= 0 ? u.substring(0, qIdx) : u; var query = qIdx >= 0 ? u.substring(qIdx) : ""
    try { path = encodeURI(decodeURI(path)) } catch (_) {}
    return path + query
  }
  function localReportTaskIndex(f) {
    try {
      var base = ($os.getenv("VIBEX_CONTROL_URL") || "").replace(/\/+$/, "")
      var appId = (f && f.app_id) || $os.getenv("VIBEX_APP_ID")
      if (!base || !appId || !f || !f.task_id) return
      var headers = { "Content-Type": "application/json" }
      var tok = $os.getenv("VIBEX_TASK_INDEX_TOKEN")
      if (tok) headers.Authorization = "Bearer " + tok
      $http.send({
        url: base + "/api/app-task-index/upsert", method: "POST", headers: headers,
        body: JSON.stringify({
          app_id: appId, snapshot_id: f.snapshot_id || $os.getenv("VIBEX_PUBLISH_SNAPSHOT_ID") || null,
          task_id: String(f.task_id), rh_user_id: f.rh_user_id || null, rh_task_id: f.rh_task_id || null,
          status: f.status || "running", error_message: f.error_message || null,
        }),
        timeout: 5,
      })
    } catch (_) {}
  }
  // 任务异步失败: 找到本任务的扣费流水(held/settled 的 gen/gen_admin), 幂等写一笔退款冲销;
  // 普通用户退站内余额, 管理员旁路没扣站内余额只冲成本。
  function localSettleFailure(ev, rec) {
    try {
      var ref = ""
      try { ref = String(rec.getString("charge_ref") || "") } catch (_) { ref = "" }
      if (!ref) return
      var txn = null
      try { txn = $app.findFirstRecordByFilter("wallet_txns", "ref = {:r} && (kind = 'gen' || kind = 'gen_admin')", { r: ref }) } catch (_) { txn = null }
      if (!txn) return
      var kind = String(txn.get("kind") || "")
      var refundKind = kind === "gen_admin" ? "refund_admin" : "refund"
      var refundRef = "refund:" + ref
      var dup = null
      try { dup = $app.findFirstRecordByFilter("wallet_txns", "ref = {:r} && (kind = 'refund' || kind = 'refund_admin')", { r: refundRef }) } catch (_) { dup = null }
      if (dup) return
      var amt = Math.abs(Number(txn.get("amount") || 0))
      var em = String(txn.get("user_email") || "").trim().toLowerCase()
      if (kind === "gen") {
        var w = null
        try { w = $app.findFirstRecordByFilter("wallets", "user_email = {:em}", { em: em }) } catch (_) { w = null }
        var bal = w ? Number(w.get("balance") || 0) : 0
        if (w) {
          var nb = Math.round((bal + amt) * 100) / 100
          w.set("balance", nb)
          w.set("total_consumed", Math.round(Math.max(0, Number(w.get("total_consumed") || 0) - amt) * 100) / 100)
          $app.save(w); bal = nb
        }
        var t1 = new Record($app.findCollectionByNameOrId("wallet_txns"))
        t1.set("user_email", em); t1.set("kind", "refund"); t1.set("amount", Math.round(amt * 100) / 100)
        t1.set("balance_after", Math.round(bal * 100) / 100); t1.set("ref", refundRef)
        t1.set("model", String(txn.get("model") || "")); t1.set("note", "任务失败自动退款"); t1.set("status", "done")
        $app.save(t1)
      } else {
        var t2 = new Record($app.findCollectionByNameOrId("wallet_txns"))
        t2.set("user_email", em); t2.set("kind", "refund_admin"); t2.set("amount", Math.round(amt * 100) / 100)
        t2.set("balance_after", 0); t2.set("ref", refundRef)
        t2.set("model", String(txn.get("model") || "")); t2.set("note", "任务失败·冲销实扣RH"); t2.set("status", "done")
        $app.save(t2)
      }
    } catch (ferr) { try { $app.logger().error("settle failure refund: " + String(ferr && ferr.message || ferr)) } catch (_) {} }
  }
  // RH /openapi/v2/query 终态响应里的 usage 是真实扣费明细 (thirdPartyConsumeMoney 通常是实付
  // 金额, consumeMoney/consumeCoins 常为 null)。全部按字符串落库/返回, 避免精度问题。
  function localExtractUsage(data) {
    var u = (data && data.usage) || {}
    function s(v) { return (v === undefined || v === null) ? null : String(v) }
    return {
      consumeMoney: s(u.consumeMoney),
      consumeCoins: s(u.consumeCoins),
      taskCostTime: s(u.taskCostTime),
      thirdPartyConsumeMoney: s(u.thirdPartyConsumeMoney),
    }
  }
  try {
    var allowedModels = {"gpt-image-2":{"endpoint":"rhart-image-g-2-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-0-text-to-image-channel-low-price":{"endpoint":"rhart-image-g-2/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2-gemini31flash-text-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"21:9"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2":{"endpoint":"rhart-image-n-g31-flash/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"]}],"media_params":[]},"nano-banana-pro-text-to-image-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/text-to-image-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"3:4"}],"media_params":[]},"nano-banana-pro":{"endpoint":"rhart-image-n-pro/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-image-to-image-official-stable":{"endpoint":"rhart-image-g-2-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":50}]},"gpt-image-2-0-edit-channel-low-price":{"endpoint":"rhart-image-g-2/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana2-gemini31flash-image-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":14,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana2-gemini31flash-image-to-image-channel-low-price":{"endpoint":"rhart-image-n-g31-flash/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana-pro-edit-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/edit-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"empty"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana-pro-edit-channel-low-price":{"endpoint":"rhart-image-n-pro/edit","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"seedance-2-0-mini-text-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"webSearch","required":false,"type":"bool","default":false},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[]},"seedance-2":{"endpoint":"rhart-video/sparkvideo-2.0/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true}],"media_params":[]},"seedance-2.5":{"endpoint":"bytedance/seedance-2.5-token/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[]},"xai-grok-imagine-video-v1-5-text-to-video-official-stable":{"endpoint":"rhart-video-g-official/text-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"aspectRatio","required":false,"type":"string","enum":["16:9","1:1","9:16","3:2","2:3"],"default":"16:9"},{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p"],"default":"720p"}],"media_params":[]},"minimax-h3-text-to-video":{"endpoint":"minimax/hailuo-h3/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"ratio","required":false,"type":"string","enum":["21:9","16:9","4:3","1:1","3:4","9:16"],"default":"16:9"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[]},"seedance2-0-multimodal-video":{"endpoint":"rhart-video/sparkvideo-2.0/multimodal-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"imageUrls","type":"image","required":false,"multiple":true,"max_num":9,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"videoUrls","type":"video","required":false,"multiple":true,"max_num":3,"accept":"[\"MP4\"]","max_size":50},{"name":"audioUrls","type":"audio","required":false,"multiple":true,"max_num":3,"accept":"[\"MP3\",\"WAV\"]","max_size":50}]},"seedance-2-0-mini-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"realPersonMode","required":false,"type":"bool","default":true},{"name":"conversionSlots","required":false,"type":"string","enum":["all","firstFrameUrl","lastFrameUrl"],"default":"all"},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance2-0-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance-2-5-image-to-video-token":{"endpoint":"bytedance/seedance-2.5-token/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30}]},"xai-grok-imagine-video-v1-5-image-to-video-official-stable":{"endpoint":"rhart-video-g-official/image-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"resolution","required":true,"type":"string","enum":["480p","720p"],"default":"720p"}],"media_params":[{"name":"imageUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":100}]},"minimax-h3-image-to-video-first-last-frame":{"endpoint":"minimax/hailuo-h3/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]}}
    var key = localReadKey(e)
    if (!key) return e.json(412, { error: "rh_login_required", message: "请用右上角按钮登录 RunningHub" })
    var userEmail = String(e.get("authEmail") || "").trim().toLowerCase()
    if (!userEmail) return e.json(401, { error: "login_required", message: "请先登录" })
    var jobId = e.request.pathValue("jobId")
    if (!jobId) return e.json(400, { error: "job_id_required" })
    var rec = null
    try { rec = $app.findFirstRecordByFilter("aigc_tasks", "task_id = {:tid} && user_email = {:email}", { tid: jobId, email: userEmail }) } catch (_) {}
    if (!rec) return e.json(404, { error: "job_not_found", message: "任务不存在或已过期" })
    var rhTaskId = rec.getString("rh_task_id")
    if (!rhTaskId) return e.json(200, { ok: true, taskId: jobId, status: "RUNNING", outputs: [] })

    var res = $http.send({
      // 刻意不带上浮票据: /query 只读任务状态、不计价, 带了纯属白烧一张一次性票。
      // 计价只发生在 /submit (实扣) 与 /price-preview (展示价) 两处。
      url: "https://www.runninghub.cn/openapi/v2/query", method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: rhTaskId }), timeout: 30,
    })
    var rawBody = (res && typeof res.raw === "string") ? res.raw : ""
    if (localIsRhAuthErr(rawBody)) return e.json(412, { error: "rh_login_required", message: "RunningHub 登录态已过期" })
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      return e.json(200, { ok: true, taskId: jobId, status: "RUNNING", outputs: [], model: rec.getString("model_name") })
    }
    var data = null; try { data = JSON.parse(rawBody) } catch (_) {}
    if (!data) return e.json(200, { ok: true, taskId: jobId, status: "RUNNING", outputs: [], model: rec.getString("model_name") })

    var modelName = rec.getString("model_name")
    var cfg = allowedModels[modelName] || {}
    var outputType = String(cfg.output_type || "image")
    var taskStatus = String(data.status || "RUNNING").toUpperCase()
    var usage = localExtractUsage(data)
    var outputs = []
    if (taskStatus === "SUCCESS") {
      var results = data.results || []
      for (var i = 0; i < results.length; i++) {
        var r = results[i]
        var u = (r && (r.url || r.fileUrl || r.imageUrl)) || ""
        if (!u && typeof r === "string") u = r
        if (u) outputs.push({ url: localNormalizeOutputUrl(u), type: outputType })
      }
      if (outputs.length) {
        try {
          rec.set("status", "success"); rec.set("result_url", outputs[0].url.substring(0, 2048))
          rec.set("consume_money", usage.consumeMoney || ""); rec.set("consume_coins", usage.consumeCoins || "")
          rec.set("task_cost_time", usage.taskCostTime || ""); rec.set("third_party_consume_money", usage.thirdPartyConsumeMoney || "")
          $app.save(rec)
        } catch (_) {}
        localReportTaskIndex({ task_id: jobId, rh_task_id: rhTaskId, rh_user_id: rec.getString("rh_user_id"), status: "success" })
      }
    } else if (taskStatus === "FAILED" || taskStatus === "CANCEL") {
      var errMsg = "task_failed"
      try {
        rec.set("status", "failed"); rec.set("error_message", errMsg)
        rec.set("consume_money", usage.consumeMoney || ""); rec.set("consume_coins", usage.consumeCoins || "")
        rec.set("task_cost_time", usage.taskCostTime || ""); rec.set("third_party_consume_money", usage.thirdPartyConsumeMoney || "")
        $app.save(rec)
      } catch (_) {}
      localReportTaskIndex({ task_id: jobId, rh_task_id: rhTaskId, rh_user_id: rec.getString("rh_user_id"), status: "failed", error_message: errMsg })
      // 异步失败: 按 charge_ref 幂等结算——普通用户退站内余额+冲成本, 管理员旁路只冲成本
      localSettleFailure(e, rec)
      return e.json(200, { ok: true, taskId: jobId, status: taskStatus, outputs: [], error: "生成失败, 请稍后重试", model: modelName, usage: usage, chargeAmount: Number(rec.get("charge_amount") || 0) || null })
    }
    return e.json(200, { ok: true, taskId: jobId, status: taskStatus, outputs: outputs, model: modelName, usage: usage, chargeAmount: Number(rec.get("charge_amount") || 0) || null })
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("aigc_poll_transient: " + msg) } catch (_) {}
    return e.json(200, { ok: true, status: "RUNNING", outputs: [] })
  }
})

routerAdd("POST", "/api/aigc/history", function (e) {
  function localReadKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function localKeyFingerprint(k) {
    var s = String(k || "")
    if (!s) return ""
    var h1 = 0x811c9dc5 >>> 0, h2 = 0x1000193 >>> 0
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      h1 = ((h1 ^ c) >>> 0); h1 = (h1 * 16777619) >>> 0
      h2 = ((h2 + c) >>> 0); h2 = (h2 * 2246822519) >>> 0
    }
    function hex8(n) { var x = (n >>> 0).toString(16); while (x.length < 8) x = "0" + x; return x }
    return hex8(h1) + hex8(h2)
  }
  function localSafeString(r, name) { try { return r.getString(name) } catch (_) { return "" } }
  function localSafeBool(r, name) { try { return !!r.getBool(name) } catch (_) { return false } }
  function localSafeNumber(r, name) { try { return Number(r.get(name) || 0) || 0 } catch (_) { return 0 } }
  function localItemFromRecord(rec) {
    return {
      jobId: rec.getString("task_id"),
      taskId: rec.getString("rh_task_id"),
      status: rec.getString("status"),
      page: rec.getString("page"),
      prompt: rec.getString("prompt"),
      resultUrl: rec.getString("result_url"),
      errorMessage: rec.getString("error_message"),
      rating: localSafeNumber(rec, "rating"),
      favorite: localSafeBool(rec, "favorite"),
      category: localSafeString(rec, "category"),
      note: localSafeString(rec, "note"),
      created: rec.getString("created"),
      updated: rec.getString("updated"),
      model: rec.getString("model_name"),
      consumeMoney: localSafeString(rec, "consume_money"),
      consumeCoins: localSafeString(rec, "consume_coins"),
      taskCostTime: localSafeString(rec, "task_cost_time"),
      thirdPartyConsumeMoney: localSafeString(rec, "third_party_consume_money"),
      chargeAmount: (function () { try { return Number(rec.get("charge_amount") || 0) || null } catch (_) { return null } })(),
    }
  }
  function localIsRhAuthErr(raw) {
    var s = String(raw || "")
    return s.indexOf("APIKEY_USER_NOT_FOUND") >= 0 || s.indexOf("APIKEY_INVALID") >= 0 || s.indexOf("TOKEN_INVALID") >= 0
      || s.indexOf("user not exist") >= 0 || s.indexOf('"code":301') >= 0
      || s.indexOf('"errorCode":"806"') >= 0 || s.indexOf('"errorCode":"412"') >= 0
  }
  function localNormalizeOutputUrl(rawUrl) {
    if (!rawUrl) return rawUrl
    var u = String(rawUrl)
    var idx = u.indexOf("myqcloud.com/")
    if (idx >= 0) u = "https://rh-images.xiaoyaoyou.com/" + u.substring(idx + "myqcloud.com/".length)
    var qIdx = u.indexOf("?"); var path = qIdx >= 0 ? u.substring(0, qIdx) : u; var query = qIdx >= 0 ? u.substring(qIdx) : ""
    try { path = encodeURI(decodeURI(path)) } catch (_) {}
    return path + query
  }
  function localExtractUsage(data) {
    var u = (data && data.usage) || {}
    function s(v) { return (v === undefined || v === null) ? null : String(v) }
    return {
      consumeMoney: s(u.consumeMoney),
      consumeCoins: s(u.consumeCoins),
      taskCostTime: s(u.taskCostTime),
      thirdPartyConsumeMoney: s(u.thirdPartyConsumeMoney),
    }
  }
  // 懒对账: 关页/刷新期间没有浏览器在 poll 时, /jobs/{jobId}/poll (唯一写终态的地方) 就没人调用,
  // aigc_tasks 记录会永远停在 running —— 哪怕 RH 那边任务早就跑完了。这里在用户自己打开历史列表时,
  // 用他自己请求带的 key 顺带把 stale running 记录的真实终态补上, 逻辑跟 /jobs/{jobId}/poll 完全一致
  // (成功查usage/结果URL, 失败查errorMessage), 避免记录变成永远转圈的幽灵。
  // 只处理本页 status=="running" 且 updated 超过 30s 的记录, 最多 3 条 (串行请求 RH), 防止一页里
  // 混进很多 stale 记录时拖慢 /history 响应 —— 没处理到的等下次打开历史 (或 resumeAigcJob) 再对账。
  // RH /query 对已被清理/过期的任务不会返回 status=FAILED, 而是返回错误文案 (无 status 字段)。
  // 这类记录必须写成 failed, 否则永远卡 running —— 恰恰是"隔天才回来看历史"这种最需要对账的场景。
  // 只认明确的 not-found/expired 标记, 瞬时错误 (限流/5xx 文案) 不能误判成终态。
  function localIsRhTaskGone(raw) {
    var s = String(raw || "").toLowerCase()
    return s.indexOf("task not found") >= 0 || s.indexOf("task not exist") >= 0
      || s.indexOf("task_not_found" ) >= 0 || s.indexOf("task_not_exist") >= 0
      || s.indexOf("任务不存在") >= 0 || s.indexOf("已过期") >= 0 || s.indexOf("task expired") >= 0
  }
  function localSettleFailure(ev, rec) {
    try {
      var ref = ""
      try { ref = String(rec.getString("charge_ref") || "") } catch (_) { ref = "" }
      if (!ref) return
      var txn = null
      try { txn = $app.findFirstRecordByFilter("wallet_txns", "ref = {:r} && (kind = 'gen' || kind = 'gen_admin')", { r: ref }) } catch (_) { txn = null }
      if (!txn) return
      var kind = String(txn.get("kind") || "")
      var refundKind = kind === "gen_admin" ? "refund_admin" : "refund"
      var refundRef = "refund:" + ref
      var dup = null
      try { dup = $app.findFirstRecordByFilter("wallet_txns", "ref = {:r} && (kind = 'refund' || kind = 'refund_admin')", { r: refundRef }) } catch (_) { dup = null }
      if (dup) return
      var amt = Math.abs(Number(txn.get("amount") || 0))
      var em = String(txn.get("user_email") || "").trim().toLowerCase()
      if (kind === "gen") {
        var w = null
        try { w = $app.findFirstRecordByFilter("wallets", "user_email = {:em}", { em: em }) } catch (_) { w = null }
        var bal = w ? Number(w.get("balance") || 0) : 0
        if (w) {
          var nb = Math.round((bal + amt) * 100) / 100
          w.set("balance", nb)
          w.set("total_consumed", Math.round(Math.max(0, Number(w.get("total_consumed") || 0) - amt) * 100) / 100)
          $app.save(w); bal = nb
        }
        var t1 = new Record($app.findCollectionByNameOrId("wallet_txns"))
        t1.set("user_email", em); t1.set("kind", "refund"); t1.set("amount", Math.round(amt * 100) / 100)
        t1.set("balance_after", Math.round(bal * 100) / 100); t1.set("ref", refundRef)
        t1.set("model", String(txn.get("model") || "")); t1.set("note", "任务失败自动退款"); t1.set("status", "done")
        $app.save(t1)
      } else {
        var t2 = new Record($app.findCollectionByNameOrId("wallet_txns"))
        t2.set("user_email", em); t2.set("kind", "refund_admin"); t2.set("amount", Math.round(amt * 100) / 100)
        t2.set("balance_after", 0); t2.set("ref", refundRef)
        t2.set("model", String(txn.get("model") || "")); t2.set("note", "任务失败·冲销实扣RH"); t2.set("status", "done")
        $app.save(t2)
      }
    } catch (ferr) { try { $app.logger().error("settle failure refund: " + String(ferr && ferr.message || ferr)) } catch (_) {} }
  }

  function localReconcileStaleRunning(records, key) {
    if (!key) return
    var allowedModels = {"gpt-image-2":{"endpoint":"rhart-image-g-2-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-0-text-to-image-channel-low-price":{"endpoint":"rhart-image-g-2/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2-gemini31flash-text-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"21:9"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[]},"nano-banana2":{"endpoint":"rhart-image-n-g31-flash/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"]}],"media_params":[]},"nano-banana-pro-text-to-image-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/text-to-image-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"3:4"}],"media_params":[]},"nano-banana-pro":{"endpoint":"rhart-image-n-pro/text-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"1k","enum":["1k","2k","4k"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[]},"gpt-image-2-image-to-image-official-stable":{"endpoint":"rhart-image-g-2-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"2k","enum":["1k","2k","4k"]},{"name":"quality","type":"string","default":"medium","enum":["low","medium","high"]},{"name":"aspectRatio","type":"string","default":"3:4","enum":["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9"]}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":50}]},"gpt-image-2-0-edit-channel-low-price":{"endpoint":"rhart-image-g-2/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","3:2","1:1","2:3","5:4","4:5","16:9","9:16","21:9","3:4","4:3","9:21","1:2","2:1","1:3","3:1"],"default":"empty"},{"name":"resolution","required":false,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana2-gemini31flash-image-to-image-official-stable":{"endpoint":"rhart-image-n-g31-flash-official/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":14,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana2-gemini31flash-image-to-image-channel-low-price":{"endpoint":"rhart-image-n-g31-flash/image-to-image","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9","1:4","4:1","1:8","8:1"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":30}]},"nano-banana-pro-edit-ultra-official-stable":{"endpoint":"rhart-image-n-pro-official/edit-ultra","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"4k"},{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],"default":"empty"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"nano-banana-pro-edit-channel-low-price":{"endpoint":"rhart-image-n-pro/edit","output_type":"image","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"aspectRatio","required":false,"type":"string","enum":["empty","1:1","16:9","9:16","4:3","3:4","3:2","2:3","5:4","4:5","21:9"],"default":"empty"},{"name":"resolution","required":true,"type":"string","enum":["1k","2k","4k"],"default":"1k"}],"media_params":[{"name":"imageUrls","type":"image","required":true,"multiple":true,"max_num":10,"accept":"[\"JPG\",\"PNG\"]","max_size":10}]},"seedance-2-0-mini-text-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"webSearch","required":false,"type":"bool","default":false},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[]},"seedance-2":{"endpoint":"rhart-video/sparkvideo-2.0/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true}],"media_params":[]},"seedance-2.5":{"endpoint":"bytedance/seedance-2.5-token/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[]},"xai-grok-imagine-video-v1-5-text-to-video-official-stable":{"endpoint":"rhart-video-g-official/text-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"aspectRatio","required":false,"type":"string","enum":["16:9","1:1","9:16","3:2","2:3"],"default":"16:9"},{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p"],"default":"720p"}],"media_params":[]},"minimax-h3-text-to-video":{"endpoint":"minimax/hailuo-h3/text-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"ratio","required":false,"type":"string","enum":["21:9","16:9","4:3","1:1","3:4","9:16"],"default":"16:9"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[]},"seedance2-0-multimodal-video":{"endpoint":"rhart-video/sparkvideo-2.0/multimodal-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"imageUrls","type":"image","required":false,"multiple":true,"max_num":9,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"videoUrls","type":"video","required":false,"multiple":true,"max_num":3,"accept":"[\"MP4\"]","max_size":50},{"name":"audioUrls","type":"audio","required":false,"multiple":true,"max_num":3,"accept":"[\"MP3\",\"WAV\"]","max_size":50}]},"seedance-2-0-mini-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0-mini/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["480p","720p","1080p","2k","4k"],"default":"720p"},{"name":"duration","required":true,"type":"string","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"generateAudio","required":false,"type":"bool","default":true},{"name":"ratio","required":false,"type":"string","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"],"default":"adaptive"},{"name":"realPersonMode","required":false,"type":"bool","default":true},{"name":"conversionSlots","required":false,"type":"string","enum":["all","firstFrameUrl","lastFrameUrl"],"default":"all"},{"name":"returnLastFrame","required":false,"type":"bool","default":false},{"name":"seed","required":false,"type":"number","default":-1,"min":-1,"max":2147483647}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance2-0-image-to-video":{"endpoint":"rhart-video/sparkvideo-2.0/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","native4k","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["4","5","6","7","8","9","10","11","12","13","14","15"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive","16:9","4:3","1:1","3:4","9:16","21:9"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]},"seedance-2-5-image-to-video-token":{"endpoint":"bytedance/seedance-2.5-token/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":false},"scalar_params":[{"name":"resolution","type":"string","default":"720p","enum":["480p","720p","native1080p","1080p","2k","4k"]},{"name":"duration","type":"string","default":"5","enum":["-1","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]},{"name":"ratio","type":"string","default":"adaptive","enum":["adaptive"]},{"name":"generateAudio","type":"bool","default":true},{"name":"realPersonMode","type":"bool","default":true},{"name":"conversionSlots","type":"string","default":"all","enum":["all","firstFrameUrl","lastFrameUrl"]},{"name":"returnLastFrame","type":"bool","default":false},{"name":"bitrateMode","type":"string","default":"standard","enum":["standard","high"]}],"media_params":[{"name":"firstFrameUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\",\"BMP\",\"TIFF\",\"GIF\",\"HEIC\",\"HEIF\"]","max_size":30}]},"xai-grok-imagine-video-v1-5-image-to-video-official-stable":{"endpoint":"rhart-video-g-official/image-to-video-v1.5","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"duration","required":true,"type":"number","default":6,"min":1,"max":15},{"name":"resolution","required":true,"type":"string","enum":["480p","720p"],"default":"720p"}],"media_params":[{"name":"imageUrl","type":"image","required":true,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":100}]},"minimax-h3-image-to-video-first-last-frame":{"endpoint":"minimax/hailuo-h3/image-to-video","output_type":"video","primary_input":{"name":"prompt","required":true},"scalar_params":[{"name":"resolution","required":true,"type":"string","enum":["2K","768P"],"default":"2K"},{"name":"duration","required":true,"type":"string","enum":["5","6","7","8","9","10","11","12","13","14","15"],"default":"5"},{"name":"aigc_watermark","required":false,"type":"bool","default":false}],"media_params":[{"name":"firstFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30},{"name":"lastFrameUrl","type":"image","required":false,"multiple":false,"max_num":1,"accept":"[\"JPG\",\"JPEG\",\"PNG\",\"WEBP\"]","max_size":30}]}}
    var handled = 0
    for (var i = 0; i < records.length && handled < 3; i++) {
      var rec = records[i]
      try {
        if (rec.getString("status") !== "running") continue
        var rhTaskId = rec.getString("rh_task_id")
        if (!rhTaskId) continue
        // PB autodate 字符串是 "2006-01-02 15:04:05.000Z" (空格分隔, 非 ISO); Goja 的 Date 不保证
        // 能解析这种格式, 必须先归一化成 ISO。解析失败按 stale 处理 (fail-open, 最坏多查一次 RH),
        // 绝不能按"跳过"处理 —— 否则解析一旦失败, 懒对账整体静默失效。
        var updatedMs = NaN
        try { updatedMs = new Date(String(rec.getString("updated") || "").replace(" ", "T")).getTime() } catch (_) {}
        if (!isNaN(updatedMs) && Date.now() - updatedMs < 30000) continue
        handled++

        var res = $http.send({
          url: "https://www.runninghub.cn/openapi/v2/query", method: "POST",
          headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: rhTaskId }), timeout: 15,
        })
        var rawBody = (res && typeof res.raw === "string") ? res.raw : ""
        if (localIsRhAuthErr(rawBody)) continue // 登录态过期留给用户主动操作时再报 412, 这里不动记录
        if (!res || res.statusCode < 200 || res.statusCode >= 300) continue
        var data = null; try { data = JSON.parse(rawBody) } catch (_) {}
        if (!data) continue

        var taskStatus = String(data.status || "RUNNING").toUpperCase()
        if (taskStatus !== "SUCCESS" && taskStatus !== "FAILED" && taskStatus !== "CANCEL") {
          // RH 端任务已不存在/过期 → 写 failed 终态, 不再让它永远转圈
          if (!data.status && localIsRhTaskGone(rawBody)) {
            rec.set("status", "failed")
            rec.set("error_message", "task_gone")
            $app.save(rec)
            localSettleFailure(e, rec)
          }
          continue
        }
        var usage = localExtractUsage(data)
        if (taskStatus === "SUCCESS") {
          var results = data.results || []
          var outUrl = ""
          for (var j = 0; j < results.length; j++) {
            var r = results[j]
            var u = (r && (r.url || r.fileUrl || r.imageUrl)) || ""
            if (!u && typeof r === "string") u = r
            if (u) { outUrl = localNormalizeOutputUrl(u); break }
          }
          if (!outUrl) continue
          rec.set("status", "success"); rec.set("result_url", outUrl.substring(0, 2048))
          rec.set("consume_money", usage.consumeMoney || ""); rec.set("consume_coins", usage.consumeCoins || "")
          rec.set("task_cost_time", usage.taskCostTime || ""); rec.set("third_party_consume_money", usage.thirdPartyConsumeMoney || "")
          $app.save(rec)
        } else {
          var errMsg = "task_failed"
          rec.set("status", "failed"); rec.set("error_message", errMsg)
          rec.set("consume_money", usage.consumeMoney || ""); rec.set("consume_coins", usage.consumeCoins || "")
          rec.set("task_cost_time", usage.taskCostTime || ""); rec.set("third_party_consume_money", usage.thirdPartyConsumeMoney || "")
          $app.save(rec)
          localSettleFailure(e, rec)
        }
      } catch (_) { /* 单条对账失败不影响其它记录 / 主流程, 保持 running 下次再试 */ }
    }
  }
  try {
    var userId = localKeyFingerprint(localReadKey(e))
    if (!userId) return e.json(200, { ok: true, items: [], page: 1, perPage: 0 })
    var userEmail = String(e.get("authEmail") || "").trim().toLowerCase()
    if (!userEmail) return e.json(401, { error: "login_required", message: "请先登录" })
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    var query = {}
    try { query = e.requestInfo().query || {} } catch (_) {}
    var page = parseInt(String(body.page || query.page || "1"), 10); if (!page || page < 1) page = 1
    var perPage = parseInt(String(body.perPage || query.perPage || "20"), 10); if (!perPage || perPage < 1) perPage = 20
    if (perPage > 100) perPage = 100

    var filters = ["rh_user_id = {:uid}", "user_email = {:email}"]
    var params = { uid: userId, email: userEmail }
    var modelName = String(body.model || query.model || "").trim()
    if (modelName) { filters.push("model_name = {:m}"); params.m = modelName }
    if (body.favorite === true || body.favorite === "true") filters.push("favorite = true")
    if (body.status) { filters.push("status = {:status}"); params.status = String(body.status) }
    if (body.category) { filters.push("category = {:category}"); params.category = String(body.category).substring(0, 32) }
    var minRating = parseInt(String(body.minRating || "0"), 10)
    if (minRating > 0) { filters.push("rating >= {:minRating}"); params.minRating = minRating }
    var sort = "-created"
    if (body.sort === "oldest") sort = "created"
    if (body.sort === "rating") sort = "-rating,-created"
    if (body.sort === "favorite") sort = "-favorite,-created"

    var records = []
    try {
      records = $app.findRecordsByFilter("aigc_tasks", filters.join(" && "), sort, perPage, (page - 1) * perPage, params) || []
    } catch (_) { records = [] }

    localReconcileStaleRunning(records, localReadKey(e))

    var items = []
    for (var i = 0; i < records.length; i++) items.push(localItemFromRecord(records[i]))
    return e.json(200, { ok: true, items: items, page: page, perPage: perPage })
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("aigc_history_error: " + msg) } catch (_) {}
    return e.json(500, { error: "aigc_history_error", message: "历史记录加载失败, 请稍后重试" })
  }
})

routerAdd("POST", "/api/aigc/history/{jobId}/update", function (e) {
  function localReadKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function localKeyFingerprint(k) {
    var s = String(k || "")
    if (!s) return ""
    var h1 = 0x811c9dc5 >>> 0, h2 = 0x1000193 >>> 0
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      h1 = ((h1 ^ c) >>> 0); h1 = (h1 * 16777619) >>> 0
      h2 = ((h2 + c) >>> 0); h2 = (h2 * 2246822519) >>> 0
    }
    function hex8(n) { var x = (n >>> 0).toString(16); while (x.length < 8) x = "0" + x; return x }
    return hex8(h1) + hex8(h2)
  }
  function localSafeString(r, name) { try { return r.getString(name) } catch (_) { return "" } }
  function localSafeBool(r, name) { try { return !!r.getBool(name) } catch (_) { return false } }
  function localSafeNumber(r, name) { try { return Number(r.get(name) || 0) || 0 } catch (_) { return 0 } }
  function localItemFromRecord(rec) {
    return {
      jobId: rec.getString("task_id"),
      taskId: rec.getString("rh_task_id"),
      status: rec.getString("status"),
      page: rec.getString("page"),
      prompt: rec.getString("prompt"),
      resultUrl: rec.getString("result_url"),
      errorMessage: rec.getString("error_message"),
      rating: localSafeNumber(rec, "rating"),
      favorite: localSafeBool(rec, "favorite"),
      category: localSafeString(rec, "category"),
      note: localSafeString(rec, "note"),
      created: rec.getString("created"),
      updated: rec.getString("updated"),
      model: rec.getString("model_name"),
      consumeMoney: localSafeString(rec, "consume_money"),
      consumeCoins: localSafeString(rec, "consume_coins"),
      taskCostTime: localSafeString(rec, "task_cost_time"),
      thirdPartyConsumeMoney: localSafeString(rec, "third_party_consume_money"),
      chargeAmount: (function () { try { return Number(rec.get("charge_amount") || 0) || null } catch (_) { return null } })(),
    }
  }
  try {
    var userId = localKeyFingerprint(localReadKey(e))
    if (!userId) return e.json(412, { error: "rh_login_required", message: "请用右上角按钮登录 RunningHub" })
    var userEmail = String(e.get("authEmail") || "").trim().toLowerCase()
    if (!userEmail) return e.json(401, { error: "login_required", message: "请先登录" })
    var jobId = e.request.pathValue("jobId")
    var rec = null
    try { rec = $app.findFirstRecordByFilter("aigc_tasks", "task_id = {:tid} && rh_user_id = {:uid} && user_email = {:email}", { tid: jobId, uid: userId, email: userEmail }) } catch (_) {}
    if (!rec) return e.json(404, { error: "history_not_found", message: "记录不存在或已删除" })
    var body = {}
    try { body = e.requestInfo().body || {} } catch (_) {}
    if (body.rating !== undefined) {
      var rating = Number(body.rating || 0)
      if (rating < 0 || rating > 5 || Math.floor(rating) !== rating) return e.json(400, { error: "invalid_rating", message: "评分必须是 1-5, 或 0 表示清空" })
      rec.set("rating", rating)
    }
    if (body.favorite !== undefined) rec.set("favorite", !!body.favorite)
    if (body.category !== undefined) rec.set("category", String(body.category || "").substring(0, 32))
    if (body.note !== undefined) rec.set("note", String(body.note || "").substring(0, 1000))
    $app.save(rec)
    return e.json(200, { ok: true, item: localItemFromRecord(rec) })
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("aigc_history_update_error: " + msg) } catch (_) {}
    return e.json(500, { error: "aigc_history_update_error", message: "历史记录更新失败, 请稍后重试" })
  }
})

routerAdd("POST", "/api/aigc/history/{jobId}/delete", function (e) {
  function localReadKey(ev) {
    return $os.getenv("RH_API_KEY") || ""
  }
  function localKeyFingerprint(k) {
    var s = String(k || "")
    if (!s) return ""
    var h1 = 0x811c9dc5 >>> 0, h2 = 0x1000193 >>> 0
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i)
      h1 = ((h1 ^ c) >>> 0); h1 = (h1 * 16777619) >>> 0
      h2 = ((h2 + c) >>> 0); h2 = (h2 * 2246822519) >>> 0
    }
    function hex8(n) { var x = (n >>> 0).toString(16); while (x.length < 8) x = "0" + x; return x }
    return hex8(h1) + hex8(h2)
  }
  try {
    var userId = localKeyFingerprint(localReadKey(e))
    if (!userId) return e.json(412, { error: "rh_login_required", message: "请用右上角按钮登录 RunningHub" })
    var userEmail = String(e.get("authEmail") || "").trim().toLowerCase()
    if (!userEmail) return e.json(401, { error: "login_required", message: "请先登录" })
    var jobId = e.request.pathValue("jobId")
    var rec = null
    try { rec = $app.findFirstRecordByFilter("aigc_tasks", "task_id = {:tid} && rh_user_id = {:uid} && user_email = {:email}", { tid: jobId, uid: userId, email: userEmail }) } catch (_) {}
    if (!rec) return e.json(404, { error: "history_not_found", message: "记录不存在或已删除" })
    $app.delete(rec)
    return e.json(200, { ok: true, deleted: true, jobId: jobId })
  } catch (err) {
    var msg = String(err && err.message || err)
    try { $app.logger().error("aigc_history_delete_error: " + msg) } catch (_) {}
    return e.json(500, { error: "aigc_history_delete_error", message: "历史记录删除失败, 请稍后重试" })
  }
})
