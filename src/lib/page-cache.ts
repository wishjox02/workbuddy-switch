import { adminBackendUrl } from "@/lib/admin-backend";
import { readClientToken } from "@/lib/auth";

// In-memory only: never persist account data, credentials, or stale prices to disk.
let identity = "";
const entries = new Map<string, unknown>();

function currentIdentity(): string {
  return JSON.stringify([adminBackendUrl(), readClientToken()]);
}

function synchronizeIdentity(): void {
  const next = currentIdentity();
  if (identity !== next) { entries.clear(); identity = next; }
}

export function readPageCache<T>(key: string): T | undefined {
  synchronizeIdentity();
  return entries.get(key) as T | undefined;
}

export function writePageCache<T>(key: string, value: T, expectedIdentity: string): void {
  synchronizeIdentity();
  if (identity === expectedIdentity) entries.set(key, value);
}

export function pageCacheIdentity(): string {
  synchronizeIdentity();
  return identity;
}
