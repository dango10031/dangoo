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
  DEFAULT_MOTION_PROMPT,
  MOTION_1080P_MAX_SECONDS,
  MOTION_APP_SLUG,
  MOTION_PRICE_TEXT,
  MOTION_USER_PRICE,
  MOTION_VIDEO_MAX_SECONDS,
  motionCameraIntensityOf,
  motionChestOf,
  motionExpressionOf,
  motionIntOf,
  motionPoseIntensityOf,
} from './canvasModels'
import { logModelLabel, logPlatformOf } from './nodeParams'
import type { CanvasCardData, MotionNodeState, PendingJobRecord } from './canvasTypes'
import { SPECIAL_POLL_INTERVAL_MS as POLL_INTERVAL_MS, SPECIAL_POLL_TIMEOUT_MS as POLL_TIMEOUT_MS, type SpecialJobContext } from './specialJobTypes'

/** 媒体上传接口单文件大小上限（与平台媒体接口一致） */
const MOTION_MEDIA_MAX_BYTES = 100 * 1024 * 1024

interface AiAppHistoryItem {
  jobId: string
  taskId?: string
  status: string
  resultUrl?: string
  errorMessage?: string
  created?: string
}

export interface UseMotionNodeOptions {
  job: SpecialJobContext
  /** 专用 AI 应用运行守卫（提交 + 轮询，统一处理登录拦截） */
  runGuarded: typeof callAiAppAndPoll
  /** 计费确认通过后执行任务 */
  runWithCostConfirm: (action: () => void, priceText: string) => void
  /** 写回节点状态 */
  updateState(cardId: string, patch: Partial<MotionNodeState>): void
  /** 登记一条刷新前未完成任务（运行入口用） */
  addPendingJob(cardId: string, promptText: string): void
}

export interface MotionNodeApi {
  handleMotionUpload(cardId: string, slot: 'image' | 'video', file: File | null): Promise<void>
  handleRemoveMotionMedia(cardId: string, slot: 'image' | 'video'): void
  handleRunMotion(cardId: string): void
  handleDownloadMotion(cardId: string): void
  /** 刷新恢复：未完成的动作迁移任务按受理任务 ID 续轮询/收敛 */
  restoreMotionJobs(jobs: PendingJobRecord[], docCards: CanvasCardData[], sessionToken: number): Promise<void>
}

/**
 * 动作迁移节点（Animate V9）：人物参考图 + 动作参考视频 → 跟随动作的新视频。
 * 从 useCanvas 抽出，作业信号/日志/运行计数走 SpecialJobContext，与语音克隆节点同构。
 */
export function useMotionNode(options: UseMotionNodeOptions): MotionNodeApi {
  const { job, runWithCostConfirm, updateState, addPendingJob } = options
  const {
    cardsRef, aliveForSession, beginJobSignal, endJobSignal,
    removePendingJob, removePendingJobByIdentity, rememberPendingTaskId,
    setRunningCount, signalLoginRequired,
    beginSpecialLog, appendRestoredLog,
  } = job

  /** 动作迁移媒体上传：本地即时预览 → 时长校验 → 落永久链接（随画布/模板保存） */
  async function handleMotionUpload(cardId: string, slot: 'image' | 'video', file: File | null) {
    if (!file) return
    const alive = () => !!cardsRef.current.find(c => c.id === cardId)
    if (slot === 'image') {
      const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(file.name)
      if (!isImage) {
        toast.error('请选择图片文件（支持 JPG / PNG / WEBP 等）')
        return
      }
      const localUrl = URL.createObjectURL(file)
      await runSingleMediaUpload(file, 'image', { localUrl }, {
        uploadOne: (f, t) => persistMedia(f, t),
        isAlive: alive,
        onLocal: local => updateState(cardId, { refImageUrl: local.localUrl, refImageName: file.name }),
        onFinal: url => updateState(cardId, { refImageUrl: url, refImageName: file.name }),
        onError: kind => {
          if (kind === 'login') signalLoginRequired()
          else toast.error('图片上传失败, 请重试')
          updateState(cardId, { refImageUrl: undefined, refImageName: undefined })
        },
        revokePreview: local => URL.revokeObjectURL(local.localUrl),
      })
      return
    }

    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv|gif)(\?|$)/i.test(file.name)
    if (!isVideo) {
      toast.error('请选择视频文件（支持 MP4 / WEBM / MOV 等）')
      return
    }
    if (file.size > MOTION_MEDIA_MAX_BYTES) {
      toast.error('视频不能超过 100MB, 请压缩或剪短后再上传')
      return
    }
    const duration = await readVideoDuration(file)
    if (duration !== null && duration > MOTION_VIDEO_MAX_SECONDS) {
      toast.error(`动作视频建议不超过 ${MOTION_VIDEO_MAX_SECONDS} 秒, 当前 ${Math.round(duration)} 秒, 请剪短后再上传`)
      return
    }
    const localUrl = URL.createObjectURL(file)
    await runSingleMediaUpload(file, 'video', { localUrl, duration: duration ?? undefined }, {
      uploadOne: (f, t) => persistMedia(f, t),
      isAlive: alive,
      onLocal: local => updateState(cardId, {
        refVideoUrl: local.localUrl,
        refVideoName: file.name,
        refVideoDuration: local.duration,
      }),
      onFinal: (url, local) => updateState(cardId, {
        refVideoUrl: url,
        refVideoName: file.name,
        refVideoDuration: local.duration,
      }),
      onError: kind => {
        if (kind === 'login') signalLoginRequired()
        else if (file.size > 60 * 1024 * 1024) toast.error('视频过大, 上传失败, 请换一段更小的视频')
        else toast.error('视频上传失败, 请重试')
        updateState(cardId, { refVideoUrl: undefined, refVideoName: undefined, refVideoDuration: undefined })
      },
      revokePreview: local => URL.revokeObjectURL(local.localUrl),
    })
  }

  function handleRemoveMotionMedia(cardId: string, slot: 'image' | 'video') {
    updateState(
      cardId,
      slot === 'image'
        ? { refImageUrl: undefined, refImageName: undefined }
        : { refVideoUrl: undefined, refVideoName: undefined, refVideoDuration: undefined },
    )
  }

  /** 把永久媒体链接拉成 File 并上传给 Animate V9 应用，换回提交用 fileName */
  async function uploadMotionMedia(mediaUrl: string, kind: 'image' | 'video'): Promise<string> {
    const src = mediaSrc(mediaUrl)
    if (!src) throw new Error('missing-media')
    const resp = await fetch(src, { mode: 'cors' })
    if (!resp.ok) throw new Error('media-fetch-failed')
    const blob = await resp.blob()
    if (kind === 'image') {
      const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
      const file = new File([blob], `ref.${ext}`, { type: blob.type || 'image/png' })
      const up = await uploadAiAppMedia(MOTION_APP_SLUG, file, 'image')
      if (!up?.ok || !up.fileName) throw new Error('image-upload-failed')
      return up.fileName
    }
    const ext = blob.type.split('/')[1] || 'mp4'
    const file = new File([blob], `motion.${ext}`, { type: blob.type || 'video/mp4' })
    const up = await uploadAiAppMedia(MOTION_APP_SLUG, file, 'video')
    if (!up?.ok || !up.fileName) throw new Error('video-upload-failed')
    return up.fileName
  }

  /** 提交 + 轮询（单任务），成功写回结果视频并后台转存永久链接 */
  async function runMotionJob(cardId: string) {
    const start = cardsRef.current.find(c => c.id === cardId)?.motionState
    await runSpecialAppJob({
      job,
      cardId,
      slug: MOTION_APP_SLUG,
      nodeType: '动作迁移',
      start,
      outputKind: 'video',
      persistKind: 'video',
      defaultResultName: '动作迁移视频.mp4',
      fallbackErrorText: '媒体上传或生成失败, 请重试',
      signalLoginRequired,
      write: patch => updateState(cardId, patch),
      readResultUrl: () => cardsRef.current.find(c => c.id === cardId)?.motionState?.resultUrl,
      beginLog: () => {
        if (!start) return
        // 动作迁移的引用素材是 1 图 + 1 视频，日志按真实媒体类型渲染（视频不被当破图）
        beginSpecialLog(
          cardId,
          DEFAULT_MOTION_PROMPT,
          [start.refImageUrl, start.refVideoUrl].filter((u): u is string => !!u),
          [
            ...(start.refImageUrl ? [{ url: start.refImageUrl, kind: 'image' as const }] : []),
            ...(start.refVideoUrl ? [{ url: start.refVideoUrl, kind: 'video' as const }] : []),
          ],
        )
      },
      buildBody: async () => {
        const imageFileName = await uploadMotionMedia(start!.refImageUrl as string, 'image')
        const videoFileName = await uploadMotionMedia(start!.refVideoUrl as string, 'video')
        const body: Record<string, unknown> = {
          // 固定参数: 正常模式 / 正常输出 / 自动尺寸
          trueFalse: 'true',
          node571_select: '1',
          node452_value: 'false',
          // 主界面参数
          node566_select: start!.resolution,
          // 高级参数
          node563_select: start!.poseMode,
          node497_value: start!.poseMode === '3' && start!.longNeck ? 'true' : 'false',
          node297_value: String(motionPoseIntensityOf(start!.poseIntensity)),
          node370_value: start!.cameraOn ? 'true' : 'false',
          node361_value: String(motionCameraIntensityOf(start!.cameraIntensity)),
          node271_value: start!.maskHelmet ? 'true' : 'false',
          node265_value: String(motionExpressionOf(start!.expression)),
          node266_value: String(motionChestOf(start!.chest)),
          node499_value: String(motionIntOf(start!.skipFrames, 0, 500, 0)),
          node422_value: String(motionIntOf(start!.frameLimit, 1, 2000, 840)),
          node264_value: String(motionIntOf(start!.frameRate, 1, 60, 30)),
          referenceImage: imageFileName,
          referenceVideo: videoFileName,
        }
        return { body, costText: aiAppCostText(MOTION_USER_PRICE) }
      },
      extractUrl: res => motionVideoUrl(res),
    })
  }

  /** 运行入口：校验输入 → 计费确认 → 提交 */
  function handleRunMotion(cardId: string) {
    const ms = cardsRef.current.find(c => c.id === cardId)?.motionState
    if (!ms) return
    if (ms.jobStatus === 'queued' || ms.jobStatus === 'running') return
    if (!ms.refImageUrl) {
      toast.error('请先上传人物参考图')
      return
    }
    if (!ms.refVideoUrl) {
      toast.error('请先上传动作参考视频')
      return
    }
    if (ms.resolution === '3' && typeof ms.refVideoDuration === 'number' && ms.refVideoDuration > MOTION_1080P_MAX_SECONDS) {
      toast.error(`1080P 建议视频不超过 ${MOTION_1080P_MAX_SECONDS} 秒, 请换 720P 或把视频剪短`)
      return
    }
    runWithCostConfirm(() => {
      updateState(cardId, { jobStatus: 'queued', errorMsg: null, resultUrl: undefined })
      addPendingJob(cardId, `动作迁移 · ${ms.refVideoName ?? ''}`.slice(0, 80))
      setRunningCount(n => n + 1)
      void runMotionJob(cardId)
    }, `运行动作迁移 1 次 · ${MOTION_PRICE_TEXT}`)
  }

  function handleDownloadMotion(cardId: string) {
    const ms = cardsRef.current.find(c => c.id === cardId)?.motionState
    if (ms?.resultUrl) void downloadAigcResult(ms.resultUrl, ms.resultName)
  }

  async function restoreMotionJobs(
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
        `/api/aigc/ai-app/${MOTION_APP_SLUG}/history`,
        { page: 1, perPage: 30 },
      )
      items = r.items ?? []
    } catch {
      historyAvailable = false
    }
    // 按受理任务号直接续轮询(列表缺席/在 30 条之外都不影响), 终态写回/日志/转存后按号清理
    async function followJob(j: PendingJobRecord, ms: MotionNodeState, jobId: string) {
      updateState(j.cardId, { jobStatus: 'running', remoteTaskId: jobId })
      rememberPendingTaskId(j.cardId, MOTION_APP_SLUG, jobId)
      try {
      const motionSignal = beginJobSignal()
      const res = await resumeAiAppJob(MOTION_APP_SLUG, { jobId }, { pollIntervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_TIMEOUT_MS, signal: motionSignal })
      endJobSignal(motionSignal)
      if (!aliveForSession(sessionToken) || res.error?.code === 'ABORTED') return
      if (res.state === 'succeeded' || res.state === 'partial') {
        const url = motionVideoUrl(res)
        updateState(j.cardId, { jobStatus: 'success', resultUrl: url, resultName: url.split('/').pop()?.split('?')[0] || '动作迁移视频.mp4', errorMsg: null })
        appendRestoredLog({
          status: 'success',
          platform: logPlatformOf(MOTION_APP_SLUG),
          nodeType: '动作迁移',
          model: logModelLabel(MOTION_APP_SLUG),
          prompt: DEFAULT_MOTION_PROMPT,
          refs: [],
          refsMedia: [
            ...(ms.refImageUrl ? [{ url: ms.refImageUrl, kind: 'image' as const }] : []),
            ...(ms.refVideoUrl ? [{ url: ms.refVideoUrl, kind: 'video' as const }] : []),
          ],
          outputs: url ? [{ url, kind: 'video' }] : [],
          taskId: res.job?.taskId || jobId,
          costText: aiAppCostText(MOTION_USER_PRICE),
        })
        if (url) {
          const resultUrl = url
          void persistRemoteImage(resultUrl, 'video').then((permanent: string) => {
            if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
              const cur = cardsRef.current.find(c => c.id === j.cardId)
              if (cur?.motionState?.resultUrl === resultUrl) updateState(j.cardId, { resultUrl: permanent })
            }
          })
        }
      } else {
        if (res.error?.code === 'RH_LOGIN_REQUIRED') signalLoginRequired()
        const resumeMotionError = formatAiAppFailureMessage(res)
        updateState(j.cardId, { jobStatus: 'failed', errorMsg: resumeMotionError })
        appendRestoredLog({
          status: 'failed',
          platform: logPlatformOf(MOTION_APP_SLUG),
          nodeType: '动作迁移',
          model: logModelLabel(MOTION_APP_SLUG),
          prompt: DEFAULT_MOTION_PROMPT,
          refs: [],
          refsMedia: [
            ...(ms.refImageUrl ? [{ url: ms.refImageUrl, kind: 'image' as const }] : []),
            ...(ms.refVideoUrl ? [{ url: ms.refVideoUrl, kind: 'video' as const }] : []),
          ],
          errorMsg: resumeMotionError,
          taskId: jobId,
        })
      }
      } catch {
        if (aliveForSession(sessionToken)) updateState(j.cardId, { jobStatus: 'failed', errorMsg: '生成失败, 请重试' })
      } finally {
        // compare-and-delete: 只删同卡同渠道同任务号; 旧会话轮询退出不碰新画布待办
        if (aliveForSession(sessionToken)) removePendingJobByIdentity(j.cardId, MOTION_APP_SLUG, jobId)
        setRunningCount(n => Math.max(0, n - 1))
      }
    }
    for (const j of jobs) {
      if (!aliveForSession(sessionToken)) return
      const card = docCards.find(c => c.id === j.cardId)
      const ms = card?.motionState
      if (!card || !ms) {
        removePendingJob(j.cardId)
        setRunningCount(n => Math.max(0, n - 1))
        continue
      }
      // 有任务号时列表缺席也直接按号续跑; 列表拉取失败则一律延迟重查, 不标失败;
      // 完全没有 ID 的老记录且本节点仅一条待恢复时, 才用「最新 running」兜底。
      const claimedId = ms.remoteTaskId || j.remoteTaskId
      const decision = matchSpecialRestore(claimedId, items, jobs.length, historyAvailable)
      if (decision.kind === 'resume-exact') {
        await followJob(j, ms, decision.jobId)
        continue
      }
      if (decision.kind === 'await-exact') {
        // 仅因列表没取到才等待: 网络故障不消耗重试机会, 4s 后原样再查
        const retryJob: PendingJobRecord = historyAvailable ? { ...j, __retried: true } : j
        setTimeout(() => {
          if (aliveForSession(sessionToken)) void restoreMotionJobs([retryJob], docCards, sessionToken, { alreadyCounted: true })
        }, 4000)
        continue
      }
      const matched = decision.kind === 'matched' ? decision.item : undefined
      if (matched?.jobId && matched.status === 'running') {
        await followJob(j, ms, matched.jobId)
      } else if (matched?.status === 'success' && matched.resultUrl) {
        const resultUrl = matched.resultUrl
        updateState(j.cardId, {
          jobStatus: 'success',
          resultUrl,
          resultName: resultUrl.split('/').pop()?.split('?')[0] || '动作迁移视频.mp4',
          errorMsg: null,
        })
        appendRestoredLog({
          status: 'success',
          platform: logPlatformOf(MOTION_APP_SLUG),
          nodeType: '动作迁移',
          model: logModelLabel(MOTION_APP_SLUG),
          prompt: DEFAULT_MOTION_PROMPT,
          refs: [],
          refsMedia: [
            ...(ms.refImageUrl ? [{ url: ms.refImageUrl, kind: 'image' as const }] : []),
            ...(ms.refVideoUrl ? [{ url: ms.refVideoUrl, kind: 'video' as const }] : []),
          ],
          outputs: [{ url: resultUrl, kind: 'video' }],
          taskId: matched.taskId || matched.jobId,
        })
        void persistRemoteImage(resultUrl, 'video').then((permanent: string) => {
          if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
            const cur = cardsRef.current.find(c => c.id === j.cardId)
            if (cur?.motionState?.resultUrl === resultUrl) updateState(j.cardId, { resultUrl: permanent })
          }
        })
        removePendingJobByIdentity(j.cardId, MOTION_APP_SLUG, matched.taskId || matched.jobId)
        setRunningCount(n => Math.max(0, n - 1))
      } else {
        updateState(j.cardId, { jobStatus: 'failed', errorMsg: '任务在刷新时中断了, 请点击重试' })
        removePendingJob(j.cardId)
        setRunningCount(n => Math.max(0, n - 1))
      }
    }
  }

  return { handleMotionUpload, handleRemoveMotionMedia, handleRunMotion, handleDownloadMotion, restoreMotionJobs }
}
