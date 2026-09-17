// 画布全局标签的数据模型与颜色工具。
// 标签色是用户内容数据(等同画笔选色), 允许内联 hex; 弹窗/浮层等界面结构仍只用主题 token。

/** 全局标签定义(账号级, 所有画布共享); 卡片只存 slug, 不存 id */
export interface CanvasTagDef {
  id?: string
  name: string
  /** 小写 #rrggbb */
  color: string
  /** 内置 fixed:xxx / ecommerce:xxx, 自定义 custom:<时间戳36进制>:<短随机> */
  slug: string
  /** 'content' | 'ecommerce' | ''(自定义) */
  template?: string
  sort: number
}

export const NAME_MAX = 24

/** 名称校验: trim 后非空且不超过 24 字符 */
export function isValidTagName(name: string): boolean {
  const t = name.trim()
  return t.length > 0 && t.length <= NAME_MAX
}

/** 内置模板: 内容创作(slug/名称/hex 严格按页面规格) */
export const CONTENT_TEMPLATE_DEFS: CanvasTagDef[] = [
  { slug: 'fixed:character', name: '人物', color: '#F5A623', template: 'content', sort: 0 },
  { slug: 'fixed:scene', name: '场景', color: '#2ECC71', template: 'content', sort: 1 },
  { slug: 'fixed:prop', name: '道具', color: '#4A90F5', template: 'content', sort: 2 },
  { slug: 'fixed:style_ref', name: '风格参考', color: '#A855F7', template: 'content', sort: 3 },
  { slug: 'fixed:storyboard', name: '分镜图', color: '#FF4D8D', template: 'content', sort: 4 },
  { slug: 'fixed:reference', name: '参考图', color: '#22C3D6', template: 'content', sort: 5 },
  { slug: 'fixed:other', name: '其他', color: '#2BB8A6', template: 'content', sort: 6 },
]

/** 内置模板: 电商创作 */
export const ECOMMERCE_TEMPLATE_DEFS: CanvasTagDef[] = [
  { slug: 'ecommerce:product', name: '商品', color: '#F5A623', template: 'ecommerce', sort: 0 },
  { slug: 'ecommerce:model', name: '模特', color: '#4A90F5', template: 'ecommerce', sort: 1 },
  { slug: 'ecommerce:scene', name: '场景图', color: '#2ECC71', template: 'ecommerce', sort: 2 },
  { slug: 'ecommerce:selling', name: '卖点图', color: '#FF4D8D', template: 'ecommerce', sort: 3 },
  { slug: 'ecommerce:detail', name: '详情素材', color: '#A855F7', template: 'ecommerce', sort: 4 },
  { slug: 'ecommerce:brand', name: '品牌素材', color: '#22C3D6', template: 'ecommerce', sort: 5 },
]

export const TAG_TEMPLATES: Record<'content' | 'ecommerce', { label: string; defs: CanvasTagDef[] }> = {
  content: { label: '内容创作', defs: CONTENT_TEMPLATE_DEFS },
  ecommerce: { label: '电商创作', defs: ECOMMERCE_TEMPLATE_DEFS },
}

const BUILTIN_LIST = [...CONTENT_TEMPLATE_DEFS, ...ECOMMERCE_TEMPLATE_DEFS]
const BUILTIN_BY_SLUG = new Map<string, CanvasTagDef>(BUILTIN_LIST.map(d => [d.slug, d]))

export function builtinTagDef(slug: string): CanvasTagDef | null {
  return BUILTIN_BY_SLUG.get(slug) ?? null
}

export function isBuiltinSlug(slug: string): boolean {
  return BUILTIN_BY_SLUG.has(slug)
}

/** 自定义标签 slug: custom:<时间戳36进制>:<短随机>(浏览器运行时代码) */
export function makeCustomSlug(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `custom:${Date.now().toString(36)}:${rand}`
}

/** 旧六色图钉 → 内置标签 slug 的纯渲染兼容映射(不回写卡片字段) */
export const LEGACY_PIN_MAP: Record<string, string> = {
  red: 'fixed:storyboard',
  orange: 'fixed:character',
  yellow: 'fixed:character',
  green: 'fixed:scene',
  blue: 'fixed:prop',
  purple: 'fixed:style_ref',
}

/** 预设色两排 10 个, 与内置标签色体系协调 */
export const PRESET_COLORS: string[] = [
  '#E03E3E', // 红
  '#F68D31', // 橙
  '#F5C518', // 黄
  '#2ECC71', // 绿
  '#4A90F5', // 蓝
  '#A855F7', // 紫
  '#FF4D8D', // 粉
  '#22C3D6', // 青
  '#2BB8A6', // 青绿
  '#B45309', // 棕
]

/**
 * 归一化 hex: 接受 #rgb / #rrgggb / rrggbb / rgb(r,g,b) / rgba(...),
 * 输出小写 #rrggbb; 非法返回 null。
 */
export function normalizeHex(input: string): string | null {
  if (!input) return null
  const s = input.trim().toLowerCase()
  let m = /^#?([0-9a-f]{6})$/.exec(s)
  if (m) return `#${m[1]}`
  m = /^#?([0-9a-f]{3})$/.exec(s)
  if (m) {
    const [r, g, b] = m[1]
    return `#${r}${r}${g}${g}${b}${b}`
  }
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(s)
  if (m) {
    const ch = [m[1], m[2], m[3]].map(Number)
    if (ch.every(v => v >= 0 && v <= 255)) {
      return `#${ch.map(v => v.toString(16).padStart(2, '0')).join('')}`
    }
  }
  return null
}

export function isValidHex(input: string): boolean {
  return normalizeHex(input) !== null
}

export interface Hsv {
  h: number
  s: number
  v: number
}

export function hexToHsv(hex: string): Hsv {
  const n = normalizeHex(hex)
  if (!n) return { h: 0, s: 0, v: 0 }
  const r = parseInt(n.slice(1, 3), 16) / 255
  const g = parseInt(n.slice(3, 5), 16) / 255
  const b = parseInt(n.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const rgb = h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x]
  const [r, g, b] = rgb
  const to2 = (ch: number) => Math.round((ch + m) * 255).toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`
}

/** 按标签底色相对亮度返回黑/白文字色(WCAG sRGB 简化算法) */
export function readableTextOn(hex: string): string {
  const n = normalizeHex(hex) ?? '#000000'
  const chan = [n.slice(1, 3), n.slice(3, 5), n.slice(5, 7)].map(h => {
    const v = parseInt(h, 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  const lum = 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2]
  return lum > 0.42 ? '#1F1300' : '#FFFFFF'
}
