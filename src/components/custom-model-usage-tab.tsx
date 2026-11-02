import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, Search } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { authChangedEvent, readClientToken } from "@/lib/auth";
import { fetchCustomModelUsage, type CustomModelUsagePage, type CustomModelUsageRecord } from "@/lib/sub2api";
import { cn } from "@/lib/utils";

type Range = "today" | "7d" | "30d" | "all";
const PAGE_SIZE = 50;
const ranges: { value: Range; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "all", label: "全部" },
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

export function CustomModelUsageTab({ reload }: { reload: number }) {
  const [range, setRange] = useState<Range>("all");
  const [draftModel, setDraftModel] = useState("");
  const [model, setModel] = useState("");
  const [page, setPage] = useState(1);
  const [authRevision, setAuthRevision] = useState(0);
  const [usage, setUsage] = useState<CustomModelUsagePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onAuthChanged = () => setAuthRevision((value) => value + 1);
    window.addEventListener(authChangedEvent(), onAuthChanged);
    return () => window.removeEventListener(authChangedEvent(), onAuthChanged);
  }, []);

  useEffect(() => {
    if (!readClientToken()) { setUsage(null); setError(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setUsage(null);
    const startDate = range === "today" ? dateKey(0) : range === "7d" ? dateKey(6) : range === "30d" ? dateKey(29) : undefined;
    void fetchCustomModelUsage({ page, pageSize: PAGE_SIZE, model, startDate, endDate: startDate ? dateKey(0) : undefined })
      .then((result) => { if (!cancelled) setUsage(result); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range, model, page, reload, authRevision]);

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

    {error && <Alert variant="destructive"><CircleAlert /><AlertTitle>读取 Sub2API 用量失败</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}

    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[
        ["调用次数", summary ? tokens.format(summary.requests) : "—"],
        ["输入 Token", summary ? tokens.format(summary.inputTokens) : "—"],
        ["输出 Token", summary ? tokens.format(summary.outputTokens) : "—"],
        ["费用（人民币）", summary ? money(summary.costCny) : "—"],
      ].map(([label, value]) => <Card key={label} className="gap-0 rounded-lg py-4 shadow-none"><CardContent className="px-4"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-2 truncate text-xl font-semibold tabular-nums" title={value}>{loading ? "加载中…" : value}</div></CardContent></Card>)}
    </div>

    {modelTotals.length > 0 && <section className="min-w-0 space-y-2"><h2 className="text-sm font-semibold">本页模型汇总</h2><div className="overflow-x-auto rounded-lg border"><Table className="min-w-[560px]"><TableHeader><TableRow><TableHead>模型</TableHead><TableHead className="text-right">输入 Token</TableHead><TableHead className="text-right">输出 Token</TableHead><TableHead className="text-right">费用（人民币）</TableHead></TableRow></TableHeader><TableBody>{modelTotals.map(([name, value]) => <TableRow key={name}><TableCell className="max-w-[240px] truncate font-medium" title={name}>{name}</TableCell><TableCell className="text-right tabular-nums">{tokens.format(value.input)}</TableCell><TableCell className="text-right tabular-nums">{tokens.format(value.output)}</TableCell><TableCell className="text-right tabular-nums">{money(value.priced ? value.cost : null)}</TableCell></TableRow>)}</TableBody></Table></div></section>}

    <section className="min-w-0 space-y-2"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">请求明细</h2><span className="text-xs text-muted-foreground">{usage ? `共 ${tokens.format(usage.total)} 条` : ""}</span></div><div className="overflow-x-auto rounded-lg border"><Table className="min-w-[760px]"><TableHeader><TableRow><TableHead>时间</TableHead><TableHead>模型</TableHead><TableHead className="text-right">输入 Token</TableHead><TableHead className="text-right">输出 Token</TableHead><TableHead className="text-right">费用（人民币）</TableHead></TableRow></TableHeader><TableBody>{usage?.records.length ? usage.records.map((record: CustomModelUsageRecord, index) => <TableRow key={`${record.id ?? record.model}-${index}`}><TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{formatTime(record.createdAt)}</TableCell><TableCell className="max-w-[240px] truncate font-medium" title={record.model}>{record.model || "—"}</TableCell><TableCell className="text-right tabular-nums">{tokens.format(record.inputTokens || 0)}</TableCell><TableCell className="text-right tabular-nums">{tokens.format(record.outputTokens || 0)}</TableCell><TableCell className="text-right tabular-nums">{money(record.costCny)}</TableCell></TableRow>) : <TableRow><TableCell colSpan={5} className="h-32 text-center text-muted-foreground">{loading ? "正在读取…" : error ? "暂无数据" : "当前范围没有请求记录"}</TableCell></TableRow>}</TableBody></Table></div>
      <div className="flex items-center justify-end gap-2"><Button type="button" variant="outline" size="icon" className="size-8" aria-label="上一页" title="上一页" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={loading || page <= 1}><ChevronLeft className="size-4" /></Button><span className="min-w-20 text-center text-xs tabular-nums">{page} / {pageCount}</span><Button type="button" variant="outline" size="icon" className="size-8" aria-label="下一页" title="下一页" onClick={() => setPage((value) => value + 1)} disabled={loading || page >= pageCount}><ChevronRight className="size-4" /></Button></div>
    </section>
  </div>;
}
