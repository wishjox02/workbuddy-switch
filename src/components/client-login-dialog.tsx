import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, MessageCircle, Phone, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { LegalAgreementDialog } from "@/components/legal-agreement-dialog";
import { fetchLoginCaptcha, loginWithCode, sendLoginCode, type ClientUser, type LoginCaptcha } from "@/lib/auth";
import { type LegalDocument } from "@/lib/legal";

export function ClientLoginDialog({ open, onOpenChange, onLoggedIn }: { open: boolean; onOpenChange: (open: boolean) => void; onLoggedIn: (user: ClientUser) => void }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [captcha, setCaptcha] = useState<LoginCaptcha | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [captchaError, setCaptchaError] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [captchaOpen, setCaptchaOpen] = useState(false);
  const [pendingPhone, setPendingPhone] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [legalDocument, setLegalDocument] = useState<LegalDocument | null>(null);
  const dialogGeneration = useRef(0);
  const loginAbort = useRef<AbortController | null>(null);

  useEffect(() => () => { loginAbort.current?.abort(); }, []);

  function reset() {
    dialogGeneration.current += 1;
    loginAbort.current?.abort();
    loginAbort.current = null;
    setPhone(""); setCode(""); setChallengeId(""); setMaskedPhone(""); setBusy(false); setSending(false);
    setCaptcha(null); setCaptchaAnswer(""); setCaptchaError(""); setCaptchaLoading(false); setCaptchaOpen(false); setPendingPhone(""); setAgreed(false); setLegalDocument(null);
  }

  function requireAgreement(): boolean {
    if (agreed) return true;
    toast.error("请先阅读并同意用户服务协议和隐私政策");
    return false;
  }

  function normalizedPhone(): string | null {
    const normalized = phone.trim().replace(/[\s()-]/g, "");
    if (!/^\+?[0-9]{6,20}$/.test(normalized)) { toast.error("请输入有效手机号"); return null; }
    return normalized;
  }

  async function sendCode(phoneValue: string, captchaValue?: { captchaId: string; captchaAnswer: string }): Promise<boolean> {
    const generation = dialogGeneration.current;
    setSending(true);
    try {
      const result = await sendLoginCode(phoneValue, captchaValue);
      if (generation !== dialogGeneration.current) return false;
      setPhone(phoneValue); setChallengeId(result.challengeId); setMaskedPhone(result.phoneMasked); setCaptchaOpen(false); setCaptcha(null); setCaptchaAnswer(""); setPendingPhone("");
      toast.success("验证码已发送");
      return true;
    } catch (error) {
      if (generation !== dialogGeneration.current) return false;
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (generation === dialogGeneration.current) setSending(false);
    }
  }

  async function requestCode() {
    if (!requireAgreement()) return;
    const phoneValue = normalizedPhone();
    if (!phoneValue || captchaLoading || sending || challengeId) return;
    const generation = dialogGeneration.current;
    setCaptchaLoading(true); setCaptchaError(""); setPendingPhone(phoneValue);
    try {
      const result = await fetchLoginCaptcha();
      if (generation !== dialogGeneration.current) return;
      if (!result) {
        await sendCode(phoneValue);
        return;
      }
      setCaptcha(result); setCaptchaAnswer(""); setCaptchaOpen(true);
    } catch (error) {
      if (generation === dialogGeneration.current) toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === dialogGeneration.current) setCaptchaLoading(false);
    }
  }

  async function refreshCaptcha() {
    if (captchaLoading || sending) return;
    const generation = dialogGeneration.current;
    setCaptchaLoading(true); setCaptchaError("");
    try {
      const result = await fetchLoginCaptcha();
      if (generation !== dialogGeneration.current) return;
      if (!result) { setCaptchaOpen(false); setCaptcha(null); return; }
      setCaptcha(result); setCaptchaAnswer("");
    } catch (error) {
      if (generation === dialogGeneration.current) setCaptchaError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === dialogGeneration.current) setCaptchaLoading(false);
    }
  }

  async function confirmCaptcha() {
    if (!captcha || !pendingPhone || sending) return;
    const answer = captchaAnswer.trim();
    const valid = captcha.imageDataUrl ? /^[a-zA-Z0-9]{1,8}$/.test(answer) : /^\d{1,8}$/.test(answer);
    if (!valid) { setCaptchaError(captcha.imageDataUrl ? "请输入图片中的字符" : "请输入数字验证答案"); return; }
    const generation = dialogGeneration.current;
    setCaptchaError("");
    const sent = await sendCode(pendingPhone, { captchaId: captcha.captchaId, captchaAnswer: answer });
    if (!sent && dialogGeneration.current === generation) await refreshCaptcha();
  }

  async function submit() {
    if (!requireAgreement()) return;
    if (!challengeId || !code.trim()) { toast.error("请先获取并输入验证码"); return; }
    const generation = dialogGeneration.current;
    const controller = new AbortController();
    loginAbort.current = controller;
    setBusy(true);
    try {
      const user = await loginWithCode(phone.trim(), challengeId, code.trim(), controller.signal);
      if (generation !== dialogGeneration.current) return;
      if (user.sub2apiSync?.error) toast.warning("登录成功，但模型服务尚未同步完成，请稍后在模型页面重试同步。");
      else if (user.sub2apiSync?.apiKeyReady) toast.success(`登录成功，已创建用户 API Key，可用模型 ${user.sub2apiSync.modelCount || 0} 个`);
      else toast.success(user.sub2apiSync?.synced ? "登录成功，模型服务账号已同步" : "登录成功");
      onLoggedIn(user); onOpenChange(false); reset();
    } catch (error) { if (generation === dialogGeneration.current) toast.error(error instanceof Error ? error.message : String(error)); }
    finally { if (generation === dialogGeneration.current) { loginAbort.current = null; setBusy(false); } }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) reset(); }}>
      <DialogContent className="sm:max-w-md">
        {captchaOpen ? (
          <>
            <DialogHeader>
              <DialogTitle>验证后发送短信</DialogTitle>
              <DialogDescription>完成安全验证后，后台才会向 {pendingPhone} 发送短信验证码。</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2"><Label htmlFor="client-login-captcha">安全验证</Label><div className="flex items-center gap-2"><span className="flex h-10 w-[132px] shrink-0 items-center justify-center overflow-hidden rounded-md border border-input bg-muted/40 px-2 text-sm font-medium tabular-nums" aria-live="polite">{captchaLoading ? <Loader2 className="size-4 animate-spin" /> : captcha?.imageDataUrl ? <img src={captcha.imageDataUrl} alt="图形验证码" className="h-full w-full object-contain" /> : captcha?.question || "加载失败"}</span><Input id="client-login-captcha" className="min-w-0 flex-1" inputMode={captcha?.imageDataUrl ? "text" : "numeric"} autoComplete="off" placeholder={captcha?.imageDataUrl ? "图片中的字符" : "计算结果"} value={captchaAnswer} onChange={(event) => setCaptchaAnswer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void confirmCaptcha(); }} maxLength={8} disabled={!captcha || captchaLoading || sending} autoFocus /><Button type="button" variant="outline" size="icon" className="shrink-0" aria-label="换一题" title="换一题" onClick={() => void refreshCaptcha()} disabled={captchaLoading || sending}><RefreshCw className="size-4" /></Button></div>{captchaError && <p className="break-all text-xs text-destructive" role="alert">{captchaError}</p>}</div>
            </div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => { setCaptchaOpen(false); setCaptchaAnswer(""); setCaptchaError(""); }}>返回</Button><Button type="button" onClick={() => void confirmCaptcha()} disabled={sending || captchaLoading || !captcha}>{sending ? <Loader2 className="animate-spin" /> : "确认发送"}</Button></DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader><DialogTitle>登录小玉米</DialogTitle><DialogDescription>使用手机号验证登录。登录后可同步个人模型配置。</DialogDescription></DialogHeader>
            <div className="space-y-4 py-2"><div className="space-y-2"><Label htmlFor="client-login-phone">手机号</Label><div className="relative"><Phone className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="client-login-phone" className="pl-9" placeholder="请输入手机号" value={phone} onChange={(event) => setPhone(event.target.value)} disabled={Boolean(challengeId)} /></div></div><div className="space-y-2"><Label htmlFor="client-login-code">短信验证码</Label><div className="flex gap-2"><div className="relative min-w-0 flex-1"><MessageCircle className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="client-login-code" className="pl-9" placeholder="6 位验证码" value={code} onChange={(event) => setCode(event.target.value)} maxLength={6} /></div><Button type="button" variant="outline" className="min-w-28" onClick={() => void requestCode()} disabled={sending || busy || captchaLoading || Boolean(challengeId) || !phone.trim()}>{captchaLoading ? <Loader2 className="animate-spin" /> : "获取验证码"}</Button></div></div>{maskedPhone && <p className="text-xs text-muted-foreground">验证码已发送至 {maskedPhone}，有效期 5 分钟。</p>}<div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/25 px-3 py-2.5"><Checkbox id="client-login-agreement" checked={agreed} onCheckedChange={(checked) => setAgreed(checked === true)} className="mt-1" /><label htmlFor="client-login-agreement" className="text-xs leading-5 text-muted-foreground">我已阅读并同意 <button type="button" className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-2 hover:underline" onClick={() => setLegalDocument("terms")}><FileText className="size-3" />用户服务协议</button> 和 <button type="button" className="inline-flex items-center gap-0.5 font-medium text-primary underline-offset-2 hover:underline" onClick={() => setLegalDocument("privacy")}><ShieldCheck className="size-3" />隐私政策</button></label></div></div>
            <DialogFooter><Button type="button" variant="outline" onClick={() => { onOpenChange(false); reset(); }}>取消</Button><Button type="button" onClick={() => void submit()} disabled={busy || !challengeId}>{busy ? <Loader2 className="animate-spin" /> : null}登录</Button></DialogFooter>
          </>
        )}
      </DialogContent>
      </Dialog>
      <LegalAgreementDialog open={legalDocument !== null} document={legalDocument || "terms"} onOpenChange={(open) => { if (!open) setLegalDocument(null); }} />
    </>
  );
}
