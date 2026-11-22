/**
 * 一次性脚本：主线任务链全集落库（#1084，docs/31 §九，2026-11-19 拍板）
 *
 * ## 它做什么
 * 220 只怪 = 220 个 kill 环 + 每段 2 个 talk 调剂环 ≈ 232 环，从 8005 顺延
 * （跳过 8100~8109，日常 8101 不动）。六段（1-10 / … / 51-60）各 1 位任务 NPC
 * （npcs 0101~0106，**src 留空** —— 美术 plist 由用户后补，填上前客户端不显示该 NPC），
 * 落位 map_npcs 一点位（map 0 新手村）。
 *
 * 刷怪落位**整表重排**：map_spawn_areas 全删重建（220 区**按等级段分图**，每段一张猎场，
 * 见下方 BAND_PLAN；每张图从外向内铺同心环，boss 占该段最外环首槽 = 巢穴在猎场外缘，
 * 密度取最高档 —— normal 25→15 随等级递减、boss 巢穴化 2 只）；world_monsters 全删，
 * 重启后由 RoomManager 按新刷怪区重播种（运行时表不手摆）。
 *
 * ## 为什么是脚本而不是手写 SQL
 * 逐环奖励是**逐行显式值**（数值纪律：无曲线生成、管理端可逐环改），但 232 行手抄必错；
 * 基准公式住在 docs/31 §9.4，脚本按它算，落库后 `e2e-quest-chain-coverage` 按同一份
 * 公式做容差守点 —— 两边对着同一篇文档，谁跑飞了都会红。
 *
 * ## 段内环序（拍板补充）
 * 段首 talk（报到）→ 普通怪 kill 环（按怪等级升序，前半 count=5 / 后半 count=8）
 * → 段末 talk（复命）→ boss kill 环（count=1）→ 下一段。
 * boss 收尾保证「链末环 = 60 级 boss」（§9.6 判据 2）；「杀完回来交」的叙事落在复命环上。
 *
 * ## 用法
 *   cd server && node --disable-warning=ExperimentalWarning -r ts-node/register \
 *     scripts/oneoff-seed-quest-chain.ts              # 干跑（只打印统计）
 *     同上 + ` --apply`                                # 真写库
 *   写完跑 `make config-export`（根目录）重导配置快照，空库首启才有这批数据。
 */

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DatabaseService } from "../src/database/database.service";

const APPLY = process.argv.includes("--apply");

/**
 * 6 个等级段 → 各自的猎场图（**#1150 换图后按段分图**，2026-11-21 拍板）。
 *
 * 为什么不再「220 区全落 map 0」：旧图 0 是 8192×8192（6700 万 px²），220 个 220×220 的区
 * 只占 16%；新图 0（DT2101）只有 2304×1856（427 万 px²），220 区是整图的 2.5 倍，怎么排都
 * 放不下。于是按等级段分摊到 6 张图，每图 33~38 区，区尺寸还能保持 170~190。
 *
 * 图 0 就是 1-10 级猎场（带复活点与 6 位任务使者，村口开打 —— **怪多是刻意的**：
 * 2026-11-22 拍板「出门即死不管，靠玩家自己团结解决」）。
 *
 * rect = 该图上的刷怪区边长；脚本按格位算容量（放不下直接抛错，不会静默丢怪）。
 * 图 0 / 图 2 的半短边只有 900 上下，170 才装得下 33/38 区；其余图半径够，统一 190。
 */
const BAND_PLAN = [
  { start: 1, map: "0", rect: 170 },
  { start: 11, map: "2", rect: 170 },
  { start: 21, map: "4", rect: 190 },
  { start: 31, map: "6", rect: 190 },
  { start: 41, map: "8", rect: 190 },
  { start: 51, map: "10", rect: 190 },
] as const;
const SEGMENTS: readonly number[] = BAND_PLAN.map((b) => b.start);
/** 任务 NPC 所在图（新手复活点那间村）与村中心：换图后图 0 复活点 1152,-928 */
const QUEST_MAP = "0";
const VILLAGE = { x: 1152, y: -928 };
/** 主线环 id 起点 / 日常保留段 */
const QUEST_ID_START = 8005;
const DAILY_RESERVED = [8100, 8109] as const;

/** 中文数字（NPC label 用） */
const CN_NUM = ["壹", "贰", "叁", "肆", "伍", "陆"];

/** mulberry32：确定性伪随机（同输入同布局，重跑幂等） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 奖励基准（docs/31 §9.4，唯一来源；守点测试按同一公式复核） */
function round10(value: number): number {
  return Math.round(value / 10) * 10;
}
function killExpBasis(level: number, count: number, expPerLevel: number): number {
  return round10(count * (level + 1) * expPerLevel);
}
function goldBasis(segStart: number): number {
  // 「段中位等级」按段起始等级口径（2026-11-19 拍板补记：首段对齐 8002 的 800/环）
  return Math.round(800 * (1 + (segStart - 1) / 10));
}

/** 矩形（世界坐标，cy 为负、y 轴向上）重叠判定 */
function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return (
    Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + pad &&
    Math.abs(a.cy - b.cy) < (a.h + b.h) / 2 + pad
  );
}

interface Rect {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

interface MonsterRow {
  id: string;
  label: string;
  tier: string;
  level: number;
}

interface GeneratedQuest {
  id: string;
  kind: string;
  label: string;
  description: string;
  prev_quest_id: string;
  min_level: number;
  npc_id: string;
  objective_type: string;
  objective_target: string;
  objective_count: number;
  reward_bind_gold: number;
  reward_exp: number;
}

async function main(): Promise<void> {
  // AppModule 是工厂形态（#37 拆进程）：按「存档进程」形态起 context（不需要 WS）
  const { AppModule } = await import("../src/app.module");
  const app = await NestFactory.createApplicationContext(AppModule.register({ realtime: false }), {
    logger: ["error", "warn"],
  });
  const db = app.get(DatabaseService);

  const monsters = db.all<MonsterRow>(
    "SELECT id, label, tier, level FROM monsters ORDER BY level, CAST(id AS INTEGER)",
  );
  if (monsters.length !== 220) throw new Error(`怪物表应有 220 只，实际 ${monsters.length}`);
  const expRow = db.get<{ value: number }>(
    "SELECT value FROM growth_scalars WHERE key = 'expGain.expPerLevel'",
  );
  const expPerLevel = expRow?.value ?? 5;

  interface MapGeom {
    map_id: string;
    label: string;
    pixel_width: number;
    pixel_height: number;
  }
  const geomRows = db.all<MapGeom>(
    "SELECT map_id, label, pixel_width, pixel_height FROM maps",
  );
  const geomOf = new Map(geomRows.map((g) => [g.map_id, g]));
  /** 各图碰撞盒（落位避让用；没有盒子的图就是空数组） */
  const collisionsOf = new Map<string, Rect[]>();
  for (const c of db.all<Rect & { map_id: string }>(
    "SELECT map_id, cx, cy, w, h FROM map_collisions",
  )) {
    const list = collisionsOf.get(c.map_id) ?? [];
    list.push({ cx: c.cx, cy: c.cy, w: c.w, h: c.h });
    collisionsOf.set(c.map_id, list);
  }

  // ---------- 1. 六段 NPC（src 留空，美术后补） ----------
  const npcRows = SEGMENTS.map((start, i) => ({
    id: `010${i + 1}`,
    label: `任务使者·${CN_NUM[i]}`,
    dialog: `${start}-${start + 9} 级的讨伐名录在我这里。接了就去做，做完回来见我。`,
    src: "", // plist 美术由用户后补（2026-11-19 拍板）；填上前客户端不显示
    scale_x: 1,
    scale_y: 1,
    pos_x: 0,
    pos_y: 0,
  }));

  // ---------- 2. 每段猎场各自铺格（放不下就在这抛错，不静默丢怪） ----------
  const bandCounts = SEGMENTS.map(
    (start) => monsters.filter((m) => m.level >= start && m.level <= start + 9).length,
  );
  interface BandLayout {
    map: string;
    label: string;
    rect: number;
    center: { x: number; y: number };
    /** 可用格位，**由外向内**排好（离图心远的在前） */
    cells: Rect[];
  }
  /**
   * 每段一张图，图上按 **rect + 60 的格子间距**铺格（不是同心环）。
   *
   * 为什么放弃同心环（#1150 实测）：刷怪区是**轴对齐方块**，两块不重叠的判据是
   * `max(|dx|,|dy|) ≥ 边长`，而同心环上相邻格的连线在 45° 方向时两个分量都只有
   * 弦长/√2 —— 按弧长算的容量因此高估，图 0 摆到第 11 个就挤满了。格子间距在
   * 两个轴上都恒定，天然满足判据，容量也好算。
   *
   * 图心留一块 `半区宽 + 140` 的空地（复活点 / 传送官 / 任务 NPC 在那儿），
   * 压着碰撞盒（pad 16）的格子直接剔掉。
   */
  const bands: BandLayout[] = BAND_PLAN.map((plan, b) => {
    const g = geomOf.get(plan.map);
    if (!g || !g.pixel_width || !g.pixel_height) {
      throw new Error(`图 ${plan.map} 没有几何（先 make config-export 重导快照再跑）`);
    }
    const rect = plan.rect;
    const pitch = rect + 60;
    const inset = rect / 2 + 12;
    const halfW = g.pixel_width / 2;
    const halfH = g.pixel_height / 2;
    const center = { x: halfW, y: -halfH };
    const collisions = collisionsOf.get(plan.map) ?? [];
    const cols = Math.floor((halfW - inset) / pitch);
    const rows = Math.floor((halfH - inset) / pitch);
    const found: Array<{ rect: Rect; dist: number }> = [];
    for (let i = -cols; i <= cols; i++) {
      for (let j = -rows; j <= rows; j++) {
        const dist = Math.hypot(i * pitch, j * pitch);
        if (dist < rect / 2 + 140) continue; // 图心留空（复活点 / NPC）
        const box: Rect = {
          cx: center.x + i * pitch,
          cy: center.y + j * pitch,
          w: rect,
          h: rect,
        };
        if (collisions.some((c) => rectsOverlap(box, c, 16))) continue;
        found.push({ rect: box, dist });
      }
    }
    // 由外向内；同半径按 x 再按 y 定序（保证重跑完全一致）
    found.sort((a, b2) => b2.dist - a.dist || a.rect.cx - b2.rect.cx || b2.rect.cy - a.rect.cy);
    if (found.length < bandCounts[b]) {
      throw new Error(
        `图 ${plan.map}（${g.label}）摆 ${rect} 区只有 ${found.length} 个格位，第 ${b + 1} 段要 ${bandCounts[b]} 个`,
      );
    }
    return { map: plan.map, label: g.label, rect, center, cells: found.map((f) => f.rect) };
  });
  console.log(
    `分图猎场：${bands.map((bd, b) => `${bd.map}「${bd.label}」${bd.rect}区 × ${bandCounts[b]}/${bd.cells.length}格`).join(" · ")}`,
  );

  // ---------- 3. 刷怪落位：220 区按段铺到各自猎场（整表重排） ----------
  const rnd = mulberry32(0x1084);
  const areaRows: Array<{
    map_id: string;
    name: string;
    monster_key: string;
    min: number;
    max: number;
    cx: number;
    cy: number;
    w: number;
    h: number;
  }> = [];

  /** 格位微抖（±8，格距 60 所以不会抖出重叠），让整片猎场不像棋盘 */
  function jitter(box: Rect): Rect {
    return {
      cx: box.cx + Math.round((rnd() - 0.5) * 16),
      cy: box.cy + Math.round((rnd() - 0.5) * 16),
      w: box.w,
      h: box.h,
    };
  }

  for (let s = 0; s < SEGMENTS.length; s++) {
    const bd = bands[s];
    const start = SEGMENTS[s];
    const inSeg = monsters.filter((m) => m.level >= start && m.level <= start + 9);
    const bosses = inSeg.filter((m) => m.tier === "boss");
    const normals = inSeg.filter((m) => m.tier !== "boss");
    const used = bd.cells.map(() => false);
    // boss 巢穴铺在猎场外缘：最外圈按等间隔挑格（后面的普通怪跳过这些格）
    const stride = Math.max(1, Math.floor(bd.cells.length / (bosses.length + 1)));
    const bossCells: number[] = [];
    for (let k = 0; k < bosses.length; k++) {
      let idx = Math.min(bd.cells.length - 1, k * stride);
      while (used[idx]) idx++;
      used[idx] = true;
      bossCells.push(idx);
    }
    let cursor = 0;
    for (const m of [...bosses, ...normals]) {
      const isBoss = m.tier === "boss";
      let idx: number;
      if (isBoss) {
        idx = bossCells.shift() as number;
      } else {
        while (used[cursor]) cursor++;
        idx = cursor;
        used[idx] = true;
        cursor++;
      }
      const rect = jitter(bd.cells[idx]);
      // 密度取最高档（2026-11-19 拍板）：normal 25→15 随怪等级线性递减；boss 巢穴化 2 只
      const max = isBoss ? 2 : Math.round(25 - (10 * (m.level - 1)) / 59);
      const min = isBoss ? 1 : Math.round(max * 0.6);
      areaRows.push({
        map_id: bd.map,
        name: `带${s + 1}-L${m.level}-${m.id}`,
        monster_key: m.id,
        min,
        max,
        ...rect,
      });
    }
  }

  // ---------- 4. 任务 NPC 点位：全在图 0 村中心空地（避开复活点 / 墙 / 刷怪区） ----------
  const homeAreas = areaRows.filter((a) => a.map_id === QUEST_MAP);
  const npcCollisions = collisionsOf.get(QUEST_MAP) ?? [];
  const npcRects: Rect[] = [];
  const npcSpots = npcRows.map((npc) => {
    for (let r = 150; r <= 330; r += 30) {
      for (let k = 0; k < 48; k++) {
        const angle = (2 * Math.PI * k) / 48;
        const spot: Rect = {
          cx: VILLAGE.x + Math.cos(angle) * r,
          cy: VILLAGE.y + Math.sin(angle) * r,
          w: 64,
          h: 64,
        };
        const blocked =
          npcCollisions.some((c) => rectsOverlap(spot, c, 32)) ||
          homeAreas.some((a) => rectsOverlap(spot, a, 40)) ||
          npcRects.some((n) => rectsOverlap(spot, n, 80));
        if (!blocked) {
          npcRects.push(spot);
          return { npc_id: npc.id, cx: spot.cx, cy: spot.cy };
        }
      }
    }
    throw new Error(`任务 NPC ${npc.id} 在图 ${QUEST_MAP} 村中心找不到空位`);
  });

  // ---------- 5. 任务链（232 环） ----------
  // 环 id：8005 起顺延，跳过 8100~8109（日常 8100~8109 段原地保留）
  const nextQuestId = (() => {
    let n = QUEST_ID_START;
    return () => {
      if (n >= DAILY_RESERVED[0] && n <= DAILY_RESERVED[1]) n = DAILY_RESERVED[1] + 1;
      return String(n++);
    };
  })();

  const quests: GeneratedQuest[] = [];
  let prev = "8004"; // 现有链尾「战魂之门」
  const segKillExpMeans: number[] = [];

  for (let s = 0; s < SEGMENTS.length; s++) {
    const start = SEGMENTS[s];
    const npcId = npcRows[s].id;
    const inSeg = monsters.filter((m) => m.level >= start && m.level <= start + 9);
    const normals = inSeg.filter((m) => m.tier !== "boss");
    const bosses = inSeg.filter((m) => m.tier === "boss");

    // 段首报到
    const segQuests: GeneratedQuest[] = [];
    const huntMap = `${bands[s].label}（图 ${bands[s].map}）`;
    segQuests.push({
      id: nextQuestId(),
      kind: "main",
      label: `投奔·任务使者${CN_NUM[s]}`,
      description: `前往任务使者·${CN_NUM[s]}处报到，接下 ${start}-${start + 9} 级的讨伐名录（猎场在${huntMap}）。`,
      prev_quest_id: "",
      min_level: start,
      npc_id: npcId,
      objective_type: "talk",
      objective_target: npcId,
      objective_count: 1,
      reward_bind_gold: 0,
      reward_exp: 0,
    });

    // 普通怪 kill 环：按怪等级升序，前半 count=5 / 后半 count=8（docs/31 §9.3）
    const killExpList: number[] = [];
    normals.forEach((m, idx) => {
      const count = idx < normals.length / 2 ? 5 : 8;
      const gold = goldBasis(start) * (idx % 2 === 0 ? 1.1 : 0.9);
      const exp = killExpBasis(m.level, count, expPerLevel);
      killExpList.push(exp);
      segQuests.push({
        id: nextQuestId(),
        kind: "main",
        label: `讨伐·${m.label}`,
        description: `在${huntMap}击杀 ${count} 只${m.label}（${m.level} 级）。`,
        prev_quest_id: "",
        min_level: start,
        npc_id: npcId,
        objective_type: "kill",
        objective_target: m.id,
        objective_count: count,
        reward_bind_gold: Math.round(gold),
        reward_exp: exp,
      });
    });

    // 段末复命（奖励经验 = 本段 kill 环均值 × 2，docs/31 §9.4）
    const segMean = killExpList.reduce((a, b) => a + b, 0) / Math.max(1, killExpList.length);
    segKillExpMeans.push(segMean);
    // 段首报到的奖励在 kill 环算完后回填（同 talk 口径：段均值 × 2）
    segQuests[0].reward_exp = round10(segMean * 2);
    segQuests[0].reward_bind_gold = goldBasis(start);
    segQuests.push({
      id: nextQuestId(),
      kind: "main",
      label: `复命·任务使者${CN_NUM[s]}`,
      description: `带着${huntMap}的战果，回任务使者·${CN_NUM[s]}处复命。`,
      prev_quest_id: "",
      min_level: start,
      npc_id: npcId,
      objective_type: "talk",
      objective_target: npcId,
      objective_count: 1,
      reward_bind_gold: goldBasis(start),
      reward_exp: round10(segMean * 2),
    });

    // boss 讨伐收尾（count=1，min_level = 段起始 + 5；链末环 = 60 级 boss）
    for (const b of bosses) {
      segQuests.push({
        id: nextQuestId(),
        kind: "main",
        label: `讨伐·${b.label}`,
        description: `${b.label}（${b.level} 级）盘踞在${huntMap}外缘的巢穴。斩了它，${start}-${start + 9} 级的名录就此勾销。`,
        prev_quest_id: "",
        min_level: start + 5,
        npc_id: npcId,
        objective_type: "kill",
        objective_target: b.id,
        objective_count: 1,
        reward_bind_gold: Math.round(goldBasis(start) * 1.1),
        reward_exp: killExpBasis(b.level, 1, expPerLevel),
      });
    }

    // 串链 + 回填 prev_quest_id
    for (const q of segQuests) {
      q.prev_quest_id = prev;
      prev = q.id;
      quests.push(q);
    }
  }

  // ---------- 6. 输出 / 落库 ----------
  const newIds = quests.map((q) => q.id);
  if (new Set(newIds).size !== newIds.length) throw new Error("环 id 有重复（分配器跑了飞）");
  const killTargets = new Set(quests.filter((q) => q.objective_type === "kill").map((q) => q.objective_target));
  console.log(`怪物 ${monsters.length} · 环 ${quests.length}（kill ${killTargets.size} 覆盖 / talk ${quests.length - killTargets.size}）`);
  console.log(`环 id：${newIds[0]} ~ ${newIds[newIds.length - 1]} · NPC ${npcRows.map((n) => n.id).join("/")} · 刷怪区 ${areaRows.length} 区 / ${bands.length} 张图`);
  console.log(
    `各区落图：${bands
      .map((bd) => `${bd.map} ${areaRows.filter((a) => a.map_id === bd.map).length} 区`)
      .join(" · ")} · NPC 全落 ${QUEST_MAP}`,
  );
  for (const spot of npcSpots) {
    const near = areaRows
      .filter((a) => a.map_id === QUEST_MAP)
      .some((a) => rectsOverlap({ cx: spot.cx, cy: spot.cy, w: 64, h: 64 }, a, 0));
    if (near) throw new Error(`NPC ${spot.npc_id} 压在刷怪区上`);
  }
  console.log(`首环 ${quests[0].id}（${quests[0].label}）· 末环 ${quests[quests.length - 1].id}（${quests[quests.length - 1].label}）`);

  if (!APPLY) {
    console.log("（干跑，未写库 —— 加 --apply 真写）");
    void app.close();
    return;
  }

  db.run("BEGIN");
  try {
    // npcs：INSERT OR IGNORE 幂等（运营改过的不覆盖）；src 留空等美术
    for (const n of npcRows) {
      db.run(
        `INSERT OR IGNORE INTO npcs (id, label, dialog, src, scale_x, scale_y, pos_x, pos_y, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [n.id, n.label, n.dialog, n.src, n.scale_x, n.scale_y, n.pos_x, n.pos_y],
      );
    }
    // map_npcs：本脚本点位为准（重跑覆盖）
    db.run(
      `DELETE FROM map_npcs WHERE npc_id IN (${npcRows.map((n) => `'${n.id}'`).join(",")})`,
    );
    for (const spot of npcSpots) {
      db.run(
        `INSERT INTO map_npcs (map_id, npc_id, cx, cy, updated_at) VALUES (?, ?, ?, ?, 0)`,
        [QUEST_MAP, spot.npc_id, spot.cx, spot.cy],
      );
    }
    // 任务链：只动本脚本的两个 id 段（8001~8004 与日常 8101 不碰）
    db.run(`DELETE FROM quests WHERE (id BETWEEN '8005' AND '8099') OR (id BETWEEN '8110' AND '8246')`);
    for (const q of quests) {
      db.run(
        `INSERT INTO quests (id, kind, label, description, prev_quest_id, min_level, npc_id,
           objective_type, objective_target, objective_count, reward_bind_gold, reward_exp, reward_items, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0)`,
        [q.id, q.kind, q.label, q.description, q.prev_quest_id, q.min_level, q.npc_id,
          q.objective_type, q.objective_target, q.objective_count, q.reward_bind_gold, q.reward_exp],
      );
    }
    // 刷怪落位整表重排 + 世界实例清空（重启后 RoomManager 按新区重播种）
    db.run("DELETE FROM map_spawn_areas");
    for (const a of areaRows) {
      db.run(
        `INSERT INTO map_spawn_areas (map_id, name, monster_key, min, max, cx, cy, w, h, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [a.map_id, a.name, a.monster_key, a.min, a.max, a.cx, a.cy, a.w, a.h],
      );
    }
    db.run("DELETE FROM world_monsters");
    db.run("COMMIT");
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
  console.log(`已落库（--apply）。下一步：make config-export 重导快照，重启服务重播种世界怪。`);
  void app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
