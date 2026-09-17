import { useEffect, useMemo, useState } from 'react'
import { Check, Droplet, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useCanvasVm } from '@/components/canvas/canvasRuntime'
import { HsvColorPicker } from './HsvColorPicker'
import { NAME_MAX, PRESET_COLORS, isValidHex, isValidTagName, normalizeHex } from './tagModel'

type TemplateKind = 'content' | 'ecommerce'

/** 深色标签管理弹窗: 左栏标签列表, 右栏名称/颜色编辑, 底部标签模板批量加入 */
export function TagManagerDialog() {
  const p = useCanvasVm()
  const open = p.tagManagerOpen
  const tags = p.tags

  // 编辑态: editingId = null 表示新建草稿; '' 表示未选中任何项
  const [editingId, setEditingId] = useState<string | null>('')
  const [draftName, setDraftName] = useState('')
  const [draftColor, setDraftColor] = useState(PRESET_COLORS[0])
  const [hexInput, setHexInput] = useState(PRESET_COLORS[0])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)

  const editingTag = useMemo(() => tags.find(t => t.id === editingId) ?? null, [tags, editingId])
  const isNew = editingId === null
  const nameValid = isValidTagName(draftName)
  const colorValid = isValidHex(draftColor)
  const canSave = nameValid && colorValid && !saving

  // 打开弹窗: 带 draft(从卡片浮层新建)→新建态; 否则选中第一个标签; 无任何标签→空白新建态
  useEffect(() => {
    if (!open) return
    queueMicrotask(() => {
      setConfirmDelete(false)
      setPickerOpen(false)
      if (p.tagManagerDraft) {
        const d = p.tagManagerDraft
        setEditingId(null)
        setDraftName(d.name ?? '')
        setDraftColor(normalizeHex(d.color) ?? PRESET_COLORS[0])
        setHexInput(normalizeHex(d.color) ?? PRESET_COLORS[0])
      } else if (tags.length > 0) {
        const first = tags[0]
        setEditingId(first.id ?? '')
        setDraftName(first.name)
        setDraftColor(first.color)
        setHexInput(first.color)
      } else {
        setEditingId(null)
        setDraftName('')
        setDraftColor(PRESET_COLORS[0])
        setHexInput(PRESET_COLORS[0])
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 左栏切换标签: 直接切换草稿(不做脏确认)
  function selectTag(id: string) {
    const t = tags.find(x => x.id === id)
    if (!t) return
    setConfirmDelete(false)
    setEditingId(id)
    setDraftName(t.name)
    setDraftColor(t.color)
    setHexInput(t.color)
  }

  function startNew() {
    setConfirmDelete(false)
    setEditingId(null)
    setDraftName('')
    setDraftColor(PRESET_COLORS[0])
    setHexInput(PRESET_COLORS[0])
  }

  function setColor(hex: string) {
    setDraftColor(hex)
    setHexInput(hex)
  }

  function onHexInput(value: string) {
    setHexInput(value)
    const n = normalizeHex(value)
    if (n) setDraftColor(n)
  }

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    try {
      if (isNew) {
        const rec = await p.createTag({ name: draftName, color: draftColor })
        if (rec) {
          // 从卡片浮层「新建标签」进入: 保存成功自动给该卡打标
          const cardId = p.tagManagerDraft?.cardId
          if (cardId && rec.slug) p.setCardTag(cardId, rec.slug)
          toast.success('标签已创建')
          if (rec.id) selectTag(rec.id)
        }
      } else if (editingTag?.id) {
        const ok = await p.updateTag(editingTag.id, { name: draftName, color: draftColor })
        if (ok) toast.success('标签已保存')
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (isNew) {
      // 新建中点删除 = 丢弃草稿, 回到列表第一项
      if (tags.length > 0) selectTag(tags[0].id ?? '')
      else startNew()
      return
    }
    if (!editingTag?.id) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      window.setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    const removedId = editingTag.id
    const ok = await p.deleteTag(removedId)
    if (ok) {
      toast.success('标签已删除')
      setConfirmDelete(false)
      const rest = p.tags.filter(t => t.id !== removedId)
      if (rest.length > 0) selectTag(rest[0].id ?? '')
      else startNew()
    }
  }

  async function handleTemplate(kind: TemplateKind) {
    const added = await p.applyTagTemplate(kind)
    if (added > 0) toast.success(`已加入 ${added} 个标签`)
    else toast('该模板的标签已全部在列表中')
  }

  const templateStatus = useMemo(() => {
    const names = new Set(tags.map(t => t.name))
    const contentMissing = ['人物', '场景', '道具', '风格参考', '分镜图', '参考图', '其他'].filter(n => !names.has(n)).length
    const ecommerceMissing = ['商品', '模特', '场景图', '卖点图', '详情素材', '品牌素材'].filter(n => !names.has(n)).length
    return { contentMissing, ecommerceMissing }
  }, [tags])

  return (
    <Dialog
      open={open}
      onOpenChange={v => {
        if (!v) p.closeTagManager()
      }}
    >
      <DialogContent className="max-h-[92vh] max-w-4xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 text-left">
          <DialogTitle>管理标签</DialogTitle>
          <p className="text-xs text-muted-foreground">用于画布节点分类标记</p>
        </DialogHeader>

        <div className="flex min-h-0 gap-0">
          {/* 左栏: 标签列表 */}
          <div className="flex w-52 shrink-0 flex-col border-r border-border p-3">
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
              {tags.map(tag => {
                const active = !isNew && tag.id === editingId
                return (
                  <button
                    key={tag.slug}
                    type="button"
                    onClick={() => tag.id && selectTag(tag.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                      active ? 'bg-muted font-medium text-card-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-card-foreground'
                    }`}
                  >
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
                    <span className="flex-1 truncate">{tag.name}</span>
                  </button>
                )
              })}
              {tags.length === 0 && <p className="px-2 py-4 text-center text-xs text-muted-foreground">还没有标签</p>}
            </div>
            <button
              type="button"
              onClick={startNew}
              className={`mt-2 flex items-center justify-center gap-1 rounded-lg border border-dashed px-2 py-2 text-xs transition-colors ${
                isNew ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:border-primary hover:text-primary'
              }`}
            >
              <Plus className="h-3.5 w-3.5" />
              添加标签
            </button>
          </div>

          {/* 右栏: 编辑区 */}
          <div className="flex min-w-0 flex-1 flex-col gap-4 p-5">
            {/* 名称 */}
            <div>
              <label className="mb-1.5 block text-xs font-medium text-card-foreground">标签名称</label>
              <div className="relative">
                <Input
                  value={draftName}
                  maxLength={NAME_MAX}
                  placeholder="输入标签名称"
                  onChange={e => setDraftName(e.target.value)}
                  className="h-9 pr-14"
                />
                <span
                  className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs ${
                    draftName.length > NAME_MAX ? 'text-destructive' : 'text-muted-foreground'
                  }`}
                >
                  {draftName.length}/{NAME_MAX}
                </span>
              </div>
            </div>

            {/* 颜色 */}
            <div className="flex gap-4">
              {/* 左: 大色块 + 预设 */}
              <div className="w-56 shrink-0 space-y-3">
                <div
                  className="flex h-24 w-full items-end rounded-xl border border-border p-2 shadow-inner"
                  style={{ backgroundColor: colorValid ? draftColor : PRESET_COLORS[0] }}
                >
                  <span className="rounded-md bg-black/25 px-1.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
                    {isNew ? '新标签' : draftName || '标签预览'}
                  </span>
                </div>
                <div>
                  <p className="mb-1.5 text-xs text-muted-foreground">预设颜色</p>
                  <div className="grid grid-cols-5 gap-2">
                    {PRESET_COLORS.map(hex => {
                      const active = normalizeHex(draftColor) === hex
                      return (
                        <button
                          key={hex}
                          type="button"
                          title={hex}
                          onClick={() => setColor(hex)}
                          className="flex h-7 w-7 items-center justify-center rounded-full transition-transform hover:scale-110"
                          style={{ backgroundColor: hex }}
                        >
                          {active && <Check className="h-3.5 w-3.5 text-white drop-shadow" />}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>

              {/* 右: HEX + 拾色器 */}
              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex items-center gap-2">
                  <Input
                    value={hexInput}
                    onChange={e => onHexInput(e.target.value)}
                    spellCheck={false}
                    className="h-9 w-32 font-mono text-xs uppercase"
                    aria-label="HEX 颜色值"
                  />
                  <Button
                    type="button"
                    variant={pickerOpen ? 'default' : 'outline'}
                    size="sm"
                    className="h-9 gap-1"
                    onClick={() => setPickerOpen(v => !v)}
                  >
                    <Droplet className="h-3.5 w-3.5" />
                    拾色器
                  </Button>
                </div>
                {pickerOpen && colorValid && <HsvColorPicker color={draftColor} onChange={setColor} />}
              </div>
            </div>

            {/* 操作行 */}
            <div className="mt-auto flex items-center justify-between pt-2">
              {!isNew && editingTag?.id ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleDelete()}
                  className={`gap-1 ${confirmDelete ? 'border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive' : 'text-destructive hover:bg-destructive/10 hover:text-destructive'}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {confirmDelete ? '确认删除？再点一次' : '删除'}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => p.closeTagManager()}>
                  取消
                </Button>
                <Button type="button" size="sm" disabled={!canSave} onClick={() => void handleSave()}>
                  保存
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* 底部: 标签模板 */}
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <span className="text-xs text-muted-foreground">标签模板</span>
          <Button
            type="button"
            variant={templateStatus.contentMissing === 0 ? 'secondary' : 'outline'}
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => void handleTemplate('content')}
          >
            {templateStatus.contentMissing === 0 && <Check className="h-3 w-3 text-primary" />}
            内容创作
          </Button>
          <Button
            type="button"
            variant={templateStatus.ecommerceMissing === 0 ? 'secondary' : 'outline'}
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => void handleTemplate('ecommerce')}
          >
            {templateStatus.ecommerceMissing === 0 && <Check className="h-3 w-3 text-primary" />}
            电商创作
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
