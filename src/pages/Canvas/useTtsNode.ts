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
import { persistRemoteImage } from './canvasUtils'
import { aiAppCostText } from './canvasCostText'
import {
  TTS_APP_SLUG,
  TTS_PRICE_TEXT,
  TTS_USER_PRICE,
  ttsIntensityOf,
  ttsRateOf,
} from './canvasModels'
import type { CanvasCardData, PendingJobRecord, TtsNodeState } from './canvasTypes'
import { ttsAudioUrl } from './canvasMediaUrl'
import { logModelLabel, logPlatformOf } from './nodeParams'
import { SPECIAL_POLL_INTERVAL_MS as POLL_INTERVAL_MS, SPECIAL_POLL_TIMEOUT_MS as POLL_TIMEOUT_MS, type SpecialJobContext } from './specialJobTypes'

interface AiAppHistoryItem {
  jobId: string
  taskId?: string
  status: string
  resultUrl?: string
  errorMessage?: string
  created?: string
}

export interface UseTtsNodeOptions {
  job: SpecialJobContext
  /** 专用 AI 应用运行守卫（提交 + 轮询，统一处理登录拦截） */
  runGuarded: typeof callAiAppAndPoll
  /** 计费确认通过后执行任务 */
  runWithCostConfirm: (action: () => void, priceText: string) => void
  /** 写回节点状态 */
  updateState(cardId: string, patch: Partial<TtsNodeState>): void
  /** 登记一条刷新前未完成任务（运行入口用） */
  addPendingJob(cardId: string, promptText: string): void
}

export interface TtsNodeApi {
  handleTtsUpload(cardId: string, slot: 'clone' | 'emotion', file: File | null): Promise<void>
  handleRemoveTtsAudio(cardId: string, slot: 'clone' | 'emotion'): void
  handleRunTts(cardId: string): void
  handleDownloadTts(cardId: string): void
  /** 刷新恢复：未完成的语音克隆任务按受理任务 ID 续轮询/收敛 */
  restoreTtsJobs(jobs: PendingJobRecord[], docCards: CanvasCardData[], sessionToken: number): Promise<void>
}

/**
 * 语音克隆节点（IndexTTS 2）：上传克隆人声（可选自定义情绪参考）+ 文本 → 克隆语音。
 * 从 useCanvas 抽出，作业信号/日志/运行计数走 SpecialJobContext，节点自身不持有画布状态。
 */
export function useTtsNode(options: UseTtsNodeOptions): TtsNodeApi {
  const { job, runWithCostConfirm, updateState, addPendingJob } = options
  const {
    cardsRef, aliveForSession, beginJobSignal, endJobSignal,
    removePendingJob, removePendingJobByIdentity, rememberPendingTaskId,
    setRunningCount, signalLoginRequired,
    beginSpecialLog, appendRestoredLog,
  } = job

  /** 音频上传：本地即时预览 → 落永久链接（随画布/模板保存） */
  async function handleTtsUpload(cardId: string, slot: 'clone' | 'emotion', file: File | null) {
    if (!file) return
    const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(file.name)
    if (!isAudio) {
      toast.error('请选择音频文件（支持 MP3 / WAV / M4A 等）')
      return
    }
    const localUrl = URL.createObjectURL(file)
    const localName = file.name
    const localPatch = (audioUrl: string | undefined): Partial<TtsNodeState> =>
      slot === 'clone'
        ? { cloneAudioUrl: audioUrl, cloneAudioName: localName }
        : { emotionRefAudioUrl: audioUrl, emotionRefAudioName: localName }
    await runSingleMediaUpload(file, 'audio', { localUrl, localName }, {
      uploadOne: (f, t) => persistMedia(f, t),
      isAlive: () => !!cardsRef.current.find(c => c.id === cardId),
      onLocal: local => updateState(cardId, localPatch(local.localUrl)),
      onFinal: (url, _local) => updateState(cardId, localPatch(url)),
      onError: kind => {
        if (kind === 'login') signalLoginRequired()
        else toast.error('音频上传失败, 请重试')
        updateState(cardId, localPatch(undefined))
      },
      revokePreview: local => URL.revokeObjectURL(local.localUrl),
    })
  }

  function handleRemoveTtsAudio(cardId: string, slot: 'clone' | 'emotion') {
    updateState(cardId, slot === 'clone'
      ? { cloneAudioUrl: undefined, cloneAudioName: undefined }
      : { emotionRefAudioUrl: undefined, emotionRefAudioName: undefined })
  }

  /** 把永久音频链接拉成 File 并上传给 IndexTTS 2 应用，换回提交用 fileName */
  async function uploadTtsAudio(audioUrl: string): Promise<string> {
    const src = mediaSrc(audioUrl)
    if (!src) throw new Error('missing-audio')
    const resp = await fetch(src, { mode: 'cors' })
    if (!resp.ok) throw new Error('audio-fetch-failed')
    const blob = await resp.blob()
    const ext = blob.type.split('/')[1]?.replace('mpeg', 'mp3') || 'mp3'
    const file = new File([blob], `voice.${ext}`, { type: blob.type || 'audio/mpeg' })
    const up = await uploadAiAppMedia(TTS_APP_SLUG, file, 'audio')
    if (!up?.ok || !up.fileName) throw new Error('audio-upload-failed')
    return up.fileName
  }

  /** 提交 + 轮询（单任务），成功写回结果音频并后台转存永久链接 */
  async function runTtsJob(cardId: string) {
    const start = cardsRef.current.find(c => c.id === cardId)?.ttsState
    await runSpecialAppJob({
      job,
      cardId,
      slug: TTS_APP_SLUG,
      nodeType: '语音克隆',
      start,
      outputKind: 'audio',
      persistKind: 'audio',
      defaultResultName: '克隆语音.mp3',
      fallbackErrorText: '音频上传或生成失败, 请重试',
      signalLoginRequired,
      write: patch => updateState(cardId, patch),
      readResultUrl: () => cardsRef.current.find(c => c.id === cardId)?.ttsState?.resultUrl,
      beginLog: () => start && beginSpecialLog(cardId, start.text, [], []),
      buildBody: async () => {
        // 克隆人声/情绪参考是音频，日志不展示「参考图」行（请求参数详情里仍可查看文件名）
        const cloneFileName = await uploadTtsAudio(start!.cloneAudioUrl as string)
        let emotionFileName: string | undefined
        if (start!.emotionMode === '8' && start!.emotionRefAudioUrl) {
          emotionFileName = await uploadTtsAudio(start!.emotionRefAudioUrl)
        }
        const body: Record<string, unknown> = {
          node174_select: start!.emotionMode,
          node185_value: String(ttsIntensityOf(start!.emotionIntensity)),
          node187_value: String(ttsRateOf(start!.speechRate)),
          referenceAudio: cloneFileName,
          text: start!.text,
        }
        // 仅自定义情绪模式提交情绪参考音频，其他模式不传该字段
        if (emotionFileName) body.referenceAudio2 = emotionFileName
        return { body, costText: aiAppCostText(TTS_USER_PRICE) }
      },
      extractUrl: res => ttsAudioUrl(res),
    })
  }

  /** 运行入口：校验输入 → 计费确认 → 提交 */
  function handleRunTts(cardId: string) {
    const ts = cardsRef.current.find(c => c.id === cardId)?.ttsState
    if (!ts) return
    if (ts.jobStatus === 'queued' || ts.jobStatus === 'running') return
    if (!ts.cloneAudioUrl) {
      toast.error('请先上传要克隆的人声')
      return
    }
    if (!ts.text.trim()) {
      toast.error('请输入想让克隆声音朗读的文本')
      return
    }
    if (ts.emotionMode === '8' && !ts.emotionRefAudioUrl) {
      toast.error('自定义情绪需要上传一段情绪参考音频，或改用其他情绪模式')
      return
    }
    runWithCostConfirm(() => {
      updateState(cardId, { jobStatus: 'queued', errorMsg: null, resultUrl: undefined })
      addPendingJob(cardId, ts.text.slice(0, 80))
      setRunningCount(n => n + 1)
      void runTtsJob(cardId)
    }, `运行语音克隆 1 次 · ${TTS_PRICE_TEXT}`)
  }

  function handleDownloadTts(cardId: string) {
    const ts = cardsRef.current.find(c => c.id === cardId)?.ttsState
    if (ts?.resultUrl) void downloadAigcResult(ts.resultUrl, ts.resultName)
  }

  async function restoreTtsJobs(
    jobs: PendingJobRecord[],
    docCards: CanvasCardData[],
    sessionToken: number,
    opts?: { alreadyCounted?: boolean },
  ) {
    if (!jobs.length) return
    // 延迟重查是同一笔任务的再认领, 计数已在首次计入, 不重复 +1
    if (!opts?.alreadyCounted) setRunningCount(n => n + jobs.length)
    let items: AiAppHistoryItem[] = []
    // 列表是否真的取到: 网络失败为 false, 空列表不等于「任务不存在」, 只能等重查
    let historyAvailable = true
    try {
      const r = await callAiApp<{ ok: boolean; items?: AiAppHistoryItem[] }>(
        `/api/aigc/ai-app/${TTS_APP_SLUG}/history`,
        { page: 1, perPage: 30 },
      )
      items = r.items ?? []
    } catch {
      historyAvailable = false
    }
    // 按受理任务号直接续轮询(列表缺席/在 30 条之外都不影响), 终态写回/日志/转存后按号清理
    async function followJob(j: PendingJobRecord, ts: TtsNodeState, jobId: string) {
      updateState(j.cardId, { jobStatus: 'running', remoteTaskId: jobId })
      rememberPendingTaskId(j.cardId, TTS_APP_SLUG, jobId)
      try {
        const ttsSignal = beginJobSignal()
        const res = await resumeAiAppJob(TTS_APP_SLUG, { jobId }, { pollIntervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_TIMEOUT_MS, signal: ttsSignal })
        endJobSignal(ttsSignal)
        if (!aliveForSession(sessionToken) || res.error?.code === 'ABORTED') return
        if (res.state === 'succeeded' || res.state === 'partial') {
          const url = ttsAudioUrl(res)
          updateState(j.cardId, { jobStatus: 'success', resultUrl: url, resultName: url.split('/').pop()?.split('?')[0] || '克隆语音.mp3', errorMsg: null })
          appendRestoredLog({
            status: 'success',
            platform: logPlatformOf(TTS_APP_SLUG),
            nodeType: '语音克隆',
            model: logModelLabel(TTS_APP_SLUG),
            prompt: ts.text,
            refs: [],
            refsMedia: [],
            outputs: url ? [{ url, kind: 'audio' }] : [],
            taskId: res.job?.taskId || jobId,
            costText: aiAppCostText(TTS_USER_PRICE),
          })
          if (url) {
            const resultUrl = url
            void persistRemoteImage(resultUrl, 'audio').then((permanent: string) => {
              if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
                const cur = cardsRef.current.find(c => c.id === j.cardId)
                if (cur?.ttsState?.resultUrl === resultUrl) updateState(j.cardId, { resultUrl: permanent })
              }
            })
          }
        } else {
          if (res.error?.code === 'RH_LOGIN_REQUIRED') signalLoginRequired()
          const resumeTtsError = formatAiAppFailureMessage(res)
          updateState(j.cardId, { jobStatus: 'failed', errorMsg: resumeTtsError })
          appendRestoredLog({
            status: 'failed',
            platform: logPlatformOf(TTS_APP_SLUG),
            nodeType: '语音克隆',
            model: logModelLabel(TTS_APP_SLUG),
            prompt: ts.text,
            refs: [],
            refsMedia: [],
            errorMsg: resumeTtsError,
            taskId: jobId,
          })
        }
      } catch {
        if (aliveForSession(sessionToken)) updateState(j.cardId, { jobStatus: 'failed', errorMsg: '生成失败, 请重试' })
      } finally {
        // compare-and-delete: 只删同卡同渠道同任务号; 旧会话轮询退出不碰新画布待办
        if (aliveForSession(sessionToken)) job.removePendingJobByIdentity(j.cardId, TTS_APP_SLUG, jobId)
        setRunningCount(n => Math.max(0, n - 1))
      }
    }
    for (const j of jobs) {
      if (!aliveForSession(sessionToken)) return
      const card = docCards.find(c => c.id === j.cardId)
      const ts = card?.ttsState
      if (!card || !ts) {
        removePendingJob(j.cardId)
        setRunningCount(n => Math.max(0, n - 1))
        continue
      }
      // 认领顺序：卡片上已持久化的受理任务 ID（最可靠）→ pending 记录里的 ID；
      // 有 ID 时列表缺席也直接按号续跑；列表拉取失败则一律延迟重查, 不标失败;
      // 完全没有 ID 的老记录且本节点只有一条待恢复时, 才用「最新 running」兜底。
      const claimedId = ts.remoteTaskId || j.remoteTaskId
      const decision = matchSpecialRestore(claimedId, items, jobs.length, historyAvailable)
      if (decision.kind === 'resume-exact') {
        await followJob(j, ts, decision.jobId)
        continue
      }
      if (decision.kind === 'await-exact') {
        // 仅因列表没取到才等待: 网络故障不消耗重试机会, 4s 后原样再查(可能连断数分钟)
        const retryJob: PendingJobRecord = historyAvailable ? { ...j, __retried: true } : j
        setTimeout(() => {
          if (aliveForSession(sessionToken)) void restoreTtsJobs([retryJob], docCards, sessionToken, { alreadyCounted: true })
        }, 4000)
        continue
      }
      const matched = decision.kind === 'matched' ? decision.item : undefined
      if (matched?.jobId && matched.status === 'running') {
        await followJob(j, ts, matched.jobId)
      } else if (matched?.status === 'success' && matched.resultUrl) {
        const resultUrl = matched.resultUrl
        updateState(j.cardId, {
          jobStatus: 'success',
          resultUrl,
          resultName: resultUrl.split('/').pop()?.split('?')[0] || '克隆语音.mp3',
          errorMsg: null,
        })
        const refs = [ts.cloneAudioUrl, ts.emotionRefAudioUrl].filter((u): u is string => !!u)
        appendRestoredLog({
          status: 'success',
          platform: logPlatformOf(TTS_APP_SLUG),
          nodeType: '语音克隆',
          model: logModelLabel(TTS_APP_SLUG),
          prompt: ts.text,
          refs,
          outputs: [{ url: resultUrl, kind: 'audio' }],
          taskId: matched.taskId || matched.jobId,
        })
        void persistRemoteImage(resultUrl, 'audio').then((permanent: string) => {
          if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
            const cur = cardsRef.current.find(c => c.id === j.cardId)
            if (cur?.ttsState?.resultUrl === resultUrl) updateState(j.cardId, { resultUrl: permanent })
          }
        })
        removePendingJobByIdentity(j.cardId, TTS_APP_SLUG, matched.taskId || matched.jobId)
        setRunningCount(n => Math.max(0, n - 1))
      } else {
        updateState(j.cardId, { jobStatus: 'failed', errorMsg: '任务在刷新时中断了, 请点击重试' })
        removePendingJob(j.cardId)
        setRunningCount(n => Math.max(0, n - 1))
      }
    }
  }

  return { handleTtsUpload, handleRemoveTtsAudio, handleRunTts, handleDownloadTts, restoreTtsJobs }
}

