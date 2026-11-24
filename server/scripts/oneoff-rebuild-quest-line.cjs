#!/usr/bin/env node
/**
 * 一次性补数据：星灯纪任务线重建（#1215）
 *
 *   cd server && node scripts/oneoff-rebuild-quest-line.cjs              # 干跑：只打印要写什么
 *   cd server && node scripts/oneoff-rebuild-quest-line.cjs --apply      # 真写库
 *   node scripts/oneoff-rebuild-quest-line.cjs --db /path/to/olua.db     # 换一个库（默认 DB_PATH / data/olua.db）
 *
 * 部署机上：
 *   docker exec olua-server node scripts/oneoff-rebuild-quest-line.cjs --apply
 *
 * ## 这刀写什么（五张表，全部行级）
 *
 * 一、`monsters`：199 只普通怪按等级序分给 58 张野外图（每图 3 只起步、面积最大的 25 张
 *     图 4 只），21 只 boss 按里程碑图分配；**怪物等级 := 所在图等级**，属性按「同等级
 *     共享模板」口径重写。模板 1~60 取库内现状（校验同档一致），61~69 沿 51~60 段的
 *     每级增量线性外推——与角色曲线同段线性延续，每级击杀回合数不变（升级体感顺滑）。
 *     boss 的模板单独算（与普通怪不同量纲）：已知等级间线性插值，低于最低档按比例缩放，
 *     高于最高档沿末段每级增量外推。
 * 二、`map_spawn_areas`：每物种一区（3~4 区/图）+ boss 图 1 个首领区；区域几何按地图
 *     像素尺寸四象限展开，越界钳进图内。任务图的主力区物种 = 该图第一个物种，与任务
 *     的击杀目标同源（同一分配算法推导）。
 * 三、`npcs` + `map_npcs`：9 个星灯纪 NPC（立绘 npc/2130~2138，缺帧由运营补图）+ 各自
 *     的图上点位（复活点旁）；顺带补 config-sync.sql 里已有而库缺的 0101@图0 点位。
 * 四、`quests`：28 条主线（7000 段，避开 e2e seed 的 8000/8100 段），严格 prev 线性链；
 *     min_level = 目标图等级（talk 取发布图与目标图的较大值）；经验奖励从
 *     `role_level_curves` **现算**（击杀 ≈ 40% / boss ≈ 60% / talk ≈ 20% 的升级需求），
 *     不抄第二份曲线；绑金 = (min_level+1)×100（boss ×3）；boss 任务发药品。
 *
 * ## 幂等
 *
 * 全部按「先删自己这批再插」：quests 按 id 清、npcs/map_npcs 按 npc_id 清、刷怪区整表
 * 重建（#1177 起本表就归本脚本管）、monsters 只 UPDATE。重跑只在值有变时才写。
 *
 * ## 快照可见性
 *
 * `--apply` 成功后会把 `config_version` +1（见 main 末尾）：客户端快照按这个版本缓存，
 * 不推版本的话运行中的服务端会一直发旧数据（直接改库不经过管理端写接口的版本拦截器）。
 *
 * ## 不碰什么
 *
 * maps / monster_drops / monster_presentation / 成就 / 曲线段——运营数据与本刀无关。
 */
"use strict";

const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const tooling = require("./lib/db-tooling.cjs");

const SOURCE = "oneoff-quest-line";
const NOW = () => Date.now();

// =====================================================================
// 星灯纪剧本（唯一数据源：本文件）
// =====================================================================

/** 9 个新 NPC（id / 名称 / 立绘 / 驻图 / 对话文案） */
const NPCS = [
  {
    id: "1101", label: "守灯长老·苍梧", src: "npc/2130", mapId: "0",
    dialog: "星坠之夜，我守了六十年的灯第一次黯了。年轻人，你的影子里有灯芯的微光——你就是传说里的执灯人。去吧，大陆的灯火，就托付给你了。",
  },
  {
    id: "1102", label: "猎户·燕七", src: "npc/2131", mapId: "2",
    dialog: "村外的野兽这几年越来越不对劲——眼里有火星子。你既执灯，就替村里清一清。",
  },
  {
    id: "1103", label: "药师·白芷", src: "npc/2132", mapId: "5",
    dialog: "星尘入药能救人，入地脉能害人。断崖的瘴气我闻得出——那不是毒，是魔。小心些。",
  },
  {
    id: "1104", label: "卧龙城守将·赵擎", src: "npc/2133", mapId: "9",
    dialog: "北境告急！魔潮自紫泉洞窟涌出，一路往南。执灯人，朝廷的兵守城，野外的魔，得靠你的灯。",
  },
  {
    id: "1105", label: "老矿工·韩掘", src: "npc/2134", mapId: "10",
    dialog: "我在矿道里挖了四十年，头一回听见地底下有喘气声。泉眼底下那东西……老汉不敢想。你去看看吧。",
  },
  {
    id: "1106", label: "王城军师·沈九章", src: "npc/2135", mapId: "33",
    dialog: "西境十一座烽台，七日连灭五座。深渊先锋已入境内——本官要的胜负手，是你的灯。",
  },
  {
    id: "1107", label: "斥候·夜未央", src: "npc/2136", mapId: "34",
    dialog: "西境活着的眼线只剩我一个。布防图、暗桩、逃生道——都给你。但先让我看看，你配不配拿它。",
  },
  {
    id: "1108", label: "冰原向导·雪里鸿", src: "npc/2137", mapId: "47",
    dialog: "冰原上的路，白天是路，夜里是坟。跟着我的脚印走——灯别灭，灯一灭，我救不了你。",
  },
  {
    id: "1109", label: "花庭圣女·洛神蘅", src: "npc/2138", mapId: "61",
    dialog: "七块星屑合一，深渊之门自开。执灯人，四十年前的预言今夜应验——此战过后，愿大陆灯火长明。",
  },
];

/**
 * 28 条主线（严格按数组顺序成 prev 链）
 *
 * objective.type：kill（杀 targetMap 主力怪 ×10）/ boss（杀 targetMap 的 boss ×1）/
 * talk（去 targetNpc 所在处对话 ×1）。description 里的 {monster} 会在落库时替换成
 * 目标怪名（boss 任务替换 boss 名）。
 */
const QUESTS = [
  { id: "7001", label: "星坠之夜", npc: "1101", type: "kill", map: "1",
    desc: "星坠之夜，守灯长老苍梧把你唤到灯前——灯芯黯淡，星尘已污染了村外的八卦台。替长老清剿 10 只{monster}，让守灯重新亮起来。" },
  { id: "7002", label: "校场试炼", npc: "1102", type: "kill", map: "2",
    desc: "猎户燕七在校场等你：星尘落进青石校场后，{monster}成群出没，操练的新兵不敢出门。清掉 10 只，还校场一片清净。" },
  { id: "7003", label: "百旗之乱", npc: "1102", type: "kill", map: "3",
    desc: "百旗围场的百旗一夜之间全被魔气蚀黑。燕七说，旗倒人散——把 10 只{monster}清了，把旗立回来。" },
  { id: "7004", label: "南寻药师", npc: "1101", type: "talk", npcTarget: "1103",
    desc: "灯芯碎片的第一缕光指向南边。去盘根断崖找药师白芷——她认得星尘的踪迹。" },
  { id: "7005", label: "断崖毒瘴", npc: "1103", type: "kill", map: "5",
    desc: "白芷说断崖的毒瘴变了性，是星屑沾了地脉。清剿 10 只{monster}，她才敢进崖采药。" },
  { id: "7006", label: "洞窟火患", npc: "1103", type: "kill", map: "6",
    desc: "火焰洞窟的火不是地火，是星屑在烧。白芷要进洞配药，你先把 10 只{monster}清出一条路。" },
  { id: "7007", label: "矿坑救工", npc: "1103", type: "kill", map: "7",
    desc: "陷坑矿场的矿工被困在坑道里。白芷的药要矿工来运——清掉 10 只{monster}，救他们出来。" },
  { id: "7008", label: "庙门镇邪", npc: "1101", type: "boss", map: "8",
    desc: "苍梧掐指一算：第一块灯芯碎片，就压在破败庙门那头{monster}身下。去取回来。" },
  { id: "7009", label: "北境告急", npc: "1104", type: "talk", npcTarget: "1105",
    desc: "灯芯碎片指向北境。卧龙城守将赵擎战报如火——魔潮从紫泉洞窟涌出。先去洞窟口找老矿工韩掘，他是最后一个从深处上来的人。" },
  { id: "7010", label: "泉眼怪物", npc: "1105", type: "kill", map: "10",
    desc: "韩掘说泉眼底下有东西在喘气。他不敢再下去——替他清掉 10 只{monster}，看看泉眼到底怎么了。" },
  { id: "7011", label: "土径匪患", npc: "1105", type: "kill", map: "12",
    desc: "魔潮顺着落日土径往南渗。韩掘的矿车队被堵在半路——清掉 10 只{monster}，把路打通。" },
  { id: "7012", label: "石堂夺旗", npc: "1104", type: "kill", map: "15",
    desc: "赵擎点兵：金盘石堂的战旗营失联。清掉 10 只{monster}，把战旗夺回来。" },
  { id: "7013", label: "青焰异动", npc: "1104", type: "kill", map: "22",
    desc: "斥候来报，青焰石室的火光夜里变成了青色。赵擎让你去看——清掉 10 只{monster}，别让它烧出石室。" },
  { id: "7014", label: "大殿幽影", npc: "1104", type: "kill", map: "24",
    desc: "紫曜大殿的灯，一夜之间全灭了。赵擎说灯灭的地方必有魔——清掉 10 只{monster}，把灯点回来。" },
  { id: "7015", label: "沉渊残兵", npc: "1104", type: "kill", map: "27",
    desc: "沉渊残台的旧守军没有撤干净，他们还站在岗上——只是已经不是人了。清掉 10 只{monster}，让他们安息。" },
  { id: "7016", label: "浴龙池惊龙", npc: "1104", type: "boss", map: "32",
    desc: "魔潮之源找到了：浴龙池底。赵擎把最后一道令箭交给你——下去，斩了那头{monster}。" },
  { id: "7017", label: "军师委托", npc: "1106", type: "talk", npcTarget: "1107",
    desc: "王城军师沈九章览尽战报：深渊先锋已入西境。带着军师的手令去废土营寨找斥候夜未央——她是西境唯一还活着的眼线。" },
  { id: "7018", label: "营寨拔钉", npc: "1107", type: "kill", map: "34",
    desc: "夜未央说营寨里的人都成了{monster}的形状。清掉 10 只，她才敢把西境的布防图交给你。" },
  { id: "7019", label: "雷台试炼", npc: "1107", type: "kill", map: "38",
    desc: "布防图上第一个标记是云海雷台。夜未央要在雷台上试你的斤两——清掉 10 只{monster}，再谈下一步。" },
  { id: "7020", label: "藏宝殿劫案", npc: "1107", type: "kill", map: "41",
    desc: "藏宝殿的镇殿之宝「引星盘」失窃，夜未央查出是{monster}干的。清掉 10 只——星屑的下落就藏在殿里。" },
  { id: "7021", label: "方城水患", npc: "1106", type: "kill", map: "45",
    desc: "碧水方城的水闸被魔物占了。沈九章说方城一破，王城西境再无可守——清掉 10 只{monster}，守住水闸。" },
  { id: "7022", label: "荒原冰棘", npc: "1108", type: "kill", map: "47",
    desc: "过了冰棘荒原就是深渊魔潮的老巢。向导雪里鸿只带认路的人——清掉 10 只{monster}，让他看看你的本事。" },
  { id: "7023", label: "废墟冰晶", npc: "1108", type: "kill", map: "54",
    desc: "冰晶废墟的冰层下埋着上古战场。雪里鸿说星屑的第三缕光就在那里——清掉 10 只{monster}，破冰取光。" },
  { id: "7024", label: "幽灯守卫", npc: "1108", type: "boss", map: "58",
    desc: "幽灯石室的灯亮了千年，守灯的不是人，是{monster}。雪里鸿把最后一盏灯递给你——去，吹灭它。" },
  { id: "7025", label: "围城之战", npc: "1109", type: "kill", map: "59",
    desc: "环水花庭，圣女洛神蘅揭开最后的谜：七块星屑合一，深渊之门就在土堡围城后。清掉 10 只{monster}，为大军开路。" },
  { id: "7026", label: "庄园决战", npc: "1109", type: "kill", map: "60",
    desc: "木栅庄园是最后一道防线。洛神蘅把花庭的灯芯交给你——清掉 10 只{monster}，一步都不能退。" },
  { id: "7027", label: "深渊主祭", npc: "1109", type: "boss", map: "60",
    desc: "深渊之门开了。守门的是{monster}。洛神蘅说：执灯人，此战之后，大陆再无魔潮。去，斩了它。" },
  { id: "7028", label: "凯旋封灯", npc: "1109", type: "talk", npcTarget: "1101",
    desc: "灯芯合一，魔潮退散。洛神蘅为你送行——回望星台，把灯重新点亮，告诉苍梧：执灯人，不负所托。" },
];

/** boss 任务图（剧本钉死的四张里程碑图；其余 boss 均匀铺在剩余野外图上） */
const STORY_BOSS_MAPS = ["8", "32", "58", "60"];

/** 任务经验占升级需求的比例（#1215 拍板：击杀 40% / boss 60% / talk 20%） */
const EXP_PCT = { kill: 0.4, boss: 0.6, talk: 0.2 };

/** boss 任务的物品奖励（goodId 必须是现有掉落物 id；随章节升级） */
const BOSS_ITEMS = [
  [{ goodId: "drug_hp_1", count: 3 }],
  [{ goodId: "drug_hp_2", count: 3 }],
  [{ goodId: "drug_hp_3", count: 3 }],
  [{ goodId: "drug_hp_pct", count: 2 }, { goodId: "drug_mp_pct", count: 2 }],
];

/** 奖励物品序列化（与 common/utils/reward-items.util.ts 同形） */
function itemsJson(items) {
  return JSON.stringify(items ?? []);
}

// =====================================================================
// 数据推导
// =====================================================================

/** 库里的普通怪按等级序排列（同等级按 id 序；等级序即分配序） */
function loadNormals(db) {
  return db.prepare("SELECT id, label, level, tier FROM monsters WHERE tier='normal' ORDER BY level, CAST(id AS INTEGER)").all();
}

/** 野外图按等级序（安全城 type='0' 不参与刷怪与分配） */
function loadWildMaps(db) {
  return db
    .prepare("SELECT map_id, label, type, level, pixel_width, pixel_height, revive_cx, revive_cy FROM maps WHERE type != '0' ORDER BY level, CAST(map_id AS INTEGER)")
    .all();
}

/**
 * 物种 → 图的分配（唯一真相：本函数）
 *
 * 每图 3 只起步；面积最大的 25 张图各 +1（199 = 58×3 + 25）。按等级序依次领取，
 * 主题顺序与等级阶梯天然同向，重排幅度有限。
 */
function assignSpecies(normals, wildMaps) {
  const EXTRA = normals.length - wildMaps.length * 3; // 199 - 174 = 25
  if (EXTRA < 0) throw new Error(`普通怪 ${normals.length} 只不够每图 3 只（${wildMaps.length} 张图）`);
  const extraQuota = new Map();
  const byArea = [...wildMaps].sort(
    (a, b) => b.pixel_width * b.pixel_height - a.pixel_width * a.pixel_height,
  );
  for (const row of byArea.slice(0, EXTRA)) extraQuota.set(row.map_id, 1);

  const assignment = new Map(); // map_id -> [monster rows]
  let cursor = 0;
  for (const map of wildMaps) {
    const count = 3 + (extraQuota.get(map.map_id) ?? 0);
    assignment.set(map.map_id, normals.slice(cursor, cursor + count));
    cursor += count;
  }
  if (cursor !== normals.length) {
    throw new Error(`分配没吃满：物种 ${normals.length} 只，分掉 ${cursor} 只`);
  }
  return assignment;
}

/** boss → 图的分配：剧本图钉死，其余从 11 级以上的野外图按序列均匀取（等级序对齐 boss 等级序） */
function assignBosses(bosses, wildMaps) {
  const taken = new Set(STORY_BOSS_MAPS);
  // 新手段（1~9 级）不铺野 boss：出村就撞首领等于教玩家受苦；剧本图不受此限
  const rest = wildMaps.filter((row) => !taken.has(row.map_id) && row.level >= 11);
  const need = bosses.length - STORY_BOSS_MAPS.length;
  if (need > rest.length) throw new Error(`11 级以上野外图只有 ${rest.length} 张，铺不下 ${need} 只非剧本 boss`);
  const step = rest.length / need;
  const picks = new Set();
  for (let i = 0; i < need; i += 1) picks.add(rest[Math.min(rest.length - 1, Math.round(i * step))].map_id);
  const bossMaps = wildMaps.filter((row) => taken.has(row.map_id) || picks.has(row.map_id));
  if (bossMaps.length !== bosses.length) throw new Error(`boss 分配图数不符：${bossMaps.length} != ${bosses.length}`);
  const out = new Map(); // map_id -> boss row（boss 等级序 → 图等级序）
  bossMaps.forEach((map, i) => out.set(map.map_id, bosses[i]));
  return out;
}

/**
 * 普通怪模板（1~69 级）
 *
 * 1~60 从库内现状取（同档必须一致，不一致直接报错——模板漂了要人看）；
 * 61~69 沿 59→60 的每级增量线性外推（与角色曲线同段线性延续）。
 */
function buildNormalTemplate(db) {
  const rows = db
    .prepare(
      "SELECT level, max_hp, physical_attack_min, physical_attack_max, physical_defense_min, physical_defense_max FROM monsters WHERE tier='normal' ORDER BY level",
    )
    .all();
  const byLevel = new Map();
  const COLS = ["max_hp", "physical_attack_min", "physical_attack_max", "physical_defense_min", "physical_defense_max"];
  for (const row of rows) {
    const key = Number(row.level);
    const prior = byLevel.get(key);
    if (prior) {
      for (const col of COLS) {
        if (Number(prior[col]) !== Number(row[col])) {
          throw new Error(`普通怪 ${key} 级模板不一致（${col}: ${prior[col]} vs ${row[col]}）—— 先把同档数值对齐再跑本脚本`);
        }
      }
    } else {
      byLevel.set(key, row);
    }
  }
  const top = Math.max(...byLevel.keys());
  const template = (level) => {
    if (level <= top) return byLevel.get(level);
    const base = byLevel.get(top);
    const prev = byLevel.get(top - 1);
    const k = level - top;
    const out = { level };
    for (const col of COLS) out[col] = Math.round(Number(base[col]) + (Number(base[col]) - Number(prev[col])) * k);
    return out;
  };
  return { template, maxKnown: top };
}

/** boss 模板：已知档位线性插值；低于最低档按比例缩放；高于最高档沿末段外推 */
function buildBossTemplate(db) {
  const rows = db
    .prepare(
      "SELECT level, max_hp, physical_attack_min, physical_attack_max, physical_defense_min, physical_defense_max FROM monsters WHERE tier='boss' ORDER BY level",
    )
    .all();
  const byLevel = new Map(rows.map((row) => [Number(row.level), row]));
  const COLS = ["max_hp", "physical_attack_min", "physical_attack_max", "physical_defense_min", "physical_defense_max"];
  const lo = Math.min(...byLevel.keys());
  const hi = Math.max(...byLevel.keys());
  const at = (level) => {
    if (byLevel.has(level)) return byLevel.get(level);
    if (level < lo) {
      // 低于最低档：按等级比例缩放（boss 最低档本身就是满配起点）
      const base = byLevel.get(lo);
      const out = { level };
      for (const col of COLS) out[col] = Math.max(1, Math.round((Number(base[col]) * level) / lo));
      return out;
    }
    if (level > hi) {
      // 高于最高档：沿最后两个已知档的每级增量外推
      const base = byLevel.get(hi);
      const prev = byLevel.get(hi - 1) ?? byLevel.get(hi - 2);
      const span = hi - Number(prev.level);
      const k = level - hi;
      const out = { level };
      for (const col of COLS) out[col] = Math.round(Number(base[col]) + ((Number(base[col]) - Number(prev[col])) / span) * k);
      return out;
    }
    const upper = Math.min(...[...byLevel.keys()].filter((value) => value >= level));
    const lower = Math.max(...[...byLevel.keys()].filter((value) => value <= level));
    const hiRow = byLevel.get(upper);
    const loRow = byLevel.get(lower);
    const t = upper === lower ? 0 : (level - lower) / (upper - lower);
    const out = { level };
    for (const col of COLS) out[col] = Math.round(Number(loRow[col]) + (Number(hiRow[col]) - Number(loRow[col])) * t);
    return out;
  };
  return { at };
}

/**
 * 升级经验需求（唯一尺子 = `role_level_curves` 的 exp 曲线）
 *
 * value(level) = start_value + per_level*k + accel*k*(k-1)/2（k = level - from_level），
 * 与 runtime-config-cache 求值同式。
 */
function buildExpNeed(db) {
  const segments = db.prepare("SELECT seq, from_level, to_level, start_value, per_level, accel FROM role_level_curves WHERE curve='exp' ORDER BY seq").all();
  if (segments.length === 0) throw new Error("role_level_curves 里没有 exp 曲线段");
  return (level) => {
    const seg = segments.find((row) => level >= row.from_level && level <= row.to_level)
      ?? segments.reduce((best, row) => (row.from_level > (best?.from_level ?? -1) ? row : best), null);
    const k = Math.max(0, level - seg.from_level);
    return Math.round(seg.start_value + seg.per_level * k + (seg.accel * k * (k - 1)) / 2);
  };
}

/** 刷怪区几何：最多 4 个常规区的四象限锚点（相对图宽/高的比例），boss 区钉在远角 */
const AREA_ANCHORS = [
  [0.24, 0.24],
  [0.72, 0.28],
  [0.3, 0.72],
  [0.72, 0.72],
];

function buildAreaRect(map, index) {
  const isBoss = index === -1;
  const [fx, fy] = isBoss ? [0.85, 0.85] : AREA_ANCHORS[index];
  const shortSide = Math.min(map.pixel_width, map.pixel_height);
  const size = Math.min(900, Math.max(320, Math.round(shortSide * (isBoss ? 0.1 : 0.28))));
  const margin = Math.max(60, Math.round(shortSide * 0.08));
  const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);
  const cx = clamp(Math.round(map.pixel_width * fx), margin + size / 2, map.pixel_width - margin - size / 2);
  const cy = clamp(-Math.round(map.pixel_height * fy), -(map.pixel_height - margin - size / 2), -(margin + size / 2));
  return { cx, cy, w: size, h: size };
}

// =====================================================================
// 落库
// =====================================================================

function main() {
  const args = tooling.parseArgs(process.argv.slice(2), { db: "db", "dry-run": "dryRun", apply: "apply" });
  tooling.loadServerEnv();
  const dbPath = tooling.resolveDbPath(args.db);
  tooling.inspect(dbPath, { label: "数据文件" });
  const apply = args.apply === true;

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 10000");
  try {
    const maps = db.prepare("SELECT map_id, label, type, level, pixel_width, pixel_height, revive_cx, revive_cy FROM maps ORDER BY CAST(map_id AS INTEGER)").all();
    const mapById = new Map(maps.map((row) => [row.map_id, row]));
    const wildMaps = loadWildMaps(db);
    const normals = loadNormals(db);
    const bosses = db.prepare("SELECT id, label, level, tier FROM monsters WHERE tier='boss' ORDER BY level, CAST(id AS INTEGER)").all();
    const allMonsters = db.prepare("SELECT id, label, level, tier, max_hp FROM monsters ORDER BY CAST(id AS INTEGER)").all();

    const speciesByMap = assignSpecies(normals, wildMaps);
    const bossByMap = assignBosses(bosses, wildMaps);
    const normalTemplate = buildNormalTemplate(db);
    const bossTemplate = buildBossTemplate(db);
    const expNeed = buildExpNeed(db);

    // —— 分配预览 ——
    console.log(`野外图 ${wildMaps.length} 张 / 普通怪 ${normals.length} 只 / boss ${bosses.length} 只`);
    console.log(`等级上限：普通怪已知模板到 ${normalTemplate.maxKnown} 级，61~69 线性外推`);
    for (const map of wildMaps) {
      const species = speciesByMap.get(map.map_id).map((row) => `${row.label}#${row.id}`).join("、");
      const boss = bossByMap.get(map.map_id);
      console.log(`  图 ${map.map_id.padStart(2)} ${map.label}（${map.level} 级）：${species}${boss ? ` ＋ boss ${boss.label}#${boss.id}` : ""}`);
    }

    // —— 任务推导（min_level / 目标怪 / 奖励）——
    const npcById = new Map(NPCS.map((row) => [row.id, row]));
    const questPlan = QUESTS.map((quest, index) => {
      const prev = index === 0 ? "" : QUESTS[index - 1].id;
      const publisher = npcById.get(quest.npc);
      const publisherMap = mapById.get(publisher.mapId);
      if (quest.type === "talk") {
        const target = npcById.get(quest.npcTarget);
        const targetMap = mapById.get(target.mapId);
        const minLevel = Math.max(publisherMap.level, targetMap.level);
        return { ...quest, prev, minLevel, targetMonster: null, targetNpc: quest.npcTarget, count: 1,
          items: [], exp: Math.round(expNeed(minLevel) * EXP_PCT.talk),
          gold: (minLevel + 1) * 100, desc: quest.desc };
      }
      const map = mapById.get(quest.map);
      if (!map) throw new Error(`任务 ${quest.id} 引用的图 ${quest.map} 不存在`);
      if (quest.type === "boss") {
        const boss = bossByMap.get(quest.map);
        if (!boss) throw new Error(`任务 ${quest.id} 是 boss 任务，但图 ${quest.map} 没配 boss`);
        const bossIndex = QUESTS.filter((entry) => entry.type === "boss").findIndex((entry) => entry.id === quest.id);
        const items = BOSS_ITEMS[bossIndex] ?? BOSS_ITEMS[BOSS_ITEMS.length - 1];
        return { ...quest, prev, minLevel: map.level, targetMonster: boss, targetNpc: null, count: 1,
          items, exp: Math.round(expNeed(map.level) * EXP_PCT.boss),
          gold: minLevelGold(map.level) * 3, desc: quest.desc.replaceAll("{monster}", boss.label) };
      }
      const main = speciesByMap.get(quest.map)[0];
      return { ...quest, prev, minLevel: map.level, targetMonster: main, targetNpc: null, count: 10,
        items: [], exp: Math.round(expNeed(map.level) * EXP_PCT.kill),
        gold: minLevelGold(map.level), desc: quest.desc.replaceAll("{monster}", main.label) };
    });
    function minLevelGold(level) {
      return (level + 1) * 100;
    }

    console.log("\n任务链：");
    for (const quest of questPlan) {
      const target = quest.type === "talk"
        ? `对话 ${npcById.get(quest.targetNpc).label}`
        : `杀 ${quest.targetMonster.label}#%s ×${quest.count}`.replace("%s", quest.targetMonster.id);
      console.log(`  ${quest.id} ${quest.label}（${quest.minLevel} 级，NPC ${publisherLabel(quest.npc)}）：${target}  exp=${quest.exp} gold=${quest.gold}${quest.items.length ? ` +${quest.items.map((item) => `${item.goodId}×${item.count}`).join(",")}` : ""}`);
    }
    function publisherLabel(id) {
      return npcById.get(id).label;
    }

    // —— monsters 差异 ——
    const monsterDiffs = [];
    for (const [mapId, species] of speciesByMap) {
      const level = mapById.get(mapId).level;
      for (const row of species) {
        const t = normalTemplate.template(level);
        monsterDiffs.push({ id: row.id, label: row.label, from: row.level, to: level, t });
      }
    }
    for (const [mapId, boss] of bossByMap) {
      const level = mapById.get(mapId).level;
      monsterDiffs.push({ id: boss.id, label: boss.label, from: boss.level, to: level, t: bossTemplate.at(level), boss: true });
    }
    const monsterChanged = monsterDiffs.filter((row) => row.from !== row.to);
    console.log(`\n怪物要改 ${monsterChanged.length}/${monsterDiffs.length} 行等级（属性一律按模板重写）`);
    for (const row of monsterChanged.slice(0, 12)) {
      console.log(`  ${row.boss ? "[boss]" : "      "} ${row.label}#${row.id}：${row.from} → ${row.to} 级（hp ${row.t.max_hp}）`);
    }
    if (monsterChanged.length > 12) console.log(`  ……等 ${monsterChanged.length} 行`);

    if (!apply) {
      console.log("\n干跑结束（没有写库）。确认无误后加 --apply 真写。");
      return;
    }

    // ============ 真写 ============
    const now = NOW();
    let areaRows = 0;
    db.exec("BEGIN");
    try {
      // 一、monsters：等级 + 模板属性（magic/道术攻击恒 0、法防道防 = 物防，与现状口径一致）
      const updMonster = db.prepare(
        "UPDATE monsters SET level=?, max_hp=?, physical_attack_min=?, physical_attack_max=?, magic_attack_min=0, magic_attack_max=0, taoist_attack_min=0, taoist_attack_max=0, physical_defense_min=?, physical_defense_max=?, magic_defense_min=?, magic_defense_max=?, taoist_defense_min=?, taoist_defense_max=?, updated_at=? WHERE id=?",
      );
      for (const row of monsterDiffs) {
        updMonster.run(row.to, row.t.max_hp, row.t.physical_attack_min, row.t.physical_attack_max,
          row.t.physical_defense_min, row.t.physical_defense_max,
          row.t.physical_defense_min, row.t.physical_defense_max, row.t.physical_defense_min, row.t.physical_defense_max,
          now, row.id);
      }

      // 二、map_spawn_areas：整表重建（#1177 起本表归本脚本管）
      const areaCount = db.prepare("SELECT COUNT(*) AS n FROM map_spawn_areas").get().n;
      if (areaCount > 0) console.log(`  刷怪区表里已有 ${areaCount} 行，整表重建`);
      db.exec("DELETE FROM map_spawn_areas");
      const insArea = db.prepare(
        "INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      );
      const AREA_NAMES = ["甲区", "乙区", "丙区", "丁区"];
      for (const map of wildMaps) {
        const species = speciesByMap.get(map.map_id);
        species.forEach((monster, i) => {
          const rect = buildAreaRect(map, i);
          insArea.run(map.map_id, AREA_NAMES[i], monster.id, 4, 7, rect.cx, rect.cy, rect.w, rect.h, now);
          areaRows += 1;
        });
        const boss = bossByMap.get(map.map_id);
        if (boss) {
          const rect = buildAreaRect(map, -1);
          insArea.run(map.map_id, "首领区", boss.id, 1, 1, rect.cx, rect.cy, rect.w, rect.h, now);
          areaRows += 1;
        }
      }

      // 三、npcs + map_npcs
      const delNpc = db.prepare("DELETE FROM npcs WHERE id=?");
      const delMapNpc = db.prepare("DELETE FROM map_npcs WHERE npc_id=?");
      const insNpc = db.prepare("INSERT INTO npcs (id, label, dialog, updated_at, src, scale_x, scale_y, pos_x, pos_y) VALUES (?,?,?,?,?,1,1,0,0)");
      const insMapNpc = db.prepare("INSERT INTO map_npcs (map_id, npc_id, cx, cy, updated_at) VALUES (?,?,?,?,?)");
      for (const npc of NPCS) {
        delNpc.run(npc.id);
        delMapNpc.run(npc.id);
        insNpc.run(npc.id, npc.label, npc.dialog, now, npc.src);
        const map = mapById.get(npc.mapId);
        insMapNpc.run(npc.mapId, npc.id, Math.round(map.revive_cx) + 120, Math.round(map.revive_cy) - 90, now);
      }
      // config-sync.sql 里已提交而库缺的 0101@图0 点位补回（历史提交意图，收敛两处口径）
      const spot0101 = db.prepare("SELECT COUNT(*) AS n FROM map_npcs WHERE map_id='0' AND npc_id='0101'").get().n;
      if (spot0101 === 0) insMapNpc.run("0", "0101", 1152, -778, now);

      // 四、quests：先清自己这批再插（prev 链按数组顺序）
      const delQuest = db.prepare("DELETE FROM quests WHERE id=?");
      const insQuest = db.prepare(
        "INSERT INTO quests (id, kind, label, description, prev_quest_id, min_level, npc_id, objective_type, objective_target, objective_count, reward_bind_gold, reward_exp, reward_items, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const quest of questPlan) delQuest.run(quest.id);
      for (const quest of questPlan) {
        const objectiveType = quest.type === "talk" ? "talk" : "kill";
        const objectiveTarget = quest.type === "talk" ? quest.targetNpc : quest.targetMonster.id;
        insQuest.run(quest.id, "main", quest.label, quest.desc, quest.prev, quest.minLevel, quest.npc,
          objectiveType, objectiveTarget, quest.count, quest.gold, quest.exp, itemsJson(quest.items), now);
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    console.log(`\n已写入：怪物 ${monsterDiffs.length} 行 / 刷怪区 ${areaRows} 区 / NPC ${NPCS.length} 个 / 任务 ${questPlan.length} 条。`);

    // ============ 推配置版本 ============
    // 快照按 config_version 缓存（#881），版本 +1 只发生在管理端写接口的拦截器里 ——
    // 直接改库绕过它，运行中的服务端会一直发旧快照（2026-11-24 实踩：#1215 落库后
    // 客户端地图弹窗看不到刷怪区怪名，直到有人在管理端碰了一下配置才自愈）。
    // 与 ConfigRevisionRepository.bumpVersion 同语义：单行表 ensure + version+1；
    // 不写 config_revisions（那是管理端写接口的审计账，直接改库的数据变更本来也不在那条账上）。
    db.exec("INSERT OR IGNORE INTO config_version (id, version, updated_at, updated_by) VALUES (1, 0, 0, '')");
    const version = db
      .prepare("UPDATE config_version SET version = version + 1, updated_at = ?, updated_by = 'oneoff-quest-line' WHERE id = 1 RETURNING version")
      .get(now).version;
    console.log(`config_version → ${version}（运行中的服务端会在下一次客户端请求时重建快照，无需重启）。`);

    console.log("下一步：跑 splice 脚本同步 config-sync.sql 的五张表段（maps 等其余段有运营 WIP，不整份导出）。");
  } finally {
    db.close();
  }
}

main();
