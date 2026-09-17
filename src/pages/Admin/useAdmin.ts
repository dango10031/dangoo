import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  fetchWallet, adminStats, adminUserStats, adminOverview, adminApprove, adminReject,
  adminAdjust, adminSetUserStatus, adminLookupUser,
  type AdminStats, type AdminUserStats, type AdminOverview, type AdminWalletLookup, type StatsRange, type WalletMe,
} from '@/lib/wallet'
import { redirectToLogin } from '@/lib/auth'

export type AdminTab = 'dashboard' | 'recharges' | 'users' | 'txns'

function isoDate(d: Date): string {
  const p = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function useAdmin() {
  const navigate = useNavigate()
  const [wallet, setWallet] = useState<WalletMe | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [range, setRange] = useState<StatsRange>('today')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [drillEmail, setDrillEmail] = useState<string | null>(null)
  const [userStats, setUserStats] = useState<AdminUserStats | null>(null)
  const [userLoading, setUserLoading] = useState(false)

  const [tab, setTab] = useState<AdminTab>('dashboard')
  const [overview, setOverview] = useState<AdminOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [queryEmail, setQueryEmail] = useState('')
  const [lookup, setLookup] = useState<AdminWalletLookup | null>(null)
  const [adjAmount, setAdjAmount] = useState('')
  const [adjNote, setAdjNote] = useState('')

  useEffect(() => {
    let alive = true
    fetchWallet()
      .then(w => { if (alive) { setWallet(w); setAuthReady(true) } })
      .catch(() => { if (alive) setAuthReady(true) })
    return () => { alive = false }
  }, [])

  const load = useCallback(async (r: StatsRange, s?: string, en?: string) => {
    setLoading(true)
    setError('')
    try {
      setStats(await adminStats({ range: r, start: s, end: en }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '统计加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authReady && wallet?.is_admin && range !== 'custom') Promise.resolve().then(() => load(range))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, wallet?.is_admin, range])

  // 快捷区间在前端精确算日期，用 custom 范围查询
  const applyQuick = useCallback((kind: '3d' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth') => {
    const now = new Date()
    let s: Date
    let en: Date
    if (kind === '3d') { s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2); en = now }
    else if (kind === 'thisWeek') {
      const dow = (now.getDay() + 6) % 7
      s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow); en = now
    } else if (kind === 'lastWeek') {
      const dow = (now.getDay() + 6) % 7
      s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow - 7)
      en = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow - 1)
    } else if (kind === 'thisMonth') {
      s = new Date(now.getFullYear(), now.getMonth(), 1); en = now
    } else {
      s = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      en = new Date(now.getFullYear(), now.getMonth(), 0)
    }
    const ss = isoDate(s)
    const ee = isoDate(en)
    setRange('custom'); setStart(ss); setEnd(ee)
    void load('custom', ss, ee)
  }, [load])

  const applyCustom = useCallback(() => { void load('custom', start, end) }, [load, start, end])
  const goHome = useCallback(() => navigate('/'), [navigate])
  const login = useCallback(() => redirectToLogin(), [])

  // 当前生效的查询参数（供下钻沿用同一时间范围）
  const effectiveRange = useCallback((): { range: StatsRange; start?: string; end?: string } => {
    return range === 'custom' ? { range: 'custom', start, end } : { range }
  }, [range, start, end])

  const loadUser = useCallback(async (email: string) => {
    setUserLoading(true)
    try {
      const q = effectiveRange()
      setUserStats(await adminUserStats({ email, ...q }))
    } catch {
      setUserStats(null)
    } finally {
      setUserLoading(false)
    }
  }, [effectiveRange])

  const openUser = useCallback((email: string) => {
    setDrillEmail(email)
    void loadUser(email)
  }, [loadUser])

  const closeUser = useCallback(() => { setDrillEmail(null); setUserStats(null) }, [])

  // 切换时间范围时，若正在下钻则带着新范围刷新该用户
  useEffect(() => {
    if (drillEmail) Promise.resolve().then(() => loadUser(drillEmail))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, start, end])

  const trendMax = useMemo(() => Math.max(1, ...(stats?.trend ?? []).map(t => t.calls)), [stats])

  // ---------- 审核 / 用户额度 / 流水（概览数据，切到对应页签时加载）----------
  const loadOverview = useCallback(async () => {
    setOverviewLoading(true)
    try {
      setOverview(await adminOverview())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setOverviewLoading(false)
    }
  }, [])

  useEffect(() => {
    if (authReady && wallet?.is_admin && (tab === 'recharges' || tab === 'users' || tab === 'txns') && !overview) {
      Promise.resolve().then(loadOverview)
    }
  }, [authReady, wallet?.is_admin, tab, overview, loadOverview])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadOverview(), range !== 'custom' ? load(range) : load('custom', start, end)])
  }, [loadOverview, load, range, start, end])

  const approveRecharge = useCallback(async (id: string) => {
    setBusy(id)
    try {
      await adminApprove(id)
      toast.success('已通过并加额度')
      await refreshAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }, [refreshAll])

  const rejectRecharge = useCallback(async (id: string) => {
    setBusy(id)
    try {
      await adminReject(id)
      toast.success('已拒绝该申请')
      await refreshAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }, [refreshAll])

  const lookupUser = useCallback(async (email: string) => {
    const em = email.trim().toLowerCase()
    if (!em) { toast.error('请输入用户邮箱'); return }
    setBusy('lookup')
    setLookup(null)
    try {
      const r = await adminLookupUser(em)
      setLookup(r)
      if (!r.found) toast.error(r.message || '该用户不存在')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '查询失败')
    } finally {
      setBusy(null)
    }
  }, [])

  const adjustUser = useCallback(async (sign: 1 | -1) => {
    const email = lookup?.found ? lookup.email : queryEmail.trim().toLowerCase()
    const amt = Number(adjAmount)
    if (!email) { toast.error('请先查询用户'); return }
    if (!(amt > 0)) { toast.error('请输入要调整的金额'); return }
    setBusy('adjust')
    try {
      const res = await adminAdjust({ email, amount: sign * amt, note: adjNote })
      toast.success(sign > 0 ? '已加额度' : '已扣减额度')
      setAdjAmount(''); setAdjNote('')
      setLookup(prev => (prev?.found ? { ...prev, balance: res.balance ?? prev.balance } : prev))
      await refreshAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }, [lookup, queryEmail, adjAmount, adjNote, refreshAll])

  const toggleBan = useCallback(async (email: string, banned: boolean) => {
    setBusy(`ban:${email}`)
    try {
      await adminSetUserStatus({ email, banned })
      toast.success(banned ? '已停用该账号，其登录立即失效' : '已恢复该账号')
      setLookup(prev => (prev?.email === email ? { ...prev, banned } : prev))
      await loadOverview()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(null)
    }
  }, [loadOverview])

  const rangeText = range === 'custom'
    ? (start && end ? `${start} 至 ${end}` : '自定义')
    : (['今日', '昨日', '近 7 天', '近 30 天', '近 6 个月', '近 1 年', '全部'][
        ['today', 'yesterday', '7d', '30d', '6m', '1y', 'all'].indexOf(range)
      ] ?? range)

  return {
    wallet, authReady, isAdmin: wallet?.is_admin ?? false,
    range, setRange, start, setStart, end, setEnd,
    stats, loading, error, trendMax, rangeText,
    applyQuick, applyCustom, goHome, login,
    drillEmail, userStats, userLoading, openUser, closeUser,
    tab, setTab, overview, overviewLoading, busy,
    approveRecharge, rejectRecharge,
    queryEmail, setQueryEmail, lookup, lookupUser,
    adjAmount, setAdjAmount, adjNote, setAdjNote, adjustUser, toggleBan,
  }
}

export type AdminVm = ReturnType<typeof useAdmin>
