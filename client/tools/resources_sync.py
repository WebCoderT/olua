#!/usr/bin/env python3
"""resources 多人一致性同步工具（#266）

client/assets/resources 不入库（体积 ~4G），多机并行靠「清单锁 + GitHub Releases 分发」保证一致：
  manifest  生成/更新 resources.manifest.json（全量文件 sha1+size，含 .meta——Cocos uuid 绑在 meta 上，
            各机器自生成 meta 会 uuid 漂移、prefab 引用断裂，所以 meta 必须随包分发）
  verify    对比本地资源与 manifest（missing / extra / mismatch），一致性守卫
  pack      按资源树顶层目录打 zip（单卷超 1900MB 自动续卷，GitHub Release 单资产上限 2GiB）
  extract   解压 dist 目录里的全部分卷并 verify（download 的落盘侧）

zip 内路径 = 相对 client/assets/resources 的 posix 路径；解压回同一目录。

用法：
  python client/tools/resources_sync.py manifest --version 2026-10-25-1
  python client/tools/resources_sync.py verify
  python client/tools/resources_sync.py pack --version 2026-10-25-1 [--out resources_dist]
  python client/tools/resources_sync.py extract --dir resources_dist/2026-10-25-1

上传/下载走 Makefile 的 resources-upload / resources-download（gh release，见 README「资源同步」节）。
"""

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
RES_ROOT = REPO / "client" / "assets" / "resources"
MANIFEST = REPO / "resources.manifest.json"
DEFAULT_DIST = REPO / "resources_dist"

# 单卷上限（MB）：GitHub Release 单资产上限 2GiB，留余量
VOLUME_MAX_MB = 1900


def sha1_of(path: Path) -> str:
    digest = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest() -> dict:
    if not MANIFEST.is_file():
        sys.exit(f"清单不存在：{MANIFEST}（先跑 manifest 子命令）")
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def scan_files() -> list[Path]:
    if not RES_ROOT.is_dir():
        sys.exit(f"资源目录不存在：{RES_ROOT}")
    return sorted(p for p in RES_ROOT.rglob("*") if p.is_file() and not p.name.startswith("."))


# ---------- manifest ----------

def cmd_manifest(version: str | None) -> int:
    entries = [[p.relative_to(RES_ROOT).as_posix(), sha1_of(p), p.stat().st_size] for p in scan_files()]
    data = {"version": version or (json.loads(MANIFEST.read_text(encoding="utf-8"))["version"] if MANIFEST.is_file() else "dev"), "files": entries}
    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8", newline="\n")
    total = sum(size for _, _, size in entries)
    print(f"manifest：{len(entries)} 个文件，{total / 1e9:.2f} GB，version={data['version']}")
    return 0


# ---------- verify ----------

def cmd_verify() -> int:
    data = load_manifest()
    expected = {path: (sha, size) for path, sha, size in data["files"]}
    actual = {p.relative_to(RES_ROOT).as_posix(): p for p in scan_files()}
    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected))
    mismatch = []
    for path in sorted(set(expected) & set(actual)):
        sha, size = expected[path]
        if actual[path].stat().st_size != size or sha1_of(actual[path]) != sha:
            mismatch.append(path)
    for label, items in (("缺失", missing), ("多出", extra), ("不一致", mismatch)):
        for path in items[:10]:
            print(f"  [{label}] {path}")
        if len(items) > 10:
            print(f"  [{label}] …共 {len(items)} 个")
    if missing or extra or mismatch:
        print(f"✘ resources 与清单（version={data['version']}）不一致：缺失 {len(missing)} / 多出 {len(extra)} / 不一致 {len(mismatch)}")
        print("  修复：git pull 后跑 make resources-download；或确认改动后重新 pack + upload + manifest 提交")
        return 1
    print(f"✔ resources 与清单一致（{len(expected)} 个文件，version={data['version']}）")
    return 0


# ---------- pack ----------

def plan_volumes(files: list[Path]) -> list[tuple[str, list[Path]]]:
    """按顶层目录分组；单组超限就把组内文件按序装箱成多卷（顺序稳定 = 产物可复现）。
    返回 [(卷名, 文件列表)]：单卷组叫 <顶层>，多卷组叫 <顶层>.part<N>"""
    groups: dict[str, list[Path]] = {}
    for p in files:
        rel = p.relative_to(RES_ROOT)
        top = rel.parts[0] if len(rel.parts) > 1 else "misc"
        groups.setdefault(top, []).append(p)
    volumes: list[tuple[str, list[Path]]] = []
    for top in sorted(groups):
        chunks, members, used = [], [], 0
        for p in groups[top]:
            size = p.stat().st_size
            if members and used + size > VOLUME_MAX_MB << 20:
                chunks.append(members)
                members, used = [], 0
            members.append(p)
            used += size
        if members:
            chunks.append(members)
        for index, chunk in enumerate(chunks, 1):
            volumes.append((top if len(chunks) == 1 else f"{top}.part{index}", chunk))
    return volumes


def cmd_pack(version: str, dist_root: Path) -> int:
    data = load_manifest()
    if data["version"] != version:
        sys.exit(f"清单 version={data['version']} 与 --version {version} 不一致（先跑 manifest --version {version}）")
    out_dir = dist_root / version
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.zip"):
        old.unlink()
    files = scan_files()
    total_mb = 0
    for name, members in plan_volumes(files):
        zip_path = out_dir / f"{name}.zip"
        # STORED 不重压缩：png 本身已压缩，重压缩只耗时不省空间
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED, compresslevel=None) as zf:
            for p in members:
                zf.write(p, p.relative_to(RES_ROOT).as_posix())
        size_mb = zip_path.stat().st_size >> 20
        total_mb += size_mb
        print(f"  {zip_path.name}：{len(members)} 文件，{size_mb} MB")
    print(f"pack 完成：{out_dir}（{total_mb / 1024:.2f} GB）")
    return 0


# ---------- extract ----------

def cmd_extract(dist_dir: Path) -> int:
    zips = sorted(dist_dir.glob("*.zip"))
    if not zips:
        sys.exit(f"dist 目录没有 zip：{dist_dir}")
    for zip_path in zips:
        with zipfile.ZipFile(zip_path) as zf:
            bad = zf.testzip()
            if bad:
                sys.exit(f"{zip_path.name} 损坏：{bad}")
            zf.extractall(RES_ROOT)
        print(f"  已解压 {zip_path.name}")
    print("extract 完成，开始 verify")
    return cmd_verify()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("manifest", help="生成/更新清单")
    m.add_argument("--version", default=None)
    sub.add_parser("verify", help="本地资源 vs 清单一致性校验")
    p = sub.add_parser("pack", help="按清单打分卷 zip")
    p.add_argument("--version", required=True)
    p.add_argument("--out", default=str(DEFAULT_DIST))
    e = sub.add_parser("extract", help="解压 dist 里的全部分卷并校验")
    e.add_argument("--dir", required=True)
    args = parser.parse_args()
    if args.cmd == "manifest":
        return cmd_manifest(args.version)
    if args.cmd == "verify":
        return cmd_verify()
    if args.cmd == "pack":
        return cmd_pack(args.version, Path(args.out))
    if args.cmd == "extract":
        return cmd_extract(Path(args.dir))
    return 1


if __name__ == "__main__":
    sys.exit(main())
