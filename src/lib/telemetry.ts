import { adminApiUrl } from "@/lib/admin-backend";
import { demoModeEnabled } from "@/lib/demo-mode";

const INSTALLATION_ID_KEY = "workbuddy.telemetry.installation-id.v1";
const sentEvents = new Set<string>();
let launchSent = false;

function telemetryUrl(): string {
  // 匿名心跳跟随客户端统一的后台地址（默认线上域名），可用 VITE_WB_ADMIN_URL 覆盖。
  return adminApiUrl("/telemetry/heartbeat");
}

function installationId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const existing = window.localStorage.getItem(INSTALLATION_ID_KEY);
    if (existing) return existing;
    const next = crypto.randomUUID();
    window.localStorage.setItem(INSTALLATION_ID_KEY, next);
    return next;
  } catch {
    return null;
  }
}

function platform(): { os: string; arch: string } {
  if (typeof navigator === "undefined") return { os: "unknown", arch: "unknown" };
  const ua = navigator.userAgent.toLowerCase();
  const os = ua.includes("windows") ? "windows" : ua.includes("mac") ? "macos" : ua.includes("linux") ? "linux" : "other";
  const arch = ua.includes("arm") || ua.includes("aarch") ? "arm64" : ua.includes("64") ? "x64" : "unknown";
  return { os, arch };
}

async function send(payload: { accountCount: number; launch: boolean; events?: Record<string, number> }): Promise<void> {
  const base = telemetryUrl();
  const id = installationId();
  if (!base || !id || demoModeEnabled) return;
  const { os, arch } = platform();
  const key = `${payload.launch ? "launch" : "event"}:${payload.accountCount}:${JSON.stringify(payload.events || {})}`;
  if (!payload.launch && sentEvents.has(key)) return;
  if (!payload.launch) sentEvents.add(key);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4000);
  try {
    await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installationId: id,
        appVersion: import.meta.env.VITE_APP_VERSION || "0.1.62",
        os,
        arch,
        locale: navigator.language,
        accountCount: Math.max(0, Math.floor(payload.accountCount)),
        launch: payload.launch,
        events: payload.events,
      }),
      signal: controller.signal,
    });
  } catch {
    // Telemetry must never affect the user-facing app.
  } finally {
    window.clearTimeout(timeout);
  }
}

export function sendTelemetryLaunch(accountCount: number): void {
  if (launchSent) return;
  launchSent = true;
  void send({ accountCount, launch: true, events: { app_open: 1 } });
}

export function sendTelemetryEvent(accountCount: number, feature: string): void {
  if (!feature.trim()) return;
  void send({ accountCount, launch: false, events: { [feature.trim().slice(0, 80)]: 1 } });
}
