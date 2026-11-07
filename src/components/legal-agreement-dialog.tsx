import { FileText, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LEGAL_DOCUMENTS, LEGAL_VERSION, type LegalDocument } from "@/lib/legal";

export function LegalAgreementDialog({ open, document, onOpenChange }: { open: boolean; document: LegalDocument; onOpenChange: (open: boolean) => void }) {
  const content = LEGAL_DOCUMENTS[document];
  const Icon = document === "terms" ? FileText : ShieldCheck;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Icon className="size-4 text-primary" />{content.title}</DialogTitle>
          <DialogDescription>版本 {LEGAL_VERSION}。请在登录前阅读本文件。正式上线前请由运营主体补充身份、地址和联系方式并完成法律审核。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-2 text-sm leading-6 text-muted-foreground">
          {content.sections.map((section) => <section key={section.heading}><h3 className="font-semibold text-foreground">{section.heading}</h3><p className="mt-1">{section.body}</p></section>)}
        </div>
        <DialogFooter><Button type="button" onClick={() => onOpenChange(false)}>返回登录</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
