#!/usr/bin/env python3
"""把散帧外观目录按 configs/animation 的帧号公式重编码分拣到按动作分目录的暂存区，
供 sprite-plist-packer 打包成按动作分 plist 的图集。

用法：
  python stage-action-frames.py <目录ID> [<目录ID> ...]

目录ID 四种形态（按前缀自动选帧号公式，与 resources 下的相对路径一致）：
  monster/out/1      → 怪物（帧号 = start + 方向下标 × spacing + 帧内下标）
  clothes/out/001    → 衣服/武器（顺序布局：动作段首尾相接，段内 = 方向下标 × 每方向帧数 + 帧内下标）
  weapons/out/001
  role/1、role/2     → 角色本体（同衣服的顺序布局 + 帧号基准偏移：role/2 整体 +600，见
                       configs/animation.animationFrameBases）
  npc/npc_2108、backgrounds/sfx_16000 → 单循环（整目录一串循环帧，不改名原样入暂存区）

- 源：client/assets/resources/<目录ID>/{NNNNN.png, NNNNN.PNG}
- 目标：client/tools/_stage_action_atlas/<目录ID>/<action>/d<方向>_<帧>.png
  （暂存根按树分目录，打包器镜像相对路径 → 输出根取 resources/<树>/atlas：
   _stage_action_atlas/clothes/out/001/... → resources/clothes/atlas/out/001/...）
  （同卷硬链接，避免大体积拷贝；跨卷时退回复制）
- 源帧缺失时记入缺失清单并继续（个别包缺段属正常，如怪物 27 没有走路段）
输出根目录由调用方传给 plist_packer / verify_plist。
"""

import os
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
RES_ROOT = REPO / "client" / "assets" / "resources"
# 散帧已图集化（#235）移出 assets：原始逐帧素材归档在仓库根 _loose_frames_archive（gitignored）
ARCHIVE_ROOT = REPO / "_loose_frames_archive"
STAGE_ROOT = REPO / "client" / "tools" / "_stage_action_atlas"

DIRECTION_COUNT = 8

# 与 client/assets/configs/animation.ts monsterActionSpecs 同源（改这边必须同步那边，测试盯住）
MONSTER_ACTION_SPECS = [
    # (action, start, frames, spacing)
    ("stand", 0, 4, 10),
    ("walk", 80, 6, 10),
    ("run", 160, 6, 10),
    ("injured", 240, 2, 2),
    ("die", 260, 10, 10),
]

# 与 client/assets/configs/animation.ts roleActions + roleSpriteFrameLength 同源：
# 顺序布局（fillAnimationMap 的 actionStartIndex 累计），段长 = 8 方向 × 每方向帧数
ROLE_ACTION_SPECS = [
    # (action, start, frames_per_direction)
    ("stand", 0, 8),
    ("walk", 64, 8),
    ("run", 128, 8),
    ("test1", 192, 1),
    ("attack_near", 200, 8),
    ("attack_skill_1", 264, 8),
    ("test3", 328, 8),
    ("attack_far", 392, 8),
    ("injured", 456, 2),
    ("a1", 472, 8),
    ("die", 536, 8),
]


def action_specs(dir_id: str):
    """按目录前缀选帧号公式，返回 [(action, start, frames, spacing)]（spacing=方向步长）"""
    if dir_id.startswith("monster/out/"):
        return MONSTER_ACTION_SPECS
    if dir_id.startswith(("clothes/out/", "weapons/out/")) or dir_id in ("role/1", "role/2"):
        return [(action, start, frames, frames) for action, start, frames in ROLE_ACTION_SPECS]
    raise SystemExit(f"不支持的目录形态：{dir_id}（只支持 monster/out、clothes|weapons/out、role/N）")


def frame_base(dir_id: str) -> int:
    """帧号基准偏移（与 configs/animation.animationFrameBases 同源：role/2 = role/1 + 600）"""
    return 600 if dir_id == "role/2" else 0


def is_loop_dir(dir_id: str) -> bool:
    """单循环目录（npc / backgrounds）：整目录一串循环帧，不改名原样入暂存区"""
    return dir_id.startswith(("npc/", "backgrounds/"))


def link_or_copy(src: Path, dst: Path):
    if dst.exists():
        return
    try:
        os.link(src, dst)  # 同卷硬链接：大体积素材零拷贝
    except OSError:
        shutil.copyfile(src, dst)


def stage_one(dir_id: str) -> bool:
    # 散帧已在 assets 里的优先（未移除的目录），否则从归档取（#235 移出的原始逐帧）
    src_dir = next((root / dir_id for root in (RES_ROOT, ARCHIVE_ROOT) if (root / dir_id).is_dir()), None)
    if src_dir is None:
        print(f"[跳过] {dir_id} 不存在（assets 与归档都没有）")
        return False
    if is_loop_dir(dir_id):
        # 单循环：不改名原样入暂存区（帧名保持原序号，加载侧按图集帧序排序）
        out_dir = STAGE_ROOT / dir_id
        out_dir.mkdir(parents=True, exist_ok=True)
        copied = 0
        for src in sorted(src_dir.iterdir()):
            if src.suffix.lower() != ".png" or src.name.startswith("."):
                continue
            link_or_copy(src, out_dir / src.name)
            copied += 1
        print(f"[{dir_id}] 单循环 共 {copied} 帧")
        return copied > 0
    base = frame_base(dir_id)
    total = copied = 0
    missing: list[str] = []
    for action, start, frames, spacing in action_specs(dir_id):
        action_dir = STAGE_ROOT / dir_id / action
        action_dir.mkdir(parents=True, exist_ok=True)
        for direction in range(DIRECTION_COUNT):
            for frame_index in range(frames):
                number = base + start + direction * spacing + frame_index
                total += 1
                src = next((src_dir / f"{number:05d}.{ext}" for ext in ("png", "PNG") if (src_dir / f"{number:05d}.{ext}").is_file()), None)
                if src is None:
                    missing.append(f"{action} d{direction}_{frame_index:02d} (帧号 {number:05d})")
                    continue
                link_or_copy(src, action_dir / f"d{direction}_{frame_index:02d}.png")
                copied += 1
    print(f"[{dir_id}] 共 {total} 帧，链接 {copied}，缺失 {len(missing)}")
    for item in missing:
        print(f"  缺失 {item}")
    return copied > 0


def main() -> int:
    ids = sys.argv[1:]
    if not ids:
        print(__doc__)
        return 1
    ok = [stage_one(dir_id) for dir_id in ids]
    return 0 if any(ok) else 1


if __name__ == "__main__":
    sys.exit(main())
