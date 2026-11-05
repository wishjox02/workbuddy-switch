import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClientBalance } from "./sub2api";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("model service balance", () => {
  it("accepts a real zero balance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { balance: 0 } }), { status: 200 })));
    await expect(fetchClientBalance()).resolves.toMatchObject({ balance: 0 });
  });

  it("does not interpret a missing balance as zero", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })));
    await expect(fetchClientBalance()).rejects.toThrow("余额数据暂不可用");
  });
});
