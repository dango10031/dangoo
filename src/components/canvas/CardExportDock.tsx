import { useRef, useState, type ReactNode } from 'react'
import {
  Brush,
  Camera,
  Clapperboard,
  Crop,
  FileImage,
  LayoutGrid,
  Loader2,
  PenTool,
  Scissors,
  Trash2,
} from 'lucide-react'
import { useCanvasVm } from '@/components/canvas/canvasRuntime'
import { TagMenuButton } from '@/components/canvas/tags/TagMenuButton'
import type { CanvasCardData } from '@/pages/Canvas/useCanvas'

type BusyKind = '' | 'jianying' | 'photoshop' | 'illustrator'

/**
 * 媒体卡(生成节点结果 / 结果图卡 / 视频卡)的卡片操作坞, 悬浮在卡片上方居中:
 * 图片编辑组(裁剪 / 画笔标注 / 宫格切分 / 提取选区 / 标签) + 分隔线 +
 * 导出组(视频有帧捕捉; 导入剪映, 图片另有 Photoshop / Illustrator)。
 * 仅在卡片被选中或鼠标悬停时出现; 所有交互阻止冒泡, 避免误拖卡片。
 * 忙态在组件内本地维护一份: vm 走稳定 ref, 全局 busy 变化不一定触发重渲染。
 */
export function CardExportDock({ card }: { card: CanvasCardData }) {
  const cardId = card.id
  const isVideo = card.kind === 'video' || !!card.results?.some(r => r.isVideo)
  // 局部选区(裁剪/提取产物)不做外部软件导出, 只给编辑与删除
  const isPatch = card.kind === 'result' && !!card.cropContext
  const canDelete = card.kind === 'result'
  const p = useCanvasVm()
  const [localBusy, setLocalBusy] = useState<BusyKind>('')
  const busyRef = useRef<BusyKind>('')
  // vm 全局忙态(其它入口触发)与本地忙态取并集
  const jyBusy = localBusy === 'jianying' || !!p.jianyingImporting
  const photoshopBusy = localBusy === 'photoshop'
  const illustratorBusy = localBusy === 'illustrator'
  const adobeBusy = photoshopBusy || illustratorBusy || !!p.adobeImporting

  /** 点导入后本地立刻置忙(转圈+禁用), 无论成功失败 30s 兜底复位; 用 ref 同步防连点 */
  const runBusy = async (kind: BusyKind, fn: () => Promise<unknown>) => {
    if (busyRef.current || p.jianyingImporting || p.adobeImporting) return
    busyRef.current = kind
    setLocalBusy(kind)
    const timer = window.setTimeout(() => {
      busyRef.current = ''
      setLocalBusy('')
    }, 30000)
    try {
      await fn()
    } finally {
      window.clearTimeout(timer)
      busyRef.current = ''
      setLocalBusy('')
    }
  }

  const dockBtn = (title: string, onClick: () => void, icon: ReactNode, disabled = false, danger = false) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={e => {
        e.stopPropagation()
        onClick()
      }}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-40 ${
        danger ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive' : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'
      }`}
    >
      {icon}
    </button>
  )

  return (
    <div
      className="absolute bottom-[calc(100%+4px)] left-1/2 z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-border/70 bg-card/95 px-1 py-1 shadow-lg backdrop-blur"
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      {!isVideo && (
        <>
          {dockBtn('裁剪', () => p.openImageEditor(cardId, 'crop'), <Crop className="h-4 w-4" />)}
          {dockBtn('画笔标注', () => p.openImageEditor(cardId, 'draw'), <Brush className="h-4 w-4" />)}
          {dockBtn('宫格切分', () => p.openImageEditor(cardId, 'grid'), <LayoutGrid className="h-4 w-4" />)}
          {dockBtn('提取选区（裁出一块局部图，用于局部重绘融合）', () => p.openImageEditor(cardId, 'extract'), <Scissors className="h-4 w-4" />)}
          <TagMenuButton cardId={cardId} variant="dock" />
          {canDelete && dockBtn('删除卡片', () => p.handleDeleteCards([cardId]), <Trash2 className="h-4 w-4" />, false, true)}
        </>
      )}
      {isVideo && <TagMenuButton cardId={cardId} variant="dock" />}
      <span className="mx-0.5 h-4 w-px bg-border" />
      {isVideo &&
        dockBtn(
          '帧捕捉: 截取视频画面添加到画布',
          () => p.openFrameCapture(cardId),
          <Camera className="h-4 w-4" />,
        )}
      {dockBtn(
        '导入剪映(经本地助手)',
        // eslint-disable-next-line react-hooks/refs -- onClick 只会在事件期调用
        () => void runBusy('jianying', () => p.handleImportSelectionToJianying([cardId])),
        jyBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />,
        jyBusy,
      )}
      {!isVideo && !isPatch && (
        <>
          {dockBtn(
            '导入 Photoshop(经本地助手)',
            // eslint-disable-next-line react-hooks/refs -- onClick 只会在事件期调用
            () => void runBusy('photoshop', () => p.handleImportSelectionToAdobe([cardId], 'photoshop')),
            photoshopBusy || p.adobeImporting === 'photoshop' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileImage className="h-4 w-4" />
            ),
            adobeBusy,
          )}
          {dockBtn(
            '导入 Illustrator(经本地助手)',
            // eslint-disable-next-line react-hooks/refs -- onClick 只会在事件期调用
            () => void runBusy('illustrator', () => p.handleImportSelectionToAdobe([cardId], 'illustrator')),
            illustratorBusy || p.adobeImporting === 'illustrator' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PenTool className="h-4 w-4" />
            ),
            adobeBusy,
          )}
        </>
      )}
    </div>
  )
}
