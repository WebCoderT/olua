#!/usr/bin/env python3
"""把 monster/out/<id> 的散帧按 configs/animation.monsterActionSpecs 的帧号公式
重编码分拣到按动作分目录的暂存区，供 sprite-plist-packer 打包成按动作分 plist 的图集。

用法：
  python stage-monster-action-frames.py <monsterId> [<monsterId> ...]

- 源：client/assets/resources/monster/out/<id>/00000.png ...
- 目标：_stage_monster_atlas/<id>/<action>/d<方向>_<帧>.png（方向 0-7 按配置方向顺序，
  帧号公式 = start + 方向下标 × spacing + 帧内下标，与 configs/animation.ts 保持同源）
- 源帧缺失时记入缺失清单并继续（个别包缺段属正常，如怪物 27 没有走路段）
输出根目录由调用方传给 plist_packer / verify_plist。
"""

import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SRC_ROOT = REPO / "client" / "assets" / "resources" / "monster" / "out"
STAGE_ROOT = REPO / "client" / "tools" / "_stage_monster_atlas"

# 与 client/assets/configs/animation.ts monsterActionSpecs 同源（改这边必须同步那边）
MONSTER_ACTION_SPECS = [
    # (action, start, frames, spacing)
    ("stand", 0, 4, 10),
    ("walk", 80, 6, 10),
    ("run", 160, 6, 10),
    ("injured", 240, 2, 2),
    ("die", 260, 10, 10),
]
DIRECTION_COUNT = 8


def stage_one(monster_id: str) -> bool:
    src_dir = SRC_ROOT / monster_id
    if not src_dir.is_dir():
        print(f"[跳过] monster/out/{monster_id} 不存在")
        return False
    total = copied = 0
    missing: list[str] = []
    for action, start, frames, spacing in MONSTER_ACTION_SPECS:
        action_dir = STAGE_ROOT / monster_id / action
        action_dir.mkdir(parents=True, exist_ok=True)
        for direction in range(DIRECTION_COUNT):
            for frame_index in range(frames):
                number = start + direction * spacing + frame_index
                total += 1
                src = src_dir / f"{number:05d}.png"
                if not src.is_file():
                    missing.append(f"{action} d{direction}_{frame_index:02d} (帧号 {number:05d})")
                    continue
                dst = action_dir / f"d{direction}_{frame_index:02d}.png"
                shutil.copyfile(src, dst)
                copied += 1
    print(f"[{monster_id}] 共 {total} 帧，拷贝 {copied}，缺失 {len(missing)}")
    for item in missing:
        print(f"  缺失 {item}")
    return copied > 0


def main() -> int:
    ids = sys.argv[1:]
    if not ids:
        print(__doc__)
        return 1
    ok = [stage_one(monster_id) for monster_id in ids]
    return 0 if any(ok) else 1


if __name__ == "__main__":
    sys.exit(main())
