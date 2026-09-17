import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Check, FolderOpen, HardDrive, Loader2, MousePointer2, Pencil, ScrollText, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AccountChip } from '@/components/canvas/account/AccountChip'
import { NotificationBell } from '@/components/canvas/account/NotificationBell'
import { AssistantStatus } from '@/components/canvas/AssistantStatus'
import type { useCanvas } from '@/pages/Canvas/useCanvas'

type CanvasVm = ReturnType<typeof useCanvas>

/**
 * 画布名: 平时显示为静态标题(点一下进入编辑), 编辑态有明确的 ✓ 确认按钮,
 * 回车/✓ 提交, Esc 还原, 失焦自动提交。不能用常驻 input——画布 pointerdown 为拖动画布
 * 会 preventDefault 阻止默认焦点转移, 常驻 input 一旦聚焦就退不出去(表现为卡在输入态)。
 */
function CanvasTitle({ p }: { p: CanvasVm }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(p.canvasTitle)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = () => {
    if (!editing) return
    const next = draft.trim()
    p.setCanvasTitle(next)
    setDraft(next)
    setEditing(false)
  }
  const cancel = () => {
    setDraft(p.canvasTitle)
    setEditing(false)
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(p.canvasTitle)
          setEditing(true)
        }}
        title="点击重命名画布"
        className="group flex max-w-[220px] items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm font-semibold text-foreground transition-colors hover:bg-muted"
      >
        <span className="truncate">{p.canvasTitle || '未命名画布'}</span>
        <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    )
  }

  return (
    <span className="flex items-center gap-1">
      <input
        ref={inputRef}
        value={draft}
        onChange={e => {
          setDraft(e.target.value)
          p.setCanvasTitle(e.target.value)
        }}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') cancel()
        }}
        onPointerDown={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        placeholder="未命名画布"
        maxLength={60}
        className="h-8 w-44 rounded-md bg-muted px-2 py-1 text-sm font-semibold text-foreground outline-none ring-1 ring-primary"
      />
      <button
        type="button"
        title="确认(回车)"
        onClick={commit}
        onPointerDown={e => e.stopPropagation()}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <Check className="h-4 w-4" />
      </button>
    </span>
  )
}

export function CanvasTopBar({ p }: { p: CanvasVm }) {
  // 保存状态六档: editing 编辑中(静默等待); local 本地已存待同步; saving 同步中(>300ms 才显示);
  // saved 已保存; error 同步失败可点重试; conflict 冲突待选择(另有弹窗)。idle 不显示, 避免误导。
  const saveBadge = (() => {
    if (p.saveState === 'saving') {
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          同步中…
        </span>
      )
    }
    if (p.saveState === 'local') {
      return (
        <span
          className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
          title="改动已安全保存在本机, 网络恢复或重新登录后会自动同步到云端"
        >
          <HardDrive className="h-3.5 w-3.5" />
          本地已存·待同步
        </span>
      )
    }
    if (p.saveState === 'editing') {
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground/70">
          <Pencil className="h-3 w-3" />
          编辑中
        </span>
      )
    }
    if (p.saveState === 'error') {
      return (
        <button
          type="button"
          onClick={() => p.flushPersistNow()}
          title="云端同步失败, 改动尚未落本地盘, 点击立即重试"
          className="flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          同步失败·点击重试
        </button>
      )
    }
    if (p.saveState === 'conflict') {
      return (
        <span className="flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
          <AlertTriangle className="h-3.5 w-3.5" />
          画布在别处被修改
        </span>
      )
    }
    if (p.saveState === 'saved') {
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Check className="h-3.5 w-3.5 text-primary" />
          已保存
        </span>
      )
    }
    return null
  })()
  return (
    <header
      className="z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-card/90 px-3 shadow-sm backdrop-blur"
      onPointerDown={e => {
        // 点标题输入框改名时不清; 点顶栏其它功能区视为「操作别处」, 取消画布节点选中
        const el = e.target as HTMLElement
        if (el.closest('input, textarea, select, [contenteditable="true"]')) return
        if (p.selectedIds.length) p.clearSelection()
      }}
    >
      {/* 左上角: 账号 / 余额 */}
      <div className="shrink-0">
        <AccountChip
          account={p.account}
          balance={p.walletBalance}
          isAdmin={p.walletAdmin}
          onLogin={() => p.setAuthDialog('login')}
          onRecharge={() => p.openRecharge()}
          onLogout={() => { p.setAccount(null); void p.refreshWallet() }}
        />
      </div>

      <div className="shrink-0">
        <NotificationBell onBalanceChanged={() => void p.refreshWallet()} />
      </div>

      <div className="h-6 w-px bg-border" />
      <Link
        to="/"
        className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        返回首页
      </Link>
      <CanvasTitle p={p} />
      {saveBadge}
      {p.conflictBackupAvailable && (
        <button
          type="button"
          onClick={() => void p.restoreConflictBackup()}
          title="取回冲突时被「加载最新」覆盖掉的本地版本, 并强制同步回云端(仅保留一次机会)"
          className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
        >
          <Undo2 className="h-3.5 w-3.5" />
          取回我的版本
        </button>
      )}
      <div className="flex-1" />
      <button
        type="button"
        title="资产库"
        onClick={() => p.setAssetPanelOpen(v => !v)}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-lg border transition-colors',
          p.assetPanelOpen
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border text-muted-foreground hover:border-primary hover:text-primary',
        )}
      >
        <FolderOpen className="h-4 w-4" />
      </button>
      <button
        type="button"
        title="生成日志"
        onClick={() => p.setLogDialogOpen(true)}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-lg border transition-colors',
          p.logDialogOpen
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border text-muted-foreground hover:border-primary hover:text-primary',
        )}
      >
        <ScrollText className="h-4 w-4" />
      </button>
      <AssistantStatus p={p} />
      <span className="hidden items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 py-1 text-xs text-muted-foreground md:flex">
        <MousePointer2 className="h-3.5 w-3.5 text-primary" />
        双击画布空白处创建节点 · Shift 拖动框选批量运行
      </span>
    </header>
  )
}
