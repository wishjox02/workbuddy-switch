import { afterEach, describe, expect, it, vi } from "vitest";

import { adminApiUrl, adminBackendUrl, saveAdminBackendUrl, serviceDisplayText, validateAdminBackendUrl } from "./admin-backend";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("adminApiUrl", () => {
  it("removes service identifiers from displayed errors", () => {
    expect(serviceDisplayText("Sub2API 请求 https://woai.info/admin/api/client/models 失败"))
      .toBe("模型服务 请求 更新服务 失败");
    expect(serviceDisplayText("WOAI.INFO 返回错误")).toBe("更新服务 返回错误");
    expect(serviceDisplayText("error sending request for url (https://example.test/api/releases)"))
      .toBe("更新服务请求失败");
  });
  it("uses the online API by default in development", () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "");

    expect(adminBackendUrl()).toBe("https://admin.woai.info/api");
  });

  it("migrates the old saved woai.info root address", () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "");
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => "http://woai.info",
      },
    });

    expect(adminBackendUrl()).toBe("https://admin.woai.info/api");
  });

  it("adds the API route prefix to a domain root", () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://admin.example.test");

    expect(adminApiUrl("/client/auth/sms/send")).toBe("https://admin.example.test/api/client/auth/sms/send");
  });

  it("preserves a reverse-proxy prefix", () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin");

    expect(adminApiUrl("/client/auth/sms/send")).toBe("https://woai.info/admin/api/client/auth/sms/send");
  });

  it("does not duplicate /api when the configured value is already an API root", () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "https://woai.info/admin/api/");

    expect(adminApiUrl("/api/client/auth/sms/send")).toBe("https://woai.info/admin/api/client/auth/sms/send");
  });

  it("requires HTTPS for remote backends but permits loopback development URLs", () => {
    expect(() => validateAdminBackendUrl("http://example.test/admin/api")).toThrow("HTTPS");
    expect(validateAdminBackendUrl("http://127.0.0.1:57900")).toBe("http://127.0.0.1:57900");
    expect(() => validateAdminBackendUrl("https://user:pass@example.test/api")).toThrow("账号");
  });

  it("clears the old client session when switching backend origins", () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "");
    const values = new Map<string, string>([
      ["workbuddy.admin-backend-url.v1", "https://old.example/api"],
      ["workbuddy.client.session-token.v1", "old-token"],
      ["workbuddy.client.user.v1", JSON.stringify({ id: 1 })],
    ]);
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
      dispatchEvent,
    });

    expect(saveAdminBackendUrl("https://new.example/api")).toBe("https://new.example/api");
    expect(values.has("workbuddy.client.session-token.v1")).toBe(false);
    expect(values.has("workbuddy.client.user.v1")).toBe(false);
    expect(dispatchEvent).toHaveBeenCalled();
  });
});
