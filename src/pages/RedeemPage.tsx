import { CircleAlert } from "lucide-react";

export default function RedeemPage() {
  return <div className="wb-page mx-auto w-full max-w-[1180px] min-w-0 px-4 py-7 sm:px-8 sm:py-10">
    <header className="mb-7">
      <h1 className="text-[28px] font-semibold">CDKY 兑换</h1>
    </header>
    <div role="status" className="flex max-w-lg items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span>兑换服务暂未开放。</span>
    </div>
  </div>;
}
