#!/usr/bin/env node
/**
 * 怪物按动作分 plist 图集单测（client/tools/test-monster-action-atlas.cjs）
 *
 * 盯的不变量（#228：怪物动画按动作分图集的打包管线 + 加载接线）：
 * · 图集素材守卫：怪物 1 的五个动作图集（stand/walk/run/injured/die）plist + png 成对存在
 * · 帧数与帧号表一致：每动作 8 方向 × 每方向帧数（stand 4 / walk 6 / run 6 / injured 2 / die 10）
 * · 帧名分拣规约：d<方向>_<帧>，方向 0-7 齐全、组内帧号连续无缺口
 * · plist 画布尺寸 == PNG 尺寸（打包器以 spriteOffset 保留回贴位置，播放与原逐帧版一致）
 * · 打包脚本与 configs/animation 的帧号表同源（改一边必须同步另一边）
 * · 接线：AnimationHelper.prepare 对 monster 先试图集（getMonsterAtlasSrc + getDirWithPath 静默探测），
 *   无图集静默回退散帧目录；片段缓存 key 与散帧路径同键（"monster|目录|速度倍率"），
 *   片段名走 getAnimationName（MonsterAI.playAction 无需改动）
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const ATLAS_ROOT = path.join(PROJECT_ROOT, "assets/resources/monster/atlas/out");
const PILOT_MONSTER = "1";
const ACTIONS = ["stand", "walk", "run", "injured", "die"];
/** 每方向帧数（与 configs/animation monsterActionSpecs 一致，B 组再断言两处同源） */
const FRAMES_PER_DIRECTION = { stand: 4, walk: 6, run: 6, injured: 2, die: 10 };
const DIRECTION_COUNT = 8;
/** 试点怪物每动作总帧数（8 方向齐备的口径，缺段怪物由打包脚本的缺失清单兜住） */
const EXPECTED_TOTAL = { stand: 32, walk: 48, run: 48, injured: 16, die: 80 };

let outDir;
try {
  outDir = prepare("olua-monster-action-atlas", ["configs/animation.ts"]);
} catch (error) {
  fail(String(error && error.message ? error.message : error));
  process.exit();
}

const { getMonsterAtlasSrc, monsterActionSpecs, directions } = require(path.join(outDir, "configs/animation.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
const helperSource = read("assets/ui/helpers/AnimationHelper.ts");
const stageToolSource = read("tools/stage-monster-action-frames.py");

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

console.log("\n— A. 图集素材守卫（试点怪物 1）—");
check(fs.existsSync(ATLAS_ROOT), "图集根目录 monster/atlas/out 存在");
for (const action of ACTIONS) {
  const dir = path.join(ATLAS_ROOT, PILOT_MONSTER, action);
  const plistPath = path.join(dir, `${action}.plist`);
  const pngPath = path.join(dir, `${action}.png`);
  check(fs.existsSync(plistPath) && fs.existsSync(pngPath), `怪物 ${PILOT_MONSTER} 的 ${action} 图集 plist + png 成对存在`);
  if (!fs.existsSync(plistPath) || !fs.existsSync(pngPath)) continue;

  const plist = parsePlist(plistPath);
  const names = plist.frameNames.map((name) => name.replace(/\.png$/i, ""));
  check(names.length === EXPECTED_TOTAL[action], `${action} 帧数 = ${EXPECTED_TOTAL[action]}`, `实际 ${names.length}`);

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
  check(malformed === 0, `${action} 帧名全部符合 d<方向>_<帧> 规约`, `不符 ${malformed} 个`);
  check(byDirection.size === DIRECTION_COUNT, `${action} 覆盖 8 个方向`, `实际 ${byDirection.size} 个`);
  const badDirections = [];
  byDirection.forEach((slots, direction) => {
    const sorted = slots.slice().sort((a, b) => a - b);
    const complete = sorted.length === FRAMES_PER_DIRECTION[action] && sorted.every((slot, index) => slot === index);
    if (!complete) badDirections.push(`d${direction}(${sorted.join(",")})`);
  });
  check(badDirections.length === 0, `${action} 每方向 ${FRAMES_PER_DIRECTION[action]} 帧且帧号连续无缺口`, badDirections.join(" "));

  const size = pngSize(pngPath);
  check(plist.textureSize === `{${size.width},${size.height}}`, `${action} plist 画布尺寸 == PNG 尺寸（${size.width}x${size.height}）`, plist.textureSize);
}

console.log("\n— B. 打包脚本与帧号表同源 —");
for (const spec of monsterActionSpecs) {
  const pattern = new RegExp(`\\("${spec.action}",\\s*${spec.start},\\s*${spec.frames},\\s*${spec.spacing}\\)`);
  check(pattern.test(stageToolSource), `打包脚本 ${spec.action} 段与 configs 帧号表一致（start=${spec.start} frames=${spec.frames} spacing=${spec.spacing}）`);
}
check(monsterActionSpecs.length === ACTIONS.length, "帧号表动作数与打包脚本一致（5 个动作）", `实际 ${monsterActionSpecs.length}`);
check(directions.length === DIRECTION_COUNT, "方向表 8 个方向（与打包脚本的 DIRECTION_COUNT 一致）");

console.log("\n— C. 图集路径映射 —");
check(getMonsterAtlasSrc("monster/out/1") === "monster/atlas/out/1", "monster/out/1 → monster/atlas/out/1");
check(getMonsterAtlasSrc("monster/out/27") === "monster/atlas/out/27", "monster/out/27 → monster/atlas/out/27");
check(getMonsterAtlasSrc("role/1") === "", "非怪物目录映射为空串（不试图集）");
check(getMonsterAtlasSrc("") === "", "空目录映射为空串");

console.log("\n— D. AnimationHelper 接线 —");
check(/kind === "monster" && \(await this\.prepareMonsterAtlas/.test(helperSource), "prepare 对 monster 先试图集路径");
check(/resources\.getDirWithPath\(atlasDir, SpriteAtlas\)/.test(helperSource), "图集探测走 resources.getDirWithPath（目录索引同步查询，未打包不报错刷屏）");
check(/if \(!clips\.size\) return false;/.test(helperSource), "一个动作都没切出来时返回 false（回退散帧目录兜底）");
{
  const prepareBody = helperSource.slice(helperSource.indexOf("static async prepare("), helperSource.indexOf("static async prepareMonsterAtlas"));
  check(/this\.loadFrames\(dirSrc\)/.test(prepareBody), "prepare 回退路径仍走散帧目录加载（未打包目录行为不变）");
}
{
  const atlasBody = helperSource.slice(helperSource.indexOf("static async prepareMonsterAtlas"), helperSource.indexOf("private static atlasFrameSlot"));
  check(/this\.clipKey\(dirSrc, "monster", speedRate\)/.test(atlasBody), "图集片段与散帧片段同缓存键（useManyNameAnimation / MonsterAI 无需改动）");
  check(/getAnimationName\(spec\.action, direction\)/.test(atlasBody), "片段名走 getAnimationName（动作_方向，MonsterAI.playAction 口径）");
  check(/this\.getFrameTime\(name, speedRate\)/.test(atlasBody), "每帧时长走 getFrameTime（速度倍率口径与散帧路径一致）");
  check(/list\.sort\(/.test(atlasBody), "组内按帧下标排序（d0_00 与 d1_00 末尾数字同为 0，不能依赖 loadFramesFromAtlas 的排序）");
  check(/this\.createClip\(name, list/.test(atlasBody), "片段创建复用 createClip（wrapMode / enableTrsBlending 与散帧路径一致）");
  check(!/console\.error/.test(atlasBody), "图集缺失路径无 console.error（220 个未打包目录预加载不刷屏）");
}

finish("PASS：图集素材与帧号表一致、帧名规约成立、路径映射正确、加载接线图集优先且静默回退。");
