import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Brush,
  Square,
  Circle,
  ListOrdered,
  Type,
  Undo2,
  Redo2,
  Eraser,
  Pencil,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { mediaSrc } from '@/lib/media'
import { DRAW_COLORS, contentColorOf } from './colors'
import type { DrawColorKey } from './colors'

type DrawTool = 'free' | 'rect' | 'ellipse' | 'label' | 'text'

type DrawShape =
  | { type: 'free'; pts: Array<{ x: number; y: number }>; color: DrawColorKey; width: number }
  | { type: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; color: DrawColorKey; width: number }
  | { type: 'label'; x: number; y: number; color: DrawColorKey; width: number; text: string }
  | { type: 'text'; x: number; y: number; color: DrawColorKey; width: number; text: string }

const HISTORY_CAP = 40
const TOOLS: Array<{ key: DrawTool; label: string; icon: React.ReactNode }> = [
  { key: 'free', label: '自由画笔', icon: <Brush className="h-4 w-4" /> },
  { key: 'rect', label: '矩形', icon: <Square className="h-4 w-4" /> },
  { key: 'ellipse', label: '椭圆', icon: <Circle className="h-4 w-4" /> },
  { key: 'label', label: '数字标签', icon: <ListOrdered className="h-4 w-4" /> },
  { key: 'text', label: '文字', icon: <Type className="h-4 w-4" /> },
]

/** 在 canvas 上绘制一组形状; scale 为显示尺寸/自然尺寸的换算系数(显示预览为 1, 导出为自然/显示) */
function paintShapes(
  ctx: CanvasRenderingContext2D,
  shapes: DrawShape[],
  scale: number,
) {
  shapes.forEach(s => {
    const col = contentColorOf(s.color).hsl
    const lw = Math.max(1, s.width * scale)
    ctx.strokeStyle = col
    ctx.fillStyle = col
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (s.type === 'free') {
      if (s.pts.length < 2) return
      ctx.beginPath()
      ctx.moveTo(s.pts[0].x * scale, s.pts[0].y * scale)
      for (let i = 1; i < s.pts.length; i += 1) ctx.lineTo(s.pts[i].x * scale, s.pts[i].y * scale)
      ctx.stroke()
    } else if (s.type === 'rect') {
      ctx.strokeRect(s.x * scale, s.y * scale, s.w * scale, s.h * scale)
    } else if (s.type === 'ellipse') {
      ctx.beginPath()
      ctx.ellipse(
        (s.x + s.w / 2) * scale,
        (s.y + s.h / 2) * scale,
        Math.abs(s.w / 2) * scale,
        Math.abs(s.h / 2) * scale,
        0,
        0,
        Math.PI * 2,
      )
      ctx.stroke()
    } else if (s.type === 'label' || s.type === 'text') {
      const fontPx = (s.type === 'label' ? 26 : 18) * scale + lw
      ctx.font = `600 ${fontPx}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const x = s.x * scale
      const y = s.y * scale
      if (s.type === 'label') {
        const r = fontPx * 0.78
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = 'hsl(0,0%,98%)'
        ctx.fillText(s.text, x, y + fontPx * 0.04)
      } else {
        ctx.lineWidth = Math.max(1, lw * 0.35)
        ctx.strokeStyle = 'hsl(0,0%,98%)'
        ctx.strokeText(s.text, x, y)
        ctx.fillStyle = col
        ctx.fillText(s.text, x, y)
      }
    }
  })
}

/** 画笔标注模式: 自由线/矩形/椭圆/数字序号/文字, 撤销重做清空, 应用后把标注烘焙进原图导出 PNG */
export function DrawMode({
  imageUrl,
  busy,
  onExport,
  onCancel,
}: {
  imageUrl: string
  busy: boolean
  onExport: (blob: Blob) => void
  onCancel: () => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [tool, setTool] = useState<DrawTool>('free')
  const [color, setColor] = useState<DrawColorKey>('red')
  const [brushW, setBrushW] = useState(4)
  const [stack, setStack] = useState<DrawShape[][]>([[]])
  const [index, setIndex] = useState(0)
  const [labelCount, setLabelCount] = useState(0)
  const [textDraft, setTextDraft] = useState<{ x: number; y: number } | null>(null)
  const [textValue, setTextValue] = useState('')
  const dragRef = useRef<DrawShape | null>(null)
  const freePtsRef = useRef<Array<{ x: number; y: number }>>([])

  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const measure = () => {
      const w = img.clientWidth
      const h = img.clientHeight
      if (w > 4 && h > 4) setSize({ w, h })
    }
    if (img.complete) {
      const raf = requestAnimationFrame(() => requestAnimationFrame(measure))
      return () => cancelAnimationFrame(raf)
    }
    img.addEventListener('load', measure)
    return () => img.removeEventListener('load', measure)
  }, [imageUrl])

  const shapes = useMemo(() => stack[index] ?? [], [stack, index])

  // 实时重绘: 每次形状变化都整幅重绘, 拖动矩形/椭圆无残影
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w < 4) return
    canvas.width = size.w
    canvas.height = size.h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const preview = dragRef.current ? [...shapes, dragRef.current] : shapes
    paintShapes(ctx, preview, 1)
  }, [shapes, size])

  function commit(next: DrawShape[]) {
    const trimmed = stack.slice(0, index + 1)
    const withNext = [...trimmed, next]
    setStack(withNext.slice(-HISTORY_CAP))
    setIndex(Math.min(index + 1, HISTORY_CAP - 1))
  }

  function undo() {
    if (index > 0) setIndex(index - 1)
  }
  function redo() {
    if (index < stack.length - 1) setIndex(index + 1)
  }
  function clearAll() {
    commit([])
    setLabelCount(0)
  }

  function localPoint(e: React.PointerEvent) {
    const r = wrapRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (busy) return
    const p = localPoint(e)
    if (tool === 'text') {
      setTextDraft(p)
      setTextValue('')
      return
    }
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const base = { color, width: brushW }
    if (tool === 'label') {
      const n = labelCount + 1
      commit([...shapes, { type: 'label', x: p.x, y: p.y, ...base, text: n <= 20 ? ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩','⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'][n - 1] : `(${n})` }])
      setLabelCount(n)
      return
    }
    if (tool === 'free') {
      freePtsRef.current = [p]
      dragRef.current = { type: 'free', pts: [p], ...base }
    } else {
      dragRef.current = { type: tool, x: p.x, y: p.y, w: 0, h: 0, ...base }
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d) return
    const p = localPoint(e)
    if (d.type === 'free') {
      freePtsRef.current.push(p)
      d.pts = [...freePtsRef.current]
    } else if (d.type === 'rect' || d.type === 'ellipse') {
      const sx = d.w >= 0 ? d.x : d.x + d.w
      const sy = d.h >= 0 ? d.y : d.y + d.h
      d.w = p.x - sx
      d.h = p.y - sy
    }
    // 触发预览重绘
    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        paintShapes(ctx, [...shapes, d], 1)
      }
    }
  }

  function onPointerUp() {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.type === 'free' && d.pts.length < 2) return
    if ((d.type === 'rect' || d.type === 'ellipse') && Math.abs(d.w) < 3 && Math.abs(d.h) < 3) return
    commit([...shapes, d])
  }

  function submitText() {
    const t = textValue.trim()
    if (t && textDraft) {
      commit([...shapes, { type: 'text', x: textDraft.x, y: textDraft.y, color, width: brushW, text: t }])
    }
    setTextDraft(null)
    setTextValue('')
  }

  async function apply() {
    const img = imgRef.current
    if (!img || size.w < 4) return
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    const cw = img.clientWidth
    if (cw < 4 || nw < 4) return
    const canvas = document.createElement('canvas')
    canvas.width = nw
    canvas.height = nh
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, 0, 0, nw, nh)
    // 标注按显示->自然尺寸换算后叠加
    paintShapes(ctx, shapes, nw / cw)
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'))
    if (blob) onExport(blob)
  }

  function ToolBtn({ tk, label, icon }: { tk: DrawTool; label: string; icon: React.ReactNode }) {
    const active = tool === tk
    return (
      <button
        title={label}
        onClick={() => setTool(tk)}
        className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
          active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        }`}
      >
        {icon}
      </button>
    )
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {TOOLS.map(t => (
          <ToolBtn key={t.key} tk={t.key} label={t.label} icon={t.icon} />
        ))}
        <span className="mx-1 h-6 w-px bg-border" />
        <span className="text-xs text-muted-foreground">颜色</span>
        <span className="flex items-center gap-1.5">
          {DRAW_COLORS.map(c => (
            <button
              key={c.key}
              title={c.label}
              onClick={() => setColor(c.key)}
              className={`h-6 w-6 rounded-full ${c.cssClass} transition-transform hover:scale-110 ${
                color === c.key ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : ''
              }`}
            />
          ))}
        </span>
        <span className="mx-1 h-6 w-px bg-border" />
        <span className="text-xs text-muted-foreground">笔刷</span>
        <input
          type="range"
          min={1}
          max={24}
          value={brushW}
          onChange={e => setBrushW(Number(e.target.value))}
          className="h-1 w-28 cursor-pointer accent-primary"
        />
        <span className="w-6 text-xs text-muted-foreground">{brushW}</span>
        <span className="mx-1 h-6 w-px bg-border" />
        <button
          title="撤销"
          onClick={undo}
          disabled={index <= 0}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          title="重做"
          onClick={redo}
          disabled={index >= stack.length - 1}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Redo2 className="h-4 w-4" />
        </button>
        <button
          title="清空"
          onClick={clearAll}
          className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Eraser className="h-4 w-4" />
          清空
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background/40 p-4">
        <div ref={wrapRef} className="relative">
          <img
            ref={imgRef}
            src={mediaSrc(imageUrl)}
            alt="画笔标注原图"
            draggable={false}
            // 跨域 CDN 结果图需匿名加载, 否则与标注 canvas 合成后 toBlob 会因画布污染失败
            crossOrigin="anonymous"
            className="block max-h-[56vh] max-w-full select-none rounded-lg"
          />
          {size.w > 0 && (
            <canvas
              ref={canvasRef}
              width={size.w}
              height={size.h}
              className="absolute left-0 top-0 h-full w-full cursor-crosshair touch-none rounded-lg"
              style={{ width: size.w, height: size.h }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          )}
          {textDraft && (
            <input
              autoFocus
              value={textValue}
              onChange={e => setTextValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitText()
                if (e.key === 'Escape') setTextDraft(null)
              }}
              onBlur={submitText}
              placeholder="输入文字, 回车确认"
              className="absolute z-10 w-40 -translate-x-1/2 -translate-y-1/2 rounded-md border border-primary bg-card px-2 py-1 text-sm text-card-foreground outline-none"
              style={{ left: textDraft.x, top: textDraft.y }}
            />
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">
          {tool === 'text' ? '在图上点击放置文字标签' : tool === 'label' ? '点击放置自动编号标签' : '按住拖动进行绘制'}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button onClick={apply} disabled={busy} className="gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />}
            应用画笔
          </Button>
        </div>
      </div>
    </>
  )
}
