// 语音克隆 / 动作迁移 / 视频高清修复三个专用 AI 应用节点「刷新后续跑」的共享决策。
// 三节点原先各自内联同一套认领顺序, 且都有同一个错认口: 卡片/记录里已有真实任务号、
// 远端历史却暂时缺席(写库延迟/排在 30 条之外)时, 仍会退回「最新 running」兜底,
// 可能把别的节点任务认领到本卡。这里统一为:
//   ① 有任务号 → 只认精确匹配; 缺席交给调用方延迟重查(fail closed, 绝不兜底);
//   ② 完全没有任务号记录 → 仅当本批只有一条待恢复任务时, 才用「最新 running」兜底。
// 纯函数, 零 React/DOM/网络。

/** 决策依赖的远端历史项最小结构(与节点 hook 内的 AiAppHistoryItem 兼容) */
export interface SpecialRestoreHistoryLike {
  jobId: string
  taskId?: string
  status: string
}

/** 一条待恢复任务的认领决策 */
export type SpecialRestoreMatch<TItem> =
  /** 精确/兜底认领到这条历史 */
  | { kind: 'matched'; item: TItem }
  /**
   * 历史列表里没看到、但本地持久化了受理任务号: 列表只拉最近 30 条、写库有延迟,
   * 不依赖列表, 直接按该任务号续轮询(号是服务端受理时返回的真实身份)。
   */
  | { kind: 'resume-exact'; jobId: string }
  /**
   * 没有任务号、暂时也没查到可兜底的在跑项: 首次应延迟重查(历史写库有秒级延迟),
   * 重查仍无再标中断; 绝不能换认别的任务。
   */
  | { kind: 'await-exact' }
  /** 没有可续跑的任务(无任务号且无在跑兜底, 或历史已是成功/失败由调用方自行判定) */
  | { kind: 'none' }

function byCreatedDesc<TItem extends SpecialRestoreHistoryLike>(a: TItem, b: TItem): number {
  const ca = (a as { created?: string }).created || ''
  const cb = (b as { created?: string }).created || ''
  return cb.localeCompare(ca)
}

/**
 * 为一条专用节点待恢复任务找历史项。
 * @param claimedTaskId 卡片状态或待恢复记录上持久化的受理任务号(没有则空串)
 * @param siblingsCount 同一节点本次待恢复的任务总数(仅 1 条时允许最新在跑兜底)
 * @param historyAvailable 历史列表这次是否成功取到(网络失败为 false):
 *   列表缺席不等于任务不存在, 所有结论都要等待重查, 不能标中断。
 */
export function matchSpecialRestore<TItem extends SpecialRestoreHistoryLike>(
  claimedTaskId: string | undefined,
  items: readonly TItem[],
  siblingsCount: number,
  historyAvailable = true,
): SpecialRestoreMatch<TItem> {
  if (claimedTaskId) {
    const exact = items.find(it => it.jobId === claimedTaskId || (!!it.taskId && it.taskId === claimedTaskId))
    if (exact) return { kind: 'matched', item: exact }
    // 有受理号却没在列表里: 列表成功但缺席 → 号是真实身份, 直接按号续轮询,
    // 不必等它出现在最近 30 条里; 列表本身拉取失败 → 什么都无法确认, 等重查。
    return historyAvailable
      ? { kind: 'resume-exact', jobId: claimedTaskId }
      : { kind: 'await-exact' }
  }
  // 列表都没取到: 无号任务也不能下「没有在跑」的结论
  if (!historyAvailable) return { kind: 'await-exact' }
  // 完全没有任务号的老记录: 仅本节点只有这一条待恢复时才兜底最新在跑, 避免多节点并发误认
  if (siblingsCount === 1) {
    const running = [...items].filter(it => it.status === 'running').sort(byCreatedDesc)[0]
    if (running) return { kind: 'matched', item: running }
  }
  return { kind: 'none' }
}
