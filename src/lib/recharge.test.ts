import { afterEach, describe, expect, it, vi } from "vitest";

import { createRechargeOrder, fetchRechargeConfig, rechargePaymentTargets, rechargeStatusState } from "./sub2api";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("recharge activities", () => {
  it("reads the bonus and credited amount from the backend", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { enabled: true, activities: [{ id: 7, amount: 10, bonus: 10, credited: 20, label: "限时赠送", enabled: true }] },
    }), { status: 200 })));

    await expect(fetchRechargeConfig()).resolves.toMatchObject({
      enabled: true,
      activities: [{ id: 7, amount: 10, bonus: 10, credited: 20, label: "限时赠送" }],
    });
  });

  it("sends the selected activity ID when creating an order", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { order: { id: 1, amount: 10, bonus: 10, credited: 20 }, payUrl: null, qrcode: null },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await createRechargeOrder(10, "alipay", 7);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://woai.info/admin/api/client/recharge/create",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ amount: 10, type: "alipay", activityId: 7 });
  });

  it("does not interpret legacy points as a RMB gift", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { enabled: true, plans: [{ id: 1, amount: 10, credits: 1000 }] },
    }), { status: 200 })));

    await expect(fetchRechargeConfig()).resolves.toEqual({ enabled: true, activities: [] });
  });

  it("supports the deployed plans response when balance is a RMB amount", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { enabled: true, plans: [{ id: 1, amount: 10, balance: 12, credits: 12, enabled: true }, { id: 2, amount: 30, balance: 38, credits: 38, enabled: true }, { id: 3, amount: 50, balance: 50, credits: 50, enabled: true }] },
    }), { status: 200 })));

    await expect(fetchRechargeConfig()).resolves.toMatchObject({
      enabled: true,
      activities: [
        { id: 1, amount: 10, bonus: 2, credited: 12 },
        { id: 2, amount: 30, bonus: 8, credited: 38 },
        { id: 3, amount: 50, bonus: 0, credited: 50 },
      ],
    });
  });
});

describe("recharge payment targets", () => {
  it("keeps a native QR code from an older backend that duplicated it as payUrl", () => {
    expect(rechargePaymentTargets({
      payUrl: "weixin://wxpay/bizpayurl?pr=example",
      qrcode: "weixin://wxpay/bizpayurl?pr=example",
      urlScheme: null,
    })).toEqual({ qrValue: "weixin://wxpay/bizpayurl?pr=example", fallbackUrl: null });
  });

  it("uses checkout links only as a fallback page", () => {
    expect(rechargePaymentTargets({
      payUrl: "https://payment.example/checkout/order-1",
      qrcode: null,
      urlScheme: null,
    })).toEqual({ qrValue: null, fallbackUrl: "https://payment.example/checkout/order-1" });
  });
});

describe("recharge order status", () => {
  it("distinguishes payment confirmation from a credited balance", () => {
    expect(rechargeStatusState("Pending")).toBe("other");
    expect(rechargeStatusState("Failed")).toBe("other");
    expect(rechargeStatusState("Paid")).toBe("paid");
    expect(rechargeStatusState("Credited")).toBe("credited");
  });
});
