import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { BrowserRouter, HashRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ArrowUp, BarChart3, Boxes, Gift, Headphones, LogIn, LogOut, Megaphone, RefreshCw, Settings2, ShoppingBag, Sparkles, UserRound, Wallet, X } from "lucide-react";

import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import AccountsPage from "@/pages/AccountsPage";
import CreditStatsPage from "@/pages/CreditStatsPage";
import TokenStatsPage from "@/pages/TokenStatsPage";
import SettingsPage from "@/pages/SettingsPage";
import ModelsPage from "@/pages/ModelsPage";
import ModelMarketPage from "@/pages/ModelMarketPage";
import RechargePage from "@/pages/RechargePage";
import RedeemPage from "@/pages/RedeemPage";
import CustomerServicePage from "@/pages/CustomerServicePage";
import { CustomModelUsageTab } from "@/components/custom-model-usage-tab";
import { AppIconMark } from "@/components/product-marks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { demoModeEnabled, pagesDemoHostingEnabled } from "@/lib/demo-mode";
import { useUpdateState } from "@/lib/use-update-state";
import { useWorkbuddyStatusRefresh } from "@/lib/use-workbuddy-status-refresh";
import { sendTelemetryEvent, sendTelemetryLaunch } from "@/lib/telemetry";
import { UpdateInstallDialog } from "@/components/update-install-dialog";
import { ClientLoginDialog } from "@/components/client-login-dialog";
import { authChangedEvent, logoutClient, readClientToken, readClientUser, refreshClientUser, type ClientUser } from "@/lib/auth";
import { adminApiUrl } from "@/lib/admin-backend";
import { fetchDshModels, isStaleModelConnectionError, syncWorkBuddyConnection } from "@/lib/sub2api";
import { useModelBalance } from "@/lib/use-model-balance";
import type { CreditExpiry } from "@/lib/types";
import { useAccountsStore } from "@/stores/accounts";

function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function creditValue(credit: CreditExpiry | undefined): number | null {
  if (!credit?.ok) return 0;
  if (credit.unlimited) return null;
  if (typeof credit.totalRemaining === "number") return credit.totalRemaining;
  return (credit.resources ?? []).reduce((sum, resource) => sum + (resource.remaining || 0), 0);
}

function TotalCreditBar() {
  const accounts = useAccountsStore((state) => state.accounts);
  const creditMap = useAccountsStore((state) => state.creditMap);
  const ensureCredits = useAccountsStore((state) => state.ensureCredits);
  const fetchAll = useAccountsStore((state) => state.fetchAll);
  const [announcement, setAnnouncement] = useState("");
  const { balance, loading: balanceLoading } = useModelBalance();
  const navigate = useNavigate();

  useEffect(() => {
    if (accounts.length === 0) void fetchAll();
  }, [accounts.length, fetchAll]);

  useEffect(() => {
    if (accounts.length === 0) return;
    void ensureCredits(accounts.map((account) => account.id));
  }, [accounts, ensureCredits]);

  // 顶部公告：后台保存后无需重启客户端，重新聚焦或轮询即可看到最新状态。
  useEffect(() => {
    let cancelled = false;
    const loadAnnouncement = async () => {
      try {
        const response = await fetch(adminApiUrl("/client/announcement"), { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (cancelled || !response.ok || !payload || payload.ok === false) return;
        setAnnouncement(String(payload.data?.announcement || "").trim());
      } catch {
        // 公告不可用不影响账号和模型功能。
      }
    };
    void loadAnnouncement();
    const timer = window.setInterval(() => void loadAnnouncement(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const total = useMemo(() => {
    let amount = 0;
    let hasUnlimited = false;
    let loaded = 0;
    for (const account of accounts) {
      const value = creditValue(creditMap[account.id]);
      if (creditMap[account.id]?.ok) loaded += 1;
      if (value === null) hasUnlimited = true;
      else amount += value;
    }
    return { amount, hasUnlimited, loaded };
  }, [accounts, creditMap]);

  const totalLabel = total.hasUnlimited
    ? "不限量"
    : total.loaded === 0 && accounts.length > 0
      ? "暂不可用"
      : formatCredits(total.amount);

  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-card/95 px-3 py-3 backdrop-blur sm:px-8">
      <div className="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="hidden size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary sm:flex">
            <Sparkles className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5 whitespace-nowrap sm:gap-2">
              <span className="text-xs font-medium text-foreground sm:text-sm">积分</span>
              <strong className="truncate text-base font-semibold tabular-nums text-foreground sm:text-xl">{totalLabel}</strong>
              <span className="hidden text-xs text-muted-foreground sm:inline">{accounts.length} 个账号</span>
              {total.loaded > 0 && total.loaded < accounts.length && <span className="hidden text-xs text-muted-foreground sm:inline">部分账号未同步</span>}
            </div>
            {announcement && (
              <div className="mt-2 flex max-w-[min(64vw,680px)] items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs text-foreground" role="status" title={announcement}>
                <Megaphone className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span className="line-clamp-2 break-words">{announcement}</span>
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => navigate("/models")} className="rounded-lg border border-border bg-background px-3 py-2 text-left text-xs text-foreground" title="查看模型服务余额">
            <span className="font-semibold">余额 {balanceLoading ? "加载中…" : balance === null ? "—" : `¥${balance.toFixed(2)}`}</span>
          </button>
          <Button type="button" className="rounded-xl bg-primary px-3.5 text-primary-foreground shadow-sm shadow-primary/20 hover:bg-primary/90" onClick={() => navigate("/recharge")}>
            <Wallet />充值
          </Button>
        </div>
      </div>
    </header>
  );
}

function UpdateCenter() {
  const snapshot = useUpdateState();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState(() => {
    if (typeof window === "undefined") return "";
    try { return window.localStorage.getItem("workbuddy.update-dismissed-version.v1") || ""; } catch { return ""; }
  });
  const availableVersion = snapshot.phase === "available" ? snapshot.latest : null;
  const showAvailableNotice = Boolean(availableVersion && availableVersion !== dismissedVersion);
  return (
    <>
      <section className="update-center mt-auto px-1 text-xs">
        {showAvailableNotice && (
          <div className="relative mb-2 rounded-xl border border-primary/35 bg-primary/10 px-3 py-2.5 text-sidebar-foreground shadow-sm">
            <button
              type="button"
              className="absolute right-1.5 top-1.5 rounded-md p-1 text-sidebar-foreground/55 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              onClick={() => {
                if (!availableVersion) return;
                setDismissedVersion(availableVersion);
                try { window.localStorage.setItem("workbuddy.update-dismissed-version.v1", availableVersion); } catch { /* ignore storage errors */ }
              }}
              aria-label="关闭新版本提醒"
              title="关闭新版本提醒"
            >
              <X className="size-3.5" />
            </button>
            <div className="pr-5 font-semibold text-primary">发现新版本 v{availableVersion}</div>
            <div className="mt-1 text-[11px] leading-4 text-sidebar-foreground/70">更新客户端以获取最新功能和修复。</div>
            <Button type="button" size="sm" className="mt-2 h-7 w-full text-xs" onClick={() => setDialogOpen(true)}>
              <ArrowUp className="size-3.5" />查看更新
            </Button>
          </div>
        )}
      </section>
      <UpdateInstallDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}

function PersonalCenter() {
  const [user, setUser] = useState<ClientUser | null>(() => readClientUser());
  const [loginOpen, setLoginOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sync = () => setUser(readClientUser());
    const openLogin = () => setLoginOpen(true);
    window.addEventListener(authChangedEvent(), sync);
    window.addEventListener("open-client-login", openLogin);
    return () => { window.removeEventListener(authChangedEvent(), sync); window.removeEventListener("open-client-login", openLogin); };
  }, []);

  useEffect(() => {
    const refresh = () => { void refreshClientUser().catch(() => undefined); };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, []);

  async function logout() {
    setBusy(true);
    await logoutClient();
    setUser(null);
    setBusy(false);
    toast.success("已退出登录");
  }

  return (
    <>
      <section className="personal-center mb-3 rounded-xl border border-sidebar-border bg-sidebar-accent/45 p-2.5">
        {user ? (
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">{user.phone.slice(-2)}</div>
            <div className="personal-center-details min-w-0 flex-1">
              <div className="personal-center-heading truncate text-xs font-semibold">个人中心</div>
              <div className="personal-center-phone truncate text-[11px] text-sidebar-foreground/60">{user.phone}</div>
              <div className="personal-center-id break-all text-[11px] text-sidebar-foreground/60">用户ID: {user.sub2apiAccountId || "未同步"}</div>
            </div>
            <Button type="button" variant="ghost" size="icon" className="size-7 rounded-lg text-sidebar-foreground/65 hover:text-sidebar-foreground" onClick={() => void logout()} disabled={busy} aria-label="退出登录" title="退出登录"><LogOut className="size-3.5" /></Button>
          </div>
        ) : (
          <button type="button" className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1 text-left text-sidebar-foreground/75 hover:text-sidebar-foreground" onClick={() => setLoginOpen(true)}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-sidebar-primary-foreground"><LogIn className="size-4" /></span>
            <span><span className="block text-xs font-semibold">登录个人中心</span><span className="block text-[11px] text-sidebar-foreground/60">手机号验证码登录</span></span>
          </button>
        )}
      </section>
      <ClientLoginDialog open={loginOpen} onOpenChange={setLoginOpen} onLoggedIn={setUser} />
    </>
  );
}

function ClientAuthGate({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState(() => Boolean(readClientToken()));
  const [loginOpen, setLoginOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const sync = () => setAuthenticated(Boolean(readClientToken()));
    window.addEventListener(authChangedEvent(), sync);
    return () => window.removeEventListener(authChangedEvent(), sync);
  }, []);

  useEffect(() => {
    if (demoModeEnabled || authenticated) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(adminApiUrl("/client/announcement"), { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!cancelled && response.ok && payload?.ok !== false) setAnnouncement(String(payload?.data?.announcement || "").trim());
      } catch { /* 公告不可用不阻断登录 */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [authenticated]);

  if (demoModeEnabled || authenticated) return <>{children}</>;
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-5 py-10">
      <div className="w-full max-w-sm space-y-5 text-center">
        <AppIconMark size={64} className="mx-auto" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">登录小玉米</h1>
          <p className="mt-2 text-sm text-muted-foreground">登录后才能访问账号、模型、余额和统计功能。</p>
        </div>
        {announcement && <p className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-left text-sm text-foreground"><Megaphone className="mt-0.5 size-4 shrink-0 text-primary" /><span>{announcement}</span></p>}
        <Button type="button" size="lg" className="w-full" onClick={() => setLoginOpen(true)}>
          <LogIn />登录个人中心
        </Button>
        <ClientLoginDialog open={loginOpen} onOpenChange={setLoginOpen} onLoggedIn={() => setAuthenticated(true)} />
      </div>
    </div>
  );
}

function ModelUsagePage() {
  const [reload, setReload] = useState(0);
  return <div className="wb-page mx-auto w-full max-w-[1180px] min-w-0 px-4 py-7 sm:px-8 sm:py-10">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-[28px] font-semibold">模型使用记录</h1><p className="mt-2 text-sm text-muted-foreground">查看小玉米模型的 Token 用量与消费明细。</p></div>
      <Button variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}><RefreshCw />刷新记录</Button>
    </header>
    <CustomModelUsageTab reload={reload} />
  </div>;
}

function Layout() {
  const accounts = useAccountsStore((state) => state.accounts);
  const accountsLoading = useAccountsStore((state) => state.loading);
  const navigate = useNavigate();
  const location = useLocation();
  const hasUnifiedTitleBar = api.isDesktop() && typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
  useWorkbuddyStatusRefresh();

  useEffect(() => {
    if (!api.isDesktop()) return;
    let lastToken = readClientToken();
    let lastUserId = readClientUser()?.id ?? null;
    const syncConnection = (notify = false) => {
      const token = readClientToken();
      if (notify) {
        void fetchDshModels().then((models) => {
          if (token === readClientToken() && models.some((model) => model.managed)) {
            toast.warning("DeepSeek Harness 使用独立的 API Key。切换账号后请先核对并更新其密钥；若启动环境中存在旧密钥，需要退出并重新启动 Harness。", { duration: 15000 });
          }
        }).catch(() => {});
      }
      void syncWorkBuddyConnection()
        .then(() => {
          if (notify && token === readClientToken()) toast.info("账号已切换，请重启 WorkBuddy 以确保模型连接生效。");
        })
        .catch((error) => {
          if (token !== readClientToken() || isStaleModelConnectionError(error)) return;
          toast.warning(`模型连接${token ? "未更新" : "未清除"}：${error instanceof Error ? error.message : String(error)}。请暂停使用托管模型并检查 WorkBuddy 连接。`);
        });
    };
    syncConnection();
    const onAuthChanged = () => {
      const token = readClientToken();
      const userId = readClientUser()?.id ?? null;
      const changed = token !== lastToken || userId !== lastUserId;
      lastToken = token; lastUserId = userId;
      if (changed) syncConnection(true);
    };
    window.addEventListener(authChangedEvent(), onAuthChanged);
    return () => window.removeEventListener(authChangedEvent(), onAuthChanged);
  }, []);

  useEffect(() => {
    if (!accountsLoading) sendTelemetryLaunch(accounts.length);
  }, [accountsLoading]);

  useEffect(() => {
    if (!accountsLoading) sendTelemetryEvent(accounts.length, `page:${location.pathname}`);
  }, [accountsLoading, accounts.length, location.pathname]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        navigate("/models");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const navGroups = [
    { title: "WorkBuddy", items: [
      { to: "/", label: "账号管理", icon: UserRound, end: true },
      { to: "/credit-stats", label: "积分统计", icon: Sparkles },
      { to: "/token-stats", label: "Token 统计", icon: BarChart3 },
    ] },
    { title: "小玉米模型服务", items: [
      { to: "/models", label: "模型与启用", icon: Boxes },
      { to: "/model-market", label: "模型广场", icon: ShoppingBag },
      { to: "/recharge", label: "余额与充值", icon: Wallet },
      { to: "/redeem", label: "CDKY兑换", icon: Gift },
      { to: "/model-usage", label: "使用记录", icon: BarChart3 },
    ] },
    { title: "", items: [{ to: "/settings", label: "设置", icon: Settings2 }, { to: "/customer-service", label: "客服", icon: Headphones }] },
  ];

  return (
    <div className="wb-app-shell flex h-screen min-h-0 overflow-hidden bg-background">
      {hasUnifiedTitleBar ? <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-50 h-8" aria-hidden="true" /> : null}
      <aside className={cn("flex min-h-0 w-[248px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 pb-4 text-sidebar-foreground", hasUnifiedTitleBar ? "pt-20" : "pt-5")}>
        <div className="mb-8 flex items-center gap-3 px-2">
          <AppIconMark size={38} className="drop-shadow-sm" />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold tracking-tight">小玉米</div>
            <div className="mt-0.5 text-[11px] text-sidebar-foreground/55">账号与模型工作台</div>
            {demoModeEnabled && <Badge variant="secondary" className="mt-1 h-5 border-0 px-1.5 text-[10px]">演示模式</Badge>}
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="主导航">
          {navGroups.map((group) => <div key={group.title || "settings"} className="mb-2">{group.title && <div className="mb-1 px-3 pt-1 text-[11px] font-semibold text-sidebar-foreground/50">{group.title}</div>}
          {group.items.map(({ to, label, icon: Icon, ...options }) => (
            <NavLink
              key={to}
              to={to}
              end={"end" in options && options.end === true}
              className={({ isActive }) => cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm" : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}</div>)}
        </nav>
        {api.isWebui() && !demoModeEnabled ? null : <UpdateCenter />}
        <PersonalCenter />
      </aside>
      <main className={cn("min-w-0 flex-1 overflow-y-auto bg-muted/25 overscroll-contain", hasUnifiedTitleBar && "pt-16")}>
        <TotalCreditBar />
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  const Router = pagesDemoHostingEnabled ? HashRouter : BrowserRouter;
  return (
    <TooltipProvider delayDuration={250}>
      <Router>
        <Routes>
          <Route element={<ClientAuthGate><Layout /></ClientAuthGate>}>
            <Route path="/" element={<AccountsPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/model-market" element={<ModelMarketPage />} />
            <Route path="/recharge" element={<RechargePage />} />
            <Route path="/redeem" element={<RedeemPage />} />
            <Route path="/model-usage" element={<ModelUsagePage />} />
            <Route path="/credit-stats" element={<CreditStatsPage />} />
            <Route path="/token-stats" element={<TokenStatsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/customer-service" element={<CustomerServicePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <Toaster />
      </Router>
    </TooltipProvider>
  );
}
