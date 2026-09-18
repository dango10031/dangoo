// 摄影机节点数据模型(纯前端, 不依赖 React / 不调任何接口):
// 机身 → 镜头 → 焦段逐级兼容(同一支镜头配不同机身, 可选焦段不同),
// 光圈挂镜头, 明度九调 / 镜头特效字典, 配置清洗, 摄影风格提示词组合,
// 默认配置与镜头预设的 localStorage 读写, 摄影机自动命名。
// 机身/镜头/焦段/明度/特效数据对齐旧版 Infinite-Canvas camera-config.json。

// ---------- 类型 ----------

export interface CameraFocalOption {
  /** 焦段值, 如 18mm / 32mm */
  value: string
  /** 短标签(同 value) */
  label: string
  /** 焦段说明(适配画面展示, 不进提示词) */
  desc: string
  /** 该焦段在提示词里的片段, 如「18mm 焦距」 */
  prompt: string
}

export interface CameraApertureOption {
  /** 光圈值, 如 T2.0 / f/1.78 */
  value: string
  /** 短标签(同 value) */
  label: string
  /** 光圈说明(适配画面展示, 不进提示词) */
  desc: string
  /** 该光圈在提示词里的片段, 如「T2.0 光圈」 */
  prompt: string
}

export interface CameraEffect {
  id: string
  label: string
  /** 该特效在提示词里的片段 */
  prompt: string
  /** 优先级: 数字越小优先级越高, 互斥组冲突时保留高者, 最终按它排序 */
  priority: number
  /** 同组特效互斥(散景↔浅景深 / 不同眩光类型) */
  group?: string
}

export interface CameraLens {
  id: string
  name: string
  /** 可选光圈 T 档 / f 档 */
  apertures: string[]
  /** 该镜头专属成像质感长文, 直接进提示词 */
  lookPrompt: string
  /** 适用场景文案(只展示, 不进提示词) */
  scene: string
  /** 允许的特效 id */
  effectIds: string[]
}

/**
 * 机身 ↔ 镜头挂载关系: 同一支镜头配不同机身时可选焦段不同
 * (如 Cooke S4/i 配 535B 是 18/25/32, 配 16SR3 是 20/25/32)。
 */
export interface CameraLensMount {
  bodyId: string
  lensId: string
  focals: string[]
}

export interface CameraBody {
  id: string
  name: string
  /** 机身基础质感提示词, 提示词序列最后一段 */
  basePrompt: string
}

export interface CameraTone {
  id: string
  /** 胶囊短标签, 如「中中调」 */
  label: string
  /** 实际进提示词的明度文案 */
  prompt: string
}

export interface CameraConfig {
  bodyId: string
  lensId: string
  focalValue: string
  apertureValue: string
  toneId: string
  effectIds: string[]
}

export interface CameraDictionary {
  bodies: CameraBody[]
  lenses: CameraLens[]
  mounts: CameraLensMount[]
  tones: CameraTone[]
  effects: CameraEffect[]
}

export interface CameraPreset {
  id: string
  name: string
  config: CameraConfig
  createdAt: number
}

// ---------- 「不指定」取值 ----------

/** 焦段 / 光圈的「不指定」选项值: 选中后该段不参与提示词拼接, 且对任何镜头都合法 */
export const CAMERA_NOT_SPECIFIED = 'unspecified'
export const CAMERA_NOT_SPECIFIED_LABEL = '不指定'

// ---------- 长度上限 ----------

export const MAX_EFFECTS_SELECTED = 4
export const MAX_EFFECT_PROMPT_LENGTH = 60
export const MAX_BODY_BASE_PROMPT_LENGTH = 40
export const MAX_TONE_PROMPT_LENGTH = 30
export const MAX_CAMERA_PREFIX_LENGTH = 200

// ---------- 机身 ----------

const BODIES: CameraBody[] = [
  { id: 'arri_535b', name: '阿莱 535B 型静音 Super35 胶片机', basePrompt: '超写实，胶片质感' },
  { id: 'arri_435', name: '阿莱 435 高速 Super35 胶片机', basePrompt: '超写实，胶片质感' },
  { id: 'arri_16sr3', name: '阿莱 16SR3 Super16 毫米胶片机', basePrompt: '超写实，胶片质感' },
  { id: 'panavision_xl2', name: '潘那维申金色 II 型 Millennium XL2 35mm 胶片机', basePrompt: '超写实，胶片质感' },
  { id: 'imax_msm9802', name: 'IMAX MSM9802 70mm 胶片摄影机', basePrompt: 'IMAX巨幕胶片，史诗宏大画质' },
  { id: 'arri_alexa65', name: 'ARRI Alexa 65 IMAX 数字电影机', basePrompt: '数字电影干净画质，高解析' },
  { id: 'sony_venice2', name: 'SONY Venice 2 8.6K全画幅数字电影机', basePrompt: '数字电影干净画质，高解析' },
  { id: 'red_ranger', name: 'RED Ranger Monstro 8K数字电影机', basePrompt: '数字电影干净画质，高解析' },
  // 用户点名补充的手机机身: 独立镜头组, 不与电影镜头互通
  { id: 'apple_iphone_pro', name: 'Apple iPhone Pro 主摄系统', basePrompt: '超写实，手机计算摄影质感' },
]

// ---------- 镜头 ----------

const LENSES: CameraLens[] = [
  {
    id: 'cooke_s4i',
    name: 'Cooke S4/i',
    apertures: ['T2.0', 'T2.8', 'T4.0', 'T5.6'],
    lookPrompt: 'Cooke暖柔肤色，柔和高光，松软灰阶，细密胶片颗粒',
    scene: '年代剧情、室内双人对话、人文外景',
    effectIds: ['bokeh', 'shallow_dof', 'soft_skin', 'warm_tone', 'warm_cool_balance', 'cooke_look', 'medium_format'],
  },
  {
    id: 'zeiss_master_prime',
    name: 'Zeiss Master Prime',
    apertures: ['T1.3', 'T2.0', 'T2.8', 'T4.0'],
    lookPrompt: '冷调锐利写实，低色散纯净，夜景建筑通透',
    scene: '现代都市、夜景、商业广告',
    effectIds: ['bokeh', 'shallow_dof', 'soft_skin', 'warm_cool_balance', 'medium_format'],
  },
  {
    id: 'arri_master_anamorphic',
    name: 'ARRI Master Anamorphic',
    apertures: ['T1.9', 'T2.8', 'T4.0'],
    lookPrompt: '2x变形宽幕，椭圆散景，细长水平眩光',
    scene: '宽银幕电影、史诗场景、风格化人像',
    effectIds: ['oval_bokeh', 'anamorphic_flare', 'horizontal_streak', 'shallow_dof', 'soft_skin', 'warm_cool_balance'],
  },
  {
    id: 'zeiss_ultra_prime',
    name: 'Zeiss Ultra Prime',
    apertures: ['T1.9', 'T2.8', 'T4.0'],
    lookPrompt: '超广轻畸变，暗部噪点明显，冷调复古纪实',
    scene: '街头纪实、运动跟拍、复古题材',
    effectIds: ['bokeh', 'shallow_dof', 'medium_format', 'warm_cool_balance', 'anamorphic_flare'],
  },
  {
    id: 'cooke_s5i',
    name: 'Cooke S5/i',
    apertures: ['T1.4', 'T2.0', 'T2.8'],
    lookPrompt: '改良Cooke肤色，层次立体，颗粒细腻干净',
    scene: '现代剧情、商业人像、特写对话',
    effectIds: ['bokeh', 'shallow_dof', 'soft_skin', 'warm_tone', 'warm_cool_balance', 'cooke_look', 'medium_format'],
  },
  {
    id: 'imax_spherical_prime',
    name: 'IMAX 70mm Spherical Prime',
    apertures: ['T2.0', 'T2.8', 'T4.0'],
    lookPrompt: '18K超高解析，宽阔视野，原生1.43:1画幅',
    scene: 'IMAX 巨幕、宏大场景、风光纪录',
    effectIds: ['imax_flare', 'large_bokeh', 'shallow_dof', 'medium_format'],
  },
  {
    id: 'imax_anamorphic',
    name: 'IMAX 70mm Anamorphic Lens',
    apertures: ['T2.8', 'T4.0', 'T5.6'],
    lookPrompt: '70mm变形宽幕，巨型椭圆散景，漫射水平眩光',
    scene: 'IMAX 宽幕史诗、大场面、科幻题材',
    effectIds: ['imax_flare', 'anamorphic_flare', 'horizontal_streak', 'oval_bokeh', 'large_bokeh'],
  },
  {
    // 潘那维申 PV 卡口机身(XL2)专用, 不挂其他品牌机身
    id: 'panavision_primo',
    name: 'Panavision Primo Prime',
    apertures: ['T1.9', 'T2.8', 'T4.0'],
    lookPrompt: '普利摩定焦极锐利，低像差，肤色干净，暗部高解析',
    scene: '现代商业广告、高速运动、棚拍人像',
    effectIds: ['bokeh', 'shallow_dof', 'soft_skin', 'warm_cool_balance'],
  },
  {
    id: 'panavision_c_series',
    name: 'Panavision C-Series Vintage Prime',
    apertures: ['T2.3', 'T2.8', 'T4.0'],
    lookPrompt: '六零年代复古镀膜，柔和反差，温润肤色，轻光晕',
    scene: '年代剧情、复古广告、怀旧题材',
    effectIds: ['bokeh', 'shallow_dof', 'soft_skin', 'warm_tone', 'warm_cool_balance'],
  },
  {
    id: 'panavision_g_anamorphic',
    name: 'Panavision G-Series Anamorphic',
    apertures: ['T2.2', 'T2.8', 'T4.0'],
    lookPrompt: '2x变形宽幕，椭圆散景，标志性蓝色水平眩光',
    scene: '宽银幕史诗、复古好莱坞、风格化人像',
    effectIds: ['oval_bokeh', 'anamorphic_flare', 'horizontal_streak', 'shallow_dof', 'soft_skin'],
  },
  {
    id: 'iphone_pro_cam',
    name: 'iPhone Pro 三摄系统',
    apertures: ['f/1.78', 'f/2.2', 'f/2.8'],
    lookPrompt: 'iPhone计算摄影质感，智能HDR高动态，自动人像磨皮，夜景提亮降噪，屏幕直出色彩',
    scene: '日常随拍、生活 vlog、旅行记录、社交直出',
    effectIds: ['bokeh', 'shallow_dof', 'soft_skin', 'warm_tone', 'warm_cool_balance'],
  },
]

// ---------- 机身 × 镜头挂载关系(含该组合可选焦段) ----------

const MOUNTS: CameraLensMount[] = [
  { bodyId: 'arri_535b', lensId: 'cooke_s4i', focals: ['18mm', '25mm', '32mm', '50mm'] },
  { bodyId: 'arri_535b', lensId: 'zeiss_master_prime', focals: ['21mm', '32mm', '40mm'] },
  { bodyId: 'arri_535b', lensId: 'arri_master_anamorphic', focals: ['32mm', '40mm', '50mm'] },
  { bodyId: 'arri_435', lensId: 'zeiss_ultra_prime', focals: ['70mm', '85mm', '100mm'] },
  { bodyId: 'arri_435', lensId: 'cooke_s5i', focals: ['40mm', '50mm', '65mm'] },
  { bodyId: 'arri_16sr3', lensId: 'cooke_s4i', focals: ['20mm', '25mm', '32mm'] },
  { bodyId: 'arri_16sr3', lensId: 'zeiss_ultra_prime', focals: ['12mm', '14mm', '18mm'] },
  // 潘那维申 XL2 为 PV 卡口, 只挂潘那维申自家镜头(此前临时配的两支 Cooke 不符合卡口, 2026-09 修正)
  { bodyId: 'panavision_xl2', lensId: 'panavision_primo', focals: ['27mm', '35mm', '50mm', '75mm'] },
  { bodyId: 'panavision_xl2', lensId: 'panavision_c_series', focals: ['35mm', '50mm', '75mm'] },
  { bodyId: 'panavision_xl2', lensId: 'panavision_g_anamorphic', focals: ['35mm', '50mm', '75mm'] },
  { bodyId: 'imax_msm9802', lensId: 'imax_spherical_prime', focals: ['24mm', '30mm', '40mm'] },
  { bodyId: 'imax_msm9802', lensId: 'imax_anamorphic', focals: ['40mm', '50mm', '60mm'] },
  { bodyId: 'arri_alexa65', lensId: 'arri_master_anamorphic', focals: ['50mm', '65mm', '80mm'] },
  { bodyId: 'arri_alexa65', lensId: 'zeiss_master_prime', focals: ['40mm', '50mm', '70mm'] },
  { bodyId: 'sony_venice2', lensId: 'cooke_s5i', focals: ['24mm', '28mm', '35mm'] },
  { bodyId: 'sony_venice2', lensId: 'zeiss_ultra_prime', focals: ['70mm', '75mm', '85mm'] },
  { bodyId: 'red_ranger', lensId: 'zeiss_master_prime', focals: ['16mm', '21mm', '24mm'] },
  { bodyId: 'red_ranger', lensId: 'arri_master_anamorphic', focals: ['35mm', '45mm', '55mm'] },
  { bodyId: 'apple_iphone_pro', lensId: 'iphone_pro_cam', focals: ['13mm', '24mm', '48mm', '100mm'] },
]

// ---------- 明度九调 ----------

const TONES: CameraTone[] = [
  { id: 'high_long', label: '高长调', prompt: '高调摄影，强对比度，明亮白调，深黑局部阴影' },
  { id: 'high_mid', label: '高中调', prompt: '高调摄影，灰阶丰富，明亮通透，柔和阴影' },
  { id: 'high_short', label: '高短调', prompt: '高调摄影，低对比，空气感，柔和微影' },
  { id: 'mid_long', label: '中长调', prompt: '中调为主，强对比，高光突出，阴影深邃' },
  { id: 'mid_mid', label: '中中调', prompt: '均衡中调，自然对比，层次饱满' },
  { id: 'mid_short', label: '中短调', prompt: '闷灰中调，低对比，复古颗粒' },
  { id: 'low_long', label: '低长调', prompt: '低调摄影，强对比，戏剧性轮廓光' },
  { id: 'low_mid', label: '低中调', prompt: '低调摄影，夜景质感，沉稳暗部' },
  { id: 'low_short', label: '低短调', prompt: '低调摄影，极低对比，浓雾压抑感' },
]

// ---------- 镜头特效 ----------
// 互斥: 散景 ↔ 浅景深(dof 组); IMAX 眩光 / 变形眩光 / 水平拉丝互为不同眩光类型(flare 组)

const EFFECTS: CameraEffect[] = [
  { id: 'shallow_dof', label: '浅景深', prompt: '高级浅景深', priority: 10, group: 'dof' },
  { id: 'bokeh', label: '散景', prompt: '柔和散景虚化', priority: 20, group: 'dof' },
  { id: 'cooke_look', label: 'Cooke Look', prompt: 'Cooke温润成像', priority: 30 },
  { id: 'soft_skin', label: '柔和肤色', prompt: '肤色柔和通透', priority: 40 },
  { id: 'large_bokeh', label: '大画幅散景', prompt: '大画幅厚重散景', priority: 50 },
  { id: 'oval_bokeh', label: '椭圆散景', prompt: '椭圆变形散景', priority: 60 },
  { id: 'warm_tone', label: '暖色调', prompt: '整体暖调色彩', priority: 70 },
  { id: 'warm_cool_balance', label: '冷暖平衡', prompt: '冷暖平衡色调', priority: 80 },
  { id: 'medium_format', label: '中画幅质感', prompt: '中画幅厚重肌理', priority: 90 },
  { id: 'imax_flare', label: 'IMAX巨幕眩光', prompt: 'IMAX巨型漫射眩光', priority: 100, group: 'flare' },
  { id: 'anamorphic_flare', label: '变形眩光', prompt: '电影变形眩光', priority: 110, group: 'flare' },
  { id: 'horizontal_streak', label: '水平拉丝', prompt: '水平拉丝眩光', priority: 120, group: 'flare' },
]

export const CAMERA_DICTIONARY: CameraDictionary = {
  bodies: BODIES,
  lenses: LENSES,
  mounts: MOUNTS,
  tones: TONES,
  effects: EFFECTS,
}

// ---------- 默认配置 / localStorage ----------

const STORAGE_PREFIX = 'infinite-canvas:'
export const CAMERA_DEFAULT_CONFIG_KEY = `${STORAGE_PREFIX}camera-default-config`
export const CAMERA_PRESETS_KEY = `${STORAGE_PREFIX}camera-presets`
export const MAX_CAMERA_PRESETS = 20

export const DEFAULT_CAMERA_CONFIG: CameraConfig = {
  bodyId: 'arri_535b',
  lensId: 'cooke_s4i',
  focalValue: '18mm',
  apertureValue: 'T2.0',
  toneId: 'high_mid',
  effectIds: [],
}

// ---------- 字典查询 ----------

export function cameraBodyOf(bodyId: string): CameraBody {
  return BODIES.find(b => b.id === bodyId) ?? BODIES[0]
}

export function cameraLensOf(lensId: string): CameraLens {
  return LENSES.find(l => l.id === lensId) ?? LENSES[0]
}

function cameraToneOf(toneId: string): CameraTone {
  return TONES.find(t => t.id === toneId) ?? TONES.find(t => t.id === DEFAULT_CAMERA_CONFIG.toneId) ?? TONES[0]
}

function cameraEffectOf(effectId: string): CameraEffect | undefined {
  return EFFECTS.find(e => e.id === effectId)
}

/** 某机身可挂载的全部镜头(按挂载表顺序) */
export function cameraLensesForBody(bodyId: string): CameraLens[] {
  const lensIds = MOUNTS.filter(m => m.bodyId === bodyId).map(m => m.lensId)
  const lenses = lensIds.map(id => LENSES.find(l => l.id === id)).filter((l): l is CameraLens => !!l)
  return lenses.length ? lenses : LENSES
}

/** 机身 × 镜头组合的挂载记录(不存在返回 undefined) */
export function cameraMountOf(bodyId: string, lensId: string): CameraLensMount | undefined {
  return MOUNTS.find(m => m.bodyId === bodyId && m.lensId === lensId)
}

/** 该机身的默认(第一支可用)镜头 */
export function defaultLensForBody(bodyId: string): CameraLens {
  return cameraLensesForBody(bodyId)[0]
}

/** 该机身 × 镜头的可选焦段值; 组合不存在时回退该机身默认(第一支)镜头的焦段 */
export function cameraFocalsFor(bodyId: string, lensId: string): string[] {
  const direct = cameraMountOf(bodyId, lensId)?.focals
  if (direct) return direct
  return MOUNTS.find(m => m.bodyId === bodyId)?.focals ?? []
}

/** 焦段选项(适配画面说明按毫米区间生成, 提示词固定「Nmm 焦距」) */
export function cameraFocalOption(value: string): CameraFocalOption {
  const mm = parseInt(value, 10)
  let desc: string
  if (!Number.isFinite(mm)) desc = ''
  else if (mm < 20) desc = '超广角, 大场景与空间交代'
  else if (mm <= 28) desc = '小广角, 环境与叙事'
  else if (mm <= 45) desc = '标准视角, 日常对话'
  else if (mm < 70) desc = '中焦, 人物中近景'
  else desc = '长焦, 特写与空间压缩'
  return { value, label: value, desc, prompt: `${value} 焦距` }
}

/** 光圈选项(提示词固定「值 光圈」) */
export function cameraApertureOption(value: string): CameraApertureOption {
  const t = parseFloat(value.replace(/[^\d.]/g, ''))
  let desc: string
  if (!Number.isFinite(t)) desc = ''
  else if (t <= 1.5) desc = '超大光圈, 极浅景深'
  else if (t <= 2.0) desc = '大光圈, 柔和背景虚化'
  else if (t < 4) desc = '常用档, 画质与虚化平衡'
  else if (t < 5.6) desc = '环境兼顾, 人物背景都清楚'
  else desc = '小光圈, 大景深环境镜头'
  return { value, label: value, desc, prompt: `${value} 光圈` }
}

// ---------- 配置清洗 ----------

/**
 * 校验清洗一份摄影机配置:
 * - 无效机身回落默认
 * - 镜头必须存在且挂载在该机身上(机身×镜头组合表), 否则取该机身第一支镜头
 * - 焦段必须属于「机身×镜头」组合(「不指定」对任何组合合法), 否则取该组合第一项
 * - 光圈必须属于该镜头(「不指定」合法), 否则取该镜头第一项
 * - 特效去重、仅留当前镜头允许的、互斥组内按 priority 保留高者(数字小)、
 *   按优先级排序、最多 4 个
 */
export function sanitizeCameraConfig(raw: Partial<CameraConfig> | null | undefined): CameraConfig {
  const body = BODIES.some(b => b.id === raw?.bodyId) ? (raw?.bodyId as string) : DEFAULT_CAMERA_CONFIG.bodyId

  const mount = MOUNTS.find(m => m.bodyId === body && m.lensId === raw?.lensId)
  const lensId = mount ? (raw?.lensId as string) : cameraLensesForBody(body)[0].id
  const lensDef = cameraLensOf(lensId)
  const focalList = cameraMountOf(body, lensId)?.focals ?? []

  const focal =
    raw?.focalValue === CAMERA_NOT_SPECIFIED || focalList.includes(raw?.focalValue ?? '')
      ? (raw?.focalValue as string)
      : focalList[0]
  const aperture =
    raw?.apertureValue === CAMERA_NOT_SPECIFIED || lensDef.apertures.includes(raw?.apertureValue ?? '')
      ? (raw?.apertureValue as string)
      : lensDef.apertures[0]
  const tone = TONES.some(t => t.id === raw?.toneId)
    ? (raw?.toneId as string)
    : DEFAULT_CAMERA_CONFIG.toneId

  const allowed = new Set(lensDef.effectIds)
  const unique = Array.from(new Set(Array.isArray(raw?.effectIds) ? raw.effectIds : []))
  const picked = unique
    .map(id => cameraEffectOf(id))
    .filter((e): e is CameraEffect => !!e && allowed.has(e.id))
  // 互斥组: 同组只保留优先级最高的一个
  const groupWinner = new Map<string, CameraEffect>()
  picked.forEach(e => {
    if (!e.group) return
    const cur = groupWinner.get(e.group)
    if (!cur || e.priority < cur.priority) groupWinner.set(e.group, e)
  })
  const cleaned = picked
    .filter(e => !e.group || groupWinner.get(e.group)?.id === e.id)
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_EFFECTS_SELECTED)

  return { bodyId: body, lensId, focalValue: focal, apertureValue: aperture, toneId: tone, effectIds: cleaned.map(e => e.id) }
}

// ---------- 提示词组合 ----------

/**
 * 固定顺序: 焦段 → 光圈 → 明度 → 镜头型号+成像质感 → 镜头特效(按优先级) → 机身型号+基础质感,
 * 中文逗号拼接, 总长 ≤200 字截断; 焦段/光圈「不指定」时该段跳过。
 * 机身/镜头以「型号名 + 质感文案」整段写入, 提示词里能明确看出用了哪台机、哪支镜。
 */
export function buildCameraPromptFromConfig(config: CameraConfig): string {
  const cfg = sanitizeCameraConfig(config)
  const lens = cameraLensOf(cfg.lensId)
  const focalText = cfg.focalValue === CAMERA_NOT_SPECIFIED ? '' : cameraFocalOption(cfg.focalValue).prompt
  const apertureText = cfg.apertureValue === CAMERA_NOT_SPECIFIED ? '' : cameraApertureOption(cfg.apertureValue).prompt
  const tone = cameraToneOf(cfg.toneId)
  const effects = cfg.effectIds
    .map(id => cameraEffectOf(id))
    .filter((e): e is CameraEffect => !!e)
    .sort((a, b) => a.priority - b.priority)
    .map(e => e.prompt)
  const body = cameraBodyOf(cfg.bodyId)
  const lensText = `${lens.name}镜头，${lens.lookPrompt}`
  const bodyText = `${body.name}，${body.basePrompt}`
  const parts = [focalText, apertureText, tone.prompt, lensText, ...effects, bodyText].filter(Boolean)
  const joined = parts.join('，')
  return joined.length > MAX_CAMERA_PREFIX_LENGTH ? joined.slice(0, MAX_CAMERA_PREFIX_LENGTH) : joined
}

export interface CameraSummary {
  /** 机身名 */
  title: string
  /** 镜头名 */
  sub: string
  /** 「焦段 / 光圈」 */
  meta: string
  /** 「明度 / N个特效」 */
  metaTail: string
}

export function cameraSummaryFromConfig(config: CameraConfig): CameraSummary {
  const cfg = sanitizeCameraConfig(config)
  const lens = cameraLensOf(cfg.lensId)
  const focalText = cfg.focalValue === CAMERA_NOT_SPECIFIED ? CAMERA_NOT_SPECIFIED_LABEL : cfg.focalValue
  const apertureText = cfg.apertureValue === CAMERA_NOT_SPECIFIED ? CAMERA_NOT_SPECIFIED_LABEL : cfg.apertureValue
  const toneLabel = cameraToneOf(cfg.toneId).label
  const effectCount = cfg.effectIds.length
  return {
    title: cameraBodyOf(cfg.bodyId).name,
    sub: lens.name,
    meta:
      cfg.focalValue === CAMERA_NOT_SPECIFIED && cfg.apertureValue === CAMERA_NOT_SPECIFIED
        ? '焦段 / 光圈不指定'
        : `${focalText} / ${apertureText}`,
    metaTail: `${toneLabel} / ${effectCount}个特效`,
  }
}

/** 切镜头时按新镜头即时校验草稿(不落盘, 弹窗预览用); 焦段按机身×镜头组合校验 */
export function reconcileConfigForLens(config: CameraConfig, lensId: string): CameraConfig {
  return sanitizeCameraConfig({ ...config, lensId })
}

/**
 * 切机身时按挂载关系即时重配草稿(不落盘, 弹窗预览用):
 * 原镜头仍挂在新机身上则保留镜头(但焦段按新组合重新校验), 否则切到该机身第一支镜头。
 */
export function reconcileConfigForBody(config: CameraConfig, bodyId: string): CameraConfig {
  const keepLens = MOUNTS.some(m => m.bodyId === bodyId && m.lensId === config.lensId)
  return sanitizeCameraConfig({ ...config, bodyId, ...(keepLens ? {} : { lensId: cameraLensesForBody(bodyId)[0].id }) })
}

// ---------- localStorage 读写(全部 try/catch 兜底) ----------

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function loadCameraDefault(): CameraConfig {
  try {
    const parsed = safeParse<Partial<CameraConfig>>(window.localStorage.getItem(CAMERA_DEFAULT_CONFIG_KEY))
    return sanitizeCameraConfig(parsed)
  } catch {
    return { ...DEFAULT_CAMERA_CONFIG }
  }
}

export function saveCameraDefault(config: CameraConfig): boolean {
  try {
    window.localStorage.setItem(CAMERA_DEFAULT_CONFIG_KEY, JSON.stringify(sanitizeCameraConfig(config)))
    return true
  } catch {
    return false
  }
}

export function loadCameraPresets(): CameraPreset[] {
  try {
    const parsed = safeParse<CameraPreset[]>(window.localStorage.getItem(CAMERA_PRESETS_KEY))
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(item => item && typeof item.id === 'string' && item.config)
      .map(item => ({ ...item, config: sanitizeCameraConfig(item.config) }))
  } catch {
    return []
  }
}

/** 保存预设; 已满 20 个返回 null, 成功返回新预设 */
export function saveCameraPreset(name: string, config: CameraConfig): CameraPreset | null {
  try {
    const presets = loadCameraPresets()
    if (presets.length >= MAX_CAMERA_PRESETS) return null
    const preset: CameraPreset = {
      id: `cam-preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim() || `${cameraBodyOf(config.bodyId).name} · ${cameraLensOf(config.lensId).name}`,
      config: sanitizeCameraConfig(config),
      createdAt: Date.now(),
    }
    window.localStorage.setItem(CAMERA_PRESETS_KEY, JSON.stringify([preset, ...presets]))
    return preset
  } catch {
    return null
  }
}

export function deleteCameraPreset(presetId: string): CameraPreset[] {
  try {
    const presets = loadCameraPresets().filter(p => p.id !== presetId)
    window.localStorage.setItem(CAMERA_PRESETS_KEY, JSON.stringify(presets))
    return presets
  } catch {
    return loadCameraPresets()
  }
}

// ---------- 摄影机自动命名 ----------

/**
 * 扫描画布上已占用的摄影机名(「摄影机X」), 返回第一个未用字母 A-Z。
 * extraUsed 供多选复制时带上本轮已分配的新名。
 */
export function nextCameraLetter(usedTitles: Iterable<string>, extraUsed?: Set<string>): string {
  const usedLetters = new Set<string>()
  const mark = (title: string) => {
    const m = /^摄影机([A-Z])$/.exec(title.trim())
    if (m) usedLetters.add(m[1])
  }
  for (const t of usedTitles) mark(t)
  extraUsed?.forEach(t => mark(t))
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    if (!usedLetters.has(letter)) return letter
  }
  // 超过 26 台时退回双字母兜底
  return `${String.fromCharCode(90)}${Math.floor(Math.random() * 900 + 100)}`
}

export function cameraTitleFromLetter(letter: string): string {
  return `摄影机${letter}`
}

/**
 * 把摄影提示词追加到用户提示词末尾: 去掉末尾中英文逗号/句号/空白后用中文逗号拼接。
 * 摄影段为空时原样返回; 用户提示词为空时只返回摄影段。
 */
export function appendCameraPrompt(userPrompt: string, cameraPrompt: string): string {
  const base = userPrompt.replace(/[，,。.\s]+$/u, '')
  const extra = cameraPrompt.trim()
  if (!extra) return userPrompt
  return base ? `${base}，${extra}` : extra
}
