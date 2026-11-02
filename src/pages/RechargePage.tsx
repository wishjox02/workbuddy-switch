import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BadgeCheck, CircleAlert, Clock, CreditCard, Loader2, QrCode, RefreshCw, Wallet } from "lucide-react";
import QRCode from "qrcode";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DEMO_UNAVAILABLE_MESSAGE, demoModeEnabled } from "@/lib/demo-mode";
import { isDesktop } from "@/lib/api";
import {
  createRechargeOrder, fetchRechargeConfig, fetchRechargeOrderStatus, fetchRechargeOrders, rechargePaymentTargets,
  type RechargeConfig, type RechargeOrder,
} from "@/lib/sub2api";

const PRESET_AMOUNTS = [10, 30, 50, 100, 200, 500];

const PAY_TYPES: Array<{ id: string; label: string; hint: string }> = [
  { id: "alipay", label: "支付宝", hint: "推荐，支持扫码/跳转" },
  { id: "wxpay", label: "微信支付", hint: "扫码支付" },
];

const STATUS_META: Record<string, { label: string; variant: "secondary" | "success" | "destructive" | "outline" }> = {
  Pending: { label: "待支付", variant: "secondary" },
  Paid: { label: "已支付", variant: "success" },
  Credited: { label: "已到账", variant: "success" },
  Failed: { label: "失败", variant: "destructive" },
};

function formatTime(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleString("zh-CN", { hour12: false });
}

function isImageSource(value: string): boolean {
  return /^data:image\//i.test(value) || /\.(?:png|jpe?g|webp|gif)(?:[?#]|$)/i.test(value);
}

async function openPaymentUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error("支付链接无效");
  if (isDesktop()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  const opened = window.open(url, "_blank");
  if (!opened) {
    throw new Error("浏览器阻止了支付页面，请点击下方按钮重试");
  }
  opened.opener = null;
}

export default function RechargePage() {
  const [config, setConfig] = useState<RechargeConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [amount, setAmount] = useState<string>("30");
  const [selectedActivityId, setSelectedActivityId] = useState<number | null>(null);
  const [payType, setPayType] = useState<string>("alipay");
  const [creating, setCreating] = useState(false);
  const [orders, setOrders] = useState<RechargeOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [payUrl, setPayUrl] = useState<string | null>(null);
  const [payQrValue, setPayQrValue] = useState<string | null>(null);
  const [payQrImage, setPayQrImage] = useState<string | null>(null);
  const [payQrLoading, setPayQrLoading] = useState(false);
  const [payTradeNo, setPayTradeNo] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const pollRef = useRef<string | null>(null);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try { setOrders(await fetchRechargeOrders()); }
    catch { /* 未登录或后台不可用 */ }
    finally { setOrdersLoading(false); }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const result = await fetchRechargeConfig();
        setConfig(result);
        const activities = result.activities.filter((activity) => activity.enabled);
        const initial = activities.find((activity) => activity.amount === 30) ?? activities[0];
        if (initial) {
          setSelectedActivityId(initial.id);
          setAmount(String(initial.amount));
        }
      } catch (error) { setConfigError(error instanceof Error ? error.message : String(error)); }
    })();
    void loadOrders();
  }, [loadOrders]);

  useEffect(() => {
    if (!payQrValue) {
      setPayQrImage(null);
      setPayQrLoading(false);
      return;
    }
    if (isImageSource(payQrValue)) {
      setPayQrImage(payQrValue);
      setPayQrLoading(false);
      return;
    }
    let cancelled = false;
    setPayQrLoading(true);
    setPayQrImage(null);
    QRCode.toDataURL(payQrValue, { errorCorrectionLevel: "M", margin: 1, width: 280 })
      .then((dataUrl) => { if (!cancelled) setPayQrImage(dataUrl); })
      .catch(() => { if (!cancelled) setPayQrImage(null); })
      .finally(() => { if (!cancelled) setPayQrLoading(false); });
    return () => { cancelled = true; };
  }, [payQrValue]);

  function closePaymentDialog() {
    setPayUrl(null);
    setPayQrValue(null);
    setPayQrImage(null);
    setPayTradeNo(null);
    pollRef.current = null;
  }

  // 支付链接弹出后轮询订单状态，最多 15 分钟
  useEffect(() => {
    if ((!payUrl && !payQrValue) || !pollRef.current) return;
    const timer = setInterval(async () => {
      try {
        const order = await fetchRechargeOrderStatus(pollRef.current!);
        if (order.status === "Paid" || order.status === "Credited") {
          toast.success("充值成功，余额已更新");
          clearInterval(timer);
          closePaymentDialog();
          void loadOrders();
        }
      } catch { /* 忽略轮询错误 */ }
    }, 5000);
    const stop = setTimeout(() => { clearInterval(timer); closePaymentDialog(); }, 15 * 60 * 1000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [payUrl, payQrValue, loadOrders]);

  // 用户点击“我已完成支付”：主动查询一次订单状态
  async function handlePaidConfirm() {
    if (!pollRef.current) return;
    setChecking(true);
    try {
      const order = await fetchRechargeOrderStatus(pollRef.current);
      if (order.status === "Paid" || order.status === "Credited") {
        toast.success("支付已确认，余额已到账");
        closePaymentDialog();
        void loadOrders();
      } else {
        toast.info(`当前订单状态：${STATUS_META[order.status]?.label ?? order.status}。若您刚完成支付，请稍等几秒后再试（支付平台回调可能有延迟）。`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setChecking(false); }
  }

  const amountNumber = useMemo(() => Number(amount), [amount]);
  const validAmount = Number.isFinite(amountNumber) && amountNumber >= 1 && amountNumber <= 4000;
  const activities = config?.activities.filter((activity) => activity.enabled) ?? [];
  const selectedActivity = activities.find((activity) => activity.id === selectedActivityId);
  const bonus = selectedActivity?.bonus ?? 0;
  const credited = selectedActivity?.credited ?? amountNumber;
  async function handleCreate() {
    if (demoModeEnabled) { toast.info(DEMO_UNAVAILABLE_MESSAGE); return; }
    if (!validAmount) { toast.error("请输入 1-4000 之间的充值金额"); return; }
    setCreating(true);
    try {
      const result = await createRechargeOrder(amountNumber, payType, selectedActivityId);
      // The older backend copies a qrcode-only response into payUrl as well.
      // qrcode/urlScheme remain authoritative; payUrl alone is a checkout page.
      const { qrValue, fallbackUrl } = rechargePaymentTargets(result);
      if (qrValue || fallbackUrl) {
        pollRef.current = result.order.outTradeNo;
        setPayUrl(fallbackUrl);
        setPayQrValue(qrValue);
        setPayTradeNo(result.order.outTradeNo);
        if (qrValue) toast.success("订单已创建，请扫码完成支付");
        else if (fallbackUrl) {
          try {
            await openPaymentUrl(fallbackUrl);
            toast.success("支付页面已打开");
          } catch (openError) {
            toast.error(openError instanceof Error ? openError.message : String(openError));
          }
        }
      } else {
        toast.success("订单已创建，请稍后在订单列表查看状态");
      }
      void loadOrders();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally { setCreating(false); }
  }

  const paidTotal = useMemo(() => orders.filter((order) => order.status === "Paid" || order.status === "Credited").reduce((sum, order) => sum + Number(order.amount || 0), 0), [orders]);
  const pendingCount = orders.filter((order) => order.status === "Pending").length;

  return <div className="wb-page mx-auto w-full max-w-[1180px] min-w-0 px-4 py-7 sm:px-8 sm:py-10">
    <header className="mb-7 flex min-w-0 flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary"><Wallet className="size-4" />余额充值</div>
        <h1 className="text-[28px] font-semibold tracking-tight">充值</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">选择充值金额，支付成功后余额自动到账。</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => void loadOrders()} disabled={ordersLoading}><RefreshCw className={cn(ordersLoading && "animate-spin")} />刷新订单</Button>
    </header>

    {configError && <div className="mb-6 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"><CircleAlert className="size-4 shrink-0" />{configError}</div>}
    {config && !config.enabled && <div className="mb-6 flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"><CircleAlert className="size-4 shrink-0" />充值暂未开放，请稍后再试。</div>}

    <div className="grid min-w-0 gap-6 xl:grid-cols-5">
      <Card className="min-w-0 gap-0 overflow-hidden rounded-2xl py-0 shadow-none xl:col-span-2">
        <CardHeader className="border-b border-border/60 px-4 py-4 sm:px-5">
          <CardTitle className="text-base">创建充值订单</CardTitle>
          <CardDescription className="mt-1 text-xs">支付金额与到账余额均为人民币</CardDescription>
        </CardHeader>
        <CardContent className="px-4 py-5 sm:px-5">
          <div className="text-xs font-medium text-muted-foreground">{activities.length ? "充值活动" : "选择充值金额"}</div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {activities.length === 0 && PRESET_AMOUNTS.map((preset) => <Button key={preset} type="button" variant={amountNumber === preset ? "default" : "outline"} size="sm" className="rounded-lg" onClick={() => { setSelectedActivityId(null); setAmount(String(preset)); }}>¥{preset}</Button>)}
            {activities.map((activity) => (
              <button key={activity.id} type="button" onClick={() => { setSelectedActivityId(activity.id); setAmount(String(activity.amount)); }} aria-pressed={selectedActivityId === activity.id}
                className={cn("flex min-h-[82px] flex-col items-start justify-center gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors", selectedActivityId === activity.id ? "border-primary bg-primary/[0.06]" : "border-border hover:bg-muted/50")}>
                {activity.label && <span className="w-full truncate text-[11px] text-muted-foreground" title={activity.label}>{activity.label}</span>}
                <span className="text-sm font-semibold">充 ¥{activity.amount.toFixed(2)}</span>
                {activity.bonus > 0 && <span className="text-xs font-medium text-primary">送 ¥{activity.bonus.toFixed(2)}</span>}
                <span className="text-[11px] text-muted-foreground">到账 ¥{activity.credited.toFixed(2)}</span>
              </button>
            ))}
          </div>
          <div className="mt-4 space-y-1.5 border-t border-border/60 pt-4 text-sm">
            <div className="flex items-center justify-between"><span className="text-muted-foreground">支付金额</span><span>¥{validAmount ? amountNumber.toFixed(2) : "—"}</span></div>
            {bonus > 0 && <div className="flex items-center justify-between"><span className="text-muted-foreground">活动赠送</span><span className="text-primary">+¥{bonus.toFixed(2)}</span></div>}
            <div className="flex items-center justify-between font-semibold"><span>到账余额</span><span className="text-primary">¥{validAmount ? credited.toFixed(2) : "—"}</span></div>
          </div>

          <div className="mt-5 text-xs font-medium text-muted-foreground">支付方式</div>
          <div className="mt-2 grid gap-2">
            {PAY_TYPES.map((item) => (
              <button key={item.id} type="button" onClick={() => setPayType(item.id)} className={cn("flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors", payType === item.id ? "border-primary bg-primary/[0.06]" : "border-border hover:bg-muted/50")}>
                <span className="flex items-center gap-2 text-sm font-medium"><CreditCard className="size-4" />{item.label}</span>
                <span className="text-[11px] text-muted-foreground">{item.hint}</span>
              </button>
            ))}
          </div>

          <Button type="button" className="mt-5 h-11 w-full rounded-xl text-sm font-semibold" onClick={() => void handleCreate()} disabled={creating || !validAmount || !config?.enabled || demoModeEnabled}>
            {creating ? <Loader2 className="animate-spin" /> : <Wallet />}立即充值
          </Button>
        </CardContent>
      </Card>

      <Card className="min-w-0 gap-0 overflow-hidden rounded-2xl py-0 shadow-none xl:col-span-3">
        <CardHeader className="border-b border-border/60 px-4 py-4 sm:px-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">充值订单</CardTitle>
              <CardDescription className="mt-1 text-xs">累计充值 ¥{paidTotal.toFixed(2)} · 待支付 {pendingCount} 笔</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {orders.length === 0 ? <div className="px-5 py-14 text-center text-sm text-muted-foreground">暂无充值订单。</div> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-3 font-medium sm:px-5">订单号</th>
                    <th className="px-4 py-3 font-medium">支付金额</th>
                    <th className="px-4 py-3 font-medium">活动赠送</th>
                    <th className="px-4 py-3 font-medium">到账余额</th>
                    <th className="px-4 py-3 font-medium">方式</th>
                    <th className="px-4 py-3 font-medium">状态</th>
                    <th className="px-4 py-3 font-medium sm:px-5">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => {
                    const status = STATUS_META[order.status] ?? { label: order.status, variant: "outline" as const };
                    const orderCredited = Number(order.credited ?? order.balanceAmount ?? order.amount ?? 0);
                    const orderBonus = Number(order.bonus ?? Math.max(0, orderCredited - Number(order.amount)));
                    return <tr key={order.id} className="border-b border-border/40 last:border-b-0">
                      <td className="max-w-[200px] truncate px-4 py-3 font-mono text-xs sm:px-5">{order.outTradeNo}</td>
                      <td className="px-4 py-3 font-semibold">¥{Number(order.amount).toFixed(2)}</td>
                      <td className="px-4 py-3 text-primary">{orderBonus > 0 ? `+¥${orderBonus.toFixed(2)}` : "—"}</td>
                      <td className="px-4 py-3 text-primary">¥{orderCredited.toFixed(2)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{PAY_TYPES.find((item) => item.id === order.type)?.label ?? order.type}</td>
                      <td className="px-4 py-3"><Badge variant={status.variant} className="gap-1 text-[11px]">{order.status === "Paid" || order.status === "Credited" ? <BadgeCheck className="size-3" /> : order.status === "Pending" ? <Clock className="size-3" /> : null}{status.label}</Badge></td>
                      <td className="px-4 py-3 text-xs text-muted-foreground sm:px-5">{formatTime(order.createdAt)}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>

    {(payUrl || payQrValue) && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="dialog" aria-modal="true">
        <div className="w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-xl">
          <div className="mb-3 flex items-center gap-2 text-base font-semibold">{payQrValue ? <QrCode className="size-5 text-primary" /> : <CreditCard className="size-5 text-primary" />}完成支付</div>
          {payQrValue && (payQrImage ? <div className="mb-4 flex justify-center rounded-xl border border-border bg-white p-3"><img src={payQrImage} alt="支付二维码" className="size-64 max-w-full" /></div> : <div className="mb-4 flex h-64 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">{payQrLoading ? "正在生成二维码…" : "二维码生成失败，请打开支付页面"}</div>)}
          <p className="mb-4 text-sm leading-6 text-muted-foreground">{payQrValue ? "请使用支付宝或微信扫码完成支付。" : "请在支付页面完成付款；若页面未打开，可点击下方按钮。"}支付完成后页面会自动刷新订单状态；若状态未更新，请点击“我已完成支付”。</p>
          <div className="flex flex-wrap gap-2">
            {payUrl && <Button type="button" size="sm" variant="outline" onClick={() => void openPaymentUrl(payUrl).catch((error) => toast.error(error instanceof Error ? error.message : String(error)))}>打开支付页面</Button>}
            <Button type="button" size="sm" className="gap-1.5" onClick={() => void handlePaidConfirm()} disabled={checking}>{checking ? <Loader2 className="size-4 animate-spin" /> : <BadgeCheck className="size-4" />}我已完成支付</Button>
            <Button type="button" size="sm" variant="ghost" onClick={closePaymentDialog}>关闭</Button>
          </div>
          {payTradeNo && <p className="mt-3 text-xs text-muted-foreground">订单号：<span className="font-mono">{payTradeNo}</span></p>}
        </div>
      </div>
    )}
  </div>;
}
