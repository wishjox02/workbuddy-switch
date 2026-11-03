import { useEffect, useMemo, useState } from "react";
import { Boxes, Bot, Gauge, Loader2, RefreshCw, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";

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
import {
  disableModelFromDsh, disableModelFromWorkBuddy, enableModelFromDsh, enableModelFromWorkBuddy,
  fetchDshModels, fetchSub2ApiModels, fetchWorkBuddyModels, hasSub2ApiBackend,
  importModelsToDsh, importModelsToWorkBuddy,
  syncWorkBuddyConnection,
  removeThirdPartyModelFromDsh, removeThirdPartyModelFromWorkBuddy, testSub2ApiSpeed,
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
    provider: dsh.providerName || remote.modelType || local.vendor || remote.ownedBy || "Sub2API",
    description: "由后台模型服务配置提供。",
    context: remote.object || "chat model",
    managed: local.managed ?? dsh.managed,
    disabled: local.disabled ?? dsh.disabled,
  };
}

function ModelRow({ model, imported, busy, canManage, onSwitchChange, onRemove }: { model: ModelDefinition; imported: boolean; busy: boolean; canManage: boolean; onSwitchChange: (checked: boolean) => void; onRemove: () => void }) {
  const managed = model.managed === true;
  return <div className={cn("flex min-w-0 items-center gap-2.5 border-b border-border/60 px-3 py-2.5 last:border-b-0 sm:px-4", imported && "bg-primary/[0.035]")}>
    <div className="min-w-0 flex-1"><div className="truncate text-[13px] font-medium text-foreground">{model.name}</div><div className="mt-0.5 truncate text-[10px] text-muted-foreground/75">模型 ID：{model.id}</div></div>
    <div className="flex shrink-0 items-center gap-1.5"><Switch checked={imported} onCheckedChange={onSwitchChange} disabled={busy || demoModeEnabled || !canManage} aria-label={`${model.name} Switch 空间，${imported ? "已打开" : "已关闭"}`} title={imported ? "关闭模型" : "打开模型"} />{!managed && model.localInstalled && <Button type="button" variant="ghost" size="icon" className="size-7 rounded-lg text-muted-foreground hover:text-destructive" onClick={onRemove} disabled={busy || !canManage} aria-label={`删除 ${model.name}`} title={`删除 ${model.name}`}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}</Button>}</div>
  </div>;
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
  const [target, setTarget] = useState<TargetApp>("workbuddy");
  const [catalog, setCatalog] = useState<ModelDefinition[]>([]);
  const [importedWorkBuddy, setImportedWorkBuddy] = useState<WorkBuddyModel[]>([]);
  const [importedDsh, setImportedDsh] = useState<DshModel[]>([]);
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [openAiBusy, setOpenAiBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [speedLoading, setSpeedLoading] = useState(false);
  const [speedMessage, setSpeedMessage] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ModelDefinition | null>(null);
  const [loggedIn, setLoggedIn] = useState(() => Boolean(readClientToken()));

  const importedModels: Array<WorkBuddyModel | DshModel> = target === "workbuddy" ? importedWorkBuddy : importedDsh;
  async function syncModels() {
    const token = readClientToken();
    setLoggedIn(Boolean(token));
    setRemoteLoading(true); setRemoteError(null);
    try {
      let connectionError: string | null = null;
      if (token && isDesktop()) {
        try {
          setImportedWorkBuddy(dedupeModels(await syncWorkBuddyConnection()));
        } catch (error) {
          connectionError = error instanceof Error ? error.message : String(error);
        }
      }
      const [remote, workBuddy, dsh] = await Promise.allSettled([
        token && hasSub2ApiBackend() ? fetchSub2ApiModels() : Promise.resolve([] as Sub2ApiModel[]),
        fetchWorkBuddyModels(),
        fetchDshModels(),
      ]);
      const errors: string[] = connectionError ? [`WorkBuddy 连接：${connectionError}`] : [];
      if (remote.status === "fulfilled") setCatalog(dedupeModels(remote.value).map(toModelDefinition));
      else { setCatalog([]); errors.push(`远端模型：${String(remote.reason)}`); }
      if (workBuddy.status === "fulfilled") setImportedWorkBuddy(dedupeModels(workBuddy.value));
      else errors.push(`本机 WorkBuddy：${String(workBuddy.reason)}`);
      if (dsh.status === "fulfilled") setImportedDsh(dsh.value);
      else errors.push(`本机 Harness：${String(dsh.reason)}`);
      setRemoteError(errors.length ? errors.join("；") : null);
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRemoteError(message.includes("余额不足") || message.includes("INSUFFICIENT_BALANCE") ? "当前用户积分为 0，Sub2API 已暂停模型访问。请先充值积分，再点击同步模型。" : message);
    }
    finally { setRemoteLoading(false); }
  }

  useEffect(() => { void syncModels(); }, []);

  useEffect(() => {
    const handleAuthChanged = () => { setLoggedIn(Boolean(readClientToken())); void syncModels(); };
    window.addEventListener(authChangedEvent(), handleAuthChanged);
    return () => window.removeEventListener(authChangedEvent(), handleAuthChanged);
  }, []);

  const importedDefinitions = useMemo(() => importedModels.map(toModelDefinition), [importedModels]);
  const normalizedQuery = query.trim().toLowerCase();
  const allModels = useMemo(() => mergeModelCatalog(catalog, importedDefinitions, true), [catalog, importedDefinitions]);
  const filteredModels = useMemo(() => allModels.filter((model) => !normalizedQuery || [model.id, model.name, model.provider, model.description].some((value) => value.toLowerCase().includes(normalizedQuery))), [allModels, normalizedQuery]);
  const visibleModels = filteredModels;
  const groupedModels = useMemo(() => groupModelCatalog(visibleModels), [visibleModels]);
  const openAiModels = allModels.filter((model) => !isOurModel(model) && model.provider.toLowerCase() === "openai");
  const openAiAllEnabled = openAiModels.length > 0 && openAiModels.every((model) => model.localInstalled && !model.disabled);

  async function importModels(ids: string[]) {
    if (demoModeEnabled) { toast.info(DEMO_UNAVAILABLE_MESSAGE); return; }
    if (!readClientToken()) { toast.error("请先登录个人中心"); return; }
    const definitions = [...catalog, ...importedDefinitions];
    const models = ids.map((id) => definitions.find((model) => model.id === id)).filter((model): model is ModelDefinition => Boolean(model));
    if (models.length === 0) return;
    const inputs: WorkBuddyModelInput[] = models.map((model) => ({ id: model.id, name: model.name, provider: model.provider }));
    setBusyIds((current) => [...new Set([...current, ...models.map((model) => model.id)])]);
    try {
      if (target === "workbuddy") {
        const result = await importModelsToWorkBuddy(inputs);
        setImportedWorkBuddy(dedupeModels(result));
      } else {
        const result = await importModelsToDsh(inputs);
        setImportedDsh(result);
      }
      toast.success(`已将 ${models.length} 个模型导入${TARGET_META[target].appLabel}`);
    }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setBusyIds((current) => current.filter((id) => !ids.includes(id))); }
  }

  async function toggleImport(model: ModelDefinition, checked: boolean) {
    if (model.localInstalled) {
      await toggleDisable(model);
      return;
    }
    if (checked) await importModels([model.id]);
  }

  async function removeModel(model: ModelDefinition) {
    if (model.managed || !isDesktop()) return;
    const id = model.id;
    setBusyIds((current) => [...new Set([...current, id])]);
    try {
      if (target === "workbuddy") {
        const result = await removeThirdPartyModelFromWorkBuddy(id);
        setImportedWorkBuddy(dedupeModels(result));
      } else {
        const result = await removeThirdPartyModelFromDsh(id, model.provider);
        setImportedDsh(result);
      }
      toast.success("已移除模型");
    }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setBusyIds((current) => current.filter((item) => item !== id)); }
  }

  async function toggleDisable(model: ModelDefinition) {
    const id = model.id;
    const targetModel = importedModels.find((entry) => entry.id === id && (target !== "dsh" || (entry as DshModel).providerName === model.provider));
    if (!targetModel) return;
    const wasDisabled = targetModel.disabled === true;
    setBusyIds((current) => [...new Set([...current, id])]);
    try {
      if (target === "workbuddy") {
        const result = wasDisabled ? await enableModelFromWorkBuddy(id) : await disableModelFromWorkBuddy(id);
        setImportedWorkBuddy(dedupeModels(result));
      } else {
        const result = wasDisabled ? await enableModelFromDsh(id, model.provider) : await disableModelFromDsh(id, model.provider);
        setImportedDsh(result);
      }
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setBusyIds((current) => current.filter((item) => item !== id)); }
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

  async function toggleOpenAiGroup(checked: boolean) {
    if (demoModeEnabled) { toast.info(DEMO_UNAVAILABLE_MESSAGE); return; }
    const pending = openAiModels.filter((model) => (model.localInstalled === true && !model.disabled) !== checked);
    if (pending.length === 0) return;
    if (checked && pending.some((model) => !model.localInstalled) && !readClientToken()) {
      toast.error("请先登录个人中心");
      return;
    }
    setOpenAiBusy(true);
    setBusyIds((current) => [...new Set([...current, ...openAiModels.map((model) => model.id)])]);
    let completed = 0;
    let currentModel = "";
    try {
      for (const model of pending) {
        currentModel = model.name;
        if (target === "workbuddy") {
          const result = !model.localInstalled
            ? await importModelsToWorkBuddy([{ id: model.id, name: model.name, provider: model.provider }])
            : checked ? await enableModelFromWorkBuddy(model.id) : await disableModelFromWorkBuddy(model.id);
          setImportedWorkBuddy(dedupeModels(result));
        } else {
          const result = !model.localInstalled
            ? await importModelsToDsh([{ id: model.id, name: model.name, provider: model.provider }])
            : checked ? await enableModelFromDsh(model.id, model.provider) : await disableModelFromDsh(model.id, model.provider);
          setImportedDsh(result);
        }
        completed++;
      }
      toast.success(`已${checked ? "打开" : "关闭"} ${completed} 个 OPENAI 模型`);
    } catch (error) {
      toast.error(`${currentModel} 操作失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyIds((current) => current.filter((id) => !openAiModels.some((model) => model.id === id)));
      setOpenAiBusy(false);
    }
  }
  async function testSpeed() { setSpeedLoading(true); setSpeedMessage(null); try { const result = await testSub2ApiSpeed(); setSpeedMessage(`链路 ${result.durationMs} ms · ${result.count} 个模型`); } catch (error) { setSpeedMessage(error instanceof Error ? error.message : String(error)); } finally { setSpeedLoading(false); } }

  const meta = TARGET_META[target];

  return <div className="wb-page mx-auto w-full max-w-[1180px] min-w-0 px-4 py-7 sm:px-8 sm:py-10">
    <header className="mb-7 flex min-w-0 flex-wrap items-start justify-between gap-4"><div className="min-w-0"><h1 className="text-[28px] font-semibold tracking-tight">模型</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">管理 WorkBuddy 与 DeepSeek Harness 的模型。</p></div><div className="flex shrink-0 flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" onClick={() => void syncModels()} disabled={remoteLoading}><RefreshCw className={cn(remoteLoading && "animate-spin")} />同步模型</Button><Button type="button" variant="outline" size="sm" onClick={() => void testSpeed()} disabled={speedLoading}>{speedLoading ? <Loader2 className="animate-spin" /> : <Gauge />}测试速度</Button></div></header>
    <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
      <div className="inline-flex min-w-0 rounded-xl border border-border bg-muted/40 p-1">
        <button type="button" onClick={() => setTarget("workbuddy")} className={cn("inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors", target === "workbuddy" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><Boxes className="size-4" />WorkBuddy</button>
        <button type="button" onClick={() => setTarget("dsh")} className={cn("inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors", target === "dsh" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><Bot className="size-4" />DeepSeek Harness</button>
      </div>
      {(remoteLoading || remoteError || speedMessage || !loggedIn) && <p className="min-w-0 max-w-md truncate text-xs text-muted-foreground" title={remoteError || speedMessage || undefined} role="status">{remoteLoading ? "正在加载模型…" : remoteError ? `读取失败：${remoteError}` : speedMessage || "登录后可加载远端模型"}</p>}
    </div>
    <Card className="min-w-0 gap-0 overflow-hidden rounded-lg py-0 shadow-none">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3 sm:px-5">
        <div className="flex shrink-0 items-baseline gap-2"><h2 className="text-sm font-semibold">模型列表</h2><span className="text-xs tabular-nums text-muted-foreground">{normalizedQuery ? `${filteredModels.length} / ${allModels.length}` : allModels.length} 个</span></div>
        <div className="relative w-full sm:w-72"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型名称、厂商或 ID" className="h-9 rounded-lg pl-9" aria-label="搜索模型" />{query && <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1/2 size-7 -translate-y-1/2 rounded-md" onClick={() => setQuery("")} aria-label="清除搜索"><X className="size-4" /></Button>}</div>
      </div>
      <CardContent className="p-0">{groupedModels.length === 0 ? <div className="px-5 py-14 text-center text-sm text-muted-foreground">{normalizedQuery ? "没有匹配的模型" : "暂无模型"}</div> : groupedModels.map(([provider, models]) => <section key={provider} aria-label={`${provider} 模型`}><div className="flex items-center justify-between border-b border-t border-border/60 bg-muted/25 px-4 py-2 text-xs font-semibold"><span>{provider}</span><span className="tabular-nums text-muted-foreground">{models.length}</span></div>{models.map((model) => <ModelRow key={`${model.localInstalled ? "local" : "remote"}:${provider}:${model.id}`} model={model} imported={model.localInstalled === true && !model.disabled} busy={busyIds.includes(model.id)} canManage={model.managed === true || !model.localInstalled || isDesktop()} onSwitchChange={(checked) => void toggleImport(model, checked)} onRemove={() => requestRemoveModel(model)} />)}{provider.toLowerCase() === "openai" && <div className="flex items-center justify-between border-t border-border/60 bg-muted/15 px-4 py-3"><span className="text-xs font-medium">全选</span><Switch checked={openAiAllEnabled} onCheckedChange={(checked) => void toggleOpenAiGroup(checked)} disabled={openAiBusy || busyIds.some((id) => openAiModels.some((model) => model.id === id)) || demoModeEnabled || openAiModels.some((model) => model.localInstalled && !model.managed && !isDesktop())} aria-label="打开或关闭 OPENAI 全部模型" title={openAiAllEnabled ? "关闭 OPENAI 全部模型" : "打开 OPENAI 全部模型"} /></div>}</section>)}</CardContent>
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

  </div>;
}
