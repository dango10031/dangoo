import { useRef, useState } from 'react'
import { getAigcModelInfo, type AigcModelInfo } from '@/lib/aigc'
import { aiAppSlugOf } from './canvasModels'

/**
 * 每个渠道模型的接口契约缓存（标量参数/媒体参数/枚举）。
 * 从 useCanvas 抽出：getNodeModelInfo 供渲染控件用（未命中后台拉取并触发一次重渲染），
 * ensureModelInfo 供运行前等待契约；AI 应用渠道没有标准契约，统一记 null 不拉取。
 */
export function useModelInfo() {
  const cacheRef = useRef<Record<string, AigcModelInfo | null>>({})
  const inflightRef = useRef<Record<string, boolean>>({})
  const [, setTick] = useState(0)

  function requestModelInfo(slug: string) {
    // AI 应用渠道没有标准 openapi 模型契约, 参数控件本就不渲染, 直接记空不拉取
    if (aiAppSlugOf(slug)) {
      if (!(slug in cacheRef.current)) cacheRef.current[slug] = null
      return
    }
    if (slug in cacheRef.current || inflightRef.current[slug]) return
    inflightRef.current[slug] = true
    getAigcModelInfo(slug)
      .then(info => {
        cacheRef.current[slug] = info
      })
      .catch(() => {
        cacheRef.current[slug] = null
      })
      .finally(() => {
        inflightRef.current[slug] = false
        setTick(t => t + 1)
      })
  }

  /** 渲染期读契约：未命中时发起后台拉取，立即返回 null（拉完触发重渲染） */
  function getNodeModelInfo(slug: string): AigcModelInfo | null {
    if (!(slug in cacheRef.current)) requestModelInfo(slug)
    return cacheRef.current[slug] ?? null
  }

  /** 运行前等契约：命中缓存直接返回，未命中则等待本次拉取结果；失败返回 null */
  async function ensureModelInfo(slug: string): Promise<AigcModelInfo | null> {
    if (aiAppSlugOf(slug)) return null
    if (slug in cacheRef.current) return cacheRef.current[slug]
    try {
      const info = await getAigcModelInfo(slug)
      cacheRef.current[slug] = info
      return info
    } catch {
      return null
    }
  }

  return { requestModelInfo, getNodeModelInfo, ensureModelInfo }
}
