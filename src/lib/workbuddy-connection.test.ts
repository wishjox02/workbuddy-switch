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

let sessionNumber = 0;
function signedIn() {
  const token = `session-token-${++sessionNumber}`;
  const values: Record<string, string> = {
    "workbuddy.client.session-token.v1": token,
    "workbuddy.client.user.v1": JSON.stringify({ id: 3, phone: "13800138000" }),
  };
  const localStorage = { getItem: (key: string) => values[key] ?? null };
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("localStorage", localStorage);
  vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
  return { values, token };
}

describe("syncWorkBuddyConnection", () => {
  it("writes the current user's refreshed connection into the desktop model file", async () => {
    const { token } = signedIn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, data: { userId: 3, baseUrl: "https://models.example/v1", apiKey: "sk-new-key" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(invoke).mockResolvedValue({ models: [{ id: "cn:test" }] });

    await expect(syncWorkBuddyConnection()).resolves.toEqual([{ id: "cn:test" }]);
    expect(fetchMock).toHaveBeenCalledWith("https://woai.info/admin/api/client/models/connection", expect.objectContaining({
      method: "POST", cache: "no-store", headers: { Authorization: `Bearer ${token}` }, signal: expect.any(AbortSignal),
    }));
    expect(invoke).toHaveBeenCalledWith("local_workbuddy_clear_connection");
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
    expect(invoke).not.toHaveBeenCalledWith("local_workbuddy_update_connection", expect.anything());
  });

  it("identifies a backend without the connection sync endpoint", async () => {
    signedIn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "Not Found" }), { status: 404 })));

    await expect(syncWorkBuddyConnection()).rejects.toThrow("后台尚未部署模型连接同步接口");
    expect(invoke).not.toHaveBeenCalledWith("local_workbuddy_update_connection", expect.anything());
  });

  it("discards an old account response before applying the new account connection", async () => {
    const { values, token } = signedIn();
    let finishOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => { finishOld = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init) => {
      if (init.headers.Authorization === `Bearer ${token}`) return oldResponse;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data: { userId: 4, baseUrl: "https://new.example/v1", apiKey: "sk-new" } }), { status: 200 }));
    }));
    vi.mocked(invoke).mockResolvedValue({ models: [] });
    const oldSync = syncWorkBuddyConnection();
    const oldResult = oldSync.catch((error) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    values["workbuddy.client.session-token.v1"] = "new-token";
    values["workbuddy.client.user.v1"] = JSON.stringify({ id: 4 });
    const newSync = syncWorkBuddyConnection();
    finishOld(new Response(JSON.stringify({ ok: true, data: { userId: 3, baseUrl: "https://old.example/v1", apiKey: "sk-old" } }), { status: 200 }));
    expect(await oldResult).toBeInstanceOf(Error);
    await newSync;
    expect(invoke).toHaveBeenCalledWith("local_workbuddy_update_connection", { userId: 4, baseUrl: "https://new.example/v1", apiKey: "sk-new" });
    expect(invoke).not.toHaveBeenCalledWith("local_workbuddy_update_connection", { userId: 3, baseUrl: "https://old.example/v1", apiKey: "sk-old" });
  });

  it("clears the old connection after an in-flight write before applying a new account", async () => {
    const { values } = signedIn();
    let finishWrite!: (result: { models: [] }) => void;
    const oldWrite = new Promise<{ models: [] }>((resolve) => { finishWrite = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url, init) => {
      const newUser = init.headers.Authorization === "Bearer next-token";
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data: { userId: newUser ? 4 : 3, baseUrl: "https://models.example/v1", apiKey: newUser ? "sk-new" : "sk-old" } }), { status: 200 }));
    }));
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command === "local_workbuddy_update_connection" && (args as { userId?: number } | undefined)?.userId === 3) return oldWrite;
      return Promise.resolve({ models: [] });
    });
    const oldResult = syncWorkBuddyConnection().catch((error) => error);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("local_workbuddy_update_connection", expect.objectContaining({ userId: 3 })));
    values["workbuddy.client.session-token.v1"] = "next-token";
    values["workbuddy.client.user.v1"] = JSON.stringify({ id: 4 });
    const newSync = syncWorkBuddyConnection();
    finishWrite({ models: [] });
    await oldResult;
    await newSync;
    expect(vi.mocked(invoke).mock.calls.map(([command, args]) => [command, (args as { userId?: number } | undefined)?.userId])).toEqual([
      ["local_workbuddy_clear_connection", undefined], ["local_workbuddy_update_connection", 3],
      ["local_workbuddy_clear_connection", undefined], ["local_workbuddy_update_connection", 4],
    ]);
  });

  it("leaves old credentials cleared if the new connection request fails", async () => {
    signedIn();
    vi.mocked(invoke).mockResolvedValue({ models: [] });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(syncWorkBuddyConnection()).rejects.toThrow("offline");
    expect(invoke).toHaveBeenCalledWith("local_workbuddy_clear_connection");
    expect(invoke).not.toHaveBeenCalledWith("local_workbuddy_update_connection", expect.anything());
  });

  it("clears the managed connection on logout", async () => {
    const { values } = signedIn();
    vi.mocked(invoke).mockResolvedValue({ models: [] });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true, data: { userId: 3, baseUrl: "https://models.example/v1", apiKey: "sk-current" },
    }), { status: 200 })));
    await syncWorkBuddyConnection();
    vi.mocked(invoke).mockClear();
    delete values["workbuddy.client.session-token.v1"];
    delete values["workbuddy.client.user.v1"];

    await expect(syncWorkBuddyConnection()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith("local_workbuddy_clear_connection");
    expect(invoke).not.toHaveBeenCalledWith("local_workbuddy_update_connection", expect.anything());
  });
});
