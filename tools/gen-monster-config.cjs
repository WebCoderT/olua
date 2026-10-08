#!/usr/bin/env node
/**
 * 生成 assets/configs/monster.ts 的几何 / 玩法字段（重写整个文件）
 *
 * 数据来源：
 * 1. 旧 configs/monster.ts —— 保留手工数据（key / level / tier / icon / out / label /
 *    moveSpeed / detectRange / description）与 monsterAI 块、以及条目里「非全 1」的 speedRate 覆盖；
 * 2. assets/resources/monster/out/<id>/00040.png.meta —— Cocos 编辑器对每帧做好的 auto-trim 数据
 *    （trimType:"auto"，与引擎渲染同一口径），从中取：
 *      · contentSize = 裁剪区尺寸（width × height）＝ 可见身体尺寸；
 *        碰撞盒（MonsterCollider）、点击选中（UITransform.hitTest）、头顶血条位置全由它决定；
 *      · outOffset   = 裁剪区中心相对画布中心的反向偏移（-offsetX, -offsetY），
 *        外观节点摆在它上面可见身体中心就正好落在节点原点（消费点 GameUiHelper.createMonsterBody）。
 *
 * 规则（改这里后重新生成本文件）：
 * - aggressive：tier === "boss" 或可见身体宽 ≥ AGGRESSIVE_BODY_WIDTH 判主动；
 * - sellPirce：normal = level × 2 / elite = level × 5 / boss = level × 20（当前无消费点，为击杀奖励预留）；
 * - moveSpeed / detectRange：沿用旧表数值（保持全员 2 / 200）；
 * - speedRate：条目里不再写死，运行时以 configs/monster 的 monsterDefaultSpeedRate 打底、
 *   条目覆盖（与角色 defaultRoleSpeedRate 同构）。
 *
 * 运行：node tools/gen-monster-config.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MONSTER_TS = path.join(ROOT, "assets/configs/monster.ts");
const OUT_DIR = path.join(ROOT, "assets/resources/monster/out");

/** 规则：可见身体宽达到该值（像素）判主动怪（220 只怪身体宽 p75 ≈ 250，即约四分之一大体型 + BOSS 主动） */
const AGGRESSIVE_BODY_WIDTH = 250;
/** 规则：出售价按定位取「每级单价」（normal / elite / boss） */
const SELL_PRICE_PER_LEVEL = { normal: 2, elite: 5, boss: 20 };
/** 几何基准帧：stand 动作、正面（DOWN，方向下标 4）、该方向第 1 帧（start 0 + 4×spacing 10） */
const STAND_DOWN_FRAME = 40;

//#region 1. 读旧表（保留手工数据）

const src = fs.readFileSync(MONSTER_TS, "utf8");

const aiStart = src.indexOf("export const monsterAI");
const aiEnd = src.indexOf("\n};", aiStart) + 3;
if (aiStart < 0 || aiEnd < 3) throw new Error("旧表里找不到 monsterAI 块");
const aiBlock = src.slice(aiStart, aiEnd);

const dataStart = src.indexOf("const monsterData");
const dataEnd = src.indexOf("\n];", dataStart);
if (dataStart < 0 || dataEnd < 0) throw new Error("旧表里找不到 monsterData 数组");

const monsters = [];
const blocks = src.slice(dataStart, dataEnd).split(/\n  \{/).slice(1);
for (const block of blocks) {
  const grab = (re) => {
    const m = re.exec(block);
    return m ? m[1] : undefined;
  };
  const key = grab(/key:\s*"([^"]+)"/);
  if (!key) continue;
  // 旧条目里的 speedRate 覆盖（非全 1 才保留；1~4 号那份全 1 是历史默认，收敛进 monsterDefaultSpeedRate）
  const rateBlock = /speedRate:\s*\{([\s\S]*?)\n\s*\},?\s*$/.exec(block.trimEnd());
  const speedRate = {};
  if (rateBlock) {
    const reRate = /\[ACTION\.(\w+)\]:\s*([\d.]+)/g;
    let r;
    while ((r = reRate.exec(rateBlock[1]))) speedRate[r[1]] = Number(r[2]);
  }
  const hasOverride = Object.keys(speedRate).length > 0 && !Object.values(speedRate).every((v) => v === 1);
  monsters.push({
    key,
    level: Number(grab(/level:\s*(\d+)/)),
    tier: grab(/tier:\s*"(\w+)"/),
    icon: grab(/icon:\s*"([^"]+)"/),
    out: grab(/out:\s*"([^"]+)"/),
    label: grab(/label:\s*"([^"]+)"/),
    moveSpeed: grab(/moveSpeed:\s*([\d.]+)/) ?? "2",
    detectRange: grab(/detectRange:\s*([\d.]+)/) ?? "200",
    description: grab(/description:\s*"([^"]*)"/),
    speedRate: hasOverride ? speedRate : undefined,
  });
}
if (!monsters.length) throw new Error("旧表一条怪物都没解析到，中止（防止误清空）");
console.log("旧表怪物:", monsters.length);

//#endregion

//#region 2. 读素材 meta（auto-trim 实测）

function readTrim(outPath) {
  const id = outPath.split("/").pop();
  const metaPath = path.join(OUT_DIR, id, `${String(STAND_DOWN_FRAME).padStart(5, "0")}.png.meta`);
  if (!fs.existsSync(metaPath)) throw new Error(`找不到基准帧 meta：${metaPath}`);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  // sprite-frame 子 meta 的 id 是内容哈希（通常为 f9941），按 importer 找更稳
  const sfMeta = Object.values(meta.subMetas).find((sub) => sub.importer === "sprite-frame");
  const data = sfMeta && sfMeta.userData;
  if (!data || typeof data.width !== "number") throw new Error(`meta 里没有 trim 数据：${metaPath}`);
  return {
    width: data.width,
    height: data.height,
    offsetX: data.offsetX ?? 0,
    offsetY: data.offsetY ?? 0,
  };
}

for (const mon of monsters) {
  if (!mon.out) throw new Error(`怪物 ${mon.key} 缺 out 字段`);
  const trim = readTrim(mon.out);
  mon.contentSize = { width: trim.width, height: trim.height };
  // 裁剪区中心相对画布中心偏了 (offsetX, offsetY)（y 向上为正）→ 外观节点反向摆，身体中心就回到原点
  mon.outOffset = { x: -trim.offsetX, y: -trim.offsetY };
  mon.aggressive = mon.tier === "boss" || trim.width >= AGGRESSIVE_BODY_WIDTH;
  mon.sellPirce = mon.level * SELL_PRICE_PER_LEVEL[mon.tier ?? "normal"];
}

const aggressiveCount = monsters.filter((m) => m.aggressive).length;
console.log(`主动怪: ${aggressiveCount}/${monsters.length}（body 宽 ≥ ${AGGRESSIVE_BODY_WIDTH} 或 boss）`);
const widths = monsters.map((m) => m.contentSize.width);
console.log(`身体宽 min/median/max: ${Math.min(...widths)}/${widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 2)]}/${Math.max(...widths)}`);

//#endregion

//#region 3. 生成文件

const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(n));
const fmtVec = (v) => `new Vec2(${fmtNum(v.x)}, ${fmtNum(v.y)})`;
const fmtSize = (s) => `new Size(${s.width}, ${s.height})`;
const fmtRate = (rate) =>
  Object.entries(rate)
    .map(([action, value]) => `      [ACTION.${action}]: ${value},`)
    .join("\n");

const lines = [];
lines.push(`import { Size, Vec2 } from "cc";`);
lines.push(`import { ACTION, SpeedRate } from "../types/animation";`);
lines.push(`import { MonsterConfig, MonsterData } from "../types/monster";`);
lines.push(`import { monsterStats } from "./growth";`);
lines.push(`import { monsterDropPicks, monsterDrops } from "./drop";`);
lines.push(`import { getMonsterDropConfig } from "./monsterDrops";`);
lines.push("");
lines.push("/**");
lines.push(" * 怪物数据表");
lines.push(" *");
lines.push(" * **key 只做关联**：地图对象组里的 id、掉落 / 技能 / AI 要引用同一只怪时都用 key，");
lines.push(" * 它可以是任意字符串（\"1\"、\"goblin_chief\" 都行），**不参与任何数值计算**。");
lines.push(" * 数值全部按**等级**从 configs/growth 的成长曲线取：");
lines.push(" * - level：这只怪自己的等级（唯一定级入口，想调强弱就改它）");
lines.push(" * - tier：定位 normal / elite / boss（不写 = normal），决定同等级下的强度倍率（见 configs/growth 的 monsterTierScale）");
lines.push(" * - 六项攻防与 maxHp：由 monsterStats(level, tier) 按等级生成，不用手写");
lines.push(" *   · 想单独改某只怪（法系怪要魔法攻击、特殊怪要更高血量）→ 直接在条目里覆盖同名字段");
lines.push(" *   · 想整体调手感（怪更耐打 / 打人更疼）→ 改 configs/growth 的 monsterBalance / roleGrowth");
lines.push(" *");
lines.push(" * **掉落**：每只怪的掉落列表独立配置在 configs/monsterDrops（key 与这里一一对应，");
lines.push(" * 条目里逐条配 weight/chance/count）；这里只做「条目里的 drops/dropPicks 覆盖 > 独立掉落表 > 兜底生成」三级取值。");
lines.push(" *");
lines.push(" * **几何 / 玩法字段由 tools/gen-monster-config.cjs 生成**（数据源 = 素材 .meta 的 auto-trim 实测，");
lines.push(" * 与引擎渲染同一口径；改生成器头部的规则后重跑即可，手工微调直接改条目）：");
lines.push(` * - contentSize：基准帧（stand·正面·第 ${STAND_DOWN_FRAME} 帧）裁剪后的**可见身体尺寸** ——`);
lines.push(" *   碰撞盒（MonsterCollider）、点击选中（UITransform.hitTest）、头顶血条位置都由它决定；");
lines.push(" * - outOffset：外观节点摆放偏移（裁剪区中心相对画布中心的反向偏移），");
lines.push(" *   把可见身体中心对准节点原点（消费点 GameUiHelper.createMonsterBody）；");
lines.push(` * - aggressive：tier=boss 或身体宽 ≥ ${AGGRESSIVE_BODY_WIDTH}px 判主动；`);
lines.push(" * - sellPirce：normal = level×2 / elite = level×5 / boss = level×20（击杀奖励预留，当前无消费点）；");
lines.push(" * - speedRate：条目里默认不写，运行时取下方 monsterDefaultSpeedRate 打底；");
lines.push(" *   想给个别怪调速就在条目里写 speedRate: { stand: 2 }（只写要改的动作，生成器会原样保留）。");
lines.push(" */");
lines.push("");
lines.push(aiBlock);
lines.push("");
lines.push("/**");
lines.push(" * 怪物默认动作速度（**每秒循环数**，片段总时长 = 1 / 该值，见 AnimationHelper.createClip）");
lines.push(" * 怪物素材是统一帧规格（见 configs/animation 的 monsterActionSpecs：stand 4 帧 / walk·run 6 帧 /");
lines.push(" * injured 2 帧 / die 10 帧，没有攻击帧——播攻击动作时回退待机），所以全怪共用一套默认即可；");
lines.push(" * 想单独调某只怪 → 条目里写 speedRate 覆盖（与角色 defaultRoleSpeedRate 同构）");
lines.push(" */");
lines.push("export const monsterDefaultSpeedRate: SpeedRate = {");
lines.push("  [ACTION.STAND]: 1, // 4 帧 / 1 秒：缓慢的呼吸循环");
lines.push("  [ACTION.WALK]: 1, // 6 帧 / 1 秒，与角色步行循环同速");
lines.push("  [ACTION.RUN]: 1, // 6 帧 / 1 秒");
lines.push("  [ACTION.ATTACK_NEAR]: 2, // 素材暂无攻击帧（回退待机），留 0.5 秒一击的默认");
lines.push("  [ACTION.ATTACK_SKILL_1]: 2,");
lines.push("  [ACTION.TEST3]: 1,");
lines.push("  [ACTION.ATTACK_FAR]: 2,");
lines.push("  [ACTION.INJURED]: 2, // 受击只有 2 帧，0.5 秒抖一下");
lines.push("  [ACTION.A1]: 1,");
lines.push("  [ACTION.DIE]: 1, // 10 帧 / 1 秒：一秒倒地");
lines.push("  [ACTION.TEST1]: 1,");
lines.push("};");
lines.push("");
lines.push("const monsterData: MonsterData[] = [");
for (const mon of monsters) {
  lines.push("  {");
  lines.push(`    key: "${mon.key}",`);
  lines.push(`    level: ${mon.level},`);
  if (mon.tier) lines.push(`    tier: "${mon.tier}",`);
  lines.push(`    icon: "${mon.icon}",`);
  lines.push(`    out: "${mon.out}",`);
  lines.push(`    outOffset: ${fmtVec(mon.outOffset)},`);
  lines.push(`    label: "${mon.label}",`);
  lines.push(`    moveSpeed: ${mon.moveSpeed},`);
  lines.push(`    aggressive: ${mon.aggressive},`);
  lines.push(`    detectRange: ${mon.detectRange},`);
  lines.push(`    description: "${mon.description ?? mon.label}",`);
  lines.push(`    sellPirce: ${mon.sellPirce},`);
  lines.push(`    contentSize: ${fmtSize(mon.contentSize)},`);
  if (mon.speedRate) {
    lines.push("    speedRate: {");
    lines.push(fmtRate(mon.speedRate));
    lines.push("    },");
  }
  lines.push("  },");
}
lines.push("];");
lines.push("");
lines.push("/** 怪物配置（key → 配置）：等级取自条目里的 level，属性由 monsterStats(level, tier) 按等级生成 */");
lines.push("export const monsters = new Map<string, MonsterConfig>();");
lines.push("for (const data of monsterData) {");
lines.push("  const { key, tier, drops, dropPicks, ...rest } = data;");
lines.push("  // 掉落优先取「每只怪独立掉落表」（configs/monsterDrops）；条目里写了 drops/dropPicks 则再覆盖；");
lines.push("  // 两者都没有（例如新加的怪还没铺掉落）→ 退回 configs/drop 的按等级兜底生成器");
lines.push("  const dropConfig = getMonsterDropConfig(key);");
lines.push("  monsters.set(key, {");
lines.push("    ...monsterStats(data.level, tier),");
lines.push("    ...rest,");
lines.push("    // 动作速度：默认表打底，条目里写了 speedRate 则逐动作覆盖（见 monsterDefaultSpeedRate）");
lines.push("    speedRate: { ...monsterDefaultSpeedRate, ...data.speedRate },");
lines.push("    drops: drops ?? dropConfig?.entries ?? monsterDrops(data.level, tier),");
lines.push("    dropPicks: dropPicks ?? dropConfig?.picks ?? monsterDropPicks(tier),");
lines.push("  });");
lines.push("}");
lines.push("");
lines.push("export default monsters;");
lines.push("");

const out = lines.join("\n");
fs.writeFileSync(MONSTER_TS, out, "utf8");
console.log("写入:", MONSTER_TS, `(${(Buffer.byteLength(out) / 1024).toFixed(1)} KB, ${lines.length} 行)`);

//#endregion
