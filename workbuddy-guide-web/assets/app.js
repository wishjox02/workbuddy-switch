/* ==========================================================================
   WorkBuddy 全景数据站 — 交互脚本
   ========================================================================== */
(function () {
  "use strict";

  const CORE = window.WB_CORE || {};
  const SC = window.WB_SCENES || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  /* ---------------- 主题 ---------------- */
  const themeBtn = $("#themeBtn");
  const themeLabel = $("#themeLabel");
  const saved = localStorage.getItem("wb-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  const syncTheme = () => {
    const dark = document.documentElement.dataset.theme !== "light";
    themeLabel.textContent = dark ? "切换浅色" : "切换深色";
  };
  syncTheme();
  themeBtn && themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("wb-theme", next);
    syncTheme();
  });

  /* ---------------- Toast ---------------- */
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
  }

  /* 复制工具：若用户正在选中文字，则忽略这次点击，避免打断复制 */
  function plainClick() {
    try {
      const sel = window.getSelection ? String(window.getSelection()) : "";
      return sel.trim().length === 0;
    } catch (e) { return true; }
  }

  function copyText(text, okMsg) {
    const done = () => toast(okMsg || "已复制");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (err) { toast("复制失败，请手动选择文本"); }
    document.body.removeChild(ta);
  }

  /* ---------------- 数字滚动 ---------------- */
  function countUp(node, target) {
    const dur = 900;
    const start = performance.now();
    function tick(now) {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = Math.round(target * eased).toLocaleString("zh-CN");
      if (p < 1) requestAnimationFrame(tick);
      else node.textContent = target.toLocaleString("zh-CN");
    }
    requestAnimationFrame(tick);
    setTimeout(() => { node.textContent = target.toLocaleString("zh-CN"); }, dur + 200);
  }

  /* ---------------- Hero ---------------- */
  const heroLead = $("#heroLead");
  if (heroLead) {
    heroLead.textContent =
      (CORE.meta && CORE.meta.intro) ||
      "把散落在多套资料里的做法重新裁剪成一张可检索的地图。";
  }

  const statsBox = $("#stats");
  if (statsBox && CORE.stats) {
    CORE.stats.forEach((s) => {
      const card = el("div", "stat stat--link");
      card.innerHTML =
        '<div class="stat__v"><i class="num">0</i><span>' + esc(s.unit) + "</span></div>" +
        '<div class="stat__k">' + esc(s.k) + "</div>" +
        '<div class="stat__n">' + esc(s.note) + "</div>";
      statsBox.appendChild(card);
      countUp($(".num", card), s.v);
      if (s.go) {
        card.setAttribute("role", "link");
        card.setAttribute("tabindex", "0");
        card.title = "点击跳到 " + s.go.replace("#", "") + " 区块";
        const jump = () => {
          if (!plainClick()) return;
          const t = document.querySelector(s.go);
          if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
        };
        card.addEventListener("click", jump);
        card.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); jump(); }
        });
      }
    });
  }

  /* ---------------- 01 产品认知 ---------------- */
  const posBox = $("#positions");
  if (posBox && CORE.positions) {
    CORE.positions.forEach((p) => {
      const c = el("div", "card");
      c.innerHTML =
        '<span class="tagline">' + esc(p.tag) + "</span>" +
        '<h3 style="margin-top:7px">' + esc(p.t) + "</h3>" +
        "<p>" + esc(p.d) + "</p>";
      posBox.appendChild(c);
    });
  }

  const modeBox = $("#modes");
  if (modeBox && CORE.modes) {
    CORE.modes.forEach((m) => {
      const c = el("div", "mode");
      c.dataset.en = m.en;
      const cls = m.risk === "低" ? "chip--mint" : m.risk === "中" ? "chip--amber" : "chip--rose";
      c.innerHTML =
        '<span class="chip ' + cls + ' mode__risk">风险 ' + esc(m.risk) + "</span>" +
        '<h3 style="font-size:16px">' + esc(m.name) + '<small style="font-family:var(--mono);color:var(--dim);font-size:11px;margin-left:7px">' + esc(m.en) + "</small></h3>" +
        '<p style="font-size:13px;color:var(--txt-2);margin-top:8px">' + esc(m.desc) + "</p>" +
        '<p style="font-size:12.5px;color:var(--dim);margin-top:10px">适用：' + esc(m.use) + "</p>";
      modeBox.appendChild(c);
    });
  }

  const modBox = $("#modules");
  if (modBox && CORE.modules) {
    CORE.modules.forEach((m) => {
      const c = el("div", "card");
      c.innerHTML =
        '<span class="tagline">' + esc(m.i) + "</span>" +
        '<h3 style="margin-top:6px">' + esc(m.n) + "</h3>" +
        "<p>" + esc(m.d) + "</p>";
      modBox.appendChild(c);
    });
  }

  const pkgRows = $("#pkgRows");
  if (pkgRows && CORE.packages) {
    CORE.packages.forEach((p) => {
      const tr = el("tr");
      tr.innerHTML =
        "<td><b>" + esc(p.n) + "</b></td><td style='white-space:nowrap;color:var(--mint)'>" +
        esc(p.vol) + "</td><td>" + esc(p.got) + "</td>";
      pkgRows.appendChild(tr);
    });
  }

  const factRows = $("#factRows");
  if (factRows && CORE.facts) {
    CORE.facts.forEach((f) => {
      const tr = el("tr");
      tr.innerHTML = "<td><b>" + esc(f.k) + "</b></td><td>" + esc(f.v) + "</td><td>" + esc(f.d) + "</td>";
      factRows.appendChild(tr);
    });
  }

  /* ---------------- 02 能力六层 ---------------- */
  const layerList = $("#layerList");
  if (layerList && CORE.layers) {
    CORE.layers.forEach((l) => {
      const d = el("div", "layer");
      d.innerHTML =
        '<div class="layer__lv">L' + l.lv + "</div>" +
        "<div>" +
        '<h3>' + esc(l.n) + "<small>" + esc(l.d) + "</small></h3>" +
        "<p>例：" + esc(l.ex) + "</p>" +
        '<div class="layer__fail">' + esc(l.fail) + "</div>" +
        "</div>";
      layerList.appendChild(d);
    });
  }

  /* ---------------- 03 场景矩阵 ---------------- */
  const state = { cat: "all", aud: "all", q: "", limit: 30 };
  const catPills = $("#catPills");
  const audPills = $("#audPills");
  const sceneGrid = $("#sceneGrid");
  const sceneCount = $("#sceneCount");
  const sceneSummary = $("#sceneSummary");
  const catMap = {};
  (SC.categories || []).forEach((c) => (catMap[c.key] = c));

  function buildPills(host, items, getKey, getName, extra, onPick, activeKey) {
    host.innerHTML = "";
    const all = el("button", "pill" + (activeKey === "all" ? " on" : ""), "全部");
    all.type = "button";
    all.addEventListener("click", () => onPick("all"));
    host.appendChild(all);
    items.forEach((it) => {
      const key = getKey(it);
      const b = el(
        "button",
        "pill" + (activeKey === key ? " on" : ""),
        esc(getName(it)) + (extra ? "<small>" + esc(extra(it)) + "</small>" : "")
      );
      b.type = "button";
      b.addEventListener("click", () => onPick(key));
      host.appendChild(b);
    });
  }

  function countByCat() {
    const m = {};
    (SC.scenes || []).forEach((s) => (m[s.c] = (m[s.c] || 0) + 1));
    return m;
  }
  const catCounts = countByCat();

  function renderCatPills() {
    buildPills(
      catPills,
      SC.categories || [],
      (c) => c.key,
      (c) => c.name,
      (c) => catCounts[c.key] || 0,
      (k) => {
        state.cat = k; state.limit = 30; renderScenes();
        if (k !== "all") syncForgeTo(k);   // 让指令工坊跟着分类走
      },
      state.cat
    );
  }

  function renderAudPills() {
    buildPills(
      audPills,
      SC.audiences || [],
      (a) => a.key,
      (a) => a.name,
      null,
      (k) => { state.aud = k; renderScenes(); renderForge(); },
      state.aud
    );
  }

  function currentScenes() {
    const q = state.q.trim().toLowerCase();
    return (SC.scenes || []).filter((s) => {
      if (state.cat !== "all" && s.c !== state.cat) return false;
      if (!q) return true;
      const cat = catMap[s.c] ? catMap[s.c].name : "";
      return (s.n + s.g + s.o + s.k + cat).toLowerCase().includes(q);
    });
  }

  function renderScenes() {
    if (!sceneGrid) return;
    renderCatPills();
    renderAudPills();
    const list = currentScenes();
    const shown = list.slice(0, state.limit);
    sceneGrid.innerHTML = "";

    shown.forEach((s) => {
      const cat = catMap[s.c] || { name: s.c, color: "#7f8ba3" };
      const card = el("div", "scene");
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.title = "点击用这个场景生成指令";
      card.innerHTML =
        '<div class="scene__top">' +
          '<div class="scene__name">' + esc(s.n) + "</div>" +
          '<div class="scene__cat" style="color:' + cat.color + ';border-color:' + cat.color + '55">' + esc(cat.name) + "</div>" +
        "</div>" +
        '<div class="scene__goal">' + esc(s.g) + "</div>" +
        '<div class="scene__meta"><b>交付</b><span>' + esc(s.o) + "</span></div>" +
        '<div class="scene__foot">' +
          '<span class="scene__warn">⚠ ' + esc(s.k) + "</span>" +
          '<span style="display:flex;gap:6px">' +
            '<button class="linkbtn" type="button" data-orig="' + esc(s.n) + '">查原文</button>' +
            '<button class="linkbtn" type="button">生成指令</button>' +
          "</span>" +
        "</div>";
      const use = () => {
        if (!plainClick()) return;          // 用户正在选文字时不打断
        syncForgeTo(s.c, s.n);
        $("#prompts").scrollIntoView({ behavior: "smooth", block: "start" });
        toast("已切到「" + s.n + "」");
      };
      $$(".linkbtn", card).forEach((btn) => {
        if (btn.hasAttribute("data-orig")) {
          btn.addEventListener("click", (ev) => { ev.stopPropagation(); goSource(s.n); });
        } else {
          btn.addEventListener("click", (ev) => { ev.stopPropagation(); use(); });
        }
      });
      card.addEventListener("click", use);
      card.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); use(); }
      });
      sceneGrid.appendChild(card);
    });

    if (list.length > state.limit) {
      const row = el("div", "more-row");
      const btn = el("button", "linkbtn", "再显示 30 个（还有 " + (list.length - state.limit) + " 个）");
      btn.type = "button";
      btn.addEventListener("click", () => { state.limit += 30; renderScenes(); });
      row.appendChild(btn);
      sceneGrid.appendChild(row);
    }

    if (sceneCount) sceneCount.textContent = list.length + " / " + (SC.scenes || []).length;
    if (sceneSummary) {
      const aud = (SC.audiences || []).find((a) => a.key === state.aud);
      const total = list.length * (SC.audiences || []).length;
      sceneSummary.textContent =
        "当前筛选 " + list.length + " 个场景 · 展开为 " + total + " 条受众组合" +
        (aud ? " · 语气取向：" + aud.hint : "");
    }
  }

  const sceneSearch = $("#sceneSearch");
  if (sceneSearch) {
    let t;
    sceneSearch.addEventListener("input", (e) => {
      clearTimeout(t);
      const v = e.target.value;
      t = setTimeout(() => { state.q = v; state.limit = 30; renderScenes(); }, 120);
    });
  }

  /* ---------------- 04 指令工坊 ---------------- */
  const forgeCat = $("#forgeCat");
  const forgeScene = $("#forgeScene");
  const forgeVersions = $("#forgeVersions");
  const forgeOut = $("#forgeOut");
  const forgeMeta = $("#forgeMeta");
  let forgeVer = (SC.versions && SC.versions[0] && SC.versions[0].key) || "fast";
  let forgeIndex = 0;

  function fillCatSelect() {
    if (!forgeCat) return;
    forgeCat.innerHTML = "";
    (SC.categories || []).forEach((c) => {
      const o = el("option", null, c.name);
      o.value = c.key;
      forgeCat.appendChild(o);
    });
  }

  function renderForgeScenes(catKey, keepName) {
    if (!forgeScene) return;
    forgeScene.innerHTML = "";
    (SC.scenes || [])
      .filter((s) => s.c === catKey)
      .forEach((s) => {
        const o = el("option", null, s.n);
        o.value = s.n;
        forgeScene.appendChild(o);
        if (keepName && s.n === keepName) o.selected = true;
      });
  }

  function renderVersionPills() {
    if (!forgeVersions) return;
    forgeVersions.innerHTML = '<span class="forge__label">口径</span>';
    (SC.versions || []).forEach((v) => {
      const b = el(
        "button",
        "pill" + (forgeVer === v.key ? " on" : ""),
        esc(v.name) + '<small>' + esc(v.tag) + "</small>"
      );
      b.type = "button";
      b.title = v.desc;
      b.addEventListener("click", () => { forgeVer = v.key; forgeIndex = 0; renderForge(); });
      forgeVersions.appendChild(b);
    });
  }

  function buildPrompt(scene, ver) {
    if (!scene || !ver) return "";
    let text = ver.tpl
      .replace("{n}", scene.n)
      .replace("{g}", scene.g)
      .replace("{o}", scene.o);
    const aud = (SC.audiences || []).find((a) => a.key === state.aud);
    if (aud) {
      text += "\n\n使用者身份：" + aud.name + "（" + aud.hint + "）。请按这个身份调整详略与措辞。";
    }
    text += "\n\n验收提示：" + scene.k + "。";
    return text;
  }

  function renderForge() {
    if (!forgeOut) return;
    const catKey = forgeCat.value;
    if (!forgeScene.value && forgeScene.options.length) forgeScene.selectedIndex = 0;
    const name = forgeScene.value;
    const scene = (SC.scenes || []).find((s) => s.c === catKey && s.n === name);
    const ver = (SC.versions || []).find((v) => v.key === forgeVer);
    const text = buildPrompt(scene, ver);
    forgeOut.textContent = text;
    renderVersionPills();
    const idx = (SC.scenes || []).indexOf(scene) + 1;
    forgeMeta.textContent =
      "第 " + (idx || 0) + " / " + (SC.scenes || []).length + " 个场景 · " +
      (ver ? ver.name : "") + (state.aud !== "all" ? " · 已叠加受众口径" : "");
  }

  if (forgeCat) {
    fillCatSelect();
    forgeCat.addEventListener("change", () => { renderForgeScenes(forgeCat.value); renderForge(); });
    forgeScene.addEventListener("change", renderForge);
    renderForgeScenes(forgeCat.value);
    renderForge();
  }

  /* 分类切换时同步指令工坊（函数声明提升，可在上方回调中安全调用） */
  function syncForgeTo(catKey, sceneName) {
    if (!forgeCat || !forgeScene) return;
    forgeCat.value = catKey;
    renderForgeScenes(catKey, sceneName);
    renderForge();
  }

  /* 动作地图 */
  const promptMap = $("#promptMap");
  if (promptMap && CORE.promptMap) {
    CORE.promptMap.forEach((g) => {
      const c = el("div", "card");
      c.style.padding = "13px 15px";
      c.innerHTML =
        "<h3 style='font-size:13.5px'>" + esc(g.g) + "<span class='chip' style='margin-left:auto'>" + g.items.length + "</span></h3>" +
        '<p style="margin-top:8px;display:flex;flex-wrap:wrap;gap:5px">' +
        g.items.map((i) => '<span class="chip" style="border-color:var(--line)">' + esc(i) + "</span>").join("") +
        "</p>";
      promptMap.appendChild(c);
    });
  }

  /* 复制与下一条 */
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy]");
    if (btn) {
      const txt = forgeOut ? forgeOut.textContent : "";
      const done = () => { btn.classList.add("done"); btn.textContent = "已复制"; toast("指令已复制，去粘贴吧"); setTimeout(() => { btn.classList.remove("done"); btn.textContent = "复制指令"; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
      } else fallbackCopy(txt, done);
    }
    const next = e.target.closest("[data-next]");
    if (next) {
      const catKey = forgeCat.value;
      const list = (SC.scenes || []).filter((s) => s.c === catKey);
      const cur = list.findIndex((s) => s.n === forgeScene.value);
      const nxt = list[(cur + 1) % list.length];
      if (nxt) {
        forgeScene.value = nxt.n;
        forgeIndex++;
        renderForge();
      }
    }
  });

  /* ---------------- 05 案例库 ---------------- */
  const casePills = $("#casePills");
  const caseGrid = $("#caseGrid");
  const caseCount = $("#caseCount");
  let caseCat = "all";

  function caseCats() {
    const m = {};
    (SC.appCases || []).forEach((c) => (m[c.c] = (m[c.c] || 0) + 1));
    return m;
  }

  function renderCases() {
    if (!caseGrid) return;
    const counts = caseCats();
    casePills.innerHTML = '<span class="filters__label">分类</span>';
    const allBtn = el("button", "pill" + (caseCat === "all" ? " on" : ""), "全部<small>" + (SC.appCases || []).length + "</small>");
    allBtn.type = "button";
    allBtn.addEventListener("click", () => { caseCat = "all"; renderCases(); });
    casePills.appendChild(allBtn);
    Object.keys(counts).forEach((k) => {
      const b = el("button", "pill" + (caseCat === k ? " on" : ""), esc(k) + "<small>" + counts[k] + "</small>");
      b.type = "button";
      b.addEventListener("click", () => { caseCat = k; renderCases(); });
      casePills.appendChild(b);
    });

    const list = (SC.appCases || []).filter((c) => caseCat === "all" || c.c === caseCat);
    caseGrid.innerHTML = "";
    list.forEach((c) => {
      const d = el("div", "case");
      d.setAttribute("role", "button");
      d.setAttribute("tabindex", "0");
      d.title = "点击复制这个做法的起手指令";
      d.innerHTML =
        "<h4>" + esc(c.n) + "<span>" + esc(c.c) + "</span></h4>" +
        "<p>" + esc(c.how) + "</p>" +
        '<p class="out">' + esc(c.out) + "</p>";
      const grab = () => {
        if (!plainClick()) return;
        copyText(
        "请按这个思路帮我完成一项同类任务：\n做法：" + c.how + "\n交付物：" + c.out +
        "\n\n执行要求：\n1) 先说明你需要我提供哪些材料，缺什么直说；\n2) 给出处理步骤和将要生成的文件名；\n3) 我确认后再执行，原文件只读，不覆盖不删除；\n4) 结果里标注不确定的地方。",
        "已复制：起手指令"
      );
      };
      d.addEventListener("click", grab);
      d.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); grab(); } });
      caseGrid.appendChild(d);
    });
    if (caseCount) caseCount.textContent = "显示 " + list.length + " 个应用案例";
  }
  renderCases();

  const deepGrid = $("#deepGrid");
  if (deepGrid && SC.deepCases) {
    SC.deepCases.forEach((d) => {
      const c = el("div", "card");
      c.innerHTML =
        '<div class="deep__lvl">' + esc(d.lvl) + "</div>" +
        "<div>" +
        "<h3>" + esc(d.n) + "</h3>" +
        '<p style="margin-top:6px"><span class="chip">' + esc(d.cap) + "</span></p>" +
        '<p style="color:var(--dim);font-size:12.5px">关键动作：' + esc(d.move) + "</p>" +
        "</div>";
      deepGrid.appendChild(c);
    });
  }

  /* ---------------- 06 专题与模板 ---------------- */
  const topicList = $("#topicList");
  if (topicList && CORE.topics) {
    CORE.topics.forEach((t, i) => {
      const li = el("li");
      li.innerHTML =
        "<b><em>" + String(i + 1).padStart(2, "0") + "</em>" + esc(t.n) + "</b>" +
        "何时用：" + esc(t.when) + "<br>" +
        '<span style="color:var(--rose)">坑：' + esc(t.pit) + "</span>";
      topicList.appendChild(li);
    });
  }

  const tplList = $("#tplList");
  if (tplList && CORE.templates) {
    const groups = {};
    CORE.templates.forEach((t) => (groups[t.g] = groups[t.g] || []).push(t));
    Object.keys(groups).forEach((g) => {
      const li = el("li");
      li.innerHTML =
        '<b><em>' + esc(g) + "</em>" + groups[g].length + " 条</b>" +
        groups[g].map((t) => "· " + esc(t.n) + "｜" + esc(t.s) + "｜<span style='color:var(--dim)'>" + esc(t.u) + "</span>").join("<br>");
      tplList.appendChild(li);
    });
  }

  /* ---------------- 07 岗位与行业 ---------------- */
  const roleRows = $("#roleRows");
  if (roleRows && CORE.roles) {
    CORE.roles.forEach((r) => {
      const tr = el("tr");
      tr.innerHTML =
        "<td><b>" + esc(r.r) + "</b></td><td>" + esc(r.first) + "</td><td>" + esc(r.second) +
        "</td><td style='color:var(--amber)'>" + esc(r.gate) + "</td>";
      roleRows.appendChild(tr);
    });
  }

  const maturity = $("#maturity");
  if (maturity && CORE.maturity) {
    CORE.maturity.forEach((m) => {
      const c = el("div", "card");
      c.innerHTML =
        '<span class="tagline">' + esc(m.lv) + "</span>" +
        '<h3 style="margin-top:6px">' + esc(m.n) + "</h3>" +
        "<p>" + esc(m.d) + "</p>" +
        '<p style="color:var(--dim);font-size:12px">升级条件：' + esc(m.next) + "</p>";
      maturity.appendChild(c);
    });
  }

  const industryGrid = $("#industryGrid");
  if (industryGrid && CORE.industries) {
    CORE.industries.forEach((it) => {
      const c = el("div", "card");
      c.innerHTML =
        "<h3>" + esc(it.n) + "</h3>" +
        '<p style="color:var(--dim);font-size:12px">工作对象：' + esc(it.obj) + "</p>" +
        '<p style="font-size:13px">' + esc(it.flow) + "</p>" +
        '<p style="color:var(--rose);font-size:12px">边界：' + esc(it.limit) + "</p>";
      industryGrid.appendChild(c);
    });
  }

  /* ---------------- 08 自动化 ---------------- */
  const autoIntake = $("#autoIntake");
  if (autoIntake && CORE.automation) {
    CORE.automation.intake.forEach((t, i) => {
      const li = el("li");
      li.innerHTML = "<em>" + String(i + 1).padStart(2, "0") + "</em>" + esc(t);
      autoIntake.appendChild(li);
    });
  }
  const autoGates = $("#autoGates");
  if (autoGates && CORE.automation) {
    CORE.automation.gates.forEach((t) => {
      const li = el("li");
      li.innerHTML = "· " + esc(t);
      autoGates.appendChild(li);
    });
  }
  const autoFlow = $("#autoFlow");
  if (autoFlow && CORE.automation) {
    CORE.automation.states.forEach((s, i) => {
      const n = el("div", "flow__node");
      n.innerHTML = "<b>" + esc(s.s) + "</b> · " + esc(s.d);
      autoFlow.appendChild(n);
      if (i < CORE.automation.states.length - 1) autoFlow.appendChild(el("span", "flow__arrow", "→"));
    });
  }
  const autoRetry = $("#autoRetry");
  if (autoRetry && CORE.automation) {
    CORE.automation.retry.forEach((r) => {
      const li = el("li");
      li.innerHTML = "<b>" + esc(r.t) + "</b>" + esc(r.r);
      autoRetry.appendChild(li);
    });
  }
  const autoMetrics = $("#autoMetrics");
  if (autoMetrics && CORE.automation) {
    CORE.automation.metrics.forEach((m, i) => {
      const li = el("li");
      li.innerHTML = "<em>" + String(i + 1).padStart(2, "0") + "</em>" + esc(m);
      autoMetrics.appendChild(li);
    });
  }

  /* ---------------- 09 知识库 ---------------- */
  const imaLibs = $("#imaLibs");
  if (imaLibs && CORE.ima) {
    CORE.ima.libs.forEach((l) => {
      const c = el("div", "card");
      c.innerHTML =
        "<h3>" + esc(l.n) + "</h3>" +
        "<p>" + esc(l.d) + "</p>" +
        '<p style="color:var(--amber);font-size:12px">注意：' + esc(l.warn) + "</p>";
      imaLibs.appendChild(c);
    });
  }
  const imaScore = $("#imaScore");
  if (imaScore && CORE.ima) {
    CORE.ima.score.forEach((s, i) => {
      const li = el("li");
      li.innerHTML = "<em>" + (i + 1) + "</em>" + esc(s);
      imaScore.appendChild(li);
    });
  }
  const imaKeep = $("#imaKeep");
  if (imaKeep && CORE.ima) {
    const li1 = el("li");
    li1.innerHTML =
      '<b style="color:var(--mint)">建议回存</b>' + CORE.ima.keep.map((k) => "· " + esc(k)).join("<br>");
    const li2 = el("li");
    li2.innerHTML =
      '<b style="color:var(--rose)">不要直接回存</b>' + CORE.ima.drop.map((k) => "· " + esc(k)).join("<br>");
    imaKeep.appendChild(li1);
    imaKeep.appendChild(li2);
  }
  const imaProbes = $("#imaProbes");
  if (imaProbes && CORE.ima) {
    CORE.ima.probes.forEach((p, i) => {
      const d = el("div", "card card--link");
      d.style.padding = "11px 14px";
      d.style.fontSize = "13px";
      d.setAttribute("role", "button");
      d.setAttribute("tabindex", "0");
      d.title = "点击复制这个问题，直接粘到知识库里问";
      d.innerHTML = '<span style="font-family:var(--mono);color:var(--dim);font-size:11px;margin-right:8px">' +
        String(i + 1).padStart(2, "0") + "</span>" + esc(p);
      const grab = () => {
        if (!plainClick()) return;
        copyText("只基于当前知识库回答：" + p + "。先给结论，再列出支持结论的资料名称；资料不足时直接说「知识库中未找到」。", "已复制体检问题");
      };
      d.addEventListener("click", grab);
      d.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); grab(); } });
      imaProbes.appendChild(d);
    });
  }

  /* ---------------- 10 路线与 FAQ ---------------- */
  const weekRoute = $("#weekRoute");
  if (weekRoute && CORE.routes) {
    CORE.routes.week.forEach((w) => {
      const li = el("li");
      li.innerHTML = "<b><em>" + esc(w.d) + "</em>" + esc(w.t) + "</b><small style='color:var(--dim)'>" + esc(w.k) + "</small>";
      weekRoute.appendChild(li);
    });
  }
  const monthRoute = $("#monthRoute");
  if (monthRoute && CORE.routes) {
    CORE.routes.month.forEach((m) => {
      const li = el("li");
      li.innerHTML = "<b><em>D" + esc(m.d) + "</em></b>" + esc(m.t);
      monthRoute.appendChild(li);
    });
  }
  const videoRoute = $("#videoRoute");
  if (videoRoute && CORE.routes) {
    CORE.routes.video.forEach((v) => {
      const li = el("li");
      li.innerHTML = "<b>" + esc(v.n) + "</b>" + esc(v.d);
      videoRoute.appendChild(li);
    });
  }
  const pickList = $("#pickList");
  if (pickList && CORE.routes) {
    CORE.routes.pick.forEach((p, i) => {
      const li = el("li");
      li.innerHTML = "<em>" + (i + 1) + "</em>" + esc(p);
      pickList.appendChild(li);
    });
  }
  const faqList = $("#faqList");
  if (faqList && CORE.faq) {
    CORE.faq.forEach((f, i) => {
      const d = el("details");
      if (i === 0) d.open = true;
      d.innerHTML = "<summary>" + esc(f.q) + "</summary><p>" + esc(f.a) + "</p>";
      faqList.appendChild(d);
    });
  }

  /* ---------------- 来源与边界 ---------------- */
  const sourceList = $("#sourceList");
  if (sourceList && CORE.sources) {
    CORE.sources.forEach((s) => {
      const a = el("a", null, esc(s.n) + " ↗");
      a.href = s.u;
      a.target = "_blank";
      a.rel = "noopener";
      sourceList.appendChild(a);
    });
  }
  const boundaryList = $("#boundaryList");
  if (boundaryList && CORE.boundaries) {
    boundaryList.innerHTML = CORE.boundaries.map((b) => "· " + esc(b)).join("<br>");
  }

  /* ---------------- 导航高亮 / 进度 / 回到顶部 ---------------- */
  const navLinks = $$("#railnav a");
  const sections = navLinks.map((a) => $(a.getAttribute("href"))).filter(Boolean);

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          navLinks.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + en.target.id));
        }
      });
    },
    { rootMargin: "-20% 0px -70% 0px", threshold: 0 }
  );
  sections.forEach((s) => io.observe(s));

  const progress = $("#progress");
  const toTop = $("#toTop");
  function onScroll() {
    const h = document.documentElement;
    const p = h.scrollTop / (h.scrollHeight - h.clientHeight || 1);
    if (progress) progress.style.width = (p * 100).toFixed(2) + "%";
    if (toTop) toTop.classList.toggle("show", h.scrollTop > 600);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  toTop && toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  /* 入场动画 */
  const revealEls = $$(".section .card, .section .mode, .section .list, .section .tablewrap, .forge, .scene, .case, .layer");
  if ("IntersectionObserver" in window) {
    const ro = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) { en.target.classList.add("in"); ro.unobserve(en.target); }
        });
      },
      { rootMargin: "0px 0px -8% 0px" }
    );
    revealEls.forEach((n, i) => {
      n.classList.add("reveal");
      n.style.transitionDelay = Math.min(i % 6, 5) * 40 + "ms";
      ro.observe(n);
    });
  }

  /* ---------------- 11 原文库 ---------------- */
  const DOC_INDEX = window.WB_DOC_INDEX || [];
  const DOC_BODY = {};
  (window.WB_DOCS || []).forEach((d) => { if (d && d.id) DOC_BODY[d.id] = d.blocks || []; });

  const docList = $("#docList");
  const docReader = $("#docReader");
  const docSearch = $("#docSearch");
  const docCountEl = $("#docCount");
  const docSummaryEl = $("#docSummary");
  const pkgPills = $("#pkgPills");
  const typePills = $("#typePills");

  const lib = { pkg: "all", type: "all", q: "", doc: null, shown: 400, focus: -1 };
  const TYPE_NAME = { pdf: "PDF", docx: "DOCX", md: "Markdown", txt: "纯文本", csv: "表格" };
  const wan = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + " 万字" : (n || 0) + " 字");

  /* 一个 block 的纯文本 */
  function blkText(b) {
    if (!b) return "";
    if (b[0] === "tb") return b[1].map((r) => r.join(" ｜ ")).join("\n");
    if (b[0] === "pg") return "";
    if (b[0] === "h") return b[2];
    return b[1] || "";
  }

  /* 会话内缓存的全文纯文本，供搜索与复制用 */
  function docPlain(id) {
    const d = DOC_INDEX.find((x) => x.id === id);
    if (!d) return "";
    if (d._plain == null) {
      d._plain = (DOC_BODY[id] || []).map((b) => {
        const t = blkText(b);
        if (!t) return "";
        if (b[0] === "h") return "## " + t;
        if (b[0] === "li") return "· " + t;
        return t;
      }).filter(Boolean).join("\n");
    }
    return d._plain;
  }

  /* 关键词高亮（先分段转义，避免 HTML 注入） */
  function mark(text, q) {
    const s = String(text == null ? "" : text);
    if (!q) return esc(s);
    const tl = s.toLowerCase(), ql = q.toLowerCase();
    let out = "", i = 0, k;
    while ((k = tl.indexOf(ql, i)) >= 0) {
      out += esc(s.slice(i, k)) + "<mark>" + esc(s.slice(k, k + q.length)) + "</mark>";
      i = k + q.length;
    }
    return out + esc(s.slice(i));
  }

  function fileHref(rel) {
    if (!rel) return "#";
    return "../" + String(rel).split(/[\\/]/).map(encodeURIComponent).join("/");
  }

  function inPkg(d) {
    if (lib.pkg === "all") return true;
    if (d.pkgName === lib.pkg) return true;
    return (d.pkgNames || []).indexOf(lib.pkg) >= 0;
  }

  function libFiltered() {
    return DOC_INDEX.filter((d) => inPkg(d) && (lib.type === "all" || d.type === lib.type));
  }

  /* 摘要 → 原文的互链：场景卡的「查原文」把词带进原文库搜一遍 */
  function goSource(q) {
    if (!docSearch) return;
    docSearch.value = q;
    lib.q = q;
    renderDocList();
    renderReader();
    const sec = $("#library");
    if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
    toast("已在原文库搜索：" + q);
  }

  function libSearch(q) {
    const ql = q.toLowerCase();
    const hits = [];
    libFiltered().forEach((d) => {
      const bs = DOC_BODY[d.id] || [];
      let count = 0, first = -1, snip = "";
      for (let i = 0; i < bs.length; i++) {
        const t = blkText(bs[i]);
        if (!t) continue;
        const p = t.toLowerCase().indexOf(ql);
        if (p >= 0) {
          count++;
          if (first < 0) {
            first = i;
            snip = (p > 26 ? "…" : "") + t.slice(Math.max(0, p - 26), p + 74);
          }
        }
      }
      if (count) hits.push({ id: d.id, d: d, count: count, first: first, snip: snip });
    });
    hits.sort((a, b) => b.count - a.count);
    return hits;
  }

  function renderPkgPills() {
    if (!pkgPills) return;
    pkgPills.innerHTML = '<span class="filters__label">资料包</span>';
    const counts = {};
    DOC_INDEX.forEach((d) => {
      const names = d.pkgNames && d.pkgNames.length ? d.pkgNames : [d.pkgName];
      names.forEach((n) => (counts[n] = (counts[n] || 0) + 1));
    });
    const mk = (key, name, n) => {
      const b = el("button", "pill" + (lib.pkg === key ? " on" : ""), esc(name) + "<small>" + n + "</small>");
      b.type = "button";
      b.addEventListener("click", () => { lib.pkg = key; lib.q = docSearch.value.trim(); renderDocList(); renderReader(); });
      pkgPills.appendChild(b);
    };
    const allBtn = el("button", "pill" + (lib.pkg === "all" ? " on" : ""), "全部<small>" + DOC_INDEX.length + "</small>");
    allBtn.type = "button";
    allBtn.addEventListener("click", () => { lib.pkg = "all"; lib.q = docSearch.value.trim(); renderDocList(); renderReader(); });
    pkgPills.appendChild(allBtn);
    Object.keys(counts).forEach((k) => mk(k, k, counts[k]));
  }

  function renderTypePills() {
    if (!typePills) return;
    typePills.innerHTML = '<span class="filters__label">格式</span>';
    const counts = {};
    DOC_INDEX.forEach((d) => (counts[d.type] = (counts[d.type] || 0) + 1));
    const allBtn = el("button", "pill" + (lib.type === "all" ? " on" : ""), "全部");
    allBtn.type = "button";
    allBtn.addEventListener("click", () => { lib.type = "all"; lib.q = docSearch.value.trim(); renderDocList(); renderReader(); });
    typePills.appendChild(allBtn);
    Object.keys(counts).sort().forEach((k) => {
      const b = el("button", "pill" + (lib.type === k ? " on" : ""), esc(TYPE_NAME[k] || k) + "<small>" + counts[k] + "</small>");
      b.type = "button";
      b.addEventListener("click", () => { lib.type = k; lib.q = docSearch.value.trim(); renderDocList(); renderReader(); });
      typePills.appendChild(b);
    });
  }

  function renderDocList() {
    if (!docList) return;
    renderPkgPills();
    renderTypePills();
    const q = lib.q.trim();
    docList.innerHTML = "";

    if (q) {
      const hits = libSearch(q);
      if (!hits.length) {
        docList.innerHTML = '<div class="lib__hint">没有命中。换个词试试，例如「连接器」「周报」「Token」「会议纪要」。</div>';
      }
      hits.slice(0, 200).forEach((h) => {
        const it = el("div", "docitem" + (lib.doc === h.id ? " on" : ""));
        it.innerHTML =
          '<div class="docitem__t">' + esc(h.d.title) + "</div>" +
          '<div class="docitem__m">' + esc(h.d.pkgName) + " · 命中 " + h.count + " 处 · " + wan(h.d.chars) + "</div>" +
          '<div class="docitem__s">' + mark(h.snip, q) + "</div>";
        it.addEventListener("click", () => openDoc(h.id, h.first));
        docList.appendChild(it);
      });
      if (docCountEl) docCountEl.textContent = hits.length + " 篇命中";
      if (docSummaryEl) {
        const total = hits.reduce((s, h) => s + h.count, 0);
        docSummaryEl.textContent = "「" + q + "」在 " + hits.length + " 篇里共命中 " + total + " 处（已按命中数排序）";
      }
      return;
    }

    const list = libFiltered();
    if (!list.length) docList.innerHTML = '<div class="lib__hint">当前条件没有文档。</div>';
    list.forEach((d) => {
      const it = el("div", "docitem" + (lib.doc === d.id ? " on" : ""));
      const meta = [d.pkgName, TYPE_NAME[d.type] || d.type, wan(d.chars)];
      if (d.pages) meta.push(d.pages + " 页");
      if (d.ocr) meta.push("OCR " + d.ocr + " 页");
      it.innerHTML =
        '<div class="docitem__t">' + esc(d.title) + "</div>" +
        '<div class="docitem__m">' + esc(meta.join(" · ")) + "</div>" +
        (d.sa ? '<div class="docitem__s">' + esc(d.sa) + "</div>" : "");
      it.addEventListener("click", () => {
        if (d.dup) { openDoc(d.dup, -1); toast("这篇内容与另一份重复，已跳到保留版"); }
        else openDoc(d.id, -1);
      });
      docList.appendChild(it);
    });
    if (docCountEl) docCountEl.textContent = list.length + " / " + DOC_INDEX.length + " 篇";
    if (docSummaryEl) {
      const chars = list.reduce((s, d) => s + (d.chars || 0), 0);
      docSummaryEl.textContent = "当前 " + list.length + " 篇 · 全文 " + wan(chars) +
        " · 五套资料原文均已解析为数据";
    }
  }

  function openDoc(id, first) {
    lib.doc = id;
    lib.shown = 400;
    lib.focus = typeof first === "number" ? first : -1;
    renderReader();
    renderDocList();
    if (lib.focus >= 0) {
      setTimeout(() => {
        const n = docReader && docReader.querySelector('[data-bi="' + lib.focus + '"]');
        if (n) {
          n.scrollIntoView({ block: "center", behavior: "smooth" });
          n.classList.add("focusblk");
          setTimeout(() => n.classList.remove("focusblk"), 2400);
        }
      }, 40);
    }
  }

  function renderBody(bs, end, q) {
    let html = "", inList = false;
    const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
    for (let i = 0; i < end; i++) {
      const b = bs[i];
      if (!b) continue;
      const t = blkText(b);
      if (b[0] === "pg") { closeList(); html += '<div class="pgmark" data-bi="' + i + '">第 ' + b[1] + " 页</div>"; continue; }
      if (b[0] === "h") {
        closeList();
        const lv = Math.min(5, Math.max(3, (b[1] || 3) + 2));
        html += "<h" + lv + ' data-bi="' + i + '">' + mark(t, q) + "</h" + lv + ">";
        continue;
      }
      if (b[0] === "li") {
        if (!inList) { html += '<ul class="reader__ul">'; inList = true; }
        html += '<li data-bi="' + i + '">' + mark(t, q) + "</li>";
        continue;
      }
      if (b[0] === "tb") {
        closeList();
        const rows = b[1] || [];
        html += '<table data-bi="' + i + '">';
        rows.forEach((r, ri) => {
          html += "<tr>";
          r.forEach((c) => {
            html += (ri === 0 ? "<th>" : "<td>") + mark(c, q) + (ri === 0 ? "</th>" : "</td>");
          });
          html += "</tr>";
        });
        html += "</table>";
        continue;
      }
      closeList();
      html += '<p data-bi="' + i + '">' + mark(t, q) + "</p>";
    }
    closeList();
    return html;
  }

  function renderReader() {
    if (!docReader) return;
    const d = DOC_INDEX.find((x) => x.id === lib.doc);
    if (!d) {
      docReader.innerHTML = '<div class="reader__empty">左侧点一篇资料，这里按页显示全文；也能用上面的搜索框直接搜到段落。</div>';
      return;
    }
    const q = lib.q.trim();
    const bs = DOC_BODY[d.id] || [];
    const title = '<div class="reader__title">' + esc(d.title) + "</div>";
    const meta = '<div class="reader__meta">' +
      '<span class="chip chip--mint">' + esc(d.pkgName) + "</span>" +
      '<span class="chip">' + esc(TYPE_NAME[d.type] || d.type) + "</span>" +
      '<span class="chip">' + wan(d.chars) + "</span>" +
      (d.pages ? '<span class="chip">' + d.pages + " 页</span>" : "") +
      (d.ocr ? '<span class="chip chip--amber">其中 ' + d.ocr + " 页 OCR 识别</span>" : "") +
      ((d.rels && d.rels.length > 1) ? '<span class="chip">另有 ' + (d.rels.length - 1) + " 处副本</span>" : "") +
      '<span class="chip" style="font-family:var(--mono)">' + esc(d.id) + "</span>" +
      "</div>";
    const bar = '<div class="reader__bar">' +
      '<button class="copy" type="button" data-doccopy="1">复制全文</button>' +
      '<a class="copy" style="display:inline-flex;align-items:center" href="' + fileHref(d.rel) +
        '" target="_blank" rel="noopener">打开原文件 ↗</a>' +
      (q ? '<button class="copy" type="button" data-docclear="1">清空搜索</button>' : "") +
      "</div>";

    if (!bs.length) {
      const dupTarget = d.dup ? DOC_INDEX.find((x) => x.id === d.dup) : null;
      docReader.innerHTML = '<div class="reader__head">' + title + meta + bar + "</div>" +
        '<div class="reader__empty">这篇与 ' +
        (dupTarget ? "「" + esc(dupTarget.title) + "」（" + esc(dupTarget.type.toUpperCase()) + "）" : "另一份资料") +
        " 内容相同，为避免重复只保留一份正文。" +
        (dupTarget ? ' <button class="linkbtn" type="button" data-docopen="' + dupTarget.id + '">去读保留版 →</button>' : "") +
        "</div>";
      return;
    }

    const end = Math.min(bs.length, Math.max(lib.shown, lib.focus + 80));
    const outline = (d.outline || []).slice(0, 14);
    const outlineHtml = (!q && outline.length)
      ? '<div class="reader__outline">' + outline.map((o) =>
          '<button type="button" data-docjump="' + esc(o[1].slice(0, 40)) + '">' + esc(o[1]) + "</button>").join("") + "</div>"
      : "";
    let body = renderBody(bs, end, q);
    if (end < bs.length) {
      body += '<div class="docmore"><button class="linkbtn" type="button" data-docmore="1">继续往下读（还有 ' +
        (bs.length - end) + " 段）</button></div>";
    }
    docReader.innerHTML = '<div class="reader__head">' + title + meta + outlineHtml + bar + "</div>" +
      '<div class="reader__body" id="docBody">' + body + "</div>";
  }

  if (docReader) {
    docReader.addEventListener("click", (e) => {
      const more = e.target.closest("[data-docmore]");
      if (more) { lib.shown += 600; renderReader(); return; }
      const cp = e.target.closest("[data-doccopy]");
      if (cp) {
        const d = DOC_INDEX.find((x) => x.id === lib.doc);
        copyText(docPlain(lib.doc), "已复制「" + (d ? d.title : "") + "」全文");
        return;
      }
      const cl = e.target.closest("[data-docclear]");
      if (cl) { docSearch.value = ""; lib.q = ""; renderDocList(); renderReader(); return; }
      const op = e.target.closest("[data-docopen]");
      if (op) { openDoc(op.getAttribute("data-docopen"), -1); return; }
      const jp = e.target.closest("[data-docjump]");
      if (jp) {
        const want = jp.getAttribute("data-docjump");
        const bs = DOC_BODY[lib.doc] || [];
        const idx = bs.findIndex((b) => b[0] === "h" && String(b[2]).slice(0, 40) === want);
        if (idx >= 0) {
          lib.shown = Math.max(lib.shown, idx + 200);
          lib.focus = idx;
          renderReader();
          setTimeout(() => {
            const n = docReader.querySelector('[data-bi="' + idx + '"]');
            if (n) n.scrollIntoView({ block: "start", behavior: "smooth" });
          }, 40);
        }
      }
    });
  }

  if (docSearch) {
    let t2;
    docSearch.addEventListener("input", (e) => {
      clearTimeout(t2);
      const v = e.target.value;
      t2 = setTimeout(() => { lib.q = v; renderDocList(); renderReader(); }, 140);
    });
  }

  if (DOC_INDEX.length) {
    renderDocList();
    renderReader();
    const firstDoc = libFiltered().find((d) => !d.dup);
    if (firstDoc) openDoc(firstDoc.id, -1);   // 默认先打开第一篇，避免右侧空着
  } else if (docReader) {
    docReader.innerHTML = '<div class="reader__empty">原文数据没有加载：请确认 content/docs-*.js 与本页在同一目录，' +
      '或运行 <code>python tools/build_docs.py</code> 重新生成。</div>';
  }

  /* 初始化 */
  renderScenes();
})();
