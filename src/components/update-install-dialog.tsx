import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";

import { DemoAction } from "@/components/demo-action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import * as api from "@/lib/api";
import { useUpdateState } from "@/lib/use-update-state";
import { serviceDisplayText } from "@/lib/admin-backend";

interface UpdateInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 统一更新弹窗：只展示 Rust 更新状态机（与托盘菜单同源）的阶段与进度。
 *
 * 阶段与进度来自 `update-state` 订阅，不再自己调用 `@tauri-apps/plugin-updater`；
 * 下载 / 重启都只是把动作交给后端（`updateDownload` / `updateRestart`），状态由后端
 * 持有——关掉弹窗再打开，看到的仍是同一阶段与进度。
 */
export function UpdateInstallDialog({ open, onOpenChange }: UpdateInstallDialogProps) {
  const snapshot = useUpdateState();
  const [restarting, setRestarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [manualDownloading, setManualDownloading] = useState(false);
  const [manualPercent, setManualPercent] = useState<number | null>(null);

  const phase = snapshot.phase;
  const targetVersion = snapshot.latest ?? "新版本";
  const percent = snapshot.percent;
  const busy = phase === "checking" || phase === "downloading" || manualDownloading;
  const error = serviceDisplayText(actionError ?? snapshot.message ?? "未知更新错误");

  useEffect(() => {
    if (!open) return;
    // 每次打开重置本地动作态：阶段与错误文案都由快照承载。
    setRestarting(false);
    setActionError(null);
    setManualDownloading(false);
    setManualPercent(null);
  }, [open]);

  async function startDownload() {
    setActionError(null);
    try {
      if (snapshot.manualUrl) {
        if (!snapshot.manualSha256) throw new Error("更新包缺少校验值");
        setManualDownloading(true);
        setManualPercent(0);
        await api.downloadAndInstallManualUpdate(
          snapshot.manualUrl,
          snapshot.manualSha256,
          targetVersion,
          setManualPercent,
        );
      }
      else await api.updateDownload();
    } catch (e) {
      setManualDownloading(false);
      setActionError(`下载更新失败：${api.asError(e)}`);
    }
  }

  /** 与托盘一致：已知目标版本则重试下载，否则重试检查。 */
  async function retry() {
    if (snapshot.phase === "error" && snapshot.latest && !snapshot.manualUrl) {
      await startDownload();
      return;
    }
    setActionError(null);
    try {
      const result = await api.checkUpdate(undefined, true);
      if (!result.ok) {
        setActionError(result.message || result.error || "检查更新失败");
      }
    } catch (e) {
      setActionError(`检查更新失败：${api.asError(e)}`);
    }
  }

  async function restartApp() {
    setRestarting(true);
    setActionError(null);
    try {
      await api.updateRestart();
    } catch (e) {
      setRestarting(false);
      setActionError(`重启失败：${api.asError(e)}`);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (busy || restarting)) return;
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!busy && !restarting}>
        <DialogHeader>
          <DialogTitle>
            {phase === "checking" && "正在检查更新"}
            {phase === "downloading" && `正在升级到 v${targetVersion}`}
            {phase === "idle" && "检查更新"}
            {phase === "upToDate" && "当前已是最新版本"}
            {phase === "available" && "发现新版本"}
            {phase === "readyToRestart" && "更新已就绪"}
            {phase === "error" && "拉取更新失败"}
          </DialogTitle>
          <DialogDescription>
            {phase === "checking" && "正在从后台检查最新版本，请稍候。"}
            {manualDownloading && "正在下载更新包，下载完成后将静默安装并自动重启。"}
            {phase === "downloading" &&
              "请不要关闭应用，更新包下载完成后由你决定何时重启安装。"}
            {phase === "idle" && "尚未检查版本。"}
            {phase === "upToDate" && "后台没有可用的新版本。"}
            {phase === "available" && !manualDownloading && `发现新版本 v${targetVersion}。`}
            {phase === "readyToRestart" && "更新包已下载，重启应用后完成安装并生效。"}
            {phase === "error" && "检查或下载更新失败，请重试。"}
          </DialogDescription>
        </DialogHeader>

        {phase === "checking" && (
          <div className="flex items-center gap-2 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在连接后台版本服务…
          </div>
        )}

        {manualDownloading && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin text-primary" />
                下载更新包
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {manualPercent === null ? "下载中…" : `${manualPercent}%`}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${manualPercent ?? 30}%` }} />
            </div>
          </div>
        )}

        {phase === "downloading" && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin text-primary" />
                下载更新包
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {percent === null ? "下载中…" : `${percent}%`}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${percent ?? 30}%` }}
              />
            </div>
          </div>
        )}

        {phase === "readyToRestart" && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800">
            v{targetVersion} 已准备完成，重启应用后生效。
          </div>
        )}

        {phase === "error" && (
          <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p className="text-destructive">{error}</p>
          </div>
        )}

        {actionError && phase !== "error" && <p className="text-sm text-destructive">{serviceDisplayText(actionError)}</p>}

        <DialogFooter>
          {phase === "available" && !manualDownloading && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
              <DemoAction>
                <Button onClick={() => void startDownload()}>
                  <Download />
                  下载更新包
                </Button>
              </DemoAction>
            </>
          )}
          {phase === "readyToRestart" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={restarting}>
                立即关闭
              </Button>
              <DemoAction>
                <Button onClick={() => void restartApp()} disabled={restarting}>
                  {restarting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {restarting ? "正在重启…" : "重启以完成升级"}
                </Button>
              </DemoAction>
            </>
          )}
          {phase === "error" && (
            <>
              <DemoAction>
                <Button onClick={() => void retry()}>
                  <RefreshCw />
                  重试
                </Button>
              </DemoAction>
            </>
          )}
          {(phase === "idle" || phase === "upToDate") && <Button onClick={() => void retry()}><RefreshCw />检查更新</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
