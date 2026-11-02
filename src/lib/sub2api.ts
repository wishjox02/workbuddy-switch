import { adminApiUrl, adminBackendUrl } from "@/lib/admin-backend";
import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "@/lib/api";
import { readClientToken, readClientUser } from "@/lib/auth";

export interface Sub2ApiModel {
  id: string;
  displayName?: string | null;
  modelType?: string | null;
  enabled?: boolean;
  object?: string | null;
  ownedBy?: string | null;
  created?: number | null;
}

export interface WorkBuddyModel {
  id: string;
  name?: string | null;
  vendor?: string | null;
  url?: string | null;
  managed?: boolean;
  managedUserId?: number | null;
  disabled?: boolean;
}

export interface WorkBuddyModelInput {
  id: string;
  name: string;
  provider?: string;
}

function clientAuthHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = window.localStorage.getItem("workbuddy.client.session-token.v1") || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function hasSub2ApiBackend(): boolean {
  return Boolean(adminBackendUrl());
}

export async function fetchSub2ApiModels(): Promise<Sub2ApiModel[]> {
  const base = adminBackendUrl();
  if (!base) return [];
  const response = await fetch(adminApiUrl("/client/models"), { cache: "no-store", headers: clientAuthHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `读取后台模型失败 (${response.status})`);
  }
  return Array.isArray(payload.data?.models) ? payload.data.models : [];
}

export async function testSub2ApiSpeed(): Promise<{ count: number; durationMs: number }> {
  const base = adminBackendUrl();
  if (!base) throw new Error("未配置后台地址，请在设置 → 后台服务中填写");
  const response = await fetch(adminApiUrl("/client/models/speed"), { cache: "no-store", headers: clientAuthHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `测试 Sub2API 链路失败 (${response.status})`);
  }
  return payload.data || { count: 0, durationMs: 0 };
}

export interface ClientBalance {
  balance: number;
  currency: "CNY" | string;
}

export async function fetchClientBalance(): Promise<ClientBalance> {
  const response = await fetch(adminApiUrl("/client/balance"), { cache: "no-store", headers: clientAuthHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `读取余额失败 (${response.status})`);
  return { balance: Number(payload.data?.balance) || 0, currency: String(payload.data?.currency || "CNY") };
}

export interface CustomModelUsageRecord {
  id: string | number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCny: number | null;
  createdAt: string | number | null;
  statusCode: number | null;
}

export interface CustomModelUsagePage {
  records: CustomModelUsageRecord[];
  total: number;
  page: number;
  pageSize: number;
  summary: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; costCny: number | null };
  exchangeRate: number;
}

export async function fetchCustomModelUsage(query: { page: number; pageSize: number; model?: string; startDate?: string; endDate?: string }): Promise<CustomModelUsagePage> {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  if (query.model) params.set("model", query.model);
  if (query.startDate) params.set("startDate", query.startDate);
  if (query.endDate) params.set("endDate", query.endDate);
  const response = await fetch(`${adminApiUrl("/client/tokens/usage")}?${params}`, { cache: "no-store", headers: clientAuthHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) throw new Error("后台尚未部署自定义模型用量接口，请更新 Python 后台服务");
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `读取自定义模型用量失败 (${response.status})`);
  return payload.data as CustomModelUsagePage;
}

async function workBuddyModelsRequest(path: string, init?: RequestInit): Promise<{ models: WorkBuddyModel[]; path?: string; proxyUrl?: string; removed?: number }> {
  const base = adminBackendUrl();
  if (!base) throw new Error("未配置后台地址，请在设置 → 后台服务中填写");
  const response = await fetch(adminApiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...clientAuthHeaders(), ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `同步 WorkBuddy 模型失败 (${response.status})`);
  }
  return payload.data || { models: [] };
}

export async function fetchWorkBuddyModels(): Promise<WorkBuddyModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: WorkBuddyModel[] }>("local_workbuddy_models");
    return Array.isArray(result?.models) ? result.models : [];
  }
  const result = await workBuddyModelsRequest("/api/client/workbuddy/models", { method: "GET" });
  return Array.isArray(result.models) ? result.models : [];
}

let connectionSyncPromise: Promise<WorkBuddyModel[]> | null = null;

export function syncWorkBuddyConnection(): Promise<WorkBuddyModel[]> {
  if (!isDesktop()) return Promise.resolve([]);
  if (connectionSyncPromise) return connectionSyncPromise;
  connectionSyncPromise = (async () => {
    const user = readClientUser();
    if (!user || !readClientToken()) throw new Error("请先登录个人中心");
    const response = await fetch(adminApiUrl("/client/models/connection"), {
      method: "POST", cache: "no-store", headers: clientAuthHeaders(),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 404) throw new Error("后台尚未部署模型连接同步接口");
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `同步模型连接失败 (${response.status})`);
    const connection = payload.data;
    if (Number(connection?.userId) !== user.id || !/^https?:\/\//i.test(connection?.baseUrl || "") || !/^sk-/.test(connection?.apiKey || "")) {
      throw new Error("后台返回的模型连接无效");
    }
    const result = await invoke<{ models?: WorkBuddyModel[] }>("local_workbuddy_update_connection", {
      userId: user.id, baseUrl: connection.baseUrl, apiKey: connection.apiKey,
    });
    return Array.isArray(result?.models) ? result.models : [];
  })().finally(() => { connectionSyncPromise = null; });
  return connectionSyncPromise;
}

export async function importModelsToWorkBuddy(models: WorkBuddyModelInput[]): Promise<WorkBuddyModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: WorkBuddyModel[] }>("local_workbuddy_import", { models, userId: readClientUser()?.id ?? null });
    return Array.isArray(result?.models) ? result.models : [];
  }
  const result = await workBuddyModelsRequest("/api/client/workbuddy/models", {
    method: "POST",
    body: JSON.stringify({ models }),
  });
  return Array.isArray(result.models) ? result.models : [];
}

export async function removeModelFromWorkBuddy(id: string): Promise<WorkBuddyModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: WorkBuddyModel[] }>("local_workbuddy_remove", { id });
    return Array.isArray(result?.models) ? result.models : [];
  }
  const result = await workBuddyModelsRequest("/api/client/workbuddy/models/remove", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return Array.isArray(result.models) ? result.models : [];
}

export async function removeThirdPartyModelFromWorkBuddy(id: string): Promise<WorkBuddyModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: WorkBuddyModel[] }>("local_workbuddy_remove_external", { id });
    return Array.isArray(result?.models) ? result.models : [];
  }
  throw new Error("第三方模型删除仅在桌面客户端可用");
}

export async function removeAllImportedModelsFromWorkBuddy(): Promise<{ models: WorkBuddyModel[]; removed: number }> {
  if (isDesktop()) {
    const result = await invoke<{ models?: WorkBuddyModel[]; removed?: number }>("local_workbuddy_remove_all");
    return { models: Array.isArray(result?.models) ? result.models : [], removed: Number(result?.removed) || 0 };
  }
  const result = await workBuddyModelsRequest("/api/client/workbuddy/models/remove-all", { method: "POST" });
  return { models: Array.isArray(result.models) ? result.models : [], removed: Number(result.removed) || 0 };
}

export async function disableModelFromWorkBuddy(id: string): Promise<WorkBuddyModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: WorkBuddyModel[] }>("local_workbuddy_disable", { id });
    return Array.isArray(result?.models) ? result.models : [];
  }
  const result = await workBuddyModelsRequest("/api/client/workbuddy/models/disable", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return Array.isArray(result.models) ? result.models : [];
}

export async function enableModelFromWorkBuddy(id: string): Promise<WorkBuddyModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: WorkBuddyModel[] }>("local_workbuddy_enable", { id });
    return Array.isArray(result?.models) ? result.models : [];
  }
  const result = await workBuddyModelsRequest("/api/client/workbuddy/models/enable", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return Array.isArray(result.models) ? result.models : [];
}

export async function proxySub2ApiChat(body: unknown): Promise<Response> {
  const base = adminBackendUrl();
  if (!base) throw new Error("未配置后台地址，请在设置 → 后台服务中填写");
  const installationId = typeof window !== "undefined" ? window.localStorage.getItem("workbuddy.telemetry.installation-id.v1") || "" : "";
  return fetch(adminApiUrl("/client/chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...clientAuthHeaders(), "X-Installation-Id": installationId },
    body: JSON.stringify(body),
  });
}

// ---- DeepSeek Harness 模型 ----
export interface DshModel {
  id: string;
  name?: string | null;
  /** 该模型所在的 provider 名称（如 wb-switch、my） */
  providerName?: string | null;
  managed?: boolean;
  disabled?: boolean;
}

async function dshModelsRequest(path: string, init?: RequestInit): Promise<{ models: DshModel[]; path?: string; added?: number; removed?: number }> {
  const base = adminBackendUrl();
  if (!base) throw new Error("未配置后台地址，请在设置 → 后台服务中填写");
  const response = await fetch(adminApiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...clientAuthHeaders(), ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `同步 DeepSeek Harness 模型失败 (${response.status})`);
  }
  return payload.data || { models: [] };
}

export async function fetchDshModels(): Promise<DshModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: DshModel[] }>("local_dsh_models");
    return Array.isArray(result?.models) ? result.models : [];
  }
  const result = await dshModelsRequest("/api/client/dsh/models", { method: "GET" });
  return Array.isArray(result.models) ? result.models : [];
}

export async function importModelsToDsh(models: WorkBuddyModelInput[]): Promise<DshModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: DshModel[] }>("local_dsh_import", { models });
    return Array.isArray(result?.models) ? result.models : [];
  }
  const result = await dshModelsRequest("/api/client/dsh/models", {
    method: "POST",
    body: JSON.stringify({ models }),
  });
  return Array.isArray(result.models) ? result.models : [];
}

export async function removeModelFromDsh(id: string): Promise<DshModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: DshModel[] }>("local_dsh_remove", { id });
    return Array.isArray(result?.models) ? result.models : [];
  }
  const result = await dshModelsRequest("/api/client/dsh/models/remove", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return Array.isArray(result.models) ? result.models : [];
}

export async function removeThirdPartyModelFromDsh(id: string, providerName: string): Promise<DshModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: DshModel[] }>("local_dsh_remove_external", { id, providerName });
    return Array.isArray(result?.models) ? result.models : [];
  }
  throw new Error("第三方模型删除仅在桌面客户端可用");
}

export async function removeAllModelsFromDsh(): Promise<{ models: DshModel[]; removed: number }> {
  if (isDesktop()) {
    const result = await invoke<{ models?: DshModel[]; removed?: number }>("local_dsh_remove_all");
    return { models: Array.isArray(result?.models) ? result.models : [], removed: Number(result?.removed) || 0 };
  }
  const result = await dshModelsRequest("/api/client/dsh/models/remove-all", { method: "POST" });
  return { models: Array.isArray(result.models) ? result.models : [], removed: Number(result.removed) || 0 };
}

export async function disableModelFromDsh(id: string, providerName?: string): Promise<DshModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: DshModel[] }>("local_dsh_disable", { id, providerName });
    return Array.isArray(result?.models) ? result.models : [];
  }
  if (providerName && providerName !== "wb-switch") throw new Error("第三方模型开关仅在桌面客户端可用");
  const result = await dshModelsRequest("/api/client/dsh/models/disable", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return Array.isArray(result.models) ? result.models : [];
}

export async function enableModelFromDsh(id: string, providerName?: string): Promise<DshModel[]> {
  if (isDesktop()) {
    const result = await invoke<{ models?: DshModel[] }>("local_dsh_enable", { id, providerName });
    return Array.isArray(result?.models) ? result.models : [];
  }
  if (providerName && providerName !== "wb-switch") throw new Error("第三方模型开关仅在桌面客户端可用");
  const result = await dshModelsRequest("/api/client/dsh/models/enable", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  return Array.isArray(result.models) ? result.models : [];
}

// ---- 充值 ----
export interface RechargeOrder {
  id: number;
  outTradeNo: string;
  userId: number;
  amount: number;
  credited: number;
  balanceAmount?: number;
  bonus?: number;
  activityId?: number | null;
  type: string;
  status: string;
  tradeNo?: string | null;
  payUrl?: string | null;
  createdAt: number;
  paidAt?: number | null;
  creditedAt?: number | null;
}

export interface RechargeActivity {
  id: number;
  amount: number;
  bonus: number;
  credited: number;
  label: string;
  enabled: boolean;
  sortOrder: number;
  updatedAt: number;
}

export interface RechargeConfig {
  enabled: boolean;
  activities: RechargeActivity[];
}

async function rechargeRequest(path: string, init?: RequestInit): Promise<any> {
  const base = adminBackendUrl();
  if (!base) throw new Error("未配置后台地址，请在设置 → 后台服务中填写");
  const response = await fetch(adminApiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...clientAuthHeaders(), ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `充值请求失败 (${response.status})`);
  }
  return payload.data || {};
}

export async function fetchRechargeConfig(): Promise<RechargeConfig> {
  const result = await rechargeRequest("/api/client/recharge/config", { method: "GET" });
  const hasActivities = Array.isArray(result.activities);
  const entries = (hasActivities ? result.activities : Array.isArray(result.plans) ? result.plans : [])
    .filter((entry: Record<string, unknown>) => hasActivities || entry.balance !== undefined || entry.credited !== undefined || entry.bonus !== undefined);
  const activities = entries.map((entry: Record<string, unknown>) => {
    const amount = Number(entry.amount) || 0;
    const hasRmbBalance = entry.balance !== undefined && entry.balance !== null;
    const credited = Number(entry.credited ?? (hasRmbBalance ? entry.balance : amount)) || amount;
    const bonus = Number(entry.bonus ?? (hasRmbBalance ? Math.max(0, credited - amount) : 0)) || 0;
    return {
      id: Number(entry.id), amount, credited, bonus,
      label: String(entry.label || ""), enabled: entry.enabled !== false,
      sortOrder: Number(entry.sortOrder) || 0, updatedAt: Number(entry.updatedAt) || 0,
    } satisfies RechargeActivity;
  }).filter((activity: RechargeActivity) => Number.isFinite(activity.id) && activity.amount > 0 && activity.bonus >= 0 && activity.credited >= activity.amount);
  return { enabled: Boolean(result.enabled), activities };
}

export async function createRechargeOrder(amount: number, type: string, activityId?: number | null, returnUrl?: string): Promise<{ order: RechargeOrder; payUrl: string | null; qrcode: string | null; urlScheme: string | null }> {
  const result = await rechargeRequest("/api/client/recharge/create", {
    method: "POST",
    body: JSON.stringify({ amount, type, activityId: activityId ?? undefined, returnUrl: returnUrl ?? (typeof window !== "undefined" ? window.location.origin + window.location.pathname : undefined) }),
  });
  return { order: result.order, payUrl: result.payUrl || null, qrcode: result.qrcode || null, urlScheme: result.urlScheme || null };
}

export function rechargePaymentTargets(result: { payUrl: string | null; qrcode: string | null; urlScheme: string | null }): { qrValue: string | null; fallbackUrl: string | null } {
  const qrValue = result.urlScheme || result.qrcode;
  const fallbackUrl = result.payUrl && result.payUrl !== qrValue && /^https?:\/\//i.test(result.payUrl) ? result.payUrl : null;
  return { qrValue, fallbackUrl };
}

export async function fetchRechargeOrders(): Promise<RechargeOrder[]> {
  const result = await rechargeRequest("/api/client/recharge/orders", { method: "GET" });
  return Array.isArray(result.orders) ? result.orders : [];
}

export async function fetchRechargeOrderStatus(outTradeNo: string): Promise<RechargeOrder> {
  const result = await rechargeRequest(`/api/client/recharge/status?outTradeNo=${encodeURIComponent(outTradeNo)}`, { method: "GET" });
  return result.order;
}
