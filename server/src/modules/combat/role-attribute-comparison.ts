/**
 * 战斗属性比对：**服务端重算的那份** vs **客户端上报的那份**
 *
 * ===========================================================================
 * 这条为什么存在
 * ===========================================================================
 * 角色存档里的 `combat` / `maxHp` / 攻防那几个值，是客户端 `combatCalc` 算完随着
 * `RoleSync` 一起推上来的 —— 服务端存下它们，但**从来没看过一眼**。于是「客户端说
 * 自己多强」就是唯一答案：谁调接口看战斗力，看到的就是玩家客户端说了多少。
 *
 * 服务端有了自己的算法（`role-attributes.ts`）之后，这件事终于可以被检验：拿同一份
 * 存档输入重算一遍，与上报值比一比。
 *
 * ===========================================================================
 * `mismatch` 的意思：口径不一致，**不是「玩家作弊」**
 * ===========================================================================
 * 这是本文件最容易被误读的一个字段，所以在这里说清楚：
 *
 * - 玩家在「升级」与「下一次 combatCalc」之间存档 → 客户端那份是旧的 → **会命中**
 * - 玩家换了装备还没重算就存档 → 同上 → **会命中**
 * - 客户端配置漂了、服务端快照还没跟上 → **会命中**（有 audit-shared-data 守着，但那是部署时的一致性）
 * - 客户端被改过、直接上报了一个大数字 → **会命中**
 *
 * 前三种是正常的，第四种才是安全问题，而**这一层分不出来**。所以它叫 `mismatch`
 * 不叫 `cheating`，调用方也不许拿它去拒绝写入或纠正存档 —— 它只是一个「这里值得
 * 看一眼」的标记。
 *
 * ===========================================================================
 * 为什么用容差而不是严格相等
 * ===========================================================================
 * `combat` 是加权求和（含乘法），两端代码路径不同时浮点求和顺序可能不同，
 * 严格相等会把「口径其实一致」误报成不一致。篡改动辄改掉几个数量级，
 * 容差 1e-6 完全兜得住。
 */

import { RoleAttributeSource, summarizeRoleAttributesWithNotes } from "./role-attributes";

/** 浮点比对的容差（理由见文件头） */
const COMPARISON_EPSILON = 1e-6;

/** 客户端上报的那几个战斗数值（存档里的原样字段；缺了或不是数字就是 null） */
export interface ReportedCombatValues {
  combat?: unknown;
  maxHp?: unknown;
}

/** 比对结果 */
export interface RoleAttributeComparison {
  /** 服务端按同一份存档输入重算的结果；**等级不在成长曲线里时为 null**（此时没法比） */
  server: ReturnType<typeof summarizeRoleAttributesWithNotes>["summary"];
  /** 存档里客户端上报的那份（没有或不是数字就是 null） */
  reported: { combat: number | null; maxHp: number | null };
  /**
   * 两份对不上
   *
   * **重算不出来时恒为 false** —— 没有服务端那份就谈不上「不一致」，
   * 这跟「一致」是两回事，不能都塞进 false 里让调用方猜。所以另配 `comparable` 说明比没比成。
   */
  mismatch: boolean;
  /** 这一次到底比成了没有（false = 服务端算不出来，mismatch 无意义） */
  comparable: boolean;
  /** 查不到属性的装备 id（客户端删了装备 / 存档留着旧 id 时会命中，属性会悄悄少一截） */
  unknownEquipmentIds: string[];
}

/**
 * 用同一份存档输入重算，与客户端上报值比对
 *
 * @param source 角色存档里的输入（等级 / 装备 / 战魂 / 称号 / 军衔）
 * @param reported 存档里客户端上报的那份
 */
export function compareRoleAttributes(source: RoleAttributeSource, reported: ReportedCombatValues = {}): RoleAttributeComparison {
  const { summary, notes } = summarizeRoleAttributesWithNotes(source);
  const normalized = {
    combat: numberOrNull(reported.combat),
    maxHp: numberOrNull(reported.maxHp),
  };

  if (!summary) {
    return { server: null, reported: normalized, mismatch: false, comparable: false, unknownEquipmentIds: notes.unknownEquipmentIds };
  }

  // 只对「两端都有的项」判定：上报值缺失（旧存档）时不算不一致，否则会刷屏
  const differ = (serverValue: number, reportedValue: number | null) => reportedValue !== null && Math.abs(serverValue - reportedValue) > COMPARISON_EPSILON;

  return {
    server: summary,
    reported: normalized,
    mismatch: differ(summary.combat, normalized.combat) || differ(summary.maxHp, normalized.maxHp),
    comparable: true,
    unknownEquipmentIds: notes.unknownEquipmentIds,
  };
}

/**
 * 从**角色存档**直接比对（把「取输入 + 比对」合成一步）
 *
 * 两个观测点要的都是这一句：管理端读详情（#93）、玩家推进度（#94）。
 * 取值的容错逻辑只有这一份 —— 各写一份迟早会漂（一处改了容错，另一处还在旧写法）。
 *
 * @param level 取**索引列**（`roles.level`）而不是 `data.level`：前者是服务端维护的权威值
 * @param data 已解码的角色存档
 */
export function compareRoleAttributesOfRole(level: number, data: Record<string, unknown>): RoleAttributeComparison {
  return compareRoleAttributes(
    {
      level,
      equipments: equipmentMapOf(data.equipments),
      soulOfWar: numberOrUndefined(data.soulOfWar),
      title: numberOrUndefined(data.title),
      rank: numberOrUndefined(data.rank),
    },
    { combat: data.combat, maxHp: data.maxHp },
  );
}

/** 存档里的装备表（槽位 → 装备 id）；形状不对就当没穿（与汇总函数的容错一致） */
function equipmentMapOf(value: unknown): Record<string, string | null> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, string | null>;
}

/** 取一个有限数字；不是数字时返回 undefined（交回汇总函数按「未激活」处理） */
function numberOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 取一个有限数字，其余形态（undefined / 字符串 / NaN / Infinity）一律当「没有」 */
function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
