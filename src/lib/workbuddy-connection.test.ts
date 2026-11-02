import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { syncWorkBuddyConnection } from "./sub2api";

vi.mock("@/lib/api", () => ({ isDesktop: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function signedIn() {
  const values: Record<string, string> = {
    "workbuddy.client.session-token.v1": "session-token",
    "workbuddy.client.user.v1": JSON.stringify({ id: 3, phone: "13800138000" }),
  };
  const localStorage = { getItem: (key: string) => values[key] ?? null };
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("localStorage", localStorage);
  vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
}

describe("syncWorkBuddyConnection", () => {
  it("writes the current user's refreshed connection into the desktop model file", async () => {
    signedIn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, data: { userId: 3, baseUrl: "https://models.example/v1", apiKey: "sk-new-key" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(invoke).mockResolvedValue({ models: [{ id: "cn:test" }] });

    await expect(syncWorkBuddyConnection()).resolves.toEqual([{ id: "cn:test" }]);
    expect(fetchMock).toHaveBeenCalledWith("https://woai.info/admin/api/client/models/connection", {
      method: "POST", cache: "no-store", headers: { Authorization: "Bearer session-token" },
    });
    expect(invoke).toHaveBeenCalledWith("local_workbuddy_update_connection", {
      userId: 3, baseUrl: "https://models.example/v1", apiKey: "sk-new-key",
    });
  });

  it("refuses credentials for another user", async () => {
    signedIn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, data: { userId: 8, baseUrl: "https://models.example/v1", apiKey: "sk-other-key" },
    }), { status: 200 })));

    await expect(syncWorkBuddyConnection()).rejects.toThrow("后台返回的模型连接无效");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("identifies a backend without the connection sync endpoint", async () => {
    signedIn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "Not Found" }), { status: 404 })));

    await expect(syncWorkBuddyConnection()).rejects.toThrow("后台尚未部署模型连接同步接口");
    expect(invoke).not.toHaveBeenCalled();
  });
});
