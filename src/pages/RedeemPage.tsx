import { CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, Gift, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authChangedEvent, readClientToken } from "@/lib/auth";
import { adminBackendUrl, serviceDisplayText } from "@/lib/admin-backend";
import { fetchRedeemHistory, redeemCode, type RedeemHistoryPage } from "@/lib/sub2api";
import { MODEL_BALANCE_CHANGED } from "@/lib/use-model-balance";

export default function RedeemPage() {
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");
  const [credits, setCredits] = useState<number | null>(null);
  const [loggedIn, setLoggedIn] = useState(() => Boolean(readClientToken()));
  const [history, setHistory] = useState<RedeemHistoryPage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyRevision, setHistoryRevision] = useState(0);
  const generation = useRef(0);

  const loadHistory = useCallback(async (page: number) => {
    const token = readClientToken();
    const current = ++generation.current;
    if (!token) { setHistory(null); setHistoryLoading(false); return; }
    setHistoryLoading(true); setHistoryError(null);
    try {
      const result = await fetchRedeemHistory(page);
      if (current === generation.current && token === readClientToken()) setHistory(result);
    } catch (error) {
      if (current === generation.current && token === readClientToken()) setHistoryError(serviceDisplayText(error instanceof Error ? error.message : String(error)));
    } finally {
      if (current === generation.current && token === readClientToken()) setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    const update = () => { ++generation.current; setLoggedIn(Boolean(readClientToken())); setMessage(null); setCode(""); setCredits(null); setHistory(null); setHistoryError(null); setHistoryPage(1); setHistoryRevision((value) => value + 1); };
    window.addEventListener(authChangedEvent(), update);
    return () => { ++generation.current; window.removeEventListener(authChangedEvent(), update); };
  }, []);

  useEffect(() => { void loadHistory(historyPage); }, [historyPage, historyRevision, loadHistory]);

  async function handleRedeem() {
    const value = code.trim();
    const token = readClientToken();
    if (!token) { toast.error("请先登录个人中心"); return; }
    if (!value) { toast.error("请输入兑换码"); return; }
    setRedeeming(true); setMessage(null);
    try {
      const result = await redeemCode(value);
      if (token !== readClientToken()) return;
      setCredits(result.balance); setCode("");
      window.dispatchEvent(new Event(MODEL_BALANCE_CHANGED));
      setMessageKind("success"); setMessage(`兑换成功，获得 ${result.credits} 积分，当前余额 ${result.balance} 积分`);
      toast.success("兑换成功");
      setHistoryPage(1); setHistoryRevision((revision) => revision + 1);
    } catch (error) { if (token === readClientToken()) { setMessageKind("error"); setMessage(serviceDisplayText(error instanceof Error ? error.message : String(error))); } }
    finally { setRedeeming(false); }
  }

  return <div className="wb-page mx-auto w-full max-w-[1180px] min-w-0 px-4 py-7 sm:px-8 sm:py-10">
    <header className="mb-7">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary"><Gift className="size-4" />兑换中心</div>
      <h1 className="text-[28px] font-semibold">兑换</h1>
      <p className="mt-2 text-sm text-muted-foreground">使用兑换码为当前账号增加积分。</p>
    </header>
    {!loggedIn ? <div role="status" className="flex max-w-lg items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>请先登录个人中心，再使用兑换功能。</span></div> : !adminBackendUrl() ? <div role="alert" className="flex max-w-lg items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"><CircleAlert className="mt-0.5 size-4 shrink-0" /><span>尚未配置后台服务，暂时无法兑换。</span></div> : <Card className="max-w-lg rounded-lg shadow-none">
      <CardHeader><CardTitle className="text-base">输入兑换码</CardTitle><CardDescription>每个兑换码只能使用一次，兑换后积分立即到账。</CardDescription></CardHeader>
      <CardContent className="space-y-4"><div className="flex gap-2"><Input value={code} onChange={(event) => setCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void handleRedeem(); }} placeholder="请输入兑换码" autoComplete="off" disabled={redeeming} aria-label="兑换码" /><Button type="button" onClick={() => void handleRedeem()} disabled={redeeming || !code.trim()}>{redeeming ? <Loader2 className="animate-spin" /> : <Gift />}兑换</Button></div>
        {message && <div role={messageKind === "error" ? "alert" : "status"} className={messageKind === "error" ? "flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" : "flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm"}>{messageKind === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />}{message}</div>}
        {credits !== null && <p className="text-xs text-muted-foreground">本次页面记录的当前积分：{credits}</p>}
      </CardContent>
    </Card>}
    {loggedIn && <section className="mt-8 max-w-3xl" aria-labelledby="redeem-history-heading">
      <div className="mb-3 flex items-center justify-between gap-3"><h2 id="redeem-history-heading" className="text-base font-semibold">兑换记录</h2><Button type="button" variant="outline" size="sm" onClick={() => void loadHistory(historyPage)} disabled={historyLoading}><RefreshCw className={historyLoading ? "animate-spin" : ""} />刷新</Button></div>
      {historyError && <div role="alert" className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">读取兑换记录失败：{historyError}</div>}
      <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[480px] text-left text-sm"><thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">兑换时间</th><th className="px-4 py-3 font-medium">兑换码</th><th className="px-4 py-3 font-medium">类型</th><th className="px-4 py-3 text-right font-medium">兑换金额</th></tr></thead><tbody>
        {history && history.page === historyPage && history.items.length > 0 ? history.items.map((item, index) => <tr key={item.id ?? `${item.usedAt}-${index}`} className="border-t"><td className="px-4 py-3 tabular-nums">{formatHistoryDate(item.usedAt)}</td><td className="px-4 py-3 font-mono">{item.code ? `••••${item.code.slice(-4)}` : "—"}</td><td className="px-4 py-3">{historyType(item.type)}</td><td className="px-4 py-3 text-right tabular-nums">{item.value === null ? "—" : item.type === "balance" ? `¥${item.value.toFixed(2)}` : item.value}</td></tr>) : <tr><td colSpan={4} className="h-24 px-4 text-center text-muted-foreground">{historyLoading ? "正在读取兑换记录…" : historyError ? "暂无可显示的记录" : "暂无兑换记录"}</td></tr>}
      </tbody></table></div>
      <div className="mt-3 flex items-center justify-end gap-2"><Button type="button" variant="outline" size="icon" className="size-8" aria-label="上一页" title="上一页" disabled={historyLoading || historyPage <= 1} onClick={() => setHistoryPage((page) => page - 1)}><ChevronLeft /></Button><span className="min-w-20 text-center text-xs tabular-nums">{historyPage} / {history ? Math.max(1, Math.ceil(history.total / history.pageSize)) : 1}</span><Button type="button" variant="outline" size="icon" className="size-8" aria-label="下一页" title="下一页" disabled={historyLoading || !history || historyPage * history.pageSize >= history.total} onClick={() => setHistoryPage((page) => page + 1)}><ChevronRight /></Button></div>
    </section>}
  </div>;
}

function formatHistoryDate(value: string | number | null): string {
  if (value === null || value === "") return "—";
  const numeric = typeof value === "number" ? value : /^\d{10,13}$/.test(value) ? Number(value) : null;
  const date = numeric === null ? new Date(value) : new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function historyType(type: string): string {
  return ({ balance: "余额", concurrency: "并发额度", subscription: "订阅", invitation: "邀请码" } as Record<string, string>)[type] || type || "—";
}
