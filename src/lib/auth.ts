import { adminApiUrl } from "@/lib/admin-backend";

const TOKEN_KEY = "workbuddy.client.session-token.v1";
const USER_KEY = "workbuddy.client.user.v1";
const AUTH_EVENT = "workbuddy-auth-changed";

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
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  window.dispatchEvent(new Event(AUTH_EVENT));
}

export function clearClientAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  window.dispatchEvent(new Event(AUTH_EVENT));
}

export async function fetchLoginCaptcha(): Promise<LoginCaptcha | null> {
  const endpoint = adminApiUrl("/client/auth/captcha");
  let response: Response;
  try {
    response = await fetch(endpoint, { cache: "no-store" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法获取安全验证题目（${endpoint}）：${reason}`);
  }
  if (response.status === 404) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `获取安全验证题目失败 (${response.status})`);
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
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法连接验证码后台（${endpoint}）：${reason}`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `发送验证码失败 (${response.status})`);
  return payload.data;
}

export async function loginWithCode(phone: string, challengeId: string, verifyCode: string): Promise<ClientUser> {
  const response = await fetch(adminApiUrl("/client/auth/sms/login"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, challengeId, verifyCode }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `登录失败 (${response.status})`);
  const user = { ...payload.data.user, sub2apiSync: payload.data.sub2apiSync } as ClientUser;
  writeClientAuth(payload.data.sessionToken, user);
  return user;
}

export async function logoutClient(): Promise<void> {
  const token = readClientToken();
  if (token) {
    await fetch(adminApiUrl("/client/auth/logout"), { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
  }
  clearClientAuth();
}

export function authChangedEvent(): string { return AUTH_EVENT; }
