

// 导出时的站内链 → 绝对地址转换依赖运行环境，经 toAbsolute 注入，便于纯单测。
import type { CanvasCardData, CanvasConnection } from './canvasTypes'
import type { CropContext } from '@/components/canvas/imageEdit/localPatch'
import { cardShowsVideo } from './canvasTopology'

export interface MergePatch {
  card: CanvasCardData
  url: string
  context: CropContext
}

export interface MergeInputs {
  original?: { card: CanvasCardData; url: string }
  patches: MergePatch[]
  error?: string
}

/**
 * 融合节点输入解析: 沿入边找上游图片卡, cropContext 为空 = 完整原图候选,
 * 有 cropContext(v2) = 局部修改图。多张原图取第一张; 局部图按连线顺序保留;
 * 视频卡与无主图卡不参与。
 */
export function resolveMergeInputs(
  cardId: string,
  cards: CanvasCardData[],
  connections: CanvasConnection[],
): MergeInputs {
  const fromCards = connections
    .filter(conn => conn.toId === cardId)
    .map(conn => cards.find(c => c.id === conn.fromId))
    .filter((c): c is CanvasCardData => !!c?.url && c.kind !== 'video' && !cardShowsVideo(c))
  const originals: Array<{ card: CanvasCardData; url: string }> = []
  const patches: MergePatch[] = []
  fromCards.forEach(card => {
    const url = card.url as string
    if (card.cropContext && card.cropContext.version === 2) {
      patches.push({ card, url, context: card.cropContext })
    } else {
      originals.push({ card, url })
    }
  })
  if (!originals.length) return { patches, error: '请连接一张完整原图' }
  if (!patches.length) return { original: originals[0], patches, error: '请连接至少一张提取的局部修改图' }
  if (patches.length > 16) return { original: originals[0], patches, error: '一次最多融合 16 张局部图' }
  return { original: originals[0], patches }
}

export interface ExportItem {
  url: string
  name?: string
  isVideo?: boolean
}

/**
 * 收集选中卡片的可导出素材:
 * 有成功结果的卡片展开每个成功结果(命名取结果标题, 否则「卡名/提示词-序号」);
 * 无成功结果但有主图的取主图。最后只保留 http(s) 绝对链接并按 URL 去重——
 * 站内 /api/files/ 永久链先经 toAbsolute 转绝对地址(同源含 __pb 前缀), 否则会被过滤丢掉。
 */
export function collectExportItemsFor(
  cardIds: string[],
  cards: CanvasCardData[],
  toAbsolute: (url: string) => string | undefined,
): ExportItem[] {
  const items: ExportItem[] = []
  cardIds.forEach(id => {
    const c = cards.find(x => x.id === id)
    if (!c) return
    const okResults = (Array.isArray(c.results) ? c.results : [])
      .filter(r => r.itemStatus === 'success' && r.url)
      .map((r, index) => ({
        url: r.url as string,
        name: r.title || `${c.title || c.prompt || '生成图片'}-${index + 1}`,
        isVideo: r.isVideo === true,
      }))
    if (okResults.length) items.push(...okResults)
    else if (c.url) items.push({ url: c.url, name: c.title || c.prompt || '生成图片', isVideo: c.kind === 'video' })
  })
  const seen = new Set<string>()
  return items
    .map(item => (/^https?:\/\//i.test(item.url) ? item : { ...item, url: toAbsolute(item.url) ?? item.url }))
    .filter(item => {
      if (!/^https?:\/\//i.test(item.url) || seen.has(item.url)) return false
      seen.add(item.url)
      return true
    })
}
