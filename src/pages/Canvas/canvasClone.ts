// 卡片复制 / 粘贴 / 删除的纯数据变换内核。
// 从 useCanvas 抽出：只对 cards / connections 快照做确定性计算，不碰 state / uid / 网络。
// id 生成（uid）与副作用留给包装层，通过 newId 注入，便于单测注入固定 id。
import type { CanvasCardData, CanvasConnection, RepNodeState } from './canvasTypes'

export type IdFactory = () => string

/** 复制时必须剥离的卡片顶层运行态：副本是静态节点，不继承任务、不转圈、不被刷新恢复认领 */
export function stripCardRuntime(copy: CanvasCardData): CanvasCardData {
  copy.taskId = undefined
  copy.jobStatus = undefined
  copy.errorMsg = undefined
  copy.costText = undefined
  return copy
}

/** 三类专用 AI 节点深拷贝时清空结果/任务态，但保留用户上传的媒体与参数 */
export function resetSpecialStates(copy: CanvasCardData): CanvasCardData {
  if (copy.ttsState) {
    copy.ttsState = {
      ...copy.ttsState,
      jobStatus: 'idle',
      resultUrl: undefined,
      resultName: undefined,
      errorMsg: null,
      remoteTaskId: undefined,
    }
  }
  if (copy.motionState) {
    copy.motionState = {
      ...copy.motionState,
      jobStatus: 'idle',
      resultUrl: undefined,
      resultName: undefined,
      errorMsg: null,
      remoteTaskId: undefined,
    }
  }
  if (copy.vsrState) {
    copy.vsrState = {
      ...copy.vsrState,
      jobStatus: 'idle',
      resultUrl: undefined,
      resultName: undefined,
      errorMsg: null,
      remoteTaskId: undefined,
    }
  }
  return copy
}

/**
 * 深拷贝一张卡作为副本：新 id、偏移摆放、剥离运行态、清空专用节点结果。
 * 不处理 groupId 映射与摄影机改名（由多选/粘贴的调用方在其批量流程里统一做）。
 */
export function cloneCard(
  src: CanvasCardData,
  newId: string,
  offsetX: number,
  offsetY: number,
): CanvasCardData {
  const copy = JSON.parse(JSON.stringify(src)) as CanvasCardData
  copy.id = newId
  copy.x = src.x + offsetX
  copy.y = src.y + offsetY
  stripCardRuntime(copy)
  resetSpecialStates(copy)
  return copy
}

/** 粘贴生成节点结果列表：只带走已成功/已失败的成品，在途项丢弃；下标钳制 */
export function keepOnlyFinishedResults(copy: CanvasCardData): CanvasCardData {
  if (Array.isArray(copy.results)) {
    const kept = copy.results.filter(r => r.itemStatus !== 'queued' && r.itemStatus !== 'running')
    kept.forEach(r => {
      r.taskId = undefined
    })
    copy.results = kept
    if (kept.length === 0) {
      copy.activeResultIndex = undefined
    } else if (typeof copy.activeResultIndex === 'number') {
      copy.activeResultIndex = Math.min(copy.activeResultIndex, kept.length - 1)
    }
  }
  return copy
}

/**
 * 粘贴专用：在复制剥离基础上，额外把各类节点「分析中/生图中」的过程态回落到空闲。
 * 已生成的成品（复刻成品图、润色/Agent 文本）保留，在途任务与错误清空。
 */
export function resetPasteNodeStates(copy: CanvasCardData): CanvasCardData {
  // 分层节点: 分析中/生图中回落到空闲(已分析出的分层清单保留, 可直接重新生图)
  if (copy.layerState && (copy.layerState.stage === 'analyzing' || copy.layerState.stage === 'generating')) {
    copy.layerState = { ...copy.layerState, stage: 'idle' }
  }
  // 复刻节点: 分析/生成阶段回落, 正背面在途任务置空闲(已出的成品图保留)
  if (copy.repState) {
    const rs = copy.repState
    let stage = rs.stage
    if (stage === 'analyzing' || stage === 'generating') {
      stage = rs.frontPrompt || rs.backPrompt ? 'ready' : 'idle'
    }
    const idleSide = (s: RepNodeState['jobStatus']['front']) =>
      s === 'queued' || s === 'running' ? 'idle' : s
    copy.repState = {
      ...rs,
      stage,
      jobStatus: { front: idleSide(rs.jobStatus.front), back: idleSide(rs.jobStatus.back) },
    }
  }
  // 融合节点: 清运行标记与错误
  if (copy.mergeState) {
    copy.mergeState = { ...copy.mergeState, running: false, error: null }
  }
  // 润色 / Agent(共用 jobStatus 形态): 运行中回落空闲, 已生成的文本结果保留
  if (copy.polishState && (copy.polishState.jobStatus === 'running' || copy.polishState.jobStatus === 'failed')) {
    copy.polishState = { ...copy.polishState, jobStatus: 'idle', errorMsg: null }
  }
  if (copy.agentState && (copy.agentState.jobStatus === 'running' || copy.agentState.jobStatus === 'failed')) {
    copy.agentState = { ...copy.agentState, jobStatus: 'idle', errorMsg: null }
  }
  return copy
}

/** 粘贴时一并剥离在途结果与各节点过程态（深拷贝后的副本上调用） */
export function stripPasteRuntime(copy: CanvasCardData): CanvasCardData {
  keepOnlyFinishedResults(copy)
  resetPasteNodeStates(copy)
  return copy
}

/**
 * 一批源卡 → 复制结果：返回副本数组、旧 id→新 id 映射、旧 groupId→新 groupId 映射。
 * 仅做拷贝/偏移/剥离/分组重映射；摄影机改名与摄影机绑定映射由调用方按业务顺序处理。
 */
export interface CloneBatchResult {
  copies: CanvasCardData[]
  idMap: Map<string, string>
  gidMap: Map<string, string>
}

export function cloneCardBatch(
  sources: CanvasCardData[],
  newId: IdFactory,
  offsetX: number,
  offsetY: number,
  opts: { resetResults?: boolean } = {},
): CloneBatchResult {
  const idMap = new Map(sources.map(c => [c.id, newId()]))
  const gidMap = new Map<string, string>()
  const copies = sources.map(src => {
    const copy = JSON.parse(JSON.stringify(src)) as CanvasCardData
    copy.id = idMap.get(src.id) as string
    copy.x = src.x + offsetX
    copy.y = src.y + offsetY
    stripCardRuntime(copy)
    resetSpecialStates(copy)
    if (opts.resetResults) stripPasteRuntime(copy)
    if (src.groupId) {
      if (!gidMap.has(src.groupId)) gidMap.set(src.groupId, newId())
      copy.groupId = gidMap.get(src.groupId)
    }
    return copy
  })
  return { copies, idMap, gidMap }
}

/**
 * 重建「两端都在复制集合内」的连线（多选复制的组内连线），id 用 newId 重新生成。
 * 注意：沿用历史行为，组内连线不携带 toSlot（只映射 id/from/to）。
 */
export function rebuildInnerConnections(
  connections: CanvasConnection[],
  idMap: Map<string, string>,
  newId: IdFactory,
): CanvasConnection[] {
  return connections
    .filter(conn => idMap.has(conn.fromId) && idMap.has(conn.toId))
    .map(conn => ({
      id: newId(),
      fromId: idMap.get(conn.fromId) as string,
      toId: idMap.get(conn.toId) as string,
    }))
}

/**
 * 粘贴剪贴板：连线「任一端在复制集合内」就带走。
 * - 两端都在集合 → 两端都映射到新节点（完整子链）
 * - 仅一端在集合 → 保留外部那端原 id（新节点连回原外部节点）
 */
export function rebuildPasteConnections(
  stored: Array<{ fromId: string; toId: string; toSlot?: CanvasConnection['toSlot'] }>,
  idMap: Map<string, string>,
  newId: IdFactory,
  existing: CanvasConnection[] = [],
): CanvasConnection[] {
  // 与现有连线、以及本批内部去重: 同一 (源→目标→槽) 只保留一条(同一槽只允许一条线)
  const seen = new Set(existing.map(c => `${c.fromId}>${c.toId}>${c.toSlot ?? ''}`))
  const out: CanvasConnection[] = []
  stored
    .filter(conn => idMap.has(conn.fromId) || idMap.has(conn.toId))
    .map(conn => ({
      fromId: idMap.get(conn.fromId) ?? conn.fromId,
      toId: idMap.get(conn.toId) ?? conn.toId,
      ...(conn.toSlot ? { toSlot: conn.toSlot } : {}),
    }))
    // 两端都没被复制不会发生(复制时已按任一端命中过滤); 排除映射后产生的自连
    .filter(conn => conn.fromId !== conn.toId)
    .forEach(conn => {
      const key = `${conn.fromId}>${conn.toId}>${conn.toSlot ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      out.push({ id: newId(), ...conn })
    })
  return out
}

/** 删除一批卡片后，清理任一端命中的连线 */
export function connectionsWithoutCards(
  connections: CanvasConnection[],
  idSet: Set<string>,
): CanvasConnection[] {
  return connections.filter(conn => !idSet.has(conn.fromId) && !idSet.has(conn.toId))
}

/** 删除一批卡片后，从选中态里剔除它们 */
export function selectionWithoutCards(selectedIds: string[], idSet: Set<string>): string[] {
  return selectedIds.filter(id => !idSet.has(id))
}
