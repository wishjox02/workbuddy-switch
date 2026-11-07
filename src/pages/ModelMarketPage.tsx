import { useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, ShoppingBag, Store } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { serviceDisplayText } from "@/lib/admin-backend";
import { isDesktop } from "@/lib/api";
import { fetchModelMarket, type ModelMarketItem } from "@/lib/model-market";
import { pageCacheIdentity, readPageCache, writePageCache } from "@/lib/page-cache";

async function openMarketLink(url: string): Promise<void> {
  if (!url) return;
  if (isDesktop()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) throw new Error("浏览器阻止了链接打开，请允许新窗口后重试");
}

function price(value: number): string {
  return `¥${value.toFixed(2)}`;
}

export default function ModelMarketPage() {
  const [items, setItems] = useState<ModelMarketItem[]>(() => readPageCache<ModelMarketItem[]>("model-market") ?? []);
  const [hasData, setHasData] = useState(() => readPageCache<ModelMarketItem[]>("model-market") !== undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const identity = pageCacheIdentity();
    setLoading(true);
    setError(null);
    try { const next = await fetchModelMarket(); if (identity === pageCacheIdentity()) { setItems(next); setHasData(true); writePageCache("model-market", next, identity); } }
    catch (cause) { setError(serviceDisplayText(cause instanceof Error ? cause.message : String(cause))); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  return <div className="wb-page mx-auto w-full max-w-[1180px] min-w-0 px-4 py-6 sm:px-8 sm:py-8">
    <header className="mb-5 flex min-w-0 flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold">模型广场</h1>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "animate-spin" : ""} />刷新</Button>
    </header>

    {error && <div className="mb-5 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"><span className="min-w-0 flex-1">{error}</span><Button type="button" variant="outline" size="sm" onClick={() => void load()}>重试</Button></div>}
    {loading && !hasData ? <div className="flex min-h-56 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />正在加载模型广场…</div> : items.length === 0 ? <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center text-muted-foreground"><Store className="size-8 opacity-50" /><p className="text-sm">暂时没有上架模型</p></div> : <div className="grid grid-cols-1 gap-3 min-[500px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{items.map((item) => <Card key={String(item.id)} className="group overflow-hidden rounded-lg py-0 shadow-none transition-shadow hover:shadow-md"><div className="aspect-[2/1] overflow-hidden bg-muted">{item.imageUrl ? <img src={item.imageUrl} alt={item.modelName} className="h-full w-full object-contain" loading="lazy" referrerPolicy="no-referrer" /> : <div className="flex h-full items-center justify-center"><ShoppingBag className="size-8 text-muted-foreground/35" /></div>}</div><CardContent className="flex flex-1 flex-col p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="truncate text-sm font-semibold" title={item.modelName}>{item.modelName}</h2><p className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground"><Store className="size-3 shrink-0" />{item.storeName || "未填写店铺"}</p></div><div className="shrink-0 text-sm font-semibold tabular-nums text-primary">{price(item.price)}</div></div>{item.description && <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.description}</p>}<div className="mt-auto pt-3"><Button type="button" size="sm" className="w-full" disabled={!item.link} onClick={() => void openMarketLink(item.link).catch((cause) => setError(serviceDisplayText(cause instanceof Error ? cause.message : String(cause))))}>{item.link ? <><ExternalLink />前往店铺</> : "暂未提供链接"}</Button></div></CardContent></Card>)}</div>}
  </div>;
}
