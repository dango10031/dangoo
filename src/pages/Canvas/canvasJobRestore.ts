// 生成任务「刷新后续跑」认领决策的纯内核。
// 画布刷新后, 已提交未完成的任务靠持久化记录(pending)去远端历史里找回:
// 优先按受理时记下的真实任务 ID 精确匹配(不受同提示词并发影响),
// 否则按「同提示词且仍在运行」兜底, 再否则取同提示词最新一条(成功可补写),
// 同一批里一条历史任务最多被一个本地待恢复任务认领, 杜绝并发任务写错节点/重复扣费。
//
// 本文件零 React/DOM/网络: 输入 pending 记录与远端历史项, 输出处置决策,
// 由装配层(useCanvas)执行真正的卡片写回、续轮询与历史拉取。

/** 决策只依赖的远端历史项最小结构(lib/aigc 的 AigcHistoryItem 兼容) */
export interface RestoreHistoryItem {
  jobId: string
  taskId?: string
  status: string // 'running' | 'success' | 'failed' | 其它
  prompt?: string
  resultUrl?: string
  errorMessage?: string
  created?: string
}

/** 决策只依赖的本地待恢复任务最小结构 */
export interface RestorePendingJob {
  cardId: string
  resultIndex?: number
  model: string
  promptText: string
  remoteTaskId?: string
  __retried?: boolean
}

/** 一条本地待恢复任务的处置方式 */
export type RestoreDecision =
  /** 卡片/结果项已不存在: 丢弃记录, 不动卡片 */
  | { action: 'drop' }
  /** 续轮询这条远端在跑任务; claimedJobId 需加入本批去重集合 */
  | { action: 'resume'; history: RestoreHistoryItem; rememberTaskId: boolean }
  /**
   * 历史列表里没看到这条任务, 但本地持久化了受理任务号: 列表可能只拉了最近 30 条、
   * 写库有延迟, 不依赖列表, 直接按任务号续轮询(号是受理时服务端返回的真实身份)。
   */
  | { action: 'resume-exact'; jobId: string }
  /** 历史里已是成功且有产物: 补写成功结果 */
  | { action: 'complete'; history: RestoreHistoryItem }
  /** 历史里是明确失败: 补写失败 */
  | { action: 'fail'; history: RestoreHistoryItem }
  /** 没匹配到远端任务且属于视频类(历史写库有秒级延迟): 保留排队, 延迟再认领一次 */
  | { action: 'retry-later' }
  /** 没匹配到且不该等: 标「刷新时中断, 可重试」 */
  | { action: 'interrupt' }

/**
 * 有持久化任务号却没在本批历史里精确找到: 该任务可能因历史写库延迟/排在 30 条之外
 * 暂时缺席。fail closed —— 绝不退回同提示词兜底(那可能把别的节点任务认领到本卡)。
 * 直接按受理任务号续轮询: 号是真实身份, 不必等它出现在最近 30 条列表里;
 * 只有连号都没有(老记录)才靠重试/中断处置。
 */
export function missingExactRemoteDecision(job: RestorePendingJob): RestoreDecision {
  if (job.remoteTaskId) return { action: 'resume-exact', jobId: job.remoteTaskId }
  return job.__retried ? { action: 'interrupt' } : { action: 'retry-later' }
}

/** 按创建时间倒序的比较键(created 为字符串时间) */
function createdDesc(a: RestoreHistoryItem, b: RestoreHistoryItem): number {
  return (b.created || '').localeCompare(a.created || '')
}

/**
 * 在一批远端历史项里为一条本地待恢复任务找匹配项。
 * @param claimed 本批已被别的本地任务认领的 jobId 集合(调用方在逐条决策时维护)
 * @returns 匹配到的历史项与是否靠「非精确」兜底找到(精确命中不受 claimed 限制)
 */
export function matchRestoreHistory(
  job: RestorePendingJob,
  items: RestoreHistoryItem[],
  claimed: ReadonlySet<string>,
): { item: RestoreHistoryItem; exact: boolean } | null {
  // ① 受理时持久化的真实任务 ID: 精确匹配 jobId 或 taskId, 不受 claimed 与同提示词影响。
  //    有 ID 却没找到时 fail closed(返回 null, 由调用方延迟重查) —— 绝不退回同提示词兜底,
  //    否则历史写库延迟期间可能把别的节点(同提示词)的任务认领到本卡、结果写错卡。
  if (job.remoteTaskId) {
    const exact = items.find(
      it => it.jobId === job.remoteTaskId || (!!it.taskId && it.taskId === job.remoteTaskId),
    )
    return exact ? { item: exact, exact: true } : null
  }
  // ② 同提示词且仍在运行、本批未被认领: 取最新一条
  const running = items
    .filter(it => it.status === 'running' && it.prompt === job.promptText && !!it.jobId && !claimed.has(it.jobId))
    .sort(createdDesc)[0]
  if (running) return { item: running, exact: false }
  // ③ 同提示词最新一条(成功可补写、失败可标记), 同样本批去重
  const latest = items
    .filter(it => it.prompt === job.promptText && !!it.jobId && !claimed.has(it.jobId))
    .sort(createdDesc)[0]
  if (latest) return { item: latest, exact: false }
  return null
}

/**
 * 由匹配结果决定一条本地待恢复任务的处置。
 * @param exists       对应卡片/结果项是否仍存在(不存在直接 drop)
 * @param isVideoish   是否视频类任务(AI 应用/视频模型): 未匹配时允许延迟再认领一次
 * @param claimed      本批认领集合; 命中可认领项时会把 jobId 加进去(就地更新)
 */
export function decideRestore(
  job: RestorePendingJob,
  items: RestoreHistoryItem[],
  exists: boolean,
  isVideoish: boolean,
  claimed: Set<string>,
  /** 历史列表这次是否成功取到: 网络失败/接口报错为 false, 缺席不等于查无此任务 */
  historyAvailable = true,
): RestoreDecision {
  if (!exists) return { action: 'drop' }
  const matched = matchRestoreHistory(job, items, claimed)
  if (!matched) {
    // 列表本身没取到(网络故障等): 什么都不能确认, 所有任务一律延迟重查,
    // 绝不能把空数组当作「任务不存在」而标中断(会诱导重复提交、重复扣费)。
    if (!historyAvailable) return { action: 'retry-later' }
    // 有真实任务号却暂时缺席: 不退回同提示词兜底, 直接按号续轮询
    // (受理号是真实身份, 不必等它出现在最近 30 条列表里)。
    if (job.remoteTaskId) return missingExactRemoteDecision(job)
    // 没有任务号的记录: 视频/AI 应用历史可能有秒级写库延迟或排在 30 条之后, 第一次先延迟再认领,
    // 立即标可重试会诱导用户重新提交 → 重复扣费。
    return isVideoish && !job.__retried ? { action: 'retry-later' } : { action: 'interrupt' }
  }
  // 精确命中也登记去重: 后续同提示词的另一条本地任务不应再把它当兜底候选
  if (matched.item.jobId) claimed.add(matched.item.jobId)
  const it = matched.item
  if (it.status === 'running') {
    // 仅「靠提示词兜底找到、且记录里本来没有任务 ID」时才需要把认领 ID 补登回记录,
    // 精确命中(remoteTaskId 已存在)无需重复补登。
    return { action: 'resume', history: it, rememberTaskId: !matched.exact && !job.remoteTaskId }
  }
  if (it.status === 'success' && it.resultUrl) {
    return { action: 'complete', history: it }
  }
  if (it.status === 'failed') {
    return { action: 'fail', history: it }
  }
  // 成功但无产物 / 未知状态: 视频类再等一次, 其余按中断处理
  return isVideoish && !job.__retried ? { action: 'retry-later' } : { action: 'interrupt' }
}
