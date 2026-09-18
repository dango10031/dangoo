import { describe, it, expect } from 'vitest'
import { matchSpecialRestore, type SpecialRestoreHistoryLike } from './specialJobRestore'

interface H extends SpecialRestoreHistoryLike {
  created?: string
}
const h = (over: Partial<H>): H => ({ jobId: '', taskId: '', status: 'running', ...over })

describe('matchSpecialRestore', () => {
  it('有任务号: 精确命中 jobId/taskId', () => {
    const items = [h({ jobId: 'a', taskId: 't-a' }), h({ jobId: 'b', taskId: 't-b' })]
    expect(matchSpecialRestore('b', items, 5).kind).toBe('matched')
    const byTask = matchSpecialRestore('t-b', items, 5)
    expect(byTask.kind === 'matched' ? byTask.item.jobId : '').toBe('b')
  })

  it('有任务号但列表缺席: resume-exact 直接按号续, 不退回最新在跑兜底(任务可能在 30 条之外)', () => {
    const items = [
      h({ jobId: 'other-running', status: 'running', created: '2026-09-02' }),
      h({ jobId: 'other-success', status: 'success', created: '2026-09-03' }),
    ]
    // 即使本节点只有一条待恢复也不兜底
    expect(matchSpecialRestore('my-task', items, 1)).toEqual({ kind: 'resume-exact', jobId: 'my-task' })
  })

  it('有任务号但列表是因网络失败没取到: await-exact 等重查, 不直接续也不标失败', () => {
    expect(matchSpecialRestore('my-task', [], 1, false)).toEqual({ kind: 'await-exact' })
  })

  it('无任务号且列表拉取失败: await-exact, 不把空列表当「没有在跑」', () => {
    expect(matchSpecialRestore(undefined, [], 1, false)).toEqual({ kind: 'await-exact' })
  })

  it('无任务号且仅一条待恢复: 兜底取最新在跑项', () => {
    const items = [
      h({ jobId: 'old', created: '2026-09-01' }),
      h({ jobId: 'new', created: '2026-09-02' }),
    ]
    const d = matchSpecialRestore(undefined, items, 1)
    expect(d.kind === 'matched' ? d.item.jobId : '').toBe('new')
  })

  it('无任务号但多条待恢复: 不兜底(避免并发误认)', () => {
    expect(matchSpecialRestore(undefined, [h({ jobId: 'x' })], 2)).toEqual({ kind: 'none' })
  })

  it('无任务号且无在跑项: none(成功项交给调用方按状态判定)', () => {
    expect(matchSpecialRestore(undefined, [h({ jobId: 'x', status: 'success' })], 1)).toEqual({ kind: 'none' })
    expect(matchSpecialRestore('', [], 1)).toEqual({ kind: 'none' })
  })
})
