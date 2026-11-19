/**
 * 一次性脚本：主线任务链全集落库（#1084，docs/31 §九，2026-11-19 拍板）
 *
 * ## 它做什么
 * 220 只怪 = 220 个 kill 环 + 每段 2 个 talk 调剂环 ≈ 232 环，从 8005 顺延
 * （跳过 8100~8109，日常 8101 不动）。六段（1-10 / … / 51-60）各 1 位任务 NPC
 * （npcs 0101~0106，**src 留空** —— 美术 plist 由用户后补，填上前客户端不显示该 NPC），
 * 落位 map_npcs 一点位（map 0 新手村）。
 *
 * 刷怪落位**整表重排**：map_spawn_areas 全删重建（220 区全部落 map 0，按等级环带分布，
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

/** 6 个等级段的起始等级（等 10 级边界 = 等级曲线前六段） */
const SEGMENTS = [1, 11, 21, 31, 41, 51] as const;
/** 新手村（map 0）与村中心（revive 点，落位环带圆心） */
const QUEST_MAP = "0";
const VILLAGE = { x: 4057.2, y: -3688.04 };
const MAP_SIZE = 8192;
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
  const collisions = db.all<Rect>(
    "SELECT cx, cy, w, h FROM map_collisions WHERE map_id = ?",
    [QUEST_MAP],
  );

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

  // ---------- 2. 全局同心环布局（先算，NPC 点位要用环半径） ----------
  let bandRingRadii: number[][] = [];
  /**
   * 村外围从外向内铺**固定间距的同心环**（环距 340 = 矩形 220 + 邻环边缘间隙 120），
   * 六个等级段从最外环向内**逐环瓜分**：每段怪先占满自己分到的环（boss 占该段最外环
   * 的首槽 = 巢穴在段带外缘），装不下再向内拿一条环。相比「按段算带边界」，环距固定
   * 让相邻段的落点天然错开一个环距，不会出现「band 外缘贴着上一带外缘」的挤压。
   */
  const RECT_SIZE = 220;
  const RECT_SPACING = RECT_SIZE + 36;
  const RING_STEP = 340;
  const RING_OUTER = 3145; // 最外环半径（rect 中心最大 3530 - 半宽余量）
  const RING_INNER = 425; // 最内环（村中心建筑群外缘之外一步）
  const bandCounts = SEGMENTS.map((start) =>
    monsters.filter((m) => m.level >= start && m.level <= start + 9).length,
  );
  const ringRadii: number[] = [];
  for (let r = RING_OUTER; r >= RING_INNER; r -= RING_STEP) ringRadii.push(r);
  const ringCapacity = (radius: number): number =>
    Math.max(6, Math.floor((2 * Math.PI * radius) / (RECT_SPACING * 1.15)));
  // 逐带瓜分：band 5（最高段）先挑最外环，依次向内；band 1（新手段）最后从
  // **剩余环的内侧**取 —— 新手村中心（revive 点）的 AOI 只有 ±768px，新手出门
  // 必须立刻看得见第一带怪，所以 band 1 的怪要贴着村子摆（765/1105 环）
  {
    let cursor = 0;
    const bandRingIndices: number[][] = [];
    for (let b = SEGMENTS.length - 1; b >= 0; b--) {
      let remaining = bandCounts[b];
      const rings: number[] = [];
      if (b === 0) {
        // 新手段：从内向外取剩余环（内侧优先，怪物贴村）
        let inner = ringRadii.length - 1;
        while (remaining > 0 && inner >= cursor) {
          rings.push(inner);
          remaining -= ringCapacity(ringRadii[inner]);
          inner--;
        }
        if (remaining > 0) throw new Error(`第 1 段的 ${remaining} 只怪没有环可分`);
      } else {
        while (remaining > 0 && cursor < ringRadii.length) {
          rings.push(cursor);
          remaining -= ringCapacity(ringRadii[cursor]);
          cursor++;
        }
        if (remaining > 0) throw new Error(`第 ${b + 1} 段的 ${remaining} 只怪没有环可分`);
      }
      bandRingIndices[b] = rings;
    }
    if (cursor > ringRadii.length) throw new Error("同心环不够分");
    bandRingRadii = bandRingIndices.map((idx) =>
      idx.map((i) => ringRadii[i]).sort((a, b2) => b2 - a),
    );
    console.log(
      `同心环 ${ringRadii.length} 条（${ringRadii.map((r) => Math.round(r)).join("/")}），每段怪 ${bandCounts.join("/")} 分环 ${bandRingRadii.map((r) => r.map((x) => Math.round(x)).join("+")).join(" / ")}`,
    );
  }

  // ---------- 3. NPC 点位：本段怪带内缘、沿「讨伐道」（正东方向一条线） ----------
  const npcSpots = npcRows.map((npc, i) => {
    // 段带内缘 = 该段最内环再往村里退一步（第 1 段的「上一段」就是村本身）
    const rings = bandRingRadii[i];
    const cx = VILLAGE.x + rings[rings.length - 1] + RING_STEP / 2;
    const cy = VILLAGE.y;
    // 碰撞避让：优先向南挪（村中心障碍群在圆心一带，东侧走廊基本干净）
    for (let dy = 0; dy < 2000; dy += 60) {
      const spot = { cx, cy: cy - dy, w: 64, h: 64 };
      if (!collisions.some((c) => rectsOverlap(spot, c, 32))) {
        return { npc_id: npc.id, cx, cy: cy - dy };
      }
    }
    return { npc_id: npc.id, cx, cy };
  });

  // ---------- 4. 刷怪落位：整表重排（220 区全落 map 0） ----------
  const rnd = mulberry32(0x1084);
  const placedRects: Rect[] = [];
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

  /** 每带做确定性角槽布局：boss 占该段最外环首槽，普通怪接着摊满再向内一条环 */
  const slotLayout = new Map<string, { radius: number; angle: number }>();
  for (let s = 0; s < SEGMENTS.length; s++) {
    const start = SEGMENTS[s];
    const inSeg = monsters.filter((m) => m.level >= start && m.level <= start + 9);
    const members = [
      ...inSeg.filter((m) => m.tier === "boss"),
      ...inSeg.filter((m) => m.tier !== "boss"),
    ];
    let ringIdx = 0;
    let slotIdx = 0;
    for (const m of members) {
      const rings = bandRingRadii[s];
      const radius = rings[Math.min(ringIdx, rings.length - 1)];
      const slots = ringCapacity(radius);
      slotLayout.set(m.id, {
        radius,
        angle: (2 * Math.PI * slotIdx) / slots + rnd() * 0.04,
      });
      slotIdx++;
      if (slotIdx >= slots) {
        slotIdx = 0;
        ringIdx = Math.min(ringIdx + 1, rings.length - 1);
      }
    }
  }

  /** 按角槽落位：守点卡住就在槽位附近微调（角度步进 + 半径锯齿）重试 */
  function place(segIndex: number, isBoss: boolean, key: string): Rect {
    const w = RECT_SIZE;
    const slot = slotLayout.get(key);
    if (!slot) throw new Error(`怪 ${key} 没有角槽（带 ${segIndex + 1} 布局遗漏）`);
    for (let attempt = 0; attempt < 128; attempt++) {
      const drift = Math.ceil(attempt / 2) * 14 * (attempt % 2 === 0 ? -1 : 1);
      const radius = slot.radius + drift;
      const angle = slot.angle + attempt * 0.05;
      const rect: Rect = {
        cx: Math.min(MAP_SIZE - w / 2 - 8, Math.max(w / 2 + 8, VILLAGE.x + Math.cos(angle) * radius)),
        cy: Math.min(-w / 2 - 8, Math.max(-MAP_SIZE + w / 2 + 8, VILLAGE.y + Math.sin(angle) * radius)),
        w,
        h: w,
      };
      const blocked =
        collisions.some((c) => rectsOverlap(rect, c, 16)) ||
        placedRects.some((p) => rectsOverlap(rect, p, isBoss ? 60 : 36));
      if (!blocked) {
        placedRects.push(rect);
        return rect;
      }
    }
    throw new Error(`怪 ${key} 在第 ${segIndex + 1} 带 128 次尝试都摆不下`);
  }

  for (const m of monsters) {
    const segIndex = Math.min(5, Math.floor((m.level - 1) / 10));
    const isBoss = m.tier === "boss";
    // 密度取最高档（2026-11-19 拍板）：normal 25→15 随怪等级线性递减；boss 巢穴化 2 只
    const max = isBoss ? 2 : Math.round(25 - (10 * (m.level - 1)) / 59);
    const min = isBoss ? 1 : Math.round(max * 0.6);
    const rect = place(segIndex, isBoss, m.id);
    areaRows.push({
      map_id: QUEST_MAP,
      name: `带${segIndex + 1}-L${m.level}-${m.id}`,
      monster_key: m.id,
      min,
      max,
      ...rect,
    });
  }

  // ---------- 4. 任务链（232 环） ----------
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
    segQuests.push({
      id: nextQuestId(),
      kind: "main",
      label: `投奔·任务使者${CN_NUM[s]}`,
      description: `前往任务使者·${CN_NUM[s]}处报到，接下 ${start}-${start + 9} 级的讨伐名录。`,
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
        description: `在任务使者·${CN_NUM[s]}划定的猎场击杀 ${count} 只${m.label}（${m.level} 级）。`,
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
      description: `带着 ${start}-${start + 9} 级猎场的战果，回任务使者·${CN_NUM[s]}处复命。`,
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
        description: `${b.label}（${b.level} 级）盘踞在猎场外缘的巢穴。斩了它，${start}-${start + 9} 级的名录就此勾销。`,
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

  // ---------- 5. 输出 / 落库 ----------
  const newIds = quests.map((q) => q.id);
  if (new Set(newIds).size !== newIds.length) throw new Error("环 id 有重复（分配器跑了飞）");
  const killTargets = new Set(quests.filter((q) => q.objective_type === "kill").map((q) => q.objective_target));
  console.log(`怪物 ${monsters.length} · 环 ${quests.length}（kill ${killTargets.size} 覆盖 / talk ${quests.length - killTargets.size}）`);
  console.log(`环 id：${newIds[0]} ~ ${newIds[newIds.length - 1]} · NPC ${npcRows.map((n) => n.id).join("/")} · 刷怪区 ${areaRows.length} 区（全落 ${QUEST_MAP}）`);
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
