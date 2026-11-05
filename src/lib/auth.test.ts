import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchLoginCaptcha, loginWithCode, logoutClient, readClientToken, readClientUser, refreshClientUser, sendLoginCode, writeClientAuth, type ClientUser } from "./auth";

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

  it("does not expose the endpoint when the verification backend cannot be reached", async () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(sendLoginCode("13800138000")).rejects.toThrow(
      "无法连接验证码服务，请检查网络或稍后重试",
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
  it("provides a readable message when the login service cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(fetchLoginCaptcha()).rejects.toThrow("无法连接登录服务，请检查网络或稍后重试");
  });
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

describe("account changes during authentication", () => {
  const user = (id: number): ClientUser => ({ id, phone: String(id), displayName: String(id), status: "active", createdAt: 0 });
  function setupStorage() {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  }
  const loginResponse = (id: number) => new Response(JSON.stringify({ ok: true, data: { sessionToken: `token-${id}`, user: user(id) } }), { status: 200 });
  const meResponse = (value: ClientUser) => new Response(JSON.stringify({ ok: true, data: { user: value } }), { status: 200 });

  it("refreshes the remote account ID while preserving login sync details", async () => {
    setupStorage();
    const sync = { synced: true };
    writeClientAuth("token-1", { ...user(1), sub2apiSync: sync });
    const fetchMock = vi.fn().mockResolvedValue(meResponse({ ...user(1), sub2apiAccountId: "42" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(refreshClientUser()).resolves.toMatchObject({ sub2apiAccountId: "42", sub2apiSync: sync });
    expect(readClientUser()?.sub2apiAccountId).toBe("42");
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/client/auth/me"), expect.objectContaining({ headers: { Authorization: "Bearer token-1" } }));
  });

  it("ignores an old refresh after an account switch", async () => {
    setupStorage();
    let resolveOld!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveOld = resolve; })));
    writeClientAuth("token-1", user(1));
    const old = refreshClientUser();
    writeClientAuth("token-2", user(2));
    resolveOld(meResponse({ ...user(1), sub2apiAccountId: "42" }));
    await expect(old).resolves.toBeNull();
    expect(readClientUser()?.id).toBe(2);
  });

  it("ignores an older refresh that completes after a newer refresh", async () => {
    setupStorage();
    let resolveOld!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(meResponse({ ...user(1), sub2apiAccountId: "new" })));
    writeClientAuth("token-1", user(1));
    const old = refreshClientUser();
    await refreshClientUser();
    resolveOld(meResponse({ ...user(1), sub2apiAccountId: "old" }));
    await expect(old).resolves.toBeNull();
    expect(readClientUser()?.sub2apiAccountId).toBe("new");
  });

  it("does not clear a new login when an older logout finishes", async () => {
    setupStorage();
    let resolveLogout!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveLogout = resolve; })));
    writeClientAuth("token-1", user(1));
    const logout = logoutClient();
    expect(readClientToken()).toBe("");
    writeClientAuth("token-2", user(2));
    resolveLogout(new Response(null, { status: 200 }));
    await logout;
    expect(readClientToken()).toBe("token-2");
  });

  it("ignores a previous login response after a newer login", async () => {
    setupStorage();
    let resolveOld!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(loginResponse(2));
    vi.stubGlobal("fetch", fetchMock);
    const old = loginWithCode("1", "challenge-1", "123456");
    await loginWithCode("2", "challenge-2", "123456");
    resolveOld(loginResponse(1));
    await expect(old).rejects.toThrow("账号已切换");
    expect(readClientToken()).toBe("token-2");
  });

  it("does not save a cancelled login even if the server responds", async () => {
    setupStorage();
    let resolveLogin!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveLogin = resolve; })));
    const controller = new AbortController();
    const login = loginWithCode("1", "challenge-1", "123456", controller.signal);
    controller.abort();
    resolveLogin(loginResponse(1));
    await expect(login).rejects.toThrow("登录请求已取消");
    expect(readClientToken()).toBe("");
  });
});
