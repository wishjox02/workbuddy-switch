import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchCustomModelUsage } from "./sub2api";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fetchCustomModelUsage", () => {
  it("normalizes snake_case usage records and stats from older backends", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    vi.stubGlobal("window", { localStorage: { getItem: () => "user-session" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {
      records: [{ id: 1, model: "cn:glm", prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, actual_cost: 0.125, created_at: "2026-11-04T10:00:00Z", status_code: 200 }],
      total: 1, page: 1, page_size: 50, stats: { total_requests: 1, total_input_tokens: 120, total_output_tokens: 30, total_tokens: 150, total_actual_cost: 0.125 }, exchangeRate: 7.2,
    } }), { status: 200 })));

    await expect(fetchCustomModelUsage({ page: 1, pageSize: 50 })).resolves.toMatchObject({
      summary: { requests: 1, inputTokens: 120, outputTokens: 30, totalTokens: 150, costCny: 0.125 },
      records: [{ inputTokens: 120, outputTokens: 30, totalTokens: 150, costCny: 0.125, statusCode: 200 }],
    });
  });

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
