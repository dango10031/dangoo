import type { RefObject } from 'react'
import type { callAiAppAndPoll } from '@/lib/aigc'
import type { CanvasCardData, GenLogOutput, PendingJobRecord } from './canvasTypes'

export type { GenLogOutput, PendingJobRecord }
export type { CanvasCardData }

/** 专用 AI 应用节点统一轮询节奏（秒/毫秒，最长 60 分钟），与画布标准生成任务一致 */
export const SPECIAL_POLL_INTERVAL_MS = 3500
export const SPECIAL_POLL_TIMEOUT_MS = 3600000

/**
 * 语音克隆 / 动作迁移 / 视频高清修复三个「专用 AI 应用节点」共享的作业能力。
 * 由 useCanvas 构造一次，分别传给 useTtsNode / useMotionNode / useVsrNode，
 * 避免每个节点各写一套会话判断、轮询信号、日志、运行计数逻辑。
 */
export interface SpecialJobContext {
  /** 当前画布全部卡片（读节点状态），渲染期持续刷新为最新引用 */
  cardsRef: RefObject<CanvasCardData[]>
  /** 当前画布会话标识；切换画布后旧会话的异步回写一律丢弃 */
  sessionTokenRef: RefObject<number>
  aliveForSession(token: number): boolean
  /** 登记/注销可在切画布时统一取消的轮询信号 */
  beginJobSignal(): AbortSignal
  endJobSignal(signal: AbortSignal | undefined): void
  /** 专用 AI 应用提交 + 轮询守卫（统一登录拦截），运行器经它发起任务 */
  runGuarded: typeof callAiAppAndPoll
  /** 移除刷新前任务记录（新链路可按 resultIndex 精确移除，专用节点只传 cardId） */
  removePendingJob(cardId: string, resultIndex?: number): void
  /**
   * 按任务身份 compare-and-delete 单条待办: 仅删同卡同渠道且任务号相符的那一条,
   * 同卡旧任务晚结束时不得带走新任务的待办(实时生成收尾用)。
   */
  removePendingJobByIdentity(cardId: string, model: string, remoteTaskId?: string | null): void
  /**
   * 续跑认领到受理任务号后, 把同卡同渠道仍无任务号的待办记录补登为该号
   * (刷新恢复路径: 老记录无号, 不补登则收尾的按号清理命中不到)。
   */
  rememberPendingTaskId(cardId: string, model: string, remoteTaskId: string): void
  /** 全局并发计数（顶栏进度用） */
  setRunningCount(updater: (n: number) => number): void
  /** 登录失效：拉起登录弹窗并标记需要重新授权 RH */
  signalLoginRequired(): void
  /** 一次实时生成的开始/结束日志（finish 时落最终产物与花费） */
  beginSpecialLog(cardId: string, prompt: string, refs: string[], refsMedia?: GenLogOutput[]): void
  finishSpecialLog(
    cardId: string,
    appSlug: string,
    nodeType: string,
    result: {
      success: boolean
      output?: GenLogOutput
      taskId?: string
      costText?: string
      errorMsg?: string
      request?: Record<string, unknown>
    },
  ): void
  /** abort/超时/会话切换路径兜底清理一次实时生成的日志元信息 */
  clearSpecialLogMeta(cardId: string): void
  /** 刷新恢复路径补写的日志（不经 begin/finish） */
  appendRestoredLog(entry: {
    status: 'success' | 'failed'
    platform: string
    nodeType: string
    model: string
    prompt: string
    refs: string[]
    refsMedia?: GenLogOutput[]
    outputs?: GenLogOutput[]
    errorMsg?: string
    taskId?: string
    costText?: string
  }): void
}
