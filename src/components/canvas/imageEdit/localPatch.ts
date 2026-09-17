// 局部选区提取 + 多局部图融合: 浏览器 Canvas/ImageData 实现, 数值逻辑忠实复刻
// 插件算法参考(compute_padded_rect 等比外扩滑回边界 / smoothstep 羽化 / 环带颜色匹配 clamp±24 / 宽高比 ±1% 校验 / SHA-256 指纹)。
// 全部为纯函数; 图片地址一律先用 mediaSrc() 转同源, 避免 canvas 跨域污染。
import { mediaSrc } from '@/lib/media'

export interface PatchRect {
  x: number
  y: number
  w: number
  h: number
}

/** 局部图上下文: 记录裁剪来源(原图尺寸 + 文件指纹)、选区、等比外扩窗口 */
export interface CropContext {
  version: 2
  contextId: string
  source: {
    url: string
    width: number
    height: number
    fingerprint: string
  }
  rect: PatchRect
  paddedRect: PatchRect
  paddingRatio: number
}

export interface ExtractResult {
  canvas: HTMLCanvasElement
  paddedRect: PatchRect
  rect: PatchRect
}

function toInt(v: unknown): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) throw new Error('坐标必须是整数')
  return n
}

/** 加载图片(natural 尺寸), 强制同源地址避免 canvas 跨域污染 */
export function loadImageNatural(url: string): Promise<{ img: HTMLImageElement; naturalWidth: number; naturalHeight: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        reject(new Error('图片尺寸无效'))
        return
      }
      resolve({ img, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight })
    }
    img.onerror = () => reject(new Error('图片加载失败'))
    const src = mediaSrc(url)
    if (!src) {
      reject(new Error('图片地址无效'))
      return
    }
    img.src = src
  })
}

/** 图片文件 SHA-256 指纹(hex), 融合时校验原图是否被替换 */
export async function sha256Hex(url: string): Promise<string> {
  const src = mediaSrc(url)
  if (!src) throw new Error('图片地址无效')
  const resp = await fetch(src)
  if (!resp.ok) throw new Error('原图读取失败')
  const buf = await resp.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 等比外扩窗口: desiredScale = 1 + 2*paddingRatio, 但不超过图片允许的最大缩放;
 * 窗口居中后滑回图片边界内(四边均匀收窄, 保持与选区相同宽高比)。
 */
export function computePaddedRect(sel: PatchRect, imgW: number, imgH: number, paddingRatio = 0.1): PatchRect {
  const rect: PatchRect = { x: toInt(sel.x), y: toInt(sel.y), w: toInt(sel.w), h: toInt(sel.h) }
  const ratio = Number(paddingRatio)
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 0.5) throw new Error('padding_ratio 无效')
  if (rect.w <= 0 || rect.h <= 0) throw new Error('选区尺寸无效')
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > imgW || rect.y + rect.h > imgH) throw new Error('选区越界')
  const desiredScale = 1 + 2 * ratio
  const availableScale = Math.min(imgW / rect.w, imgH / rect.h)
  const scale = Math.min(desiredScale, availableScale)
  const targetW = Math.min(imgW, Math.max(rect.w, Math.round(rect.w * scale)))
  const targetH = Math.min(imgH, Math.max(rect.h, Math.round(rect.h * scale)))

  const placeAxis = (start: number, length: number, targetLength: number, imageLength: number): number => {
    const ideal = start - Math.floor((targetLength - length) / 2)
    const minimum = Math.max(0, start + length - targetLength)
    const maximum = Math.min(start, imageLength - targetLength)
    return Math.min(Math.max(ideal, minimum), maximum)
  }

  return {
    x: placeAxis(rect.x, rect.w, targetW, imgW),
    y: placeAxis(rect.y, rect.h, targetH, imgH),
    w: targetW,
    h: targetH,
  }
}

/** 按 paddedRect 从原图裁出局部区域(离屏 canvas, 像素坐标 = 原图 natural 像素) */
export function extractPatchCanvas(img: HTMLImageElement, sel: PatchRect, paddingRatio = 0.1): ExtractResult {
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  const rect: PatchRect = { x: Math.round(sel.x), y: Math.round(sel.y), w: Math.round(sel.w), h: Math.round(sel.h) }
  if (rect.w < 32 || rect.h < 32) throw new Error('选区宽高均不得小于 32 像素')
  const paddedRect = computePaddedRect(rect, nw, nh, paddingRatio)
  const canvas = document.createElement('canvas')
  canvas.width = paddedRect.w
  canvas.height = paddedRect.h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画布初始化失败')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, paddedRect.x, paddedRect.y, paddedRect.w, paddedRect.h, 0, 0, paddedRect.w, paddedRect.h)
  return { canvas, paddedRect, rect }
}

function rectOf(v: unknown, name: string): PatchRect {
  if (!v || typeof v !== 'object') throw new Error(`${name}无效`)
  const r = v as Record<string, unknown>
  const out: PatchRect = { x: toInt(r.x), y: toInt(r.y), w: toInt(r.w), h: toInt(r.h) }
  if (out.w <= 0 || out.h <= 0) throw new Error(`${name}尺寸无效`)
  return out
}

/** smoothstep 羽化蒙版: 内选区全不透明, 外扩四边按 t*t*(3-2t) 渐变, 再做 0.8px 高斯模糊, 内区最后强制 255 */
function buildFeatherMask(rect: PatchRect, padded: PatchRect): HTMLCanvasElement {
  const width = padded.w
  const height = padded.h
  const innerLeft = rect.x - padded.x
  const innerTop = rect.y - padded.y
  const innerRight = innerLeft + rect.w
  const innerBottom = innerTop + rect.h

  const smoothstep = (value: number): number => {
    const t = Math.max(0, Math.min(1, value))
    return t * t * (3 - 2 * t)
  }

  const mask = document.createElement('canvas')
  mask.width = width
  mask.height = height
  const mctx = mask.getContext('2d')
  if (!mctx) throw new Error('蒙版初始化失败')
  const imgData = mctx.createImageData(width, height)
  const data = imgData.data
  for (let y = 0; y < height; y += 1) {
    let wy: number
    if (y < innerTop) wy = y / Math.max(1, innerTop)
    else if (y >= innerBottom) wy = (height - 1 - y) / Math.max(1, height - innerBottom)
    else wy = 1
    for (let x = 0; x < width; x += 1) {
      let wx: number
      if (x < innerLeft) wx = x / Math.max(1, innerLeft)
      else if (x >= innerRight) wx = (width - 1 - x) / Math.max(1, width - innerRight)
      else wx = 1
      const a = Math.round(255 * smoothstep(Math.min(wx, wy)))
      const idx = (y * width + x) * 4
      data[idx] = a
      data[idx + 1] = a
      data[idx + 2] = a
      data[idx + 3] = 255
    }
  }
  mctx.putImageData(imgData, 0, 0)

  // 近似高斯 0.8px 模糊: 用 ctx.filter 对蒙版整体做一次 blur(部分浏览器降级为无模糊, smoothstep 渐变本身已足够柔和)
  try {
    const blurred = document.createElement('canvas')
    blurred.width = width
    blurred.height = height
    const bctx = blurred.getContext('2d')
    if (bctx) {
      bctx.filter = 'blur(0.8px)'
      bctx.drawImage(mask, 0, 0)
      bctx.filter = 'none'
      mctx.clearRect(0, 0, width, height)
      mctx.drawImage(blurred, 0, 0)
    }
  } catch {
    // filter 不支持时保留未模糊蒙版
  }
  // 内选区强制不透明(直接写蒙版像素, 内区始终 alpha=255)
  if (innerRight > innerLeft && innerBottom > innerTop) {
    const forced = mctx.getImageData(0, 0, width, height)
    const fd = forced.data
    for (let y = innerTop; y < innerBottom; y += 1) {
      for (let x = innerLeft; x < innerRight; x += 1) {
        const p = (y * width + x) * 4
        fd[p] = 255
        fd[p + 1] = 255
        fd[p + 2] = 255
        fd[p + 3] = 255
      }
    }
    mctx.putImageData(forced, 0, 0)
  }
  return mask
}

/** 环带 = paddedRect 减去内 rect; 统计该区域 RGB 均值, offset=clamp(当前结果均值-局部图均值, -24, 24) 后加到局部图全像素 */
function applyLimitedColorMatch(currentData: ImageData, patchData: ImageData, rect: PatchRect, padded: PatchRect): void {
  const width = padded.w
  const height = padded.h
  const innerLeft = rect.x - padded.x
  const innerTop = rect.y - padded.y
  const innerRight = innerLeft + rect.w
  const innerBottom = innerTop + rect.h
  let rA = 0, gA = 0, bA = 0, rB = 0, gB = 0, bB = 0, count = 0
  const cur = currentData.data
  const pat = patchData.data
  for (let y = 0; y < height; y += 1) {
    const inRingY = y < innerTop || y >= innerBottom
    for (let x = 0; x < width; x += 1) {
      if (!inRingY && x >= innerLeft && x < innerRight) continue
      const idx = (y * width + x) * 4
      rA += cur[idx]
      gA += cur[idx + 1]
      bA += cur[idx + 2]
      rB += pat[idx]
      gB += pat[idx + 1]
      bB += pat[idx + 2]
      count += 1
    }
  }
  if (count === 0) return
  const clamp24 = (v: number) => Math.max(-24, Math.min(24, Math.round(v)))
  const oR = clamp24(rA / count - rB / count)
  const oG = clamp24(gA / count - gB / count)
  const oB = clamp24(bA / count - bB / count)
  if (oR === 0 && oG === 0 && oB === 0) return
  for (let i = 0; i < pat.length; i += 4) {
    pat[i] = Math.max(0, Math.min(255, pat[i] + oR))
    pat[i + 1] = Math.max(0, Math.min(255, pat[i + 1] + oG))
    pat[i + 2] = Math.max(0, Math.min(255, pat[i + 2] + oB))
  }
}

export interface MergePatchInput {
  img: HTMLImageElement
  context: CropContext
}

/**
 * 把多张提取的局部图按数组顺序叠回原图(后者盖前者), 返回原图尺寸的合成 canvas。
 * 逐张: 校验上下文/尺寸/指纹/宽高比(±1%) → 缩回 padded 尺寸 → 环带颜色匹配 → 羽化 alpha 合成。
 */
export function mergePatchesCanvas(
  originalImg: HTMLImageElement,
  patches: MergePatchInput[],
  colorMatch: boolean,
): HTMLCanvasElement {
  const ow = originalImg.naturalWidth
  const oh = originalImg.naturalHeight
  const result = document.createElement('canvas')
  result.width = ow
  result.height = oh
  const rctx = result.getContext('2d')
  if (!rctx) throw new Error('画布初始化失败')
  rctx.imageSmoothingEnabled = true
  rctx.imageSmoothingQuality = 'high'
  rctx.drawImage(originalImg, 0, 0, ow, oh)

  patches.forEach((patchInput, i) => {
    const idx = i + 1
    try {
      const ctx0 = patchInput.context
      if (!ctx0 || ctx0.version !== 2) throw new Error('局部图上下文版本无效')
      if (!ctx0.source?.fingerprint) throw new Error('局部图缺少来源信息')
      const rect = rectOf(ctx0.rect, 'rect')
      const padded = rectOf(ctx0.paddedRect, 'paddedRect')
      if (rect.x < padded.x || rect.y < padded.y || rect.x + rect.w > padded.x + padded.w || rect.y + rect.h > padded.y + padded.h) {
        throw new Error('选区不在局部图范围内')
      }
      if (ctx0.source.width !== ow || ctx0.source.height !== oh) {
        throw new Error('原图尺寸与裁剪来源不一致')
      }
      if (padded.x < 0 || padded.y < 0 || padded.x + padded.w > ow || padded.y + padded.h > oh) {
        throw new Error('局部区域超出原图边界')
      }
      const pw = patchInput.img.naturalWidth
      const ph = patchInput.img.naturalHeight
      const targetRatio = padded.w / padded.h
      const patchRatio = pw / ph
      if (Math.abs(patchRatio / targetRatio - 1) > 0.01) {
        throw new Error('局部图宽高比已改变，无法安全还原')
      }

      // 局部图缩回 padded 尺寸(等比放大/缩小兼容)
      const patchCanvas = document.createElement('canvas')
      patchCanvas.width = padded.w
      patchCanvas.height = padded.h
      const pctx = patchCanvas.getContext('2d')
      if (!pctx) throw new Error('画布初始化失败')
      pctx.imageSmoothingEnabled = true
      pctx.imageSmoothingQuality = 'high'
      pctx.drawImage(patchInput.img, 0, 0, padded.w, padded.h)

      if (colorMatch) {
        const currentRegion = rctx.getImageData(padded.x, padded.y, padded.w, padded.h)
        const patchRegion = pctx.getImageData(0, 0, padded.w, padded.h)
        applyLimitedColorMatch(currentRegion, patchRegion, rect, padded)
        pctx.putImageData(patchRegion, 0, 0)
      }

      // 羽化蒙版作为 alpha: patch alpha × mask/255
      const mask = buildFeatherMask(rect, padded)
      const mctx = mask.getContext('2d')
      const patchRegion = pctx.getImageData(0, 0, padded.w, padded.h)
      const maskRegion = mctx ? mctx.getImageData(0, 0, padded.w, padded.h) : null
      if (maskRegion) {
        const pd = patchRegion.data
        const md = maskRegion.data
        for (let p = 0; p < pd.length; p += 4) {
          pd[p + 3] = Math.round((pd[p + 3] * md[p]) / 255)
        }
        pctx.putImageData(patchRegion, 0, 0)
      }
      rctx.drawImage(patchCanvas, padded.x, padded.y)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '局部图处理失败'
      throw new Error(`第 ${idx} 张局部图：${msg}`, { cause: err })
    }
  })

  return result
}
