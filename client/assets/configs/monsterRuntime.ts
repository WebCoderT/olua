import { Size, Vec2 } from "cc";
import type { MonsterPresentation, MonsterRuntimeStats } from "../types/monster";
import { monsterDefaultSpeedRate } from "./monster";

/**
 * 怪物运行时表（#588 数据归属收口）—— **客户端唯一的怪物数据持有处**
 *
 * 两半都来自 `GET /game-config` 快照（客户端没有怪物数据文件）：
 * - `monsterResource`：资源与表现（快照 `monsterPresentations` 段 ← 服务端
 *   `monster-presentation.generated.ts`，图集实测的几何与素材路径）；
 * - `monsterRuntime`：数值（快照 `monsters` 段 ← 服务端 `monsters` 表，出厂 =
 *   `monster-seed.ts` 曲线展开，管理端可改）。
 *
 * 此前数值在 configs/monster 本地有一份、快照来了逐字段覆写 —— 那要求「覆写一个不漏」
 * 才不静默回退到出厂值（靠审计钉着）；现在本地根本没有，漏发/缺行直接表现为
 * 「名字是 key、怪不落场」，warn 一条，想看不见都难。
 */
export const monsterResource = new Map<string, MonsterPresentation>();
export const monsterRuntime = new Map<string, MonsterRuntimeStats>();

/** 已经 warn 过的缺行 key（每会话每 key 只 warn 一次，别刷屏） */
const warned = new Set<string>();

function warnMissingOnce(key: string, what: string): void {
  const mark = `${what}:${key}`;
  if (warned.has(mark)) return;
  warned.add(mark);
  console.warn(`[monsterRuntime] 怪物 ${key} 没有运行时${what}（GET /game-config 快照未到或服务端缺行），相关表现按退化口径处理`);
}

/** 落表：资源与表现行（快照 DTO → 运行时形状；speedRate 在这里与默认表合成，消费方直接用） */
export function applyMonsterPresentation(
  key: string,
  row: { icon: string; out: string; outOffset: { x: number; y: number }; contentSize: { width: number; height: number }; moveSpeed: number; aggressive: boolean; detectRange: number; speedRate?: Record<string, number> | null },
): void {
  monsterResource.set(key, {
    icon: row.icon,
    out: row.out,
    outOffset: new Vec2(row.outOffset.x, row.outOffset.y),
    contentSize: new Size(row.contentSize.width, row.contentSize.height),
    // 快照只带「要改的动作」，其余动作走客户端默认（素材帧规格统一，见 configs/monster）
    speedRate: { ...monsterDefaultSpeedRate, ...(row.speedRate ?? {}) },
    moveSpeed: row.moveSpeed,
    aggressive: row.aggressive,
    detectRange: row.detectRange,
  });
}

/** 落表：数值行（快照 DTO → 运行时形状） */
export function applyMonsterRuntimeStats(key: string, stats: MonsterRuntimeStats): void {
  monsterRuntime.set(key, stats);
}

/**
 * 取资源与表现；缺行返回 undefined（**调用方要处理**：没有资源 = 没法渲染，
 * 生成直接跳过并 warn —— 数值可以退化演，一只看不见的怪没法退化）
 */
export function monsterResourceOf(key: string): MonsterPresentation | undefined {
  const row = monsterResource.get(key);
  if (!row) warnMissingOnce(key, "资源行");
  return row;
}

/**
 * 取运行时数值；缺行时返回**退化值**而不是 undefined：
 * 名字 = key、等级/定位归零、六项攻防全 [0,0]、maxHp = 调用方给的兜底（场上实例用当前血）——
 * 这样 Monster 实例的字段永远是全的，消费点（血条 / 名牌 / 双跑对账）不用到处判空；
 * 「数据断了」这件事由 warn 负责，不靠 undefined 炸调用栈。
 */
export function monsterStatsOrDefault(key: string, fallbackMaxHp: number): MonsterRuntimeStats {
  const stats = monsterRuntime.get(key);
  if (stats) return stats;
  warnMissingOnce(key, "数值行");
  return {
    label: key,
    level: 0,
    tier: "normal",
    maxHp: Math.max(1, fallbackMaxHp),
    physicalAttack: [0, 0],
    magicAttack: [0, 0],
    taoistAttack: [0, 0],
    physicalDefense: [0, 0],
    magicDefense: [0, 0],
    taoistDefense: [0, 0],
  };
}

/** 显示名：快照没到或缺行时退回 key（warn 一次）——地图预览 / 任务文案等「只要个名字」的场景用 */
export function monsterLabelOf(key: string): string {
  const stats = monsterRuntime.get(key);
  if (!stats) warnMissingOnce(key, "数值行");
  return stats?.label ?? key;
}
