import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchModelMarket } from "./model-market";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("model market", () => {
  it("loads the public catalog and excludes malformed prices", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://example.test/admin/api");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { items: [
      { id: 7, modelName: "Model A", shopName: "Store", price: 19.5, imageUrl: "https://example.test/a.png", linkUrl: "https://shop.example/item" },
      { id: 8, modelName: "Model B", storeName: "Store", price: -1 },
    ] } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchModelMarket()).resolves.toEqual([{ id: 7, modelName: "Model A", storeName: "Store", price: 19.5, imageUrl: "https://example.test/a.png", link: "https://shop.example/item", description: "" }]);
    expect(fetchMock).toHaveBeenCalledWith("https://example.test/admin/api/client/model-market", { cache: "no-store" });
  });

  it("never exposes executable URL schemes as links or images", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://example.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { items: [
      { id: 1, modelName: "Model", storeName: "Store", price: 0, imageUrl: "javascript:alert(1)", link: "file:///tmp/secret" },
    ] } }), { status: 200 })));
    await expect(fetchModelMarket()).resolves.toMatchObject([{ imageUrl: "", link: "" }]);
  });

  it("keeps an item without an optional shop name", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://example.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { items: [
      { id: 1, modelName: "Model", price: 0, linkUrl: "https://shop.example/item" },
    ] } }), { status: 200 })));
    await expect(fetchModelMarket()).resolves.toMatchObject([{ modelName: "Model", storeName: "", link: "https://shop.example/item" }]);
  });

  it("resolves uploaded images against the configured backend proxy path", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://example.test/admin/api");
    const filename = `${"a".repeat(32)}.png`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { items: [
      { id: 1, modelName: "Model", shopName: "Store", price: 10, imageUrl: `/api/client/model-market/images/${filename}` },
      { id: 2, modelName: "Bad", shopName: "Store", price: 10, imageUrl: "/api/client/model-market/images/../../other" },
    ] } }), { status: 200 })));
    await expect(fetchModelMarket()).resolves.toMatchObject([
      { imageUrl: `https://example.test/admin/api/client/model-market/images/${filename}` },
      { imageUrl: "" },
    ]);
  });
});
