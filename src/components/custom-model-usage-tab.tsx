import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, RefreshCw, Search } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { authChangedEvent, readClientToken } from "@/lib/auth";
import { fetchCustomModelUsage, type CustomModelUsagePage, type CustomModelUsageRecord } from "@/lib/sub2api";
import { cn } from "@/lib/utils";
import { pageCacheIdentity, readPageCache, writePageCache } from "@/lib/page-cache";

type Range = "today" | "7d" | "30d" | "custom";
const PAGE_SIZE = 50;
const ranges: { value: Range; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];
const tokens = new Intl.NumberFormat("zh-CN");
const yuan = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 6 });

function dateKey(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatTime(value: string | number | null): string {
  if (value == null || value === "") return "—";
  const numeric = typeof value === "number" ? value : /^\d{10,13}$/.test(value) ? Number(value) : null;
  const date = numeric === null ? new Date(value) : new Date(numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function money(value: number | null | undefined): string {
  return value == null ? "—" : yuan.format(value);
}

export function CustomModelUsageTab({ reload, onRefresh }: { reload: number; onRefresh: () => void }) {
  const [range, setRange] = useState<Range>("today");
  const [draftModel, setDraftModel] = useState("");
  const [model, setModel] = useState("");
  const [draftStart, setDraftStart] = useState(dateKey(6));
  const [draftEnd, setDraftEnd] = useState(dateKey(0));
  const [customDates, setCustomDates] = useState({ start: "", end: "" });
  const [page, setPage] = useState(1);
  const [authRevision, setAuthRevision] = useState(0);
  const [usage, setUsage] = useState<CustomModelUsagePage | null>(() => readPageCache<CustomModelUsagePage>(`usage:v2:${dateKey(0)}:today::::1`) ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onAuthChanged = () => { setUsage(null); setError(null); setPage(1); setAuthRevision((value) => value + 1); };
    window.addEventListener(authChangedEvent(), onAuthChanged);
    return () => window.removeEventListener(authChangedEvent(), onAuthChanged);
  }, []);

  useEffect(() => {
    const token = readClientToken();
    if (!token) { setUsage(null); setError(null); setLoading(false); return; }
    let cancelled = false;
    const identity = pageCacheIdentity();
    const cacheKey = `usage:v2:${dateKey(0)}:${range}:${customDates.start}:${customDates.end}:${model}:${page}`;
    const cached = readPageCache<CustomModelUsagePage>(cacheKey);
    setLoading(true);
    setError(null);
    setUsage(cached ?? null);
    const startDate = range === "today" ? dateKey(0) : range === "7d" ? dateKey(6) : range === "30d" ? dateKey(29) : range === "custom" ? customDates.start : undefined;
    const endDate = range === "custom" ? customDates.end : startDate ? dateKey(0) : undefined;
    void fetchCustomModelUsage({ page, pageSize: PAGE_SIZE, model, startDate, endDate })
      .then((result) => { if (!cancelled && token === readClientToken() && identity === pageCacheIdentity()) { setUsage(result); writePageCache(cacheKey, result, identity); } })
      .catch((cause) => { if (!cancelled && token === readClientToken()) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled && token === readClientToken()) setLoading(false); });
    return () => { cancelled = true; };
  }, [range, customDates, model, page, reload, authRevision]);

  const modelTotals = useMemo(() => {
    const grouped = new Map<string, { input: number; output: number; cost: number; priced: boolean }>();
    for (const record of usage?.records ?? []) {
      const key = record.model || "未知模型";
      const value = grouped.get(key) ?? { input: 0, output: 0, cost: 0, priced: false };
      value.input += record.inputTokens || 0;
      value.output += record.outputTokens || 0;
      if (record.costCny != null) { value.cost += record.costCny; value.priced = true; }
      grouped.set(key, value);
    }
    return [...grouped].sort((left, right) => right[1].cost - left[1].cost);
  }, [usage]);

  if (!readClientToken()) return <div className="rounded-lg border border-dashed px-4 py-16 text-center text-sm text-muted-foreground">请先登录个人中心。</div>;

  const summary = usage?.summary;
  const pageCount = usage ? Math.max(1, Math.ceil(usage.total / usage.pageSize)) : 1;

  return <div className="min-w-0 space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="inline-flex rounded-lg border bg-muted/40 p-1" role="group" aria-label="统计时间范围">
        {ranges.map((option) => <button key={option.value} type="button" onClick={() => { setRange(option.value); setPage(1); }} className={cn("rounded-md px-3 py-1.5 text-xs font-medium", range === option.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{option.label}</button>)}
      </div>
      <form className="flex min-w-0 items-center gap-2" onSubmit={(event) => { event.preventDefault(); setModel(draftModel.trim()); setPage(1); }}>
        <Input value={draftModel} onChange={(event) => setDraftModel(event.target.value)} placeholder="模型 ID" aria-label="筛选模型 ID" className="h-9 w-44 max-w-[45vw]" />
        <Button type="submit" variant="outline" size="sm" className="h-9" aria-label="筛选模型" title="筛选模型"><Search className="size-4" /></Button>
      </form>
    </div>

    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (!draftStart || !draftEnd || draftStart > draftEnd) { setError("请选择有效的日期范围，开始日期不能晚于结束日期。"); return; } setCustomDates({ start: draftStart, end: draftEnd }); setRange("custom"); setPage(1); }}>
      <label className="space-y-1 text-xs text-muted-foreground"><span className="block">开始日期</span><Input type="date" required value={draftStart} max={draftEnd || undefined} onChange={(event) => setDraftStart(event.target.value)} className="h-9 w-40" /></label>
      <label className="space-y-1 text-xs text-muted-foreground"><span className="block">结束日期</span><Input type="date" required value={draftEnd} min={draftStart || undefined} onChange={(event) => setDraftEnd(event.target.value)} className="h-9 w-40" /></label>
      <Button type="submit" variant="outline" size="sm" className="h-9"><Search />查询日期</Button>
      <Button type="button" variant="outline" size="sm" className="h-9" onClick={onRefresh} disabled={loading}><RefreshCw className={cn(loading && "animate-spin")} />刷新记录</Button>
    </form>

    {error && <Alert variant="destructive"><CircleAlert /><AlertTitle>读取模型用量失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}

    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[
        ["调用次数", summary?.requests != null ? tokens.format(summary.requests) : "—"],
        ["输入 Token", summary?.inputTokens != null ? tokens.format(summary.inputTokens) : "—"],
        ["输出 Token", summary?.outputTokens != null ? tokens.format(summary.outputTokens) : "—"],
        ["费用（人民币）", summary ? money(summary.costCny) : "—"],
      ].map(([label, value]) => <Card key={label} className="gap-0 rounded-lg py-4 shadow-none"><CardContent className="px-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-2 truncate text-xl font-semibold tabular-nums" title={value}>{loading && !usage ? "加载中…" : value}</div></CardContent></Card>)}
    </div>

    {modelTotals.length > 0 && <section className="min-w-0 space-y-2"><h2 className="text-sm font-semibold">本页模型汇总</h2><div className="overflow-x-auto rounded-lg border"><Table className="min-w-[560px]"><TableHeader><TableRow><TableHead>模型</TableHead><TableHead className="text-right">输入 Token</TableHead><TableHead className="text-right">输出 Token</TableHead><TableHead className="text-right">费用（人民币）</TableHead></TableRow></TableHeader><TableBody>{modelTotals.map(([name, value]) => <TableRow key={name}><TableCell className="max-w-[240px] truncate font-medium" title={name}>{name}</TableCell><TableCell className="text-right tabular-nums">{tokens.format(value.input)}</TableCell><TableCell className="text-right tabular-nums">{tokens.format(value.output)}</TableCell><TableCell className="text-right tabular-nums">{money(value.priced ? value.cost : null)}</TableCell></TableRow>)}</TableBody></Table></div></section>}

    <section className="min-w-0 space-y-2"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">请求明细</h2><span className="text-xs text-muted-foreground">{usage ? `共 ${tokens.format(usage.total)} 条` : ""}</span></div><div className="overflow-x-auto rounded-lg border"><Table className="min-w-[820px]"><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>模型</TableHead><TableHead>状态</TableHead><TableHead className="text-right">输入 Token</TableHead><TableHead className="text-right">输出 Token</TableHead><TableHead className="text-right">费用（人民币）</TableHead></TableRow></TableHeader><TableBody>{usage?.records.length ? usage.records.map((record: CustomModelUsageRecord, index) => <TableRow key={`${record.id ?? record.model}-${index}`}><TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{formatTime(record.createdAt)}</TableCell><TableCell className="max-w-[240px] truncate font-medium" title={record.model}>{record.model || "—"}</TableCell><TableCell>{record.statusCode == null ? "—" : record.statusCode >= 200 && record.statusCode < 400 ? "成功" : `失败 (${record.statusCode})`}</TableCell><TableCell className="text-right tabular-nums">{tokens.format(record.inputTokens || 0)}</TableCell><TableCell className="text-right tabular-nums">{tokens.format(record.outputTokens || 0)}</TableCell><TableCell className="text-right tabular-nums">{money(record.costCny)}</TableCell></TableRow>) : <TableRow><TableCell colSpan={6} className="h-32 text-center text-muted-foreground">{loading ? "正在读取…" : error ? "暂无数据" : "当前范围没有请求记录"}</TableCell></TableRow>}</TableBody></Table></div>
      <div className="flex items-center justify-end gap-2"><Button type="button" variant="outline" size="icon" className="size-8" aria-label="上一页" title="上一页" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={loading || page <= 1}><ChevronLeft className="size-4" /></Button><span className="min-w-20 text-center text-xs tabular-nums">{page} / {pageCount}</span><Button type="button" variant="outline" size="icon" className="size-8" aria-label="下一页" title="下一页" onClick={() => setPage((value) => value + 1)} disabled={loading || page >= pageCount}><ChevronRight className="size-4" /></Button></div>
    </section>
  </div>;
}
