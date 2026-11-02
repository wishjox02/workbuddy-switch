import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCustomModelUsage } from "./sub2api";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fetchCustomModelUsage", () => {
  it("queries the Python backend for the signed-in user's model usage", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => key === "workbuddy.client.session-token.v1" ? "user-session" : null } });
    const data = { records: [], total: 0, page: 1, pageSize: 50, summary: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costCny: 0 }, exchangeRate: 7.2 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCustomModelUsage({ page: 1, pageSize: 50, model: "cn:glm" })).resolves.toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://woai.info/admin/api/client/tokens/usage?page=1&pageSize=50&model=cn%3Aglm",
      { cache: "no-store", headers: { Authorization: "Bearer user-session" } },
    );
  });

  it("identifies a backend that has not deployed the client usage endpoint", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "Not Found" }), { status: 404 })));

    await expect(fetchCustomModelUsage({ page: 1, pageSize: 50 })).rejects.toThrow("后台尚未部署自定义模型用量接口");
  });
});
