import type { GenNodeParams, ModelKind } from './canvasTypes'

/**
 * 计价函数实际读取的参数字段（分辨率/画质/时长）。
 * 完整的 GenNodeParams 是它的超集，可直接传入；测试与聚合函数也可只构造这几个字段。
 */
export type PriceParams = {
  resolution?: string
  quality?: string
  videoDuration?: string
  aspectRatio?: string
}

/** 文生图 6 渠道(顺序即规格确认顺序) */
export const T2I_MODELS = [
  'gpt-image-2',
  'gpt-image-2-0-text-to-image-channel-low-price',
  'nano-banana2-gemini31flash-text-to-image-official-stable',
  'nano-banana2',
  'nano-banana-pro-text-to-image-ultra-official-stable',
  'nano-banana-pro',
]
/** 图生图 6 渠道(分层/复刻等带参考图任务) */
export const I2I_MODELS = [
  'gpt-image-2-image-to-image-official-stable',
  'gpt-image-2-0-edit-channel-low-price',
  'nano-banana2-gemini31flash-image-to-image-official-stable',
  'nano-banana2-gemini31flash-image-to-image-channel-low-price',
  'nano-banana-pro-edit-ultra-official-stable',
  'nano-banana-pro-edit-channel-low-price',
]
export const ALL_IMAGE_MODELS = [...T2I_MODELS, ...I2I_MODELS]

/** 文生视频渠道 */
export const T2V_MODELS = [
  'seedance-2-0-mini-text-to-video',
  'seedance-2.5',
  'xai-grok-imagine-video-v1-5-text-to-video-official-stable',
  'minimax-h3-text-to-video',
  'seedance2-0-multimodal-video',
]
/** 图生视频渠道(图片作首帧) + 1 个 AI 应用渠道 */
export const I2V_MODELS = [
  'seedance-2-0-mini-image-to-video',
  'seedance-2-5-image-to-video-token',
  'xai-grok-imagine-video-v1-5-image-to-video-official-stable',
  'minimax-h3-image-to-video-first-last-frame',
  'seedance2-0-multimodal-video',
  'wan-2.2-i2v-ai-app',
  'wan-2.2-i2v-hq-ai-app',
]
export const ALL_VIDEO_MODELS = [...T2V_MODELS, ...I2V_MODELS]
export const ALL_MODELS = [...ALL_IMAGE_MODELS, ...ALL_VIDEO_MODELS]

/**
 * AI 应用渠道(图生视频): 走独立的 /api/aigc/ai-app/wan22 链路, 不是标准 openapi 模型 ——
 * 不查标准模型契约、不套标准参数/询价、不做 body 换链, 首帧图用该应用自己的上传接口换 fileName。
 */
export const AI_APP_SLUGS: Record<string, string> = {
  'wan-2.2-i2v-ai-app': 'wan22',
  'wan-2.2-i2v-hq-ai-app': 'wan22hq',
}
export function aiAppSlugOf(model: string): string | null {
  return AI_APP_SLUGS[model] ?? null
}

/**
 * 渠道家族: 下拉里同一模型只展示一条, 不再向用户区分「文生/图生」。
 * key = 家族主键(也是文生 slug), i2v/i2i = 有参考图时实际使用的图生 slug;
 * 纯图生渠道(如 WAN 2.2)没有 key 的文生能力, t2 为空、key 即 i2v slug。
 */
export interface ChannelFamily {
  key: string
  media: 'image' | 'video'
  label: string
  t2?: string // 无图时用的文生 slug(纯图生渠道缺省)
  i2: string // 有图时用的图生 slug
  /** 不在渠道下拉里暴露(改为工作流预设等方式进入); 旧节点与预设重建节点仍正常显示/运行 */
  hidden?: boolean
}
export const CHANNEL_FAMILIES: ChannelFamily[] = [
  // 图片家族(文生图 ↔ 图生图 同档合并)
  { key: 'gpt-image-2', media: 'image', label: 'GPT Image 2 · 官方稳定', t2: 'gpt-image-2', i2: 'gpt-image-2-image-to-image-official-stable' },
  { key: 'gpt-image-2-0-text-to-image-channel-low-price', media: 'image', label: 'GPT Image 2 · 低价渠道', t2: 'gpt-image-2-0-text-to-image-channel-low-price', i2: 'gpt-image-2-0-edit-channel-low-price' },
  { key: 'nano-banana2-gemini31flash-text-to-image-official-stable', media: 'image', label: 'Nano Banana 2 · 官方稳定', t2: 'nano-banana2-gemini31flash-text-to-image-official-stable', i2: 'nano-banana2-gemini31flash-image-to-image-official-stable' },
  { key: 'nano-banana2', media: 'image', label: 'Nano Banana 2 · 低价渠道', t2: 'nano-banana2', i2: 'nano-banana2-gemini31flash-image-to-image-channel-low-price' },
  { key: 'nano-banana-pro-text-to-image-ultra-official-stable', media: 'image', label: 'Nano Banana PRO · 官方稳定', t2: 'nano-banana-pro-text-to-image-ultra-official-stable', i2: 'nano-banana-pro-edit-ultra-official-stable' },
  { key: 'nano-banana-pro', media: 'image', label: 'Nano Banana PRO · 低价渠道', t2: 'nano-banana-pro', i2: 'nano-banana-pro-edit-channel-low-price' },
  // 视频家族(文生视频 ↔ 图生视频 同模型合并)
  { key: 'seedance-2-0-mini-text-to-video', media: 'video', label: 'Seedance 2.0 Mini', t2: 'seedance-2-0-mini-text-to-video', i2: 'seedance-2-0-mini-image-to-video' },
  { key: 'seedance-2.5', media: 'video', label: 'Seedance 2.5 · 按时长计费', t2: 'seedance-2.5', i2: 'seedance-2-5-image-to-video-token' },
  { key: 'xai-grok-imagine-video-v1-5-text-to-video-official-stable', media: 'video', label: 'Grok Imagine v1.5 · 官方稳定', t2: 'xai-grok-imagine-video-v1-5-text-to-video-official-stable', i2: 'xai-grok-imagine-video-v1-5-image-to-video-official-stable' },
  { key: 'minimax-h3-text-to-video', media: 'video', label: 'MiniMax H3', t2: 'minimax-h3-text-to-video', i2: 'minimax-h3-image-to-video-first-last-frame' },
  // 统一的 Seedance 2.0: 同一接口兼顾纯文生 / 单图 / 多图+视频+音频参考(原"旗舰"已并入此项)
  { key: 'seedance2-0-multimodal-video', media: 'video', label: 'Seedance 2.0 · 全能参考(多图/视频/音频)', t2: 'seedance2-0-multimodal-video', i2: 'seedance2-0-multimodal-video' },
  // WAN 2.2 不再出现在视频渠道下拉: 统一从资产库「工作流」页签的内置预设拖入(单图生视频)
  { key: 'wan-2.2-i2v-ai-app', media: 'video', label: 'WAN 2.2', i2: 'wan-2.2-i2v-ai-app', hidden: true },
  // WAN 2.2 6 秒高质量版: 同为预设进入的纯图生视频 AI 应用渠道
  { key: 'wan-2.2-i2v-hq-ai-app', media: 'video', label: 'WAN 2.2 · 6秒高质量', i2: 'wan-2.2-i2v-hq-ai-app', hidden: true },
]

// 已下线的旧 Seedance 2.0「旗舰/标准版」slug → 统一到全能参考模型(纯文生也走该接口)
export const LEGACY_VIDEO_SLUG_MAP: Record<string, string> = {
  'seedance-2': 'seedance2-0-multimodal-video',
  'seedance2-0-image-to-video': 'seedance2-0-multimodal-video',
}
const FAMILY_BY_SLUG: Record<string, ChannelFamily> = (() => {
  const m: Record<string, ChannelFamily> = {}
  for (const f of CHANNEL_FAMILIES) {
    m[f.key] = f
    if (f.t2 && f.t2 !== f.key) m[f.t2] = f
    m[f.i2] = f
  }
  // 旧旗舰 slug 映射到全能参考家族
  const mm = m['seedance2-0-multimodal-video']
  if (mm) { m['seedance-2'] = mm; m['seedance2-0-image-to-video'] = mm }
  return m
})()
/** 任意 slug(含老数据的文生/图生 slug) → 所属渠道家族; 非渠道 slug 返回 null */
export function channelFamilyOf(slug: string): ChannelFamily | null {
  return FAMILY_BY_SLUG[slug] ?? null
}
/** 支持「透明背景」开关的图片渠道家族 key(仅 GPT Image 2 官方稳定 / 低价渠道两家族) */
export const TRANSPARENT_BG_FAMILY_KEYS = new Set([
  'gpt-image-2',
  'gpt-image-2-0-text-to-image-channel-low-price',
])
/** 开启透明背景时前置到用户提示词最前面的固定文案 */
export const TRANSPARENT_BG_PROMPT_PREFIX = '生成透明背景图像'

/**
 * 任意模型 slug(家族 key / 文生 / 图生 slug 均可)是否属于支持透明背景的 GPT Image 2 渠道。
 * 切换到 Nano Banana 等其它渠道时控件隐藏, 已存的开关值保留但不参与提交。
 */
export function supportsTransparentBg(slug: string): boolean {
  const fam = channelFamilyOf(slug)
  return !!fam && TRANSPARENT_BG_FAMILY_KEYS.has(fam.key)
}

/**
 * 校验生成节点是否可跑: 返回错误提示或 null。按实际运行模型(家族主键 + 是否有参考图)判断——
 * 图生视频无提示词也可跑; 纯图生渠道缺图在此拦截; 文生图必须有画面描述。
 */
export function validateGenerateRun(input: {
  prompt: string
  hasImage: boolean
  model: string
}): string | null {
  const { prompt, hasImage, model } = input
  const runModel = resolveRunModel(model, hasImage)
  const kind = modelKindOf(runModel)
  const hasPrompt = prompt.trim().length > 0
  if (kind !== 'i2v' && !hasPrompt) return '先在生成节点里写画面描述'
  if (kind === 'i2i' && !hasImage) return '缺少图片无法运行: 请先给该渠道放一张参考图'
  if (kind === 'i2v' && !hasImage) return '缺少图片无法运行: 请先给该渠道放一张图当首帧'
  return null
}

/**
 * 透明背景开关开启且当前渠道支持时, 把固定诉求前置到用户提示词最前面(摄影段仍在最后追加)。
 * 不支持的渠道或关闭态原样返回; 用户已手写同类诉求时不重复加。
 */
export function applyTransparentBgPrompt(prompt: string, params: GenNodeParams): string {
  if (!params.transparentBg || !supportsTransparentBg(params.model)) return prompt
  const base = prompt.trim()
  if (!base) return TRANSPARENT_BG_PROMPT_PREFIX
  if (base.includes(TRANSPARENT_BG_PROMPT_PREFIX)) return base
  return `${TRANSPARENT_BG_PROMPT_PREFIX}，${base}`
}

/** 家族选择 + 是否有生效参考图 → 实际提交的真实模型 slug; 纯图生渠道无图时仍返回 i2(由校验拦截) */
export function resolveRunModel(familyKeyOrSlug: string, hasImg: boolean): string {
  const legacy = LEGACY_VIDEO_SLUG_MAP[familyKeyOrSlug]
  const key = legacy ?? familyKeyOrSlug
  const fam = FAMILY_BY_SLUG[key]
  if (fam) return hasImg || !fam.t2 ? fam.i2 : fam.t2
  return key
}
/** AI 应用 run body 里承载首帧永久链接的内部字段, 提交前会取出并上传换成 fileName */
export const AI_APP_FIRST_FRAME_KEY = '__aiAppFirstFrameUrl'

/** AI 应用「最长边」档位(像素): 与应用内加减器一致, 默认 1280 */
export const AI_APP_LONG_EDGE_DEFAULT = 1280
export const AI_APP_LONG_EDGE_MIN = 512
export const AI_APP_LONG_EDGE_MAX = 2048
export const AI_APP_LONG_EDGE_STEP = 64
export const AI_APP_LONG_EDGE_OPTIONS = [512, 768, 1024, 1280, 1536, 1792, 2048]

/** 把任意输入归一到合法最长边档位(缺省 1280, 非整数/越界收敛到默认或边界) */
export function aiAppLongEdgeOf(value: number | string | undefined | null): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return AI_APP_LONG_EDGE_DEFAULT
  return Math.min(AI_APP_LONG_EDGE_MAX, Math.max(AI_APP_LONG_EDGE_MIN, n))
}

/** AI 应用「总帧数」档位(WAN 2.2 6 秒高质量版): 41–241, 步进 4, 默认 81(约 6 秒) */
export const AI_APP_FRAMES_DEFAULT = 81
export const AI_APP_FRAMES_MIN = 41
export const AI_APP_FRAMES_MAX = 241
export const AI_APP_FRAMES_STEP = 4

/** 把任意输入归一到合法总帧数(缺省 81, 非整数/越界收敛到默认或边界, 对齐步进 4) */
export function aiAppFramesOf(value: number | string | undefined | null): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return AI_APP_FRAMES_DEFAULT
  const clamped = Math.min(AI_APP_FRAMES_MAX, Math.max(AI_APP_FRAMES_MIN, Math.round(n)))
  const steps = Math.round((clamped - AI_APP_FRAMES_MIN) / AI_APP_FRAMES_STEP)
  return AI_APP_FRAMES_MIN + steps * AI_APP_FRAMES_STEP
}
/** Seedance 2.5 系列按时长/分辨率计费, 无固定单价, 挂载时询价回填 */
export const TOKEN_PRICED_VIDEO_MODELS = ['seedance-2.5', 'seedance-2-5-image-to-video-token']
export const MULTIMODAL_VIDEO_MODEL = 'seedance2-0-multimodal-video'
export const DEFAULT_MOTION_PROMPT = '让画面自然地动起来, 主体与风格保持一致, 镜头平稳流畅'

/**
 * 用户实付单价(元/张, 已含创作者加价) —— 与后端钱包收费表逐分一致, 界面显示多少就扣多少。
 * 文生图 6 项。图生同档价见 I2I_PRICE_MAP。
 */
export const T2I_PRICE_MAP: Record<string, number> = {
  // gpt-image-2 官方按 quality×resolution 分档, 见 IMAGE_TIER_PRICE / imageTierPrice, 此处仅留最低档作兜底/下拉起价
  'gpt-image-2': 0.07,
  'gpt-image-2-0-text-to-image-channel-low-price': 0.15,
  'nano-banana2-gemini31flash-text-to-image-official-stable': 0.59,
  'nano-banana2': 0.27,
  'nano-banana-pro-text-to-image-ultra-official-stable': 0.96,
  'nano-banana-pro': 0.48,
}

/**
 * GPT Image 2 官方稳定(文生/图生同价)按画质 × 分辨率九档的用户实付价(元/张, 已含 +20%),
 * 与后端 IMAGE_TIER_PRICE 逐分一致。quality/resolution 缺省或非法时归一到 medium/1k。
 */
export const IMAGE_TIER_PRICE: Record<string, Record<'low' | 'medium' | 'high', Record<string, number>>> = {
  'gpt-image-2': {
    low: { '1k': 0.07, '2k': 0.07, '4k': 0.23 },
    medium: { '1k': 0.46, '2k': 0.91, '4k': 1.36 },
    high: { '1k': 1.67, '2k': 3.32, '4k': 4.99 },
  },
  'gpt-image-2-image-to-image-official-stable': {
    low: { '1k': 0.07, '2k': 0.07, '4k': 0.23 },
    medium: { '1k': 0.46, '2k': 0.91, '4k': 1.36 },
    high: { '1k': 1.67, '2k': 3.32, '4k': 4.99 },
  },
}

type ImageQuality = 'low' | 'medium' | 'high'

/** 分档图片单张用户价; 非分档模型或缺档返回 null */
export function imageTierPrice(model: string, params?: PriceParams): number | null {
  const table = IMAGE_TIER_PRICE[model]
  if (!table) return null
  const q = (String(params?.quality ?? 'medium').toLowerCase() as ImageQuality)
  const quality: ImageQuality = q === 'low' || q === 'medium' || q === 'high' ? q : 'medium'
  const res = String(params?.resolution ?? '1k').toLowerCase()
  const resolution = res === '1k' || res === '2k' || res === '4k' ? res : '1k'
  return table[quality][resolution] ?? table.medium['1k']
}

/**
 * 仅按分辨率 1k/2k/4k 三档的图片渠道用户实付价(元/张, 文生/图生同价), 与后端 IMAGE_RES_PRICE 同源。
 */
export const IMAGE_RES_PRICE: Record<string, Record<string, number>> = {
  // Nano Banana 2 官方(+20%): 底价 0.49/0.74/0.99
  'nano-banana2-gemini31flash-text-to-image-official-stable': { '1k': 0.59, '2k': 0.89, '4k': 1.19 },
  'nano-banana2-gemini31flash-image-to-image-official-stable': { '1k': 0.59, '2k': 0.89, '4k': 1.19 },
  // Nano Banana 2 低价(文生/图生同价 0.27/0.27/0.42)
  'nano-banana2': { '1k': 0.27, '2k': 0.27, '4k': 0.42 },
  'nano-banana2-gemini31flash-image-to-image-channel-low-price': { '1k': 0.27, '2k': 0.27, '4k': 0.42 },
  // Nano Banana PRO 官方(+20%): 底价 0.8/1.0/1.5(已无 8k)
  'nano-banana-pro-text-to-image-ultra-official-stable': { '1k': 0.96, '2k': 1.2, '4k': 1.8 },
  'nano-banana-pro-edit-ultra-official-stable': { '1k': 0.96, '2k': 1.2, '4k': 1.8 },
  // Nano Banana PRO 低价(+20%): 底价 0.4/0.4/0.5
  'nano-banana-pro': { '1k': 0.48, '2k': 0.48, '4k': 0.6 },
  'nano-banana-pro-edit-channel-low-price': { '1k': 0.48, '2k': 0.48, '4k': 0.6 },
}

/** 仅按分辨率分档的图片单张用户价; 非该类模型返回 null */
export function imageResPrice(model: string, params?: PriceParams): number | null {
  const table = IMAGE_RES_PRICE[model]
  if (!table) return null
  const res = String(params?.resolution ?? '1k').toLowerCase()
  const resolution = res === '1k' || res === '2k' || res === '4k' ? res : '1k'
  return table[resolution] ?? table['1k']
}

/** 分档图片的最低档价(用于渠道下拉「¥X 起」); 非分档返回 undefined */
export function imageMinPrice(model: string): number | undefined {
  const qt = IMAGE_TIER_PRICE[model]
  if (qt) return Math.min(...Object.values(qt).flatMap(row => Object.values(row)))
  const rt = IMAGE_RES_PRICE[model]
  if (rt) return Math.min(...Object.values(rt))
  return undefined
}

/** 图生图 6 项用户实付单价(元/张) */
export const I2I_PRICE_MAP: Record<string, number> = {
  'gpt-image-2-image-to-image-official-stable': 0.07,
  'gpt-image-2-0-edit-channel-low-price': 0.15,
  'nano-banana2-gemini31flash-image-to-image-official-stable': 0.59,
  'nano-banana2-gemini31flash-image-to-image-channel-low-price': 0.27,
  'nano-banana-pro-edit-ultra-official-stable': 0.96,
  'nano-banana-pro-edit-channel-low-price': 0.48,
}

/** 全部 12 个图片渠道的用户实付单价(文生 + 图生) */
export const IMAGE_USER_PRICE: Record<string, number> = { ...T2I_PRICE_MAP, ...I2I_PRICE_MAP }

/**
 * 固定按次视频渠道的用户实付价(元/次, 与时长/分辨率无关)。
 * 矩阵按时长计费的视频(Mini / Seedance 2.0 / 全能参考 / Grok / 2.5)不在此表, 走 VIDEO_PER_SEC。
 */
export const VIDEO_FLAT_USER_PRICE: Record<string, number> = {
  'minimax-h3-text-to-video': 0.58,
  'minimax-h3-image-to-video-first-last-frame': 0.58,
}

/**
 * 兼容旧引用: 视频「单次价」初始表。现在只剩固定按次的 MiniMax H3;
 * 其余视频一律由 VIDEO_PER_SEC 按时长矩阵实时计算, 不再有「起价」概念。
 */
export const VIDEO_PRICE_MAP: Record<string, number> = { ...VIDEO_FLAT_USER_PRICE }

/**
 * 加价已内化进上方各价目表(每张/每秒/每次的值即用户实付价, 与后端收费表同源),
 * 不再在展示侧二次乘系数。保留函数仅为兼容旧调用点, 直接返回原价。
 */
/** @deprecated 加价已内化进价目表, 此函数恒等返回 */
export function withCreatorMarkup(_slug: string, base: number): number {
  return base
}

function round2Price(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 单个标准渠道任务的用户实付总额(元), 与后端守卫收费逐分一致:
 * 图片 = 每张价 × 数量; 矩阵视频 = 每秒价 × 时长 × 数量; H3 = 按次价 × 数量。
 * AI 应用渠道(wan22 等)不在此处理, 返回 null 由调用方取 AI_APP_USER_PRICE。
 * 无法定价返回 null(调用方显示「按实际扣费」)。
 */
export function userRunPrice(runModel: string, count: number, params?: PriceParams): number | null {
  if (aiAppSlugOf(runModel)) return null
  const kind = modelKindOf(runModel)
  const n = count > 0 ? count : 1
  if (kind === 't2v' || kind === 'i2v') {
    const per = videoBasePrice(runModel, params)
    if (per !== null) return round2Price(per * n)
    const flat = VIDEO_FLAT_USER_PRICE[runModel]
    if (typeof flat === 'number') return round2Price(flat * n)
    return null
  }
  // 图片: 先画质×分辨率九档(GPT Image 2 官方), 再仅分辨率三档(Nano Banana 2/PRO), 最后固定按张
  const tier = imageTierPrice(runModel, params)
  if (tier !== null) return round2Price(tier * n)
  const resTier = imageResPrice(runModel, params)
  if (resTier !== null) return round2Price(resTier * n)
  const up = IMAGE_USER_PRICE[runModel]
  return typeof up === 'number' ? round2Price(up * n) : null
}

/**
 * AI 应用渠道站内定价(元/次): 平台不给这条链路加价, 改由站内钱包额度收取 ——
 * 提交冻结 → 受理实扣 → 失败自动退回, 与后端钱包底价表 AI_APP_FLOOR 同口径, 改价两处要一起改。
 */
export const AI_APP_USER_PRICE: Record<string, number> = {
  // WAN 2.2 图生视频站内定价 0.80 元/次(与后端 AI_APP_FLOOR 同口径, 改价两处一起改)
  'wan-2.2-i2v-ai-app': 0.8,
  // 6 秒高质量渠道预设已下线, 底价保留给已存画布/自存工作流里的存量节点
  'wan-2.2-i2v-hq-ai-app': 0.8,
}

/**
 * IndexTTS 2 语音克隆(独立 AI 应用, 不走生成节点渠道下拉):
 * 后端 slug / 站内单价(与 000-wallet-core 的 AI_APP_FLOOR 同口径, 改价两处一起改) /
 * 情绪模式枚举与强度、语速档位。
 */
export const TTS_APP_SLUG = 'indextts2'
export const TTS_USER_PRICE = 0.5
export const TTS_PRICE_TEXT = `¥${TTS_USER_PRICE.toFixed(2)} / 次`

/** 情绪模式: 值为提交给应用的字符串枚举, 顺序与应用内一致 */
export const TTS_EMOTION_MODES: Array<{ value: string; label: string }> = [
  { value: '1', label: '正常口播 · 男声' },
  { value: '2', label: '正常口播 · 女声' },
  { value: '3', label: '直播带货 · 高亢' },
  { value: '4', label: '直播带货 · 快节奏' },
  { value: '5', label: '自然谈话' },
  { value: '6', label: '情感电台' },
  { value: '7', label: '励志演讲' },
  { value: '8', label: '自定义情绪' },
]
export const TTS_INTENSITY_MIN = 0
export const TTS_INTENSITY_MAX = 1.6
export const TTS_INTENSITY_STEP = 0.01
export const TTS_INTENSITY_DEFAULT = 0.6
/** 情绪强度快捷档位 */
export const TTS_INTENSITY_PRESETS = [0, 0.3, 0.6, 1.0, 1.3, 1.6]
export const TTS_RATE_MIN = 0.5
export const TTS_RATE_MAX = 2
export const TTS_RATE_STEP = 0.05
export const TTS_RATE_DEFAULT = 1.0
/** 语速快捷档位(建议 0.9–1.1) */
export const TTS_RATE_PRESETS = [0.9, 1.0, 1.1]

/** 任意输入归一到合法情绪强度 */
export function ttsIntensityOf(value: number | string | undefined | null): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  if (!Number.isFinite(n)) return TTS_INTENSITY_DEFAULT
  const clamped = Math.min(TTS_INTENSITY_MAX, Math.max(TTS_INTENSITY_MIN, n))
  return Math.round(clamped * 100) / 100
}

/** 任意输入归一到合法语速 */
export function ttsRateOf(value: number | string | undefined | null): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  if (!Number.isFinite(n)) return TTS_RATE_DEFAULT
  const clamped = Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, n))
  return Math.round(clamped * 100) / 100
}

/**
 * Animate 动作迁移 V9(独立 AI 应用, 人物参考图 + 动作参考视频 → 新视频):
 * 后端 slug / 站内单价(与 000-wallet-core 的 AI_APP_FLOOR 同口径, 改价两处一起改) /
 * 分辨率与姿势枚举 / 各高级参数档位。
 */
export const MOTION_APP_SLUG = 'animatev9'
export const MOTION_USER_PRICE = 8
export const MOTION_PRICE_TEXT = `¥${MOTION_USER_PRICE.toFixed(2)} / 次`

/** 动作参考视频建议时长上限(秒); 1080P 建议更短 */
export const MOTION_VIDEO_MAX_SECONDS = 50
export const MOTION_1080P_MAX_SECONDS = 12

/** 分辨率档位: 值为提交给应用的 select 字符串 */
export const MOTION_RESOLUTIONS: Array<{ value: string; label: string }> = [
  { value: '1', label: '480P' },
  { value: '2', label: '720P' },
  { value: '3', label: '1080P（建议视频 10 秒内）' },
]
/** 姿势选择档位 */
export const MOTION_POSE_MODES: Array<{ value: string; label: string }> = [
  { value: '1', label: 'VITPOSE · 快（默认）' },
  { value: '2', label: 'SDPOSE · 更准更慢' },
  { value: '3', label: 'WUWUPOSE · 动漫 / 特殊身材比例' },
]

export const MOTION_POSE_INTENSITY_MIN = 0
export const MOTION_POSE_INTENSITY_MAX = 2
export const MOTION_CAMERA_INTENSITY_MIN = 0
export const MOTION_CAMERA_INTENSITY_MAX = 2
export const MOTION_EXPRESSION_MIN = 0
export const MOTION_EXPRESSION_MAX = 2
export const MOTION_CHEST_MIN = 0
export const MOTION_CHEST_MAX = 1
export const MOTION_STEP = 0.01

function motionClampFloat(
  value: number | string | null | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''))
  if (!Number.isFinite(n)) return fallback
  const clamped = Math.min(max, Math.max(min, n))
  return Math.round(clamped * 100) / 100
}

/** 姿势强度归一(默认 1.0) */
export function motionPoseIntensityOf(value: number | string | null | undefined): number {
  return motionClampFloat(value, MOTION_POSE_INTENSITY_MIN, MOTION_POSE_INTENSITY_MAX, 1.0)
}
/** 运镜强度归一(默认 1.0) */
export function motionCameraIntensityOf(value: number | string | null | undefined): number {
  return motionClampFloat(value, MOTION_CAMERA_INTENSITY_MIN, MOTION_CAMERA_INTENSITY_MAX, 1.0)
}
/** 表情强度归一(默认 0.8) */
export function motionExpressionOf(value: number | string | null | undefined): number {
  return motionClampFloat(value, MOTION_EXPRESSION_MIN, MOTION_EXPRESSION_MAX, 0.8)
}
/** 胸部抖动幅度归一(默认 0.2) */
export function motionChestOf(value: number | string | null | undefined): number {
  return motionClampFloat(value, MOTION_CHEST_MIN, MOTION_CHEST_MAX, 0.2)
}
/**
 * 视频高清修复(SeedVR2 / FlashVSR, 独立 AI 应用, 同应用两档价):
 * 后端 slug 与站内单价(与 000-wallet-core 的 AI_APP_VARIANT 同口径, 改价两处一起改)。
 */
export const VSR_APP_SLUG = 'videovsr'

export interface VsrModelOption {
  value: '1' | '2'
  label: string
  price: number
  hint: string
}
export const VSR_MODELS: VsrModelOption[] = [
  { value: '1', label: 'SeedVR2 · 高清慢速（¥3/次）', price: 3, hint: '建议视频不超过 40 秒' },
  { value: '2', label: 'FlashVSR · 快速（¥1.5/次）', price: 1.5, hint: '速度快, 质量一般' },
]
export const VSR_RESOLUTION_DEFAULT = 1920
export const VSR_RESOLUTION_MIN = 720
export const VSR_RESOLUTION_MAX = 1920
export const VSR_RESOLUTION_STEP = 16
/** SeedVR2(高清慢速)建议视频时长上限(秒) */
export const VSR_HQ_MAX_SECONDS = 40

/** 按模型档位取站内单价(未知值按高清档 3.00, 与服务端 fail-closed 同口径) */
export function vsrPriceOf(model: string): number {
  return VSR_MODELS.find(m => m.value === model)?.price ?? VSR_MODELS[0].price
}

/** 任意输入归一到合法最大分辨率(缺省 1920, 不允许超过 1920, 对齐步进 16) */
export function vsrResolutionOf(value: number | string | undefined | null): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return VSR_RESOLUTION_DEFAULT
  const clamped = Math.min(VSR_RESOLUTION_MAX, Math.max(VSR_RESOLUTION_MIN, Math.round(n)))
  const steps = Math.round((clamped - VSR_RESOLUTION_MIN) / VSR_RESOLUTION_STEP)
  return VSR_RESOLUTION_MIN + steps * VSR_RESOLUTION_STEP
}

/** 整数参数归一(跳过帧/帧上限/帧率) */
export function motionIntOf(
  value: number | string | null | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 视频「用户实付每秒价」矩阵(元/秒, 已含创作者加价), 与后端钱包 VIDEO_PER_SEC 逐分一致。
 * - 多模态模型(Seedance2.0 全能参考)无参考时价格与文生相同, 统一按文生行计;
 * - token 计费(Seedance2.5)按官方每秒费率 +20% 换算成元/秒;
 * - 分辨率 key 与提交体一致; 没有该分辨率档时回退 720p, 再无返回 null。
 * 用户实付 = 每秒价 × 秒数 × 数量, 与真实扣费完全相同。
 */
const VIDEO_PER_SEC: Record<string, Record<string, number>> = {
  // Seedance 2.0 Mini
  'seedance-2-0-mini-text-to-video': { '480p': 0.36, '720p': 0.72, '1080p': 1.06, '2k': 1.22, '4k': 1.48 },
  'seedance-2-0-mini-image-to-video': { '480p': 0.36, '720p': 0.72, '1080p': 1.06, '2k': 1.22, '4k': 1.48 },
  // Seedance 2.0(旧旗舰/图生/全能参考同价)
  'seedance-2': { '480p': 0.72, '720p': 1.44, '1080p': 1.78, 'native1080p': 3.6, '2k': 1.94, '4k': 2.2, 'native4k': 7.2 },
  'seedance2-0-image-to-video': { '480p': 0.72, '720p': 1.44, '1080p': 1.78, 'native1080p': 3.6, '2k': 1.94, '4k': 2.2, 'native4k': 7.2 },
  'seedance2-0-multimodal-video': { '480p': 0.72, '720p': 1.44, '1080p': 1.78, 'native1080p': 3.6, '2k': 1.94, '4k': 2.2, 'native4k': 7.2 },
  // Seedance 2.5 token 计费: 官方每秒价 +20% (480p原生0.84 / 720p原生1.89 / 1080p原生3.37)
  'seedance-2.5': { '480p': 1.01, '720p': 2.27, 'native1080p': 4.04, '1080p': 2.65, '2k': 2.77, '4k': 3.02 },
  'seedance-2-5-image-to-video-token': { '480p': 1.01, '720p': 2.27, 'native1080p': 4.04, '1080p': 2.65, '2k': 2.77, '4k': 3.02 },
  // Grok Imagine v1.5 官方稳定(图生 720p 官方 0.95, 加价取整后 1.14)
  'xai-grok-imagine-video-v1-5-text-to-video-official-stable': { '480p': 0.67, '720p': 1.18, '1080p': 2.1 },
  'xai-grok-imagine-video-v1-5-image-to-video-official-stable': { '480p': 0.67, '720p': 1.14, '1080p': 2.1 },
}

/** 视频每次用户实付价(每秒用户价 × 秒数); 该模型/分辨率无表内数据时返回 null(如固定按次的 H3) */
export function videoBasePrice(model: string, params?: PriceParams): number | null {
  // 旧旗舰 slug 已并入全能参考
  const m = LEGACY_VIDEO_SLUG_MAP[model] ?? model
  const table = VIDEO_PER_SEC[m]
  if (!table) return null
  const res = String(params?.resolution ?? '720p').toLowerCase()
  let perSec = table[res]
  if (perSec === undefined) perSec = table['720p']
  if (perSec === undefined) return null
  let sec = Number(params?.videoDuration ?? '5')
  if (!Number.isFinite(sec) || sec <= 0) sec = 5
  // 与后端收费口径一致: 最长 30 秒
  if (sec > 30) sec = 30
  return Math.round(perSec * sec * 100) / 100
}

// 渠道展示名: 同族(文生/图生)模型同名, 不再向用户区分; 真实生成类型由有无参考图自动决定
export const MODEL_LABELS: Record<string, string> = {
  'gpt-image-2': 'GPT Image 2 · 官方稳定',
  'gpt-image-2-image-to-image-official-stable': 'GPT Image 2 · 官方稳定',
  'gpt-image-2-0-text-to-image-channel-low-price': 'GPT Image 2 · 低价渠道',
  'gpt-image-2-0-edit-channel-low-price': 'GPT Image 2 · 低价渠道',
  'nano-banana2-gemini31flash-text-to-image-official-stable': 'Nano Banana 2 · 官方稳定',
  'nano-banana2-gemini31flash-image-to-image-official-stable': 'Nano Banana 2 · 官方稳定',
  'nano-banana2': 'Nano Banana 2 · 低价渠道',
  'nano-banana2-gemini31flash-image-to-image-channel-low-price': 'Nano Banana 2 · 低价渠道',
  'nano-banana-pro-text-to-image-ultra-official-stable': 'Nano Banana PRO · 官方稳定',
  'nano-banana-pro-edit-ultra-official-stable': 'Nano Banana PRO · 官方稳定',
  'nano-banana-pro': 'Nano Banana PRO · 低价渠道',
  'nano-banana-pro-edit-channel-low-price': 'Nano Banana PRO · 低价渠道',
  'seedance-2-0-mini-text-to-video': 'Seedance 2.0 Mini',
  'seedance-2-0-mini-image-to-video': 'Seedance 2.0 Mini',
  'seedance-2': 'Seedance 2.0 · 全能参考',
  'seedance2-0-image-to-video': 'Seedance 2.0 · 全能参考',
  'seedance-2.5': 'Seedance 2.5 · 按时长计费',
  'seedance-2-5-image-to-video-token': 'Seedance 2.5 · 按时长计费',
  'xai-grok-imagine-video-v1-5-text-to-video-official-stable': 'Grok Imagine v1.5 · 官方稳定',
  'xai-grok-imagine-video-v1-5-image-to-video-official-stable': 'Grok Imagine v1.5 · 官方稳定',
  'minimax-h3-text-to-video': 'MiniMax H3',
  'minimax-h3-image-to-video-first-last-frame': 'MiniMax H3',
  'seedance2-0-multimodal-video': 'Seedance 2.0 全能参考 · 文字+多图/视频/音频',
  'wan-2.2-i2v-ai-app': 'WAN 2.2',
  'wan-2.2-i2v-hq-ai-app': 'WAN 2.2 · 6秒高质量',
}

/** 视觉分析可选文本模型: qwen3.8-max 不可看图, 禁止出现在视觉任务里 */
export const VISION_LLM_OPTIONS = [
  { slug: 'doubao-seed-2.0-lite', label: '豆包 Seed 2.0 Lite · 可看图 · 快' },
  { slug: 'doubao-seed-2.1-pro', label: '豆包 Seed 2.1 Pro · 可看图 · 高质量' },
  { slug: 'qwen3.8-flash-next', label: '通义千问 3.8 Flash · 可看图 · 快' },
  { slug: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash · 可看图 · 轻量' },
  { slug: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash · 可看图 · 推理强' },
]
export const POLISH_LLM_OPTIONS = [
  ...VISION_LLM_OPTIONS,
  { slug: 'qwen3.8-max', label: '通义千问 3.8 Max · 纯文本润色' },
]
/** 整合分析下拉里可选用的模型(默认千问 3.8 Max 长文整合) */
export const ANALYZE_LLM_OPTIONS = [
  { slug: 'qwen3.8-max', label: '通义千问 3.8 Max · 长文整合（默认推荐）' },
  { slug: 'doubao-seed-2.0-lite', label: '豆包 Seed 2.0 Lite · 可看图 · 快' },
  { slug: 'doubao-seed-2.1-pro', label: '豆包 Seed 2.1 Pro · 可看图 · 高质量' },
  { slug: 'qwen3.8-flash-next', label: '通义千问 3.8 Flash · 可看图 · 快' },
  { slug: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash · 可看图 · 轻量' },
  { slug: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash · 可看图 · 推理强' },
]

/** 复刻节点整合分析线路(当前仅一条: 视觉分析 → 整合编译) */
export const REP_ROUTE_OPTIONS = [{ value: 'route1', label: '线路一' }]

/** 六折面文案润色固定使用的模型(豆包 Seed 2.0 Lite, 快) */
export const REP_PANEL_POLISH_MODEL = 'doubao-seed-2.0-lite'
/** 线路一第一步: 视觉模型读取参考图 */
export const REP_VISION_MODEL = 'doubao-seed-2.0-lite'

export const LLM_ERROR_ZH: Record<string, string> = {
  timeout: 'AI 生成超时 (可能服务器繁忙), 请稍后重试',
  not_found: '请求未能到达 AI, 请检查网络后重试',
  rh_login_required: '请先登录 RunningHub 后再生成',
  insufficient_balance: 'RunningHub 账户余额不足, 请充值后重试',
}

export function modelKindOf(slug: string): ModelKind {
  if (I2I_MODELS.includes(slug)) return 'i2i'
  if (T2V_MODELS.includes(slug)) return 't2v'
  if (I2V_MODELS.includes(slug)) return 'i2v'
  return 't2i'
}

export function formatUnitPrice(v?: number): string {
  return typeof v === 'number' ? `¥${v}` : '按实际扣费'
}

export function defaultGenParams(): GenNodeParams {
  return { model: T2I_MODELS[0], count: 1, aspectRatio: '16:9' }
}

/** 带图生成节点的默认参数: 默认选中首个图生图渠道(老图片节点兼容与拖拽传图节点也用) */
export function defaultImageGenParams(): GenNodeParams {
  return { model: I2I_MODELS[0], count: 1 }
}
