import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Sparkles, SquareStack, Upload, Wand2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { LodThumb, MiniSelect, ratioLabel, withAdaptiveRatio } from '@/components/canvas/NodeBarShared'
import { ANALYZE_LLM_OPTIONS, REP_ROUTE_OPTIONS, resolveRunModel } from '@/pages/Canvas/canvasModels'
import { FOLD_TYPE_LABELS, TRI_FOLD_LABELS } from '@/pages/Canvas/canvasTypes'
import type { CanvasCardData, FoldType, RepSlot, TriFoldMode } from '@/pages/Canvas/canvasTypes'
import { repPanelLabel } from '@/pages/Canvas/repPrompt'
import type { useCanvas } from '@/pages/Canvas/useCanvas'

type CanvasVm = ReturnType<typeof useCanvas>

/**
 * 复刻节点的一个图片投放槽: 点击本地上传; 可作为画布连线的落点(data-rep-slot);
 * 槽内图片可拖到其他槽完成换位; 连线进来的图片可点 × 断开。
 */
function SlotBox({
  p,
  cardId,
  slot,
  label,
  url,
  connected,
  highlight,
  onFile,
}: {
  p: CanvasVm
  cardId: string
  slot: RepSlot
  label: string
  url: string | null
  connected: boolean
  highlight: boolean
  onFile: (f: File | null) => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const active = dragOver || highlight
  return (
    <div
      data-rep-slot={slot}
      draggable={!!url}
      onDragStart={e => {
        e.stopPropagation()
        e.dataTransfer.setData('text/rep-slot', slot)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={e => {
        // 只接收槽位换位拖放, 避免与画布拖卡冲突
        if (!e.dataTransfer.types.includes('text/rep-slot')) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        setDragOver(true)
      }}
      onDragLeave={e => {
        e.stopPropagation()
        setDragOver(false)
      }}
      onDrop={e => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
        const from = e.dataTransfer.getData('text/rep-slot') as RepSlot | ''
        if (from && from !== slot) p.handleRepReorderSlots(cardId, from, slot)
      }}
      className={`relative flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-1.5 text-center transition-colors ${
        active ? 'border-primary bg-primary/10' : 'border-border bg-muted/30'
      } ${url ? 'cursor-grab active:cursor-grabbing' : ''}`}
      title={url ? '可拖到其他图片格换位, 也可从画布连线到这里' : '点击上传, 或从画布拖线到这里'}
    >
      <label className="flex cursor-pointer flex-col items-center justify-center gap-1">
        {url ? (
          <LodThumb url={url} alt={label} className="h-10 rounded object-contain" />
        ) : (
          <Upload className={`h-3.5 w-3.5 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
        )}
        <span className="text-xs text-muted-foreground">{label}</span>
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={e => {
            onFile(e.target.files?.[0] ?? null)
            e.target.value = ''
          }}
        />
      </label>
      {connected && (
        <button
          type="button"
          title="断开这一格的连线"
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:border-destructive hover:text-destructive"
          onPointerDown={e => e.stopPropagation()}
          onClick={e => {
            e.preventDefault()
            e.stopPropagation()
            p.handleRepDisconnectSlot(cardId, slot)
          }}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  )
}

/** 单个折面: 身份标签 + 文案输入框 + 对应的润色按钮(固定豆包 Seed 2.0 Lite) */
function PanelField({
  p,
  cardId,
  side,
  idx,
  label,
  value,
  panels,
}: {
  p: CanvasVm
  cardId: string
  side: 'front' | 'back'
  idx: number
  label: string
  value: string
  panels: string[]
}) {
  const polishKey = `${cardId}:${side}-panel-${idx}`
  const polishing = p.polishingField === polishKey
  return (
    <div className="flex h-full flex-col gap-1">
      <span className="flex min-h-8 items-center text-xs font-semibold leading-tight text-card-foreground">{label}</span>
      <Textarea
        value={value}
        rows={3}
        placeholder={`输入${label}内容…`}
        onChange={e => p.handleRepPanelsChange(cardId, side, panels.map((v, i) => (i === idx ? e.target.value : v)))}
        className="resize-none py-1.5 text-xs leading-relaxed"
      />
      <Button
        size="sm"
        variant="outline"
        className="mt-auto h-7 w-full text-xs text-foreground"
        disabled={polishing}
        onClick={() => p.handlePolishRepPanel(cardId, side, idx)}
      >
        {polishing ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Wand2 className="mr-1 h-3 w-3" />}
        润色
      </Button>
    </div>
  )
}

export function ReplicateNodeBody({
  p,
  card,
  externalHoverSlot,
}: {
  p: CanvasVm
  card: CanvasCardData
  /** 拉线快速路径下由舞台精确下发的悬停槽(此时卡片 memo 不会因拉线状态变化而重渲染) */
  externalHoverSlot?: { cardId: string; slot: RepSlot } | null
}) {
  const rs = card.repState
  const analyzing = rs?.stage === 'analyzing'
  const generating = rs?.stage === 'generating'
  const imageChannels = p.modelOptions.filter(o => o.media === 'image')
  const eff = p.effectiveRepUrls(card.id)
  const effSlots = p.effectiveRepSlots(card.id)
  const foldType = rs?.foldType ?? 'tri'
  const triFold = rs?.triFold ?? 'wrap'
  const hasPrompts = !!(rs?.frontPrompt || rs?.backPrompt)
  // 每个槽是否有专门连入的上游线(有则显示断开按钮)
  const connectedSlots = new Set(
    p.connections.filter(c => c.toId === card.id && c.toSlot).map(c => c.toSlot as RepSlot),
  )
  // 拉线跟手走 DOM 快速路径、卡片不再随每帧状态重渲染, 高亮槽由舞台作为 prop 精确下发;
  // externalHoverSlot 缺省时(其它挂载路径)仍兼容读 VM 草稿状态。
  const hover = externalHoverSlot !== undefined ? externalHoverSlot : p.connectionDraft?.hoverSlot
  const slotLabel = (slot: RepSlot): string => {
    if (slot === 'front') return rs?.frontUrl ? '正面' : effSlots.front ? '正面·上游' : '正面'
    if (slot === 'back') return rs?.backUrl ? '背面' : effSlots.back ? (effSlots.back === effSlots.front ? '背面·同正面' : '背面·上游') : '背面'
    if (slot === 'logo') return 'Logo'
    return '二维码'
  }
  const slotDefs: { slot: RepSlot; url: string | null }[] = [
    { slot: 'front', url: effSlots.front },
    { slot: 'back', url: effSlots.back },
    { slot: 'logo', url: effSlots.logo },
    { slot: 'qr', url: effSlots.qr },
  ]

  // 生图参数(分辨率/比例)按实际提交的图生渠道契约取可选项
  const runModel = rs ? resolveRunModel(rs.genModel, true) : ''
  const modelInfo = rs ? p.getNodeModelInfo(runModel) : null
  useEffect(() => {
    if (!runModel) return
    p.requestModelInfo(runModel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runModel])
  if (!rs) return null
  const scalarOpts = (name: string) => modelInfo?.scalar_params?.find(sp => sp.name === name)?.enum ?? []
  const resOpts = scalarOpts('resolution')
  const arOpts = withAdaptiveRatio(scalarOpts('aspectRatio'))

  return (
    <div
      className="space-y-2 p-2"
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
    >
      <div className="grid grid-cols-4 gap-1.5">
        {slotDefs.map(def => (
          <SlotBox
            key={def.slot}
            p={p}
            cardId={card.id}
            slot={def.slot}
            label={slotLabel(def.slot)}
            url={def.url}
            connected={connectedSlots.has(def.slot)}
            highlight={!!hover && hover.cardId === card.id && hover.slot === def.slot}
            onFile={f => void p.handleRepUpload(card.id, def.slot, f)}
          />
        ))}
      </div>

      <div className="flex gap-1.5">
        <Select value={foldType} onValueChange={v => p.handleRepSetFoldType(card.id, v as FoldType)}>
          <SelectTrigger className="h-8 flex-1 text-xs">
            <SelectValue placeholder="折页类型" />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FOLD_TYPE_LABELS) as FoldType[]).map(t => (
              <SelectItem key={t} value={t}>
                {FOLD_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {foldType === 'tri' && (
          <Select value={triFold} onValueChange={v => p.updateCard(card.id, { repState: { ...rs, triFold: v as TriFoldMode } })}>
            <SelectTrigger className="h-8 flex-1 text-xs">
              <SelectValue placeholder="折法" />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(TRI_FOLD_LABELS) as TriFoldMode[]).map(m => (
                <SelectItem key={m} value={m}>
                  {TRI_FOLD_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="space-y-1.5 rounded-lg border border-border p-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-card-foreground">折面内容</h4>
          <span className="text-[11px] text-muted-foreground">数字、名称与联系方式会作为锁定文案</span>
        </div>
        {/* 按折面行(正面N↔反面N)分组, 两列拉伸等高, 保证标题/输入框/润色钮横向对齐 */}
        <div className="space-y-2">
          {rs.frontPanels.map((frontText, idx) => {
            const backPanels = rs.backPanels
            const backText = backPanels[idx] ?? ''
            const frontPanels = rs.frontPanels
            return (
              <div key={idx} className="grid grid-cols-2 items-stretch gap-1.5">
                <PanelField
                  p={p}
                  cardId={card.id}
                  side="front"
                  idx={idx}
                  label={repPanelLabel(foldType, triFold, 'front', idx)}
                  value={frontText}
                  panels={frontPanels}
                />
                <PanelField
                  p={p}
                  cardId={card.id}
                  side="back"
                  idx={idx}
                  label={repPanelLabel(foldType, triFold, 'back', idx)}
                  value={backText}
                  panels={backPanels}
                />
              </div>
            )
          })}
        </div>
      </div>

      <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold text-card-foreground">分析结果</h4>
          <span className="text-[11px] text-muted-foreground">连接 Loop 后作为两条并发任务</span>
        </div>

        {analyzing ? (
          <div className="flex min-h-[110px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">正在分析参考图并编译提示词…</span>
          </div>
        ) : hasPrompts ? (
          <div className="space-y-1.5">
            {(['front', 'back'] as const).map(side => (
              <div key={side} className="space-y-1">
                <span className="block text-xs font-semibold text-card-foreground">
                  {side === 'front' ? '正面生图提示词' : '反面生图提示词'}
                </span>
                <Textarea
                  value={side === 'front' ? rs.frontPrompt : rs.backPrompt}
                  rows={7}
                  placeholder={side === 'front' ? '这一侧未生成, 可重新分析或手动填写' : '这一侧未生成, 可重新分析或手动填写'}
                  onChange={e => p.handleRepSetPrompt(card.id, side, e.target.value)}
                  className="resize-y py-1.5 text-xs leading-relaxed"
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex min-h-[110px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card">
            <SquareStack className="h-5 w-5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">分析后在这里生成正面与反面提示词</span>
          </div>
        )}

        <div className="grid grid-cols-[1fr_1.2fr_auto] items-center gap-1.5">
          <Select value={rs.route || 'route1'} onValueChange={v => p.updateCard(card.id, { repState: { ...rs, route: v } })}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="线路" />
            </SelectTrigger>
            <SelectContent>
              {REP_ROUTE_OPTIONS.map(o => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={rs.analyzeModel || 'qwen3.8-max'} onValueChange={v => p.updateCard(card.id, { repState: { ...rs, analyzeModel: v } })}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="分析模型" />
            </SelectTrigger>
            <SelectContent>
              {ANALYZE_LLM_OPTIONS.map(o => (
                <SelectItem key={o.slug} value={o.slug}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-8 bg-primary px-3 text-xs text-primary-foreground hover:bg-primary/90"
            disabled={analyzing || generating || !eff.front || !eff.back}
            onClick={() => p.handleAnalyzeReplicate(card.id)}
          >
            {analyzing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
            {analyzing ? '分析中…' : '开始分析'}
          </Button>
        </div>
      </div>

      <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-2">
        <Select value={rs.genModel} onValueChange={v => p.updateCard(card.id, { repState: { ...rs, genModel: v } })}>
          <SelectTrigger className="h-8 w-full text-xs">
            <SelectValue placeholder="生图渠道" />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            {imageChannels.map(o => (
              <SelectItem key={o.slug} value={o.slug}>
                {o.label} · {o.priceText}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {(resOpts.length > 0 || arOpts.length > 0) && (
          <div className="flex items-center gap-1.5">
            {arOpts.length > 0 && (
              <MiniSelect
                value={rs.aspectRatio ?? 'adaptive'}
                options={arOpts}
                onChange={v => p.updateCard(card.id, { repState: { ...rs, aspectRatio: v } })}
                format={ratioLabel}
                width="flex-1"
              />
            )}
            {resOpts.length > 0 && (
              <MiniSelect
                value={rs.resolution ?? resOpts[0]}
                options={resOpts}
                onChange={v => p.updateCard(card.id, { repState: { ...rs, resolution: v } })}
                width="flex-1"
              />
            )}
          </div>
        )}

        <Button
          size="sm"
          className="h-7 w-full bg-primary text-xs text-primary-foreground hover:bg-primary/90"
          disabled={generating || analyzing}
          onClick={() => p.handleRunReplicate(card.id)}
        >
          {generating ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
          {generating ? '正反面生成中…' : '确认生成(正反面 2 张并发)'}
        </Button>
        {(rs.frontResultUrl || rs.backResultUrl) && (
          <div className="flex items-center gap-1.5">
            {rs.frontResultUrl && <LodThumb url={rs.frontResultUrl} alt="正面结果" className="h-12 w-12 rounded border border-border object-cover" />}
            {rs.backResultUrl && <LodThumb url={rs.backResultUrl} alt="背面结果" className="h-12 w-12 rounded border border-border object-cover" />}
            <span className="flex items-center gap-1 text-xs text-primary">
              <RefreshCw className="h-3 w-3" />
              已自动进画布和素材库
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
