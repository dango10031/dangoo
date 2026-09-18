// 画布媒体「上传生命周期」的框架无关内核。
// 接管原先散在 useCanvas 图片/视频批量上传里的重复编排:
// 受控并发(图片 3 路 Safari 连接限制 / 视频串行)、逐张结果确认、登录失效识别、
// 归属画布记账(切走后回来的结果仍落回原画布)。
//
// 本文件不碰 React / DOM(本地预览 URL 的创建与回收、toast、状态写回均由装配层注入),
// 不直接 fetch——真正的上传(压缩/鉴权/计数)经 deps.uploadOne 注入, 生产传 lib/media 的 persistMedia。
// 控制器只规定「按什么顺序传、传完确认给谁、整批何时收尾」。

/** 一个上传项失败后的归一化原因 */
export type MediaUploadErrorKind = 'login' | 'failed'

/** 上传类异常的统一识别: 412/401 一律算登录失效(后端在未登录时抛 412), 其余算普通失败 */
export function classifyMediaUploadError(err: unknown): MediaUploadErrorKind {
  const status = (err as { status?: number } | null)?.status
  return status === 412 || status === 401 ? 'login' : 'failed'
}

/** 批量入参: 每项带归属画布(切画布后结果仍落回它)与装配层透传的本地预览信息 */
export interface MediaUploadItem<TMeta> {
  /** 发起上传时所在画布; 完成确认时原样回传, 装配层据此把结果落回正确画布 */
  canvasId: string
  /** 卡片 id, 装配层据此写回对应卡片 */
  cardId: string
  file: File
  /** 'image' 走应用图片压缩链, 'video'/'audio' 不压缩 */
  fileType: 'image' | 'video' | 'audio'
  /** 装配层私有数据(本地 blob URL 等), 内核原样回传 */
  meta: TMeta
}

export type MediaItemOutcome<TMeta> =
  | { ok: true; url: string; item: MediaUploadItem<TMeta> }
  | { ok: false; kind: MediaUploadErrorKind; item: MediaUploadItem<TMeta> }

/** 批量汇总结果 */
export interface MediaBatchResult<TMeta> {
  outcomes: MediaItemOutcome<TMeta>[]
  /** 成功张数 */
  okCount: number
  /** 是否至少一张因登录失效失败(装配层据此弹登录框, 只弹一次) */
  loginBlocked: boolean
}

export interface MediaUploadDeps<TMeta> {
  /** 真正上传一个文件, 返回环境无关裸路径; 失败抛出(带 status 412 表示需登录) */
  uploadOne: (file: File, fileType: MediaUploadItem<TMeta>['fileType']) => Promise<string>
  /** 单张成功(永久链接到手, 本地预览 URL 由装配层在此回收) */
  onItemSuccess?: (item: MediaUploadItem<TMeta>, url: string) => void
  /** 单张失败(装配层标红卡片、回收本地预览 URL) */
  onItemError?: (item: MediaUploadItem<TMeta>, kind: MediaUploadErrorKind) => void
}

/**
 * 受控并发跑完整批上传, 单张失败只标记该张, 不拖慢其它项。
 * concurrency<=0 按 1 串行; 任何一张抛出都在 worker 内部消化, 本函数本身不 reject。
 */
export async function runMediaUploadBatch<TMeta>(
  items: MediaUploadItem<TMeta>[],
  concurrency: number,
  deps: MediaUploadDeps<TMeta>,
): Promise<MediaBatchResult<TMeta>> {
  const outcomes: MediaItemOutcome<TMeta>[] = new Array(items.length)
  let cursor = 0
  let okCount = 0
  let loginBlocked = false

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const item = items[index]
      try {
        const url = await deps.uploadOne(item.file, item.fileType)
        okCount += 1
        outcomes[index] = { ok: true, url, item }
        deps.onItemSuccess?.(item, url)
      } catch (err) {
        const kind = classifyMediaUploadError(err)
        if (kind === 'login') loginBlocked = true
        outcomes[index] = { ok: false, kind, item }
        deps.onItemError?.(item, kind)
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return { outcomes, okCount, loginBlocked }
}

/**
 * 单文件媒体上传的完整生命周期回调。配音/动作迁移/高清修复等节点的
 * 「本地预览 → 上传 → 卡片仍存在才回写永久链接 → 成败都延迟回收 blob」
 * 流程完全同构, 差异仅在校验与字段映射(留在调用方), 统一走 runSingleMediaUpload。
 */
export interface SingleMediaUploadHandlers<TLocal> {
  /** 真正上传(生产传 lib/media 的 persistMedia) */
  uploadOne: (file: File, fileType: MediaUploadItem<unknown>['fileType']) => Promise<string>
  /** 成功回来时卡片/节点是否仍存在: 切画布/删除后为 false 则丢弃回写(不报错) */
  isAlive: () => boolean
  /** 本地预览态落卡(blob: 链接即时可见) */
  onLocal: (local: TLocal) => void
  /** 上传成功且卡片仍在: 落永久链接 */
  onFinal: (url: string, local: TLocal) => void
  /** 失败(含登录失效): 调用方按 kind 弹登录/提示并重置本地态 */
  onError: (kind: MediaUploadErrorKind, local: TLocal) => void
  /** 回收本地预览 URL(成败都延迟调, 等视图切到永久地址) */
  revokePreview?: (local: TLocal) => void
  /** 回收延迟毫秒, 默认 5000 */
  revokeDelayMs?: number
  /** 注入时钟(测试用); 默认浏览器定时器 */
  clock?: { setTimeout: (fn: () => void, ms: number) => unknown }
}

/**
 * 跑一个单文件上传生命周期, 永不 reject(所有失败经 onError 归一化):
 * 先落本地预览 → 上传 → 成功且 isAlive 才 onFinal; 412/401 归 login, 其余归 failed;
 * 成功(含卡片已消失)与失败都安排一次延迟回收。
 */
export async function runSingleMediaUpload<TLocal>(
  file: File,
  fileType: MediaUploadItem<unknown>['fileType'],
  local: TLocal,
  handlers: SingleMediaUploadHandlers<TLocal>,
): Promise<void> {
  const timerClock = handlers.clock ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) }
  const delay = handlers.revokeDelayMs ?? 5000
  const scheduleRevoke = () => {
    if (handlers.revokePreview) {
      const preview = handlers.revokePreview
      timerClock.setTimeout(() => preview(local), delay)
    }
  }
  handlers.onLocal(local)
  try {
    const url = await handlers.uploadOne(file, fileType)
    if (!handlers.isAlive()) {
      // 上传期间卡片被删或已切到别的画布: 永久链接无处可写, 静默丢弃, 只回收本地预览
      scheduleRevoke()
      return
    }
    handlers.onFinal(url, local)
    scheduleRevoke()
  } catch (err) {
    handlers.onError(classifyMediaUploadError(err), local)
    scheduleRevoke()
  }
}

interface RegistryEntry {
  canvasId: string
  /** 同一逻辑键(通常是 cardId)上并发的在途上传笔数; 全部结束才算该键空闲 */
  refs: number
}

/**
 * 在途上传的「归属画布」记账表(框架无关)。
 * 全局传输计数(lib/media)只回答「有没有东西在传」(关页拦截用),
 * 本表回答「哪些画布有上传没回来」: 切走 A 后 A 的上传回来时仍可落回 A,
 * 切回 A 或 A 被卸载时也能知道它是否还有未确认媒体。
 * key 由装配层定义(通常 cardId), 与 canvasId 多对一。
 * 同一 key 支持多笔并发上传(同一张卡连续换图): 引用计数, 先结束的一笔不能
 * 提前注销后一笔的在途状态。需要区分具体某一笔时, 装配层用 cardId:opId 作 key。
 */
export class MediaUploadRegistry {
  private readonly entryByKey = new Map<string, RegistryEntry>()

  /**
   * 登记一笔在途上传(同 key 引用计数 +1, 不覆盖已有归属);
   * 返回该键是否从空闲变为在途(第一笔)。
   */
  begin(key: string, canvasId: string): boolean {
    const existing = this.entryByKey.get(key)
    if (existing) {
      existing.refs += 1
      return false
    }
    this.entryByKey.set(key, { canvasId, refs: 1 })
    return true
  }

  /**
   * 一笔上传终态(成功/失败/放弃): 引用计数 -1, 仅最后一笔结束时才注销归属。
   * 返回注销后该键是否已无在途上传。
   */
  end(key: string): boolean {
    const existing = this.entryByKey.get(key)
    if (!existing) return true
    existing.refs -= 1
    if (existing.refs > 0) return false
    this.entryByKey.delete(key)
    return true
  }

  /** 注销键以 prefix 开头的全部在途上传(如删卡时清掉该卡 cardId:opId 形式的多笔登记) */
  endByPrefix(prefix: string): void {
    for (const key of Array.from(this.entryByKey.keys())) {
      if (key.startsWith(prefix)) this.entryByKey.delete(key)
    }
  }

  /** 某笔上传归属的画布(已全部注销返回 undefined) */
  ownerOf(key: string): string | undefined {
    return this.entryByKey.get(key)?.canvasId
  }

  /** 指定逻辑键是否仍有在途上传(交错完成时第一笔结束不应清掉第二笔) */
  keyInflight(key: string): boolean {
    return this.entryByKey.has(key)
  }

  /** 指定画布是否还有在途上传(切画布/卸载前判定) */
  canvasInflight(canvasId: string): boolean {
    for (const entry of this.entryByKey.values()) {
      if (entry.canvasId === canvasId) return true
    }
    return false
  }

  /** 全局在途逻辑键数(主要供测试与诊断; 关页拦截仍以 lib/media 传输计数为准) */
  get size(): number {
    return this.entryByKey.size
  }

  clear(): void {
    this.entryByKey.clear()
  }
}
