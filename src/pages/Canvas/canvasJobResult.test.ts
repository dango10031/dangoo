import { describe, it, expect } from 'vitest'
import {
  applyResultItemPatch,
  aggregateJobStatus,
  sumResultsCost,
  clampActiveIndex,
  pickMainResult,
  aggregateNodeResults,
  resultItemPatchFromSpec,
  removePendingJobRecord,
  removePendingJobByIdentity,
  finishPendingJobRecord,
  initialRestoreCount,
  attachRemoteTaskId,
} from './canvasJobResult'
import type { CanvasCardData, GenerateResultItem, PendingJobRecord } from './canvasTypes'
import type { CropContext } from '@/components/canvas/imageEdit/localPatch'

/** 测试用最小合法 CropContext(只关心引用是否透传) */
function cropCtx(id: string): CropContext {
  return {
    version: 2,
    contextId: id,
    source: { url: `u-${id}`, width: 10, height: 10, fingerprint: `f-${id}` },
    rect: { x: 0, y: 0, w: 1, h: 1 },
    paddedRect: { x: 0, y: 0, w: 1, h: 1 },
    paddingRatio: 0,
  }
}

function item(over: Partial<GenerateResultItem>): GenerateResultItem {
  return { itemStatus: 'queued', ...over }
}
function card(results: GenerateResultItem[], over: Partial<CanvasCardData> = {}): CanvasCardData {
  return { id: 'c', kind: 'generate', results, activeResultIndex: 0, ...over } as unknown as CanvasCardData
}
function pending(over: Partial<PendingJobRecord>): PendingJobRecord {
  return { cardId: 'c', model: 'm', promptText: 'p', submittedAt: 1, ...over }
}

describe('applyResultItemPatch', () => {
  it('只更新目标下标, 其它项引用不变; 越界原样返回', () => {
    const list = [item({ url: 'a' }), item({ url: 'b' })]
    const next = applyResultItemPatch(list, 1, { url: 'B' })
    expect(next[0]).toBe(list[0])
    expect(next[1].url).toBe('B')
    expect(applyResultItemPatch(list, 5, { url: 'x' })).toBe(list)
  })
})

describe('aggregateJobStatus', () => {
  it('有排队/运行 → running(优先)', () => {
    expect(aggregateJobStatus([item({ itemStatus: 'failed' }), item({ itemStatus: 'running' })])).toBe('running')
    expect(aggregateJobStatus([item({ itemStatus: 'success' }), item({ itemStatus: 'queued' })])).toBe('running')
  })
  it('全成功 → success; 有失败且无在跑 → failed; 空 → undefined', () => {
    expect(aggregateJobStatus([item({ itemStatus: 'success' })])).toBe('success')
    expect(aggregateJobStatus([item({ itemStatus: 'success' }), item({ itemStatus: 'failed' })])).toBe('failed')
    expect(aggregateJobStatus([])).toBeUndefined()
  })
})

describe('费用合计', () => {
  it('解析 ¥ 文案求和, 无正值费用返回 undefined', () => {
    expect(sumResultsCost([item({ costText: '¥1.50' }), item({ costText: '¥2.50' })])).toBe('¥4.00')
    expect(sumResultsCost([item({ costText: '' })])).toBeUndefined()
  })
})

describe('active 下标与主图', () => {
  it('clampActiveIndex 钳到范围内', () => {
    expect(clampActiveIndex(5, 3)).toBe(2)
    expect(clampActiveIndex(1, 3)).toBe(1)
    expect(clampActiveIndex(undefined, 3)).toBe(0)
    expect(clampActiveIndex(0, 0)).toBe(0)
  })
  it('active 成功有 url 优先, 否则取第一个成功项, 都没有 null', () => {
    const list = [
      item({ itemStatus: 'success', url: 'a' }),
      item({ itemStatus: 'success', url: 'b' }),
    ]
    expect(pickMainResult(list, 1)?.url).toBe('b')
    const list2 = [
      item({ itemStatus: 'failed' }),
      item({ itemStatus: 'success', url: 'ok' }),
    ]
    expect(pickMainResult(list2, 0)?.url).toBe('ok')
    expect(pickMainResult([item({ itemStatus: 'failed' })], 0)).toBeNull()
  })
})

describe('aggregateNodeResults', () => {
  it('某项转运行: 聚合 running, 主图沿用既有成功项', () => {
    const c = card([
      item({ itemStatus: 'success', url: 'a' }),
      item({ itemStatus: 'queued' }),
    ], { cropContext: cropCtx("x1") })
    const agg = aggregateNodeResults(c, 1, { itemStatus: 'running' })
    expect(agg.jobStatus).toBe('running')
    expect(agg.url).toBe('a')
  })

  it('两项全成功: 聚合 success, active 决定主图, 费用合计', () => {
    const c = card([
      item({ itemStatus: 'success', url: 'a', costText: '¥1.00' }),
      item({ itemStatus: 'running' }),
    ], { activeResultIndex: 1 })
    const agg = aggregateNodeResults(c, 1, { itemStatus: 'success', url: 'b', costText: '¥2.00' })
    expect(agg.jobStatus).toBe('success')
    expect(agg.activeResultIndex).toBe(1)
    expect(agg.url).toBe('b')
    expect(agg.costText).toBe('¥3.00')
  })

  it('active 越界(防御)钳到末项; 无成功项时 url 为 undefined、cropContext 回退卡值', () => {
    const c = card([item({ itemStatus: 'failed' })], { activeResultIndex: 9, cropContext: cropCtx("keep") })
    const agg = aggregateNodeResults(c, 0, { itemStatus: 'failed' })
    expect(agg.activeResultIndex).toBe(0)
    expect(agg.url).toBeUndefined()
    expect(agg.cropContext).toEqual(cropCtx("keep"))
  })

  it('成功主图带来 cropContext', () => {
    const c = card([item({ itemStatus: 'success', url: 'a', cropContext: cropCtx("z9") })])
    const agg = aggregateNodeResults(c, 0, { itemStatus: 'success', url: 'a', cropContext: cropCtx("z9") })
    expect(agg.cropContext).toEqual(cropCtx("z9"))
  })
})

describe('resultItemPatchFromSpec', () => {
  it('终态字段映射到结果项, 视频带 isVideo', () => {
    const p = resultItemPatchFromSpec({ jobStatus: 'success', url: 'u', taskId: 't', costText: '¥1' }, true)
    expect(p).toMatchObject({ itemStatus: 'success', url: 'u', taskId: 't', costText: '¥1', isVideo: true })
    expect(resultItemPatchFromSpec({ jobStatus: 'failed', errorMsg: 'x' }).isVideo).toBeUndefined()
  })
})

describe('pending 记账', () => {
  it('removePendingJobRecord 复刻旧谓词: 同卡无下标条总删, 结果项仅带对应下标调用才删', () => {
    const list = [
      pending({ cardId: 'c', resultIndex: 0 }),
      pending({ cardId: 'c', resultIndex: 1 }),
      pending({ cardId: 'c' }),
      pending({ cardId: 'd' }),
    ]
    // 带下标 1: 删 c:1 与同卡无下标条 c:-; c:0 与 d 保留
    expect(removePendingJobRecord(list, 'c', 1).map(j => `${j.cardId}:${j.resultIndex ?? '-'}`)).toEqual([
      'c:0', 'd:-',
    ])
    // 不带下标: 只删同卡无下标条 c:-; 两个结果项与 d 保留
    expect(removePendingJobRecord(list, 'c').map(j => `${j.cardId}:${j.resultIndex ?? '-'}`)).toEqual([
      'c:0', 'c:1', 'd:-',
    ])
  })

  it('attachRemoteTaskId: 只补同卡同下标同 model 且尚无 ID 的那一条', () => {
    const list = [
      pending({ cardId: 'c', resultIndex: 0 }),
      pending({ cardId: 'c', resultIndex: 1 }),
      pending({ cardId: 'c', resultIndex: 2, remoteTaskId: 'already' }),
      pending({ cardId: 'c', resultIndex: 0, model: 'other' }),
    ]
    const next = attachRemoteTaskId(list, 'c', 0, 'm', 'NEW')
    expect(next[0].remoteTaskId).toBe('NEW')
    expect(next[1].remoteTaskId).toBeUndefined()
    expect(next[2].remoteTaskId).toBe('already')
    expect(next[3].remoteTaskId).toBeUndefined()
  })

  it('attachRemoteTaskId: 无下标只补老独立结果卡(无 resultIndex)那条', () => {
    const list = [pending({ cardId: 'c' }), pending({ cardId: 'c', resultIndex: 0 })]
    const next = attachRemoteTaskId(list, 'c', undefined, 'm', 'NEW')
    expect(next[0].remoteTaskId).toBe('NEW')
    expect(next[1].remoteTaskId).toBeUndefined()
  })

  it('removePendingJobByIdentity: 旧任务按自己任务号收尾, 不误删同卡新任务', () => {
    const list = [
      pending({ cardId: 'c', model: 'tts', remoteTaskId: 'old' }),
      pending({ cardId: 'c', model: 'tts', remoteTaskId: 'new' }),
      pending({ cardId: 'c', model: 'vsr', remoteTaskId: 'old' }),
      pending({ cardId: 'd', model: 'tts', remoteTaskId: 'old' }),
    ]
    const next = removePendingJobByIdentity(list, 'c', 'tts', 'old')
    expect(next.map(j => `${j.cardId}:${j.model}:${j.remoteTaskId}`)).toEqual([
      'c:tts:new',
      'c:vsr:old',
      'd:tts:old',
    ])
  })

  it('removePendingJobByIdentity: 未受理(无任务号)只删同卡同渠道同样无号的记录', () => {
    const list = [
      pending({ cardId: 'c', model: 'tts' }),
      pending({ cardId: 'c', model: 'tts', remoteTaskId: 'accepted' }),
      pending({ cardId: 'c', model: 'vsr' }),
    ]
    const next = removePendingJobByIdentity(list, 'c', 'tts', null)
    expect(next.map(j => `${j.model}:${j.remoteTaskId ?? '-'}`)).toEqual([
      'tts:accepted',
      'vsr:-',
    ])
  })

  it('finishPendingJobRecord: 同卡两条不同结果项任务, 旧任务先结束不带走新任务待办', () => {
    // 场景: 同一节点两项同时在跑(不同下标), 下标 0 的旧任务先结束
    const list = [
      pending({ cardId: 'c', model: 'm-a', resultIndex: 0, remoteTaskId: 'old-0' }),
      pending({ cardId: 'c', model: 'm-a', resultIndex: 1, remoteTaskId: 'new-1' }),
    ]
    const next = finishPendingJobRecord(list, 'c', 'm-a', 'old-0', 0)
    expect(next).toHaveLength(1)
    expect(next[0].remoteTaskId).toBe('new-1')
    expect(next[0].resultIndex).toBe(1)
  })

  it('finishPendingJobRecord: 同一结果项换渠道重跑, 旧模型任务先结束不删新模型待办', () => {
    // 场景: 第 0 项先跑 m-a 失败被标失败(待办已清), 换 m-b 重跑后极端情况下旧任务的延迟收尾到达
    // ——渠道不同、任务号不同, 新待办必须保留(否则刷新后新任务无人续跑)
    const list = [
      pending({ cardId: 'c', model: 'm-b', resultIndex: 0, remoteTaskId: 'new-b' }),
    ]
    expect(finishPendingJobRecord(list, 'c', 'm-a', 'late-a', 0)).toEqual(list)
    // 同渠道但任务号对不上(旧的延迟收尾, 新笔已受理): 同样保留
    expect(finishPendingJobRecord(list, 'c', 'm-b', 'old-b', 0)).toEqual(list)
    // 只有同卡同渠道同槽同号才删
    expect(finishPendingJobRecord(list, 'c', 'm-b', 'new-b', 0)).toEqual([])
  })

  it('finishPendingJobRecord: 无下标整卡槽与有下标结果项槽互不串删', () => {
    const list = [
      pending({ cardId: 'c', model: 'm-a', resultIndex: 0, remoteTaskId: 'item' }),
      pending({ cardId: 'c', model: 'm-a', remoteTaskId: 'card' }),
    ]
    // 整卡旧路径任务(无下标)收尾: 只删无下标条
    const next1 = finishPendingJobRecord(list, 'c', 'm-a', 'card', undefined)
    expect(next1.map(j => j.remoteTaskId)).toEqual(['item'])
    // 结果项任务收尾: 只删该下标条
    const next2 = finishPendingJobRecord(list, 'c', 'm-a', 'item', 0)
    expect(next2.map(j => j.remoteTaskId)).toEqual(['card'])
  })

  it('finishPendingJobRecord: 未受理(无任务号)只删同卡同渠道同槽同样无号的一条', () => {
    const list = [
      pending({ cardId: 'c', model: 'm-a', resultIndex: 0 }),
      pending({ cardId: 'c', model: 'm-a', resultIndex: 1, remoteTaskId: 'running-1' }),
      pending({ cardId: 'c', model: 'm-a', resultIndex: 1 }),
    ]
    // 下标 0 的笔提交前失败: 只删 (c,m-a,idx0,无号), 下标 1 两条都保留
    const next = finishPendingJobRecord(list, 'c', 'm-a', undefined, 0)
    expect(next.map(j => `${j.resultIndex}:${j.remoteTaskId ?? '-'}`)).toEqual([
      '1:running-1',
      '1:-',
    ])
  })

  it('initialRestoreCount: 首次认领计入整批, 4s 延迟重查同一批不重复计数', () => {
    expect(initialRestoreCount(3)).toBe(3)
    expect(initialRestoreCount(3, {})).toBe(3)
    expect(initialRestoreCount(3, { alreadyCounted: true })).toBe(0)
    expect(initialRestoreCount(1, { alreadyCounted: true })).toBe(0)
  })
})
