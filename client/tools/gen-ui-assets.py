#!/usr/bin/env python3
"""从 design/*.png 产出登录/选角的背景与缺失素材（一次性再生成脚本，design/ 与 resources/ 都不入库）。

两件事：
1. 背景修补：设计原图带有模板自带的烘焙 UI（按钮/条/牌），把**会被活动 UI 替换**的那几块
   用逐列插值抹掉；其余烘焙内容（主视觉、称号文字、合规标、版权行）保留 —— 它们就是设计的一部分。
2. 素材生成：抠图效果差（用户定论），改为**程序化绘制**风格一致的整套素材
   （金板按钮 / 选服条 / 名牌 / 骰子 / 圆形角钮），文字一律不上图，运行时用 Label 叠加。

用法：/Users/tz/.workbuddy/binaries/python/envs/default/bin/python client/tools/gen-ui-assets.py
（依赖 Pillow；design/*.png 由设计提供，本地存在才跑得动）
"""
from PIL import Image, ImageDraw, ImageFilter
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DESIGN = os.path.join(ROOT, "design")
RES = os.path.join(ROOT, "client", "assets", "resources")

# 设计图 652×1160 → 游戏 750×1624 的映射系数（横向 1.1503 宽度铺满；纵向 1.4 等比）
S_W, S_H = 750 / 652, 1624 / 1160


def interp_columns(img, box, pad=3):
    """逐列上下边界线性插值 + 轻模糊：盖掉贴在纹理上的 UI 块（条/按钮/牌/文字行）。"""
    x0, y0, x1, y1 = box
    top, bottom = max(y0 - pad, 0), min(y1 + pad, img.height - 1)
    px = img.load()
    for x in range(x0, x1):
        c0, c1 = px[x, top], px[x, bottom]
        span = bottom - top
        for y in range(top + 1, bottom):
            t = (y - top) / span
            px[x, y] = tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3))
    region = img.crop((x0, top, x1, bottom + 1)).filter(ImageFilter.GaussianBlur(1.5))
    img.paste(region, (x0, top))


# ---------- 背景修补 ----------

def patch_login(img):
    """登录背景：抹掉选服条与进入游戏按钮、右列功能圆钮（全部由活动 UI 重建）。
    注意右列圆钮在设计稿 x 545~650，cover 映射到 750 宽窗口后落在 x ~681~750 仍可见，必须修掉。"""
    img = img.copy()
    interp_columns(img, (150, 772, 510, 850))    # 选服条（含上下描边）
    interp_columns(img, (186, 884, 466, 986))    # 进入游戏金按钮（含装饰边）
    interp_columns(img, (541, 55, 652, 505))     # 右列功能圆钮（公告/协议/隐私协议/清除缓存）
    return img


def patch_rs(img):
    """选角背景：抹掉创建角色竖排字 / 名牌 / 骰子 / 金按钮 / Powered By / 右列菱形钮（活动 UI 重建）。
    右列（战/法/道/新职业/性别）同样部分落在 750 窗口内，必须修掉。"""
    img = img.copy()
    interp_columns(img, (0, 0, 92, 212))         # 左上「创建角色」竖排字
    interp_columns(img, (152, 866, 478, 942))    # 名牌（镖局霸业）
    interp_columns(img, (460, 858, 554, 954))    # 骰子
    interp_columns(img, (184, 954, 470, 1074))   # 进入游戏金按钮
    interp_columns(img, (108, 1078, 552, 1160))  # Powered By LayaAir Engine
    interp_columns(img, (503, 55, 649, 762))     # 右列菱形钮（战/法/道/新职业/性别；注意本图 650 宽）
    return img


# ---------- 素材生成（程序化绘制，与美术包同风格：暗底 + 金边 + 高光）----------

GOLD_HI = (247, 222, 138)   # 金·高光
GOLD = (216, 170, 74)       # 金·主体
GOLD_DEEP = (146, 100, 32)  # 金·暗部
GOLD_EDGE = (98, 62, 18)    # 金·描边
DARK = (26, 19, 14)         # 暗·底板
DARK_HI = (58, 44, 30)      # 暗·底板受光


def vgradient(size, top, bottom):
    """垂直渐变底。"""
    w, h = size
    im = Image.new("RGB", size)
    px = im.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        px_row = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = px_row
    return im


def rounded_gradient(size, radius, top, bottom, edge, edge_w, hi_line=True):
    """圆角板：垂直渐变 + 描边 + 顶部高光线（按钮/条/牌的公共底子）。2 倍尺寸输出。"""
    im = vgradient(size, top, bottom).convert("RGBA")
    w, h = size
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    # 描边：mask 腐蚀出内孔
    inner = Image.new("L", size, 0)
    ImageDraw.Draw(inner).rounded_rectangle(
        [edge_w, edge_w, w - 1 - edge_w, h - 1 - edge_w], radius=max(radius - edge_w, 2), fill=255)
    border = Image.new("RGBA", size, edge + (255,))
    border.putalpha(Image.composite(Image.new("L", size, 0), mask, inner))
    im.alpha_composite(border)
    if hi_line:
        draw = ImageDraw.Draw(im)
        draw.line([radius, edge_w + 2, w - radius, edge_w + 2], fill=GOLD_HI + (90,), width=2)
    im.putalpha(mask)
    return im


def gen_button_gold(path):
    """金板主按钮（2×552×168 → 显示 276×84）：金渐变 + 深描边 + 上下压暗。"""
    w, h = 552, 168
    im = rounded_gradient((w, h), 30, GOLD_HI, GOLD_DEEP, GOLD_EDGE, 6)
    draw = ImageDraw.Draw(im)
    # 两端压暗竖条（模板按钮的「束腰」质感）
    for x0, alpha in ((0, 70), (w - 26, 70)):
        shade = Image.new("RGBA", (26, h), (60, 34, 8, alpha))
        im.alpha_composite(shade, (x0, 0))
    # 内圈细金线
    draw.rounded_rectangle([14, 14, w - 15, h - 15], radius=22, outline=GOLD + (160,), width=2)
    im.save(path)


def gen_server_bar(path):
    """选服条（2×958×126 → 显示 479×63）：暗板金边，左侧烘一颗红宝石（文字运行时叠加）。"""
    w, h = 958, 126
    im = rounded_gradient((w, h), 24, DARK_HI, DARK, GOLD_EDGE, 4)
    draw = ImageDraw.Draw(im)
    draw.rounded_rectangle([8, 8, w - 9, h - 9], radius=18, outline=(201, 160, 90, 200), width=2)
    # 红宝石（圆形渐变 + 高光点）
    cx, cy, r = 74, h // 2, 30
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            d = (dx * dx + dy * dy) / (r * r)
            if d <= 1:
                t = 1 - d
                base = (int(120 + 110 * t), int(16 + 40 * t), int(20 + 30 * t))
                im.putpixel((cx + dx, cy + dy), base + (255,))
    draw.ellipse([cx - 12, cy - 14, cx - 2, cy - 4], fill=(255, 190, 190, 220))
    im.save(path)


def gen_name_plate(path):
    """名牌（2×800×128 → 显示 400×64）：暗板金边 + 两端束腰缺口，角色名运行时叠加。"""
    w, h = 800, 128
    im = rounded_gradient((w, h), 20, DARK_HI, DARK, GOLD_EDGE, 4)
    draw = ImageDraw.Draw(im)
    draw.rounded_rectangle([8, 8, w - 9, h - 9], radius=14, outline=(201, 160, 90, 190), width=2)
    # 两端菱形金饰
    for cx in (28, w - 28):
        draw.polygon([(cx, h // 2 - 14), (cx + 10, h // 2), (cx, h // 2 + 14), (cx - 10, h // 2)],
                     fill=GOLD + (230,))
    im.save(path)


def gen_dice(path):
    """骰子（2×180×180 → 显示 90×90）：金圆角方 + 暗色点数（5 点）。"""
    s = 180
    im = rounded_gradient((s, s), 40, GOLD_HI, GOLD_DEEP, GOLD_EDGE, 6).convert("RGBA")
    draw = ImageDraw.Draw(im)
    draw.rounded_rectangle([16, 16, s - 17, s - 17], radius=30, outline=GOLD + (170,), width=3)
    pr = 16
    for cx, cy in ((s // 2, s // 2), (48, 48), (s - 48, 48), (48, s - 48), (s - 48, s - 48)):
        draw.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=(60, 36, 10, 255))
        draw.ellipse([cx - pr + 4, cy - pr + 4, cx - pr + 10, cy - pr + 10], fill=(255, 240, 200, 120))
    im.save(path)


def gen_corner_button(path):
    """圆形角钮（2×176×176 → 显示 88×88）：暗球 + 金环 + 顶部高光（图标/文字运行时叠加）。"""
    s = 176
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    px = im.load()
    r = s // 2 - 4
    cx = cy = s // 2
    for y in range(s):
        for x in range(s):
            d = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r)
            if d <= 1:
                t = max(0.0, 1 - d)
                top_light = max(0.0, 1 - (y - (cy - r * 0.55)) / (r * 0.9))
                base = tuple(int(DARK[i] + (DARK_HI[i] - DARK[i]) * top_light * 0.9) for i in range(3))
                rim = max(0.0, 1 - abs(1 - d - 0.045) / 0.05)
                col = tuple(int(base[i] + (GOLD[i] - base[i]) * rim) for i in range(3))
                alpha = 255 if d < 0.985 else int((1 - d) / 0.015 * 255)
                px[x, y] = col + (alpha,)
    draw = ImageDraw.Draw(im)
    draw.arc([6, 6, s - 6, s - 6], 200, 330, fill=GOLD_HI + (200,), width=4)
    im.save(path)


# ---------- 执行 ----------

def main():
    login = Image.open(os.path.join(DESIGN, "login.png")).convert("RGB")
    rs = Image.open(os.path.join(DESIGN, "role_selector.png")).convert("RGB")
    patch_login(login).save(os.path.join(RES, "login", "login_bg.png"))
    patch_rs(rs).save(os.path.join(RES, "create_role", "bg.png"))

    os.makedirs(os.path.join(RES, "common"), exist_ok=True)
    gen_button_gold(os.path.join(RES, "common", "button_gold.png"))
    gen_server_bar(os.path.join(RES, "login", "server_bar.png"))
    gen_name_plate(os.path.join(RES, "common", "name_plate.png"))
    gen_dice(os.path.join(RES, "common", "dice.png"))
    gen_corner_button(os.path.join(RES, "login", "corner_button.png"))
    print("背景修补与素材生成完成 →", RES)


if __name__ == "__main__":
    main()
