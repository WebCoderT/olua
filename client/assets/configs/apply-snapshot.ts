import { Vec2 } from "cc";
import type {
  ConfigAttributes,
  Drug as DrugRow,
  Equipment as EquipmentRow,
  EquipAlign,
  EquipInAlign,
  Fashion as FashionRow,
  GameConfigSnapshot,
  GrowthScalar,
  Item as ItemRow,
  MallPriceItem,
  MapConfig as MapConfigRow,
  MapTypeGroup as MapTypeGroupRow,
  Monster as MonsterRow,
  MonsterPresentation as MonsterPresentationRow,
  Quest as QuestRow,
  Skill as SkillRow,
  Status as StatusRow,
  UiEffectConfig,
} from "../ui/utils/net/ApiModels";
import type { BattleAttributes } from "../types/common";
import { GOOD_TYPE } from "../types/good";
import type { EquipmentData, OutTransform } from "../types/good";
import { applyTitleRows } from "./title";
import { applySoulRows } from "./soul";
import { applyRankRows } from "./rank";
import { applyLevelRows } from "./level";
import { mapTypeGroups, maps } from "./map";
import { uiEffects } from "./effect";
import { applyMallPricing } from "./mall";
import { applyCombatWeights } from "./battle";
import { applyEquipmentRules, setRoleMaxLevel } from "./growth";
import { items, rebuildItemIndex } from "./items";
import { applyDrugData } from "./drug";
import { applyItemBaseData } from "./material";
import { applyMonsterPresentation, applyMonsterRuntimeStats } from "./monsterRuntime";
import { applyNpcRows } from "./npc";
import { questData } from "./quest-data";
import type { QuestData } from "./quest-data";
import { rebuildQuests } from "./quest";
import { applyFashionData } from "./fashionClothes";
import { applyEquipmentData, applyEquipmentQualityLabels, applyEquipmentSlots, getEquipmentBaseKey } from "./equipments";
import { roleDefaultCloths } from "./role";
import { applySkillData } from "./skill-data";
import { statuses } from "./status";
import { SEX } from "../types/role";
import { StatusConfig, StatusSource } from "../types/status";
import type { MonsterRuntimeStats } from "../types/monster";

/**
 * 服务端配置快照落库（#294 / #361 / #363 / #590）
 *
 * 进游戏时拉到 `gameConfig.snapshot` 后，把管理端可改的字段**原地覆写**进本地
 * 配置数据（称号 / 战魂 / 军衔 / 等级表 / 商城定价 / 装备 / 药品 / 物品 /
 * 怪物 / NPC / 时装 / 技能 / 状态）—— 消费方拿到的引用不变、读取函数签名不变，
 * 所以弹窗 / 战力计算 / 名牌外显 / 背包 / 图鉴零改动即读新值。
 *
 * #590 起称号 / 战魂 / 军衔 / 等级表是**整表重建**（与地图 #573 同款）：
 * 客户端没有本地数据兜底行（书写处在 server/src/shared/*-seed.ts），
 * 快照里没有的阶 / 级客户端就不存在 —— 「管理端删了一行」会如实反映。
 *
 * ## 只覆写「管理端能改的字段」
 * 资源路径（icon / 动画目录 / 外观 src）、几何（位置 / 缩放 / 碰撞尺寸）、
 * AI 参数一律**不覆写** —— 它们属于发布素材与客户端布局，服务端那份只是 seed 时的镜像。
 * 这条不是偷懒：resources 以远程发布包为唯一来源（见仓库 README 的素材纪律），
 * 让服务端下发路径就能把客户端指到一张不存在的图上。
 *
 * **例外只有两处，都是「管理端调出来的几何」**（再多一处就该重审这条纪律了）：
 * - 装备**外观**几何（#513，见文件末尾的 `applyEquipAlignRows`）：8 方向位置 + 缩放；
 * - 装备**内观**几何（#523，见 `applyEquipInAlignRows`）：弹窗圆盘上的位置 + 两轴缩放。
 * 两者都只覆写「位置 / 缩放 / 手调开关」，**资源路径依然一个都不动** ——
 * 否则服务端能把客户端指到一张不存在的图上。
 *
 * ⚠ 消费方注意：覆写发生在进游戏后的异步时刻，模块加载期的读取（如资源预加载）
 * 仍用本地数据 —— 这正是设计意图：预加载走本地资源路径，玩法数值走服务端。
 * （称号 / 战魂的动画目录是快照下发里的例外——它们本来就是服务端种子的字段，#590。） */

/** 商城定价：统一价 + 特殊价表（price = null 的行 = 未定价，走统一价） */
function applyMallPrices(prices: MallPriceItem[], defaultPrice: number): void {
  applyMallPricing(defaultPrice, prices);
}

/**
 * 覆写成长标量参数（#361；#590 起客户端只消费 roleMaxLevel）
 *
 * 键名是管理端的接口契约（`GROWTH_SCALAR_SPECS`）。曲线派生类参数（attributeRange.* /
 * expGain.*）随 #590 移出客户端（属性与经验都由服务端展开进 `levels` 段），
 * 这里只保留等级上限的覆写；未知键直接忽略（服务端新增参数时旧客户端照常玩）。
 */
export function applyGrowthScalars(rows: GrowthScalar[]): void {
  rows.forEach((row) => {
    switch (row.key) {
      case "roleMaxLevel":
        setRoleMaxLevel(row.value);
        return;
      default:
        return;
    }
  });
}

/**
 * 成长底座的覆写总入口（#361；#590 重写）
 *
 * #590 前是「曲线 + 标量下发 → 客户端重建 levelMap → 经验表覆盖」；
 * #590 起客户端不派生：快照 `levels` 段就是每级的最终属性与经验（服务端展开），
 * 这里只剩「标量里的上限先落、再整表重建 levelMap」两步。
 * 顺序有讲究：上限变了 levelMap 行数跟着变（整表重建自然裁掉多出来的等级）。
 */
export function applyGrowthSnapshot(snapshot: GameConfigSnapshot): void {
  if (snapshot.growthScalars) applyGrowthScalars(snapshot.growthScalars);
  if (snapshot.levels) applyLevelRows(snapshot.levels);
}

//#region 内容表（#363）

/** 区间型属性（服务端 `{ min, max }`）→ 客户端 `[下限, 上限]` */
function toAttributeRange(range: { min: number; max: number } | undefined): [number, number] {
  return [range?.min ?? 0, range?.max ?? 0];
}

/**
 * 八项属性（服务端 `ConfigAttributes`）→ 客户端 `BattleAttributes`
 *
 * 两者只差区间表示：服务端是 `{ min, max }` 对象，客户端是二元组数组。
 * 时装段与装备段共用这一份，避免两处各写一遍漏掉 hpRecover（#590 新增的属性）。
 */
function toBattleAttributes(attributes: ConfigAttributes): BattleAttributes {
  return {
    maxHp: attributes.maxHp,
    hpRecover: attributes.hpRecover ?? 0,
    physicalAttack: toAttributeRange(attributes.physicalAttack),
    magicAttack: toAttributeRange(attributes.magicAttack),
    taoistAttack: toAttributeRange(attributes.taoistAttack),
    physicalDefense: toAttributeRange(attributes.physicalDefense),
    magicDefense: toAttributeRange(attributes.magicDefense),
    taoistDefense: toAttributeRange(attributes.taoistDefense),
  };
}

/**
 * 装备行（服务端快照）→ 客户端基础件条目（`EquipmentData`）
 *
 * **为什么这层转换放在这里而不是 `configs/equipments`**：`equipments.ts` 处在
 * 「生成器要在 Node 垫片里加载 `configs/items` 这条链」上（见 `tools/lib/configs-sandbox.cjs`），
 * 一旦它 import `ui/utils/net/ApiModels` 就把整个网络层拖进去了。行格式（DTO）只在
 * 网络这一侧出现，转换就留在网络这一侧。
 *
 * `outManual` / `inManual` **不从行里取**：它们是工作台（`equip_aligns` / `equip_in_aligns`）
 * 运行时覆盖出来的语义，出厂值一律 false（= 没手调过），否则一只「外观对齐」工作台
 * 调过的衣服会把全服玩家的武器内观都钉死在某个数字上。
 */
function rowToEquipmentData(row: EquipmentRow): EquipmentData {
  const attributes = toBattleAttributes(row.attributes);
  return {
    key: row.id,
    type: GOOD_TYPE.EQUIPMENT,
    label: row.label,
    description: row.description,
    sellPirce: row.sellPrice,
    level: row.level,
    slot: row.slot as EquipmentData["slot"],
    occupation: row.occupation as EquipmentData["occupation"],
    sex: row.sex as EquipmentData["sex"],
    icon: row.icon,
    in: row.inAtlas,
    out: row.outAtlas,
    tags: row.tags,
    inPosition: new Vec2(row.inPosX, row.inPosY),
    inScaleX: row.inScaleX,
    inScaleY: row.inScaleY,
    inRotate: row.inRotate,
    outScale: row.outScale,
    outPositions: (row.outPositions ?? []).map((point) => new Vec2(point.x, point.y)),
    ...attributes,
  };
}

/**
 * 装载装备（#603 第九域：整表重建）
 *
 * 服务端下发**基础件**（37 件）+ 全部显示字段，`applyEquipmentData` 按「前缀 × 后缀」
 * 展开成 555 条变体并按部位分表。物品总表（`items`）不在这里逐条写 —— 由
 * `applyContentSnapshot` 末尾的 `rebuildItemIndex()` 一次性重建（#603 第十域）,
 * 顺序「装备 → 药品 → 材料」只有那一处实现。
 */
export function applyEquipments(rows: EquipmentRow[]): void {
  applyEquipmentData(rows.map(rowToEquipmentData));
}

/**
 * 覆写药品（#603 第十域：**整表重建**）
 *
 * 客户端 `configs/drug` 已经没有出厂行了（数据在服务端 `item-seed.ts` → `drugs` 表），
 * 所以这里是「清空再按快照填」而不是「按 id 覆写已有行」—— 管理端下架一种药,
 * 客户端就该少一种（留着旧行会让它变成捡不起来、用不掉的幽灵物品）。
 *
 * 效果值的还原（四段拍平 → effects 数组）在 `configs/drug.toDrugEffects` 里,
 * 与 `resolveDrugRecovery` 的累加口径一致，这里只做直传。
 */
export function applyDrugRows(rows: DrugRow[]): void {
  applyDrugData(rows);
}

/**
 * 覆写物品与材料（#603 第十域：**整表重建**）
 *
 * 与药品同款：客户端 `configs/material` 只剩空数组，这里按快照清空重建。
 * 只收 MATERIAL / OTHER 大类（装备与药品各有自己的段与表）—— 快照的 `items` 段
 * 按表内容下发，不会混进装备行。
 */
export function applyItemRows(rows: ItemRow[]): void {
  applyItemBaseData(rows);
}

/**
 * 怪物数值落表（#588：**不再覆写本地副本** —— 客户端 configs/monster 没有怪物数据了）
 *
 * 数值唯一来源是服务端 monsters 表，快照整段写入 configs/monsterRuntime 的运行时数值表；
 * 消费点（MonsterManager / 血条 / 名牌 / 地图预览 / 任务文案）从那里取。
 * 表里没有的 key 不落行 —— 缺行的退化口径（名字 = key、攻防 [0,0]）由 monsterRuntime 统一给。
 */
export function applyMonsterRows(rows: MonsterRow[]): void {
  rows.forEach((row) => {
    const range = (source: { min: number; max: number }): [number, number] => [source.min, source.max];
    applyMonsterRuntimeStats(row.id, {
      label: row.label,
      level: row.level,
      tier: (row.tier ?? "normal") as MonsterRuntimeStats["tier"],
      maxHp: row.maxHp,
      physicalAttack: range(row.attributes.physicalAttack),
      magicAttack: range(row.attributes.magicAttack),
      taoistAttack: range(row.attributes.taoistAttack),
      physicalDefense: range(row.attributes.physicalDefense),
      magicDefense: range(row.attributes.magicDefense),
      taoistDefense: range(row.attributes.taoistDefense),
    });
  });
}

/**
 * 怪物资源与表现落表（#588 新增）：快照 monsterPresentations 段 → 运行时资源表。
 * 与数值一一对应（同一份 key 清单，服务端生成器双向对账过）；speedRate 覆盖在这里
 * 与客户端默认表合成（见 monsterRuntime.applyMonsterPresentation）。
 */
export function applyMonsterPresentations(rows: MonsterPresentationRow[]): void {
  rows.forEach((row) => applyMonsterPresentation(row.id, row));
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
 * 时装装载（#257 / #603 第十二域）
 *
 * #603 起客户端**没有任何时装出厂行**（`configs/fashionClothes` 只剩空数组 + 取源规则），
 * 所以这里一律整表重建：快照里有什么就是什么。
 *
 * **icon / in / out 也来自快照**（与地图那套相反）：时装 id 与资源目录编号之间没有可推导的
 * 约定（cloth_13 甚至没有内观图），路径只能入库跟着行走。属性全 0 时也要照写
 * （运营可能就是把加成清零）。
 */
export function applyFashionRows(rows: FashionRow[]): void {
  applyFashionData(rows);
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
 * 技能配置装载（#367 / #372 / #603）
 *
 * #603 第十一域起客户端**没有任何技能出厂行**（`configs/skill-data` 只剩空数组 + 派生规则），
 * 所以这里一律整表重建：快照里有什么就是什么，角色技能与怪物技能同表（`owner` 区分）。
 *
 * **不动 onClick**：技能释放实现是代码（configs/skill 按 id 接上），数据只描述
 * 「冷却 / 倍率 / 动作 / 特效 / 释放限制 / 职业归属 / 击退」。重建后必须调 `rebuildSkills()`
 * （见 ConfigLoader），否则 `skills` Map 里还是旧对象 —— 消费方读的是 Map，不是这个数组。
 */
export function applySkillRows(rows: SkillRow[]): void {
  applySkillData(rows);
}

/**
 * 状态配置装载（#367 / #372 / #603）
 *
 * 覆写的是**注册表本身**（`statuses` 这个 Map 的元素内容），所以已经在身上生效的状态
 * 时长与图标也会跟着变（`StatusManager` 只记到期时间戳，读的仍是这份配置）。
 *
 * #603 起客户端 `configs/status` 里**没有任何状态数据**（只剩一张空 Map），所以
 * 这里对**所有**未登记的行一律写入（不再区分 owner）—— 角色状态与怪物状态同表，
 * 快照就是唯一来源。角色技能的 `casts` 帧只带 statusId，查不到配置就表现不出来，
 * 所以缺行必须补而不是忽略。
 */
export function applyStatusRows(rows: StatusRow[]): void {
  for (const row of rows) {
    const next = statusRowToConfig(row);
    const config = statuses.get(row.id);
    if (!config) {
      statuses.set(row.id, next);
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
  if (snapshot.equipments) applyEquipments(snapshot.equipments);
  if (snapshot.drugs) applyDrugRows(snapshot.drugs);
  if (snapshot.items) applyItemRows(snapshot.items);
  // #603 第十域：三张物品表都落完，再一次性重建「id → 物品」总表 ——
  // 放在这里而不是各自 apply 里，是因为顺序（装备 → 药品 → 材料）只该有一处实现
  rebuildItemIndex();
  if (snapshot.monsters) applyMonsterRows(snapshot.monsters);
  // #588：怪物资源与表现（icon / out / 几何 / 移动 / AI 参数）—— 客户端没有本地怪物数据文件
  if (snapshot.monsterPresentations) applyMonsterPresentations(snapshot.monsterPresentations);
  if (snapshot.npcs) applyNpcRows(snapshot.npcs);
  if (snapshot.quests) applyQuestRows(snapshot.quests);
  if (snapshot.fashions) applyFashionRows(snapshot.fashions);
}

//#endregion

/** 快照总入口：逐表覆写；某表缺失（undefined）时跳过该表，保留本地兜底 */
export function applyConfigSnapshot(snapshot: GameConfigSnapshot): void {
  // #603：战斗力权重（客户端不再存倍率，唯一来源是服务端 combat-seed）
  applyCombatWeights(snapshot.combatWeights);
  // #603 第九域：装备规则**必须最先装** —— 它决定「每件基础件展开成几档变体」
  // （倍率为空 = 一件都展开不出来）与「回收价怎么算」。顺序反了装备表整个是空的
  if (snapshot.equipmentMeta) {
    applyEquipmentRules(snapshot.equipmentMeta.prefixRates, snapshot.equipmentMeta.suffixRates, snapshot.equipmentMeta.recycleCurve);
    applyEquipmentQualityLabels(snapshot.equipmentMeta.prefixLabels, snapshot.equipmentMeta.suffixLabels);
  }
  if (snapshot.equipmentSlots) applyEquipmentSlots(snapshot.equipmentSlots);
  if (snapshot.titles) applyTitleRows(snapshot.titles);
  if (snapshot.souls) applySoulRows(snapshot.souls);
  if (snapshot.ranks) applyRankRows(snapshot.ranks);
  if (snapshot.mallPrices && snapshot.mallSettings) {
    applyMallPrices(snapshot.mallPrices, snapshot.mallSettings.defaultPrice);
  }
  applyGrowthSnapshot(snapshot);
  applyContentSnapshot(snapshot);
  applySkillSnapshot(snapshot);
  if (snapshot.maps) applyMapRows(snapshot.maps, snapshot.mapTypes ?? []);
  if (snapshot.uiEffects) applyUiEffectRows(snapshot.uiEffects);
}

//#region 地图玩法配置（#573）

/**
 * 覆写地图玩法配置（#573）
 *
 * 客户端以前把 11 张图的名称 / 类型 / 进入条件写死在 `configs/map.ts` 的 `mapData` 里 ——
 * 改一个进入等级要重打整个客户端包。现在这些值由服务端 `maps` 表下发（管理端可改），
 * 这里按 id 填进运行时表，消费方（传送弹窗 / 小地图 / 进图判定）读的引用不变。
 *
 * 三条口径：
 * - **整表重建**（先 clear 再按行填）：地图行由服务端决定，客户端没有「本地兜底行」可言。
 *   留着旧行会让「服务端没有这张图」在客户端变成幽灵按钮（点开就是黑屏）。
 * - **资源路径不在这里**（`mapSrcOf` 按 `resources/map/<id>/<id>` 拼）：下发方永远改不到
 *   「客户端加载哪张图」—— 与这个文件开头那条「资源路径一律不覆写」完全一致。
 * - **类型分组一并替换**：类型码 → 文案的唯一来源在服务端，客户端的 `mapTypeGroups`
 *   只是它的容器（以前这里也存着一份，改一次文案要改两个仓库里的同一个意思）。
 */
export function applyMapRows(rows: MapConfigRow[], groups: MapTypeGroupRow[]): void {
  maps.clear();
  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    maps.set(row.id, {
      label: String(row.label ?? ""),
      type: String(row.type ?? ""),
      typeLabel: String(row.typeLabel ?? row.type ?? ""),
      level: Number(row.level) || 0,
      combat: Number(row.combat) || 0,
      soulOfWar: Number(row.soulOfWar) || 0,
    });
  }
  mapTypeGroups.length = 0;
  for (const group of groups) {
    if (!group || typeof group.type !== "string") continue;
    mapTypeGroups.push({ type: group.type, label: String(group.label ?? group.type) });
  }
}

//#endregion

//#region 界面特效表现参数（#594）

/**
 * 覆写界面特效的表现参数（#594）
 *
 * 特效的摆位 / 缩放 / 旋转 / 时长 / 开关以前写死在 `GameUiHelper.createUpgradeEffect` 里 ——
 * 调一次摆位要重打 3G 的客户端包。现在这些值由服务端 `ui_effects` 表下发（管理端「特效管理」
 * 可改，与武器外观同一套取向），这里按 key 填进运行时表，消费方读 `upgradeEffectConfig()`。
 *
 * 三条口径：
 * - **整表重建**（先 clear 再按行填）：特效行由服务端 seed 决定，客户端没有「本地兜底行」可言；
 * - **图集路径不在这里**（`effect/<key>/<key>.plist` 两端约定）：下发方永远改不到
 *   「客户端加载哪张图」—— 与这个文件开头那条「资源路径一律不覆写」完全一致；
 * - **坏行整条跳过**：缺 key / 数值不是数的行直接丢，宁可用出厂值演，不演一半错位的。
 */
export function applyUiEffectRows(rows: UiEffectConfig[]): void {
  uiEffects.clear();
  for (const row of rows ?? []) {
    if (!row || typeof row.key !== "string" || !row.key) continue;
    const numeric = (value: unknown): number | null => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const offsetX = numeric(row.offsetX);
    const offsetY = numeric(row.offsetY);
    const scaleX = numeric(row.scaleX);
    const scaleY = numeric(row.scaleY);
    const rotate = numeric(row.rotate);
    const durationMs = numeric(row.durationMs);
    if (offsetX === null || offsetY === null || scaleX === null || scaleY === null || rotate === null || durationMs === null) continue;
    uiEffects.set(row.key, {
      key: row.key,
      offsetX,
      offsetY,
      scaleX,
      scaleY,
      rotate,
      durationMs,
      enabled: row.enabled === true,
    });
  }
}

//#endregion

//#region 装备外观几何（#513）

/**
 * 覆写装备外观几何（#513）
 *
 * 与这个文件里其它所有覆写不同，这一条**故意打破**开头那条「几何一律不覆写」的纪律 ——
 * 管理端「装备对齐」工作台产出的就是几何，不下发它，页面上调完就只能靠重新打 3G 的包生效，
 * 「保存 → 刷新客户端即见」这件事根本不成立。打破面严格限制在
 * 「外观缩放 + 8 方向位置 + 位置语义」三样：资源路径（icon / in / out）**仍然一个都不动**。
 *
 * 四条口径：
 * - **按 id 对齐、缺省不动**：列表里没有的目标保留客户端配置值 ——
 *   所以服务端「重置」的实现就是删行，不需要存一份默认值副本；
 * - **衣服 / 武器按基础件命中全部变体**：工作台调的是 `cloth_1`，穿在身上的是 `cloth_1_p3s2`
 *   （`buildEquipmentMap` 从同一份条目浅拷贝出 15 个变体）。只覆盖基础件会让
 *   「背包里预览对了、穿上身还是歪」，而且这种 bug 看起来像素材问题；
 *   注意浅拷贝只共享 `outPositions` **数组引用**，`outScale` / `outManual` 是各变体自己的，
 *   所以这里必须逐变体赋值（原地推坐标才会自动传到别的变体，但那样没有回落基线可用）；
 * - **裸模按性别**：`role:1` → 男、`role:2` → 女。改的是 `roleDefaultCloths` 里的对象本身
 *   （引用不变），`RoleAppearance.play` 每次按方向现读，不需要额外通知；
 * - **每次覆写前先还原出厂值**（`resetEquipAlignRows`）：进游戏是可以重进的，
 *   不还原的话「管理端把某件重置了」在重进之后仍然显示上次覆写的值 ——
 *   删行与「从没调过」必须长得一模一样，否则重置按钮只在刷新页面时才生效。
 *
 * 失败方式也有讲究：**逐条 try**，一条坏数据只丢一条（形态不对的行直接跳过），
 * 不让整份对齐表因为某个 id 拼错而全部失效 —— 那会让所有调好的衣服武器一起回到默认位置。
 */
export function applyEquipAlignRows(rows: EquipAlign[]): void {
  resetEquipAlignRows();
  if (!rows) return;
  for (const row of rows) applyEquipAlignRow(row);
}

/** 被覆写过的目标的**出厂几何**（改之前的值），「重置」与「重进游戏重拉」都靠它回落 */
const alignBaselines: Array<{ target: OutTransform; outScale: number; outPositions: Vec2[]; outManual: boolean }> = [];

/** 记下目标的出厂值（只记第一次 —— 之后再记记到的就是上次覆写的结果了） */
function rememberBaseline(target: OutTransform): void {
  // 变体的几何是各自的对象（`{ ...base }` 只共享 outPositions 数组），所以要按引用逐个记
  if (alignBaselines.some((entry) => entry.target === target)) return;
  alignBaselines.push({
    target,
    outScale: target.outScale,
    // 深拷贝：覆写是整份换掉 outPositions，但以后若有人改成就地写，浅拷贝的基线会跟着一起变
    outPositions: (target.outPositions ?? []).map((point) => new Vec2(point.x, point.y)),
    outManual: target.outManual === true,
  });
}

/** 把覆写过的目标全部还原成客户端配置里的值，并清空基线（下次覆写重新记录） */
export function resetEquipAlignRows(): void {
  for (const entry of alignBaselines) {
    entry.target.outScale = entry.outScale;
    entry.target.outPositions = entry.outPositions.map((point) => new Vec2(point.x, point.y));
    entry.target.outManual = entry.outManual;
  }
  alignBaselines.length = 0;
}

function applyEquipAlignRow(row: EquipAlign): void {
  if (!row || typeof row.id !== "string") return;
  if (row.id === "role:1" || row.id === "role:2") {
    const cloth = roleDefaultCloths.get(row.id === "role:2" ? SEX.GRIL : SEX.BOY);
    if (cloth) applyOutGeometry(cloth, row);
    return;
  }
  // 服务端只校验 id 形态、不校验存在性（装备清单在客户端配置里），所以这里对形态再兜一层
  const separator = row.id.indexOf(":");
  if (separator <= 0) return;
  const baseKey = row.id.slice(separator + 1);
  items.forEach((good, id) => {
    if (good.type !== GOOD_TYPE.EQUIPMENT) return;
    if (getEquipmentBaseKey(id) !== baseKey) return;
    applyOutGeometry(good, row);
  });
}

/** 把一条对齐几何写到目标上（外观缩放 + 8 方向位置 + 位置语义） */
function applyOutGeometry(target: OutTransform, row: EquipAlign): void {
  rememberBaseline(target);
  target.outScale = row.outScale > 0 ? row.outScale : 1;
  target.outPositions = row.outPositions.map((point) => new Vec2(point.x, point.y));
  target.outManual = row.outManual;
}

//#endregion

//#region 装备内观几何（#523）

/** 内观可覆写的字段（`Equipment` 与「时装借装备几何」那条路都满足） */
interface InTransform {
  inScaleX?: number;
  inScaleY?: number;
  inPosition: Vec2;
  /** 武器的位置语义：true = 下面这三个字段就是最终值，false/缺省 = 运行时按当前衣服现算 */
  inManual?: boolean;
}

/**
 * 覆写装备内观几何（#523）
 *
 * 内观 = 角色信息弹窗里站在圆盘上的那套（衣服 + 武器）。它是 `apply-snapshot` 的第二处、
 * 也是最后一处「覆写几何」的例外（第一处是外观，见上面的 `applyEquipAlignRows`）：
 * 工作台里对着圆盘调好的位置，如果不下发，就只能靠重新打包才生效。
 *
 * 三条口径与外观一致：
 * - **按 id 对齐、缺省不动** → 服务端「重置」就是删行；
 * - **按基础件命中全部变体**：工作台调 `cloth_1`，玩家身上可能是 `cloth_1_p3s2`
 *   （`buildEquipmentMap` 的浅拷贝只共享数组引用，`inScaleX` / `inScaleY` / `inPosition`
 *   是各自的原语与对象 → 必须逐变体赋值）；
 * - **每次覆写前先还原出厂值**（`resetEquipInAlignRows`）：不还原的话，管理端删了行，
 *   重进游戏仍显示上次的位置 —— 「删行」与「从没调过」必须长得一模一样。
 *
 * 失败方式同样是**逐条 try**：一条坏 id 只丢它自己，不让整张表失效
 * （否则所有调好的衣服武器会一起回到出厂位置，看起来像「保存全没了」）。
 */
export function applyEquipInAlignRows(rows: EquipInAlign[]): void {
  resetEquipInAlignRows();
  if (!rows) return;
  for (const row of rows) applyEquipInAlignRow(row);
}

/** 被覆写过的目标的出厂内观几何（「重置」与「重进游戏重拉」都靠它回落） */
const inAlignBaselines: Array<{
  target: InTransform;
  inScaleX: number;
  inScaleY: number;
  inPosition: Vec2;
  inManual: boolean;
}> = [];

function rememberInBaseline(target: InTransform): void {
  if (inAlignBaselines.some((entry) => entry.target === target)) return;
  const position = target.inPosition ?? new Vec2();
  inAlignBaselines.push({
    target,
    inScaleX: target.inScaleX ?? 1,
    inScaleY: target.inScaleY ?? 1,
    // 深拷贝：覆写是整份换掉 inPosition，但基线不能共享同一个 Vec2 引用
    inPosition: new Vec2(position.x, position.y),
    inManual: target.inManual === true,
  });
}

/** 把覆写过的目标全部还原成客户端配置里的值，并清空基线（下次覆写重新记录） */
export function resetEquipInAlignRows(): void {
  for (const entry of inAlignBaselines) {
    entry.target.inScaleX = entry.inScaleX;
    entry.target.inScaleY = entry.inScaleY;
    entry.target.inPosition = new Vec2(entry.inPosition.x, entry.inPosition.y);
    entry.target.inManual = entry.inManual;
  }
  inAlignBaselines.length = 0;
}

function applyEquipInAlignRow(row: EquipInAlign): void {
  if (!row || typeof row.id !== "string") return;
  // 服务端只校验 id 形态（`cloth:*` / `weapon:*`），这里对形态再兜一层
  const separator = row.id.indexOf(":");
  if (separator <= 0) return;
  const baseKey = row.id.slice(separator + 1);
  items.forEach((good, id) => {
    if (good.type !== GOOD_TYPE.EQUIPMENT) return;
    if (getEquipmentBaseKey(id) !== baseKey) return;
    applyInGeometry(good, row);
  });
}

/** 把一条内观几何写到目标上（两轴缩放 + 位置 + 手调开关） */
function applyInGeometry(target: InTransform, row: EquipInAlign): void {
  rememberInBaseline(target);
  // 0 / 负数缩放在客户端等于「这个节点消失」，所以坏值一律回 1
  target.inScaleX = row.inScaleX > 0 ? row.inScaleX : 1;
  target.inScaleY = row.inScaleY > 0 ? row.inScaleY : 1;
  target.inPosition = new Vec2(row.inPosition.x, row.inPosition.y);
  target.inManual = row.inManual === true;
}

//#endregion
