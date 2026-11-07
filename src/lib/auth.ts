import { adminApiUrl, serviceDisplayText } from "@/lib/admin-backend";

const TOKEN_KEY = "workbuddy.client.session-token.v1";
const USER_KEY = "workbuddy.client.user.v1";
const AUTH_EVENT = "workbuddy-auth-changed";
let authGeneration = 0;
let refreshGeneration = 0;

export interface ClientUser {
  id: number;
  phone: string;
  displayName: string;
  sub2apiAccountId?: string | null;
  status: string;
  createdAt: number;
  lastLoginAt?: number | null;
  sub2apiSync?: { synced: boolean; created?: boolean; error?: string | null; apiKeyReady?: boolean; apiKeyLast4?: string | null; modelCount?: number };
}

export interface LoginCaptcha {
  captchaId: string;
  question?: string;
  imageDataUrl?: string;
  expiresIn: number;
  maxAttempts: number;
}

export interface LoginCaptchaAnswer {
  captchaId: string;
  captchaAnswer: string;
}

export function readClientUser(): ClientUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) as ClientUser : null;
  } catch { return null; }
}

export function readClientToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

export function writeClientAuth(token: string, user: ClientUser): void {
  authGeneration += 1;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  window.dispatchEvent(new Event(AUTH_EVENT));
}

export function clearClientAuth(): void {
  authGeneration += 1;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  window.dispatchEvent(new Event(AUTH_EVENT));
}

export async function refreshClientUser(): Promise<ClientUser | null> {
  const token = readClientToken();
  if (!token) return null;
  const generation = authGeneration;
  const refresh = ++refreshGeneration;
  const response = await fetch(adminApiUrl("/client/auth/me"), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (generation !== authGeneration || refresh !== refreshGeneration || readClientToken() !== token) return null;
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `读取用户信息失败 (${response.status})`));
  if (!payload.data?.user) throw new Error("用户信息响应无效");
  const user = { ...payload.data.user, sub2apiSync: readClientUser()?.sub2apiSync } as ClientUser;
  const serialized = JSON.stringify(user);
  const previous = localStorage.getItem(USER_KEY);
  localStorage.setItem(USER_KEY, serialized);
  // Background profile refresh must not look like an account switch to pages
  // that clear local state on auth changes (for example redeem history).
  if (previous !== serialized) window.dispatchEvent(new Event(AUTH_EVENT));
  return user;
}

export async function fetchLoginCaptcha(): Promise<LoginCaptcha | null> {
  const endpoint = adminApiUrl("/client/auth/captcha");
  let response: Response;
  try {
    response = await fetch(endpoint, { cache: "no-store" });
  } catch {
    throw new Error("无法连接登录服务，请检查网络或稍后重试");
  }
  if (response.status === 404) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `获取安全验证题目失败 (${response.status})`));
  const captcha = payload.data;
  const hasQuestion = typeof captcha?.question === "string" && Boolean(captcha.question.trim());
  const hasImage = typeof captcha?.imageDataUrl === "string" && /^data:image\/(?:png|jpeg|webp);base64,/i.test(captcha.imageDataUrl);
  if (typeof captcha?.captchaId !== "string" || !captcha.captchaId || (!hasQuestion && !hasImage)) {
    throw new Error("安全验证题目响应无效");
  }
  return captcha as LoginCaptcha;
}

export async function sendLoginCode(phone: string, captcha?: LoginCaptchaAnswer): Promise<{ challengeId: string; phoneMasked: string; expiresIn: number; devCode?: string }> {
  const endpoint = adminApiUrl("/client/auth/sms/send");
  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, ...captcha }) });
  } catch {
    throw new Error("无法连接验证码服务，请检查网络或稍后重试");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `发送验证码失败 (${response.status})`));
  return payload.data;
}

export async function loginWithCode(phone: string, challengeId: string, verifyCode: string, signal?: AbortSignal): Promise<ClientUser> {
  const generation = ++authGeneration;
  const originalToken = readClientToken();
  const response = await fetch(adminApiUrl("/client/auth/sms/login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, challengeId, verifyCode }), signal });
  const payload = await response.json().catch(() => ({}));
  if (signal?.aborted || generation !== authGeneration || readClientToken() !== originalToken) {
    throw new Error("登录请求已取消或账号已切换");
  }
  if (!response.ok || payload.ok === false) throw new Error(serviceDisplayText(payload.error || `登录失败 (${response.status})`));
  const user = { ...payload.data.user, sub2apiSync: payload.data.sub2apiSync } as ClientUser;
  writeClientAuth(payload.data.sessionToken, user);
  return user;
}

export async function logoutClient(): Promise<void> {
  const token = readClientToken();
  clearClientAuth();
  if (token) {
    await fetch(adminApiUrl("/client/auth/logout"), { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
  }
}

export function authChangedEvent(): string { return AUTH_EVENT; }
