/**
 * 画布本地兜底快照(IndexedDB):
 * 每笔云端保存在发送前把当时最新全量快照写一份到本地, 云端确认成功后删除。
 * 浏览器崩溃 / 强杀进程 / 断网关机时, 防抖窗口与在途失败的内容仍能在下次打开时恢复。
 * 所有方法永不抛错——本地库不可用(隐私模式 / 配额满)时静默失败, 不影响内存与云端链路。
 */

export interface LocalCanvasSnapshot {
  /** 快照所基于的服务端版本号, 恢复时用于判断云端是否已被别处更新 */
  rev: number
  title: string
  /** 与 PATCH 全量体一致的画布文档(cards/connections/view/pendingJobs/projectAssets/logs) */
  doc: Record<string, unknown>
  savedAt: number
  /** 写下这份快照的浏览器会话标识, 启动恢复时用来识别「本会话之前的标签页」 */
  sessionId: string
  /**
   * 这份快照内容的文档修改序号(装配层单调递增): 云端确认某一序号后,
   * 只能删除「仍是同一序号」的快照; 序号已推进说明盘上是更新的内容, 不能删。
   */
  docSeq?: number
}

const DB_NAME = 'vibex-canvas'
const DB_VERSION = 1
const STORE_SNAPSHOTS = 'local_snapshots'
const STORE_BACKUPS = 'conflict_backups'
const SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>(resolve => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) db.createObjectStore(STORE_SNAPSHOTS)
      if (!db.objectStoreNames.contains(STORE_BACKUPS)) db.createObjectStore(STORE_BACKUPS)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    // 个别浏览器隐私模式下 open 直接阻塞/拒绝, 兜底
    setTimeout(() => resolve(null), 2500)
  }).then(db => {
    // onsuccess 与超时兜底可能竞态: 只认第一个 resolve, 这里不重复处理
    return db
  })
  return dbPromise
}

function tx<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(db => new Promise<T | null>(resolve => {
    if (!db) {
      resolve(null)
      return
    }
    let t: IDBTransaction
    try {
      t = db.transaction(storeName, mode)
    } catch {
      resolve(null)
      return
    }
    let req: IDBRequest<T>
    try {
      req = fn(t.objectStore(storeName))
    } catch {
      resolve(null)
      return
    }
    let settled = false
    // 读操作以请求成功为准; 事务中止/失败(配额满等)优先翻成 null,
    // 不能只看 req.onsuccess —— put/delete 的请求即使随后事务 abort 也可能先回调成功。
    const finish = (v: T | null) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    req.onsuccess = () => finish(req.result)
    req.onerror = () => finish(null)
    // 事务异常(配额满等)同样走 null, 不阻塞主流程
    t.onerror = () => finish(null)
    t.onabort = () => finish(null)
  }))
}

function key(canvasId: string, sessionId: string) {
  return `${canvasId}::${sessionId}`
}

/** 以事务完成为准执行一次写操作(put/delete 的 result 恒为 undefined, 不能拿它判断成败) */
function txDone(storeName: string, run: (store: IDBObjectStore) => void): Promise<boolean> {
  return openDb().then(db => new Promise<boolean>(resolve => {
    if (!db) {
      resolve(false)
      return
    }
    let t: IDBTransaction
    try {
      t = db.transaction(storeName, 'readwrite')
    } catch {
      resolve(false)
      return
    }
    try {
      run(t.objectStore(storeName))
    } catch {
      resolve(false)
      return
    }
    t.oncomplete = () => resolve(true)
    t.onerror = () => resolve(false)
    t.onabort = () => resolve(false)
  }))
}

/** 写下/覆盖一份待同步快照; 返回是否真正落盘(失败时保存状态不能显示「本地已存」) */
export function putLocalSnapshot(canvasId: string, sessionId: string, snap: LocalCanvasSnapshot): Promise<boolean> {
  return txDone(STORE_SNAPSHOTS, store => store.put(snap, key(canvasId, sessionId)))
}

/**
 * 云端确认某一序号的保存成功后, 是否允许删除当前盘上快照(纯裁决, 便于在无 IDB 的
 * node 单测里锁定竞态语义):
 * - 云端笔没带序号(卸载抢发等无号笔): 不参与带号快照的版本管理, 允许;
 * - 盘上无快照: 允许(本就是 no-op);
 * - 盘上快照无序号: 只能被它自己的覆盖/恢复流程消化, 带号旧确认不得删, 拒绝;
 * - 序号全等: 云端确认的就是盘上这一版, 允许;
 * - 盘上序号更新(旧请求晚成功, 期间已有新编辑写入新快照): 拒绝, 保住最新内容的唯一兜底。
 */
export function shouldClearSnapshotForSeq(
  expectDocSeq: number | undefined,
  gotSeq: number | undefined,
): boolean {
  if (expectDocSeq === undefined) return true
  return gotSeq === expectDocSeq
}

/**
 * 云端确认保存成功后清掉这份快照。
 * 传入 expectDocSeq 时: 只有盘上快照仍是该序号才删除——旧请求晚成功时, 盘上快照
 * 可能已被更新的内容覆盖, 删掉会让最新内容失去兜底。
 */
export async function clearLocalSnapshot(
  canvasId: string,
  sessionId: string,
  expectDocSeq?: number,
): Promise<{ deleted: boolean; seq?: number }> {
  const db = await openDb()
  if (!db) return { deleted: false }
  const k = key(canvasId, sessionId)
  const got = await new Promise<LocalCanvasSnapshot | null>(resolve => {
    let t: IDBTransaction
    try {
      t = db.transaction(STORE_SNAPSHOTS, 'readonly')
    } catch {
      resolve(null)
      return
    }
    const req = t.objectStore(STORE_SNAPSHOTS).get(k)
    req.onsuccess = () => resolve((req.result as LocalCanvasSnapshot | undefined) ?? null)
    req.onerror = () => resolve(null)
  })
  if (!got) return { deleted: false }
  // 序号全等才删: 旧请求晚成功时盘上可能已被更新序号的快照覆盖;
  // 盘上是无号快照(卸载即时落盘)而本笔有号时也不删, 无号快照只能被它自己的覆盖/恢复流程消化。
  if (!shouldClearSnapshotForSeq(expectDocSeq, got.docSeq)) {
    return { deleted: false, seq: got.docSeq }
  }
  const deleted = await txDone(STORE_SNAPSHOTS, store => store.delete(k))
  return { deleted, seq: got.docSeq }
}

/**
 * 崩溃恢复接管: 把旧会话键下的快照原样复制(改写会话键)到当前会话键, 以事务完成为准。
 * 调用方只有在返回 true 后才允许删除旧快照, 保证任何时刻至少有一份兜底。
 */
export function copySnapshotToSession(
  canvasId: string,
  fromSessionId: string,
  toSessionId: string,
): Promise<boolean> {
  return openDb().then(db => new Promise<boolean>(resolve => {
    if (!db) {
      resolve(false)
      return
    }
    let t: IDBTransaction
    try {
      t = db.transaction(STORE_SNAPSHOTS, 'readwrite')
    } catch {
      resolve(false)
      return
    }
    const store = t.objectStore(STORE_SNAPSHOTS)
    const getReq = store.get(key(canvasId, fromSessionId))
    getReq.onsuccess = () => {
      const snap = getReq.result as LocalCanvasSnapshot | undefined
      if (!snap) {
        resolve(false)
        return
      }
      try {
        store.put({ ...snap, sessionId: toSessionId }, key(canvasId, toSessionId))
      } catch {
        resolve(false)
      }
    }
    getReq.onerror = () => resolve(false)
    t.oncomplete = () => resolve(true)
    t.onerror = () => resolve(false)
    t.onabort = () => resolve(false)
  }))
}

/**
 * 从某画布的全部快照主键里筛出「非当前会话」的快照键(纯裁决):
 * 多标签同开时各标签会话标识不同、各写各的键, 互不覆盖;
 * 本标签只把「别的会话」留下的快照当作崩溃恢复候选, 绝不挑自己的键。
 * 第二个返回值是解析出的来源会话标识, 与快照一一对应(顺序与入参一致)。
 */
export function partitionStaleSnapshotKeys(
  allKeys: readonly IDBValidKey[],
  canvasId: string,
  currentSessionId: string,
): { key: IDBValidKey; originSessionId: string }[] {
  const prefix = `${canvasId}::`
  const out: { key: IDBValidKey; originSessionId: string }[] = []
  for (const k of allKeys) {
    const ks = String(k)
    if (!ks.startsWith(prefix)) continue
    const originSessionId = ks.slice(prefix.length)
    if (originSessionId === currentSessionId) continue
    out.push({ key: k, originSessionId })
  }
  return out
}

/** 某个画布里、非当前会话留下的快照(崩溃/异常关闭的标签页才有), 含主键解析出的会话标识 */
export interface StaleSnapshot extends LocalCanvasSnapshot {
  originSessionId: string
}

export async function listStaleSnapshots(canvasId: string, currentSessionId: string): Promise<StaleSnapshot[]> {
  const db = await openDb()
  if (!db) return []
  const all = await new Promise<IDBValidKey[]>(resolve => {
    let t: IDBTransaction
    try {
      t = db.transaction(STORE_SNAPSHOTS, 'readonly')
    } catch {
      resolve([])
      return
    }
    const req = t.objectStore(STORE_SNAPSHOTS).getAllKeys()
    req.onsuccess = () => resolve(req.result ?? [])
    req.onerror = () => resolve([])
  })
  const staleKeys = partitionStaleSnapshotKeys(all, canvasId, currentSessionId)
  const out: StaleSnapshot[] = []
  for (const { key: k, originSessionId } of staleKeys) {
    const snap = await tx<LocalCanvasSnapshot>(STORE_SNAPSHOTS, 'readonly', store => store.get(k))
    if (snap && typeof snap.savedAt === 'number') out.push({ ...snap, originSessionId })
  }
  // 最近写入的优先(极端情况下同一画布有多个崩溃标签页的快照)
  return out.sort((a, b) => b.savedAt - a.savedAt)
}

export function deleteStaleSnapshot(canvasId: string, originSessionId: string): Promise<void> {
  return tx(STORE_SNAPSHOTS, 'readwrite', store => store.delete(key(canvasId, originSessionId))).then(() => undefined)
}

/** 启动时顺手清掉超过保留期的快照, 防止长期占空间 */
export async function pruneExpiredSnapshots(now: number): Promise<void> {
  const db = await openDb()
  if (!db) return
  const keys = await new Promise<IDBValidKey[]>(resolve => {
    let t: IDBTransaction
    try {
      t = db.transaction(STORE_SNAPSHOTS, 'readonly')
    } catch {
      resolve([])
      return
    }
    const req = t.objectStore(STORE_SNAPSHOTS).getAllKeys()
    req.onsuccess = () => resolve(req.result ?? [])
    req.onerror = () => resolve([])
  })
  for (const k of keys) {
    const snap = await tx<LocalCanvasSnapshot>(STORE_SNAPSHOTS, 'readonly', store => store.get(k))
    if (snap && now - snap.savedAt > SNAPSHOT_TTL_MS) {
      await tx(STORE_SNAPSHOTS, 'readwrite', store => store.delete(k))
    }
  }
}

/* ---------------- 冲突选择撤销备份(只保留最近一次) ---------------- */

export interface ConflictBackup extends LocalCanvasSnapshot {
  serverRev: number
  backedAt: number
}

/**
 * 写下冲突选择前的本地备份; 以事务 oncomplete 为准返回是否真正落盘。
 * 上层只有在 true 时才允许丢弃本地待发内容 —— tx 的请求 onsuccess 之后事务
 * 仍可能因配额/中止失败, 不能拿「没抛异常」当备份成功。
 */
export function putConflictBackup(canvasId: string, backup: ConflictBackup): Promise<boolean> {
  return txDone(STORE_BACKUPS, store => store.put(backup, canvasId))
}

export function takeConflictBackup(canvasId: string): Promise<ConflictBackup | null> {
  return openDb().then(db => new Promise<ConflictBackup | null>(resolve => {
    if (!db) {
      resolve(null)
      return
    }
    let t: IDBTransaction
    try {
      t = db.transaction(STORE_BACKUPS, 'readwrite')
    } catch {
      resolve(null)
      return
    }
    const store = t.objectStore(STORE_BACKUPS)
    let done = false
    const finish = (v: ConflictBackup | null) => {
      if (done) return
      done = true
      resolve(v)
    }
    const getReq = store.get(canvasId)
    getReq.onsuccess = () => {
      const got = getReq.result as ConflictBackup | undefined
      // 只在确实取到备份时删除; 删除与读取同一事务, 提交后才算「取回并移除」
      if (got) {
        try {
          store.delete(canvasId)
        } catch {
          finish(null)
        }
      }
      t.oncomplete = () => finish(got ?? null)
    }
    getReq.onerror = () => finish(null)
    t.onerror = () => finish(null)
    t.onabort = () => finish(null)
  }))
}

/* ---------------- 内容指纹: 启动时判断陈旧快照是否真有不同于云端的改动 ---------------- */

function fingerprintValue(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    if (Array.isArray(v)) return '[' + v.map(fingerprintValue).join(',') + ']'
    const obj = v as Record<string, unknown>
    return '{' + Object.keys(obj).sort().map(k => `${k}:${fingerprintValue(obj[k])}`).join(',') + '}'
  }
  return String(v)
}

/** 只比对用户内容(卡片/连线/标题/视角); 任务队列/日志等瞬态字段不参与, 避免无谓打扰 */
export function canvasContentFingerprint(part: {
  title?: string
  doc?: Record<string, unknown>
  cards?: unknown
  connections?: unknown
  view?: unknown
}): string {
  const doc = (part.doc ?? part) as Record<string, unknown>
  return fingerprintValue({
    t: part.title ?? '',
    c: doc.cards ?? part.cards ?? [],
    n: doc.connections ?? part.connections ?? [],
    v: doc.view ?? part.view ?? null,
  })
}
