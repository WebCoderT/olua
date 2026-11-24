import MessageLogStore from "../MessageLogStore";
import type { MessageLogCategory } from "../MessageLogStore";
import { getText } from "../../../configs/texts";
import type { Role } from "../../../entities/Role";

/**
 * 角色数据差分 → 消息记录（#1229：HUD 右下角「消息记录」升级为个人流水）
 *
 * ## 为什么做差分，而不是逐点埋
 * 与「我」相关的数值有十几个来源：击杀 / 组队分经验 / 使用升级卷轴 / 任务发奖 / 成就发奖 / 邮件领取 /
 * 商城购买 / 背包回收 / 成长线升级 / 加点 / 技能升级 / 换装 / 后台改动…… 逐个来源挂一处埋点的话，
 * 每加一个来源就得回来再找一遍落点，**漏一处就是静默失效**（流水里少了一类，还没人发现）。
 *
 * 这里改在**角色数据的落账出口**做一次快照对比：上一份与这一份不同就写一条。
 * 只要来源最终改了角色数据，流水自动就有了 —— 新增来源不用回来改这个文件。
 *
 * ## 两个落点（都幂等：没有差异就不写）
 * 1. `storage/ui-bridge.ts` 的 `updateRoleUi`：所有 storage 子模块（背包 / 成长 / 商城 / 时装 / 战斗落账）
 *    与 `roleUpdate` 权威帧（任务发奖 / 商城 / 回收 / 后台改动的汇合点）；
 * 2. `storage/role-cache.ts` 的 `updateOnlineRole`：只刷背包不刷角色 UI 的路径（丢弃等）。
 *    先到的那一次把差异写掉，后到的那一次对比无差异 → 不会再写一条。
 *
 * ## 记什么、不记什么
 * 记：等级 / 经验 / 绑定元宝 / 背包件数（按物品 id 聚合）/ 技能点 / 属性点 / 四维 / 战斗力 /
 *     技能等级 / 战魂 / 称号 / 军衔 / 装备穿脱 / 时装更换。
 * 不记：血量魔法（每次受击都在变）、位置朝向（操作反馈）、修订号（同步用，不是玩家资产）、
 *      时间戳与引导进度（体验状态，不是「我变强了/变多了」）。
 *
 * ## 基线
 * 首次 `note` 与换角色都**只建基线、不写流水** —— 登录时那份全量存档不是「刚发生的变化」，
 * 否则一进游戏就是几十条「获得 X」。
 *
 * ## 不 import cc
 * 本文件要能被 `tools/test-message-log.cjs` 直接编译跑断言（同 MessageLogStore / ChatStore）。
 * 物品 / 技能 / 时装的**名字**来自要引擎与快照的表，所以由 ui 层注入解析器（见 `configure`）。
 */

/** 四维的键（顺序与角色信息面板一致；不 import types/role —— 那个文件带 cc） */
const ATTRIBUTE_KEYS = ["str", "agi", "vit", "spi"] as const;

/** 名称解析器：由 ui 层注入（默认原样返回 id，单测里就不用造表） */
export interface RoleDeltaResolvers {
  /** 物品 / 装备的名字（背包与穿戴槽里存的是 id） */
  itemName: (id: string) => string;
  /** 技能名字 */
  skillName: (id: string) => string;
  /** 时装名字 */
  fashionName: (id: string) => string;
}

/** 一份用于对比的角色快照（只留会进流水的字段，且全部是值拷贝） */
interface RoleSnapshot {
  roleId: string;
  level: number;
  exp: number;
  bindGold: number;
  skillPoints: number;
  attrPoints: number;
  combat: number;
  soulOfWar: number;
  title: number;
  rank: number;
  attrs: Record<string, number>;
  skills: Record<string, number>;
  /** 背包：物品 id → 件数（格子位置是展示规则，流水只关心「多了/少了多少件」） */
  bag: Map<string, number>;
  /** 已穿戴：槽位 → 物品 id（空串 = 空槽） */
  worn: Record<string, string>;
  /** 时装 id（空串 = 没穿） */
  fashion: string;
}

export default class RoleDeltaLog {
  private static last: RoleSnapshot | null = null;
  private static resolvers: RoleDeltaResolvers = {
    itemName: (id) => id,
    skillName: (id) => id,
    fashionName: (id) => id,
  };

  /** 注入名称解析器（ui 层接线时调用一次；只覆盖给了的那几项） */
  static configure(resolvers: Partial<RoleDeltaResolvers>): void {
    this.resolvers = { ...this.resolvers, ...resolvers };
  }

  /**
   * 重置基线（离开游戏场景时调用）
   *
   * 与 `MessageLogStore.clear()` 同时机：下一局第一次 `note` 只建基线 —— 否则换个角色进来，
   * 第一份快照会跟前一个角色的数据比，冒出一串莫名其妙的「获得 / 消耗」。
   */
  static reset(): void {
    this.last = null;
  }

  /**
   * 角色数据变了一次（**变化之后**调用：这里读到的就是新值）
   *
   * 没有角色 / 首次调用 / 换了角色：只建基线，不写流水。
   */
  static note(role: Role | null | undefined): void {
    if (!role || !role.id) return;
    const next = snapshotOf(role);
    const prev = this.last;
    this.last = next;
    if (!prev || prev.roleId !== next.roleId) return;
    report(prev, next, this.resolvers);
  }
}

/** 取一份快照（字段缺省一律按 0 / 空，老存档不该让流水崩） */
function snapshotOf(role: Role): RoleSnapshot {
  const attrs: Record<string, number> = {};
  for (const key of ATTRIBUTE_KEYS) attrs[key] = int(role.attrs ? (role.attrs as Record<string, unknown>)[key] : 0);
  const skills: Record<string, number> = {};
  const skillTable = (role.skills ?? {}) as Record<string, unknown>;
  for (const id of Object.keys(skillTable)) skills[id] = int(skillTable[id]);
  return {
    roleId: role.id,
    level: int(role.level),
    exp: int(role.exp),
    bindGold: int(role.bindGold),
    skillPoints: int(role.skillPoints),
    attrPoints: int(role.attrPoints),
    combat: int(role.combat),
    soulOfWar: int(role.soulOfWar),
    title: int(role.title),
    rank: int(role.rank),
    attrs,
    skills,
    bag: bagCounts(role),
    worn: wornIds(role),
    fashion: typeof role.fashionCloth === "string" ? role.fashionCloth : "",
  };
}

/** 背包按物品 id 聚合件数（空格子 / 坏格子跳过） */
function bagCounts(role: Role): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of role.bag ?? []) {
    if (!line) continue;
    for (const cell of line) {
      if (!cell || !cell.id) continue;
      const count = Math.max(1, int(cell.count));
      counts.set(cell.id, (counts.get(cell.id) ?? 0) + count);
    }
  }
  return counts;
}

/** 已穿戴的槽位 → 物品 id（老存档可能是裸 id 字符串，也可能是 `{ id, bound?, from? }`） */
function wornIds(role: Role): Record<string, string> {
  const worn: Record<string, string> = {};
  const equipments = (role.equipments ?? {}) as Record<string, unknown>;
  for (const slot of Object.keys(equipments)) worn[slot] = wornId(equipments[slot]);
  return worn;
}

function wornId(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return "";
}

/** 逐项对比并写流水（顺序：等级 → 经验 → 货币 → 物品 → 成长 → 装备 → 时装） */
function report(prev: RoleSnapshot, next: RoleSnapshot, resolvers: RoleDeltaResolvers): void {
  const levelChanged = prev.level !== next.level;
  if (levelChanged) {
    // 升级会把经验条清零 —— 那条「经验 -12,400」不是玩家掉的，别报
    const key = next.level > prev.level ? "message_log_level_up" : "message_log_level_down";
    push("level", getText(key, { from: prev.level, to: next.level }));
  } else if (prev.exp !== next.exp) {
    push("exp", getText("message_log_exp", { value: signed(next.exp - prev.exp) }));
  }

  if (prev.bindGold !== next.bindGold) {
    push("money", getText("message_log_money", { value: signed(next.bindGold - prev.bindGold) }));
  }

  reportBag(prev.bag, next.bag, resolvers);

  if (prev.skillPoints !== next.skillPoints) {
    push("growth", getText("message_log_skill_point", { value: signed(next.skillPoints - prev.skillPoints) }));
  }
  if (prev.attrPoints !== next.attrPoints) {
    push("growth", getText("message_log_attr_point", { value: signed(next.attrPoints - prev.attrPoints) }));
  }
  for (const key of ATTRIBUTE_KEYS) {
    if (prev.attrs[key] === next.attrs[key]) continue;
    push(
      "growth",
      getText("message_log_attr", {
        attr: getText(`label_attr_${key}`),
        value: signed(next.attrs[key] - prev.attrs[key]),
      }),
    );
  }
  if (prev.combat !== next.combat) {
    push("growth", getText("message_log_combat", { value: signed(next.combat - prev.combat) }));
  }
  reportSkills(prev.skills, next.skills, resolvers);
  if (prev.soulOfWar !== next.soulOfWar) push("growth", getText("message_log_soul", { level: next.soulOfWar }));
  if (prev.title !== next.title) push("growth", getText("message_log_title", { level: next.title }));
  if (prev.rank !== next.rank) push("growth", getText("message_log_rank", { level: next.rank }));

  reportWorn(prev.worn, next.worn, resolvers);

  if (prev.fashion !== next.fashion) {
    push(
      "growth",
      next.fashion
        ? getText("message_log_fashion", { name: resolvers.fashionName(next.fashion) })
        : getText("message_log_fashion_off"),
    );
  }
}

/** 背包差异：按物品 id 逐项写「获得 / 消耗」（同一件东西一次进出只写一条） */
function reportBag(before: Map<string, number>, after: Map<string, number>, resolvers: RoleDeltaResolvers): void {
  // 不用展开（audit-iterator-spread：babel loose 下迭代器展开会失效），Array.from 拼接
  const ids = new Set<string>(Array.from(before.keys()).concat(Array.from(after.keys())));
  for (const id of ids) {
    const from = before.get(id) ?? 0;
    const to = after.get(id) ?? 0;
    if (from === to) continue;
    const count = Math.abs(to - from);
    push("gain", getText(to > from ? "message_log_item_gain" : "message_log_item_lose", { name: resolvers.itemName(id), count }));
  }
}

/** 技能等级差异（只报变了的那个技能，不整表重报） */
function reportSkills(before: Record<string, number>, after: Record<string, number>, resolvers: RoleDeltaResolvers): void {
  const ids = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  for (const id of ids) {
    const from = before[id] ?? 0;
    const to = after[id] ?? 0;
    if (from === to) continue;
    push("growth", getText(to > from ? "message_log_skill_up" : "message_log_skill_down", {
      skill: resolvers.skillName(id),
      level: to,
    }));
  }
}

/** 穿脱：槽位上的物品变了就写一条（换装 = 脱下旧的 + 穿上新的两条） */
function reportWorn(before: Record<string, string>, after: Record<string, string>, resolvers: RoleDeltaResolvers): void {
  const slots = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  for (const slot of slots) {
    const from = before[slot] ?? "";
    const to = after[slot] ?? "";
    if (from === to) continue;
    // 先脱后穿：与玩家的操作顺序一致（换装时两条读起来像一句话）
    if (from) push("growth", getText("message_log_equip_off", { name: resolvers.itemName(from) }));
    if (to) push("growth", getText("message_log_equip_on", { name: resolvers.itemName(to) }));
  }
}

function push(category: MessageLogCategory, text: string): void {
  MessageLogStore.push(category, text);
}

/** 非负整数（脏值 / 缺字段一律 0，别让流水崩在 NaN 上） */
function int(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
}

/**
 * 带符号的数值文案：`+3,200` / `-12`
 *
 * 千分位是**展示规则**，留在这一层（不进 configs/texts 的模板 —— 模板里只写 `{value}`）。
 * 用正则而不是 `toLocaleString`：各平台 Intl 行为不一致，流水在 Android 上不该变成别的写法。
 */
function signed(delta: number): string {
  const text = String(Math.abs(Math.floor(delta))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return delta < 0 ? `-${text}` : `+${text}`;
}
