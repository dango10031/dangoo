// 拖拽 / 粘贴 / 文件选择的统一入口工具。
// 专门修 macOS Safari / 微信等来源的兼容问题：
//  - Safari 从访达拖入时 File.type 可能是空串，必须回退用扩展名判定；
//  - Safari 部分来源 dataTransfer.files 为空，需要走 dataTransfer.items；
//  - 文件夹 / HEIC 等来源尽量只取真实图片，避免误吞。

const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'heic', 'heif', 'tiff', 'tif',
])
/** 浏览器 <img> 能直接渲染、画布可直接展示的图片格式 */
const RENDERABLE_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'])
/** 是图片但浏览器无法直接渲染(TIFF / HEIC 等): 上传到画布只会显示破图, 需先转格式 */
const UNSUPPORTED_IMAGE_EXT = new Set(['tiff', 'tif', 'heic', 'heif'])
const UNSUPPORTED_IMAGE_MIME = new Set(['image/tiff', 'image/tif', 'image/heic', 'image/heif'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'])

function extOf(name: string): string {
  const dot = String(name || '').lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 是否图片：MIME 优先，MIME 缺失（Safari 常见）时回退扩展名判定。 */
export function isImageFile(f: File | { name?: string; type?: string }): boolean {
  const type = String(f.type || '').toLowerCase()
  if (type.startsWith('image/')) return true
  if (type) return false // 有明确的非图片 MIME，不再靠扩展名猜
  return IMAGE_EXT.has(extOf(f.name || ''))
}

/** 是否视频（同样回退扩展名）。 */
export function isVideoFile(f: File | { name?: string; type?: string }): boolean {
  const type = String(f.type || '').toLowerCase()
  if (type.startsWith('video/')) return true
  if (type) return false
  return VIDEO_EXT.has(extOf(f.name || ''))
}

/**
 * 画布是否能直接展示该图片: 浏览器 <img> 可渲染的格式才算。
 * TIFF / HEIC 等虽是图片但浏览器画不出来(只会出现破图), 返回 false。
 */
export function isSupportedCanvasImageFile(f: File | { name?: string; type?: string }): boolean {
  const type = String(f.type || '').toLowerCase()
  if (type) {
    if (type.startsWith('image/')) return !UNSUPPORTED_IMAGE_MIME.has(type)
    return false
  }
  // MIME 缺失(Safari 从访达拖入常见): 按扩展名判
  return RENDERABLE_IMAGE_EXT.has(extOf(f.name || ''))
}

/**
 * 把一批文件分成三类: 可直接上画布的图片 / 不支持的图片(TIFF、HEIC 等) / 非图片。
 * 用于上传前给用户准确提示, 而不是静默生成破图。
 */
export function classifyIncomingFiles(
  files: ArrayLike<File | { name?: string; type?: string }>,
): {
  supported: File[]
  unsupportedImages: Array<{ name: string }>
  other: number
} {
  const supported: File[] = []
  const unsupportedImages: Array<{ name: string }> = []
  let other = 0
  for (let i = 0; i < files.length; i++) {
    const f = files[i] as File
    if (!f) continue
    const type = String(f.type || '').toLowerCase()
    const ext = extOf(f.name || '')
    if (isSupportedCanvasImageFile(f)) {
      supported.push(f)
    } else if (
      isImageFile(f) ||
      UNSUPPORTED_IMAGE_MIME.has(type) ||
      UNSUPPORTED_IMAGE_EXT.has(ext)
    ) {
      unsupportedImages.push({ name: String(f.name || '该图片') })
    } else {
      other += 1
    }
  }
  return { supported, unsupportedImages, other }
}

/** 不支持格式的提示文案(列出前 2 个文件名) */
export function unsupportedImageToast(names: Array<{ name: string }>): string {
  const shown = names.slice(0, 2).map(n => n.name).join('、')
  const more = names.length > 2 ? ` 等 ${names.length} 个文件` : ''
  return `${shown}${more} 格式暂不支持, 请先转成 JPG / PNG / WEBP 后再上传`
}

/** 从 FileList / File 数组里挑图片（用兼容性判定，解决 Safari PNG 被过滤）。 */
export function pickImageFiles(files: ArrayLike<File> | null | undefined): File[] {
  if (!files) return []
  const out: File[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    if (f && isImageFile(f)) out.push(f)
  }
  return out
}

/** 从 FileList / File 数组里挑视频（MIME 优先，缺失时回退扩展名）。 */
export function pickVideoFiles(files: ArrayLike<File> | null | undefined): File[] {
  if (!files) return []
  const out: File[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    if (f && isVideoFile(f)) out.push(f)
  }
  return out
}

function isFileEntry(entry: FileSystemEntry | null | undefined): entry is FileSystemFileEntry {
  return !!entry && entry.isFile
}
function isDirEntry(entry: FileSystemEntry | null | undefined): entry is FileSystemDirectoryEntry {
  return !!entry && entry.isDirectory
}

/** 递归把文件夹里的图片拍平（限制数量/深度，防止拖入整个磁盘卡死）。 */
function readEntryImages(entry: FileSystemEntry, out: File[], depth: number, budget: { n: number }): Promise<void> {
  return new Promise(resolve => {
    if (budget.n <= 0 || depth > 4) return resolve()
    if (isFileEntry(entry)) {
      entry.file(
        file => {
          if (budget.n > 0 && isImageFile(file)) {
            out.push(file)
            budget.n -= 1
          }
          resolve()
        },
        () => resolve(),
      )
    } else if (isDirEntry(entry) && depth < 4) {
      const reader = entry.createReader()
      const readBatch = () => {
        reader.readEntries(
          entries => {
            if (!entries.length || budget.n <= 0) return resolve()
            let pending = entries.length
            entries.forEach(child => {
              readEntryImages(child, out, depth + 1, budget).then(() => {
                pending -= 1
                if (pending === 0) readBatch() // Safari 一次只返回 100 条，需续读
              })
            })
          },
          () => resolve(),
        )
      }
      readBatch()
    } else {
      resolve()
    }
  })
}

/**
 * 从拖拽事件稳健提取图片文件（兼容 Safari：files 为空时走 items / webkitGetAsEntry）。
 * 至多取 max 张；文件夹会递归但受限。
 */
/** 拖放事件里只取本函数实际用到的字段，便于用纯文件数组构造（如已先分流掉视频） */
type DropLike = {
  dataTransfer: { files?: ArrayLike<File> | null; items?: DataTransferItemList } | null
}

export async function extractImageFilesFromDrop(
  e: DropLike,
  max = 30,
): Promise<File[]> {
  const dt = e.dataTransfer
  if (!dt) return []

  // 1) 常规路径：files 非空且含图片，直接用（最快路径，不做异步 entry 遍历）
  const direct = pickImageFiles(Array.from(dt.files || []))
  const hasFiles = (dt.files && dt.files.length > 0) || direct.length > 0

  // Safari/Chrome 拖网页图片或部分来源时 items 更可靠；文件夹只能靠 entry
  const items = dt.items
  const hasItemApi = !!(items && items.length && typeof items[0].webkitGetAsEntry === 'function')

  // 直接 files 就能识别出图片，优先走它（避免 entry.file 的额外异步开销）
  if (direct.length > 0) return direct.slice(0, max)

  // files 为空但有 items（Safari 从某些来源拖入 / 文件夹）→ 走 entry
  if (hasItemApi && items) {
    const entries: FileSystemEntry[] = []
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry?.()
      if (entry) entries.push(entry)
    }
    if (entries.length) {
      const out: File[] = []
      const budget = { n: max }
      await Promise.all(entries.map(en => readEntryImages(en, out, 0, budget)))
      if (out.length) return out.slice(0, max)
    }
    // entry 拿不到（纯网页图片拖入）→ 退而取 items 里的 File
    const fallback: File[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const f = items[i].getAsFile()
        if (f && isImageFile(f)) fallback.push(f)
      }
    }
    if (fallback.length) return fallback.slice(0, max)
  }

  // 兜底：哪怕 files 里没识别成图片，也把原始文件返回给上层（上层会再判一次）
  if (!hasFiles) return []
  return Array.from(dt.files || []).slice(0, max)
}
