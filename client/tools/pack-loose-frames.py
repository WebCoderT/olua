#!/usr/bin/env python3
"""
散帧打包器：把散列帧目录打包成 Cocos plist 图集（「动画帧全部 plist」的收尾工具）

- 目标目录：resources 下「同一目录内 >= 2 张散帧 png（无同名 plist 配对）」的目录，
  目前只剩 titles/sfx_* 与 war-soul/sfx_*（整包循环特效动画）；
  其余多 png 目录（icon / map tileset / 独立图片）不是帧序列，本脚本按显式传入的目录工作，不乱扫。
- 产物：<目录>/<目录名>.plist + <目录名>.png（帧名 = 原文件名，帧序号排序逻辑不变）。
  帧不裁边（offset 0 / sourceSize = 原始尺寸），打包器只做排布，不碰像素内容。
- 原始散帧连同 .meta 移入仓库根 _loose_frames_archive/<tree>/（gitignored，#235 惯例），不删数据。
- .meta 由 Cocos 编辑器下次聚焦时自动生成（本脚本不伪造 uuid）。

用法：
  python3 client/tools/pack-loose-frames.py titles/sfx_13009 war-soul/sfx_13001   # 显式列目录（相对 resources）
  python3 client/tools/pack-loose-frames.py --all                                 # 打包 titles/ war-soul/ 全部散帧目录
"""

import os
import re
import shutil
import sys
from math import ceil

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RESOURCES = os.path.join(REPO, "client", "assets", "resources")
ARCHIVE = os.path.join(REPO, "_loose_frames_archive")
PLIST_HEADER = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>frames</key>
\t<dict>
"""
PLIST_FOOTER = """\t</dict>
\t<key>metadata</key>
\t<dict>
\t\t<key>format</key>
\t\t<integer>2</integer>
\t\t<key>realTextureFileName</key>
\t\t<string>{texture}</string>
\t\t<key>size</key>
\t\t<string>{{{tw},{th}}}</string>
\t\t<key>textureFileName</key>
\t\t<string>{texture}</string>
\t</dict>
</dict>
</plist>
"""


def frame_order(name: str) -> int:
    """帧序号：去扩展名取末尾连续数字（与客户端 FrameOrder.getFrameOrder 同口径）"""
    match = re.search(r"(\d+)$", os.path.splitext(name)[0])
    return int(match.group(1)) if match else 0


def loose_frames(directory: str):
    """目录里的散帧 png（无同名 plist 配对的才算散帧；配对的是图集纹理）"""
    files = os.listdir(directory)
    plists = {os.path.splitext(f)[0] for f in files if f.lower().endswith(".plist")}
    return sorted(
        (f for f in files if f.lower().endswith(".png") and os.path.splitext(f)[0] not in plists),
        key=frame_order,
    )


def pack(directory: str) -> bool:
    name = os.path.basename(directory)
    frames = loose_frames(directory)
    if not frames:
        return False
    atlas_plist = os.path.join(directory, f"{name}.plist")
    if os.path.exists(atlas_plist):
        print(f"  跳过（已有同名图集）：{directory}")
        return False

    images = [(f, Image.open(os.path.join(directory, f)).convert("RGBA")) for f in frames]
    # 简单货架排布：按高度降序逐行放，行内从左到右（特效帧数少，排布损失可忽略）
    ordered = sorted(images, key=lambda item: item[1].height, reverse=True)
    row_capacity = max(1, ceil(len(ordered) ** 0.5))
    rows, row, row_width, row_height = [], [], 0, 0
    for frame_name, image in ordered:
        if len(row) >= row_capacity and row:
            rows.append((row_width, row_height, row))
            row, row_width, row_height = [], 0, 0
        row.append((frame_name, image))
        row_width += image.width
        row_height = max(row_height, image.height)
    if row:
        rows.append((row_width, row_height, row))
    tex_width = max(width for width, _, _ in rows)
    tex_height = sum(height for _, height, _ in rows)

    texture = Image.new("RGBA", (tex_width, tex_height), (0, 0, 0, 0))
    entries, y = [], 0
    for _, row_height, row in rows:
        x = 0
        for frame_name, image in row:
            texture.paste(image, (x, y))
            w, h = image.size
            # frame=贴图内矩形 / offset=0 / sourceSize=原始尺寸（不裁边，帧内容一个像素不动）
            entries.append(
                f"\t\t<key>{frame_name}</key>\n"
                f"\t\t<dict>\n"
                f"\t\t\t<key>frame</key><string>{{{{{x},{y}}},{{{w},{h}}}}}</string>\n"
                f"\t\t\t<key>offset</key><string>{{0,0}}</string>\n"
                f"\t\t\t<key>rotated</key><false/>\n"
                f"\t\t\t<key>sourceColorRect</key><string>{{{{0,0}},{{{w},{h}}}}}</string>\n"
                f"\t\t\t<key>sourceSize</key><string>{{{w},{h}}}</string>\n"
                f"\t\t</dict>"
            )
            x += w
        y += row_height

    plist = PLIST_HEADER + "\n".join(entries) + "\n" + PLIST_FOOTER.format(texture=f"{name}.png", tw=tex_width, th=tex_height)
    with open(atlas_plist, "w", encoding="utf-8") as handle:
        handle.write(plist)
    texture.save(os.path.join(directory, f"{name}.png"))

    # 散帧移入归档（连同 .meta）
    tree = os.path.relpath(directory, RESOURCES).split(os.sep)[0]
    archive_dir = os.path.join(ARCHIVE, tree, os.path.relpath(directory, os.path.join(RESOURCES, tree)))
    os.makedirs(archive_dir, exist_ok=True)
    for frame_name, _ in images:
        for suffix in ("", ".meta"):
            source = os.path.join(directory, frame_name + suffix)
            if os.path.exists(source):
                shutil.move(source, os.path.join(archive_dir, frame_name + suffix))
    print(f"  打包 {len(images)} 帧 -> {atlas_plist}（{tex_width}x{tex_height}）")
    return True


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    if args[0] == "--all":
        targets = [
            os.path.join(RESOURCES, tree, entry)
            for tree in ("titles", "war-soul")
            for entry in sorted(os.listdir(os.path.join(RESOURCES, tree)))
            if os.path.isdir(os.path.join(RESOURCES, tree, entry))
        ]
    else:
        targets = [os.path.join(RESOURCES, arg) for arg in args]
    packed = sum(1 for target in targets if os.path.isdir(target) and pack(target))
    print(f"完成：{packed} 个目录打出图集")


if __name__ == "__main__":
    main()
