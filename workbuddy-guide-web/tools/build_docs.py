#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 workbuddy 资料包里的原始文档（PDF / DOCX / MD / CSV / TXT）解析成结构化数据，
输出到 ../content/ ：docs-index.js（目录，含大纲与摘要）与 docs-gN.js（正文，按资料包分组）。

v2 相比 v1 的变化：
  1. PDF 按页抽取，块里带页码标记 ["pg", n]，扫描页自动走 OCR 缓存（tools/ocr_cache.py 产物）；
  2. 每篇文档带 sa（摘要，取首个有效段落）、pkgs（同一文件出现在哪些资料包）、dupOf（正文重复指向）；
  3. 同一份内容同时存在 docx / pdf / md / txt 时按正文指纹去重，只保留一份可检索正文；
  4. 目录与正文分离：目录文件小，可先渲染；正文按资料包分文件，页面按需加载。

用法：
    python tools/build_docs.py            # 全量重建
    python tools/build_docs.py --dry      # 只打印统计，不写文件

依赖：pypdf、python-docx；扫描页 OCR 另需 rapidocr-onnxruntime、pypdfium2（见 tools/ocr_cache.py）
"""
import os
import re
import sys
import json
import hashlib
import collections

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
ROOT = os.path.dirname(SITE)
OUT = os.path.join(SITE, "content")

sys.path.insert(0, HERE)
try:
    import ocr_cache
except Exception:                                    # OCR 依赖没装时也要能跑
    ocr_cache = None

PKG_DIRS = [
    ("《WorkBuddy 使用手册与实战指南》236页", "旗舰手册"),
    ("WorkBuddy 基础手册", "基础手册"),
    ("WorkBuddy128页速通手册", "128页速通包"),
    ("WORKBUDDY 保姆级学习手册+视频", "保姆级手册"),
    ("WorkBuddy_x_ima_全套", "WorkBuddy × ima"),
]
EXTS = (".pdf", ".docx", ".md", ".txt", ".csv")
# 正文重复时，优先保留哪种格式（可编辑、结构最全的排前面）
FMT_RANK = {".docx": 0, ".md": 1, ".csv": 2, ".txt": 3, ".pdf": 4}
OCR_MIN_CHARS = 20          # 单页可提取字符少于此值 → 当作扫描页，走 OCR 缓存

NOISE = [
    re.compile(r"^\d+\s*/\s*\d+$"),
    re.compile(r"^第\s*\d+\s*页$"),
    re.compile(r"^截图扫码添加我进社群学习$"),
    re.compile(r"^打磨院未来职场人才社区$"),
    re.compile(r"^（内容由AI生成，仅供参考）$"),
    re.compile(r"^!?\[[^\]]*图片缺失[^\]]*\]$"),
    re.compile(r"^\[图片占位[:：].*\]$"),
    re.compile(r"^!\[\]\(.*\)$"),
    re.compile(r"^<video[^>]*>.*</video>$"),
    re.compile(r"^```.*$"),
    re.compile(r"^(flowchart|graph|sequenceDiagram|stateDiagram|stateDiagram-v2)\b.*$"),
    re.compile(r"^(participant|subgraph|end$|direction)\b.*$"),
    re.compile(r"^[A-Za-z]*\s*-->.*$"),
    re.compile(r"^\.\.\.$"),
]
MERMAID_LINE = re.compile(r"^\s*[A-Za-z0-9_\[\]{}()\/\-\.\|]+\s*(-->|->>|-->>|---)\s*")

HEAD_PATTERNS = [
    (1, re.compile(r"^(第\s*[一二三四五六七八九十百零\d]+\s*[章节篇]|CHAPTER\s*\d+|第\s*\d+\s*章)")),
    (2, re.compile(r"^([一二三四五六七八九十]+、)")),
    (3, re.compile(r"^(\d+\.\d+(\.\d+)?)\s*\S")),
    (2, re.compile(r"^(模块[一二三四五六七]|阶段\s*\d|路线[A-Z]|附录[A-Z－\-]?)")),
]
BULLET = re.compile(r"^(?:[•·▪◦●○\-–—*]\s+|[（(]\s*\d+\s*[）)]|\d+[.、）)]\s*|·\s*)")
SENT_END = "。！？；：”』」）)%"


def clean_line(s):
    s = s.replace("\u3000", " ").replace("\x00", "")
    s = re.sub(r"[ \t]+", " ", s).strip()
    return s


def is_noise(s):
    if not s:
        return True
    for p in NOISE:
        if p.match(s):
            return True
    if MERMAID_LINE.match(s):
        return True
    if len(s) <= 2 and not re.search(r"[\u4e00-\u9fa5]", s):
        return True
    return False


def detect_heading(s):
    """返回 (level, text) 或 None"""
    if len(s) > 40:
        return None
    for lv, pat in HEAD_PATTERNS:
        if pat.match(s):
            return (lv, s)
    return None


def flush(buf, blocks):
    """把累积的散文行合并成段落"""
    if not buf:
        return
    text = "".join(buf)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) >= 8:
        blocks.append(["p", text])
    buf.clear()


def blocks_from_lines(lines):
    """行序列 → blocks（PDF / TXT 用）"""
    blocks, buf = [], []
    for raw in lines:
        s = clean_line(raw)
        if is_noise(s):
            continue
        # PDF 换行多在句子中间，只有当上一行已收尾、这一行又很短时，才当作新段落开头
        if buf and len(s) <= 30 and buf[-1][-1:] in tuple("。！？!?；"):
            flush(buf, blocks)
        h = detect_heading(s)
        if h:
            flush(buf, blocks)
            blocks.append(["h", h[0], h[1]])
            continue
        if BULLET.match(s):
            flush(buf, blocks)
            blocks.append(["li", BULLET.sub("", s).strip()])
            continue
        if len(s) <= 22 and re.match(r"^[^\u4e00-\u9fa5A-Za-z0-9]*[\u4e00-\u9fa5]{2,12}$", s) and not buf:
            blocks.append(["h", 3, s])
            continue
        buf.append(s)
    flush(buf, blocks)
    return blocks


def blocks_from_markdown(text):
    blocks, buf = [], []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i].rstrip()
        s = clean_line(raw)
        if s.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:\-|]+\|?$", clean_line(lines[i + 1])):
            flush(buf, blocks)
            rows = [[c.strip() for c in s.strip("|").split("|")]]
            i += 2
            while i < len(lines) and clean_line(lines[i]).startswith("|"):
                rows.append([c.strip() for c in clean_line(lines[i]).strip("|").split("|")])
                i += 1
            blocks.append(["tb", rows])
            continue
        m = re.match(r"^(#{1,5})\s+(.+)$", raw)
        if m:
            flush(buf, blocks)
            blocks.append(["h", min(len(m.group(1)), 4), clean_line(m.group(2))])
            i += 1
            continue
        if re.match(r"^[-*+]\s+", s) or re.match(r"^\d+\.\s+", s):
            flush(buf, blocks)
            blocks.append(["li", re.sub(r"^([-*+]|\d+\.)\s+", "", s)])
            i += 1
            continue
        if is_noise(s):
            i += 1
            continue
        buf.append(s)
        i += 1
    flush(buf, blocks)
    return blocks


def blocks_from_docx(path):
    import docx
    d = docx.Document(path)
    blocks = []
    for p in d.paragraphs:
        s = clean_line(p.text)
        if not s or is_noise(s):
            continue
        style = (p.style.name or "").lower()
        m = re.search(r"(heading|标题)\s*(\d)", style)
        if m:
            blocks.append(["h", min(int(m.group(2)), 4), s])
        elif style.startswith("list") or BULLET.match(s):
            blocks.append(["li", BULLET.sub("", s).strip()])
        else:
            h = detect_heading(s)
            if h:
                blocks.append(["h", h[0], h[1]])
            else:
                blocks.append(["p", s])
    for t in d.tables:
        rows = [[clean_line(c.text) for c in row.cells] for row in t.rows]
        if rows:
            blocks.append(["tb", rows])
    return blocks


def blocks_from_csv(path):
    import csv
    with open(path, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    rows = [[c.strip() for c in r] for r in rows if any(c.strip() for c in r)]
    return [["tb", rows]] if rows else []


def blocks_from_pdf(path, key):
    """按页抽取；某页几乎没字就当作扫描页，取 OCR 缓存（有就合并进来）"""
    from pypdf import PdfReader
    reader = PdfReader(path)
    pages, ocr_pages = [], []
    for i, pg in enumerate(reader.pages):
        try:
            raw = pg.extract_text() or ""
        except Exception:
            raw = ""
        if len(raw.strip()) < OCR_MIN_CHARS and ocr_cache is not None:
            cached = ocr_cache.read_cache(key, i)
            if cached and cached.strip():
                raw = cached
                ocr_pages.append(i + 1)
        pages.append(blocks_from_lines(raw.splitlines()))
    return pages, len(reader.pages), ocr_pages


def drop_running_headers(blocks):
    """去掉在文中反复出现的页眉页脚（同一段落出现 4 次以上且很短）

    短文档（如 2 页 FAQ）里整页文字可能都是重复行，一刀切会删成空篇，
    所以删完若正文缩水到不足原来三成，就保留原文。
    """
    cnt = collections.Counter()
    for b in blocks:
        if b[0] in ("p", "li") and len(b[1]) < 60:
            cnt[b[1]] += 1
    keep = []
    for b in blocks:
        if b[0] in ("p", "li") and cnt.get(b[1], 0) >= 4 and len(b[1]) < 60:
            continue
        keep.append(b)
    if blocks_chars(keep) * 3 < blocks_chars(blocks):
        return blocks
    return keep


def block_text(b):
    if b[0] == "tb":
        return " ".join(" ".join(c for c in row) for row in b[1])
    if b[0] == "pg":
        return ""
    return b[-1]


def blocks_chars(blocks):
    return sum(len(block_text(b)) for b in blocks)


def read_text_file(path):
    for enc in ("utf-8-sig", "utf-8", "gbk", "utf-16"):
        try:
            with open(path, encoding=enc) as f:
                return f.read()
        except Exception:
            continue
    return ""


def extract(path, key):
    """返回 {blocks, pages, ocrPages}"""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        pages_blocks, pages, ocr_pages = blocks_from_pdf(path, key)
        blocks = []
        for i, pb in enumerate(pages_blocks):
            if not pb:
                continue
            blocks.append(["pg", i + 1])
            blocks.extend(pb)
        return {"blocks": drop_running_headers(blocks), "pages": pages, "ocrPages": ocr_pages}
    if ext == ".docx":
        return {"blocks": blocks_from_docx(path), "pages": None, "ocrPages": []}
    if ext == ".md":
        blocks = blocks_from_markdown(read_text_file(path))
        return {"blocks": drop_running_headers(blocks), "pages": None, "ocrPages": []}
    if ext == ".txt":
        blocks = blocks_from_lines(read_text_file(path).splitlines())
        return {"blocks": drop_running_headers(blocks), "pages": None, "ocrPages": []}
    if ext == ".csv":
        return {"blocks": blocks_from_csv(path), "pages": None, "ocrPages": []}
    return {"blocks": [], "pages": None, "ocrPages": []}


def fingerprint(blocks):
    """正文指纹：去掉页码标记后取前 240 字 + 总字数档位，用来识别同一内容的不同格式"""
    text = re.sub(r"\s+", "", "".join(block_text(b) for b in blocks))
    if not text:
        return ""
    return hashlib.md5(text[:240].encode("utf-8")).hexdigest() + "|" + str(len(text) // 200)


def scan_files():
    """遍历五套资料包，按文件指纹合并同一份文件的多处拷贝。

    同一个 PDF 往往同时躺在「自己的资料包」和另一个包的 09_ 子目录里，
    所以归属规则是：路径层级最浅处为这个文件的主资料包（子目录里的通常是拷贝），
    同级时按资料包顺序；其余出现位置记在 rels / pkgNames 里。
    """
    by_key = {}
    order = []
    for pkg_i, (dirname, pkg_name) in enumerate(PKG_DIRS, start=1):
        base = os.path.join(ROOT, dirname)
        if not os.path.isdir(base):
            print("!! 目录不存在:", base)
            continue
        found = []
        for dp, dn, fn in os.walk(base):
            for f in fn:
                if f.lower().endswith(EXTS):
                    found.append(os.path.join(dp, f))
        for path in sorted(found):
            key = ocr_cache.file_key(path) if ocr_cache else hashlib.md5(open(path, "rb").read()).hexdigest()
            rel = os.path.relpath(path, ROOT)
            sight = {"path": path, "rel": rel, "pkg": pkg_i, "pkgName": pkg_name,
                     "depth": rel.count(os.sep)}
            if key in by_key:
                by_key[key]["sights"].append(sight)
                continue
            item = {"key": key, "sights": [sight]}
            by_key[key] = item
            order.append(item)

    result = []
    for item in order:
        sights = sorted(item["sights"], key=lambda s: (s["depth"], s["pkg"], s["rel"]))
        primary = sights[0]
        result.append({
            "path": primary["path"], "rel": primary["rel"],
            "pkg": primary["pkg"], "pkgName": primary["pkgName"],
            "pkgNames": list(dict.fromkeys(s["pkgName"] for s in sights)),
            "rels": [s["rel"] for s in sights],
            "key": item["key"],
        })
    return result


def main():
    dry = "--dry" in sys.argv
    items = scan_files()

    # 1) 逐文件抽取正文
    entries = []
    for it in items:
        data = extract(it["path"], it["key"])
        ext = os.path.splitext(it["path"])[1].lower()
        entries.append({
            "title": os.path.splitext(os.path.basename(it["path"]))[0],
            "rel": it["rel"], "rels": it["rels"],
            "pkg": it["pkg"], "pkgName": it["pkgName"], "pkgNames": it["pkgNames"],
            "type": ext.lstrip("."),
            "pages": data["pages"], "ocrPages": data["ocrPages"],
            "blocks": data["blocks"],
            "fp": fingerprint(data["blocks"]),
        })

    # 2) 同一正文的多格式版本（docx / pdf / md / txt）只留格式最好的那份可检索
    groups = {}
    for e in entries:
        if e["fp"] and e["blocks"]:
            groups.setdefault(e["fp"], []).append(e)
    for grp in groups.values():
        grp.sort(key=lambda e: FMT_RANK.get("." + e["type"], 9))
        primary = grp[0]
        for dup in grp[1:]:
            dup["dupOf"] = primary
            dup["blocks"] = []

    # 3) 按资料包 + 路径排序后分配 id，把重复指向换成 id
    entries.sort(key=lambda e: (e["pkg"], e["rel"]))
    for i, d in enumerate(entries, start=1):
        d["id"] = "d%03d" % i
    for d in entries:
        if isinstance(d.get("dupOf"), dict):
            d["dupOf"] = d["dupOf"]["id"]
        d["chars"] = blocks_chars(d["blocks"])
    docs = entries

    # 摘要
    for d in docs:
        sa = ""
        for b in d["blocks"]:
            if b[0] == "p" and len(b[1]) >= 12:
                sa = b[1]
                break
        if not sa:
            for b in d["blocks"]:
                if b[0] in ("li", "h"):
                    sa = b[-1]
                    break
        d["sa"] = sa[:140]
        d["outline"] = [[b[1], b[2]] for b in d["blocks"] if b[0] == "h"][:150]

    total_chars = sum(d["chars"] for d in docs)
    for d in docs:
        flag = "OCR%3d页" % len(d["ocrPages"]) if d["ocrPages"] else ""
        print("%-5s %-5s %7d 字符 %6s 页  %-14s %s %s"
              % (d["id"], d["type"], d["chars"],
                 d["pages"] if d["pages"] else "-", d["pkgName"], d["title"][:40], flag))
    print("\n文档数: %d  总字符: %d  扫描页(OCR): %d"
          % (len(docs), total_chars, sum(len(d["ocrPages"]) for d in docs)))
    empty = [d for d in docs if not d["blocks"]]
    if empty:
        print("空正文: %d 篇 → %s" % (len(empty), "、".join(d["title"][:20] for d in empty)))
    if dry:
        return

    os.makedirs(OUT, exist_ok=True)

    index = []
    for d in docs:
        index.append({
            "id": d["id"], "title": d["title"], "rel": d["rel"], "rels": d["rels"],
            "pkg": d["pkg"], "pkgName": d["pkgName"], "pkgNames": d["pkgNames"],
            "type": d["type"], "chars": d["chars"], "pages": d["pages"],
            "ocr": len(d["ocrPages"]), "sa": d["sa"],
            "dup": d.get("dupOf"),
            "blocks": len(d["blocks"]), "outline": d["outline"],
        })
    head = "/* 自动生成：tools/build_docs.py —— 文档目录（不含正文）*/\n"
    with open(os.path.join(OUT, "docs-index.js"), "w", encoding="utf-8") as f:
        f.write(head + "window.WB_DOC_INDEX = " + json.dumps(index, ensure_ascii=False, separators=(",", ":")) + ";\n")

    for pkg_i, (_, pkg_name) in enumerate(PKG_DIRS, start=1):
        group = [{"id": d["id"], "title": d["title"], "blocks": d["blocks"]}
                 for d in docs if d["pkg"] == pkg_i and d["blocks"]]
        fn = "docs-g%d.js" % pkg_i
        body = json.dumps(group, ensure_ascii=False, separators=(",", ":"))
        with open(os.path.join(OUT, fn), "w", encoding="utf-8") as f:
            f.write("/* 自动生成：tools/build_docs.py —— %s 正文 */\n"
                    "window.WB_DOCS = (window.WB_DOCS || []);\n"
                    "window.WB_DOCS = window.WB_DOCS.concat(%s);\n" % (pkg_name, body))
        print("写出 %-14s %7.1f KB  (%d 篇)" % (fn, len(body.encode("utf-8")) / 1024, len(group)))

    idx_size = os.path.getsize(os.path.join(OUT, "docs-index.js"))
    print("写出 %-14s %7.1f KB  (%d 篇)" % ("docs-index.js", idx_size / 1024, len(index)))


if __name__ == "__main__":
    main()
