import { useMemo, useState } from 'react'
import type { useCanvas } from '@/pages/Canvas/useCanvas'
import { isImageAssetKind, type AssetLibEntry } from './assetLib'
import { PRESET_WORKFLOW_ENTRIES } from './presetWorkflows'

type CanvasVm = ReturnType<typeof useCanvas>
export type AssetLibraryTab = 'images' | 'workflows'

/** 资产库面板纯 UI 状态: 页签 / 库范围 / 当前文件夹 */
export function useAssetLibraryPanel(p: CanvasVm) {
  const [activeTab, setActiveTab] = useState<AssetLibraryTab>('images')
  const [scope, setScope] = useState<'project' | 'global'>('project')
  // '' = 全部资产, 'uncategorized' = 未分类, 其它 = 文件夹 id
  const [selectedFolderId, setSelectedFolderId] = useState<string>('')

  // memo 化: 旧实现每次渲染都新建数组, 导致下游 tabEntries/visibleEntries/gridEntries 全部缓存失效重过滤
  const folders = useMemo(
    () => (scope === 'project' ? p.projectAssets.folders : p.globalFolders.map(f => ({ id: f.id, name: f.name ?? '未命名文件夹' }))),
    [scope, p.projectAssets.folders, p.globalFolders],
  )
  // 图片/工作流共用同一套库与文件夹, 只按 kind 过滤
  const allEntries = scope === 'project' ? p.projectAssetEntries : p.globalAssetEntries
  const tabEntries = useMemo(
    () => allEntries.filter(e => (activeTab === 'images' ? isImageAssetKind(e.kind) : e.kind === 'workflow')),
    [allEntries, activeTab],
  )

  // 切换范围 / 文件夹被删除后, 失效选择回落到「全部资产」; 原始选择保留, 返回原范围时可恢复
  const folderId = selectedFolderId && selectedFolderId !== 'uncategorized' && !folders.some(f => f.id === selectedFolderId)
    ? ''
    : selectedFolderId

  const visibleEntries = useMemo<AssetLibEntry[]>(() => {
    if (folderId === 'uncategorized') return tabEntries.filter(e => !e.folderId)
    if (folderId) return tabEntries.filter(e => e.folderId === folderId)
    return tabEntries
  }, [tabEntries, folderId])

  const currentFolder = useMemo(() => folders.find(f => f.id === folderId) ?? null, [folders, folderId])

  // 工作流页签: 内置预设始终置顶, 不受库范围/文件夹影响; 图片页签不出现预设
  const gridEntries = useMemo<AssetLibEntry[]>(
    () => (activeTab === 'workflows' ? [...PRESET_WORKFLOW_ENTRIES, ...visibleEntries] : visibleEntries),
    [activeTab, visibleEntries],
  )

  return {
    activeTab,
    setActiveTab,
    scope,
    setScope,
    setFolderId: setSelectedFolderId,
    folderId,
    folders,
    visibleEntries,
    gridEntries,
    currentFolder,
    totalCount: gridEntries.length,
  }
}
