// 生成任务「结果写回收口」的纯内核。
// 两类零副作用、最易错的决策从 useCanvas 的 setState 回调里抽出:
// 1) 生成节点多个结果项(items)里某一项更新后, 节点级状态/主图/费用如何聚合;
// 2) 刷新前待办任务(pending)的增、删、按卡片+结果项匹配。
//
// 本文件零 React/DOM/网络: 输入旧数组返回新数组/布尔, 由装配层接进 setState。
import type { CanvasCardData, GenerateResultItem, CardJobStatus, PendingJobRecord } from './canvasTypes'

/** 终态写回卡片/结果项的统一补丁(标准 AIGC 与 AI 应用共用) */
export interface SpecResultPatch {
  jobStatus: CardJobStatus
  url?: string
  taskId?: string
  costText?: string
  errorMsg?: string
}

/**
 * 把单个结果项的补丁应用到数组, 返回新数组(下标越界时原样返回)。
 */
export function applyResultItemPatch(
  results: GenerateResultItem[],
  resultIndex: number,
  itemPatch: Partial<GenerateResultItem>,
): GenerateResultItem[] {
  if (resultIndex < 0 || resultIndex >= results.length) return results
  return results.map((it, i) => (i === resultIndex ? { ...it, ...itemPatch } : it))
}

/**
 * 节点级聚合状态: 有排队/运行 → running; 全部成功 → success; 否则有失败 → failed; 空数组 → undefined。
 */
export function aggregateJobStatus(results: GenerateResultItem[]): CardJobStatus | undefined {
  if (results.some(r => r.itemStatus === 'queued' || r.itemStatus === 'running')) return 'running'
  if (results.length > 0 && results.every(r => r.itemStatus === 'success')) return 'success'
  if (results.some(r => r.itemStatus === 'failed')) return 'failed'
  return undefined
}

/** 「¥1.23」等费用文案解析成数字(解析不出按 0) */
function parseCost(text: string | undefined): number {
  const n = parseFloat((text ?? '').replace(/[^\d.]/g, ''))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 全部成功结果项的费用合计, 返回用于展示的「¥x.xx」(无正值费用返回 undefined) */
export function sumResultsCost(results: GenerateResultItem[]): string | undefined {
  const total = results.map(r => parseCost(r.costText)).reduce((a, b) => a + b, 0)
  return total > 0 ? `¥${total.toFixed(2)}` : undefined
}

/** active 下标钳制到结果数组范围内(删除/重置不缩容时的防御) */
export function clampActiveIndex(activeIndex: number | undefined, length: number): number {
  if (length <= 0) return 0
  return Math.min(activeIndex ?? 0, length - 1)
}

/**
 * 选出节点主图: 当前 active 项若是「成功且有 url」用它, 否则取第一个成功且有 url 的项; 都没有返回 null。
 */
export function pickMainResult(
  results: GenerateResultItem[],
  activeIndex: number,
): GenerateResultItem | null {
  const active = results[activeIndex]
  if (active && active.itemStatus === 'success' && active.url) return active
  return results.find(r => r.itemStatus === 'success' && r.url) ?? null
}

export interface NodeResultAggregate {
  results: GenerateResultItem[]
  activeResultIndex: number
  jobStatus: CardJobStatus | undefined
  url: string | undefined
  cropContext: GenerateResultItem['cropContext']
  costText: string | undefined
}

/**
 * 对某张生成节点卡的某个结果项打补丁后, 一次性算出整张卡应聚合出的字段。
 * 复刻原 patchNodeResult 的全部规则; 非该卡/无 results 由调用方先判定。
 */
export function aggregateNodeResults(
  card: CanvasCardData,
  resultIndex: number,
  itemPatch: Partial<GenerateResultItem>,
): NodeResultAggregate {
  const oldResults = card.results ?? []
  const results = applyResultItemPatch(oldResults, resultIndex, itemPatch)
  const activeIdx = clampActiveIndex(card.activeResultIndex, results.length)
  const main = pickMainResult(results, activeIdx)
  const summed = sumResultsCost(results)
  return {
    results,
    activeResultIndex: activeIdx,
    jobStatus: aggregateJobStatus(results),
    url: main?.url,
    cropContext: main ? main.cropContext ?? null : card.cropContext,
    costText: summed ?? card.costText,
  }
}

/**
 * 终态补丁落到单个结果项时的字段映射: itemStatus 用 jobStatus,
 * 视频结果带 isVideo(由 spec 决定), 其余字段透传。
 */
export function resultItemPatchFromSpec(
  patch: SpecResultPatch,
  isVideo?: boolean,
): Partial<GenerateResultItem> {
  return {
    itemStatus: patch.jobStatus,
    url: patch.url,
    taskId: patch.taskId,
    costText: patch.costText,
    errorMsg: patch.errorMsg,
    isVideo,
  }
}

// ---------------- 刷新前待办任务(pending)记账 ----------------

/**
 * 移除待办(逐字复刻原内联 removePendingJob 谓词)。对每条记录:
 * - 无下标的待办(老独立结果卡): 只要卡片相同就移除(无论调用是否带 resultIndex);
 * - 有下标的待办(节点结果项): 仅当调用也带下标、且卡片与下标都相同才移除。
 * 即调用结果: 无下标调用只删同卡的老独立卡记录; 有下标调用删同卡老独立卡记录 + 精确那一条结果项。
 * 同一张卡实际不会同时存在两类任务, 故重叠删除无实际影响, 严格保留原行为。
 */
export function removePendingJobRecord(
  prev: PendingJobRecord[],
  cardId: string,
  resultIndex?: number,
): PendingJobRecord[] {
  return prev.filter(j => {
    if (j.cardId !== cardId) return true
    if (j.resultIndex === undefined) return false
    return resultIndex !== undefined ? j.resultIndex !== resultIndex : true
  })
}

/**
 * 按「任务身份」清理单条待办(compare-and-delete): 仅移除同卡片、同模型渠道、
 * 且任务号相符的那一条。任务号缺省(null/undefined)时只匹配同样没有任务号的记录。
 * 用途: 同一卡片上旧任务晚结束时, 不得带走已被新任务替换的待办记录
 * (旧实现按 cardId 整删, 连续提交两笔时旧任务的收尾会误删新任务)。
 */
export function removePendingJobByIdentity(
  prev: PendingJobRecord[],
  cardId: string,
  model: string,
  remoteTaskId?: string | null,
): PendingJobRecord[] {
  return prev.filter(j => {
    if (j.cardId !== cardId || j.model !== model) return true
    if (remoteTaskId) return j.remoteTaskId !== remoteTaskId
    // 没拿到任务号(受理前就失败/中断): 仅删同样没有任务号的同卡同渠道记录
    return !!j.remoteTaskId
  })
}

/**
 * 任务终态收尾的 compare-and-delete(比 removePendingJobByIdentity 更严格):
 * 必须「同卡片 + 同模型渠道 + 同任务槽(有下标精确到结果项, 无下标按整卡) + 同任务号」
 * 才删除; 无任务号时只删同槽同渠道且同样没有号的那一条。
 * 用途: 同一张卡上先后两笔(如失败项换渠道重跑、刷新恢复与新提交交错)旧笔先结束时,
 * 不得带走新笔的待办记录 —— 槽位不同或任务号不同都保留。
 */
export function finishPendingJobRecord(
  prev: PendingJobRecord[],
  cardId: string,
  model: string,
  remoteTaskId: string | undefined,
  resultIndex: number | undefined,
): PendingJobRecord[] {
  return prev.filter(j => {
    if (j.cardId !== cardId || j.model !== model) return true
    // 任务槽必须全等(undefined 整卡槽只匹配无下标记录, 数字只匹配该结果项)
    if (j.resultIndex !== resultIndex) return true
    if (remoteTaskId) return j.remoteTaskId !== remoteTaskId
    return !!j.remoteTaskId
  })
}

/**
 * 一批刷新恢复任务进入时应为运行计数增加多少: 首次认领计入整批,
 * 4s 延迟重查(同一批的再认领)计 0, 杜绝重试递归把顶栏进度越积越高。
 */
export function initialRestoreCount(
  pendingCount: number,
  opts?: { alreadyCounted?: boolean },
): number {
  return opts?.alreadyCounted ? 0 : pendingCount
}

/**
 * 受理后把远端任务 ID 补登到匹配的待办上(只补没有 ID 的那一条):
 * 同卡片、同结果项(有下标精确, 无下标按卡片)、同 model 且 remoteTaskId 仍空。
 */
export function attachRemoteTaskId(
  prev: PendingJobRecord[],
  cardId: string,
  resultIndex: number | undefined,
  model: string,
  remoteTaskId: string,
): PendingJobRecord[] {
  return prev.map(j => {
    const sameSlot =
      resultIndex === undefined ? j.resultIndex === undefined : j.resultIndex === resultIndex
    if (j.cardId === cardId && sameSlot && j.model === model && !j.remoteTaskId) {
      return { ...j, remoteTaskId }
    }
    return j
  })
}
