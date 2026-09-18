import { describe, it, expect } from 'vitest'
import type { CanvasCardData } from './canvasTypes'
import { appendCameraPrompt } from './cameraModel'
import { applyTransparentBgPrompt } from './canvasModels'
import { collectUpstreamTextsFor, deriveLoopTasksFor } from './canvasTopology'

const card = (over: Record<string, unknown>): CanvasCardData =>
  ({ id: over.id ?? 'c', kind: over.kind ?? 'generate', ...over }) as unknown as CanvasCardData

describe('appendCameraPrompt', () => {
  it('去尾部标点后用中文逗号拼接', () => {
    expect(appendCameraPrompt('一只猫，。', '50mm 镜头')).toBe('一只猫，50mm 镜头')
  })
  it('摄影段为空原样返回', () => {
    expect(appendCameraPrompt('一只猫', '   ')).toBe('一只猫')
  })
  it('用户提示为空只返回摄影段', () => {
    expect(appendCameraPrompt('   ', '50mm 镜头')).toBe('50mm 镜头')
  })
})

describe('applyTransparentBgPrompt', () => {
  it('支持模型且开关开时前置透明背景诉求', () => {
    const out = applyTransparentBgPrompt('一只猫', { transparentBg: true, model: 'gpt-image-2' } as never)
    expect(out).toMatch(/^.+，一只猫$/)
  })
  it('空提示词只保留前缀', () => {
    const out = applyTransparentBgPrompt('  ', { transparentBg: true, model: 'gpt-image-2' } as never)
    expect(out).not.toContain('，')
  })
  it('开关关或模型不支持时原样返回', () => {
    expect(applyTransparentBgPrompt('猫', { transparentBg: false, model: 'gpt-image-2' } as never)).toBe('猫')
    expect(applyTransparentBgPrompt('猫', { transparentBg: true, model: 'seedream-4.0' } as never)).toBe('猫')
  })
  it('已含相同诉求不重复前置', () => {
    const prefix = applyTransparentBgPrompt('猫', { transparentBg: true, model: 'gpt-image-2' } as never).split('，')[0]
    const out = applyTransparentBgPrompt(`${prefix}，猫`, { transparentBg: true, model: 'gpt-image-2' } as never)
    expect(out.startsWith(prefix)).toBe(true)
    expect(out.indexOf(prefix)).toBe(out.lastIndexOf(prefix))
  })
})

describe('collectUpstreamTextsFor', () => {
  const cards = [
    card({ id: 'a', kind: 'agent', prompt: '备用提示词', agentState: { output: 'Agent 输出' } }),
    card({ id: 'p', kind: 'generate', prompt: '  普通提示词  ' }),
    card({ id: 'e', kind: 'generate', prompt: '   ' }),
    card({ id: 'loop' }),
  ]
  const conns = [
    { id: '1', fromId: 'a', toId: 'loop' },
    { id: '2', fromId: 'p', toId: 'loop' },
    { id: '3', fromId: 'e', toId: 'loop' },
  ]
  it('Agent 取输出文本，其余取 prompt，按连线顺序去空白', () => {
    expect(collectUpstreamTextsFor('loop', cards, conns)).toEqual(['Agent 输出', '普通提示词'])
  })
})

describe('deriveLoopTasksFor', () => {
  const agentText = card({
    id: 'ta',
    kind: 'agent',
    prompt: 'fallback',
    agentState: {
      tableMode: false,
      output: '1. 第一行\n2) 第二行\n\n坏行\n3、第三行',
    },
  })
  const cards = [agentText, card({ id: 'loop' })]
  const conns = [{ id: '1', fromId: 'ta', toId: 'loop' }]
  it('文本模式：按空行拆、剥序号、空行丢弃，标记非表格驱动', () => {
    expect(deriveLoopTasksFor('loop', cards, conns)).toEqual([
      { prompt: '第一行', rowDriven: false },
      { prompt: '第二行', rowDriven: false },
      { prompt: '坏行', rowDriven: false },
      { prompt: '第三行', rowDriven: false },
    ])
  })

  it('表格模式：跳过禁用行，拼成「列名: 值」多行，标记表格驱动', () => {
    const tableAgent = card({
      id: 'tb',
      kind: 'agent',
      agentState: {
        tableMode: true,
        tableColumns: [
          { id: 'c1', name: '主题' },
          { id: 'c2', name: '风格' },
        ],
        tableRows: [
          { id: 'r1', cells: { c1: '猫', c2: '油画' } },
          { id: 'r2', enabled: false, cells: { c1: '狗', c2: '水彩' } },
          { id: 'r3', cells: { c1: '  ', c2: '素描' } },
        ],
      },
    })
    expect(
      deriveLoopTasksFor('loop', [card({ id: 'loop' }), tableAgent], [{ id: '1', fromId: 'tb', toId: 'loop' }]),
    ).toEqual([
      { prompt: '主题: 猫\n风格: 油画', rowDriven: true },
      { prompt: '风格: 素描', rowDriven: true },
    ])
  })

  it('非 Agent 上游与空文本忽略', () => {
    const cs = [card({ id: 'g', kind: 'generate', prompt: '不该出现' }), card({ id: 'loop' })]
    expect(deriveLoopTasksFor('loop', cs, [{ id: '1', fromId: 'g', toId: 'loop' }])).toEqual([])
  })
})
