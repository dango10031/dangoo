import { useEffect, useRef, useState } from 'react'
import { Crop as CropIcon, Loader2, Scissors } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { mediaSrc } from '@/lib/media'

interface DispRect {
  x: number
  y: number
  w: number
  h: number
}

function clampNum(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

/** 裁剪/提取选区模式: 拖动框体移动, 拖右下角手柄缩放, 始终限制在图片范围内;
 *  crop 导出原图坐标截取的 PNG 替换原图; extract 把 natural 像素选区回调给父级(裁局部图 + 外扩上下文) */
export function CropMode({
  imageUrl,
  busy,
  mode = 'crop',
  onExport,
  onExtract,
  onCancel,
}: {
  imageUrl: string
  busy: boolean
  mode?: 'crop' | 'extract'
  onExport: (blob: Blob) => void
  onExtract?: (sel: { x: number; y: number; w: number; h: number; sourceWidth: number; sourceHeight: number }) => void
  onCancel: () => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [rect, setRect] = useState<DispRect | null>(null)
  const dragRef = useRef<{ kind: 'move' | 'resize'; sx: number; sy: number; orig: DispRect } | null>(null)

  // 图片布局完成后初始化裁剪框: 四周内缩 8%(保留约 84% 宽高)
  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const setup = () => {
      const cw = img.clientWidth
      const ch = img.clientHeight
      if (cw > 4 && ch > 4) setRect({ x: cw * 0.08, y: ch * 0.08, w: cw * 0.84, h: ch * 0.84 })
    }
    if (img.complete) {
      const raf = requestAnimationFrame(() => requestAnimationFrame(setup))
      return () => cancelAnimationFrame(raf)
    }
    img.addEventListener('load', setup)
    return () => img.removeEventListener('load', setup)
  }, [imageUrl])

  function localPoint(e: React.PointerEvent) {
    const r = wrapRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function beginDrag(kind: 'move' | 'resize') {
    return (e: React.PointerEvent) => {
      if (!rect) return
      e.preventDefault()
      e.stopPropagation()
      // eslint-disable-next-line react-hooks/refs -- pointer-down 只在事件期读取 wrapRef
      const p = localPoint(e)
      // eslint-disable-next-line react-hooks/refs -- pointer-down 只在事件期更新拖拽状态
      dragRef.current = { kind, sx: p.x, sy: p.y, orig: { ...rect } }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }
  }

  function onMove(e: React.PointerEvent) {
    const d = dragRef.current
    const img = imgRef.current
    if (!d || !rect || !img) return
    const p = localPoint(e)
    const cw = img.clientWidth
    const ch = img.clientHeight
    if (d.kind === 'move') {
      setRect({
        ...d.orig,
        x: clampNum(d.orig.x + p.x - d.sx, 0, cw - d.orig.w),
        y: clampNum(d.orig.y + p.y - d.sy, 0, ch - d.orig.h),
      })
    } else {
      setRect({
        ...d.orig,
        w: clampNum(d.orig.w + p.x - d.sx, 24, cw - d.orig.x),
        h: clampNum(d.orig.h + p.y - d.sy, 24, ch - d.orig.y),
      })
    }
  }

  function endDrag() {
    dragRef.current = null
  }

  async function apply() {
    const img = imgRef.current
    if (!img || !rect) return
    const cw = img.clientWidth
    const ch = img.clientHeight
    if (cw < 4 || ch < 4) return
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    // 显示坐标 -> 原图(natural)坐标
    const sx = (rect.x / cw) * nw
    const sy = (rect.y / ch) * nh
    const sw = (rect.w / cw) * nw
    const sh = (rect.h / ch) * nh
    if (mode === 'extract') {
      onExtract?.({
        x: Math.round(sx),
        y: Math.round(sy),
        w: Math.round(sw),
        h: Math.round(sh),
        sourceWidth: nw,
        sourceHeight: nh,
      })
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sw))
    canvas.height = Math.max(1, Math.round(sh))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'))
    if (blob) onExport(blob)
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background/40 p-4">
        <div ref={wrapRef} className="relative">
          <img
            ref={imgRef}
            src={mediaSrc(imageUrl)}
            alt="裁剪原图"
            draggable={false}
            // 跨域 CDN 结果图需匿名加载, 否则 canvas.toBlob 导出会因画布污染失败
            crossOrigin="anonymous"
            className="block max-h-[62vh] max-w-full select-none rounded-lg"
          />
          {rect && (
            <>
              {/* 框外遮罩(四块) */}
              <div className="absolute bg-background/70" style={{ left: 0, top: 0, bottom: 0, width: rect.x }} />
              <div className="absolute bg-background/70" style={{ left: rect.x + rect.w, top: 0, right: 0, bottom: 0 }} />
              <div className="absolute bg-background/70" style={{ left: rect.x, top: 0, width: rect.w, height: rect.y }} />
              <div className="absolute bg-background/70" style={{ left: rect.x, top: rect.y + rect.h, width: rect.w, bottom: 0 }} />
              {/* 裁剪框 */}
              <div
                className="absolute cursor-move border-2 border-primary"
                style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
                onPointerDown={beginDrag('move')}
                onPointerMove={onMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <span className="pointer-events-none absolute inset-0">
                  <span className="absolute left-1/3 top-0 h-full w-px bg-primary/30" />
                  <span className="absolute left-2/3 top-0 h-full w-px bg-primary/30" />
                  <span className="absolute left-0 top-1/3 h-px w-full bg-primary/30" />
                  <span className="absolute left-0 top-2/3 h-px w-full bg-primary/30" />
                </span>
                <span
                  className="absolute -bottom-2.5 -right-2.5 h-5 w-5 cursor-nwse-resize rounded-full border-2 border-primary bg-card shadow-md"
                  onPointerDown={beginDrag('resize')}
                  onPointerMove={onMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          取消
        </Button>
        <Button onClick={apply} disabled={busy} className="gap-1.5">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === 'extract' ? <Scissors className="h-4 w-4" /> : <CropIcon className="h-4 w-4" />}
          {mode === 'extract' ? '提取选区' : '应用裁剪'}
        </Button>
      </div>
    </>
  )
}
