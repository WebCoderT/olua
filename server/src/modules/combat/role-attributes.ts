/**
 * 角色战斗属性汇总（服务端版）
 *
 * ===========================================================================
 * 这条为什么存在
 * ===========================================================================
 * 服务端要成为战斗权威，第一步不是「会算伤害」，而是**得先知道玩家有多强**。
 * 这份函数就是那个答案：给定一份角色存档，算出八项战斗属性与战斗力。
 *
 * 它不是新设计，是**对齐**：结果务必与客户端 `GameHelper.combatCalc` 完全一致。
 * 两端一旦算得不一样，后面所有上移到服务端的结算都会偏离玩家所见 —— 而这个偏差
 * 不会报错，只会变成「打怪手感不对」「升级后血量没变」这类最难查的抱怨。
 *
 * 所以本文件每一处「为什么这么写」都指向客户端那一版的行为，包括几处看着别扭的
 * 地方（见下）。**改这里先跑 `make audit-combat-parity`** —— 那个审计会拿着真的
 * 客户端算子跑同一组输入、逐项比对，掉一位都不行。
 *
 * ===========================================================================
 * 输入的数据全部来自生成物
 * ===========================================================================
 * 五张表全部取自那份 `@generated` 生成物（单一来源仍是 `client/assets/configs`）。
 * 这里只做查表与相加 —— **不做任何自行推算**。把算法照抄一份到服务端，
 * 正是这条线要消灭的事。
 */

import {
  COMBAT_RANGE_KEYS,
  COMBAT_WEIGHTS,
  EQUIPMENT_ATTRIBUTES,
  RANK_LEVEL_ATTRIBUTES,
  ROLE_LEVEL_ATTRIBUTES,
  SOUL_LEVEL_ATTRIBUTES,
  TITLE_LEVEL_ATTRIBUTES,
} from "./battle-rules.generated";

/** 汇总所需的那几个角色字段（角色存档里的原样字段名） */
export interface RoleAttributeSource {
  /** 角色等级（等级曲线里没有这个等级时算不出属性，返回 null） */
  level: number;
  /** 已穿戴装备：槽位 → 装备 id（客户端就是这么存的；查不到的 id 会被跳过） */
  equipments?: Record<string, string | null> | null;
  /** 战魂等级（0 = 未激活） */
  soulOfWar?: number;
  /** 称号等级（0 = 未激活） */
  title?: number;
  /** 军衔阶数（0 = 未授衔） */
  rank?: number;
}

/** 汇总结果（八项战斗属性 + 战斗力） */
export interface RoleAttributeSummary {
  maxHp: number;
  hpRecover: number;
  maxMp: number;
  physicalAttack: [number, number];
  magicAttack: [number, number];
  taoistAttack: [number, number];
  physicalDefense: [number, number];
  magicDefense: [number, number];
  taoistDefense: [number, number];
  combat: number;
}

/**
 * 汇总过程中需要被注意的地方
 *
 * 客户端的做法是「查不到的装备跳过，当作没穿」，这里也一样 —— 但服务端不能把这件事
 * 咽下去：客户端配置里删掉一件装备（或存档里留着旧 id）时，属性会悄悄少一截，
 * 而表面上一切正常。所以把它作为**可读的证据**交出去，让调用方能区分
 * 「这一格是空的」和「这一格里有东西但我查不到」。
 */
export interface RoleAttributeNotes {
  /** 查不到属性的装备 id（顺序即槽位遍历顺序） */
  unknownEquipmentIds: string[];
}

/**
 * 汇总一个角色的战斗属性
 *
 * 与客户端 `combatCalc` 只有两处差异，都是刻意的：
 *
 * 1. **不改传入对象**：客户端 `Object.assign(role, ...)` 直接把结果写回角色，
 *    这里是纯函数。服务端没有「改完要同步回客户端」的语境，写回还会让调用方分不清
 *    哪些字段是算出来的、哪些是存档里原本就有的。
 * 2. **等级查不到时返回 null**：客户端是「原样返回 role」（一次兜底，等于没重算）。
 *    服务端无处可取旧值，返回 null 让调用方自己决定是报错还是兜底 —— 不能静默给 0，
 *    「属性全 0」会被读成「算过了、结果就是 0」，那是完全不同的两句话。
 *
 * @param source 角色存档里的相关字段
 * @returns 汇总结果；等级曲线里没有这个等级时返回 null
 */
export function summarizeRoleAttributes(source: RoleAttributeSource): RoleAttributeSummary | null {
  return summarizeRoleAttributesWithNotes(source).summary;
}

/**
 * 同上，但把「哪几个装备 id 查不到」一起交出来
 *
 * 想要知道这次汇总有没有踩到未知装备时用这个（例如给运营看的那份角色详情）。
 */
export function summarizeRoleAttributesWithNotes(source: RoleAttributeSource): { summary: RoleAttributeSummary | null; notes: RoleAttributeNotes } {
  const notes: RoleAttributeNotes = { unknownEquipmentIds: [] };

  const levelBundle = lookupGeneratedBundle(ROLE_LEVEL_ATTRIBUTES, source.level);
  if (!levelBundle) return { summary: null, notes };

  const equipmentBundles = collectEquipmentBundles(source.equipments, notes);
  // 战魂 / 称号 / 军衔：三项都是「当前等级提供整份加成，未激活（< 1）则不加成」
  const extras = [
    lookupLevelBundle(SOUL_LEVEL_ATTRIBUTES, source.soulOfWar),
    lookupLevelBundle(TITLE_LEVEL_ATTRIBUTES, source.title),
    lookupLevelBundle(RANK_LEVEL_ATTRIBUTES, source.rank),
  ].filter((bundle): bundle is GeneratedBundle => bundle !== null);

  // maxHp / hpRecover 是单值，六项攻防是 [下限, 上限] 元组 —— 两条路径，别合并着写
  let maxHp = singleOf(levelBundle, "maxHp", 0);
  let hpRecover = singleOf(levelBundle, "hpRecover", 0);
  for (const bundle of [...equipmentBundles, ...extras]) {
    maxHp += singleOf(bundle, "maxHp", 0);
    hpRecover += singleOf(bundle, "hpRecover", 0);
  }
  // 魔法值只跟等级走（客户端注释：「装备暂不影响魔法值」）
  const maxMp = singleOf(levelBundle, "maxMp", 0);

  const ranges: Record<string, [number, number]> = {};
  for (const key of COMBAT_RANGE_KEYS) {
    let low = 0;
    let high = 0;
    for (const bundle of [levelBundle, ...equipmentBundles, ...extras]) {
      const value = rangeOf(bundle, key);
      if (!value) continue;
      low += value[0];
      high += value[1];
    }
    ranges[key] = [low, high];
  }

  return {
    summary: {
      maxHp,
      hpRecover,
      maxMp,
      physicalAttack: ranges.physicalAttack,
      magicAttack: ranges.magicAttack,
      taoistAttack: ranges.taoistAttack,
      physicalDefense: ranges.physicalDefense,
      magicDefense: ranges.magicDefense,
      taoistDefense: ranges.taoistDefense,
      // 战斗力是加权求和，两个反直觉的地方都是客户端的既有口径：
      //   ① 区间属性取**两端之和**（不是平均、也不是上限）
      //   ② maxHp 走另一条分支，取单值本身
      combat: computeCombat(maxHp, ranges),
    },
    notes,
  };
}

//#region 内部实现

/** 生成物里一份「属性包」的最小可访问形状 */
type GeneratedBundle = Record<string, unknown>;

function computeCombat(maxHp: number, ranges: Record<string, [number, number]>): number {
  let total = 0;
  for (const [key, weight] of Object.entries(COMBAT_WEIGHTS)) {
    if (key === "maxHp") {
      total += maxHp * weight;
      continue;
    }
    const value = ranges[key];
    // 权重表里出现的键一定在 ranges 里，这条防御是给将来新增权重用的
    if (value) total += (value[0] + value[1]) * weight;
  }
  return total;
}

/** 取单值属性（取不到用兜底值） */
function singleOf(bundle: GeneratedBundle, key: string, fallback: number): number {
  const value = bundle[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 取区间属性（不是 [a, b] 形状时返回 null） */
function rangeOf(bundle: GeneratedBundle, key: string): [number, number] | null {
  const value = bundle[key];
  if (!Array.isArray(value) || value.length < 2) return null;
  const low = Number(value[0]);
  const high = Number(value[1]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return [low, high];
}

/** 按**等级键**查表（角色等级那一支：键就是等级本身） */
function lookupGeneratedBundle(table: GeneratedBundle, level: number): GeneratedBundle | null {
  const value = Number(level);
  if (!Number.isFinite(value)) return null;
  const bundle = table[String(Math.trunc(value))];
  return bundle && typeof bundle === "object" ? (bundle as GeneratedBundle) : null;
}

/**
 * 按「客户端的等级语义」查战魂 / 称号 / 军衔表
 *
 * 生成物里这三张表的键是**来源数组的下标**，而客户端 `getXxxLevel(n)` 取的是
 * `config.level === n` 那一项（等级从 1 起）—— 两者差一位。这里是那一位的唯一去处，
 * 由 `audit-combat-parity` 全量遍历每个等级来保证没写反。
 */
function lookupLevelBundle(table: GeneratedBundle, level: number | undefined): GeneratedBundle | null {
  const value = Number(level);
  if (!Number.isFinite(value) || value < 1) return null; // 未激活（0 / undefined）→ 不加成
  return lookupGeneratedBundle(table, value - 1);
}

/** 收集穿戴装备的属性包（查不到的 id 跳过，但记进 notes） */
function collectEquipmentBundles(equipments: RoleAttributeSource["equipments"], notes: RoleAttributeNotes): GeneratedBundle[] {
  if (!equipments || typeof equipments !== "object") return [];
  const bundles: GeneratedBundle[] = [];
  for (const id of Object.values(equipments)) {
    if (typeof id !== "string" || id === "") continue; // 空槽位
    const bundle = EQUIPMENT_ATTRIBUTES[id as keyof typeof EQUIPMENT_ATTRIBUTES];
    if (!bundle) {
      notes.unknownEquipmentIds.push(id);
      continue;
    }
    bundles.push(bundle as unknown as GeneratedBundle);
  }
  return bundles;
}

//#endregion
