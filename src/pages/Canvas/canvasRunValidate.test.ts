import { describe, it, expect } from 'vitest'
import type { CanvasCardData, CanvasConnection } from './canvasTypes'
import { validateGenerateRun } from './canvasModels'
import { deriveLoopSharedRefsFor } from './canvasTopology'

const card = (over: Record<string, unknown>): CanvasCardData =>
  ({ id: over.id ?? 'c', kind: over.kind ?? 'generate', ...over }) as unknown as CanvasCardData

describe('validateGenerateRun', () => {
  // 用真实模型 slug 断言, 避免凭记忆编模型名
  it('文生图: 无提示词报错, 有提示词通过', () => {
    expect(validateGenerateRun({ prompt: '   ', hasImage: false, model: 'gpt-image-2' })).toContain('画面描述')
    expect(validateGenerateRun({ prompt: '一只猫', hasImage: false, model: 'gpt-image-2' })).toBeNull()
  })

  it('图生视频纯渠道(WAN 2.2 预设): 无提示词不报错, 但缺首帧图报错', () => {
    const i2vSlug = 'wan-2.2-i2v-ai-app'
    expect(validateGenerateRun({ prompt: '', hasImage: false, model: i2vSlug })).toContain('首帧')
    expect(validateGenerateRun({ prompt: '', hasImage: true, model: i2vSlug })).toBeNull()
  })

  it('家族主键无图时走文生: gpt-image-2 无图无提示词只报画面描述, 不报缺图', () => {
    expect(validateGenerateRun({ prompt: '', hasImage: false, model: 'gpt-image-2' })).toBe('先在生成节点里写画面描述')
  })

  it('家族主键有图时走图生: 图生图无提示词仍报画面描述, 不要求图(图已具备)', () => {
    expect(validateGenerateRun({ prompt: '', hasImage: true, model: 'gpt-image-2' })).toBe('先在生成节点里写画面描述')
    expect(validateGenerateRun({ prompt: '改成油画', hasImage: true, model: 'gpt-image-2' })).toBeNull()
  })
})

describe('deriveLoopSharedRefsFor', () => {
  const cards = [
    card({ id: 'loop' }),
    card({ id: 'agent1', kind: 'agent', url: '' }),
    card({ id: 'img1', url: 'http://x/1.jpg' }),
    card({ id: 'img2', url: 'http://x/2.jpg' }),
    card({ id: 'agent2', kind: 'agent' }),
    card({ id: 'img3', url: 'http://x/3.jpg' }),
    card({ id: 'dup', url: 'http://x/1.jpg' }),
  ]
  const conns: CanvasConnection[] = [
    { id: 'c1', fromId: 'img1', toId: 'loop' },
    { id: 'c2', fromId: 'img2', toId: 'agent1' },
    { id: 'c3', fromId: 'agent1', toId: 'loop' },
    { id: 'c4', fromId: 'img3', toId: 'agent2' },
    { id: 'c5', fromId: 'agent2', toId: 'loop' },
    { id: 'c6', fromId: 'dup', toId: 'loop' },
  ]
  it('自身入边图 + 直连 Agent 的入边图，去重合并，最多 9 张', () => {
    // 自身入边图先入集合(1.jpg 重复一次), 再按入边连线序展开各 Agent 的入边图
    expect(deriveLoopSharedRefsFor('loop', cards, conns)).toEqual([
      'http://x/1.jpg',
      'http://x/2.jpg',
      'http://x/3.jpg',
    ])
  })

  it('非 Agent 上游的二级图不展开', () => {
    const cs = [
      card({ id: 'loop' }),
      card({ id: 'gen', kind: 'generate' }),
      card({ id: 'hidden', url: 'http://x/h.jpg' }),
      card({ id: 'direct', url: 'http://x/d.jpg' }),
    ]
    const cc: CanvasConnection[] = [
      { id: '1', fromId: 'hidden', toId: 'gen' },
      { id: '2', fromId: 'gen', toId: 'loop' },
      { id: '3', fromId: 'direct', toId: 'loop' },
    ]
    expect(deriveLoopSharedRefsFor('loop', cs, cc)).toEqual(['http://x/d.jpg'])
  })
})
