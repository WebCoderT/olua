#!/usr/bin/env python3
"""
从官网 logo 一键生成各端应用图标（唯一来源：website/assets/icons/logo-512.png）。

覆盖的面（存在才写，不存在跳过并在结尾提示）：
  - 管理端      admin/public/{favicon.ico, logo-256.png}
  - web 构建模板 client/build-templates/web-desktop/{favicon.ico, logo-256.png, apple-touch-icon.png}
  - 原生 macOS/iOS  client/native/engine/*/ 任意 *.xcassets/AppIcon.appiconset（按 Contents.json 逐条生成）
  - 原生 Android    client/native/engine/android/ 的 mipmap-*（ic_launcher / ic_launcher_round）
  - 原生 Windows    client/native/engine/win32/ 下已有的 *.ico 原位替换

用法：make icons   （或 python3 tools/gen-app-icons.py [源图]）
依赖：python3 + Pillow（缺了会提示 pip3 install pillow）
注意：client/native 整目录在 .gitignore —— 生成结果只落本机，换机器/重新生成原生
      工程后重跑本脚本即可；仓库里版本化的只有这份脚本和官网 logo。
"""

import json
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("缺少 Pillow：先 pip3 install pillow 再重跑")

REPO = Path(__file__).resolve().parent.parent
DEFAULT_SRC = REPO / "website/assets/icons/logo-512.png"
ICO_SIZES = [16, 32, 48, 64, 128, 256]
# apple-touch-icon 必须不透明（iOS 会把透明底渲染成纯黑），垫这个底色
TOUCH_BG = (14, 14, 16, 255)
ANDROID_DPI = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

done: list[str] = []
skipped: list[str] = []


def resize(src: Image.Image, px: int) -> Image.Image:
    """缩放到 px×px；源小时允许放大（1024 档只能从 512 放大，LANCZOS 质量可接受）"""
    return src.resize((px, px), Image.LANCZOS)


def write_png(src: Image.Image, path: Path, px: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    resize(src, px).save(path, format="PNG")
    done.append(f"{path.relative_to(REPO)} ({px}×{px})")


def write_ico(src: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Pillow 会按 sizes 从源图自行缩出各档并打包成真·多尺寸 ICO
    src.save(path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    done.append(f"{path.relative_to(REPO)} ({'/'.join(str(s) for s in ICO_SIZES)})")


def write_touch_icon(src: Image.Image, path: Path, px: int = 180) -> None:
    """iOS 桌面图标：不透明底 + 居中 logo"""
    canvas = Image.new("RGBA", (px, px), TOUCH_BG)
    canvas.alpha_composite(resize(src, px))
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(path, format="PNG")
    done.append(f"{path.relative_to(REPO)} ({px}×{px} 不透明)")


def gen_appiconsets(src: Image.Image) -> None:
    """mac / iOS：凡是已生成的 AppIcon.appiconset 都按 Contents.json 逐条重画"""
    sets = sorted(REPO.glob("client/native/engine/*/*.xcassets/AppIcon.appiconset/Contents.json"))
    if not sets:
        skipped.append("mac/iOS AppIcon（native/engine 下还没有任何 xcassets）")
        return
    for contents in sets:
        entries = json.loads(contents.read_text())["images"]
        for entry in entries:
            name = entry.get("filename")
            if not name:
                continue  # 空槽位（如 watch）跳过
            size = int(entry["size"].split("x")[0]) * int(entry.get("scale", "1x").rstrip("x"))
            write_png(src, contents.parent / name, size)


def gen_android(src: Image.Image) -> None:
    res_dirs = sorted(set(p.parent for p in REPO.glob("client/native/engine/android/**/mipmap-*")))
    if not res_dirs:
        skipped.append("Android mipmap（原生工程还没生成；Cocos 首次构建 Android 后重跑）")
        return
    for res in res_dirs:
        px = ANDROID_DPI.get(res.name.removeprefix("mipmap-"))
        if px is None:
            continue  # mipmap-anydpi-v26 是自适应图标 XML，不动
        for name in ("ic_launcher.png", "ic_launcher_round.png"):
            write_png(src, res / name, px)


def gen_windows(src: Image.Image) -> None:
    icons = sorted(REPO.glob("client/native/engine/win32/**/*.ico"))
    if not icons:
        skipped.append("Windows .ico（原生工程还没生成；生成后重跑，脚本会原位替换已有 .ico）")
        return
    for ico in icons:
        write_ico(src, ico)


def main() -> None:
    src_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src_path.exists():
        sys.exit(f"源图不存在：{src_path}")
    src = Image.open(src_path).convert("RGBA")

    # —— 管理端 ——
    write_ico(src, REPO / "admin/public/favicon.ico")
    write_png(src, REPO / "admin/public/logo-256.png", 256)

    # —— web 构建模板（web-desktop；web-mobile 模板需整份 index.ejs，没建就先不管） ——
    tpl = REPO / "client/build-templates/web-desktop"
    write_ico(src, tpl / "favicon.ico")
    write_png(src, tpl / "logo-256.png", 256)
    write_touch_icon(src, tpl / "apple-touch-icon.png")

    # —— 原生各平台 ——
    gen_appiconsets(src)
    gen_android(src)
    gen_windows(src)

    print("==> 已生成")
    for line in done:
        print(f"  ✓ {line}")
    if skipped:
        print("==> 跳过（对应平台的原生工程还没生成，生成后重跑 make icons）")
        for line in skipped:
            print(f"  - {line}")


if __name__ == "__main__":
    main()
