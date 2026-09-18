import { describe, it, expect } from 'vitest'
import {
  clientToCanvasCoords,
  centerSpawnCoords,
  zoomViewport,
  frameViewport,
  alignmentPatch,
  groupChipBounds,
  saveDebounceMs,
  cascadeDropPos,
  geometrySignature,
  connectionSignatures,
  MIN_SCALE,
  MAX_SCALE,
  type CardBox,
} from './canvasGeometry'

const vp = (scale = 1, x = 80, y = 80) => ({ x, y, scale })

describe('clientToCanvasCoords', () => {
  it('按容器偏移与缩放换算', () => {
    expect(clientToCanvasCoords(180, 190, { left: 0, top: 0 }, vp(1))).toEqual({ x: 100, y: 110 })
    expect(clientToCanvasCoords(180, 190, { left: 20, top: 10 }, vp(2, 0, 0))).toEqual({ x: 80, y: 90 })
  })
})

describe('centerSpawnCoords', () => {
  it('视口中心偏移 130/90', () => {
    expect(centerSpawnCoords(vp(1, 80, 80), { width: 900, height: 600 })).toEqual({ x: 240, y: 130 })
  })
  it('零尺寸舞台回退 900x600', () => {
    expect(centerSpawnCoords(vp(1, 80, 80), { width: 0, height: 0 })).toEqual({ x: 240, y: 130 })
  })
})

describe('zoomViewport', () => {
  it('放大时锚点保持不动', () => {
    // 锚点 450：prev.x=80, factor 2 → x = 450-(450-80)*2 = -290
    const next = zoomViewport(vp(1, 80, 80), 2, { x: 450, y: 300 })
    expect(next.scale).toBeCloseTo(2)
    expect(next.x).toBeCloseTo(-290)
    expect(next.y).toBeCloseTo(-140)
  })
  it('夹取上下限', () => {
    expect(zoomViewport(vp(1), 100, { x: 0, y: 0 }).scale).toBe(MAX_SCALE)
    expect(zoomViewport(vp(1), 0.0001, { x: 0, y: 0 }).scale).toBe(MIN_SCALE)
  })
})

describe('frameViewport', () => {
  const stage = { width: 1000, height: 800 }
  it('空数组回默认视图', () => {
    expect(frameViewport([], stage)).toEqual({ x: 80, y: 80, scale: 1 })
  })
  it('单卡居中并留白缩放', () => {
    const r = frameViewport([{ x: 0, y: 0, w: 100, h: 100 }], stage)
    expect(r.scale).toBeLessThanOrEqual(MAX_SCALE)
    expect(r.scale).toBeGreaterThanOrEqual(MIN_SCALE)
    // 840x640 可用区域放 100x100 → scale 6.4，但被夹到 2.5
    expect(r.scale).toBe(2.5)
    expect(r.x).toBeCloseTo((1000 - 100 * 2.5) / 2)
  })
  it('超大内容被缩小到视野内', () => {
    const r = frameViewport([{ x: 0, y: 0, w: 4000, h: 2000 }], stage)
    expect(r.scale).toBeLessThan(1)
    expect(r.scale).toBeCloseTo(Math.min(840 / 4000, 640 / 2000))
  })
})

const cards = (): CardBox[] => [
  { id: 'a', x: 0, y: 0, w: 100, h: 100 },
  { id: 'b', x: 300, y: 200, w: 100, h: 100 },
  { id: 'c', x: 50, y: 400, w: 120, h: 80 },
]

describe('alignmentPatch', () => {
  it('少于 2 张返回空补丁', () => {
    expect(alignmentPatch([cards()[0]], 'left').size).toBe(0)
  })
  it('左对齐把所有 x 钉到最小值', () => {
    const p = alignmentPatch(cards(), 'left')
    expect(p.get('a')?.x).toBe(0)
    expect(p.get('b')?.x).toBe(0)
    expect(p.get('c')?.x).toBe(0)
    expect(p.get('a')?.y).toBeUndefined()
  })
  it('顶部对齐把所有 y 钉到最小值', () => {
    const p = alignmentPatch(cards(), 'top')
    for (const id of ['a', 'b', 'c']) expect(p.get(id)?.y).toBe(0)
  })
  it('横向等距把卡间空白间隔放宽为 2 倍', () => {
    // 按 x 排序为 a(0) c(50) b(300)：原步距 step=150，最大卡宽 120，
    // 当前空白 30 → 步距 +30 = 180
    const p = alignmentPatch(cards(), 'hdist')
    expect(p.get('a')?.x).toBe(0)
    expect(p.get('c')?.x).toBe(180)
    expect(p.get('b')?.x).toBe(360)
  })
  it('等宽卡片横向间距精确翻倍', () => {
    const eq: CardBox[] = [
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 200, y: 0, w: 100, h: 100 },
      { id: 'c', x: 400, y: 0, w: 100, h: 100 },
    ]
    // 原步距 200（空白 100）→ 翻倍后步距 300（空白 200）
    const p = alignmentPatch(eq, 'hdist')
    expect(p.get('a')?.x).toBe(0)
    expect(p.get('b')?.x).toBe(300)
    expect(p.get('c')?.x).toBe(600)
  })
  it('纵向等距在原步距上再加一份空白间隔', () => {
    // 按 y 排序 a0 b200 c400，step=200；maxCardH=100，curGap=100 → step=300
    const p = alignmentPatch(cards(), 'vdist')
    expect(p.get('a')?.y).toBe(0)
    expect(p.get('b')?.y).toBe(300)
    expect(p.get('c')?.y).toBe(600)
  })
  it('网格按行列排布', () => {
    const p = alignmentPatch(cards(), 'grid')
    // cols=ceil(sqrt3)=2, cw=maxw120+60=180, ch=maxh100+60=160, origin(0,0)
    // 排序 by y,x: a(0,0),b(300,200),c(50,400) → a(0,0), b(180,0), c(0,160)
    expect(p.get('a')).toEqual({ x: 0, y: 0 })
    expect(p.get('b')).toEqual({ x: 180, y: 0 })
    expect(p.get('c')).toEqual({ x: 0, y: 160 })
  })
})

describe('groupChipBounds', () => {
  it('空数组返回 null', () => {
    expect(groupChipBounds([])).toBeNull()
  })
  it('返回成员包围盒中心的固定尺寸芯片', () => {
    const r = groupChipBounds([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 200, y: 300, w: 100, h: 100 },
    ])
    // 中心 (150, 200)，芯片 176x52
    expect(r).toEqual({ x: 150 - 88, y: 200 - 26, w: 176, h: 52 })
  })
})

describe('saveDebounceMs', () => {
  it('视图类恒为 600', () => {
    expect(saveDebounceMs('view', 1000)).toBe(600)
  })
  it('小画布全文回落 600', () => {
    expect(saveDebounceMs('full', 30)).toBe(600)
  })
  it('中等画布 1150，大画布 1400', () => {
    expect(saveDebounceMs('full', 200)).toBe(1150)
    expect(saveDebounceMs('full', 500)).toBe(1400)
  })
  it('弱网加 300 且封顶 1500', () => {
    expect(saveDebounceMs('full', 200, { saveData: true })).toBe(1450)
    expect(saveDebounceMs('full', 500, { rtt: 500 })).toBe(1500)
  })
})

describe('cascadeDropPos', () => {
  it('首张落在原点，之后每张往右下退一个步长', () => {
    expect(cascadeDropPos({ x: 100, y: 200 }, 0)).toEqual({ x: 100, y: 200 })
    expect(cascadeDropPos({ x: 100, y: 200 }, 1)).toEqual({ x: 140, y: 240 })
    expect(cascadeDropPos({ x: 100, y: 200 }, 3)).toEqual({ x: 220, y: 320 })
  })
  it('支持自定义步长', () => {
    expect(cascadeDropPos({ x: 0, y: 0 }, 2, 10)).toEqual({ x: 20, y: 20 })
  })
})

describe('geometrySignature', () => {
  const a = { id: 'a', x: 0, y: 0, w: 100, h: 200 }
  const b = { id: 'b', x: 10, y: 20, w: 30, h: 40 }

  it('相同几何(含其它非几何字段不同)签名一致', () => {
    const withExtra = [
      { ...a, prompt: 'x' },
      { ...b, jobStatus: 'running' },
    ]
    expect(geometrySignature(withExtra)).toBe(geometrySignature([a, b]))
  })
  it('任一几何字段变化签名改变', () => {
    const base = geometrySignature([a, b])
    expect(geometrySignature([a, { ...b, x: 11 }])).not.toBe(base)
    expect(geometrySignature([a, { ...b, h: 41 }])).not.toBe(base)
  })
  it('卡片增删(数量/顺序/id)签名改变', () => {
    const base = geometrySignature([a, b])
    expect(geometrySignature([a])).not.toBe(base)
    expect(geometrySignature([a, { ...b, id: 'c' }])).not.toBe(base)
    expect(geometrySignature([b, a])).not.toBe(base)
  })
  it('空数组签名稳定', () => {
    expect(geometrySignature([])).toBe(geometrySignature([]))
  })
})

describe('connectionSignatures', () => {
  const c1 = { id: 'l1', fromId: 'a', toId: 'b' }
  const c2 = { id: 'l2', fromId: 'a', toId: 'c', toSlot: 'front' }

  it('无连线返回空表', () => {
    expect(connectionSignatures([]).size).toBe(0)
  })

  it('同集合(顺序不同)签名一致, 不同集合签名变化', () => {
    const base = connectionSignatures([c1, c2])
    expect(connectionSignatures([c2, c1]).get('a')).toBe(base.get('a'))
    // a 参与两条连线: 删掉一条后 a/b/c 的相关签名都变
    const removed = connectionSignatures([c1])
    expect(removed.get('a')).not.toBe(base.get('a'))
    expect(removed.has('c')).toBe(false)
    expect(removed.get('b')).toBe(base.get('b'))
  })

  it('只影响相关卡片: 与变化连线无关的卡签名不变', () => {
    const base = connectionSignatures([c1, { id: 'l3', fromId: 'x', toId: 'y' }])
    const next = connectionSignatures([c1, { id: 'l4', fromId: 'x', toId: 'z' }])
    expect(next.get('a')).toBe(base.get('a'))
    expect(next.get('b')).toBe(base.get('b'))
    expect(next.get('x')).not.toBe(base.get('x'))
  })

  it('槽位变化签名改变(同端点)', () => {
    const base = connectionSignatures([c2])
    const moved = connectionSignatures([{ ...c2, toSlot: 'back' }])
    expect(moved.get('b' as string)).toBeUndefined()
    expect(moved.get('c')).not.toBe(base.get('c'))
  })
})
