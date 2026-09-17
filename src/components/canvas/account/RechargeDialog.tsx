import { useEffect, useState } from 'react'
import { Loader2, QrCode, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { getBasename } from '@/lib/pb'
import { fetchMyRecharges, submitRecharge, type RechargeItem } from '@/lib/wallet'

interface RechargeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  balance: number | null
  onRecharged: () => void
}

const PRESETS = [10, 30, 50, 100, 200, 500]
const STATUS_ZH: Record<string, string> = {
  pending: '待审核',
  approved: '已到账',
  rejected: '未通过',
}

export function RechargeDialog({ open, onOpenChange, balance, onRecharged }: RechargeDialogProps) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [items, setItems] = useState<RechargeItem[]>([])
  const [qrOk, setQrOk] = useState(true)

  const base = getBasename()
  const qrSrc = `${base === '/' ? '' : base}/pay-qr.jpg`

  async function loadList() {
    try {
      const data = await fetchMyRecharges()
      setItems(data.items || [])
    } catch {
      // 列表失败不阻塞
    }
  }

  useEffect(() => {
    if (open) void Promise.resolve().then(loadList)
  }, [open])

  const amt = Number(amount)
  const valid = amt > 0

  async function handleSubmit() {
    if (!valid) { toast.error('请输入充值金额'); return }
    setBusy(true)
    try {
      await submitRecharge({ amount: Math.round(amt * 100) / 100, pay_method: 'wechat', note })
      toast.success('充值申请已提交, 到账后会为你加额度')
      setAmount(''); setNote('')
      void loadList()
      onRecharged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交失败, 请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <Wallet className="h-5 w-5 text-primary" />
            账户充值
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            当前余额 <span className="font-semibold text-foreground">¥{typeof balance === 'number' ? balance.toFixed(2) : '0.00'}</span>
            , 余额不足时无法生成。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 收款码 */}
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 p-4">
            {qrOk ? (
              <img
                src={qrSrc}
                alt="微信收款码"
                className="h-52 w-52 rounded-lg bg-white object-contain p-1"
                onError={() => setQrOk(false)}
              />
            ) : (
              <div className="flex h-52 w-52 flex-col items-center justify-center gap-2 rounded-lg bg-card text-center text-xs text-muted-foreground">
                <QrCode className="h-8 w-8 text-muted-foreground" />
                收款码稍后提供
                <br />付款后请在下方备注
              </div>
            )}
            <p className="text-xs text-muted-foreground">微信扫码付款后, 填写金额并提交申请, 核对到账后为你加额度</p>
          </div>

          {/* 金额 */}
          <div className="flex flex-wrap gap-2">
            {PRESETS.map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setAmount(String(v))}
                className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                  Number(amount) === v
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-foreground hover:border-primary'
                }`}
              >
                ¥{v}
              </button>
            ))}
          </div>
          <Input
            type="number"
            min={1}
            placeholder="输入充值金额(元)"
            value={amount}
            onChange={e => setAmount(e.target.value)}
          />
          <Input
            type="text"
            placeholder="付款备注(可选): 付款时间 / 微信昵称, 方便核对"
            value={note}
            onChange={e => setNote(e.target.value)}
          />
          <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90" onClick={handleSubmit} disabled={busy || !valid}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            提交充值申请
          </Button>

          {/* 申请记录 */}
          {items.length > 0 && (
            <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-card p-2">
              {items.slice(0, 8).map(it => (
                <div key={it.id} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">¥{Number(it.amount).toFixed(2)} · {new Date(it.created).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                  <span className={
                    it.status === 'approved' ? 'font-medium text-primary'
                      : it.status === 'rejected' ? 'text-destructive'
                      : 'text-muted-foreground'
                  }>
                    {STATUS_ZH[it.status] || it.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
