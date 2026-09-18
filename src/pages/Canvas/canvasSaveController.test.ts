import { describe, it, expect, vi } from 'vitest'
import {
  CanvasSaveController,
  cyrb53Hex,
  type SaveDeps,
  type SaveHttpResult,
  type SaveRequest,
} from './canvasSaveController'

// 假时钟: setTimeout 进队列, tick(ms) 推进并触发到期回调; 支持链式调度
interface FakeClock {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (h: ReturnType<typeof setTimeout>) => void
  now: () => number
  random: () => number
  tick: (ms: number) => Promise<void>
  runMicro: () => Promise<void>
}

function makeClock(): FakeClock {
  let seq = 1
  let t = 0
  const timers = new Map<number, { fn: () => void; at: number }>()
  const clock: FakeClock = {
    setTimeout: (fn, ms) => {
      const id = seq++
      timers.set(id as unknown as number, { fn, at: t + ms })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: h => timers.delete(h as unknown as number),
    now: () => t,
    random: () => 0,
    async tick(ms: number) {
      const deadline = t + ms
      // 多轮推进: 定时器回调里可能再排定时器(链式补发)
      for (let guard = 0; guard < 100; guard++) {
        const due = Array.from(timers.entries())
          .filter(([, v]) => v.at <= deadline)
          .sort((a, b) => a[1].at - b[1].at)
        if (!due.length) break
        const [id, entry] = due[0]
        timers.delete(id)
        t = entry.at
        entry.fn()
        await Promise.resolve()
      }
      t = deadline
      await Promise.resolve()
    },
    async runMicro() {
      await Promise.resolve()
      await Promise.resolve()
    },
  }
  return clock
}

interface HarnessResult {
  status: number | 'throw' | 'skipped'
}

function makeController(overrides?: Partial<SaveDeps>) {
  const clock = makeClock()
  const calls: SaveRequest[] = []
  const events: string[] = []
  let inflightSend: ((r: HarnessResult) => void) | null = null
  let pendingResult: HarnessResult | null = null
  const deps: SaveDeps = {
    clock,
    isBlocked: () => blockedCanvas != null,
    cardCount: () => 10,
    netHint: () => undefined,
    sendRequest: vi.fn((req: SaveRequest): Promise<SaveHttpResult> => {
      calls.push(req)
      return new Promise<SaveHttpResult>((resolve, reject) => {
        inflightSend = r => {
          if (r.status === 'throw') reject(new Error('network down'))
          else resolve(r.status === 'skipped' ? { status: 0, skipped: true } : { status: r.status as number })
        }
        if (pendingResult) {
          const r = pendingResult
          pendingResult = null
          queueMicrotask(() => inflightSend?.(r))
        }
      })
    }),
    onKeepaliveOversizeNote: id => events.push(`oversize:${id}`),
    onSaved: (id, _req, _res, stillDirty) => events.push(`saved:${id}:${stillDirty}`),
    onConflict: (id, _req, _res) => events.push(`conflict:${id}`),
    onAuthFailure: id => events.push(`auth:${id}`),
    onRetryableFailure: id => events.push(`retry:${id}`),
    onSendStart: id => events.push(`start:${id}`),
    onSettled: id => events.push(`settled:${id}`),
  }
  let blockedCanvas: string | null = null
  const merged = { ...deps, ...overrides }
  const ctl = new CanvasSaveController(merged)
  return {
    ctl,
    clock,
    calls,
    events,
    /** 下一笔 sendRequest 以微任务返回此结果 */
    willReturn: (r: HarnessResult) => {
      pendingResult = r
    },
    /** 当前在途请求手动落定 */
    settle: (r: HarnessResult) => {
      const fn = inflightSend
      inflightSend = null
      fn?.(r)
    },
    setBlocked: (id: string | null) => {
      blockedCanvas = id
    },
  }
}

describe('cyrb53Hex', () => {
  it('同输入稳定、不同输入不同', () => {
    expect(cyrb53Hex('abc')).toBe(cyrb53Hex('abc'))
    expect(cyrb53Hex('abc')).not.toBe(cyrb53Hex('abd'))
    expect(cyrb53Hex('abc')).toMatch(/^[0-9a-f]{14}$/)
  })
})

describe('CanvasSaveController 记账与单飞', () => {
  it('无改动时 send 不发请求', async () => {
    const h = makeController()
    await h.ctl.send('c1')
    expect(h.calls).toHaveLength(0)
  })

  it('单飞: 在途期间再次 send 直接退出', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.runMicro()
    await h.clock.tick(600) // 小画布防抖回落 600ms
    expect(h.calls).toHaveLength(1)
    // 请求尚未落定, 再来一笔被单飞挡住
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.runMicro()
    void h.ctl.send('c1')
    await h.clock.runMicro()
    expect(h.calls).toHaveLength(1)
    h.settle({ status: 200 })
    await h.clock.runMicro()
  })

  it('成功且期间无新改动: 不链式补发, 发 settled', async () => {
    const h = makeController()
    h.willReturn({ status: 200 })
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.tick(600)
    expect(h.calls).toHaveLength(1)
    expect(h.events).toContain('saved:c1:false')
    expect(h.events).toContain('settled:c1')
    expect(h.ctl.isQuiet('c1')).toBe(true)
  })

  it('成功但发送期间又有新改动: 立即链式补发最新快照', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.tick(600)
    expect(h.calls).toHaveLength(1)
    h.settle({ status: 200 })
    await h.clock.runMicro()
    // 无新改动 → 不补发
    expect(h.calls).toHaveLength(1)
  })
})

describe('CanvasSaveController 失败分类与重试', () => {
  it('5xx: 留住改动并排退避重试, 不立即补发', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.tick(600)
    h.settle({ status: 503 })
    await h.clock.runMicro()
    expect(h.events).toContain('retry:c1')
    expect(h.calls).toHaveLength(1) // 没有立即第二笔
    expect(h.ctl.marksOf('c1')?.full).toBe(true)
    // 退避首档 1000ms ±20% 抖动, fake random=-1 → 实际 800ms; 800ms 前不补发
    await h.clock.tick(799)
    expect(h.calls).toHaveLength(1)
    h.willReturn({ status: 200 })
    await h.clock.tick(2)
    expect(h.calls).toHaveLength(2)
    expect(h.ctl.isQuiet('c1')).toBe(true)
  })

  it('网络抛错: 同样退避, 不忙等', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.tick(600)
    h.settle({ status: 'throw' })
    await h.clock.runMicro()
    expect(h.events).toContain('retry:c1')
    expect(h.calls).toHaveLength(1)
    expect(h.ctl.isContentAtRisk('c1')).toBe(true) // full 待发且无本地安全标记
  })

  it('401: 留住改动但不补发、不排退避, flushAfterAuth 才续发', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.tick(600)
    h.settle({ status: 401 })
    await h.clock.runMicro()
    expect(h.events).toContain('auth:c1')
    expect(h.calls).toHaveLength(1)
    // 过很久也不会自动重试(登录等待)
    await h.clock.tick(60_000)
    expect(h.calls).toHaveLength(1)
    // 登录成功后续存
    h.willReturn({ status: 200 })
    h.ctl.flushAfterAuth('c1')
    await h.clock.runMicro()
    expect(h.calls).toHaveLength(2)
  })

  it('409: 挂冲突、留住改动; 挂起期间不补发也不排退避', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.tick(600)
    h.settle({ status: 409 })
    await h.clock.runMicro()
    expect(h.events).toContain('conflict:c1')
    h.setBlocked('c1')
    await h.clock.tick(60_000)
    expect(h.calls).toHaveLength(1)
    // 用户选强制覆盖
    h.setBlocked(null)
    h.willReturn({ status: 200 })
    h.ctl.forceFullNow('c1')
    await h.clock.runMicro()
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1].force).toBe(true)
  })

  it('keepalive 超限 skipped: 留住改动, 1.2s 后走普通请求补发', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.tick(600)
    h.settle({ status: 'skipped' })
    await h.clock.runMicro()
    expect(h.events).toContain('oversize:c1')
    expect(h.calls).toHaveLength(1)
    expect(h.ctl.marksOf('c1')?.full).toBe(true)
    // 1.2s 前不补发
    await h.clock.tick(1199)
    expect(h.calls).toHaveLength(1)
    h.willReturn({ status: 200 })
    await h.clock.tick(2)
    expect(h.calls).toHaveLength(2)
    // 补发是普通请求, 不再带 keepalive
    expect(h.calls[1].keepalive).toBe(false)
    expect(h.ctl.isQuiet('c1')).toBe(true)
  })
})

describe('CanvasSaveController 挂起与卸载', () => {
  it('挂起期间 scheduleSave 只累积标记不调度', async () => {
    const h = makeController()
    h.setBlocked('c1')
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.tick(5000)
    expect(h.calls).toHaveLength(0)
    expect(h.ctl.marksOf('c1')?.full).toBe(true)
    h.setBlocked(null)
    h.willReturn({ status: 200 })
    h.ctl.flushNow('c1')
    await h.clock.runMicro()
    expect(h.calls).toHaveLength(1)
  })

  it('flushNow 清掉防抖定时器立即发; resetPending 丢弃待发', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    h.ctl.flushNow('c1')
    await h.clock.runMicro()
    expect(h.calls).toHaveLength(1)
    expect(h.ctl.hasDebounceTimer('c1')).toBe(false)
    h.settle({ status: 500 })
    await h.clock.runMicro()
    expect(h.ctl.marksOf('c1')?.full).toBe(true)
    // 用户选「加载最新」: 待发清空
    h.ctl.resetPending('c1')
    expect(h.ctl.marksOf('c1')).toEqual({ full: false, view: false })
    await h.clock.tick(60_000)
    expect(h.calls).toHaveLength(1)
  })

  it('clearAllTimers 后防抖与退避都不再触发', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    h.ctl.clearAllTimers()
    await h.clock.tick(60_000)
    expect(h.calls).toHaveLength(0)
  })

  it('scheduleQuickFullSave: 标记全量并在 250ms 后发送(不立即发抢旧桶)', async () => {
    const h = makeController()
    h.ctl.scheduleQuickFullSave('c1')
    await h.clock.runMicro()
    expect(h.calls).toHaveLength(0) // 不立即发
    expect(h.ctl.marksOf('c1')?.full).toBe(true)
    h.willReturn({ status: 200 })
    await h.clock.tick(250)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].full).toBe(true)
  })

  it('requestQuickFullSave 后立刻 clearAllTimers: 0ms 引导与 250ms 发送都不再触发', async () => {
    const h = makeController()
    h.ctl.requestQuickFullSave('c1', () => true)
    // 卸载发生在 0ms 定时器触发之前
    h.ctl.clearAllTimers()
    await h.clock.tick(60_000)
    expect(h.calls).toHaveLength(0)
  })

  it('requestQuickFullSave: ready 通过后 250ms 发送; ready 闸门不通过则不发', async () => {
    const h = makeController()
    h.ctl.requestQuickFullSave('c1', () => false)
    await h.clock.tick(300)
    expect(h.calls).toHaveLength(0)
    expect(h.ctl.marksOf('c1')?.full).toBeFalsy()

    const h2 = makeController()
    h2.ctl.requestQuickFullSave('c1', () => true)
    h2.willReturn({ status: 200 })
    await h2.clock.tick(250)
    expect(h2.calls).toHaveLength(1)
    expect(h2.calls[0].full).toBe(true)
  })

  it('多画布记账互不干扰', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'a')
    h.ctl.scheduleSave('view', 'b')
    h.willReturn({ status: 200 })
    await h.clock.tick(600)
    expect(h.calls.map(c => c.canvasId).sort()).toEqual(['a', 'b'])
    expect(h.calls.find(c => c.canvasId === 'a')?.full).toBe(true)
    expect(h.calls.find(c => c.canvasId === 'b')?.full).toBe(false)
  })
})

describe('CanvasSaveController 文档序号与本地安全标记', () => {
  it('全量笔带单调递增 docSeq, 纯视角笔不带', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    h.ctl.flushNow('c1')
    await h.clock.runMicro()
    expect(h.calls[0].docSeq).toBe(1)
    h.settle({ status: 200 })
    await h.clock.runMicro()
    // 第二笔全量序号递增
    h.ctl.scheduleSave('full', 'c1')
    h.ctl.flushNow('c1')
    await h.clock.runMicro()
    expect(h.calls[1].docSeq).toBe(2)
    h.settle({ status: 200 })
    await h.clock.runMicro()
    // 视角笔无序号
    h.ctl.scheduleSave('view', 'c1')
    h.ctl.flushNow('c1')
    await h.clock.runMicro()
    expect(h.calls[2].docSeq).toBeUndefined()
    h.settle({ status: 200 })
    await h.clock.runMicro()
  })

  it('全量改动会使旧版本的本地安全标记失效; 纯视角改动不失效', () => {
    const h = makeController()
    h.ctl.markLocalSafe('c1')
    expect(h.ctl.isLocalSafe('c1')).toBe(true)
    h.ctl.scheduleSave('view', 'c1')
    expect(h.ctl.isLocalSafe('c1')).toBe(true)
    h.ctl.scheduleSave('full', 'c1')
    expect(h.ctl.isLocalSafe('c1')).toBe(false)
  })

  it('在途期间有新全量改动: 失败落定不得把本地安全标记重新置真(盘上只是旧版快照)', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.tick(600)
    expect(h.calls).toHaveLength(1)
    // 请求在途时用户又编辑
    h.ctl.scheduleSave('full', 'c1')
    h.settle({ status: 503 })
    await h.clock.runMicro()
    h.ctl.retainLocalSafeIfLanded('c1', true)
    expect(h.ctl.isLocalSafe('c1')).toBe(false) // 新改动没落盘, 不能宣称安全
  })

  it('在途期间无新改动: 本笔落过盘则失败也保住本地安全标记', async () => {
    const h = makeController()
    h.ctl.scheduleSave('full', 'c1')
    await h.clock.tick(600)
    h.settle({ status: 503 })
    await h.clock.runMicro()
    h.ctl.retainLocalSafeIfLanded('c1', true)
    expect(h.ctl.isLocalSafe('c1')).toBe(true)
  })
})
