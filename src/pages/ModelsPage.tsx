import { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, Bot, Box, ChevronDown, Cpu, Gauge, Loader2, PowerOff, RefreshCw, RotateCw, Search, Sparkles, Trash2, X } from "lucide-react";
import { siClaude, siDeepseek, siGooglegemini, siKimi, siMeta, siMistralai, siQwen, siBytedance } from "simple-icons";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { DEMO_UNAVAILABLE_MESSAGE, demoModeEnabled } from "@/lib/demo-mode";
import { authChangedEvent, readClientToken } from "@/lib/auth";
import { isDesktop } from "@/lib/api";
import { groupModelCatalog, isOurModel, mergeModelCatalog, type ModelDefinition } from "@/lib/model-catalog";
import { serviceDisplayText } from "@/lib/admin-backend";
import { MODEL_BALANCE_CHANGED, useModelBalance } from "@/lib/use-model-balance";
import {
  disableModelFromDsh, disableModelFromWorkBuddy, enableModelFromDsh, enableModelFromWorkBuddy,
  fetchDshModels, fetchSub2ApiModels, fetchWorkBuddyModels, hasSub2ApiBackend,
  importModelsToDsh, importModelsToWorkBuddy,
  syncWorkBuddyConnection,
  removeThirdPartyModelFromDsh, removeThirdPartyModelFromWorkBuddy, restartDeepSeekHarness, testSub2ApiSpeed,
  type DshModel, type Sub2ApiModel, type WorkBuddyModel, type WorkBuddyModelInput,
} from "@/lib/sub2api";
import { cn } from "@/lib/utils";

function toModelDefinition(model: Sub2ApiModel | WorkBuddyModel | DshModel): ModelDefinition {
  const remote = model as Sub2ApiModel;
  const local = model as WorkBuddyModel;
  const dsh = model as DshModel;
  return {
    id: model.id,
    name: remote.displayName || local.name || dsh.name || model.id,
    provider: dsh.providerName || remote.modelType || local.vendor || remote.ownedBy || "模型服务",
    description: "由后台模型服务配置提供。",
    context: remote.object || "chat model",
    managed: local.managed ?? dsh.managed,
    disabled: local.disabled ?? dsh.disabled,
  };
}

function ModelRow({ model, imported, busy, canManage, unavailable, onSwitchChange, onRemove }: { model: ModelDefinition; imported: boolean; busy: boolean; canManage: boolean; unavailable: boolean; onSwitchChange: (checked: boolean) => void; onRemove: () => void }) {
  const managed = model.managed === true;
  return <div className={cn("flex min-w-0 items-center gap-2.5 border-b border-border/60 px-3 py-2.5 last:border-b-0 sm:px-4", imported && "bg-primary/[0.035]")}>
    <ModelIcon model={model} />
    <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-normal text-foreground">{serviceDisplayText(model.name)}</div><div className="mt-0.5 truncate text-[10px] text-muted-foreground/75">模型 ID：{serviceDisplayText(model.id)}{unavailable ? " · 当前账号不可用" : ""}</div></div>
    <div className="flex shrink-0 items-center gap-1.5"><Switch checked={imported} onCheckedChange={onSwitchChange} disabled={busy || demoModeEnabled || !canManage} aria-label={`${model.name} Switch 空间，${imported ? "已打开" : "已关闭"}`} title={imported ? "关闭模型" : "打开模型"} />{!managed && model.localInstalled && <Button type="button" variant="ghost" size="icon" className="size-7 rounded-lg text-muted-foreground hover:text-destructive" onClick={onRemove} disabled={busy || !canManage} aria-label={`删除 ${model.name}`} title={`删除 ${model.name}`}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}</Button>}</div>
  </div>;
}

function ModelIcon({ model }: { model: ModelDefinition }) {
  const name = `${model.id} ${model.name}`.toLowerCase();
  const icon = name.includes("deepseek") ? siDeepseek : name.includes("claude") ? siClaude : name.includes("gemini") ? siGooglegemini : name.includes("qwen") ? siQwen : name.includes("kimi") ? siKimi : name.includes("llama") ? siMeta : name.includes("mistral") ? siMistralai : name.includes("doubao") ? siBytedance : null;
  return <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-primary" aria-hidden="true">{icon ? <svg viewBox="0 0 24 24" className="size-4" fill="currentColor"><path d={icon.path} /></svg> : <Cpu className="size-4 text-muted-foreground" />}</span>;
}

type TargetApp = "workbuddy" | "dsh";

function dedupeModels<T extends { id: string; disabled?: boolean; managed?: boolean }>(models: T[]): T[] {
  const byId = new Map<string, T>();
  for (const model of models) {
    const existing = byId.get(model.id);
    if (!existing || (existing.disabled === true && model.disabled !== true) || (existing.managed !== true && model.managed === true)) {
      byId.set(model.id, model);
    }
  }
  return [...byId.values()];
}

const TARGET_META: Record<TargetApp, { appLabel: string }> = {
  workbuddy: { appLabel: "WorkBuddy" },
  dsh: { appLabel: "DeepSeek Harness" },
};

export default function ModelsPage() {
  const navigate = useNavigate();
  const { balance, loading: balanceLoading } = useModelBalance();
  const [target, setTarget] = useState<TargetApp>("workbuddy");
  const [catalog, setCatalog] = useState<ModelDefinition[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [connectionReady, setConnectionReady] = useState(false);
  const [importedWorkBuddy, setImportedWorkBuddy] = useState<WorkBuddyModel[]>([]);
  const [importedDsh, setImportedDsh] = useState<DshModel[]>([]);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [groupBusy, setGroupBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [removeGroup, setRemoveGroup] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [speedLoading, setSpeedLoading] = useState(false);
  const [speedMessage, setSpeedMessage] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ModelDefinition | null>(null);
  const [restartingHarness, setRestartingHarness] = useState(false);
  const [loggedIn, setLoggedIn] = useState(() => Boolean(readClientToken()));
  const syncGeneration = useRef(0);
  const authGeneration = useRef(0);

  const importedModels: Array<WorkBuddyModel | DshModel> = target === "workbuddy" ? importedWorkBuddy : importedDsh;
  useEffect(() => { window.dispatchEvent(new Event("model-list-changed")); }, [importedWorkBuddy]);
  async function syncModels() {
    const token = readClientToken();
    const generation = ++syncGeneration.current;
    const isCurrent = () => generation === syncGeneration.current && token === readClientToken();
    setLoggedIn(Boolean(token));
    setRemoteLoading(true); setRemoteError(null); setConnectionReady(false);
    try {
      let connectionError: string | null = null;
      if (isDesktop()) {
        try {
          const models = await syncWorkBuddyConnection();
          if (!isCurrent()) return;
          setImportedWorkBuddy(dedupeModels(models));
          setConnectionReady(Boolean(token));
        } catch (error) {
          if (!isCurrent()) return;
          connectionError = error instanceof Error ? error.message : String(error);
        }
      } else setConnectionReady(Boolean(token));
      const [remote, workBuddy, dsh] = await Promise.allSettled([
        token && hasSub2ApiBackend() ? fetchSub2ApiModels() : Promise.resolve([] as Sub2ApiModel[]),
        fetchWorkBuddyModels(),
        fetchDshModels(),
      ]);
      if (!isCurrent()) return;
      const errors: string[] = connectionError ? [`WorkBuddy 连接：${connectionError}`] : [];
      if (remote.status === "fulfilled") { setCatalog(dedupeModels(remote.value).map(toModelDefinition)); setCatalogLoaded(Boolean(token)); }
      else { setCatalog([]); setCatalogLoaded(false); errors.push(`远端模型：${String(remote.reason)}`); }
      if (workBuddy.status === "fulfilled") setImportedWorkBuddy(dedupeModels(workBuddy.value));
      else errors.push(`本机 WorkBuddy：${String(workBuddy.reason)}`);
      if (dsh.status === "fulfilled") setImportedDsh(dsh.value);
      else errors.push(`本机 Harness：${String(dsh.reason)}`);
      setRemoteError(errors.length ? errors.join("；") : null);
    }
    catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof Error ? error.message : String(error);
      setRemoteError(message.includes("余额不足") || message.includes("INSUFFICIENT_BALANCE") ? "当前用户积分为 0，模型服务已暂停访问。请先充值积分，再点击同步模型。" : serviceDisplayText(message));
    }
    finally { if (isCurrent()) setRemoteLoading(false); }
  }

  useEffect(() => {
    const handleAuthChanged = () => {
      ++authGeneration.current;
      setCatalog([]); setCatalogLoaded(false); setImportedWorkBuddy([]); setImportedDsh([]);
      setConnectionReady(false); setRemoteError(null); setSpeedMessage(null); setSpeedLoading(false); setRemoveTarget(null);
      setBusyIds([]); setGroupBusy(false); setRemoveGroup(null);
      setLoggedIn(Boolean(readClientToken())); void syncModels();
    };
    window.addEventListener(authChangedEvent(), handleAuthChanged);
    void syncModels();
    return () => { ++syncGeneration.current; ++authGeneration.current; window.removeEventListener(authChangedEvent(), handleAuthChanged); };
  }, []);

  const importedDefinitions = useMemo(() => importedModels.map(toModelDefinition), [importedModels]);
  const normalizedQuery = query.trim().toLowerCase();
  const allModels = useMemo(() => mergeModelCatalog(catalog, importedDefinitions, true), [catalog, importedDefinitions]);
  const filteredModels = useMemo(() => allModels.filter((model) => !normalizedQuery || [model.id, model.name, model.provider, model.description].some((value) => value.toLowerCase().includes(normalizedQuery))), [allModels, normalizedQuery]);
  const visibleModels = filteredModels;
  const groupedModels = useMemo(() => groupModelCatalog(visibleModels), [visibleModels]);
  const allGroups = useMemo(() => groupModelCatalog(allModels), [allModels]);

  async function importModels(ids: string[]) {
    if (demoModeEnabled) { toast.info(DEMO_UNAVAILABLE_MESSAGE); return; }
    if (!readClientToken()) { toast.error("请先登录个人中心"); return; }
    const generation = authGeneration.current;
    const token = readClientToken();
    const isCurrent = () => generation === authGeneration.current && token === readClientToken();
    const definitions = [...catalog, ...importedDefinitions];
    const models = ids.map((id) => definitions.find((model) => model.id === id)).filter((model): model is ModelDefinition => Boolean(model));
    if (models.length === 0) return;
    const inputs: WorkBuddyModelInput[] = models.map((model) => ({ id: model.id, name: model.name, provider: model.provider }));
    setBusyIds((current) => [...new Set([...current, ...models.map((model) => model.id)])]);
    try {
      if (target === "workbuddy") {
        const result = await importModelsToWorkBuddy(inputs);
        if (isCurrent()) setImportedWorkBuddy(dedupeModels(result));
      } else {
        const result = await importModelsToDsh(inputs);
        if (isCurrent()) setImportedDsh(result);
      }
      if (isCurrent()) toast.success(`已将 ${models.length} 个模型导入${TARGET_META[target].appLabel}`, { description: target === "workbuddy" ? "请在 WorkBuddy 的模型选择器中选择；如未显示，请重启 WorkBuddy。" : "请检查 Harness 的 API Key 后选择模型。" });
    }
    catch (error) { if (isCurrent()) toast.error(error instanceof Error ? error.message : String(error)); }
    finally { if (isCurrent()) setBusyIds((current) => current.filter((id) => !ids.includes(id))); }
  }

  async function toggleImport(model: ModelDefinition, checked: boolean) {
    if (checked && isOurModel(model) && (!readClientToken() || !catalogLoaded || !catalog.some((item) => item.id === model.id))) {
      toast.error("当前账号不可使用此模型，请同步模型列表后重试");
      return;
    }
    if (checked && target === "workbuddy" && isOurModel(model) && !connectionReady) {
      toast.error("当前账号的 WorkBuddy 模型连接尚未同步成功");
      return;
    }
    if (model.localInstalled) {
      await toggleDisable(model);
      return;
    }
    if (checked) await importModels([model.id]);
  }

  async function removeModel(model: ModelDefinition) {
    if (model.managed || !isDesktop()) return;
    const id = model.id;
    const generation = authGeneration.current;
    const isCurrent = () => generation === authGeneration.current;
    setBusyIds((current) => [...new Set([...current, id])]);
    try {
      if (target === "workbuddy") {
        const result = await removeThirdPartyModelFromWorkBuddy(id);
        if (isCurrent()) setImportedWorkBuddy(dedupeModels(result));
      } else {
        const result = await removeThirdPartyModelFromDsh(id, model.provider);
        if (isCurrent()) setImportedDsh(result);
      }
      if (isCurrent()) toast.success("已移除模型");
    }
    catch (error) { if (isCurrent()) toast.error(error instanceof Error ? error.message : String(error)); }
    finally { if (isCurrent()) setBusyIds((current) => current.filter((item) => item !== id)); }
  }

  async function toggleDisable(model: ModelDefinition) {
    const id = model.id;
    const generation = authGeneration.current;
    const isCurrent = () => generation === authGeneration.current;
    const targetModel = importedModels.find((entry) => entry.id === id && (target !== "dsh" || (entry as DshModel).providerName === model.provider));
    if (!targetModel) return;
    const wasDisabled = targetModel.disabled === true;
    setBusyIds((current) => [...new Set([...current, id])]);
    try {
      if (target === "workbuddy") {
        const result = wasDisabled ? await enableModelFromWorkBuddy(id) : await disableModelFromWorkBuddy(id);
        if (isCurrent()) setImportedWorkBuddy(dedupeModels(result));
      } else {
        const result = wasDisabled ? await enableModelFromDsh(id, model.provider) : await disableModelFromDsh(id, model.provider);
        if (isCurrent()) setImportedDsh(result);
      }
      if (isCurrent() && wasDisabled && isOurModel(model)) toast.success(`已在${TARGET_META[target].appLabel}启用模型`, { description: target === "workbuddy" ? "请在 WorkBuddy 的模型选择器中选择；如未显示，请重启 WorkBuddy。" : "请核对 Harness 的 API Key 后选择模型。" });
    } catch (error) { if (isCurrent()) toast.error(error instanceof Error ? error.message : String(error)); }
    finally { if (isCurrent()) setBusyIds((current) => current.filter((item) => item !== id)); }
  }

  /** 单个删除：弹出确认框后再执行（桌面 WebView 不支持 window.confirm） */
  function requestRemoveModel(model: ModelDefinition) {
    if (demoModeEnabled) { toast.info(DEMO_UNAVAILABLE_MESSAGE); return; }
    if (model.managed) return;
    setRemoveTarget(model);
  }

  async function confirmRemoveModel() {
    const model = removeTarget;
    if (!model) return;
    setRemoveTarget(null);
    await removeModel(model);
  }

  async function changeExternalGroup(group: string, action: "disable" | "remove") {
    if (demoModeEnabled || !isDesktop() || groupBusy) return;
    const pending = (allGroups.find(([name]) => name === group)?.[1] ?? [])
      .filter((model) => !isOurModel(model) && model.localInstalled && (action === "remove" || !model.disabled));
    if (!pending.length) return;
    const generation = authGeneration.current;
    const isCurrent = () => generation === authGeneration.current;
    setGroupBusy(true);
    setBusyIds((current) => [...new Set([...current, ...pending.map((model) => model.id)])]);
    let completed = 0;
    let currentModel = "";
    try {
      for (const model of pending) {
        if (!isCurrent()) return;
        currentModel = model.name;
        if (target === "workbuddy") {
          const result = action === "remove" ? await removeThirdPartyModelFromWorkBuddy(model.id) : await disableModelFromWorkBuddy(model.id);
          if (isCurrent()) setImportedWorkBuddy(dedupeModels(result));
        } else {
          const result = action === "remove" ? await removeThirdPartyModelFromDsh(model.id, model.provider) : await disableModelFromDsh(model.id, model.provider);
          if (isCurrent()) setImportedDsh(result);
        }
        completed++;
      }
      if (isCurrent()) toast.success(`已${action === "remove" ? "删除" : "关闭"} ${completed} 个 ${group} 模型`);
    } catch (error) {
      if (isCurrent()) toast.error(serviceDisplayText(`已处理 ${completed} 个，${currentModel} 操作失败：${error instanceof Error ? error.message : String(error)}`));
    } finally {
      if (isCurrent()) {
        setBusyIds((current) => current.filter((id) => !pending.some((model) => model.id === id)));
        setGroupBusy(false);
      }
    }
  }
  async function testSpeed() {
    const generation = authGeneration.current;
    setSpeedLoading(true); setSpeedMessage(null);
    try { const result = await testSub2ApiSpeed(); if (generation === authGeneration.current) setSpeedMessage(`链路 ${result.durationMs} ms · ${result.count} 个模型`); }
    catch (error) { if (generation === authGeneration.current) setSpeedMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === authGeneration.current) setSpeedLoading(false); }
  }

  async function restartHarness() {
    if (restartingHarness) return;
    setRestartingHarness(true);
    try {
      await restartDeepSeekHarness();
      toast.success("DeepSeek Harness 已重启", { description: "Agent 已重新读取模型配置。" });
      window.setTimeout(() => void syncModels(), 1200);
    } catch (error) {
      toast.error("重启 DeepSeek Harness 失败", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setRestartingHarness(false);
    }
  }

  const meta = TARGET_META[target];
  const enabledOurModels = importedModels.filter((model) => model.managed && !model.disabled).length;
  const guide = !loggedIn
    ? { title: "登录后使用小玉米模型", detail: "登录后可充值、启用模型并查看使用记录。", action: "登录", run: () => window.dispatchEvent(new Event("open-client-login")) }
    : balanceLoading || remoteLoading
      ? { title: "正在检查模型服务状态", detail: "正在读取余额与模型配置。", action: "", run: () => {} }
      : balance === null
        ? { title: "余额暂不可用", detail: "无法确认当前余额，请检查网络后重试。", action: "重试", run: () => window.dispatchEvent(new Event(MODEL_BALANCE_CHANGED)) }
        : balance <= 0
          ? { title: "模型服务余额不足", detail: "小玉米模型按实际用量扣费，充值后可使用。WorkBuddy 积分与模型服务余额相互独立。", action: "去充值", run: () => navigate("/recharge") }
          : remoteError || !catalogLoaded || (target === "workbuddy" && !connectionReady)
            ? { title: "模型连接尚未就绪", detail: "请同步模型并检查连接状态。", action: "重新同步", run: () => void syncModels() }
            : enabledOurModels === 0
              ? { title: `选择模型并启用到 ${meta.appLabel}`, detail: "在下方“我们的模型”分组中打开需要的模型。", action: "查看模型", run: () => document.getElementById("model-list")?.scrollIntoView({ behavior: "smooth" }) }
              : { title: `${meta.appLabel} 已启用 ${enabledOurModels} 个小玉米模型`, detail: target === "workbuddy" ? "请在 WorkBuddy 的模型选择器中选择；如未显示，请重启 WorkBuddy。" : "请核对 Harness 的 API Key，然后在 Harness 中选择模型。", action: "查看使用记录", run: () => navigate("/model-usage") };

  return <div className="wb-page mx-auto w-full max-w-[1180px] min-w-0 px-4 py-7 sm:px-8 sm:py-10">
    <header className="mb-7 flex min-w-0 flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h1 className="text-[28px] font-semibold tracking-tight">模型与启用</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">启用小玉米模型，管理 WorkBuddy 与 DeepSeek Harness 的模型配置。</p></div><div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2"><div className="inline-flex min-w-0 rounded-xl border border-border bg-muted/40 p-1"><button type="button" onClick={() => setTarget("workbuddy")} className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors", target === "workbuddy" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><Boxes className="size-3.5" />WorkBuddy</button><button type="button" onClick={() => setTarget("dsh")} className={cn("inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors", target === "dsh" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><Bot className="size-3.5" />Harness</button></div><Button type="button" variant="outline" size="sm" onClick={() => void syncModels()} disabled={remoteLoading}><RefreshCw className={cn(remoteLoading && "animate-spin")} />同步模型</Button><Button type="button" variant="outline" size="sm" onClick={() => void testSpeed()} disabled={speedLoading}>{speedLoading ? <Loader2 className="animate-spin" /> : <Gauge />}测试速度</Button></div></header>
    <section className="mb-5 flex flex-wrap items-center justify-between gap-4 border-y border-border bg-primary/[0.035] px-4 py-4" aria-label="模型服务状态">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-x-4 gap-y-1"><h2 className="text-sm font-semibold">{guide.title}</h2><span className="text-xs tabular-nums text-muted-foreground">模型服务余额 {balanceLoading ? "加载中…" : balance === null ? "—" : `¥${balance.toFixed(2)}`}</span></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{guide.detail}</p></div>
      {guide.action && <Button type="button" size="sm" onClick={guide.run}>{guide.action}</Button>}
    </section>
    <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
      {(remoteLoading || remoteError || speedMessage || !loggedIn) && <p className="min-w-0 max-w-md truncate text-xs text-muted-foreground" title={serviceDisplayText(remoteError || speedMessage || "") || undefined} role="status">{remoteLoading ? "正在加载模型…" : remoteError ? `读取失败：${serviceDisplayText(remoteError)}` : speedMessage ? serviceDisplayText(speedMessage) : "登录后可加载远端模型"}</p>}
    </div>
    {target === "dsh" && (loggedIn || importedDsh.some((model) => model.managed)) && <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2" role="status"><p className="text-xs leading-5 text-foreground">模型开关会先更新 Harness 配置；正在运行的 Agent 需要重新读取配置才能生效。</p><Button type="button" variant="outline" size="sm" onClick={() => void restartHarness()} disabled={restartingHarness || demoModeEnabled || !isDesktop()}>{restartingHarness ? <Loader2 className="animate-spin" /> : <RotateCw />}重启 Harness</Button></div>}
    <Card id="model-list" className="min-w-0 gap-0 overflow-hidden rounded-lg py-0 shadow-none">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
        <div className="flex shrink-0 items-baseline gap-2"><h2 className="text-sm font-semibold">模型列表</h2><span className="text-xs tabular-nums text-muted-foreground">{normalizedQuery ? `${filteredModels.length} / ${allModels.length}` : allModels.length} 个</span></div>
        <div className="relative w-full sm:w-72"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型名称、厂商或 ID" className="h-9 rounded-lg pl-9" aria-label="搜索模型" />{query && <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1/2 size-7 -translate-y-1/2 rounded-md" onClick={() => setQuery("")} aria-label="清除搜索"><X className="size-4" /></Button>}</div>
      </div>
      <CardContent className="p-0">{groupedModels.length === 0 ? <div className="px-5 py-14 text-center text-sm text-muted-foreground">{normalizedQuery ? "没有匹配的模型" : "暂无模型"}</div> : groupedModels.map(([provider, models]) => {
        const groupModels = allGroups.find(([name]) => name === provider)?.[1] ?? [];
        const external = provider !== "我们的模型";
        const installed = groupModels.filter((model) => !isOurModel(model) && model.localInstalled);
        const groupKey = `${target}:${provider}`;
        const isCollapsed = collapsed[groupKey] === true;
        const displayProvider = serviceDisplayText(provider);
        return <section key={provider} aria-label={`${displayProvider} 模型`}><div className="flex min-w-0 items-center gap-1 border-b border-t border-border/60 bg-muted/25 px-3 py-1.5">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left text-xs font-bold hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => ({ ...current, [groupKey]: !isCollapsed }))}>
            <ChevronDown className={cn("size-4 shrink-0 transition-transform", isCollapsed && "-rotate-90")} />{external ? <Box className="size-4 shrink-0 text-muted-foreground" /> : <Sparkles className="size-4 shrink-0 text-primary" />}<span className="truncate">{serviceDisplayText(provider)}</span><span className="font-normal tabular-nums text-muted-foreground">{models.length}</span>
          </button>
          {external && <div className="flex shrink-0 items-center gap-1"><Button type="button" variant="ghost" size="icon" className="size-7" title={`关闭 ${displayProvider} 全部模型`} aria-label={`关闭 ${displayProvider} 全部模型`} disabled={!isDesktop() || demoModeEnabled || groupBusy || busyIds.length > 0 || !installed.some((model) => !model.disabled)} onClick={() => void changeExternalGroup(provider, "disable")}><PowerOff className="size-4" /></Button><Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" title={`删除 ${displayProvider} 全部模型`} aria-label={`删除 ${displayProvider} 全部模型`} disabled={!isDesktop() || demoModeEnabled || groupBusy || busyIds.length > 0 || installed.length === 0} onClick={() => setRemoveGroup(provider)}><Trash2 className="size-4" /></Button></div>}
        </div>{!isCollapsed && models.map((model) => {
        const imported = model.localInstalled === true && !model.disabled;
        const unavailable = model.managed === true && loggedIn && catalogLoaded && !catalog.some((item) => item.id === model.id);
        const canManage = (model.managed === true || !model.localInstalled || isDesktop()) && (imported || !isOurModel(model) || (loggedIn && catalogLoaded && !unavailable && (target !== "workbuddy" || connectionReady)));
        return <ModelRow key={`${model.localInstalled ? "local" : "remote"}:${provider}:${model.id}`} model={model} imported={imported} unavailable={unavailable} busy={groupBusy || busyIds.includes(model.id)} canManage={canManage} onSwitchChange={(checked) => void toggleImport(model, checked)} onRemove={() => requestRemoveModel(model)} />;
      })}</section>;
      })}</CardContent>
    </Card>

    {/* 单个模型删除确认（桌面 App 不支持 window.confirm） */}
    <Dialog open={removeTarget !== null} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除第三方模型</DialogTitle>
          <DialogDescription>
            确定要从{meta.appLabel}删除第三方模型「{removeTarget?.name}」吗？
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRemoveTarget(null)}>取消</Button>
          <Button variant="destructive" onClick={() => void confirmRemoveModel()}>确认删除</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={removeGroup !== null} onOpenChange={(open) => { if (!open) setRemoveGroup(null); }}>
      <DialogContent><DialogHeader><DialogTitle>删除分组模型</DialogTitle><DialogDescription>确定从{meta.appLabel}删除「{serviceDisplayText(removeGroup || "")}」分组的全部第三方模型吗？包含已关闭和搜索结果以外的模型，此操作无法撤销。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setRemoveGroup(null)}>取消</Button><Button variant="destructive" onClick={() => { const group = removeGroup; setRemoveGroup(null); if (group) void changeExternalGroup(group, "remove"); }}>确认删除</Button></DialogFooter></DialogContent>
    </Dialog>

  </div>;
}
