import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  callAigcAndPoll,
  resumeAigcJob,
  formatAigcFailureMessage,
  loadAigcHistory,
  getAigcModelInfo,
  downloadAigcResult,
  callAiApp,
  callAiAppAndPoll,
  resumeAiAppJob,
  uploadAiAppMedia,
  formatAiAppFailureMessage,
} from '@/lib/aigc'
import type { AigcModelInfo, AigcHistoryItem, AigcResult, AiAppRunResponse } from '@/lib/aigc'
import { callLlmWithFallback } from '@/lib/llm'
import type { LlmContentPart, LlmMessage, LlmCallResult } from '@/lib/llm'
import { persistMedia, toRhMediaUrl, toRhMediaUrls, isPersistedMediaUrl, isDurableOutputMediaUrl, mediaSrc, canonicalMediaPath, getMediaUploadInflight } from '@/lib/media'
import {
  detectAssistant,
  importToAdobe,
  importToJianying,
  assistantErrorText,
  type AdobeApplication,
  type AssistantHealth,
} from '@/lib/desktopAssistant'
import { classifyIncomingFiles, isImageFile, isSupportedCanvasImageFile, unsupportedImageToast } from '@/lib/dropFiles'
import {
  getLocalAccount,
  onLocalAccountChange,
  type LocalAccount,
} from '@/lib/localAuth'
import { getAuthHeaders } from '@/lib/auth'
import {
  putLocalSnapshot,
  clearLocalSnapshot,
  listStaleSnapshots,
  deleteStaleSnapshot,
  pruneExpiredSnapshots,
  putConflictBackup,
  takeConflictBackup,
  canvasContentFingerprint,
  type LocalCanvasSnapshot,
} from '@/lib/canvasLocalSnapshot'
import { acquireCloudSlot, tryAcquireCloudSlot } from '@/lib/cloudSaveQueue'
import { postCanvasMessage, onCanvasMessage } from '@/lib/canvasBroadcast'
import { loadImageNatural, sha256Hex, computePaddedRect, extractPatchCanvas, mergePatchesCanvas } from '@/components/canvas/imageEdit/localPatch'
import type { CropContext } from '@/components/canvas/imageEdit/localPatch'
export type { CropContext } from '@/components/canvas/imageEdit/localPatch'
import { useCostConfirm } from '@/hooks/useCostConfirm'
import { getPocketBaseUrl } from '@/lib/pb'
import { loadImageDims, preloadLod, primeLod } from '@/components/canvas/useLod'
import { GeometryRegistry, ViewportProbe } from '@/components/canvas/canvasRuntime'
import {
  AI_APP_FIRST_FRAME_KEY,
  AI_APP_LONG_EDGE_DEFAULT,
  AI_APP_FRAMES_DEFAULT,
  aiAppLongEdgeOf,
  aiAppFramesOf,
  VSR_APP_SLUG,
  VSR_HQ_MAX_SECONDS,
  vsrPriceOf,
  vsrResolutionOf,
  ALL_VIDEO_MODELS,
  CHANNEL_FAMILIES,
  DEFAULT_MOTION_PROMPT,
  I2I_MODELS,
  I2V_MODELS,
  LEGACY_VIDEO_SLUG_MAP,
  MULTIMODAL_VIDEO_MODEL,
  POLISH_LLM_OPTIONS,
  REP_PANEL_POLISH_MODEL,
  REP_VISION_MODEL,
  T2I_PRICE_MAP,
  IMAGE_USER_PRICE,
  imageMinPrice,
  T2I_MODELS,
  T2V_MODELS,
  VIDEO_PRICE_MAP,
  VIDEO_FLAT_USER_PRICE,
  userRunPrice,
  VISION_LLM_OPTIONS,
  AI_APP_USER_PRICE,
  TTS_APP_SLUG,
  TTS_USER_PRICE,
  TTS_PRICE_TEXT,
  ttsIntensityOf,
  ttsRateOf,
  MOTION_APP_SLUG,
  MOTION_USER_PRICE,
  MOTION_PRICE_TEXT,
  MOTION_VIDEO_MAX_SECONDS,
  MOTION_1080P_MAX_SECONDS,
  motionPoseIntensityOf,
  motionCameraIntensityOf,
  motionExpressionOf,
  motionChestOf,
  motionIntOf,
  aiAppSlugOf,
  channelFamilyOf,
  defaultGenParams,
  defaultImageGenParams,
  modelKindOf,
  resolveRunModel,
  videoBasePrice,
  supportsTransparentBg,
  TRANSPARENT_BG_PROMPT_PREFIX,
} from './canvasModels'
import {
  REP_DIRECTOR_SYSTEM_PROMPT,
  buildRepDirectorUserText,
  buildRepVisionPrompt,
  parseRepDirectorOutput,
} from './repPrompt'
import {
  FOLD_TYPE_LABELS,
  REP_SLOTS,
  defaultAgentState,
  defaultLayerState,
  defaultLoopState,
  defaultMergeState,
  defaultPolishState,
  defaultRepState,
  defaultTtsState,
  defaultMotionState,
  defaultVsrState,
  foldPanelCount,
  foldPanelRoles,
  foldSpecText,
} from './canvasTypes'
import type {
  AgentNodeState,
  AssetItem,
  CardJobStatus,
  CardKind,
  CanvasCardData,
  CanvasConnection,
  CanvasDoc,
  CanvasViewport,
  ConnectionDraft,
  ConnectionSide,
  FoldType,
  GenLogEntry,
  GenLogOutput,
  GenNodeParams,
  GenerateResultItem,
  GlobalAssetFolder,
  ImageEditGridPart,
  JobSpec,
  LayerStage,
  LayerItem,
  LayerNodeState,
  LoopNodeState,
  MarqueeRect,
  ModelKind,
  PendingJobRecord,
  ProjectAssetFolder,
  ProjectAssetItem,
  ProjectAssets,
  ProjectAssetKind,
  ProjectAssetMember,
  RepStage,
  RepNodeState,
  RepSlot,
  StageGesture,
  TtsNodeState,
  MotionNodeState,
  VsrNodeState,
  WorkflowDoc,
} from './canvasTypes'
import {
  cutoutWhiteBackground,
  downloadDataUrl,
  fileToDataUrl,
  inheritCropContext,
  llmErrorText,
  parseLooseJsonArray,
  persistRemoteImage,
  runPool,
  uid,
  urlToDataUrl,
} from './canvasUtils'
import {
  ASSET_DND_CARD,
  ASSET_DND_ENTRY,
  cardMediaOf,
  globalEntryOf,
  isImageAssetKind,
  parseAssetDnd,
  projectEntryOf,
  type AssetLibEntry,
} from '@/components/canvas/asset-library/assetLib'
import {
  buildWorkflowSelection,
  collectWorkflowMediaUrls,
  probeImageAccessible,
  rebuildWorkflow,
  replaceWorkflowUrlsDeep,
  serializeWorkflow,
  workflowCoverOf,
} from '@/components/canvas/asset-library/workflowLib'
import {
  DEFAULT_CAMERA_CONFIG,
  buildCameraPromptFromConfig,
  cameraTitleFromLetter,
  loadCameraDefault,
  nextCameraLetter,
  sanitizeCameraConfig,
  type CameraConfig,
} from './cameraModel'
import { useGlobalTags } from '@/components/canvas/tags/useGlobalTags'
import { LEGACY_PIN_MAP } from '@/components/canvas/tags/tagModel'

/** 共享空数组: 派生索引未命中时返回它, 避免每次查询新建数组引发下游无谓重渲染 */
const EMPTY_STRINGS: readonly string[] = []
const POLL_INTERVAL_MS = 3500
const POLL_TIMEOUT_MS = 3600000
// 批量生成并发上限: 浏览器同域连接池仅 6 路, 500 个任务同时发只会排队抖动并打爆后端,
// 6 路打满连接池、后续任务排队进池即可; 轮询本就 3.5s 一次, 排队代价远小于瞬时洪峰。
const BATCH_CONCURRENCY = 6
const CANVASES_API = `${getPocketBaseUrl()}/api/canvases`
const ASSETS_API = `${getPocketBaseUrl()}/api/assets`
const ASSET_FOLDERS_API = `${getPocketBaseUrl()}/api/asset_folders`
// 画布内复制卡片后写入系统剪贴板的标记: 让随后的粘贴事件识别为「画布卡片粘贴」而非外部图片
const CANVAS_CLIP_MARKER = 'dangoo-canvas-clipboard'
const LOOP_BATCH_SIZE = 9
// 失败主动重试退避(毫秒): 1s→3s→10s→30s→60s 封顶, 实际值再加 ±20% 抖动避免多标签齐发
const RETRY_BACKOFF_MS = [1000, 3000, 10000, 30000, 60000]
// keepalive fetch 浏览器上限 64KB, 留余量: 全量保存体超过该值在卸载路径不强发(本地盘已有快照)
const KEEPALIVE_BODY_LIMIT = 60_000

/** 同步短哈希(cyrb53): 为全量保存体生成幂等指纹, 同内容重试复用同一幂等键 */
function cyrb53Hex(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const h = (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
  return h.padStart(14, '0')
}

/**
 * 当前标签页会话标识: 用 sessionStorage 存, 复制标签页会被浏览器复制一份旧值,
 * 启动时发现键已存在即换发新 id。本地快照按「画布 id + 会话 id」分键,
 * 因此同一浏览器多个标签同时编辑同一画布也不会互踩兜底快照。
 */
function currentSessionId(): string {
  try {
    const KEY = 'rh-canvas-session'
    const existing = sessionStorage.getItem(KEY)
    if (existing) return existing
    const id =
      (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    sessionStorage.setItem(KEY, id)
    return id
  } catch {
    return `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

/**
 * 工作流重建后: 给摄影机卡按当前画布与本批内已用字母重新命名,
 * 并把绑定到它们的生成节点快照名同步成新名。
 */
function renameRebuiltCameras(rebuiltCards: CanvasCardData[], existingTitles: Iterable<string>): void {
  const usedLetters = new Set<string>()
  for (const title of existingTitles) {
    const m = /^摄影机([A-Z])$/.exec(title.trim())
    if (m) usedLetters.add(m[1])
  }
  const newNameById = new Map<string, string>()
  rebuiltCards
    .filter(c => c.kind === 'camera')
    .forEach(cam => {
      // 原工作流名若不与画布/本批冲突就沿用, 否则取下一个空字母
      const m = /^摄影机([A-Z])$/.exec((cam.title ?? '').trim())
      let letter = m && !usedLetters.has(m[1]) ? m[1] : null
      if (!letter) {
        for (let code = 65; code <= 90; code += 1) {
          const l = String.fromCharCode(code)
          if (!usedLetters.has(l)) {
            letter = l
            break
          }
        }
      }
      letter = letter ?? 'Z'
      usedLetters.add(letter)
      const title = cameraTitleFromLetter(letter)
      cam.title = title
      newNameById.set(cam.id, title)
    })
  rebuiltCards.forEach(card => {
    if (card.kind !== 'generate' || !card.cameraNodeId || !card.cameraSnapshot) return
    const newName = newNameById.get(card.cameraNodeId)
    if (newName) card.cameraSnapshot = { ...card.cameraSnapshot, name: newName }
  })
}

export * from './canvasModels'
export * from './canvasTypes'

export function useCanvas() {
  const { id: canvasId } = useParams()

  // --- 画布文档 ---
  const [docLoaded, setDocLoaded] = useState(false)
  const [canvasTitle, setCanvasTitle] = useState('未命名画布')
  const [cards, setCards] = useState<CanvasCardData[]>([])
  const [viewport, setViewportState] = useState<CanvasViewport>({ x: 80, y: 80, scale: 1 })
  // viewportRef 始终持有最新视图; 拖动/滚轮平移时直接改 transform 的快速路径读它, 不走 React 渲染
  const viewportRef = useRef(viewport)
  // 最近一次已提交视图的位置: 快速平移按它算位移阈值, 任何视图变更(缩放/适应内容/提交)都经统一入口刷新
  const panCommitRef = useRef({ x: viewport.x, y: viewport.y })
  const contentRef = useRef<HTMLDivElement | null>(null)
  const marqueeLayerRef = useRef<HTMLDivElement | null>(null)
  // 拉线草稿的常驻 SVG path: 跟鼠标期间直接写 d 属性(同框选层), 坐标变化零 React 提交;
  // connectionDraft 只保留起点/悬停槽等低频信息
  const draftPathRef = useRef<SVGPathElement | null>(null)
  const [spacePanning, setSpacePanning] = useState(false)
  const spaceRef = useRef(false)
  // 卡片手动双击检测(原生 dblclick 被指针捕获破坏时兜底): 记录上次按下的卡与时间
  const cardTapRef = useRef<{ id: string; t: number }>({ id: '', t: 0 })
  // 手动双击触发预览/展开后, 抑制随之落到舞台的原生 dblclick
  const suppressStageDblRef = useRef(false)
  // 几何注册表: 一个 ResizeObserver + React 提交后同步, 观测全部卡片位置/尺寸
  const geometryRef = useRef<GeometryRegistry>(undefined as unknown as GeometryRegistry)
  if (!geometryRef.current) geometryRef.current = new GeometryRegistry()
  // 视口探测器: 维护屏幕视口↔画布坐标可见矩形, 供卡片两级挂载/连线裁剪/近场预热
  const probeRef = useRef<ViewportProbe>(undefined as unknown as ViewportProbe)
  if (!probeRef.current) probeRef.current = new ViewportProbe()

  /** 统一的视图状态入口: 同步 ref + 直接写变换层 DOM(平移快速路径后提交状态也一致) */
  const applyContentTransform = useCallback((v: CanvasViewport) => {
    const el = contentRef.current
    if (el) el.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`
  }, [])

  const setViewport = useCallback((next: CanvasViewport | ((prev: CanvasViewport) => CanvasViewport)) => {
    const resolved = typeof next === 'function' ? (next as (prev: CanvasViewport) => CanvasViewport)(viewportRef.current) : next
    viewportRef.current = resolved
    panCommitRef.current = { x: resolved.x, y: resolved.y }
    setViewportState(resolved)
    applyContentTransform(resolved)
  }, [applyContentTransform])
  /** 框选矩形直接写样式层, 拖动过程零 React 渲染 */
  function paintMarqueeLayer(rect: MarqueeRect | null) {
    const el = marqueeLayerRef.current
    if (!el) return
    if (!rect) {
      el.style.display = 'none'
      return
    }
    el.style.display = 'block'
    el.style.left = `${rect.x}px`
    el.style.top = `${rect.y}px`
    el.style.width = `${rect.w}px`
    el.style.height = `${rect.h}px`
  }
  // 保存状态六档: idle 未改动 / editing 防抖窗口内 / local 本地已落盘待同步 / saving 云端同步中
  // / saved 已保存 / error 同步失败重试中 / conflict 多端版本冲突待选择
  const [saveState, setSaveState] = useState<'idle' | 'editing' | 'local' | 'saving' | 'saved' | 'error' | 'conflict'>('idle')
  // 多标签/多设备保存冲突: 服务端 409 后不再自动用旧快照覆盖, 暂存待处理冲突让用户二选一
  const saveConflictRef = useRef<{ canvasId: string; serverRev: number } | null>(null)
  type SaveConflictValue = { canvasId: string; serverRev: number } | null
  const [saveConflict, setSaveConflictState] = useState<SaveConflictValue>(null)
  const setSaveConflict = (v: SaveConflictValue | ((prev: SaveConflictValue) => SaveConflictValue)) => {
    setSaveConflictState(prev => {
      const next = typeof v === 'function' ? (v as (p: SaveConflictValue) => SaveConflictValue)(prev) : v
      saveConflictRef.current = next
      return next
    })
  }
  // 本标签页会话标识(本地快照分键用), 挂载即定不再变
  const browserSessionIdRef = useRef<string>('')
  if (!browserSessionIdRef.current) browserSessionIdRef.current = currentSessionId()
  // 崩溃恢复弹窗: 上次异常关闭留下的本地快照。ref 镜像供保存链路在闭包里即时读取
  const [localRestore, setLocalRestoreState] = useState<{
    canvasId: string
    snapshot: LocalCanvasSnapshot
    originSessionId: string
    differsFromCloud: boolean
  } | null>(null)
  const localRestoreRef = useRef<typeof localRestore>(null)
  const setLocalRestore = (v: typeof localRestore | ((prev: typeof localRestore) => typeof localRestore)) => {
    setLocalRestoreState(prev => {
      const next = typeof v === 'function' ? (v as (p: typeof localRestore) => typeof localRestore)(prev) : v
      localRestoreRef.current = next
      return next
    })
  }
  // 崩溃恢复弹窗挂起时, 云端文档携带的待续轮询任务(选「以云端为准」时恢复轮询)
  const cloudPendingAtRestoreRef = useRef<PendingJobRecord[]>([])
  // 冲突选「加载最新」前自动备份本地改动, 提供一次「取回我的版本」
  const [conflictBackupAvailable, setConflictBackupAvailable] = useState(false)
  // 主动重试: 每个画布的退避档位与定时器
  const retryTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const retryStepRef = useRef<Record<string, number>>({})
  const [pendingJobs, setPendingJobs] = useState<PendingJobRecord[]>([])
  // 生成日志: 随画布数据持久化(canvas_data.logs), 新日志 unshift 到头部, 最多保留最近 500 条
  const [genLogs, setGenLogs] = useState<GenLogEntry[]>([])
  const genLogsRef = useRef<GenLogEntry[]>([])
  genLogsRef.current = genLogs
  const [logDialogOpen, setLogDialogOpen] = useState(false)
  const cardsRef = useRef<CanvasCardData[]>([])
  cardsRef.current = cards
  // 会话闸门: 每次进入/切换画布自增。所有延迟异步回写(轮询/转存/复刻建卡/抠图)先比对令牌,
  // 防止在 A 画布发起的任务完成后把结果写进 B 画布。
  const sessionTokenRef = useRef(0)
  // 本会话所有生成轮询的取消器: 切画布时统一 abort, 不再让旧画布的轮询空跑到超时。
  const jobAbortsRef = useRef<Set<AbortController>>(new Set())
  /** 登记一次可取消的生成轮询, 返回该任务专属 signal */
  function beginJobSignal(): AbortSignal {
    const ac = new AbortController()
    jobAbortsRef.current.add(ac)
    return ac.signal
  }
  /** 轮询终态后注销取消器 */
  function endJobSignal(signal: AbortSignal | undefined) {
    if (!signal) return
    const found = [...jobAbortsRef.current].find(ac => ac.signal === signal)
    if (found) jobAbortsRef.current.delete(found)
  }
  /** 仍属于当前画布会话才执行回写 */
  function aliveForSession(token: number): boolean {
    return token === sessionTokenRef.current
  }
  // 项目资产快照桶需先于 docBucketsRef 声明: 下方每次渲染都会把最新项目资产写进画布快照
  const projectAssetsRef = useRef<ProjectAssets>({ items: [], folders: [] })
  // 会话期快照桶(按画布 id 索引): 渲染时持续刷新为最新值, 切画布瞬间仍能拿到旧画布的最终快照做 flush
  const docBucketsRef = useRef<
    Record<string, { cards: CanvasCardData[]; connections: CanvasConnection[]; viewport: CanvasViewport; title: string; pending: PendingJobRecord[]; projectAssets: ProjectAssets; logs: GenLogEntry[]; rev: number }>
  >({})

  // --- 选择与手势 ---
  const stageRef = useRef<HTMLDivElement | null>(null)
  const gestureRef = useRef<StageGesture | null>(null)
  const dragRafRef = useRef(0)
  const dragPosRef = useRef<{ x: number; y: number } | null>(null)
  const marqueeRef = useRef<MarqueeRect | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedIdsRef = useRef<string[]>([])
  selectedIdsRef.current = selectedIds
  // 聚焦连线模式(左下角眼睛按钮): 开启后只显示选中节点直接上下游的连线; 无选中时全部隐藏
  const [focusConnections, setFocusConnections] = useState(false)
  const [batchSettingsReady, setBatchSettingsReady] = useState(false)
  const [editNodeId, setEditNodeId] = useState<string | null>(null)
  // 上一次选中变更是「拖动卡片」造成的: 拖动松手不自动弹出输入面板, 只有原地轻点才展开;
  // 由选中副作用读取后立即清掉, 不影响后续点击/新建/复制等路径的自动展开
  const suppressAutoPanelRef = useRef(false)
  const [connectionDraft, setConnectionDraft] = useState<ConnectionDraft | null>(null)
  const [connections, setConnections] = useState<CanvasConnection[]>([])
  const connectionsRef = useRef<CanvasConnection[]>([])
  // 画布内复制粘贴: ⌘/Ctrl+C 存选中卡+组内连线, ⌘/Ctrl+V 粘贴(每次递增偏移避免叠在原副本上)
  const clipboardRef = useRef<
    { cards: CanvasCardData[]; conns: Array<{ fromId: string; toId: string; toSlot?: RepSlot }> } | null
  >(null)
  const pasteSeqRef = useRef(0)
  connectionsRef.current = connections
  // 每张卡「上一版已确认」的媒体字段(url + 结果项)。上传/替换图片时卡片先显示 blob: 本地预览,
  // 若此时自动保存/切后台/关页触发全量保存, 不能用空 URL 覆盖云端(否则刷新后图没了、卡片塌成小卡),
  // 用这里的上一版媒体字段顶替入库。只存轻量字段, 避免大画布每渲染深拷贝整卡的性能成本。
  const lastPersistedMediaRef = useRef<Map<string, { url: string; results?: CanvasCardData['results'] }>>(new Map())
  // 快照桶随每次渲染刷新为最新值(此时 cards/connections/viewport/pendingJobs 均已声明)
  docBucketsRef.current[canvasId ?? ''] = {
    cards, connections, viewport, title: canvasTitle, pending: pendingJobs,
    projectAssets: projectAssetsRef.current,
    logs: genLogs,
    rev: docBucketsRef.current[canvasId ?? '']?.rev ?? 0,
  }
  // 渲染期同步「已确认媒体字段」: 有非 blob 永久链接的卡即为可兜底版本(图片 await 上传成功才换此 URL)。
  // buildPersistCards 在下次上传在途时用它顶替, 防止自动保存剥空图片覆盖云端; 顺带清理已删除卡。
  {
    const liveIds = new Set(cards.map(c => c.id))
    Array.from(lastPersistedMediaRef.current.keys()).forEach(id => {
      if (!liveIds.has(id)) lastPersistedMediaRef.current.delete(id)
    })
    cards.forEach(c => {
      if (c.url && !c.url.startsWith('blob:')) {
        const prev = lastPersistedMediaRef.current.get(c.id)
        if (!prev || prev.url !== c.url) {
          lastPersistedMediaRef.current.set(c.id, {
            url: c.url,
            ...(c.results ? { results: c.results.map(r => ({ ...r })) } : {}),
          })
        }
      }
    })
  }
  /** 手动拉缩放手柄期间暂停尺寸回写, 避免与回写互相打架 */
  const resizingRef = useRef(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewMediaType, setPreviewMediaType] = useState<'image' | 'video'>('image')

  // --- 视频帧捕捉弹窗: 源视频卡 id(弹窗自己维护截帧列表与上传状态) ---
  const [frameCaptureCardId, setFrameCaptureCardId] = useState<string | null>(null)
  function openFrameCapture(cardId: string) {
    setFrameCaptureCardId(cardId)
  }
  function closeFrameCapture() {
    setFrameCaptureCardId(null)
  }

  // --- 图片编辑器(裁剪 / 画笔标注 / 宫格切分) ---
  const [editDialogId, setEditDialogId] = useState<string | null>(null)
  const [editDialogMode, setEditDialogMode] = useState<'crop' | 'draw' | 'grid' | 'extract' | null>(null)

  function openImageEditor(cardId: string, mode: 'crop' | 'draw' | 'grid' | 'extract') {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card?.url || card.kind === 'video') return
    setEditDialogId(cardId)
    setEditDialogMode(mode)
  }

  function closeImageEditor() {
    setEditDialogId(null)
    setEditDialogMode(null)
  }

  /** 颜色图钉(旧): 仅写卡片数据, 不改图片; 传 undefined 清除标记 */
  function setPinColor(cardId: string, color: CanvasCardData['pinColor']) {
    updateCard(cardId, { pinColor: color })
  }

  /** 全局标签打标: 传 slug 打标, 传 undefined 清除(updateCard 展开无法删键, 空串=无标签) */
  function setCardTag(cardId: string, slug: string | undefined) {
    updateCard(cardId, { tagSlug: slug === undefined ? '' : slug })
  }

  /** 解析卡片当前标签 slug: tagSlug 优先, 空串/查不到时纯渲染回退旧 pinColor 映射(不回写字段) */
  function resolveCardTagSlug(card: Pick<CanvasCardData, 'tagSlug' | 'pinColor'>): string | null {
    if (card.tagSlug) {
      const def = globalTags.getTagDef(card.tagSlug)
      if (def) return def.slug
      // 自定义 slug 查不到定义时不回退旧色点, 胶囊不显示
      if (card.tagSlug.startsWith('fixed:') || card.tagSlug.startsWith('ecommerce:')) {
        return card.pinColor ? LEGACY_PIN_MAP[card.pinColor] ?? null : null
      }
      return null
    }
    if (card.pinColor) return LEGACY_PIN_MAP[card.pinColor] ?? null
    return null
  }

  function editLoginErr(err: unknown): boolean {
    const status = (err as { status?: number })?.status
    if (status === 412 || status === 401 || status === 403) {
      setNeedsRhLogin(true)
      return true
    }
    return false
  }

  /** 裁剪 / 画笔: 标注烘焙进原图导出 PNG, 上传后替换当前卡片 url */
  async function applyImageReplace(cardId: string, blob: Blob, okText: string) {
    const file = new File([blob], `edit-${Date.now().toString(36)}.png`, { type: 'image/png' })
    try {
      const url = await persistMedia(file, 'image')
      if (!url) throw new Error('bad upload')
      updateCard(cardId, { url, jobStatus: undefined })
      closeImageEditor()
      toast.success(okText)
    } catch (err) {
      if (!editLoginErr(err)) toast.error('保存失败, 请重试')
    }
  }

  /**
   * 宫格切分: 逐格导出 PNG 批量上传; 原图卡片保留, 每张切分图作为新结果卡
   * 追加到源卡右侧网格排布, 并从源卡连线。
   */
  async function applyGridSplit(cardId: string, parts: ImageEditGridPart[]) {
    const source = cardsRef.current.find(c => c.id === cardId)
    if (!source) return
    const gridGroupId = uid()
    const uploaded: Array<{ part: ImageEditGridPart; url: string }> = []
    let failed = 0
    for (const part of parts) {
      const file = new File([part.blob], `grid_${part.name}.png`, { type: 'image/png' })
      try {
        const url = await persistMedia(file, 'image')
        if (url) uploaded.push({ part, url })
        else failed += 1
      } catch (err) {
        if (editLoginErr(err)) return
        failed += 1
      }
    }
    if (!uploaded.length) {
      toast.error('切分失败, 请重试')
      return
    }
    const newCards: CanvasCardData[] = uploaded.map(({ part, url }) => {
      const cardW = Math.min(240, Math.max(140, Math.round(part.naturalW)))
      const cardH = Math.round(cardW * (part.naturalH / Math.max(1, part.naturalW))) + 34
      return {
        id: uid(),
        kind: 'result' as CardKind,
        x: source.x + source.w + 56 + part.col * (cardW + 28),
        y: source.y + part.row * (cardH + 28),
        w: cardW,
        h: cardH,
        url,
        sourceCardId: source.id,
        model: source.model,
        gridMeta: { groupId: gridGroupId, row: part.row, col: part.col, rows: part.rows, cols: part.cols },
      }
    })
    setCards(prev => [...prev, ...newCards])
    setConnections(prev => [...prev, ...newCards.map(nc => ({ id: uid(), fromId: source.id, toId: nc.id }))])
    closeImageEditor()
    if (newCards[0]) flushAfterMediaSaved(newCards[0].id)
    if (failed > 0) toast.success(`已切分 ${uploaded.length} 张到画布, ${failed} 张上传失败`)
    else toast.success(`已切分 ${uploaded.length} 张到画布`)
  }

  /**
   * 帧捕捉「全部添加到画布」: 把截到的帧(blob)逐张上传为永久图,
   * 在源视频卡右侧错落建成结果卡并连线; 返回成功上传的帧 id(供弹窗清空已添加项)。
   * 帧对象由弹窗生成, 含 blob/objectUrl/秒点/像素宽高。
   */
  async function addCapturedFramesToCanvas(
    sourceCardId: string,
    frames: Array<{ id: string; blob: Blob; timeSec: number; naturalW: number; naturalH: number }>,
  ): Promise<string[]> {
    if (!frames.length) return []
    const source = cardsRef.current.find(c => c.id === sourceCardId)
    if (!source) {
      toast.error('源视频卡已被删除, 无法添加帧')
      return []
    }
    const uploaded: Array<{ frame: (typeof frames)[number]; url: string }> = []
    let failed = 0
    for (const frame of frames) {
      const file = new File([frame.blob], `frame_${Math.round(frame.timeSec * 10)}s.png`, { type: 'image/png' })
      try {
        const url = await persistMedia(file, 'image')
        if (url) uploaded.push({ frame, url })
        else failed += 1
      } catch (err) {
        if ((err as { status?: number })?.status === 412) {
          toast.error('请先登录后再添加到画布')
          return []
        }
        failed += 1
      }
    }
    if (!uploaded.length) {
      toast.error('帧添加失败, 请重试')
      return []
    }
    // 上传是串行 await, 落卡前复查源卡仍存在(上传期间可能被删), 避免孤立卡与悬空连线
    const liveSource = cardsRef.current.find(c => c.id === sourceCardId)
    if (!liveSource) {
      toast.error('源视频卡已被删除, 已取消添加')
      return []
    }
    const baseX = liveSource.x + liveSource.w + 56
    const baseY = liveSource.y
    const newCards: CanvasCardData[] = uploaded.map(({ frame, url }, i) => {
      const cardW = Math.min(240, Math.max(140, Math.round(frame.naturalW)))
      const cardH = Math.round(cardW * (frame.naturalH / Math.max(1, frame.naturalW)))
      const col = i % 3
      const row = Math.floor(i / 3)
      return {
        id: uid(),
        kind: 'result' as CardKind,
        x: baseX + col * (cardW + 28),
        y: baseY + row * (cardH + 28),
        w: cardW,
        h: cardH,
        url,
        sourceCardId: liveSource.id,
        title: `帧 ${frame.timeSec.toFixed(1)}s`,
      }
    })
    setCards(prev => [...prev, ...newCards])
    setConnections(prev => [...prev, ...newCards.map(nc => ({ id: uid(), fromId: liveSource.id, toId: nc.id }))])
    if (newCards[0]) flushAfterMediaSaved(newCards[0].id)
    if (failed > 0) toast.success(`已添加 ${uploaded.length} 帧到画布, ${failed} 帧上传失败`)
    else toast.success(`已添加 ${uploaded.length} 帧到画布`)
    return uploaded.map(({ frame }) => frame.id)
  }

  /** 图片编辑器应用入口: 裁剪/画笔替换原图, 宫格切分追加结果卡 */
  async function applyImageEdit(
    cardId: string,
    result:
      | { kind: 'crop'; blob: Blob }
      | { kind: 'draw'; blob: Blob }
      | { kind: 'grid'; parts: ImageEditGridPart[] },
  ) {
    if (result.kind === 'grid') await applyGridSplit(cardId, result.parts)
    else if (result.kind === 'crop') await applyImageReplace(cardId, result.blob, '裁剪已应用')
    else await applyImageReplace(cardId, result.blob, '标注已应用')
  }

  // ---------- 局部提取选区 / 图像融合(纯前端 Canvas) ----------

  /**
   * 提取选区: 按 natural 像素选区等比外扩裁出局部图(含上下文环带), 持久化后在源卡右侧
   * 建「局部选区」结果卡并连线; 局部图携带 cropContext, 供后续多轮改图继承与最终融合。
   */
  async function handleExtractSelection(
    cardId: string,
    sel: { x: number; y: number; w: number; h: number; sourceWidth: number; sourceHeight: number },
  ) {
    const source = cardsRef.current.find(c => c.id === cardId)
    if (!source?.url || source.kind === 'video') {
      toast.error('请先选择一张图片')
      return
    }
    const sourceUrl = source.url
    try {
      const { img, naturalWidth, naturalHeight } = await loadImageNatural(sourceUrl)
      if (sel.sourceWidth !== naturalWidth || sel.sourceHeight !== naturalHeight) {
        throw new Error('原图尺寸已变化，请重新框选')
      }
      const rect = {
        x: Math.max(0, Math.round(sel.x)),
        y: Math.max(0, Math.round(sel.y)),
        w: Math.round(sel.w),
        h: Math.round(sel.h),
      }
      if (rect.w < 32 || rect.h < 32) throw new Error('选区宽高均不得小于 32 像素')
      const paddedRect = computePaddedRect(rect, naturalWidth, naturalHeight, 0.1)
      const { canvas } = extractPatchCanvas(img, rect, 0.1)
      const [blob, fingerprint] = await Promise.all([
        new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png')),
        sha256Hex(sourceUrl),
      ])
      if (!blob) throw new Error('局部图导出失败')
      const file = new File([blob], `patch-${Date.now().toString(36)}.png`, { type: 'image/png' })
      const url = await persistMedia(file, 'image')
      if (!url) throw new Error('局部图保存失败')
      const context: CropContext = {
        version: 2,
        contextId: uid(),
        source: { url: sourceUrl, width: naturalWidth, height: naturalHeight, fingerprint },
        rect,
        paddedRect,
        paddingRatio: 0.1,
      }
      const cardW = 240
      const cardH = Math.round(cardW * (paddedRect.h / Math.max(1, paddedRect.w))) + 60
      const patchCard: CanvasCardData = {
        id: uid(),
        kind: 'result',
        x: source.x + source.w + 56,
        y: source.y,
        w: cardW,
        h: Math.max(cardH, 180),
        url,
        title: '局部选区',
        cropContext: context,
        sourceCardId: source.id,
        jobStatus: 'success',
      }
      setCards(prev => [...prev, patchCard])
      setConnections(prev => [...prev, { id: uid(), fromId: source.id, toId: patchCard.id }])
      flushAfterMediaSaved(patchCard.id)
      closeImageEditor()
      toast.success('已提取局部选区, 可在局部图上改图后连接到融合节点')
    } catch (err) {
      if (editLoginErr(err)) return
      toast.error(err instanceof Error ? err.message : '提取选区失败, 请重试')
    }
  }

  /**
   * 融合节点输入解析: 沿入边找上游图片卡, cropContext 为空 = 完整原图候选,
   * 有 cropContext = 局部修改图。多张原图取第一张; 局部图按连线顺序叠加(后连盖先连)。
   */
  function mergeInputs(cardId: string): {
    original?: { card: CanvasCardData; url: string }
    patches: Array<{ card: CanvasCardData; url: string; context: CropContext }>
    error?: string
  } {
    const fromCards = connectionsRef.current
      .filter(conn => conn.toId === cardId)
      .map(conn => cardsRef.current.find(c => c.id === conn.fromId))
      .filter((c): c is CanvasCardData => !!c?.url && c.kind !== 'video' && !cardShowsVideo(c))
    const originals: Array<{ card: CanvasCardData; url: string }> = []
    const patches: Array<{ card: CanvasCardData; url: string; context: CropContext }> = []
    fromCards.forEach(card => {
      const url = card.url as string
      if (card.cropContext && card.cropContext.version === 2) {
        patches.push({ card, url, context: card.cropContext })
      } else {
        originals.push({ card, url })
      }
    })
    if (!originals.length) return { patches, error: '请连接一张完整原图' }
    if (!patches.length) return { original: originals[0], patches, error: '请连接至少一张提取的局部修改图' }
    if (patches.length > 16) return { original: originals[0], patches, error: '一次最多融合 16 张局部图' }
    return { original: originals[0], patches }
  }

  /** 融合: 校验原图指纹/尺寸后把局部图羽化叠回原图, 结果卡 cropContext=null(完整图边界) */
  async function handleRunMerge(cardId: string) {
    const mergeCard = cardsRef.current.find(c => c.id === cardId)
    if (!mergeCard) return
    const colorMatch = mergeCard.mergeState?.colorMatch ?? true
    const inputs = mergeInputs(cardId)
    if (inputs.error || !inputs.original) {
      const msg = inputs.error ?? '融合输入无效'
      updateCard(cardId, { mergeState: { colorMatch, running: false, error: msg } })
      toast.error(msg)
      return
    }
    updateCard(cardId, { mergeState: { colorMatch, running: true, error: null } })
    const mergeStartedAt = Date.now()
    try {
      const [origLoaded, origFingerprint] = await Promise.all([
        loadImageNatural(inputs.original.url),
        sha256Hex(inputs.original.url),
      ])
      const loadedPatches = await Promise.all(
        inputs.patches.map(async (p, i) => {
          if (p.context.source.fingerprint !== origFingerprint) {
            throw new Error(`第 ${i + 1} 张局部图与原图不匹配（原图可能已替换）`)
          }
          const { img } = await loadImageNatural(p.url)
          return { img, context: p.context }
        }),
      )
      const resultCanvas = mergePatchesCanvas(origLoaded.img, loadedPatches, colorMatch)
      const blob = await new Promise<Blob | null>(res => resultCanvas.toBlob(res, 'image/png'))
      if (!blob) throw new Error('融合结果导出失败')
      const file = new File([blob], `merge-${Date.now().toString(36)}.png`, { type: 'image/png' })
      const url = await persistMedia(file, 'image')
      if (!url) throw new Error('融合结果保存失败')
      const resultCard: CanvasCardData = {
        id: uid(),
        kind: 'result',
        x: mergeCard.x + mergeCard.w + 56,
        y: mergeCard.y,
        w: 260,
        h: 310,
        url,
        title: '融合结果',
        cropContext: null,
        sourceCardId: cardId,
        jobStatus: 'success',
      }
      setCards(prev => [...prev, resultCard])
      setConnections(prev => [...prev, { id: uid(), fromId: cardId, toId: resultCard.id }])
      flushAfterMediaSaved(resultCard.id)
      updateCard(cardId, { mergeState: { colorMatch, running: false, error: null } })
      appendGenLog({
        status: 'success',
        platform: '本地画布',
        nodeType: '融合',
        model: '局部融合',
        prompt: '',
        refs: [inputs.original.url, ...inputs.patches.map(p => p.url)],
        outputs: [{ url, kind: 'image' }],
        runMs: Date.now() - mergeStartedAt,
      })
      toast.success('融合完成')
    } catch (err) {
      if (editLoginErr(err)) {
        updateCard(cardId, { mergeState: { colorMatch, running: false, error: null } })
        return
      }
      const msg = err instanceof Error ? err.message : '融合失败, 请重试'
      updateCard(cardId, { mergeState: { colorMatch, running: false, error: msg } })
      appendGenLog({
        status: 'failed',
        platform: '本地画布',
        nodeType: '融合',
        model: '局部融合',
        prompt: '',
        refs: inputs.original ? [inputs.original.url, ...inputs.patches.map(p => p.url)] : [],
        outputs: [],
        runMs: Date.now() - mergeStartedAt,
        error: msg,
      })
      toast.error(msg)
    }
  }

  function setMergeColorMatch(cardId: string, v: boolean) {
    const cur = cardsRef.current.find(c => c.id === cardId)?.mergeState ?? defaultMergeState()
    updateCard(cardId, { mergeState: { ...cur, colorMatch: v } })
  }

  // --- 双击功能菜单(画布坐标) ---
  const [addMenuPos, setAddMenuPos] = useState<{ x: number; y: number; connectFrom?: { ids: string[]; side: ConnectionSide } } | null>(null)

  // --- 摄影机控制弹窗: 当前打开配置弹窗的摄影机卡 id, null = 关闭 ---
  const [cameraConfigCardId, setCameraConfigCardId] = useState<string | null>(null)

  // --- 图片批量高额二次确认: 仅框选批量运行、且图片任务总额超过阈值时强制确认 ---
  const [batchConfirm, setBatchConfirm] = useState<{ imageTotal: number; imageCount: number; hasVideo: boolean; run: () => void } | null>(null)

  // --- 模型目录 / 单价 / 每节点模型契约缓存 ---
  const [modelPrices, setModelPrices] = useState<Record<string, number>>({ ...T2I_PRICE_MAP, ...VIDEO_PRICE_MAP })
  const modelInfoCacheRef = useRef<Record<string, AigcModelInfo | null>>({})
  const modelInfoInflightRef = useRef<Record<string, boolean>>({})
  const [, setModelInfoTick] = useState(0)

  // --- 生成状态 ---
  const [runningCount, setRunningCount] = useState(0)
  const [needsRhLogin, setNeedsRhLogin] = useState(false)

  // 同步重入锁: 处理器在第一个 await 之前同步占锁, 防止双击/连点造成重复提交与重复扣费。
  // 任务终态(成功/失败/取消)前 key 一直在集合内, finally 释放; 失败后立即可再次点击。
  const inflightRunRef = useRef<Set<string>>(new Set())
  /** 同步尝试占锁: 已在执行返回 false; 占成功返回 true。必须在任何 await 之前调用 */
  function acquireRunLock(key: string): boolean {
    if (inflightRunRef.current.has(key)) return false
    inflightRunRef.current.add(key)
    return true
  }
  function releaseRunLock(key: string) {
    inflightRunRef.current.delete(key)
  }
  /** 单节点/单项/卡片/Agent/润色/Loop 等单 key 入口的在途判断 */
  function isRunInflight(key: string): boolean {
    return inflightRunRef.current.has(key)
  }
  /** 批量运行在途: 任意一个批量提交未结束 */
  function batchRunInflight(): boolean {
    for (const k of inflightRunRef.current) if (k.startsWith('batch:')) return true
    return false
  }

  // --- 账号 / 计费 / 钱包 ---
  const [account, setAccount] = useState<LocalAccount | null>(() => getLocalAccount())
  const costConfirm = useCostConfirm()
  // 钱包余额(元); null = 未登录或未加载
  const [walletBalance, setWalletBalance] = useState<number | null>(null)
  const [walletAdmin, setWalletAdmin] = useState(false)
  // 弹窗: login=登录/注册, recharge=充值, 空=关闭
  const [authDialog, setAuthDialog] = useState<null | 'login' | 'recharge'>(null)

  // 订阅站内账号登录态
  useEffect(() => {
    return onLocalAccountChange(acc => {
      setAccount(acc)
      if (!acc) {
        setWalletBalance(null)
        setWalletAdmin(false)
      }
    })
  }, [])

  // 拉取钱包余额
  const refreshWallet = useCallback(async () => {
    if (!getLocalAccount()) {
      setWalletBalance(null)
      setWalletAdmin(false)
      return
    }
    try {
      const res = await fetch(`${getPocketBaseUrl()}/api/wallet/me`, { headers: { ...getAuthHeaders() } })
      if (res.status === 401) {
        setWalletBalance(null)
        return
      }
      const data = await res.json()
      if (data && data.ok) {
        setWalletBalance(typeof data.balance === 'number' ? data.balance : 0)
        setWalletAdmin(!!data.is_admin)
      }
    } catch {
      // 钱包拉取失败不阻塞
    }
  }, [])
  const selectedIdsKey = selectedIds.join(',')

  useEffect(() => {
    Promise.resolve().then(refreshWallet)
  }, [account?.id, refreshWallet])

  /** 打开充值弹窗(未登录先弹登录) */
  function openRecharge() {
    if (!getLocalAccount()) {
      setAuthDialog('login')
      return
    }
    setAuthDialog('recharge')
  }

  // --- 全局标签(账号级, 取代旧六色图钉); 登录失效走全站统一登录弹窗 ---
  const globalTags = useGlobalTags(account?.id ?? account?.email ?? null, () => setAuthDialog('login'))
  // 标签管理弹窗: draft 非空 = 打开时直接进入新建态(从卡片浮层「+ 新建标签」进入时带 cardId, 保存后自动打标)
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [tagManagerDraft, setTagManagerDraft] = useState<{ name: string; color: string; cardId?: string } | null>(null)
  function openTagManager(draft?: { name?: string; color?: string; cardId?: string }) {
    setTagManagerDraft(draft ? { name: draft.name ?? '', color: draft.color ?? '', cardId: draft.cardId } : null)
    setTagManagerOpen(true)
  }
  function closeTagManager() {
    setTagManagerOpen(false)
    setTagManagerDraft(null)
  }

  /** 登录成功回调(供登录弹窗调用): 关弹窗、刷新钱包, 并把登录过期期间挂起的改动立即续存 */
  function handleAuthSuccess() {
    setAccount(getLocalAccount())
    setAuthDialog(null)
    void refreshWallet()
    // 登录过期时 sendPersist 把改动留在了 dirty 里, 登录后立即补发, 不让用户白编辑
    try {
      const id = lastCanvasIdRef.current || canvasId
      if (id) {
        const marks = saveDirtyRef.current[id]
        if (marks?.full || marks?.view) {
          if (saveTimerRef.current[id]) {
            clearTimeout(saveTimerRef.current[id])
            delete saveTimerRef.current[id]
          }
          clearRetryTimer(id)
          retryStepRef.current[id] = 0
          setSaveState('saving')
          void sendPersist(id)
        }
      }
    } catch {
      /* 续存失败等下一次编辑/重试 */
    }
  }

  /** 统一识别生成结果里的登录/余额问题并弹窗; 返回是否命中 */
  function interceptAuthIssue(res: unknown): boolean {
    const r = res as { status?: string; errorKind?: string; needsLogin?: boolean; needsRecharge?: boolean; error?: string; ok?: boolean } | null
    if (!r) return false
    const failed = r.status === 'failed' || r.ok === false
    if (!failed) {
      if (r.status === 'success' || r.ok === true) void refreshWallet()
      return false
    }
    if (r.needsLogin || r.errorKind === 'login_required') {
      setAuthDialog('login')
      return true
    }
    if (r.needsRecharge || r.errorKind === 'insufficient_balance') {
      void refreshWallet()
      setAuthDialog('recharge')
      return true
    }
    const errText = String(r.error || '').toLowerCase()
    if (r.status === 'failed' && (errText.includes('login') || errText.includes('登录') || errText.includes('unauthorized'))) {
      setAuthDialog('login')
      return true
    }
    return false
  }

  // 包装生成/LLM 调用: 自动拦截登录与余额问题
  const runAigcGuarded: typeof callAigcAndPoll = async (...args) => {
    const res = await callAigcAndPoll(...args)
    interceptAuthIssue(res)
    return res
  }
  const runAiAppGuarded: typeof callAiAppAndPoll = async (...args) => {
    const res = await callAiAppAndPoll(...args)
    interceptAuthIssue(res)
    return res
  }
  const runLlmGuarded: typeof callLlmWithFallback = async (...args) => {
    const res = await callLlmWithFallback(...args)
    const r = res as { ok?: boolean; error?: string }
    if (r && r.ok === false) {
      const t = String(r.error || '').toLowerCase()
      if (t.includes('login') || t.includes('登录') || t.includes('401') || t.includes('unauthorized')) {
        setAuthDialog('login')
      }
    }
    return res
  }

  // --- 素材库(全局资产分页累积: 后端 perPage 50, 超过 50 条靠 loadMoreGlobalAssets 追加) ---
  const [assets, setAssets] = useState<AssetItem[]>([])
  const [assetsLoading, setAssetsLoading] = useState(false)
  const [assetsLoadingMore, setAssetsLoadingMore] = useState(false)
  const [assetsHasMore, setAssetsHasMore] = useState(false)
  const [assetsTotal, setAssetsTotal] = useState(0)
  const assetsPageRef = useRef(1)
  const ASSETS_PAGE_SIZE = 50
  const [assetUploading, setAssetUploading] = useState(false)
  const [assetPickerFor, setAssetPickerFor] = useState<{ cardId: string; slot: 'ref' | 'node' } | null>(null)
  // @ 引用弹窗的范围切换: global=账号全局库, project=当前画布项目库
  const [pickerScope, setPickerScope] = useState<'global' | 'project'>('global')

  // --- 右侧资产库浮动面板 ---
  const [assetPanelOpen, setAssetPanelOpen] = useState(false)
  const [globalFolders, setGlobalFolders] = useState<GlobalAssetFolder[]>([])
  const [foldersLoading, setFoldersLoading] = useState(false)
  // 项目库(随画布保存): 面板开合不持久化, 资产与文件夹持久化
  const [projectAssets, setProjectAssets] = useState<ProjectAssets>({ items: [], folders: [] })
  projectAssetsRef.current = projectAssets

  // --- 润色进行中标记(复刻节点用, 含 cardId 前缀) ---
  const [polishingField, setPolishingField] = useState<string | null>(null)
  // --- 生成节点内联润色中(看图反推 / 提示词优化, 结果回填到本节点输入框) ---
  const [polishingGenId, setPolishingGenId] = useState<string | null>(null)

  // --- 本地助手(一键导入剪映): 在线状态 + 剪映状态 + 导入进行中 ---
  const [assistant, setAssistant] = useState<AssistantHealth>({ ok: false, port: null })
  const [jianyingImporting, setJianyingImporting] = useState(false)
  const [adobeImporting, setAdobeImporting] = useState<AdobeApplication | null>(null)

  // --- 运行时 dataUrl 缓存(不持久化, 刷新后按需重取) ---
  // LRU 有界: value 是全尺寸图片的 base64(单张可达数 MB), 只服务一次性视觉分析,
  // 若用无界 Record 缓存, 连续分析/反复换图会让长会话内存只增不减(数百 MB)。
  // Map 的键按插入顺序保留, 命中时 delete+set 提到最新, 超容量从最旧开始淘汰。
  const DATA_URL_CACHE_MAX = 24
  const dataUrlCacheRef = useRef<Map<string, string>>(new Map())
  function cacheDataUrl(key: string, value: string) {
    const m = dataUrlCacheRef.current
    if (m.has(key)) m.delete(key)
    m.set(key, value)
    while (m.size > DATA_URL_CACHE_MAX) {
      const oldest = m.keys().next().value
      if (oldest === undefined) break
      m.delete(oldest)
    }
  }
  function readDataUrl(key: string): string | undefined {
    const m = dataUrlCacheRef.current
    const hit = m.get(key)
    if (hit !== undefined) {
      m.delete(key)
      m.set(key, hit)
    }
    return hit
  }

  // ---------- 工具函数(闭包内) ----------

  function updateCard(cardId: string, patch: Partial<CanvasCardData>) {
    setCards(prev => prev.map(c => (c.id === cardId ? { ...c, ...patch } : c)))
  }

  /**
   * 关键状态(媒体永久链接、远端任务 ID 等)到手后的「立刻落盘」: 等一拍让 setState 灌进快照桶,
   * 再把全量保存防抖从最长 ~1.5s 提前到 ~250ms, 压缩「刚提交/刚传完就关页或返回首页」的丢失窗口。
   * requireCardId 给定时只在该卡仍存在时落(媒体场景); 任务受理等场景不传, 只校验画布已加载。
   * 关页本身还有 beforeunload+pagehide keepalive+本地快照兜底, 这里是额外一道保险。
   */
  function requestQuickFullSave(requireCardId?: string) {
    const target = lastCanvasIdRef.current || canvasId
    if (!target || !docLoaded) return
    setTimeout(() => {
      const b = docBucketsRef.current[target]
      if (!b) return
      if (requireCardId && !b.cards.some(c => c.id === requireCardId)) return
      const marks = saveDirtyRef.current[target] || { full: false, view: false }
      marks.full = true
      saveDirtyRef.current[target] = marks
      if (saveTimerRef.current[target]) clearTimeout(saveTimerRef.current[target])
      saveTimerRef.current[target] = setTimeout(() => {
        delete saveTimerRef.current[target]
        void sendPersist(target)
      }, 250)
    }, 0)
  }

  function flushAfterMediaSaved(cardId: string) {
    requestQuickFullSave(cardId)
  }

  function patchLayerState(cardId: string, patch: Partial<LayerNodeState>) {
    setCards(prev =>
      prev.map(c => (c.id === cardId ? { ...c, layerState: { ...defaultLayerState(), ...c.layerState, ...patch } } : c)),
    )
  }

  function patchRepState(cardId: string, patch: Partial<RepNodeState>) {
    setCards(prev =>
      prev.map(c => (c.id === cardId ? { ...c, repState: { ...defaultRepState(), ...c.repState, ...patch } } : c)),
    )
  }

  function updateLayerFor(cardId: string, layerId: string, patch: Partial<LayerItem>) {
    setCards(prev =>
      prev.map(c =>
        c.id === cardId && c.layerState
          ? { ...c, layerState: { ...c.layerState, layers: c.layerState.layers.map(l => (l.id === layerId ? { ...l, ...patch } : l)) } }
          : c,
      ),
    )
  }

  function clientToCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const el = stageRef.current
    const rect = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 }
    const v = viewportRef.current
    return {
      x: (clientX - rect.left - v.x) / v.scale,
      y: (clientY - rect.top - v.y) / v.scale,
    }
  }

  function centerSpawnPos(): { x: number; y: number } {
    const el = stageRef.current
    const cw = el ? el.clientWidth : 900
    const ch = el ? el.clientHeight : 600
    return {
      x: (cw / 2 - viewport.x) / viewport.scale - 130,
      y: (ch / 2 - viewport.y) / viewport.scale - 90,
    }
  }

  function pickParamValue(info: AigcModelInfo | null, paramName: string, preferred: string): string | null {
    const sp = info?.scalar_params?.find(p => p.name === paramName)
    if (!sp) return null
    if (sp.enum && sp.enum.length) {
      if (sp.enum.includes(preferred)) return preferred
      const fallback = sp.default !== undefined ? String(sp.default) : sp.enum[0]
      return fallback === 'empty' ? null : fallback
    }
    return preferred
  }

  /** 比例提交值: empty 不送; adaptive 在渠道枚举支持时送原值, 否则省略参数让平台自定比例(对齐官网自适应语义); 其余值走 pickParamValue */
  function aspectRatioForBody(info: AigcModelInfo | null, preferred: string): string | null {
    if (preferred === 'empty') return null
    if (preferred === 'adaptive') {
      const sp = info?.scalar_params?.find(p => p.name === 'aspectRatio')
      return sp?.enum?.includes('adaptive') ? 'adaptive' : null
    }
    return pickParamValue(info, 'aspectRatio', preferred)
  }

  /** 把图片真实宽高匹配到渠道支持的最接近比例枚举(对数距离); 超出渠道极端比例(1:3~3:1)返回 null */
  function matchAspectRatioEnum(enumValues: string[] | undefined, width: number, height: number): string | null {
    if (!enumValues || !width || !height) return null
    const target = width / height
    let best: { v: string; d: number } | null = null
    for (const raw of enumValues) {
      const m = /^(\d+(?:\.\d+)?)\s*[:xX]\s*(\d+(?:\.\d+)?)$/.exec(raw)
      if (!m) continue
      const ratio = Number(m[1]) / Number(m[2])
      if (!Number.isFinite(ratio) || ratio <= 0) continue
      const d = Math.abs(Math.log(ratio / target))
      if (!best || d < best.d) best = { v: raw, d }
    }
    // 偏差超过一档(如 16:9 配 3:4)说明图片比例超出渠道档位, 不强行指定, 交平台处理
    if (!best || best.d > 0.45) return null
    return best.v
  }

  /**
   * 自适应 + 有参考图: 读参考图真实尺寸, 匹配渠道支持的最接近比例并显式提交,
   * 保证图生图(尤其局部选区图与原图比例不一致时)出图跟随参考图而不是平台默认 3:4;
   * 读尺寸失败/超宽高比/渠道无比例参数时回退普通自适应语义。
   */
  async function resolveAdaptiveRatio(info: AigcModelInfo | null, preferred: string | undefined, refUrls: string[]): Promise<string | null> {
    // 官网系「自适应」在不同渠道枚举里可能叫 adaptive 或 empty, 两种都按自适应处理
    if (preferred !== 'adaptive' && preferred !== 'empty') return aspectRatioForBody(info, preferred ?? '16:9')
    const sp = info?.scalar_params?.find(p => p.name === 'aspectRatio')
    // 渠道原生支持 adaptive 时优先交给平台(平台通常会参考输入图)
    if (sp?.enum?.includes('adaptive')) return 'adaptive'
    const refUrl = refUrls[0]
    if (!sp?.enum || !refUrl) return null
    try {
      const { naturalWidth, naturalHeight } = await loadImageNatural(refUrl)
      return matchAspectRatioEnum(sp.enum, naturalWidth, naturalHeight)
    } catch {
      return null
    }
  }

  function buildBodyWithDefaults(info: AigcModelInfo | null, promptText: string, refUrls: string[]): Record<string, unknown> {
    const body: Record<string, unknown> = { prompt: promptText }
    for (const sp of info?.scalar_params ?? []) {
      if (sp.default !== undefined && String(sp.default) !== 'empty') body[sp.name] = sp.default
    }
    if (refUrls.length) body.imageUrls = refUrls
    return body
  }

  /** 移除未完成任务记录: 新生成节点路径按 cardId+resultIndex 精确移除(一个节点可有多张), 老路径按 cardId 全移 */
  function removePendingJob(cardId: string, resultIndex?: number) {
    setPendingJobs(prev =>
      prev.filter(j =>
        j.resultIndex === undefined ? j.cardId !== cardId : !(j.cardId === cardId && j.resultIndex === resultIndex),
      ),
    )
  }

  /** 卡片主图是否为视频结果(生成节点看当前 active 结果项, 老视频卡看 kind) */
  function cardShowsVideo(card: CanvasCardData | undefined): boolean {
    if (!card) return false
    if (card.kind === 'video') return true
    const idx = card.activeResultIndex ?? 0
    return !!card.results?.[idx]?.isVideo
  }

  /**
   * 生成节点结果写回: 更新 results[resultIndex], 重算节点级 jobStatus 聚合,
   * 并把 active 结果项(或首个成功项)同步到 card.url/card.cropContext ——
   * 下游连线/融合/图片编辑器全部照旧读 card.url, 零改动。
   */
  function patchNodeResult(nodeId: string, resultIndex: number, itemPatch: Partial<GenerateResultItem>) {
    setCards(prev =>
      prev.map(c => {
        if (c.id !== nodeId || !c.results) return c
        const results = c.results.map((it, i) => (i === resultIndex ? { ...it, ...itemPatch } : it))
        // 节点级状态聚合: 有运行/排队 → running; 全成功 → success; 否则有失败 → failed; 无结果 → idle
        let agg: CardJobStatus | undefined
        if (results.some(r => r.itemStatus === 'queued' || r.itemStatus === 'running')) agg = 'running'
        else if (results.length > 0 && results.every(r => r.itemStatus === 'success')) agg = 'success'
        else if (results.some(r => r.itemStatus === 'failed')) agg = 'failed'
        // active 下标保护: 删除/重置不会缩容, 但防御性钳制
        const activeIdx = Math.min(c.activeResultIndex ?? 0, Math.max(0, results.length - 1))
        const active = results[activeIdx]
        const firstOk = results.find(r => r.itemStatus === 'success' && r.url)
        const main = active && active.itemStatus === 'success' && active.url ? active : firstOk
        const totalCost = results
          .map(r => parseFloat((r.costText ?? '').replace(/[^\d.]/g, '')))
          .filter(n => Number.isFinite(n) && n > 0)
          .reduce((a, b) => a + b, 0)
        return {
          ...c,
          results,
          activeResultIndex: activeIdx,
          jobStatus: agg,
          url: main?.url,
          cropContext: main ? main.cropContext ?? null : c.cropContext,
          costText: totalCost > 0 ? `¥${totalCost.toFixed(2)}` : c.costText,
        }
      }),
    )
  }

  /** 节点结果里的临时链接转存为永久链接后静默替换(图片才转存, 视频保持平台链接) */
  function replaceNodeResultUrl(nodeId: string, resultIndex: number, oldUrl: string, permanent: string) {
    setCards(prev =>
      prev.map(c => {
        if (c.id !== nodeId || !c.results) return c
        const results = c.results.map((it, i) => (i === resultIndex && it.url === oldUrl ? { ...it, url: permanent } : it))
        const activeIdx = c.activeResultIndex ?? 0
        const active = results[activeIdx]
        return {
          ...c,
          results,
          url: active && active.url === oldUrl ? permanent : c.url === oldUrl ? permanent : c.url,
        }
      }),
    )
  }

  /** 切换节点当前主看的结果项, 主图/裁剪上下文跟随(下游连线引用的是主图) */
  function handleSelectNodeResult(cardId: string, index: number) {
    setCards(prev =>
      prev.map(c => {
        if (c.id !== cardId || !c.results?.[index]) return c
        const item = c.results[index]
        return {
          ...c,
          activeResultIndex: index,
          url: item.url ?? c.url,
          cropContext: item.itemStatus === 'success' ? item.cropContext ?? null : c.cropContext,
        }
      }),
    )
  }

  function looksLikeFileName(text: string): boolean {
    return /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|mp4|mov)$/i.test(text.trim())
  }

  /** 图生视频提示词: 卡片上有用户写的运动描述就用, 只有文件名/空则给中性运动描述 */
  function resolveI2vPrompt(raw?: string): string {
    const text = (raw ?? '').trim()
    return text && !looksLikeFileName(text) ? text : DEFAULT_MOTION_PROMPT
  }

  /** 各图生视频渠道首帧字段名不同 (firstFrameUrl / imageUrl), 以契约 media_params 为准 */
  function firstFrameFieldName(info: AigcModelInfo | null): string {
    const names = (info?.media_params ?? []).map(m => m.name)
    if (names.includes('firstFrameUrl')) return 'firstFrameUrl'
    if (names.includes('imageUrl')) return 'imageUrl'
    return 'firstFrameUrl'
  }

  /** 每节点模型契约缓存: 先读缓存, 未命中异步拉取并触发重渲染 */
  function requestModelInfo(slug: string) {
    // AI 应用渠道没有标准 openapi 模型契约, 参数控件本就不渲染, 直接记空不拉取
    if (aiAppSlugOf(slug)) {
      if (!(slug in modelInfoCacheRef.current)) modelInfoCacheRef.current[slug] = null
      return
    }
    if (slug in modelInfoCacheRef.current || modelInfoInflightRef.current[slug]) return
    modelInfoInflightRef.current[slug] = true
    getAigcModelInfo(slug)
      .then(info => {
        modelInfoCacheRef.current[slug] = info
      })
      .catch(() => {
        modelInfoCacheRef.current[slug] = null
      })
      .finally(() => {
        modelInfoInflightRef.current[slug] = false
        setModelInfoTick(t => t + 1)
      })
  }

  function getNodeModelInfo(slug: string): AigcModelInfo | null {
    if (!(slug in modelInfoCacheRef.current)) requestModelInfo(slug)
    return modelInfoCacheRef.current[slug] ?? null
  }

  async function ensureModelInfo(slug: string): Promise<AigcModelInfo | null> {
    if (aiAppSlugOf(slug)) return null
    if (slug in modelInfoCacheRef.current) return modelInfoCacheRef.current[slug]
    try {
      const info = await getAigcModelInfo(slug)
      modelInfoCacheRef.current[slug] = info
      return info
    } catch {
      return null
    }
  }

  /** 按节点自身参数构建 run body; kind 由模型决定 */
  function buildNodeRunBody(
    params: GenNodeParams,
    promptText: string,
    refUrls: string[],
    info: AigcModelInfo | null,
  ): Record<string, unknown> {
    const kind = modelKindOf(params.model)
    const body: Record<string, unknown> = { prompt: promptText }
    if (kind === 't2v' || kind === 'i2v') {
      const resVal = pickParamValue(info, 'resolution', params.resolution ?? '1k')
      if (resVal !== null) body.resolution = resVal
      const durParam = info?.scalar_params?.find(sp => sp.name === 'duration')
      if (durParam) {
        const preferred = params.videoDuration ?? '5'
        if (durParam.enum && durParam.enum.length) {
          const v = durParam.enum.includes(preferred) ? preferred : String(durParam.default ?? durParam.enum[0])
          body.duration = durParam.type === 'number' ? Number(v) : v
        } else if (durParam.type === 'number') {
          const n = Number(preferred)
          body.duration = Number.isFinite(n) && n >= 1 ? Math.round(Math.min(30, n)) : Number(durParam.default ?? 6)
        }
      }
      const ratioVal = pickParamValue(info, 'ratio', params.videoRatio ?? 'adaptive')
      if (ratioVal !== null) body.ratio = ratioVal
      const arVal = pickParamValue(info, 'aspectRatio', params.videoRatio ?? 'adaptive')
      if (arVal !== null && arVal !== 'empty') body.aspectRatio = arVal
      // 全能参考模型统一用 imageUrls(数组, 最多9张); 其余 i2v 渠道用各自的首帧字段
      if (params.model === MULTIMODAL_VIDEO_MODEL) {
        if (refUrls.length) body.imageUrls = refUrls
      } else if (kind === 'i2v' && refUrls.length) {
        body[firstFrameFieldName(info)] = refUrls[0]
      }
    } else {
      const resVal = pickParamValue(info, 'resolution', params.resolution ?? '1k')
      if (resVal !== null) body.resolution = resVal
      const arVal = aspectRatioForBody(info, params.aspectRatio ?? '1:1')
      if (arVal !== null) body.aspectRatio = arVal
      const qVal = pickParamValue(info, 'quality', params.quality ?? 'medium')
      if (qVal !== null) body.quality = qVal
      if (kind === 'i2i' && refUrls.length) body.imageUrls = refUrls
    }
    return body
  }

  /** 校验生成节点是否可跑, 返回错误提示或 null; 图片位/参考图行/上游连线任一有图即算有图; 按实际运行模型判断, 纯图生渠道缺图在此拦截 */
  function validateGenerateNode(card: CanvasCardData, params: GenNodeParams): string | null {
    const hasImage = effectiveRefUrls(card).length > 0
    const runModel = resolveRunModel(params.model, hasImage)
    const kind = modelKindOf(runModel)
    const hasPrompt = (card.prompt ?? '').trim().length > 0
    if (kind !== 'i2v' && !hasPrompt) return '先在生成节点里写画面描述'
    if (kind === 'i2i' && !hasImage) return '缺少图片无法运行: 请先给该渠道放一张参考图'
    if (kind === 'i2v' && !hasImage) return '缺少图片无法运行: 请先给该渠道放一张图当首帧'
    return null
  }

  /** 上游直连节点的图片位图(参与本节点生成, 也用于节点上的上游参考提示); 视频结果不作图片参考 */
  /**
   * 上游图片索引: 卡片渲染热路径(每张生成节点/复刻槽都要查入边图)。
   * 旧实现对每条入边做一次全量 cards.find, 500 卡全挂载时退化为 O(边×卡);
   * 这里按 cards/connections 引用变化一次性重建 toId → 去重图片url[], 查询 O(1)。
   */
  const inboundIndexRef = useRef<{ cards: CanvasCardData[]; connections: CanvasConnection[]; map: Map<string, string[]> }>({
    cards: [],
    connections: [],
    map: new Map(),
  })
  function upstreamImageUrls(cardId: string): readonly string[] {
    const index = inboundIndexRef.current
    if (index.cards !== cardsRef.current || index.connections !== connectionsRef.current) {
      const map = new Map<string, string[]>()
      const imageById = new Map<string, string | undefined>()
      cardsRef.current.forEach(c => imageById.set(c.id, !cardShowsVideo(c) ? c.url : undefined))
      connectionsRef.current.forEach(conn => {
        const url = imageById.get(conn.fromId)
        if (!url) return
        const arr = map.get(conn.toId)
        if (!arr) map.set(conn.toId, [url])
        else if (!arr.includes(url)) arr.push(url)
      })
      index.cards = cardsRef.current
      index.connections = connectionsRef.current
      index.map = map
    }
    return index.map.get(cardId) ?? EMPTY_STRINGS
  }

  /** 分层节点有效原图: 上传优先, 未上传时承接第一张上游连线图 */
  function effectiveLayerSource(cardId: string): string | null {
    const ls = cardsRef.current.find(c => c.id === cardId)?.layerState
    return ls?.sourceUrl ?? upstreamImageUrls(cardId)[0] ?? null
  }

  /** 某个图片槽当前显示图片的真实来源: 本地上传 / 某条连线(含无槽位的通用连线兜底) */
  type RepSlotSource = { kind: 'upload'; slot: RepSlot; url: string } | { kind: 'conn'; connId: string; url: string } | null

  /** 解析四个图片槽各自的有效来源: 槽位上传 > 连到该槽的线 > 无槽通用线按序兜底。
   *  背面无来源时借用正面来源(只传/只连一张也能跑), 借用关系供换位使用。 */
  function resolveRepSlotSources(cardId: string): Record<RepSlot, RepSlotSource> {
    const rs = cardsRef.current.find(c => c.id === cardId)?.repState
    const uploaded: Record<RepSlot, string | null> = {
      front: rs?.frontUrl ?? null,
      back: rs?.backUrl ?? null,
      logo: rs?.logoUrl ?? null,
      qr: rs?.qrUrl ?? null,
    }
    const bySlot: Record<RepSlot, RepSlotSource[]> = { front: [], back: [], logo: [], qr: [] }
    const generic: RepSlotSource[] = []
    connectionsRef.current.forEach(conn => {
      if (conn.toId !== cardId) return
      const up = cardsRef.current.find(c => c.id === conn.fromId)
      if (!up?.url || cardShowsVideo(up)) return
      const src: RepSlotSource = { kind: 'conn', connId: conn.id, url: up.url }
      if (src && conn.toSlot) {
        if (!bySlot[conn.toSlot].some(s => s?.url === src.url)) bySlot[conn.toSlot].push(src)
      } else if (src && !generic.some(s => s?.url === src.url)) {
        generic.push(src)
      }
    })
    const result: Record<RepSlot, RepSlotSource> = { front: null, back: null, logo: null, qr: null }
    let genericIdx = 0
    REP_SLOTS.forEach(slot => {
      const up = uploaded[slot]
      result[slot] = up
        ? { kind: 'upload', slot, url: up }
        : bySlot[slot][0] ?? generic[genericIdx++] ?? null
    })
    // 背面无自己的来源时借用正面(展示为「背面·同正面」), 换位时按用户看到的这张图处理
    if (!result.back && result.front) result.back = result.front
    return result
  }

  /** 复刻节点四个图片槽位的有效图片: 槽位上传优先; 未上传时取连到该槽位的上游图;
   *  都没有的通用连线按顺序兜底; 背面最终复用正面, 保证只传/只连一张也能跑 */
  function effectiveRepSlots(cardId: string): Record<RepSlot, string | null> {
    const sources = resolveRepSlotSources(cardId)
    return {
      front: sources.front?.url ?? null,
      back: sources.back?.url ?? null,
      logo: sources.logo?.url ?? null,
      qr: sources.qr?.url ?? null,
    }
  }

  /** 复刻节点有效正/背图(背面复用正面) */
  function effectiveRepUrls(cardId: string): { front: string | null; back: string | null } {
    const slots = effectiveRepSlots(cardId)
    return { front: slots.front, back: slots.back }
  }

  /** 生效参考图: 节点图片位的图作第一张参考(图生视频时即首帧), 其余参考图行顺排, 上游连线节点的图追加其后, 总数封顶 9; 当前主看为视频结果时不把视频地址当图片参考 */
  /**
   * 节点主图(card.url)是否为「本节点自己生成出的结果」而非用户放到图片位的参考图。
   * card.url 有二义性: 上传时是参考图, 生成成功后 patchNodeResult 会把它同步成当前结果图。
   * 用它判定, 避免结果图被当成参考图在重新生成时自引用(详见 effectiveRefUrls)。
   */
  function isNodeOwnResult(card: CanvasCardData): boolean {
    const u = card.url
    if (!u || cardShowsVideo(card)) return false
    return (card.results ?? []).some(r => r && r.itemStatus === 'success' && r.url === u)
  }

  function effectiveRefUrls(card: CanvasCardData): string[] {
    // 主图若是本节点刚生成的结果, 绝不能再当参考图(否则重新生成=拿自己的结果当输入, 自引用出错);
    // 只有用户放到图片位的上传图(主图不等于任何成功结果)才作为自身参考。
    const ownUrl = card.url && !cardShowsVideo(card) && !isNodeOwnResult(card) ? card.url : undefined
    const own = ownUrl
      ? [ownUrl, ...(card.refUrls ?? []).filter(u => u !== ownUrl)]
      : [...(card.refUrls ?? [])]
    const ups = upstreamImageUrls(card.id).filter(u => !own.includes(u))
    return [...own, ...ups].slice(0, 9)
  }

  // ---------- 画布文档加载 / 保存 ----------

  /** 老数据兼容 + 新节点中间状态恢复: 运行中被刷新打断的任务标记失败可重试 */
  /** 深度剥除卡片任意字段里固化的部署前缀(/app-preview|/p /app-xxx/__pb), 供跨环境自愈 */
  function stripDeployedPrefix(value: unknown): unknown {
    if (typeof value === 'string') {
      return value.includes('/__pb/api/files/') ? canonicalMediaPath(value) : value
    }
    if (Array.isArray(value)) return value.map(v => stripDeployedPrefix(v))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(value as Record<string, unknown>)) {
        out[k] = stripDeployedPrefix((value as Record<string, unknown>)[k])
      }
      return out
    }
    return value
  }

  function normalizeRestoredCards(
    rawCards: CanvasCardData[],
    inFlightResultKeys?: Set<string>,
  ): CanvasCardData[] {
    return rawCards.map(raw => {
      // 历史数据可能把部署前缀(/app-preview/.../__pb 或 /p/.../__pb)固化进了媒体 URL,
      // 切到另一种部署后前缀对不上会整批 404 裂图; 统一剥成环境无关的裸路径, 渲染时再按当前环境拼。
      // 深度遍历卡片所有字段(url/results/refUrls/ttsState 等), 命中即归一化。
      let c: CanvasCardData = stripDeployedPrefix(raw) as CanvasCardData
      // 顶层运行态在刷新/跨环境恢复时必须收敛: 上传/生成任务不跨页面续跑,
      // 残留 running/queued 会让卡片永久被当忙碌态——工具坞(导出/编辑/标签)与缩放柄全部不显示。
      // 已有成品结果按成功收敛, 否则清回空闲(结果项自身的中断态在下面 generate 分支单独标失败可重试)。
      if (c.jobStatus === 'running' || c.jobStatus === 'queued') {
        const hasSuccess =
          !!c.url ||
          (Array.isArray(c.results) && c.results.some(r => r.itemStatus === 'success' && r.url))
        c = { ...c, jobStatus: hasSuccess ? ('success' as const) : undefined }
      }
      if (c.kind === 'layer' && c.layerState) {
        const ls = c.layerState
        const layers = (ls.layers ?? []).map(l => {
          if (l.genStatus === 'queued' || l.genStatus === 'running') {
            return { ...l, genStatus: 'failed' as const, errorMsg: '任务在刷新时中断了, 请点击重试' }
          }
          return { ...l, cutoutUrl: null }
        })
        const stage: LayerStage = ls.stage === 'analyzing' || ls.stage === 'generating' ? (layers.length ? 'ready' : 'idle') : ls.stage
        // 老数据生图渠道可能存的是图生 slug, 归一到家族主键(提交时再解析为图生 slug)
        const layerFamily = channelFamilyOf(ls.genModel ?? '')
        const layerGenModel = layerFamily ? layerFamily.key : 'gpt-image-2'
        return { ...c, layerState: { ...defaultLayerState(), ...ls, layers, stage, genModel: layerGenModel } }
      }
      if (c.kind === 'replicate' && c.repState) {
        const rs = c.repState
        const jobStatus = {
          front: rs.jobStatus?.front === 'running' || rs.jobStatus?.front === 'queued' ? ('failed' as const) : rs.jobStatus?.front ?? ('idle' as const),
          back: rs.jobStatus?.back === 'running' || rs.jobStatus?.back === 'queued' ? ('failed' as const) : rs.jobStatus?.back ?? ('idle' as const),
        }
        const stage: RepStage = rs.stage === 'analyzing' || rs.stage === 'generating' ? (rs.frontPrompt || rs.backPrompt ? 'ready' : 'idle') : rs.stage
        // 老数据生图渠道可能存的是图生 slug, 归一到家族主键(提交时再解析为图生 slug)
        const genFamily = channelFamilyOf(rs.genModel ?? '')
        const genModel = genFamily ? genFamily.key : 'gpt-image-2'
        return { ...c, repState: { ...defaultRepState(), ...rs, jobStatus, stage, genModel } }
      }
      if ((c.kind as string) === 'image') {
        // 老图片节点升级成统一生成节点: 原图进入节点图片位, 提示词保留(旧存文件名则清空), i2i 默认参数保留
        const rawPrompt = c.prompt ?? ''
        return {
          ...c,
          kind: 'generate' as CardKind,
          prompt: looksLikeFileName(rawPrompt) ? '' : rawPrompt,
          genParams: c.genParams ?? defaultImageGenParams(),
          w: 320,
          h: c.url ? Math.max(c.h, 560) : 180,
        }
      }
      if (c.kind === 'generate') {
        // 节点自身结果: 刷新时未完成的项标记失败可单项重试; active 项下标钳制并同步主图
        let results = c.results
        if (Array.isArray(results) && results.length) {
          results = results.map((r, ri) => {
            const inFlight = !!inFlightResultKeys?.has(`${c.id}:${ri}`)
            // 有在途任务记录的排队/运行项: 保持 queued, 交给 restorePendingJobs 认领远端任务
            // 续轮询(成功写结果/失败标错/真正丢失才中断), 不能先标失败, 否则用户点重试=重复提交扣费。
            if (r.itemStatus === 'running') {
              return inFlight ? { ...r, itemStatus: 'queued' as CardJobStatus, errorMsg: undefined } : r
            }
            if (r.itemStatus === 'queued' && !inFlight) {
              return { ...r, itemStatus: 'failed' as CardJobStatus, errorMsg: '任务在刷新时中断了, 请点击重试' }
            }
            if (r.itemStatus === 'queued' && inFlight) {
              return { ...r, errorMsg: undefined }
            }
            return r
          })
        }
        const activeIdx = results && results.length ? Math.min(c.activeResultIndex ?? 0, results.length - 1) : 0
        const active = results?.[activeIdx]
        const firstOk = results?.find(r => r.itemStatus === 'success' && r.url)
        const main = active && active.itemStatus === 'success' && active.url ? active : firstOk
        return {
          ...c,
          results,
          activeResultIndex: results && results.length ? activeIdx : c.activeResultIndex,
          url: main?.url ?? c.url,
          cropContext: main ? main.cropContext ?? null : c.cropContext,
          genParams: {
            ...defaultGenParams(),
            ...c.genParams,
            // 旧 Seedance 2.0「旗舰/标准版」节点统一迁移到全能参考接口
            ...(c.genParams?.model && LEGACY_VIDEO_SLUG_MAP[c.genParams.model]
              ? { model: LEGACY_VIDEO_SLUG_MAP[c.genParams.model] }
              : {}),
            // 早期数据空节点缺省比例时补 16:9; 已显式选了「自适应」的节点必须保留——
            // 图生图场景下自适应要跟随参考图比例, 这里强写 16:9 会让选择静默失效
            ...(c.url || main?.url || c.genParams?.aspectRatio ? {} : { aspectRatio: '16:9' }),
          },
          w: 320,
          h: c.url || main?.url ? Math.max(c.h, 560) : 180,
        }
      }
      if (c.kind === 'polish') {
        return { ...c, polishState: { ...defaultPolishState(), ...c.polishState }, w: Math.max(c.w, 300), h: Math.max(c.h, 270) }
      }
      if (c.kind === 'tts') {
        // 老版本地 blob 链接刷新即失效, 一律清空; 尺寸给足最小值
        const ts: TtsNodeState = { ...defaultTtsState(), ...c.ttsState }
        if (ts.cloneAudioUrl?.startsWith('blob:')) ts.cloneAudioUrl = undefined
        if (ts.emotionRefAudioUrl?.startsWith('blob:')) ts.emotionRefAudioUrl = undefined
        if (ts.resultUrl?.startsWith('blob:')) ts.resultUrl = undefined
        return { ...c, ttsState: ts, w: Math.max(c.w, 380), h: Math.max(c.h, 560) }
      }
      if (c.kind === 'motion') {
        const ms: MotionNodeState = { ...defaultMotionState(), ...c.motionState }
        if (ms.refImageUrl?.startsWith('blob:')) { ms.refImageUrl = undefined; ms.refImageName = undefined }
        if (ms.refVideoUrl?.startsWith('blob:')) { ms.refVideoUrl = undefined; ms.refVideoName = undefined; ms.refVideoDuration = undefined }
        if (ms.resultUrl?.startsWith('blob:')) ms.resultUrl = undefined
        // 高度自适应内容, 不强制最小高度
        return { ...c, motionState: ms, w: Math.max(c.w, 380), h: c.h }
      }
      if (c.kind === 'vsr') {
        const vs: VsrNodeState = { ...defaultVsrState(), ...c.vsrState }
        if (vs.videoUrl?.startsWith('blob:')) { vs.videoUrl = undefined; vs.videoName = undefined; vs.videoDuration = undefined }
        if (vs.resultUrl?.startsWith('blob:')) vs.resultUrl = undefined
        return { ...c, vsrState: vs, w: Math.max(c.w, 380), h: c.h }
      }
      return c
    })
  }

  const lastCanvasIdRef = useRef<string | null>(null)

  // 「程序灌入服务端文档」时抑制随之而来的保存 effect(内容/视角各一个),
  // 避免打开画布/多标签同步后把刚灌入的视角又回发, 造成同浏览器多标签视角互抢
  const suppressContentSaveRef = useRef(0)
  const suppressViewSaveRef = useRef(0)
  /** 打一拍抑制: 对应 effect 触发时立即消费; 若灌入未引起该 state 变化, 300ms 后兜底释放, 防止计数泄漏 */
  function armSuppressSave() {
    suppressContentSaveRef.current += 1
    suppressViewSaveRef.current += 1
    setTimeout(() => {
      suppressContentSaveRef.current = Math.max(0, suppressContentSaveRef.current - 1)
      suppressViewSaveRef.current = Math.max(0, suppressViewSaveRef.current - 1)
    }, 300)
  }

  /** 把一份服务端画布文档灌入本地 state(初始加载/冲突后加载最新/多标签同步共用), 返回解析后的卡片与待续轮询任务 */
  function applyServerDoc(
    rec: { title?: string; canvas_data?: unknown },
    id: string,
    _sessionToken: number,
    opts?: { suppressSave?: boolean },
  ): { docCards: CanvasCardData[]; pending: PendingJobRecord[] } {
    if (opts?.suppressSave) armSuppressSave()
    if (rec && typeof rec.title === 'string' && rec.title) setCanvasTitle(rec.title)
    const data = (rec?.canvas_data ?? {}) as Partial<CanvasDoc>
    // 加载最新即放弃本地旧基线, 直接采用服务端 rev(不做「只增不减」, 否则拿旧 rev 保存必再次 409)
    const bucket = docBucketsRef.current[id]
    if (bucket) bucket.rev = Number((data as { rev?: number }).rev ?? 0) || 0
    const pendingRaw = Array.isArray(data.pendingJobs) ? data.pendingJobs : []
    // 仍在途的生成节点结果项(有 pending 记录): 归一化时保留排队态, 交给 restorePendingJobs
    // 按真实任务 ID/提示词认领远端在跑任务续轮询, 不能先标失败——否则用户只能点重试, 重复提交扣费。
    const inFlightResultKeys = new Set(
      pendingRaw
        .filter((j: PendingJobRecord) => j && j.resultIndex !== undefined)
        .map((j: PendingJobRecord) => `${j.cardId}:${j.resultIndex}`),
    )
    const docCards = normalizeRestoredCards(Array.isArray(data.cards) ? data.cards : [], inFlightResultKeys)
    setCards(docCards)
    setConnections(Array.isArray(data.connections) ? data.connections : [])
    restoreProjectAssets(data.projectAssets)
    if (data.view && typeof data.view.scale === 'number') setViewport(data.view)
    const pending = pendingRaw as PendingJobRecord[]
    setPendingJobs(pending)
    setGenLogs(
      Array.isArray(data.logs)
        ? data.logs
            .filter(
              (l): l is GenLogEntry =>
                !!l && typeof l.id === 'string' && (l.status === 'success' || l.status === 'failed' || l.status === 'running'),
            )
            .slice(0, 500)
        : [],
    )
    // 历史数据补救: 仍指向平台 24h 过期临时签名链(myqcloud/input?q-sign-*)的媒体, 这些链接本身
    // 必在 24h 后 403, 属于「不转就一定坏」的数据, 后台代下载转存为永久链接(无损救援, 不碰健康数据)。
    // 永久 AI 成品图/健康的本地文件一律不在打开时改写; 真裂图改为图片 onError 按需救回(见 healResultImageByTask)。
    void rehostTempMediaCards(docCards)
    return { docCards, pending }
  }

  /**
   * 对一组卡里「会过期」的平台临时链接后台转存为本应用永久链接并替换; 失败静默跳过。
   * 只转输入上传签名链(myqcloud/input/openapi?q-sign-*, ~24h 后 403);
   * AI 成品输出图(rh-images.xiaoyaoyou.com/.../output/)是无签名长期公开对象, 不在此列——
   * 旧版本把它们也转存到会丢的本地存储, 正是「再进画布图没了」黑卡的根因。
   */
  const rehostingRef = useRef<Set<string>>(new Set())
  async function rehostTempMediaCards(cardList: CanvasCardData[]) {
    const TEMP_HOST = /^https?:\/\/[^/]*myqcloud\.com\/.*[?&]q-sign-=/i
    const jobs: Array<() => Promise<void>> = []
    cardList.forEach(c => {
      const pushJob = (oldUrl: string, kind: 'image' | 'video' | 'audio', apply: (permanent: string) => void) => {
        if (!TEMP_HOST.test(oldUrl) || rehostingRef.current.has(oldUrl)) return
        rehostingRef.current.add(oldUrl)
        jobs.push(async () => {
          try {
            const permanent = await persistRemoteImage(oldUrl, kind)
            if (permanent && permanent !== oldUrl && isPersistedMediaUrl(permanent)) {
              apply(canonicalMediaPath(permanent))
            }
          } catch {
            /* 单条失败不阻塞其它, 下次打开再试 */
          } finally {
            setTimeout(() => rehostingRef.current.delete(oldUrl), 60_000)
          }
        })
      }
      if (c.url) pushJob(c.url, c.kind === 'video' ? 'video' : 'image', u => updateCard(c.id, { url: u }))
      c.results?.forEach((r, i) => {
        if (r.url) {
          pushJob(r.url, r.isVideo ? 'video' : 'image', u => {
            setCards(prev => prev.map(x => {
              if (x.id !== c.id || !x.results?.[i]) return x
              const results = x.results.map((it, j) => (j === i ? { ...it, url: u } : it))
              return { ...x, results, url: x.activeResultIndex === i ? u : x.url }
            }))
          })
        }
      })
      if (c.ttsState?.resultUrl) pushJob(c.ttsState.resultUrl, 'audio', u => updateTtsState(c.id, { resultUrl: u }))
      if (c.motionState?.resultUrl) pushJob(c.motionState.resultUrl, 'video', u => updateMotionState(c.id, { resultUrl: u }))
      if (c.vsrState?.resultUrl) pushJob(c.vsrState.resultUrl, 'video', u => updateVsrState(c.id, { resultUrl: u }))
    })
    // 最多 3 路并发, 避免一次打开大量历史卡时打爆后端
    let cursor = 0
    const worker = async () => {
      while (cursor < jobs.length) {
        const j = jobs[cursor]
        cursor += 1
        await j()
      }
    }
    if (jobs.length) await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, () => worker()))
  }

  /**
   * 单张成品结果图「按需」裂图自愈: 仅当该图实际加载失败(onError)时, 凭结果项 taskId
   * 从任务历史取回平台永久 CDN 地址替换。绝不在打开画布时批量改写健康的本地图片——
   * 存量数据保持原样, 只有真坏的图才被救回, 且替换成功才触发一次正常自动保存。
   * 同一 taskId 只查一次(含失败负缓存), 宫格/融合等无 taskId 的前端产物不在此列。
   */
  const healTriedRef = useRef<Set<string>>(new Set())
  async function healResultImageByTask(cardId: string, index: number, taskId: string) {
    if (!taskId || healTriedRef.current.has(taskId)) return
    healTriedRef.current.add(taskId)
    try {
      const res = await fetch(`${getPocketBaseUrl()}/api/media/result-urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ taskIds: [taskId] }),
      })
      if (!res.ok) return
      const data = (await res.json().catch(() => null)) as { urls?: Record<string, string> } | null
      const durable = data?.urls?.[taskId]
      if (!durable || !isDurableOutputMediaUrl(durable)) return
      // 仅当该结果项当前仍指向同一条本地链接时才替换, 避免覆盖用户的更新操作
      setCards(prev =>
        prev.map(x => {
          const item = x.id === cardId ? x.results?.[index] : undefined
          if (!item || item.taskId !== taskId || !isPersistedMediaUrl(item.url)) return x
          const results = x.results!.map((it, j) => (j === index ? { ...it, url: durable } : it))
          return { ...x, results, ...(x.activeResultIndex === index ? { url: durable } : {}) }
        }),
      )
    } catch {
      // 自愈失败静默: 下次该图再触发 onError 时, 负缓存阻止重复请求; 不阻塞画布
    }
  }

  /** 对恢复出的待续轮询任务按渠道分流(初始加载与冲突后加载最新共用) */
  function resumeRestoredJobs(docCards: CanvasCardData[], pending: PendingJobRecord[], sessionToken: number) {
    if (!pending.length) return
    const appJobSlugs = new Set([TTS_APP_SLUG, MOTION_APP_SLUG, VSR_APP_SLUG])
    const ttsJobs = pending.filter(j => j.model === TTS_APP_SLUG)
    const motionJobs = pending.filter(j => j.model === MOTION_APP_SLUG)
    const vsrJobs = pending.filter(j => j.model === VSR_APP_SLUG)
    const otherJobs = pending.filter(j => !appJobSlugs.has(j.model))
    if (otherJobs.length) void restorePendingJobs(otherJobs, docCards, sessionToken)
    if (ttsJobs.length) void restoreTtsJobs(ttsJobs, docCards, sessionToken)
    if (motionJobs.length) void restoreMotionJobs(motionJobs, docCards, sessionToken)
    if (vsrJobs.length) void restoreVsrJobs(vsrJobs, docCards, sessionToken)
  }

  useEffect(() => {
    if (!canvasId) return
    let active = true
    // 进入新画布: 换会话令牌并取消上一画布全部在轮询的任务, 杜绝旧任务回写新画布
    sessionTokenRef.current += 1
    jobAbortsRef.current.forEach(ac => ac.abort())
    jobAbortsRef.current.clear()
    // 切换画布或刷新时先锁住自动保存，避免旧画布状态覆盖刚加载的内容。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 自动保存闸门必须与旧画布状态同帧关闭；延迟一拍会重新打开旧文档覆盖窗口
    setDocLoaded(false)
    const sessionToken = sessionTokenRef.current
    // 切换前先把「上一画布」防抖中未落库的改动尽力发出去(读会话桶最新快照, 不依赖闭包)
    const prevId = lastCanvasIdRef.current
    lastCanvasIdRef.current = canvasId
    if (prevId && prevId !== canvasId) flushPersistNow(prevId)
    ;(async () => {
      try {
        const res = await fetch(`${CANVASES_API}/${canvasId}`, { headers: { ...getAuthHeaders() } })
        if (!res.ok) throw new Error('load failed')
        const rec = await res.json()
        if (!active || sessionToken !== sessionTokenRef.current) return
        // 崩溃/异常关闭恢复: 查其它会话留下的本地快照(当前会话正常关闭时自己的快照已随云端成功删除)
        const stale = await listStaleSnapshots(canvasId, browserSessionIdRef.current)
        if (!active || sessionToken !== sessionTokenRef.current) return
        const snap = stale[0] ?? null
        if (snap) {
          const cloudFp = canvasContentFingerprint({ title: rec?.title ?? '', doc: (rec?.canvas_data ?? {}) as Record<string, unknown> })
          const localFp = canvasContentFingerprint({ title: snap.title, doc: snap.doc })
          if (cloudFp === localFp) {
            // 云端已有同等内容(多半是切后台时抢发成功后进程才死): 不打扰, 直接清快照走正常加载
            await deleteStaleSnapshot(canvasId, snap.originSessionId)
          } else {
            // 先把云端文档灌进内存(基线=云端), 再挂起自动保存等用户选择, 避免选择前任何自动写入。
            // 云端待续轮询任务先存下: 用户选「以云端为准」时恢复轮询, 选「恢复我的改动」则以快照内任务为准。
            const { pending: cloudPending } = applyServerDoc(rec, canvasId, sessionToken, { suppressSave: true })
            cloudPendingAtRestoreRef.current = cloudPending
            setLocalRestore({
              canvasId,
              snapshot: { rev: snap.rev, title: snap.title, doc: snap.doc, savedAt: snap.savedAt, sessionId: snap.sessionId },
              originSessionId: snap.originSessionId,
              differsFromCloud: true,
            })
            setDocLoaded(true)
            setSaveState('local')
            return
          }
        }
        const { docCards, pending } = applyServerDoc(rec, canvasId, sessionToken, { suppressSave: true })
        setDocLoaded(true)
        // 分层节点: 刷新后对已生成图层后台重算透明抠图(切走画布即放弃回写)
        docCards.forEach(c => {
          if (c.kind === 'layer' && c.layerState) {
            c.layerState.layers.forEach(l => {
              if (l.genStatus === 'success' && l.genUrl && !l.cutoutUrl) {
                void cutoutWhiteBackground(l.genUrl).then(cut => {
                  if (cut && active && sessionToken === sessionTokenRef.current) {
                    updateLayerFor(c.id, l.id, { cutoutUrl: cut })
                  }
                })
              }
            })
          }
        })
        resumeRestoredJobs(docCards, pending, sessionToken)
      } catch {
        if (active && sessionToken === sessionTokenRef.current) {
          setDocLoaded(true)
          toast.error('画布加载失败, 请刷新页面重试')
        }
      }
    })()
    // 挂载时顺手清理过期本地快照
    void pruneExpiredSnapshots(Date.now())
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId])

  // ---------- 自动保存: 串行单飞 + 最新快照合并 + 视图拆分 + 乐观锁 + 本地双写兜底 ----------
  // 每次变化只在桶里标记 dirty, 实际请求严格串行; 上一笔完成后再取最新快照发送,
  // 从机制上保证后发永远不早于先发; 后端按 canvas_data.rev 乐观锁再兜底一层。
  // 全量内容在发送前同步写入 IndexedDB, 云端确认后删除: 崩溃/强杀/断网关机也能下次恢复。
  const saveTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const saveInFlightRef = useRef<Record<string, boolean>>({})
  const saveDirtyRef = useRef<Record<string, { full: boolean; view: boolean }>>({})
  // 各画布「待同步内容是否已安全落本地盘」: 关页原生确认只在盘上也没有时才弹
  const localSafeRef = useRef<Record<string, boolean>>({})
  // 各画布是否有全量(内容)请求正在途中: 卸载瞬间 dirty 已被消费, 靠它判断内容风险
  const inFlightFullRef = useRef<Record<string, boolean>>({})
  // 各画布「下一笔全量保存强制覆盖乐观锁」一次性标记(崩溃恢复接管后使用)
  const pendingForceRef = useRef<Record<string, boolean>>({})

  /** 抠图 dataUrl 太大不落库(刷新按 genUrl 重算); 上传中的 blob: 链接刷新即失效, 临时清空 */
  /**
   * 组持久化卡片: 正在上传、url 还是 blob: 本地预览的卡, 用上一版已成功持久化的完整卡片快照顶替,
   * 绝不能剥成空 url 写进全量文档覆盖云端(否则刷新后图片消失、卡片塌成 180 高)。
   * 全新卡首次上传、尚无旧快照时, 用同 id 占位: 剥掉 blob url 但保留卡片骨架与位置,
   * 上传完成后的下一次保存会带上永久链接(只此一次, 且不会覆盖任何已有图片)。
   */
  function buildPersistCards(srcCards: CanvasCardData[]): CanvasCardData[] {
    return srcCards.map(c => {
      let next = c
      if (c.kind === 'layer' && c.layerState) {
        next = { ...c, layerState: { ...c.layerState, layers: c.layerState.layers.map(l => ({ ...l, cutoutUrl: null })) } }
      }
      if (next.url && next.url.startsWith('blob:')) {
        const prevMedia = lastPersistedMediaRef.current.get(c.id)
        if (prevMedia) {
          // 有上一版永久媒体: 保留旧的 url/results, 不被在途 blob 剥空, 位置/改名等字段取当前值
          next = {
            ...next,
            url: prevMedia.url,
            ...(prevMedia.results ? { results: prevMedia.results } : {}),
          }
        } else {
          // 全新卡首次上传在途: 剥掉不可持久化的 blob, 骨架先入库; 永久链接随上传完成后的下一次保存写入
          next = { ...next, url: '', jobStatus: next.jobStatus === 'running' ? 'queued' : next.jobStatus }
        }
      }
      // 语音克隆: 上传中的 blob 本地链接不入库
      if (next.kind === 'tts' && next.ttsState) {
        const ts = { ...next.ttsState }
        let dirty = false
        if (ts.cloneAudioUrl?.startsWith('blob:')) { ts.cloneAudioUrl = undefined; ts.cloneAudioName = undefined; dirty = true }
        if (ts.emotionRefAudioUrl?.startsWith('blob:')) { ts.emotionRefAudioUrl = undefined; ts.emotionRefAudioName = undefined; dirty = true }
        if (ts.resultUrl?.startsWith('blob:')) { ts.resultUrl = undefined; dirty = true }
        if (dirty) next = { ...next, ttsState: ts }
      }
      // 动作迁移: 上传中的 blob 本地链接不入库
      if (next.kind === 'motion' && next.motionState) {
        const ms = { ...next.motionState }
        let motionDirty = false
        if (ms.refImageUrl?.startsWith('blob:')) { ms.refImageUrl = undefined; ms.refImageName = undefined; motionDirty = true }
        if (ms.refVideoUrl?.startsWith('blob:')) { ms.refVideoUrl = undefined; ms.refVideoName = undefined; ms.refVideoDuration = undefined; motionDirty = true }
        if (ms.resultUrl?.startsWith('blob:')) { ms.resultUrl = undefined; motionDirty = true }
        if (motionDirty) next = { ...next, motionState: ms }
      }
      // 视频高清修复: 上传中的 blob 本地链接不入库
      if (next.kind === 'vsr' && next.vsrState) {
        const vs = { ...next.vsrState }
        let vsrDirty = false
        if (vs.videoUrl?.startsWith('blob:')) { vs.videoUrl = undefined; vs.videoName = undefined; vs.videoDuration = undefined; vsrDirty = true }
        if (vs.resultUrl?.startsWith('blob:')) { vs.resultUrl = undefined; vsrDirty = true }
        if (vsrDirty) next = { ...next, vsrState: vs }
      }
      return next
    })
  }

  /** 排掉某画布的待发主动重试定时器 */
  function clearRetryTimer(id: string) {
    if (retryTimerRef.current[id]) {
      clearTimeout(retryTimerRef.current[id])
      delete retryTimerRef.current[id]
    }
  }

  /** 失败后按指数退避安排一次主动重试(1s→3s→10s→30s→60s 封顶, ±20% 抖动), 无需用户再操作 */
  function scheduleRetry(targetCanvasId: string) {
    if (retryTimerRef.current[targetCanvasId]) return
    if (saveConflictRef.current?.canvasId === targetCanvasId) return
    const step = Math.min(retryStepRef.current[targetCanvasId] ?? 0, RETRY_BACKOFF_MS.length - 1)
    const base = RETRY_BACKOFF_MS[step]
    retryStepRef.current[targetCanvasId] = step + 1
    const jitter = base * 0.2 * (2 * Math.random() - 1)
    retryTimerRef.current[targetCanvasId] = setTimeout(() => {
      delete retryTimerRef.current[targetCanvasId]
      const marks = saveDirtyRef.current[targetCanvasId]
      if (!marks?.full && !marks?.view) return
      if (navigator.onLine === false) return // online 事件会再触发
      void sendPersist(targetCanvasId)
    }, Math.max(300, base + jitter))
  }

  /** 全量内容在发云端前先落本地盘; 失败返回 false(顶栏不能显示「本地已存」) */
  async function writeLocalSnapshotBeforeSend(targetCanvasId: string, baseRev: number, doc: CanvasDoc, title: string): Promise<boolean> {
    try {
      const snap: LocalCanvasSnapshot = {
        rev: baseRev,
        title,
        doc: doc as unknown as Record<string, unknown>,
        savedAt: Date.now(),
        sessionId: browserSessionIdRef.current,
      }
      return await putLocalSnapshot(targetCanvasId, browserSessionIdRef.current, snap)
    } catch {
      return false
    }
  }

  async function sendPersist(targetCanvasId: string, opts?: { keepalive?: boolean; force?: boolean }) {
    const bucket = docBucketsRef.current[targetCanvasId]
    if (!bucket) return
    const marks = saveDirtyRef.current[targetCanvasId]
    if (!marks || (!marks.full && !marks.view)) return
    // 单飞: 同一画布同一时刻只有一个在途 PATCH, 完成后检查 dirty 决定是否补发最新快照
    if (saveInFlightRef.current[targetCanvasId]) return
    // 冲突挂起/恢复弹窗未决时不自动发, 避免覆盖别处新版本或打断用户选择
    if (saveConflictRef.current?.canvasId === targetCanvasId) return
    if (localRestoreRef.current?.canvasId === targetCanvasId) return
    saveInFlightRef.current[targetCanvasId] = true
    const wantFull = marks.full
    const wantView = marks.view
    const wantForce = !!opts?.force || !!pendingForceRef.current[targetCanvasId]
    if (wantForce) pendingForceRef.current[targetCanvasId] = false
    if (wantFull) inFlightFullRef.current[targetCanvasId] = true
    if (targetCanvasId === canvasId) armSavingFlash(targetCanvasId)
    saveDirtyRef.current[targetCanvasId] = { full: false, view: false }
    const baseRev = bucket.rev || 0
    let localLanded = false
    let fullDoc: CanvasDoc | null = null
    if (wantFull) {
      // 全量保存携带当时最新视图; 版本号(rev)由服务端统一分配, 这里只传基线供乐观锁校验
      fullDoc = {
        version: 1,
        cards: buildPersistCards(bucket.cards),
        connections: bucket.connections,
        view: bucket.viewport,
        pendingJobs: bucket.pending,
        projectAssets: bucket.projectAssets,
        logs: bucket.logs.slice(0, 500),
      }
      // 先落本地兜底盘再排队等云槽: 等槽期间页面被终止也不丢(崩溃恢复的唯一来源)
      localLanded = await writeLocalSnapshotBeforeSend(targetCanvasId, baseRev, fullDoc, bucket.title)
      localSafeRef.current[targetCanvasId] = localSafeRef.current[targetCanvasId] || localLanded
    }
    // 全局并发槽: 卸载抢发不排队, 平时多画布最多 2 笔在途
    const releaseSlot = opts?.keepalive ? tryAcquireCloudSlot() : await acquireCloudSlot()
    // 序列化一次: 同时拿到请求体大小(keepalive 64KB 判定)与内容指纹(幂等键)
    let body: Record<string, unknown>
    if (wantFull) {
      body = {
        title: bucket.title,
        canvas_data: fullDoc,
        canvas_rev: baseRev,
        // 409 冲突后用户显式选择「用我的版本覆盖」时带上, 服务端跳过基线校验但仍自增 rev
        ...(wantForce ? { canvas_force: true } : {}),
      }
    } else {
      // 纯视图变化(平移/缩放)只发视图, 不重写画布内容, 避免拖动画布也产生整文档写入
      body = {
        canvas_data: { view: bucket.viewport },
        canvas_view_only: true,
        canvas_rev: baseRev,
      }
    }
    const bodyText = JSON.stringify(body)
    // 幂等键: 按内容指纹生成, 同内容网络重试复用(服务端命中回放, 消除响应丢失导致的伪 409);
    // force 覆盖与纯视角不幂等(语义上每次都应真实处理)
    const idemKey = wantFull && !wantForce ? `c-${cyrb53Hex(bodyText)}` : ''
    // 卸载路径 + 全量体超过 keepalive 上限: 浏览器会静默丢弃, 不强发。
    // 页面仍存活(SPA 路由离开)时 1.2s 后走普通请求补发; 真正终止时靠本地快照下次打开恢复。
    if (opts?.keepalive && wantFull && bodyText.length > KEEPALIVE_BODY_LIMIT) {
      const cur3 = saveDirtyRef.current[targetCanvasId] || { full: false, view: false }
      cur3.full = true
      saveDirtyRef.current[targetCanvasId] = cur3
      if (!retryTimerRef.current[targetCanvasId]) {
        retryTimerRef.current[targetCanvasId] = setTimeout(() => {
          delete retryTimerRef.current[targetCanvasId]
          void sendPersist(targetCanvasId)
        }, 1200)
      }
      if (targetCanvasId === canvasId) setSaveState(localSafeRef.current[targetCanvasId] ? 'local' : 'error')
      return
    }
    const res = await fetch(`${CANVASES_API}/${targetCanvasId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
          ...(idemKey ? { 'X-Idempotency-Key': idemKey } : {}),
        },
        body: bodyText,
        keepalive: !!opts?.keepalive,
      })
    try {
      if (res.ok) {
        const updated = (await res.json().catch(() => null)) as { canvas_data?: { rev?: number } } | null
        const serverRev = Number(updated?.canvas_data?.rev ?? 0)
        const b = docBucketsRef.current[targetCanvasId]
        // 只增不减(同上, 防止任何晚到响应把基线拉回旧版本)
        if (b && serverRev > b.rev) b.rev = serverRev
        clearRetryTimer(targetCanvasId)
        retryStepRef.current[targetCanvasId] = 0
        // 云端确认: 内容快照已无用, 清本地盘
        if (wantFull) {
          void clearLocalSnapshot(targetCanvasId, browserSessionIdRef.current)
          localSafeRef.current[targetCanvasId] = false
          // 通知同浏览器其它标签页: 云端有新版本了
          postCanvasMessage({ type: 'canvas-saved', canvasId: targetCanvasId, rev: serverRev, fromSession: browserSessionIdRef.current })
        }
        if (targetCanvasId === canvasId) {
          const stillDirty = saveDirtyRef.current[targetCanvasId]
          setSaveState(stillDirty?.full || stillDirty?.view ? 'saving' : 'saved')
        }
      } else if (res.status === 409) {
        // 内容保存版本冲突(多标签/多设备同开)。绝不再用本地旧快照自动重放 —— 那会静默覆盖别处的新内容。
        // 保留本次改动(重标 dirty, 基线不前移到新版本, 否则会被当成最新而误覆盖),
        // 弹出冲突选择让用户决定「加载最新 / 强制覆盖」。
        let serverRev = 0
        try {
          const conflict = (await res.json().catch(() => null)) as { canvas_rev?: number } | null
          serverRev = Number(conflict?.canvas_rev ?? 0) || 0
        } catch {
          /* 忽略冲突体解析失败 */
        }
        const cur = saveDirtyRef.current[targetCanvasId] || { full: false, view: false }
        if (wantFull) cur.full = true
        if (wantView && !wantFull) cur.view = true
        saveDirtyRef.current[targetCanvasId] = cur
        if (wantFull) localSafeRef.current[targetCanvasId] = localSafeRef.current[targetCanvasId] || localLanded
        clearRetryTimer(targetCanvasId)
        if (targetCanvasId === canvasId && wantFull) {
          setSaveState('conflict')
          setSaveConflict(prev => prev ?? { canvasId: targetCanvasId, serverRev })
        }
      } else if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 412) {
        // 登录过期/失效: 改动必须留住待登录后续存, 顶栏标红并弹登录, 不能只悄悄置一个灰字。
        // 本地已落盘的内容显示「本地已存·待同步」, 让用户知道崩溃也不丢; 不落盘才是失败红标。
        const cur = saveDirtyRef.current[targetCanvasId] || { full: false, view: false }
        if (wantFull) cur.full = true
        if (wantView && !wantFull) cur.view = true
        saveDirtyRef.current[targetCanvasId] = cur
        if (wantFull) localSafeRef.current[targetCanvasId] = localSafeRef.current[targetCanvasId] || localLanded
        clearRetryTimer(targetCanvasId)
        if (targetCanvasId === canvasId) {
          setSaveState(wantFull && localSafeRef.current[targetCanvasId] ? 'local' : 'error')
          setAuthDialog('login')
          toast.error('登录已过期, 改动尚未同步, 请重新登录后会自动续存')
        }
      } else {
        // 其它 5xx/400: 保留改动, 进入指数退避主动重试, 顶栏按本地落盘情况区分状态
        const cur2 = saveDirtyRef.current[targetCanvasId] || { full: false, view: false }
        if (wantFull) cur2.full = true
        if (wantView && !wantFull) cur2.view = true
        saveDirtyRef.current[targetCanvasId] = cur2
        if (wantFull) localSafeRef.current[targetCanvasId] = localSafeRef.current[targetCanvasId] || localLanded
        if (targetCanvasId === canvasId) {
          setSaveState(wantFull && localSafeRef.current[targetCanvasId] ? 'local' : 'error')
        }
        scheduleRetry(targetCanvasId)
      }
    } catch {
      // 网络失败: 重新标记待保存, 指数退避主动重试 + online 事件双保险, 不丢改动
      const cur = saveDirtyRef.current[targetCanvasId] || { full: false, view: false }
      if (wantFull) cur.full = true
      if (wantView && !wantFull) cur.view = true
      saveDirtyRef.current[targetCanvasId] = cur
      if (wantFull) localSafeRef.current[targetCanvasId] = localSafeRef.current[targetCanvasId] || localLanded
      if (targetCanvasId === canvasId) {
        setSaveState(wantFull && localSafeRef.current[targetCanvasId] ? 'local' : 'error')
      }
      scheduleRetry(targetCanvasId)
    } finally {
      releaseSlot()
      saveInFlightRef.current[targetCanvasId] = false
      if (wantFull) delete inFlightFullRef.current[targetCanvasId]
      // 链式补发会重新 arm 闪烁定时器; 终态(成功/冲突)则取消, 避免已保存后闪一下「同步中」
      const stillDirty = !!(saveDirtyRef.current[targetCanvasId]?.full || saveDirtyRef.current[targetCanvasId]?.view)
      if (!stillDirty) cancelSavingFlash()
      // 409 冲突已挂起等用户选择时, 绝不自动补发(否则又用旧快照覆盖); 其余情况有待发改动则串行补发最新快照
      const conflictPending = saveConflictRef.current?.canvasId === targetCanvasId
      const restorePending = localRestoreRef.current?.canvasId === targetCanvasId
      if (!conflictPending && !restorePending && stillDirty) void sendPersist(targetCanvasId)
    }
  }

  /** 立即把防抖中未落库的改动发出去(切画布/卸载前调用) */
  function flushPersistNow(targetCanvasId?: string) {
    const id = targetCanvasId ?? canvasId
    if (!id) return
    if (saveTimerRef.current[id]) {
      clearTimeout(saveTimerRef.current[id])
      delete saveTimerRef.current[id]
    }
    // 冲突挂起时不允许普通 flush 覆盖, 必须用户先做选择
    if (saveConflictRef.current?.canvasId === id) return
    void sendPersist(id)
  }

  function focusAgentNode(nodeId: string) {
    const card = cardsRef.current.find(item => item.id === nodeId)
    if (!card) return
    setSelectedIds([nodeId])
    frameCards([card])
  }

  async function prepareAgentTurn() {
    const id = canvasId
    const token = sessionTokenRef.current
    if (!id || !docLoaded) throw new Error('画布尚未加载')
    flushPersistNow(id)
    const deadline = Date.now() + 15000
    // A UI save label is not a receipt; inspect the persistence queue itself.
    while (Date.now() < deadline) {
      if (sessionTokenRef.current !== token) throw new Error('画布已切换')
      if (saveConflictRef.current || localRestoreRef.current) throw new Error('请先处理画布版本冲突')
      const dirty = saveDirtyRef.current[id]
      if (!dirty?.full && !dirty?.view && !saveInFlightRef.current[id] && !saveTimerRef.current[id]) return
      await new Promise(resolve => setTimeout(resolve, 80))
    }
    throw new Error('画布尚未同步，请稍后发送')
  }

  async function syncAgentRevision(revision: number) {
    const id = canvasId
    const token = sessionTokenRef.current
    if (!id || !docLoaded) return
    const before = docBucketsRef.current[id]
    if (!before || before.rev >= revision) return
    const conflict = () => {
      setSaveState('conflict')
      setSaveConflict(prev => prev ?? { canvasId: id, serverRev: revision })
    }
    const dirty = saveDirtyRef.current[id]
    if (dirty?.full || dirty?.view || saveInFlightRef.current[id] || saveTimerRef.current[id]) { conflict(); return }
    const res = await fetch(`${CANVASES_API}/${id}`, { headers: { ...getAuthHeaders() } })
    if (!res.ok) throw new Error('画布更新读取失败')
    const rec = await res.json()
    if (sessionTokenRef.current !== token) return
    const now = docBucketsRef.current[id]
    const dirtyNow = saveDirtyRef.current[id]
    if (saveConflictRef.current || localRestoreRef.current || dirtyNow?.full || dirtyNow?.view || saveInFlightRef.current[id] || saveTimerRef.current[id] || now?.cards !== before.cards || now?.connections !== before.connections) { conflict(); return }
    if ((Number(rec.canvas_data?.rev) || 0) < (now?.rev || 0)) return
    applyServerDoc(rec, id, token, { suppressSave: true })
  }

  /** 冲突选择一: 加载别处已保存的最新版; 本地未同步改动先备份, 提供一次「取回我的版本」 */
  async function resolveConflictReload() {
    const conflict = saveConflictRef.current
    setSaveConflict(null)
    if (!conflict) return
    const id = conflict.canvasId
    // 覆盖前把本地待发内容备份一份(只保留最近一次), 误选后可取回
    const hadLocalChanges = !!(saveDirtyRef.current[id]?.full || saveDirtyRef.current[id]?.view)
    if (hadLocalChanges) {
      const b = docBucketsRef.current[id]
      if (b) {
        try {
          await putConflictBackup(id, {
            rev: b.rev || 0,
            title: b.title,
            doc: {
              version: 1,
              cards: buildPersistCards(b.cards),
              connections: b.connections,
              view: b.viewport,
              pendingJobs: b.pending,
              projectAssets: b.projectAssets,
              logs: b.logs.slice(0, 500),
            },
            savedAt: Date.now(),
            sessionId: browserSessionIdRef.current,
            serverRev: conflict.serverRev,
            backedAt: Date.now(),
          })
          setConflictBackupAvailable(true)
        } catch {
          /* 备份失败不阻断「加载最新」主流程 */
        }
      }
    }
    // 丢弃本地待发内容改动
    saveDirtyRef.current[id] = { full: false, view: false }
    localSafeRef.current[id] = false
    clearRetryTimer(id)
    try {
      const res = await fetch(`${CANVASES_API}/${id}`, { headers: { ...getAuthHeaders() } })
      if (!res.ok) throw new Error('reload failed')
      const rec = await res.json()
      if (id !== canvasId) return
      const { docCards, pending } = applyServerDoc(rec, id, sessionTokenRef.current, { suppressSave: true })
      setDocLoaded(true)
      resumeRestoredJobs(docCards, pending, sessionTokenRef.current)
      setSaveState('saved')
      toast.success(hadLocalChanges ? '已加载最新版本, 本地改动已保留, 顶栏可取回' : '已加载最新版本')
    } catch {
      // 拉取失败: 保留冲突态让用户可重试, 不静默
      setSaveConflict({ canvasId: id, serverRev: conflict.serverRev })
      toast.error('加载最新版本失败, 请检查网络后重试')
    }
  }

  /** 冲突误选撤销: 取出刚才备份的本地版本并强制覆盖回去(只保留一次机会) */
  async function restoreConflictBackup() {
    const id = lastCanvasIdRef.current || canvasId
    if (!id) return
    const backup = await takeConflictBackup(id)
    if (!backup) {
      toast.error('没有可取回的本地版本')
      return
    }
    setConflictBackupAvailable(false)
    const rec = { title: backup.title, canvas_data: backup.doc }
    const { docCards, pending } = applyServerDoc(rec, id, sessionTokenRef.current, { suppressSave: true })
    setDocLoaded(true)
    resumeRestoredJobs(docCards, pending, sessionTokenRef.current)
    const b = docBucketsRef.current[id]
    if (b && backup.serverRev > b.rev) b.rev = backup.serverRev
    saveDirtyRef.current[id] = { full: true, view: false }
    if (saveTimerRef.current[id]) {
      clearTimeout(saveTimerRef.current[id])
      delete saveTimerRef.current[id]
    }
    setSaveState('saving')
    void sendPersist(id, { force: true })
    toast.success('已取回你的本地版本, 正在覆盖同步')
  }

  function dismissConflictBackup() {
    setConflictBackupAvailable(false)
  }

  /** 崩溃恢复选择一: 以云端为准, 丢弃本地快照(同时清掉同画布其它陈旧快照) */
  async function discardLocalRestore() {
    const r = localRestoreRef.current
    if (!r) return
    setLocalRestore(null)
    const { canvasId: id, originSessionId } = r
    await deleteStaleSnapshot(id, originSessionId)
    // 同画布若还残留别的崩溃标签页快照, 一并清掉, 避免下次打开再弹
    const rest = await listStaleSnapshots(id, browserSessionIdRef.current)
    for (const s of rest) await deleteStaleSnapshot(id, s.originSessionId)
    // 内存里已灌的是云端文档, 补续它携带的生成任务轮询
    const cloudCards = cardsRef.current
    resumeRestoredJobs(cloudCards, cloudPendingAtRestoreRef.current, sessionTokenRef.current)
    cloudPendingAtRestoreRef.current = []
    setSaveState('saved')
    toast.success('已使用云端最新版本, 本地未同步内容已清除')
  }

  /**
   * 崩溃恢复选择二: 把本地快照灌入画布, 随后走常规防抖保存(带 force,
   * 快照基线可能落后云端, 属于用户显式选择覆盖)。
   */
  function acceptLocalRestore() {
    const r = localRestoreRef.current
    if (!r) return
    const { canvasId: id, snapshot, originSessionId } = r
    setLocalRestore(null)
    cloudPendingAtRestoreRef.current = []
    const { docCards, pending } = applyServerDoc(
      { title: snapshot.title, canvas_data: snapshot.doc },
      id,
      sessionTokenRef.current,
      // 不抑制保存 effect: 灌入后让常规防抖链路在 900ms 后自动发最新桶, 避开时序依赖
    )
    resumeRestoredJobs(docCards, pending, sessionTokenRef.current)
    pendingForceRef.current[id] = true
    localSafeRef.current[id] = true
    // 接管后该快照归当前会话所有: 旧会话键删除, 正常保存成功后会清当前会话键
    void deleteStaleSnapshot(id, originSessionId)
    toast.success('已恢复未保存的改动, 稍后将自动同步到云端')
  }

  /** 崩溃恢复弹窗挂起期间不做选择, 快照留在本机下次再问 */
  function deferLocalRestore() {
    setLocalRestore(null)
    cloudPendingAtRestoreRef.current = []
    setSaveState('local')
    toast.message('未保存的改动仍保留在本机, 下次打开这个画布可再次选择恢复')
  }

  /** 冲突选择二: 用本地版本强制覆盖别处的新内容(用户显式确认, 服务端 canvas_force 跳过基线校验) */
  function resolveConflictOverwrite() {
    const conflict = saveConflictRef.current
    setSaveConflict(null)
    if (!conflict) return
    const id = conflict.canvasId
    // 把本地基线对齐到服务端 rev, 再带 force 发一次最新全量
    const b = docBucketsRef.current[id]
    if (b && conflict.serverRev > b.rev) b.rev = conflict.serverRev
    saveDirtyRef.current[id] = { full: true, view: false }
    if (saveTimerRef.current[id]) {
      clearTimeout(saveTimerRef.current[id])
      delete saveTimerRef.current[id]
    }
    setSaveState('saving')
    void sendPersist(id, { force: true })
  }

  // 「同步中」字样延迟显示: 请求 300ms 内完成不切换状态, 避免快速保存时顶栏频闪
  const savingFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function armSavingFlash(id: string) {
    if (savingFlashTimerRef.current) clearTimeout(savingFlashTimerRef.current)
    savingFlashTimerRef.current = setTimeout(() => {
      savingFlashTimerRef.current = null
      if (saveInFlightRef.current[id] && id === canvasId && !saveConflictRef.current) setSaveState('saving')
    }, 300)
  }
  function cancelSavingFlash() {
    if (savingFlashTimerRef.current) {
      clearTimeout(savingFlashTimerRef.current)
      savingFlashTimerRef.current = null
    }
  }

  /**
   * 动态防抖时长:
   * - 视图拖动 0.6s, 不受规模影响(请求体很小);
   * - 内容保存按画布卡片数(120/400 两档)与网络信息(saveData/弱网 rtt)在 0.9–1.5s 浮动,
   *   小画布好网最低 0.6s, 让大画布弱网下少排队、少发大请求。
   */
  function saveDebounceMs(kind: 'full' | 'view', cardCount: number): number {
    if (kind === 'view') return 600
    let delay = 900
    if (cardCount > 400) delay += 500
    else if (cardCount > 120) delay += 250
    try {
      const conn = (navigator as Navigator & { connection?: { saveData?: boolean; rtt?: number } }).connection
      if (conn?.saveData || (typeof conn?.rtt === 'number' && conn.rtt >= 400)) delay = Math.min(1500, delay + 300)
    } catch {
      /* 无网络信息用默认 */
    }
    if (cardCount <= 30) delay = Math.min(delay, 600)
    return delay
  }

  function scheduleSave(kind: 'full' | 'view') {
    if (!docLoaded || !canvasId) return
    // 崩溃恢复弹窗未决: 改动标记照常累积, 但不抢状态、不调度发送(用户选择后再发)
    if (localRestoreRef.current?.canvasId === canvasId) return
    const marks = saveDirtyRef.current[canvasId] || { full: false, view: false }
    if (kind === 'full') marks.full = true
    else if (!marks.full) marks.view = true
    saveDirtyRef.current[canvasId] = marks
    // 冲突弹窗挂起期间继续累积改动, 但不抢状态、不调度发送(用户选择后再发最新快照)
    if (saveConflictRef.current?.canvasId === canvasId) return
    // 用户有新操作: 退避重试从 1s 重新起步
    clearRetryTimer(canvasId)
    retryStepRef.current[canvasId] = 0
    setSaveState('editing')
    if (saveTimerRef.current[canvasId]) clearTimeout(saveTimerRef.current[canvasId])
    const delay = saveDebounceMs(kind === 'view' && !marks.full ? 'view' : 'full', cardsRef.current.length)
    saveTimerRef.current[canvasId] = setTimeout(() => {
      delete saveTimerRef.current[canvasId]
      void sendPersist(canvasId)
    }, delay)
  }

  // 内容变化: 全量保存(程序灌入服务端文档的一拍跳过, 避免打开/同步后无意义回存)
  useEffect(() => {
    const timers = saveTimerRef.current
    if (suppressContentSaveRef.current > 0) {
      suppressContentSaveRef.current -= 1
      return
    }
    scheduleSave('full')
    return () => {
      if (canvasId && timers[canvasId]) {
        clearTimeout(timers[canvasId])
        delete timers[canvasId]
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, connections, canvasTitle, pendingJobs, genLogs, projectAssets, docLoaded, canvasId])

  // 视图变化(平移/缩放): 只保存视图(程序灌入服务端文档的一拍跳过)
  useEffect(() => {
    const timers = saveTimerRef.current
    if (suppressViewSaveRef.current > 0) {
      suppressViewSaveRef.current -= 1
      return
    }
    scheduleSave('view')
    return () => {
      if (canvasId && timers[canvasId]) {
        clearTimeout(timers[canvasId])
        delete timers[canvasId]
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, docLoaded, canvasId])

  // 卸载路径专用: 不等防抖, 直接把当前最新全量快照写入本地盘(崩溃恢复的兜底来源)
  async function dumpLocalSnapshotNow(id: string): Promise<boolean> {
    const b = docBucketsRef.current[id]
    if (!b) return false
    try {
      const ok = await writeLocalSnapshotBeforeSend(
        id,
        b.rev || 0,
        {
          version: 1,
          cards: buildPersistCards(b.cards),
          connections: b.connections,
          view: b.viewport,
          pendingJobs: b.pending,
          projectAssets: b.projectAssets,
          logs: b.logs.slice(0, 500),
        } as CanvasDoc,
        b.title,
      )
      if (ok) localSafeRef.current[id] = true
      return ok
    } catch {
      return false
    }
  }

  // 关页/切后台/切画布多通道保存, 尽量消除最后几笔改动的丢失窗口(读 ref, 不依赖首次渲染闭包):
  //  - visibilitychange=hidden(切后台/最小化/移动端切 App, 关页前大多先触发): 页面尚未终止,
  //    先把最新全量快照写本地盘, 再用普通 fetch 提前 flush(不受 keepalive 64KB 限制);
  //  - pagehide(关标签/跳走): 发起本地写盘后再补一笔 keepalive(≤64KB 请求浏览器卸载后继续发完),
  //    发不出去也有盘上快照, 下次打开提示恢复;
  //  - React cleanup(SPA 内路由离开, 如返回首页): 先落盘再 keepalive。
  // 冲突挂起中不强发(避免覆盖别处的新版本)。
  useEffect(() => {
    function clearTimers() {
      Object.keys(saveTimerRef.current).forEach(id => {
        if (saveTimerRef.current[id]) clearTimeout(saveTimerRef.current[id])
      })
      Object.keys(retryTimerRef.current).forEach(id => {
        if (retryTimerRef.current[id]) clearTimeout(retryTimerRef.current[id])
      })
    }
    function targetId() {
      return lastCanvasIdRef.current
    }
    function marksOf(id: string | null) {
      if (!id) return null
      if (saveConflictRef.current?.canvasId === id) return null
      return saveDirtyRef.current[id] ?? null
    }
    async function onHidden() {
      const id = targetId()
      const m = marksOf(id)
      if (!id || !m || (!m.full && !m.view)) return
      clearTimers()
      // 防抖窗口里的最新内容先落盘(hidden 后页面通常不会立刻终止, 事务来得及完成)
      if (m.full && !localSafeRef.current[id]) await dumpLocalSnapshotNow(id)
      void sendPersist(id)
    }
    function onPageHide() {
      const id = targetId()
      const m = marksOf(id)
      if (!id || !m || (!m.full && !m.view)) return
      clearTimers()
      if (m.full && !localSafeRef.current[id]) void dumpLocalSnapshotNow(id)
      void sendPersist(id, { keepalive: true })
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPageHide)
      clearTimers()
      const lastId = lastCanvasIdRef.current
      const m = lastId ? marksOf(lastId) : null
      if (!lastId || !m || (!m.full && !m.view)) return
      // SPA 内路由离开: JS 环境仍存活, 先落盘再抢发
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 卸载兜底必须读取最新的本地安全标记
      if (m.full && !localSafeRef.current[lastId]) {
        void dumpLocalSnapshotNow(lastId).then(ok => {
          if (ok) void sendPersist(lastId, { keepalive: true })
        })
      } else {
        void sendPersist(lastId, { keepalive: true })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 关页原生拦截只在「内容有丢失风险」时弹: 内容待发/全量在途且本地盘也没有, 或冲突待选择。
  // 本地已存(断网也能恢复)、纯视角变化、已保存、空闲均不打扰。
  useEffect(() => {
    const id = canvasId
    function onBeforeUnload(ev: BeforeUnloadEvent) {
      if (!id) return
      if (saveConflictRef.current?.canvasId === id) {
        ev.preventDefault()
        ev.returnValue = '画布存在待处理的版本冲突, 确定离开吗?'
        return
      }
      if (localRestoreRef.current) return
      const m = saveDirtyRef.current[id]
      const contentAtRisk = (!!m?.full || inFlightFullRef.current[id]) && !localSafeRef.current[id]
      // 有文件仍在上传: 全新卡首传若此刻终止, 永久链接还没写回, 再进来就是无图空卡
      const uploadInFlight = getMediaUploadInflight() > 0
      if (contentAtRisk || uploadInFlight) {
        ev.preventDefault()
        ev.returnValue = uploadInFlight
          ? '图片还在上传中, 现在离开可能丢失图片, 确定离开吗?'
          : '有改动尚未保存, 确定离开吗?'
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
    // 回调内全部读 ref, 只随画布 id 挂一次: 旧依赖每次编辑/任务回写都重订阅一次监听
  }, [canvasId])

  // 网络恢复 / 定时退避双保险: 从离线回到在线, 立刻把所有画布的待发改动补发一次
  useEffect(() => {
    function onOnline() {
      Object.keys(saveDirtyRef.current).forEach(id => {
        const m = saveDirtyRef.current[id]
        if (!m || (!m.full && !m.view)) return
        if (saveConflictRef.current?.canvasId === id) return
        if (localRestoreRef.current?.canvasId === id) return
        if (saveInFlightRef.current[id]) return
        clearRetryTimer(id)
        retryStepRef.current[id] = 0
        if (saveTimerRef.current[id]) {
          clearTimeout(saveTimerRef.current[id])
          delete saveTimerRef.current[id]
        }
        void sendPersist(id)
      })
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 同浏览器多标签协同: 别的标签保存了同一画布——
  // 本标签没有未同步改动就静默拉到最新(消掉绝大多数保存时 409); 有未同步改动则提前弹出冲突选择。
  useEffect(() => {
    return onCanvasMessage(msg => {
      if (msg.type !== 'canvas-saved' || msg.canvasId !== canvasId) return
      if (msg.fromSession === browserSessionIdRef.current) return
      if (saveConflictRef.current || localRestoreRef.current) return
      const b = docBucketsRef.current[canvasId]
      if (!b) return
      // 版本不新于本地基线: 旧消息/自己的回声, 忽略
      if (msg.rev && b.rev >= msg.rev) return
      const m = saveDirtyRef.current[canvasId]
      const pendingLocal = !!(m?.full || m?.view) || !!saveTimerRef.current[canvasId] || saveInFlightRef.current[canvasId]
      if (pendingLocal) {
        // 本地有未同步内容且云端已被别的标签推进: 提前挂冲突, 不等保存时才发现
        if (!saveInFlightRef.current[canvasId]) {
          setSaveState('conflict')
          setSaveConflict(prev => prev ?? { canvasId, serverRev: msg.rev || b.rev + 1 })
        }
        return
      }
      // 本地干净: 静默同步
      void (async () => {
        try {
          const res = await fetch(`${CANVASES_API}/${canvasId}`, { headers: { ...getAuthHeaders() } })
          if (!res.ok) return
          const rec = await res.json()
          if (saveConflictRef.current || localRestoreRef.current) return
          const m2 = saveDirtyRef.current[canvasId]
          if (m2?.full || m2?.view || saveTimerRef.current[canvasId]) return
          applyServerDoc(rec, canvasId, sessionTokenRef.current, { suppressSave: true })
        } catch {
          /* 静默同步失败不打扰, 乐观锁在保存时兜底 */
        }
      })()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId])

  // ---------- 单价(本地用户价表, 与后端收费同源) ----------

  /** 模型价格组合键: 视频=模型|分辨率|时长; 图片=模型|分辨率|质量|比例; 基础单价仍存模型名键作回退 */
  function priceKeyFor(model: string, params?: GenNodeParams): string {
    const kind = modelKindOf(model)
    if (kind === 't2v' || kind === 'i2v') {
      return `${model}|${params?.resolution ?? '1k'}|${params?.videoDuration ?? '5'}`
    }
    return `${model}|${params?.resolution ?? '1k'}|${params?.quality ?? 'medium'}|${params?.aspectRatio ?? '1:1'}`
  }

  /**
   * 价格随参数联动(分辨率/时长)。价格完全取本地用户价表(与后端收费同源),
   * 保留函数与各处调用点以驱动 key 化缓存, 不再发起任何询价请求。
   */
  function refreshModelPrice(model: string, _imageUrls: string[], params?: GenNodeParams) {
    if (aiAppSlugOf(model)) return
    const key = priceKeyFor(model, params)
    const kind = modelKindOf(model)
    const video = kind === 't2v' || kind === 'i2v'
    if (video) {
      const local = videoBasePrice(model, params)
      if (local !== null) {
        setModelPrices(prev => ({ ...prev, [key]: local }))
        return
      }
      const flat = VIDEO_FLAT_USER_PRICE[model]
      if (typeof flat === 'number') setModelPrices(prev => ({ ...prev, [key]: flat }))
      return
    }
    const up = IMAGE_USER_PRICE[model]
    if (typeof up === 'number') setModelPrices(prev => ({ ...prev, [key]: up }))
  }

  /**
   * 底行/确认框价格文案: 统一显示「用户实付价」(与后端真实扣费逐分一致)。
   *  - AI 应用渠道(wan22 等): 站内固定单价 / 次;
   *  - 矩阵视频(Mini/2.0/全能/Grok/2.5): 每秒用户价 × 时长; 固定按次(H3): 一口价; 标「¥」;
   *  - 图片: 每张固定价 × 数量。
   */
  function priceTextForModel(model: string, count: number, params?: GenNodeParams, hasImg = false): string {
    const fam = channelFamilyOf(model)
    const isVideo = fam ? fam.media === 'video' : ALL_VIDEO_MODELS.includes(model)
    // 有无参考图决定真实提交 slug, 价格按真实 slug 取(文生/图生各档价)
    const runModel = resolveRunModel(model, hasImg)

    // AI 应用渠道: 站内钱包固定单价(提交冻结/失败退回)
    if (aiAppSlugOf(runModel)) {
      const ap = AI_APP_USER_PRICE[runModel]
      return typeof ap === 'number' ? `¥${(ap * (count > 0 ? count : 1)).toFixed(2)} / 次` : '按实际扣费'
    }

    if (isVideo) {
      const total = userRunPrice(runModel, count, params)
      if (total !== null) return `¥${total.toFixed(2)}`
      return '按实际扣费'
    }

    // 图片: GPT Image 2 官方走分档, 其余固定价; 统一由 userRunPrice 算
    const total = userRunPrice(runModel, count, params)
    if (total !== null) return count > 1 ? `¥${total.toFixed(2)} / ${count} 张` : `¥${total.toFixed(2)} / 张`
    return '按实际扣费'
  }

  /**
   * 标准模型任务完成后的「本次花费」文案: 优先用后端回传的站内真实扣费额(与预估价同源),
   * 老任务无该字段时回退上游 RH usage 成本价, 都没有则不展示(返回 undefined / 空串)。
   */
  function stdCostText(res: { chargeAmount?: number | null; usage?: { thirdPartyConsumeMoney?: string | null } | null } | undefined | null, empty = ''): string {
    const ca = Number(res?.chargeAmount)
    if (ca > 0) return `¥${ca.toFixed(2)}`
    const tp = res?.usage?.thirdPartyConsumeMoney
    return tp ? `¥${tp}` : empty
  }

  /**
   * AI 应用专用节点(语音克隆/动作迁移/视频修复, 以及视频渠道 wan22 系列)的花费:
   * 站内固定单价是权威实付价, 直接按已知价显示; 未知档位(如修复两档)可传显式单价。
   */
  function aiAppCostText(price: number | undefined | null): string | undefined {
    return typeof price === 'number' && price > 0 ? `¥${price.toFixed(2)}` : undefined
  }

  /** 图片批量二次确认阈值(元): 框选批量运行时图片任务总额超过它才强制确认, 视频不计入 */
  const BATCH_IMAGE_CONFIRM_LIMIT = 8

  /** 批量任务里图片部分的费用汇总(视频/AI 应用不计), 与真实扣费同源 */
  function summarizeImageJobs(jobs: Array<{ model: string; count: number; params?: GenNodeParams; hasImg?: boolean }>) {
    let imageTotal = 0
    let imageCount = 0
    let hasVideo = false
    jobs.forEach(j => {
      const runModel = resolveRunModel(j.model, !!j.hasImg)
      const fam = channelFamilyOf(runModel)
      const isVideo = fam ? fam.media === 'video' : ALL_VIDEO_MODELS.includes(runModel)
      if (isVideo) {
        hasVideo = true
        return
      }
      const p = userRunPrice(runModel, j.count, j.params)
      if (typeof p === 'number') {
        imageTotal += p
        imageCount += j.count
      }
    })
    return { imageTotal: Math.round(imageTotal * 100) / 100, imageCount, hasVideo }
  }

  // ---------- 双击功能菜单 ----------

  function openAddMenuAt(clientX: number, clientY: number) {
    setAddMenuPos(clientToCanvas(clientX, clientY))
  }

  function onStageDoubleClick(e: React.MouseEvent<HTMLDivElement>) {
    // 手动卡片双击(cardTapRef)已处理预览/展开时, 抑制随后落到舞台的原生 dblclick,
    // 避免预览弹窗背后又弹出节点菜单。
    if (suppressStageDblRef.current) {
      suppressStageDblRef.current = false
      return
    }
    if (e.target !== e.currentTarget) return
    openAddMenuAt(e.clientX, e.clientY)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 分层退出: 添加菜单优先; 输入框中不打断(交给控件自身处理 Esc/失焦)
        const elEsc = document.activeElement as HTMLElement | null
        const tagEsc = elEsc?.tagName
        const typingEsc = tagEsc === 'INPUT' || tagEsc === 'TEXTAREA' || tagEsc === 'SELECT' || elEsc?.isContentEditable
        if (addMenuPos) {
          setAddMenuPos(null)
          return
        }
        if (typingEsc) return
        // 其次收起展开的生成节点参数面板, 再次按 Esc 取消选中
        if (editNodeId) {
          setEditNodeId(null)
          return
        }
        if (selectedIdsRef.current.length) {
          setSelectedIds([])
        }
        return
      }
      // F 键: 一键回到内容中心。有选中节点就框住选中, 否则框住全部;
      // 防止无限平移后找不到内容。输入框打字 / 输入法组词 / 带修饰键时不触发。
      if (e.key === 'f' || e.key === 'F') {
        const elF = document.activeElement as HTMLElement | null
        const tagF = elF?.tagName
        const typingF = tagF === 'INPUT' || tagF === 'TEXTAREA' || tagF === 'SELECT' || elF?.isContentEditable
        if (!typingF && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing) {
          e.preventDefault()
          handleFrameContent()
        }
        return
      }
      // 按住空格 = 抓手工具, 左键拖拽即可平移无限画布(输入框打字时空格不触发)
      if (e.code === 'Space' || e.key === ' ') {
        const el = document.activeElement as HTMLElement | null
        const tag = el?.tagName
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable
        if (!typing) {
          e.preventDefault()
          if (!spaceRef.current) {
            spaceRef.current = true
            setSpacePanning(true)
          }
          return
        }
      }
      // 复制/粘贴: 输入框内打字时让浏览器原生行为接管(复制文字等)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        const el = document.activeElement as HTMLElement | null
        const tag = el?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
        if (selectedIds.length === 0) return
        e.preventDefault()
        handleCopySelection()
        // 系统剪贴板写入标记文本: 之后 ⌘/Ctrl+V 的 paste 事件不带图片, 走画布卡片粘贴而非旧的外部图片
        try { void navigator.clipboard?.writeText(CANVAS_CLIP_MARKER).catch(() => {}) } catch { /* 忽略 */ }
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 正在输入文字(提示词/折面内容/命名等)时不触发, 避免删掉正在编辑的内容
        const el = document.activeElement as HTMLElement | null
        const tag = el?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
        // 模态弹窗打开时(帧捕捉等)禁用画布级删除快捷键, 防止误删弹窗背后的源卡
        if (document.querySelector('[role="dialog"]')) return
        if (e.metaKey || e.ctrlKey || e.altKey) return
        if (selectedIds.length === 0) return
        e.preventDefault()
        handleDeleteCards(selectedIds)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') {
        if (spaceRef.current) {
          spaceRef.current = false
          setSpacePanning(false)
        }
      }
    }
    const onBlur = () => {
      if (spaceRef.current) {
        spaceRef.current = false
        setSpacePanning(false)
      }
      // 窗口失焦时中键抓手可能收不到 pointerup: 复位手势与抓手光标, 避免光标永久卡在 grabbing
      const g = gestureRef.current
      if (g?.type === 'pan' && g.viaMiddle) {
        gestureRef.current = null
        setSpacePanning(false)
        setViewport({ ...viewportRef.current })
      }
    }
    const onPaste = (e: ClipboardEvent) => {
      const el = (e.target as HTMLElement | null) || (document.activeElement as HTMLElement | null)
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      const items = e.clipboardData?.items
      let file: File | null = null
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith('image/')) {
            file = items[i].getAsFile()
            break
          }
        }
      }
      if (file) {
        e.preventDefault()
        void handlePasteImageFile(file)
        return
      }
      if (clipboardRef.current) {
        e.preventDefault()
        handlePasteClipboard()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('paste', onPaste)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds])

  // ---------- 节点创建(双击菜单入口) ----------

  /** 从加号拖拽创建的节点与源节点建立持久连接; 右侧加号=源→新, 左侧加号=新→源 */
  function linkNewCard(newId: string) {
    const link = addMenuPos?.connectFrom
    if (!link) return
    setConnections(prev => [
      ...prev,
      ...link.ids.map(from => ({
        id: uid(),
        fromId: link.side === 'right' ? from : newId,
        toId: link.side === 'right' ? newId : from,
      })),
    ])
  }

  function handleAddGenerateCardAt(pos?: { x: number; y: number }) {
    const at = pos ?? centerSpawnPos()
    const card: CanvasCardData = {
      id: uid(),
      kind: 'generate',
      x: at.x,
      y: at.y,
      w: 320,
      h: 180,
      prompt: '',
      refUrls: [],
      genParams: defaultGenParams(),
    }
    setCards(prev => [...prev, card])
    setSelectedIds([card.id])
    linkNewCard(card.id)
    setAddMenuPos(null)
  }

  function handleAddLayerNodeAt(pos?: { x: number; y: number }) {
    const at = pos ?? centerSpawnPos()
    const card: CanvasCardData = {
      id: uid(),
      kind: 'layer',
      x: at.x,
      y: at.y,
      w: 380,
      h: 540,
      layerState: defaultLayerState(),
    }
    setCards(prev => [...prev, card])
    setSelectedIds([card.id])
    linkNewCard(card.id)
    setAddMenuPos(null)
  }

  function handleAddReplicateNodeAt(pos?: { x: number; y: number }) {
    const at = pos ?? centerSpawnPos()
    const card: CanvasCardData = {
      id: uid(),
      kind: 'replicate',
      x: at.x,
      y: at.y,
      w: 460,
      h: 620,
      repState: defaultRepState(),
    }
    setCards(prev => [...prev, card])
    setSelectedIds([card.id])
    linkNewCard(card.id)
    setAddMenuPos(null)
  }

  function handleAddAgentCardAt(pos?: { x: number; y: number }) {
    const at = pos ?? centerSpawnPos()
    const card: CanvasCardData = {
      id: uid(),
      kind: 'agent',
      x: at.x,
      y: at.y,
      w: 500,
      h: 600,
      prompt: '',
      agentState: defaultAgentState(),
    }
    setCards(prev => [...prev, card])
    setSelectedIds([card.id])
    linkNewCard(card.id)
    setAddMenuPos(null)
  }

  function handleAddLoopCardAt(pos?: { x: number; y: number }) {
    const at = pos ?? centerSpawnPos()
    const card: CanvasCardData = {
      id: uid(),
      kind: 'loop',
      x: at.x,
      y: at.y,
      w: 420,
      h: 560,
      loopState: defaultLoopState(),
    }
    setCards(prev => [...prev, card])
    setSelectedIds([card.id])
    linkNewCard(card.id)
    setAddMenuPos(null)
  }

  /** 融合节点: 左端口接完整原图, 右端口可接多张提取的局部修改图, 融合结果出在右侧 */
  function handleAddMergeCardAt(pos?: { x: number; y: number }) {
    const at = pos ?? centerSpawnPos()
    const card: CanvasCardData = {
      id: uid(),
      kind: 'merge',
      x: at.x,
      y: at.y,
      w: 240,
      h: 300,
      mergeState: defaultMergeState(),
    }
    setCards(prev => [...prev, card])
    setSelectedIds([card.id])
    linkNewCard(card.id)
    setAddMenuPos(null)
  }

  // ---------- 摄影机节点(纯前端: 配置转中文摄影风格提示词, 不调任何接口) ----------

  /** 扫当前画布摄影机名, 取第一个未用的 A-Z 字母 */
  function nextUnusedCameraLetter(): string {
    return nextCameraLetter(cardsRef.current.filter(c => c.kind === 'camera').map(c => c.title ?? ''))
  }

  /** 双击菜单创建摄影机: 自动命名 摄影机A/B/C, 配置取本机默认, 不连线不可运行 */
  function handleAddCameraCardAt(pos?: { x: number; y: number }) {
    const at = pos ?? centerSpawnPos()
    const card: CanvasCardData = {
      id: uid(),
      kind: 'camera',
      x: at.x,
      y: at.y,
      w: 360,
      h: 200,
      title: cameraTitleFromLetter(nextUnusedCameraLetter()),
      cameraState: sanitizeCameraConfig(loadCameraDefault()),
    }
    setCards(prev => [...prev, card])
    setSelectedIds([card.id])
    // 摄影机不靠连线生效, 不调 linkNewCard
    setAddMenuPos(null)
  }

  /** 打开摄影机控制弹窗(双击菜单/卡面「配置」按钮入口) */
  function openCameraConfig(cardId: string) {
    setCameraConfigCardId(cardId)
  }

  /** 应用弹窗里的配置: 清洗落盘, 已绑定它的生成节点下次运行实时读到新提示词, 无需回写快照 */
  function applyCameraConfig(cardId: string, config: CameraConfig) {
    const clean = sanitizeCameraConfig(config)
    setCards(prev => prev.map(c => (c.id === cardId ? { ...c, cameraState: clean } : c)))
  }

  /**
   * 生成节点绑定 / 解绑摄影机:
   * 绑定时实时写入一份快照(节点名 + 当时提示词); 摄影机被删后用快照兜底; '' = 解绑。
   */
  function handleSetGenCamera(genCardId: string, cameraNodeId: string) {
    setCards(prev =>
      prev.map(c => {
        if (c.id !== genCardId || c.kind !== 'generate') return c
        if (!cameraNodeId) {
          return { ...c, cameraNodeId: undefined, cameraSnapshot: undefined }
        }
        const cam = prev.find(x => x.id === cameraNodeId && x.kind === 'camera')
        if (!cam) return c
        const promptText = buildCameraPromptFromConfig(cam.cameraState ?? DEFAULT_CAMERA_CONFIG)
        return { ...c, cameraNodeId, cameraSnapshot: { name: cam.title ?? '摄影机', prompt: promptText } }
      }),
    )
  }

  /**
   * 解析生成节点当前应追加的摄影提示词:
   * 绑定的摄影机还在 → 实时算最新配置(改配置下次运行即生效);
   * 摄影机已删 → 用绑定时快照; 都没有 → ''。
   */
  function resolveCameraPrompt(card: CanvasCardData): string {
    if (card.kind !== 'generate') return ''
    if (card.cameraNodeId) {
      const cam = cardsRef.current.find(c => c.id === card.cameraNodeId && c.kind === 'camera')
      if (cam) return buildCameraPromptFromConfig(cam.cameraState ?? DEFAULT_CAMERA_CONFIG)
    }
    return card.cameraSnapshot?.prompt ?? ''
  }

  /** 把摄影提示词追加到用户提示词末尾: 去掉末尾中英文逗号/句号/空白后用中文逗号拼接 */
  function appendCameraPrompt(userPrompt: string, cameraPrompt: string): string {
    const base = userPrompt.replace(/[，,。.\s]+$/u, '')
    const extra = cameraPrompt.trim()
    if (!extra) return userPrompt
    return base ? `${base}，${extra}` : extra
  }

  /**
   * 透明背景开关开启时, 把「生成透明背景图像」前置到用户提示词最前面(摄影机段仍在最后)。
   * 仅 GPT Image 2 官方/低价渠道的真实提交模型生效, 其余渠道与关闭态原样返回。
   */
  function applyTransparentBgPrompt(prompt: string, params: GenNodeParams): string {
    if (!params.transparentBg || !supportsTransparentBg(params.model)) return prompt
    const base = prompt.trim()
    if (!base) return TRANSPARENT_BG_PROMPT_PREFIX
    // 用户已手动写了同类诉求时不重复前缀
    if (base.includes(TRANSPARENT_BG_PROMPT_PREFIX)) return base
    return `${TRANSPARENT_BG_PROMPT_PREFIX}，${base}`
  }

  /** 摄影机绑定下拉选项: 无摄影机 + 画布全部摄影机; 绑定的摄影机被删则补快照占位项 */
  function cameraBindingOptions(card: CanvasCardData): Array<{ value: string; label: string }> {
    const options: Array<{ value: string; label: string }> = [{ value: '', label: '无摄影机' }]
    cards
      .filter(c => c.kind === 'camera')
      .forEach(c => options.push({ value: c.id, label: c.title ?? '摄影机' }))
    if (card.cameraNodeId && !cards.some(c => c.id === card.cameraNodeId && c.kind === 'camera')) {
      options.push({ value: '__snapshot__', label: `${card.cameraSnapshot?.name ?? '摄影机'}·已删除用快照` })
    }
    return options
  }

  /** 语音克隆节点(IndexTTS 2): 上传人声 + 文本, 输出克隆语音 */
  function updateTtsState(cardId: string, patch: Partial<TtsNodeState>) {
    setCards(prev =>
      prev.map(c => (c.id === cardId && c.ttsState ? { ...c, ttsState: { ...c.ttsState, ...patch } } : c)),
    )
  }

  /** 语音克隆节点音频上传: 本地即时预览 → 落永久链接(随画布/模板保存) */
  async function handleTtsUpload(cardId: string, slot: 'clone' | 'emotion', file: File | null) {
    if (!file) return
    const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(file.name)
    if (!isAudio) {
      toast.error('请选择音频文件（支持 MP3 / WAV / M4A 等）')
      return
    }
    const localUrl = URL.createObjectURL(file)
    const localName = file.name
    updateTtsState(cardId, slot === 'clone'
      ? { cloneAudioUrl: localUrl, cloneAudioName: localName }
      : { emotionRefAudioUrl: localUrl, emotionRefAudioName: localName })
    try {
      const url = await persistMedia(file, 'audio')
      const cur = cardsRef.current.find(c => c.id === cardId)
      if (!cur) return
      updateTtsState(cardId, slot === 'clone'
        ? { cloneAudioUrl: url, cloneAudioName: localName }
        : { emotionRefAudioUrl: url, emotionRefAudioName: localName })
      setTimeout(() => URL.revokeObjectURL(localUrl), 5000)
    } catch (upErr) {
      const status = (upErr as { status?: number })?.status
      if (status === 412 || status === 401) {
        setNeedsRhLogin(true)
        setAuthDialog('login')
      } else {
        toast.error('音频上传失败, 请重试')
      }
      updateTtsState(cardId, slot === 'clone'
        ? { cloneAudioUrl: undefined, cloneAudioName: undefined }
        : { emotionRefAudioUrl: undefined, emotionRefAudioName: undefined })
      setTimeout(() => URL.revokeObjectURL(localUrl), 5000)
    }
  }

  function handleRemoveTtsAudio(cardId: string, slot: 'clone' | 'emotion') {
    updateTtsState(cardId, slot === 'clone'
      ? { cloneAudioUrl: undefined, cloneAudioName: undefined }
      : { emotionRefAudioUrl: undefined, emotionRefAudioName: undefined })
  }

  /** 从语音克隆结果 outputs/results 取第一个音频条目链接 */
  function ttsAudioUrl(res: AiAppRunResponse): string {
    const all = [...(res.outputs ?? []), ...(res.results ?? [])]
    const audio = all.find(o => o?.type === 'audio' && o.url) ?? all.find(o => /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.test(o.url || '')) ?? all.find(o => o.url)
    return audio?.url ?? ''
  }

  /** 把永久音频链接拉成 File 并上传给 IndexTTS 2 应用, 换回提交用 fileName */
  async function uploadTtsAudio(slug: string, audioUrl: string): Promise<string> {
    const src = mediaSrc(audioUrl)
    if (!src) throw new Error('missing-audio')
    const resp = await fetch(src, { mode: 'cors' })
    if (!resp.ok) throw new Error('audio-fetch-failed')
    const blob = await resp.blob()
    const ext = blob.type.split('/')[1]?.replace('mpeg', 'mp3') || 'mp3'
    const file = new File([blob], `voice.${ext}`, { type: blob.type || 'audio/mpeg' })
    const up = await uploadAiAppMedia(slug, file, 'audio')
    if (!up?.ok || !up.fileName) throw new Error('audio-upload-failed')
    return up.fileName
  }

  /** 语音克隆提交 + 轮询(单任务), 成功写回结果音频并后台转存永久链接 */
  async function runTtsJob(cardId: string) {
    const token = sessionTokenRef.current
    const signal = beginJobSignal()
    const write = (patch: Partial<TtsNodeState>) => {
      if (aliveForSession(token)) updateTtsState(cardId, patch)
    }
    try {
      const startCard = cardsRef.current.find(c => c.id === cardId)
      const start = startCard?.ttsState
      if (!start) return
      // 克隆人声/情绪参考是音频, 日志不展示「参考图」行(请求参数详情里仍可查看文件名)
      beginSpecialLog(cardId, start.text, [], [])
      const cloneFileName = await uploadTtsAudio(TTS_APP_SLUG, start.cloneAudioUrl as string)
      let emotionFileName: string | undefined
      if (start.emotionMode === '8' && start.emotionRefAudioUrl) {
        emotionFileName = await uploadTtsAudio(TTS_APP_SLUG, start.emotionRefAudioUrl)
      }
      if (!aliveForSession(token)) return
      const body: Record<string, unknown> = {
        node174_select: start.emotionMode,
        node185_value: String(ttsIntensityOf(start.emotionIntensity)),
        node187_value: String(ttsRateOf(start.speechRate)),
        referenceAudio: cloneFileName,
        text: start.text,
      }
      // 仅自定义情绪模式提交情绪参考音频, 其他模式不传该字段
      if (emotionFileName) body.referenceAudio2 = emotionFileName
      const res = await runAiAppGuarded(TTS_APP_SLUG, body, {
        pollIntervalMs: POLL_INTERVAL_MS,
        deadlineMs: POLL_TIMEOUT_MS,
        signal,
        // 任务受理即进入生成中(否则按钮一直停在「排队中」, 只有刷新恢复路径才会置 running)
        onAccepted: remoteId => aliveForSession(token) && write({ remoteTaskId: remoteId, jobStatus: 'running' }),
      })
      if (!aliveForSession(token) || res.error?.code === 'ABORTED') return
      if (res.state === 'succeeded' || res.state === 'partial') {
        const url = ttsAudioUrl(res)
        write({
          jobStatus: 'success',
          resultUrl: url,
          resultName: url.split('/').pop()?.split('?')[0] || '克隆语音.mp3',
          errorMsg: null,
        })
        finishSpecialLog(cardId, TTS_APP_SLUG, '语音克隆', {
          success: true,
          output: url ? { url, kind: 'audio' } : undefined,
          taskId: res.job?.taskId || res.job?.jobId,
          costText: aiAppCostText(TTS_USER_PRICE),
          request: body,
        })
        if (url) {
          const resultUrl = url
          void persistRemoteImage(resultUrl, 'audio').then(permanent => {
            if (!permanent || permanent === resultUrl || !aliveForSession(token)) return
            const cur = cardsRef.current.find(c => c.id === cardId)
            if (cur?.ttsState?.resultUrl === resultUrl) {
              updateTtsState(cardId, { resultUrl: permanent })
            }
          })
        }
      } else {
        if (res.error?.code === 'RH_LOGIN_REQUIRED') setNeedsRhLogin(true)
        const ttsError = formatAiAppFailureMessage(res)
        write({ jobStatus: 'failed', errorMsg: ttsError })
        finishSpecialLog(cardId, TTS_APP_SLUG, '语音克隆', {
          success: false,
          taskId: res.job?.taskId || res.job?.jobId,
          errorMsg: ttsError,
          request: body,
        })
      }
    } catch (err) {
      if (!aliveForSession(token)) return
      const status = (err as { status?: number })?.status
      if (status === 412 || status === 401 || status === 403) {
        setNeedsRhLogin(true)
        setAuthDialog('login')
        write({ jobStatus: 'failed', errorMsg: '登录已过期, 请重新登录后重试' })
      } else {
        write({ jobStatus: 'failed', errorMsg: '音频上传或生成失败, 请重试' })
      }
      finishSpecialLog(cardId, TTS_APP_SLUG, '语音克隆', {
        success: false,
        errorMsg: status === 412 || status === 401 || status === 403 ? '登录已过期, 请重新登录后重试' : '音频上传或生成失败, 请重试',
      })
    } finally {
      endJobSignal(signal)
      // 兜底清理本次专用任务的日志元信息(finishSpecialLog 在终态已删, abort/超时/会话切换路径在此兜住)
      delete specialLogMetaRef.current[cardId]
      removePendingJob(cardId)
      setRunningCount(n => Math.max(0, n - 1))
    }
  }

  /** 运行语音克隆节点: 校验输入 → 计费确认 → 提交 */
  function handleRunTts(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const ts = card?.ttsState
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
    costConfirm.runWithCostConfirm(() => {
      updateTtsState(cardId, { jobStatus: 'queued', errorMsg: null, resultUrl: undefined })
      setPendingJobs(prev => [
        ...prev.filter(j => !(j.cardId === cardId && j.model === TTS_APP_SLUG)),
        { cardId, model: TTS_APP_SLUG, promptText: ts.text.slice(0, 80), submittedAt: Date.now() },
      ])
      setRunningCount(n => n + 1)
      void runTtsJob(cardId)
    }, `运行语音克隆 1 次 · ${TTS_PRICE_TEXT}`)
  }

  function handleDownloadTts(cardId: string) {
    const ts = cardsRef.current.find(c => c.id === cardId)?.ttsState
    if (ts?.resultUrl) void downloadAigcResult(ts.resultUrl, ts.resultName)
  }

  /** 刷新恢复: 语音克隆未完成任务续轮询(按受理任务 ID 精确认领) */
  async function restoreTtsJobs(jobs: PendingJobRecord[], docCards: CanvasCardData[], sessionToken: number) {
    if (!jobs.length) return
    let items: Array<{ jobId: string; taskId?: string; status: string; resultUrl?: string; errorMessage?: string; created?: string }>
    try {
      const r = await callAiApp<{ ok: boolean; items?: Array<{ jobId: string; taskId?: string; status: string; resultUrl?: string; errorMessage?: string; created?: string }> }>(
        `/api/aigc/ai-app/${TTS_APP_SLUG}/history`,
        { page: 1, perPage: 30 },
      )
      items = r.items ?? []
    } catch {
      items = []
    }
    for (const job of jobs) {
      if (!aliveForSession(sessionToken)) return
      const card = docCards.find(c => c.id === job.cardId)
      const ts = card?.ttsState
      if (!card || !ts) {
        removePendingJob(job.cardId)
        setRunningCount(n => Math.max(0, n - 1))
        continue
      }
      // 认领顺序: 卡片上已持久化的受理任务 ID (最可靠) → pending 记录里的 ID →
      // 仅当本页只有一个语音任务在跑时, 才用「最新 running」兜底, 避免多节点并发误认。
      const claimedId = ts.remoteTaskId || job.remoteTaskId
      const matched =
        items.find(it => claimedId && (it.jobId === claimedId || it.taskId === claimedId)) ||
        (jobs.length === 1
          ? [...items].filter(it => it.status === 'running').sort((a, b) => (b.created || '').localeCompare(a.created || ''))[0]
          : undefined)
      if (matched?.jobId && matched.status === 'running') {
        updateTtsState(job.cardId, { jobStatus: 'running', remoteTaskId: matched.jobId })
        try {
          const ttsSignal = beginJobSignal()
          const res = await resumeAiAppJob(TTS_APP_SLUG, { jobId: matched.jobId }, { pollIntervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_TIMEOUT_MS, signal: ttsSignal })
          endJobSignal(ttsSignal)
          if (!aliveForSession(sessionToken) || res.error?.code === 'ABORTED') return
          if (res.state === 'succeeded' || res.state === 'partial') {
            const url = ttsAudioUrl(res)
            updateTtsState(job.cardId, { jobStatus: 'success', resultUrl: url, resultName: url.split('/').pop()?.split('?')[0] || '克隆语音.mp3', errorMsg: null })
            appendRestoredLog({
              status: 'success',
              platform: logPlatformOf(TTS_APP_SLUG),
              nodeType: '语音克隆',
              model: logModelLabel(TTS_APP_SLUG),
              prompt: ts.text,
              refs: [],
              refsMedia: [],
              outputs: url ? [{ url, kind: 'audio' }] : [],
              taskId: res.job?.taskId || matched.jobId,
              costText: aiAppCostText(TTS_USER_PRICE),
            })
            if (url) {
              const resultUrl = url
              void persistRemoteImage(resultUrl, 'audio').then(permanent => {
                if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
                  const cur = cardsRef.current.find(c => c.id === job.cardId)
                  if (cur?.ttsState?.resultUrl === resultUrl) updateTtsState(job.cardId, { resultUrl: permanent })
                }
              })
            }
          } else {
            if (res.error?.code === 'RH_LOGIN_REQUIRED') setNeedsRhLogin(true)
            const resumeTtsError = formatAiAppFailureMessage(res)
            updateTtsState(job.cardId, { jobStatus: 'failed', errorMsg: resumeTtsError })
            appendRestoredLog({
              status: 'failed',
              platform: logPlatformOf(TTS_APP_SLUG),
              nodeType: '语音克隆',
              model: logModelLabel(TTS_APP_SLUG),
              prompt: ts.text,
              refs: [],
              refsMedia: [],
              errorMsg: resumeTtsError,
              taskId: matched.jobId,
            })
          }
        } catch {
          if (aliveForSession(sessionToken)) updateTtsState(job.cardId, { jobStatus: 'failed', errorMsg: '生成失败, 请重试' })
        }
      } else if (matched?.status === 'success' && matched.resultUrl) {
        const resultUrl = matched.resultUrl
        updateTtsState(job.cardId, {
          jobStatus: 'success',
          resultUrl,
          resultName: resultUrl.split('/').pop()?.split('?')[0] || '克隆语音.mp3',
          errorMsg: null,
        })
        appendRestoredLog({
          status: 'success',
          platform: logPlatformOf(TTS_APP_SLUG),
          nodeType: '语音克隆',
          model: logModelLabel(TTS_APP_SLUG),
          prompt: ts.text,
          refs: [ts.cloneAudioUrl, ts.emotionRefAudioUrl].filter((u): u is string => !!u),
          outputs: [{ url: resultUrl, kind: 'audio' }],
          taskId: matched.taskId || matched.jobId,
        })
        void persistRemoteImage(resultUrl, 'audio').then(permanent => {
          if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
            const cur = cardsRef.current.find(c => c.id === job.cardId)
            if (cur?.ttsState?.resultUrl === resultUrl) updateTtsState(job.cardId, { resultUrl: permanent })
          }
        })
      } else {
        updateTtsState(job.cardId, { jobStatus: 'failed', errorMsg: '任务在刷新时中断了, 请点击重试' })
      }
      removePendingJob(job.cardId)
      setRunningCount(n => Math.max(0, n - 1))
    }
  }

  /** 动作迁移节点(Animate V9): 人物图 + 动作视频, 输出跟随动作的新视频 */
  function updateMotionState(cardId: string, patch: Partial<MotionNodeState>) {
    setCards(prev =>
      prev.map(c => (c.id === cardId && c.motionState ? { ...c, motionState: { ...c.motionState, ...patch } } : c)),
    )
  }

  /** 读取本地视频时长(秒), 读不到返回 null */
  function readVideoDuration(file: File): Promise<number | null> {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file)
      const video = document.createElement('video')
      video.preload = 'metadata'
      const done = (val: number | null) => {
        URL.revokeObjectURL(url)
        resolve(val)
      }
      video.onloadedmetadata = () => {
        const d = video.duration
        done(Number.isFinite(d) && d > 0 ? d : null)
      }
      video.onerror = () => done(null)
      video.src = url
    })
  }

  /** 媒体上传接口单文件大小上限(与平台媒体接口一致) */
  const MOTION_MEDIA_MAX_BYTES = 100 * 1024 * 1024

  /** 动作迁移媒体上传: 本地即时预览 → 时长校验 → 落永久链接(随画布/模板保存) */
  async function handleMotionUpload(cardId: string, slot: 'image' | 'video', file: File | null) {
    if (!file) return
    if (slot === 'image') {
      const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(file.name)
      if (!isImage) {
        toast.error('请选择图片文件（支持 JPG / PNG / WEBP 等）')
        return
      }
      const localUrl = URL.createObjectURL(file)
      updateMotionState(cardId, { refImageUrl: localUrl, refImageName: file.name })
      try {
        const url = await persistMedia(file, 'image')
        if (!cardsRef.current.find(c => c.id === cardId)) return
        updateMotionState(cardId, { refImageUrl: url, refImageName: file.name })
        setTimeout(() => URL.revokeObjectURL(localUrl), 5000)
      } catch (upErr) {
        const status = (upErr as { status?: number })?.status
        if (status === 412 || status === 401) {
          setNeedsRhLogin(true)
          setAuthDialog('login')
        } else {
          toast.error('图片上传失败, 请重试')
        }
        updateMotionState(cardId, { refImageUrl: undefined, refImageName: undefined })
        setTimeout(() => URL.revokeObjectURL(localUrl), 5000)
      }
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
    updateMotionState(cardId, {
      refVideoUrl: localUrl,
      refVideoName: file.name,
      refVideoDuration: duration ?? undefined,
    })
    try {
      const url = await persistMedia(file, 'video')
      if (!cardsRef.current.find(c => c.id === cardId)) return
      updateMotionState(cardId, {
        refVideoUrl: url,
        refVideoName: file.name,
        refVideoDuration: duration ?? undefined,
      })
      setTimeout(() => URL.revokeObjectURL(localUrl), 5000)
    } catch (upErr) {
      const status = (upErr as { status?: number })?.status
      if (status === 412 || status === 401) {
        setNeedsRhLogin(true)
        setAuthDialog('login')
      } else if (file.size > 60 * 1024 * 1024) {
        toast.error('视频过大, 上传失败, 请换一段更小的视频')
      } else {
        toast.error('视频上传失败, 请重试')
      }
      updateMotionState(cardId, { refVideoUrl: undefined, refVideoName: undefined, refVideoDuration: undefined })
      setTimeout(() => URL.revokeObjectURL(localUrl), 5000)
    }
  }

  function handleRemoveMotionMedia(cardId: string, slot: 'image' | 'video') {
    updateMotionState(
      cardId,
      slot === 'image'
        ? { refImageUrl: undefined, refImageName: undefined }
        : { refVideoUrl: undefined, refVideoName: undefined, refVideoDuration: undefined },
    )
  }

  /** 从动作迁移结果 outputs/results 取第一个视频条目链接 */
  function motionVideoUrl(res: AiAppRunResponse): string {
    const all = [...(res.outputs ?? []), ...(res.results ?? [])]
    const video =
      all.find(o => o?.type === 'video' && o.url) ??
      all.find(o => /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(o.url || '')) ??
      all.find(o => o.url)
    return video?.url ?? ''
  }

  /** 把永久媒体链接拉成 File 并上传给 Animate V9 应用, 换回提交用 fileName */
  async function uploadMotionMedia(slug: string, mediaUrl: string, kind: 'image' | 'video'): Promise<string> {
    const src = mediaSrc(mediaUrl)
    if (!src) throw new Error('missing-media')
    const resp = await fetch(src, { mode: 'cors' })
    if (!resp.ok) throw new Error('media-fetch-failed')
    const blob = await resp.blob()
    if (kind === 'image') {
      const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
      const file = new File([blob], `ref.${ext}`, { type: blob.type || 'image/png' })
      const up = await uploadAiAppMedia(slug, file, 'image')
      if (!up?.ok || !up.fileName) throw new Error('image-upload-failed')
      return up.fileName
    }
    const ext = blob.type.split('/')[1] || 'mp4'
    const file = new File([blob], `motion.${ext}`, { type: blob.type || 'video/mp4' })
    const up = await uploadAiAppMedia(slug, file, 'video')
    if (!up?.ok || !up.fileName) throw new Error('video-upload-failed')
    return up.fileName
  }

  /** 动作迁移提交 + 轮询(单任务), 成功写回结果视频并后台转存永久链接 */
  async function runMotionJob(cardId: string) {
    const token = sessionTokenRef.current
    const signal = beginJobSignal()
    const write = (patch: Partial<MotionNodeState>) => {
      if (aliveForSession(token)) updateMotionState(cardId, patch)
    }
    try {
      const startCard = cardsRef.current.find(c => c.id === cardId)
      const start = startCard?.motionState
      if (!start) return
      // 动作迁移的引用素材是 1 图 + 1 视频, 日志按真实媒体类型渲染(视频不再被当破图)
      beginSpecialLog(
        cardId,
        DEFAULT_MOTION_PROMPT,
        [start.refImageUrl, start.refVideoUrl].filter((u): u is string => !!u),
        [
          ...(start.refImageUrl ? [{ url: start.refImageUrl, kind: 'image' as const }] : []),
          ...(start.refVideoUrl ? [{ url: start.refVideoUrl, kind: 'video' as const }] : []),
        ],
      )
      const imageFileName = await uploadMotionMedia(MOTION_APP_SLUG, start.refImageUrl as string, 'image')
      const videoFileName = await uploadMotionMedia(MOTION_APP_SLUG, start.refVideoUrl as string, 'video')
      if (!aliveForSession(token)) return
      const body: Record<string, unknown> = {
        // 固定参数: 正常模式 / 正常输出 / 自动尺寸
        trueFalse: 'true',
        node571_select: '1',
        node452_value: 'false',
        // 主界面参数
        node566_select: start.resolution,
        // 高级参数
        node563_select: start.poseMode,
        node497_value: start.poseMode === '3' && start.longNeck ? 'true' : 'false',
        node297_value: String(motionPoseIntensityOf(start.poseIntensity)),
        node370_value: start.cameraOn ? 'true' : 'false',
        node361_value: String(motionCameraIntensityOf(start.cameraIntensity)),
        node271_value: start.maskHelmet ? 'true' : 'false',
        node265_value: String(motionExpressionOf(start.expression)),
        node266_value: String(motionChestOf(start.chest)),
        node499_value: String(motionIntOf(start.skipFrames, 0, 500, 0)),
        node422_value: String(motionIntOf(start.frameLimit, 1, 2000, 840)),
        node264_value: String(motionIntOf(start.frameRate, 1, 60, 30)),
        referenceImage: imageFileName,
        referenceVideo: videoFileName,
      }
      const res = await runAiAppGuarded(MOTION_APP_SLUG, body, {
        pollIntervalMs: POLL_INTERVAL_MS,
        deadlineMs: POLL_TIMEOUT_MS,
        signal,
        onAccepted: remoteId => aliveForSession(token) && write({ remoteTaskId: remoteId, jobStatus: 'running' }),
      })
      if (!aliveForSession(token) || res.error?.code === 'ABORTED') return
      if (res.state === 'succeeded' || res.state === 'partial') {
        const url = motionVideoUrl(res)
        write({
          jobStatus: 'success',
          resultUrl: url,
          resultName: url.split('/').pop()?.split('?')[0] || '动作迁移视频.mp4',
          errorMsg: null,
        })
        finishSpecialLog(cardId, MOTION_APP_SLUG, '动作迁移', {
          success: true,
          output: url ? { url, kind: 'video' } : undefined,
          taskId: res.job?.taskId || res.job?.jobId,
          costText: aiAppCostText(TTS_USER_PRICE),
          request: body,
        })
        if (url) {
          const resultUrl = url
          // 结果视频 60MB 内静默转永久链接; 超限 persistRemoteImage 原样回平台链接
          void persistRemoteImage(resultUrl, 'video').then(permanent => {
            if (!permanent || permanent === resultUrl || !aliveForSession(token)) return
            const cur = cardsRef.current.find(c => c.id === cardId)
            if (cur?.motionState?.resultUrl === resultUrl) {
              updateMotionState(cardId, { resultUrl: permanent })
            }
          })
        }
      } else {
        if (res.error?.code === 'RH_LOGIN_REQUIRED') setNeedsRhLogin(true)
        const motionError = formatAiAppFailureMessage(res)
        write({ jobStatus: 'failed', errorMsg: motionError })
        finishSpecialLog(cardId, MOTION_APP_SLUG, '动作迁移', {
          success: false,
          taskId: res.job?.taskId || res.job?.jobId,
          errorMsg: motionError,
          request: body,
        })
      }
    } catch (err) {
      if (!aliveForSession(token)) return
      const status = (err as { status?: number })?.status
      if (status === 412 || status === 401 || status === 403) {
        setNeedsRhLogin(true)
        setAuthDialog('login')
        write({ jobStatus: 'failed', errorMsg: '登录已过期, 请重新登录后重试' })
      } else {
        write({ jobStatus: 'failed', errorMsg: '媒体上传或生成失败, 请重试' })
      }
      finishSpecialLog(cardId, MOTION_APP_SLUG, '动作迁移', {
        success: false,
        errorMsg: status === 412 || status === 401 || status === 403 ? '登录已过期, 请重新登录后重试' : '媒体上传或生成失败, 请重试',
      })
    } finally {
      endJobSignal(signal)
      // 兜底清理本次专用任务的日志元信息(finishSpecialLog 在终态已删, abort/超时/会话切换路径在此兜住)
      delete specialLogMetaRef.current[cardId]
      removePendingJob(cardId)
      setRunningCount(n => Math.max(0, n - 1))
    }
  }

  /** 运行动作迁移节点: 校验输入 → 计费确认 → 提交 */
  function handleRunMotion(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const ms = card?.motionState
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
    costConfirm.runWithCostConfirm(() => {
      updateMotionState(cardId, { jobStatus: 'queued', errorMsg: null, resultUrl: undefined })
      setPendingJobs(prev => [
        ...prev.filter(j => !(j.cardId === cardId && j.model === MOTION_APP_SLUG)),
        { cardId, model: MOTION_APP_SLUG, promptText: `动作迁移 · ${ms.refVideoName ?? ''}`.slice(0, 80), submittedAt: Date.now() },
      ])
      setRunningCount(n => n + 1)
      void runMotionJob(cardId)
    }, `运行动作迁移 1 次 · ${MOTION_PRICE_TEXT}`)
  }

  function handleDownloadMotion(cardId: string) {
    const ms = cardsRef.current.find(c => c.id === cardId)?.motionState
    if (ms?.resultUrl) void downloadAigcResult(ms.resultUrl, ms.resultName)
  }

  /** 刷新恢复: 动作迁移未完成任务续轮询(按受理任务 ID 精确认领) */
  async function restoreMotionJobs(jobs: PendingJobRecord[], docCards: CanvasCardData[], sessionToken: number) {
    if (!jobs.length) return
    let items: Array<{ jobId: string; taskId?: string; status: string; resultUrl?: string; errorMessage?: string; created?: string }>
    try {
      const r = await callAiApp<{ ok: boolean; items?: Array<{ jobId: string; taskId?: string; status: string; resultUrl?: string; errorMessage?: string; created?: string }> }>(
        `/api/aigc/ai-app/${MOTION_APP_SLUG}/history`,
        { page: 1, perPage: 30 },
      )
      items = r.items ?? []
    } catch {
      items = []
    }
    for (const job of jobs) {
      if (!aliveForSession(sessionToken)) return
      const card = docCards.find(c => c.id === job.cardId)
      const ms = card?.motionState
      if (!card || !ms) {
        removePendingJob(job.cardId)
        setRunningCount(n => Math.max(0, n - 1))
        continue
      }
      const claimedId = ms.remoteTaskId || job.remoteTaskId
      const matched =
        items.find(it => claimedId && (it.jobId === claimedId || it.taskId === claimedId)) ||
        (jobs.length === 1
          ? [...items].filter(it => it.status === 'running').sort((a, b) => (b.created || '').localeCompare(a.created || ''))[0]
          : undefined)
      if (matched?.jobId && matched.status === 'running') {
        updateMotionState(job.cardId, { jobStatus: 'running', remoteTaskId: matched.jobId })
        try {
          const motionSignal = beginJobSignal()
          const res = await resumeAiAppJob(MOTION_APP_SLUG, { jobId: matched.jobId }, { pollIntervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_TIMEOUT_MS, signal: motionSignal })
          endJobSignal(motionSignal)
          if (!aliveForSession(sessionToken) || res.error?.code === 'ABORTED') return
          if (res.state === 'succeeded' || res.state === 'partial') {
            const url = motionVideoUrl(res)
            updateMotionState(job.cardId, { jobStatus: 'success', resultUrl: url, resultName: url.split('/').pop()?.split('?')[0] || '动作迁移视频.mp4', errorMsg: null })
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
              taskId: res.job?.taskId || matched.jobId,
              costText: aiAppCostText(MOTION_USER_PRICE),
            })
            if (url) {
              const resultUrl = url
              void persistRemoteImage(resultUrl, 'video').then(permanent => {
                if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
                  const cur = cardsRef.current.find(c => c.id === job.cardId)
                  if (cur?.motionState?.resultUrl === resultUrl) updateMotionState(job.cardId, { resultUrl: permanent })
                }
              })
            }
          } else {
            if (res.error?.code === 'RH_LOGIN_REQUIRED') setNeedsRhLogin(true)
            const resumeMotionError = formatAiAppFailureMessage(res)
            updateMotionState(job.cardId, { jobStatus: 'failed', errorMsg: resumeMotionError })
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
              taskId: matched.jobId,
            })
          }
        } catch {
          if (aliveForSession(sessionToken)) updateMotionState(job.cardId, { jobStatus: 'failed', errorMsg: '生成失败, 请重试' })
        }
      } else if (matched?.status === 'success' && matched.resultUrl) {
        const resultUrl = matched.resultUrl
        updateMotionState(job.cardId, {
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
        void persistRemoteImage(resultUrl, 'video').then(permanent => {
          if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
            const cur = cardsRef.current.find(c => c.id === job.cardId)
            if (cur?.motionState?.resultUrl === resultUrl) updateMotionState(job.cardId, { resultUrl: permanent })
          }
        })
      } else {
        updateMotionState(job.cardId, { jobStatus: 'failed', errorMsg: '任务在刷新时中断了, 请点击重试' })
      }
      removePendingJob(job.cardId)
      setRunningCount(n => Math.max(0, n - 1))
    }
  }

  // ── 视频高清修复节点(SeedVR2 / FlashVSR) ─────────────────────────────────

  function updateVsrState(cardId: string, patch: Partial<VsrNodeState>) {
    setCards(prev =>
      prev.map(c => (c.id === cardId && c.vsrState ? { ...c, vsrState: { ...c.vsrState, ...patch } } : c)),
    )
  }

  /** 视频高清修复媒体上传接口单文件大小上限(与平台媒体接口一致) */
  const VSR_MEDIA_MAX_BYTES = 100 * 1024 * 1024

  /** 视频上传: 本地即时预览 → 读时长 → 落永久链接(随画布/模板保存) */
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
    updateVsrState(cardId, { videoUrl: localUrl, videoName: file.name, videoDuration: duration ?? undefined })
    try {
      const url = await persistMedia(file, 'video')
      if (!cardsRef.current.find(c => c.id === cardId)) return
      updateVsrState(cardId, { videoUrl: url, videoName: file.name, videoDuration: duration ?? undefined })
      setTimeout(() => URL.revokeObjectURL(localUrl), 5000)
    } catch (upErr) {
      const status = (upErr as { status?: number })?.status
      if (status === 412 || status === 401) {
        setNeedsRhLogin(true)
        setAuthDialog('login')
      } else if (file.size > 60 * 1024 * 1024) {
        toast.error('视频过大, 上传失败, 请换一段更小的视频')
      } else {
        toast.error('视频上传失败, 请重试')
      }
      updateVsrState(cardId, { videoUrl: undefined, videoName: undefined, videoDuration: undefined })
      setTimeout(() => URL.revokeObjectURL(localUrl), 5000)
    }
  }

  function handleRemoveVsrVideo(cardId: string) {
    updateVsrState(cardId, { videoUrl: undefined, videoName: undefined, videoDuration: undefined })
  }

  /** 从视频修复结果 outputs/results 取第一个视频条目链接 */
  function vsrVideoUrl(res: AiAppRunResponse): string {
    const all = [...(res.outputs ?? []), ...(res.results ?? [])]
    const video =
      all.find(o => o?.type === 'video' && o.url) ??
      all.find(o => /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(o.url || '')) ??
      all.find(o => o.url)
    return video?.url ?? ''
  }

  /** 把永久视频链接拉成 File 并上传给视频修复应用, 换回提交用 fileName */
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

  /** 视频高清修复提交 + 轮询(单任务), 成功写回结果视频并后台转存永久链接 */
  async function runVsrJob(cardId: string) {
    const token = sessionTokenRef.current
    const signal = beginJobSignal()
    const write = (patch: Partial<VsrNodeState>) => {
      if (aliveForSession(token)) updateVsrState(cardId, patch)
    }
    try {
      const start = cardsRef.current.find(c => c.id === cardId)?.vsrState
      if (!start) return
      // 待修复视频按视频缩略图渲染, 不再被当图片出现破图
      beginSpecialLog(
        cardId,
        `视频高清修复 · ${start.videoName ?? ''}`,
        start.videoUrl ? [start.videoUrl] : [],
        start.videoUrl ? [{ url: start.videoUrl, kind: 'video' }] : [],
      )
      const videoFileName = await uploadVsrVideo(start.videoUrl as string)
      if (!aliveForSession(token)) return
      const body: Record<string, unknown> = {
        referenceVideo: videoFileName,
        node108_select: start.model,
        node112_value: String(vsrResolutionOf(start.maxResolution)),
      }
      const res = await runAiAppGuarded(VSR_APP_SLUG, body, {
        pollIntervalMs: POLL_INTERVAL_MS,
        deadlineMs: POLL_TIMEOUT_MS,
        signal,
        onAccepted: remoteId => aliveForSession(token) && write({ remoteTaskId: remoteId, jobStatus: 'running' }),
      })
      if (!aliveForSession(token) || res.error?.code === 'ABORTED') return
      if (res.state === 'succeeded' || res.state === 'partial') {
        const url = vsrVideoUrl(res)
        write({
          jobStatus: 'success',
          resultUrl: url,
          resultName: url.split('/').pop()?.split('?')[0] || '高清修复视频.mp4',
          errorMsg: null,
        })
        finishSpecialLog(cardId, VSR_APP_SLUG, '视频修复', {
          success: true,
          output: url ? { url, kind: 'video' } : undefined,
          taskId: res.job?.taskId || res.job?.jobId,
          costText: aiAppCostText(TTS_USER_PRICE),
          request: body,
        })
        if (url) {
          const resultUrl = url
          // 结果视频 60MB 内静默转永久链接; 超限原样保留平台链接
          void persistRemoteImage(resultUrl, 'video').then(permanent => {
            if (!permanent || permanent === resultUrl || !aliveForSession(token)) return
            const cur = cardsRef.current.find(c => c.id === cardId)
            if (cur?.vsrState?.resultUrl === resultUrl) {
              updateVsrState(cardId, { resultUrl: permanent })
            }
          })
        }
      } else {
        if (res.error?.code === 'RH_LOGIN_REQUIRED') setNeedsRhLogin(true)
        const vsrError = formatAiAppFailureMessage(res)
        write({ jobStatus: 'failed', errorMsg: vsrError })
        finishSpecialLog(cardId, VSR_APP_SLUG, '视频修复', {
          success: false,
          taskId: res.job?.taskId || res.job?.jobId,
          errorMsg: vsrError,
          request: body,
        })
      }
    } catch (err) {
      if (!aliveForSession(token)) return
      const status = (err as { status?: number })?.status
      if (status === 412 || status === 401 || status === 403) {
        setNeedsRhLogin(true)
        setAuthDialog('login')
        write({ jobStatus: 'failed', errorMsg: '登录已过期, 请重新登录后重试' })
      } else {
        write({ jobStatus: 'failed', errorMsg: '媒体上传或修复失败, 请重试' })
      }
      finishSpecialLog(cardId, VSR_APP_SLUG, '视频修复', {
        success: false,
        errorMsg: status === 412 || status === 401 || status === 403 ? '登录已过期, 请重新登录后重试' : '媒体上传或修复失败, 请重试',
      })
    } finally {
      endJobSignal(signal)
      // 兜底清理本次专用任务的日志元信息(finishSpecialLog 在终态已删, abort/超时/会话切换路径在此兜住)
      delete specialLogMetaRef.current[cardId]
      removePendingJob(cardId)
      setRunningCount(n => Math.max(0, n - 1))
    }
  }

  /** 运行视频高清修复节点: 校验输入 → 计费确认 → 提交 */
  function handleRunVsr(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const vs = card?.vsrState
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
    costConfirm.runWithCostConfirm(() => {
      updateVsrState(cardId, { jobStatus: 'queued', errorMsg: null, resultUrl: undefined })
      setPendingJobs(prev => [
        ...prev.filter(j => !(j.cardId === cardId && j.model === VSR_APP_SLUG)),
        { cardId, model: VSR_APP_SLUG, promptText: `视频高清修复 · ${vs.videoName ?? ''}`.slice(0, 80), submittedAt: Date.now() },
      ])
      setRunningCount(n => n + 1)
      void runVsrJob(cardId)
    }, `运行视频高清修复 1 次 · ${priceText}`)
  }

  function handleDownloadVsr(cardId: string) {
    const vs = cardsRef.current.find(c => c.id === cardId)?.vsrState
    if (vs?.resultUrl) void downloadAigcResult(vs.resultUrl, vs.resultName)
  }

  /** 刷新恢复: 视频高清修复未完成任务续轮询(按受理任务 ID 精确认领) */
  async function restoreVsrJobs(jobs: PendingJobRecord[], docCards: CanvasCardData[], sessionToken: number) {
    if (!jobs.length) return
    let items: Array<{ jobId: string; taskId?: string; status: string; resultUrl?: string; created?: string }>
    try {
      const r = await callAiApp<{ ok: boolean; items?: Array<{ jobId: string; taskId?: string; status: string; resultUrl?: string; created?: string }> }>(
        `/api/aigc/ai-app/${VSR_APP_SLUG}/history`,
        { page: 1, perPage: 30 },
      )
      items = r.items ?? []
    } catch {
      items = []
    }
    for (const job of jobs) {
      if (!aliveForSession(sessionToken)) return
      const card = docCards.find(c => c.id === job.cardId)
      const vs = card?.vsrState
      if (!card || !vs) {
        removePendingJob(job.cardId)
        setRunningCount(n => Math.max(0, n - 1))
        continue
      }
      const claimedId = vs.remoteTaskId || job.remoteTaskId
      const matched =
        items.find(it => claimedId && (it.jobId === claimedId || it.taskId === claimedId)) ||
        (jobs.length === 1
          ? [...items].filter(it => it.status === 'running').sort((a, b) => (b.created || '').localeCompare(a.created || ''))[0]
          : undefined)
      if (matched?.jobId && matched.status === 'running') {
        updateVsrState(job.cardId, { jobStatus: 'running', remoteTaskId: matched.jobId })
        try {
          const vsrSignal = beginJobSignal()
          const res = await resumeAiAppJob(VSR_APP_SLUG, { jobId: matched.jobId }, { pollIntervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_TIMEOUT_MS, signal: vsrSignal })
          endJobSignal(vsrSignal)
          if (!aliveForSession(sessionToken) || res.error?.code === 'ABORTED') return
          if (res.state === 'succeeded' || res.state === 'partial') {
            const url = vsrVideoUrl(res)
            updateVsrState(job.cardId, { jobStatus: 'success', resultUrl: url, resultName: url.split('/').pop()?.split('?')[0] || '高清修复视频.mp4', errorMsg: null })
            appendRestoredLog({
              status: 'success',
              platform: logPlatformOf(VSR_APP_SLUG),
              nodeType: '视频修复',
              model: logModelLabel(VSR_APP_SLUG),
              prompt: `视频高清修复 · ${vs.videoName ?? ''}`,
              refs: [],
              refsMedia: vs.videoUrl ? [{ url: vs.videoUrl, kind: 'video' }] : [],
              outputs: url ? [{ url, kind: 'video' }] : [],
              taskId: res.job?.taskId || matched.jobId,
              costText: aiAppCostText(vsrPriceOf(vs.model)),
            })
            if (url) {
              const resultUrl = url
              void persistRemoteImage(resultUrl, 'video').then(permanent => {
                if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
                  const cur = cardsRef.current.find(c => c.id === job.cardId)
                  if (cur?.vsrState?.resultUrl === resultUrl) updateVsrState(job.cardId, { resultUrl: permanent })
                }
              })
            }
          } else {
            if (res.error?.code === 'RH_LOGIN_REQUIRED') setNeedsRhLogin(true)
            const resumeVsrError = formatAiAppFailureMessage(res)
            updateVsrState(job.cardId, { jobStatus: 'failed', errorMsg: resumeVsrError })
            appendRestoredLog({
              status: 'failed',
              platform: logPlatformOf(VSR_APP_SLUG),
              nodeType: '视频修复',
              model: logModelLabel(VSR_APP_SLUG),
              prompt: `视频高清修复 · ${vs.videoName ?? ''}`,
              refs: [],
              refsMedia: vs.videoUrl ? [{ url: vs.videoUrl, kind: 'video' }] : [],
              errorMsg: resumeVsrError,
              taskId: matched.jobId,
            })
          }
        } catch {
          if (aliveForSession(sessionToken)) updateVsrState(job.cardId, { jobStatus: 'failed', errorMsg: '修复失败, 请重试' })
        }
      } else if (matched?.status === 'success' && matched.resultUrl) {
        const resultUrl = matched.resultUrl
        updateVsrState(job.cardId, {
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
        void persistRemoteImage(resultUrl, 'video').then(permanent => {
          if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
            const cur = cardsRef.current.find(c => c.id === job.cardId)
            if (cur?.vsrState?.resultUrl === resultUrl) updateVsrState(job.cardId, { resultUrl: permanent })
          }
        })
      } else {
        updateVsrState(job.cardId, { jobStatus: 'failed', errorMsg: '任务在刷新时中断了, 请点击重试' })
      }
      removePendingJob(job.cardId)
      setRunningCount(n => Math.max(0, n - 1))
    }
  }

  function handleConvertToGenerate(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card) return
    updateCard(cardId, {
      kind: 'generate',
      genParams: card.genParams ?? defaultGenParams(),
      w: 320,
      h: 520,
    })
  }

  async function handleUploadImageFiles(files: File[], clientX?: number, clientY?: number) {
    const pos = clientX !== undefined && clientY !== undefined ? clientToCanvas(clientX, clientY) : centerSpawnPos()
    await handleUploadImageFilesPos(files, pos)
  }

  /** 拖拽/批量上传: 每张图生成一个带图片位的生成节点(默认图生图渠道), 不强制继续操作 */
  async function handleUploadImageFilesPos(files: File[], pos: { x: number; y: number }) {
    // 分成 可展示图片 / 不支持的图片(TIFF/HEIC 等浏览器画不出来) / 非图片,
    // 不支持的直接弹提示拦下, 绝不能静默落一张破图小卡。
    const { supported: imgs, unsupportedImages, other } = classifyIncomingFiles(files)
    if (unsupportedImages.length) toast.error(unsupportedImageToast(unsupportedImages))
    if (!imgs.length) {
      if (!unsupportedImages.length && other > 0) toast.error('请选择图片文件（支持 PNG / JPG / WEBP 等）')
      return
    }
    const tooMany = imgs.length > 30
    const picked = imgs.slice(0, 30)

    // 1) 立即用本地 blob 预览落卡，零网络延迟，拖入即时可见
    const created = picked.map((file, idx) => {
      const localUrl = URL.createObjectURL(file)
      const cardId = uid()
      const card: CanvasCardData = {
        id: cardId,
        kind: 'generate',
        x: pos.x + idx * 40,
        y: pos.y + idx * 40,
        w: 520,
        h: 560,
        url: localUrl,
        prompt: '',
        refUrls: [],
        genParams: defaultImageGenParams(),
        jobStatus: 'running',
        errorMsg: undefined,
      }
      return { cardId, card, file, localUrl }
    })
    setCards(prev => [...prev, ...created.map(c => c.card)])
    if (tooMany) toast.message(`一次最多上传 30 张, 已取前 ${picked.length} 张`)

    // 2) 受控并发上传（Safari 对同域并发连接有限制, 3 路兼顾速度与稳定），
    //    传完把本地 blob 链接换成永久链接；单张失败只标红该卡，不拖慢其它图。
    const CONCURRENCY = 3
    let cursor = 0
    let okCount = 0
    let loginBlocked = false
    async function worker() {
      while (cursor < created.length) {
        const item = created[cursor]
        cursor += 1
        try {
          const url = await persistMedia(item.file, 'image')
          URL.revokeObjectURL(item.localUrl)
          updateCard(item.cardId, { url, jobStatus: undefined, errorMsg: undefined })
          refreshModelPrice(I2I_MODELS[0], [url])
          okCount += 1
        } catch (upErr) {
          URL.revokeObjectURL(item.localUrl)
          const st = (upErr as { status?: number }).status
          if (st === 412 || st === 401) {
            loginBlocked = true
            updateCard(item.cardId, { url: '', jobStatus: 'failed', errorMsg: '请先登录' })
          } else {
            updateCard(item.cardId, { jobStatus: 'failed', errorMsg: '上传失败' })
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, created.length) }, () => worker()))
    if (loginBlocked) {
      setAuthDialog('login')
      toast.error('请先登录后再上传图片')
    } else if (okCount === picked.length && picked.length > 1) {
      toast.success(`已放入 ${picked.length} 张图片`)
    }
  }

  function handleDeleteCards(cardIds: string[]) {
    const idSet = new Set(cardIds)
    setCards(prev => prev.filter(c => !idSet.has(c.id)))
    setSelectedIds(prev => prev.filter(cid => !idSet.has(cid)))
    setConnections(prev => prev.filter(conn => !idSet.has(conn.fromId) && !idSet.has(conn.toId)))
    // 删掉的正是帧捕捉弹窗的源视频卡: 关掉弹窗, 避免弹窗状态/队列残留
    setFrameCaptureCardId(prev => (prev && idSet.has(prev) ? null : prev))
  }

  function handleDuplicateCard(cardId: string) {
    const src = cardsRef.current.find(c => c.id === cardId)
    if (!src) return
    const copy: CanvasCardData = {
      ...src,
      id: uid(),
      x: src.x + 32,
      y: src.y + 32,
      taskId: undefined,
      jobStatus: undefined,
      errorMsg: undefined,
      costText: undefined,
      // 语音克隆节点深拷贝: 副本不带运行结果/任务态, 音频与参数保留
      ...(src.ttsState
        ? {
            ttsState: {
              ...src.ttsState,
              jobStatus: 'idle' as const,
              resultUrl: undefined,
              resultName: undefined,
              errorMsg: null,
              remoteTaskId: undefined,
            },
          }
        : {}),
      // 动作迁移节点深拷贝: 副本不带运行结果/任务态, 媒体与参数保留
      ...(src.motionState
        ? {
            motionState: {
              ...src.motionState,
              jobStatus: 'idle' as const,
              resultUrl: undefined,
              resultName: undefined,
              errorMsg: null,
              remoteTaskId: undefined,
            },
          }
        : {}),
      // 视频高清修复节点深拷贝: 副本不带运行结果/任务态, 视频与参数保留
      ...(src.vsrState
        ? {
            vsrState: {
              ...src.vsrState,
              jobStatus: 'idle' as const,
              resultUrl: undefined,
              resultName: undefined,
              errorMsg: null,
              remoteTaskId: undefined,
            },
          }
        : {}),
    }
    // 摄影机副本重新分配字母名(同画布复制, 生成节点副本仍指向原摄影机, 绑定保留)
    if (copy.kind === 'camera') {
      copy.title = cameraTitleFromLetter(nextCameraLetter(cardsRef.current.filter(c => c.kind === 'camera').map(c => c.title ?? '')))
      if (copy.cameraState) copy.cameraState = sanitizeCameraConfig(copy.cameraState)
    }
    setCards(prev => [...prev, copy])
    setSelectedIds([copy.id])
  }

  /** 多选/整组复制: 连同组内连线与分组关系一起复制一份, 偏移摆放 */
  function handleDuplicateSelection() {
    const sel = cardsRef.current.filter(c => selectedIds.includes(c.id))
    if (sel.length < 2) return
    const idMap = new Map(sel.map(c => [c.id, uid()]))
    const gidMap = new Map<string, string>()
    // 摄影机副本本轮已分配的字母, 避免一次复制多台时重名
    const usedLetters = new Set<string>()
    const copies = sel.map(src => {
      const copy = JSON.parse(JSON.stringify(src)) as CanvasCardData
      copy.id = idMap.get(src.id) as string
      copy.x = src.x + 48
      copy.y = src.y + 48
      copy.taskId = undefined
      copy.jobStatus = undefined
      copy.errorMsg = undefined
      copy.costText = undefined
      if (src.ttsState) {
        copy.ttsState = {
          ...src.ttsState,
          jobStatus: 'idle',
          resultUrl: undefined,
          resultName: undefined,
          errorMsg: null,
          remoteTaskId: undefined,
        }
      }
      if (src.motionState) {
        copy.motionState = {
          ...src.motionState,
          jobStatus: 'idle',
          resultUrl: undefined,
          resultName: undefined,
          errorMsg: null,
          remoteTaskId: undefined,
        }
      }
      if (src.vsrState) {
        copy.vsrState = {
          ...src.vsrState,
          jobStatus: 'idle',
          resultUrl: undefined,
          resultName: undefined,
          errorMsg: null,
          remoteTaskId: undefined,
        }
      }
      if (src.groupId) {
        if (!gidMap.has(src.groupId)) gidMap.set(src.groupId, uid())
        copy.groupId = gidMap.get(src.groupId)
      }
      return copy
    })
    // 摄影机: 副本重新分配字母名; 生成节点: 源摄影机也在复制集合内时绑定映射到副本并同步快照,
    // 源摄影机不在集合内时绑定保留(同画布, 原摄影机仍有效)
    sel.forEach(src => {
      const copyId = idMap.get(src.id) as string
      const copy = copies.find(c => c.id === copyId)
      if (!copy) return
      if (src.kind === 'camera') {
        const letter = nextCameraLetter(cardsRef.current.filter(c => c.kind === 'camera').map(c => c.title ?? ''), usedLetters)
        usedLetters.add(letter)
        copy.title = cameraTitleFromLetter(letter)
        if (copy.cameraState) copy.cameraState = sanitizeCameraConfig(copy.cameraState)
      } else if (copy.kind === 'generate' && copy.cameraNodeId) {
        const mappedCamId = idMap.get(copy.cameraNodeId)
        if (mappedCamId) {
          copy.cameraNodeId = mappedCamId
          const camCopy = copies.find(c => c.id === mappedCamId)
          if (camCopy) {
            copy.cameraSnapshot = {
              name: camCopy.title ?? '摄影机',
              prompt: buildCameraPromptFromConfig(camCopy.cameraState ?? DEFAULT_CAMERA_CONFIG),
            }
          }
        }
      }
    })
    const selSet = idMap
    const innerConns = connectionsRef.current
      .filter(conn => selSet.has(conn.fromId) && selSet.has(conn.toId))
      .map(conn => ({ id: uid(), fromId: selSet.get(conn.fromId) as string, toId: selSet.get(conn.toId) as string }))
    setCards(prev => [...prev, ...copies])
    setConnections(prev => [...prev, ...innerConns])
    setSelectedIds(copies.map(c => c.id))
  }

  /** ⌘/Ctrl+V 的 paste 事件: 系统剪贴板带图片=替换选中图/空白处落新卡; 不带图片=画布卡片粘贴 */
  function handlePasteImageFile(file: File) {
    return persistMedia(file, 'image')
      .then(url => {
        const sel = cardsRef.current.filter(c => selectedIds.includes(c.id))
        const target = sel.length === 1 ? sel[0] : undefined
        if (target && target.url && !cardShowsVideo(target)) {
          if (target.kind === 'generate') {
            const idx = target.activeResultIndex ?? 0
            const oldUrl = target.results?.[idx]?.url
            if (oldUrl) {
              replaceNodeResultUrl(target.id, idx, oldUrl, url)
              toast.success('已替换选中图片')
              return
            }
          } else {
            updateCard(target.id, { url })
            toast.success('已替换选中图片')
            return
          }
        }
        // 未选中图片卡(空白处/多选/视频卡): 粘贴为一张新图片卡
        const pos = centerSpawnPos()
        const pasted: CanvasCardData = {
          id: uid(),
          kind: 'result',
          x: pos.x,
          y: pos.y,
          w: 300,
          h: 330,
          url,
          prompt: '粘贴的图片',
          jobStatus: 'success',
        }
        setCards(prev => [...prev, pasted])
        setSelectedIds([pasted.id])
        toast.success('已粘贴为新图片卡')
      })
      .catch(err => {
        if ((err as { status?: number }).status === 412) {
          setNeedsRhLogin(true)
          return
        }
        toast.error('粘贴图片失败, 请重试')
      })
  }

  /** ⌘/Ctrl+C: 选中卡片连同组内连线存入画布剪贴板 */
  function handleCopySelection() {
    const sel = cardsRef.current.filter(c => selectedIds.includes(c.id))
    if (sel.length === 0) return
    clipboardRef.current = {
      cards: sel.map(c => JSON.parse(JSON.stringify(c)) as CanvasCardData),
      // 连线「任意一端在选中集合内」就带走:
      //  - 两端都被复制 → 粘贴时映射到两个新节点(复制一条完整子链)
      //  - 只有一端被复制 → 新节点连回原来的外部节点(只复制一个下游节点时, 仍引用同一上游参考图)
      conns: connectionsRef.current
        .filter(conn => selectedIds.includes(conn.fromId) || selectedIds.includes(conn.toId))
        .map(conn => ({ fromId: conn.fromId, toId: conn.toId, toSlot: conn.toSlot })),
    }
    pasteSeqRef.current = 0
    toast.success(sel.length === 1 ? '已复制 1 张卡片' : `已复制 ${sel.length} 张卡片`)
  }

  /** ⌘/Ctrl+V: 粘贴剪贴板卡片(新 id/新分组, 组内连线一并重建, 逐次偏移摆放) */
  function handlePasteClipboard() {
    const clip = clipboardRef.current
    if (!clip || clip.cards.length === 0) return
    pasteSeqRef.current += 1
    const off = 48 * pasteSeqRef.current
    const idMap = new Map(clip.cards.map(c => [c.id, uid()]))
    const gidMap = new Map<string, string>()
    const copies = clip.cards.map(src => {
      const copy = JSON.parse(JSON.stringify(src)) as CanvasCardData
      copy.id = idMap.get(src.id) as string
      copy.x = src.x + off
      copy.y = src.y + off
      // —— 一律剥离「生成中」运行态: 复制出的是静态节点, 不继承原任务、不转圈、不会被刷新恢复误认领 ——
      copy.taskId = undefined
      copy.jobStatus = undefined
      copy.errorMsg = undefined
      copy.costText = undefined
      // 生成节点结果列表: 只带走已成功/已失败的成品项, 排队/运行中的在途项直接丢弃。
      // 成品保留(用户复制的是已有结果), 在途任务不可复制(没有结果、也不能让新节点去认领别人的任务)。
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
      // 分层节点: 分析中/生图中回落到空闲(已分析出的分层清单保留, 可直接重新生图)
      if (copy.layerState && (copy.layerState.stage === 'analyzing' || copy.layerState.stage === 'generating')) {
        copy.layerState = { ...copy.layerState, stage: 'idle' }
      }
      // 复刻节点: 分析/生成阶段回落, 正背面在途任务置空闲(已出的成品图保留)
      if (copy.repState) {
        const rs = copy.repState
        let stage = rs.stage
        if (stage === 'analyzing' || stage === 'generating') stage = rs.frontPrompt || rs.backPrompt ? 'ready' : 'idle'
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
      if (src.ttsState) {
        copy.ttsState = {
          ...src.ttsState,
          jobStatus: 'idle',
          resultUrl: undefined,
          resultName: undefined,
          errorMsg: null,
          remoteTaskId: undefined,
        }
      }
      if (src.motionState) {
        copy.motionState = {
          ...src.motionState,
          jobStatus: 'idle',
          resultUrl: undefined,
          resultName: undefined,
          errorMsg: null,
          remoteTaskId: undefined,
        }
      }
      if (src.vsrState) {
        copy.vsrState = {
          ...src.vsrState,
          jobStatus: 'idle',
          resultUrl: undefined,
          resultName: undefined,
          errorMsg: null,
          remoteTaskId: undefined,
        }
      }
      if (src.groupId) {
        if (!gidMap.has(src.groupId)) gidMap.set(src.groupId, uid())
        copy.groupId = gidMap.get(src.groupId)
      }
      return copy
    })
    // 连线重映射: 被复制的一端指向新节点, 未被复制的一端保留原外部节点 id(连回原上游/下游)
    const newConns = clip.conns
      .map(cn => ({
        fromId: idMap.get(cn.fromId) ?? cn.fromId,
        toId: idMap.get(cn.toId) ?? cn.toId,
        ...(cn.toSlot ? { toSlot: cn.toSlot } : {}),
      }))
      // 两端都没被复制不会发生(复制时已按任一端命中过滤); 排除自连与完全重复
      .filter(cn => cn.fromId !== cn.toId)
    // 与现有连线去重后再加入: 同一 (源→目标→槽) 已存在则不重复建(同一槽只允许一条线)
    setCards(prev => [...prev, ...copies])
    setConnections(prev => {
      const exist = new Set(
        prev.map(c => `${c.fromId}>${c.toId}>${c.toSlot ?? ''}`),
      )
      const add = newConns.filter(c => {
        const k = `${c.fromId}>${c.toId}>${c.toSlot ?? ''}`
        if (exist.has(k)) return false
        exist.add(k)
        return true
      })
      return [
        ...prev,
        ...add.map(c => ({ id: uid(), fromId: c.fromId, toId: c.toId, ...(c.toSlot ? { toSlot: c.toSlot } : {}) })),
      ]
    })
    setSelectedIds(copies.map(c => c.id))
    toast.success(copies.length === 1 ? '已粘贴 1 张卡片' : `已粘贴 ${copies.length} 张卡片`)
  }

  /** 多选节点对齐 / 等距分布 / 网格整理 */
  function alignSelection(mode: 'left' | 'top' | 'hdist' | 'vdist' | 'grid') {
    const sel = cardsRef.current.filter(c => selectedIds.includes(c.id))
    if (sel.length < 2) return
    const patch = new Map<string, { x?: number; y?: number }>()
    if (mode === 'left' || mode === 'top') {
      const v = mode === 'left' ? Math.min(...sel.map(c => c.x)) : Math.min(...sel.map(c => c.y))
      sel.forEach(c => patch.set(c.id, mode === 'left' ? { x: v } : { y: v }))
    } else if (mode === 'hdist' || mode === 'vdist') {
      const horiz = mode === 'hdist'
      const sorted = [...sel].sort((a, b) => (horiz ? a.x - b.x : a.y - b.y))
      const first = horiz ? sorted[0].x : sorted[0].y
      const last = horiz ? sorted[sorted.length - 1].x : sorted[sorted.length - 1].y
      // 首尾重合时退化为按最大尺寸+间隔依次排开
      const gap = Math.max(...sel.map(c => (horiz ? c.w : c.h))) + 60
      let step = last > first ? (last - first) / (sorted.length - 1) : gap
      // 纵向等距: 把卡片之间的「空白间隔」放宽为当前的 2 倍(等高卡片下精确翻倍)。
      // 当前原点步距 step 含一张卡高, 现有空白 = step - 最大卡高; 新步距 = step + 现有空白。
      // 首尾原本重合(无现存间隔)时仍用兜底 gap, 不额外放大。
      if (!horiz && last > first) {
        const maxCardH = Math.max(...sel.map(c => c.h))
        const curGap = Math.max(0, step - maxCardH)
        step = step + curGap
      }
      sorted.forEach((c, i) => {
        const v = Math.round(first + step * i)
        patch.set(c.id, horiz ? { x: v } : { y: v })
      })
    } else {
      const cols = Math.ceil(Math.sqrt(sel.length))
      const cw = Math.max(...sel.map(c => c.w)) + 60
      const ch = Math.max(...sel.map(c => c.h)) + 60
      const ox = Math.min(...sel.map(c => c.x))
      const oy = Math.min(...sel.map(c => c.y))
      ;[...sel]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .forEach((c, i) => patch.set(c.id, { x: ox + (i % cols) * cw, y: oy + Math.floor(i / cols) * ch }))
    }
    setCards(prev => prev.map(c => (patch.has(c.id) ? { ...c, ...patch.get(c.id) } : c)))
  }

  /**
   * 节点渲染出的真实尺寸回写数据, 组外框/选择框/连接点与视觉保持一致。
   * 由几何注册表在一帧内汇总所有变化后批量调用: 无任何变化时直接返回原数组,
   * 不再每张图解码都触发一次整树重渲染(旧实现 N 张图最多 N 次)。
   */
  function syncCardSizes(batch: Array<{ cardId: string; w: number; h: number }>) {
    if (resizingRef.current || !batch.length) return
    const byId = new Map(batch.map(b => [b.cardId, b]))
    setCards(prev => {
      let changed = false
      const next = prev.map(c => {
        const b = byId.get(c.id)
        // 图片尚未加载时容器可能短暂 0 宽, 绝不能回写——否则卡片 max-width 变 0, 图永远撑不开
        if (!b || b.w < 8 || b.h < 8) return c
        if (Math.abs(c.w - b.w) <= 1 && Math.abs(c.h - b.h) <= 1) return c
        changed = true
        return { ...c, w: b.w, h: b.h }
      })
      return changed ? next : prev
    })
  }

  /** 单卡尺寸回写: 几何注册表逐卡回调, 这里用 rAF 合批成一帧一次状态更新 */
  const sizeBatchRef = useRef<Map<string, { w: number; h: number }>>(new Map())
  const sizeFlushRafRef = useRef(0)
  function syncCardSize(cardId: string, w: number, h: number) {
    if (resizingRef.current || w < 8 || h < 8) return
    sizeBatchRef.current.set(cardId, { w, h })
    if (sizeFlushRafRef.current) return
    sizeFlushRafRef.current = requestAnimationFrame(() => {
      sizeFlushRafRef.current = 0
      const entries = [...sizeBatchRef.current.entries()].map(([id, r]) => ({ cardId: id, w: r.w, h: r.h }))
      sizeBatchRef.current.clear()
      syncCardSizes(entries)
    })
  }

  function handleRemoveRefFromCard(cardId: string, url: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card) return
    const next = (card.refUrls ?? []).filter(u => u !== url)
    updateCard(cardId, { refUrls: next })
    if (card.genParams?.model) refreshModelPrice(card.genParams.model, next, card.genParams)
  }

  function handlePreviewCard(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (card?.url) {
      setPreviewMediaType(cardShowsVideo(card) ? 'video' : 'image')
      setPreviewUrl(card.url)
    }
  }

  function handleDownloadCard(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (card?.url) void downloadAigcResult(card.url)
  }

  // ---------- 画布手势: 平移 / 缩放 / 框选 / 拖卡 ----------

  function startConnection(e: React.PointerEvent, cardId: string, side: ConnectionSide) {
    // 框选多张时从某张卡的右侧输出加号拖线: 把所有选中节点一起作为源拖向目标,
    // 实现一次性批量连接; 左侧输入端口只连当前卡。
    if (side === 'right' && selectedIds.includes(cardId) && selectedIds.length > 1) {
      // 不再在此按「是否有任意下游连线」过滤——一张图可能已连到别的节点, 这次仍应能再连到
      // 当前目标; 真正的去重放在松手落地时按 (源→该目标) 判定, 已连过的不重复建。
      const ids = selectedIds.filter(id => id === cardId || !!cardsRef.current.find(x => x.id === id))
      beginConnection(e, ids, side)
      return
    }
    beginConnection(e, [cardId], side)
  }

  /** 双击连接线: 断开这条上游引用(仅删该连线, 节点和结果都保留) */
  function handleDisconnect(connId: string) {
    setConnections(prev => prev.filter(c => c.id !== connId))
  }

  /** 整组拖线: 从组包围盒边缘发出, 选择新节点后组内每个成员都连过去 */
  function startGroupConnection(e: React.PointerEvent, ids: string[], side: ConnectionSide) {
    beginConnection(e, ids, side)
  }

  function beginConnection(e: React.PointerEvent, ids: string[], side: ConnectionSide) {
    e.preventDefault()
    e.stopPropagation()
    if (!ids.length) return
    // 锚定真实渲染边界: 单卡取加号中心, 多卡取组包围盒边缘中点
    let left = Infinity
    let right = -Infinity
    let top = Infinity
    let bottom = -Infinity
    let collapsedGroup = false
    ids.forEach(id => {
      const card = cardsRef.current.find(c => c.id === id)
      if (!card) return
      const chip = card.groupId && isGroupCollapsed(card.groupId) ? groupChipRect(card.groupId) : null
      if (chip) {
        collapsedGroup = true
        left = Math.min(left, chip.x)
        right = Math.max(right, chip.x + chip.w)
        top = Math.min(top, chip.y)
        bottom = Math.max(bottom, chip.y + chip.h)
        return
      }
      const el = stageRef.current?.querySelector<HTMLElement>(`[data-card-id="${id}"]`)
      const rx = el ? el.offsetLeft : card.x
      const ry = el ? el.offsetTop : card.y
      const rw = el ? el.offsetWidth : card.w
      const rh = el ? el.offsetHeight : card.h
      left = Math.min(left, rx)
      right = Math.max(right, rx + rw)
      top = Math.min(top, ry)
      bottom = Math.max(bottom, ry + rh)
    })
    if (left === Infinity) return
    // 多卡(整组)拖线: 起点在外侧加号处, 即组外框边界(内容包围盒外扩 36); 收纳态小卡无外框, 不外扩
    if (ids.length > 1 && !collapsedGroup) {
      left -= 36
      right += 36
    }
    const startX = side === 'right' ? right : left
    const startY = (top + bottom) / 2
    // 显示常驻草稿线并定位到起点; 之后跟鼠标只写 path 的 d 属性, 零 React 提交
    const paintDraft = (x: number, y: number) => {
      const pathEl = draftPathRef.current
      if (pathEl) pathEl.setAttribute('d', `M ${startX} ${startY} C ${startX + 80} ${startY}, ${x - 80} ${y}, ${x} ${y}`)
    }
    const draftSvg = draftPathRef.current?.parentElement
    paintDraft(startX, startY)
    // 必须显式给 block: svg 常驻 class 含 Tailwind hidden(display:none),
    // 只把内联值清空会被 hidden 重新压回不显示, 表现为拖线全程看不到线。
    if (draftSvg) draftSvg.style.display = 'block'
    setConnectionDraft({ sourceId: ids[0], startX, startY, hoverSlot: null })
    // 用 window 原生监听跟线, 不依赖指针捕获/事件冒泡, 跨元素拖动不丢事件; rAF 节流避免高刷鼠标每事件重渲染
    let raf = 0
    let last: { x: number; y: number } | null = null
    let lastHoverKey = ''
    let lastSnapKey = ''
    // 当前吸附目标(端口级): 只在变化时 setState 唤醒卡片高亮; 每帧命中计算纯内存扫描, 不提交
    let activeSnap: { cardId: string; side: ConnectionSide; x: number; y: number } | null = null
    // 吸附半径用画布单位的固定手感, 再按当前缩放补偿(缩放越小屏幕上越难点, 适当放大判定);
    // 屏幕半径控制在 30–52px: 太大会在节点密集区还没靠近就被远处端口「隔空吸住」, 线完全不跟鼠标
    const snapRadius = Math.min(52 / viewportRef.current.scale, 30 / Math.min(1, viewportRef.current.scale))
    const findSnap = (pt: { x: number; y: number }) => {
      // 右出优先吸附目标左端口, 左出优先右端口; 同张源卡不吸
      let best: { cardId: string; side: ConnectionSide; x: number; y: number; dist: number } | null = null
      const pad = snapRadius + 120
      // 拖动方向: 用来排除「拖向的反方向上」的端口, 避免起手附近的节点在身后抢吸附
      const dx = pt.x - startX
      const dy = pt.y - startY
      const dirLen = Math.hypot(dx, dy) || 1
      for (const other of cardsRef.current) {
        if (ids.includes(other.id)) continue
        // 收纳进折叠组的成员不单独作为吸附目标
        if (other.groupId && isGroupCollapsed(other.groupId)) continue
        // 包围盒粗筛(同样用真实渲染几何): 端口在卡左右边中点, 离鼠标一个吸附半径外的卡直接跳过
        const m = geometryRef.current.getRect(other.id)
        const bx = m?.x ?? other.x
        const by = m?.y ?? other.y
        const bw = m?.w ?? other.w
        const bh = m?.h ?? other.h
        if (bx > pt.x + pad || bx + bw < pt.x - pad || by > pt.y + pad || by + bh < pt.y - pad) continue
        // 只吸该卡真实存在的端口(与卡片视图 connInput/connOutput 保持一致):
        // 结果卡只有输出口; 润色/分层/复刻只有输入口; 无端口的普通素材卡直接跳过
        const hasLeft =
          other.kind === 'generate' ||
          other.kind === 'agent' ||
          other.kind === 'loop' ||
          other.kind === 'merge' ||
          other.kind === 'polish' ||
          other.kind === 'layer' ||
          other.kind === 'replicate'
        const hasRight =
          other.kind === 'generate' || other.kind === 'agent' || other.kind === 'loop' || other.kind === 'merge' || other.kind === 'result'
        const wanted: ConnectionSide = side === 'right' ? 'left' : 'right'
        const fallback: ConnectionSide = side === 'right' ? 'right' : 'left'
        const sides: ConnectionSide[] = [
          ...((wanted === 'left' ? hasLeft : hasRight) ? [wanted] : []),
          ...((fallback === 'left' ? hasLeft : hasRight) ? [fallback] : []),
        ]
        for (const s of sides) {
          // 端口坐标必须以真实渲染几何为准: 空生成节点高度是 auto(约 180), 而存量数据里
          // card.h 可能还是旧面板时代的 540/560/620, 用数据算中点会偏出卡片一大截,
          // 远处的鼠标被「看不见的端口」隔空吸住, 表现为起拖后线钉死不动。
          const px = s === 'left' ? bx : bx + bw
          const py = by + bh / 2
          const ddx = pt.x - px
          const ddy = pt.y - py
          const dist = Math.hypot(ddx, ddy)
          if (dist >= snapRadius || (best && dist >= best.dist)) continue
          // 方向门: 优先端口必须在拖动方向的半球内(点积>0), 防止身后的端口抢吸;
          // fallback 侧(输出口接输出口等反常规连法)只在非常近时才允许, 避免与正常目标竞争
          if (s === wanted) {
            if (dirLen > 24 && (ddx * dx + ddy * dy) / (dist * dirLen) < 0.15) continue
          } else if (dist > snapRadius * 0.55) {
            continue
          }
          // 纵向也要在端口附近: 给半个卡高 + 半径的余量, 防止从卡片上下方远处被中点隔空吸
          if (Math.abs(ddy) > bh / 2 + snapRadius) continue
          best = { cardId: other.id, side: s, x: px, y: py, dist }
        }
      }
      return best
    }
    const move = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY }
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (!last) return
        const pt = clientToCanvas(last.x, last.y)
        // 悬停在复刻卡的某个图片投放槽上时高亮该槽(只在单源向右拖出时);
        // 槽位切换是低频事件, 才值得一次 setState, 同一槽位上移动不重复提交
        let hoverSlot: ConnectionDraft['hoverSlot'] = null
        const slotEl = document
          .elementFromPoint(last.x, last.y)
          ?.closest<HTMLElement>('[data-rep-slot]')
        const slotCardId = slotEl?.closest<HTMLElement>('[data-card-id]')?.dataset.cardId
        const slotName = slotEl?.dataset.repSlot as RepSlot | undefined
        if (side === 'right' && ids.length === 1 && slotCardId && slotName && slotCardId !== ids[0]) {
          hoverSlot = { cardId: slotCardId, slot: slotName }
        }
        const hoverKey = hoverSlot ? `${hoverSlot.cardId}:${hoverSlot.slot}` : ''
        // 吸附扫描: 正悬停在投放槽上时不抢吸附(槽位投放更精确); 否则靠近端口就把线端钉过去
        const snap = hoverSlot ? null : findSnap(pt)
        activeSnap = snap
        const endX = snap ? snap.x : pt.x
        const endY = snap ? snap.y : pt.y
        // 坐标直写 DOM: 拉线期间舞台不重渲染, 近场集合/兄弟组件/几何扫描全部不被唤醒
        paintDraft(endX, endY)
        const snapKey = snap ? `${snap.cardId}:${snap.side}` : ''
        if (hoverKey !== lastHoverKey || snapKey !== lastSnapKey) {
          lastHoverKey = hoverKey
          lastSnapKey = snapKey
          setConnectionDraft(prev =>
            prev
              ? {
                  ...prev,
                  hoverSlot,
                  snapCardId: snap?.cardId ?? null,
                  snapSide: snap?.side ?? null,
                  snapX: snap?.x,
                  snapY: snap?.y,
                }
              : prev,
          )
        }
      })
    }
    const hideDraft = () => {
      if (draftSvg) draftSvg.style.display = 'none'
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', onCancel)
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      } catch {
        /* 忽略 */
      }
      if (raf) cancelAnimationFrame(raf)
      hideDraft()
      const pt = clientToCanvas(ev.clientX, ev.clientY)
      // 吸附目标优先: 即使松手瞬间鼠标已略微离开卡片(吸附半径把线钉在端口上), 也按吸附目标连
      const snapTarget = activeSnap && !ids.includes(activeSnap.cardId) ? activeSnap : null
      const movedEnough = Math.abs(pt.x - startX) + Math.abs(pt.y - startY) > 8
      if (snapTarget || movedEnough) {
        // 落到已有卡片上: 直接连到该卡(右侧拖出=源→目标, 左侧拖出=目标→源); 落到空白才弹新建菜单
        const overEl = document.elementFromPoint(ev.clientX, ev.clientY)
        const slotEl = overEl?.closest<HTMLElement>('[data-rep-slot]')
        const over = overEl?.closest<HTMLElement>('[data-card-id]')
        const targetId = snapTarget?.cardId ?? over?.dataset.cardId
        if (targetId && !ids.includes(targetId)) {
          // 吸附时按吸住的端口判方向(左端口=输入, 源→目标; 右端口=输出, 反向); 普通落卡沿用拖出侧
          const forward = snapTarget ? snapTarget.side === 'left' : side === 'right'
          // 单源投到复刻卡的具体图片槽: 带 toSlot; 一个槽只收一条线, 新线替换同槽旧线
          const dropSlot =
            forward && ids.length === 1
              ? (slotEl?.closest<HTMLElement>('[data-card-id]')?.dataset.cardId === targetId
                  ? (slotEl.dataset.repSlot as RepSlot | undefined)
                  : undefined)
              : undefined
          setConnections(prev => {
            let next = prev
            if (dropSlot) next = next.filter(c => !(c.toId === targetId && c.toSlot === dropSlot))
            next = [...next]
            ids.forEach(fromId => {
              const a = forward ? fromId : targetId
              const b = forward ? targetId : fromId
              if (!next.some(c => c.fromId === a && c.toId === b && c.toSlot === dropSlot)) {
                next.push({ id: uid(), fromId: a, toId: b, ...(dropSlot ? { toSlot: dropSlot } : {}) })
              }
            })
            return next
          })
          // 右侧拖出=源节点新增下游: 若其参数面板正展开则收起(有下游的节点默认不自动弹)
          if (forward) {
            setEditNodeId(prev => (prev && ids.includes(prev) ? null : prev))
          }
          setConnectionDraft(null)
          // 新连线与几何同步存在帧序竞争: 连线组件可能比目标卡几何注册更早挂载,
          // 首帧读到空端点矩形会直接不画线(表现为要再点一下卡片才出现)。下一帧强制对齐一次几何。
          requestAnimationFrame(() => geometryRef.current.syncFromDom())
          return
        }
        // 菜单弹出期间草稿线已隐藏; 选择节点后固化为持久连接, 菜单关闭时统一清理草稿
        setConnectionDraft(prev =>
          prev ? { ...prev, hoverSlot: null, snapCardId: null, snapSide: null, snapX: undefined, snapY: undefined } : prev,
        )
        setAddMenuPos({ x: pt.x, y: pt.y, connectFrom: { ids, side } })
      } else {
        setConnectionDraft(null)
      }
    }
    // 指针被浏览器/系统取消(触屏来电等)等价于松手: 隐藏草稿线并清状态
    const onCancel = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', onCancel)
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      } catch {
        /* 忽略 */
      }
      if (raf) cancelAnimationFrame(raf)
      hideDraft()
      setConnectionDraft(null)
    }
    // 在起拖元素(+按钮)上显式捕获指针: 配合按钮的 touch-none, 保证拖动全程
    // pointermove 稳定投递, 不被浏览器滚屏/缩放手势接管(表现为草稿线不跟手)。
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch {
      // 个别环境不支持时, 下面的 window 监听仍能兜底
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', onCancel)
  }

  function startResize(e: React.PointerEvent, cardId: string) {
    e.preventDefault()
    e.stopPropagation()
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card) return
    resizingRef.current = true
    // resize 快速路径(同拖卡): 移动期直接写卡片 DOM 宽高 + 几何注册表基准增量,
    // 零 React 提交(旧实现每帧 setCards 全量 map, 还会连锁触发 ResizeObserver 与同步布局扫描);
    // 松手时一次性把最终宽高提交进状态。
    const ids = [cardId]
    geometryRef.current.beginResizeFastPath(ids)
    const el = contentRef.current?.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`) ?? null
    const startW = el?.offsetWidth || card.w
    const startH = el?.offsetHeight || card.h
    const sx = e.clientX
    const sy = e.clientY
    const scale = viewportRef.current.scale
    let raf = 0
    let last: { x: number; y: number } | null = null
    let finalW = startW
    let finalH = startH
    const move = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY }
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (!last) return
        const dw = (last.x - sx) / scale
        const dh = (last.y - sy) / scale
        finalW = Math.max(240, Math.round(startW + dw))
        finalH = Math.max(140, Math.round(startH + dh))
        if (el) {
          el.style.width = `${finalW}px`
          el.style.height = `${finalH}px`
        }
        geometryRef.current.applyResizeDelta(cardId, finalW, finalH)
      })
    }
    const finishResize = () => {
      if (raf) cancelAnimationFrame(raf)
      geometryRef.current.endResizeFastPath()
      resizingRef.current = false
      if (finalW !== card.w || finalH !== card.h) {
        setCards(prev => prev.map(c => (c.id === cardId ? { ...c, w: finalW, h: finalH } : c)))
      } else if (el) {
        // 没变化: 清掉快速路径写下的内联宽高, 回到样式默认
        el.style.width = ''
        el.style.height = ''
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', onCancel)
      finishResize()
    }
    const onCancel = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', onCancel)
      finishResize()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', onCancel)
  }

  function onStagePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // 按住空格 = 抓手: 任意左键按下都平移画布(含落在卡片上的), 不触发框选/拖卡
    if (spaceRef.current && e.button === 0) {
      if (addMenuPos) setAddMenuPos(null)
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      gestureRef.current = {
        type: 'pan',
        startClientX: e.clientX,
        startClientY: e.clientY,
        originX: viewportRef.current.x,
        originY: viewportRef.current.y,
        moved: false,
      }
      return
    }
    if (e.button !== 0 && e.button !== 1) return
    // 鼠标中键(滚轮按下) = 抓手平移: 优先级最高, 落在卡片/控件上也不启动拖卡,
    // 直接由舞台接管(中键事件在卡片处不拦截会冒泡到这里)
    if (e.button === 1) {
      if (addMenuPos) setAddMenuPos(null)
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      gestureRef.current = {
        type: 'pan',
        startClientX: e.clientX,
        startClientY: e.clientY,
        originX: viewportRef.current.x,
        originY: viewportRef.current.y,
        moved: false,
        viaMiddle: true,
      }
      setSpacePanning(true)
      return
    }
    // 交互控件(按钮/输入等)上的按下不启动框选, 否则指针被画布捕获会吞掉按钮点击
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, button, select, a, video, [role="separator"], [contenteditable="true"]')) return
    if (addMenuPos) setAddMenuPos(null)
    // 画布为拖拽阻止了默认焦点转移, 这里手动让仍聚焦的输入框(如顶栏画布名)失焦结束编辑
    const active = document.activeElement as HTMLElement | null
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) active.blur()
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const pt = clientToCanvas(e.clientX, e.clientY)
    gestureRef.current = { type: 'marquee', startX: pt.x, startY: pt.y }
    const rect: MarqueeRect = { x: pt.x, y: pt.y, w: 0, h: 0 }
    marqueeRef.current = rect
    paintMarqueeLayer(rect)
  }

  function onStagePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current
    if (!g) return
    if (g.type === 'pan') {
      const dx = e.clientX - g.startClientX
      const dy = e.clientY - g.startClientY
      if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true
      // 平移快速路径: 只写变换层 DOM, 不触发 React 渲染; 松手时一次性提交 viewport
      const next = { ...viewportRef.current, x: g.originX + dx, y: g.originY + dy }
      viewportRef.current = next
      applyContentTransform(next)
      // 视口探测器静默同步最新视图(不通知)
      probeRef.current.hintViewport(next)
      // 网格背景直接跟随(它在外层舞台上, 不在变换层里)
      if (stageRef.current) stageRef.current.style.backgroundPosition = `${next.x}px ${next.y}px`
      // 移动超过 0.35 视口短边就提交一次状态, 让视口感知的卡片集合按最新目标位置重算。
      // 阈值与位移都是屏幕像素(clientX/clientY), 不除缩放比, 任何缩放下手感一致;
      // React 会合批中间的 pointermove, 近场集合只按提交时的最终视图计算, 不存在小步追赶。
      // 不会出现「甩画布时屏幕里只有空壳、松手后内容才出现」; 提交本身仍走轻量防抖保存
      const stageEl = stageRef.current
      const stepLimit = stageEl ? Math.min(stageEl.clientWidth, stageEl.clientHeight) * 0.35 : 240
      const last = panCommitRef.current
      if (Math.abs(next.x - last.x) > stepLimit || Math.abs(next.y - last.y) > stepLimit) {
        setViewport(next)
      }
      return
    }
    if (g.type === 'marquee') {
      const pt = clientToCanvas(e.clientX, e.clientY)
      const rect: MarqueeRect = {
        x: Math.min(g.startX, pt.x),
        y: Math.min(g.startY, pt.y),
        w: Math.abs(pt.x - g.startX),
        h: Math.abs(pt.y - g.startY),
      }
      marqueeRef.current = rect
      paintMarqueeLayer(rect)
      return
    }
    if (g.type === 'drag') {
      dragPosRef.current = { x: e.clientX, y: e.clientY }
      if (dragRafRef.current) return
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = 0
        const gg = gestureRef.current
        const pos = dragPosRef.current
        if (!gg || gg.type !== 'drag' || !pos) return
        const dx = (pos.x - gg.startClientX) / viewport.scale
        const dy = (pos.y - gg.startClientY) / viewport.scale
        // 拖动判定按屏幕像素恒定(约 3px), 任何缩放下手感一致; 快速路径首帧越过阈值即提交一次状态
        if (Math.abs(pos.x - gg.startClientX) + Math.abs(pos.y - gg.startClientY) > 3) gg.moved = true
        if (gg.fastPath) {
          // 快速路径: 直接写变换层里拖动卡 DOM 的 left/top, 不触发 React 提交(平移画布同款)。
          // 连线经几何注册表版本号跟随; 组外框见 Stage 的 dragRenderTick 订阅。
          const content = contentRef.current
          if (content) {
            gg.selectIds.forEach(id => {
              const o = gg.origins[id]
              if (!o) return
              const el = content.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`)
              if (el) {
                el.style.left = `${o.x + dx}px`
                el.style.top = `${o.y + dy}px`
              }
            })
          }
          geometryRef.current.applyDragDelta(dx, dy)
          return
        }
        setCards(prev =>
          prev.map(c => (gg.origins[c.id] ? { ...c, x: gg.origins[c.id].x + dx, y: gg.origins[c.id].y + dy } : c)),
        )
      })
    }
  }

  /**
   * 手势结束; canceled=true 为 pointercancel(系统手势打断等),
   * 此时框选不应选中、拖动不应触发面板抑制, 但要复位光标/清草稿, 避免状态永久残留。
   */
  function finishStageGesture(canceled: boolean) {
    const g = gestureRef.current
    gestureRef.current = null
    if (!g) return
    if (g.type === 'pan') {
      // 平移结束: 把纯 DOM 阶段的视图一次性提交为状态(触发一次视图轻量保存), 与屏幕所见一致
      setViewport({ ...viewportRef.current })
      // 中键抓手平移松手恢复光标; 空格仍按住(空格+中键组合)时保留抓手, 由 keyup 负责
      if (g.viaMiddle && !spaceRef.current) setSpacePanning(false)
      return
    }
    if (g.type === 'marquee') {
      const rect = canceled ? null : marqueeRef.current
      marqueeRef.current = null
      paintMarqueeLayer(null)
      if (!canceled && rect && rect.w > 4 && rect.h > 4) {
        // 收纳组成员按小卡边界命中, 不扫隐藏成员的旧包围盒
        const hit = cardsRef.current
          .filter(c => {
            const gg = c.groupId && isGroupCollapsed(c.groupId) ? groupChipRect(c.groupId) : null
            const rx = gg ? gg.x : c.x
            const ry = gg ? gg.y : c.y
            const rw = gg ? gg.w : c.w
            const rh = gg ? gg.h : c.h
            return rx < rect.x + rect.w && rx + rw > rect.x && ry < rect.y + rect.h && ry + rh > rect.y
          })
          .map(c => c.id)
        setSelectedIds(hit)
      } else if (!canceled) {
        // 空白处轻点(未形成有效框选): 取消所有卡片/节点选中, 与点别的节点互斥的直觉一致
        setSelectedIds([])
      }
      return
    }
    if (g.type === 'drag') {
      // 快速路径的 DOM 对齐辅助: 拖动期间只写了 DOM, 松手要对齐 React 状态
      const alignFastDom = (dx: number, dy: number, commit: boolean) => {
        if (!g.fastPath) return
        const content = contentRef.current
        if (content) {
          g.selectIds.forEach(id => {
            const o = g.origins[id]
            const el = content.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`)
            if (!el || !o) return
            // commit: 与即将提交的状态位置保持一致(无跳动); 否则回到拖动前(取消/轻点)
            el.style.left = `${commit ? o.x + dx : o.x}px`
            el.style.top = `${commit ? o.y + dy : o.y}px`
          })
        }
        geometryRef.current.endDragFastPath()
      }
      // pointercancel: 快速路径下 DOM 已被直接移动, 回滚到起点, 不改状态/选中
      if (canceled) {
        alignFastDom(0, 0, false)
        return
      }
      if (g.fastPath && g.moved) {
        // 一次性提交最终位置(dx/dy 取最后一帧指针位置)
        const pos = dragPosRef.current
        const dx = pos ? (pos.x - g.startClientX) / viewport.scale : 0
        const dy = pos ? (pos.y - g.startClientY) / viewport.scale : 0
        alignFastDom(dx, dy, true)
        setCards(prev =>
          prev.map(c => (g.origins[c.id] ? { ...c, x: g.origins[c.id].x + dx, y: g.origins[c.id].y + dy } : c)),
        )
      } else if (g.fastPath) {
        // 原地轻点: DOM 可能有阈值内微位移, 回位
        alignFastDom(0, 0, false)
      }
      if (g.moved && g.clearIfMoved) {
        setSelectedIds([])
        return
      }
      // 纯拖动(位置变化)且选中集真的发生变化时, 才抑制生成节点面板自动弹出;
      // 已选中的卡原地轻点(moved=false)或拖动后选中集未变, 不置标记——
      // 否则标记会残留到下一次点别的卡, 错误地阻止面板展开
      const selectedChanged =
        g.selectIds.length !== selectedIdsRef.current.length ||
        g.selectIds.some(id => !selectedIdsRef.current.includes(id))
      if (g.moved && selectedChanged) suppressAutoPanelRef.current = true
      setSelectedIds(g.selectIds)
      return
    }
  }

  function onStagePointerUp() {
    finishStageGesture(false)
  }

  /** pointercancel(系统手势打断/指针异常丢失): 复位手势与抓手光标, 避免状态永久残留 */
  function onStagePointerCancel() {
    finishStageGesture(true)
    setSpacePanning(false)
  }

  // ---------- 打组 ----------

  /** 同组成员 id 列表; 未分组返回自身 */
  function groupMemberIds(cardId: string): string[] {
    const gid = cardsRef.current.find(c => c.id === cardId)?.groupId
    if (!gid) return [cardId]
    return cardsRef.current.filter(c => c.groupId === gid).map(c => c.id)
  }

  function handleGroupSelection() {
    if (selectedIds.length < 2) return
    const gid = uid()
    setCards(prev =>
      prev.map(c => (selectedIds.includes(c.id) ? { ...c, groupId: gid, groupName: c.groupName ?? '新建组' } : c)),
    )
  }

  function handleRenameGroup(groupId: string, name: string) {
    setCards(prev => prev.map(c => (c.groupId === groupId ? { ...c, groupName: name } : c)))
  }

  function handleUngroupSelection() {
    const gids = new Set(
      cardsRef.current.filter(c => selectedIds.includes(c.id)).map(c => c.groupId).filter((g): g is string => !!g),
    )
    if (!gids.size) return
    setCards(prev => prev.map(c => (c.groupId && gids.has(c.groupId) ? { ...c, groupId: undefined, groupName: undefined, groupCollapsed: undefined } : c)))
  }

  // ---------- 组收纳: 成员隐藏, 画布只留一枚轻量小卡 ----------

  const COLLAPSED_CHIP_W = 176
  const COLLAPSED_CHIP_H = 52

  function isGroupCollapsed(gid?: string): boolean {
    if (!gid) return false
    return cardsRef.current.some(c => c.groupId === gid && c.groupCollapsed)
  }

  /** 收纳小卡位置: 取组成员包围盒中心, 固定尺寸 */
  function groupChipRect(gid: string): { x: number; y: number; w: number; h: number } | null {
    const arr = cardsRef.current.filter(c => c.groupId === gid)
    if (!arr.length) return null
    const left = Math.min(...arr.map(c => c.x))
    const right = Math.max(...arr.map(c => c.x + c.w))
    const top = Math.min(...arr.map(c => c.y))
    const bottom = Math.max(...arr.map(c => c.y + c.h))
    return {
      x: (left + right) / 2 - COLLAPSED_CHIP_W / 2,
      y: (top + bottom) / 2 - COLLAPSED_CHIP_H / 2,
      w: COLLAPSED_CHIP_W,
      h: COLLAPSED_CHIP_H,
    }
  }

  function setGroupCollapsed(groupId: string, collapsed: boolean) {
    setCards(prev =>
      prev.map(c => (c.groupId === groupId ? { ...c, groupCollapsed: collapsed || undefined } : c)),
    )
  }

  /** 工具条入口: 对选中的组整体收纳 / 恢复 */
  function handleCollapseSelection(collapsed: boolean) {
    const gids = new Set(
      cardsRef.current.filter(c => selectedIds.includes(c.id)).map(c => c.groupId).filter((g): g is string => !!g),
    )
    gids.forEach(gid => setGroupCollapsed(gid, collapsed))
  }

  /** 按住组外框空白处 / 收纳小卡: 整组一起拖动 */
  function onGroupPointerDown(e: React.PointerEvent, ids: string[]) {
    if (e.button !== 0) return
    // 空格抓手优先: 不拖组, 交给舞台平移
    if (spaceRef.current) return
    e.stopPropagation()
    // 阻止浏览器发起原生文本选择(拖动组/小卡时不再出现蓝字全选画面)
    e.preventDefault()
    if (addMenuPos) setAddMenuPos(null)
    const origins: Record<string, { x: number; y: number }> = {}
    cardsRef.current.forEach(c => {
      if (ids.includes(c.id)) origins[c.id] = { x: c.x, y: c.y }
    })
    const first = cardsRef.current.find(c => c.id === ids[0])
    const collapsed = !!first?.groupId && isGroupCollapsed(first.groupId)
    gestureRef.current = {
      type: 'drag',
      startClientX: e.clientX,
      startClientY: e.clientY,
      origins,
      selectIds: ids,
      moved: false,
      clearIfMoved: collapsed,
      fastPath: true,
    }
    geometryRef.current.beginDragFastPath(ids)
    stageRef.current?.setPointerCapture(e.pointerId)
  }

  function onCardPointerDown(e: React.PointerEvent, cardId: string) {
    if (e.button !== 0) return
    // 空格抓手优先: 不拖卡片, 不阻止冒泡, 让舞台接管平移
    if (spaceRef.current) return
    // 交互控件(输入/按钮/下拉/视频等)上按下去不启动拖拽, 其余空白区域都可拖节点
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, button, select, a, video, [role="separator"], [contenteditable="true"]')) return
    e.stopPropagation()
    if (addMenuPos) setAddMenuPos(null)
    // 手动双击检测: 卡片按下会 setPointerCapture 到舞台, 浏览器原生 dblclick 的第二击
    // 常落到舞台而不是图片, 纯结果卡因此双击预览失效。这里在「未移动的快速第二次按下」时
    // 直接触发与卡片双击相同的行为(纯图预览 / 生成节点展开), 不依赖 dblclick 事件合成。
    const now = performance.now()
    const lastTap = cardTapRef.current
    const isDouble = lastTap.id === cardId && now - lastTap.t < 320
    if (isDouble) {
      lastTap.id = ''
      lastTap.t = 0
      suppressStageDblRef.current = true
      setTimeout(() => { suppressStageDblRef.current = false }, 350)
      const dblCard = cardsRef.current.find(c => c.id === cardId)
      if (dblCard) {
        if (dblCard.kind === 'generate') handleToggleNodePanel(cardId)
        else if (dblCard.url) handlePreviewCard(cardId)
      }
      // 双击仍允许其按下逻辑执行(选中), 但由 pointerup 的未移动判定保证不拖卡
    } else {
      lastTap.id = cardId
      lastTap.t = now
    }
    // 组成员联动: 选中/拖动任一成员时整组一起
    const members = groupMemberIds(cardId)
    if (e.shiftKey) {
      setSelectedIds(prev =>
        prev.includes(cardId)
          ? prev.filter(cid => !members.includes(cid))
          : [...prev, ...members.filter(m => !prev.includes(m))],
      )
      return
    }
    const base = selectedIds.includes(cardId) ? selectedIds : [cardId]
    const nextSel = Array.from(new Set([...base, ...members]))
    // 拖动范围: 多选时整批一起拖; 单选按下一张卡时, 若它在组里则整组一起拖——
    // 否则拖动期间只有被按的那张 DOM 移动, 其余成员和组外框都留在原地, 卡片跑出框外。
    // 轻点(未移动)抬起后选中态照旧是整组。
    const dragIds = base.length > 1 ? nextSel : members
    const origins: Record<string, { x: number; y: number }> = {}
    dragIds.forEach(id => {
      const c = cardsRef.current.find(cc => cc.id === id)
      if (c) origins[id] = { x: c.x, y: c.y }
    })
    // 先不提交选中状态，避免按住节点拖动时立即弹出设置面板；抬起鼠标后再确认选中。
    // 单卡/已选多卡拖动走快速路径(move 只写 DOM, 不提交 React); 组联动拖动成员较多时也适用,
    // 只要按下的卡不是未选中状态下的组内联动(那种抬起才选中, 拖动目标明确)。
    const useFast = nextSel.length > 0
    gestureRef.current = {
      type: 'drag',
      startClientX: e.clientX,
      startClientY: e.clientY,
      origins,
      selectIds: nextSel,
      moved: false,
      fastPath: useFast,
    }
    if (useFast) geometryRef.current.beginDragFastPath(nextSel)
    stageRef.current?.setPointerCapture(e.pointerId)
  }

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    // 滚轮直接缩放(无需按住 Ctrl/Cmd), 以光标位置为缩放中心; 平移走空格/中键抓手。
    // 高频 wheel 走 rAF 合流的 DOM 快速路径(只写变换层 + viewportRef), 停顿 180ms 才提交一次
    // React 状态触发持久化, 大画布下连续滚轮不会逐事件整树重渲染。
    let wheelRaf = 0
    let commitTimer: ReturnType<typeof setTimeout> | null = null
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setAddMenuPos(null)
      // deltaMode=1(行)时滚轮增量放大, 与像素模式手感一致
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1)
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const v = viewportRef.current
      const factor = Math.exp(-dy * 0.0012)
      const scale = Math.min(2.5, Math.max(0.1, v.scale * factor))
      const k = scale / v.scale
      const next = { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
      viewportRef.current = next
      if (wheelRaf) return
      wheelRaf = requestAnimationFrame(() => {
        wheelRaf = 0
        const cur = viewportRef.current
        applyContentTransform(cur)
        probeRef.current.hintViewport(cur)
        if (stageRef.current) stageRef.current.style.backgroundPosition = `${cur.x}px ${cur.y}px`
        // 同步平移阈值基线, 避免滚轮后立刻中键/空格平移时第一段位移多触发一次状态提交
        panCommitRef.current = { x: cur.x, y: cur.y }
      })
      if (commitTimer) clearTimeout(commitTimer)
      commitTimer = setTimeout(() => {
        setViewport({ ...viewportRef.current })
      }, 180)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (wheelRaf) cancelAnimationFrame(wheelRaf)
      if (commitTimer) clearTimeout(commitTimer)
    }
  }, [docLoaded, setViewport, applyContentTransform])

  function zoomBy(factor: number) {
    const el = stageRef.current
    const cx = el ? el.clientWidth / 2 : 450
    const cy = el ? el.clientHeight / 2 : 300
    setViewport(v => {
      const scale = Math.min(2.5, Math.max(0.1, v.scale * factor))
      const k = scale / v.scale
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
    })
  }

  function handleZoomReset() {
    setViewport({ x: 80, y: 80, scale: 1 })
  }

  /** 框住全部内容: 自动缩放/平移让所有节点都在视野内; 空画布回到默认视图 */
  /** F 键: 有选中节点就框住选中, 否则框住全部内容; 空画布回默认视图 */
  function handleFrameContent() {
    const sel = cardsRef.current.filter(c => selectedIdsRef.current.includes(c.id))
    frameCards(sel.length ? sel : cardsRef.current)
  }

  /** 把给定一组节点居中并缩放到视野内 */
  function frameCards(items: CanvasCardData[]) {
    const el = stageRef.current
    if (!el || !items.length) {
      setViewport({ x: 80, y: 80, scale: 1 })
      return
    }
    const pad = 80
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    items.forEach(c => {
      minX = Math.min(minX, c.x)
      minY = Math.min(minY, c.y)
      maxX = Math.max(maxX, c.x + c.w)
      maxY = Math.max(maxY, c.y + c.h)
    })
    const vw = el.clientWidth
    const vh = el.clientHeight
    const w = Math.max(1, maxX - minX)
    const h = Math.max(1, maxY - minY)
    const scale = Math.min(2.5, Math.max(0.1, Math.min((vw - pad * 2) / w, (vh - pad * 2) / h)))
    const x = (vw - w * scale) / 2 - minX * scale
    const y = (vh - h * scale) / 2 - minY * scale
    setViewport({ x, y, scale })
  }

  // ---------- 生成节点运行 / 批量(不限并发全量同时跑, 逐项状态, 部分失败单独重试) ----------

  function priceNoteForJobs(jobs: Array<{ model: string; count: number; params?: GenNodeParams; hasImg?: boolean }>): string {
    let total = 0
    let sum = 0
    let exact = true
    jobs.forEach(j => {
      total += j.count
      // 计价用解析后的真实模型(家族 key 在有图时对应图生 slug)
      const runModel = resolveRunModel(j.model, !!j.hasImg)
      // AI 应用渠道按站内固定单价; 其余标准渠道统一走用户价表(图片按张 / 矩阵视频按秒 / H3 按次)
      const ai = aiAppSlugOf(runModel)
      const p = ai ? (AI_APP_USER_PRICE[runModel] ?? null) : userRunPrice(runModel, 1, j.params)
      if (typeof p === 'number' && p > 0) {
        sum += p * j.count
      }
      else exact = false
      j.model = runModel
    })
    const video = jobs.some(j => ALL_VIDEO_MODELS.includes(j.model) || channelFamilyOf(j.model)?.media === 'video')
    const unit = video ? '个' : '张'
    if (exact && sum > 0) return `共 ${total} ${unit} · ¥${sum.toFixed(2)}`
    return `共 ${total} ${unit} · 按实际扣费`
  }

  /** AI 应用渠道提交体: 按 slug 分支把业务字段平铺在请求体顶层 */
  function buildAiAppRunBody(
    runModel: string,
    promptText: string,
    genParams: GenNodeParams | undefined,
    firstFrame: string,
  ): Record<string, unknown> {
    if (aiAppSlugOf(runModel) === 'wan22hq') {
      return {
        text: promptText,
        node438_value: String(aiAppLongEdgeOf(genParams?.aiAppLongEdge)),
        node446_value: String(aiAppFramesOf(genParams?.aiAppFrames)),
        [AI_APP_FIRST_FRAME_KEY]: firstFrame,
      }
    }
    return {
      text: promptText,
      node51_value: String(aiAppLongEdgeOf(genParams?.aiAppLongEdge)),
      [AI_APP_FIRST_FRAME_KEY]: firstFrame,
    }
  }

  async function runNodeSpecs(card: CanvasCardData, params: GenNodeParams, info: AigcModelInfo | null): Promise<JobSpec[]> {
    const kind = modelKindOf(params.model)
    // 唯一提示词收口: 标准渠道与 AI 应用渠道都从这里取 promptText;
    // 绑定的摄影机提示词在此统一追加(摄影机实时配置优先, 节点被删回退快照), 五渠道全覆盖
    const basePrompt = kind === 'i2v' ? resolveI2vPrompt(card.prompt) : card.prompt || ''
    // 透明背景前缀在用户提示词之前(仅 GPT Image 2 官方/低价渠道), 摄影机提示词仍追加在最后
    const withTransparent = applyTransparentBgPrompt(basePrompt, params)
    const promptText = appendCameraPrompt(withTransparent, resolveCameraPrompt(card))
    const refUrls = effectiveRefUrls(card)
    const video = kind === 't2v' || kind === 'i2v'
    // 图片结果继承局部选区上下文(节点自身图 + 直连上游卡; 视频结果不设)
    const inheritedContext = video
      ? null
      : inheritCropContext([
          card,
          ...connectionsRef.current
            .filter(conn => conn.toId === card.id)
            .map(conn => cardsRef.current.find(c => c.id === conn.fromId))
            .filter((c): c is CanvasCardData => !!c),
        ])
    // AI 应用渠道: 不走标准 openapi body, 字段平铺给该应用; 单次只出 1 个视频
    const appSlug = aiAppSlugOf(params.model)
    if (appSlug) {
      const firstFrame = refUrls[0] ?? ''
      const body = buildAiAppRunBody(params.model, promptText, params, firstFrame)
      const item: GenerateResultItem = {
        itemStatus: 'queued',
        isVideo: true,
        runBody: body,
        model: params.model,
        promptText,
        aiAppFirstFrame: firstFrame,
      }
      setCards(prev =>
        prev.map(c =>
          c.id === card.id
            ? { ...c, model: params.model, runBody: body, results: [item], activeResultIndex: 0, jobStatus: 'running', costText: '' }
            : c,
        ),
      )
      return [{ resultCardId: card.id, nodeId: card.id, resultIndex: 0, model: params.model, body, promptText, sourceCardId: card.id, aiAppFirstFrame: firstFrame, isVideo: true }]
    }
    let body = buildNodeRunBody(params, promptText, refUrls, info)
    // 图片任务选「自适应」且有参考图时: 出图比例跟随参考图真实尺寸。
    // 局部选区图常与原图比例不同(如竖版原图上的横版局部), 若把比例完全交给平台,
    // 部分渠道会回落到默认竖版比例, 改图结果与局部图拼不回原图; 这里显式给最接近的渠道档位。
    if (!video && refUrls.length && (params.aspectRatio === 'adaptive' || params.aspectRatio === 'empty')) {
      const adaptiveAr = await resolveAdaptiveRatio(info, params.aspectRatio, refUrls)
      if (adaptiveAr) body = { ...body, aspectRatio: adaptiveAr }
    }
    const count = Math.max(1, Math.min(4, params.count || 1))
    const specs: JobSpec[] = []
    // 结果直接长在生成节点自身: 重置为 count 个排队项, 不再新建右侧结果卡/连线;
    // 主图(card.url)保持上一轮结果直到新结果成功, 下游图生图首帧不受影响。
    const items: GenerateResultItem[] = Array.from({ length: count }, () => ({
      itemStatus: 'queued' as CardJobStatus,
      isVideo: video,
      runBody: body,
      model: params.model,
      promptText,
      ...(video ? {} : { cropContext: inheritedContext }),
    }))
    setCards(prev =>
      prev.map(c =>
        c.id === card.id
          ? { ...c, model: params.model, runBody: body, results: items, activeResultIndex: 0, jobStatus: 'running' as CardJobStatus }
          : c,
      ),
    )
    for (let i = 0; i < count; i += 1) {
      specs.push({
        resultCardId: card.id,
        nodeId: card.id,
        resultIndex: i,
        model: params.model,
        body,
        promptText,
        sourceCardId: card.id,
        isVideo: video,
      })
    }
    return specs
  }

  async function launchSpecs(specs: JobSpec[]) {
    if (!specs.length) return
    setPendingJobs(prev => [
      ...prev,
      ...specs.map(s => ({
        cardId: s.nodeId ?? s.resultCardId,
        resultIndex: s.resultIndex,
        model: s.model,
        promptText: s.promptText,
        submittedAt: Date.now(),
      })),
    ])
    setRunningCount(n => n + specs.length)
    // 提交即把在途记录快速落库: 用户提交后立刻退出, 再进画布也能按提示词/远端 ID 认领在跑任务,
    // 而不是只剩「可重试的失败项」诱导重复提交扣费。
    requestQuickFullSave()
    await runPool(specs, BATCH_CONCURRENCY, spec => runJob(spec))
  }

  async function runBatchNodes(targets: CanvasCardData[]) {
    const allSpecs: JobSpec[] = []
    for (const card of targets) {
      const base = card.genParams ?? defaultGenParams()
      // 家族选择 → 按有无参考图解析成真实模型(文生/图生); 纯图生渠道无图已在校验里拦截
      const runModel = resolveRunModel(base.model, effectiveRefUrls(card).length > 0)
      const params = runModel === base.model ? base : { ...base, model: runModel }
      const info = await ensureModelInfo(runModel)
      const specs = await runNodeSpecs(card, params, info)
      allSpecs.push(...specs)
    }
    await launchSpecs(allSpecs)
  }

  function handleRunGenerateNode(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card) return
    const params = card.genParams ?? defaultGenParams()
    const err = validateGenerateNode(card, params)
    if (err) {
      toast.error(err)
      return
    }
    const count = Math.max(1, Math.min(4, params.count || 1))
    const priceNote = priceNoteForJobs([{ model: params.model, count, params, hasImg: effectiveRefUrls(card).length > 0 }])
    costConfirm.runWithCostConfirm(() => {
      // 同步占锁(action 在放行模式下于点击当帧同步执行, 早于第一个 await):
      // 双击第二下直接忽略, 防重复扣费与结果写串
      const lockKey = `node:${cardId}`
      if (!acquireRunLock(lockKey)) return
      void runBatchNodes([card]).finally(() => releaseRunLock(lockKey))
    }, priceNote)
  }

  /** 可批量运行的节点: 生成节点(有提示词即可跑文生; 图生模式需有图, 缺图跳过) */
  const selectedRunnableNodes = useMemo(
    () => cards.filter(c => selectedIds.includes(c.id) && c.kind === 'generate'),
    [cards, selectedIds],
  )

  function handleRunSelectedNodes() {
    const targets = selectedRunnableNodes
    if (!targets.length) {
      toast.error('请先框选生成节点')
      return
    }
    const valid: CanvasCardData[] = []
    let skipped = 0
    targets.forEach(card => {
      const err = validateGenerateNode(card, card.genParams ?? defaultGenParams())
      if (err) skipped += 1
      else valid.push(card)
    })
    if (!valid.length) {
      toast.error('选中的节点都还缺内容: 写描述/提示词或传一张图后再运行')
      return
    }
    if (skipped > 0) toast.info(`${skipped} 个节点缺描述、提示词或图片, 已跳过`)
    const jobs = valid.map(card => {
      const params = card.genParams ?? defaultGenParams()
      return { model: params.model, count: Math.max(1, Math.min(4, params.count || 1)), params, hasImg: effectiveRefUrls(card).length > 0 }
    })
    // 批次 key 只取 id(稳定快照), 排序后拼接: 同一次选择的连点命中同一把锁
    const lockKey = `batch:${valid.map(c => c.id).sort().join(',')}`
    const launch = () => {
      if (!acquireRunLock(lockKey)) return
      void runBatchNodes(valid).finally(() => releaseRunLock(lockKey))
    }
    // 图片批量高额保护: 图片任务总额超阈值(默认 8 元)强制二次确认, 视频不计入也不拦截
    const img = summarizeImageJobs(jobs)
    if (img.imageTotal > BATCH_IMAGE_CONFIRM_LIMIT) {
      setBatchConfirm({
        imageTotal: img.imageTotal,
        imageCount: img.imageCount,
        hasVideo: img.hasVideo,
        run: () => costConfirm.runWithCostConfirm(launch, priceNoteForJobs(jobs)),
      })
      return
    }
    costConfirm.runWithCostConfirm(launch, priceNoteForJobs(jobs))
  }

  /** 图片批量高额确认弹窗: 取消(关闭不运行) / 确认(执行已暂存的批量启动) */
  function cancelBatchImageConfirm() {
    setBatchConfirm(null)
  }
  function confirmBatchImageRun() {
    const run = batchConfirm?.run
    setBatchConfirm(null)
    run?.()
  }

  /** 提交 AIGC 前把 body 里的永久图片链接换成平台临时链接(展示用永久链接不过期, 出任务才换) */
  async function bodyWithRhUrls(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { ...body }
    await Promise.all(
      Object.keys(out).map(async k => {
        const v = out[k]
        if (typeof v === 'string') {
          if (isPersistedMediaUrl(v)) out[k] = await toRhMediaUrl(v)
        } else if (Array.isArray(v)) {
          const arr = v.filter((x): x is string => typeof x === 'string')
          if (arr.length && arr.some(u => isPersistedMediaUrl(u))) out[k] = await toRhMediaUrls(arr)
        }
      }),
    )
    return out
  }

  /** AI 应用结果视频: 从 outputs/results 里取第一个视频条目链接 */
  function aiAppVideoUrl(res: AiAppRunResponse): string {
    const all = [...(res.outputs ?? []), ...(res.results ?? [])]
    const video = all.find(o => o?.type === 'video' && o.url) ?? all.find(o => o.url)
    return video?.url ?? ''
  }

  /** 把首帧永久链接拉成 File 并上传给该 AI 应用, 换回 fileName(图片走 image 二进制直传) */
  async function uploadAiAppFirstFrame(slug: string, frameUrl: string): Promise<string> {
    const src = mediaSrc(frameUrl)
    if (!src) throw new Error('missing-frame')
    const resp = await fetch(src, { mode: 'cors' })
    if (!resp.ok) throw new Error('frame-fetch-failed')
    const blob = await resp.blob()
    const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    const file = new File([blob], `firstframe.${ext}`, { type: blob.type || 'image/png' })
    const up = await uploadAiAppMedia(slug, file, 'image')
    if (!up?.ok || !up.fileName) throw new Error('frame-upload-failed')
    return up.fileName
  }

  // ---------- 生成日志 ----------
  /** 写一条生成日志: 新条目 unshift 到头部, 最多保留最近 500 条(随自动保存落盘) */
  function appendGenLog(entry: Omit<GenLogEntry, 'id' | 'createdAt'> & { id?: string; createdAt?: number }) {
    const full: GenLogEntry = {
      id: entry.id ?? uid(),
      createdAt: entry.createdAt ?? Date.now(),
      status: entry.status,
      platform: entry.platform,
      nodeType: entry.nodeType,
      model: entry.model,
      prompt: entry.prompt ?? '',
      refs: entry.refs ?? [],
      outputs: entry.outputs ?? [],
      runMs: Math.max(0, Math.round(entry.runMs || 0)),
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      ...(entry.traceId ? { traceId: entry.traceId } : {}),
      ...(entry.costText ? { costText: entry.costText } : {}),
      ...(entry.batchSummary ? { batchSummary: entry.batchSummary } : {}),
      ...(entry.request && Object.keys(entry.request).length ? { request: entry.request } : {}),
    }
    setGenLogs(prev => [full, ...prev].slice(0, 500))
  }

  /** 生成日志平台名: AI 应用渠道按应用给中文名, 标准 AIGC 统一 RunningHub */
  function logPlatformOf(model: string): string {
    const appSlug = aiAppSlugOf(model)
    if (appSlug === 'wan22' || appSlug === 'wan22hq') return 'WAN 2.2 AI 应用'
    if (model === TTS_APP_SLUG) return 'IndexTTS 2 AI 应用'
    if (model === MOTION_APP_SLUG) return 'Animate V9 AI 应用'
    if (model === VSR_APP_SLUG) return 'SeedVR2 AI 应用'
    return 'RunningHub'
  }

  /** 生成日志模型/任务名: 优先渠道家族中文名, 其次原始 slug */
  function logModelLabel(model: string): string {
    return channelFamilyOf(model)?.label || model
  }

  /** 提交快照(用于日志详情): 去掉 AI 应用首帧内部字段, 避免把内部占位透给用户 */
  function sanitizeLogBody(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!body) return undefined
    const out: Record<string, unknown> = {}
    Object.keys(body).forEach(k => {
      if (k === AI_APP_FIRST_FRAME_KEY) return
      const v = body[k]
      if (v === undefined) return
      out[k] = v
    })
    return out
  }

  /** 标准 AIGC / AI 应用统一管线(runJob)的提交快照: 提示词/参考图/开始时间 */
  const specLogMetaRef = useRef(new WeakMap<JobSpec, { startedAt: number; refs: string[] }>())
  function beginSpecLog(spec: JobSpec) {
    const ownerCard = cardsRef.current.find(c => c.id === (spec.nodeId ?? spec.resultCardId))
    const refs =
      spec.refs ??
      (ownerCard
        ? effectiveRefUrls(ownerCard)
        : (spec.sourceCardId ? cardsRef.current.find(c => c.id === spec.sourceCardId)?.refUrls ?? [] : []))
    specLogMetaRef.current.set(spec, { startedAt: Date.now(), refs: refs.filter(Boolean).slice(0, 9) })
  }
  /** 统一管线收尾写日志(仅终态 success/failed; aborted/会话失效不写) */
  function finishSpecLog(
    spec: JobSpec,
    out: { jobStatus: CardJobStatus; url?: string; taskId?: string; costText?: string; errorMsg?: string },
  ) {
    if (out.jobStatus !== 'success' && out.jobStatus !== 'failed') return
    const meta = specLogMetaRef.current.get(spec)
    const ownerCard = cardsRef.current.find(c => c.id === (spec.nodeId ?? spec.resultCardId))
    const refs = meta?.refs ?? spec.refs ?? (ownerCard ? effectiveRefUrls(ownerCard) : [])
    appendGenLog({
      status: out.jobStatus,
      platform: logPlatformOf(spec.model),
      nodeType: spec.nodeType ?? (ownerCard?.loopSourceId || ownerCard?.loopSlotIndex !== undefined ? 'Loop' : '生成节点'),
      model: logModelLabel(spec.model),
      prompt: spec.promptText ?? '',
      refs,
      outputs: out.url ? [{ url: out.url, kind: spec.isVideo ? 'video' : 'image' }] : [],
      runMs: meta ? Date.now() - meta.startedAt : 0,
      ...(out.errorMsg ? { error: out.errorMsg } : {}),
      ...(out.taskId ? { taskId: out.taskId } : {}),
      ...(out.costText ? { costText: out.costText } : {}),
      request: sanitizeLogBody(spec.body),
    })
  }

  /**
   * 专用 AI 应用节点(语音克隆 / 动作迁移 / 视频高清修复)的日志计时:
   * 这些通道不走 runJob, 在各自 run*Job 入口调用 start, 收尾调用 finish。
   */
  const specialLogMetaRef = useRef<Record<string, { startedAt: number; refs: string[]; refsMedia?: GenLogOutput[]; prompt: string }>>({})
  function beginSpecialLog(cardId: string, prompt: string, refs: string[], refsMedia?: GenLogOutput[]) {
    specialLogMetaRef.current[cardId] = {
      startedAt: Date.now(),
      prompt,
      refs: refs.filter(Boolean).slice(0, 9),
      // 带媒体类型的引用素材(动作迁移=图+视频、视频修复=视频、语音=音频不展示), 优先于 refs
      refsMedia: refsMedia?.filter(m => !!m.url).slice(0, 9),
    }
  }
  function finishSpecialLog(
    cardId: string,
    model: string,
    nodeType: string,
    out: { success: boolean; output?: GenLogOutput; taskId?: string; costText?: string; errorMsg?: string; request?: Record<string, unknown> },
  ) {
    const meta = specialLogMetaRef.current[cardId]
    appendGenLog({
      status: out.success ? 'success' : 'failed',
      platform: logPlatformOf(model),
      nodeType,
      model: logModelLabel(model),
      prompt: meta?.prompt ?? '',
      refs: meta?.refs ?? [],
      // 带媒体类型的引用素材优先; 语音克隆等纯音频任务传空数组, 日志不显示参考图行
      ...(meta?.refsMedia ? { refsMedia: meta.refsMedia } : {}),
      outputs: out.success && out.output ? [out.output] : [],
      runMs: meta ? Date.now() - meta.startedAt : 0,
      ...(out.errorMsg ? { error: out.errorMsg } : {}),
      ...(out.taskId ? { taskId: out.taskId } : {}),
      ...(out.costText ? { costText: out.costText } : {}),
      request: sanitizeLogBody(out.request),
    })
    delete specialLogMetaRef.current[cardId]
  }

  /** 刷新恢复的任务在收尾时写日志(无法精确测量耗时, runMs=0) */
  function appendRestoredLog(input: {
    status: 'success' | 'failed'
    platform: string
    nodeType: string
    model: string
    prompt: string
    refs?: string[]
    refsMedia?: GenLogOutput[]
    outputs?: GenLogOutput[]
    errorMsg?: string
    taskId?: string
    costText?: string
  }) {
    appendGenLog({
      status: input.status,
      platform: input.platform,
      nodeType: input.nodeType,
      model: input.model,
      prompt: input.prompt,
      refs: input.refs ?? [],
      ...(input.refsMedia ? { refsMedia: input.refsMedia } : {}),
      outputs: input.outputs ?? [],
      runMs: 0,
      ...(input.errorMsg ? { error: input.errorMsg } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.costText ? { costText: input.costText } : {}),
    })
  }

  /** 任务结果写回: 生成节点自身结果走 results[resultIndex] 聚合; 老独立结果卡(loop 等)照旧整卡更新 */
  function writeSpecResult(
    spec: JobSpec,
    patch: { jobStatus: CardJobStatus; url?: string; taskId?: string; costText?: string; errorMsg?: string },
  ) {
    if (spec.nodeId !== undefined && spec.resultIndex !== undefined) {
      patchNodeResult(spec.nodeId, spec.resultIndex, {
        itemStatus: patch.jobStatus,
        url: patch.url,
        taskId: patch.taskId,
        costText: patch.costText,
        errorMsg: patch.errorMsg,
        isVideo: spec.isVideo,
      })
    } else {
      updateCard(spec.resultCardId, patch)
    }
    // 统一收口: 标准 AIGC / AI 应用所有经 runJob 的任务(含重试)在终态写一条生成日志
    finishSpecLog(spec, patch)
  }

  /** 任务运行中态: 节点结果项转 running(老路径整卡转 running) */
  function markSpecRunning(spec: JobSpec) {
    if (spec.nodeId !== undefined && spec.resultIndex !== undefined) {
      patchNodeResult(spec.nodeId, spec.resultIndex, { itemStatus: 'running' })
    } else {
      updateCard(spec.resultCardId, { jobStatus: 'running' })
    }
  }

  function finishSpec(spec: JobSpec) {
    setRunningCount(n => Math.max(0, n - 1))
    removePendingJob(spec.nodeId ?? spec.resultCardId, spec.resultIndex)
  }

  /** 任务被受理拿到远端 ID 后即刻写回未完成任务记录(用于刷新后精确认领, 不再靠提示词猜) */
  function attachPendingTask(spec: JobSpec, remoteTaskId: string) {
    setPendingJobs(prev =>
      prev.map(j =>
        j.cardId === (spec.nodeId ?? spec.resultCardId) &&
        (j.resultIndex === undefined ? spec.resultIndex === undefined : j.resultIndex === spec.resultIndex) &&
        j.model === spec.model &&
        !j.remoteTaskId
          ? { ...j, remoteTaskId }
          : j,
      ),
    )
    // 远端任务 ID 是刷新后续跑/防重复提交的关键: 立即排一次保存(防抖提前到 250ms),
    // 避免「提交后秒退、ID 还没随防抖落库」导致再进画布只能靠提示词猜甚至重复提交。
    requestQuickFullSave()
  }

  /** 延迟转存回写前统一过会话闸门, 切走画布后不再回写 */
  function persistResultPermanent(spec: JobSpec, url: string, kind?: 'video') {
    const token = sessionTokenRef.current
    void persistRemoteImage(url, kind).then(permanent => {
      if (!permanent || permanent === url || !aliveForSession(token)) return
      if (spec.nodeId !== undefined && spec.resultIndex !== undefined) {
        replaceNodeResultUrl(spec.nodeId, spec.resultIndex, url, permanent)
      } else {
        const cur = cardsRef.current.find(c => c.id === spec.resultCardId)
        if (cur && cur.url === url) updateCard(spec.resultCardId, { url: permanent })
      }
    })
  }

  /** AI 应用渠道(图生视频)提交+轮询: 首帧上传换 fileName → 平铺字段提交, 不走标准 openapi body 换链 */
  async function runAiAppJob(slug: string, spec: JobSpec, token: number, signal: AbortSignal): Promise<void> {
    try {
      // 首帧优先取 JobSpec 自带, 重试场景从 runBody 内部字段 / 标准首帧字段兜底
      let frameUrl =
        spec.aiAppFirstFrame ||
        (spec.body[AI_APP_FIRST_FRAME_KEY] as string | undefined) ||
        (spec.body.firstFrameUrl as string | undefined) ||
        (spec.body.imageUrl as string | undefined) ||
        spec.body.referenceImage as string | undefined ||
        ''
      if (!frameUrl) frameUrl = effectiveRefUrls(cardsRef.current.find(c => c.id === (spec.nodeId ?? spec.resultCardId)) ?? ({} as CanvasCardData))[0] ?? ''
      // 重试 / 续跑时 spec.body 已按所选 AI 应用渠道平铺好(node51 或 node438/node446), 原样复用;
      // 历史遗留 body 缺标量字段时再按当前渠道兜底重建。
      const text = typeof spec.body.text === 'string' ? spec.body.text : spec.promptText
      let appBody: Record<string, unknown>
      if (slug === 'wan22hq') {
        appBody = {
          text,
          node438_value: (spec.body.node438_value as string) ?? String(aiAppLongEdgeOf(undefined)),
          node446_value: (spec.body.node446_value as string) ?? String(AI_APP_FRAMES_DEFAULT),
        }
      } else {
        appBody = {
          text,
          node51_value: (spec.body.node51_value as string) ?? String(AI_APP_LONG_EDGE_DEFAULT),
        }
      }
      if (frameUrl) appBody.referenceImage = await uploadAiAppFirstFrame(slug, frameUrl)
      const res = await runAiAppGuarded(slug, appBody, {
        pollIntervalMs: POLL_INTERVAL_MS,
        deadlineMs: POLL_TIMEOUT_MS,
        signal,
        onAccepted: remoteId => aliveForSession(token) && attachPendingTask(spec, remoteId),
      })
      if (!aliveForSession(token)) return
      if (res.state === 'succeeded' || res.state === 'partial') {
        const url = aiAppVideoUrl(res)
        // wan22 / wan22hq 走站内固定单价, 花费直接显示已知实付价
        const costVal = AI_APP_USER_PRICE[spec.model]
        writeSpecResult(spec, {
          jobStatus: 'success',
          url,
          taskId: res.job?.taskId || res.job?.jobId || `${spec.nodeId ?? spec.resultCardId}:${spec.resultIndex ?? 0}`,
          costText: typeof costVal === 'number' ? `¥${costVal.toFixed(2)}` : '',
        })
        // AI 应用视频同样后台转存永久链接(临时链接 24h 过期, 不转存次日裂掉且导出项目拿不到视频)
        if (url) persistResultPermanent(spec, url, 'video')
      } else {
        if (res.error?.code === 'ABORTED') return
        if (res.error?.code === 'RH_LOGIN_REQUIRED') setNeedsRhLogin(true)
        writeSpecResult(spec, { jobStatus: 'failed', errorMsg: formatAiAppFailureMessage(res) })
      }
    } catch (err) {
      if (!aliveForSession(token)) return
      const status = (err as { status?: number })?.status
      if (status === 412 || status === 401 || status === 403) setNeedsRhLogin(true)
      writeSpecResult(spec, {
        jobStatus: 'failed',
        errorMsg: status === 412 || status === 401 || status === 403 ? '登录已过期, 请重新登录后重试' : '首帧图上传或生成失败, 请重试',
      })
    } finally {
      endJobSignal(signal)
      finishSpec(spec)
    }
  }

  async function runJob(spec: JobSpec) {
    const token = sessionTokenRef.current
    const signal = beginJobSignal()
    // 记录提交快照(提示词/参考图/开始时间), 终态由 writeSpecResult 统一写日志
    beginSpecLog(spec)
    const appSlug = aiAppSlugOf(spec.model)
    if (appSlug) {
      markSpecRunning(spec)
      await runAiAppJob(appSlug, spec, token, signal)
      return
    }
    markSpecRunning(spec)
    try {
      const body = await bodyWithRhUrls(spec.body)
      if (!aliveForSession(token)) return
      const res = await runAigcGuarded(spec.model, body, {
        pollIntervalMs: POLL_INTERVAL_MS,
        deadlineMs: POLL_TIMEOUT_MS,
        signal,
        onAccepted: remoteId => aliveForSession(token) && attachPendingTask(spec, remoteId),
      })
      if (!aliveForSession(token) || (res.status === 'failed' && res.errorKind === 'aborted')) return
      if (res.status === 'success') {
        const outs = res.outputs || []
        const url = res.url || outs[0]?.url || ''
        writeSpecResult(spec, {
          jobStatus: 'success',
          url,
          taskId: res.taskId || `${spec.nodeId ?? spec.resultCardId}:${spec.resultIndex ?? 0}`,
          costText: stdCostText(res, ''),
        })
        // 结果图/视频后台转存为永久链接: 先展示临时链接(立刻可见), 转存完成后静默替换, 避免次日裂图
        // (节点结果项替换对应项 url, 老独立结果卡整卡替换)
        if (url) persistResultPermanent(spec, url, spec.isVideo ? 'video' : undefined)
      } else {
        if (res.needsLogin || res.errorKind === 'login_required') setNeedsRhLogin(true)
        writeSpecResult(spec, { jobStatus: 'failed', errorMsg: formatAigcFailureMessage(res) })
      }
    } catch (err) {
      // 换链上传等同步异常不再泄漏: 计数/未完成任务/节点状态统一在 finally 收尾
      if (!aliveForSession(token)) return
      const status = (err as { status?: number })?.status
      if (status === 412 || status === 401 || status === 403) setNeedsRhLogin(true)
      writeSpecResult(spec, { jobStatus: 'failed', errorMsg: '提交失败, 请重试' })
    } finally {
      endJobSignal(signal)
      finishSpec(spec)
    }
  }

  function handleRetryCard(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const cardModel = card?.model
    if (!card || !cardModel) return
    const lockKey = `card:${cardId}`
    costConfirm.runWithCostConfirm(async () => {
      if (!acquireRunLock(lockKey)) return
      try {
        await runRetryCard(card, cardId, cardModel)
      } finally {
        releaseRunLock(lockKey)
      }
    }, `重试生成 1 ${ALL_VIDEO_MODELS.includes(cardModel) || channelFamilyOf(cardModel)?.media === 'video' ? '个视频' : '张'} · 按 RunningHub 实际扣费`)
  }

  async function runRetryCard(card: CanvasCardData, cardId: string, cardModel: string) {
    let body = card.runBody
    const appSlug = aiAppSlugOf(cardModel)
    if (!body) {
      if (appSlug) {
        // AI 应用渠道重建提交体: 平铺字段 + 首帧内部占位(提交前上传换 fileName)。
        // 参考图统一走 effectiveRefUrls——已排除本节点自己的生成结果, 不会自引用。
        const firstFrame = effectiveRefUrls(card)[0] ?? ''
        body = buildAiAppRunBody(cardModel, resolveI2vPrompt(card.prompt), card.genParams, firstFrame)
      } else {
        const info = await ensureModelInfo(cardModel)
        const kind = modelKindOf(cardModel)
        const effRefs = effectiveRefUrls(card)
        if (kind === 't2v' || kind === 'i2v') {
          body = buildBodyWithDefaults(info, resolveI2vPrompt(card.prompt), [])
          const firstFrame = kind === 'i2v' ? effRefs[0] ?? null : null
          if (firstFrame) body[firstFrameFieldName(info)] = firstFrame
        } else {
          body = buildBodyWithDefaults(info, card.prompt || '', kind === 'i2i' ? effRefs : [])
        }
      }
    }
    setPendingJobs(prev => [
      ...prev,
      { cardId, model: cardModel, promptText: card.prompt || '', submittedAt: Date.now() },
    ])
    setRunningCount(n => n + 1)
    await runJob({ resultCardId: cardId, model: cardModel, body, promptText: card.prompt || '', sourceCardId: cardId })
  }

  /** 生成节点失败结果项的单项重试: 同参数/同提示词/同上游重跑, 写回同一项(不影响其他结果) */
  function handleRetryNodeResult(cardId: string, resultIndex: number) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const item = card?.results?.[resultIndex]
    if (!card || !item) return
    // 模型优先取节点当前选定渠道(浮条上可换): 换过渠道则旧 runBody 属于旧模型契约, 丢弃重建
    const model = card.genParams?.model || item.model || card.model
    if (!model) return
    const video = !!item.isVideo || ALL_VIDEO_MODELS.includes(model) || channelFamilyOf(model)?.media === 'video'
    const lockKey = `retry:${cardId}:${resultIndex}`
    costConfirm.runWithCostConfirm(async () => {
      // 同步占锁, 早于 ensureModelInfo/上传等所有 await; 失败格小钮连点只认第一次
      if (!acquireRunLock(lockKey)) return
      try {
        await runRetryNodeResult(card, item, cardId, resultIndex, model, video)
      } finally {
        releaseRunLock(lockKey)
      }
    }, `重试生成 1 ${video ? '个视频' : '张'} · 按 RunningHub 实际扣费`)
  }

  async function runRetryNodeResult(
    card: CanvasCardData,
    item: GenerateResultItem,
    cardId: string,
    resultIndex: number,
    model: string,
    video: boolean,
  ) {
    let body = model === item.model ? item.runBody : undefined
    const appSlug = aiAppSlugOf(model)
    if (!body) {
      if (appSlug) {
        const firstFrame = effectiveRefUrls(card)[0] ?? ''
        body = buildAiAppRunBody(model, resolveI2vPrompt(item.promptText ?? card.prompt), card.genParams, firstFrame)
      } else {
        const info = await ensureModelInfo(model)
        const refUrls = effectiveRefUrls(card)
        const kind = modelKindOf(model)
        body = buildBodyWithDefaults(info, item.promptText ?? card.prompt ?? '', kind === 't2i' ? [] : refUrls)
        if (kind === 'i2v') {
          const firstFrame = refUrls[0]
          if (firstFrame) body[firstFrameFieldName(info)] = firstFrame
        }
      }
    }
    const spec: JobSpec = {
      resultCardId: cardId,
      nodeId: cardId,
      resultIndex,
      model,
      body,
      promptText: item.promptText ?? card.prompt ?? '',
      sourceCardId: cardId,
      isVideo: video,
      ...(appSlug ? { aiAppFirstFrame: item.aiAppFirstFrame } : {}),
    }
    patchNodeResult(cardId, resultIndex, {
      itemStatus: 'queued',
      errorMsg: undefined,
      runBody: body,
      model,
      promptText: spec.promptText,
    })
    setPendingJobs(prev => [
      ...prev,
      { cardId, resultIndex, model, promptText: spec.promptText, submittedAt: Date.now() },
    ])
    setRunningCount(n => n + 1)
    await runJob(spec)
  }

  // ---------- 生成节点参数 ----------

  function handleUpdateGenParams(cardId: string, patch: Partial<GenNodeParams>) {
    setCards(prev =>
      prev.map(c => (c.id === cardId ? { ...c, genParams: { ...defaultGenParams(), ...c.genParams, ...patch } } : c)),
    )
    if (patch.model || patch.resolution || patch.videoDuration || patch.quality || patch.aspectRatio) {
      const card = cardsRef.current.find(c => c.id === cardId)
      const merged = { ...defaultGenParams(), ...card?.genParams, ...patch }
      refreshModelPrice(merged.model, card ? effectiveRefUrls(card) : [], merged)
    }
  }

  function handleUpdateSelectedGenParams(patch: Partial<GenNodeParams>) {
    const targets = cardsRef.current.filter(c => selectedIds.includes(c.id) && c.kind === 'generate')
    if (!targets.length) return
    setCards(prev =>
      prev.map(c =>
        selectedIds.includes(c.id) && c.kind === 'generate'
          ? { ...c, genParams: { ...defaultGenParams(), ...c.genParams, ...patch } }
          : c,
      ),
    )
    setBatchSettingsReady(true)
    if (patch.model || patch.resolution || patch.videoDuration || patch.quality || patch.aspectRatio) {
      targets.forEach(card => {
        const merged = { ...defaultGenParams(), ...card.genParams, ...patch }
        refreshModelPrice(merged.model, effectiveRefUrls(card), merged)
      })
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      setBatchSettingsReady(false)
      const soloId = selectedIdsRef.current.length === 1 ? selectedIdsRef.current[0] : null
      const soloCard = soloId ? cardsRef.current.find(c => c.id === soloId) : undefined
      // 拖动卡片松手造成的选中: 不自动弹出面板(区分「移动」与「原地点击」), 标记只读一次
      const dragged = suppressAutoPanelRef.current
      suppressAutoPanelRef.current = false
      // 已接下游(融合/生成/润色等任意节点)的生成节点默认收起, 避免点击图片或节点时参数面板弹出遮挡;
      // 没有下游时, 原地点击选中即展开面板
      const hasOutgoing =
        !!soloCard && soloCard.kind === 'generate' && connectionsRef.current.some(conn => conn.fromId === soloId)
      if (soloCard && soloCard.kind === 'generate' && !hasOutgoing && !dragged) {
        setEditNodeId(soloId)
        return
      }
      // 拖动移动 / 已有下游 / 非生成节点 / 取消选择: 不自动弹出(已展开的拖动时保留); 同选中下手动展开则保留
      setEditNodeId(prev => (prev && prev === soloId ? prev : null))
    })
  }, [selectedIdsKey])

  // 创建菜单关闭(已创建/ Esc / 点空白 / 滚轮)或无连接来源打开时, 清掉停驻的连接预览线
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 连接预览线必须与创建菜单关闭同帧清理，延迟会出现幽灵线
    if (!addMenuPos?.connectFrom) setConnectionDraft(null)
  }, [addMenuPos])

  /** 双击节点 展开/收起生成节点面板(editNodeId 记录当前展开的节点) */
  function handleToggleNodePanel(cardId: string) {
    setEditNodeId(prev => (prev === cardId ? null : cardId))
  }

  /** 纯图结果态点「展开」: 选中该节点并展开完整生成节点面板(已展开则收起); 融合输入的节点默认收起, 由此按钮手动展开 */
  function handleExpandNodePanel(cardId: string) {
    setSelectedIds([cardId])
    setEditNodeId(prev => (prev === cardId ? null : cardId))
  }


  // ---------- 生成节点图片位(上传/换图/删图; 图生图/图生视频时作第一张参考/首帧) ----------

  /** 上传或更换生成节点的图片位 */
  async function handleSetNodeImage(cardId: string, file: File | null) {
    if (!file) return
    if (!isSupportedCanvasImageFile(file)) {
      toast.error(isImageFile(file) ? unsupportedImageToast([{ name: file.name }]) : '请选择图片文件')
      return
    }
    // 本地先预览: 先解码本地图拿到真实尺寸写入缓存, 节点首帧即按正确大小显示图片(跳过占位框)
    const localUrl = URL.createObjectURL(file)
    const dims = await loadImageDims(localUrl)
    if (dims) primeLod(localUrl, dims.nw, dims.nh)
    updateCard(cardId, { url: localUrl, jobStatus: 'queued' })
    preloadLod([localUrl])
    try {
      let url = ''
      try { url = await persistMedia(file, 'image') } catch (upErr) { if ((upErr as { status?: number }).status === 412) throw Object.assign(new Error('login_required'), { status: 412 }) }
      if (!url) {
        updateCard(cardId, { url: undefined, jobStatus: undefined, w: 320, h: 180 })
        toast.error('上传失败, 请重试')
        return
      }
      // 同一张图尺寸已知, 预写云端地址尺寸, 换地址时布局不变;
      // 缩略图后台预热即可, 不再 await 阻塞转圈(本地 blob 预览一直显示到新图就绪)
      if (dims) primeLod(url, dims.nw, dims.nh)
      preloadLod([url])
      updateCard(cardId, { url, jobStatus: undefined })
      // 永久链接刚写回: 立刻排一次全量保存, 把「传完→退出」的丢失窗口压到近乎为零
      flushAfterMediaSaved(cardId)
      // 稍后再释放本地预览, 等视图完全切到云端地址
      setTimeout(() => URL.revokeObjectURL(localUrl), 5000)
      const curParams = cardsRef.current.find(c => c.id === cardId)?.genParams
      refreshModelPrice(curParams?.model ?? I2I_MODELS[0], [url], curParams)
    } catch {
      updateCard(cardId, { url: undefined, jobStatus: undefined, w: 320, h: 180 })
      URL.revokeObjectURL(localUrl)
      toast.error('上传失败, 请重试')
    }
  }

  function handleClearNodeImage(cardId: string) {
    // 移除节点图片位后恢复空生成节点默认尺寸——此前卡片已按图片自然尺寸回写过 w/h,
    // 只清 url 会留下一个图片大小的空框。已有生成结果的节点不走此入口(无移除钮)。
    updateCard(cardId, { url: undefined, w: 320, h: 180 })
  }

  // ---------- 刷新恢复: 未完成任务续轮询 ----------

  async function restorePendingJobs(pending: PendingJobRecord[], docCards: CanvasCardData[], sessionToken: number) {
    const byModel = new Map<string, PendingJobRecord[]>()
    pending.forEach(j => {
      const arr = byModel.get(j.model) ?? []
      arr.push(j)
      byModel.set(j.model, arr)
    })
    setRunningCount(n => n + pending.length)
    // 提示词兜底匹配时, 一条远端历史任务最多被一个本地待恢复任务认领, 杜绝同提示词并发任务写错节点
    const claimedHistory = new Set<string>()
    const settleJob = (job: PendingJobRecord, patch: 'drop' | 'interrupt') => {
      if (patch === 'interrupt') {
        if (job.resultIndex !== undefined) {
          patchNodeResult(job.cardId, job.resultIndex, { itemStatus: 'failed', errorMsg: '任务在刷新时中断了, 请点击重试' })
        } else {
          updateCard(job.cardId, { jobStatus: 'failed', errorMsg: '任务在刷新时中断了, 请点击重试' })
        }
      }
      removePendingJob(job.cardId, job.resultIndex)
      setRunningCount(n => Math.max(0, n - 1))
    }
    for (const [modelKey, jobs] of byModel.entries()) {
      const appSlug = aiAppSlugOf(modelKey)
      let items: AigcHistoryItem[]
      try {
        if (appSlug) {
          // AI 应用渠道有独立的历史/续轮询接口, 不走标准 openapi history
          const r = await callAiApp<{ ok: boolean; items?: Array<{ jobId: string; taskId?: string; status: string; resultUrl?: string; prompt?: string; errorMessage?: string; created?: string }> }>(
            `/api/aigc/ai-app/${appSlug}/history`,
            { page: 1, perPage: 30 },
          )
          items = (r.items ?? []).map(it => ({
            jobId: it.jobId,
            taskId: it.taskId ?? '',
            status: it.status === 'success' ? 'success' : it.status === 'running' ? 'running' : 'failed',
            resultUrl: it.resultUrl ?? '',
            prompt: it.prompt ?? '',
            errorMessage: it.errorMessage ?? '',
            created: it.created ?? '',
          })) as unknown as AigcHistoryItem[]
        } else {
          items = (await loadAigcHistory(modelKey, { page: 1, perPage: 30 })) ?? []
        }
      } catch {
        items = []
      }
      if (!aliveForSession(sessionToken)) return
      // 仅未完成的历史任务可被 running 兜底认领; 已成功/失败的历史项即使同提示词也只作精确匹配候选
      for (const job of jobs) {
        if (!aliveForSession(sessionToken)) return
        const card = docCards.find(c => c.id === job.cardId)
        if (!card) {
          settleJob(job, 'drop')
          continue
        }
        // 生成节点自身结果项: 有 pending 记录的在途项在 normalize 时已保留为 queued,
        // 这里按 queued/running 续轮询; 结果项不存在才丢弃。
        if (job.resultIndex !== undefined) {
          const item = card.results?.[job.resultIndex]
          if (!item) {
            settleJob(job, 'drop')
            continue
          }
        }
        // 节点类型/参考图快照(用于恢复完成时写日志): 生成节点自身项按节点类型, 独立结果卡按 Loop 来源标记
        const restoredNodeType =
          job.resultIndex !== undefined
            ? '生成节点'
            : card.loopSourceId || card.loopSlotIndex !== undefined
              ? 'Loop'
              : '生成节点'
        const restoredRefs = effectiveRefUrls(card)
        // 匹配优先级: ① 受理时持久化的真实任务 ID(精确, 不受同提示词并发影响)
        // ② 同提示词且仍在运行的历史任务(本批内去重认领) ③ 同提示词最新一条(成功可补写, 兜底)
        let matched: AigcHistoryItem | undefined
        if (job.remoteTaskId) {
          matched = items.find(it => it.jobId === job.remoteTaskId || (!!it.taskId && it.taskId === job.remoteTaskId))
        }
        if (!matched) {
          const runningCandidates = items
            .filter(it => it.status === 'running' && it.prompt === job.promptText && it.jobId && !claimedHistory.has(it.jobId))
            .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
          matched = runningCandidates[0]
        }
        if (!matched) {
          const latestSamePrompt = items
            .filter(it => it.prompt === job.promptText && it.jobId && !claimedHistory.has(it.jobId))
            .sort((a, b) => (b.created || '').localeCompare(a.created || ''))[0]
          matched = latestSamePrompt
        }
        if (matched?.jobId) claimedHistory.add(matched.jobId)
        if (matched && matched.status === 'running' && matched.jobId) {
          if (job.resultIndex !== undefined) {
            patchNodeResult(job.cardId, job.resultIndex, { itemStatus: 'running' })
          } else {
            updateCard(job.cardId, { jobStatus: 'running' })
          }
          // 把精确认领到的任务 ID 补登到记录, 后续再次刷新也走精确匹配
          if (!job.remoteTaskId) {
            setPendingJobs(prev =>
              prev.map(j =>
                j.cardId === job.cardId && j.resultIndex === job.resultIndex && j.model === job.model && !j.remoteTaskId
                  ? { ...j, remoteTaskId: matched!.jobId }
                  : j,
              ),
            )
          }
          void resumeJobForCard(job.cardId, matched.jobId, modelKey, job.resultIndex, sessionToken)
        } else if (matched && matched.status === 'success' && matched.resultUrl) {
          if (job.resultIndex !== undefined) {
            patchNodeResult(job.cardId, job.resultIndex, {
              itemStatus: 'success',
              url: matched.resultUrl,
              taskId: matched.taskId,
            })
            if (!aiAppSlugOf(modelKey)) {
              const resultUrl = matched.resultUrl
              const cardId = job.cardId
              const idx = job.resultIndex
              void persistRemoteImage(resultUrl).then(permanent => {
                if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
                  replaceNodeResultUrl(cardId, idx as number, resultUrl, permanent)
                }
              })
            }
          } else {
            updateCard(job.cardId, { jobStatus: 'success', url: matched.resultUrl, taskId: matched.taskId })
            const resultUrl = matched.resultUrl
            const cardId = job.cardId
            void persistRemoteImage(resultUrl).then(permanent => {
              if (permanent && permanent !== resultUrl && aliveForSession(sessionToken)) {
                const cur = cardsRef.current.find(c => c.id === cardId)
                if (cur && cur.url === resultUrl) updateCard(cardId, { url: permanent })
              }
            })
          }
          const isVideoResult = !!appSlug || ALL_VIDEO_MODELS.includes(modelKey) || channelFamilyOf(modelKey)?.media === 'video'
          appendRestoredLog({
            status: 'success',
            platform: logPlatformOf(modelKey),
            nodeType: restoredNodeType,
            model: logModelLabel(modelKey),
            prompt: job.promptText,
            refs: restoredRefs,
            outputs: [{ url: matched.resultUrl, kind: isVideoResult ? 'video' : 'image' }],
            taskId: matched.taskId || matched.jobId,
          })
          settleJob(job, 'drop')
        } else if (matched && matched.status === 'failed') {
          if (job.resultIndex !== undefined) {
            patchNodeResult(job.cardId, job.resultIndex, { itemStatus: 'failed', errorMsg: matched.errorMessage || '生成失败, 请重试' })
          } else {
            updateCard(job.cardId, { jobStatus: 'failed', errorMsg: matched.errorMessage || '生成失败, 请重试' })
          }
          appendRestoredLog({
            status: 'failed',
            platform: logPlatformOf(modelKey),
            nodeType: restoredNodeType,
            model: logModelLabel(modelKey),
            prompt: job.promptText,
            refs: restoredRefs,
            errorMsg: matched.errorMessage || '生成失败, 请重试',
            taskId: matched.taskId || matched.jobId,
          })
          settleJob(job, 'drop')
        } else {
          // 没匹配到远端任务: 视频/AI 应用历史可能有秒级写库延迟或在第 30 条之后,
          // 立刻标「可重试」会诱导用户重新提交→重复扣费。保留排队态, 延迟 4s 自动再认领一次。
          const isVideoishJob =
            !!appSlug || ALL_VIDEO_MODELS.includes(modelKey) || channelFamilyOf(modelKey)?.media === 'video'
          if (isVideoishJob && !job.__retried) {
            setTimeout(() => {
              if (!aliveForSession(sessionToken)) return
              void restorePendingJobs([{ ...job, __retried: true }], docCards, sessionToken)
            }, 4000)
          } else {
            settleJob(job, 'interrupt')
          }
        }
      }
    }
  }

  async function resumeAiAppJobForCard(cardId: string, jobId: string, slug: string, resultIndex: number | undefined, sessionToken: number) {
    const signal = beginJobSignal()
    try {
      const res = await resumeAiAppJob(slug, { jobId }, { pollIntervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_TIMEOUT_MS, signal })
      if (!aliveForSession(sessionToken) || res.error?.code === 'ABORTED') return
      if (res.state === 'succeeded' || res.state === 'partial') {
        const appPrice = AI_APP_USER_PRICE[slug]
        const patch = {
          jobStatus: 'success' as CardJobStatus,
          url: aiAppVideoUrl(res),
          taskId: res.job?.taskId || jobId,
          costText: typeof appPrice === 'number' ? `¥${appPrice.toFixed(2)}` : '',
        }
        if (resultIndex !== undefined) patchNodeResult(cardId, resultIndex, { ...patch, itemStatus: 'success', isVideo: true })
        else updateCard(cardId, patch)
        // AI 应用视频恢复后同样后台转存永久链接
        const appVideoUrl = patch.url
        if (appVideoUrl) {
          void persistRemoteImage(appVideoUrl, 'video').then(permanent => {
            if (permanent && permanent !== appVideoUrl && aliveForSession(sessionToken)) {
              if (resultIndex !== undefined) replaceNodeResultUrl(cardId, resultIndex, appVideoUrl, permanent)
              else {
                const cur = cardsRef.current.find(c => c.id === cardId)
                if (cur && cur.url === appVideoUrl) updateCard(cardId, { url: permanent })
              }
            }
          })
        }
        const aiResumeCard = cardsRef.current.find(c => c.id === cardId)
        appendRestoredLog({
          status: 'success',
          platform: logPlatformOf(slug),
          nodeType: resultIndex !== undefined ? '生成节点' : aiResumeCard?.loopSourceId ? 'Loop' : 'AI 应用',
          model: logModelLabel(slug),
          prompt: aiResumeCard?.prompt ?? '',
          refs: aiResumeCard ? effectiveRefUrls(aiResumeCard) : [],
          outputs: appVideoUrl ? [{ url: appVideoUrl, kind: 'video' }] : [],
          taskId: res.job?.taskId || jobId,
          costText: patch.costText,
        })
      } else {
        if (res.error?.code === 'RH_LOGIN_REQUIRED') setNeedsRhLogin(true)
        const aiResumeError = formatAiAppFailureMessage(res)
        if (resultIndex !== undefined) patchNodeResult(cardId, resultIndex, { itemStatus: 'failed', errorMsg: aiResumeError })
        else updateCard(cardId, { jobStatus: 'failed', errorMsg: aiResumeError })
        const aiResumeCard = cardsRef.current.find(c => c.id === cardId)
        appendRestoredLog({
          status: 'failed',
          platform: logPlatformOf(slug),
          nodeType: resultIndex !== undefined ? '生成节点' : 'AI 应用',
          model: logModelLabel(slug),
          prompt: aiResumeCard?.prompt ?? '',
          refs: aiResumeCard ? effectiveRefUrls(aiResumeCard) : [],
          errorMsg: aiResumeError,
          taskId: jobId,
        })
      }
    } catch {
      if (aliveForSession(sessionToken)) {
        if (resultIndex !== undefined) patchNodeResult(cardId, resultIndex, { itemStatus: 'failed', errorMsg: '生成失败, 请重试' })
        else updateCard(cardId, { jobStatus: 'failed', errorMsg: '生成失败, 请重试' })
      }
    } finally {
      endJobSignal(signal)
      removePendingJob(cardId, resultIndex)
      setRunningCount(n => Math.max(0, n - 1))
    }
  }

  async function resumeJobForCard(cardId: string, jobId: string, modelKey: string, resultIndex: number | undefined, sessionToken: number) {
    const appSlug = aiAppSlugOf(modelKey)
    if (appSlug) {
      await resumeAiAppJobForCard(cardId, jobId, appSlug, resultIndex, sessionToken)
      return
    }
    const signal = beginJobSignal()
    try {
      const res = await resumeAigcJob({ jobId, model: modelKey }, { pollIntervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_TIMEOUT_MS, signal })
      if (!aliveForSession(sessionToken) || (res.status === 'failed' && res.errorKind === 'aborted')) return
      if (res.status === 'success') {
        const outs = res.outputs || []
        const url = res.url || outs[0]?.url || ''
        const patch = {
          jobStatus: 'success' as CardJobStatus,
          url,
          taskId: res.taskId || jobId,
          costText: stdCostText(res, ''),
        }
        if (resultIndex !== undefined) {
          patchNodeResult(cardId, resultIndex, { ...patch, itemStatus: 'success' })
          if (url) {
            void persistRemoteImage(url).then(permanent => {
              if (permanent && permanent !== url && aliveForSession(sessionToken)) {
                replaceNodeResultUrl(cardId, resultIndex, url, permanent)
              }
            })
          }
        } else {
          updateCard(cardId, patch)
        }
        const resumeCard = cardsRef.current.find(c => c.id === cardId)
        const resumeNodeType = resultIndex !== undefined ? '生成节点' : resumeCard?.loopSourceId || resumeCard?.loopSlotIndex !== undefined ? 'Loop' : '生成节点'
        appendRestoredLog({
          status: 'success',
          platform: logPlatformOf(modelKey),
          nodeType: resumeNodeType,
          model: logModelLabel(modelKey),
          prompt: resumeCard?.prompt ?? '',
          refs: resumeCard ? effectiveRefUrls(resumeCard) : [],
          outputs: url ? [{ url, kind: modelKindOf(modelKey) === 't2v' || modelKindOf(modelKey) === 'i2v' ? 'video' : 'image' }] : [],
          taskId: res.taskId || jobId,
          costText: patch.costText,
        })
      } else {
        if (res.needsLogin || res.errorKind === 'login_required') setNeedsRhLogin(true)
        const resumeError = formatAigcFailureMessage(res)
        if (resultIndex !== undefined) patchNodeResult(cardId, resultIndex, { itemStatus: 'failed', errorMsg: resumeError })
        else updateCard(cardId, { jobStatus: 'failed', errorMsg: resumeError })
        const resumeCard = cardsRef.current.find(c => c.id === cardId)
        appendRestoredLog({
          status: 'failed',
          platform: logPlatformOf(modelKey),
          nodeType: resultIndex !== undefined ? '生成节点' : '生成节点',
          model: logModelLabel(modelKey),
          prompt: resumeCard?.prompt ?? '',
          refs: resumeCard ? effectiveRefUrls(resumeCard) : [],
          errorMsg: resumeError,
          taskId: jobId,
        })
      }
    } catch {
      if (aliveForSession(sessionToken)) {
        if (resultIndex !== undefined) patchNodeResult(cardId, resultIndex, { itemStatus: 'failed', errorMsg: '生成失败, 请重试' })
        else updateCard(cardId, { jobStatus: 'failed', errorMsg: '生成失败, 请重试' })
      }
    } finally {
      endJobSignal(signal)
      removePendingJob(cardId, resultIndex)
      setRunningCount(n => Math.max(0, n - 1))
    }
  }

  // ---------- 素材库(最小数据层) ----------

  useEffect(() => {
    const ownerKey = account?.email
    if (!ownerKey) return
    let active = true
    const loadFirstPage = async () => {
      setAssetsLoading(true)
      assetsPageRef.current = 1
      try {
        const res = await fetch(`${ASSETS_API}?page=1&perPage=${ASSETS_PAGE_SIZE}`, { headers: { ...getAuthHeaders() } })
        if (!res.ok) throw new Error('list failed')
        const data = (await res.json()) as { items?: AssetItem[]; totalItems?: number; totalPages?: number }
        if (!active) return
        setAssets(Array.isArray(data.items) ? data.items : [])
        setAssetsTotal(typeof data.totalItems === 'number' ? data.totalItems : 0)
        setAssetsHasMore(typeof data.totalPages === 'number' ? data.totalPages > 1 : (data.items?.length ?? 0) >= ASSETS_PAGE_SIZE)
      } catch {
        // 素材库加载失败不阻塞画布
      } finally {
        if (active) setAssetsLoading(false)
      }
    }
    void loadFirstPage()
    // 「全部产物」分区批量存入素材库后广播刷新, 切回素材库分区立即看到新存项
    const onAssetsChanged = () => { void loadFirstPage() }
    window.addEventListener('dangoo:assets-changed', onAssetsChanged)
    return () => {
      active = false
      window.removeEventListener('dangoo:assets-changed', onAssetsChanged)
    }
  }, [account?.email])

  /** 加载下一页全局资产, 追加到已有列表(去重) */
  async function loadMoreGlobalAssets() {
    if (assetsLoadingMore || !assetsHasMore || !account?.email) return
    setAssetsLoadingMore(true)
    try {
      const nextPage = assetsPageRef.current + 1
      const res = await fetch(`${ASSETS_API}?page=${nextPage}&perPage=${ASSETS_PAGE_SIZE}`, { headers: { ...getAuthHeaders() } })
      if (!res.ok) throw new Error('list failed')
      const data = (await res.json()) as { items?: AssetItem[]; totalPages?: number }
      const items = Array.isArray(data.items) ? data.items : []
      assetsPageRef.current = nextPage
      setAssets(prev => {
        const seen = new Set(prev.map(a => a.id))
        return [...prev, ...items.filter(a => !seen.has(a.id))]
      })
      setAssetsHasMore(typeof data.totalPages === 'number' ? nextPage < data.totalPages : items.length >= ASSETS_PAGE_SIZE)
    } catch {
      toast.error('加载更多素材失败, 请稍后重试')
    } finally {
      setAssetsLoadingMore(false)
    }
  }

  async function createAssetRecord(input: {
    name: string
    url: string
    source: string
    mediaType?: 'image' | 'video' | 'group' | 'workflow'
    folder?: string
    images?: ProjectAssetMember[] | { workflow: WorkflowDoc }
  }): Promise<AssetItem | null> {
    try {
      const res = await fetch(ASSETS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          rh_user_id: account?.email ?? '',
          name: input.name.slice(0, 120) || '未命名素材',
          url: input.url,
          media_type: input.mediaType ?? 'image',
          source: input.source,
          folder: input.folder ?? '',
          images: input.images,
        }),
      })
      if (!res.ok) return null
      return (await res.json()) as AssetItem
    } catch {
      return null
    }
  }

  async function handleUploadAsset(file: File | null) {
    if (!file) {
      toast.error('请选择图片')
      return
    }
    if (!isSupportedCanvasImageFile(file)) {
      toast.error(isImageFile(file) ? unsupportedImageToast([{ name: file.name }]) : '请选择图片')
      return
    }
    if (!getLocalAccount()) { setAuthDialog('login'); return }
    setAssetUploading(true)
    try {
      const url = await persistMedia(file, 'image').catch(upErr => {
        if ((upErr as { status?: number }).status === 412) throw Object.assign(new Error('login_required'), { status: 412 })
        return ''
      })
      if (!url) throw new Error('upload failed')
      const rec = await createAssetRecord({ name: file.name || '未命名素材', url, source: 'upload' })
      if (rec) {
        setAssets(prev => [rec, ...prev])
        toast.success('已加入素材库')
      } else {
        toast.error('素材保存失败, 请重试')
      }
    } catch {
      toast.error('素材上传失败, 请重试')
    } finally {
      setAssetUploading(false)
    }
  }

  async function handleSaveCardToAssets(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card?.url) return
    if (!getLocalAccount()) { setAuthDialog('login'); return }
    const isVideoCard = cardShowsVideo(card)
    const rec = await createAssetRecord({
      name: (card.prompt || (isVideoCard ? '生成视频' : card.kind === 'generate' ? '节点图片' : '生成图')).slice(0, 120),
      url: card.url,
      source: 'result',
      mediaType: isVideoCard ? 'video' : 'image',
    })
    if (rec) {
      setAssets(prev => [rec, ...prev])
      toast.success('已保存到素材库')
    } else {
      toast.error('保存到素材库失败')
    }
  }

  function handleOpenAssetPicker(cardId: string) {
    setAssetPickerFor({ cardId, slot: 'ref' })
  }

  // ---------- 右侧资产库: 项目库 / 全局库 / 文件夹 ----------

  /** 老文档没有 projectAssets 时补空结构, 并清洗异常项 */
  function restoreProjectAssets(raw: unknown) {
    const empty: ProjectAssets = { items: [], folders: [] }
    if (!raw || typeof raw !== 'object') {
      setProjectAssets(empty)
      return
    }
    const obj = raw as Partial<ProjectAssets>
    const items = (Array.isArray(obj.items) ? obj.items : []).filter(
      (it): it is ProjectAssetItem =>
        !!it &&
        typeof it.id === 'string' &&
        typeof it.url === 'string' &&
        (it.kind !== 'workflow' || !!it.workflow || !!it.coverUrl),
    )
    const folders = (Array.isArray(obj.folders) ? obj.folders : []).filter(
      (f): f is ProjectAssetFolder => !!f && typeof f.id === 'string' && typeof f.name === 'string',
    )
    setProjectAssets({ items, folders })
  }

  // 全局文件夹: 跟随账号加载
  useEffect(() => {
    if (!account?.email) {
      Promise.resolve().then(() => setGlobalFolders([]))
      return
    }
    let active = true
    ;(async () => {
      setFoldersLoading(true)
      try {
        // 文件夹数量通常很少, 一次拉到后端允许上限 200, 避免超过 50 个后被分页截断
        const res = await fetch(`${ASSET_FOLDERS_API}?page=1&perPage=200`, { headers: { ...getAuthHeaders() } })
        if (!res.ok) throw new Error('list failed')
        const data = await res.json()
        if (active) setGlobalFolders(Array.isArray(data.items) ? data.items : [])
      } catch {
        // 文件夹加载失败不阻塞面板
      } finally {
        if (active) setFoldersLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [account?.email])

  // ---------- 文件夹 CRUD ----------

  async function handleCreateFolder(scope: 'global' | 'project', displayName: string) {
    const trimmed = displayName.trim().slice(0, 100)
    if (!trimmed) {
      toast.error('文件夹名称不能为空')
      return null
    }
    if (scope === 'project') {
      const folder: ProjectAssetFolder = { id: uid(), name: trimmed }
      setProjectAssets(prev => ({ ...prev, folders: [...prev.folders, folder] }))
      toast.success('已新建文件夹')
      return folder.id
    }
    if (!getLocalAccount()) { setAuthDialog('login'); return null }
    try {
      const res = await fetch(ASSET_FOLDERS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ name: trimmed }),
      })
      if (res.status === 412) { setAuthDialog('login'); return null }
      if (!res.ok) throw new Error('create folder failed')
      const rec = (await res.json()) as GlobalAssetFolder
      setGlobalFolders(prev => [...prev, rec])
      toast.success('已新建文件夹')
      return rec.id
    } catch {
      toast.error('新建文件夹失败, 请重试')
      return null
    }
  }

  async function handleRenameFolder(scope: 'global' | 'project', folderId: string, displayName: string) {
    const trimmed = displayName.trim().slice(0, 100)
    if (!trimmed) {
      toast.error('文件夹名称不能为空')
      return
    }
    if (scope === 'project') {
      setProjectAssets(prev => ({
        ...prev,
        folders: prev.folders.map(f => (f.id === folderId ? { ...f, name: trimmed } : f)),
      }))
      return
    }
    try {
      const res = await fetch(`${ASSET_FOLDERS_API}/${folderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) throw new Error('rename folder failed')
      setGlobalFolders(prev => prev.map(f => (f.id === folderId ? { ...f, name: trimmed } : f)))
    } catch {
      toast.error('重命名失败, 请重试')
    }
  }

  async function handleDeleteFolder(scope: 'global' | 'project', folderId: string) {
    if (scope === 'project') {
      // 删夹不删资产: 夹内资产 folderId 置空, 落入「未分类」
      setProjectAssets(prev => ({
        folders: prev.folders.filter(f => f.id !== folderId),
        items: prev.items.map(it => (it.folderId === folderId ? { ...it, folderId: undefined } : it)),
      }))
      toast.success('文件夹已删除, 资产已移到未分类')
      return
    }
    try {
      const res = await fetch(`${ASSET_FOLDERS_API}/${folderId}`, { method: 'DELETE', headers: { ...getAuthHeaders() } })
      if (!res.ok) throw new Error('delete folder failed')
      setGlobalFolders(prev => prev.filter(f => f.id !== folderId))
      // 全局资产的 folder 字段同样置空(逐条 PATCH, 失败的保留原值不影响使用)
      setAssets(prev => {
        prev
          .filter(a => a.folder === folderId)
          .forEach(a => {
            void fetch(`${ASSETS_API}/${a.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
              body: JSON.stringify({ folder: '' }),
            }).catch(() => {})
          })
        return prev.map(a => (a.folder === folderId ? { ...a, folder: '' } : a))
      })
      toast.success('文件夹已删除, 资产已移到未分类')
    } catch {
      toast.error('删除文件夹失败, 请重试')
    }
  }

  // ---------- 项目库资产 ----------

  function addProjectItems(items: ProjectAssetItem[]) {
    if (!items.length) return
    setProjectAssets(prev => ({ ...prev, items: [...items, ...prev.items] }))
  }

  function handleRenameProjectAsset(assetId: string, displayName: string) {
    const trimmed = displayName.trim().slice(0, 120)
    if (!trimmed) return
    setProjectAssets(prev => ({
      ...prev,
      items: prev.items.map(it => (it.id === assetId ? { ...it, name: trimmed } : it)),
    }))
  }

  function handleDeleteProjectAsset(assetId: string) {
    // 只删库记录, 画布上已有卡片不动
    setProjectAssets(prev => ({ ...prev, items: prev.items.filter(it => it.id !== assetId) }))
  }

  async function handleRenameGlobalAsset(assetId: string, displayName: string) {
    const trimmed = displayName.trim().slice(0, 120)
    if (!trimmed) return
    try {
      const res = await fetch(`${ASSETS_API}/${assetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) throw new Error('rename asset failed')
      setAssets(prev => prev.map(a => (a.id === assetId ? { ...a, name: trimmed } : a)))
    } catch {
      toast.error('重命名失败, 请重试')
    }
  }

  async function handleDeleteGlobalAsset(assetId: string) {
    try {
      const res = await fetch(`${ASSETS_API}/${assetId}`, { method: 'DELETE', headers: { ...getAuthHeaders() } })
      if (!res.ok) throw new Error('delete asset failed')
      setAssets(prev => prev.filter(a => a.id !== assetId))
    } catch {
      toast.error('删除失败, 请重试')
    }
  }

  /** 统一入库: 项目库直接写画布数据; 全局库写账号资产 */
  async function persistMediaToLibrary(input: {
    scope: 'global' | 'project'
    url: string
    isVideo: boolean
    displayName: string
    folderId?: string
    groupMembers?: ProjectAssetMember[]
  }): Promise<boolean> {
    const kind: ProjectAssetKind = input.groupMembers ? 'group' : input.isVideo ? 'video' : 'image'
    if (input.scope === 'project') {
      if (input.groupMembers) {
        const item: ProjectAssetItem = {
          id: uid(),
          name: input.displayName,
          kind: 'group',
          url: input.groupMembers[0]?.url ?? input.url,
          folderId: input.folderId || undefined,
          createdAt: Date.now(),
          images: input.groupMembers,
        }
        addProjectItems([item])
      } else {
        const item: ProjectAssetItem = {
          id: uid(),
          name: input.displayName,
          kind,
          url: input.url,
          folderId: input.folderId || undefined,
          createdAt: Date.now(),
        }
        addProjectItems([item])
      }
      return true
    }
    if (!getLocalAccount()) { setAuthDialog('login'); return false }
    const rec = await createAssetRecord({
      name: input.displayName,
      url: input.url,
      source: 'canvas',
      mediaType: kind,
      folder: input.folderId ?? '',
      images: input.groupMembers,
    })
    if (rec) {
      setAssets(prev => [rec, ...prev])
      return true
    }
    toast.error('保存到资产库失败, 请重试')
    return false
  }

  /** 拖入面板: 按 cardId 取最新卡片主图(生成节点取当前 active 结果) */
  async function handleDropCardsToLibrary(cardIds: string[], scope: 'global' | 'project', folderId: string) {
    if (!cardIds.length) return
    const medias: Array<{ url: string; isVideo: boolean; displayName: string }> = []
    let skipped = 0
    cardIds.forEach(id => {
      const card = cardsRef.current.find(c => c.id === id)
      const media = cardMediaOf(card)
      if (!card || !media || !media.url) {
        skipped += 1
        return
      }
      const label = (card.prompt || card.title || (media.isVideo ? '生成视频' : '生成图片')).slice(0, 120)
      medias.push({ url: media.url, isVideo: media.isVideo, displayName: label || (media.isVideo ? '生成视频' : '生成图片') })
    })
    if (!medias.length) {
      toast.error('选中的节点没有可保存的图片或视频')
      return
    }
    // 永久链接转存: 已有永久链接直接引用; 临时链接抓取后重传, 保证随项目包导出可重新上传
    const ensured = await Promise.all(
      medias.map(async m => {
        const permanent = await persistRemoteImage(m.url, m.isVideo ? 'video' : 'image').catch(() => m.url)
        return { ...m, url: permanent || m.url }
      }),
    )
    let groupMembers: ProjectAssetMember[] | undefined
    let targetUrl = ensured[0].url
    let displayName = ensured[0].displayName
    if (ensured.length > 1) {
      groupMembers = ensured.map(m => ({ url: m.url, name: m.displayName }))
      targetUrl = groupMembers[0].url
      displayName = `图片组 · ${groupMembers.length} 张`
    }
    const ok = await persistMediaToLibrary({ scope, url: targetUrl, isVideo: ensured[0].isVideo, displayName, folderId, groupMembers })
    if (ok) {
      toast.success(ensured.length > 1 ? `已把 ${ensured.length} 张图保存为图片组` : '已保存到资产库')
      if (skipped) toast.message(`已跳过 ${skipped} 个没有图片的节点`)
    }
  }

  /** 头部按钮: 保存当前选中节点为资产 */
  async function handleSaveSelectedToLibrary(scope: 'global' | 'project', folderId: string) {
    if (!selectedIdsRef.current.length) {
      toast.error('请先在画布上选择带图片的节点')
      return
    }
    await handleDropCardsToLibrary([...selectedIdsRef.current], scope, folderId)
  }

  // ---------- 工作流资产 ----------

  /** 工作流保存前的选中校验结果(供头部按钮禁用/文案) */
  const workflowSelectionState = useMemo<{ ok: boolean; reason: string }>(() => {
    const sel = selectedIds.map(id => cards.find(c => c.id === id)).filter((c): c is CanvasCardData => !!c)
    if (!sel.length) return { ok: false, reason: '先在画布上选中要保存的节点' }
    const hasGen = sel.some(c => c.kind === 'generate')
    if (sel.length < 2 || !hasGen) return { ok: false, reason: '请选中至少一个生成节点和它的输入节点' }
    // 入选集合里除生成节点外还需有输入来源(连线输入卡 / 提示词文本 / 直接挂载的参考图)
    const trial = buildWorkflowSelection(sel, connections)
    const hasInput =
      !!trial &&
      trial.cards.some(
        c =>
          c.kind !== 'generate' ||
          !!(c.prompt && c.prompt.trim()) ||
          !!c.url ||
          (c.refUrls?.length ?? 0) > 0,
      )
    if (!hasInput) return { ok: false, reason: '请选中至少一个生成节点和它的输入节点' }
    return { ok: true, reason: '把选中的节点链路存为可复用工作流' }
  }, [selectedIds, cards, connections])

  /** 默认工作流名称(追加当天日期, 同名多次保存可区分) */
  function defaultWorkflowName(): string {
    const d = new Date()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `工作流 · ${mm}${dd}`
  }

  /** 头部按钮: 保存当前选中节点为工作流 */
  async function handleSaveSelectedToWorkflow(scope: 'global' | 'project', folderId: string): Promise<boolean> {
    const sel = cardsRef.current.filter(c => selectedIdsRef.current.includes(c.id))
    const selection = buildWorkflowSelection(sel, connectionsRef.current)
    if (!selection || selection.cards.length < 2) {
      toast.error('请选中至少一个生成节点和它的输入节点')
      return false
    }
    if (selection.skippedUnrelated > 0) {
      toast.message(`已跳过 ${selection.skippedUnrelated} 个无关节点`)
    }
    let doc = serializeWorkflow(selection.cards, connectionsRef.current)

    // 直接挂载的参考图(含 layer/rep 等专用节点状态内的上传图): 临时链接先转永久再存(失败保留原链接)
    const mediaUrls = collectWorkflowMediaUrls(doc)
    if (mediaUrls.length) {
      const ensured = new Map<string, string>()
      await Promise.all(
        mediaUrls.map(async u => {
          const permanent = await persistRemoteImage(
            u,
            /\.(mp4|webm|mov|m4v)(\?|$)/i.test(u) ? 'video' : 'image',
          ).catch(() => u)
          if (permanent) ensured.set(u, permanent)
        }),
      )
      doc = replaceWorkflowUrlsDeep(doc, ensured)
    }

    const cover = workflowCoverOf(doc)
    const displayName = defaultWorkflowName()

    if (scope === 'project') {
      const item: ProjectAssetItem = {
        id: uid(),
        name: displayName,
        kind: 'workflow',
        url: cover,
        coverUrl: cover,
        folderId: folderId || undefined,
        createdAt: Date.now(),
        workflow: doc,
      }
      addProjectItems([item])
      toast.success('已保存为工作流')
      return true
    }

    if (!getLocalAccount()) {
      setAuthDialog('login')
      return false
    }
    const rec = await createAssetRecord({
      name: displayName,
      url: cover,
      source: 'workflow',
      mediaType: 'workflow',
      folder: folderId ?? '',
      images: { workflow: doc },
    })
    if (rec) {
      setAssets(prev => [rec, ...prev])
      toast.success('已保存为工作流')
      return true
    }
    toast.error('保存工作流失败, 请重试')
    return false
  }

  /** 工作流拖回画布: 以松手坐标为包围盒左上角重建全部节点与连线(全新 id), 未运行态 */
  async function spawnWorkflowOnCanvas(payload: NonNullable<ReturnType<typeof parseAssetDnd>>, clientX: number, clientY: number) {
    if (!payload.workflow) return
    const pos = clientToCanvas(clientX, clientY)
    const rebuilt = rebuildWorkflow(payload.workflow, pos.x, pos.y)
    // 重建后的摄影机按当前画布重新分配字母名(避免与画布已有摄影机重名), 同步绑定快照名
    renameRebuiltCameras(
      rebuilt.cards,
      cardsRef.current.filter(c => c.kind === 'camera').map(c => c.title ?? ''),
    )
    setCards(prev => [...prev, ...rebuilt.cards])
    setConnections(prev => [...prev, ...rebuilt.connections])
    setSelectedIds(rebuilt.cards.map(c => c.id))

    // 参考图探活: URL 为空或图片加载失败 → 该输入位留空; 全部探测完统一轻提示一次
    if (rebuilt.probeRefs.length) {
      let deadSlots = 0
      await Promise.all(
        rebuilt.probeRefs.map(async ref => {
          const okList = await Promise.all(
            ref.urls.map(u => (u ? probeImageAccessible(mediaSrc(u) ?? u) : Promise.resolve(false))),
          )
          const primaryUrl = ref.primary ? ref.urls[0] : ''
          const primaryOk = ref.primary ? okList[0] : true
          const restUrls = ref.primary ? ref.urls.slice(1) : ref.urls
          const restOk = ref.primary ? okList.slice(1) : okList
          const liveRefs = restUrls.filter((_, i) => restOk[i])
          if (ref.primary && !primaryOk) deadSlots += 1
          restOk.forEach(ok => {
            if (!ok) deadSlots += 1
          })
          if (ref.kind === 'generate') {
            // url 是图片位参考(主图位), refUrls 是缩略图条
            updateCard(
              ref.cardId,
              ref.primary ? { url: primaryOk ? primaryUrl : '', refUrls: liveRefs } : { refUrls: liveRefs },
            )
          } else if ((ref.kind === 'result' || ref.kind === 'video') && ref.primary && !primaryOk) {
            // 失效的结果来源卡清空媒体, 卡片仍保留在链路里(用户可手动换图)
            updateCard(ref.cardId, { url: '', jobStatus: undefined })
          }
        }),
      )
      if (deadSlots > 0) toast.message('部分参考图已失效, 已留空')
    }

    // 内置预设落到画布后的使用引导(预设本身不带参考图), 按节点类型给文案
    if (payload.preset) {
      const hasMotion = payload.workflow.nodes.some(n => n.kind === 'motion')
      const hasVsr = payload.workflow.nodes.some(n => n.kind === 'vsr')
      const hasTts = payload.workflow.nodes.some(n => n.kind === 'tts')
      const isWan22 = payload.workflow.nodes.some(n => n.genParams?.model === 'wan-2.2-i2v-ai-app')
      const isWan22Hq = payload.workflow.nodes.some(n => n.genParams?.model === 'wan-2.2-i2v-hq-ai-app')
      toast.message(
        hasMotion
          ? '已添加动作迁移节点, 上传人物照片和动作视频后即可运行'
          : hasVsr
            ? '已添加视频修复节点, 上传视频后即可运行'
            : hasTts
              ? '已添加语音克隆节点, 上传声音和文本后即可运行'
              : isWan22Hq
                ? '已添加 WAN 2.2 高质量节点, 挂一张参考图后即可运行'
                : isWan22
                  ? '已添加 WAN 2.2 节点, 挂一张参考图后即可运行'
                  : '已添加预设工作流, 补充素材后即可运行',
      )
    }
  }

  /** 资产拖回画布: 在松手落点建卡; 图片组错落展开多张并自动同组 */
  function spawnAssetOnCanvas(rawPayload: string, clientX: number, clientY: number) {
    const payload = parseAssetDnd(rawPayload)
    if (!payload) return
    if (payload.kind === 'workflow') {
      void spawnWorkflowOnCanvas(payload, clientX, clientY)
      return
    }
    const pos = clientToCanvas(clientX, clientY)
    const isGroup = payload.kind === 'group' && payload.members.length > 1
    if (isGroup) {
      const gid = uid()
      const newCards: CanvasCardData[] = payload.members.slice(0, 12).map((m, idx) => ({
        id: uid(),
        kind: 'result' as CardKind,
        x: pos.x + (idx % 4) * 42 - 60,
        y: pos.y + Math.floor(idx / 4) * 42 + (idx % 2) * 24 - 40,
        w: 300,
        h: 330,
        url: m.url,
        prompt: m.name || payload.name,
        jobStatus: 'success' as CardJobStatus,
        groupId: gid,
        groupName: (payload.name || '图片组').slice(0, 60),
      }))
      setCards(prev => [...prev, ...newCards])
      setSelectedIds(newCards.map(c => c.id))
      return
    }
    const isVideo = payload.kind === 'video'
    const newCard: CanvasCardData = {
      id: uid(),
      kind: isVideo ? 'video' : 'result',
      x: pos.x - 150,
      y: pos.y - 165,
      w: isVideo ? 360 : 300,
      h: isVideo ? 380 : 330,
      url: payload.url,
      prompt: payload.name,
      jobStatus: 'success',
    }
    setCards(prev => [...prev, newCard])
    setSelectedIds([newCard.id])
  }

  /** 画布舞台 drop 事件入口(外部文件拖入仍走原上传逻辑) */
  function handleStageAssetDrop(e: React.DragEvent, clientX: number, clientY: number): boolean {
    const dt = e.dataTransfer
    if (!dt) return false
    const types = Array.from(dt.types || [])
    if (types.includes(ASSET_DND_ENTRY)) {
      const raw = dt.getData(ASSET_DND_ENTRY)
      if (raw) {
        spawnAssetOnCanvas(raw, clientX, clientY)
        return true
      }
    }
    if (types.includes(ASSET_DND_CARD)) return true
    return false
  }

  // ---------- @ 引用弹窗: 全局 / 本项目范围 ----------

  function applyPickedEntry(entry: AssetLibEntry) {
    if (!assetPickerFor) return
    const { cardId, slot } = assetPickerFor
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card) {
      setAssetPickerFor(null)
      return
    }
    if (entry.kind === 'group') {
      if (slot === 'node') {
        const first = entry.members[0]?.url ?? entry.coverUrl
        updateCard(cardId, { url: first })
        const curModel = card.genParams?.model ?? I2I_MODELS[0]
        refreshModelPrice(curModel, [first], card.genParams)
        toast.message('已把图片组首图设为节点图片')
      } else {
        const urls = entry.members.map(m => m.url).filter(Boolean)
        const refs = card.refUrls ?? []
        const merged = [...refs, ...urls].filter((u, i, arr) => arr.indexOf(u) === i && u !== card.url)
        if (merged.length >= 9) toast.message('最多添加 9 张参考图, 已取前 9 张')
        updateCard(cardId, { refUrls: merged.slice(0, 9) })
      }
    } else if (slot === 'node') {
      updateCard(cardId, { url: entry.coverUrl })
      const curModel = card.genParams?.model ?? I2I_MODELS[0]
      refreshModelPrice(curModel, [entry.coverUrl], card.genParams)
    } else {
      const refs = card.refUrls ?? []
      if (refs.includes(entry.coverUrl) || card.url === entry.coverUrl) toast.info('该素材已在当前节点上')
      else if (refs.length + (card.url ? 1 : 0) >= 9) toast.error('最多添加 9 张参考图')
      else updateCard(cardId, { refUrls: [...refs, entry.coverUrl] })
    }
    setAssetPickerFor(null)
  }

  /** 弹窗/面板共用的统一资产条目(按范围派生) */
  const globalAssetEntries = useMemo(() => assets.map(globalEntryOf), [assets])
  const projectAssetEntries = useMemo(() => projectAssets.items.map(projectEntryOf), [projectAssets.items])
  const pickerEntries = useMemo(
    // @ 选参考图弹窗只选图片/视频; 工作流条目仅可从面板拖回画布
    () =>
      (pickerScope === 'global' ? globalAssetEntries : projectAssetEntries).filter(e => isImageAssetKind(e.kind)),
    [pickerScope, globalAssetEntries, projectAssetEntries],
  )
  /** 当前选中里是否存在带图节点(头部保存按钮可用性) */
  const selectedHasMedia = useMemo(
    () => selectedIds.some(id => !!cardMediaOf(cards.find(c => c.id === id))),
    [cards, selectedIds],
  )

  // ---------- 图片分层节点 ----------

  async function handleLayerUpload(cardId: string, slot: 'source' | 'marker', file: File | null) {
    if (!file) return
    if (!isSupportedCanvasImageFile(file)) {
      toast.error(isImageFile(file) ? unsupportedImageToast([{ name: file.name }]) : '请选择图片文件')
      return
    }
    try {
      const dataUrl = await fileToDataUrl(file)
      const url = await persistMedia(file, 'image').catch(upErr => {
        if ((upErr as { status?: number }).status === 412) throw Object.assign(new Error('login_required'), { status: 412 })
        return ''
      })
      if (!url) throw new Error('upload failed')
      cacheDataUrl(`${cardId}:${slot}:${url}`, dataUrl)
      if (slot === 'source') patchLayerState(cardId, { sourceUrl: url, layers: [], stage: 'idle' })
      else patchLayerState(cardId, { markerUrl: url })
    } catch {
      toast.error('图片上传失败, 请重试')
    }
  }

  async function resolveNodeDataUrl(cardId: string, slot: string, url: string | null): Promise<string | null> {
    // 键含 url: 槽位换图(上传改投 / 上游换接)不复用旧缓存
    const key = `${cardId}:${slot}:${url}`
    const cached = readDataUrl(key)
    if (cached) return cached
    if (!url) return null
    const fetched = await urlToDataUrl(url)
    if (fetched) cacheDataUrl(key, fetched)
    return fetched
  }

  function handleAnalyzeLayers(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const ls = card?.layerState
    const source = effectiveLayerSource(cardId)
    if (!ls || !source) {
      toast.error('请上传原图, 或连接上游图片节点')
      return
    }
    costConfirm.runWithCostConfirm(async () => {
      patchLayerState(cardId, { stage: 'analyzing' })
      try {
        const sourceDataUrl = await resolveNodeDataUrl(cardId, 'source', source)
        const markerDataUrl = ls.markerUrl ? await resolveNodeDataUrl(cardId, 'marker', ls.markerUrl) : null
        if (!sourceDataUrl) throw new Error('原图读取失败, 请重新上传')
        const parts: LlmContentPart[] = [{ type: 'image_url', image_url: { url: sourceDataUrl } }]
        if (markerDataUrl) parts.push({ type: 'image_url', image_url: { url: markerDataUrl } })
        parts.push({
          type: 'text',
          text: `分析这张图中可以拆分成独立图层的元素${markerDataUrl ? '(第二张图是标注了图层位置的示意图, 以它为准)' : ''}。每个图层输出: {"name": "图层简短中文名", "description": "该图层的内容与风格描述, 用于后续图像生成"}。只输出 JSON 数组, 不要任何其他文字。`,
        })
        const messages: LlmMessage[] = [
          { role: 'system', content: '你是图片分层助手, 擅长把一张图拆解成可独立生成的图层清单。严格输出 JSON。' },
          { role: 'user', content: parts },
        ]
        const res = await runLlmGuarded(ls.visionModel, { messages, page: 'canvas' })
        if (res.needsLogin) setNeedsRhLogin(true)
        if (!res.ok || !res.text) throw new Error(llmErrorText(res))
        const arr = parseLooseJsonArray(res.text)
        if (!arr || !arr.length) throw new Error('没有识别出图层结构, 请重试或用示意图标注')
        patchLayerState(cardId, {
          stage: 'ready',
          layers: arr.map(item => ({
            id: uid(),
            name: String(item.name ?? '未命名图层'),
            desc: String(item.description ?? item.desc ?? ''),
            enabled: true,
            genStatus: 'idle' as const,
            genUrl: null,
            cutoutUrl: null,
            errorMsg: null,
          })),
        })
      } catch (err) {
        patchLayerState(cardId, { stage: 'idle' })
        toast.error(err instanceof Error ? err.message : '分析失败, 请重试')
      }
    }, '图层分析按 token 计费')
  }

  function handleRenameLayer(cardId: string, layerId: string, value: string) {
    updateLayerFor(cardId, layerId, { name: value })
  }

  function handleToggleLayer(cardId: string, layerId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const layer = card?.layerState?.layers.find(l => l.id === layerId)
    if (!layer) return
    updateLayerFor(cardId, layerId, { enabled: !layer.enabled })
  }

  function handleDeleteLayer(cardId: string, layerId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card?.layerState) return
    patchLayerState(cardId, { layers: card.layerState.layers.filter(l => l.id !== layerId) })
  }

  function layerPriceNote(count: number, genModel: string): string {
    const i2 = channelFamilyOf(genModel)?.i2 ?? resolveRunModel(genModel, true)
    // 分层/复刻出图均带参考图(图生图口径), 用合约默认参数(GPT Image 2 默认 2k/medium)计价, 与真实扣费一致
    const info = getNodeModelInfo(i2)
    const defRes = info?.scalar_params?.find(p => p.name === 'resolution')?.default
    const defQ = info?.scalar_params?.find(p => p.name === 'quality')?.default
    const params: GenNodeParams = { model: i2, count: 1 }
    if (defRes !== undefined && defRes !== null) params.resolution = String(defRes)
    if (defQ !== undefined && defQ !== null) params.quality = String(defQ)
    const total = userRunPrice(i2, count, params)
    return total !== null ? `共 ${count} 张 · ¥${total.toFixed(2)}` : `共 ${count} 张 · 按实际扣费`
  }

  async function runLayerGenFor(cardId: string, layer: LayerItem, genModel: string, sourceUrl: string | null, sessionToken: number) {
    const signal = beginJobSignal()
    const layerStartedAt = Date.now()
    const promptText = `只画出参考图中的「${layer.name}」(${layer.desc || '画面中的一个元素'}), 作为单独对象居中放在纯白色背景上, 保持参考图原有的风格、光影和细节, 画面中不要出现任何其他元素、文字或背景装饰。`
    try {
      const info = await ensureModelInfo(genModel)
      updateLayerFor(cardId, layer.id, { genStatus: 'running', errorMsg: null })
      const res = await runAigcGuarded(
        resolveRunModel(genModel, true),
        await bodyWithRhUrls(buildBodyWithDefaults(info, promptText, sourceUrl ? [sourceUrl] : [])),
        { pollIntervalMs: POLL_INTERVAL_MS, deadlineMs: POLL_TIMEOUT_MS, signal },
      )
      if (!aliveForSession(sessionToken) || (res.status === 'failed' && res.errorKind === 'aborted')) return
      if (res.status === 'success') {
        const url = res.url || res.outputs?.[0]?.url || ''
        updateLayerFor(cardId, layer.id, { genStatus: 'success', genUrl: url })
        appendGenLog({
          status: 'success',
          platform: 'RunningHub',
          nodeType: '分层',
          model: logModelLabel(genModel),
          prompt: promptText,
          refs: sourceUrl ? [sourceUrl] : [],
          outputs: url ? [{ url, kind: 'image' }] : [],
          runMs: Date.now() - layerStartedAt,
          taskId: res.taskId,
          costText: stdCostText(res),
          request: sanitizeLogBody(buildBodyWithDefaults(info, promptText, sourceUrl ? [sourceUrl] : [])),
        })
        if (url) {
          const cut = await cutoutWhiteBackground(url)
          if (cut && aliveForSession(sessionToken)) updateLayerFor(cardId, layer.id, { cutoutUrl: cut })
          // 分层结果图后台转存永久链接, 完成后静默替换, 避免次日裂图
          void persistRemoteImage(url).then(permanent => {
            if (permanent && permanent !== url && aliveForSession(sessionToken)) {
              const cur = cardsRef.current.find(c => c.id === cardId)?.layerState?.layers.find(l => l.id === layer.id)
              if (cur && cur.genUrl === url) updateLayerFor(cardId, layer.id, { genUrl: permanent })
            }
          })
        }
      } else {
        if (res.needsLogin || res.errorKind === 'login_required') setNeedsRhLogin(true)
        const layerError = formatAigcFailureMessage(res)
        updateLayerFor(cardId, layer.id, { genStatus: 'failed', errorMsg: layerError })
        appendGenLog({
          status: 'failed',
          platform: 'RunningHub',
          nodeType: '分层',
          model: logModelLabel(genModel),
          prompt: promptText,
          refs: sourceUrl ? [sourceUrl] : [],
          outputs: [],
          runMs: Date.now() - layerStartedAt,
          taskId: res.taskId,
          error: layerError,
          request: sanitizeLogBody(buildBodyWithDefaults(info, promptText, sourceUrl ? [sourceUrl] : [])),
        })
      }
    } catch (err) {
      // 换链/同步异常: 单个图层标失败, 不让整批 runPool 连带卡死
      if (!aliveForSession(sessionToken)) return
      const status = (err as { status?: number })?.status
      if (status === 412 || status === 401 || status === 403) setNeedsRhLogin(true)
      const layerError = '生成失败, 请重试'
      updateLayerFor(cardId, layer.id, { genStatus: 'failed', errorMsg: layerError })
      appendGenLog({
        status: 'failed',
        platform: 'RunningHub',
        nodeType: '分层',
        model: logModelLabel(genModel),
        prompt: promptText,
        refs: sourceUrl ? [sourceUrl] : [],
        outputs: [],
        runMs: Date.now() - layerStartedAt,
        error: layerError,
      })
    } finally {
      endJobSignal(signal)
    }
  }

  function handleGenerateLayers(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const ls = card?.layerState
    if (!ls) return
    const targets = ls.layers.filter(l => l.enabled)
    if (!targets.length) {
      toast.error('请至少保留一个启用的图层')
      return
    }
    const source = effectiveLayerSource(cardId)
    if (!source) {
      toast.error('请上传原图, 或连接上游图片节点')
      return
    }
    const genModel = ls.genModel
    const lockKey = `layers:${cardId}`
    costConfirm.runWithCostConfirm(async () => {
      if (!acquireRunLock(lockKey)) return
      try {
        await runGenerateLayers(cardId, targets, genModel, source)
      } finally {
        releaseRunLock(lockKey)
      }
    }, layerPriceNote(targets.length, genModel))
  }

  async function runGenerateLayers(
    cardId: string,
    targets: LayerItem[],
    genModel: string,
    source: string,
  ) {
    const sessionToken = sessionTokenRef.current
    patchLayerState(cardId, { stage: 'generating' })
    patchLayerState(cardId, {
      layers: (cardsRef.current.find(c => c.id === cardId)?.layerState?.layers ?? []).map(l =>
        l.enabled ? { ...l, genStatus: 'queued' as const, errorMsg: null } : l,
      ),
    })
    try {
      await runPool(targets, 8, layer => runLayerGenFor(cardId, layer, genModel, source, sessionToken))
    } finally {
      // 无论单图是否抛错, 分层节点都要退出 generating, 否则永久转圈
      if (aliveForSession(sessionToken)) patchLayerState(cardId, { stage: 'ready' })
    }
  }

  function handleRetryLayer(cardId: string, layerId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const layer = card?.layerState?.layers.find(l => l.id === layerId)
    const source = effectiveLayerSource(cardId)
    if (!card || !layer || !source || !card.layerState) return
    const genModel = card.layerState.genModel
    const lockKey = `layer-retry:${cardId}:${layerId}`
    costConfirm.runWithCostConfirm(async () => {
      // 同步占锁: 失败层小钮连点只跑一次
      if (!acquireRunLock(lockKey)) return
      try {
        await runLayerGenFor(cardId, layer, genModel, source, sessionTokenRef.current)
      } finally {
        releaseRunLock(lockKey)
      }
    }, layerPriceNote(1, genModel))
  }

  function handleDownloadLayer(layer: LayerItem) {
    if (layer.cutoutUrl) downloadDataUrl(layer.cutoutUrl, `${layer.name || '图层'}.png`)
    else if (layer.genUrl) void downloadAigcResult(layer.genUrl)
  }

  function handleDownloadAllLayers(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const done = (card?.layerState?.layers ?? []).filter(l => l.genStatus === 'success')
    if (!done.length) {
      toast.error('还没有生成成功的图层')
      return
    }
    done.forEach((l, i) => setTimeout(() => handleDownloadLayer(l), i * 400))
  }

  // ---------- 图片复刻节点(折页) ----------

  /** 切换折页类型: 折面数量随之变化(三折 3 / 二折 2), 已有文案尽量保留 */
  function handleRepSetFoldType(cardId: string, foldType: FoldType) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const rs = card?.repState
    if (!rs || rs.foldType === foldType) return
    const n = foldPanelCount(foldType)
    const resize = (arr: string[]) => Array.from({ length: n }, (_, i) => arr[i] ?? '')
    patchRepState(cardId, {
      foldType,
      frontPanels: resize(rs.frontPanels),
      backPanels: resize(rs.backPanels),
      panelPrompts: { front: resize(rs.panelPrompts.front), back: resize(rs.panelPrompts.back) },
    })
  }

  async function handleRepUpload(cardId: string, slot: 'front' | 'back' | 'logo' | 'qr', file: File | null) {
    if (!file) return
    if (!isSupportedCanvasImageFile(file)) {
      toast.error(isImageFile(file) ? unsupportedImageToast([{ name: file.name }]) : '请选择图片文件')
      return
    }
    try {
      const dataUrl = await fileToDataUrl(file)
      const url = await persistMedia(file, 'image').catch(upErr => {
        if ((upErr as { status?: number }).status === 412) throw Object.assign(new Error('login_required'), { status: 412 })
        return ''
      })
      if (!url) throw new Error('upload failed')
      if (slot === 'front' || slot === 'back') cacheDataUrl(`${cardId}:${slot}:${url}`, dataUrl)
      if (slot === 'front') patchRepState(cardId, { frontUrl: url })
      else if (slot === 'back') patchRepState(cardId, { backUrl: url })
      else if (slot === 'logo') patchRepState(cardId, { logoUrl: url })
      else patchRepState(cardId, { qrUrl: url })
    } catch {
      toast.error('图片上传失败, 请重试')
    }
  }

  function handleRepPanelsChange(cardId: string, side: 'front' | 'back', arr: string[]) {
    if (side === 'front') patchRepState(cardId, { frontPanels: arr })
    else patchRepState(cardId, { backPanels: arr })
  }

  /** 四个图片槽位之间换位: 按每格「当前实际显示的来源」交换——
   *  本地上传改上传字段, 连线(含无槽通用线)改 toSlot 归属, 空格参与时把来源挪过去。 */
  function handleRepReorderSlots(cardId: string, fromSlot: RepSlot, toSlot: RepSlot) {
    if (fromSlot === toSlot) return
    const rs = cardsRef.current.find(c => c.id === cardId)?.repState
    if (!rs) return
    const sources = resolveRepSlotSources(cardId)
    const a = sources[fromSlot]
    const b = sources[toSlot]
    // 背面可能是借用正面的同一来源, 视为同一张: 只把它挪到目标格, 背面回到空(自动兜底)
    const same = a && b && a.kind === b.kind && ((a.kind === 'upload' && b.kind === 'upload' && a.url === b.url) || (a.kind === 'conn' && b.kind === 'conn' && a.connId === b.connId))
    const movedTo = same ? a : b
    const movedFrom = a

    const urlPatch: Record<RepSlot, string | null> = {
      front: rs.frontUrl ?? null,
      back: rs.backUrl ?? null,
      logo: rs.logoUrl ?? null,
      qr: rs.qrUrl ?? null,
    }
    // 两槽原本的上传字段先清掉, 再按交换后的来源落位; 连线来源不写上传字段(由 toSlot 归属决定)
    if (urlPatch[fromSlot] && movedFrom?.kind === 'upload') urlPatch[fromSlot] = null
    if (urlPatch[toSlot] && movedTo?.kind === 'upload') urlPatch[toSlot] = null
    if (movedFrom?.kind === 'upload') urlPatch[toSlot] = movedFrom.url
    if (!same && movedTo?.kind === 'upload') urlPatch[fromSlot] = movedTo.url
    patchRepState(cardId, { frontUrl: urlPatch.front, backUrl: urlPatch.back, logoUrl: urlPatch.logo, qrUrl: urlPatch.qr })

    setConnections(prev =>
      prev.map(conn => {
        if (conn.toId !== cardId) return conn
        // 同一条线同时占据两格(背面借用): 只把线绑到目标格
        if (same && movedFrom?.kind === 'conn' && conn.id === movedFrom.connId) {
          return { ...conn, toSlot: toSlot }
        }
        if (movedFrom?.kind === 'conn' && conn.id === movedFrom.connId) return { ...conn, toSlot: toSlot }
        if (!same && movedTo?.kind === 'conn' && conn.id === movedTo.connId) return { ...conn, toSlot: fromSlot }
        return conn
      }),
    )
  }

  /** 清空某个图片槽位(只移除本槽连线; 上传图通过重新上传覆盖) */
  function handleRepDisconnectSlot(cardId: string, slot: RepSlot) {
    setConnections(prev => prev.filter(c => !(c.toId === cardId && c.toSlot === slot)))
  }

  function handleRepSetPrompt(cardId: string, side: 'front' | 'back', value: string) {
    if (side === 'front') patchRepState(cardId, { frontPrompt: value })
    else patchRepState(cardId, { backPrompt: value })
  }

  function handleAnalyzeReplicate(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const rs = card?.repState
    const { front, back } = effectiveRepUrls(cardId)
    if (!rs || !front || !back) {
      toast.error('请上传至少一张参考图, 或连接上游图片节点')
      return
    }
    costConfirm.runWithCostConfirm(() => runReplicateAnalysis(cardId), '分析含参考图识别与整体编译, 共多次大模型调用, 按 token 计费')
  }

  /**
   * 线路一(两阶段):
   * A. 视觉模型分别读正/背参考图, 产出纯文字的设计规律报告(背面复用正面图时只跑一次);
   * B. 整合模型(默认千问 3.8 Max)拿报告 + 六折面文案 + 素材说明, 一次编译出正反两条完整生图提示词。
   */
  async function runReplicateAnalysis(cardId: string) {
    const token = sessionTokenRef.current
    const card = cardsRef.current.find(c => c.id === cardId)
    const rs = card?.repState
    if (!rs) return
    const { front, back } = effectiveRepUrls(cardId)
    if (!front || !back) return
    patchRepState(cardId, { stage: 'analyzing' })
    try {
    const foldType = rs.foldType ?? 'tri'
    const triFold = rs.triFold ?? 'wrap'

    // 阶段 A: 参考图 → 设计规律文字报告
    const frontDataUrl = await resolveNodeDataUrl(cardId, 'front', front)
    if (!frontDataUrl) {
      patchRepState(cardId, { stage: 'idle' })
      toast.error('参考图读取失败, 请重新上传')
      return
    }
    const sharedBack = back === front
    const backDataUrl = sharedBack ? null : await resolveNodeDataUrl(cardId, 'back', back)
    if (!sharedBack && !backDataUrl) {
      patchRepState(cardId, { stage: 'idle' })
      toast.error('背面参考图读取失败, 请重新上传')
      return
    }
    const mkVisionMessages = (dataUrl: string, sideLabel: string): LlmMessage[] => [
      { role: 'system', content: '你是资深商业平面设计分析师,擅长从折页设计稿中提炼可迁移的版式、色彩与视觉规律。只输出分析报告本身,不要寒暄。' },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: buildRepVisionPrompt(foldSpecText(foldType, triFold), sideLabel) },
        ],
      },
    ]
    const visionTasks: Promise<LlmCallResult>[] = [
      runLlmGuarded(REP_VISION_MODEL, { messages: mkVisionMessages(frontDataUrl, '正面'), page: 'canvas' }),
    ]
    if (!sharedBack && backDataUrl) {
      visionTasks.push(runLlmGuarded(REP_VISION_MODEL, { messages: mkVisionMessages(backDataUrl, '背面'), page: 'canvas' }))
    }
    const visionResults = await Promise.all(visionTasks)
    const fVision = visionResults[0]
    const bVision = sharedBack ? fVision : visionResults[1]
    if (fVision.needsLogin || bVision.needsLogin) setNeedsRhLogin(true)
    if (!fVision.ok || !fVision.text) {
      patchRepState(cardId, { stage: 'idle' })
      toast.error(`正面参考图分析失败: ${llmErrorText(fVision)}`)
      return
    }
    if (!sharedBack && (!bVision.ok || !bVision.text)) {
      patchRepState(cardId, { stage: 'idle' })
      toast.error(`背面参考图分析失败: ${llmErrorText(bVision)}`)
      return
    }

    // 阶段 B: 设计规律 + 文案 + 素材 → 整合模型编译正反两条生图提示词
    const analyzeModel = rs.analyzeModel || 'qwen3.8-max'
    const latest = cardsRef.current.find(c => c.id === cardId)?.repState ?? rs
    const latestSlots = effectiveRepSlots(cardId)
    const directorRes = await runLlmGuarded(analyzeModel, {
      messages: [
        { role: 'system', content: REP_DIRECTOR_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildRepDirectorUserText({
            foldType,
            triFold,
            frontAnalysis: fVision.text,
            backAnalysis: bVision.text ?? fVision.text,
            frontPanels: latest.frontPanels,
            backPanels: latest.backPanels,
            hasLogo: !!latestSlots.logo,
            hasQr: !!latestSlots.qr,
          }),
        },
      ],
      page: 'canvas',
    })
    if (directorRes.needsLogin) setNeedsRhLogin(true)
    if (!directorRes.ok || !directorRes.text) {
      patchRepState(cardId, { stage: 'idle' })
      toast.error(`整合编译失败: ${llmErrorText(directorRes)}`)
      return
    }
    const parsed = parseRepDirectorOutput(directorRes.text)
    if (!parsed || (!parsed.front && !parsed.back)) {
      patchRepState(cardId, { stage: 'idle' })
      toast.error('整合结果无法识别, 请重试')
      return
    }
    const n = foldPanelCount(foldType)
    patchRepState(cardId, {
      stage: 'ready',
      frontPrompt: parsed.front,
      backPrompt: parsed.back,
      panelPrompts: { front: Array.from({ length: n }, () => ''), back: Array.from({ length: n }, () => '') },
    })
    if (!parsed.back) toast.message('反面提示词缺失, 可再分析一次')
    } catch (err) {
      // 读图/请求的同步异常不能让复刻卡永久停在「分析中」
      if (!aliveForSession(token)) return
      const status = (err as { status?: number })?.status
      if (status === 412 || status === 401 || status === 403) setNeedsRhLogin(true)
      patchRepState(cardId, { stage: 'idle' })
      toast.error('分析失败, 请重试')
    }
  }

  /** 六个折面文案框各自的润色: 固定走豆包 Seed 2.0 Lite, 只润色该格用户输入的文案 */
  function handlePolishRepPanel(cardId: string, side: 'front' | 'back', idx: number) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const rs = card?.repState
    if (!rs) return
    const panels = side === 'front' ? rs.frontPanels : rs.backPanels
    const current = (panels[idx] ?? '').trim()
    if (!current) {
      toast.error('先填写这一格的折面内容, 再点润色')
      return
    }
    const foldType = rs.foldType ?? 'tri'
    const triFold = rs.triFold ?? 'wrap'
    const role = foldPanelRoles(foldType, triFold, side)[idx] ?? `折面${idx + 1}`
    const key = `${cardId}:${side}-panel-${idx}`
    costConfirm.runWithCostConfirm(async () => {
      setPolishingField(key)
      try {
        const res = await runLlmGuarded(REP_PANEL_POLISH_MODEL, {
          messages: [
            {
              role: 'user',
              content: `你是商业画册文案编辑。下面是用户为三折页「${role}」折面撰写的原始文案,请在不改变原意的前提下润色:让表达更专业、更有商业感染力、层次更清晰;公司/品牌名称、产品名称、人名、电话、网址、地址、数字、数据、资质、二维码说明等锁定信息必须原样保留,不得改写、翻译或编造;只输出润色后的文案本身,不要解释、不要加引号、不要分点标签。\n原始文案:\n${current}`,
            },
          ],
          page: 'canvas',
        })
        if (res.needsLogin) setNeedsRhLogin(true)
        if (!res.ok || !res.text) {
          toast.error(llmErrorText(res))
          return
        }
        const polished = res.text.trim()
        const cur = cardsRef.current.find(c => c.id === cardId)?.repState
        const src = side === 'front' ? cur?.frontPanels ?? panels : cur?.backPanels ?? panels
        handleRepPanelsChange(cardId, side, src.map((v, i) => (i === idx ? polished : v)))
        toast.success('润色完成')
      } finally {
        setPolishingField(null)
      }
    }, '折面文案润色按 token 计费')
  }

  function handleRunPolishNode(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card) return
    const source = card.sourceCardId ? cardsRef.current.find(c => c.id === card.sourceCardId) : undefined
    // 用户在本润色节点输入框里实际填写/改写的指令优先; 框为空时才回退到源生成节点的描述
    const current = ((card.prompt ?? '').trim() || (source?.prompt ?? '').trim())
    // 图片输入: 下游生成节点图 + 上游连线图, 去重后取 4 张; 有图即可看图反推描述
    const images = Array.from(new Set([...(source?.url ? [source.url] : []), ...upstreamImageUrls(cardId)])).slice(0, 4)
    if (!current && images.length === 0) {
      toast.error('先在生成节点里写提示词, 或连接一张图片来反推')
      return
    }
    const lockKey = `polish:${cardId}`
    // LLM 付费调用走计费确认包裹; 锁同步占在第一个 await 之前, 防双击重复烧额度
    costConfirm.runWithCostConfirm(async () => {
      if (!acquireRunLock(lockKey)) return
      try {
        await runPolishNode(cardId, current, images)
      } finally {
        releaseRunLock(lockKey)
      }
    }, '提示词润色调用大模型按 token 计费, 以实际扣费为准')
  }

  async function runPolishNode(cardId: string, current: string, images: string[]) {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card) return
    const base = { ...defaultPolishState(), ...card.polishState }
    // 带图任务必须视觉模型: 当前是纯文本模型时自动切换
    const model = images.length && !VISION_LLM_OPTIONS.some(o => o.slug === base.model) ? VISION_LLM_OPTIONS[0].slug : base.model
    const state = { ...base, model, jobStatus: 'running' as const, errorMsg: null }
    updateCard(cardId, { prompt: current, polishState: state })
    try {
      const rhImages = await toRhMediaUrls(images)
      const userContent: LlmMessage['content'] = rhImages.length
        ? [
            ...rhImages.map(url => ({ type: 'image_url' as const, image_url: { url } })),
            {
              type: 'text',
              text: current
                ? `附图是供参考的画面素材(共 ${rhImages.length} 张)。请严格按照下面用户的【任务指令】处理这些参考图, 不要默认逐张反推或复述图片; 输出一条可直接用于生图的中文提示词, 围绕指令指定的侧重点(如风格、影调、光影、色调、氛围、构图等)把画面描述到位。只输出提示词本身, 不要解释、不要分点、不要加引号。\n【任务指令】${current}`
                : '请综合反推这' + rhImages.length + '张参考图的生图提示词: 描述主体、环境、光线、构图和风格, 输出一条可直接用于生图的完整提示词, 不要附加解释。',
            },
          ]
        : `请润色下面的生图提示词, 保持原意, 补充主体、环境、光线和构图细节, 只输出润色后的提示词:\n${current}`
      const res = await runLlmGuarded(state.model, {
        messages: [{ role: 'user', content: userContent }],
        page: 'canvas',
      })
      if (res.needsLogin) setNeedsRhLogin(true)
      if (!res.ok || !res.text) {
        updateCard(cardId, { polishState: { ...state, jobStatus: 'failed', errorMsg: llmErrorText(res) } })
        return
      }
      const polished = res.text.trim()
      updateCard(cardId, { prompt: polished, polishState: { ...state, jobStatus: 'success', result: polished } })
      const src = card.sourceCardId ? cardsRef.current.find(c => c.id === card.sourceCardId) : undefined
      if (src) updateCard(src.id, { prompt: polished })
      toast.success('提示词润色完成')
    } catch {
      updateCard(cardId, { polishState: { ...state, jobStatus: 'failed', errorMsg: '润色失败, 请稍后重试' } })
    }
  }

  /**
   * 生成节点内联润色: 直接接收本节点参考图(图位/参考图/上游连线) + 已输入提示词,
   * 看图反推分析后把优化后的提示词回填到本节点输入框, 不再新建独立润色节点。
   * - 有图 + 无提示词: 看图反推
   * - 有图 + 有提示词: 结合图 + 原意优化
   * - 纯文本: 纯文本润色(qwen)
   */
  function handleInlinePolishGenerate(cardId: string) {
    if (polishingGenId) return
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card || card.kind !== 'generate') return
    const current = (card.prompt ?? '').trim()
    // 只取已持久化的可访问链接; 仍在上传的 blob: 本地预览不发给模型
    const images = effectiveRefUrls(card)
      .filter(u => /^https?:\/\//i.test(u) || u.startsWith('/api/files/'))
      .slice(0, 4)
    if (!current && images.length === 0) {
      toast.error('先写一句提示词, 或放入/连入一张参考图')
      return
    }
    const lockKey = `inline-polish:${cardId}`
    // LLM 付费调用走计费确认; action 内同步占锁(早于第一个 await), polishingGenId 仅做按钮态
    costConfirm.runWithCostConfirm(async () => {
      if (!acquireRunLock(lockKey)) return
      setPolishingGenId(cardId)
      try {
        const model = images.length ? VISION_LLM_OPTIONS[0].slug : POLISH_LLM_OPTIONS.find(o => o.slug === 'qwen3.8-max')?.slug ?? VISION_LLM_OPTIONS[0].slug
        let rhImages: string[] = []
        if (images.length) {
          try {
            rhImages = (await toRhMediaUrls(images)).filter(Boolean)
          } catch {
            rhImages = images
          }
        }
        const userContent: LlmMessage['content'] = rhImages.length
          ? [
              ...rhImages.map(url => ({ type: 'image_url' as const, image_url: { url } })),
              {
                type: 'text',
                text: current
                  ? `附图是供参考的画面素材(共 ${rhImages.length} 张)。请严格按照下面用户给出的【任务指令】来处理这些参考图, 不要默认去逐张反推或复述图片内容; 最终输出一条可直接用于生图/生视频的中文提示词, 内容必须围绕用户指令的侧重点(例如只分析风格、影调、光影、色调、氛围、构图等指定维度), 并据此把画面描述到位。只输出提示词本身, 不要解释、不要分点、不要加引号。\n【任务指令】${current}`
                  : '请综合反推这' + rhImages.length + '张参考图, 输出一条可直接用于生图的高质量中文提示词: 描述画面主体、环境、光线、构图、材质与整体风格。只输出提示词本身, 不要解释、不要分点、不要加引号。',
              },
            ]
          : `请润色下面的生图提示词, 保持原意, 补充主体、环境、光线、构图、材质与风格细节, 使其更专业、更具画面感, 只输出润色后的提示词, 不要解释:\n${current}`
        const res = await runLlmGuarded(model, {
          messages: [{ role: 'user', content: userContent }],
          page: 'canvas',
        })
        if (res.needsLogin) setNeedsRhLogin(true)
        if (!res.ok || !res.text) {
          toast.error(llmErrorText(res))
          return
        }
        const polished = res.text.trim().replace(/^[「"'“]+|[」"'”]+$/g, '')
        if (!polished) {
          toast.error('润色失败, 请稍后重试')
          return
        }
        updateCard(cardId, { prompt: polished })
        toast.success(images.length && !current ? '已看图反推并回填' : '提示词已优化')
      } catch {
        toast.error('润色失败, 请稍后重试')
      } finally {
        setPolishingGenId(null)
        releaseRunLock(lockKey)
      }
    }, '提示词润色调用大模型按 token 计费, 以实际扣费为准')
  }

  // ---------- 本地助手：一键导入剪映 ----------

  // 定时探测本机助手是否运行（顺带拿剪映/Adobe 状态）。
  // 自适应: 已连接保持 5s 短轮询以及时反映软件开关; 未连接时退避到 20s,
  // 页面切到后台时暂停, 回到前台立即探一次 —— 助手没开时不再高频打本机端口。
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    // 助手从未连接变为已连接时提示一次(含打开页面时已在运行), 告知打开对应软件再点导出
    let wasOnline = false
    let announced = false
    const check = async () => {
      if (alive && document.hidden) {
        schedule(20000)
        return
      }
      const h = await detectAssistant()
      if (!alive) return
      setAssistant(h)
      if (h.ok && !wasOnline) {
        wasOnline = true
        if (!announced) {
          announced = true
          toast.success('本地助手已连接, 请打开对应软件(剪映 / Photoshop / Illustrator), 再点卡片上的导出按钮')
        }
      } else if (!h.ok) {
        wasOnline = false
      }
      schedule(h.ok ? 5000 : 20000)
    }
    function schedule(delay: number) {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void check() }, delay)
    }
    const onFocus = () => { if (alive && !document.hidden) void check() }
    const onVisible = () => { if (alive && !document.hidden) void check() }
    void check()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  /** 收集一组卡片可导出的成品 URL（主看结果项，其次节点主图），去重 */
  function collectExportItems(cardIds: string[]): Array<{ url: string; name?: string; isVideo?: boolean }> {
    const items: Array<{ url: string; name?: string; isVideo?: boolean }> = []
    cardIds.forEach(id => {
      const c = cardsRef.current.find(x => x.id === id)
      if (!c) return
      const okResults = (Array.isArray(c.results) ? c.results : [])
        .filter(r => r.itemStatus === 'success' && r.url)
        .map((r, index) => ({
          url: r.url as string,
          name: r.title || `${c.title || c.prompt || '生成图片'}-${index + 1}`,
          isVideo: r.isVideo === true,
        }))
      if (okResults.length) items.push(...okResults)
      else if (c.url) items.push({ url: c.url, name: c.title || c.prompt || '生成图片', isVideo: c.kind === 'video' })
    })
    // 助手要按 URL 下载到本机, 只保留 http(s) 链接并去重;
    // 站内 /api/files/ 永久链接先转成绝对地址(同源含 __pb 前缀), 否则会被下面的过滤丢掉
    const seen = new Set<string>()
    return items
      .map(item => (/^https?:\/\//i.test(item.url) ? item : { ...item, url: mediaSrc(item.url) ?? item.url }))
      .filter(item => {
        if (!/^https?:\/\//i.test(item.url) || seen.has(item.url)) return false
        seen.add(item.url)
        return true
      })
  }

  /** 兼容现有剪映入口: 返回可下载的去重 URL。 */
  function collectExportUrls(cardIds: string[]): string[] {
    return collectExportItems(cardIds).map(item => item.url)
  }

  /** 把选中卡片的成品一键导入剪映（经本地助手） */
  async function handleImportSelectionToJianying(cardIds: string[]) {
    if (jianyingImporting) return
    const urls = collectExportUrls(cardIds)
    if (urls.length === 0) {
      toast.error('选中的节点还没有可导出的图片或视频')
      return
    }
    if (!assistant.ok || !assistant.port) {
      toast.error('未检测到本地助手：请先在电脑上启动「Dangoo 本地助手」并保持运行')
      return
    }
    if (assistant.jianying && assistant.jianying.platform_supported && assistant.jianying.running === false) {
      toast.error('请先打开剪映专业版并进入一个工程，再点导入')
      return
    }
    setJianyingImporting(true)
    try {
      const res = await importToJianying(assistant.port, urls.map(url => ({ url })))
      if (res.ok) {
        const n = res.imported?.length ?? urls.length
        toast.success(`已把 ${n} 个素材导入剪映`)
        if (res.failed && res.failed.length) toast(`其中 ${res.failed.length} 个素材未导入`)
      } else {
        toast.error(assistantErrorText(res.code, res.message))
      }
    } catch {
      toast.error('连接本地助手失败：请确认助手正在运行')
    } finally {
      setJianyingImporting(false)
      // 刷新一次助手状态（剪映可能刚被打开等）
      setAssistant(await detectAssistant())
    }
  }

  /** 把选中卡片的图片导入 Photoshop / Illustrator。 */
  async function handleImportSelectionToAdobe(cardIds: string[], application: AdobeApplication) {
    if (jianyingImporting || adobeImporting) return
    const items = collectExportItems(cardIds).filter(item => !item.isVideo)
    if (items.length === 0) {
      toast.error('选中的节点还没有可导出的 PNG/JPG 图片')
      return
    }
    if (!assistant.ok || !assistant.port) {
      toast.error('未检测到本地助手：请先在电脑上启动「Dangoo 本地助手」并保持运行')
      return
    }
    const adobe = application === 'photoshop' ? assistant.photoshop : assistant.illustrator
    if (adobe && adobe.platform_supported === false) {
      toast.error('Adobe 导入目前仅支持 Windows')
      return
    }
    if (adobe && adobe.running === false) {
      toast.error(`请先打开${application === 'photoshop' ? 'Photoshop' : 'Illustrator'}`)
      return
    }
    if (adobe && adobe.has_document === false) {
      toast.error(`请先在${application === 'photoshop' ? 'Photoshop' : 'Illustrator'}中打开文档或画板`)
      return
    }
    setAdobeImporting(application)
    try {
      const res = await importToAdobe(assistant.port, application, items)
      if (res.ok) {
        const n = res.imported?.length ?? items.length
        toast.success(`已把 ${n} 张图片导入${application === 'photoshop' ? ' Photoshop' : ' Illustrator'}`)
      } else if (res.code === 'partial_failure' && res.imported?.length) {
        toast.success(`已导入 ${res.imported.length} 张图片，${res.failed?.length ?? 0} 张失败`)
      } else {
        toast.error(assistantErrorText(res.code, res.message))
      }
      if (res.failed?.length) toast(`其中 ${res.failed.length} 张图片未导入`)
    } catch (err) {
      // PNA/浏览器拦截或助手版本过旧: GET 探测能通但 POST 发不出去, 给出可操作的提示而不是静默
      const msg = err instanceof Error ? String(err.message || '') : ''
      if (/failed to fetch|networkerror|load failed|network error/i.test(msg)) {
        toast.error('浏览器拦截了对本地助手的导出请求: 请把助手升级到最新版(重新下载), 并确认已打开目标软件后再点导出')
      } else {
        toast.error('连接本地助手失败：请确认助手正在运行, 且已打开目标软件(Photoshop / Illustrator)')
      }
    } finally {
      setAdobeImporting(null)
      setAssistant(await detectAssistant())
    }
  }

  // ---------- Agent 节点 ----------

  /** 直连上游的文本(Agent 输出 / 提示词节点 / 生成节点描述) */
  function upstreamTexts(cardId: string): string[] {
    const fromIds = connectionsRef.current.filter(c => c.toId === cardId).map(c => c.fromId)
    const texts: string[] = []
    fromIds.forEach(fid => {
      const up = cardsRef.current.find(c => c.id === fid)
      if (!up) return
      const t = up.kind === 'agent' ? (up.agentState?.output || up.prompt || '') : (up.prompt ?? '')
      if (t.trim()) texts.push(t.trim())
    })
    return texts
  }

  function handleUpdateAgentState(cardId: string, patch: Partial<AgentNodeState>) {
    const cur = cardsRef.current.find(c => c.id === cardId)?.agentState ?? defaultAgentState()
    updateCard(cardId, { agentState: { ...cur, ...patch } })
  }

  function parseAgentTableRows(text: string): Array<{ id?: string; cells?: Record<string, unknown> }> {
    const raw = text.replace(/```json|```/g, '').trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return []
    try {
      const obj = JSON.parse(raw.slice(start, end + 1)) as { rows?: Array<{ id?: string; cells?: Record<string, unknown> }> }
      return Array.isArray(obj.rows) ? obj.rows : []
    } catch {
      return []
    }
  }

  function handleRunAgentNode(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    if (!card) return
    const st0 = { ...defaultAgentState(), ...card.agentState }
    const requirement = (card.prompt ?? '').trim()
    const upTexts0 = upstreamTexts(cardId)
    if (!requirement && upTexts0.length === 0) {
      toast.error('先写需求文本, 或连接上游文本 / Agent 节点')
      return
    }
    const lockKey = `agent:${cardId}`
    // LLM 付费调用: 必须走计费确认包裹(审计固定写法); 锁在 action 第一行同步占, 防双击
    costConfirm.runWithCostConfirm(async () => {
      if (!acquireRunLock(lockKey)) return
      try {
        const curCard = cardsRef.current.find(c => c.id === cardId)
        if (!curCard) return
        const st = { ...defaultAgentState(), ...curCard.agentState }
        const upTexts = upstreamTexts(cardId)
        const req = (curCard.prompt ?? '').trim()
        const vision = VISION_LLM_OPTIONS.some(o => o.slug === st.model)
        const images = vision ? upstreamImageUrls(cardId).slice(0, 12) : []
        const lines: string[] = []
        if (upTexts.length) lines.push(`【上游文本】\n${upTexts.join('\n---\n')}`)
        if (req) lines.push(`【本次需求】\n${req}`)
        if (images.length) lines.push(`(已附 ${images.length} 张参考图, 结合图片理解任务)`)
        if (st.tableMode) {
          lines.push(
            `当前表格列: ${st.tableColumns.map(c => `${c.id}=${c.name}`).join(', ')}; 需要 AI 填写的列: ${st.generationColumnIds.join(', ')}。\n现有行数据: ${JSON.stringify(st.tableRows)}\n按行补全 AI 列内容, 只输出 JSON: {"rows":[{"id":"行id","cells":{"列id":"内容"}}]}`,
          )
        } else {
          lines.push('完成任务并直接输出结果文本, 不要附加解释。')
        }
        const rhImages = await toRhMediaUrls(images)
        const messages: LlmMessage[] = []
        if (st.systemPrompt.trim()) messages.push({ role: 'system', content: st.systemPrompt.trim() })
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: lines.join('\n\n') },
            ...rhImages.map(url => ({ type: 'image_url' as const, image_url: { url } })),
          ],
        })
        updateCard(cardId, { agentState: { ...st, jobStatus: 'running', errorMsg: null } })
        const res = await runLlmGuarded(st.model, { messages, page: 'canvas' })
        if (res.needsLogin) setNeedsRhLogin(true)
        const cur = cardsRef.current.find(c => c.id === cardId)?.agentState ?? st
        if (!res.ok || !res.text) {
          updateCard(cardId, { agentState: { ...cur, jobStatus: 'failed', errorMsg: llmErrorText(res) } })
          return
        }
        if (!st.tableMode) {
          const out = res.text.trim()
          const output = st.mode === 'append' && cur.output.trim() ? `${cur.output}\n${out}` : out
          updateCard(cardId, { agentState: { ...cur, output, jobStatus: 'success', errorMsg: null } })
        } else {
          const rows = parseAgentTableRows(res.text)
          if (!rows.length) {
            updateCard(cardId, { agentState: { ...cur, jobStatus: 'failed', errorMsg: '未能识别表格结果, 请重试或切换文本模式' } })
            return
          }
          const merged = cur.tableRows.map(r => ({ ...r, cells: { ...r.cells } }))
          rows.forEach(rr => {
            const cells: Record<string, string> = {}
            Object.entries(rr.cells ?? {}).forEach(([k, v]) => {
              if (cur.tableColumns.some(c => c.id === k)) cells[k] = String(v ?? '')
            })
            const exist = rr.id ? merged.find(m => m.id === rr.id) : undefined
            if (exist) Object.assign(exist.cells, cells)
            else merged.push({ id: rr.id || uid(), cells })
          })
          updateCard(cardId, { agentState: { ...cur, tableRows: merged, jobStatus: 'success', errorMsg: null } })
        }
      } catch {
        const latest = cardsRef.current.find(c => c.id === cardId)?.agentState ?? st0
        updateCard(cardId, { agentState: { ...latest, jobStatus: 'failed', errorMsg: '运行失败, 请稍后重试' } })
      } finally {
        releaseRunLock(lockKey)
      }
    }, '智能体调用大模型按 token 计费, 以实际扣费为准')
  }

  // ---------- Loop 节点 ----------

  /** 上游 Agent 输出拆成批量任务: 表格一行一任务; 文本按编号/换行拆分 */
  function loopTasks(cardId: string): Array<{ prompt: string; rowDriven: boolean }> {
    const fromIds = connectionsRef.current.filter(c => c.toId === cardId).map(c => c.fromId)
    const tasks: Array<{ prompt: string; rowDriven: boolean }> = []
    fromIds.forEach(fid => {
      const up = cardsRef.current.find(c => c.id === fid)
      if (!up || up.kind !== 'agent' || !up.agentState) return
      const st = up.agentState
      if (st.tableMode) {
        st.tableRows.forEach(row => {
          if (row.enabled === false) return
          const lines = st.tableColumns
            .map(col => ({ name: col.name, value: (row.cells[col.id] ?? '').trim() }))
            .filter(v => v.value)
          if (lines.length) tasks.push({ prompt: lines.map(v => `${v.name}: ${v.value}`).join('\n'), rowDriven: true })
        })
      } else {
        const text = (st.output || up.prompt || '').trim()
        if (!text) return
        text
          .split(/\n+/)
          .map(t => t.replace(/^\s*\d+\s*[.、)）]\s*/, '').trim())
          .filter(Boolean)
          .forEach(pt => tasks.push({ prompt: pt, rowDriven: false }))
      }
    })
    return tasks
  }

  /** Loop 共享参考图: 自身与上游 Agent 的参考图去重合并, 最多 9 张透传给每个任务 */
  function loopSharedRefs(cardId: string): string[] {
    const set = new Set<string>()
    upstreamImageUrls(cardId).forEach(u => set.add(u))
    connectionsRef.current
      .filter(c => c.toId === cardId)
      .forEach(c => {
        const up = cardsRef.current.find(x => x.id === c.fromId)
        if (up?.kind === 'agent') upstreamImageUrls(up.id).forEach(u => set.add(u))
      })
    return [...set].slice(0, 9)
  }

  function handleUpdateLoopState(cardId: string, patch: Partial<LoopNodeState>) {
    const cur = cardsRef.current.find(c => c.id === cardId)?.loopState ?? defaultLoopState()
    updateCard(cardId, { loopState: { ...cur, ...patch } })
  }

  const DEFAULT_MODEL_OF_KIND: Record<ModelKind, string> = {
    t2i: T2I_MODELS[0],
    i2i: I2I_MODELS[0],
    t2v: T2V_MODELS[0],
    i2v: I2V_MODELS[0],
  }

  async function handleRunLoop(cardId: string) {
    const loop = cardsRef.current.find(c => c.id === cardId)
    if (!loop) return
    const st = { ...defaultLoopState(), ...loop.loopState }
    const allTasks = loopTasks(cardId)
    if (!allTasks.length) {
      toast.error('上游 Agent 还没有可执行的任务, 先产出表格行或文本')
      return
    }
    if (allTasks.length > 20) toast.info('单次上限 20 条, 已只执行前 20 条')
    const tasks = allTasks.slice(0, 20)
    const refs = loopSharedRefs(cardId)
    const video = st.media === 'video'
    const desired: ModelKind = video ? (refs.length ? 'i2v' : 't2v') : refs.length ? 'i2i' : 't2i'
    // 下拉存的是渠道家族 key: 同媒体类型就用用户选的家族(按有无参考图解析文生/图生), 否则回退该类型默认家族
    const famMedia = channelFamilyOf(st.model)?.media
    const familyKey = famMedia === (video ? 'video' : 'image') ? st.model : DEFAULT_MODEL_OF_KIND[desired]
    const model = resolveRunModel(familyKey, refs.length > 0)
    const params: GenNodeParams = {
      model,
      count: 1,
      resolution: st.resolution,
      aspectRatio: st.aspectRatio,
      videoDuration: st.videoDuration,
      videoRatio: st.videoRatio,
    }
    const priceNote = priceNoteForJobs([{ model, count: tasks.length, params, hasImg: refs.length > 0 }])
    const lockKey = `loop:${cardId}`
    costConfirm.runWithCostConfirm(async () => {
      // 同步占锁, 早于第一个 await(ensureModelInfo); finally 释放, 失败可立即重跑
      if (!acquireRunLock(lockKey)) return
      try {
        const info = await ensureModelInfo(model)
        const newCards: CanvasCardData[] = []
        const specs: JobSpec[] = []
        const loopAppSlug = aiAppSlugOf(model)
        tasks.forEach((t, i) => {
          // AI 应用渠道: 平铺字段 body + 首帧(提交前上传换 fileName); 标准渠道走 openapi body
          const body = loopAppSlug
            ? { text: t.prompt, node51_value: String(AI_APP_LONG_EDGE_DEFAULT), [AI_APP_FIRST_FRAME_KEY]: refs[0] ?? '' }
            : buildNodeRunBody(params, t.prompt, refs, info)
          const col = i % 3
          const rowIdx = Math.floor(i / 3)
          // 图片结果继承局部选区上下文(循环节点上游卡链; 视频结果不设)
          const loopInheritedContext = video
            ? null
            : inheritCropContext([
                loop,
                ...connectionsRef.current
                  .filter(conn => conn.toId === cardId)
                  .map(conn => cardsRef.current.find(c => c.id === conn.fromId))
                  .filter((c): c is CanvasCardData => !!c),
              ])
          const out: CanvasCardData = {
            id: uid(),
            kind: video ? 'video' : 'result',
            x: loop.x + loop.w + 60 + col * 300,
            y: loop.y + rowIdx * 350,
            w: video ? 300 : 260,
            h: video ? 330 : 310,
            prompt: t.prompt,
            refUrls: refs,
            model,
            runBody: body,
            jobStatus: 'queued',
            sourceCardId: cardId,
            loopSourceId: cardId,
            loopRoundIndex: 0,
            loopSlotIndex: i,
            ...(video ? {} : { cropContext: loopInheritedContext }),
          }
          newCards.push(out)
          specs.push({
            resultCardId: out.id,
            model,
            body,
            promptText: t.prompt,
            sourceCardId: cardId,
            ...(loopAppSlug ? { aiAppFirstFrame: refs[0] ?? '' } : {}),
            refs: refs.slice(),
            nodeType: 'Loop',
          })
        })
        setCards(prev => [...prev, ...newCards])
        setConnections(prev => [...prev, ...newCards.map(rc => ({ id: uid(), fromId: cardId, toId: rc.id }))])
        updateCard(cardId, { loopState: { ...st, model } })
        setPendingJobs(prev => [
          ...prev,
          ...specs.map(s => ({ cardId: s.resultCardId, model: s.model, promptText: s.promptText, submittedAt: Date.now() })),
        ])
        setRunningCount(n => n + specs.length)
        // 单批最多 9 并发, 超出自动排队分批
        await runPool(specs, Math.min(LOOP_BATCH_SIZE, specs.length), spec => runJob(spec))
      } finally {
        releaseRunLock(lockKey)
      }
    }, priceNote)
  }

  function handleRunReplicate(cardId: string) {
    const card = cardsRef.current.find(c => c.id === cardId)
    const rs = card?.repState
    if (!rs) return
    const { front, back } = effectiveRepUrls(cardId)
    if (!front || !back) {
      toast.error('请上传至少一张参考图, 或连接上游图片节点')
      return
    }
    if (!rs.frontPrompt.trim() || !rs.backPrompt.trim()) {
      toast.error('请先分析或填写正反面提示词')
      return
    }
    costConfirm.runWithCostConfirm(() => runReplicateGeneration(cardId), layerPriceNote(2, rs.genModel))
  }

  async function runReplicateGeneration(cardId: string) {
    const token = sessionTokenRef.current
    const card = cardsRef.current.find(c => c.id === cardId)
    const rs = card?.repState
    if (!rs) return
    const { front, back } = effectiveRepUrls(cardId)
    if (!front || !back) return
    patchRepState(cardId, { stage: 'generating', jobStatus: { front: 'running', back: 'running' } })
    // 正反两面各自独立收尾: 任一面换链/同步异常不影响另一面出图, finally 统一保证节点退出 generating
    const failedResult = (msg: string): AigcResult => ({ status: 'failed', errorKind: 'submit', error: msg })
    const applyImageParamsLocal = (body: Record<string, unknown>, resVal: string | null, arVal: string | null) => {
      if (resVal !== null) body.resolution = resVal
      if (arVal !== null) body.aspectRatio = arVal
      return body
    }
    const repStartedAt = Date.now()
    const repRefs: Record<'front' | 'back', string[]> = { front: [], back: [] }
    const repBodies: Record<'front' | 'back', Record<string, unknown> | undefined> = { front: undefined, back: undefined }
    try {
      // Logo / 二维码同样支持连线槽位, 取槽位有效图
      const slotUrls = effectiveRepSlots(cardId)
      const mkRefs = (base: string) =>
        [base, slotUrls.logo, slotUrls.qr].filter((v): v is string => !!v && v !== base)
      repRefs.front = mkRefs(front)
      repRefs.back = mkRefs(back)
      const runSideLogged = async (side: 'front' | 'back', prompt: string, refs: string[]) => {
        const signal = beginJobSignal()
        try {
          // genModel 存家族主键, 提交时按「有参考图」解析成图生 slug
          const runModel = resolveRunModel(rs.genModel, true)
          const info = await ensureModelInfo(runModel)
          const resVal = pickParamValue(info, 'resolution', rs.resolution ?? '1k')
          const arVal = aspectRatioForBody(info, rs.aspectRatio ?? 'adaptive')
          const body = applyImageParamsLocal(buildBodyWithDefaults(info, prompt, refs), resVal, arVal)
          repBodies[side] = body
          return await runAigcGuarded(runModel, await bodyWithRhUrls(body), {
            pollIntervalMs: POLL_INTERVAL_MS,
            deadlineMs: POLL_TIMEOUT_MS,
            signal,
          })
        } catch (err) {
          const status = (err as { status?: number })?.status
          if (status === 412 || status === 401 || status === 403) setNeedsRhLogin(true)
          return failedResult(status === 412 || status === 401 || status === 403 ? '登录已过期, 请重新登录后重试' : '提交失败, 请重试')
        } finally {
          endJobSignal(signal)
        }
      }
      const outcomes = await Promise.allSettled([
        runSideLogged('front', rs.frontPrompt, repRefs.front),
        runSideLogged('back', rs.backPrompt, repRefs.back),
      ])
      if (!aliveForSession(token)) return
      const fRes = outcomes[0].status === 'fulfilled' && outcomes[0].value ? outcomes[0].value : failedResult('提交失败, 请重试')
      const bRes = outcomes[1].status === 'fulfilled' && outcomes[1].value ? outcomes[1].value : failedResult('提交失败, 请重试')
      applyRepResult(cardId, 'front', fRes, token)
      applyRepResult(cardId, 'back', bRes, token)
      // 正/背面并发, 各自一条日志; 两条都成功时补批量统计
      const repResults: Array<{ side: 'front' | 'back'; res: AigcResult; refs: string[]; prompt: string; body: Record<string, unknown> | undefined }> = [
        { side: 'front', res: fRes, refs: repRefs.front, prompt: rs.frontPrompt, body: repBodies.front },
        { side: 'back', res: bRes, refs: repRefs.back, prompt: rs.backPrompt, body: repBodies.back },
      ]
      const okCount = repResults.filter(r => r.res.status === 'success').length
      const failCount = repResults.length - okCount
      repResults.forEach(r => {
        const sideLabel = r.side === 'front' ? '正面' : '背面'
        const url = r.res.status === 'success' ? r.res.url || r.res.outputs?.[0]?.url || '' : ''
        appendGenLog({
          status: r.res.status === 'success' ? 'success' : 'failed',
          platform: 'RunningHub',
          nodeType: '复刻',
          model: `${logModelLabel(rs.genModel)} · ${sideLabel}`,
          prompt: r.prompt,
          refs: r.refs,
          outputs: url ? [{ url, kind: 'image' }] : [],
          runMs: Date.now() - repStartedAt,
          taskId: r.res.taskId,
          costText: stdCostText(r.res),
          error: r.res.status === 'success' ? undefined : formatAigcFailureMessage(r.res),
          request: sanitizeLogBody(r.body),
          batchSummary: okCount + failCount === 2 ? `成功 ${okCount} · 失败 ${failCount}` : undefined,
        })
      })
    } finally {
      if (aliveForSession(token)) patchRepState(cardId, { stage: 'done' })
    }
  }

  function applyRepResult(cardId: string, side: 'front' | 'back', res: AigcResult, sessionToken?: number) {
    const sideLabel = side === 'front' ? '正面' : '背面'
    const card = cardsRef.current.find(c => c.id === cardId)
    const rs = card?.repState
    const baseJob = rs?.jobStatus ?? { front: 'idle' as const, back: 'idle' as const }
    if (res.status === 'success') {
      const url = res.url || res.outputs?.[0]?.url || ''
      if (side === 'front') patchRepState(cardId, { frontResultUrl: url, jobStatus: { ...baseJob, front: 'success' } })
      else patchRepState(cardId, { backResultUrl: url, jobStatus: { ...baseJob, back: 'success' } })
      if (url) {
        const pos = card ? { x: card.x + card.w + 48, y: card.y + (side === 'front' ? 0 : 340) } : centerSpawnPos()
        const resultCard: CanvasCardData = {
          id: uid(),
          kind: 'result',
          x: pos.x,
          y: pos.y,
          w: 300,
          h: 330,
          url,
          prompt: `${FOLD_TYPE_LABELS[rs?.foldType ?? 'tri']}复刻 · ${sideLabel}`,
          model: rs?.genModel,
          jobStatus: 'success',
          taskId: res.taskId,
          sourceCardId: cardId,
        }
        // 跨画布闸门: 复刻卡已不在当前画布(切走了)就绝不追加成品卡, 杜绝写进别的画布
        setCards(prev => (prev.some(c => c.id === cardId) ? [...prev, resultCard] : prev))
        const resultId = resultCard.id
        const token = sessionToken
        void persistRemoteImage(url).then(permanent => {
          if (token !== undefined && !aliveForSession(token)) return
          if (permanent && permanent !== url) {
            setCards(prev => prev.map(c => (c.id === resultId && c.url === url ? { ...c, url: permanent } : c)))
          }
          if (getLocalAccount()) {
            void createAssetRecord({ name: `${FOLD_TYPE_LABELS[rs?.foldType ?? 'tri']}复刻 · ${sideLabel}`, url: permanent && permanent !== url ? permanent : url, source: 'result' }).then(rec => {
              if (rec && (token === undefined || aliveForSession(token))) setAssets(prev => [rec, ...prev])
            })
          }
        })
      }
    } else {
      if (res.needsLogin || res.errorKind === 'login_required') setNeedsRhLogin(true)
      if (side === 'front') patchRepState(cardId, { jobStatus: { ...baseJob, front: 'failed' } })
      else patchRepState(cardId, { jobStatus: { ...baseJob, back: 'failed' } })
      toast.error(`${sideLabel}生成失败: ${formatAigcFailureMessage(res)}`)
    }
  }

  // ---------- 派生数据 ----------

  // 下拉选项按「渠道家族」给: 同一模型文生/图生合并为一条; kind 用家族媒体类型。
  // 分层/复刻这类带参考图(图生)节点直接消费 priceText, 故图片家族展示「图生底价 + 创作者加价」后的访客实付单价。
  const modelOptions = useMemo(
    () =>
      // hidden 家族(WAN 2.2 等)不在任何渠道下拉里暴露, 改由工作流预设进入;
      // 已在画布上的旧节点与预设重建节点仍能正常显示名称/价格并运行
      CHANNEL_FAMILIES.filter(fam => !fam.hidden).map(fam => {
        const slugKey = fam.key
        const video = fam.media === 'video'
        let priceLabel: string
        if (video) {
          // 矩阵视频(每秒×时长)与 2.5 统一标「按时长计费」, 精确价在底行随参数显示;
          // 固定按次的 H3 直接显示一口价
          const flat = VIDEO_FLAT_USER_PRICE[fam.t2 ?? ''] ?? VIDEO_FLAT_USER_PRICE[fam.i2]
          if (typeof flat === 'number') priceLabel = `¥${flat.toFixed(2)} / 次`
          else priceLabel = '按时长计费'
        } else {
          // 图片: GPT Image 2 官方按画质/分辨率分档显示「¥最低价 起 / 张」; 其余显示固定单张价
          const t2Slug = fam.t2 ?? slugKey
          const tierMin = imageMinPrice(t2Slug)
          const up = tierMin ?? IMAGE_USER_PRICE[t2Slug] ?? T2I_PRICE_MAP[t2Slug]
          priceLabel = typeof up === 'number' ? `¥${up.toFixed(2)} 起 / 张` : '按实际扣费'
        }
        return { slug: slugKey, label: fam.label, kind: video ? 't2v' : 't2i', media: fam.media, priceText: priceLabel }
      }),
    [],
  )

  return {
    // 文档与顶栏
    docLoaded, canvasTitle, setCanvasTitle, saveState, prepareAgentTurn, syncAgentRevision, focusAgentNode,
    // 多标签保存冲突
    saveConflict, resolveConflictReload, resolveConflictOverwrite, flushPersistNow,
    // 崩溃本地恢复
    localRestore, acceptLocalRestore, discardLocalRestore, deferLocalRestore,
    // 冲突误选后取回本地版本
    conflictBackupAvailable, restoreConflictBackup, dismissConflictBackup,
    needsRhLogin, setNeedsRhLogin, account, setAccount,
    // 钱包 / 登录充值弹窗
    walletBalance, walletAdmin, refreshWallet,
    authDialog, setAuthDialog, openRecharge, handleAuthSuccess,
    // 画布与手势
    stageRef, contentRef, marqueeLayerRef, draftPathRef, geometryRef, probeRef, cards, viewport, selectedIds, focusConnections, setFocusConnections,
    /** 点画布外的功能区(顶栏/资产库)时取消节点选中 */
    clearSelection: () => setSelectedIds([]),
    batchSettingsReady, connectionDraft,
    pendingJobs,
    // 生成日志
    genLogs, logDialogOpen, setLogDialogOpen,
    // 图片批量高额二次确认
    batchConfirm, cancelBatchImageConfirm, confirmBatchImageRun, BATCH_IMAGE_CONFIRM_LIMIT,
    connections, editNodeId, handleToggleNodePanel, handleExpandNodePanel, upstreamImageUrls, effectiveLayerSource, effectiveRepUrls, effectiveRepSlots,
    handleDisconnect,
    onStagePointerDown, onStagePointerMove, onStagePointerUp, onStagePointerCancel, onCardPointerDown, startConnection, startResize,
    onStageDoubleClick, zoomBy, handleZoomReset, handleFrameContent, spacePanning,
    // 双击功能菜单
    addMenuPos,
    handleAddGenerateCardAt, handleAddLayerNodeAt, handleAddReplicateNodeAt, handleAddAgentCardAt, handleAddLoopCardAt, handleAddMergeCardAt,
    // 摄影机节点
    cameraConfigCardId, setCameraConfigCardId, openCameraConfig, handleAddCameraCardAt,
    applyCameraConfig, handleSetGenCamera, resolveCameraPrompt, cameraBindingOptions,
    updateTtsState, handleTtsUpload, handleRemoveTtsAudio, handleRunTts, handleDownloadTts,
    updateMotionState, handleMotionUpload, handleRemoveMotionMedia, handleRunMotion, handleDownloadMotion,
    updateVsrState, handleVsrUpload, handleRemoveVsrVideo, handleRunVsr, handleDownloadVsr,
    // 卡片操作
    handleUploadImageFiles,
    handleDeleteCards, handleDuplicateCard, handleDuplicateSelection, alignSelection, syncCardSize, updateCard, handleConvertToGenerate,
    handleRemoveRefFromCard,
    handlePreviewCard, handleDownloadCard, handleRetryCard,
    handleRetryNodeResult, handleSelectNodeResult, cardShowsVideo,
    healResultImageByTask,
    previewUrl, setPreviewUrl, previewMediaType, setPreviewMediaType,
    frameCaptureCardId, openFrameCapture, closeFrameCapture, addCapturedFramesToCanvas,
    // 图片编辑器: 裁剪 / 画笔标注 / 宫格切分 / 颜色图钉 / 提取选区
    editDialogId, editDialogMode, openImageEditor, closeImageEditor,
    setPinColor, applyImageEdit, handleExtractSelection,
    // 全局标签体系(取代旧六色图钉)
    tags: globalTags.tags, tagsLoading: globalTags.tagsLoading,
    createTag: globalTags.createTag, updateTag: globalTags.updateTag, deleteTag: globalTags.deleteTag,
    applyTagTemplate: globalTags.applyTemplate, getTagDef: globalTags.getTagDef,
    setCardTag, resolveCardTagSlug,
    tagManagerOpen, openTagManager, closeTagManager, tagManagerDraft,
    // 图像融合节点
    mergeInputs, handleRunMerge, setMergeColorMatch,
    // 生成节点参数与运行
    modelOptions, modelPrices, getNodeModelInfo, requestModelInfo,
    refreshModelPrice, effectiveRefUrls, resolveRunModel, priceTextForModel,
    channelFamilyMedia: (slug: string) => channelFamilyOf(slug)?.media ?? null,
    handleUpdateGenParams, handleUpdateSelectedGenParams, handleRunGenerateNode,
    handleSetNodeImage, handleClearNodeImage,
    selectedRunnableNodes, handleRunSelectedNodes,
    runningCount, isRunInflight, batchRunInflight,
    // 素材库
    assets, assetsLoading, assetsLoadingMore, assetsHasMore, assetsTotal, loadMoreGlobalAssets, assetUploading,
    handleUploadAsset, handleSaveCardToAssets,
    assetPickerFor, setAssetPickerFor, handleOpenAssetPicker,
    // 右侧资产库浮动面板
    assetPanelOpen, setAssetPanelOpen,
    globalFolders, foldersLoading,
    projectAssets,
    pickerScope, setPickerScope,
    pickerEntries, globalAssetEntries, projectAssetEntries, selectedHasMedia,
    handleCreateFolder, handleRenameFolder, handleDeleteFolder,
    handleRenameProjectAsset, handleDeleteProjectAsset, handleRenameGlobalAsset, handleDeleteGlobalAsset,
    handleDropCardsToLibrary, handleSaveSelectedToLibrary,
    handleSaveSelectedToWorkflow, workflowSelectionState,
    handleStageAssetDrop, applyPickedEntry,
    // 图片分层节点
    handleLayerUpload, handleAnalyzeLayers,
    handleRenameLayer, handleToggleLayer, handleDeleteLayer,
    handleGenerateLayers, handleRetryLayer, handleDownloadLayer, handleDownloadAllLayers,
    // 图片复刻节点
    handleRepUpload, handleRepSetFoldType, handleRepPanelsChange, handleRepSetPrompt,
    handleRepReorderSlots, handleRepDisconnectSlot,
    handleAnalyzeReplicate, handlePolishRepPanel, handleRunReplicate,
    handleRunPolishNode, handleRunAgentNode, handleUpdateAgentState,
    handleRunLoop, handleUpdateLoopState, loopTasks, loopSharedRefs,
    startGroupConnection, handleGroupSelection, handleUngroupSelection, handleRenameGroup, onGroupPointerDown,
    setGroupCollapsed, handleCollapseSelection,
    polishingField, polishingGenId, handleInlinePolishGenerate,
    // 本地助手 / 一键导入剪映 / Adobe
    assistant, jianyingImporting, adobeImporting, handleImportSelectionToJianying, handleImportSelectionToAdobe,
    // 计费确认
    ...costConfirm,
  }
}
