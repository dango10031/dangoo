import type { CropContext } from '@/components/canvas/imageEdit/localPatch'
import { I2I_MODELS, POLISH_LLM_OPTIONS, T2I_MODELS, VISION_LLM_OPTIONS } from './canvasModels'
import type { CameraConfig } from './cameraModel'

export type CardKind = 'prompt' | 'generate' | 'polish' | 'result' | 'video' | 'layer' | 'replicate' | 'agent' | 'loop' | 'merge' | 'tts' | 'motion' | 'vsr' | 'camera'
export type CardJobStatus = 'queued' | 'running' | 'success' | 'failed'

/**
 * 生成节点自身携带的一项结果(多图/多任务): 节点运行后不再新建右侧结果卡,
 * 结果直接长在节点上; 主图 = activeResultIndex 指向的那一项, 同步到 card.url/card.cropContext,
 * 下游连线(图生图参考/融合局部图)与图片编辑都照旧读 card.url。
 */
export interface GenerateResultItem {
  /** 单项任务状态(queued/running 显示转圈, failed 可单项重试) */
  itemStatus: CardJobStatus
  /** 结果地址(图片为永久链接, 视频为平台链接) */
  url?: string
  isVideo?: boolean
  taskId?: string
  errorMsg?: string
  /** 局部选区上下文: 图片结果继承自上游局部图, 视频结果不继承 */
  cropContext?: CropContext | null
  /** 单项费用(¥ 文案) */
  costText?: string
  title?: string
  /** 该单项重跑所需的提交体(AI 应用渠道与标准渠道都存, 重试时直接复用) */
  runBody?: Record<string, unknown>
  model?: string
  promptText?: string
  /** AI 应用渠道首帧永久链接, 提交前上传换 fileName */
  aiAppFirstFrame?: string
}
export type ModelKind = 't2i' | 'i2i' | 't2v' | 'i2v'
export type PolishJobStatus = 'idle' | 'running' | 'success' | 'failed'

/** 融合节点状态: 颜色匹配默认开, running/error 驱动按钮与提示 */
export interface MergeNodeState {
  colorMatch: boolean
  running?: boolean
  error?: string | null
}

export function defaultMergeState(): MergeNodeState {
  return { colorMatch: true, running: false, error: null }
}

export interface PolishNodeState {
  model: string
  jobStatus: PolishJobStatus
  result: string
  errorMsg: string | null
}

export function defaultPolishState(): PolishNodeState {
  return { model: 'doubao-seed-2.0-lite', jobStatus: 'idle', result: '', errorMsg: null }
}

/** Agent 节点(smart-prompt): 理解/分析/组织任务, 输出文本或表格, 不直接生成图片视频 */
export interface AgentTableColumn {
  id: string
  name: string
}
export interface AgentTableRow {
  id: string
  cells: Record<string, string>
  /** 显式 false = 该行被跳过, Loop 不为其生成任务 */
  enabled?: boolean
}
export interface AgentNodeState {
  systemPrompt: string
  model: string
  mode: 'overwrite' | 'append'
  output: string
  tableMode: boolean
  tableColumns: AgentTableColumn[]
  tableRows: AgentTableRow[]
  generationColumnIds: string[]
  jobStatus: PolishJobStatus
  errorMsg: string | null
}

export function defaultAgentState(): AgentNodeState {
  return {
    systemPrompt: '',
    model: POLISH_LLM_OPTIONS[0].slug,
    mode: 'overwrite',
    output: '',
    tableMode: false,
    tableColumns: [
      { id: 'col-a', name: '主题' },
      { id: 'col-b', name: 'AI 生成' },
    ],
    tableRows: [],
    generationColumnIds: ['col-b'],
    jobStatus: 'idle',
    errorMsg: null,
  }
}

export const AGENT_PROMPT_TEMPLATES: Array<{ label: string; text: string }> = [
  { label: '通用助手', text: '你是一个创意助手, 理解用户需求并给出结构清晰、可直接使用的文本结果。' },
  { label: '生图提示词专家', text: '你是 AI 绘画提示词专家, 输出包含主体、环境、光线、构图、风格的专业生图提示词。' },
  { label: '文案写手', text: '你是资深文案写手, 语言生动精炼, 贴合使用场景, 不堆砌辞藻。' },
  { label: '表格数据整理', text: '你是数据整理助手, 严格按要求的 JSON 结构输出, 内容准确、列对齐、不遗漏行。' },
]

/** Loop 节点(smart-loop): Agent 的批量执行伴侣, 拆任务 + 控批次, 本身不调 LLM */
export interface LoopNodeState {
  media: 'image' | 'video'
  model: string
  resolution?: string
  aspectRatio?: string
  videoRatio?: string
  videoDuration?: string
}

export function defaultLoopState(): LoopNodeState {
  return { media: 'image', model: T2I_MODELS[0], videoDuration: '5' }
}

export interface GenNodeParams {
  model: string
  count: number
  resolution?: string
  aspectRatio?: string
  quality?: string
  videoDuration?: string
  videoRatio?: string
  /** AI 应用渠道的「最长边」参数(如 WAN 2.2, 像素), 缺省 1280 */
  aiAppLongEdge?: number
  /** AI 应用渠道的「总帧数」参数(如 WAN 2.2 6 秒高质量版), 缺省 81 */
  aiAppFrames?: number
  /** 透明背景开关(仅 GPT Image 2 官方/低价渠道显示): 开启后提示词最前面加「生成透明背景图像」, 缺省关闭 */
  transparentBg?: boolean
}

export interface LayerItem {
  id: string
  name: string
  desc: string
  enabled: boolean
  genStatus: 'idle' | CardJobStatus
  genUrl: string | null
  cutoutUrl: string | null
  errorMsg: string | null
}
export type LayerStage = 'idle' | 'analyzing' | 'ready' | 'generating'
export interface LayerNodeState {
  stage: LayerStage
  sourceUrl: string | null
  markerUrl: string | null
  visionModel: string
  genModel: string
  layers: LayerItem[]
}
export function defaultLayerState(): LayerNodeState {
  return {
    stage: 'idle',
    sourceUrl: null,
    markerUrl: null,
    visionModel: VISION_LLM_OPTIONS[0].slug,
    genModel: I2I_MODELS[0],
    layers: [],
  }
}

export type FoldType = 'tri' | 'bi'
export type TriFoldMode = 'wrap' | 'z'
export const FOLD_TYPE_LABELS: Record<FoldType, string> = { tri: '三折页', bi: '二折页' }
export const TRI_FOLD_LABELS: Record<TriFoldMode, string> = { wrap: '包心折', z: 'Z 字折' }
export function foldPanelCount(foldType: FoldType): number {
  return foldType === 'bi' ? 2 : 3
}
/** 折页从左到右各折面的职责(按顺序), 用于提示词结构与界面标注 */
export function foldPanelRoles(foldType: FoldType, triFold: TriFoldMode, side: 'front' | 'back'): string[] {
  if (foldType === 'bi') return side === 'front' ? ['封底', '封面'] : ['内页一', '内页二']
  if (side === 'front') return triFold === 'wrap' ? ['折入页', '封底', '封面'] : ['封底', '折入页', '封面']
  return ['内页一', '内页二', '内页三']
}
export function foldSpecText(foldType: FoldType, triFold: TriFoldMode): string {
  return foldType === 'bi'
    ? '二折页(展开尺寸 420×297mm, 横向, 两个折面各约 210×297mm)'
    : `三折页(展开尺寸 285×210mm, 横向, 三个折面各约 95×210mm, ${TRI_FOLD_LABELS[triFold]}折法)`
}

export type RepStage = 'idle' | 'analyzing' | 'ready' | 'generating' | 'done'
export interface RepNodeState {
  stage: RepStage
  foldType: FoldType
  triFold: TriFoldMode
  frontUrl: string | null
  backUrl: string | null
  logoUrl: string | null
  qrUrl: string | null
  frontPanels: string[]
  backPanels: string[]
  /** 整合分析线路(当前仅「线路一」: 视觉模型先分析参考图, 再交整合模型编译两条提示词) */
  route: string
  /** 整合分析模型(默认通义千问 3.8 Max, 纯文本长文) */
  analyzeModel: string
  visionModel: string
  polishModel: string
  genModel: string
  /** 生图分辨率(可选值随所选渠道契约) */
  resolution?: string
  /** 生图比例(默认 adaptive=平台自定, 适配展开的整幅折页图) */
  aspectRatio?: string
  frontPrompt: string
  backPrompt: string
  panelPrompts: { front: string[]; back: string[] }
  jobStatus: { front: CardJobStatus | 'idle'; back: CardJobStatus | 'idle' }
  frontResultUrl: string | null
  backResultUrl: string | null
}
export function defaultRepState(): RepNodeState {
  return {
    stage: 'idle',
    foldType: 'tri',
    triFold: 'wrap',
    frontUrl: null,
    backUrl: null,
    logoUrl: null,
    qrUrl: null,
    frontPanels: ['', '', ''],
    backPanels: ['', '', ''],
    route: 'route1',
    analyzeModel: 'qwen3.8-max',
    visionModel: VISION_LLM_OPTIONS[0].slug,
    polishModel: 'qwen3.8-max',
    // 生图渠道存「家族主键」, 提交时按有参考图解析为图生 slug
    genModel: 'gpt-image-2',
    // 比例默认自适应; 分辨率缺省走渠道契约默认档, 用户切换后记住
    aspectRatio: 'adaptive',
    frontPrompt: '',
    backPrompt: '',
    panelPrompts: { front: ['', '', ''], back: ['', '', ''] },
    jobStatus: { front: 'idle', back: 'idle' },
    frontResultUrl: null,
    backResultUrl: null,
  }
}

/** 语音克隆节点(IndexTTS 2): 上传克隆人声/情绪参考 + 文本 + 情绪参数, 输出 mp3 */
export type TtsJobStatus = 'idle' | 'queued' | 'running' | 'success' | 'failed'
export interface TtsNodeState {
  /** 要克隆的人声永久链接(≤20s 干净人声), 必传 */
  cloneAudioUrl?: string
  cloneAudioName?: string
  /** 自定义情绪参考音频永久链接(约 15s), 仅 emotionMode==='8' 时必传 */
  emotionRefAudioUrl?: string
  emotionRefAudioName?: string
  /** 情绪模式枚举值字符串('1'..'8'), 应用默认自定义情绪 '8' */
  emotionMode: string
  /** 情绪强度 0.0–1.6 */
  emotionIntensity: number
  /** 语速, 建议 0.9–1.1 */
  speechRate: number
  text: string
  jobStatus: TtsJobStatus
  /** 结果音频(优先永久链接) */
  resultUrl?: string
  resultName?: string
  errorMsg?: string | null
  /** 受理后回写的远端任务 ID, 刷新恢复用 */
  remoteTaskId?: string
}

export function defaultTtsState(): TtsNodeState {
  return {
    emotionMode: '8',
    emotionIntensity: 0.6,
    speechRate: 1.0,
    text: '',
    jobStatus: 'idle',
    errorMsg: null,
  }
}

/** 动作迁移节点(Animate V9): 人物参考图 + 动作参考视频, 输出人物跟随动作的新视频 */
export type MotionJobStatus = 'idle' | 'queued' | 'running' | 'success' | 'failed'
export interface MotionNodeState {
  /** 人物参考图永久链接, 必传 */
  refImageUrl?: string
  refImageName?: string
  /** 动作参考视频永久链接, 必传(建议 50 秒内) */
  refVideoUrl?: string
  refVideoName?: string
  /** 动作参考视频时长(秒), 选择文件时读出, 用于 1080P 时长校验 */
  refVideoDuration?: number
  /** 分辨率 "1" 480P / "2" 720P / "3" 1080P */
  resolution: string
  /** 姿势选择 "1" VITPOSE / "2" SDPOSE / "3" WUWUPOSE */
  poseMode: string
  /** 仅姿势 3: 脖子长修正 */
  longNeck: boolean
  /** 姿势强度 0–2 */
  poseIntensity: number
  /** 运镜开关与强度 */
  cameraOn: boolean
  cameraIntensity: number
  /** 面具头盔模式 */
  maskHelmet: boolean
  /** 表情强度 0–2(动物/动漫建议调低) */
  expression: number
  /** 胸部抖动幅度 0–1 */
  chest: number
  /** 跳过前帧 / 加载帧上限 / 帧率(24 或 30) */
  skipFrames: number
  frameLimit: number
  frameRate: number
  jobStatus: MotionJobStatus
  resultUrl?: string
  resultName?: string
  errorMsg?: string | null
  /** 受理后回写的远端任务 ID, 刷新恢复用 */
  remoteTaskId?: string
}

export function defaultMotionState(): MotionNodeState {
  return {
    resolution: '2',
    poseMode: '1',
    longNeck: false,
    poseIntensity: 1.0,
    cameraOn: false,
    cameraIntensity: 1.0,
    maskHelmet: false,
    expression: 0.8,
    chest: 0.2,
    skipFrames: 0,
    frameLimit: 840,
    frameRate: 30,
    jobStatus: 'idle',
    errorMsg: null,
  }
}

/** 视频高清修复节点(SeedVR2): 上传一段模糊视频, 输出修复后的高清视频 */
export type VsrJobStatus = 'idle' | 'queued' | 'running' | 'success' | 'failed'
export interface VsrNodeState {
  /** 待修复视频永久链接, 必传 */
  videoUrl?: string
  videoName?: string
  /** 视频时长(秒), 选择文件时读出, SeedVR2 限速 40 秒内 */
  videoDuration?: number
  /** 修复模型 "1" SeedVR2(高清慢速) / "2" FlashVSR(快速) */
  model: '1' | '2'
  /** 最大分辨率(像素), 不建议超过 1920 */
  maxResolution: number
  jobStatus: VsrJobStatus
  resultUrl?: string
  resultName?: string
  errorMsg?: string | null
  /** 受理后回写的远端任务 ID, 刷新恢复用 */
  remoteTaskId?: string
}

export function defaultVsrState(): VsrNodeState {
  return {
    model: '1',
    maxResolution: 1920,
    jobStatus: 'idle',
    errorMsg: null,
  }
}

export interface CanvasCardData {
  id: string
  kind: CardKind
  x: number
  y: number
  w: number
  h: number
  prompt?: string
  url?: string
  refUrls?: string[]
  model?: string
  runBody?: Record<string, unknown>
  taskId?: string
  jobStatus?: CardJobStatus
  errorMsg?: string
  costText?: string
  sourceCardId?: string
  genParams?: GenNodeParams
  layerState?: LayerNodeState
  repState?: RepNodeState
  polishState?: PolishNodeState
  agentState?: AgentNodeState
  loopState?: LoopNodeState
  loopSourceId?: string
  loopRoundIndex?: number
  loopSlotIndex?: number
  groupId?: string
  groupName?: string
  groupCollapsed?: boolean
  /** 颜色图钉标记(旧版六色标记, 保留兼容; 新逻辑优先用 tagSlug; 随画布保存) */
  pinColor?: 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple'
  /**
   * 全局标签 slug(取代 pinColor): 指向账号级 canvas_tags 定义, 空字符串/undefined = 无标签。
   * 渲染时查不到定义再回退旧 pinColor 映射; pinColor 永不回写。
   */
  tagSlug?: string
  /** 宫格切分产物元数据 */
  gridMeta?: { groupId: string; row: number; col: number; rows: number; cols: number }
  /** 局部选区上下文: null/undefined = 完整图; 局部提取图携带, 随多轮改图继承, 融合出图后清除 */
  cropContext?: CropContext | null
  /** 卡片短标题(局部选区 / 融合结果等产物卡用) */
  title?: string
  /** 融合节点状态 */
  mergeState?: MergeNodeState
  /** 语音克隆节点状态(IndexTTS 2) */
  ttsState?: TtsNodeState
  /** 动作迁移节点状态(Animate V9) */
  motionState?: MotionNodeState
  /** 视频高清修复节点状态(SeedVR2) */
  vsrState?: VsrNodeState
  /** 生成节点自身结果列表(运行后结果长在节点上, 不再新建右侧结果卡) */
  results?: GenerateResultItem[]
  /** 当前主看的结果项下标(随缩略图点击切换, card.url/card.cropContext 同步该项) */
  activeResultIndex?: number
  /** 摄影机节点唯一状态: 机身/镜头/焦段/光圈/明度/特效配置 */
  cameraState?: CameraConfig
  /** 生成节点绑定的摄影机节点 id; 指向的摄影机被删时回退用 cameraSnapshot */
  cameraNodeId?: string
  /** 绑定时写入的摄影机快照(节点名 + 当时的摄影提示词全文) */
  cameraSnapshot?: { name: string; prompt: string }
}
export interface ImageEditGridPart {
  blob: Blob
  row: number
  col: number
  rows: number
  cols: number
  naturalW: number
  naturalH: number
  name: string
}
export interface CanvasViewport { x: number; y: number; scale: number }
export interface PendingJobRecord {
  cardId: string
  model: string
  promptText: string
  submittedAt: number
  /** 生成节点自身结果项下标(老独立结果卡无此字段) */
  resultIndex?: number
  /**
   * 远端任务受理后回传的内部任务 ID(标准 AIGC 与 AI 应用共用),
   * 刷新恢复时按它精确认领历史任务; 提交未受理前为空, 此时按提示词兜底匹配。
   */
  remoteTaskId?: string
  /** 仅内存: 恢复认领不到远端任务时是否已延迟重试过一次(不随画布保存) */
  __retried?: boolean
}
/** 节点间持久连接: 从加号拖出创建的新节点会与源节点连线 */
export interface CanvasConnection {
  id: string
  fromId: string
  toId: string
  /** 复刻节点的四个图片投放槽位; 缺省=通用输入(按顺序兜底到正/背面) */
  toSlot?: RepSlot
}

/** 工作流资产: 可复用的节点链路模板(不保存运行结果与任务态) */
export type WorkflowNodeKind = CardKind

/** 序列化后的单个工作流节点: 仅白名单字段, id 为工作流内临时占位, 重建时换全新 id */
export interface WorkflowNode {
  id: string
  kind: WorkflowNodeKind
  x: number
  y: number
  w: number
  h: number
  prompt?: string
  /** 直接挂载在节点上的参考图(生成节点图片位 / 结果卡 / 视频卡的永久链接), 无连线来源 */
  url?: string
  refUrls?: string[]
  genParams?: GenNodeParams
  title?: string
  layerState?: LayerNodeState
  repState?: RepNodeState
  polishState?: PolishNodeState
  agentState?: AgentNodeState
  loopState?: LoopNodeState
  mergeState?: MergeNodeState
  ttsState?: TtsNodeState
  motionState?: MotionNodeState
  vsrState?: VsrNodeState
  /** 摄影机节点配置(随工作流带走, 无任务态) */
  cameraState?: CameraConfig
  /** 重建后生成节点的摄影机绑定按 idMap 重映射 */
  cameraNodeId?: string
  /** 摄影机被删时兜底的绑定快照 */
  cameraSnapshot?: { name: string; prompt: string }
}

/** 工作流连线: 两端 id 均指向 WorkflowNode 的临时 id */
export interface WorkflowEdge {
  fromId: string
  toId: string
  toSlot?: RepSlot
}

export interface WorkflowDoc {
  version: 1
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** 图片复刻节点的四个图片槽位: 正面 / 背面 / Logo / 二维码 */
export type RepSlot = 'front' | 'back' | 'logo' | 'qr'
export const REP_SLOTS: RepSlot[] = ['front', 'back', 'logo', 'qr']

/** 生成日志单条记录: 每个生成任务成功/失败收尾时写一条, 随画布数据持久化, 最多保留最近 500 条 */
export interface GenLogOutput {
  url: string
  kind: 'image' | 'video' | 'audio'
}
export interface GenLogEntry {
  id: string
  createdAt: number
  /** success/failed/running(仅终态落盘, running 不持久化) */
  status: 'success' | 'failed' | 'running'
  /** 渠道/AI 应用平台名 */
  platform: string
  /** 节点类型中文标签(生成节点/分层/复刻/融合/Loop/语音克隆/动作迁移/视频修复/AI 应用) */
  nodeType: string
  /** 模型或任务名 */
  model: string
  prompt: string
  /** 提交时参考图 URL 数组(永久链接, 旧日志与图片任务使用) */
  refs: string[]
  /** 提交时引用的输入素材(图片/视频/音频), 按真实媒体类型渲染; 音频任务传空数组不显示参考图行 */
  refsMedia?: GenLogOutput[]
  /** 输出(图片/视频/音频) */
  outputs: GenLogOutput[]
  /** 运行耗时毫秒(刷新恢复的任务可能为 0) */
  runMs: number
  /** 错误文案(失败时) */
  error?: string
  /** 远端任务 ID */
  taskId?: string
  /** Trace ID(预留, 当前渠道无返回则缺省) */
  traceId?: string
  /** 本次费用文案, 如 ¥0.10 */
  costText?: string
  /** 批量任务统计文案, 如「成功 2 · 失败 1」 */
  batchSummary?: string
  /** 请求参数快照(详情展开区展示) */
  request?: Record<string, unknown>
}
export interface CanvasDoc { version: number; cards: CanvasCardData[]; connections?: CanvasConnection[]; view?: CanvasViewport; pendingJobs?: PendingJobRecord[]; projectAssets?: ProjectAssets; logs?: GenLogEntry[] }
export interface MarqueeRect { x: number; y: number; w: number; h: number }
export interface AssetItem {
  id: string
  name?: string
  url: string
  media_type?: string
  source?: string
  created?: string
  width?: number
  height?: number
  /** 所属文件夹 id(全局库), 空字符串/缺省 = 未分类 */
  folder?: string
  /** 图片组成员(kind=group 时存在), 单图/视频为空; media_type=workflow 时存 {"workflow": WorkflowDoc} */
  images?: ProjectAssetMember[] | WorkflowImagesPayload
}

/** 全局库 media_type='workflow' 时 images 字段的载荷形态 */
export interface WorkflowImagesPayload {
  workflow: WorkflowDoc
}

/** 项目资产 / 全局图片组共用的成员结构 */
export interface ProjectAssetMember {
  url: string
  name?: string
  width?: number
  height?: number
}
export type ProjectAssetKind = 'image' | 'video' | 'group' | 'workflow'
/** 项目库资产项: 随画布数据保存, 随项目包导出导入 */
export interface ProjectAssetItem {
  id: string
  name: string
  kind: ProjectAssetKind
  /** workflow 项: 封面地址, 可为空字符串 */
  url: string
  width?: number
  height?: number
  folderId?: string
  createdAt: number
  /** 图片组成员; 封面取 members[0].url */
  images?: ProjectAssetMember[]
  /** 工作流项的节点链路结构 */
  workflow?: WorkflowDoc
  /** 工作流项的封面(与 url 同义, 语义化字段) */
  coverUrl?: string
}
export interface ProjectAssetFolder {
  id: string
  name: string
}
export interface ProjectAssets {
  items: ProjectAssetItem[]
  folders: ProjectAssetFolder[]
}
/** 全局资产文件夹(后端 asset_folders 记录) */
export interface GlobalAssetFolder {
  id: string
  name?: string
}

export type ConnectionSide = 'left' | 'right'

export interface ConnectionDraft {
  sourceId: string
  startX: number
  startY: number
  /**
   * 拖线悬停时命中的复刻槽位(仅用于高亮)。
   * 鼠标端坐标不在状态里: 跟线期间直接写常驻 path 的 d 属性(见 draftPathRef),
   * 避免每帧 setState 唤醒整个舞台。
   */
  hoverSlot?: { cardId: string; slot: RepSlot } | null
  /**
   * 靠近目标节点端口时的自动吸附(用于跟线终点与端口高亮): 线端被钉到 snapX/snapY(画布坐标),
   * 松手直接与 snapCardId 建连。只在吸附目标变化时才 setState。
   */
  snapCardId?: string | null
  snapSide?: ConnectionSide | null
  snapX?: number
  snapY?: number
}

export type StageGesture =
  | {
      type: 'pan'
      startClientX: number
      startClientY: number
      originX: number
      originY: number
      moved: boolean
      /** 鼠标中键按住触发的平移: 松手时同步关掉抓手光标(空格抓手不由它控制) */
      viaMiddle?: boolean
    }
  | {
      type: 'drag'
      startClientX: number
      startClientY: number
      origins: Record<string, { x: number; y: number }>
      selectIds: string[]
      moved: boolean
      /** 收纳小卡: 拖动落点后清空选中, 回到干净状态(轻点不移动仍选中) */
      clearIfMoved?: boolean
      /**
       * 拖动快速路径: true 时 move 只直接写卡片 DOM 的 left/top + 更新几何注册表,
       * 不触发 React 提交(平移画布同款方案); 松手时一次性把最终位置写回状态。
       */
      fastPath?: boolean
    }
  | { type: 'marquee'; startX: number; startY: number }

export interface JobSpec {
  /** 老路径(loop/复刻等独立结果卡): 结果写回的卡片 id; 新生成节点路径与 nodeId 相同 */
  resultCardId: string
  /** 生成节点路径: 结果落节点自身 results[resultIndex]; 缺省 = 老独立结果卡路径 */
  nodeId?: string
  resultIndex?: number
  model: string
  body: Record<string, unknown>
  promptText: string
  sourceCardId: string
  /** AI 应用渠道(图生视频)的首帧永久链接, 提交前由 runJob 上传该应用换 fileName */
  aiAppFirstFrame?: string
  /** 结果是否为视频(用于节点结果项 isVideo 标记) */
  isVideo?: boolean
  /**
   * 服务端受理后回填的真实任务 ID: 终态收尾按「卡+渠道+任务槽+任务号」
   * compare-and-delete, 旧笔(如换渠道重跑的上一笔)先结束不得带走新笔待办。
   */
  remoteTaskId?: string
  /** 生成日志用: 提交时的参考图(永久链接) */
  refs?: string[]
  /** 生成日志用: 节点类型中文标签 */
  nodeType?: string
}
