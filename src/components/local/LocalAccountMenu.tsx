// 自建账号入口组件。页面顶部 chrome 里 <LocalAccountMenu /> 即可，无 props，
// 自管登录/退出状态；需要按登录态渲染其他内容时传 onAccountChange 回调。
//
// 未登录 → 「登录 / 注册」按钮跳应用自己的 /login 页（页面由写页技能创建）；
// 已登录 → 头像首字母 + 昵称 + 退出。

import { useEffect, useRef, useState } from "react"
import {
  getLocalAccount,
  logoutLocalAccount,
  onLocalAccountChange,
  redirectToLocalLogin,
  type LocalAccount,
} from "@/lib/localAuth"

export interface LocalAccountMenuProps {
  onAccountChange?: (account: LocalAccount | null) => void
}

export function LocalAccountMenu({ onAccountChange }: LocalAccountMenuProps) {
  const [account, setAccount] = useState<LocalAccount | null>(() => getLocalAccount())

  // onAccountChange 常是父组件每次渲染都新建的 inline 回调。用 ref 存最新引用,
  // 订阅只在挂载时建立一次 —— 否则 "不稳定回调进 effect 依赖 + onChange
  // fireImmediately 立刻回调" 会反复重订阅→setState→重渲染→再重订阅, 触发
  // React "Maximum update depth exceeded"(整页黑屏)。切勿把 onAccountChange
  // 放进下面订阅 effect 的依赖数组。
  const onAccountChangeRef = useRef(onAccountChange)
  useEffect(() => {
    onAccountChangeRef.current = onAccountChange
  })

  useEffect(() => {
    return onLocalAccountChange((next) => {
      setAccount(next)
      onAccountChangeRef.current?.(next)
    })
  }, [])

  if (!account) {
    return (
      <button
        type="button"
        onClick={() => redirectToLocalLogin()}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        登录 / 注册
      </button>
    )
  }

  return (
    <div className="inline-flex items-center gap-2">
      {account.avatarUrl ? (
        <img src={account.avatarUrl} alt={account.name} className="h-7 w-7 rounded-full object-cover" />
      ) : (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium">
          {(account.name || account.email).slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="max-w-[10rem] truncate text-sm text-muted-foreground">
        {account.name || account.email}
      </span>
      <button
        type="button"
        onClick={() => logoutLocalAccount()}
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        退出
      </button>
    </div>
  )
}
