#!/usr/bin/env node
/**
 * 生成 server/src/shared/monster-presentation.generated.ts（重写整个文件）
 *
 * **#588 数据归属收口：客户端没有怪物数据文件**。本生成器把怪物的「资源与表现」事实
 * 写进**服务端**的生成物（icon / out / 几何 / 移动 / AI 参数），经 `GET /game-config`
 * 快照的 monsterPresentations 段下发 —— 客户端运行时才拿到，本地不再持有副本。
 * 数值（label / level / tier / maxHp / 六项）不归本生成器管：出厂在 monster-seed.ts，
 * 运行时权威在 monsters 表（管理端可改）。
 *
 * 数据来源：
 * 1. 上一份 monster-presentation.generated.ts —— 保留手工调过的 moveSpeed / detectRange /
 *    speedRate 覆盖（素材里没有这些事实）。「上一份生成物」是这些手工值的**唯一住址**，
 *    客户端 configs 里没有副本（#588 之后就没再有过）；
 * 2. assets/resources/monster/out/<id>/stand/stand.plist —— 图集（#235 已把散帧打包）里
 *    基准帧的 trim 数据（与引擎渲染同一口径），从中取：
 *      · contentSize = spriteSize（裁剪区尺寸）＝ 可见身体尺寸；
 *        碰撞盒（MonsterCollider）、点击选中（UITransform.hitTest）、头顶血条位置全由它决定；
 *      · outOffset   = -spriteOffset（裁剪区中心相对画布中心的反向偏移，双轴取反），
 *        外观节点摆在它上面可见身体中心就正好落在节点原点（消费点 GameUiHelper.createMonsterBody）；
 * 3. server/src/shared/monster-seed.ts —— 只读 `tier`（aggressive 判定用），**不读数值**。
 *
 * 规则：
 * - aggressive：服务端种子里 tier === "boss" 或可见身体宽 ≥ AGGRESSIVE_BODY_WIDTH 判主动；
 * - moveSpeed / detectRange：沿用上一份的值（保持全员 2 / 200），想调直接改上一份生成物对应行
 *   （生成器会原样保留；这份数据服务端管，客户端只是消费）；
 * - speedRate：条目覆盖原样保留（非全 1 才写）。
 *
 * **key 双向对账**：种子（数值）与本生成器（资源）必须一一对应，多一只少一只都直接报错 ——
 * 加一只怪的正确姿势：素材入库重跑本生成器（服务端资源行）+ monster-seed.ts 加一行（数值），
 * 重启服务端（seed 进表），客户端重启后从快照拿到全部数据。
 *
 * 运行：node client/tools/gen-monster-config.cjs
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "..");
const OUT_TS = path.join(REPO, "server/src/shared/monster-presentation.generated.ts");
const SERVER_SEED_TS = path.join(REPO, "server/src/shared/monster-seed.ts");
// #235 起帧动画是图集（stand.png + stand.plist），不再有散帧 meta
const OUT_DIR = path.join(ROOT, "assets/resources/monster/out");

/** 规则：可见身体宽达到该值（像素）判主动怪（220 只怪身体宽 p75 ≈ 250，即约四分之一大体型 + BOSS 主动） */
const AGGRESSIVE_BODY_WIDTH = 250;
/** 几何基准帧：图集 stand 是 8 向 × 4 帧，帧名 d<方向>_<序号>；方向 4 = 正面（DOWN）第 0 帧 */
const STAND_BASE_FRAME = "d4_00.png";

//#region 1. 读上一份的手工值（moveSpeed / detectRange / speedRate 覆盖）

function parseEntries(text) {
  const entries = new Map();
  const dataStart = text.indexOf("const monsterData");
  const source = dataStart >= 0 ? text.slice(dataStart, text.indexOf("\n];", dataStart)) : text;
  const blocks = source.split(/\n  \{/).slice(1);
  for (const block of blocks) {
    const grab = (re) => {
      const m = re.exec(block);
      return m ? m[1] : undefined;
    };
    // 生成物里字段叫 `id`（服务端口径），迁移期的客户端旧表叫 `key` —— 两个都认
    const key = grab(/(?:id|key):\s*"([^"]+)"/);
    if (!key) continue;
    // speedRate 覆盖（非全 1 才保留；全 1 是历史默认，收敛进客户端 monsterDefaultSpeedRate）
    const rateBlock = /speedRate:\s*\{([\s\S]*?)\n\s*\},?\s*$/.exec(block.trimEnd());
    const speedRate = {};
    if (rateBlock) {
      const reRate = /\[ACTION\.(\w+)\]:\s*([\d.]+)/g;
      let r;
      while ((r = reRate.exec(rateBlock[1]))) speedRate[r[1]] = Number(r[2]);
    }
    const hasOverride = Object.keys(speedRate).length > 0 && !Object.values(speedRate).every((v) => v === 1);
    entries.set(key, {
      icon: grab(/icon:\s*"([^"]+)"/),
      out: grab(/out:\s*"([^"]+)"/),
      moveSpeed: grab(/moveSpeed:\s*([\d.]+)/) ?? "2",
      detectRange: grab(/detectRange:\s*([\d.]+)/) ?? "200",
      speedRate: hasOverride ? speedRate : undefined,
    });
  }
  return entries;
}

const generatedText = fs.existsSync(OUT_TS) ? fs.readFileSync(OUT_TS, "utf8") : "";
const handValues = parseEntries(generatedText);
if (handValues.size === 0) throw new Error("上一份怪物数据一条都解析到，中止（防止误清空）");
console.log(`手工值来源: 上一份 monster-presentation.generated.ts（${handValues.size} 条）`);

//#endregion

//#region 2. 读服务端种子（只读 tier）+ 双向对账

const seedSrc = fs.readFileSync(SERVER_SEED_TS, "utf8");
const seedBlock = seedSrc.slice(seedSrc.indexOf("export const MONSTER_SEED_ROWS"), seedSrc.indexOf("\n];", seedSrc.indexOf("export const MONSTER_SEED_ROWS")));
const seedTier = new Map();
const seedKey = /\{ id: "([^"]+)", label: "[^"]*", level: \d+, tier: "(\w+)" \}/g;
let sm;
while ((sm = seedKey.exec(seedBlock))) seedTier.set(sm[1], sm[2]);
if (seedTier.size === 0) throw new Error("服务端种子里一行都没解析到，中止（monster-seed.ts 形状变了？）");

const handKeys = new Set(handValues.keys());
const seedKeys = new Set(seedTier.keys());
const onlyHand = [...handKeys].filter((k) => !seedKeys.has(k));
const onlySeed = [...seedKeys].filter((k) => !handKeys.has(k));
if (onlyHand.length || onlySeed.length) {
  throw new Error(
    "资源行与服务端种子（数值）的怪物 key 不一致，先补齐再加资源：\n" +
      (onlyHand.length ? `  只在资源行（种子缺数值行）：${onlyHand.join(", ")}\n` : "") +
      (onlySeed.length ? `  只在种子（缺资源行）：${onlySeed.join(", ")}\n` : ""),
  );
}

//#endregion

//#region 3. 读素材图集（trim 实测）

function readTrim(outPath) {
  const id = outPath.split("/").pop();
  const plistPath = path.join(OUT_DIR, id, "stand", "stand.plist");
  if (!fs.existsSync(plistPath)) throw new Error(`找不到图集：${plistPath}`);
  const plist = fs.readFileSync(plistPath, "utf8");
  const i = plist.indexOf(`<key>${STAND_BASE_FRAME}</key>`);
  if (i < 0) throw new Error(`图集里没有基准帧 ${STAND_BASE_FRAME}：${plistPath}`);
  const seg = plist.slice(i, i + 700);
  const tuple = (name) => {
    const m = new RegExp(`<key>${name}</key>\\s*<string>\\{([^}]+)\\}`).exec(seg);
    if (!m) throw new Error(`基准帧缺 ${name}：${plistPath}`);
    return m[1].split(",").map(Number);
  };
  const size = tuple("spriteSize");
  const offset = tuple("spriteOffset");
  return {
    width: size[0],
    height: size[1],
    offsetX: offset[0],
    offsetY: offset[1],
  };
}

const rows = [];
for (const [key, hand] of [...handValues].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  if (!hand.out) throw new Error(`怪物 ${key} 缺 out 字段`);
  const trim = readTrim(hand.out);
  const aggressive = seedTier.get(key) === "boss" || trim.width >= AGGRESSIVE_BODY_WIDTH;
  rows.push({ key, hand, aggressive, contentSize: trim, outOffset: { x: -trim.offsetX, y: -trim.offsetY } });
}

const aggressiveCount = rows.filter((r) => r.aggressive).length;
console.log(`主动怪: ${aggressiveCount}/${rows.length}（body 宽 ≥ ${AGGRESSIVE_BODY_WIDTH} 或种子 tier=boss）`);
const widths = rows.map((r) => r.contentSize.width);
console.log(`身体宽 min/median/max: ${Math.min(...widths)}/${widths.slice().sort((a, b) => a - b)[Math.floor(widths.length / 2)]}/${Math.max(...widths)}`);

//#endregion

//#region 4. 生成服务端文件

const fmtVec = (v) => `[${v.x}, ${v.y}]`;
const fmtSize = (s) => `[${s.width}, ${s.height}]`;
const fmtRate = (rate) =>
  Object.entries(rate)
    .map(([action, value]) => `${action}: ${value}`)
    .join(", ");

const lines = [];
lines.push("/**");
lines.push(" * ⚠️ 生成物，请勿手改 —— @generated by client/tools/gen-monster-config.cjs");
lines.push(" *");
lines.push(" * 怪物**资源与表现**行（#588：客户端没有怪物数据文件，这里 + GET /game-config 快照");
lines.push(" * `monsterPresentations` 段是客户端拿数据的唯一通道；服务端权威 AI 也消费 aggressive/");
lines.push(" * detectRange/moveSpeed）。数值（label / level / tier / maxHp / 六项）不在这份文件 ——");
lines.push(" * 出厂在 `monster-seed.ts`（紧凑四元组 + 曲线展开），运行时权威在 `monsters` 表（管理端可改）。");
lines.push(" *");
lines.push(" * 几何（contentSize / outOffset）从图集基准帧的 trim 实测（与引擎渲染同一口径）；");
lines.push(" * moveSpeed / detectRange / speedRate 覆盖沿用上一份的值（生成器原样保留，要调直接改上一份再重跑）。");
lines.push(" * key 与 monster-seed.ts 双向对账（生成器断言），加怪两边都要加。");
lines.push(" */");
lines.push("export interface MonsterPresentationRow {");
lines.push("  id: string;");
lines.push("  icon: string;");
lines.push("  out: string;");
lines.push("  outOffset: [number, number];");
lines.push("  contentSize: [number, number];");
lines.push("  moveSpeed: number;");
lines.push("  aggressive: boolean;");
lines.push("  detectRange: number;");
lines.push("  speedRate?: Record<string, number>;");
lines.push("}");
lines.push("");
lines.push("export const MONSTER_PRESENTATION_ROWS: MonsterPresentationRow[] = [");
for (const row of rows) {
  lines.push("  {");
  lines.push(`    id: "${row.key}",`);
  lines.push(`    icon: "${row.hand.icon}",`);
  lines.push(`    out: "${row.hand.out}",`);
  lines.push(`    outOffset: ${fmtVec(row.outOffset)},`);
  lines.push(`    contentSize: ${fmtSize(row.contentSize)},`);
  lines.push(`    moveSpeed: ${row.hand.moveSpeed},`);
  lines.push(`    aggressive: ${row.aggressive},`);
  lines.push(`    detectRange: ${row.hand.detectRange},`);
  if (row.hand.speedRate) lines.push(`    speedRate: { ${fmtRate(row.hand.speedRate)} },`);
  lines.push("  },");
}
lines.push("];");
lines.push("");

const out = lines.join("\n");
fs.writeFileSync(OUT_TS, out, "utf8");
console.log("写入:", OUT_TS, `(${(Buffer.byteLength(out) / 1024).toFixed(1)} KB, ${lines.length} 行)`);

//#endregion
