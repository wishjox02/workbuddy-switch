#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扫描版 PDF 的 OCR 缓存器（供 build_docs.py 复用）。

为什么单独跑：
    这五套资料里有一个 212 页的手册整本是扫描图，另外旗舰手册有 28 页是图片页。
    这类页面 pypdf 抽不出一个字，必须逐页渲染成图再 OCR。单页约 20~30 秒，
    串行要一两个小时，所以这里按页并行、并按「文件指纹 + 页码」落盘缓存，
    可以随时中断重跑，已经识别过的页直接命中缓存。

用法：
    python tools/ocr_cache.py              # 只扫描还缺缓存的页并补识别（默认全部 PDF）
    python tools/ocr_cache.py --dry        # 只统计：哪些 PDF 有多少页需要 OCR
    python tools/ocr_cache.py --workers 6  # 指定并行进程数（默认 min(6, CPU-1)）

缓存位置：tools/.ocr-cache/<文件md5>/p0001.txt
"""
import argparse
import hashlib
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
ROOT = os.path.dirname(SITE)
CACHE = os.path.join(HERE, ".ocr-cache")

MIN_CHARS = 20      # 一页可提取字符少于这个数，就认为需要 OCR
DPI = 150           # 渲染分辨率；150 已足够识别中文正文，再高只是变慢

_OCR = None
_DOCS = {}


def file_key(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cache_path(key, page_idx):
    return os.path.join(CACHE, key, "p%04d.txt" % (page_idx + 1))


def read_cache(key, page_idx):
    p = cache_path(key, page_idx)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return f.read()
    return None


def pages_needing_ocr(path):
    """返回 (需要 OCR 的页码列表 0-based, 总页数)"""
    from pypdf import PdfReader
    r = PdfReader(path)
    need = []
    for i, pg in enumerate(r.pages):
        try:
            t = (pg.extract_text() or "").strip()
        except Exception:
            t = ""
        if len(t) < MIN_CHARS:
            need.append(i)
    return need, len(r.pages)


def _init_worker():
    global _OCR, _DOCS
    import numpy as np  # noqa: F401
    from rapidocr_onnxruntime import RapidOCR
    # 多进程并行时把每个进程的 ONNX 线程压到 2，避免 12 核被线程数互相抢占
    threads = int(os.environ.get("OCR_THREADS", "2") or 2)
    try:
        _OCR = RapidOCR(intra_op_num_threads=threads, inter_op_num_threads=1)
    except Exception:
        _OCR = RapidOCR()


def _ocr_one(task):
    """渲染一页 → OCR → 写缓存。返回 (path, page_idx, chars)；识别出 0 字时不落盘，留给下次重试"""
    global _OCR, _DOCS
    import numpy as np
    import pypdfium2 as pdfium
    path, key, page_idx = task
    doc = _DOCS.get(path)
    if doc is None:
        doc = pdfium.PdfDocument(path)
        _DOCS[path] = doc
    page = doc[page_idx]
    img = page.render(scale=DPI / 72).to_pil().convert("RGB")
    res, _ = _OCR(np.array(img))
    lines = []
    for item in (res or []):
        txt = (item[1] or "").strip()
        if txt:
            lines.append(txt)
    text = "\n".join(lines)
    if text.strip():
        out = cache_path(key, page_idx)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            f.write(text)
    return path, page_idx, len(text)


def collect_pdfs():
    """遍历资料包，按文件指纹去重，返回 [(path, key)]"""
    seen, out = set(), []
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in (".git", "node_modules", "workbuddy-site")]
        for f in fn:
            if not f.lower().endswith(".pdf"):
                continue
            p = os.path.join(dp, f)
            k = file_key(p)
            if k in seen:
                continue
            seen.add(k)
            out.append((p, k))
    out.sort()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="只统计，不识别")
    ap.add_argument("--workers", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0, help="本次最多识别多少页（调试用）")
    args = ap.parse_args()

    workers = args.workers or max(1, min(3, (os.cpu_count() or 4) - 2))
    # 清掉历史遗留的空缓存（识别失败时写的），让这些页重跑
    if os.path.isdir(CACHE):
        for dp, dn, fn in os.walk(CACHE):
            for f in fn:
                if f.endswith(".txt") and os.path.getsize(os.path.join(dp, f)) == 0:
                    os.remove(os.path.join(dp, f))

    tasks, plan = [], []
    for path, key in collect_pdfs():
        need, total = pages_needing_ocr(path)
        todo = [i for i in need if read_cache(key, i) is None]
        plan.append((os.path.relpath(path, ROOT), total, len(need), len(todo)))
        for i in todo:
            tasks.append((path, key, i))

    print("%-70s %5s %5s %5s" % ("PDF", "页数", "需OCR", "缺缓存"))
    for rel, total, need, todo in plan:
        if need:
            print("%-70s %5d %5d %5d" % (rel[:70], total, need, todo))
    print("\n合计需 OCR %d 页，其中缺缓存 %d 页，并行 %d 进程"
          % (sum(p[2] for p in plan), len(tasks), workers))

    if args.dry or not tasks:
        return 0
    if args.limit:
        tasks = tasks[: args.limit]

    os.makedirs(CACHE, exist_ok=True)
    t0 = time.time()

    def run(batch, tag=""):
        """跑一批页；返回失败的任务列表（失败不落盘，可以下一轮重试）"""
        done, failed = 0, []
        with ProcessPoolExecutor(max_workers=workers, initializer=_init_worker) as ex:
            futs = {ex.submit(_ocr_one, t): t for t in batch}
            for fut in as_completed(futs):
                try:
                    path, idx, chars = fut.result()
                except Exception as e:
                    failed.append(futs[fut])
                    print("!! OCR 失败:", type(e).__name__, str(e)[:90], flush=True)
                    continue
                done += 1
                el = time.time() - t0
                eta = el / done * (len(batch) - done)
                print("[%s%d/%d] %s p%d → %d 字  已用 %.0f 分  预计还需 %.0f 分"
                      % (tag, done, len(batch), os.path.basename(path)[:26], idx + 1, chars,
                         el / 60, eta / 60), flush=True)
        return failed

    failed = run(tasks)
    if failed:
        # 内存抖动导致的失败很常见，隔一会儿重试一轮
        print("\n重试 %d 页失败页…" % len(failed), flush=True)
        time.sleep(10)
        failed = run(failed, "重试 ")
    print("\nOCR 完成，用时 %.1f 分钟，仍未成功 %d 页" % ((time.time() - t0) / 60, len(failed)))
    for path, key, idx in failed:
        print("  未识别: %s p%d" % (os.path.basename(path)[:40], idx + 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
