import type { GeneratedAsset } from './generatedAssetsTypes'

export interface ProjectChip {
  canvasId: string
  title: string
  count: number
}

/** 从全部产物里统计每项目产物数(项目顺序: 产物最新时间倒序) */
export function buildProjectChips(assets: GeneratedAsset[]): ProjectChip[] {
  const map = new Map<string, { title: string; count: number; latest: number }>()
  for (const asset of assets) {
    const cur = map.get(asset.canvasId)
    if (cur) {
      cur.count += 1
      if (asset.createdAt > cur.latest) cur.latest = asset.createdAt
    } else {
      map.set(asset.canvasId, { title: asset.canvasTitle, count: 1, latest: asset.createdAt })
    }
  }
  return Array.from(map.entries())
    .map(([canvasId, v]) => ({ canvasId, title: v.title, count: v.count }))
    .sort((a, b) => {
      const la = map.get(a.canvasId)?.latest ?? 0
      const lb = map.get(b.canvasId)?.latest ?? 0
      return lb - la
    })
}
