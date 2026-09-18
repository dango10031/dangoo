import { describe, it, expect } from 'vitest'
import {
  decideRunTerminal,
  isAuthErrorStatus,
  resumeNodeType,
  specialAppSnapshot,
  deriveResultName,
  specialRunErrorText,
  type PollSnapshot,
} from './canvasJobRun'

function snap(over: Partial<PollSnapshot>): PollSnapshot {
  return { succeeded: false, aborted: false, needsLogin: false, ...over }
}

describe('decideRunTerminal', () => {
  it('会话失效优先: 即便成功/有中止也静默丢弃', () => {
    expect(decideRunTerminal(snap({ succeeded: true, url: 'u' }), false).kind).toBe('discard')
    expect(decideRunTerminal(snap({ aborted: true }), false).kind).toBe('discard')
  })

  it('被中止(会话仍有效)静默丢弃, 不写结果', () => {
    expect(decideRunTerminal(snap({ aborted: true, succeeded: false }), true).kind).toBe('discard')
  })

  it('成功: 产物/任务号/费用进成功补丁, url 同时回传决定是否转存', () => {
    const r = decideRunTerminal(
      snap({ succeeded: true, url: 'http://x/a.png', taskId: 't1', costText: '¥2.00' }),
      true,
    )
    expect(r.kind).toBe('success')
    if (r.kind === 'success') {
      expect(r.patch).toMatchObject({ jobStatus: 'success', url: 'http://x/a.png', taskId: 't1', costText: '¥2.00' })
      expect(r.url).toBe('http://x/a.png')
    }
  })

  it('成功但无产物地址: 仍写 success, url 为空串(不转存)', () => {
    const r = decideRunTerminal(snap({ succeeded: true }), true)
    if (r.kind === 'success') {
      expect(r.patch.jobStatus).toBe('success')
      expect(r.patch.url).toBe('')
      expect(r.url).toBe('')
    }
  })

  it('失败: 错误文案进补丁, 登录标记透传但不改变 kind', () => {
    const loginFail = decideRunTerminal(snap({ needsLogin: true, errorMsg: '登录已过期' }), true)
    expect(loginFail.kind).toBe('failure')
    if (loginFail.kind === 'failure') {
      expect(loginFail.needsLogin).toBe(true)
      expect(loginFail.patch).toEqual({ jobStatus: 'failed', errorMsg: '登录已过期' })
    }
    const normalFail = decideRunTerminal(snap({ errorMsg: '生成失败' }), true)
    if (normalFail.kind === 'failure') expect(normalFail.needsLogin).toBe(false)
  })
})

describe('specialAppSnapshot', () => {
  it('succeeded/partial 归一化为成功', () => {
    const s1 = specialAppSnapshot({ state: 'succeeded', job: { taskId: 't' } }, { url: 'u' })
    expect(s1.succeeded).toBe(true)
    expect(s1.aborted).toBe(false)
    expect(s1.taskId).toBe('t')
    const s2 = specialAppSnapshot({ state: 'partial' }, { url: 'u' })
    expect(s2.succeeded).toBe(true)
  })
  it('失败态: ABORTED→中止, RH_LOGIN_REQUIRED→需登录, 其它→普通失败', () => {
    const aborted = specialAppSnapshot({ state: 'failed', error: { code: 'ABORTED' } }, { errorMsg: '已取消' })
    expect(aborted.aborted).toBe(true)
    const login = specialAppSnapshot({ state: 'failed', error: { code: 'RH_LOGIN_REQUIRED' } }, { errorMsg: 'x' })
    expect(login.needsLogin).toBe(true)
    const normal = specialAppSnapshot({ state: 'failed', error: { code: 'TIMEOUT' } }, { errorMsg: '超时' })
    expect(normal.succeeded).toBe(false)
    expect(normal.aborted).toBe(false)
    expect(normal.needsLogin).toBe(false)
  })
  it('任务号优先取 extra.taskId, 其次 job.taskId/jobId', () => {
    expect(specialAppSnapshot({ state: 'succeeded' }, { taskId: 'force' }).taskId).toBe('force')
    expect(specialAppSnapshot({ state: 'succeeded', job: { jobId: 'j1' } }, {}).taskId).toBe('j1')
  })
})

describe('deriveResultName', () => {
  it('取路径末段并去掉查询参数, 取不到用默认名', () => {
    expect(deriveResultName('https://x/a/b.mp4?q=1', '默认.mp4')).toBe('b.mp4')
    expect(deriveResultName('c.mp3', '默认.mp3')).toBe('c.mp3')
    expect(deriveResultName('', '默认.mp4')).toBe('默认.mp4')
    expect(deriveResultName('https://x/', '默认.mp4')).toBe('默认.mp4')
  })
})

describe('specialRunErrorText', () => {
  it('登录状态码给统一登录文案, 其余给业务兜底文案', () => {
    expect(specialRunErrorText({ status: 412 }, '兜底')).toBe('登录已过期, 请重新登录后重试')
    expect(specialRunErrorText(Object.assign(new Error('x'), { status: 403 }), '兜底')).toBe('登录已过期, 请重新登录后重试')
    expect(specialRunErrorText(new Error('boom'), '兜底')).toBe('兜底')
  })
})

describe('resumeNodeType', () => {
  it('有结果项下标一律「生成节点」', () => {
    expect(resumeNodeType(0, 'AI 应用', true)).toBe('生成节点')
    expect(resumeNodeType(2, '生成节点', false)).toBe('生成节点')
  })
  it('老独立卡: Loop 来源优先, 否则用通道兜底文案', () => {
    expect(resumeNodeType(undefined, 'AI 应用', true)).toBe('Loop')
    expect(resumeNodeType(undefined, 'AI 应用', false)).toBe('AI 应用')
    expect(resumeNodeType(undefined, '生成节点', false)).toBe('生成节点')
  })
})

describe('isAuthErrorStatus', () => {
  it('412/401/403 算登录失效, 其它与无状态对象不算', () => {
    expect(isAuthErrorStatus({ status: 412 })).toBe(true)
    expect(isAuthErrorStatus(Object.assign(new Error('x'), { status: 401 }))).toBe(true)
    expect(isAuthErrorStatus(Object.assign(new Error('x'), { status: 403 }))).toBe(true)
    expect(isAuthErrorStatus({ status: 500 })).toBe(false)
    expect(isAuthErrorStatus(new Error('network'))).toBe(false)
    expect(isAuthErrorStatus(null)).toBe(false)
  })
})
