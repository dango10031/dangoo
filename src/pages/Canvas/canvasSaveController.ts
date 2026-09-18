// 画布云端保存的「队列控制器」——框架无关的纯状态机。
// 接管原先散在 useCanvas 里的 8 个记账 ref 与其全部时序规则:
// 待保存标记(full/view)、单飞锁、防抖定时器、指数退避重试、链式补发裁决、
// keepalive 卸载抢发、在途全量风险判断、force 一次性标记、本地盘安全标记。
//
// 本文件不碰 React / DOM(定时器由注入的 clock 提供, 生产传 window.setTimeout/clearTimeout;
// 测试传假时钟)、不直接 fetch、不直接读写 IndexedDB——这些环境动作经 SaveDeps 注入,
// useCanvas 负责装配。控制器只维护「每个画布现在该发什么、什么时候发、发完怎么收场」。
import {
  classifyPersistHttpStatus,
  shouldChainNextPersist,
  type PersistOutcome,
} from './canvasPersist'
import {
  saveDebounceMs as saveDebounceMsPure,
  type NetHint,
} from './canvasGeometry'

/** 失败主动重试退避(毫秒): 1s→3s→10s→30s→60s 封顶, 实际值再加 ±20% 抖动避免多标签齐发 */
export const RETRY_BACKOFF_MS = [1000, 3000, 10000, 30000, 60000]
/** keepalive fetch 浏览器上限 64KB, 留余量: 全量保存体超过该值在卸载路径不强发(本地盘已有快照) */
export const KEEPALIVE_BODY_LIMIT = 60_000

/** 同步短哈希(cyrb53): 为全量保存体生成幂等指纹, 同内容重试复用同一幂等键 */
export function cyrb53Hex(str: string): string {
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

export interface SaveClock {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
  now: () => number
  random: () => number
}

export const browserClock: SaveClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h),
  now: () => Date.now(),
  random: () => Math.random(),
}

/** 一笔待发保存的描述: 是否全量内容、是否卸载抢发、是否强制覆盖乐观锁 */
export interface SaveRequest {
  canvasId: string
  full: boolean
  keepalive: boolean
  force: boolean
  /**
   * 本笔发送的单调序号(仅全量笔分配): 与本地快照的文档序号一一对应。
   * 云端确认时只能声明「这一序号」安全、只能删这一序号的快照,
   * 旧请求晚成功不得清掉已被新内容覆盖的快照。
   */
  docSeq?: number
}

/** deps.sendRequest 的返回: HTTP 已得到响应(status, body 为已解析 JSON)或网络层直接抛错 */
export interface SaveHttpResult {
  status: number
  /** 响应体 JSON(解析失败为 null); 装配层据此前移版本号、取冲突服务端 rev */
  body?: unknown
  /** keepalive 全量体超限、本笔未真正发出: 留住 dirty, 交装配层短延时普通补发 */
  skipped?: boolean
  /** 本笔全量内容是否已先落本地兜底盘(失败时据此保住「本地已存」标记) */
  localLanded?: boolean
}

/**
 * 环境动作注入: 控制器只规定「何时发、发什么、发完如何记账」,
 * 具体网络/磁盘/UI 由装配层(useCanvas)实现。
 */
export interface SaveDeps {
  clock?: SaveClock
  /** 是否已有挂起(不允许自动发送): 版本冲突选择 / 崩溃恢复弹窗未决 */
  isBlocked: (canvasId: string) => boolean
  /** 是否版本冲突挂起(仅用于链式补发裁决; 缺省按 isBlocked 兜底) */
  isConflictPending?: (canvasId: string) => boolean
  /** 是否崩溃恢复弹窗未决(仅用于链式补发裁决) */
  isRestorePending?: (canvasId: string) => boolean
  /** 某画布当前卡片数, 用于动态防抖 */
  cardCount: (canvasId: string) => number
  /** 网络提示(saveData / rtt), 取不到给 undefined */
  netHint: () => NetHint | undefined
  /**
   * 真正发送一笔保存。实现方负责构造/序列化请求体、本地快照前后落盘、发 fetch;
   * 控制器已经完成单飞与 dirty 消费, 实现方不要再判锁。
   * 返回响应状态; 网络异常直接抛出。
   */
  sendRequest: (req: SaveRequest) => Promise<SaveHttpResult>
  // —— 落定事件: 实现方据此前移版本号、清本地盘、更新顶栏、弹窗、跨标签通知 ——
  onSaved: (canvasId: string, req: SaveRequest, result: SaveHttpResult, stillDirty: boolean) => void
  onConflict: (canvasId: string, req: SaveRequest, result: SaveHttpResult) => void
  onAuthFailure: (canvasId: string, req: SaveRequest) => void
  onRetryableFailure: (canvasId: string, req: SaveRequest) => void
  /** 发送开始: 实现方可启动「同步中」延迟闪烁 */
  onSendStart?: (canvasId: string) => void
  /** 队列彻底空闲(无待发/无在途)或进入挂起: 实现方取消闪烁 */
  onSettled?: (canvasId: string) => void
  /** keepalive 全量体超限、本笔未发出: 实现方更新顶栏; 1.2s 普通补发由控制器统一安排 */
  onKeepaliveOversizeNote?: (canvasId: string) => void
}

interface Marks {
  full: boolean
  view: boolean
}
const EMPTY_MARKS: Marks = { full: false, view: false }

/**
 * 画布保存队列控制器(跨多画布, 每画布独立记账)。
 * 所有方法同步修改记账; 网络在后台 async 推进, 完成后经事件回调装配层。
 */
export class CanvasSaveController {
  private readonly clock: SaveClock
  private readonly dirty = new Map<string, Marks>()
  private readonly inFlight = new Map<string, boolean>()
  private readonly inFlightFull = new Map<string, boolean>()
  private readonly localSafe = new Map<string, boolean>()
  private readonly forceNext = new Map<string, boolean>()
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** keepalive 超限后的一次性短延时普通补发定时器(每画布至多一个) */
  private readonly oversizeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** requestQuickFullSave 的 0ms 引导定时器: 也必须登记, clearAllTimers 才能取消 */
  private readonly kickTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly retryStep = new Map<string, number>()
  /** 每画布全量发送的单调文档序号: 与本笔快照一一对应, 云端确认只删同序号快照 */
  private readonly docSeq = new Map<string, number>()
  /** 当前在途发送期间用户是否又产生了全量改动(旧快照不再代表最新内容) */
  private readonly editedWhileInFlight = new Set<string>()
  private readonly deps: SaveDeps

  constructor(deps: SaveDeps) {
    this.deps = deps
    this.clock = deps.clock ?? browserClock
  }

  // ---------------- 查询(供关页拦截 / Agent 屏障 / 多标签协同判断) ----------------

  marksOf(canvasId: string): Marks | null {
    return this.dirty.get(canvasId) ?? null
  }
  isInFlight(canvasId: string): boolean {
    return !!this.inFlight.get(canvasId)
  }
  hasDebounceTimer(canvasId: string): boolean {
    return this.debounceTimers.has(canvasId)
  }
  /** 是否有全量内容在途(卸载瞬间 dirty 已消费, 靠它判断内容风险) */
  isFullInFlight(canvasId: string): boolean {
    return !!this.inFlightFull.get(canvasId)
  }
  /** 待同步内容是否已有安全本地快照 */
  isLocalSafe(canvasId: string): boolean {
    return !!this.localSafe.get(canvasId)
  }
  /**
   * 有新的全量内容改动: 旧快照只担保它写下那一刻的版本, 不能再为新内容背书。
   * 纯视角变化不失效(视角丢失不打扰)。scheduleSave('full') 内部已自动调用。
   */
  invalidateLocalSafe(canvasId: string): void {
    this.localSafe.set(canvasId, false)
  }
  /** 全量内容已落本地兜底盘: 只置 true(成功保存/丢弃时由控制器复位), 供卸载判定与顶栏状态 */
  markLocalSafe(canvasId: string): void {
    this.localSafe.set(canvasId, true)
  }
  /**
   * 失败落定后, 若本笔落过本地盘则保住「本地已存」标记(装配层据落盘结果调用)。
   * 但在途期间用户又有新的全量改动时不置真: 盘上快照只代表发送时那一版,
   * 新改动尚未落盘, 置真会让关页提醒静默跳过最新内容。
   */
  retainLocalSafeIfLanded(canvasId: string, landed: boolean): void {
    if (landed && !this.editedWhileInFlight.has(canvasId)) this.localSafe.set(canvasId, true)
  }
  /** 关页原生拦截判定: 内容待发/全量在途且本地盘也没有(冲突/恢复弹窗由调用方另行处理) */
  isContentAtRisk(canvasId: string): boolean {
    const m = this.dirty.get(canvasId)
    return (!!m?.full || this.isFullInFlight(canvasId)) && !this.isLocalSafe(canvasId)
  }
  /** Agent 发送前屏障: 无待发、无在途、无防抖在等才算同步完成 */
  isQuiet(canvasId: string): boolean {
    const m = this.dirty.get(canvasId)
    return !m?.full && !m?.view && !this.isInFlight(canvasId) && !this.hasDebounceTimer(canvasId)
  }

  // ---------------- 标记改动 + 防抖调度 ----------------

  /** 记录一次改动并安排防抖发送。挂起(冲突/恢复弹窗)期间只累积标记, 不调度。 */
  scheduleSave(kind: 'full' | 'view', canvasId: string | null): void {
    if (!canvasId) return
    const marks = this.dirty.get(canvasId) ?? { ...EMPTY_MARKS }
    if (kind === 'full') {
      // 新的内容改动使旧版本快照不再代表当前内容: 失效本地安全标记,
      // 否则关页时会跳过最新快照、丢内容提醒也不弹(旧快照只担保写下那一刻的版本)。
      if (!marks.full) this.localSafe.set(canvasId, false)
      // 若此刻正有一笔在途: 盘上快照只代表在途那一版, 记下「在途期间被编辑」,
      // 该笔失败落定时不得用旧快照把安全标记置真。
      if (this.inFlight.get(canvasId)) this.editedWhileInFlight.add(canvasId)
      marks.full = true
    } else if (!marks.full) marks.view = true
    this.dirty.set(canvasId, marks)
    // 挂起期间继续累积改动, 但不抢状态、不调度发送(用户选择后再发最新快照)
    if (this.deps.isBlocked(canvasId)) return
    // 用户有新操作: 退避重试从 1s 重新起步
    this.clearRetryTimer(canvasId)
    this.retryStep.set(canvasId, 0)
    const oldTimer = this.debounceTimers.get(canvasId)
    if (oldTimer) this.clock.clearTimeout(oldTimer)
    const effectiveKind: 'full' | 'view' = kind === 'view' && !marks.full ? 'view' : 'full'
    const delay = saveDebounceMsPure(effectiveKind, this.deps.cardCount(canvasId), this.deps.netHint())
    const timer = this.clock.setTimeout(() => {
      this.debounceTimers.delete(canvasId)
      void this.send(canvasId)
    }, delay)
    this.debounceTimers.set(canvasId, timer)
  }

  /** 立刻把防抖中的改动发出去(切画布/卸载前); 冲突挂起时不允许普通 flush 覆盖 */
  flushNow(canvasId: string | null, keepalive = false): void {
    if (!canvasId) return
    this.clearDebounceTimer(canvasId)
    if (this.deps.isBlocked(canvasId)) return
    void this.send(canvasId, { keepalive })
  }

  /** 关键状态到手后的快速落盘: 等一拍让外层状态灌进快照桶, 再把全量防抖提前到 250ms */
  requestQuickFullSave(canvasId: string | null, ready: () => boolean): void {
    if (!canvasId) return
    // 0ms 引导定时器同样登记: 组件卸载 clearAllTimers 时能取消, 避免卸载后还触发一次发送
    this.clearKickTimer(canvasId)
    const kick = this.clock.setTimeout(() => {
      this.kickTimers.delete(canvasId)
      if (!ready()) return
      this.markFull(canvasId)
      this.clearDebounceTimer(canvasId)
      const timer = this.clock.setTimeout(() => {
        this.debounceTimers.delete(canvasId)
        void this.send(canvasId)
      }, 250)
      this.debounceTimers.set(canvasId, timer)
    }, 0)
    this.kickTimers.set(canvasId, kick)
  }

  /**
   * 非当前画布的关键状态(如切走后才回来的上传永久链接)到手后的提前落盘:
   * 调用方先直接改完该画布的快照桶再调本方法——先标记全量, 250ms 后发送,
   * 避开「标记后立即发会拿到旧桶」的竞态。与 requestQuickFullSave 的区别:
   * 不要求目标是当前画布、不需要 ready 闸门(桶改动在调用前已完成)。
   */
  scheduleQuickFullSave(canvasId: string | null): void {
    if (!canvasId) return
    this.markFull(canvasId)
    this.clearDebounceTimer(canvasId)
    const timer = this.clock.setTimeout(() => {
      this.debounceTimers.delete(canvasId)
      void this.send(canvasId)
    }, 250)
    this.debounceTimers.set(canvasId, timer)
  }

  // ---------------- 冲突 / 恢复 / 强制覆盖等外部裁决入口 ----------------

  /** 冲突选「加载最新」: 丢弃本地待发改动与本地安全标记 */
  resetPending(canvasId: string): void {
    this.dirty.set(canvasId, { ...EMPTY_MARKS })
    this.localSafe.set(canvasId, false)
    this.clearRetryTimer(canvasId)
  }

  /** 冲突选「强制覆盖」/ 取回本地版本: 标全量 + 带 force 立即发 */
  forceFullNow(canvasId: string): void {
    this.markFull(canvasId)
    this.clearDebounceTimer(canvasId)
    void this.send(canvasId, { force: true })
  }

  /** 崩溃恢复接管本地快照: 下一笔全量强制覆盖, 并标记本地已有安全内容 */
  markAcceptedLocalRestore(canvasId: string): void {
    this.forceNext.set(canvasId, true)
    this.localSafe.set(canvasId, true)
  }

  /** 登录成功后续存挂起改动: 清退避、立即发 */
  flushAfterAuth(canvasId: string): void {
    const m = this.dirty.get(canvasId)
    if (!m?.full && !m?.view) return
    this.clearDebounceTimer(canvasId)
    this.clearRetryTimer(canvasId)
    this.retryStep.set(canvasId, 0)
    void this.send(canvasId)
  }

  /** 网络从离线恢复: 所有有待发改动的画布立即补发一次 */
  flushAllOnOnline(): void {
    for (const id of Array.from(this.dirty.keys())) {
      const m = this.dirty.get(id)
      if (!m || (!m.full && !m.view)) continue
      if (this.deps.isBlocked(id) || this.isInFlight(id)) continue
      this.clearRetryTimer(id)
      this.retryStep.set(id, 0)
      this.clearDebounceTimer(id)
      void this.send(id)
    }
  }

  // ---------------- 定时器清理 ----------------

  clearDebounceTimer(canvasId: string): void {
    const t = this.debounceTimers.get(canvasId)
    if (t) {
      this.clock.clearTimeout(t)
      this.debounceTimers.delete(canvasId)
    }
  }

  clearRetryTimer(canvasId: string): void {
    const t = this.retryTimers.get(canvasId)
    if (t) {
      this.clock.clearTimeout(t)
      this.retryTimers.delete(canvasId)
    }
  }

  /** 卸载/销毁: 清掉全部定时器(在途请求由调用方按 keepalive 自行抢发, 控制器不再调度) */
  clearAllTimers(): void {
    for (const id of Array.from(this.debounceTimers.keys())) this.clearDebounceTimer(id)
    for (const id of Array.from(this.retryTimers.keys())) this.clearRetryTimer(id)
    for (const [id, t] of Array.from(this.oversizeTimers.entries())) {
      this.clock.clearTimeout(t)
      this.oversizeTimers.delete(id)
    }
    for (const [id, t] of Array.from(this.kickTimers.entries())) {
      this.clock.clearTimeout(t)
      this.kickTimers.delete(id)
    }
  }

  /** 取消某画布尚未触发的 quick save 引导定时器 */
  private clearKickTimer(canvasId: string): void {
    const t = this.kickTimers.get(canvasId)
    if (t) {
      this.clock.clearTimeout(t)
      this.kickTimers.delete(canvasId)
    }
  }

  // ---------------- 内部记账 ----------------

  private markFull(canvasId: string): void {
    const marks = this.dirty.get(canvasId) ?? { ...EMPTY_MARKS }
    marks.full = true
    this.dirty.set(canvasId, marks)
  }

  /** 失败后重新标记待发: 全量失败标 full; 纯视角失败且本笔非全量才标 view */
  private restoreDirty(canvasId: string, wantFull: boolean, wantView: boolean): void {
    const cur = this.dirty.get(canvasId) ?? { ...EMPTY_MARKS }
    if (wantFull) cur.full = true
    if (wantView && !wantFull) cur.view = true
    this.dirty.set(canvasId, cur)
  }

  private stillDirty(canvasId: string): boolean {
    const m = this.dirty.get(canvasId)
    return !!(m?.full || m?.view)
  }

  /** 指数退避安排一次主动重试; 冲突挂起中不安排; 已有退避定时器不重复 */
  private scheduleRetry(canvasId: string): void {
    if (this.retryTimers.has(canvasId)) return
    if (this.deps.isBlocked(canvasId)) return
    const step = Math.min(this.retryStep.get(canvasId) ?? 0, RETRY_BACKOFF_MS.length - 1)
    const base = RETRY_BACKOFF_MS[step]
    this.retryStep.set(canvasId, step + 1)
    const jitter = base * 0.2 * (2 * this.clock.random() - 1)
    const timer = this.clock.setTimeout(() => {
      this.retryTimers.delete(canvasId)
      const m = this.dirty.get(canvasId)
      if (!m?.full && !m?.view) return
      void this.send(canvasId)
    }, Math.max(300, base + jitter))
    this.retryTimers.set(canvasId, timer)
  }

  // ---------------- 发送状态机(单飞 + 统一收尾) ----------------

  async send(
    targetCanvasId: string,
    opts?: { keepalive?: boolean; force?: boolean },
  ): Promise<void> {
    const marks = this.dirty.get(targetCanvasId)
    if (!marks || (!marks.full && !marks.view)) return
    // 单飞: 同一画布同一时刻只有一个在途保存, 完成后检查 dirty 决定是否补发最新快照
    if (this.inFlight.get(targetCanvasId)) return
    // 冲突挂起/恢复弹窗未决时不自动发, 避免覆盖别处新版本或打断用户选择
    if (this.deps.isBlocked(targetCanvasId)) return
    // 本笔发送窗口开始: 清除上一笔遗留的「在途被编辑」标记, 由本笔期间的 scheduleSave 重新记录
    this.editedWhileInFlight.delete(targetCanvasId)
    this.inFlight.set(targetCanvasId, true)

    const wantFull = marks.full
    const wantView = marks.view
    const wantForce = !!opts?.force || !!this.forceNext.get(targetCanvasId)
    if (wantForce) this.forceNext.set(targetCanvasId, false)
    // 文档序号在快照写入前分配: 实现方从 req.docSeq 取号打在这份快照上,
    // 云端确认只删同号快照。序号随请求对象走, 避免共享可变状态在跨画布并发时串号。
    let reqDocSeq: number | undefined
    if (wantFull) {
      const seq = (this.docSeq.get(targetCanvasId) ?? 0) + 1
      this.docSeq.set(targetCanvasId, seq)
      reqDocSeq = seq
      this.inFlightFull.set(targetCanvasId, true)
    }
    this.deps.onSendStart?.(targetCanvasId)
    // 消费待保存标记: 发送期间的新改动会重新置位, 完成后据此决定是否链式补发
    this.dirty.set(targetCanvasId, { ...EMPTY_MARKS })

    const req: SaveRequest = {
      canvasId: targetCanvasId,
      full: wantFull,
      keepalive: !!opts?.keepalive,
      force: wantForce,
      docSeq: reqDocSeq,
    }

    let outcome: PersistOutcome = 'retry'
    try {
      const result = await this.deps.sendRequest(req)
      // 卸载抢发但全量体超限: sendRequest 以 skipped 告知, 未真正发出
      if (result.skipped) {
        this.restoreDirty(targetCanvasId, wantFull, wantView)
        this.deps.onKeepaliveOversizeNote?.(targetCanvasId)
        // 页面仍存活: 1.2s 后走普通请求补发; 每画布至多一个, 不重复排
        if (!this.oversizeTimers.has(targetCanvasId)) {
          const t = this.clock.setTimeout(() => {
            this.oversizeTimers.delete(targetCanvasId)
            void this.send(targetCanvasId)
          }, 1200)
          this.oversizeTimers.set(targetCanvasId, t)
        }
        outcome = 'skipped'
        return
      }
      const landed = !!result.localLanded
      outcome = classifyPersistHttpStatus(result.status)
      if (outcome === 'ok') {
        this.clearRetryTimer(targetCanvasId)
        this.retryStep.set(targetCanvasId, 0)
        if (wantFull) this.localSafe.set(targetCanvasId, false)
        this.deps.onSaved(targetCanvasId, req, result, this.stillDirty(targetCanvasId))
      } else if (outcome === 'conflict') {
        this.restoreDirty(targetCanvasId, wantFull, wantView)
        this.retainLocalSafeIfLanded(targetCanvasId, landed)
        this.clearRetryTimer(targetCanvasId)
        this.deps.onConflict(targetCanvasId, req, result)
      } else if (outcome === 'auth') {
        this.restoreDirty(targetCanvasId, wantFull, wantView)
        this.clearRetryTimer(targetCanvasId)
        this.retainLocalSafeIfLanded(targetCanvasId, landed)
        this.deps.onAuthFailure(targetCanvasId, req)
      } else {
        this.restoreDirty(targetCanvasId, wantFull, wantView)
        this.retainLocalSafeIfLanded(targetCanvasId, landed)
        this.deps.onRetryableFailure(targetCanvasId, req)
        this.scheduleRetry(targetCanvasId)
      }
    } catch {
      // 网络失败/取槽异常: sendRequest 抛出时无法回传 localLanded,
      // 落盘成功标记由装配层在抛出前直接 markLocalSafe 完成, 这里留住改动并排重试。
      this.restoreDirty(targetCanvasId, wantFull, wantView)
      this.deps.onRetryableFailure(targetCanvasId, req)
      this.scheduleRetry(targetCanvasId)
    } finally {
      this.inFlight.set(targetCanvasId, false)
      if (wantFull) this.inFlightFull.delete(targetCanvasId)
      const stillDirty = this.stillDirty(targetCanvasId)
      // 链式补发只看「成功 + 新改动」; 冲突/恢复挂起由 outcome 与 isBlocked 双重拦截
      const conflictPending =
        outcome === 'conflict' && this.deps.isConflictPending?.(targetCanvasId) === true
      const restorePending = this.deps.isRestorePending?.(targetCanvasId) === true
      const chain = shouldChainNextPersist({ outcome, stillDirty, conflictPending, restorePending })
      // 进入挂起或彻底空闲时取消「同步中」闪烁; 链式补发会重新 arm
      if (!stillDirty || conflictPending || restorePending || !chain) this.deps.onSettled?.(targetCanvasId)
      // 仅「本笔成功且期间又有新改动、且无挂起」才立即补发; 其余等退避/登录/用户选择
      if (chain) void this.send(targetCanvasId)
    }
  }
}
