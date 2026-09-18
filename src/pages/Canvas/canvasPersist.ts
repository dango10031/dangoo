// 画布文档「恢复归一化」与「持久化剥离」的纯函数。
// 从 useCanvas 抽出：只对 cards 快照做确定性变换，不碰 state / 网络 / DOM。
import {
  defaultLayerState,
  defaultRepState,
  defaultTtsState,
  defaultMotionState,
  defaultVsrState,
  defaultPolishState,
  type CanvasCardData,
  type LayerStage,
  type RepStage,
  type CardKind,
  type CardJobStatus,
  type TtsNodeState,
  type MotionNodeState,
  type VsrNodeState,
} from './canvasTypes'
import {
  channelFamilyOf,
  defaultGenParams,
  defaultImageGenParams,
  LEGACY_VIDEO_SLUG_MAP,
} from './canvasModels'
import { looksLikeFileName } from './nodeParams'
import { stripDeployedPrefix } from './canvasMediaUrl'

/**
 * 老数据兼容 + 新节点中间状态恢复：运行中被刷新打断的任务标记失败可重试。
 * inFlightResultKeys 为「本次恢复仍在远端跑」的 cardId:resultIndex 集合——
 * 命中的排队/运行项保持 queued 交给续轮询，不能先标失败（否则重试=重复扣费）。
 */
export function normalizeRestoredCards(
  rawCards: CanvasCardData[],
  inFlightResultKeys?: Set<string>,
): CanvasCardData[] {
  return rawCards.map(raw => {
    // 历史数据可能把部署前缀固化进媒体 URL，统一剥成环境无关的裸路径，渲染时再按当前环境拼。
    let c: CanvasCardData = stripDeployedPrefix(raw) as CanvasCardData
    // 顶层运行态在刷新/跨环境恢复时必须收敛：上传/生成任务不跨页面续跑,
    // 残留 running/queued 会让卡片永久被当忙碌态——工具坞与缩放柄全部不显示。
    if (c.jobStatus === 'running' || c.jobStatus === 'queued') {
      const hasSuccess =
        !!c.url ||
        (Array.isArray(c.results) && c.results.some(r => r.itemStatus === 'success' && r.url))
      c = { ...c, jobStatus: hasSuccess ? ('success' as const) : undefined }
    }
    if (c.kind === 'layer' && c.layerState) {
      const ls = c.layerState
      const layers = (ls.layers ?? []).map(l => {
        if (l.genStatus === 'queued' || l.genStatus === 'running') {
          return { ...l, genStatus: 'failed' as const, errorMsg: '任务在刷新时中断了, 请点击重试' }
        }
        return { ...l, cutoutUrl: null }
      })
      const stage: LayerStage = ls.stage === 'analyzing' || ls.stage === 'generating' ? (layers.length ? 'ready' : 'idle') : ls.stage
      // 老数据生图渠道可能存的是图生 slug, 归一到家族主键(提交时再解析为图生 slug)
      const layerFamily = channelFamilyOf(ls.genModel ?? '')
      const layerGenModel = layerFamily ? layerFamily.key : 'gpt-image-2'
      return { ...c, layerState: { ...defaultLayerState(), ...ls, layers, stage, genModel: layerGenModel } }
    }
    if (c.kind === 'replicate' && c.repState) {
      const rs = c.repState
      const jobStatus = {
        front: rs.jobStatus?.front === 'running' || rs.jobStatus?.front === 'queued' ? ('failed' as const) : rs.jobStatus?.front ?? ('idle' as const),
        back: rs.jobStatus?.back === 'running' || rs.jobStatus?.back === 'queued' ? ('failed' as const) : rs.jobStatus?.back ?? ('idle' as const),
      }
      const stage: RepStage = rs.stage === 'analyzing' || rs.stage === 'generating' ? (rs.frontPrompt || rs.backPrompt ? 'ready' : 'idle') : rs.stage
      // 老数据生图渠道可能存的是图生 slug, 归一到家族主键(提交时再解析为图生 slug)
      const genFamily = channelFamilyOf(rs.genModel ?? '')
      const genModel = genFamily ? genFamily.key : 'gpt-image-2'
      return { ...c, repState: { ...defaultRepState(), ...rs, jobStatus, stage, genModel } }
    }
    if ((c.kind as string) === 'image') {
      // 老图片节点升级成统一生成节点: 原图进入节点图片位, 提示词保留(旧存文件名则清空), i2i 默认参数保留
      const rawPrompt = c.prompt ?? ''
      return {
        ...c,
        kind: 'generate' as CardKind,
        prompt: looksLikeFileName(rawPrompt) ? '' : rawPrompt,
        genParams: c.genParams ?? defaultImageGenParams(),
        w: 320,
        h: c.url ? Math.max(c.h, 560) : 180,
      }
    }
    if (c.kind === 'generate') {
      // 节点自身结果: 刷新时未完成的项标记失败可单项重试; active 项下标钳制并同步主图
      let results = c.results
      if (Array.isArray(results) && results.length) {
        results = results.map((r, ri) => {
          const inFlight = !!inFlightResultKeys?.has(`${c.id}:${ri}`)
          // 有在途任务记录的排队/运行项: 保持 queued, 交给 restorePendingJobs 认领远端任务续轮询,
          // 不能先标失败, 否则用户点重试=重复提交扣费。
          if (r.itemStatus === 'running') {
            return inFlight ? { ...r, itemStatus: 'queued' as CardJobStatus, errorMsg: undefined } : r
          }
          if (r.itemStatus === 'queued' && !inFlight) {
            return { ...r, itemStatus: 'failed' as CardJobStatus, errorMsg: '任务在刷新时中断了, 请点击重试' }
          }
          if (r.itemStatus === 'queued' && inFlight) {
            return { ...r, errorMsg: undefined }
          }
          return r
        })
      }
      const activeIdx = results && results.length ? Math.min(c.activeResultIndex ?? 0, results.length - 1) : 0
      const active = results?.[activeIdx]
      const firstOk = results?.find(r => r.itemStatus === 'success' && r.url)
      const main = active && active.itemStatus === 'success' && active.url ? active : firstOk
      return {
        ...c,
        results,
        activeResultIndex: results && results.length ? activeIdx : c.activeResultIndex,
        url: main?.url ?? c.url,
        cropContext: main ? main.cropContext ?? null : c.cropContext,
        genParams: {
          ...defaultGenParams(),
          ...c.genParams,
          // 旧 Seedance 2.0「旗舰/标准版」节点统一迁移到全能参考接口
          ...(c.genParams?.model && LEGACY_VIDEO_SLUG_MAP[c.genParams.model]
            ? { model: LEGACY_VIDEO_SLUG_MAP[c.genParams.model] }
            : {}),
          // 早期数据空节点缺省比例时补 16:9; 已显式选了「自适应」的节点必须保留——
          // 图生图场景下自适应要跟随参考图比例, 这里强写 16:9 会让选择静默失效
          ...(c.url || main?.url || c.genParams?.aspectRatio ? {} : { aspectRatio: '16:9' }),
        },
        w: 320,
        h: c.url || main?.url ? Math.max(c.h, 560) : 180,
      }
    }
    if (c.kind === 'polish') {
      return { ...c, polishState: { ...defaultPolishState(), ...c.polishState }, w: Math.max(c.w, 300), h: Math.max(c.h, 270) }
    }
    if (c.kind === 'tts') {
      // 老版本地 blob 链接刷新即失效, 一律清空; 尺寸给足最小值
      const ts: TtsNodeState = { ...defaultTtsState(), ...c.ttsState }
      if (ts.cloneAudioUrl?.startsWith('blob:')) ts.cloneAudioUrl = undefined
      if (ts.emotionRefAudioUrl?.startsWith('blob:')) ts.emotionRefAudioUrl = undefined
      if (ts.resultUrl?.startsWith('blob:')) ts.resultUrl = undefined
      return { ...c, ttsState: ts, w: Math.max(c.w, 380), h: Math.max(c.h, 560) }
    }
    if (c.kind === 'motion') {
      const ms: MotionNodeState = { ...defaultMotionState(), ...c.motionState }
      if (ms.refImageUrl?.startsWith('blob:')) { ms.refImageUrl = undefined; ms.refImageName = undefined }
      if (ms.refVideoUrl?.startsWith('blob:')) { ms.refVideoUrl = undefined; ms.refVideoName = undefined; ms.refVideoDuration = undefined }
      if (ms.resultUrl?.startsWith('blob:')) ms.resultUrl = undefined
      // 高度自适应内容, 不强制最小高度
      return { ...c, motionState: ms, w: Math.max(c.w, 380), h: c.h }
    }
    if (c.kind === 'vsr') {
      const vs: VsrNodeState = { ...defaultVsrState(), ...c.vsrState }
      if (vs.videoUrl?.startsWith('blob:')) { vs.videoUrl = undefined; vs.videoName = undefined; vs.videoDuration = undefined }
      if (vs.resultUrl?.startsWith('blob:')) vs.resultUrl = undefined
      return { ...c, vsrState: vs, w: Math.max(c.w, 380), h: c.h }
    }
    return c
  })
}

/** 一笔云端保存落定后的结果分类（决定 dirty 去向、顶栏状态与是否补发）。
 *  skipped = 卸载抢发但请求体超限、本笔未真正发出(已改由短定时器普通请求补发)。 */
export type PersistOutcome = 'ok' | 'conflict' | 'auth' | 'retry' | 'skipped'

/** 按 HTTP 状态码分类保存结果: 2xx 成功; 409 版本冲突; 401/403/404/412 登录/权限失效; 其余待退避重试 */
export function classifyPersistHttpStatus(status: number): PersistOutcome {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 409) return 'conflict'
  if (status === 401 || status === 403 || status === 404 || status === 412) return 'auth'
  return 'retry'
}

/**
 * 一笔保存落定后是否允许「立即」链式补发下一笔:
 * 仅当本笔成功且保存期间又有新改动时才立即发(原本的链式语义);
 * 冲突挂起、登录失效、恢复弹窗未决、网络/服务端临时失败一律不立即补发——
 * 分别等用户选择、重新登录、弹窗结束、退避定时器/online 事件, 避免忙等打接口。
 */
export function shouldChainNextPersist(input: {
  outcome: PersistOutcome
  stillDirty: boolean
  conflictPending: boolean
  restorePending: boolean
}): boolean {
  return (
    input.outcome === 'ok' &&
    input.stillDirty &&
    !input.conflictPending &&
    !input.restorePending
  )
}

/** 上一版已永久化的媒体（blob 在途时回退用，避免把已上传的成品剥空） */
export interface PersistedMedia {
  url: string
  results?: CanvasCardData['results']
}

/**
 * 持久化前剥离不可入库的本地状态：
 * - 分层节点的抠图临时地址 cutoutUrl 不入库；
 * - 主图为 blob（上传在途）时：有上一版永久媒体则回退旧 url/results，全新卡剥空骨架先入库；
 * - 语音克隆/动作迁移/高清修复各槽位的 blob 本地链接清空（连同对应文件名）。
 */
export function buildPersistCards(
  srcCards: CanvasCardData[],
  lastPersistedMedia: Map<string, PersistedMedia> = new Map(),
): CanvasCardData[] {
  return srcCards.map(c => {
    let next = c
    if (c.kind === 'layer' && c.layerState) {
      next = { ...c, layerState: { ...c.layerState, layers: c.layerState.layers.map(l => ({ ...l, cutoutUrl: null })) } }
    }
    if (next.url && next.url.startsWith('blob:')) {
      const prevMedia = lastPersistedMedia.get(c.id)
      if (prevMedia) {
        // 有上一版永久媒体: 保留旧的 url/results, 不被在途 blob 剥空, 位置/改名等字段取当前值
        next = {
          ...next,
          url: prevMedia.url,
          ...(prevMedia.results ? { results: prevMedia.results } : {}),
        }
      } else {
        // 全新卡首次上传在途: 剥掉不可持久化的 blob, 骨架先入库; 永久链接随上传完成后的下一次保存写入
        next = { ...next, url: '', jobStatus: next.jobStatus === 'running' ? 'queued' : next.jobStatus }
      }
    }
    // 语音克隆: 上传中的 blob 本地链接不入库
    if (next.kind === 'tts' && next.ttsState) {
      const ts = { ...next.ttsState }
      let dirty = false
      if (ts.cloneAudioUrl?.startsWith('blob:')) { ts.cloneAudioUrl = undefined; ts.cloneAudioName = undefined; dirty = true }
      if (ts.emotionRefAudioUrl?.startsWith('blob:')) { ts.emotionRefAudioUrl = undefined; ts.emotionRefAudioName = undefined; dirty = true }
      if (ts.resultUrl?.startsWith('blob:')) { ts.resultUrl = undefined; dirty = true }
      if (dirty) next = { ...next, ttsState: ts }
    }
    // 动作迁移: 上传中的 blob 本地链接不入库
    if (next.kind === 'motion' && next.motionState) {
      const ms = { ...next.motionState }
      let motionDirty = false
      if (ms.refImageUrl?.startsWith('blob:')) { ms.refImageUrl = undefined; ms.refImageName = undefined; motionDirty = true }
      if (ms.refVideoUrl?.startsWith('blob:')) { ms.refVideoUrl = undefined; ms.refVideoName = undefined; ms.refVideoDuration = undefined; motionDirty = true }
      if (ms.resultUrl?.startsWith('blob:')) { ms.resultUrl = undefined; motionDirty = true }
      if (motionDirty) next = { ...next, motionState: ms }
    }
    // 视频高清修复: 上传中的 blob 本地链接不入库
    if (next.kind === 'vsr' && next.vsrState) {
      const vs = { ...next.vsrState }
      let vsrDirty = false
      if (vs.videoUrl?.startsWith('blob:')) { vs.videoUrl = undefined; vs.videoName = undefined; vs.videoDuration = undefined; vsrDirty = true }
      if (vs.resultUrl?.startsWith('blob:')) { vs.resultUrl = undefined; vsrDirty = true }
      if (vsrDirty) next = { ...next, vsrState: vs }
    }
    return next
  })
}
