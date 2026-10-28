#!/usr/bin/env node
/**
 * 外观按动作分 plist 图集单测（client/tools/test-action-atlas.cjs）
 *
 * 盯的不变量（#228：怪物 + 衣服/武器外观按动作分图集的打包管线 + 加载接线）：
 * · 图集素材守卫：试点目录（怪物 1 / clothes 001 / weapons 001）各动作图集 plist + png 成对存在
 * · 帧数与帧号表一致：怪物 8 方向 × monsterActionSpecs 帧数；衣服/武器 8 方向 × roleActionAtlas 帧数
 * · 帧名分拣规约：d<方向>_<帧>，方向 0-7 齐全、组内帧号连续无缺口
 * · plist 画布尺寸 == PNG 尺寸（打包器以 spriteOffset 保留回贴位置，播放与原逐帧版一致）
 * · 打包脚本与 configs 帧号表同源（改一边必须同步另一边；角色顺序布局段首由 roleActionAtlas 累计校验）
 * · 接线：AnimationHelper.prepare 对 monster/role 先试图集（getAtlasSrc + getDirWithPath 静默探测），
 *   无图集静默回退散帧目录；片段缓存 key 与散帧路径同键（"kind|目录|速度倍率"），
 *   片段名走 getAnimationName（MonsterAI.playAction / RoleDisplay 无需改动）
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const RES_ROOT = path.join(PROJECT_ROOT, "assets/resources");
/** 试点目录：怪物一个 + 衣服/武器各一个（怪物不保证出现，装备外观进游戏必可见） */
const PILOTS = ["monster/out/1", "clothes/out/001", "weapons/out/001"];
const DIRECTION_COUNT = 8;

let outDir;
try {
  outDir = prepare("olua-action-atlas", ["configs/animation.ts"]);
} catch (error) {
  fail(String(error && error.message ? error.message : error));
  process.exit();
}

const { BLANK_FRAME_MAX_AREA, getAtlasSrc, getLoopAtlasDir, monsterActionAtlas, monsterActionSpecs, roleActionAtlas, directions } = require(path.join(outDir, "configs/animation.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
const helperSource = read("assets/ui/helpers/AnimationHelper.ts");
const stageToolSource = read("tools/stage-action-frames.py");

/** PNG 尺寸（IHDR：宽高在固定偏移 16/20，大端 uint32） */
function pngSize(file) {
  const buffer = fs.readFileSync(file);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function parsePlist(file) {
  const xml = fs.readFileSync(file, "utf8");
  const framesSection = xml.slice(xml.indexOf("<key>frames</key>"), xml.indexOf("<key>metadata</key>"));
  const frameNames = Array.from(framesSection.matchAll(/<key>([A-Za-z0-9_.\\/]+\.png)<\/key>\s*<dict>/g)).map((m) => m[1]);
  const metaSection = xml.slice(xml.indexOf("<key>metadata</key>"));
  const pick = (key) => {
    const m = metaSection.match(new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]+)<\\/string>`));
    return m ? m[1] : null;
  };
  return { frameNames, textureSize: pick("size") };
}

/** 试点目录的动作清单：怪物 = 帧号表规格；衣服/武器 = 顺序布局动作段（每方向帧数） */
function pilotSpecs(dirId) {
  return dirId.startsWith("monster/") ? monsterActionAtlas : roleActionAtlas;
}

console.log("\n— A. 图集素材守卫（试点目录）—");
for (const dirId of PILOTS) {
  const atlasDir = path.join(RES_ROOT, getAtlasSrc(dirId));
  check(fs.existsSync(atlasDir), `${dirId} 图集目录 ${getAtlasSrc(dirId)} 存在`);
  for (const spec of pilotSpecs(dirId)) {
    const actionDir = path.join(atlasDir, spec.action);
    const plistPath = path.join(actionDir, `${spec.action}.plist`);
    const pngPath = path.join(actionDir, `${spec.action}.png`);
    if (!fs.existsSync(plistPath) || !fs.existsSync(pngPath)) {
      check(false, `${dirId} 的 ${spec.action} 图集 plist + png 成对存在`, "缺文件");
      continue;
    }

    const plist = parsePlist(plistPath);
    const names = plist.frameNames.map((name) => name.replace(/\.png$/i, ""));
    const expected = spec.frames * DIRECTION_COUNT;
    check(names.length === expected, `${dirId} ${spec.action} 帧数 = ${expected}`, `实际 ${names.length}`);

    // 帧名规约：d<方向>_<帧>，方向 0-7 齐全，组内帧号连续
    const byDirection = new Map();
    let malformed = 0;
    names.forEach((name) => {
      const m = /^d(\d+)_(\d+)$/.exec(name);
      if (!m) { malformed += 1; return; }
      const list = byDirection.get(Number(m[1])) ?? [];
      list.push(Number(m[2]));
      byDirection.set(Number(m[1]), list);
    });
    check(malformed === 0, `${dirId} ${spec.action} 帧名全部符合 d<方向>_<帧> 规约`, `不符 ${malformed} 个`);
    check(byDirection.size === DIRECTION_COUNT, `${dirId} ${spec.action} 覆盖 8 个方向`, `实际 ${byDirection.size} 个`);
    const badDirections = [];
    byDirection.forEach((slots, direction) => {
      const sorted = slots.slice().sort((a, b) => a - b);
      const complete = sorted.length === spec.frames && sorted.every((slot, index) => slot === index);
      if (!complete) badDirections.push(`d${direction}(${sorted.join(",")})`);
    });
    check(badDirections.length === 0, `${dirId} ${spec.action} 每方向 ${spec.frames} 帧且帧号连续无缺口`, badDirections.join(" "));

    const size = pngSize(pngPath);
    check(plist.textureSize === `{${size.width},${size.height}}`, `${dirId} ${spec.action} plist 画布尺寸 == PNG 尺寸（${size.width}x${size.height}）`, plist.textureSize);
  }
}

console.log("\n— B. 打包脚本与帧号表同源 —");
check(monsterActionAtlas.length === monsterActionSpecs.length, "怪物图集规格与帧号表等长");
for (const spec of monsterActionSpecs) {
  const pattern = new RegExp(`\\("${spec.action}",\\s*${spec.start},\\s*${spec.frames},\\s*${spec.spacing}\\)`);
  check(pattern.test(stageToolSource), `打包脚本 monster ${spec.action} 段与 configs 帧号表一致（start=${spec.start} frames=${spec.frames} spacing=${spec.spacing}）`);
}
{
  // 角色顺序布局：脚本段首 = 前面各段的 8 方向 × 每方向帧数累计（与 fillAnimationMap 同口径）
  let cursor = 0;
  for (const spec of roleActionAtlas) {
    const pattern = new RegExp(`\\("${spec.action}",\\s*${cursor},\\s*${spec.frames}\\)`);
    check(pattern.test(stageToolSource), `打包脚本 role ${spec.action} 段首 = ${cursor}（每方向 ${spec.frames} 帧）`);
    cursor += DIRECTION_COUNT * spec.frames;
  }
  check(cursor === 600, "角色顺序布局总帧数 = 600（与素材包 00000-00599 对齐）", `实际 ${cursor}`);
  const roleSection = stageToolSource.slice(stageToolSource.indexOf("ROLE_ACTION_SPECS"));
  check(roleActionAtlas.every((spec) => roleSection.includes(`("${spec.action}"`)), "打包脚本 role 动作与 configs roleActionAtlas 一致");
}
check(directions.length === DIRECTION_COUNT, "方向表 8 个方向（与打包脚本的 DIRECTION_COUNT 一致）");

console.log("\n— C. 图集路径映射 —");
check(getAtlasSrc("monster/out/1") === "monster/atlas/out/1", "monster/out/1 → monster/atlas/out/1");
check(getAtlasSrc("clothes/out/001") === "clothes/atlas/out/001", "clothes/out/001 → clothes/atlas/out/001");
check(getAtlasSrc("weapons/out/001") === "weapons/atlas/out/001", "weapons/out/001 → weapons/atlas/out/001");
check(getAtlasSrc("role/1") === "role/atlas/1", "role/1 → role/atlas/1");
check(getAtlasSrc("role/2") === "role/atlas/2", "role/2 → role/atlas/2");
check(getAtlasSrc("") === "", "空目录映射为空串");
check(getLoopAtlasDir("npc/npc_2108") === "npc/atlas/npc_2108", "npc/npc_2108 → npc/atlas/npc_2108");
check(getLoopAtlasDir("backgrounds/sfx_16000") === "backgrounds/atlas/sfx_16000", "backgrounds/sfx_16000 → backgrounds/atlas/sfx_16000");
check(getLoopAtlasDir("monster/out/1") === "", "外观树不匹配单循环映射");
check(getLoopAtlasDir("") === "", "空目录单循环映射为空串");

console.log("\n— D. AnimationHelper 接线 —");
check(/\(kind === "monster" \|\| kind === "role"\) && \(await this\.prepareActionAtlas/.test(helperSource), "prepare 对 monster 与 role 都先试图集路径");
check(/resources\.getDirWithPath\(atlasDir, SpriteAtlas\)/.test(helperSource), "图集探测走 resources.getDirWithPath（目录索引同步查询，未打包不报错刷屏）");
check(/if \(!clips\.size\) return false;/.test(helperSource), "一个动作都没切出来时返回 false（回退散帧目录兜底）");
{
  const prepareBody = helperSource.slice(helperSource.indexOf("static async prepare("), helperSource.indexOf("static async prepareActionAtlas"));
  check(/this\.loadFrames\(dirSrc\)/.test(prepareBody), "prepare 回退路径仍走散帧目录加载（未打包目录行为不变）");
}
{
  const atlasBody = helperSource.slice(helperSource.indexOf("static async prepareActionAtlas"), helperSource.indexOf("private static atlasFrameSlot"));
  check(/this\.clipKey\(dirSrc, kind, speedRate\)/.test(atlasBody), "图集片段与散帧片段同缓存键（useManyNameAnimation / 播放方无需改动）");
  check(/getAnimationName\(spec\.action, direction\)/.test(atlasBody), "片段名走 getAnimationName（动作_方向，播放口径不变）");
  check(/this\.getFrameTime\(name, speedRate\)/.test(atlasBody), "每帧时长走 getFrameTime（速度倍率口径与散帧路径一致）");
  check(/list\.sort\(/.test(atlasBody), "组内按帧下标排序（d0_00 与 d1_00 末尾数字同为 0，不能依赖 loadFramesFromAtlas 的排序）");
  check(/this\.createClip\(name, list/.test(atlasBody), "片段创建复用 createClip（wrapMode / enableTrsBlending 与散帧路径一致）");
  check(/this\.isSolidFrame\(frame\)/.test(atlasBody), "空帧过滤走 isSolidFrame（占位空图不进片段，避免空白闪帧）");
  check(!/console\.error/.test(atlasBody), "图集缺失路径无 console.error（未打包目录预加载不刷屏）");
}
check(helperSource.split("this.isSolidFrame(").length >= 5 && /private static isSolidFrame/.test(helperSource), "空帧判据收敛为 isSolidFrame（buildClips / prepareActionAtlas / loadLoopFrames / playLoopAtlasWithDuration 共用）");
{
  // 判据必须按面积：2026-10-29 普查 8513 个空帧，武器除 1×1 外还有 184 个 2×2，
  // 旧判据（边长 > 1）把它们放进片段 → 武器每轮消失一半时间；按边长 > 2 判又会误伤 2×174 这类薄武器帧
  const solidBody = helperSource.slice(helperSource.indexOf("private static isSolidFrame"), helperSource.indexOf("private static isSolidFrame") + 400);
  check(/rect\.width \* rect\.height > BLANK_FRAME_MAX_AREA/.test(solidBody), "空帧判据按面积且阈值取自配置（rect.width × rect.height > BLANK_FRAME_MAX_AREA），边长判据会漏过 2×2 占位块");
  check(BLANK_FRAME_MAX_AREA === 4, `空帧面积阈值 BLANK_FRAME_MAX_AREA = ${BLANK_FRAME_MAX_AREA}（普查结论：1×1 与 2×2 是占位，3×3 起是真实小图）`);
  const durationBody = helperSource.slice(helperSource.indexOf("static playLoopAtlasWithDuration"), helperSource.indexOf("static playLoopDir"));
  check(/filter\(\(frame\) => this\.isSolidFrame\(frame\)\)/.test(durationBody), "内观图集（playLoopAtlasWithDuration）同样过滤空帧，衣服内观不再周期闪空");
}
check(/kind === "monster" \? monsterActionAtlas : roleActionAtlas/.test(helperSource), "动作规格按种类取（怪物走帧号表导出，角色走顺序布局动作段）");
{
  // 单循环接线：playLoopWithDir / playLoopDir 都改走 loadLoopFrames（图集优先 + 空帧过滤 + 散帧回退）
  const loopBody = helperSource.slice(helperSource.indexOf("private static async loadLoopFrames"), helperSource.indexOf("片段缓存键"));
  check(/getLoopAtlasDir\(dirSrc\)/.test(loopBody), "单循环路径走 getLoopAtlasDir 取图集目录");
  check(/resources\.getDirWithPath\(atlasDir, SpriteAtlas\)/.test(loopBody), "单循环图集探测走 getDirWithPath（未打包不报错刷屏）");
  check(/this\.isSolidFrame\(frame\)/.test(loopBody), "单循环图集空帧过滤与动作路径同口径（isSolidFrame，占位空图不进播放序列）");
  check(/this\.loadFrames\(dirSrc\)/.test(loopBody), "单循环未打包时回退散帧目录（行为不变）");
  check(/playLoopWithDir[\s\S]*?this\.loadLoopFrames\(dirSrc\)/.test(helperSource), "playLoopWithDir（NPC 外观）已接入图集优先帧来源");
  check(/static playLoopDir\([\s\S]*?this\.loadLoopFrames\(dirSrc\)/.test(helperSource), "playLoopDir（装备详情背景）已接入图集优先帧来源");
}

console.log("\n— E. 单循环图集守卫（npc 外观 / 装备详情背景）—");
{
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  // 散帧已移出 assets（#235），源帧数以打包暂存区为准（client/tools/_stage_action_atlas，gitignored）
  const stageRoot = path.join(PROJECT_ROOT, "tools", "_stage_action_atlas");
  for (const [srcTree, atlasTree] of [["npc", "npc/atlas"], ["backgrounds", "backgrounds/atlas"]]) {
    const stageTree = path.join(stageRoot, srcTree);
    if (!isDir(stageTree)) {
      console.log(`  [跳过] ${srcTree}：打包暂存区不存在（${stageTree}），跳过帧数比对`);
      continue;
    }
    const sourceDirs = fs.readdirSync(stageTree).filter((name) => isDir(path.join(stageTree, name)));
    check(sourceDirs.length > 0, `${srcTree} 至少存在一个单循环动画目录`, "0 个");
    let checked = 0;
    for (const name of sourceDirs) {
      const sourceFrames = fs.readdirSync(path.join(stageTree, name)).filter((f) => f.toLowerCase().endsWith(".png")).length;
      const plistPath = path.join(RES_ROOT, atlasTree, name, `${name}.plist`);
      const pngPath = path.join(RES_ROOT, atlasTree, name, `${name}.png`);
      if (!fs.existsSync(plistPath) || !fs.existsSync(pngPath)) {
        check(false, `${srcTree}/${name} 单循环图集 plist + png 成对存在`, "缺文件");
        continue;
      }
      const plist = parsePlist(plistPath);
      check(plist.frameNames.length === sourceFrames, `${srcTree}/${name} 图集帧数 = 打包源帧数（${sourceFrames}）`, `实际 ${plist.frameNames.length}`);
      const size = pngSize(pngPath);
      check(plist.textureSize === `{${size.width},${size.height}}`, `${srcTree}/${name} plist 画布尺寸 == PNG 尺寸`, plist.textureSize);
      checked += 1;
    }
    check(checked === sourceDirs.length, `${srcTree} 全部 ${sourceDirs.length} 个目录已图集化`, `实际 ${checked}`);
  }
}

console.log("\n— F. role 本体动作图集守卫（role/1、role/2）—");
{
  // 空槽位（素材缺帧）允许：组内帧号严格递增、去重后落在 [0, 每方向帧数) 即可；总帧数 = 416（600 槽位 - 184 空槽）
  for (const roleId of ["1", "2"]) {
    const atlasDir = path.join(RES_ROOT, getAtlasSrc(`role/${roleId}`));
    let total = 0;
    let cursor = 0;
    for (const spec of roleActionAtlas) {
      const plistPath = path.join(atlasDir, spec.action, `${spec.action}.plist`);
      const pngPath = path.join(atlasDir, spec.action, `${spec.action}.png`);
      if (!fs.existsSync(plistPath) || !fs.existsSync(pngPath)) {
        check(false, `role/${roleId} ${spec.action} 图集 plist + png 成对存在`, "缺文件");
        cursor += DIRECTION_COUNT * spec.frames;
        continue;
      }
      const plist = parsePlist(plistPath);
      const byDirection = new Map();
      let malformed = 0;
      plist.frameNames.map((name) => name.replace(/\.png$/i, "")).forEach((name) => {
        const m = /^d(\d+)_(\d+)$/.exec(name);
        if (!m) { malformed += 1; return; }
        const list = byDirection.get(Number(m[1])) ?? [];
        list.push(Number(m[2]));
        byDirection.set(Number(m[1]), list);
      });
      check(malformed === 0, `role/${roleId} ${spec.action} 帧名全部符合 d<方向>_<帧> 规约`, `不符 ${malformed} 个`);
      const badDirections = [];
      byDirection.forEach((slots, direction) => {
        const sorted = slots.slice().sort((a, b) => a - b);
        const monotonic = sorted.every((slot, index) => index === 0 || sorted[index - 1] < slot) && sorted.every((slot) => slot >= 0 && slot < spec.frames);
        if (!monotonic) badDirections.push(`d${direction}`);
      });
      check(badDirections.length === 0, `role/${roleId} ${spec.action} 组内帧号严格递增且不越界（空槽位允许缺口）`, badDirections.join(" "));
      total += plist.frameNames.length;
      cursor += DIRECTION_COUNT * spec.frames;
    }
    check(cursor === 600, `role/${roleId} 动作段总槽位 = 600（与 configs roleActionAtlas 累计一致）`, `实际 ${cursor}`);
    check(total === 416, `role/${roleId} 图集有效帧总数 = 416（600 槽位 - 184 空槽）`, `实际 ${total}`);
    const size = pngSize(path.join(atlasDir, "stand", "stand.png"));
    const plist = parsePlist(path.join(atlasDir, "stand", "stand.plist"));
    check(plist.textureSize === `{${size.width},${size.height}}`, `role/${roleId} stand 画布尺寸 == PNG 尺寸`, plist.textureSize);
  }
}

finish("PASS：图集素材与帧号表一致、帧名规约成立、路径映射正确、加载接线图集优先且静默回退。");
