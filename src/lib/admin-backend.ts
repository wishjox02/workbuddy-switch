const ADMIN_BACKEND_STORAGE_KEY = "workbuddy.admin-backend-url.v1";
const LOCAL_ADMIN_BACKEND_URL = "http://127.0.0.1:57900";
/** 线上后台 API 根地址：打包后的客户端默认接入这里。 */
const DEFAULT_ADMIN_BACKEND_URL = "https://woai.info/admin/api";
const SESSION_TOKEN_KEY = "workbuddy.client.session-token.v1";
const SESSION_USER_KEY = "workbuddy.client.user.v1";
const AUTH_CHANGED_EVENT = "workbuddy-auth-changed";

/** Redact service implementation details in messages shown to end users. */
export function serviceDisplayText(value: string): string {
  return value
    .replace(/error sending request for url(?:\s*\([^)]*\))?/gi, "更新服务请求失败")
    .replace(/https?:\/\/[^\s"'<>，。；）)\]}]+/gi, "更新服务")
    .replace(/(?:[\w-]+\.)?woai\.info(?::\d+)?(?:\/[^\s，。；）)]*)?/gi, "更新服务")
    .replace(/sub2api/gi, "模型服务");
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** Public backends must use TLS; plain HTTP is only allowed for local development. */
export function validateAdminBackendUrl(value: string): string {
  const normalized = normalizeAdminBackendUrl(value);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("后台地址无效");
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("后台地址不能包含账号、密码、查询参数或片段");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error("远程后台必须使用 HTTPS，本机回环地址才允许 HTTP");
  }
  return normalized;
}

function normalizeAdminBackendUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  // 旧版本默认保存的是 http://woai.info，迁移到实际的线上 API 入口。
  if (/^https?:\/\/woai\.info$/i.test(normalized)) return DEFAULT_ADMIN_BACKEND_URL;
  if (/^http:\/\/woai\.info\//i.test(normalized)) return normalized.replace(/^http:/i, "https:");
  return normalized;
}

function readStoredAdminBackendUrl(): string {
  if (typeof window === "undefined") return "";
  try {
    return normalizeAdminBackendUrl(window.localStorage.getItem(ADMIN_BACKEND_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

/** Resolve the service that owns client auth, models, credits, and recharge APIs. */
export function adminBackendUrl(): string {
  const configured = normalizeAdminBackendUrl(import.meta.env.VITE_WB_ADMIN_URL || "");
  if (configured) {
    try { return validateAdminBackendUrl(configured); } catch { return DEFAULT_ADMIN_BACKEND_URL; }
  }

  const stored = readStoredAdminBackendUrl();
  if (stored) {
    try { return validateAdminBackendUrl(stored); } catch { return DEFAULT_ADMIN_BACKEND_URL; }
  }

  // 开发页也默认使用线上后台；本地预览后台请显式设置
  // VITE_WB_ADMIN_URL=http://127.0.0.1:57900，避免把登录请求发给 Vite 的账号服务。
  if (import.meta.env.DEV) return DEFAULT_ADMIN_BACKEND_URL;

  // A web deployment can put the admin service behind the same origin. Tauri 桌面
  // 窗口的 origin 是 tauri.localhost，不能当成后台地址，必须回退到线上域名。
  if (typeof window !== "undefined" && /^https?:$/.test(window.location.protocol)) {
    const origin = normalizeAdminBackendUrl(window.location.origin);
    if (origin && !/^https?:\/\/(?:tauri\.localhost|woai\.info)$/i.test(origin)) {
      try { return validateAdminBackendUrl(origin); } catch { return DEFAULT_ADMIN_BACKEND_URL; }
    }
  }

  // 打包后的桌面客户端默认接入线上后台域名，可用 VITE_WB_ADMIN_URL 覆盖。
  return DEFAULT_ADMIN_BACKEND_URL;
}

/**
 * Build a request URL for the admin service.
 *
 * The service exposes routes below `/api`, while deployments may configure
 * either the domain root, a reverse-proxy prefix such as `/admin`, or the
 * complete `/admin/api` URL. Accept all three forms without duplicating `/api`.
 */
export function adminApiUrl(path: string): string {
  const base = adminBackendUrl().replace(/\/+$/, "");
  const normalizedPath = `/${path.replace(/^\/+/, "")}`.replace(/^\/api(?=\/|$|\?)/i, "");
  const apiRoot = /\/api$/i.test(base) ? base : `${base}/api`;
  return `${apiRoot}${normalizedPath}`;
}

export function saveAdminBackendUrl(value: string): string {
  const normalized = validateAdminBackendUrl(value);
  if (typeof window !== "undefined") {
    try {
      const previous = readStoredAdminBackendUrl() || adminBackendUrl();
      if (normalized) window.localStorage.setItem(ADMIN_BACKEND_STORAGE_KEY, normalized);
      else window.localStorage.removeItem(ADMIN_BACKEND_STORAGE_KEY);
      if (previous !== normalized) {
        // A bearer token is scoped to the old backend. Never send it to a new origin.
        window.localStorage.removeItem(SESSION_TOKEN_KEY);
        window.localStorage.removeItem(SESSION_USER_KEY);
        window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
      }
    } catch {
      throw new Error("无法保存后台地址");
    }
  }
  return normalized;
}

export { DEFAULT_ADMIN_BACKEND_URL, LOCAL_ADMIN_BACKEND_URL };
