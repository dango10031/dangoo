import { toast } from 'sonner'
import {
  callAiApp,
  callAiAppAndPoll,
  downloadAigcResult,
  formatAiAppFailureMessage,
  resumeAiAppJob,
  uploadAiAppMedia,
} from '@/lib/aigc'
import { mediaSrc, persistMedia } from '@/lib/media'
import { runSingleMediaUpload } from './canvasMediaUpload'
import { runSpecialAppJob } from './specialJobRunner'
import { matchSpecialRestore } from './specialJobRestore'
import { persistRemoteImage, readVideoDuration } from './canvasUtils'
import { aiAppCostText } from './canvasCostText'
import { motionVideoUrl } from './canvasMediaUrl'
import {
  VSR_APP_SLUG,
  VSR_HQ_MAX_SECONDS,
  vsrPriceOf,
  vsrResolutionOf,
} from './canvasModels'
import { logModelLabel, logPlatformOf } from './nodeParams'
import type { CanvasCardData, PendingJobRecord, VsrNodeState } from './canvasTypes'
import { SPECIAL_POLL_INTERVAL_MS as POLL_INTERVAL_MS, SPECIAL_POLL_TIMEOUT_MS as POLL_TIMEOUT_MS, type SpecialJobContext } from './specialJobTypes'

/** 媒体上传接口单文件大小上限（与平台媒体接口一致） */
const VSR_MEDIA_MAX_BYTES = 100 * 1024 * 1024

interface AiAppHistoryItem {
  jobId: string
  taskId?: string
  status: string
  resultUrl?: string
  created?: string
}

export interface UseVsrNodeOptions {
  job: SpecialJobContext
  /** 专用 AI 应用运行守卫（提交 + 轮询，统一处理登录拦截） */
  runGuarded: typeof callAiAppAndPoll
  /** 计费确认通过后执行任务 */
  runWithCostConfirm: (action: () => void, priceText: string) => void
  /** 写回节点状态 */
  updateState(cardId: string, patch: Partial<VsrNodeState>): void
  /** 登记一条刷新前未完成任务（运行入口用） */
  addPendingJob(cardId: string, promptText: string): void
}

export interface VsrNodeApi {
  handleVsrUpload(cardId: string, file: File | null): Promise<void>
  handleRemoveVsrVideo(cardId: string): void
  handleRunVsr(cardId: string): void
  handleDownloadVsr(cardId: string): void
  /** 刷新恢复：未完成的视频修复任务按受理任务 ID 续轮询/收敛 */
  restoreVsrJobs(jobs: PendingJobRecord[], docCards: CanvasCardData[], sessionToken: number): Promise<void>
}

/**
 * 视频高清修复节点（SeedVR2 / FlashVSR）：上传一段视频 → 输出高分辨率修复视频。
 * 从 useCanvas 抽出，作业信号/日志/运行计数走 SpecialJobContext，与语音克隆、动作迁移同构。
 */
export function useVsrNode(options: UseVsrNodeOptions): VsrNodeApi {
  const { job, runWithCostConfirm, updateState, addPendingJob } = options
  const {
    cardsRef, aliveForSession, beginJobSignal, endJobSignal,
    removePendingJob, removePendingJobByIdentity, rememberPendingTaskId,
    setRunningCount, signalLoginRequired,
    beginSpecialLog, appendRestoredLog,
  } = job

  /** 视频上传：本地即时预览 → 读时长 → 落永久链接（随画布/模板保存） */
  async function handleVsrUpload(cardId: string, file: File | null) {
    if (!file) return
    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv|gif)(\?|$)/i.test(file.name)
    if (!isVideo) {
      toast.error('请选择视频文件（支持 MP4 / WEBM / MOV 等）')
      return
    }
    if (file.size > VSR_MEDIA_MAX_BYTES) {
      toast.error('视频不能超过 100MB, 请压缩或剪短后再上传')
      return
    }
    const duration = await readVideoDuration(file)
    const localUrl = URL.createObjectURL(file)
    await runSingleMediaUpload(file, 'video', { localUrl, duration: duration ?? undefined }, {
      uploadOne: (f, t) => persistMedia(f, t),
      isAlive: () => !!cardsRef.current.find(c => c.id === cardId),
      onLocal: local => updateState(cardId, { videoUrl: local.localUrl, videoName: file.name, videoDuration: local.duration }),
      onFinal: (url, local) => updateState(cardId, { videoUrl: url, videoName: file.name, videoDuration: local.duration }),
      onError: kind => {
        if (kind === 'login') signalLoginRequired()
        else if (file.size > 60 * 1024 * 1024) toast.error('视频过大, 上传失败, 请换一段更小的视频')
        else toast.error('视频上传失败, 请重试')
        updateState(cardId, { videoUrl: undefined, videoName: undefined, videoDuration: undefined })
      },
      revokePreview: local => URL.revokeObjectURL(local.localUrl),
    })
  }

  function handleRemoveVsrVideo(cardId: string) {
    updateState(cardId, { videoUrl: undefined, videoName: undefined, videoDuration: undefined })
  }

  /** 把永久视频链接拉成 File 并上传给视频修复应用，换回提交用 fileName */
  async function uploadVsrVideo(mediaUrl: string): Promise<string> {
    const src = mediaSrc(mediaUrl)
    if (!src) throw new Error('missing-media')
    const resp = await fetch(src, { mode: 'cors' })
    if (!resp.ok) throw new Error('media-fetch-failed')
    const blob = await resp.blob()
    const ext = blob.type.split('/')[1] || 'mp4'
    const file = new File([blob], `vsr.${ext}`, { type: blob.type || 'video/mp4' })
    const up = await uploadAiAppMedia(VSR_APP_SLUG, file, 'video')
    if (!up?.ok || !up.fileName) throw new Error('video-upload-failed')
    return up.fileName
  }

  /** 提交 + 轮询（单任务），成功写回结果视频并后台转存永久链接 */
  async function runVsrJob(cardId: string) {
    const start = cardsRef.current.find(c => c.id === cardId)?.vsrState
    await runSpecialAppJob({
      job,
      cardId,
      slug: VSR_APP_SLUG,
      nodeType: '视频修复',
      start,
      outputKind: 'video',
      persistKind: 'video',
      defaultResultName: '高清修复视频.mp4',
      fallbackErrorText: '媒体上传或修复失败, 请重试',
      signalLoginRequired,
      write: patch => updateState(cardId, patch),
      readResultUrl: () => cardsRef.current.find(c => c.id === cardId)?.vsrState?.resultUrl,
      beginLog: () => {
        if (!start) return
        // 待修复视频按视频缩略图渲染，不被当图片出现破图
        beginSpecialLog(
          cardId,
          `视频高清修复 · ${start.videoName ?? ''}`,
          start.videoUrl ? [start.videoUrl] : [],
          start.videoUrl ? [{ url: start.videoUrl, kind: 'video' }] : [],
        )
      },
      buildBody: async () => {
        const videoFileName = await uploadVsrVideo(start!.videoUrl as string)
        const body: Record<string, unknown> = {
          referenceVideo: videoFileName,
          node108_select: start!.model,
          node112_value: String(vsrResolutionOf(start!.maxResolution)),
        }
        return { body, costText: aiAppCostText(vsrPriceOf(start!.model)) }
      },
      extractUrl: res => motionVideoUrl(res),
    })
  }

  /** 运行入口：校验输入 → 计费确认 → 提交；价格按所选档位（SeedVR2 / FlashVSR） */
  function handleRunVsr(cardId: string) {
    const vs = cardsRef.current.find(c => c.id === cardId)?.vsrState
    if (!vs) return
    if (vs.jobStatus === 'queued' || vs.jobStatus === 'running') return
    if (!vs.videoUrl) {
      toast.error('请先上传要修复的视频')
      return
    }
    if (vs.model === '1' && typeof vs.videoDuration === 'number' && vs.videoDuration > VSR_HQ_MAX_SECONDS) {
      toast.error(`SeedVR2 建议视频不超过 ${VSR_HQ_MAX_SECONDS} 秒, 可换 FlashVSR 或剪短`)
      return
    }
    const priceText = `¥${vsrPriceOf(vs.model).toFixed(2)} / 次`
    runWithCostConfirm(() => {
      updateState(cardId, { jobStatus: 'queued', errorMsg: null, resultUrl: undefined })
      addPendingJob(cardId, `视频高清修复 · ${vs.videoName ?? ''}`.slice(0, 80))
      setRunningCount(n => n + 1)
      void runVsrJob(cardId)
    }, `运行视频高清修复 1 次 · ${priceText}`)
  }

  function handleDownloadVsr(cardId: string) {
    const vs = cardsRef.current.find(c => c.id === cardId)?.vsrState
    if (vs?.resultUrl) void downloadAigcResult(vs.resultUrl, vs.resultName)
  }

  async function restoreVsrJobs(
    jobs: PendingJobRecord[],
    docCards: CanvasCardData[],
    sessionToken: number,
    opts?: { alreadyCounted?: boolean },
  ) {
    if (!jobs.length) return
    // 恢复任务首次进入计入运行数, 延迟重查是同一笔的再认领, 不重复 +1
    if (!opts?.alreadyCounted) setRunningCount(n => n + jobs.length)
    let items: AiAppHistoryItem[] = []
    // 列表是否真的取到: 网络失败为 false, 空列表不等于「任务不存在」, 只能等重查
    let historyAvailable = true
    try {
      const r = await callAiApp<{ ok: boolean; items?: AiAppHistoryItem[] }>(
        `/api/aigc/ai-app/${VSR_APP_SLUG}/history`,
        { page: 1, perPage: 30 },
      )
      items = r.items ?? []
    } catch {
      historyAvailable = false
    }
    // 按受理任务号直接续轮询(列表缺席/在 30 条之外都不影响), 终态写回/日志/转存后按号清理
    async function followJob(j: PendingJobRecord, vs: VsrNodeState, jobId: string) {
      updateState(j.cardId, { jobStatus: 'running', remoteTaskId: jobId })
      rememberPendingTaskId(j.cardId, VSR_APP_SLUG, jobId)
      try {
        const vsrSignal = beginJobSignal()
        const res = await resumeAiAppJob(VSR_APP_SLUG, { jobId }, { pollIntervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_TIMEOUT_MS, signal: vsrSignal })
        endJobSignal(vsrSignal)
        if (!aliveForSession(sessionToken) || res.error?.code === 'ABORTED') return
        if (res.state === 'succeeded' || res.state === 'partial') {
          const url = motionVideoUrl(res)
          updateState(j.cardId, { jobStatus: 'success', resultUrl: url, resultName: url.split('/').pop()?.split('?')[0] || '高清修复视频.mp4', errorMsg: null })
          appendRestoredLog({
            status: 'success',
            platform: logPlatformOf(VSR_APP_SLUG),
            nodeType: '视频修复',
            model: logModelLabel(VSR_APP_SLUG),
            prompt: `视频高清修复 · ${vs.videoName ?? ''}`,
            refs: [],
            refsMedia: vs.videoUrl ? [{ url: vs.videoUrl, kind: 'video' }] : [],
            outputs: url ? [{ url, kind: 'video' }] : [],
            taskId: res.job?.taskId || jobId,
            costText: aiAppCostText(vsrPriceOf(vs.model)),
          })
          if (url) {
            const resultUrl = url
            void persistRemoteImage(resultUrl, 'video').then((permanent: string) => {
              if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
                const cur = cardsRef.current.find(c => c.id === j.cardId)
                if (cur?.vsrState?.resultUrl === resultUrl) updateState(j.cardId, { resultUrl: permanent })
              }
            })
          }
        } else {
          if (res.error?.code === 'RH_LOGIN_REQUIRED') signalLoginRequired()
          const resumeVsrError = formatAiAppFailureMessage(res)
          updateState(j.cardId, { jobStatus: 'failed', errorMsg: resumeVsrError })
          appendRestoredLog({
            status: 'failed',
            platform: logPlatformOf(VSR_APP_SLUG),
            nodeType: '视频修复',
            model: logModelLabel(VSR_APP_SLUG),
            prompt: `视频高清修复 · ${vs.videoName ?? ''}`,
            refs: [],
            refsMedia: vs.videoUrl ? [{ url: vs.videoUrl, kind: 'video' }] : [],
            errorMsg: resumeVsrError,
            taskId: jobId,
          })
        }
      } catch {
        if (aliveForSession(sessionToken)) updateState(j.cardId, { jobStatus: 'failed', errorMsg: '修复失败, 请重试' })
      } finally {
        // compare-and-delete: 只删同卡同渠道同任务号; 旧会话轮询退出不碰新画布待办
        if (aliveForSession(sessionToken)) removePendingJobByIdentity(j.cardId, VSR_APP_SLUG, jobId)
        setRunningCount(n => Math.max(0, n - 1))
      }
    }
    for (const j of jobs) {
      if (!aliveForSession(sessionToken)) return
      const card = docCards.find(c => c.id === j.cardId)
      const vs = card?.vsrState
      if (!card || !vs) {
        removePendingJob(j.cardId)
        setRunningCount(n => Math.max(0, n - 1))
        continue
      }
      // 有任务号时列表缺席也直接按号续跑; 列表拉取失败则一律延迟重查, 不标失败;
      // 完全没有 ID 的老记录且本节点仅一条待恢复时, 才用「最新 running」兜底。
      const claimedId = vs.remoteTaskId || j.remoteTaskId
      const decision = matchSpecialRestore(claimedId, items, jobs.length, historyAvailable)
      if (decision.kind === 'resume-exact') {
        await followJob(j, vs, decision.jobId)
        continue
      }
      if (decision.kind === 'await-exact') {
        // 仅因列表没取到才等待: 网络故障不消耗重试机会, 4s 后原样再查
        const retryJob: PendingJobRecord = historyAvailable ? { ...j, __retried: true } : j
        setTimeout(() => {
          if (aliveForSession(sessionToken)) void restoreVsrJobs([retryJob], docCards, sessionToken, { alreadyCounted: true })
        }, 4000)
        continue
      }
      const matched = decision.kind === 'matched' ? decision.item : undefined
      if (matched?.jobId && matched.status === 'running') {
        await followJob(j, vs, matched.jobId)
      } else if (matched?.status === 'success' && matched.resultUrl) {
        const resultUrl = matched.resultUrl
        updateState(j.cardId, {
          jobStatus: 'success',
          resultUrl,
          resultName: resultUrl.split('/').pop()?.split('?')[0] || '高清修复视频.mp4',
          errorMsg: null,
        })
        appendRestoredLog({
          status: 'success',
          platform: logPlatformOf(VSR_APP_SLUG),
          nodeType: '视频修复',
          model: logModelLabel(VSR_APP_SLUG),
          prompt: `视频高清修复 · ${vs.videoName ?? ''}`,
          refs: [],
          refsMedia: vs.videoUrl ? [{ url: vs.videoUrl, kind: 'video' }] : [],
          outputs: [{ url: resultUrl, kind: 'video' }],
          taskId: matched.taskId || matched.jobId,
        })
        void persistRemoteImage(resultUrl, 'video').then((permanent: string) => {
          if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
            const cur = cardsRef.current.find(c => c.id === j.cardId)
            if (cur?.vsrState?.resultUrl === resultUrl) updateState(j.cardId, { resultUrl: permanent })
          }
        })
        removePendingJobByIdentity(j.cardId, VSR_APP_SLUG, matched.taskId || matched.jobId)
        setRunningCount(n => Math.max(0, n - 1))
      } else {
        updateState(j.cardId, { jobStatus: 'failed', errorMsg: '任务在刷新时中断了, 请点击重试' })
        removePendingJob(j.cardId)
        setRunningCount(n => Math.max(0, n - 1))
      }
    }
  }

  return { handleVsrUpload, handleRemoveVsrVideo, handleRunVsr, handleDownloadVsr, restoreVsrJobs }
}
