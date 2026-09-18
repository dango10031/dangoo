import { useEffect, useRef, useState } from 'react'
import { BookOpen, Bot, Check, ChevronDown, ChevronUp, Loader2, Play, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { LodThumb } from '@/components/canvas/NodeBarShared'
import { AGENT_PROMPT_TEMPLATES, POLISH_LLM_OPTIONS } from '@/pages/Canvas/useCanvas'
import type { CanvasCardData } from '@/pages/Canvas/useCanvas'
import type { useCanvas } from '@/pages/Canvas/useCanvas'

type CanvasVm = ReturnType<typeof useCanvas>

function newId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`
}

/** Agent 节点: 元提示词 + 用户需求 + 输出(文本/表格) + 模型与运行 */
export function AgentNodeBody({ p, card }: { p: CanvasVm; card: CanvasCardData }) {
  const st = card.agentState
  const [metaOpen, setMetaOpen] = useState(true)
  const [tplOpen, setTplOpen] = useState(false)
  const tplRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!tplOpen) return
    const close = (e: PointerEvent) => {
      if (!tplRef.current?.contains(e.target as Node)) setTplOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [tplOpen])

  if (!st) return null
  // busy 含同步重入锁: 点击当帧(状态还没写成 running)第二下也点不动
  const busy = st.jobStatus === 'running' || p.isRunInflight(`agent:${card.id}`)
  const up = (patch: Parameters<CanvasVm['handleUpdateAgentState']>[1]) => p.handleUpdateAgentState(card.id, patch)

  const setCell = (rowId: string, colId: string, value: string) =>
    up({ tableRows: st.tableRows.map(r => (r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: value } } : r)) })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3" onDoubleClick={e => e.stopPropagation()}>
      {/* 元提示词 */}
      <div className="shrink-0">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold text-card-foreground">元提示词</span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setMetaOpen(o => !o)}
            >
              {metaOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {metaOpen ? '收起' : '展开'}
            </button>
            <span className="relative" ref={tplRef}>
              <button
                type="button"
                className="flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setTplOpen(o => !o)}
              >
                <BookOpen className="h-3 w-3" />
                常用提示词库
              </button>
              {tplOpen && (
                <span className="absolute right-0 top-6 z-40 block w-44 overflow-hidden rounded-lg border border-border bg-card shadow-xl">
                  {AGENT_PROMPT_TEMPLATES.map(t => (
                    <button
                      key={t.label}
                      type="button"
                      className="block w-full px-2.5 py-1.5 text-left text-xs text-card-foreground transition-colors hover:bg-muted"
                      onClick={() => {
                        up({ systemPrompt: t.text })
                        setMetaOpen(true)
                        setTplOpen(false)
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </span>
              )}
            </span>
          </span>
        </div>
        {metaOpen && (
          <textarea
            value={st.systemPrompt}
            onChange={e => up({ systemPrompt: e.target.value })}
            placeholder="输入元提示词…（设定身份、风格等）"
            onPointerDown={e => e.stopPropagation()}
            className="min-h-16 w-full resize-none rounded-lg border border-border bg-background/60 p-2 text-xs leading-relaxed text-card-foreground outline-none placeholder:text-muted-foreground/70 focus:ring-1 focus:ring-primary"
          />
        )}
      </div>

      {/* 用户需求 */}
      <div className="shrink-0">
        <p className="mb-1.5 text-xs font-semibold text-card-foreground">用户需求</p>
        <textarea
          value={card.prompt ?? ''}
          onChange={e => p.updateCard(card.id, { prompt: e.target.value })}
          placeholder="输入用户需求或连接上游文字 / Agent 节点，图片和视频作为参考素材…"
          onPointerDown={e => e.stopPropagation()}
          className="min-h-20 w-full resize-none rounded-lg border border-border bg-background/60 p-2 text-xs leading-relaxed text-card-foreground outline-none placeholder:text-muted-foreground/70 focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* 上游图片输入: 连线上来的图片, 最多 12 张参与理解 */}
      {p.upstreamImageUrls(card.id).length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {p.upstreamImageUrls(card.id).slice(0, 12).map(u => (
            <LodThumb key={u} url={u} alt="上游图片" className="h-8 w-8 rounded-md border border-border object-cover" />
          ))}
        </div>
      )}
      <p className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Bot className="h-3 w-3 text-primary" />
        上游图片最多取 12 张参与理解
      </p>

      {/* 输出内容 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-semibold text-card-foreground">输出内容</span>
          <span className="flex items-center gap-0.5 rounded-lg bg-muted/70 p-0.5">
            {([false, true] as const).map(tm => (
              <button
                key={String(tm)}
                type="button"
                className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
                  st.tableMode === tm ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => up({ tableMode: tm })}
              >
                {tm ? '表格' : '文本'}
              </button>
            ))}
          </span>
        </div>

        {!st.tableMode ? (
          <textarea
            value={st.output}
            onChange={e => up({ output: e.target.value })}
            placeholder="输出文字内容…"
            onPointerDown={e => e.stopPropagation()}
            className="min-h-24 w-full flex-1 resize-none rounded-lg border border-border bg-background/60 p-2 text-xs leading-relaxed text-card-foreground outline-none placeholder:text-muted-foreground/70 focus:ring-1 focus:ring-primary"
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto rounded-lg border border-border bg-background/60 p-2">
            <div className="flex shrink-0 items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {st.tableRows.filter(r => r.enabled !== false).length} 条可执行，单次上限 20
              </span>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs text-card-foreground transition-colors hover:border-primary hover:text-primary"
                  onClick={() => up({ tableColumns: [...st.tableColumns, { id: newId('col'), name: '新列' }] })}
                >
                  <Plus className="h-3 w-3" />
                  列
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-xs text-card-foreground transition-colors hover:border-primary hover:text-primary"
                  onClick={() =>
                    up({ tableRows: [...st.tableRows, { id: newId('row'), cells: Object.fromEntries(st.tableColumns.map(c => [c.id, ''])) }] })
                  }
                >
                  <Plus className="h-3 w-3" />
                  行
                </button>
              </span>
            </div>
            <div className="grid gap-1.5" style={{ gridTemplateColumns: `28px repeat(${st.tableColumns.length}, minmax(140px, 1fr)) 24px` }}>
              <span className="flex h-7 items-center justify-center text-xs text-muted-foreground">启用</span>
              {st.tableColumns.map(col => {
                const isGen = st.generationColumnIds.includes(col.id)
                return (
                  <span key={col.id} className="flex items-center gap-1">
                    <input
                      value={col.name}
                      onChange={e => up({ tableColumns: st.tableColumns.map(c => (c.id === col.id ? { ...c, name: e.target.value } : c)) })}
                      onPointerDown={e => e.stopPropagation()}
                      className="h-7 min-w-0 flex-1 rounded-md border border-border/60 bg-muted/40 px-1.5 text-xs text-card-foreground outline-none focus:ring-1 focus:ring-primary"
                    />
                    <button
                      type="button"
                      title={isGen ? 'AI 生成列, 点击取消' : '设为 AI 生成列'}
                      className={`shrink-0 rounded-md px-1.5 py-1 text-xs transition-colors ${
                        isGen ? 'bg-primary text-primary-foreground' : 'border border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground'
                      }`}
                      onClick={() =>
                        up({
                          generationColumnIds: isGen
                            ? st.generationColumnIds.filter(i => i !== col.id)
                            : [...st.generationColumnIds, col.id],
                        })
                      }
                    >
                      生成
                    </button>
                    <button
                      type="button"
                      title="删除列"
                      className="shrink-0 text-muted-foreground/70 transition-colors hover:text-destructive"
                      onClick={() =>
                        up({
                          tableColumns: st.tableColumns.filter(c => c.id !== col.id),
                          generationColumnIds: st.generationColumnIds.filter(i => i !== col.id),
                        })
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )
              })}
              <span />
              {st.tableRows.map(row => (
                <span key={row.id} className="contents">
                  <span className="flex items-start justify-center pt-1.5">
                    <button
                      type="button"
                      title={row.enabled === false ? '已跳过, 点击启用' : '点击跳过此行'}
                      className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
                        row.enabled === false ? 'border-border/60 bg-transparent' : 'border-primary bg-primary'
                      }`}
                      onClick={() =>
                        up({ tableRows: st.tableRows.map(r => (r.id === row.id ? { ...r, enabled: r.enabled === false } : r)) })
                      }
                    >
                      {row.enabled !== false && <Check className="h-3 w-3 text-primary-foreground" />}
                    </button>
                  </span>
                  {st.tableColumns.map(col => (
                    <textarea
                      key={col.id}
                      value={row.cells[col.id] ?? ''}
                      onChange={e => setCell(row.id, col.id, e.target.value)}
                      onPointerDown={e => e.stopPropagation()}
                      rows={2}
                      placeholder={st.generationColumnIds.includes(col.id) ? '运行后填充' : ''}
                      className={`min-h-14 w-full resize-y rounded-md border border-border/40 bg-transparent p-1.5 text-xs leading-relaxed text-card-foreground outline-none focus:ring-1 focus:ring-primary ${row.enabled === false ? 'opacity-40' : ''}`}
                    />
                  ))}
                  <button
                    type="button"
                    title="删除行"
                    className="flex items-start justify-center pt-2 text-muted-foreground/70 transition-colors hover:text-destructive"
                    onClick={() => up({ tableRows: st.tableRows.filter(r => r.id !== row.id) })}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部: 模型 + 覆盖/续写 + 运行 */}
      <div className="flex shrink-0 items-center gap-2" onPointerDown={e => e.stopPropagation()}>
        <Select value={st.model} onValueChange={v => up({ model: v })}>
          <SelectTrigger className="h-8 min-w-0 flex-1 border-border/60 bg-background/40 text-xs">
            <span className="truncate">{POLISH_LLM_OPTIONS.find(o => o.slug === st.model)?.label ?? st.model}</span>
          </SelectTrigger>
          <SelectContent>
            {POLISH_LLM_OPTIONS.map(o => (
              <SelectItem key={o.slug} value={o.slug}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex shrink-0 items-center gap-0.5 rounded-lg bg-muted/70 p-0.5">
          {(['overwrite', 'append'] as const).map(m => (
            <button
              key={m}
              type="button"
              className={`rounded-md px-2 py-1 text-xs transition-colors ${
                st.mode === m ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => up({ mode: m })}
            >
              {m === 'overwrite' ? '覆盖' : '续写'}
            </button>
          ))}
        </span>
        <Button size="sm" disabled={busy} className="h-8 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => void p.handleRunAgentNode(card.id)}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          <span className="ml-1">{busy ? '运行中' : '运行'}</span>
        </Button>
      </div>
      {st.jobStatus === 'failed' && st.errorMsg && <p className="shrink-0 text-xs leading-relaxed text-destructive">{st.errorMsg}</p>}
      {st.jobStatus === 'success' && !st.tableMode && <p className="shrink-0 text-xs text-primary">已完成{st.mode === 'append' ? '续写' : '输出'}</p>}
    </div>
  )
}
