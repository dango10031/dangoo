import { describe, it, expect } from 'vitest'
import {
  classifyMediaUploadError,
  runMediaUploadBatch,
  runSingleMediaUpload,
  MediaUploadRegistry,
  type MediaUploadItem,
  type MediaUploadDeps,
} from './canvasMediaUpload'

function makeFile(name: string): File {
  // jsdom File 可用; 内容不重要, 假上传器不读
  return new File(['x'], name, { type: 'image/png' })
}

interface Meta {
  localUrl: string
}
function item(i: number, canvasId = 'cv1'): MediaUploadItem<Meta> {
  return { canvasId, cardId: `c${i}`, file: makeFile(`f${i}.png`), fileType: 'image', meta: { localUrl: `blob:${i}` } }
}

/** 假上传器: 记录在途峰值, 按 cardId 决定成败/延迟 */
interface FakeUploader {
  deps: Pick<MediaUploadDeps<Meta>, 'uploadOne'>
  active: number
  peak: number
  order: string[]
  release: () => void
  failStatusFor: (cardId: string) => number | null
}

function makeUploader(opts?: { fail?: Record<string, number>; gate?: boolean }): FakeUploader {
  const f: FakeUploader = {
    active: 0,
    peak: 0,
    order: [],
    release: () => {},
    failStatusFor: cardId => opts?.fail?.[cardId] ?? null,
    deps: {
      uploadOne: (file, fileType) =>
        new Promise<string>((resolve, reject) => {
          void file
          void fileType
          f.active += 1
          f.peak = Math.max(f.peak, f.active)
          const cardId = `c${Number((file as File).name.replace(/\D/g, ''))}`
          const finish = () => {
            f.active -= 1
            f.order.push(cardId)
            const status = f.failStatusFor(cardId)
            if (status != null) reject(Object.assign(new Error('up'), { status }))
            else resolve(`/api/files/media_files/${cardId}.png`)
          }
          if (opts?.gate) {
            const prev = f.release
            f.release = () => {
              prev()
              finish()
            }
          } else {
            // 微任务延迟, 保证并发 worker 能同时占用槽位
            queueMicrotask(finish)
          }
        }),
    },
  }
  return f
}

describe('classifyMediaUploadError', () => {
  it('412/401 算登录失效', () => {
    expect(classifyMediaUploadError({ status: 412 })).toBe('login')
    expect(classifyMediaUploadError(Object.assign(new Error('x'), { status: 401 }))).toBe('login')
  })
  it('其它状态码与无状态错误算普通失败', () => {
    expect(classifyMediaUploadError({ status: 500 })).toBe('failed')
    expect(classifyMediaUploadError(new Error('network'))).toBe('failed')
    expect(classifyMediaUploadError(null)).toBe('failed')
  })
})

describe('runMediaUploadBatch', () => {
  it('全部成功: 计数与结果顺序与入参一致', async () => {
    const up = makeUploader()
    const okUrls: string[] = []
    const res = await runMediaUploadBatch([item(1), item(2), item(3)], 3, {
      ...up.deps,
      onItemSuccess: (it, url) => okUrls.push(`${it.cardId}=${url}`),
    })
    expect(res.okCount).toBe(3)
    expect(res.loginBlocked).toBe(false)
    expect(res.outcomes.map(o => o.item.cardId)).toEqual(['c1', 'c2', 'c3'])
    expect(res.outcomes.every(o => o.ok)).toBe(true)
    expect(okUrls).toContain('c1=/api/files/media_files/c1.png')
  })

  it('图片三路并发: 同时在途峰值为 3, 单张失败不拖慢其它', async () => {
    const up = makeUploader({ fail: { c2: 412 } })
    const errors: string[] = []
    const res = await runMediaUploadBatch([item(1), item(2), item(3), item(4), item(5)], 3, {
      ...up.deps,
      onItemError: (it, kind) => errors.push(`${it.cardId}:${kind}`),
    })
    expect(up.peak).toBe(3)
    expect(res.okCount).toBe(4)
    expect(res.loginBlocked).toBe(true)
    expect(errors).toEqual(['c2:login'])
    const failed = res.outcomes.find(o => o.item.cardId === 'c2')
    expect(failed?.ok).toBe(false)
    if (failed?.ok === false) expect(failed.kind).toBe('login')
  })

  it('视频串行: 同时在途峰值为 1', async () => {
    const up = makeUploader({ fail: { c3: 500 } })
    const res = await runMediaUploadBatch([item(1), item(2), item(3)], 1, up.deps)
    expect(up.peak).toBe(1)
    expect(res.okCount).toBe(2)
    expect(res.loginBlocked).toBe(false)
    const failed = res.outcomes.find(o => o.item.cardId === 'c3')
    if (failed?.ok === false) expect(failed.kind).toBe('failed')
  })

  it('concurrency 非正值兜底为 1, 空数组立即返回', async () => {
    const up = makeUploader()
    await runMediaUploadBatch([item(1)], 0, up.deps)
    expect(up.peak).toBe(1)
    const empty = await runMediaUploadBatch<Meta>([], 3, makeUploader().deps)
    expect(empty.okCount).toBe(0)
    expect(empty.outcomes).toEqual([])
  })

  it('单张失败时本地预览元信息仍随结果回传, 便于装配层回收 blob', async () => {
    const up = makeUploader({ fail: { c1: 502 } })
    const revoked: string[] = []
    await runMediaUploadBatch([item(1)], 1, {
      ...up.deps,
      onItemError: it => revoked.push(it.meta.localUrl),
    })
    expect(revoked).toEqual(['blob:1'])
  })

  it('多项分属不同画布时归属画布随结果原样回传', async () => {
    const up = makeUploader()
    const owners: string[] = []
    await runMediaUploadBatch([item(1, 'A'), item(2, 'B')], 2, {
      ...up.deps,
      onItemSuccess: it => owners.push(it.canvasId),
    })
    expect(owners.sort()).toEqual(['A', 'B'])
  })
})

describe('MediaUploadRegistry', () => {
  it('begin/end 记账, 同 key 重复 begin 引用计数且不覆盖归属', () => {
    const r = new MediaUploadRegistry()
    expect(r.begin('k1', 'A')).toBe(true)
    expect(r.begin('k1', 'B')).toBe(false)
    expect(r.ownerOf('k1')).toBe('A')
    expect(r.size).toBe(1)
    expect(r.canvasInflight('A')).toBe(true)
    expect(r.canvasInflight('B')).toBe(false)
    // 第一笔结束: 仍有一笔在途, 归属保留
    expect(r.end('k1')).toBe(false)
    expect(r.ownerOf('k1')).toBe('A')
    expect(r.keyInflight('k1')).toBe(true)
    // 最后一笔结束才注销
    expect(r.end('k1')).toBe(true)
    expect(r.ownerOf('k1')).toBeUndefined()
    expect(r.canvasInflight('A')).toBe(false)
  })

  it('同一张卡连续两笔上传交错完成: 先结束的一笔不得提前注销在途态', () => {
    const r = new MediaUploadRegistry()
    r.begin('card:op:1', 'A')
    r.begin('card:op:2', 'A')
    expect(r.size).toBe(2)
    expect(r.end('card:op:1')).toBe(true)
    expect(r.keyInflight('card:op:2')).toBe(true)
    expect(r.canvasInflight('A')).toBe(true)
    expect(r.end('card:op:2')).toBe(true)
    expect(r.canvasInflight('A')).toBe(false)
  })

  it('endByPrefix 注销同一卡片带操作号的全部在途登记', () => {
    const r = new MediaUploadRegistry()
    r.begin('card1', 'A')
    r.begin('card1:node-img:7', 'A')
    r.begin('card1:node-img:8', 'A')
    r.begin('card2:node-img:1', 'A')
    r.endByPrefix('card1:')
    expect(r.keyInflight('card1:node-img:7')).toBe(false)
    expect(r.keyInflight('card1:node-img:8')).toBe(false)
    // 裸 key 与其它卡片不受影响
    expect(r.keyInflight('card1')).toBe(true)
    expect(r.keyInflight('card2:node-img:1')).toBe(true)
  })

  it('同画布多笔在途全部注销才算空闲; end 未知 key 无副作用', () => {
    const r = new MediaUploadRegistry()
    r.begin('a', 'A')
    r.begin('b', 'A')
    r.begin('c', 'B')
    expect(r.size).toBe(3)
    r.end('a')
    expect(r.canvasInflight('A')).toBe(true)
    r.end('b')
    expect(r.canvasInflight('A')).toBe(false)
    expect(() => r.end('zzz')).not.toThrow()
    r.clear()
    expect(r.size).toBe(0)
  })
})

describe('runSingleMediaUpload', () => {
  interface Local { localUrl: string }
  const file = makeFile('a.png')

  /** 可手动触发的回收定时器时钟 */
  function makeClock(): { timers: Array<() => void>; setTimeout: (fn: () => void) => unknown } {
    const timers: Array<() => void> = []
    return { timers, setTimeout: fn => { timers.push(fn); return 0 } }
  }

  function trace(upload: () => Promise<string>, alive = true) {
    const log: string[] = []
    const clock = makeClock()
    const run = runSingleMediaUpload<Local>(file, 'image', { localUrl: 'blob:1' }, {
      uploadOne: upload,
      isAlive: () => alive,
      onLocal: local => log.push(`local:${local.localUrl}`),
      onFinal: (url, local) => log.push(`final:${local.localUrl}->${url}`),
      onError: (kind, local) => log.push(`error:${kind}:${local.localUrl}`),
      revokePreview: local => log.push(`revoke:${local.localUrl}`),
      revokeDelayMs: 5000,
      clock,
    })
    return { run, log, clock }
  }

  it('成功: 本地预览 → 卡片仍在 → 永久链接, 回收延迟一拍', async () => {
    const t = trace(() => Promise.resolve('/api/files/x.png'))
    await t.run
    expect(t.log).toContain('local:blob:1')
    expect(t.log).toContain('final:blob:1->/api/files/x.png')
    // 回收已排队但未触发
    expect(t.log).not.toContain('revoke:blob:1')
    expect(t.clock.timers).toHaveLength(1)
    t.clock.timers[0]()
    expect(t.log).toContain('revoke:blob:1')
  })

  it('上传期间卡片消失: 不回写永久链接也不报错, 仍回收本地预览', async () => {
    const t = trace(() => Promise.resolve('/api/files/x.png'), false)
    await t.run
    expect(t.log).toContain('local:blob:1')
    expect(t.log.some(l => l.startsWith('final'))).toBe(false)
    expect(t.log.some(l => l.startsWith('error'))).toBe(false)
    t.clock.timers[0]()
    expect(t.log).toContain('revoke:blob:1')
  })

  it('412 归登录失效、500 归普通失败, 都回收且函数不 reject', async () => {
    const login = trace(() => Promise.reject(Object.assign(new Error('login'), { status: 412 })))
    await login.run
    expect(login.log).toContain('error:login:blob:1')
    login.clock.timers[0]()
    expect(login.log).toContain('revoke:blob:1')

    const failed = trace(() => Promise.reject(new Error('boom')))
    await failed.run
    expect(failed.log).toContain('error:failed:blob:1')
  })

  it('fileType 透传给上传器', async () => {
    const seen: string[] = []
    await runSingleMediaUpload<Local>(file, 'audio', { localUrl: 'b' }, {
      uploadOne: (_f, t) => { seen.push(t); return Promise.resolve('/a.mp3') },
      isAlive: () => true,
      onLocal: () => {},
      onFinal: () => {},
      onError: () => {},
    })
    expect(seen).toEqual(['audio'])
  })
})
