import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchLoginCaptcha, sendLoginCode } from "./auth";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendLoginCode", () => {
  it("requests the verification code from the configured admin API", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { challengeId: "challenge-1", phoneMasked: "138****8000", expiresIn: 300 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendLoginCode("13800138000");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://woai.info/admin/api/client/auth/sms/send",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify({ phone: "13800138000" }));
  });

  it("reports the endpoint when the verification backend cannot be reached", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(sendLoginCode("13800138000")).rejects.toThrow(
      "无法连接验证码后台（https://woai.info/admin/api/client/auth/sms/send）",
    );
  });

  it("includes the numeric challenge answer when requesting an SMS code", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { challengeId: "sms-1", phoneMasked: "138****8000", expiresIn: 300 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendLoginCode("13800138000", { captchaId: "captcha-1", captchaAnswer: "106" });

    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify({ phone: "13800138000", captchaId: "captcha-1", captchaAnswer: "106" }));
  });
});

describe("fetchLoginCaptcha", () => {
  it("loads the numeric challenge from the admin backend", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    const captcha = { captchaId: "captcha-1", question: "46 + 60 = ?", expiresIn: 300, maxAttempts: 5 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: captcha }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLoginCaptcha()).resolves.toEqual(captcha);
    expect(fetchMock).toHaveBeenCalledWith("https://woai.info/admin/api/client/auth/captcha", { cache: "no-store" });
  });

  it("accepts an image challenge from the updated backend", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    const captcha = { captchaId: "image-1", imageDataUrl: "data:image/png;base64,aGVsbG8=", expiresIn: 300, maxAttempts: 5 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: captcha }), { status: 200 })));

    await expect(fetchLoginCaptcha()).resolves.toEqual(captcha);
  });

  it("keeps compatibility with local backends that do not have numeric challenges", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "http://127.0.0.1:57900");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    await expect(fetchLoginCaptcha()).resolves.toBeNull();
  });
});
