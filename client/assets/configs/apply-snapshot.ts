import { Vec2 } from "cc";
import type {
  ConfigAttributes,
  Equipment as EquipmentRow,
  EquipAlign,
  EquipInAlign,
  GameConfigSnapshot,
  GrowthScalar,
  MallPriceItem,
} from "../ui/utils/net/ApiModels";
import type { BattleAttributes } from "../types/common";
import { GOOD_TYPE } from "../types/good";
import type { EquipmentData, OutTransform } from "../types/good";
// 快照的「表 + 每段落库」都在 configs/game-config（#626 合并），这里只做编排
import {
  applyAudioRows,
  applyCombatWeights,
  applyDrugRows,
  applyEquipmentRules,
  applyFashionRows,
  applyItemRows,
  applyLevelRows,
  applyMallPricing,
  applyMapRows,
  applyMonsterPresentations,
  applyMonsterRows,
  applyNpcRows,
  applyQuestRows,
  applyRankRows,
  applySkillRows,
  applySoulRows,
  applyStatusRows,
  applyTitleRows,
  applyUiEffectRows,
  checkSnapshotContract,
  setRoleMaxLevel,
  snapshotContractMessage,
} from "./game-config";
import { items, rebuildItemIndex } from "./items";
import { applyEquipmentData, applyEquipmentQualityLabels, applyEquipmentSlots, getEquipmentBaseKey } from "./equipments";
import { roleDefaultCloths, setMpRecoverPerSecond } from "./role";
import { applyDropRuntime } from "./drop";
import { applyGuideSteps } from "./guide";
import { applyEquipmentAppearance } from "./border";
import { applyEquipmentDetailBackgrounds } from "./background";
import { applyAutoBattleParams } from "./autoBattle";
import { SEX } from "../types/role";

/**
 * 服务端配置快照落库（#294 / #361 / #363 / #590）
 *
 * 进游戏时拉到 `gameConfig.snapshot` 后，把管理端可改的字段**原地覆写**进本地
 * 配置数据（称号 / 战魂 / 军衔 / 等级表 / 商城定价 / 装备 / 药品 / 物品 /
 * 怪物 / NPC / 时装 / 技能 / 状态）—— 消费方拿到的引用不变、读取函数签名不变，
 * 所以弹窗 / 战力计算 / 名牌外显 / 背包 / 图鉴零改动即读新值。
 *
 * #590 起称号 / 战魂 / 军衔 / 等级表是**整表重建**（与地图 #573 同款）：
 * 客户端没有本地数据兜底行（书写处是数据库，出厂那份 = `server/data/config-sync.sql`），
 * 快照里没有的阶 / 级客户端就不存在 —— 「管理端删了一行」会如实反映。
 *
 * ## #604 起是**显式契约**，不再有「缺段跳过」
 * 这个文件里没有任何 `if (snapshot.x)`：段在不在由 `configs/snapshot-contract` 判，
 * `applyConfigSnapshot` 第一句就校验，缺段 / 形状不对直接**抛错**（不静默跳过、不回落本地）。
 * 理由：客户端那几份出厂表随 #603 逐域退场后，「回落」等于回落到空表 ——
 * 一个空着却看不出来的游戏比一个炸得响的错误难查得多。`ConfigLoader` 接住这个错，
 * 把玩家挡在 Loading 界面并给出明确文案 + 重试。
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
 * 覆写成长标量参数（#361；#590 起客户端只消费 roleMaxLevel；#605 起加上魔法回复速度）
 *
 * 键名是管理端的接口契约（`GROWTH_SCALAR_SPECS`）。属性 / 经验 / 回血全在 `levels` 段逐级给好，
 * 标量里没有任何「换算比率」—— 这里只保留**客户端也要用**的那两个，未知键直接忽略
 * （服务端新增参数时旧客户端照常玩）。
 */
export function applyGrowthScalars(rows: GrowthScalar[]): void {
  rows.forEach((row) => {
    switch (row.key) {
      case "roleMaxLevel":
        setRoleMaxLevel(row.value);
        return;
      case "mpRecoverPerSecond":
        setMpRecoverPerSecond(row.value);
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
  applyGrowthScalars(snapshot.growthScalars);
  applyLevelRows(snapshot.levels);
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
  // #655：快照发的是展开后的变体行，行自带前后缀序号与最终回收价 ——
  // 客户端不再乘倍率（sentinel 见 buildEquipmentMap 的两条路径判定）
  const variant = row as EquipmentRow & { prefix?: number; suffix?: number };
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
    prefix: variant.prefix as EquipmentData["prefix"],
    suffix: variant.suffix as EquipmentData["suffix"],
    recyclePrice: row.sellPrice,
    ...attributes,
  };
}

/**
 * 装载装备（#603 第九域：整表重建；#655：快照发的是 555 个变体，不再在客户端展开）
 *
 * 服务端下发**展开后的变体**（37 基础件 × 5 前缀 × 3 后缀 = 555）+ 全部显示字段，
 * `applyEquipmentData` 直接按部位分表。物品总表（`items`）不在这里逐条写 —— 由
 * `applyContentSnapshot` 末尾的 `rebuildItemIndex()` 一次性重建（#603 第十域）,
 * 顺序「装备 → 药品 → 材料」只有那一处实现。
 */
export function applyEquipments(rows: EquipmentRow[]): void {
  applyEquipmentData(rows.map(rowToEquipmentData));
}

/** 技能与状态的覆写总入口（#367）：角色与怪物同表，一起覆写；两段都是契约必填 */
export function applySkillSnapshot(snapshot: GameConfigSnapshot): void {
  applySkillRows(snapshot.skills);
  applyStatusRows(snapshot.statuses);
}

/** 内容表的覆写总入口（#363）：逐段整表重建；段的存在性由契约保证（#604） */
export function applyContentSnapshot(snapshot: GameConfigSnapshot): void {
  applyEquipments(snapshot.equipments);
  applyDrugRows(snapshot.drugs);
  applyItemRows(snapshot.items);
  // #603 第十域：三张物品表都落完，再一次性重建「id → 物品」总表 ——
  // 放在这里而不是各自 apply 里，是因为顺序（装备 → 药品 → 材料）只该有一处实现
  rebuildItemIndex();
  applyMonsterRows(snapshot.monsters);
  // #588：怪物资源与表现（icon / out / 几何 / 移动 / AI 参数）—— 客户端没有本地怪物数据文件
  applyMonsterPresentations(snapshot.monsterPresentations);
  applyNpcRows(snapshot.npcs);
  applyQuestRows(snapshot.quests);
  applyFashionRows(snapshot.fashions);
}

//#endregion

/**
 * 快照总入口（#294 / #604）
 *
 * 第一句校验契约：缺段 / 形状不对直接抛，**不再有「某表缺失就跳过」的分支**。
 * 这是 #604 的全部要点 —— 快照是唯一数据来源，它不完整就是服务端的 bug，
 * 应该在登录时炸响，而不是让客户端拿着半份数据演一个看似正常的游戏。
 *
 * 顺序有两处讲究（改顺序会静默毁数据）：
 * - 装备规则必须最先装：倍率决定每件基础件展开成几档变体，晚了装备表整个是空的；
 * - `rebuildItemIndex()` 在 `applyContentSnapshot` 末尾（三张物品表都落完之后）。
 */
export function applyConfigSnapshot(snapshot: GameConfigSnapshot): void {
  const problems = checkSnapshotContract(snapshot);
  if (problems.length > 0) {
    throw new Error(`配置快照不符合契约：${snapshotContractMessage(problems)}`);
  }
  // #603：战斗力权重（客户端不再存倍率，唯一来源是服务端 combat-seed）
  applyCombatWeights(snapshot.combatWeights);
  // #603 第九域：装备规则**必须最先装** —— 它决定「每件基础件展开成几档变体」
  // （倍率为空 = 一件都展开不出来）。顺序反了装备表整个是空的。
  // #655：回收价不在这里 —— 变体行的 `recyclePrice` 自己带价（见 equipments.ts 路径 1）
  applyEquipmentRules(snapshot.equipmentMeta.prefixRates, snapshot.equipmentMeta.suffixRates);
  applyEquipmentQualityLabels(
    snapshot.equipmentMeta.prefixLabels,
    snapshot.equipmentMeta.suffixLabels,
    snapshot.equipmentMeta.prefixColors,
    snapshot.equipmentMeta.suffixColors,
  );
  applyEquipmentSlots(snapshot.equipmentSlots);
  applyTitleRows(snapshot.titles);
  applySoulRows(snapshot.souls);
  applyRankRows(snapshot.ranks);
  applyMallPrices(snapshot.mallPrices, snapshot.mallSettings.defaultPrice);
  applyGrowthSnapshot(snapshot);
  applyContentSnapshot(snapshot);
  applySkillSnapshot(snapshot);
  applyMapRows(snapshot.maps, snapshot.mapTypes);
  applyUiEffectRows(snapshot.uiEffects);
  applyRuntimeParams(snapshot.runtimeParams);
  // #683：音效（文件路径 / 音量 / 循环 / 开关）—— 唯一由服务端覆写的资源路径，见 game-config 区 21
  applyAudioRows(snapshot.audio);
  // #605：新手引导步骤（表在服务端，客户端只留表现层）
  applyGuideSteps(snapshot.guideSteps);
  // #695：装备外观（哪个前后缀组合 / 哪件特殊装备用哪个边框、详情背景；资源清单仍在客户端）
  applyEquipmentAppearance(snapshot.equipmentAppearance);
  applyEquipmentDetailBackgrounds(snapshot.equipmentAppearance);
}

/**
 * 覆写运行时参数（#605）：掉落手感 + 自动战斗与寻路
 *
 * 这两组原本写死在客户端 `configs/drop.ts` / `configs/autoBattle.ts` 里，运营改不了；
 * 现在服务端存一份（`config-sync.sql` → `runtime_params` 表 → 管理端可改），
 * 进游戏拉一次快照就覆写到本地参数对象上。
 *
 * **覆写是「改字段」不是「换对象」**：消费方（DropManager / AutoBattle / DropScatter）
 * 持有的是同一个对象的引用，换对象等于把改动写在空气里。
 * `guild` 那组客户端目前不消费（帮会校验在服务端判，客户端只显示服务端返回的提示），
 * 所以这里不接 —— 契约照样要求它下发（少发说明 `snapshot()` 被动过）。
 */
export function applyRuntimeParams(params: GameConfigSnapshot["runtimeParams"]): void {
  if (!params) return;
  applyDropRuntime(params.drop);
  applyAutoBattleParams(params.autoBattle);
}

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
