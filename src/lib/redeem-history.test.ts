import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRedeemHistory } from "./sub2api";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("兑换记录", () => {
  it("requests the current account's paginated history and normalizes it", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://example.test/admin/api");
    vi.stubGlobal("window", { localStorage: { getItem: () => "session" } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { items: [{ id: 1, code: "CODE-1234", type: "balance", value: 12, used_at: "2026-11-06T12:00:00Z" }], total: 22, page: 2, page_size: 20 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchRedeemHistory(2)).resolves.toEqual({ items: [{ id: 1, code: "CODE-1234", type: "balance", value: 12, usedAt: "2026-11-06T12:00:00Z" }], total: 22, page: 2, pageSize: 20 });
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/admin/api/client/redeem/history?page=2&page_size=20", { cache: "no-store", headers: { Authorization: "Bearer session" } });
  });

  it("surfaces backend failures rather than showing an empty history", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://example.test/admin/api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "上游不可用" }), { status: 502 })));
    await expect(fetchRedeemHistory()).rejects.toThrow("上游不可用");
  });
});
