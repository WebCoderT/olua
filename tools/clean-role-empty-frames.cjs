/**
 * 清理 resources/role 下的「空帧」——扩展名是 .png 但文件本体是 1×1 BMP 的占位图。
 *
 * 背景：动作导出工具给「该帧无内容」的帧输出 1×1 占位文件（且错存成 BMP），
 * Cocos 按 .png 解码必然失败 → meta 里 imported=false / 无任何子资源 → 每次扫描刷屏报错。
 * 本项目切片段走**显式帧号映射**（configs/animation.roleAnimationMap）+ buildClips 的空图过滤，
 * 不依赖占位帧保持帧序连续，因此可以直接删除。
 *
 * 用法：
 *   node tools/clean-role-empty-frames.cjs            # 预演（只列清单，不动文件）
 *   node tools/clean-role-empty-frames.cjs --apply    # 备份 + 删除
 *
 * 备份目录：.workbuddy/backup/role-empty-frames-<时间戳>/（保持 role/1、role/2 结构）
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "assets", "resources", "role");
const APPLY = process.argv.includes("--apply");

/** 判定空帧：文件头是 BMP（42 4d）而不是 PNG 签名 */
function isEmptyFrame(file) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(8);
  try {
    fs.readSync(fd, head, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  return head[0] === 0x42 && head[1] === 0x4d; // 'BM'
}

/** 收集空的 .png 与其同名 .meta */
function collect() {
  const hits = [];
  fs.readdirSync(ROOT)
    .sort()
    .forEach((dir) => {
      const dirPath = path.join(ROOT, dir);
      if (!fs.statSync(dirPath).isDirectory()) return;
      fs.readdirSync(dirPath)
        .sort()
        .forEach((name) => {
          if (!name.toLowerCase().endsWith(".png")) return;
          const file = path.join(dirPath, name);
          if (!isEmptyFrame(file)) return;
          const meta = `${file}.meta`;
          hits.push({ dir, file, meta: fs.existsSync(meta) ? meta : null, size: fs.statSync(file).size });
        });
    });
  return hits;
}

const hits = collect();
console.log(`扫描目录：${ROOT}`);
console.log(`空帧（扩展名 .png / 本体 1×1 BMP）：${hits.length} 个`);
const byDir = {};
hits.forEach((hit) => (byDir[hit.dir] = (byDir[hit.dir] || 0) + 1));
for (const dir in byDir) console.log(`  role/${dir}: ${byDir[dir]} 个`);
console.log(`  附带 .meta：${hits.filter((h) => h.meta).length} 个`);

const otherBytes = hits.filter((h) => h.size !== 70);
if (otherBytes.length) console.log(`\n注意：有 ${otherBytes.length} 个空帧不是 70 字节，请人工复核：`, otherBytes.filter((h) => h.size !== 70).map((h) => h.file).slice(0, 5));

if (!hits.length) {
  console.log("\n没有可清理的文件，退出。");
  process.exit(0);
}

if (!APPLY) {
  console.log("\n（预演模式）前 8 个待清理文件：");
  hits.slice(0, 8).forEach((h) => console.log(`  ${h.file}`));
  console.log("\n加 --apply 执行备份 + 删除。");
  process.exit(0);
}

// —— 备份 + 删除 ——
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const backupRoot = path.join(__dirname, "..", ".workbuddy", "backup", `role-empty-frames-${stamp}`);
let copied = 0;
let removed = 0;
hits.forEach((hit) => {
  const rel = path.relative(path.join(__dirname, "..", "assets", "resources"), hit.file);
  const target = path.join(backupRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 先备份，校验字节数一致，再删原件（目录未被 git 追踪，删了找不回来）
  fs.copyFileSync(hit.file, target);
  if (fs.statSync(target).size !== hit.size) throw new Error(`备份校验失败：${hit.file}`);
  copied += 1;
  fs.unlinkSync(hit.file);
  removed += 1;
  if (hit.meta) {
    fs.copyFileSync(hit.meta, `${target}.meta`);
    fs.unlinkSync(hit.meta);
  }
});
console.log(`\n已备份 ${copied} 个空帧（含 meta）到：${backupRoot}`);
console.log(`已删除 ${removed} 个空帧文件。`);
