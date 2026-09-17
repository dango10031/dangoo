import type { SetStateAction } from 'react'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type {
  CanvasCardData,
  CanvasConnection,
  CanvasViewport,
  GenLogEntry,
  PendingJobRecord,
  ProjectAssets,
} from './canvasTypes'

const DEFAULT_VIEWPORT: CanvasViewport = { x: 80, y: 80, scale: 1 }
const EMPTY_PROJECT_ASSETS: ProjectAssets = { items: [], folders: [] }

function emptyDocumentState() {
  return {
    canvasTitle: '未命名画布',
    cards: [] as CanvasCardData[],
    connections: [] as CanvasConnection[],
    viewport: DEFAULT_VIEWPORT,
    pendingJobs: [] as PendingJobRecord[],
    genLogs: [] as GenLogEntry[],
    projectAssets: EMPTY_PROJECT_ASSETS,
  }
}

export interface CanvasDocBucket {
  cards: CanvasCardData[]
  connections: CanvasConnection[]
  viewport: CanvasViewport
  title: string
  pending: PendingJobRecord[]
  projectAssets: ProjectAssets
  logs: GenLogEntry[]
  rev: number
}

interface CanvasDocumentState {
  activeCanvasId: string
  docLoaded: boolean
  canvasTitle: string
  cards: CanvasCardData[]
  connections: CanvasConnection[]
  viewport: CanvasViewport
  pendingJobs: PendingJobRecord[]
  genLogs: GenLogEntry[]
  projectAssets: ProjectAssets
  setActiveCanvasId: (canvasId: string) => void
  setDocLoaded: (value: SetStateAction<boolean>) => void
  setCanvasTitle: (value: SetStateAction<string>) => void
  setCards: (value: SetStateAction<CanvasCardData[]>) => void
  setConnections: (value: SetStateAction<CanvasConnection[]>) => void
  setViewport: (value: SetStateAction<CanvasViewport>) => void
  setPendingJobs: (value: SetStateAction<PendingJobRecord[]>) => void
  setGenLogs: (value: SetStateAction<GenLogEntry[]>) => void
  setProjectAssets: (value: SetStateAction<ProjectAssets>) => void
}

export interface CanvasDocumentStore extends StoreApi<CanvasDocumentState> {
  getBucket: (canvasId: string) => CanvasDocBucket | undefined
  captureBucket: (canvasId?: string) => CanvasDocBucket | undefined
  setBucketRevision: (canvasId: string, revision: number) => void
}

function resolveStateAction<T>(value: SetStateAction<T>, previous: T): T {
  return typeof value === 'function' ? (value as (current: T) => T)(previous) : value
}

export function createCanvasDocumentStore(initialCanvasId = ''): CanvasDocumentStore {
  const buckets: Record<string, CanvasDocBucket> = {}
  function captureBucket(canvasId?: string): CanvasDocBucket | undefined {
    const state = store.getState()
    const id = canvasId ?? state.activeCanvasId
    if (!id) return undefined
    if (id !== state.activeCanvasId) return buckets[id]
    const bucket: CanvasDocBucket = {
      cards: state.cards,
      connections: state.connections,
      viewport: state.viewport,
      title: state.canvasTitle,
      pending: state.pendingJobs,
      projectAssets: state.projectAssets,
      logs: state.genLogs,
      rev: buckets[id]?.rev ?? 0,
    }
    buckets[id] = bucket
    return bucket
  }

  function updateDocumentField<K extends keyof Pick<
    CanvasDocumentState,
    'docLoaded' | 'canvasTitle' | 'cards' | 'connections' | 'viewport' | 'pendingJobs' | 'genLogs' | 'projectAssets'
  >>(key: K, value: SetStateAction<CanvasDocumentState[K]>) {
    const previous = store.getState()[key]
    const next = resolveStateAction(value, previous)
    if (Object.is(previous, next)) return
    store.setState({ [key]: next } as Pick<CanvasDocumentState, K>)
    captureBucket()
  }

  const base = createStore<CanvasDocumentState>()((set, get) => ({
    activeCanvasId: initialCanvasId,
    docLoaded: false,
    canvasTitle: '未命名画布',
    cards: [],
    connections: [],
    viewport: DEFAULT_VIEWPORT,
    pendingJobs: [],
    genLogs: [],
    projectAssets: EMPTY_PROJECT_ASSETS,
    setActiveCanvasId: canvasId => {
      const previousId = get().activeCanvasId
      if (previousId === canvasId) return
      if (previousId) captureBucket()
      const target = buckets[canvasId]
      set({
        activeCanvasId: canvasId,
        docLoaded: false,
        ...(target
          ? {
              canvasTitle: target.title,
              cards: target.cards,
              connections: target.connections,
              viewport: target.viewport,
              pendingJobs: target.pending,
              genLogs: target.logs,
              projectAssets: target.projectAssets,
            }
          : emptyDocumentState()),
      })
    },
    setDocLoaded: value => updateDocumentField('docLoaded', value),
    setCanvasTitle: value => updateDocumentField('canvasTitle', value),
    setCards: value => updateDocumentField('cards', value),
    setConnections: value => updateDocumentField('connections', value),
    setViewport: value => updateDocumentField('viewport', value),
    setPendingJobs: value => updateDocumentField('pendingJobs', value),
    setGenLogs: value => updateDocumentField('genLogs', value),
    setProjectAssets: value => updateDocumentField('projectAssets', value),
  }))

  const store: CanvasDocumentStore = Object.assign(base, {
    getBucket: (canvasId: string) => {
      if (canvasId && canvasId === store.getState().activeCanvasId) return captureBucket(canvasId)
      return buckets[canvasId]
    },
    captureBucket,
    setBucketRevision: (canvasId: string, revision: number) => {
      const bucket = canvasId === store.getState().activeCanvasId
        ? captureBucket(canvasId)
        : buckets[canvasId]
      if (bucket) bucket.rev = revision
    },
  })

  return store
}
