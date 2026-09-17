import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLatestRef } from '@/hooks/useLatestRef'
import { Camera, Eraser, FastForward, ImagePlus, Loader2, SkipBack, SkipForward, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { mediaSrc } from '@/lib/media'
import type { useCanvas } from '@/pages/Canvas/useCanvas'

type CanvasVm = ReturnType<typeof useCanvas>

interface CapturedFrame {
  id: string
  /** canvas 导出的 PNG blob */
  blob: Blob
  /** 本地预览地址, 添加到画布或关闭后统一 revoke */
  objectUrl: string
  /** 截取时间点(秒) */
  timeSec: number
  naturalW: number
  naturalH: number
}

let frameSeq = 0
function nextFrameId(): string {
  frameSeq += 1
  return `frame-${Date.now().toString(36)}-${frameSeq}`
}

/** 时间点按 0.1s 去重, 避免首帧/尾帧/逐秒抽帧产生重复图 */
function roundedKey(t: number): string {
  return Math.round(t * 10).toString()
}

/** seek 兜底超时(ms): 某些编码/极短视频 seeked 可能不触发, 防止队列永久挂起 */
const SEEK_TIMEOUT_MS = 3000

/**
 * 单个源视频的帧捕捉内容(按源卡 key 重挂载, 换视频/关弹窗即全新实例,
 * 旧实例卸载时统一释放 objectURL 与队列, 杜绝跨视频串帧和忙态死锁)。
 * 截帧在浏览器内用 <video>+canvas 完成, 视频是同源永久链接, canvas 不会被跨域污染。
 * 所有抓帧动作串行入队: seek 是异步的, 并发点击会在错误时间点抓帧。
 */
function FrameCaptureEditor({ p, cardId, onClose }: { p: CanvasVm; cardId: string; onClose: () => void }) {
  const card = useMemo(() => p.cards.find(c => c.id === cardId), [p.cards, cardId])
  const videoUrl = card?.url ? mediaSrc(card.url) : ''

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [ready, setReady] = useState(false)
  const [frames, setFrames] = useState<CapturedFrame[]>([])
  const [addingAll, setAddingAll] = useState(false)
  const existingKeysRef = useRef<Set<string>>(new Set())

  // seek 代次: 快速拖进度条时只认最后一次预览 seek
  const seekSeqRef = useRef(0)
  // 抓帧串行队列 + 在途计数(驱动按钮禁用, 杜绝 seek 交错抓错帧)
  const captureQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingCaptureRef = useRef(0)
  const [captureBusy, setCaptureBusy] = useState(false)

  const framesRef = useLatestRef(frames)

  // 卸载(关弹窗/换源卡)统一释放本地预览地址
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 卸载时必须撤销最新帧列表上的全部 URL
      framesRef.current.forEach(f => URL.revokeObjectURL(f.objectUrl))
    }
  }, [framesRef])

  const onLoadedMetadata = () => {
    const v = videoRef.current
    if (!v) return
    setDuration(Number.isFinite(v.duration) ? v.duration : 0)
    setReady(true)
  }

  /** seek 到指定秒并等画面就绪(仅供进度条拖动, 不入抓帧队列); 带代次, 旧 seek 的 seeked 丢弃 */
  const seekToPreview = useCallback((time: number) => {
    const v = videoRef.current
    if (!v || !Number.isFinite(v.duration)) return
    const target = Math.min(Math.max(0, time), Math.max(0, v.duration - 0.001))
    const seq = ++seekSeqRef.current
    v.pause()
    v.currentTime = target
    const onSeeked = () => {
      v.removeEventListener('seeked', onSeeked)
      if (seq !== seekSeqRef.current) return
      setCurrentTime(v.currentTime)
    }
    v.addEventListener('seeked', onSeeked)
  }, [])

  /**
   * 抓帧队列内使用: seek 并等画面就绪后返回最终时间点。
   * 预览 seek 与它共存, 但抓帧期间进度条被禁用, 不会互相抢占;
   * 超时兜底保证队列在 seeked 不触发时也能继续。
   */
  const seekForCapture = useCallback((time: number): Promise<number> => {
    const v = videoRef.current
    if (!v || !Number.isFinite(v.duration)) return Promise.resolve(0)
    const target = Math.min(Math.max(0, time), Math.max(0, v.duration - 0.001))
    return new Promise(resolve => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        v.removeEventListener('seeked', finish)
        window.clearTimeout(timer)
        setCurrentTime(v.currentTime)
        resolve(v.currentTime)
      }
      const timer = window.setTimeout(finish, SEEK_TIMEOUT_MS)
      v.addEventListener('seeked', finish, { once: true })
      v.pause()
      v.currentTime = target
    })
  }, [])

  /** 抓一帧写入预览列表; 必须在抓帧队列内串行调用 */
  const grabAt = useCallback(
    async (time?: number) => {
      const v = videoRef.current
      const canvas = canvasRef.current
      if (!v || !canvas) return
      if (!v.videoWidth) {
        toast.error('视频还没准备好, 稍等一下再试')
        return
      }
      // 无论是否指定时间都先 seek(含当前时间), 保证 drawImage 时画面已落在该帧而非过渡帧
      const t = await seekForCapture(time ?? v.currentTime)
      const key = roundedKey(t)
      if (existingKeysRef.current.has(key)) {
        toast.message('该时间点的帧已经截取过了')
        return
      }
      try {
        canvas.width = v.videoWidth
        canvas.height = v.videoHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
        if (!blob) throw new Error('toBlob failed')
        const objectUrl = URL.createObjectURL(blob)
        existingKeysRef.current.add(key)
        setFrames(prev => [
          ...prev,
          {
            id: nextFrameId(),
            blob,
            objectUrl,
            timeSec: Math.round(t * 100) / 100,
            naturalW: v.videoWidth,
            naturalH: v.videoHeight,
          },
        ])
      } catch {
        toast.error('截取失败: 当前视频不允许浏览器取帧, 请换一个生成视频再试')
      }
    },
    [seekForCapture],
  )

  /** 抓帧动作统一入队, 避免快速连点/边拖边截造成 seek 交错 */
  const enqueueCapture = useCallback((fn: () => Promise<void>) => {
    pendingCaptureRef.current += 1
    setCaptureBusy(true)
    captureQueueRef.current = captureQueueRef.current
      .then(fn)
      .catch(() => {})
      .finally(() => {
        pendingCaptureRef.current -= 1
        if (pendingCaptureRef.current === 0) setCaptureBusy(false)
      })
  }, [])

  const grabFirst = useCallback(() => enqueueCapture(() => grabAt(0)), [enqueueCapture, grabAt])
  const grabCurrent = useCallback(() => enqueueCapture(() => grabAt()), [enqueueCapture, grabAt])
  const grabTail = useCallback(() => {
    const v = videoRef.current
    if (!v || !Number.isFinite(v.duration)) return
    enqueueCapture(() => grabAt(Math.max(0, v.duration - 0.05)))
  }, [enqueueCapture, grabAt])

  /** 逐秒抽帧: 0,1,2…直到最后一秒(不足 1s 的尾段用尾帧时间点补齐), 整批作为一个队列任务 */
  const grabEverySecond = useCallback(() => {
    enqueueCapture(async () => {
      const v = videoRef.current
      if (!v || !Number.isFinite(v.duration) || v.duration <= 0) {
        toast.error('视频还没准备好')
        return
      }
      const times: number[] = []
      for (let t = 0; t < v.duration - 0.05; t += 1) times.push(Math.round(t * 100) / 100)
      times.push(Math.round(Math.max(0, v.duration - 0.05) * 100) / 100)
      const fresh = times.filter(t => !existingKeysRef.current.has(roundedKey(t)))
      if (!fresh.length) {
        toast.message('整秒帧都已经截取过了')
        return
      }
      for (const t of fresh) {
        await grabAt(t)
      }
    })
  }, [enqueueCapture, grabAt])

  const removeFrame = (id: string) => {
    // 副作用放在 updater 外(updater 在开发态可能双调用)
    const target = framesRef.current.find(f => f.id === id)
    if (!target) return
    existingKeysRef.current.delete(roundedKey(target.timeSec))
    URL.revokeObjectURL(target.objectUrl)
    setFrames(prev => prev.filter(f => f.id !== id))
  }

  const clearFrames = () => {
    framesRef.current.forEach(f => URL.revokeObjectURL(f.objectUrl))
    existingKeysRef.current = new Set()
    setFrames([])
  }

  const addAllToCanvas = async () => {
    if (!frames.length || addingAll || captureBusy) return
    setAddingAll(true)
    try {
      const okIds = await p.addCapturedFramesToCanvas(
        cardId,
        frames.map(f => ({ id: f.id, blob: f.blob, timeSec: f.timeSec, naturalW: f.naturalW, naturalH: f.naturalH })),
      )
      if (okIds.length) {
        const okSet = new Set(okIds)
        // 副作用放在 updater 外, 再一次性过滤
        framesRef.current.forEach(f => {
          if (okSet.has(f.id)) {
            existingKeysRef.current.delete(roundedKey(f.timeSec))
            URL.revokeObjectURL(f.objectUrl)
          }
        })
        setFrames(prev => prev.filter(f => !okSet.has(f.id)))
        if (okIds.length === framesRef.current.length) onClose()
      }
    } finally {
      setAddingAll(false)
    }
  }

  const fmt = (t: number) => {
    if (!Number.isFinite(t)) return '0:00'
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const actionBtn =
    'inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-4 text-xs font-medium text-card-foreground transition-colors hover:border-primary hover:text-primary disabled:pointer-events-none disabled:opacity-40'
  const actionDisabled = !ready || captureBusy

  return (
    <>
      {/* 截帧用离屏 canvas */}
      <canvas ref={canvasRef} className="hidden" />

      {videoUrl && (
        <div className="flex flex-col justify-center rounded-lg border border-border bg-black p-2">
          <video
            ref={videoRef}
            src={videoUrl}
            crossOrigin="anonymous"
            playsInline
            preload="metadata"
            onLoadedMetadata={onLoadedMetadata}
            onTimeUpdate={e => {
              if (e.currentTarget.readyState >= 2) setCurrentTime(e.currentTarget.currentTime)
            }}
            onClick={e => {
              if (captureBusy) return
              const v = e.currentTarget
              if (v.paused) void v.play()
              else v.pause()
            }}
            className="max-h-[46vh] w-full rounded object-contain"
          />
        </div>
      )}

      {/* 进度条: 拖动即 seek 预览, 不自动播放; 抓帧队列在途时禁用避免抢占抓帧 seek */}
      <div className="flex items-center gap-3">
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{fmt(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(currentTime, duration || 0)}
          disabled={actionDisabled}
          onChange={e => seekToPreview(Number(e.target.value))}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:cursor-default"
          aria-label="视频进度"
        />
        <span className="w-10 shrink-0 text-xs tabular-nums text-muted-foreground">{fmt(duration)}</span>
      </div>

      {/* 操作按钮 */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={actionBtn} disabled={actionDisabled} onClick={grabFirst}>
          <SkipBack className="h-4 w-4" />
          截首帧
        </button>
        <button type="button" className={actionBtn} disabled={actionDisabled} onClick={grabCurrent}>
          {captureBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
          截当前帧
        </button>
        <button type="button" className={actionBtn} disabled={actionDisabled} onClick={grabEverySecond}>
          <FastForward className="h-4 w-4" />
          逐秒抽帧
        </button>
        <button type="button" className={actionBtn} disabled={actionDisabled} onClick={grabTail}>
          <SkipForward className="h-4 w-4" />
          截尾帧
        </button>
        <button type="button" className={actionBtn} disabled={!frames.length || captureBusy} onClick={clearFrames}>
          <Eraser className="h-4 w-4" />
          清除
        </button>
        <Button
          size="sm"
          className="ml-auto h-9 rounded-full bg-primary px-4 text-xs text-primary-foreground hover:bg-primary/90"
          disabled={!frames.length || addingAll || captureBusy}
          onClick={() => void addAllToCanvas()}
        >
          {addingAll ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-1 h-4 w-4" />}
          全部添加到画布 ({frames.length})
        </Button>
      </div>

      {/* 已截帧预览 */}
      {frames.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">预览帧 · {frames.length} 张</p>
          <div className="grid max-h-44 grid-cols-5 gap-2 overflow-y-auto pr-1 sm:grid-cols-6">
            {frames.map(f => (
              <div
                key={f.id}
                className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-border bg-muted/30"
                title={`${f.timeSec.toFixed(1)} 秒`}
              >
                <img src={f.objectUrl} alt={`${f.timeSec.toFixed(1)} 秒的帧`} className="h-full w-full object-cover" />
                <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">
                  {f.timeSec.toFixed(1)}s
                </span>
                <button
                  type="button"
                  title="删除这一帧"
                  disabled={captureBusy}
                  onClick={() => removeFrame(f.id)}
                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition-opacity hover:bg-destructive disabled:opacity-30 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * 视频帧捕捉弹窗: 源卡 id 作为内部编辑器的 key——
 * 关闭/换源视频时编辑器整体重挂载, 抓帧队列/objectURL/去重集合随之重建, 不残留。
 */
export function FrameCaptureDialog({ p }: { p: CanvasVm }) {
  const cardId = p.frameCaptureCardId
  const open = !!cardId && !!p.cards.find(c => c.id === cardId)?.url
  return (
    <Dialog
      open={open}
      onOpenChange={v => {
        if (!v) p.closeFrameCapture()
      }}
    >
      <DialogContent className="max-h-[92vh] max-w-4xl gap-3 overflow-y-auto p-4">
        <DialogHeader>
          <DialogTitle>捕捉帧</DialogTitle>
        </DialogHeader>
        {cardId && open && <FrameCaptureEditor key={cardId} p={p} cardId={cardId} onClose={() => p.closeFrameCapture()} />}
      </DialogContent>
    </Dialog>
  )
}
