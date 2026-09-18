import { describe, it, expect } from 'vitest'
import {
  canvasContentFingerprint,
  partitionStaleSnapshotKeys,
  shouldClearSnapshotForSeq,
} from './canvasLocalSnapshot'

describe('shouldClearSnapshotForSeq —— 云端确认序号 vs 盘上快照序号', () => {
  it('旧保存响应晚到、盘上已是更新序号: 不允许删(最新内容唯一兜底必须保留)', () => {
    // 云端确认的是第 1 笔, 但用户在途期间继续编辑, 盘上已写入第 2 笔快照
    expect(shouldClearSnapshotForSeq(1, 2)).toBe(false)
    expect(shouldClearSnapshotForSeq(3, 5)).toBe(false)
  })

  it('序号全等: 云端确认的就是盘上这一版, 允许删', () => {
    expect(shouldClearSnapshotForSeq(1, 1)).toBe(true)
    expect(shouldClearSnapshotForSeq(7, 7)).toBe(true)
  })

  it('云端笔无序号(卸载抢发等): 不参与带号版本管理, 允许(上层不再带序号调用)', () => {
    expect(shouldClearSnapshotForSeq(undefined, 3)).toBe(true)
    expect(shouldClearSnapshotForSeq(undefined, undefined)).toBe(true)
  })

  it('盘上是无号快照而云端笔带号: 不允许删, 无号快照只能被它自己的流程消化', () => {
    expect(shouldClearSnapshotForSeq(1, undefined)).toBe(false)
    expect(shouldClearSnapshotForSeq(2, undefined)).toBe(false)
  })
})

describe('partitionStaleSnapshotKeys —— 多标签交错写同一画布的快照键', () => {
  it('只挑「同画布 + 非本会话」的键; 本会话键与其他画布键一律排除', () => {
    const keys = [
      'cv1::sess-A', // 本标签(当前会话): 自己的键, 排除
      'cv1::sess-B', // 另一个标签: 恢复候选
      'cv1::sess-C', // 第三个标签(异常关闭): 恢复候选
      'cv2::sess-B', // 同会话但别的画布: 排除
    ]
    const stale = partitionStaleSnapshotKeys(keys, 'cv1', 'sess-A')
    expect(stale.map(s => s.originSessionId)).toEqual(['sess-B', 'sess-C'])
    expect(stale.map(s => String(s.key))).toEqual(['cv1::sess-B', 'cv1::sess-C'])
  })

  it('不同标签各写各的会话键, 同画布快照绝不互相覆盖(键空间天然隔离)', () => {
    const forA = partitionStaleSnapshotKeys(['cv1::sess-A', 'cv1::sess-B'], 'cv1', 'sess-A')
    const forB = partitionStaleSnapshotKeys(['cv1::sess-A', 'cv1::sess-B'], 'cv1', 'sess-B')
    expect(forA.map(s => s.originSessionId)).toEqual(['sess-B'])
    expect(forB.map(s => s.originSessionId)).toEqual(['sess-A'])
  })

  it('没有别的会话快照时恢复候选为空(单标签正常保存成功后即此状态)', () => {
    expect(partitionStaleSnapshotKeys(['cv1::sess-A'], 'cv1', 'sess-A')).toEqual([])
  })
})

describe('canvasContentFingerprint —— 恢复时区分云端是否已有同等内容', () => {
  it('卡片/连线/视角/标题全等则指纹相同(不打扰直接清理快照)', () => {
    const a = canvasContentFingerprint({
      title: 't',
      doc: { cards: [{ id: 'c1' }], connections: [], view: { scale: 1 } },
    })
    const b = canvasContentFingerprint({
      title: 't',
      doc: { cards: [{ id: 'c1' }], connections: [], view: { scale: 1 } },
    })
    expect(a).toBe(b)
  })

  it('任务队列/日志等瞬态字段不参与指纹, 只有它们不同视为同等内容', () => {
    const a = canvasContentFingerprint({
      title: 't',
      doc: { cards: [], connections: [], view: null, pendingJobs: [{ x: 1 }] },
    })
    const b = canvasContentFingerprint({
      title: 't',
      doc: { cards: [], connections: [], view: null, pendingJobs: [{ x: 2 }] },
    })
    expect(a).toBe(b)
  })

  it('卡片内容不同指纹不同(应挂起并弹恢复选择)', () => {
    const a = canvasContentFingerprint({ doc: { cards: [{ id: 'c1' }] } })
    const b = canvasContentFingerprint({ doc: { cards: [{ id: 'c2' }] } })
    expect(a).not.toBe(b)
  })
})
