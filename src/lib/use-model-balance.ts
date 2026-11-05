import { useEffect, useState } from "react";
import { authChangedEvent, readClientToken } from "@/lib/auth";
import { fetchClientBalance } from "@/lib/sub2api";

export const MODEL_BALANCE_CHANGED = "model-balance-changed";

export function useModelBalance() {
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let generation = 0;
    let disposed = false;
    const load = async () => {
      const current = ++generation;
      const token = readClientToken();
      setBalance(null);
      if (!token) { setLoading(false); return; }
      setLoading(true);
      try {
        const result = await fetchClientBalance();
        if (!disposed && generation === current && token === readClientToken()) setBalance(result.balance);
      } catch {
        if (!disposed && generation === current) setBalance(null);
      } finally {
        if (!disposed && generation === current) setLoading(false);
      }
    };
    void load();
    window.addEventListener(authChangedEvent(), load);
    window.addEventListener(MODEL_BALANCE_CHANGED, load);
    return () => { disposed = true; window.removeEventListener(authChangedEvent(), load); window.removeEventListener(MODEL_BALANCE_CHANGED, load); };
  }, []);
  return { balance, loading };
}
