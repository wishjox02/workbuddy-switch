import { useEffect, useMemo, useState } from "react";
import { BookOpen, Check, ChevronLeft, ChevronRight, Clipboard, ExternalLink, FileText, Search, ShieldCheck, Sparkles, WandSparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type GuideStep = {
  id: string;
  number: string;
  title: string;
  summary: string;
  icon: typeof BookOpen;
  sections: { title: string; body: string; bullets?: string[] }[];
};

const steps: GuideStep[] = [
  {
    id: "start",
    number: "01",
    title: "先建立正确认知",
    summary: "WorkBuddy 是能读文件、调工具、交付结果的桌面 AI 工作台，不只是聊天窗口。",
    icon: BookOpen,
    sections: [
      { title: "四层能力", body: "模型负责理解，Agent 负责推进，Skill 提供做法，连接器把结果送到外部系统。人负责边界、权限和最终验收。" },
      { title: "三种工作模式", body: "先从低风险开始，再逐步开放写入权限。", bullets: ["问一问：只读资料，适合摸清现状和风险。", "想一想：先给步骤、文件清单和风险，等你确认。", "做一做：执行读写、命令和交付，适合已确认的任务。"] },
      { title: "一次任务的合格结果", body: "第二次做同类任务时少解释，成品能直接进入流程，并且能说明来源、变更和验收方式。" },
    ],
  },
  {
    id: "task",
    number: "02",
    title: "完成第一个任务",
    summary: "用六字段任务单，把模糊目标变成可执行、可检查的工作。",
    icon: WandSparkles,
    sections: [
      { title: "六字段任务单", body: "每次开工前补齐输入、目标、边界、过程、输出和验收。复杂任务先让 WorkBuddy 复述一遍。", bullets: ["输入：文件、链接、数据范围和已有结论。", "目标：最终要解决的业务问题。", "边界：不要改什么、不要外发什么、哪些结论不能猜。", "过程：先盘点，再处理；先草稿，再写回。", "输出：文件格式、保存位置、命名规则。", "验收：准确、完整、可追溯、能复跑。"] },
      { title: "可直接复制的起手式", body: "请先扫描当前工作区，列出可用文件、缺失信息和风险。不要修改文件。确认后再按：整理 → 草稿 → 人工检查 → 写回 的顺序执行。最后报告改了哪些文件、保存在哪里、还有什么未完成。" },
      { title: "推荐的首个练习", body: "把一个文件夹按类型和主题生成整理方案，只读预览，确认后再复制到新目录。这个练习能覆盖工作区、文件读取、输出命名和人工确认。" },
    ],
  },
  {
    id: "workspace",
    number: "03",
    title: "文件、工作区与权限",
    summary: "把工作范围和写入边界说清楚，AI 才能稳定地处理真实资料。",
    icon: FileText,
    sections: [
      { title: "工作区原则", body: "按项目或客户分开工作区；桌面外的资料默认不可见。先确认目录，再开始扫描，避免把私人或过期资料混进结果。" },
      { title: "高风险动作必须分段", body: "涉及删除、覆盖、批量改名、外发、系统写入时，先生成预览或副本。原件保留，输出放到新目录，完成后再人工抽样。" },
      { title: "文件类任务检查表", body: "用这四个问题收尾：是否覆盖原件？是否有遗漏？格式和命名是否一致？结果能否由另一位同事复核？" },
    ],
  },
  {
    id: "skills",
    number: "04",
    title: "Skill、连接器与知识库",
    summary: "把一次性指令沉淀成团队可复用的做法，越用越稳定。",
    icon: Sparkles,
    sections: [
      { title: "什么时候做 Skill", body: "同类任务每周重复、输入输出相对稳定、容易漏步骤时，把手册、模板、脚本、参考资料和验收规则放进一个 Skill。" },
      { title: "连接器与 MCP", body: "连接外部系统前先定义权限、写入范围和失败处理。只读查询先跑通，确认字段和去重规则后再允许写回。" },
      { title: "知识库回存闭环", body: "资料进入知识库前去重、标注来源和日期；任务结束后把事实、决定、推测、待办分开保存，避免把临时答案变成长期事实。" },
    ],
  },
  {
    id: "scenes",
    number: "05",
    title: "从岗位场景开始",
    summary: "先挑重复、耗时、容易验收的环节，再逐步扩大自动化范围。",
    icon: Clipboard,
    sections: [
      { title: "普通办公", body: "会议纪要、周报、邮件草稿、PPT 大纲、Excel 汇总适合从 L1 辅助开始。输出必须带来源、负责人和截止时间。" },
      { title: "产品、运营与销售", body: "反馈聚类、竞品证据库、内容改写、客户调研、方案初稿适合用固定模板和证据表，不能把推测写成客户承诺。" },
      { title: "研发、财务与法务", body: "代码理解、测试矩阵、合同差异、发票整理可以让 AI 加速资料处理；金额、条款、发布和专业结论必须由负责人确认。" },
      { title: "成长路线", body: "L1 单次辅助 → L2 固定任务卡 → L3 Skill/知识库/连接器 → L4 专家团和自动化。不是每个任务都需要做到 L4。" },
    ],
  },
  {
    id: "safety",
    number: "06",
    title: "验收与持续改进",
    summary: "把结果、风险和成本记录下来，才能放心复用和自动化。",
    icon: ShieldCheck,
    sections: [
      { title: "四项验收", body: "准确性：事实和数字有来源；完整性：没有漏掉关键文件或字段；时效性：使用了正确版本；安全性：权限、隐私和外发范围符合要求。" },
      { title: "高风险边界", body: "医疗、法律、财税、投资、招聘决策、生产权限和对外发布，都应保留专业人员或负责人最终确认。" },
      { title: "每周复盘", body: "记录成功案例、失败原因、人工补救、耗时和成本。把稳定步骤更新进任务卡或 Skill，把不稳定的自动化退回人工确认。" },
    ],
  },
];

const sceneCards = [
  ["会议纪要", "转写 + 纪要模板", "事实、决定、待办和未决问题分开"],
  ["文件整理", "工作区 + 文件 Skill", "先预览和复制，不覆盖原件"],
  ["Excel 对账", "数据分析", "主键、口径、异常和金额守恒"],
  ["内容创作", "证据包 + 内容 Skill", "引用、版本和版权可追溯"],
];

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("任务模板已复制");
  } catch {
    toast.error("复制失败，请手动选择文本");
  }
}

export default function GuidePage() {
  const [activeId, setActiveId] = useState("start");
  const [query, setQuery] = useState("");
  const [sourceStatus, setSourceStatus] = useState("内置资料");
  const activeIndex = steps.findIndex((step) => step.id === activeId);
  const active = steps[activeIndex] ?? steps[0];
  const filteredSteps = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return steps;
    return steps.filter((step) => `${step.title} ${step.summary} ${step.sections.map((section) => `${section.title} ${section.body}`).join(" ")}`.toLowerCase().includes(text));
  }, [query]);

  useEffect(() => {
    if (typeof window === "undefined" || "__TAURI_INTERNALS__" in window) return;
    fetch("/api/guide", { headers: { Accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("guide unavailable"))))
      .then((payload: { updatedAt?: string; data?: { updatedAt?: string } }) => {
        const updatedAt = payload.updatedAt ?? payload.data?.updatedAt;
        if (updatedAt) setSourceStatus(`资料同步于 ${updatedAt}`);
      })
      .catch(() => undefined);
  }, []);

  function selectStep(id: string) {
    setActiveId(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return <div className="wb-page mx-auto w-full max-w-[1180px] min-w-0 px-4 py-6 sm:px-8 sm:py-9">
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
      <div className="grid gap-0 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="relative overflow-hidden bg-[#103c32] px-6 py-8 text-white sm:px-10 sm:py-11">
          <div className="absolute -right-20 -top-20 size-64 rounded-full border border-white/10" aria-hidden="true" />
          <div className="relative max-w-xl">
            <div className="mb-4 flex items-center gap-2 text-sm font-medium text-emerald-100"><BookOpen className="size-4" />WorkBuddy 使用向导</div>
            <h1 className="max-w-lg text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">把 AI 从“会聊天”带到“能交付”</h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-emerald-50/80 sm:text-base">从第一次提问，到文件处理、知识沉淀、岗位工作流和自动化，按六个步骤建立一套可复用的工作方法。</p>
            <div className="mt-7 flex flex-wrap items-center gap-3 text-xs text-emerald-100/75"><span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5">6 个步骤</span><span>{sourceStatus}</span></div>
          </div>
        </div>
        <div className="hidden min-h-56 bg-[#e5f1e7] lg:block">
          <img src="/guide/workbuddy-workspace.png" alt="WorkBuddy 工作台示意" className="h-full w-full object-cover" />
        </div>
      </div>
    </section>

    <div className="mt-6 grid gap-6 lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="self-start lg:sticky lg:top-24">
        <div className="rounded-xl border border-border/70 bg-card p-3 shadow-sm">
          <label className="relative block"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索章节或关键词" className="h-9 pl-9 text-sm" /></label>
          <nav className="mt-3 grid gap-1" aria-label="向导章节">
            {filteredSteps.map((step) => { const Icon = step.icon; const selected = step.id === active.id; return <button key={step.id} type="button" onClick={() => selectStep(step.id)} className={`flex min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${selected ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}><span className={`flex size-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold ${selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{selected ? <Icon className="size-3.5" /> : step.number}</span><span className="min-w-0 truncate">{step.title}</span></button>; })}
          </nav>
          {filteredSteps.length === 0 && <p className="px-2 py-5 text-center text-xs text-muted-foreground">没有匹配的章节</p>}
        </div>
        <div className="mt-3 hidden rounded-xl border border-border/70 bg-card p-4 text-xs leading-5 text-muted-foreground shadow-sm sm:block"><div className="mb-2 flex items-center gap-2 font-medium text-foreground"><ShieldCheck className="size-4 text-primary" />阅读建议</div>先完成第 1、2 步，再把你每周重复的任务放进第 4、5 步，最后用第 6 步建立验收规则。</div>
      </aside>

      <main className="min-w-0">
        <div className="mb-5 flex items-center justify-between gap-3"><div><div className="text-xs font-medium uppercase tracking-[0.16em] text-primary">Step {active.number}</div><h2 className="mt-1 text-2xl font-semibold tracking-tight">{active.title}</h2></div><div className="flex shrink-0 items-center gap-1"><Button type="button" variant="outline" size="icon" className="size-9" onClick={() => selectStep(steps[Math.max(0, activeIndex - 1)].id)} disabled={activeIndex === 0} aria-label="上一步"><ChevronLeft className="size-4" /></Button><Button type="button" variant="outline" size="icon" className="size-9" onClick={() => selectStep(steps[Math.min(steps.length - 1, activeIndex + 1)].id)} disabled={activeIndex === steps.length - 1} aria-label="下一步"><ChevronRight className="size-4" /></Button></div></div>
        <p className="mb-6 max-w-3xl text-base leading-7 text-muted-foreground">{active.summary}</p>
        <div className="grid gap-3 sm:grid-cols-2">{active.sections.map((section) => <section key={section.title} className="rounded-xl border border-border/70 bg-card p-5 shadow-sm sm:p-6"><h3 className="text-base font-semibold">{section.title}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{section.body}</p>{section.bullets && <ul className="mt-3 space-y-2 text-sm leading-6 text-foreground">{section.bullets.map((bullet) => <li key={bullet} className="flex gap-2"><Check className="mt-1 size-4 shrink-0 text-primary" /><span>{bullet}</span></li>)}</ul>}</section>)}</div>

        {active.id === "task" && <section className="mt-4 rounded-xl border border-primary/20 bg-primary/[0.045] p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">任务卡模板</h3><p className="mt-1 text-sm text-muted-foreground">复制后替换方括号内容，先让 WorkBuddy 复述再执行。</p></div><Button type="button" size="sm" variant="outline" onClick={() => void copyText("目标：[要解决的问题]\n输入：[文件/链接/范围]\n边界：不修改原件，不外发，不能猜测\n步骤：先盘点和给方案，确认后再执行\n输出：[格式、目录、命名]\n验收：[准确、完整、来源、人工检查]")}><Clipboard className="size-4" />复制模板</Button></div><pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-lg bg-background/80 p-4 text-sm leading-6 text-foreground">{`目标：[要解决的问题]\n输入：[文件/链接/范围]\n边界：不修改原件，不外发，不能猜测\n步骤：先盘点和给方案，确认后再执行\n输出：[格式、目录、命名]\n验收：[准确、完整、来源、人工检查]`}</pre></section>}

        {active.id === "scenes" && <section className="mt-4"><div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-semibold">场景速查</h3><span className="text-xs text-muted-foreground">从低风险、可验收的任务开始</span></div><div className="grid gap-3 sm:grid-cols-2">{sceneCards.map(([title, entry, check]) => <div key={title} className="rounded-xl border border-border/70 bg-card p-4 shadow-sm"><div className="text-sm font-semibold">{title}</div><div className="mt-1 text-xs font-medium text-primary">{entry}</div><div className="mt-2 text-xs leading-5 text-muted-foreground">{check}</div></div>)}</div></section>}

        <div className="mt-6 flex items-center justify-between gap-3 border-t border-border/60 pt-5"><span className="text-xs text-muted-foreground">内容整理自 WorkBuddy 使用手册、基础手册与速通资料</span>{activeIndex < steps.length - 1 && <Button type="button" onClick={() => selectStep(steps[activeIndex + 1].id)}>下一步<ChevronRight /></Button>}{activeIndex === steps.length - 1 && <a className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline" href="https://www.workbuddy.ai" target="_blank" rel="noreferrer">查看官方入口<ExternalLink className="size-3.5" /></a>}</div>
      </main>
    </div>
  </div>;
}
