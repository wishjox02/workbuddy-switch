import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { BrowserRouter, HashRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ArrowUp, BarChart3, Boxes, Loader2, LogIn, LogOut, Megaphone, Settings2, Sparkles, UserRound, Wallet } from "lucide-react";

import { cn } from "@/lib/utils";
import * as api from "@/lib/api";
import AccountsPage from "@/pages/AccountsPage";
import CreditStatsPage from "@/pages/CreditStatsPage";
import TokenStatsPage from "@/pages/TokenStatsPage";
import SettingsPage from "@/pages/SettingsPage";
import ModelsPage from "@/pages/ModelsPage";
import RechargePage from "@/pages/RechargePage";
import { StatusDot, AppIconMark } from "@/components/product-marks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { demoModeEnabled, pagesDemoHostingEnabled } from "@/lib/demo-mode";
import { useCreditAutoRefresh } from "@/lib/use-credit-auto-refresh";
import { useUpdateState } from "@/lib/use-update-state";
import { useWorkbuddyStatusRefresh } from "@/lib/use-workbuddy-status-refresh";
import { sendTelemetryEvent, sendTelemetryLaunch } from "@/lib/telemetry";
import { UpdateInstallDialog } from "@/components/update-install-dialog";
import { ClientLoginDialog } from "@/components/client-login-dialog";
import { authChangedEvent, logoutClient, readClientToken, readClientUser, type ClientUser } from "@/lib/auth";
import { adminApiUrl } from "@/lib/admin-backend";
import { fetchClientBalance, syncWorkBuddyConnection } from "@/lib/sub2api";
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
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (accounts.length === 0) void fetchAll();
  }, [accounts.length, fetchAll]);

  useEffect(() => {
    if (accounts.length === 0) return;
    void ensureCredits(accounts.map((account) => account.id));
  }, [accounts, ensureCredits]);

  useEffect(() => {
    let cancelled = false;
    async function loadBalance() {
      if (!readClientUser()) { setBalance(null); return; }
      setBalanceLoading(true);
      try {
        const result = await fetchClientBalance();
        if (!cancelled) setBalance(result.balance);
      } catch {
        if (!cancelled) setBalance(null);
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    }
    void loadBalance();
    window.addEventListener(authChangedEvent(), loadBalance);
    return () => { cancelled = true; window.removeEventListener(authChangedEvent(), loadBalance); };
  }, []);

  // 顶部公告：后端 /api/client/announcement 可配置；拉取失败静默忽略
  useEffect(() => {
    let cancelled = false;
    fetch(adminApiUrl("/client/announcement"))
      .then((response) => response.json().catch(() => null))
      .then((payload) => {
        if (cancelled || !payload || payload.ok === false) return;
        const text = String(payload.data?.announcement || "").trim();
        if (text) setAnnouncement(text);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const total = useMemo(() => {
    let amount = 0;
    let hasUnlimited = false;
    let loaded = 0;
    for (const account of accounts) {
      const value = creditValue(creditMap[account.id]);
      if (creditMap[account.id]) loaded += 1;
      if (value === null) hasUnlimited = true;
      else amount += value;
    }
    return { amount, hasUnlimited, loaded };
  }, [accounts, creditMap]);

  const totalLabel = total.hasUnlimited
    ? "不限量"
    : total.loaded === 0 && accounts.length > 0
      ? "加载中…"
      : formatCredits(total.amount);

  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-card/95 px-5 py-3 backdrop-blur sm:px-8">
      <div className="mx-auto flex w-full max-w-[1180px] items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Sparkles className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-foreground">总积分</span>
              <strong className="truncate text-xl font-semibold tabular-nums tracking-tight text-foreground">{totalLabel}</strong>
              <span className="hidden text-xs text-muted-foreground sm:inline">{accounts.length} 个账号</span>
            </div>
            {announcement && (
              <p className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground" title={announcement}>
                <Megaphone className="size-3.5 shrink-0 text-primary/80" aria-hidden="true" />
                <span className="truncate">{announcement}</span>
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-xl border border-border bg-background px-3.5 py-2 text-sm font-semibold tabular-nums text-foreground" title="当前账户人民币余额">
            余额 {balanceLoading ? "加载中…" : balance === null ? "—" : `¥${balance.toFixed(2)}`}
          </span>
          <Button type="button" className="rounded-xl bg-primary px-3.5 text-primary-foreground shadow-sm shadow-primary/20 hover:bg-primary/90" onClick={() => navigate("/recharge")}>
            <Wallet />充值
          </Button>
        </div>
      </div>
    </header>
  );
}

function UpdateCenter({ running }: { running: boolean | undefined }) {
  const version = useAccountsStore((state) => state.status?.version);
  const snapshot = useUpdateState();
  const [dialogOpen, setDialogOpen] = useState(false);
  const hasKnownTarget = Boolean(snapshot.latest);
  const hasUpdate =
    snapshot.phase === "available" ||
    snapshot.phase === "downloading" ||
    snapshot.phase === "readyToRestart" ||
    (hasKnownTarget && (snapshot.phase === "error" || snapshot.phase === "checking"));
  const updateHint =
    snapshot.phase === "downloading"
      ? snapshot.percent === null ? "正在下载更新…" : `正在下载更新 ${snapshot.percent}%`
      : snapshot.phase === "readyToRestart" ? "重启以完成升级"
        : snapshot.phase === "error" ? "更新失败，点击重试"
          : snapshot.phase === "checking" ? "正在检查…" : "更新";

  return (
    <>
      <section className="mt-auto border-t border-sidebar-border/70 px-1 pt-4 text-xs">
        <div className="flex items-center gap-2 rounded-xl bg-sidebar-accent/60 px-2.5 py-2 text-sidebar-foreground">
          <StatusDot on={Boolean(running)} />
          <span className="min-w-0 flex-1 truncate">小玉米</span>
          <span className="text-sidebar-foreground/50">v{version || "?"}</span>
          {hasUpdate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" size="icon" className="size-6 rounded-lg p-0" aria-label={updateHint} onClick={() => setDialogOpen(true)}>
                  {snapshot.phase === "downloading" || snapshot.phase === "checking" ? <Loader2 className="size-3 animate-spin" /> : <ArrowUp className="size-3" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">{updateHint}</TooltipContent>
            </Tooltip>
          )}
        </div>
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
    window.addEventListener(authChangedEvent(), sync);
    return () => window.removeEventListener(authChangedEvent(), sync);
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
            <div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold">个人中心</div><div className="truncate text-[11px] text-sidebar-foreground/60">{user.phone}</div></div>
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

function Layout() {
  const running = useAccountsStore((state) => state.status?.running);
  const accounts = useAccountsStore((state) => state.accounts);
  const accountsLoading = useAccountsStore((state) => state.loading);
  const navigate = useNavigate();
  const location = useLocation();
  const hasUnifiedTitleBar = api.isDesktop() && typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
  useCreditAutoRefresh();
  useWorkbuddyStatusRefresh();

  useEffect(() => {
    if (!api.isDesktop()) return;
    const syncConnection = () => {
      if (!readClientToken()) return;
      void syncWorkBuddyConnection().catch((error) => {
        toast.warning(`WorkBuddy 模型连接未更新：${error instanceof Error ? error.message : String(error)}`);
      });
    };
    syncConnection();
    window.addEventListener(authChangedEvent(), syncConnection);
    return () => window.removeEventListener(authChangedEvent(), syncConnection);
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

  const navItems = [
    { to: "/", label: "账号总览", icon: UserRound, end: true },
    { to: "/models", label: "模型", icon: Boxes },
    { to: "/recharge", label: "充值", icon: Wallet },
    { to: "/credit-stats", label: "积分统计", icon: Sparkles },
    { to: "/token-stats", label: "Token 统计", icon: BarChart3 },
    { to: "/settings", label: "设置", icon: Settings2 },
  ];

  return (
    <div className="wb-app-shell flex h-screen min-h-0 overflow-hidden bg-background">
      {hasUnifiedTitleBar ? <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-50 h-8" aria-hidden="true" /> : null}
      <aside className={cn("flex min-h-0 w-[248px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-3 pb-4 text-sidebar-foreground", hasUnifiedTitleBar ? "pt-20" : "pt-5")}>
        <div className="mb-8 flex items-center gap-3 px-2">
          <AppIconMark size={38} className="drop-shadow-sm" />
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold tracking-tight">小玉米</div>
            <div className="mt-0.5 text-[11px] text-sidebar-foreground/55">账户管理工具</div>
            {demoModeEnabled && <Badge variant="secondary" className="mt-1 h-5 border-0 px-1.5 text-[10px]">演示模式</Badge>}
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1" aria-label="主导航">
          <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground/40">工作台</div>
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50",
                isActive ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm" : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <PersonalCenter />
        {api.isWebui() && !demoModeEnabled ? null : <UpdateCenter running={running} />}
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
          <Route element={<Layout />}>
            <Route path="/" element={<AccountsPage />} />
            <Route path="/models" element={<ModelsPage />} />
            <Route path="/recharge" element={<RechargePage />} />
            <Route path="/credit-stats" element={<CreditStatsPage />} />
            <Route path="/token-stats" element={<TokenStatsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <Toaster />
      </Router>
    </TooltipProvider>
  );
}
