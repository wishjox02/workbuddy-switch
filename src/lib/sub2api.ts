import { adminApiUrl, adminBackendUrl, serviceDisplayText } from "@/lib/admin-backend";
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

function isSafeModelBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
    return url.protocol === "https:" || (url.protocol === "http:" && loopback);
  } catch {
    return false;
  }
}

export async function fetchModelConnection(): Promise<{ baseUrl: string; apiKey: string }> {
  const token = readClientToken();
  const userId = readClientUser()?.id;
  if (!token || !userId) throw new Error("请先登录个人中心");
  const response = await fetch(adminApiUrl("/client/models/connection"), {
    method: "POST", cache: "no-store", headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => ({}));
  if (token !== readClientToken() || userId !== readClientUser()?.id) throw new Error("登录状态已变化，请重新打开 API");
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `读取模型连接失败 (${response.status})`));
  const connection = payload.data;
  if (Number(connection?.userId) !== userId || !isSafeModelBaseUrl(connection?.baseUrl) || !/^sk-/.test(connection?.apiKey || "")) throw new Error("后台返回的模型连接无效");
  return { baseUrl: connection.baseUrl, apiKey: connection.apiKey };
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
    throw new Error(serviceDisplayText(payload.error || `读取后台模型失败 (${response.status})`));
  }
  return Array.isArray(payload.data?.models) ? payload.data.models : [];
}

export async function testSub2ApiSpeed(): Promise<{ count: number; durationMs: number }> {
  const base = adminBackendUrl();
  if (!base) throw new Error("未配置后台地址，请在设置 → 后台服务中填写");
  const response = await fetch(adminApiUrl("/client/models/speed"), { cache: "no-store", headers: clientAuthHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(serviceDisplayText(payload.error || `测试模型服务链路失败 (${response.status})`));
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
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `读取余额失败 (${response.status})`));
  const rawBalance = payload.data?.balance;
  const balance = typeof rawBalance === "number" || (typeof rawBalance === "string" && rawBalance.trim()) ? Number(rawBalance) : NaN;
  if (!Number.isFinite(balance)) throw new Error("余额数据暂不可用");
  return { balance, currency: String(payload.data?.currency || "CNY") };
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
  summary: { requests: number | null; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; costCny: number | null };
  exchangeRate: number;
}

function firstPresent(source: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function numberOrZero(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCustomModelUsage(data: Record<string, unknown>): CustomModelUsagePage {
  const rawSummary = (data.summary ?? data.stats ?? {}) as Record<string, unknown>;
  const records = Array.isArray(data.records)
    ? data.records.map((item) => {
        const record = (item || {}) as Record<string, unknown>;
        const inputTokens = numberOrZero(firstPresent(record, ["inputTokens", "prompt_tokens", "input_tokens"]));
        const outputTokens = numberOrZero(firstPresent(record, ["outputTokens", "completion_tokens", "output_tokens"]));
        return {
          id: (record.id as string | number | null | undefined) ?? null,
          model: String(firstPresent(record, ["model", "model_name"]) ?? ""),
          inputTokens,
          outputTokens,
          totalTokens: numberOrZero(firstPresent(record, ["totalTokens", "total_tokens"])) || inputTokens + outputTokens,
          costCny: numberOrNull(firstPresent(record, ["costCny", "actual_cost", "cost"])),
          createdAt: (firstPresent(record, ["createdAt", "created_at"]) as string | number | null | undefined) ?? null,
          statusCode: numberOrNull(firstPresent(record, ["statusCode", "status_code"])),
        };
      })
    : [];
  const summaryCost = numberOrNull(firstPresent(rawSummary, ["costCny", "total_actual_cost", "totalActualCost", "total_cost", "totalCost", "actual_cost", "cost"]));
  return {
    records,
    total: numberOrZero(firstPresent(data, ["total", "count"])) || records.length,
    page: numberOrZero(data.page) || 1,
    pageSize: numberOrZero(firstPresent(data, ["pageSize", "page_size"])) || 50,
    summary: {
      requests: numberOrNull(firstPresent(rawSummary, ["requests", "total_requests", "request_count", "totalRequests"])) ?? numberOrNull(firstPresent(data, ["total", "count"])),
      inputTokens: numberOrNull(firstPresent(rawSummary, ["inputTokens", "total_input_tokens", "input_tokens", "prompt_tokens", "totalInputTokens"])),
      outputTokens: numberOrNull(firstPresent(rawSummary, ["outputTokens", "total_output_tokens", "output_tokens", "completion_tokens", "totalOutputTokens"])),
      totalTokens: numberOrNull(firstPresent(rawSummary, ["totalTokens", "total_tokens"])),
      costCny: summaryCost,
    },
    exchangeRate: numberOrZero(data.exchangeRate) || 1,
  };
}

export async function fetchCustomModelUsage(query: { page: number; pageSize: number; model?: string; startDate?: string; endDate?: string }): Promise<CustomModelUsagePage> {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  if (query.model) params.set("model", query.model);
  if (query.startDate) params.set("startDate", query.startDate);
  if (query.endDate) params.set("endDate", query.endDate);
  const response = await fetch(`${adminApiUrl("/client/tokens/usage")}?${params}`, { cache: "no-store", headers: clientAuthHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) throw new Error("后台尚未部署自定义模型用量接口，请更新 Python 后台服务");
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `读取自定义模型用量失败 (${response.status})`));
  return normalizeCustomModelUsage((payload.data || {}) as Record<string, unknown>);
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
    throw new Error(serviceDisplayText(payload.error || `同步 WorkBuddy 模型失败 (${response.status})`));
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

class StaleModelConnectionError extends Error {
  constructor() { super("登录状态已变化，模型连接同步已取消"); }
}

export function isStaleModelConnectionError(error: unknown): boolean {
  return error instanceof StaleModelConnectionError;
}

type ConnectionIdentity = { token: string; userId: number | null; base: string };
let connectionTail: Promise<void> = Promise.resolve();
let connectionTask: { identity: ConnectionIdentity; controller: AbortController; promise: Promise<WorkBuddyModel[]> } | null = null;
let preparedIdentity: ConnectionIdentity | null = null;
let connectionGeneration = 0;

function sameConnectionIdentity(a: ConnectionIdentity | null, b: ConnectionIdentity): boolean {
  return !!a && a.token === b.token && a.userId === b.userId && a.base === b.base;
}

function connectionIdentity(): ConnectionIdentity {
  return { token: readClientToken(), userId: readClientUser()?.id ?? null, base: adminBackendUrl() };
}

export function syncWorkBuddyConnection(): Promise<WorkBuddyModel[]> {
  if (!isDesktop()) return Promise.resolve([]);
  const identity = connectionIdentity();
  if (connectionTask && sameConnectionIdentity(connectionTask.identity, identity)) return connectionTask.promise;
  connectionTask?.controller.abort();
  const generation = ++connectionGeneration;
  const controller = new AbortController();
  const assertCurrent = () => {
    if (generation !== connectionGeneration || !sameConnectionIdentity(connectionIdentity(), identity)) throw new StaleModelConnectionError();
  };
  const promise = connectionTail.then(async () => {
    assertCurrent();
    if (!sameConnectionIdentity(preparedIdentity, identity)) {
      preparedIdentity = null;
      await invoke("local_workbuddy_clear_connection");
      assertCurrent();
      preparedIdentity = identity;
    }
    if (!identity.token || !identity.userId) return [];
    let response: Response;
    try {
      response = await fetch(adminApiUrl("/client/models/connection"), {
        method: "POST", cache: "no-store", headers: { Authorization: `Bearer ${identity.token}` }, signal: controller.signal,
      });
    } catch (error) {
      assertCurrent();
      throw error;
    }
    assertCurrent();
    const payload = await response.json().catch(() => ({}));
    assertCurrent();
    if (response.status === 404) throw new Error("后台尚未部署模型连接同步接口");
    if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `同步模型连接失败 (${response.status})`));
    const connection = payload.data;
    if (Number(connection?.userId) !== identity.userId || !isSafeModelBaseUrl(connection?.baseUrl) || !/^sk-/.test(connection?.apiKey || "")) {
      throw new Error("后台返回的模型连接无效");
    }
    const result = await invoke<{ models?: WorkBuddyModel[] }>("local_workbuddy_update_connection", {
      userId: identity.userId, baseUrl: connection.baseUrl, apiKey: connection.apiKey,
    });
    assertCurrent();
    return Array.isArray(result?.models) ? result.models : [];
  });
  connectionTail = promise.then(() => undefined, () => undefined);
  const task = { identity, controller, promise };
  connectionTask = task;
  void promise.finally(() => { if (connectionTask === task) connectionTask = null; }).catch(() => {});
  return promise;
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
    throw new Error(serviceDisplayText(payload.error || `同步 DeepSeek Harness 模型失败 (${response.status})`));
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
    const connection = await fetchModelConnection();
    const result = await invoke<{ models?: DshModel[] }>("local_dsh_import", { models, baseUrl: connection.baseUrl, apiKey: connection.apiKey });
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

export async function restartDeepSeekHarness(): Promise<void> {
  if (!isDesktop()) throw new Error("当前平台请手动重启 DeepSeek Harness");
  await invoke("restart_deepseek_harness");
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

export function rechargeStatusState(status: string): "credited" | "paid" | "other" {
  if (status === "Credited") return "credited";
  if (status === "Paid") return "paid";
  return "other";
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
    if (response.status === 404 && path.includes("/client/redeem")) {
      throw new Error("当前后台尚未部署兑换接口，请更新后台服务后重试");
    }
    throw new Error(serviceDisplayText(payload.error || `充值请求失败 (${response.status})`));
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

/** Confirm a signed payment return on newer backends; null means legacy backend. */
export async function confirmRechargeReturn(params: URLSearchParams): Promise<{ order: RechargeOrder | null } | null> {
  const response = await fetch(adminApiUrl("/client/recharge/confirm"), {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", ...clientAuthHeaders() },
    body: JSON.stringify(Object.fromEntries(params.entries())),
  });
  if (response.status === 404) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `确认支付失败 (${response.status})`));
  const order = payload.data?.order;
  return { order: order && typeof order === "object" ? order as RechargeOrder : null };
}

export interface RedeemResult { credits: number; balance: number }

export interface UserApiKey {
  id: string | number | null;
  name: string;
  apiKeyLast4?: string | null;
  isDefault?: boolean;
  status?: string | null;
  createdAt?: string | number | null;
  expiresAt?: string | number | null;
}

async function userApiKeysRequest(path: string, init?: RequestInit): Promise<any> {
  const base = adminBackendUrl();
  if (!base) throw new Error("未配置后台地址，请在设置 → 后台服务中填写");
  const response = await fetch(adminApiUrl(path), {
    ...init,
    headers: { "Content-Type": "application/json", ...clientAuthHeaders(), ...(init?.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `API Key 请求失败 (${response.status})`));
  return payload.data || {};
}

export async function fetchUserApiKeys(): Promise<UserApiKey[]> {
  const result = await userApiKeysRequest("/api/client/api-keys?page=1&page_size=100", { method: "GET" });
  return Array.isArray(result.items) ? result.items : [];
}

export async function createUserApiKey(name: string): Promise<{ key: UserApiKey; apiKey: string }> {
  const result = await userApiKeysRequest("/api/client/api-keys", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
  return { key: result, apiKey: String(result.apiKey || "") };
}

export async function deleteUserApiKey(id: string | number): Promise<void> {
  await userApiKeysRequest(`/api/client/api-keys/${encodeURIComponent(String(id))}`, { method: "DELETE" });
}

export interface RedeemHistoryItem {
  id: string | number | null;
  code: string;
  type: string;
  value: number | null;
  usedAt: string | number | null;
}
export interface RedeemHistoryPage { items: RedeemHistoryItem[]; total: number; page: number; pageSize: number }

export async function fetchRedeemHistory(page = 1, pageSize = 20): Promise<RedeemHistoryPage> {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  const response = await fetch(`${adminApiUrl("/client/redeem/history")}?${params}`, { cache: "no-store", headers: clientAuthHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) throw new Error("后台尚未部署兑换记录接口");
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `读取兑换记录失败 (${response.status})`));
  const data: unknown = payload.data;
  const object = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const rows = Array.isArray(data) ? data : object?.items;
  if (!Array.isArray(rows)) throw new Error("兑换记录响应格式无效");
  const items = rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object" && !Array.isArray(row))).map((row) => {
    const rawValue = row.value ?? row.amount;
    const number = rawValue === null || rawValue === undefined || rawValue === "" ? null : Number(rawValue);
    const date = row.used_at ?? row.usedAt ?? row.created_at ?? row.createdAt;
    return { id: typeof row.id === "string" || typeof row.id === "number" ? row.id : null, code: typeof row.code === "string" ? row.code : "", type: typeof row.type === "string" ? row.type : "", value: number !== null && Number.isFinite(number) ? number : null, usedAt: typeof date === "string" || typeof date === "number" ? date : null };
  });
  const total = Number(object?.total);
  return { items, total: object && Number.isFinite(total) && total >= 0 ? total : items.length, page, pageSize };
}

export async function redeemCode(code: string): Promise<RedeemResult> {
  const result = await rechargeRequest("/api/client/redeem", {
    method: "POST", body: JSON.stringify({ code: code.trim() }),
  });
  const credits = Number(result.credits);
  const balance = Number(result.balance);
  if (!Number.isFinite(credits) || !Number.isFinite(balance)) throw new Error("兑换结果无效");
  return { credits, balance };
}
