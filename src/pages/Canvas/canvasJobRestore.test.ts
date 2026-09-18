import { describe, it, expect } from 'vitest'
import {
  matchRestoreHistory,
  decideRestore,
  type RestoreHistoryItem,
  type RestorePendingJob,
} from './canvasJobRestore'

function hist(over: Partial<RestoreHistoryItem>): RestoreHistoryItem {
  return { jobId: '', taskId: '', status: 'success', prompt: '', resultUrl: '', created: '', ...over }
}

function job(over: Partial<RestorePendingJob> = {}): RestorePendingJob {
  return { cardId: 'c1', resultIndex: undefined, model: 'm', promptText: 'p', ...over }
}

describe('matchRestoreHistory 认领优先级', () => {
  it('① 真实任务 ID 精确命中 jobId, 不受提示词与去重集合影响', () => {
    const items = [hist({ jobId: 'j1', taskId: 't1', status: 'failed', prompt: '别的提示词' })]
    const claimed = new Set(['j1']) // 即使已被兜底认领过, 精确仍命中
    const m = matchRestoreHistory(job({ remoteTaskId: 'j1', promptText: 'p' }), items, claimed)
    expect(m?.item.jobId).toBe('j1')
    expect(m?.exact).toBe(true)
  })

  it('① remoteTaskId 命中 taskId 也算精确', () => {
    const items = [hist({ jobId: 'j9', taskId: 'tt-1', prompt: 'p' })]
    const m = matchRestoreHistory(job({ remoteTaskId: 'tt-1' }), items, new Set())
    expect(m?.exact).toBe(true)
    expect(m?.item.jobId).toBe('j9')
  })

  it('② 无 ID 时取同提示词在跑的最新一条, 跳过已被认领项', () => {
    const items = [
      hist({ jobId: 'old', status: 'running', prompt: 'p', created: '2026-09-01' }),
      hist({ jobId: 'new', status: 'running', prompt: 'p', created: '2026-09-02' }),
    ]
    const m = matchRestoreHistory(job({ promptText: 'p' }), items, new Set())
    expect(m?.item.jobId).toBe('new')
    expect(m?.exact).toBe(false)
  })

  it('② 最新在跑项被认领后, 取另一条在跑项', () => {
    const items = [
      hist({ jobId: 'old', status: 'running', prompt: 'p', created: '2026-09-01' }),
      hist({ jobId: 'new', status: 'running', prompt: 'p', created: '2026-09-02' }),
    ]
    const m = matchRestoreHistory(job({ promptText: 'p' }), items, new Set(['new']))
    expect(m?.item.jobId).toBe('old')
  })

  it('③ 没有在跑项时取同提示词最新一条(即便已失败/成功)', () => {
    const items = [
      hist({ jobId: 's1', status: 'success', prompt: 'p', resultUrl: 'u1', created: '2026-09-01' }),
      hist({ jobId: 's2', status: 'success', prompt: 'p', resultUrl: 'u2', created: '2026-09-03' }),
    ]
    const m = matchRestoreHistory(job({ promptText: 'p' }), items, new Set())
    expect(m?.item.jobId).toBe('s2')
  })

  it('提示词不符 / 列表为空 → null', () => {
    expect(matchRestoreHistory(job({ promptText: 'p' }), [], new Set())).toBeNull()
    expect(
      matchRestoreHistory(job({ promptText: 'p' }), [hist({ jobId: 'x', prompt: 'q', status: 'running' })], new Set()),
    ).toBeNull()
  })

  it('兜底只认有 jobId 的历史项', () => {
    const m = matchRestoreHistory(
      job({ promptText: 'p' }),
      [hist({ jobId: '', status: 'running', prompt: 'p' })],
      new Set(),
    )
    expect(m).toBeNull()
  })

  it('有 remoteTaskId 但历史缺席: fail closed, 不退回同提示词兜底', () => {
    // 同提示词恰有一条在跑、一条成功——都绝不能被认领
    const items = [
      hist({ jobId: 'other-running', status: 'running', prompt: 'p', created: '2026-09-02' }),
      hist({ jobId: 'other-success', status: 'success', prompt: 'p', resultUrl: 'u', created: '2026-09-03' }),
    ]
    expect(matchRestoreHistory(job({ remoteTaskId: 'my-task', promptText: 'p' }), items, new Set())).toBeNull()
  })

  it('有 remoteTaskId 但列表缺席: 不兜底同提示词, 直接按号 resume-exact(不依赖最近 30 条列表)', () => {
    const items = [hist({ jobId: 'other', status: 'running', prompt: 'p' })]
    const d = decideRestore(job({ remoteTaskId: 'my-task', promptText: 'p' }), items, true, false, new Set())
    expect(d.action).toBe('resume-exact')
    if (d.action === 'resume-exact') expect(d.jobId).toBe('my-task')
    // 重查仍缺席也一样按号续轮询, 绝不标中断诱导重复扣费
    const d2 = decideRestore(job({ remoteTaskId: 'my-task', promptText: 'p', __retried: true }), items, true, false, new Set())
    expect(d2.action).toBe('resume-exact')
  })

  it('历史列表拉取失败(historyAvailable=false): 一律 retry-later, 有号也不直接续(可能是网络全断)', () => {
    expect(decideRestore(job({ remoteTaskId: 'my-task' }), [], true, false, new Set(), false).action).toBe('retry-later')
    expect(decideRestore(job({ promptText: 'p' }), [], true, false, new Set(), false).action).toBe('retry-later')
  })
})

describe('decideRestore 处置决策', () => {
  it('卡片/结果项不存在 → drop', () => {
    const d = decideRestore(job(), [hist({ jobId: 'j' })], false, false, new Set())
    expect(d.action).toBe('drop')
  })

  it('在跑项 → resume, 并把 jobId 加入去重集合; 非精确命中标记需记住 ID', () => {
    const claimed = new Set<string>()
    const d = decideRestore(
      job({ promptText: 'p' }),
      [hist({ jobId: 'j1', status: 'running', prompt: 'p' })],
      true,
      true,
      claimed,
    )
    expect(d.action).toBe('resume')
    if (d.action === 'resume') {
      expect(d.history.jobId).toBe('j1')
      expect(d.rememberTaskId).toBe(true)
    }
    expect(claimed.has('j1')).toBe(true)
  })

  it('精确命中在跑项: resume 但不要求重复记忆(remoteTaskId 已在)', () => {
    const claimed = new Set<string>()
    const d = decideRestore(
      job({ remoteTaskId: 'j1' }),
      [hist({ jobId: 'j1', status: 'running', prompt: 'p' })],
      true,
      true,
      claimed,
    )
    if (d.action === 'resume') expect(d.rememberTaskId).toBe(false)
    expect(claimed.has('j1')).toBe(true)
  })

  it('成功且有产物 → complete; 明确失败 → fail', () => {
    const ok = decideRestore(
      job({ promptText: 'p' }),
      [hist({ jobId: 'j', status: 'success', prompt: 'p', resultUrl: 'u' })],
      true, false, new Set(),
    )
    expect(ok.action).toBe('complete')
    const bad = decideRestore(
      job({ promptText: 'p' }),
      [hist({ jobId: 'j', status: 'failed', prompt: 'p', errorMessage: 'boom' })],
      true, false, new Set(),
    )
    expect(bad.action).toBe('fail')
  })

  it('未匹配: 视频类首次 → retry-later, 已重试过 → interrupt; 图片类直接 interrupt', () => {
    expect(decideRestore(job(), [], true, true, new Set()).action).toBe('retry-later')
    expect(decideRestore(job({ __retried: true }), [], true, true, new Set()).action).toBe('interrupt')
    expect(decideRestore(job(), [], true, false, new Set()).action).toBe('interrupt')
  })

  it('成功但无产物: 视频类首次再等一次, 其余中断', () => {
    const noUrl = [hist({ jobId: 'j', status: 'success', prompt: 'p', resultUrl: '' })]
    expect(decideRestore(job({ promptText: 'p' }), noUrl, true, true, new Set()).action).toBe('retry-later')
    expect(decideRestore(job({ promptText: 'p', __retried: true }), noUrl, true, true, new Set()).action).toBe('interrupt')
  })

  it('同批两条本地任务: 第一条认领在跑项后, 第二条不再抢到同一条', () => {
    const items = [hist({ jobId: 'j1', status: 'running', prompt: 'p', created: '2026-09-01' })]
    const claimed = new Set<string>()
    const first = decideRestore(job({ cardId: 'a', promptText: 'p' }), items, true, true, claimed)
    const second = decideRestore(job({ cardId: 'b', promptText: 'p' }), items, true, true, claimed)
    expect(first.action).toBe('resume')
    // 第二条: 在跑项已被认领 → 无候选; 视频类首次延迟再认领(不会重复续轮询同一任务)
    expect(second.action).toBe('retry-later')
  })
})
