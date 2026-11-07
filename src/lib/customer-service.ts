import { adminApiUrl, serviceDisplayText } from "@/lib/admin-backend";

export type CustomerServiceItemType = "qq" | "wechat" | "email" | "phone" | "link" | "text";

export interface CustomerServiceItem {
  id: number;
  title: string;
  type: CustomerServiceItemType;
  value: string;
  linkUrl: string;
  sortOrder: number;
  enabled: boolean;
}

export interface CustomerServiceConfig {
  enabled: boolean;
  title: string;
  qqGroup: string;
  description: string;
  content: string;
  link: string;
  items: CustomerServiceItem[];
}

export async function fetchCustomerService(): Promise<CustomerServiceConfig> {
  const response = await fetch(adminApiUrl("/client/customer-service"), { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `读取客服信息失败 (${response.status})`));
  const rawItems: unknown[] = Array.isArray(payload.data?.items) ? payload.data.items : [];
  return {
    enabled: payload.data?.enabled !== false,
    title: String(payload.data?.title || "客服支持"),
    qqGroup: String(payload.data?.qqGroup || ""),
    description: String(payload.data?.description || "加入 QQ 群获取使用帮助和最新公告。"),
    content: String(payload.data?.content || ""),
    link: String(payload.data?.link || ""),
    items: rawItems
        .filter((item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((item) => ({
          id: Number(item.id || 0),
          title: String(item.title || "客服信息"),
          type: ["qq", "wechat", "email", "phone", "link", "text"].includes(String(item.type)) ? String(item.type) as CustomerServiceItemType : "text",
          value: String(item.value || ""),
          linkUrl: String(item.linkUrl || ""),
          sortOrder: Number(item.sortOrder || 0),
          enabled: item.enabled !== false,
        }))
        .filter((item) => item.value.length > 0),
  };
}
