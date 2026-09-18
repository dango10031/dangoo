// 生成任务「提交-轮询主链」终态裁决的纯内核。
// 标准 AIGC 与 AI 应用两条链路各自拿到形态不同的轮询响应, 但终态处理同构:
// 会话已失效/被中止 → 静默丢弃(不写卡不写日志); 成功 → 取产物地址/任务号/费用写成功;
// 其余失败 → 判断是否登录失效, 写失败与错误文案。
//
// 本文件零 React/DOM/网络: 各链路先把自己的响应归一化成 PollSnapshot,
// 裁决出一个 SpecResultPatch 交装配层写回; 真正的提交/轮询/转存/会话闸门仍在 useCanvas。
import type { SpecResultPatch } from './canvasJobResult'

/** 各链路从自己的轮询响应里提取的最小判定信息 */
export interface PollSnapshot {
  /** 链路认定的成功: 标准=status success; AI 应用=state succeeded/partial */
  succeeded: boolean
  /** 是否为「被中止」(用户取消/切画布 abort): 静默丢弃 */
  aborted: boolean
  /** 是否登录/授权失效: 失败时装配层据此拉起登录 */
  needsLogin: boolean
  /** 成功产物地址(可能为空) */
  url?: string
  /** 远端任务号(成功时展示/日志用) */
  taskId?: string
  /** 费用文案(成功时) */
  costText?: string
  /** 失败时已由链路格式化好的错误文案 */
  errorMsg?: string
}

/** 轮询终态裁决结果 */
export type RunTerminal =
  | { kind: 'discard' }
  | { kind: 'success'; patch: SpecResultPatch; url: string }
  | { kind: 'failure'; patch: SpecResultPatch; needsLogin: boolean }

/**
 * 归一化快照 + 会话是否仍有效 → 终态裁决。
 * 会话失效一律静默丢弃(优先级最高); 其后 aborted 也丢弃;
 * 成功(即便无产物地址)写 success; 其余写 failure(登录标记透传给装配层)。
 */
export function decideRunTerminal(snap: PollSnapshot, sessionAlive: boolean): RunTerminal {
  if (!sessionAlive || snap.aborted) return { kind: 'discard' }
  if (snap.succeeded) {
    const patch: SpecResultPatch = {
      jobStatus: 'success',
      url: snap.url || '',
      taskId: snap.taskId,
      costText: snap.costText,
    }
    return { kind: 'success', patch, url: snap.url || '' }
  }
  return {
    kind: 'failure',
    needsLogin: snap.needsLogin,
    patch: { jobStatus: 'failed', errorMsg: snap.errorMsg },
  }
}

/** 提交/换链/首帧上传等同步阶段抛出的异常是否属于登录/授权失效(412/401/403) */
export function isAuthErrorStatus(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status
  return status === 412 || status === 401 || status === 403
}

/** 专用 AI 应用节点(语音克隆/动作迁移/高清修复)轮询响应的最小结构 */
export interface SpecialAppResponseLike {
  state: string
  error?: { code?: string }
  job?: { taskId?: string; jobId?: string }
}

/**
 * 把专用 AI 应用的轮询响应归一化成 PollSnapshot(三个节点共用同一套判定):
 * succeeded/partial 算成功; error.code ABORTED 算中止; RH_LOGIN_REQUIRED 算登录失效。
 * url/taskId 由调用方在外层从各自的提取函数(ttsAudioUrl/motionVideoUrl)补进。
 */
export function specialAppSnapshot(
  res: SpecialAppResponseLike,
  extra: { url?: string; taskId?: string; costText?: string; errorMsg?: string },
): PollSnapshot {
  const succeeded = res.state === 'succeeded' || res.state === 'partial'
  return {
    succeeded,
    aborted: !succeeded && res.error?.code === 'ABORTED',
    needsLogin: !succeeded && res.error?.code === 'RH_LOGIN_REQUIRED',
    url: extra.url,
    taskId: extra.taskId ?? res.job?.taskId ?? res.job?.jobId,
    costText: extra.costText,
    errorMsg: extra.errorMsg,
  }
}

/** 从产物地址推导结果文件名: 取路径末段并去掉查询参数; 取不到时用调用方给的默认名 */
export function deriveResultName(url: string, fallback: string): string {
  const name = url.split('/').pop()?.split('?')[0]
  return name || fallback
}

/**
 * 专用节点提交/上传阶段异常的统一文案(与各节点旧 catch 文案逐字一致):
 * 登录失效 412/401/403 统一「登录已过期, 请重新登录后重试」, 否则用调用方给的业务兜底文案。
 */
export function specialRunErrorText(err: unknown, fallback: string): string {
  return isAuthErrorStatus(err) ? '登录已过期, 请重新登录后重试' : fallback
}

/**
 * 刷新续跑成功补写日志时的节点类型:
 * - 节点自身结果项(有 resultIndex)统一记「生成节点」;
 * - 老独立结果卡按通道给的 fallback(AI 应用通道给「AI 应用」, 标准通道给「生成节点」),
 *   若该卡是 Loop 复刻来源则记「Loop」。useLoopSlot 控制是否额外认 loopSlotIndex
 *   (AI 应用通道旧逻辑只认 loopSourceId, 标准通道两者都认)。
 */
export function resumeNodeType(
  resultIndex: number | undefined,
  fallback: string,
  isLoop: boolean,
): string {
  if (resultIndex !== undefined) return '生成节点'
  return isLoop ? 'Loop' : fallback
}
