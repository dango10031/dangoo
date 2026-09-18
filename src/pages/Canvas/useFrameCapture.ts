import { useState, type RefObject, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { persistMedia } from '@/lib/media'
import type { CanvasCardData, CanvasConnection } from './canvasTypes'
import { uid } from './canvasUtils'

export interface CapturedFrameInput {
  id: string
  blob: Blob
  timeSec: number
  naturalW: number
  naturalH: number
}

export interface UseFrameCaptureOptions {
  cardsRef: RefObject<CanvasCardData[]>
  setCards: Dispatch<SetStateAction<CanvasCardData[]>>
  setConnections: Dispatch<SetStateAction<CanvasConnection[]>>
  /** 媒体落库后触发一次完整保存 */
  flushAfterMediaSaved(cardId: string): void
}

export interface FrameCaptureApi {
  frameCaptureCardId: string | null
  openFrameCapture(cardId: string): void
  closeFrameCapture(): void
  /** 删除卡片时调用：源视频卡被删则关掉弹窗 */
  dismissFrameCaptureIfSource(deletedIds: Set<string>): void
  /** 截帧上传为永久图片并在源卡右侧 3 列落卡、自动连线；返回成功帧的 id */
  addCapturedFramesToCanvas(sourceCardId: string, frames: CapturedFrameInput[]): Promise<string[]>
}

/**
 * 视频帧捕捉：弹窗开关状态 + 把截好的帧上传并落卡。
 * 从 useCanvas 抽出，弹窗 UI 仍在 FrameCaptureDialog，本 hook 只管状态与落卡。
 */
export function useFrameCapture(options: UseFrameCaptureOptions): FrameCaptureApi {
  const { cardsRef, setCards, setConnections, flushAfterMediaSaved } = options
  const [frameCaptureCardId, setFrameCaptureCardId] = useState<string | null>(null)

  function openFrameCapture(cardId: string) {
    setFrameCaptureCardId(cardId)
  }

  function closeFrameCapture() {
    setFrameCaptureCardId(null)
  }

  function dismissFrameCaptureIfSource(deletedIds: Set<string>) {
    setFrameCaptureCardId(prev => (prev && deletedIds.has(prev) ? null : prev))
  }

  async function addCapturedFramesToCanvas(sourceCardId: string, frames: CapturedFrameInput[]): Promise<string[]> {
    if (!frames.length) return []
    const source = cardsRef.current.find(c => c.id === sourceCardId)
    if (!source) {
      toast.error('源视频卡已被删除, 无法添加帧')
      return []
    }
    const uploaded: Array<{ frame: CapturedFrameInput; url: string }> = []
    let failed = 0
    for (const frame of frames) {
      const file = new File([frame.blob], `frame_${Math.round(frame.timeSec * 10)}s.png`, { type: 'image/png' })
      try {
        const url = await persistMedia(file, 'image')
        if (url) uploaded.push({ frame, url })
        else failed += 1
      } catch (err) {
        if ((err as { status?: number })?.status === 412) {
          toast.error('请先登录后再添加到画布')
          return []
        }
        failed += 1
      }
    }
    if (!uploaded.length) {
      toast.error('帧添加失败, 请重试')
      return []
    }
    // 上传是串行 await, 落卡前复查源卡仍存在(上传期间可能被删), 避免孤立卡与悬空连线
    const liveSource = cardsRef.current.find(c => c.id === sourceCardId)
    if (!liveSource) {
      toast.error('源视频卡已被删除, 已取消添加')
      return []
    }
    const baseX = liveSource.x + liveSource.w + 56
    const baseY = liveSource.y
    const newCards: CanvasCardData[] = uploaded.map(({ frame, url }, i) => {
      const cardW = Math.min(240, Math.max(140, Math.round(frame.naturalW)))
      const cardH = Math.round(cardW * (frame.naturalH / Math.max(1, frame.naturalW)))
      const col = i % 3
      const row = Math.floor(i / 3)
      return {
        id: uid(),
        kind: 'result' as CanvasCardData['kind'],
        x: baseX + col * (cardW + 28),
        y: baseY + row * (cardH + 28),
        w: cardW,
        h: cardH,
        url,
        sourceCardId: liveSource.id,
        title: `帧 ${frame.timeSec.toFixed(1)}s`,
      }
    })
    setCards(prev => [...prev, ...newCards])
    setConnections(prev => [...prev, ...newCards.map(nc => ({ id: uid(), fromId: liveSource.id, toId: nc.id }))])
    if (newCards[0]) flushAfterMediaSaved(newCards[0].id)
    if (failed > 0) toast.success(`已添加 ${uploaded.length} 帧到画布, ${failed} 帧上传失败`)
    else toast.success(`已添加 ${uploaded.length} 帧到画布`)
    return uploaded.map(({ frame }) => frame.id)
  }

  return {
    frameCaptureCardId,
    openFrameCapture,
    closeFrameCapture,
    dismissFrameCaptureIfSource,
    addCapturedFramesToCanvas,
  }
}
