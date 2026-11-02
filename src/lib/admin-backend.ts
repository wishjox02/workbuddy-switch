const ADMIN_BACKEND_STORAGE_KEY = "workbuddy.admin-backend-url.v1";
const LOCAL_ADMIN_BACKEND_URL = "http://127.0.0.1:57900";
/** 线上后台 API 根地址：打包后的客户端默认接入这里。 */
const DEFAULT_ADMIN_BACKEND_URL = "https://woai.info/admin/api";

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
  if (configured) return configured;

  const stored = readStoredAdminBackendUrl();
  if (stored) return stored;

  // 开发页也默认使用线上后台；本地预览后台请显式设置
  // VITE_WB_ADMIN_URL=http://127.0.0.1:57900，避免把登录请求发给 Vite 的账号服务。
  if (import.meta.env.DEV) return DEFAULT_ADMIN_BACKEND_URL;

  // A web deployment can put the admin service behind the same origin. Tauri 桌面
  // 窗口的 origin 是 tauri.localhost，不能当成后台地址，必须回退到线上域名。
  if (typeof window !== "undefined" && /^https?:$/.test(window.location.protocol)) {
    const origin = normalizeAdminBackendUrl(window.location.origin);
    if (origin && !/^https?:\/\/(?:tauri\.localhost|woai\.info)$/i.test(origin)) return origin;
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
  const normalized = normalizeAdminBackendUrl(value);
  if (typeof window !== "undefined") {
    try {
      if (normalized) window.localStorage.setItem(ADMIN_BACKEND_STORAGE_KEY, normalized);
      else window.localStorage.removeItem(ADMIN_BACKEND_STORAGE_KEY);
    } catch {
      // Ignore storage failures; the build-time/default URL remains usable.
    }
  }
  return normalized;
}

export { DEFAULT_ADMIN_BACKEND_URL, LOCAL_ADMIN_BACKEND_URL };
