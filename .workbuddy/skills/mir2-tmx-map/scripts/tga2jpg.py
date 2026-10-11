#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
批量把传奇地图素材的 .tga 转成 .jpg
- 保持原有目录结构（镜像到输出根目录）
- RGBA -> RGB（已确认全部 alpha=255，无实际透明像素）
- 质量 95、关闭色度抽样（subsampling=0），保证像素画边缘不糊
- 输出同名 .jpg，生成 manifest.csv 索引
"""
import os
import sys
import csv
import time
from multiprocessing import Pool
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

SRC = sys.argv[1]
DST = sys.argv[2]
QUALITY = 95

# ---------- 收集任务 ----------
def collect(src):
    jobs = []
    for dp, dn, fn in os.walk(src):
        if ".workbuddy" in dp.split(os.sep):
            continue
        for f in fn:
            if f.lower().endswith(".tga"):
                full = os.path.join(dp, f)
                rel = os.path.relpath(full, src)
                jobs.append((full, rel))
    return jobs

# ---------- 单文件转换 ----------
def convert(job):
    src_path, rel = job
    dst_path = os.path.join(DST, os.path.splitext(rel)[0] + ".jpg")
    try:
        os.makedirs(os.path.dirname(dst_path), exist_ok=True)
        with Image.open(src_path) as im:
            w, h = im.size
            mode = im.mode
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                # 全部 alpha=255，直接取 RGB
                im = im.convert("RGB")
            else:
                im = im.convert("RGB")
            im.save(dst_path, "JPEG", quality=QUALITY, subsampling=0,
                    optimize=True, progressive=False)
        size = os.path.getsize(dst_path)
        return (rel, w, h, mode, dst_path, size, None)
    except Exception as e:
        return (rel, 0, 0, "", dst_path, 0, str(e))


def main():
    t0 = time.time()
    jobs = collect(SRC)
    print(f"发现 {len(jobs)} 个 TGA 文件，输出到: {DST}", flush=True)
    os.makedirs(DST, exist_ok=True)

    results = []
    errs = []
    with Pool(8) as pool:
        for i, r in enumerate(pool.imap_unordered(convert, jobs, chunksize=16), 1):
            results.append(r)
            if r[6]:
                errs.append(r)
            if i % 500 == 0 or i == len(jobs):
                print(f"  进度 {i}/{len(jobs)}  ({time.time()-t0:.1f}s)", flush=True)

    # manifest
    manifest = os.path.join(DST, "manifest.csv")
    with open(manifest, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["相对路径", "分组目录", "文件名", "宽度", "高度",
                    "原始模式", "输出文件", "字节数", "状态"])
        for rel, ww, hh, mode, dst_path, size, err in sorted(results):
            group = os.path.dirname(rel).split(os.sep)[0]
            w.writerow([rel, group, os.path.basename(rel), ww, hh, mode,
                        os.path.basename(dst_path), size,
                        "OK" if not err else "ERR:" + err])

    print(f"\n完成: 成功 {len(results)-len(errs)} / 失败 {len(errs)}，"
          f"耗时 {time.time()-t0:.1f}s", flush=True)
    print(f"索引文件: {manifest}", flush=True)
    for e in errs[:20]:
        print("  ERR", e[0], e[6], flush=True)


if __name__ == "__main__":
    main()
