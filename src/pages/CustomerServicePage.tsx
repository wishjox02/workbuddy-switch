import { useEffect, useState } from "react";
import { Copy, ExternalLink, Link2, Loader2, Mail, MessageCircle, Phone, QrCode } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { authChangedEvent } from "@/lib/auth";
import { fetchCustomerService, type CustomerServiceConfig, type CustomerServiceItem, type CustomerServiceItemType } from "@/lib/customer-service";
import { pageCacheIdentity, readPageCache, writePageCache } from "@/lib/page-cache";

const typeIcons: Record<CustomerServiceItemType, typeof MessageCircle> = {
  qq: QrCode,
  wechat: MessageCircle,
  email: Mail,
  phone: Phone,
  link: Link2,
  text: MessageCircle,
};

function legacyItem(config: CustomerServiceConfig): CustomerServiceItem | null {
  if (!config.qqGroup) return null;
  return { id: 0, title: "QQ群", type: "qq", value: config.qqGroup, linkUrl: config.link, sortOrder: 0, enabled: true };
}

async function copyValue(value: string, title: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${title}已复制`);
  } catch {
    toast.error("复制失败", { description: "请手动选择并复制内容。" });
  }
}

function openLink(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function itemAction(item: CustomerServiceItem): { label: string; href?: string; onClick?: () => void } | null {
  if (item.linkUrl) return { label: "打开链接", onClick: () => openLink(item.linkUrl) };
  if (item.type === "email") return { label: "发送邮件", href: `mailto:${item.value}` };
  if (item.type === "phone") return { label: "拨打电话", href: `tel:${item.value}` };
  return null;
}

export default function CustomerServicePage() {
  const [config, setConfig] = useState<CustomerServiceConfig | null>(() => readPageCache<CustomerServiceConfig>("customer-service") ?? null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const identity = pageCacheIdentity();
      setLoading(true);
      try {
        const next = await fetchCustomerService();
        if (!cancelled && identity === pageCacheIdentity()) { setConfig(next); writePageCache("customer-service", next, identity); }
      } catch (error) {
        if (!cancelled) toast.error("客服信息加载失败", { description: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const onAuthChanged = () => { setConfig(null); void load(); };
    window.addEventListener(authChangedEvent(), onAuthChanged);
    return () => { cancelled = true; window.removeEventListener(authChangedEvent(), onAuthChanged); };
  }, []);

  const items = config ? (config.items?.length > 0 ? config.items : [legacyItem(config)].filter((item): item is CustomerServiceItem => item !== null)) : [];

  return <div className="wb-page mx-auto w-full max-w-[1000px] min-w-0 px-4 py-7 sm:px-8 sm:py-10">
    <header className="mb-7"><h1 id="customer-service-title" className="text-[28px] font-semibold">{config?.title || "客服支持"}</h1></header>
    {loading && !config ? <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />正在读取客服信息…</div> : config?.enabled === false ? <div className="rounded-lg border border-dashed px-5 py-14 text-center text-sm text-muted-foreground">客服信息暂未开放。</div> : <div className="space-y-6">
      <section aria-labelledby="customer-service-title" className="space-y-3">
        {items.length > 0 ? <div className="grid gap-3 sm:grid-cols-2">{items.map((item) => {
          const Icon = typeIcons[item.type];
          const action = itemAction(item);
          return <div key={`${item.id}-${item.title}`} className="min-w-0 rounded-lg border border-border/70 bg-card p-4 shadow-sm"><div className="flex items-start gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4" /></span><div className="min-w-0 flex-1"><div className="break-words text-base font-semibold">{item.title}</div><div className="mt-1 break-words text-base text-muted-foreground">{item.value}</div>{(action || item.type !== "qq") && <div className="mt-3 flex flex-wrap gap-2">{action && (action.href ? <Button asChild type="button" size="sm" variant="outline"><a href={action.href}>{action.label}<ExternalLink /></a></Button> : <Button type="button" size="sm" variant="outline" onClick={action.onClick}><ExternalLink />{action.label}</Button>)}{item.type !== "qq" && <Button type="button" size="sm" variant="ghost" onClick={() => void copyValue(item.value, item.title)}><Copy />复制</Button>}</div>}</div></div></div>;
        })}</div> : <div className="rounded-lg border border-dashed px-5 py-12 text-center text-sm text-muted-foreground">客服信息暂未配置。</div>}
      </section>
      {config?.description && <p className="text-sm leading-6 text-muted-foreground">{config.description}</p>}
      {config?.content && <div className="whitespace-pre-wrap rounded-lg bg-muted/45 px-4 py-3 text-sm leading-6 text-foreground">{config.content}</div>}
    </div>}
  </div>;
}
