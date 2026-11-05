import { useEffect, useState } from "react";
import { ExternalLink, Headphones, Loader2, MessageCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { authChangedEvent } from "@/lib/auth";
import { fetchCustomerService, type CustomerServiceConfig } from "@/lib/customer-service";
import { cn } from "@/lib/utils";

export default function CustomerServicePage() {
  const [config, setConfig] = useState<CustomerServiceConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const next = await fetchCustomerService();
        if (!cancelled) setConfig(next);
      } catch (error) {
        if (!cancelled) toast.error("客服信息加载失败", { description: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    window.addEventListener(authChangedEvent(), load);
    return () => { cancelled = true; window.removeEventListener(authChangedEvent(), load); };
  }, []);

  return <div className="wb-page mx-auto w-full max-w-[900px] min-w-0 px-4 py-7 sm:px-8 sm:py-10">
    <header className="mb-7"><div className="mb-2 flex items-center gap-2 text-xs font-medium text-primary"><Headphones className="size-4" />客服支持</div><h1 className="text-[28px] font-semibold tracking-tight">联系我们</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">遇到账号、模型或充值问题，可以通过客服渠道获得帮助。</p></header>
    {loading ? <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />正在读取客服信息…</div> : config?.enabled === false ? <div className="rounded-lg border border-dashed px-5 py-14 text-center text-sm text-muted-foreground">客服信息暂未开放。</div> : <Card className="overflow-hidden rounded-xl py-0 shadow-none"><CardHeader className="border-b border-border/60 bg-primary/[0.035] px-5 py-5"><CardTitle className="flex items-center gap-2 text-base"><MessageCircle className="size-5 text-primary" />{config?.title || "客服支持"}</CardTitle></CardHeader><CardContent className="space-y-5 px-5 py-6"><div className="rounded-lg border border-primary/25 bg-primary/[0.045] p-4"><div className="text-xs text-muted-foreground">QQ群</div><div className={cn("mt-1 text-2xl font-semibold tracking-tight", !config?.qqGroup && "text-base text-muted-foreground")}>{config?.qqGroup || "QQ群信息暂未配置"}</div>{config?.link && <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => window.open(config.link, "_blank", "noopener,noreferrer")}><ExternalLink />打开群链接</Button>}</div>{config?.description && <p className="text-sm leading-6 text-muted-foreground">{config.description}</p>}{config?.content && <div className="whitespace-pre-wrap rounded-lg bg-muted/45 px-4 py-3 text-sm leading-6 text-foreground">{config.content}</div>}</CardContent></Card>}
  </div>;
}
