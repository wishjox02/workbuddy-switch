import { beforeEach, describe, expect, it, vi } from "vitest";

let token = "alice";
let backend = "https://example.test";
vi.mock("@/lib/auth", () => ({ readClientToken: () => token }));
vi.mock("@/lib/admin-backend", () => ({ adminBackendUrl: () => backend }));

import { pageCacheIdentity, readPageCache, writePageCache } from "./page-cache";

describe("page cache", () => {
  beforeEach(() => { token = "alice"; backend = "https://example.test"; pageCacheIdentity(); });

  it("isolates cached data by account and refuses late writes", () => {
    const identity = pageCacheIdentity();
    writePageCache("orders", [1], identity);
    expect(readPageCache("orders")).toEqual([1]);
    token = "bob";
    expect(readPageCache("orders")).toBeUndefined();
    writePageCache("orders", [2], identity);
    expect(readPageCache("orders")).toBeUndefined();
  });

  it("clears cached data after changing backend", () => {
    writePageCache("config", { enabled: true }, pageCacheIdentity());
    backend = "https://other.test";
    expect(readPageCache("config")).toBeUndefined();
  });
});
