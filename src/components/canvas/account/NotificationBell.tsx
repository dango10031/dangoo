import { useEffect, useRef, useState } from 'react'
import { useLatestRef } from '@/hooks/useLatestRef'
import { Bell, Check, Wallet } from 'lucide-react'
import { markNotificationRead, type NotificationItem } from '@/lib/wallet'
import { refreshNotifications, subscribeNotifications } from '@/lib/notificationsPoller'
import { onLocalAccountChange } from '@/lib/localAuth'
import { toast } from 'sonner'

const KIND_ICON: Record<string, React.ReactNode> = {
  recharge: <Wallet className="h-4 w-4 text-primary" />,
  admin_add: <Wallet className="h-4 w-4 text-primary" />,
  admin_sub: <Wallet className="h-4 w-4 text-destructive" />,
}

export function NotificationBell({ onBalanceChanged }: { onBalanceChanged?: () => void }) {
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)
  const seenIdsRef = useRef<Set<string> | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // 回调放进 ref: 调用方传内联函数时每次渲染都是新引用, 不能进 effect/回调依赖,
  // 否则画布高频重渲染会反复重订阅账号事件并立即拉一次通知, 把接口打到 429。
  const onBalanceChangedRef = useLatestRef(onBalanceChanged)

  // 统一通知数据源(跨组件/跨标签共享, 内部已做单飞、45s 冷却与 429 退避):
  // 首次数据只建立基线不弹窗, 之后出现的新未读 -> toast
  useEffect(() => {
    return subscribeNotifications(d => {
      const prev = seenIdsRef.current
      if (prev === null) {
        const init = new Set<string>()
        d.items.forEach(i => init.add(i.id))
        seenIdsRef.current = init
      } else {
        const fresh = d.items.filter(i => !i.read && !prev.has(i.id))
        fresh.forEach(n => {
          toast(n.title, { description: n.body, duration: 6000 })
          if (n.kind === 'recharge' || n.kind === 'admin_add') onBalanceChangedRef.current?.()
        })
        if (fresh.length) {
          const next = new Set(prev)
          fresh.forEach(n => next.add(n.id))
          seenIdsRef.current = next
        }
      }
      setItems(d.items)
      setUnread(d.unread)
    })
  }, [onBalanceChangedRef])

  // 登录态变化时启停轮询
  useEffect(() => {
    return onLocalAccountChange(acc => {
      const isIn = !!acc
      setLoggedIn(isIn)
      if (isIn) {
        seenIdsRef.current = null
        refreshNotifications(true)
      } else {
        setItems([]); setUnread(0); seenIdsRef.current = null
      }
    }, true)
  }, [])

  useEffect(() => {
    if (!loggedIn) return
    // 60s 轮询 + 切回前台补拉; 实际请求受协调器冷却/429 退避与跨标签节流约束
    const POLL_MS = 60000
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') refreshNotifications()
    }, POLL_MS)
    function onVisible() {
      if (document.visibilityState === 'visible') refreshNotifications()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loggedIn])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  async function openPanel() {
    const next = !open
    setOpen(next)
    if (next && unread > 0) {
      setUnread(0)
      await markNotificationRead()
      refreshNotifications(true)
    }
  }

  if (!loggedIn) return null

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => void openPanel()}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors hover:border-primary"
        title="通知"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-medium text-destructive-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-80 overflow-hidden rounded-lg border border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-medium">通知</span>
            <button
              type="button"
              onClick={() => {
                setUnread(0)
                void markNotificationRead().then(() => refreshNotifications(true))
              }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Check className="h-3 w-3" />全部已读
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">暂无通知</p>
            )}
            {items.map(n => (
              <div key={n.id} className={`flex gap-2 border-b border-border/60 px-3 py-2.5 last:border-0 ${n.read ? '' : 'bg-primary/5'}`}>
                <span className="mt-0.5 shrink-0">{KIND_ICON[n.kind] ?? <Bell className="h-4 w-4 text-muted-foreground" />}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-medium">{n.title}</p>
                    {!n.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{n.body}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground/70">{formatTime(n.created)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function formatTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
