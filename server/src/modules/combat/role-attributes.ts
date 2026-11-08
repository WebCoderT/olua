/**
 * 角色战斗属性汇总（服务端版）
 *
 * ===========================================================================
 * 这条为什么存在
 * ===========================================================================
 * 服务端要成为战斗权威，第一步不是「会算伤害」，而是**得先知道玩家有多强**。
 * 这份函数就是那个答案：给定一份角色存档，算出八项战斗属性与战斗力。
 *
 * #541 起这就是**唯一的属性算法**：客户端的 `GameHelper.combatCalc` 已随「服务端权威、
 * 实时下发」一起删除 —— 客户端不再自己算、只消费 roleUpdate 帧，两端各算一份再拿审计
 * 对账的旧形态到此为止。属性只有一个出处（这里），错了就是错了，不存在「对齐谁」。
 *
 * 历史备注：本文件的算法是从客户端原版逐行平移来的（包括几处看着别扭的地方），
 * 当年的比对由 `audit-combat-parity` 完成 —— 那个审计已随客户端算子一起删除，
 * 现在改这里没有任何对账网兜，唯一的安全网是 e2e-roles 的「权威覆盖」断言。
 *
 * ===========================================================================
 * 输入的数据从哪来（#544 起口径变了）
 * ===========================================================================
 * 五张表都走 `shared/runtime-overrides` 的读取函数：**先查运营库覆盖层（管理端改过的
 * 当前值），没有再回落到 `@generated` 生成物（出厂值）**。
 *
 * 这条改动之前，这里直接读生成物 —— 生成物是**编译期**快照，于是「管理端把某件装备的
 * 攻击调到 20」在客户端生效（快照下发后 `apply-snapshot` 覆写），服务端算伤害还是 10：
 * 面板与伤害分裂，且没有任何报错。覆盖层由 `RuntimeConfigService` 在启动时与管理端
 * 每次写操作后装载。
 *
 * 数据来源只有一处：数据库（出厂快照 `server/data/config-sync.sql`）。
 */

import { COMBAT_RANGE_KEYS } from "../../common/constants/game-enums";
import {
  combatWeightsOf,
  equipmentAttributesOf,
  equipmentSlotOf,
  rankAttributesOf,
  roleLevelAttributesOf,
  soulAttributesOf,
  titleAttributesOf,
} from "../../common/runtime-config-cache";

/** 汇总所需的那几个角色字段（角色存档里的原样字段名） */
export interface RoleAttributeSource {
  /** 角色等级（等级曲线里没有这个等级时算不出属性，返回 null） */
  level: number;
  /**
   * 已穿戴装备：槽位 → `{ id }` 对象（#816 起槽位存对象，不再只存裸 id；查不到的 id 会被跳过）
   *
   * 这里只声明**结构上够用**的那部分（`id`），不 import `roles/role-inventory` 的
   * `WornItem`：战斗模块读的是「存档里有什么」，与背包算子不该有编译期依赖。
   */
  equipments?: Record<string, { id?: unknown } | null> | null;
  /** 战魂等级（0 = 未激活） */
  soulOfWar?: number;
  /** 称号等级（0 = 未激活） */
  title?: number;
  /** 军衔阶数（0 = 未授衔） */
  rank?: number;
}

/**
 * 从**角色存档**取汇总输入（把「摊平 data」的容错逻辑收成一处）
 *
 * 存档里装备 / 战魂 / 称号 / 军衔都是普通 JSON 字段，形状可能旧、可能缺 ——
 * 这里的容错与 `compareRoleAttributesOfRole` 原来那版完全一致，只是从「比对专用」
 * 提升为所有调用方共用：伤害结算、互见血条、成就战力、用药上限、存档重算
 * 必须吃同一份输入，否则就会出现「伤害按裸等级算、排行榜却算装备」的口径分裂。
 *
 * @param level 取**索引列**（`roles.level`）而不是 `data.level`：前者是服务端维护的权威值
 * @param data 已解码的角色存档（`decodeStoredRoleData` 的产物）
 */
export function roleAttributeSourceOf(level: number, data: Record<string, unknown>): RoleAttributeSource {
  return {
    level,
    equipments:
      data.equipments && typeof data.equipments === "object" && !Array.isArray(data.equipments)
        ? (data.equipments as Record<string, { id?: unknown } | null>)
        : null,
    soulOfWar: typeof data.soulOfWar === "number" ? data.soulOfWar : undefined,
    title: typeof data.title === "number" ? data.title : undefined,
    rank: typeof data.rank === "number" ? data.rank : undefined,
  };
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
  /**
   * 部位不符、因此没算进属性的槽位（#825）
   *
   * 正常存档里恒为空 —— 穿戴算子只往合法槽位写。出现即说明是脏档（老存档 / 运营 PATCH /
   * 改包），此时按「宁可少算」处理：这件装备不计属性，但**不改写存档**（修档是
   * `sanitizeEquipments` 的职责，发生在读档写档路径上）。
   */
  misfitEquipmentSlots: Array<{ slot: string; id: string; actualSlot: string }>;
}

/**
 * 汇总一个角色的战斗属性
 *
 * 与原客户端 `combatCalc`（已删除）只有两处差异，都是刻意的：
 *
 * 1. **不改传入对象**：原客户端 `Object.assign(role, ...)` 直接把结果写回角色，
 *    这里是纯函数。服务端没有「改完要同步回客户端」的语境，写回还会让调用方分不清
 *    哪些字段是算出来的、哪些是存档里原本就有的。
 * 2. **等级查不到时返回 null**：原客户端是「原样返回 role」（一次兜底，等于没重算）。
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
  const notes: RoleAttributeNotes = { unknownEquipmentIds: [], misfitEquipmentSlots: [] };

  const levelBundle = roleLevelAttributesOf(source.level);
  if (!levelBundle) return { summary: null, notes };

  const equipmentBundles = collectEquipmentBundles(source.equipments, notes);
  // 战魂 / 称号 / 军衔：三项都是「当前等级提供整份加成，未激活（< 1）则不加成」
  const extras = [soulAttributesOf(source.soulOfWar), titleAttributesOf(source.title), rankAttributesOf(source.rank)].filter(
    (bundle): bundle is GeneratedBundle => bundle !== null,
  );

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
  // #605：权重从覆盖层读（管理端「战斗力权重」页可改），缺省回落生成物的出厂值
  for (const [key, weight] of Object.entries(combatWeightsOf())) {
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

/**
 * 收集穿戴装备的属性包（同一件只算一次；查不到 / 部位不符的跳过但记进 notes）
 *
 * **这里必须自己去重与校验部位（#825）**：属性是「遍历 `equipments` 的所有值」累加出来的，
 * 不看键。于是同一件顶级武器同时写进 5 个槽位就能把属性算 5 遍 —— 改包、运营 PATCH 存档、
 * 老存档都能造出这种档，而写入侧的 `sanitizeEquipments` 只在**读档写档**那两条路上，
 * 结算 / 互见 / 榜单 / 成就读的是同一个 `data`，谁都没兜住。
 *
 * 两条处置口径（与 `sanitizeEquipments` 一致，只是这里不改写存档）：
 * - **同一件出现多次**：只算一次，且优先采用「槽位对得上」的那一处（脏档常把正确槽位写在后面）；
 * - **部位不符**：直接不计（记进 `notes.misfitEquipmentSlots`），挪槽是修档的职责。
 */
function collectEquipmentBundles(equipments: RoleAttributeSource["equipments"], notes: RoleAttributeNotes): GeneratedBundle[] {
  if (!equipments || typeof equipments !== "object") return [];
  // 第一遍：按 id 收口，同一件只留一处 —— 槽位对的优先
  const chosen = new Map<string, { slot: string; actualSlot: string | null }>();
  for (const [slot, entry] of Object.entries(equipments)) {
    // 空槽位 / 形状不对（`{}` 没有 id）一律跳过：宁可少算一件，也不让 NaN 混进属性
    const raw = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : entry;
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id) continue;
    const actualSlot = equipmentSlotOf(id);
    const kept = chosen.get(id);
    if (!kept) {
      chosen.set(id, { slot, actualSlot });
      continue;
    }
    // 已有同名件：当前这处部位对得上、而留存那处对不上 → 换成这一处
    if (!slotMatches(kept.actualSlot, kept.slot) && slotMatches(actualSlot, slot)) chosen.set(id, { slot, actualSlot });
  }

  // 第二遍：出属性包（查不到的 id 跳过，但记进 notes）
  const bundles: GeneratedBundle[] = [];
  for (const [id, { slot, actualSlot }] of chosen) {
    if (actualSlot !== null && !slotMatches(actualSlot, slot)) {
      notes.misfitEquipmentSlots.push({ slot, id, actualSlot });
      continue;
    }
    // 先查运营库覆盖层（管理端改过就是新值），没有再提出厂属性 —— 两端同一份数字
    const bundle = equipmentAttributesOf(id);
    if (!bundle) {
      notes.unknownEquipmentIds.push(id);
      continue;
    }
    bundles.push(bundle as unknown as GeneratedBundle);
  }
  return bundles;
}

/**
 * 槽位名是否对得上
 *
 * **大小写不敏感**：老存档 / 管理端历史入参里槽位是大写（`WEAPON`），库里的部位键是小写
 * （`weapon`）。`sanitizeEquipments` 会在下次存盘时把键改成小写，但「改存档之前」的这段时间
 * 属性也必须照常算 —— 否则一次升级会让老号的装备凭空失效。
 *
 * `actualSlot === null` = 认不出的 id（服务端快照里没有这件）：判断不了部位，一律放行，
 * 由 `equipmentAttributesOf` 查不到再跳过（与修档口径一致：认不出的不删）。
 */
function slotMatches(actualSlot: string | null, slot: string): boolean {
  if (actualSlot === null) return true;
  return actualSlot.toLowerCase() === String(slot).toLowerCase();
}

//#endregion
