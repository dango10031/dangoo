import { useCallback, useEffect, useRef } from 'react'
import { useStore } from 'zustand'
import { getAuthHeaders } from '@/lib/auth'
import {
  canonicalMediaPath,
  isDurableOutputMediaUrl,
  isPersistedMediaUrl,
} from '@/lib/media'
import { getPocketBaseUrl } from '@/lib/pb'
import { persistRemoteImage } from './canvasUtils'
import {
  LEGACY_VIDEO_SLUG_MAP,
  channelFamilyOf,
  defaultGenParams,
  defaultImageGenParams,
} from './canvasModels'
import {
  defaultLayerState,
  defaultMotionState,
  defaultPolishState,
  defaultRepState,
  defaultTtsState,
  defaultVsrState,
} from './canvasTypes'
import type {
  CardJobStatus,
  CardKind,
  CanvasCardData,
  LayerStage,
  MotionNodeState,
  RepStage,
  TtsNodeState,
  VsrNodeState,
} from './canvasTypes'
import type { CanvasDocumentStore } from './canvasDocumentStore'

const DATA_URL_CACHE_MAX = 24

function looksLikeFileName(text: string): boolean {
  return /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|mp4|mov)$/i.test(text.trim())
}

function stripDeployedPrefix(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.includes('/__pb/api/files/') ? canonicalMediaPath(value) : value
  }
  if (Array.isArray(value)) return value.map(item => stripDeployedPrefix(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = stripDeployedPrefix((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function useCanvasMedia(documentStore: CanvasDocumentStore) {
  const cards = useStore(documentStore, state => state.cards)
  const { setCards } = documentStore.getState()
  const lastPersistedMediaRef = useRef<Map<string, { url: string; results?: CanvasCardData['results'] }>>(new Map())
  const dataUrlCacheRef = useRef<Map<string, string>>(new Map())
  const rehostingRef = useRef<Set<string>>(new Set())
  const healTriedRef = useRef<Set<string>>(new Set())

  // 渲染后同步已确认媒体。上传中的 blob 不能进入该桶，否则会失去上一版永久媒体兜底。
  useEffect(() => {
    const liveIds = new Set(cards.map(card => card.id))
    Array.from(lastPersistedMediaRef.current.keys()).forEach(id => {
      if (!liveIds.has(id)) lastPersistedMediaRef.current.delete(id)
    })
    cards.forEach(card => {
      if (!card.url || card.url.startsWith('blob:')) return
      const previous = lastPersistedMediaRef.current.get(card.id)
      if (!previous || previous.url !== card.url) {
        lastPersistedMediaRef.current.set(card.id, {
          url: card.url,
          ...(card.results ? { results: card.results.map(result => ({ ...result })) } : {}),
        })
      }
    })
  }, [cards])

  const cacheDataUrl = useCallback((key: string, value: string) => {
    const cache = dataUrlCacheRef.current
    if (cache.has(key)) cache.delete(key)
    cache.set(key, value)
    while (cache.size > DATA_URL_CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }, [])

  const readDataUrl = useCallback((key: string): string | undefined => {
    const cache = dataUrlCacheRef.current
    const hit = cache.get(key)
    if (hit !== undefined) {
      cache.delete(key)
      cache.set(key, hit)
    }
    return hit
  }, [])

  const normalizeRestoredCards = useCallback((
    rawCards: CanvasCardData[],
    inFlightResultKeys?: Set<string>,
  ): CanvasCardData[] => {
    return rawCards.map(raw => {
      let card: CanvasCardData = stripDeployedPrefix(raw) as CanvasCardData
      if (card.jobStatus === 'running' || card.jobStatus === 'queued') {
        const hasSuccess =
          !!card.url ||
          (Array.isArray(card.results) && card.results.some(result => result.itemStatus === 'success' && result.url))
        card = { ...card, jobStatus: hasSuccess ? ('success' as const) : undefined }
      }
      if (card.kind === 'layer' && card.layerState) {
        const state = card.layerState
        const layers = (state.layers ?? []).map(layer => {
          if (layer.genStatus === 'queued' || layer.genStatus === 'running') {
            return { ...layer, genStatus: 'failed' as const, errorMsg: '任务在刷新时中断了, 请点击重试' }
          }
          return { ...layer, cutoutUrl: null }
        })
        const stage: LayerStage =
          state.stage === 'analyzing' || state.stage === 'generating'
            ? (layers.length ? 'ready' : 'idle')
            : state.stage
        const family = channelFamilyOf(state.genModel ?? '')
        return {
          ...card,
          layerState: {
            ...defaultLayerState(),
            ...state,
            layers,
            stage,
            genModel: family ? family.key : 'gpt-image-2',
          },
        }
      }
      if (card.kind === 'replicate' && card.repState) {
        const state = card.repState
        const jobStatus = {
          front:
            state.jobStatus?.front === 'running' || state.jobStatus?.front === 'queued'
              ? ('failed' as const)
              : state.jobStatus?.front ?? ('idle' as const),
          back:
            state.jobStatus?.back === 'running' || state.jobStatus?.back === 'queued'
              ? ('failed' as const)
              : state.jobStatus?.back ?? ('idle' as const),
        }
        const stage: RepStage =
          state.stage === 'analyzing' || state.stage === 'generating'
            ? (state.frontPrompt || state.backPrompt ? 'ready' : 'idle')
            : state.stage
        const family = channelFamilyOf(state.genModel ?? '')
        return {
          ...card,
          repState: {
            ...defaultRepState(),
            ...state,
            jobStatus,
            stage,
            genModel: family ? family.key : 'gpt-image-2',
          },
        }
      }
      if ((card.kind as string) === 'image') {
        const rawPrompt = card.prompt ?? ''
        return {
          ...card,
          kind: 'generate' as CardKind,
          prompt: looksLikeFileName(rawPrompt) ? '' : rawPrompt,
          genParams: card.genParams ?? defaultImageGenParams(),
          w: 320,
          h: card.url ? Math.max(card.h, 560) : 180,
        }
      }
      if (card.kind === 'generate') {
        let results = card.results
        if (Array.isArray(results) && results.length) {
          results = results.map((result, resultIndex) => {
            const inFlight = !!inFlightResultKeys?.has(`${card.id}:${resultIndex}`)
            if (result.itemStatus === 'running') {
              return inFlight
                ? { ...result, itemStatus: 'queued' as CardJobStatus, errorMsg: undefined }
                : result
            }
            if (result.itemStatus === 'queued' && !inFlight) {
              return {
                ...result,
                itemStatus: 'failed' as CardJobStatus,
                errorMsg: '任务在刷新时中断了, 请点击重试',
              }
            }
            if (result.itemStatus === 'queued' && inFlight) return { ...result, errorMsg: undefined }
            return result
          })
        }
        const activeIndex = results?.length
          ? Math.min(card.activeResultIndex ?? 0, results.length - 1)
          : 0
        const active = results?.[activeIndex]
        const firstSuccess = results?.find(result => result.itemStatus === 'success' && result.url)
        const main =
          active && active.itemStatus === 'success' && active.url
            ? active
            : firstSuccess
        return {
          ...card,
          results,
          activeResultIndex: results?.length ? activeIndex : card.activeResultIndex,
          url: main?.url ?? card.url,
          cropContext: main ? main.cropContext ?? null : card.cropContext,
          genParams: {
            ...defaultGenParams(),
            ...card.genParams,
            ...(card.genParams?.model && LEGACY_VIDEO_SLUG_MAP[card.genParams.model]
              ? { model: LEGACY_VIDEO_SLUG_MAP[card.genParams.model] }
              : {}),
            ...(card.url || main?.url || card.genParams?.aspectRatio ? {} : { aspectRatio: '16:9' }),
          },
          w: 320,
          h: card.url || main?.url ? Math.max(card.h, 560) : 180,
        }
      }
      if (card.kind === 'polish') {
        return {
          ...card,
          polishState: { ...defaultPolishState(), ...card.polishState },
          w: Math.max(card.w, 300),
          h: Math.max(card.h, 270),
        }
      }
      if (card.kind === 'tts') {
        const state: TtsNodeState = { ...defaultTtsState(), ...card.ttsState }
        if (state.cloneAudioUrl?.startsWith('blob:')) state.cloneAudioUrl = undefined
        if (state.emotionRefAudioUrl?.startsWith('blob:')) state.emotionRefAudioUrl = undefined
        if (state.resultUrl?.startsWith('blob:')) state.resultUrl = undefined
        return { ...card, ttsState: state, w: Math.max(card.w, 380), h: Math.max(card.h, 560) }
      }
      if (card.kind === 'motion') {
        const state: MotionNodeState = { ...defaultMotionState(), ...card.motionState }
        if (state.refImageUrl?.startsWith('blob:')) {
          state.refImageUrl = undefined
          state.refImageName = undefined
        }
        if (state.refVideoUrl?.startsWith('blob:')) {
          state.refVideoUrl = undefined
          state.refVideoName = undefined
          state.refVideoDuration = undefined
        }
        if (state.resultUrl?.startsWith('blob:')) state.resultUrl = undefined
        return { ...card, motionState: state, w: Math.max(card.w, 380), h: card.h }
      }
      if (card.kind === 'vsr') {
        const state: VsrNodeState = { ...defaultVsrState(), ...card.vsrState }
        if (state.videoUrl?.startsWith('blob:')) {
          state.videoUrl = undefined
          state.videoName = undefined
          state.videoDuration = undefined
        }
        if (state.resultUrl?.startsWith('blob:')) state.resultUrl = undefined
        return { ...card, vsrState: state, w: Math.max(card.w, 380), h: card.h }
      }
      return card
    })
  }, [])

  const rehostTempMediaCards = useCallback(async (cardList: CanvasCardData[]) => {
    const temporaryHost = /^https?:\/\/[^/]*myqcloud\.com\/.*[?&]q-sign-=/i
    const jobs: Array<() => Promise<void>> = []
    cardList.forEach(card => {
      const pushJob = (
        oldUrl: string,
        kind: 'image' | 'video' | 'audio',
        apply: (permanent: string) => void,
      ) => {
        if (!temporaryHost.test(oldUrl) || rehostingRef.current.has(oldUrl)) return
        rehostingRef.current.add(oldUrl)
        jobs.push(async () => {
          try {
            const permanent = await persistRemoteImage(oldUrl, kind)
            if (permanent && permanent !== oldUrl && isPersistedMediaUrl(permanent)) {
              apply(canonicalMediaPath(permanent))
            }
          } catch {
            // 单条失败不阻塞其它，下次打开再试。
          } finally {
            setTimeout(() => rehostingRef.current.delete(oldUrl), 60_000)
          }
        })
      }
      if (card.url) {
        pushJob(card.url, card.kind === 'video' ? 'video' : 'image', url => {
          setCards(previous => previous.map(item => (item.id === card.id ? { ...item, url } : item)))
        })
      }
      card.results?.forEach((result, resultIndex) => {
        if (!result.url) return
        pushJob(result.url, result.isVideo ? 'video' : 'image', url => {
          setCards(previous => previous.map(item => {
            if (item.id !== card.id || !item.results?.[resultIndex]) return item
            const results = item.results.map((current, index) =>
              index === resultIndex ? { ...current, url } : current,
            )
            return {
              ...item,
              results,
              url: item.activeResultIndex === resultIndex ? url : item.url,
            }
          }))
        })
      })
      if (card.ttsState?.resultUrl) {
        pushJob(card.ttsState.resultUrl, 'audio', resultUrl => {
          setCards(previous => previous.map(item =>
            item.id === card.id
              ? { ...item, ttsState: { ...defaultTtsState(), ...item.ttsState, resultUrl } }
              : item,
          ))
        })
      }
      if (card.motionState?.resultUrl) {
        pushJob(card.motionState.resultUrl, 'video', resultUrl => {
          setCards(previous => previous.map(item =>
            item.id === card.id
              ? { ...item, motionState: { ...defaultMotionState(), ...item.motionState, resultUrl } }
              : item,
          ))
        })
      }
      if (card.vsrState?.resultUrl) {
        pushJob(card.vsrState.resultUrl, 'video', resultUrl => {
          setCards(previous => previous.map(item =>
            item.id === card.id
              ? { ...item, vsrState: { ...defaultVsrState(), ...item.vsrState, resultUrl } }
              : item,
          ))
        })
      }
    })
    let cursor = 0
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor]
        cursor += 1
        await job()
      }
    }
    if (jobs.length) {
      await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, () => worker()))
    }
  }, [setCards])

  const healResultImageByTask = useCallback(async (
    cardId: string,
    index: number,
    taskId: string,
  ) => {
    if (!taskId || healTriedRef.current.has(taskId)) return
    healTriedRef.current.add(taskId)
    try {
      const response = await fetch(`${getPocketBaseUrl()}/api/media/result-urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ taskIds: [taskId] }),
      })
      if (!response.ok) return
      const data = (await response.json().catch(() => null)) as { urls?: Record<string, string> } | null
      const durable = data?.urls?.[taskId]
      if (!durable || !isDurableOutputMediaUrl(durable)) return
      setCards(previous => previous.map(card => {
        const item = card.id === cardId ? card.results?.[index] : undefined
        if (!item || item.taskId !== taskId || !isPersistedMediaUrl(item.url)) return card
        const results = card.results!.map((result, resultIndex) =>
          resultIndex === index ? { ...result, url: durable } : result,
        )
        return {
          ...card,
          results,
          ...(card.activeResultIndex === index ? { url: durable } : {}),
        }
      }))
    } catch {
      // 裂图自愈失败不阻塞画布，负缓存避免同一任务重复请求。
    }
  }, [setCards])

  const buildPersistCards = useCallback((sourceCards: CanvasCardData[]): CanvasCardData[] => {
    return sourceCards.map(card => {
      let next = card
      if (card.kind === 'layer' && card.layerState) {
        next = {
          ...card,
          layerState: {
            ...card.layerState,
            layers: card.layerState.layers.map(layer => ({ ...layer, cutoutUrl: null })),
          },
        }
      }
      if (next.url?.startsWith('blob:')) {
        const previousMedia = lastPersistedMediaRef.current.get(card.id)
        if (previousMedia) {
          next = {
            ...next,
            url: previousMedia.url,
            ...(previousMedia.results ? { results: previousMedia.results } : {}),
          }
        } else {
          next = {
            ...next,
            url: '',
            jobStatus: next.jobStatus === 'running' ? 'queued' : next.jobStatus,
          }
        }
      }
      if (next.kind === 'tts' && next.ttsState) {
        const state = { ...next.ttsState }
        let dirty = false
        if (state.cloneAudioUrl?.startsWith('blob:')) {
          state.cloneAudioUrl = undefined
          state.cloneAudioName = undefined
          dirty = true
        }
        if (state.emotionRefAudioUrl?.startsWith('blob:')) {
          state.emotionRefAudioUrl = undefined
          state.emotionRefAudioName = undefined
          dirty = true
        }
        if (state.resultUrl?.startsWith('blob:')) {
          state.resultUrl = undefined
          dirty = true
        }
        if (dirty) next = { ...next, ttsState: state }
      }
      if (next.kind === 'motion' && next.motionState) {
        const state = { ...next.motionState }
        let dirty = false
        if (state.refImageUrl?.startsWith('blob:')) {
          state.refImageUrl = undefined
          state.refImageName = undefined
          dirty = true
        }
        if (state.refVideoUrl?.startsWith('blob:')) {
          state.refVideoUrl = undefined
          state.refVideoName = undefined
          state.refVideoDuration = undefined
          dirty = true
        }
        if (state.resultUrl?.startsWith('blob:')) {
          state.resultUrl = undefined
          dirty = true
        }
        if (dirty) next = { ...next, motionState: state }
      }
      if (next.kind === 'vsr' && next.vsrState) {
        const state = { ...next.vsrState }
        let dirty = false
        if (state.videoUrl?.startsWith('blob:')) {
          state.videoUrl = undefined
          state.videoName = undefined
          state.videoDuration = undefined
          dirty = true
        }
        if (state.resultUrl?.startsWith('blob:')) {
          state.resultUrl = undefined
          dirty = true
        }
        if (dirty) next = { ...next, vsrState: state }
      }
      return next
    })
  }, [])

  return {
    cacheDataUrl,
    readDataUrl,
    normalizeRestoredCards,
    rehostTempMediaCards,
    healResultImageByTask,
    buildPersistCards,
  }
}
