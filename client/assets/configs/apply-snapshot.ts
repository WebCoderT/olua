import type {
  ConfigAttributes,
  Drug as DrugRow,
  Equipment as EquipmentRow,
  Fashion as FashionRow,
  GameConfigSnapshot,
  GrowthScalar,
  GrowthSegment,
  Item as ItemRow,
  LevelExp,
  MallPriceItem,
  Monster as MonsterRow,
  Npc as NpcRow,
  Quest as QuestRow,
  Rank,
  Skill as SkillRow,
  Soul,
  Status as StatusRow,
  Title,
} from "../ui/utils/net/ApiModels";
import type { BattleAttributes } from "../types/common";
import { GOOD_TYPE } from "../types/good";
import type { DrugEffect } from "../types/good";
import type { RankAttributes, RankLevelConfig } from "../types/rank";
import type { SoulAttributes, SoulLevelConfig } from "../types/soul";
import type { TitleAttributes, TitleLevelConfig } from "../types/title";
import { titleLevels } from "./title";
import { soulLevels } from "./soul";
import { rankLevels } from "./rank";
import { applyMallPricing } from "./mall";
import { attributeRange, equipmentPrefixRates, equipmentRecyclePrice, equipmentSuffixRates, roleGrowth, setRoleMaxLevel } from "./growth";
import { expGain, levelMap, rebuildLevelMap } from "./level";
import { items } from "./items";
import { drugs } from "./drug";
import { monsters } from "./monster";
import { npcData } from "./npc-data";
import { questData } from "./quest-data";
import type { QuestData } from "./quest-data";
import { rebuildQuests } from "./quest";
import { fashionData } from "./fashionClothes";
import { getEquipmentBaseKey, scaleEquipmentAttributes } from "./equipments";
import { skillData } from "./skill-data";
import { statuses } from "./status";
import { SkillData, SkillTargetType, SkillType } from "../types/skill";
import { OECCUPATION } from "../types/role";
import { StatusConfig, StatusSource } from "../types/status";
import type { ACTION } from "../types/animation";

/**
 * 服务端配置快照落库（#294 / #361 / #363）
 *
 * 进游戏时拉到 `gameConfig.snapshot` 后，把管理端可改的字段**原地覆写**进本地
 * 配置数据（称号 / 战魂 / 军衔 / 商城定价 / 成长曲线与等级经验 / 装备 / 药品 / 物品 /
 * 怪物 / NPC / 时装 / 技能 / 状态）—— 消费方拿到的引用不变、读取函数签名不变，
 * 所以弹窗 / 战力计算 / 名牌外显 / 背包 / 图鉴零改动即读新值。
 *
 * 覆写是**逐条按 key 对齐**的：快照里没有的行（服务端与本地行数不一致时）保留
 * 本地值兜底，绝不因为下发数据缺行而让配置变成 undefined。
 *
 * ## 只覆写「管理端能改的字段」
 * 资源路径（icon / 动画目录 / 外观 src）、几何（位置 / 缩放 / 碰撞尺寸）、
 * AI 参数一律**不覆写** —— 它们属于发布素材与客户端布局，服务端那份只是 seed 时的镜像。
 * 这条不是偷懒：resources 以远程发布包为唯一来源（见仓库 README 的素材纪律），
 * 让服务端下发路径就能把客户端指到一张不存在的图上。
 *
 * ⚠ 消费方注意：覆写发生在进游戏后的异步时刻，模块加载期的读取（如资源预加载）
 * 仍用本地数据 —— 这正是设计意图：预加载走本地资源路径，玩法数值走服务端。
 */

/** 覆写称号配置（按 level 对齐；label / 描述 / 价格 / 渠道 / 属性以服务端为准） */
export function applyTitleRows(rows: Title[]): void {
  rows.forEach((row) => {
    const config = titleLevels.find((item) => item.level === row.level) as
      | (TitleLevelConfig & { acquireChannel?: string; upgradeOrder?: number | null })
      | undefined;
    if (!config) return;
    config.label = row.label;
    config.description = row.description;
    config.bindGold = row.bindGold;
    config.animation = row.animation;
    config.animationFrameRate = row.animationFrameRate;
    config.attributes = row.attributes as unknown as TitleAttributes;
    config.acquireChannel = row.acquireChannel;
    config.upgradeOrder = row.upgradeOrder ?? null;
  });
}

/** 覆写战魂配置（与称号同构，只少渠道两个字段） */
export function applySoulRows(rows: Soul[]): void {
  rows.forEach((row) => {
    const config = soulLevels.find((item) => item.level === row.level) as
      | (SoulLevelConfig & { upgradeOrder?: number | null })
      | undefined;
    if (!config) return;
    config.label = row.label;
    config.description = row.description;
    config.bindGold = row.bindGold;
    config.animation = row.animation;
    config.animationFrameRate = row.animationFrameRate;
    config.attributes = row.attributes as unknown as SoulAttributes;
    config.upgradeOrder = row.upgradeOrder ?? null;
  });
}

/** 覆写军衔配置（无动画字段；tier 大段名管理端不可改，保持本地值） */
export function applyRankRows(rows: Rank[]): void {
  rows.forEach((row) => {
    const config = rankLevels.find((item) => item.level === row.level) as RankLevelConfig | undefined;
    if (!config) return;
    config.label = row.label;
    config.description = row.description;
    config.bindGold = row.bindGold;
    config.attributes = row.attributes as unknown as RankAttributes;
  });
}

/** 商城定价：统一价 + 特殊价表（price = null 的行 = 未定价，走统一价） */
function applyMallPrices(prices: MallPriceItem[], defaultPrice: number): void {
  applyMallPricing(defaultPrice, prices);
}

/**
 * 覆写成长曲线分段（#361）
 *
 * **整条曲线替换**而不是逐段合并：段的条数、边界与斜率是一体的，逐段覆盖会出现
 * 「服务端删了一段、客户端还留着旧段」这种半截曲线 —— 采样时按 to 值顺序找段，
 * 残留的旧段会把新数值挡在外面。
 * 服务端多给客户端不认识的曲线键时忽略（旧客户端遇到新曲线照常玩）。
 */
export function applyGrowthSegments(rows: GrowthSegment[]): void {
  const buckets = new Map<keyof typeof roleGrowth, GrowthSegment[]>();
  rows.forEach((row) => {
    if (!(row.curve in roleGrowth)) return;
    const curve = row.curve as keyof typeof roleGrowth;
    const bucket = buckets.get(curve);
    if (bucket) bucket.push(row);
    else buckets.set(curve, [row]);
  });
  buckets.forEach((bucket, curve) => {
    // 段序取服务端的 seq：to 值必须单调，否则 sampleGrowth 会在第一段就直接返回
    roleGrowth[curve] = bucket
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((row) => ({ from: row.fromLevel, to: row.toLevel, start: row.startValue, perLevel: row.perLevel }));
  });
}

/**
 * 覆写成长标量参数（#361）
 *
 * 键名是管理端的接口契约（`GROWTH_SCALAR_SPECS`），客户端这里逐个显式列出而不是
 * 按点号路径反射赋值 —— 反射看着省事，但打错一个键就会静默写到一个不存在的字段上，
 * 而 switch 漏了新键至少是「明明收到了却没生效」，能在代码评审时看出来。
 * 未知键直接忽略（服务端新增参数时旧客户端照常玩）。
 */
export function applyGrowthScalars(rows: GrowthScalar[]): void {
  rows.forEach((row) => {
    switch (row.key) {
      case "roleMaxLevel":
        setRoleMaxLevel(row.value);
        return;
      case "attributeRange.minRate":
        attributeRange.minRate = row.value;
        return;
      case "attributeRange.mpRate":
        attributeRange.mpRate = row.value;
        return;
      case "attributeRange.hpRecoverRate":
        attributeRange.hpRecoverRate = row.value;
        return;
      case "expGain.expPerLevel":
        expGain.expPerLevel = row.value;
        return;
      case "expGain.maxLevelGap":
        expGain.maxLevelGap = row.value;
        return;
      default:
        return;
    }
  });
}

/**
 * 覆写升级经验（#361）
 *
 * 这是**最终权威**：曲线先算出一份 exp（保证「每级打几只」与实际经验对得上），
 * 管理端能直接改经验表，所以覆盖放在重建之后 —— 两者不一致时以服务端经验表为准。
 * 超出当前等级上限的行跳过：上限调小后服务端仍有更大 level 的行，不该凭空造出等级。
 */
export function applyLevelExps(rows: LevelExp[]): void {
  rows.forEach((row) => {
    const config = levelMap.get(row.level);
    if (config) config.exp = row.exp;
  });
}

/**
 * 成长底座的覆写总入口（#361）
 *
 * 顺序有讲究：**先换曲线与标量，再重建等级表**（每级属性与升级经验都由曲线派生，
 * 换了曲线不重建就是旧值留底），**最后用服务端经验表覆盖 exp**。
 * 重建是无条件的：快照没带成长数据时重建也等价于模块加载期那一次（60 行循环），
 * 而且「上限变小」这种变化只有重建才会让多出来的等级消失。
 */
export function applyGrowthSnapshot(snapshot: GameConfigSnapshot): void {
  if (snapshot.growthSegments) applyGrowthSegments(snapshot.growthSegments);
  if (snapshot.growthScalars) applyGrowthScalars(snapshot.growthScalars);
  rebuildLevelMap();
  if (snapshot.levelExps) applyLevelExps(snapshot.levelExps);
}

//#region 内容表（#363）

/** 八项属性 DTO → 客户端战斗属性（响应里是区间对象 {min,max}，客户端一直用元组 [min,max]） */
function toBattleAttributes(attributes: ConfigAttributes): BattleAttributes {
  const range = (source: { min: number; max: number }): [number, number] => [source.min, source.max];
  return {
    maxHp: attributes.maxHp,
    hpRecover: attributes.hpRecover,
    physicalAttack: range(attributes.physicalAttack),
    magicAttack: range(attributes.magicAttack),
    taoistAttack: range(attributes.taoistAttack),
    physicalDefense: range(attributes.physicalDefense),
    magicDefense: range(attributes.magicDefense),
    taoistDefense: range(attributes.taoistDefense),
  };
}

/**
 * 覆写装备（#363）
 *
 * 服务端只下发**基础件**（37 件，属性是「普通的·人级」），客户端是一张 555 条的变体 Map
 * （每件基础件 × 5 前缀 × 3 后缀）。所以这里按 id 归并回基础件、再按同一套倍率**重算**每个变体：
 * 属性**从服务端基础值重新乘倍率**，不是在变体当前值上再乘一次 —— 后者每覆写一次就滚一级雪球，
 * 重进游戏数值会飘（这也是幂等的唯一保证）。
 *
 * 资源与几何（icon / in / out / 位置 / 缩放 / 部位）一律不动：那是发布素材与客户端布局，
 * 服务端没有裁决权。回收价按「服务端等级 × 前后缀倍率」重算，与 buildEquipmentMap 同口径。
 */
export function applyEquipmentRows(rows: EquipmentRow[]): void {
  if (!rows.length) return;
  const overrides = new Map<string, EquipmentRow>();
  rows.forEach((row) => overrides.set(row.id, row));
  items.forEach((good, id) => {
    if (good.type !== GOOD_TYPE.EQUIPMENT) return;
    const row = overrides.get(getEquipmentBaseKey(id));
    if (!row) return;
    const rate = equipmentPrefixRates[good.prefix] * equipmentSuffixRates[good.suffix];
    Object.assign(good, scaleEquipmentAttributes(toBattleAttributes(row.attributes), rate));
    good.label = row.label;
    good.level = row.level;
    good.sellPirce = row.sellPrice;
    good.recyclePrice = Math.round(equipmentRecyclePrice(row.level) * rate);
  });
}

/**
 * 服务端把药品效果拍平成四个单值（同类效果逐项求和），客户端用的是 effects 数组 ——
 * 两者语义等价（resolveDrugRecovery 也是逐项累加），这里还原成**一条**合并效果即可，
 * 全为 0 时给空数组（0 = 没有该效果，不是「回 0 点」）。
 */
function toDrugEffects(row: DrugRow): DrugEffect[] {
  const effect: DrugEffect = {};
  if (row.effectHp > 0) effect.hp = row.effectHp;
  if (row.effectMp > 0) effect.mp = row.effectMp;
  if (row.effectHpPercent > 0) effect.hpPercent = row.effectHpPercent;
  if (row.effectMpPercent > 0) effect.mpPercent = row.effectMpPercent;
  return Object.keys(effect).length ? [effect] : [];
}

/** 覆写药品（文案 / 价格 / 叠加上限 / 冷却 / 回复量；id 序列固定，不增删行） */
export function applyDrugRows(rows: DrugRow[]): void {
  if (!rows.length) return;
  const overrides = new Map<string, DrugRow>();
  rows.forEach((row) => overrides.set(row.id, row));
  drugs.forEach((drug) => {
    const row = drug.id ? overrides.get(drug.id) : undefined;
    if (!row) return;
    drug.label = row.label;
    drug.description = row.description;
    drug.sellPirce = row.sellPrice;
    drug.maxStack = row.maxStack;
    drug.cooldown = row.cooldown;
    drug.effects = toDrugEffects(row);
  });
}

/**
 * 覆写物品与材料（文案 / 价格 / 叠加上限）
 *
 * 按 id 逐个对齐后原地改：快照里没有的 id（客户端独有的其它条目）保持本地值，
 * 类型（type）与图标属结构字段，不覆写。
 */
export function applyItemRows(rows: ItemRow[]): void {
  if (!rows.length) return;
  const overrides = new Map<string, ItemRow>();
  rows.forEach((row) => overrides.set(row.id, row));
  items.forEach((good, id) => {
    const row = overrides.get(id);
    if (!row) return;
    good.label = row.label;
    good.description = row.description;
    good.sellPirce = row.sellPrice;
    if (good.stackable) good.maxStack = row.maxStack;
  });
}

/**
 * 覆写怪物基础数据（名称 / 等级 / 生命 / 六项攻防）
 *
 * 数值来源是服务端的展开值（管理端改的是 maxHp 与区间本身，不是曲线参数），
 * 所以直接写死字段而不是重算 monsterStats —— 重算会在「管理端给某只怪单独调高血量」时把它抹回去。
 * 外观（icon / out / 几何 / 移动速度 / AI）不覆写。
 */
export function applyMonsterRows(rows: MonsterRow[]): void {
  rows.forEach((row) => {
    const config = monsters.get(row.id);
    if (!config) return;
    const range = (source: { min: number; max: number }): [number, number] => [source.min, source.max];
    config.label = row.label;
    config.level = row.level;
    config.maxHp = row.maxHp;
    config.physicalAttack = range(row.attributes.physicalAttack);
    config.magicAttack = range(row.attributes.magicAttack);
    config.taoistAttack = range(row.attributes.taoistAttack);
    config.physicalDefense = range(row.attributes.physicalDefense);
    config.magicDefense = range(row.attributes.magicDefense);
    config.taoistDefense = range(row.attributes.taoistDefense);
  });
}

/**
 * 覆写 NPC 名称（#363）
 *
 * 只改文案：`src` / `scale` / `position` 是地图摆放与资源路径，归客户端与素材包管。
 * 服务端的 `dialog` 客户端暂无形（对话数据形态未落地），这里不硬塞。
 */
export function applyNpcRows(rows: NpcRow[]): void {
  if (!rows.length) return;
  const overrides = new Map<string, NpcRow>();
  rows.forEach((row) => overrides.set(row.id, row));
  npcData.forEach((npc) => {
    const row = overrides.get(npc.id);
    if (row) npc.label = row.label;
  });
}

/**
 * 覆写任务配置（#396）
 *
 * 三种情况都要处理：
 * - 本地有的行 → 原地覆写（消费方拿到的引用不变，`quests` Map 由 `rebuildQuests()` 重建）；
 * - 本地没有、快照里有 → **追加**（管理端能新建任务，目标类型只有 kill / talk / collect 三种，
 *   新的行不需要客户端代码配合就能跑）；
 * - 快照里没有、本地有 → 保留（服务端还没 seed 时用本地兜底，与其它表同口径）。
 *
 * 奖励物品只认 `goodId / count` 两个字段：物品名与图标由物品总表解析，任务表不复制一份。
 */
export function applyQuestRows(rows: QuestRow[]): void {
  if (!rows.length) return;
  for (const row of rows) {
    const next = questRowToConfig(row);
    const config = questData.find((item) => item.id === row.id);
    if (config) Object.assign(config, next);
    else questData.push(next);
  }
  rebuildQuests();
}

/** 任务行（服务端快照）→ 客户端任务配置（奖励物品只认 goodId / count） */
function questRowToConfig(row: QuestRow): QuestData {
  const objective = row.objective ?? { type: "kill", target: "", count: 1 };
  const type = objective.type === "talk" || objective.type === "collect" ? objective.type : "kill";
  return {
    id: row.id,
    kind: row.kind === "daily" ? "daily" : "main",
    label: row.label,
    description: row.description,
    prevQuestId: row.prevQuestId ?? "",
    minLevel: Math.max(1, Math.floor(row.minLevel || 1)),
    npcId: row.npcId ?? "",
    objective: { type, target: `${objective.target ?? ""}`, count: Math.max(1, Math.floor(objective.count || 1)) },
    rewards: {
      gold: Math.max(0, Math.floor(row.rewards?.gold ?? 0)),
      exp: Math.max(0, Math.floor(row.rewards?.exp ?? 0)),
      items: (row.rewards?.items ?? []).map((entry) => ({ goodId: `${entry.goodId ?? ""}`, count: Math.max(1, Math.floor(entry.count || 1)) })),
    },
  };
}

/**
 * 覆写时装（名称 / 描述 / 价格 / 八项属性）
 *
 * **icon / in / out 不覆写**：资源路径以发布素材包为准（与 resources 纪律一致），
 * 服务端那份只是 seed 时的镜像。属性全 0 时也要照写（运营可能就是把加成清零）。
 */
export function applyFashionRows(rows: FashionRow[]): void {
  if (!rows.length) return;
  const overrides = new Map<string, FashionRow>();
  rows.forEach((row) => overrides.set(row.id, row));
  fashionData.forEach((fashion) => {
    const row = overrides.get(fashion.id);
    if (!row) return;
    fashion.label = row.label;
    fashion.description = row.description;
    fashion.sellPrice = row.sellPrice;
    const attributes = toBattleAttributes(row.attributes);
    fashion.attributes = {
      maxHp: attributes.maxHp,
      physicalAttack: attributes.physicalAttack,
      magicAttack: attributes.magicAttack,
      taoistAttack: attributes.taoistAttack,
      physicalDefense: attributes.physicalDefense,
      magicDefense: attributes.magicDefense,
      taoistDefense: attributes.taoistDefense,
    };
  });
}

/**
 * 技能行（服务端快照）→ 客户端数值配置（不含释放实现）
 *
 * `oeccupation` 不来自服务端：它属于客户端布局（技能栏按 `oeccupationSkills` 列举 id），
 * 服务端也没有这一列 —— 覆写时保留本地的职业归属，追加时统一给「全职业」。
 */
function skillRowToData(row: SkillRow, oeccupation: OECCUPATION = OECCUPATION.ALL): SkillData {
  return {
    id: row.id,
    owner: row.owner === "monster" ? "monster" : "role",
    label: row.label,
    icon: row.icon,
    cooldown: row.cooldown,
    mpCost: row.mpCost,
    targetType: row.targetType as SkillTargetType,
    oeccupation,
    level: row.levelReq,
    description: row.description,
    type: row.category as SkillType,
    damageCoefficients: row.damageCoefficients.map((entry) => ({
      baseType: entry.baseType as keyof BattleAttributes,
      baseTypeRate: entry.baseTypeRate,
    })),
    distance: row.distance,
    action: row.action as ACTION,
    effect: row.effect || undefined,
    effectIsOnSelf: row.effectOnSelf,
    statusId: row.statusId || undefined,
    castLockMs: row.castLockMs,
    requireTarget: row.requireTarget,
    canAuto: row.canAuto,
  };
}

/** 状态行（服务端快照）→ 客户端状态配置 */
function statusRowToConfig(row: StatusRow): StatusConfig {
  return {
    label: row.label,
    icon: row.icon,
    duration: row.duration,
    source: row.source as StatusSource,
    description: row.description,
    effect: row.effect || undefined,
    effectHoldLast: row.effectHoldLast,
    // 四个维度全缺省 = 纯表现状态（与 StatusCombatConfig 的「缺省不参与」一致）
    combat: {
      blockChance: row.combat?.blockChance,
      blockFactor: row.combat?.blockFactor,
      defenseMultiplier: row.combat?.defenseMultiplier,
      attackMultiplier: row.combat?.attackMultiplier,
    },
  };
}

/**
 * 技能配置覆写（#367 / #372）
 *
 * 角色与怪物**一起覆写**（#372 起怪物技能也要按运营改过的值演出）：
 * - 本地已有的行 → 原地覆写（消费方拿到的引用不变，`skills` Map 由 `rebuildSkills()` 重建）；
 * - 本地没有、快照里是**怪物技能** → 追加（管理端能新建怪物技能，客户端必须能演新的动作 / 特效）；
 * - 本地没有、快照里是角色技能 → 忽略（角色技能清单固定在配置里，多出来的 id 没有实现）。
 *
 * **不动 onClick**：技能释放实现是代码（configs/skill 按 id 接上），数据只描述
 * 「冷却 / 倍率 / 动作 / 特效 / 释放限制」。覆写后必须调 `rebuildSkills()`（见 ConfigLoader），
 * 否则 skills Map 里还是旧对象 —— 消费方读的是 Map，不是这个数组。
 */
export function applySkillRows(rows: SkillRow[]): void {
  for (const row of rows) {
    const config = skillData.find((item) => item.id === row.id);
    if (!config) {
      if (row.owner === "monster") skillData.push(skillRowToData(row));
      continue;
    }
    const next = skillRowToData(row, config.oeccupation);
    Object.assign(config, next);
  }
}

/**
 * 状态配置覆写（#367 / #372）
 *
 * 覆写的是**注册表本身**（`statuses` 这个 Map 的元素内容），所以已经在身上生效的状态
 * 时长与图标也会跟着变（`StatusManager` 只记到期时间戳，读的仍是这份配置）。
 * 快照里有、本地没有的怪物状态同样追加 —— 服务端会在 `casts` 帧里带 statusId，
 * 客户端查不到配置就没法在怪物身上播特效。
 */
export function applyStatusRows(rows: StatusRow[]): void {
  for (const row of rows) {
    const next = statusRowToConfig(row);
    const config = statuses.get(row.id);
    if (!config) {
      if (row.owner === "monster") statuses.set(row.id, next);
      continue;
    }
    Object.assign(config, next);
  }
}

/** 技能与状态的覆写总入口（#367）：角色与怪物同表，一起覆写；缺表跳过 */
export function applySkillSnapshot(snapshot: GameConfigSnapshot): void {
  if (snapshot.skills) applySkillRows(snapshot.skills);
  if (snapshot.statuses) applyStatusRows(snapshot.statuses);
}

/** 内容表的覆写总入口（#363）：六张表各自按 id 对齐，缺表跳过 */
export function applyContentSnapshot(snapshot: GameConfigSnapshot): void {
  if (snapshot.equipments) applyEquipmentRows(snapshot.equipments);
  if (snapshot.drugs) applyDrugRows(snapshot.drugs);
  if (snapshot.items) applyItemRows(snapshot.items);
  if (snapshot.monsters) applyMonsterRows(snapshot.monsters);
  if (snapshot.npcs) applyNpcRows(snapshot.npcs);
  if (snapshot.quests) applyQuestRows(snapshot.quests);
  if (snapshot.fashions) applyFashionRows(snapshot.fashions);
}

//#endregion

/** 快照总入口：逐表覆写；某表缺失（undefined）时跳过该表，保留本地兜底 */
export function applyConfigSnapshot(snapshot: GameConfigSnapshot): void {
  if (snapshot.titles) applyTitleRows(snapshot.titles);
  if (snapshot.souls) applySoulRows(snapshot.souls);
  if (snapshot.ranks) applyRankRows(snapshot.ranks);
  if (snapshot.mallPrices && snapshot.mallSettings) {
    applyMallPrices(snapshot.mallPrices, snapshot.mallSettings.defaultPrice);
  }
  applyGrowthSnapshot(snapshot);
  applyContentSnapshot(snapshot);
  applySkillSnapshot(snapshot);
}
