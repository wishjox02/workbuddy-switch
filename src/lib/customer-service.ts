import { adminApiUrl, serviceDisplayText } from "@/lib/admin-backend";

export interface CustomerServiceConfig {
  enabled: boolean;
  title: string;
  qqGroup: string;
  description: string;
  content: string;
  link: string;
}

export async function fetchCustomerService(): Promise<CustomerServiceConfig> {
  const response = await fetch(adminApiUrl("/client/customer-service"), { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `读取客服信息失败 (${response.status})`));
  return {
    enabled: payload.data?.enabled !== false,
    title: String(payload.data?.title || "客服支持"),
    qqGroup: String(payload.data?.qqGroup || ""),
    description: String(payload.data?.description || "加入 QQ 群获取使用帮助和最新公告。"),
    content: String(payload.data?.content || ""),
    link: String(payload.data?.link || ""),
  };
}
