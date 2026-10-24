# 踩坑记录（sprite-plist-packer）

2026-10-19 全量打包 334 个动画 / 56,109 帧时实测沉淀。改动打包/校验逻辑前先读本文。

## 1. spriteOffset 的奇偶对齐（最重要的坑）

裁剪框 `(bx, by, bw, bh)` 相对原图 `(w, h)` 的偏移：

```
ox = bx + bw/2 - w/2
oy = h/2 - (by + bh/2)
```

`bx` 是整数，`bw/2`、`w/2` 可能是 `.5`。要求 `ox` 为整数 ⟺ `bw` 与 `w` **同奇偶**。

- 初版错按"裁剪宽为偶数"处理 → 画布/原图宽为奇数时偏移出现 `.5`，还原校验出现大量
  1px 错位（表面看像"重叠"或"边界 bug"，实为半像素）。
- 修复：`(bw - w) % 2 != 0` 时扩 1px（优先向右/下扩，`bx=0` 时向左扩），并夹回图内。
  高度同理。**任何改动裁剪框的代码都不能破坏这条**。

## 2. 校验必须比像素，不能比文件字节

输出 PNG 由 PIL 重编码（compress_level=6），与源文件字节必然不同。正确做法：
按 plist 还原每帧 → 与原图做 `np.array_equal`，且**只比较 alpha>0 的像素**
（`paste` 到透明画布不会改变原图全透明区域，但还原块边界外是 0，不能整图比）。

## 3. managed venv 的环境钩子导致 I/O 慢 2000 倍

`~/.workbuddy/binaries/python/envs/default/bin/python3` 正常运行时，sitecustomize 钩子
让每次文件 open 多 ~350ms（60 帧 21s；`-S` 模式 0.03s）。批量读图务必：

```bash
PYTHONPATH=~/.workbuddy/binaries/python/envs/default/lib/python3.13/site-packages \
  ~/.workbuddy/binaries/python/envs/default/bin/python3 -S script.py
```

实测：600 帧动画 86s → 0.4s。`--jobs` 多进程对这个瓶颈基本无效（瓶颈在每次 open 的钩子，
不在 CPU）。

## 4. 缩放兜底逻辑

估算总裁剪面积 ×1.15（间隙开销）> max²×0.92 时启动缩放：先按
`sqrt(max²×0.85 / total_area)` 取下限到 2 位小数，装不下再 ×0.85 重试（最多 8 次）。
缩放后 `spriteOffset`、`spriteSourceSize` 同乘 scale 后取整。校验端靠
`spriteSourceSize / 原图尺寸` 推断 scale，`scale != 1.0` 时允许重采样差异（实测 alpha
结构 IoU 0.98~0.999）。

## 5. 环境与流程

- 长进程会被 SIGTERM（exit 137）随机杀，非 OOM。批量任务用 `run_in_background` +
  断点续跑（默认跳过已有输出；重建用 `--force`）。
- 1×1 占位帧默认保留为 1×1 图块（帧序完整）；用户明确要"移除空帧"才丢弃。
- `find_animations` 用 `os.walk` + 找到含图目录后 `dirnames[:]=[]`，保证"一个目录=一个
  动画"且不递归进子动画。`Placements`、`_预览`、隐藏目录自动跳过。
- 输出目录若被用户手动改名（如光柱 1_粉色→1），脚本读实际目录名，无需干预。
- plist 的 `smartupdate` 字段只需形如 `$TexturePacker:SmartUpdate:<md5>$`，内容无实际校验作用。
- 中文联系表字体用 `/System/Library/Fonts/Hiragino Sans GB.ttc`（PingFang.ttc 在 managed
  venv 打不开，Arial 无 CJK）。
