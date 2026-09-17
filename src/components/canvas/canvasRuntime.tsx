import { createContext, useContext, useRef, type ReactNode } from 'react'
import type { useCanvas } from '@/pages/Canvas/useCanvas'

// 画布运行时基础设施(第二批性能改造):
// 1. GeometryRegistry —— 一个 ResizeObserver 统一观测全部卡片尺寸 + React 提交后统一同步位置,
//    替代「每张卡一个 ResizeObserver + 连线层再观察一遍」的双重监听, 也不做每帧全量布局读取。
//    平移/缩放时连线随变换层 DOM 一起移动, 无需重算; 只有卡片相对位置/尺寸变化才重绘连线。
// 2. 稳定视图模型上下文 —— 上下文里放的是 ref(引用永不变), 这样画布状态变化时
//    被 React.memo 跳过的卡片不会因上下文值变化而被强制重渲染。

export type CanvasVm = ReturnType<typeof useCanvas>
export type CardRect = { x: number; y: number; w: number; h: number }
type SizeListener = (cardId: string, w: number, h: number) => void
type VersionListener = () => void

export class GeometryRegistry {
  private content: HTMLElement | null = null
  private ro: ResizeObserver | null = null
  private mo: MutationObserver | null = null
  private rects = new Map<string, CardRect>()
  /** 每张卡自己的几何版本号: 只在该卡位置/尺寸变化时自增, 连线按两端 id 订阅, 拖一张卡不唤醒其它线 */
  private rectVersions = new Map<string, number>()
  private rafId = 0
  private versionListeners = new Set<VersionListener>()
  private sizeListener: SizeListener | null = null
  /** 几何版本号: 任一卡片位置/尺寸变化即自增, 供连线层订阅重绘 */
  version = 0
  /** 拖动快速路径: 拖动卡 id 集合、当前位移增量、拖动开始时的基准几何 */
  private dragDelta: { x: number; y: number } = { x: 0, y: 0 }
  private draggingIds: Set<string> = new Set()
  private dragBase = new Map<string, CardRect>()
  /** resize 快速路径: 调尺寸的卡与当前目标宽高(位置不变) */
  private resizingIds: Set<string> = new Set()
  private resizeSize = new Map<string, { w: number; h: number }>()

  private scheduleSync = () => {
    if (this.rafId) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0
      this.syncFromDom()
    })
  }

  /**
   * 开始拖动快速路径: 快照拖动卡起始几何。之后 move 由手势直接写 DOM + applyDragDelta,
   * 不触发 React 提交; rects 里这些卡的位置 = 基准 + 当前增量。
   */
  beginDragFastPath(ids: string[]) {
    this.dragBase.clear()
    this.draggingIds = new Set()
    this.dragDelta = { x: 0, y: 0 }
    ids.forEach(id => {
      const r = this.rects.get(id)
      if (r) {
        this.dragBase.set(id, r)
        this.draggingIds.add(id)
      }
    })
  }

  /**
   * 拖动快速路径每帧: 直接按「基准几何 + 增量」更新内存并升版本号让连线跟随,
   * 不做 querySelectorAll 全量扫描(那是拖动卡顿的主要来源之一)。
   */
  applyDragDelta(dxCanvas: number, dyCanvas: number) {
    if (!this.draggingIds.size) return
    this.dragDelta = { x: dxCanvas, y: dyCanvas }
    this.dragBase.forEach((r, id) => {
      this.rects.set(id, { ...r, x: r.x + dxCanvas, y: r.y + dyCanvas })
      this.rectVersions.set(id, (this.rectVersions.get(id) ?? 0) + 1)
    })
    this.version += 1
    this.versionListeners.forEach(fn => fn())
  }

  /** 快速路径中某张卡(含组内成员)当前应叠加的屏幕位移; 非拖动卡返回 0 */
  getDragDelta(id: string): { x: number; y: number } {
    return this.draggingIds.has(id) ? this.dragDelta : { x: 0, y: 0 }
  }

  isDraggingFast(): boolean {
    return this.draggingIds.size > 0
  }

  /** 拖动结束: React 已(或将)以最终位置提交, 清增量并做一次全量同步对齐内存与 DOM */
  endDragFastPath() {
    this.dragDelta = { x: 0, y: 0 }
    this.draggingIds = new Set()
    this.dragBase.clear()
    this.syncFromDom()
  }

  /** 开始 resize 快速路径: 记录调尺寸的卡(位置以内存为准, 宽高跟随增量) */
  beginResizeFastPath(ids: string[]) {
    this.resizingIds = new Set(ids)
    this.resizeSize.clear()
  }

  /** resize 每帧: 直接更新内存宽高并升版本号让连线跟随, 不做全量 DOM 扫描 */
  applyResizeDelta(id: string, w: number, h: number) {
    if (!this.resizingIds.has(id)) return
    this.resizeSize.set(id, { w, h })
    const r = this.rects.get(id)
    if (r) {
      this.rects.set(id, { ...r, w, h })
      this.rectVersions.set(id, (this.rectVersions.get(id) ?? 0) + 1)
    }
    this.version += 1
    this.versionListeners.forEach(fn => fn())
  }

  /** 某张卡的几何版本号, 供连线做端点级订阅 */
  getRectVersion(id: string): number {
    return this.rectVersions.get(id) ?? 0
  }

  /** resize 结束: 状态即将以最终宽高提交, 清理后全量同步对齐 */
  endResizeFastPath() {
    this.resizingIds = new Set()
    this.resizeSize.clear()
    this.syncFromDom()
  }

  attach(content: HTMLElement, sizeListener: SizeListener) {
    this.content = content
    this.sizeListener = sizeListener
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(this.scheduleSync)
    }
    this.observeAll()
    // 新增/删除卡片(挂载即 absolute 子节点): 补 observe 并同步一次几何。
    // 只监听 childList: 拖动快速路径每帧直接改卡片 style.left/top, 若同时监听 attributes,
    // 会每帧触发一次「querySelectorAll 全量扫描 + ResizeObserver 连锁」, 是拖动卡顿来源之一;
    // 拖动期几何由 applyDragDelta 直接维护, 尺寸变化由 ResizeObserver 负责, 不依赖属性监听。
    // 增量观察: 卡片内部子树增删(结果图加载、面板展开)只触发新节点补 observe + 一次同步,
    // 不再每次全量 querySelectorAll 后对全部元素重复 observe(500 卡时这是无谓的 O(n) 扫描)。
    this.mo = new MutationObserver(records => {
      let addedCard = false
      records.forEach(rec => {
        rec.addedNodes.forEach(node => {
          if (node.nodeType !== 1) return
          const el = node as HTMLElement
          if (el.hasAttribute?.('data-card-id')) {
            this.ro?.observe(el)
            addedCard = true
          } else if (typeof el.querySelectorAll === 'function') {
            el.querySelectorAll<HTMLElement>('[data-card-id]').forEach(child => this.ro?.observe(child))
            addedCard = true
          }
        })
      })
      if (addedCard) this.scheduleSync()
    })
    this.mo.observe(content, { childList: true, subtree: true })
    // 挂载后先同步一次
    this.scheduleSync()
  }

  private observeAll() {
    if (!this.content || !this.ro) return
    const els = this.content.querySelectorAll<HTMLElement>('[data-card-id]')
    els.forEach(el => this.ro!.observe(el))
  }

  detach() {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.ro?.disconnect()
    this.mo?.disconnect()
    this.ro = null
    this.mo = null
    this.content = null
    this.sizeListener = null
    this.rects.clear()
  }

  /** 连线层订阅: 几何版本变化时重绘 */
  subscribe(fn: VersionListener): () => void {
    this.versionListeners.add(fn)
    return () => this.versionListeners.delete(fn)
  }

  getRect(id: string): CardRect | undefined {
    return this.rects.get(id)
  }

  /**
   * 读一次 DOM 同步全部卡片几何(React 提交后或尺寸变化时调用)。
   * 仅当位置/尺寸真的变化时才升版本号通知连线层; 尺寸变化经 1px 容差批量回写数据。
   */
  syncFromDom() {
    const content = this.content
    if (!content) return
    const els = content.querySelectorAll<HTMLElement>('[data-card-id]')
    let changed = false
    const seen = new Set<string>()
    const sizeChanges: Array<{ id: string; w: number; h: number }> = []
    for (let i = 0; i < els.length; i += 1) {
      const el = els[i]
      const id = el.dataset.cardId
      if (!id) continue
      seen.add(id)
      const r: CardRect = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
      const old = this.rects.get(id)
      const bumpCard = () => this.rectVersions.set(id, (this.rectVersions.get(id) ?? 0) + 1)
      if (!old) {
        this.rects.set(id, r)
        bumpCard()
        changed = true
        if (r.w >= 8 && r.h >= 8) sizeChanges.push({ id, w: r.w, h: r.h })
      } else {
        if (this.draggingIds.has(id)) {
          // 快速路径拖动卡: DOM left/top 已被手势直接改写, 但位置以「基准+增量」为准(已在 applyDragDelta 更新),
          // 这里只同步尺寸, 绝不用 DOM 读回的 x/y 覆盖, 否则快速路径与扫描互相打架
          if (Math.abs(old.w - r.w) > 1 || Math.abs(old.h - r.h) > 1) {
            this.rects.set(id, { ...old, w: r.w, h: r.h })
            bumpCard()
            changed = true
            if (r.w >= 8 && r.h >= 8) sizeChanges.push({ id, w: r.w, h: r.h })
          }
          continue
        }
        if (old.x !== r.x || old.y !== r.y || old.w !== r.w || old.h !== r.h) {
          this.rects.set(id, r)
          bumpCard()
          changed = true
        }
        if (Math.abs(old.w - r.w) > 1 || Math.abs(old.h - r.h) > 1) {
          if (r.w >= 8 && r.h >= 8) sizeChanges.push({ id, w: r.w, h: r.h })
        }
      }
    }
    if (this.rects.size !== seen.size) {
      for (const id of [...this.rects.keys()]) {
        if (!seen.has(id)) {
          this.rects.delete(id)
          this.rectVersions.delete(id)
        }
      }
      changed = true
    }
    if (sizeChanges.length && this.sizeListener) {
      sizeChanges.forEach(c => this.sizeListener?.(c.id, c.w, c.h))
    }
    if (changed) {
      this.version += 1
      this.versionListeners.forEach(fn => fn())
    }
  }
}

/**
 * 视口探测(第三批内存优化): 维护「屏幕视口 ↔ 画布坐标」的可见矩形。
 * 舞台渲染期用 hintViewport 静默同步最新视图(平移快速路径不提交状态, 视图值可能新于 React);
 * 只有视口尺寸变化(窗口/侧栏开合)才 bump 版本号通知——视图提交本身已触发舞台渲染, 不重复通知。
 * 卡片两级挂载 / 连线裁剪 / 近场预热都读它: 视口外只挂轻量壳, 不挂图片、视频与节点内嵌内容。
 */
export type ViewBounds = { x: number; y: number; w: number; h: number }
type ViewportLike = { x: number; y: number; scale: number }

export class ViewportProbe {
  private stage: HTMLElement | null = null
  private ro: ResizeObserver | null = null
  private listeners = new Set<() => void>()
  private vp: ViewportLike = { x: 0, y: 0, scale: 1 }
  private view = { w: 0, h: 0 }
  private rafId = 0
  version = 0

  /** 渲染期调用: 静默把最新视图写进探测源, 不通知(本次渲染本就由它引起) */
  hintViewport(vp: ViewportLike) {
    this.vp = { x: vp.x, y: vp.y, scale: vp.scale }
  }

  attach(stage: HTMLElement, vp: ViewportLike) {
    this.stage = stage
    this.vp = { ...vp }
    this.measure()
    if (typeof ResizeObserver !== 'undefined') {
      // 通知统一推迟到下一帧合并: RO 回调内同步 bump 会立刻引起 React 提交、
      // 同帧再次改变元素尺寸, 触发「ResizeObserver loop」良性错误。
      this.ro = new ResizeObserver(() => {
        this.measure()
        this.scheduleBump()
      })
      this.ro.observe(stage)
    }
    // 首次挂载 view 还是 0, 通知一次让舞台按真实视口重算近场集合
    this.bump()
  }

  private scheduleBump() {
    if (this.rafId) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0
      this.bump()
    })
  }

  detach() {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.ro?.disconnect()
    this.ro = null
    this.stage = null
    this.view = { w: 0, h: 0 }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private measure() {
    if (this.stage) this.view = { w: this.stage.clientWidth || 0, h: this.stage.clientHeight || 0 }
  }

  private bump() {
    this.version += 1
    this.listeners.forEach(fn => fn())
  }

  /**
   * 画布坐标系下的可见矩形, marginRatio 为视口尺寸的外扩比例
   * (0.5 = 四周各扩半个视口, 平移时近场卡提前挂载, 视觉上看不到挂载过程)。
   */
  bounds(marginRatio: number): ViewBounds {
    const padX = marginRatio * this.view.w
    const padY = marginRatio * this.view.h
    const s = this.vp.scale || 1
    return {
      x: (-padX - this.vp.x) / s,
      y: (-padY - this.vp.y) / s,
      w: (this.view.w + padX * 2) / s,
      h: (this.view.h + padY * 2) / s,
    }
  }
}

const CanvasVmContext = createContext<{ current: CanvasVm } | null>(null)

export function CanvasRuntimeProvider({ vm, children }: { vm: CanvasVm; children: ReactNode }) {
  // 上下文值是稳定的 ref 对象, 卡片组件读到的永远是最新 vm, 但上下文本身永不触发消费者重渲染
  const ref = useRef<CanvasVm>(vm)
  // 这里是画布隔离渲染的性能边界: 上下文值保持稳定, 仅在重渲染时转发最新 vm。
  // eslint-disable-next-line react-hooks/refs
  ref.current = vm
  return <CanvasVmContext.Provider value={ref}>{children}</CanvasVmContext.Provider>
}

/** 取最新画布视图模型; 注意它不订阅变化, 组件只在自己 props 变化时重渲染并读到最新值 */
export function useCanvasVm(): CanvasVm {
  const ctx = useContext(CanvasVmContext)
  if (!ctx) throw new Error('CanvasVmContext missing')
  return ctx.current
}
