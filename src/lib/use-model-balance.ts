import { useEffect, useState } from "react";
import { authChangedEvent, readClientToken } from "@/lib/auth";
import { fetchClientBalance } from "@/lib/sub2api";
import { pageCacheIdentity, readPageCache, writePageCache } from "@/lib/page-cache";

export const MODEL_BALANCE_CHANGED = "model-balance-changed";

export function useModelBalance() {
  const [balance, setBalance] = useState<number | null>(() => readPageCache<number>("model-balance") ?? null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let generation = 0;
    let disposed = false;
    let currentToken = readClientToken();
    let hasBalance = readPageCache<number>("model-balance") !== undefined;
    const load = async () => {
      const current = ++generation;
      const token = readClientToken();
      const identity = pageCacheIdentity();
      if (token !== currentToken) {
        currentToken = token;
        hasBalance = false;
        setBalance(null);
      }
      if (!token) { setBalance(null); setLoading(false); return; }
      if (!hasBalance) setLoading(true);
      try {
        const result = await fetchClientBalance();
        if (!disposed && generation === current && token === readClientToken()) {
          hasBalance = true;
          writePageCache("model-balance", result.balance, identity);
          setBalance(result.balance);
        }
      } catch {
        if (!disposed && generation === current && !hasBalance) setBalance(null);
      } finally {
        if (!disposed && generation === current) setLoading(false);
      }
    };
    const onAuthChanged = () => {
      if (readClientToken() !== currentToken) void load();
    };
    void load();
    // Keep the header balance aligned with the same low-frequency background
    // cadence used by the update checker.
    const timer = window.setInterval(() => void load(), 30_000);
    window.addEventListener(authChangedEvent(), onAuthChanged);
    window.addEventListener(MODEL_BALANCE_CHANGED, load);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener(authChangedEvent(), onAuthChanged); window.removeEventListener(MODEL_BALANCE_CHANGED, load); };
  }, []);
  return { balance, loading };
}
