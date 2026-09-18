import { useState, type RefObject, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { persistMedia } from '@/lib/media'
import { computePaddedRect, extractPatchCanvas, loadImageNatural, sha256Hex, type CropContext } from '@/components/canvas/imageEdit/localPatch'
import type { CanvasCardData, CanvasConnection, ImageEditGridPart } from './canvasTypes'
import { uid } from './canvasUtils'

export type ImageEditMode = 'crop' | 'draw' | 'grid' | 'extract'

export interface ImageEditResult {
  kind: 'crop' | 'draw' | 'grid'
  blob?: Blob
  parts?: ImageEditGridPart[]
}

export interface UseImageEditsOptions {
  cardsRef: RefObject<CanvasCardData[]>
  setCards: Dispatch<SetStateAction<CanvasCardData[]>>
  setConnections: Dispatch<SetStateAction<CanvasConnection[]>>
  updateCard(cardId: string, patch: Partial<CanvasCardData>): void
  flushAfterMediaSaved(cardId: string): void
  signalLoginRequired(): void
}

export interface ImageEditsApi {
  editDialogId: string | null
  editDialogMode: ImageEditMode | null
  openImageEditor(cardId: string, mode: ImageEditMode): void
  closeImageEditor(): void
  /** 图片编辑器应用入口: 裁剪/画笔替换原图, 宫格切分追加结果卡 */
  applyImageEdit(cardId: string, result: ImageEditResult): Promise<void>
  /**
   * 提取选区: 按 natural 像素选区等比外扩裁出局部图(含上下文环带), 持久化后在源卡右侧
   * 建「局部选区」结果卡并连线; 局部图携带 cropContext, 供后续多轮改图继承与最终融合。
   */
  handleExtractSelection(
    cardId: string,
    sel: { x: number; y: number; w: number; h: number; sourceWidth: number; sourceHeight: number },
  ): Promise<void>
}

/** 裁剪 / 画笔标注 / 宫格切分 / 局部选区提取，全部是纯前端 Canvas 处理 + 上传落卡 */
export function useImageEdits(options: UseImageEditsOptions): ImageEditsApi {
  const { cardsRef, setCards, setConnections, updateCard, flushAfterMediaSaved, signalLoginRequired } = options
  const [editDialogId, setEditDialogId] = useState<string | null>(null)
  const [editDialogMode, setEditDialogMode] = useState<ImageEditMode | null>(null)

  function openImageEditor(cardId: string, mode: ImageEditMode) {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card?.url || card.kind === 'video') return
    setEditDialogId(cardId)
    setEditDialogMode(mode)
  }

  function closeImageEditor() {
    setEditDialogId(null)
    setEditDialogMode(null)
  }

  function editLoginErr(err: unknown): boolean {
    const status = (err as { status?: number })?.status
    if (status === 412 || status === 401 || status === 403) {
      signalLoginRequired()
      return true
    }
    return false
  }

  /** 裁剪 / 画笔: 标注烘焙进原图导出 PNG, 上传后替换当前卡片 url */
  async function applyImageReplace(cardId: string, blob: Blob, okText: string) {
    const file = new File([blob], `edit-${Date.now().toString(36)}.png`, { type: 'image/png' })
    try {
      const url = await persistMedia(file, 'image')
      if (!url) throw new Error('bad upload')
      updateCard(cardId, { url, jobStatus: undefined })
      closeImageEditor()
      toast.success(okText)
    } catch (err) {
      if (!editLoginErr(err)) toast.error('保存失败, 请重试')
    }
  }

  /**
   * 宫格切分: 逐格导出 PNG 批量上传; 原图卡片保留, 每张切分图作为新结果卡
   * 追加到源卡右侧网格排布, 并从源卡连线。
   */
  async function applyGridSplit(cardId: string, parts: ImageEditGridPart[]) {
    const source = cardsRef.current.find(c => c.id === cardId)
    if (!source) return
    const gridGroupId = uid()
    const uploaded: Array<{ part: ImageEditGridPart; url: string }> = []
    let failed = 0
    for (const part of parts) {
      const file = new File([part.blob], `grid_${part.name}.png`, { type: 'image/png' })
      try {
        const url = await persistMedia(file, 'image')
        if (url) uploaded.push({ part, url })
        else failed += 1
      } catch (err) {
        if (editLoginErr(err)) return
        failed += 1
      }
    }
    if (!uploaded.length) {
      toast.error('切分失败, 请重试')
      return
    }
    const newCards: CanvasCardData[] = uploaded.map(({ part, url }) => {
      const cardW = Math.min(240, Math.max(140, Math.round(part.naturalW)))
      const cardH = Math.round(cardW * (part.naturalH / Math.max(1, part.naturalW))) + 34
      return {
        id: uid(),
        kind: 'result' as CanvasCardData['kind'],
        x: source.x + source.w + 56 + part.col * (cardW + 28),
        y: source.y + part.row * (cardH + 28),
        w: cardW,
        h: cardH,
        url,
        sourceCardId: source.id,
        model: source.model,
        gridMeta: { groupId: gridGroupId, row: part.row, col: part.col, rows: part.rows, cols: part.cols },
      }
    })
    setCards(prev => [...prev, ...newCards])
    setConnections(prev => [...prev, ...newCards.map(nc => ({ id: uid(), fromId: source.id, toId: nc.id }))])
    closeImageEditor()
    if (newCards[0]) flushAfterMediaSaved(newCards[0].id)
    if (failed > 0) toast.success(`已切分 ${uploaded.length} 张到画布, ${failed} 张上传失败`)
    else toast.success(`已切分 ${uploaded.length} 张到画布`)
  }

  async function applyImageEdit(cardId: string, result: ImageEditResult) {
    if (result.kind === 'grid' && result.parts) await applyGridSplit(cardId, result.parts)
    else if (result.kind === 'crop' && result.blob) await applyImageReplace(cardId, result.blob, '裁剪已应用')
    else if (result.blob) await applyImageReplace(cardId, result.blob, '标注已应用')
  }

  async function handleExtractSelection(
    cardId: string,
    sel: { x: number; y: number; w: number; h: number; sourceWidth: number; sourceHeight: number },
  ) {
    const source = cardsRef.current.find(c => c.id === cardId)
    if (!source?.url || source.kind === 'video') {
      toast.error('请先选择一张图片')
      return
    }
    const sourceUrl = source.url
    try {
      const { img, naturalWidth, naturalHeight } = await loadImageNatural(sourceUrl)
      if (sel.sourceWidth !== naturalWidth || sel.sourceHeight !== naturalHeight) {
        throw new Error('原图尺寸已变化，请重新框选')
      }
      const rect = {
        x: Math.max(0, Math.round(sel.x)),
        y: Math.max(0, Math.round(sel.y)),
        w: Math.round(sel.w),
        h: Math.round(sel.h),
      }
      if (rect.w < 32 || rect.h < 32) throw new Error('选区宽高均不得小于 32 像素')
      const paddedRect = computePaddedRect(rect, naturalWidth, naturalHeight, 0.1)
      const { canvas } = extractPatchCanvas(img, rect, 0.1)
      const [blob, fingerprint] = await Promise.all([
        new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png')),
        sha256Hex(sourceUrl),
      ])
      if (!blob) throw new Error('局部图导出失败')
      const file = new File([blob], `patch-${Date.now().toString(36)}.png`, { type: 'image/png' })
      const url = await persistMedia(file, 'image')
      if (!url) throw new Error('局部图保存失败')
      const context: CropContext = {
        version: 2,
        contextId: uid(),
        source: { url: sourceUrl, width: naturalWidth, height: naturalHeight, fingerprint },
        rect,
        paddedRect,
        paddingRatio: 0.1,
      }
      const cardW = 240
      const cardH = Math.round(cardW * (paddedRect.h / Math.max(1, paddedRect.w))) + 60
      const patchCard: CanvasCardData = {
        id: uid(),
        kind: 'result',
        x: source.x + source.w + 56,
        y: source.y,
        w: cardW,
        h: Math.max(cardH, 180),
        url,
        title: '局部选区',
        cropContext: context,
        sourceCardId: source.id,
        jobStatus: 'success',
      }
      setCards(prev => [...prev, patchCard])
      setConnections(prev => [...prev, { id: uid(), fromId: source.id, toId: patchCard.id }])
      flushAfterMediaSaved(patchCard.id)
      closeImageEditor()
      toast.success('已提取局部选区, 可在局部图上改图后连接到融合节点')
    } catch (err) {
      if (editLoginErr(err)) return
      toast.error(err instanceof Error ? err.message : '提取选区失败, 请重试')
    }
  }

  return {
    editDialogId,
    editDialogMode,
    openImageEditor,
    closeImageEditor,
    applyImageEdit,
    handleExtractSelection,
  }
}
