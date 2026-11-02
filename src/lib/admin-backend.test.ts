import { afterEach, describe, expect, it, vi } from "vitest";

import { adminApiUrl, adminBackendUrl } from "./admin-backend";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("adminApiUrl", () => {
  it("uses the online API by default in development", () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "");

    expect(adminBackendUrl()).toBe("https://woai.info/admin/api");
  });

  it("migrates the old saved woai.info root address", () => {
    vi.stubEnv("VITE_WB_ADMIN_URL", "");
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => "http://woai.info",
      },
    });

    expect(adminBackendUrl()).toBe("https://woai.info/admin/api");
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
});
