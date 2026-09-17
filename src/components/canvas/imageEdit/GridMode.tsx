import { useEffect, useMemo, useRef, useState } from 'react'
import { LayoutGrid, Loader2, Undo2, Eraser, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { mediaSrc } from '@/lib/media'

interface SplitLine {
  type: 'h' | 'v'
  pos: number
}

export interface GridPart {
  blob: Blob
  row: number
  col: number
  rows: number
  cols: number
  naturalW: number
  naturalH: number
  name: string
}

const PRESETS: Array<{ label: string; rows: number; cols: number }> = [
  { label: '1x2', rows: 1, cols: 2 },
  { label: '2x1', rows: 2, cols: 1 },
  { label: '2x2', rows: 2, cols: 2 },
  { label: '2x3', rows: 2, cols: 3 },
  { label: '3x2', rows: 3, cols: 2 },
  { label: '3x3', rows: 3, cols: 3 },
]

function clampNum(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

/** 均匀分布的切割线比例位置 */
function evenLines(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) / (count + 1))
}

/** 由线位置推导出每格的起止比例; 每条线两侧各扣半个间隔, 中间间隔不重复进左右图 */
function cellBounds(lines: number[], gapHalfRatio: number): Array<{ start: number; end: number }> {
  const marks = [0, ...lines, 1]
  const out: Array<{ start: number; end: number }> = []
  for (let i = 0; i < marks.length - 1; i += 1) {
    const start = i === 0 ? 0 : marks[i] + gapHalfRatio
    const end = i === marks.length - 2 ? 1 : marks[i + 1] - gapHalfRatio
    out.push({ start, end: Math.max(start + 0.001, end) })
  }
  return out
}

function GridStep({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex items-center overflow-hidden rounded-lg border border-border">
        <button
          className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => onChange(Math.max(0, value - 1))}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <span className="w-7 text-center text-sm font-medium text-foreground">{value}</span>
        <button
          className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => onChange(Math.min(8, value + 1))}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </span>
    </span>
  )
}

/** 宫格切分模式: 规则宫格(预设/横竖线数量)或自定义点击放置切割线; 间隔从线两侧扣除; 应用后逐格导出 PNG */
export function GridMode({
  imageUrl,
  busy,
  onExport,
  onCancel,
}: {
  imageUrl: string
  busy: boolean
  onExport: (parts: GridPart[]) => void
  onCancel: () => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [mode, setMode] = useState<'grid' | 'custom'>('grid')
  const [hCount, setHCount] = useState(2)
  const [vCount, setVCount] = useState(2)
  const [gap, setGap] = useState(8)
  const [placeType, setPlaceType] = useState<'h' | 'v'>('h')
  const [customH, setCustomH] = useState<number[]>([])
  const [customV, setCustomV] = useState<number[]>([])
  const addOrderRef = useRef<SplitLine[]>([])
  const dragLineRef = useRef<{ type: 'h' | 'v'; index: number } | null>(null)

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

  const hLines = useMemo(
    () => (mode === 'grid' ? evenLines(hCount) : [...customH].sort((a, b) => a - b)),
    [mode, hCount, customH],
  )
  const vLines = useMemo(
    () => (mode === 'grid' ? evenLines(vCount) : [...customV].sort((a, b) => a - b)),
    [mode, vCount, customV],
  )
  const rows = hLines.length + 1
  const cols = vLines.length + 1

  function localPoint(e: React.PointerEvent | React.MouseEvent) {
    const r = wrapRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function onStagePointerDown(e: React.PointerEvent) {
    if (busy || mode !== 'custom' || !size.w) return
    // 点在已存在的线上时不新增(线自身的拖拽优先)
    const p = localPoint(e)
    const pos = placeType === 'h' ? p.y / size.h : p.x / size.w
    const clamped = clampNum(pos, 0.02, 0.98)
    const line: SplitLine = { type: placeType, pos: clamped }
    addOrderRef.current.push(line)
    if (placeType === 'h') setCustomH(prev => [...prev, clamped])
    else setCustomV(prev => [...prev, clamped])
  }

  function beginDragLine(type: 'h' | 'v', index: number) {
    return (e: React.PointerEvent) => {
      if (mode !== 'custom') return
      e.preventDefault()
      e.stopPropagation()
      dragLineRef.current = { type, index }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }
  }

  function onDragMove(e: React.PointerEvent) {
    const d = dragLineRef.current
    if (!d || !size.w) return
    const p = localPoint(e)
    const pos = clampNum(d.type === 'h' ? p.y / size.h : p.x / size.w, 0.02, 0.98)
    if (d.type === 'h') setCustomH(prev => prev.map((v, i) => (i === d.index ? pos : v)))
    else setCustomV(prev => prev.map((v, i) => (i === d.index ? pos : v)))
  }

  function endDrag() {
    dragLineRef.current = null
  }

  function undoLastLine() {
    const last = addOrderRef.current.pop()
    if (!last) return
    if (last.type === 'h') {
      const idx = [...customH].sort((a, b) => a - b).indexOf(last.pos)
      setCustomH(prev => prev.filter((_, i) => i !== idx))
    } else {
      const idx = [...customV].sort((a, b) => a - b).indexOf(last.pos)
      setCustomV(prev => prev.filter((_, i) => i !== idx))
    }
  }

  function clearCustom() {
    addOrderRef.current = []
    setCustomH([])
    setCustomV([])
  }

  function applyPreset(r: number, c: number) {
    setMode('grid')
    setHCount(r - 1)
    setVCount(c - 1)
  }

  async function apply() {
    const img = imgRef.current
    if (!img || !size.w) return
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    const cw = img.clientWidth
    const ch = img.clientHeight
    if (cw < 4 || nw < 4) return
    const hHalf = (gap / 2 / ch) * nh
    const vHalf = (gap / 2 / cw) * nw
    const hBounds = cellBounds(hLines, hHalf / nh)
    const vBounds = cellBounds(vLines, vHalf / nw)
    const parts: GridPart[] = []
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const sx = vBounds[c].start * nw
        const sw = (vBounds[c].end - vBounds[c].start) * nw
        const sy = hBounds[r].start * nh
        const sh = (hBounds[r].end - hBounds[r].start) * nh
        if (sw < 4 || sh < 4) continue
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(sw)
        canvas.height = Math.round(sh)
        const ctx = canvas.getContext('2d')
        if (!ctx) continue
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
        try {
          const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'))
          if (!blob) continue
          parts.push({
            blob,
            row: r,
            col: c,
            rows,
            cols,
            naturalW: canvas.width,
            naturalH: canvas.height,
            name: `r${r + 1}_c${c + 1}`,
          })
        } catch {
          // Skip a cell that cannot be rasterized instead of failing the batch.
        }
      }
    }
    if (parts.length) onExport(parts)
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <button
          onClick={() => setMode('custom')}
          className={`h-8 rounded-lg border px-3 text-xs font-medium transition-colors ${
            mode === 'custom'
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          自定义
        </button>
        <span className="text-xs text-muted-foreground">预设</span>
        {PRESETS.map(ps => {
          const active = mode === 'grid' && hCount === ps.rows - 1 && vCount === ps.cols - 1
          return (
            <button
              key={ps.label}
              onClick={() => applyPreset(ps.rows, ps.cols)}
              className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {ps.label}
            </button>
          )
        })}
        {mode === 'grid' ? (
          <>
            <GridStep label="横向线" value={hCount} onChange={setHCount} />
            <GridStep label="竖向线" value={vCount} onChange={setVCount} />
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">间隔(px)</span>
              <input
                type="range"
                min={0}
                max={40}
                value={gap}
                onChange={e => setGap(Number(e.target.value))}
                className="h-1 w-24 cursor-pointer accent-primary"
              />
              <span className="w-6 rounded-md bg-primary px-1.5 py-0.5 text-center text-xs font-medium text-primary-foreground">
                {gap}
              </span>
            </span>
          </>
        ) : (
          <>
            <button
              onClick={() => setPlaceType('h')}
              className={`h-8 rounded-lg border px-3 text-xs font-medium transition-colors ${
                placeType === 'h'
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              放水平线
            </button>
            <button
              onClick={() => setPlaceType('v')}
              className={`h-8 rounded-lg border px-3 text-xs font-medium transition-colors ${
                placeType === 'v'
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              放竖直线
            </button>
            <button
              onClick={undoLastLine}
              className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Undo2 className="h-3.5 w-3.5" />
              撤销上一条
            </button>
            <button
              onClick={clearCustom}
              className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Eraser className="h-3.5 w-3.5" />
              清空
            </button>
          </>
        )}
        <span className="ml-auto rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          将输出 {rows}×{cols} = {rows * cols} 张
        </span>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background/40 p-4">
        <div ref={wrapRef} className="relative">
          <img
            ref={imgRef}
            src={mediaSrc(imageUrl)}
            alt="宫格切分原图"
            draggable={false}
            // 结果图是跨域 CDN 地址: 必须匿名跨域加载, 否则画到 canvas 后 toBlob 会因
            // 画布污染抛 SecurityError, 表现为「切分到 Output」按钮点了没反应。CDN 已返回 ACAO:*。
            crossOrigin="anonymous"
            className={`block max-h-[56vh] max-w-full select-none rounded-lg ${
              mode === 'custom' ? 'cursor-crosshair' : ''
            }`}
            onPointerDown={onStagePointerDown}
          />
          {size.w > 0 && (
            <div
              className="absolute left-0 top-0"
              style={{ width: size.w, height: size.h }}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {hLines.map((pos, i) => {
                const y = pos * size.h
                const hit = Math.max(gap, 12)
                return (
                  <div
                    key={`h-${i}`}
                    className={`absolute left-0 right-0 ${mode === 'custom' ? 'cursor-ns-resize touch-none' : ''}`}
                    style={{ top: y - hit / 2, height: hit }}
                    onPointerDown={beginDragLine('h', i)}
                  >
                    <span className="pointer-events-none absolute left-0 right-0 border-t border-primary/70" style={{ top: hit / 2 - gap / 2 }} />
                    <span className="pointer-events-none absolute left-0 right-0 border-t border-primary/70" style={{ top: hit / 2 + gap / 2 }} />
                  </div>
                )
              })}
              {vLines.map((pos, i) => {
                const x = pos * size.w
                const hit = Math.max(gap, 12)
                return (
                  <div
                    key={`v-${i}`}
                    className={`absolute bottom-0 top-0 ${mode === 'custom' ? 'cursor-ew-resize touch-none' : ''}`}
                    style={{ left: x - hit / 2, width: hit }}
                    onPointerDown={beginDragLine('v', i)}
                  >
                    <span className="pointer-events-none absolute bottom-0 top-0 border-l border-primary/70" style={{ left: hit / 2 - gap / 2 }} />
                    <span className="pointer-events-none absolute bottom-0 top-0 border-l border-primary/70" style={{ left: hit / 2 + gap / 2 }} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">
          {mode === 'custom' ? '点击图片放置切割线, 拖动线可移动位置' : '间隔会从每条切割线两侧各扣除一半'}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button onClick={apply} disabled={busy} className="gap-1.5">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LayoutGrid className="h-4 w-4" />}
            切分到 Output
          </Button>
        </div>
      </div>
    </>
  )
}
