import { useEffect } from 'react'
import { Image as ImageIcon, Loader2, Repeat, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { MiniSelect, shortModelLabel, ratioLabel, withAdaptiveRatio } from '@/components/canvas/NodeBarShared'
import type { CanvasCardData } from '@/pages/Canvas/useCanvas'
import type { useCanvas } from '@/pages/Canvas/useCanvas'

type CanvasVm = ReturnType<typeof useCanvas>

/** Loop 节点: 读取上游 Agent 任务批量执行, 自身不调 LLM */
export function LoopNodeBody({ p, card }: { p: CanvasVm; card: CanvasCardData }) {
  const st = card.loopState
  const isVideo = st?.media === 'video'
  const refs = st ? p.loopSharedRefs(card.id) : []
  // 渠道按家族媒体类型归类; 用户显式选的渠道(家族 key)即视为匹配, 否则运行时按素材自动匹配
  const famMedia = st ? p.channelFamilyMedia(st.model) : null
  const kindMatch = famMedia ? famMedia === (isVideo ? 'video' : 'image') : false
  const runModel = st ? p.resolveRunModel(st.model, refs.length > 0) : ''
  useEffect(() => {
    if (!runModel) return
    p.requestModelInfo(runModel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runModel])
  if (!st) return null
  const info = p.getNodeModelInfo(runModel)
  const scalarOpts = (name: string) => info?.scalar_params?.find(sp => sp.name === name)?.enum ?? []
  const resOpts = scalarOpts('resolution')
  const arOpts = withAdaptiveRatio(scalarOpts('aspectRatio'))
  const ratioOpts = scalarOpts('ratio')
  const durOpts = info?.scalar_params?.find(sp => sp.name === 'duration')?.enum ?? []
  const durLabel = (v: string) => (v === '-1' ? '自动时长' : `${v} 秒`)
  const modelOptions = p.modelOptions.filter(o => o.media === (isVideo ? 'video' : 'image'))
  const tasks = p.loopTasks(card.id)
  // 本 Loop 批次在途(同步重入锁, 点击当帧即禁用): 防止双击重复建卡重复扣费
  const loopBusy = p.isRunInflight(`loop:${card.id}`)
  const up = (patch: Parameters<CanvasVm['handleUpdateLoopState']>[1]) => p.handleUpdateLoopState(card.id, patch)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3" onDoubleClick={e => e.stopPropagation()}>
      <div className="flex shrink-0 items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-card-foreground">
          <Repeat className="h-4 w-4 text-primary" />
          运行参数
        </span>
        <span className="text-xs text-muted-foreground">修改后自动保存</span>
      </div>

      <div className="shrink-0" onPointerDown={e => e.stopPropagation()}>
        <p className="mb-1 text-xs text-muted-foreground">生成类型</p>
        <div className="flex items-center gap-0.5 rounded-lg bg-muted/70 p-0.5">
          <button
            type="button"
            className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${!isVideo ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => up({ media: 'image' })}
          >
            <ImageIcon className="h-3 w-3" />
            图片
          </button>
          <button
            type="button"
            className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${isVideo ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            onClick={() => up({ media: 'video' })}
          >
            <Video className="h-3 w-3" />
            视频
          </button>
        </div>
      </div>

      <div className="shrink-0" onPointerDown={e => e.stopPropagation()}>
        <p className="mb-1 text-xs text-muted-foreground">模型 / 工作流</p>
        <Select value={kindMatch ? st.model : ''} onValueChange={v => up({ model: v })}>
          <SelectTrigger className="h-8 w-full border-border/60 bg-background/40 text-xs">
            <span className="truncate">{kindMatch ? shortModelLabel(st.model) : '运行按素材自动匹配'}</span>
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {modelOptions.map(o => (
              <SelectItem key={o.slug} value={o.slug}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-2" onPointerDown={e => e.stopPropagation()}>
        {isVideo && ratioOpts.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">画面比例</p>
            <MiniSelect value={st.videoRatio ?? 'adaptive'} options={ratioOpts} onChange={v => up({ videoRatio: v })} width="w-full" />
          </div>
        )}
        {!isVideo && arOpts.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">画面比例</p>
            <MiniSelect value={st.aspectRatio ?? '16:9'} options={arOpts} onChange={v => up({ aspectRatio: v })} format={ratioLabel} width="w-full" />
          </div>
        )}
        {resOpts.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">分辨率</p>
            <MiniSelect value={st.resolution ?? '1k'} options={resOpts} onChange={v => up({ resolution: v })} width="w-full" />
          </div>
        )}
        {isVideo && durOpts.length > 0 && (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">视频时长</p>
            <MiniSelect value={st.videoDuration ?? '5'} options={durOpts} onChange={v => up({ videoDuration: v })} format={durLabel} width="w-full" />
          </div>
        )}
      </div>

      <div className="shrink-0 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
        上游 Agent 已拆出 <span className="font-semibold text-primary">{tasks.length}</span> 个任务
        {refs.length > 0 && <> · 共享参考图 <span className="font-semibold text-primary">{refs.length}</span> 张</>}
        <br />
        一行 / 一条文本 = 一次独立生成, 勾选跳过的行自动忽略; 单次上限 20 条, 单批最多 9 并发
      </div>

      <Button
        className="w-full shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
        disabled={loopBusy}
        onClick={() => void p.handleRunLoop(card.id)}
      >
        {loopBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Repeat className="h-4 w-4" />}
        <span className="ml-1">{loopBusy ? '任务进行中' : '一键运行'}</span>
      </Button>
    </div>
  )
}
