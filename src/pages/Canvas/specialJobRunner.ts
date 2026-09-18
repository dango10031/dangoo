// 语音克隆 / 动作迁移 / 高清修复三个「专用 AI 应用节点」共用的提交-轮询运行器。
// 三个节点原先各写一整套同构流程(会话闸门、信号登记、受理即 running、轮询、
// 成功写回+转永久链接+日志、失败登录标记+日志、catch 文案、finally 清理),
// 差异只在提交体构造、产物提取、成本、默认文件名与文案——这些经回调注入,
// 通用时序由本运行器统一承载。轮询响应的归一化/终态裁决复用 canvasJobRun 纯内核。
import {
  formatAiAppFailureMessage,
  type AiAppRunResponse,
} from '@/lib/aigc'
import { persistRemoteImage } from './canvasUtils'
import type { CardJobStatus, GenLogOutput } from './canvasTypes'
import type { SpecialJobContext } from './specialJobTypes'
import { SPECIAL_POLL_INTERVAL_MS, SPECIAL_POLL_TIMEOUT_MS } from './specialJobTypes'
import { specialAppSnapshot, specialRunErrorText, deriveResultName, isAuthErrorStatus } from './canvasJobRun'

/** 三个节点 state 里终态写回共用的字段子集 */
export interface SpecialJobStatePatch {
  remoteTaskId?: string
  jobStatus?: CardJobStatus
  resultUrl?: string
  resultName?: string
  errorMsg?: string | null
}

export interface SpecialRunnerParams<TStart> {
  job: SpecialJobContext
  cardId: string
  /** AI 应用 slug */
  slug: string
  /** 日志节点类型中文标签(语音克隆/动作迁移/视频修复) */
  nodeType: string
  /** 已由调用方读出的节点起始状态; 为空运行器直接返回(不记日志不计数) */
  start: TStart | undefined
  /** 记录一次实时生成日志(在上传换链之前), 返回终态写日志所需的 request 体等由调用方在 buildBody 里准备 */
  beginLog: () => void
  /**
   * 构造提交体(内部完成把永久媒体上传给 AI 应用换 fileName)。
   * 返回 body 与成功日志要用的成本文案(失败/catch 日志不带 request 与成本)。
   */
  buildBody: () => Promise<{ body: Record<string, unknown>; costText?: string }>
  /** 从成功响应提取产物地址(音频/视频) */
  extractUrl: (res: AiAppRunResponse) => string
  /** 产物文件名取不到时的默认名 */
  defaultResultName: string
  /** 成功产物转永久链接时的媒体类型 */
  persistKind: 'audio' | 'video'
  /** 写回节点状态(调用方无需再判会话, 运行器已闸) */
  write: (patch: SpecialJobStatePatch) => void
  /** 读当前节点结果地址(转存完成后比对, 避免把更新的结果覆盖掉) */
  readResultUrl: () => string | undefined
  /** 登录失效统一入口(由 SpecialJobContext 提供) */
  signalLoginRequired: () => void
  /** catch 非登录错误时的业务兜底文案 */
  fallbackErrorText: string
  /** 成功日志的输出媒体类型(音频/视频) */
  outputKind: GenLogOutput['kind']
}

/**
 * 跑一个专用 AI 应用节点任务, 永不抛出(异常经状态写回 + 日志收口)。
 * 调用方负责: 输入校验、计费确认、置 queued、登记 pending、计数 +1;
 * 运行器负责: 信号、受理态、上传换链、提交轮询、终态写回/转存/日志、计数 -1 与清理。
 */
export async function runSpecialAppJob<TStart>(params: SpecialRunnerParams<TStart>): Promise<void> {
  const {
    job, cardId, slug, nodeType, start, beginLog, buildBody,
    extractUrl, defaultResultName, persistKind, write, readResultUrl,
    signalLoginRequired, fallbackErrorText, outputKind,
  } = params
  if (!start) return
  const token = job.sessionTokenRef.current
  const signal = job.beginJobSignal()
  // 受理即拿到的真实任务号: 收尾按「卡+渠道+任务号」只删自己这条待办,
  // 同卡旧任务晚结束不会清掉已被新任务替换的记录。
  let acceptedTaskId: string | null = null
  beginLog()
  try {
    const built = await buildBody()
    const body = built.body
    const successCostText = built.costText ?? ''
    if (!job.aliveForSession(token)) return
    const res = await jobRunGuarded(job, slug, body, signal, token, write, id => {
      acceptedTaskId = id
    })
    if (!job.aliveForSession(token) || res.error?.code === 'ABORTED') return
    const url = extractUrl(res)
    const snap = specialAppSnapshot(res, {
      url,
      taskId: res.job?.taskId || res.job?.jobId,
      costText: successCostText,
      errorMsg: formatAiAppFailureMessage(res),
    })
    if (!snap.succeeded) {
      if (snap.needsLogin) signalLoginRequired()
      const errorMsg = snap.errorMsg || '生成失败, 请重试'
      write({ jobStatus: 'failed', errorMsg })
      job.finishSpecialLog(cardId, slug, nodeType, {
        success: false,
        taskId: snap.taskId,
        errorMsg,
        request: body,
      })
      return
    }
    write({
      jobStatus: 'success',
      resultUrl: url,
      resultName: deriveResultName(url, defaultResultName),
      errorMsg: null,
    })
    job.finishSpecialLog(cardId, slug, nodeType, {
      success: true,
      output: url ? { url, kind: outputKind } : undefined,
      taskId: snap.taskId,
      costText: successCostText,
      request: body,
    })
    if (url) {
      const resultUrl = url
      void persistRemoteImage(resultUrl, persistKind).then((permanent: string) => {
        if (!permanent || permanent === resultUrl || !job.aliveForSession(token)) return
        if (readResultUrl() === resultUrl) write({ resultUrl: permanent })
      })
    }
  } catch (err) {
    if (!job.aliveForSession(token)) return
    if (isAuthErrorStatus(err)) signalLoginRequired()
    const errorMsg = specialRunErrorText(err, fallbackErrorText)
    write({ jobStatus: 'failed', errorMsg })
    job.finishSpecialLog(cardId, slug, nodeType, { success: false, errorMsg })
  } finally {
    job.endJobSignal(signal)
    job.clearSpecialLogMeta(cardId)
    // 已受理: 按任务身份精确删; 未受理(提交前就失败/会话切换): 删同卡同渠道同样无任务号的待办
    job.removePendingJobByIdentity(cardId, slug, acceptedTaskId)
    job.setRunningCount(n => Math.max(0, n - 1))
  }
}

/**
 * 提交并轮询; 任务受理即把远端 ID 写回并置 running
 * (否则按钮一直停在「排队中」——只有刷新恢复路径才在认领后置 running)。
 */
async function jobRunGuarded(
  job: SpecialJobContext,
  slug: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  token: number,
  write: (patch: SpecialJobStatePatch) => void,
  noteAccepted: (remoteId: string) => void,
): Promise<AiAppRunResponse> {
  return job.runGuarded(slug, body, {
    pollIntervalMs: SPECIAL_POLL_INTERVAL_MS,
    deadlineMs: SPECIAL_POLL_TIMEOUT_MS,
    signal,
    onAccepted: remoteId => {
      if (!job.aliveForSession(token)) return
      noteAccepted(remoteId)
      write({ remoteTaskId: remoteId, jobStatus: 'running' })
    },
  })
}
