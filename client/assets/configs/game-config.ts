import { Color, Size, Vec2, Vec3 } from "cc";
import type { BattleAttributes, LevelConfig } from "../types/common";
import type { TitleAcquireChannel, TitleAttributes, TitleLevelConfig } from "../types/title";
import type { SoulAttributes, SoulLevelConfig } from "../types/soul";
import type { RankAttributes, RankLevelConfig } from "../types/rank";
import type { StatusConfig, StatusId, StatusSource } from "../types/status";
import type { Drug, DrugEffect, Goods, Material } from "../types/good";
import { GOOD_TYPE } from "../types/good";
import type { MapConfig, MapId, NpcData } from "../types/map";
import { OECCUPATION } from "../types/role";
import type { SpeedRate } from "../types/animation";
import { ACTION } from "../types/animation";
import type { DamageCoefficient, SkillData, SkillId } from "../types/skill";
import { SkillTargetType, SkillType } from "../types/skill";
import type { MonsterPresentation, MonsterRuntimeStats } from "../types/monster";
import type {
  AudioConfig as AudioConfigRow,
  Drug as DrugRow,
  Fashion as FashionRow,
  GameConfigSnapshot,
  Item as ItemRow,
  Level as LevelRow,
  MapConfig as MapConfigRow,
  MapTypeGroup as MapTypeGroupRow,
  Monster as MonsterRow,
  MonsterPresentation as MonsterPresentationRow,
  Npc as NpcRow,
  Quest as QuestRow,
  Rank as RankRow,
  Skill as SkillRow,
  Soul as SoulRow,
  Status as StatusRow,
  Title as TitleRow,
  UiEffectConfig,
} from "../ui/utils/net/ApiModels";

/**
 * 服务端配置快照的**客户端一半**（#626 合并；原 21 个文件）
 *
 * ## 这个文件是什么
 * 管理端能改的一切 —— 称号 / 战魂 / 军衔 / 等级 / 战斗力权重 / 装备规则 / 状态 / 药品 /
 * 材料 / NPC / 任务 / 技能 / 时装 / 怪物 / 商城定价 / 地图 / 界面特效 —— 在客户端的
 * **运行时表 + 落库方法 + 读取函数 + 契约**，全部住在这里，按 `//#region` 分域。
 *
 * 为什么合成一个文件（#626）：#603 把出厂数据逐域搬到服务端之后，每个域只剩
 * 「一张空表 + 一个 `apply*` + 一两个读取函数」，平均 80 行 —— 改一个快照段要在
 * 二十个文件之间跳，而这些文件之间除了「同属一份快照」没有任何内聚关系。
 * **它们本来就是一份数据的 21 段**，分散只是 #603 之前的历史形态。
 *
 * ## 依赖纪律（三条，违反任何一条都会静默出问题）
 * 1. **只许引** `cc` 的四个纯数据类（Vec2 / Vec3 / Size / Color）、`../types/*`、
 *    以及 `../ui/utils/net/ApiModels` 的**类型**（`import type`，编译期擦除）。
 *    本文件处在客户端单测的 Node 垫片链上（`client/tools/lib/configs-sandbox.cjs`
 *    只实现这四个类的构造函数），引一个 UI 组件或引擎行为，整条配置层单测就加载不起来。
 * 2. **不许反向 import** `items` / `equipments` / `skill` / `apply-snapshot`。
 *    依赖方向永远是 `apply-snapshot → game-config → types`：`items` 要读药品 / 材料表、
 *    `equipments` 要读装备规则与战斗力权重，反过来引就成环。
 *    （`getMallGoods` 因此住在 `configs/equipments` —— 它读七个部位表。）
 * 3. **加载期这些表都是空的**（唯一书写处是数据库，出厂那份 = `server/data/config-sync.sql`）。
 *    填充只有一条路：`Loading` 场景 `await loadGameConfig()` → 契约校验 →
 *    `applyConfigSnapshot`（见 `configs/apply-snapshot`）。**没有本地兜底数据**。
 *
 * ## 三条落库口径（每个 `apply*` 都遵守）
 * - **整表重建**：先 clear 再按行填。快照里没有的行客户端就不该有 —— 管理端删一条，
 *   客户端少一条；「按 id 覆写已有行」会让删掉的行变成捡不起来、用不掉的幽灵。
 * - **行对象是新建的**：所以派生 Map（`quests` / `items` / `skills`）必须跟着重建，
 *   否则表换了一批、映射还指着旧对象。
 * - **不覆写资源路径与几何**（唯一例外是装备外观 / 内观几何，见 `apply-snapshot`）：
 *   让服务端下发路径就能把客户端指到一张不存在的图上。
 *
 * ## 分区索引（本文件内按 region 编号；`audit-world-authority` 等守点按编号取区）
 * | # | 区 | 快照段 | 落库方法 |
 * |---|---|---|---|
 * | 0 | 契约 | —（客户端自己的要求） | `checkSnapshotContract` |
 * | 1 | 称号 | `titles` | `applyTitleRows` |
 * | 2 | 战魂 | `souls` | `applySoulRows` |
 * | 3 | 军衔 | `ranks` | `applyRankRows` |
 * | 4 | 等级 | `levels` | `applyLevelRows` |
 * | 5 | 战斗力权重 | `combatWeights` | `applyCombatWeights` |
 * | 6 | 装备规则与成长 | `equipmentMeta` / `growthScalars` | `applyEquipmentRules` |
 * | 7 | 状态 | `statuses` | `applyStatusRows` |
 * | 8 | 药品 | `drugs` | `applyDrugRows` → `applyDrugData` |
 * | 9 | 材料与其它物品 | `items` | `applyItemRows` → `applyItemBaseData` |
 * | 10 | NPC | `npcs` | `applyNpcRows` |
 * | 11 | 任务数据 | `quests` | `applyQuestRows` |
 * | 12 | 任务注册表 | —（11 区派生） | `rebuildQuests` |
 * | 13 | 技能数据 | `skills` | `applySkillRows` → `applySkillData` |
 * | 14 | 时装 | `fashions` | `applyFashionRows` → `applyFashionData` |
 * | 15 | 怪物手感参数 | —（**客户端手感**，`monsterAI` 与生成物同源） | —（常量） |
 * | 16 | 怪物运行时表 | `monsters` / `monsterPresentations` | `applyMonsterRows` / `applyMonsterPresentations` |
 * | 17 | 商城定价 | `mallPrices` / `mallSettings` | `applyMallPricing` |
 * | 18 | 地图 | `maps` / `mapTypes` | `applyMapRows` |
 * | 19 | 界面特效（升级特效 + 掉落光效） | `uiEffects` | `applyUiEffectRows` |
 * | 20 | 装备几何锚点 | `equip-align` / `equip-in-align`（另两个接口） | `applyEquipAlignRows`（在 apply-snapshot） |
 * | 21 | 音效 | `audio` | `applyAudioRows` |
 * | 22 | 装备边框与详情背景 | `equipmentAppearance` | `applyEquipmentAppearance` / `applyEquipmentDetailBackgrounds`（在 configs/border + configs/background） |
 *
 * 守点：`tools/audit-snapshot-contract.cjs` —— 分区 0 的清单 == 服务端 `GameConfigSnapshotDto`
 * == `client-config.service.snapshot()` 实际下发的键。加一段配置要三处一起改。
 */
//#region 0 · 契约：段清单与校验（原 configs/snapshot-contract.ts）

/**
 * 配置快照的**显式契约**（#604）
 *
 * ## 为什么要有这个文件
 *
 * #294 时代快照的每一段都是「可选」的：`if (snapshot.skills) {...}` 缺段静默跳过，
 * 客户端继续用内置出厂表。那是**容错设计** —— 代价是客户端里活着一份影子数据：
 * 平时被快照盖住，快照缺段 / 缺行时悄悄顶上，表现为「运营在管理端改了，游戏里没变」，
 * 而且日志里一个字都没有。
 *
 * #603 把出厂数据的书写处逐域搬到服务端之后，客户端那几份影子数据**已经退场**：
 * `configs/` 里相应表是空的，回落 = 回落到空表 = 一个空着却看不出来的游戏。
 * 所以这里改成**显式契约**：段必须存在、形状必须正确，缺了就当场抛错。
 *
 * 判据的分界线（很重要，别把两者混起来）：
 * - **契约破坏**（段缺失 / 不是数组 / 关键段空表）→ 服务端代码有 bug，应该炸在 CI 或登录时，
 *   而不是被客户端兜住 —— 所以这里报错，`ConfigLoader` 把玩家挡在 Loading 界面并给重试；
 * - **合法数据状态**（运营把某张表清空 / 下架全部药品）→ 不是契约问题，`minRows` 只给
 *   那些「空 = 客户端立刻算不出来」的段（等级表、槽位表）留着。
 *
 * ## 与哪些地方联动（改这里的清单要一起过一遍）
 * - `tools/audit-snapshot-contract.cjs`：本清单 == 服务端 `GameConfigSnapshotDto` 的字段
 *   == `client-config.service.snapshot()` 实际返回的键。**这条是「服务端少发一段」的守点**。
 * - `configs/apply-snapshot.ts`：`applyConfigSnapshot` 第一句就调 `checkSnapshotContract`，
 *   校验不过直接抛 —— 所以函数体里不再有「缺段跳过」的分支。
 * - `ui/utils/net/ConfigLoader.ts`：把失败分成 network / contract 两类，都**不置「已加载」**，
 *   下次进图重试（一次抖动不该永久退化成空表）。
 */

/** 段形状：数组表 / 单值对象 */
export type SnapshotSectionKind = "array" | "object";

/** 契约里的一段 */
export interface SnapshotSectionSpec {
  /** 快照字段名（= 服务端 DTO 属性名 = `apply*` 消费的键） */
  key: keyof GameConfigSnapshot;
  /** 中文名（报错时给人看，别让玩家对着 `monsterPresentations` 猜） */
  label: string;
  /** 数组表还是单值对象 */
  kind: SnapshotSectionKind;
  /** 至少几行/几个键（缺省 0 = 允许空表）。**只给「空 = 客户端立刻算不出来」的段** */
  minRows?: number;
}

/**
 * 契约清单（**唯一书写处**）
 *
 * 顺序与 `server/src/modules/game-config/client-config.service.ts` 的返回顺序一致，
 * 便于两边对读；`tools/audit-snapshot-contract.cjs` 按下面的字面量形式解析，
 * 加段时保持「一段一行、key/label/kind 按此顺序」。
 */
export const SNAPSHOT_SECTIONS: SnapshotSectionSpec[] = [
  { key: "titles", label: "称号配置", kind: "array" },
  { key: "souls", label: "战魂配置", kind: "array" },
  { key: "ranks", label: "军衔配置", kind: "array" },
  { key: "equipments", label: "装备基础件", kind: "array" },
  { key: "drugs", label: "药品配置", kind: "array" },
  { key: "items", label: "物品与材料", kind: "array" },
  { key: "monsters", label: "怪物基础数据", kind: "array" },
  { key: "monsterPresentations", label: "怪物资源与表现", kind: "array" },
  { key: "npcs", label: "NPC 数据", kind: "array" },
  { key: "fashions", label: "时装配置", kind: "array" },
  { key: "levels", label: "等级表", kind: "array", minRows: 1 },
  { key: "growthScalars", label: "成长标量", kind: "array" },
  { key: "combatWeights", label: "战斗力权重", kind: "object" },
  { key: "mallPrices", label: "商城定价", kind: "array" },
  { key: "mallSettings", label: "商城统一价", kind: "object" },
  // 下面三段客户端**不消费**（掉落结算在服务端、成就进度走 /achievements/me），
  // 但照样列进契约：它们少发说明 `snapshot()` 的 return 被人动过 ——
  // 那是「所有段都可能缺」的早期信号，比事后追某一段为什么没到便宜得多。
  { key: "dropTables", label: "具名掉落表", kind: "array" },
  { key: "monsterDrops", label: "每怪掉落配置", kind: "array" },
  { key: "skills", label: "技能配置", kind: "array" },
  { key: "statuses", label: "状态配置", kind: "array" },
  { key: "quests", label: "任务配置", kind: "array" },
  { key: "achievements", label: "成就配置", kind: "array" },
  { key: "maps", label: "地图玩法配置", kind: "array" },
  { key: "mapTypes", label: "地图类型分组", kind: "array" },
  { key: "uiEffects", label: "界面特效参数", kind: "array" },
  { key: "equipmentSlots", label: "装备槽位表", kind: "array", minRows: 1 },
  { key: "equipmentMeta", label: "装备规则", kind: "object" },
  { key: "runtimeParams", label: "运行时参数", kind: "object" },
  { key: "guideSteps", label: "新手引导步骤", kind: "array" },
  { key: "audio", label: "音效配置", kind: "array" },
  { key: "equipmentAppearance", label: "装备边框与详情背景", kind: "object" },
];

/** 一处契约问题（key + 中文名 + 原因，直接拼进日志与界面） */
export interface SnapshotProblem {
  key: string;
  label: string;
  reason: string;
}

/**
 * 校验快照是否符合契约，返回**全部**问题（空数组 = 通过）
 *
 * 一次列全而不是遇到第一个就抛：服务端漏发往往是「某次改动把 return 里几行一起删了」，
 * 只报第一条会让人改一轮跑一轮。
 */
export function checkSnapshotContract(snapshot: unknown): SnapshotProblem[] {
  const problems: SnapshotProblem[] = [];
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return [{ key: "snapshot", label: "配置快照", reason: `不是一个对象（拿到的是 ${describeValue(snapshot)}）` }];
  }
  const source = snapshot as Record<string, unknown>;
  for (const spec of SNAPSHOT_SECTIONS) {
    const raw = source[spec.key as string];
    if (raw === undefined || raw === null) {
      problems.push({ key: spec.key as string, label: spec.label, reason: "整段缺失" });
      continue;
    }
    if (spec.kind === "array") {
      if (!Array.isArray(raw)) {
        problems.push({ key: spec.key as string, label: spec.label, reason: `应该是数组，拿到的是 ${describeValue(raw)}` });
        continue;
      }
      if (spec.minRows && raw.length < spec.minRows) {
        problems.push({ key: spec.key as string, label: spec.label, reason: `至少要有 ${spec.minRows} 行，实际 ${raw.length} 行` });
      }
      continue;
    }
    if (Array.isArray(raw) || typeof raw !== "object") {
      problems.push({ key: spec.key as string, label: spec.label, reason: `应该是对象，拿到的是 ${describeValue(raw)}` });
      continue;
    }
    // 单值对象目前只有三段，各自的形状要求写在这里（比泛型写法好读）
    if (spec.key === "equipmentMeta") collectEquipmentMetaProblems(raw as Record<string, unknown>, problems);
    if (spec.key === "mallSettings") {
      if (typeof (raw as Record<string, unknown>).defaultPrice !== "number") {
        problems.push({ key: "mallSettings", label: spec.label, reason: "缺少 defaultPrice（统一价），商城会算不出价" });
      }
    }
    if (spec.key === "equipmentAppearance") collectEquipmentAppearanceProblems(raw as Record<string, unknown>, problems);
  }
  return problems;
}

/**
 * 装备规则的形状检查（#603 第九域踩过的坑）
 *
 * 倍率数组是**展开档数**的依据：空了客户端一件变体都展开不出来，装备表整个是空的，
 * 而且不报错 —— 正是「必须由契约拦住」的那一类。文案数组必须与倍率同长，
 * 否则某一档的品质名会取到 undefined（背包里显示成空字符串）。
 */
function collectEquipmentMetaProblems(meta: Record<string, unknown>, problems: SnapshotProblem[]): void {
  const pairs: Array<[string, string]> = [
    ["prefixRates", "prefixLabels"],
    ["suffixRates", "suffixLabels"],
  ];
  for (const [ratesKey, labelsKey] of pairs) {
    const rates = meta[ratesKey] as unknown;
    const labels = meta[labelsKey] as unknown;
    if (!Array.isArray(rates) || rates.length === 0) {
      problems.push({ key: "equipmentMeta", label: "装备规则", reason: `${ratesKey} 为空（倍率决定展开档数，空了一件变体都出不来）` });
      continue;
    }
    // 落库时 <= 0 的倍率会被 filter 掉（见 growth.applyEquipmentRules）——
    // 全 0 的倍率数组在契约层看着「有值」，落完却仍是空表，属于同一类静默失败
    if (rates.some((rate) => typeof rate !== "number" || !(rate > 0))) {
      problems.push({ key: "equipmentMeta", label: "装备规则", reason: `${ratesKey} 里有非正数（落库时会被滤掉，变成空倍率）` });
      continue;
    }
    if (!Array.isArray(labels) || labels.length !== rates.length) {
      problems.push({
        key: "equipmentMeta",
        label: "装备规则",
        reason: `${labelsKey} 与 ${ratesKey} 长度不一致（${Array.isArray(labels) ? labels.length : "非数组"} vs ${rates.length}）`,
      });
    }
  }
  // 文字颜色（#720）：可空（= 内置色）；给了就得与文案等长，否则多出来的档会渲染成内置兜底色
  for (const [colorsKey, labelsKey] of [["prefixColors", "prefixLabels"], ["suffixColors", "suffixLabels"]] as const) {
    const colors = meta[colorsKey] as unknown;
    if (colors === undefined || colors === null) continue; // 老快照没这一段，回落内置
    const labels = meta[labelsKey];
    if (Array.isArray(colors) && colors.length > 0 && Array.isArray(labels) && colors.length !== labels.length) {
      problems.push({
        key: "equipmentMeta",
        label: "装备规则",
        reason: `${colorsKey}（${colors.length} 项）与 ${labelsKey}（${labels.length} 项）长度不一致 —— 颜色要与文案同下标`,
      });
    }
  }
}

/**
 * 装备外观的形状检查（#695）
 *
 * 四组映射数组必须在：`borders` / `backgrounds` 是前后缀组合表（缺了对应品质整个没光效），
 * `customBorders` / `customBackgrounds` 是自定义表（允许为空）。条目级的合法性
 * （key 格式 / 组合覆盖度）由服务端 DTO 保证，客户端 apply 层还会再卡一遍 ——
 * 这里只拦「整段形状不对」的服务端 bug。
 */
function collectEquipmentAppearanceProblems(appearance: Record<string, unknown>, problems: SnapshotProblem[]): void {
  const pairs: Array<[string, string]> = [
    ["borders", "边框映射"],
    ["backgrounds", "详情背景映射"],
    ["customBorders", "边框自定义表"],
    ["customBackgrounds", "详情背景自定义表"],
  ];
  for (const [key, label] of pairs) {
    if (!Array.isArray(appearance[key])) {
      problems.push({ key: "equipmentAppearance", label: "装备边框与详情背景", reason: `${key} 不是数组（${label}没法重建）` });
    }
  }
}

/** 值的人话描述（报错用：区分 undefined / null / 字符串 / 数字） */
function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `数组(${value.length})`;
  return typeof value;
}

/**
 * 把问题拼成一行行可读文本（日志与界面共用同一份措辞）
 *
 * 每行形如 `缺少「技能配置」（skills）：整段缺失` —— 报错里带 key 与中文名两样，
 * 服务端开发按 key 找代码、运营 / 玩家按中文名知道是哪块内容。
 */
export function snapshotContractMessage(problems: SnapshotProblem[]): string {
  if (problems.length === 0) return "";
  return problems
    .map((problem) => `${problem.reason === "整段缺失" ? "缺少" : "异常"}「${problem.label}」（${problem.key}）：${problem.reason}`)
    .join("；");
}
//#endregion

//#region 1 · 称号（原 configs/title.ts）

/**
 * 称号运行时表（#590 起客户端**零本地数据**）
 *
 * 数据唯一来源是服务端 `titles` 表（书写处 = `server/data/config-sync.sql`，
 * 管理端可改），进游戏时随快照 `titles` 段整表下发 —— 这里只剩运行时容器与取值函数，
 * 不再有任何称号数据或派生公式（等效等级映射搬去了服务端种子）。
 *
 * 口径与怪物（#588）、地图（#573）一致：
 * - **整表重建**（先清空再按行填，数组引用不变）：快照里没有的阶就是服务端没有的阶，
 *   留着本地旧行会让「管理端删了一阶」在客户端变成幽灵卡片；
 * - **快照先于预载必到**（`Loading` 场景里 `loadGameConfig()` 在 `PreloadManager` 之前，#604），
 *   称号弹窗 / 头顶名牌 / 预加载全部在进游戏后才读这张表，空表窗口玩家看不到。
 */

/**
 * 升级链的一步（**三条成长线共用**：称号 / 战魂 / 军衔）
 *
 * - `next`   → 链上的下一档（升级按钮、价格预检、下一级增量都按它走）
 * - `maxed`  → 已在链尾（真的没有下一档了）
 * - `locked` → 当前档不在链上（运营把玩家已有的称号切出了 upgrade 渠道，或把这一档从链上删了）
 * - `closed` → 链本身是空的（运营一档都没开放）
 *
 * 这四种必须分开，别为了少写一个分支把它们并成「不能升了」：
 * 满级是玩家的进度、断链是运营改了配置、未开放是功能还没上线 —— 玩家看到的提示完全不同。
 * 服务端同一口径见 `roles.service.resolveGrowthTarget`（GROWTH_CHANNEL_LOCKED / 链尾 null）。
 */
export type GrowthStep<T> =
  | { kind: "next"; config: T }
  | { kind: "maxed" }
  | { kind: "locked" }
  | { kind: "closed" };

/**
 * 在一条升级链上找当前档的下一步
 *
 * `chain` 必须**已经按运营配置的顺序排好**（调用方传 `titleUpgradeChain` /
 * `soulUpgradeChain` / `rankLevels`）。`current = 0` 表示还没开始（返回链首）；
 * 当前档在链上找不到 = 断链（locked），不是满级；链为空 = 未开放（closed）。
 */
export function growthStepOf<T extends { level: number }>(chain: readonly T[], current: number): GrowthStep<T> {
  if (chain.length === 0) return { kind: "closed" };
  if (current <= 0) return { kind: "next", config: chain[0] };
  const index = chain.findIndex((config) => config.level === current);
  if (index < 0) return { kind: "locked" };
  const next = chain[index + 1];
  return next ? { kind: "next", config: next } : { kind: "maxed" };
}

/** 称号等级序列（level 从 1 开始连续；快照到达前为空表） */
export const titleLevels: TitleLevelConfig[] = [];

/**
 * 称号升级链（**只含 `acquireChannel === "upgrade"` 的行**，按 `upgradeOrder` 升序）
 *
 * 判据只看渠道（与服务端 `listUpgrade` 同口径）；链序缺失的行排最前（= SQLite NULL 在前）。
 * 与 `titleLevels` 一样整表重建、数组引用不变（消费方存的引用不会失效）。
 * 称号弹窗的左列表、升级按钮、「下一级增量」全部按这条链走 ——
 * **运营没放出的等级不会出现在弹窗里**（以前是全量 34 阶都画出来，
 * 玩家会看到一串点不动的空档，与后台配置对不上）。
 *
 * 管理端口径：称号列表里把渠道改成「称号升级」→ 服务端分配链尾序号 → 这里多一行；
 * 在「称号成长列表」里拖动 → 这里顺序跟着变；改价 → `bindGold` 跟着变（同一个快照）。
 */
export const titleUpgradeChain: TitleLevelConfig[] = [];

/** 从 titleLevels 重建升级链（applyTitleRows 末尾调用；**不要**在别处 push，链只能由表派生） */
function rebuildTitleUpgradeChain(): void {
  titleUpgradeChain.length = 0;
  for (const config of titleLevels) {
    // 判据只看渠道，与服务端 `title.repository.listUpgrade`（`WHERE acquire_channel = 'upgrade'`）保持同一口径：
    // 客户端多一条「必须有 upgradeOrder」会让手工改库 / 老数据在后台看得见、游戏里却没有
    if (config.acquireChannel !== "upgrade") continue;
    titleUpgradeChain.push(config);
  }
  // 链序缺失的行排最前（SQLite 的 `ORDER BY upgrade_order ASC` 也是 NULL 在前）—— 两端顺序一致
  titleUpgradeChain.sort((a, b) => (a.upgradeOrder ?? -1) - (b.upgradeOrder ?? -1));
}

/**
 * 快照 `titles` 段 → 运行时表（**整表重建**；消费方拿到的 `titleLevels` 引用不变）
 *
 * 快照行属性是 {min,max} 区间对象，这里转回客户端一直用的元组 `[min, max]`。
 */
export function applyTitleRows(rows: TitleRow[]): void {
  titleLevels.length = 0;
  for (const row of rows) {
    if (!row || typeof row.level !== "number") continue;
    const range = (source: { min: number; max: number }): [number, number] => [source.min, source.max];
    titleLevels.push({
      level: row.level,
      label: String(row.label ?? ""),
      description: String(row.description ?? ""),
      bindGold: Number(row.bindGold) || 0,
      animation: String(row.animation ?? ""),
      animationFrameRate: Number(row.animationFrameRate) || 10,
      // 渠道与链序原样保留：链的可见范围与顺序都由运营在管理端决定，客户端不做二次判断
      acquireChannel: (row.acquireChannel ?? "unavailable") as TitleAcquireChannel,
      upgradeOrder: typeof row.upgradeOrder === "number" ? row.upgradeOrder : null,
      attributes: {
        maxHp: Number(row.attributes?.maxHp) || 0,
        hpRecover: Number(row.attributes?.hpRecover) || 0,
        physicalAttack: range(row.attributes?.physicalAttack ?? { min: 0, max: 0 }),
        magicAttack: range(row.attributes?.magicAttack ?? { min: 0, max: 0 }),
        taoistAttack: range(row.attributes?.taoistAttack ?? { min: 0, max: 0 }),
        physicalDefense: range(row.attributes?.physicalDefense ?? { min: 0, max: 0 }),
        magicDefense: range(row.attributes?.magicDefense ?? { min: 0, max: 0 }),
        taoistDefense: range(row.attributes?.taoistDefense ?? { min: 0, max: 0 }),
      } satisfies TitleAttributes,
    });
  }
  titleLevels.sort((a, b) => a.level - b.level);
  rebuildTitleUpgradeChain();
}

/**
 * 称号表内的最大阶号（快照到达前为 0）
 *
 * **不是升级链的上限**：链可能只开放了其中几阶（见 `titleUpgradeChain`），
 * 「还能不能升级」一律问 `nextTitleUpgrade(role.title).kind`。
 */
export function titleMaxLevel(): number {
  return titleLevels.length;
}

/**
 * 称号属性列表的显示名与顺序（称号弹窗右侧面板，与战魂同一套短名）
 * 数组即顺序，key 为 TitleAttributes 的字段名
 */
export const titleAttributeLabels: { key: keyof TitleAttributes; label: string }[] = [
  { key: "maxHp", label: "生命" },
  { key: "physicalAttack", label: "物攻" },
  { key: "magicAttack", label: "魔攻" },
  { key: "taoistAttack", label: "道攻" },
  { key: "physicalDefense", label: "物防" },
  { key: "magicDefense", label: "魔防" },
  { key: "taoistDefense", label: "道防" },
  { key: "hpRecover", label: "回血" },
];

/**
 * 取某等级的称号配置
 * @param level 称号等级（0 或负数返回 null，表示尚未激活称号；快照未到时也返回 null）
 */
export function getTitleLevel(level: number): TitleLevelConfig | null {
  if (level < 1) return null;
  return titleLevels.find((config) => config.level === level) ?? null;
}

/**
 * 称号的下一步：链上下一档 / 已到链尾 / 断链
 *
 * 弹窗、价格预检、服务端请求的 `targetLevel` 全部走这里 ——
 * **不要写 `role.title + 1`**：等级号与链序解耦，运营拖过顺序或没放出中间等级时，
 * `level + 1` 会指向一个不在链上的等级，服务端会以「目标阶位不合法」拒绝。
 */
export function nextTitleUpgrade(current: number): GrowthStep<TitleLevelConfig> {
  return growthStepOf(titleUpgradeChain, current);
}
//#endregion

//#region 2 · 战魂（原 configs/soul.ts）

/**
 * 战魂运行时表（#590 起客户端**零本地数据**）
 *
 * 数据唯一来源是服务端 `souls` 表（书写处 = `server/data/config-sync.sql`，
 * 逐级明文表在服务端；管理端可改），进游戏时随快照 `souls` 段整表下发。
 * 这里只剩运行时容器与取值函数，不再有任何战魂数据。
 *
 * 口径与称号（#590）一致：整表重建、快照先于预载必到、空表窗口玩家看不到。
 */

/** 战魂等级序列（level 从 1 开始连续；快照到达前为空表） */
export const soulLevels: SoulLevelConfig[] = [];

/**
 * 战魂升级链（37 阶全量，按 `upgradeOrder` 升序）
 *
 * 战魂没有「获得渠道」概念，每一阶都在链上；但运营在管理端「战魂成长列表」里
 * **可以拖动排序** —— 所以链序 ≠ 阶数。弹窗列表、升级按钮、下一阶增量都按这条链走。
 * 与 `soulLevels` 一样整表重建、数组引用不变。
 */
export const soulUpgradeChain: SoulLevelConfig[] = [];

/** 从 soulLevels 重建升级链（applySoulRows 末尾调用；链只能由表派生） */
function rebuildSoulUpgradeChain(): void {
  soulUpgradeChain.length = 0;
  for (const config of soulLevels) soulUpgradeChain.push(config);
  soulUpgradeChain.sort((a, b) => a.upgradeOrder - b.upgradeOrder);
}

/**
 * 快照 `souls` 段 → 运行时表（**整表重建**；消费方拿到的 `soulLevels` 引用不变）
 */
export function applySoulRows(rows: SoulRow[]): void {
  soulLevels.length = 0;
  for (const row of rows) {
    if (!row || typeof row.level !== "number") continue;
    const range = (source: { min: number; max: number }): [number, number] => [source.min, source.max];
    soulLevels.push({
      level: row.level,
      label: String(row.label ?? ""),
      description: String(row.description ?? ""),
      bindGold: Number(row.bindGold) || 0,
      animation: String(row.animation ?? ""),
      animationFrameRate: Number(row.animationFrameRate) || 10,
      // 链序原样保留（战魂无渠道概念，全量都在链上，但顺序由运营拖）
      upgradeOrder: Number(row.upgradeOrder) || row.level,
      attributes: {
        maxHp: Number(row.attributes?.maxHp) || 0,
        hpRecover: Number(row.attributes?.hpRecover) || 0,
        physicalAttack: range(row.attributes?.physicalAttack ?? { min: 0, max: 0 }),
        magicAttack: range(row.attributes?.magicAttack ?? { min: 0, max: 0 }),
        taoistAttack: range(row.attributes?.taoistAttack ?? { min: 0, max: 0 }),
        physicalDefense: range(row.attributes?.physicalDefense ?? { min: 0, max: 0 }),
        magicDefense: range(row.attributes?.magicDefense ?? { min: 0, max: 0 }),
        taoistDefense: range(row.attributes?.taoistDefense ?? { min: 0, max: 0 }),
      } satisfies SoulAttributes,
    });
  }
  soulLevels.sort((a, b) => a.level - b.level);
  rebuildSoulUpgradeChain();
}

/** 战魂表内的最大阶数（快照到达前为 0；「还能不能升」问 nextSoulUpgrade） */
export function soulMaxLevel(): number {
  return soulLevels.length;
}

/**
 * 战魂属性列表的显示名与顺序（战魂弹窗右侧面板）
 * 用短名（生命/物攻…）：面板窄，且与角色信息弹窗的属性列表（configs/good.goodShowAttributesLabel 全名）互不干扰
 */
export const soulAttributeLabels: { key: keyof SoulAttributes; label: string }[] = [
  { key: "maxHp", label: "生命" },
  { key: "physicalAttack", label: "物攻" },
  { key: "magicAttack", label: "魔攻" },
  { key: "taoistAttack", label: "道攻" },
  { key: "physicalDefense", label: "物防" },
  { key: "magicDefense", label: "魔防" },
  { key: "taoistDefense", label: "道防" },
  { key: "hpRecover", label: "回血" },
];

/**
 * 取某等级的战魂配置
 * @param level 战魂等级（0 或负数返回 null，表示尚未激活战魂；快照未到时也返回 null）
 */
export function getSoulLevel(level: number): SoulLevelConfig | null {
  if (level < 1) return null;
  return soulLevels.find((config) => config.level === level) ?? null;
}

/**
 * 战魂的下一步：链上下一阶 / 已到链尾 / 断链（断链 = 当前阶被运营从链上挪走了）
 *
 * 与称号同一口径，**不要写 `role.soulOfWar + 1`**。
 */
export function nextSoulUpgrade(current: number): GrowthStep<SoulLevelConfig> {
  return growthStepOf(soulUpgradeChain, current);
}
//#endregion

//#region 3 · 军衔（原 configs/rank.ts）

/**
 * 军衔运行时表（#590 起客户端**零本地数据**）
 *
 * 数据唯一来源是服务端 `ranks` 表（书写处 = `server/data/config-sync.sql`，
 * 10 大段 × 10 阶与等效等级插值公式都在服务端；管理端可改文案与价格），
 * 进游戏时随快照 `ranks` 段整表下发（含 `tier` 大段名）。
 * 这里只剩运行时容器与取值函数，不再有任何军衔数据或插值公式。
 *
 * 口径与称号 / 战魂（#590）一致：整表重建、快照先于预载必到、空表窗口玩家看不到。
 */

/** 军衔阶数序列（level 从 1 连续到 100；快照到达前为空表） */
export const rankLevels: RankLevelConfig[] = [];

/**
 * 快照 `ranks` 段 → 运行时表（**整表重建**；消费方拿到的 `rankLevels` 引用不变）
 */
export function applyRankRows(rows: RankRow[]): void {
  rankLevels.length = 0;
  for (const row of rows) {
    if (!row || typeof row.level !== "number") continue;
    const range = (source: { min: number; max: number }): [number, number] => [source.min, source.max];
    rankLevels.push({
      level: row.level,
      label: String(row.label ?? ""),
      tier: String(row.tier ?? ""),
      description: String(row.description ?? ""),
      bindGold: Number(row.bindGold) || 0,
      attributes: {
        maxHp: Number(row.attributes?.maxHp) || 0,
        hpRecover: Number(row.attributes?.hpRecover) || 0,
        physicalAttack: range(row.attributes?.physicalAttack ?? { min: 0, max: 0 }),
        magicAttack: range(row.attributes?.magicAttack ?? { min: 0, max: 0 }),
        taoistAttack: range(row.attributes?.taoistAttack ?? { min: 0, max: 0 }),
        physicalDefense: range(row.attributes?.physicalDefense ?? { min: 0, max: 0 }),
        magicDefense: range(row.attributes?.magicDefense ?? { min: 0, max: 0 }),
        taoistDefense: range(row.attributes?.taoistDefense ?? { min: 0, max: 0 }),
      } satisfies RankAttributes,
    });
  }
  rankLevels.sort((a, b) => a.level - b.level);
}

/** 军衔表内的最大阶数（快照到达前为 0；「还能不能进」问 nextRankUpgrade） */
export function rankMaxLevel(): number {
  return rankLevels.length;
}

/**
 * 军衔属性列表的显示名与顺序（军衔弹窗右侧面板，与战魂/称号同一套短名）
 * 数组即顺序，key 为 RankAttributes 的字段名
 */
export const rankAttributeLabels: { key: keyof RankAttributes; label: string }[] = [
  { key: "maxHp", label: "生命" },
  { key: "physicalAttack", label: "物攻" },
  { key: "magicAttack", label: "魔攻" },
  { key: "taoistAttack", label: "道攻" },
  { key: "physicalDefense", label: "物防" },
  { key: "magicDefense", label: "魔防" },
  { key: "taoistDefense", label: "道防" },
  { key: "hpRecover", label: "回血" },
];

/**
 * 取某阶的军衔配置
 * @param level 军衔阶数（0 或负数返回 null，表示尚未授衔；快照未到时也返回 null）
 */
export function getRankLevel(level: number): RankLevelConfig | null {
  if (level < 1) return null;
  return rankLevels.find((config) => config.level === level) ?? null;
}

/**
 * 军衔的下一步：下一阶 / 已到链尾 / 断链
 *
 * 军衔**没有** `upgradeOrder`（100 阶天然按阶就是链，管理端也不让拖动），
 * 但走同一个三态口径 —— 三条成长线的调用形态保持一致，以后再加一条线不用另起一套。
 */
export function nextRankUpgrade(current: number): GrowthStep<RankLevelConfig> {
  return growthStepOf(rankLevels, current);
}
//#endregion

//#region 4 · 等级（原 configs/level.ts）

/**
 * 等级运行时表（#590 起客户端**零本地数据**）
 *
 * 数据唯一来源是服务端快照 `levels` 段（#590 新增）：每级的裸属性由服务端
 * `growth-seed` 按曲线当场展开，升级经验取 `level_exps` 表（管理端可改的最终权威）。
 * 客户端不再派生（曲线 / 标量 / 经验公式已全部随 #590 移出客户端）。
 *
 * 口径与称号 / 战魂 / 军衔（#590）一致：
 * - **整表重建**（先 clear 再按行填，`levelMap` 引用不变）——快照没有的等级客户端就没有，
 *   「管理端把上限调小」后多出来的等级会自动消失；
 * - **快照先于预载必到**（`Loading` 场景里 `loadGameConfig()` 在 `PreloadManager` 之前，#604），
 *   `levelMap` 的消费方（`entities/Role`、经验条）全部在进游戏后才读它。
 */

/** 等级配置map（1 ~ roleMaxLevel；快照到达前为空表） */
export const levelMap = new Map<number, LevelConfig>();

/**
 * 快照 `levels` 段 → 运行时表（**整表重建**；消费方拿到的 `levelMap` 引用不变）
 *
 * 快照行属性是 {min,max} 区间对象，这里转回客户端一直用的元组 `[min, max]`。
 */
export function applyLevelRows(rows: LevelRow[]): void {
  levelMap.clear();
  for (const row of rows) {
    if (!row || typeof row.level !== "number") continue;
    const range = (source: { min: number; max: number }): [number, number] => [source.min, source.max];
    levelMap.set(row.level, {
      exp: Number(row.exp) || 1,
      maxHp: Number(row.maxHp) || 0,
      maxMp: Number(row.maxMp) || 0,
      hpRecover: Number(row.hpRecover) || 0,
      physicalAttack: range(row.physicalAttack ?? { min: 0, max: 0 }),
      magicAttack: range(row.magicAttack ?? { min: 0, max: 0 }),
      taoistAttack: range(row.taoistAttack ?? { min: 0, max: 0 }),
      physicalDefense: range(row.physicalDefense ?? { min: 0, max: 0 }),
      magicDefense: range(row.magicDefense ?? { min: 0, max: 0 }),
      taoistDefense: range(row.taoistDefense ?? { min: 0, max: 0 }),
    });
  }
}

// 计算当前等级经验进度0-1
export function getCurrentLevelExpRate(level: number, exp: number): number {
  return exp / levelMap.get(level).exp;
}
//#endregion

//#region 5 · 战斗力权重（原 configs/battle.ts）

/**
 * 战斗力权重（#603 起**客户端不再存数值**）
 *
 * 唯一书写处是服务端 `server/data/config-sync.sql`：服务端用它算角色战斗力
 * （`modules/combat/role-attributes.ts`），客户端只用它算「这件装备是不是更好」
 * （`configs/equipments.equipmentCombatValue`）。进游戏拉配置快照时，
 * `configs/apply-snapshot` 用快照的 `combatWeights` 段把这张表填满。
 *
 * 表为空时 `equipmentCombatValue` 返回 0 → 「更好装备」提示会把所有候选判成不更好
 * （不崩，但等于该功能失效），所以表缺行属配置问题，不该再在本地兜底一份倍率。
 *
 * 计入战斗力的属性：hpRecover（每秒回血）**不算** —— 战斗力是地图准入的门槛
 * （地图区的 `combat`），而回血是持续回复、不改变输出与承伤上限；
 * 算进来会凭空抬高所有地图的门槛。
 */
export type CombatCalcAttribute = Exclude<keyof BattleAttributes, "hpRecover">;

/** 战斗力计算权重（属性名 → 倍率；区间型属性取上下限之和）—— 数值由快照 `combatWeights` 填 */
export const combatCalc = new Map<CombatCalcAttribute, number>();

/**
 * 用快照下发的权重整表重建（`configs/apply-snapshot` 调用）
 *
 * **先 clear 再填**：权重表由服务端决定，客户端没有「本地兜底行」可言 ——
 * 留着旧行会让「运营删掉某个权重」在客户端变成幽灵倍率。
 */
export function applyCombatWeights(weights: Record<string, number> | undefined): void {
  combatCalc.clear();
  if (!weights) return;
  // 用 for..in 而不是 Object.entries：客户端 tsconfig 的 lib 不含 ES2017，
  // 且打包器（babel loose）对 entries 这类新 API 不做垫片（`[...map.values()]` 同理，见 mall.ts 的教训）
  for (const key in weights) {
    if (!Object.prototype.hasOwnProperty.call(weights, key)) continue;
    const weight = Number(weights[key]);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    combatCalc.set(key as CombatCalcAttribute, weight);
  }
}
//#endregion

//#region 6 · 装备规则与成长（原 configs/growth.ts）
/**
 * 成长底座（#603 第九域起只剩「运行时表 + 取样函数」）
 *
 * 这个文件历史上换过两次主人：
 * - #361 时代它是全角色数值的唯一来源（曲线 / 标量 / 属性派生全手写在客户端）；
 * - #590 起曲线、标量、等级表、三条成长线搬去服务端，客户端只剩「装备前后缀倍率 +
 *   回收价曲线 + roleMaxLevel」三样常量；
 * - **#603 起连那三样也不在客户端了**：唯一书写处是 `server/data/config-sync.sql`，进游戏由配置快照下发。
 * - **#655 起回收价曲线也下架**：每件变体的 `recyclePrice` 是 `equipment_variants` 行里的一列
 *   （服务端 `sellPriceOf` 读同一列）。本文件只剩「倍率 + 品质文案 + roleMaxLevel」三样运行时值，
 *   加一段只给工具链用的装备展开。
 *
 * 所以这里**一个数字都不许再写**：想调倍率 / 回收价 / 等级上限，改库（管理端）。
 */

/**
 * 角色等级上限（**可变**：快照 growthScalars 的 roleMaxLevel 覆写）
 *
 * 用 `let` 而不是 getter，是为了让消费方的 `if (role.level >= roleMaxLevel)` 这类写法一行都不用改。
 * #590 起等级表本身由快照 `levels` 段整表下发，这里的值只影响「读表的边界判断」；
 * 快照没到时保持出厂值 60，进游戏后即被服务端值覆盖。
 */
export let roleMaxLevel = 60;

/**
 * 改等级上限（**唯一写入口**）
 *
 * ESM 的导入绑定是只读的，`apply-snapshot` 不能直接给 `roleMaxLevel` 赋值 ——
 * 收一个函数在这里，写入点就还是「只有 growth.ts 自己能改这个数」。
 */
export function setRoleMaxLevel(level: number): void {
  roleMaxLevel = Math.max(1, Math.floor(level));
}

/**
 * 装备前缀属性倍率（下标 = EQUIPMENT_PREFIX 序号）
 *
 * **空数组 = 快照还没到**：此时 `buildEquipmentMap` 展开不出任何变体（装备表整个是空的）。
 * 正常路径上 `Loading` 场景的 `loadGameConfig()` 在进场景前 await 过（#604 起拿不到就不让进图），玩家看不到空表。
 */
export let equipmentPrefixRates: number[] = [];

/** 装备后缀属性倍率（下标 = EQUIPMENT_SUFFIX 序号）；空数组的含义同上 */
export let equipmentSuffixRates: number[] = [];

/**
 * 装载装备规则（`configs/apply-snapshot` 调；快照 `equipmentMeta` 段）
 *
 * 只收正数倍率（≤ 0 或非数字会让变体属性变成 0 或负数，比「没升级」更糟）。
 * **回收价不在这里**：每件变体的 `recyclePrice` 在 `equipment_variants` 行里逐条写好了
 * （#655，服务端 `sellPriceOf` 读的也是那一列），客户端不再有「按等级取曲线价」这条路。
 */
export function applyEquipmentRules(prefixRates: number[], suffixRates: number[]): void {
  equipmentPrefixRates = (prefixRates || []).map((rate) => Number(rate)).filter((rate) => Number.isFinite(rate) && rate > 0);
  equipmentSuffixRates = (suffixRates || []).map((rate) => Number(rate)).filter((rate) => Number.isFinite(rate) && rate > 0);
}
//#endregion

//#region 7 · 状态（原 configs/status.ts）

/**
 * 状态运行时表（#603 起客户端**不存任何状态数据**）
 *
 * 状态表（名称 / 图标 / 时长 / 来源 / 特效 / 战斗数值）的唯一书写处是服务端
 * `server/data/config-sync.sql`：出厂值 seed 进 statuses 表 → 管理端可改 →
 * 随 `GET /game-config` 快照的 `statuses` 段下发，由 `apply-snapshot.applyStatusRows`
 * 灌进这张表（角色与怪物同表，owner 由服务端行带下来）。
 *
 * 用法不变：消费方（StatusManager / BattleMath / HoverTipManager / MonsterManager）
 * 照旧 `statuses.get(id)`。快照到达前表是空的 —— 与怪物数据同一口径
 * （登录时 `loadGameConfig()` 是必经 await，进游戏前快照一定已灌好）。
 */
export const statuses = new Map<StatusId, StatusConfig>();

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
 * 状态配置装载（#367 / #372 / #603 第三域；#604 起整表重建）
 *
 * 覆写的是**注册表本身**（`statuses` 这个 Map），所以已经在身上生效的状态
 * 时长与图标也会跟着变（`StatusManager` 只记到期时间戳，读的仍是这份配置）。
 *
 * 客户端 `configs/status` 只有一张空 Map（数据在服务端 `status-seed.ts` → `statuses` 表），
 * 所以这里先 clear 再按快照填：快照里没有的状态客户端就不该有。
 * 角色与怪物同表（`owner` 由服务端行带下来，这里不区分）—— 角色技能的 `casts` 帧只带
 * statusId，查不到配置就表现不出来，所以缺行必须由契约拦住而不是「补一半」。
 */
export function applyStatusRows(rows: StatusRow[]): void {
  statuses.clear();
  for (const row of rows) statuses.set(row.id, statusRowToConfig(row));
}

//#endregion

//#region 8 · 药品（原 configs/drug.ts）

/**
 * 药品配置（物品大类 GOOD_TYPE.DRUG）—— **客户端没有出厂数据**（#603 第十域）
 *
 * 名称 / 描述 / 图标 / 使用等级 / 售价 / 叠加 / 冷却 / 四段回复量的唯一书写处是
 * 服务端 `server/data/config-sync.sql` → `drugs` 表（管理端「药品配置」可改）→
 * `GET /game-config` 快照的 `drugs` 段 → 这里整表重建（`applyDrugData`）。
 *
 * 以前这里是 8 条写死的行 + 「回复量按成长曲线定标」的注释；那些数字现在只在种子里，
 * 改一次药不用重打客户端包。**客户端加载期这张表是空的** —— 进游戏前查不到药品不是 bug。
 *
 * 回复量的**算法**仍在本文件之外：`configs/items.resolveDrugRecovery` 按 effects 逐项累加
 * （固定值与百分比各自相加），与种子里「同类求和」的拍平口径等价。
 */

/** 服务端药品行（快照 `drugs` 段；与 `item-seed.ts` 的 `DrugSeedRow` 同形） */
export interface DrugSeedLike {
  id: string;
  label: string;
  description: string;
  icon: string;
  level: number;
  sellPrice: number;
  maxStack: number;
  cooldown: number;
  effectHp: number;
  effectMp: number;
  effectHpPercent: number;
  effectMpPercent: number;
}

/** 药品运行时表（内容全部来自服务端；加载期为空） */
export const drugs: Drug[] = [];

/**
 * 服务端把效果拍平成四个单值（同类效果求和），客户端用的是 effects 数组 ——
 * 两者语义等价（resolveDrugRecovery 也是逐项累加），这里还原成**一条**合并效果即可。
 * 全为 0 时给空数组（0 = 没有该效果，不是「回 0 点」）。
 */
function toDrugEffects(row: DrugSeedLike): DrugEffect[] {
  const effect: DrugEffect = {};
  if (row.effectHp > 0) effect.hp = row.effectHp;
  if (row.effectMp > 0) effect.mp = row.effectMp;
  if (row.effectHpPercent > 0) effect.hpPercent = row.effectHpPercent;
  if (row.effectMpPercent > 0) effect.mpPercent = row.effectMpPercent;
  return Object.keys(effect).length ? [effect] : [];
}

/**
 * 整表重建药品（#603 第十域）
 *
 * **整表重建而不是覆写已有行**：客户端已经没有出厂行了，快照里没有的 id 客户端就不该有
 * （「管理端下架一种药」会如实反映）。数组是同一个引用（`drugs` 只 clear + push），
 * 消费方拿着的引用不变 —— 但 `items` 总表要重新登记（见 `configs/items.rebuildItemIndex`）。
 */
export function applyDrugData(rows: DrugSeedLike[]): void {
  drugs.length = 0;
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    drugs.push({
      id: row.id,
      type: GOOD_TYPE.DRUG,
      label: String(row.label ?? ""),
      description: String(row.description ?? ""),
      icon: String(row.icon ?? ""),
      level: Number(row.level) || 1,
      sellPirce: Number(row.sellPrice) || 0,
      // 药品全部可叠加（结构约定，不是运营数据）：单格上限由服务端下发的 maxStack 决定
      stackable: true,
      maxStack: Number(row.maxStack) || 99,
      effects: toDrugEffects(row),
      cooldown: Number(row.cooldown) || 0,
    });
  }
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

//#endregion

//#region 9 · 材料与其它物品（原 configs/material.ts）

/**
 * 材料配置（物品大类 GOOD_TYPE.MATERIAL）—— **客户端没有出厂数据**（#603 第十域）
 *
 * 名称 / 描述 / 图标 / 等级 / 售价 / 叠加上限的唯一书写处是服务端
 * `server/data/config-sync.sql` → `items` 表（管理端「物品配置」可改）→
 * `GET /game-config` 快照的 `items` 段 → 这里整表重建（`applyItemBaseData`）。
 *
 * 这张表收的是 **MATERIAL / OTHER** 大类：装备在 `configs/equipments`（服务端 equipments 表）、
 * 药品在药品区（服务端 drugs 表），三张表字段形态不同，各自一张。
 */

/** 服务端物品行（快照 `items` 段；与 `item-seed.ts` 的 `ItemBaseSeedRow` 同形） */
export interface ItemBaseSeedLike {
  id: string;
  type: string;
  label: string;
  description: string;
  icon: string;
  level: number;
  sellPrice: number;
  maxStack: number;
}

/** 材料运行时表（内容全部来自服务端；加载期为空） */
export const materials: Material[] = [];

/**
 * 整表重建材料 / 其它物品（#603 第十域）
 *
 * 与药品同款：客户端没有出厂行，快照里没有的 id 客户端就不该有。
 * `type` 取服务端下发的原值（`material` / `other`；缺省按 material），
 * 因此未来加 OTHER 大类不用改客户端。
 */
export function applyItemBaseData(rows: ItemBaseSeedLike[]): void {
  materials.length = 0;
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    materials.push({
      id: row.id,
      type: ((row.type as GOOD_TYPE) || GOOD_TYPE.MATERIAL) as Material["type"],
      label: String(row.label ?? ""),
      description: String(row.description ?? ""),
      icon: String(row.icon ?? ""),
      level: Number(row.level) || 1,
      sellPirce: Number(row.sellPrice) || 0,
      stackable: true,
      maxStack: Number(row.maxStack) || 99,
    });
  }
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

//#endregion

//#region 10 · NPC（原 configs/npc.ts）

/**
 * NPC 运行时表（id → 配置）与点击注册表
 *
 * **#603 第七域起客户端不存任何 NPC 数据**（此前是 `configs/npc-data.ts` 的 21 条）：
 * 名称 / 素材目录 / 缩放 / 偏移都在服务端 `npcs` 表（出厂 = `server/data/config-sync.sql`），
 * 进游戏时由 `GET /game-config` 快照的 `npcs` 段**整表重建**（`applyNpcRows`，先 clear）。
 * 运营在管理端改完，下次进游戏生效 —— 客户端不用重打包。
 *
 * **本文件不许引 UI 组件**：`configs/apply-snapshot` 会引它，而客户端单测要在
 * Node 垫片里加载那条链（`client/tools/*.cjs`）。原来
 * `npc-data.ts` 与 `npc.ts` 分家（#258）就是为了这件事，现在数据搬去服务端，剩下的
 * 点击接线继续留在 `configs/npcClicks.ts`（那边才引弹窗），本文件只放一个注册表。
 *
 * ⚠ 快照到达前这张表是**空的**（不是 bug）：`MapObjectSpawner` 建节点时查不到会跳过该 NPC，
 * `PreloadManager` 也不会预载它的素材。**#604 起这条时序已经钉死**：`Loading` 场景先
 * `await loadGameConfig()` 再 `preloadGame`（拿不到配置就停在 Loading 重试），
 * 所以预载那一趟读到的就是完整表 —— 以前「Loading 先预载、Game 再补一趟」的缺口没有了。
 */
export const npcs = new Map<string, NpcData>();

/**
 * id → 点击行为（由 `configs/npcClicks` 在模块加载时登记）
 *
 * 用注册表而不是直接在本文件 import 弹窗：点击行为是 UI，进了这条链 Node 里就加载不了。
 * `npc.onClick` 是**点击那一刻**才查表，所以「注册表晚于快照填充」也不影响 —— 真点了才解析。
 */
export const npcClicks: Record<string, () => void> = {};

/**
 * 快照 npcs 段 → 运行时表（**整表重建**，先 clear）
 *
 * 整表重建而不是「覆写已有行」：客户端已经没有兜底数据，覆写等于「快照缺行就静默少一个 NPC」。
 * 缩放 / 偏移在库里是 NOT NULL（默认 1 / 0），所以这里无条件赋值 —— 与原先把
 * `scale` / `position` 当可选字段时渲染结果一致（setScale(1,1) / setPosition(0,0) 就是原样）。
 */
export function applyNpcRows(rows: NpcRow[]): void {
  npcs.clear();
  rows.forEach((row) => {
    npcs.set(row.id, {
      id: row.id,
      label: row.label,
      src: row.src,
      scale: new Vec3(row.scaleX, row.scaleY),
      position: new Vec3(row.posX, row.posY),
      // 延迟解析：行为在 npcClicks 里，那个文件可能比快照晚加载
      onClick: () => {
        const handler = npcClicks[row.id];
        if (handler) handler();
      },
    });
  });
}
//#endregion

//#region 11 · 任务数据（原 configs/quest-data.ts）
/**
 * 任务数据类型与运行时表（#396；#603 起客户端**不存任何任务数据**）
 *
 * 这里只剩类型定义与一张空数组：任务的唯一书写处是服务端
 * `server/data/config-sync.sql` —— 出厂值 seed 进 quests 表 → 管理端可改 →
 * 随 `GET /game-config` 快照的 `quests` 段下发，由 `apply-snapshot.applyQuestRows`
 * 灌进这张表（快照里新出现的任务会追加，`quests` Map 由 `rebuildQuests()` 重建）。
 *
 * 保留类型是因为消费方（任务区、`apply-snapshot`、任务面板）都按它取值；
 * 数组本身在快照到达前是空的 —— 与怪物 / 状态同口径（登录 `loadGameConfig()` 是必经 await）。
 *
 * 字段口径（服务端种子与这里同构）：
 * - `kind`：main = 主线（一次性，`prevQuestId` 线性链门控）；daily = 日常（领奖后可重复接，进度清零；
 *   首版**不做每日重置定时器**，重接即新一轮）；
 * - `npcId`：发布 NPC（客户端头顶 `!` 标记与对话入口的依据）；
 * - `objective`：**单目标**（v1 边界）——kill = 击杀怪物 key、talk = 与 NPC key 对话、
 *   collect = 交付时背包持有物品 id ×count（会扣走）；
 * - `rewards.items`：奖励物品（goodId 必须存在于物品总表）。
 *
 * 新增 / 改任务走管理端「任务配置」页；想让改动画进「出厂值」（别人 `make config-import` 之后也有这些行），
 * 改完库跑 `make config-export` 重导 `server/data/config-sync.sql`。
 */
export interface QuestObjective {
  /** kill = 击杀怪物（target = monster key）/ talk = 与 NPC 对话（target = npc id）/ collect = 收集物品（target = 物品 id） */
  type: "kill" | "talk" | "collect";
  target: string;
  count: number;
}

export interface QuestRewards {
  gold: number;
  exp: number;
  items: Array<{ goodId: string; count: number }>;
}

export interface QuestData {
  id: string;
  kind: "main" | "daily";
  label: string;
  description: string;
  /** 主线链门控：上一环的任务 id（空串 = 无前置） */
  prevQuestId: string;
  /** 接取最低等级 */
  minLevel: number;
  /** 发布 NPC（服务端 npc-seed 的 id） */
  npcId: string;
  objective: QuestObjective;
  rewards: QuestRewards;
}

/**
 * 任务运行时表（空数组起步，内容全部来自服务端快照）
 *
 * 追加/覆写都由 `applyQuestRows` 负责：它按 id 对齐，本地没有的**追加**，
 * 本地有的原地覆写 —— 所以运营在管理端新建任务，客户端不需要改代码就能接。
 */
export const questData: QuestData[] = [];

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
 * 覆写任务配置（#396；#603 第六域起**整表重建**）
 *
 * 客户端 `configs/quest-data` 早在 #603 就没有出厂行了，所以这里与技能 / 状态 / 时装同口径：
 * 先清空再按快照填 —— 管理端删掉一条任务，客户端就该少一条（留着旧行会变成
 * 「追踪栏还挂着、点开却是空任务」的幽灵）。`quests` Map 由 `rebuildQuests()` 重建。
 *
 * 行转换（`questRowToConfig`）仍保留钳制：目标类型只认 kill / talk / collect，
 * 数量至少 1，等级至少 1 —— 这些是**消费方的前提**（`Progress` 除以 count），
 * 不是「兜底数据」，坏行宁可钳到 1 也不该让任务追踪栏崩掉。
 *
 * 奖励物品只认 `goodId / count` 两个字段：物品名与图标由物品总表解析，任务表不复制一份。
 */
export function applyQuestRows(rows: QuestRow[]): void {
  questData.length = 0;
  for (const row of rows) questData.push(questRowToConfig(row));
  rebuildQuests();
}

//#endregion

//#region 12 · 任务注册表（原 configs/quest.ts）


/**
 * 任务注册表（#396）
 *
 * 由 `quest-data` 的纯数据构建，消费方统一 `quests.get(id)`（同 `npc` / `skill` 的形态）。
 * 数据与行为分家：数据在 `quest-data`（要进三端生成物，不能引 UI），
 * 本文件只做注册表 + 覆写后的重建入口。
 *
 * 覆写来源是服务端配置快照的 `quests` 表（管理端「任务配置」页可增删改），
 * 覆写逻辑在 `configs/apply-snapshot` 的 `applyQuestRows`，改完必须调 `rebuildQuests()`
 * —— 消费方读的是这个 Map，不是 `questData` 数组。
 */
export const quests = new Map<string, QuestData>();

/** 用当前 questData 重建注册表（快照覆写后调用；行对象引用保持不变） */
export function rebuildQuests(): void {
  quests.clear();
  for (const quest of questData) quests.set(quest.id, quest);
}

rebuildQuests();

/** 全部任务（配置顺序：主线 8000 段在前、日常 8100 段在后） */
export function allQuests(): QuestData[] {
  // Array.from 而不是 `[...quests.values()]`：web 包走 babel loose，展开迭代器只剩迭代器本身，
  // 调用方拿到的每一条都不是任务（#471）。守卫：tools/audit-iterator-spread.cjs
  return Array.from(quests.values());
}

/** 目标的中文名（客户端只显示三种；配置里出现未知类型时原样显示） */
export const QUEST_OBJECTIVE_LABELS: Record<string, string> = {
  kill: "击杀怪物",
  talk: "与 NPC 对话",
  collect: "收集物品",
};

/** 任务类型的中文名 */
export const QUEST_KIND_LABELS: Record<string, string> = {
  main: "主线",
  daily: "日常",
};

//#endregion

//#region 13 · 技能数据（原 configs/skill-data.ts）
/**
 * 技能数值数据表（#31 从 configs/skill 拆出；#603 第十一域起**客户端零出厂数据**）
 *
 * 定位：**纯数据模块** —— 只放数值 / 文案 / 映射，零引擎 import（不 import skills/warrior，
 * 也不 import 任何 ui/ 运行时），可被 Node 沙箱直接 require 跑断言（见 client/tools/test-skill-decouple.cjs）。
 * 释放实现不在这里：configs/skill.ts 的 roleSkillHandlers 按 id 接上，合成消费方要的 skills Map。
 *
 * ===========================================================================
 * #603 第十一域：数据搬走，算法留下
 * ===========================================================================
 * 名称 / 图标 / 分类 / 目标类型 / 动作 / 特效 / 冷却 / 魔法消耗 / 施法距离 / 学习等级 /
 * 描述 / 伤害倍率 / 挂载状态 / 施法锁 / 释放限制 / **职业归属 / 击退距离** 的唯一书写处是
 * 服务端 `server/data/config-sync.sql` → `skills` 表（管理端「技能配置」可改）→
 * `GET /game-config` 快照的 `skills` 段 → 这里整表重建（`applySkillData`）。
 *
 * 留在本文件的是**对枚举值的翻译**（技能类型 / 目标类型文案）与**派生规则**（职业 → 技能 id），
 * 它们不是运营数据：改一次数值不该要重打客户端包，而改一句「主动」的措辞本来就该改代码。
 *
 * **客户端加载期 `skillData` 是空的** —— 进游戏前 `skills` Map 里一个技能都没有不是 bug，
 * 那只是快照还没到。
 */

/** 服务端技能行（快照 `skills` 段；与 `skill-seed.ts` 的 `SkillSeedRow` 同形） */
export interface SkillSeedLike {
  id: string;
  /** 归属：role | monster（同一张表，靠它区分技能栏里的技能与怪物 AI 放的技能） */
  owner: string;
  label: string;
  icon: string;
  /** 客户端 SkillType 原值（"0" 主动 / "1" 被动 / "2" 状态 / "3" 回复） */
  category: string;
  /** 客户端 SkillTargetType 原值（"0" 区域 / "1" 单体 / "2" 群体 / "3" 自身） */
  targetType: string;
  /** 客户端动画动作键（如 attack_near） */
  action: string;
  /** 特效图集路径（空串 = 无） */
  effect: string;
  effectOnSelf: boolean;
  cooldown: number;
  mpCost: number;
  distance: number;
  /** 学习 / 开启等级（客户端字段名是 level） */
  levelReq: number;
  description: string;
  damageCoefficients: Array<{ baseType: string; baseTypeRate: number }>;
  /** 挂载的状态 id（空串 = 不挂） */
  statusId: string;
  castLockMs: number;
  requireTarget: boolean;
  canAuto: boolean;
  /** 职业归属（"1" 战士 / "2" 法师 / "3" 道士 / "4" 全职业） */
  occupation: string;
  /** 击退距离（像素；0 = 不击退） */
  pushDistance: number;
}

/** 技能数值表（内容全部来自服务端；加载期为空） */
export const skillData: Array<SkillData & { id: SkillId }> = [];

/** 技能栏的三种职业（`OECCUPATION.ALL` 的技能进全部三栏，见 `rebuildOccupationSkills`） */
const SKILL_BAR_OCCUPATIONS: OECCUPATION[] = [OECCUPATION.ZHAN, OECCUPATION.FA, OECCUPATION.DAO];

/**
 * 职业技能映射（职业 → 技能 id，技能栏 / 技能列表面板按它列条目）
 *
 * #603 第十一域起不再手写：它是 `skillData` 的**派生视图**，由 `rebuildOccupationSkills()`
 * 在每次整表重建后重算。以前这份清单与技能行分开维护，新增一个技能要改两处，
 * 漏一处就是「技能学了不显示」。
 */
export const oeccupationSkills = new Map<OECCUPATION, SkillId[]>();

/**
 * 普攻技能（左键点击怪物直接释放的那个技能，见 components/input/ScreenClickInput）
 * 走 SkillManager.release 统一入口：冷却/魔法值/距离校验都在里面，超出距离时 canAuto 会委托 AutoBattle 走过去继续打
 */
export const basicAttackSkillId: SkillId = "1000";

/** 技能类型文案（技能详情弹窗用，见 ui/core/HoverTipManager） */
export const skillTypeLabels: Record<SkillType, string> = {
  [SkillType.PROACTIVE]: "主动",
  [SkillType.PASSIVE]: "被动",
  [SkillType.STATUS]: "状态",
  [SkillType.REPLY]: "回复",
};

/** 技能目标类型文案（技能详情弹窗用） */
export const skillTargetTypeLabels: Record<SkillTargetType, string> = {
  [SkillTargetType.PLACE]: "区域",
  [SkillTargetType.SINGLE]: "单体",
  [SkillTargetType.MUTIPLE]: "群体",
  [SkillTargetType.SELF]: "自身",
};

/** 服务端行 → 客户端数值行（不含 onClick：释放实现由 configs/skill 按 id 接上） */
function toSkillData(row: SkillSeedLike): SkillData & { id: SkillId } {
  const pushDistance = Number(row.pushDistance) || 0;
  return {
    id: row.id as SkillId,
    // 归属缺省 role：绝大多数技能是角色技能，只有怪物 AI 放的才显式写 monster
    owner: row.owner === "monster" ? "monster" : "role",
    label: String(row.label ?? ""),
    icon: String(row.icon ?? ""),
    cooldown: Number(row.cooldown) || 0,
    mpCost: Number(row.mpCost) || 0,
    targetType: row.targetType as SkillTargetType,
    oeccupation: (row.occupation || OECCUPATION.ALL) as OECCUPATION,
    level: Number(row.levelReq) || 1,
    description: String(row.description ?? ""),
    type: row.category as SkillType,
    damageCoefficients: (row.damageCoefficients || []).map(
      (entry): DamageCoefficient => ({
        baseType: entry.baseType as DamageCoefficient["baseType"],
        baseTypeRate: Number(entry.baseTypeRate) || 0,
      }),
    ),
    distance: Number(row.distance) || 0,
    action: row.action as ACTION,
    // 0 = 不击退（不是「击退 0 像素」）：留着空对象会让 SkillManager 走一遍击退流程
    push: pushDistance > 0 ? { distance: pushDistance } : undefined,
    canAuto: row.canAuto === true,
    effect: row.effect || undefined,
    effectIsOnSelf: row.effectOnSelf === true,
    statusId: row.statusId || undefined,
    castLockMs: Number(row.castLockMs) || 0,
    // 缺省 true：绝大多数技能都要有目标才能放；自身 / 状态型技能在表里显式写 false
    requireTarget: row.requireTarget !== false,
  };
}

/**
 * 整表重建技能（#603 第十一域）
 *
 * **整表重建而不是覆写已有行**：客户端已经没有出厂行了，快照里没有的 id 客户端就不该有
 * （管理端下架/删掉的技能会如实消失）。数组是同一个引用（`skillData` 只 clear + push）。
 *
 * 重建后必须让 `configs/skill` 重算 `skills` Map（那里有 onClick）—— 快照链路里由
 * ConfigLoader 调 `rebuildSkills()`，本函数只负责数值表与职业技能映射。
 */
export function applySkillData(rows: SkillSeedLike[]): void {
  skillData.length = 0;
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    skillData.push(toSkillData(row));
  }
  rebuildOccupationSkills();
}

/**
 * 按当前 `skillData` 重建「职业 → 技能 id」
 *
 * - 怪物技能不进技能栏（它们由服务端 AI 释放，客户端只演）；
 * - `OECCUPATION.ALL` 的技能进全部三种职业；
 * - 每个职业的键**总是存在**（哪怕是空数组）：技能列表面板 `oeccupationSkills.get(职业)`
 *   拿到 undefined 会直接抛错，空数组才是「这个职业还没技能」。
 */
export function rebuildOccupationSkills(): void {
  oeccupationSkills.clear();
  for (const code of SKILL_BAR_OCCUPATIONS) oeccupationSkills.set(code, []);
  for (const skill of skillData) {
    if (skill.owner === "monster") continue;
    const codes = skill.oeccupation === OECCUPATION.ALL ? SKILL_BAR_OCCUPATIONS : [skill.oeccupation];
    for (const code of codes) {
      const list = oeccupationSkills.get(code);
      if (list && list.indexOf(skill.id) < 0) list.push(skill.id);
    }
  }
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

//#endregion

//#region 14 · 时装（原 configs/fashionClothes.ts）
/**
 * 时装配置表（#257 启用；#603 第十二域起**客户端零出厂数据**）
 *
 * ===========================================================================
 * #603 第十二域：数据搬走，取源规则留下
 * ===========================================================================
 * 名称 / 文案 / 图标 / 内观资源 / 外观资源 / 售卖价 / 八项属性加成的唯一书写处是
 * 服务端 `server/data/config-sync.sql` → `fashions` 表（管理端「时装配置」可改）→
 * `GET /game-config` 快照的 `fashions` 段 → 这里整表重建（`applyFashionData`）。
 *
 * 留在本文件的是**取源规则**（外观优先时装、其次装备衣服、最后性别默认外观）与
 * 按 id 查询的几个函数 —— 那是玩法逻辑，不是运营数据。
 *
 * **客户端加载期 `fashionData` 是空的** —— 进游戏前时装弹窗里一套都没有不是 bug，
 * 那只是快照还没到。
 *
 * 资源路径为什么跟着行走：cloth_2 与 clothes/out/001 之间没有可推导的约定
 * （编号与 id 不连续，cloth_13 连内观图都没有），所以路径必须入库；
 * 而地图 `<id>/<id>`、特效 `effect/<key>/<key>.plist` 能按 id 推导，就不入库。
 */
export interface FashionDataEntry {
  /** 时装 id（如 cloth_2；fashions 表主键，序列固定不可增删） */
  id: string;
  label: string;
  description: string;
  /** 图标资源路径（resources 相对路径，如 clothes/icon/001） */
  icon: string;
  /** 内观资源路径（空串 = 无） */
  in?: string;
  /** 外观资源路径（空串 = 无） */
  out?: string;
  /** 售卖价（原配置字段名 sellPirce，这里用正确拼写；缺省 0） */
  sellPrice?: number;
  /** 获得渠道（upgrade = 可购买 / grant = 运营发放 / unavailable = 未开放；#596） */
  acquireChannel: string;
  /** 战斗属性加成（缺省全 0） */
  attributes?: {
    maxHp?: number;
    hpRecover?: number;
    physicalAttack?: [number, number];
    magicAttack?: [number, number];
    taoistAttack?: [number, number];
    physicalDefense?: [number, number];
    magicDefense?: [number, number];
    taoistDefense?: [number, number];
  };
}

/** 协议里的区间是 `{min,max}` 对象（与装备 / 称号同一形状），客户端内部用 [min,max] 元组 */
export interface FashionRangeLike {
  min: number;
  max: number;
}

/** 服务端时装行（快照 `fashions` 段；与 `fashion-seed.ts` 的 `FashionSeedRow` 同源） */
export interface FashionSeedLike {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** 注意服务端字段名带 Res 后缀（inRes / outRes），客户端沿用 in / out */
  inRes: string;
  outRes: string;
  sellPrice: number;
  /** 获得渠道（upgrade = 可购买 / grant = 运营发放 / unavailable = 未开放；#596 起弹窗用它算「能不能买」） */
  acquireChannel?: string;
  attributes: {
    maxHp?: number;
    hpRecover?: number;
    physicalAttack?: FashionRangeLike;
    magicAttack?: FashionRangeLike;
    taoistAttack?: FashionRangeLike;
    physicalDefense?: FashionRangeLike;
    magicDefense?: FashionRangeLike;
    taoistDefense?: FashionRangeLike;
  };
}

/** 时装运行时表（内容全部来自服务端；加载期为空） */
export const fashionData: FashionDataEntry[] = [];

/** 协议区间 → 客户端元组（缺省 = [0,0]；全 0 也要照写，运营可能就是把加成清零） */
function toRange(range: FashionRangeLike | undefined): [number, number] {
  return range ? [Number(range.min) || 0, Number(range.max) || 0] : [0, 0];
}

/**
 * 整表重建时装（#603 第十二域）
 *
 * **整表重建而不是覆写已有行**：客户端已经没有出厂行了，快照里没有的 id 客户端就不该有。
 * 数组是同一个引用（只 clear + push），弹窗 / 预载拿着的引用不变。
 */
export function applyFashionData(rows: FashionSeedLike[]): void {
  fashionData.length = 0;
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    const source = row.attributes ?? {};
    fashionData.push({
      id: row.id,
      label: String(row.label ?? ""),
      description: String(row.description ?? ""),
      icon: String(row.icon ?? ""),
      in: String(row.inRes ?? ""),
      out: String(row.outRes ?? ""),
      sellPrice: Number(row.sellPrice) || 0,
      acquireChannel: String(row.acquireChannel ?? "unavailable"),
      attributes: {
        maxHp: Number(source.maxHp) || 0,
        hpRecover: Number(source.hpRecover) || 0,
        physicalAttack: toRange(source.physicalAttack),
        magicAttack: toRange(source.magicAttack),
        taoistAttack: toRange(source.taoistAttack),
        physicalDefense: toRange(source.physicalDefense),
        magicDefense: toRange(source.magicDefense),
        taoistDefense: toRange(source.taoistDefense),
      },
    });
  }
}

//#region 读取（#377 穿戴系统：外观取源规则只在这里写一遍）

/** 按 id 取时装（无此 id 返回 null） */
export function getFashion(id: string | null | undefined): FashionDataEntry | null {
  if (!id) return null;
  return fashionData.find((fashion) => fashion.id === id) ?? null;
}

/**
 * 时装的**外观**帧目录（没穿时装 / 该时装没有外观资源 → null）
 *
 * 取源优先级：**时装 > 装备衣服 > 该性别默认外观**。场景里的主角（RoleAppearance）、
 * 进图预载（PreloadManager）都走这一条，别各自判一遍 —— 三处口径不一致会变成
 * 「弹窗里换了衣服、地图上还是旧的」或者「预载漏了、进图第一帧空着」。
 */
export function getFashionOut(id: string | null | undefined): string | null {
  return getFashion(id)?.out || null;
}

/** 时装的内观资源（没穿 / 该时装没有内观 → null，调用方回落到装备内观） */
export function getFashionIn(id: string | null | undefined): string | null {
  return getFashion(id)?.in || null;
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

//#endregion
//#endregion

//#region 15 · 怪物手感参数（原 configs/monster.ts）

/**
 * 怪物全局行为常量（本区就是全部内容 —— **没有怪物条目，#588 数据归属收口**）
 *
 * 怪物的数据客户端一份都不存：
 * - **数值**（label / level / tier / maxHp / 六项攻防）唯一来源 = 服务端 `monsters` 表
 *   （出厂 = `server/data/config-sync.sql` 里 `monsters` 那批行，逐只配好，管理端可改），随 `GET /game-config`
 *   快照的 `monsters` 段下发，进本文件下面的怪物运行时表；
 * - **资源与表现**（icon / out / 几何 / 移动 / AI 参数）唯一来源 = 服务端
 *   `monster-presentation.generated.ts`（生成器从图集实测），随同一份快照的
 *   `monsterPresentations` 段下发，进同一张运行时表；
 * - 怪物的「有没有数据」由快照决定：快照失败时场上**没有怪**（生成需要资源行），
 *   不像旧口径那样回落本地出厂值演 —— 断网时服务端也不发怪，两边一致。
 *
 * 这里剩下的常量是**客户端演出的手感参数**。服务端 AI 的节奏（攻击间隔 / 攻击距离 /
 * 漫游速度倍率这些）**不在这里**：它们在库里的 `runtime_params.monster_ai` 单行表上，
 * 管理端「运行时参数」页可改，服务端 tick 直接读那一列 —— 客户端改了也不会影响服务端。
 *
 * #603 第十三域复核结论：这一整块**不搬到表里** —— 它是动画节奏与手感（普攻间隔 / 停下出手的距离 /
 * 待机游走），不是运营数值；怪物真正的数值（血量 / 六项攻防 / 掉落）早已在 `monsters` 表。
 */

export const monsterAI = {
  /** 普攻间隔（毫秒）——怪物只会普攻，没有技能，技能以后再考虑 */
  attackInterval: 2000,
  /** 普攻距离（像素）：追到这个距离就停下出手 */
  attackRange: 60,
  /** 普攻动作时长（毫秒）：出手期间站定不移动，动作播完才结算伤害 */
  attackActionTime: 600,
  /** 待机时可随机切换的动作池（想加动作往这里加，例如 ACTION.RUN / ACTION.A1） */
  idleActions: [ACTION.STAND, ACTION.WALK] as ACTION[],
  /** 待机时更换动作的随机间隔（毫秒） */
  idleAnimationInterval: [2000, 5000] as [number, number],
  /** 待机时触发一次随机走动的随机间隔（毫秒） */
  idleMoveInterval: [4000, 9000] as [number, number],
  /** 每次随机走动的持续时间（毫秒） */
  idleMoveDuration: [300, 800] as [number, number],
  /** 随机走动的速度倍率（相对怪物自身 moveSpeed，比追击慢一点） */
  idleMoveSpeedScale: 0.5,
  /** 随机走动的活动半径（像素）：离停留点超过这个距离就往回走，避免越走越远 */
  wanderRadius: 60,
  /**
   * 击退默认时长（毫秒）：技能击退是场上唯一能推动位置的途径，
   * 技能配置里只写距离时用这个时长换算击退速度（距离 / 时长），改这里可统一调整击退手感
   */
  pushDuration: 200,
};

/**
 * 怪物默认动作速度（**每秒循环数**，片段总时长 = 1 / 该值，见 AnimationHelper.createClip）
 * 怪物素材是统一帧规格（见 configs/animation 的 monsterActionSpecs：stand 4 帧 / walk·run 6 帧 /
 * injured 2 帧 / die 10 帧，没有攻击帧——播攻击动作时回退待机），所以全怪共用一套默认即可；
 * 个别怪要调速 → 服务端 monster-presentation.generated.ts 那行的 speedRate 覆盖（随快照下发）
 */
export const monsterDefaultSpeedRate: SpeedRate = {
  [ACTION.STAND]: 1, // 4 帧 / 1 秒：缓慢的呼吸循环
  [ACTION.WALK]: 1, // 6 帧 / 1 秒，与角色步行循环同速
  [ACTION.RUN]: 1, // 6 帧 / 1 秒
  [ACTION.ATTACK_NEAR]: 2, // 素材暂无攻击帧（回退待机），留 0.5 秒一击的默认
  [ACTION.ATTACK_SKILL_1]: 2,
  [ACTION.TEST3]: 1,
  [ACTION.ATTACK_FAR]: 2,
  [ACTION.INJURED]: 2, // 受击只有 2 帧，0.5 秒抖一下
  [ACTION.A1]: 1,
  [ACTION.DIE]: 1, // 10 帧 / 1 秒：一秒倒地
  [ACTION.TEST1]: 1,
};
//#endregion

//#region 16 · 怪物运行时表（原 configs/monsterRuntime.ts）

/**
 * 怪物运行时表（#588 数据归属收口）—— **客户端唯一的怪物数据持有处**
 *
 * 两半都来自 `GET /game-config` 快照（客户端没有怪物数据文件）：
 * - `monsterResource`：资源与表现（快照 `monsterPresentations` 段 ← 服务端
 *   `monster-presentation.generated.ts`，图集实测的几何与素材路径）；
 * - `monsterRuntime`：数值（快照 `monsters` 段 ← 服务端 `monsters` 表，出厂 =
 *   `monster-seed.ts` 曲线展开，管理端可改）。
 *
 * 此前数值在客户端本地有一份、快照来了逐字段覆写 —— 那要求「覆写一个不漏」
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
    // 快照只带「要改的动作」，其余动作走客户端默认（素材帧规格统一，见上面的怪物手感参数区）
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

//#endregion

//#region 17 · 商城定价（原 configs/mall.ts）

/**
 * 商城定价表
 *
 * **#603 第八域起客户端不存任何价格**：统一价与特殊价都在服务端（`mall_settings` /
 * `mall_prices` 两张表，管理端「商城定价」可改），进游戏由 `GET /game-config` 快照下发，
 * 这里只做落表与取价。以前在客户端写死的 `mallPrice = 1` 已删 —— 那份常量与服务端
 * `MALL.defaultPrice` 是同一件事，两边各改一次迟早漂移。
 *
 * 「商品 = 系统内的全部装备」那份查询（`getMallGoods`）在 `configs/equipments` —— 它要读
 * 七个部位表，而部位表由装备段建起来，放在这里会形成 `game-config → equipments → game-config`。
 */

/** 特殊价（商品 id → 绑定元宝）：快照 `mallPrices` 段整表重建 */
let specialPrices = new Map<string, number>();

/** 统一价（快照 `mallSettings.defaultPrice`）；null = 快照还没到 */
let defaultPrice: number | null = null;

/** 只 warn 一次：快照没到就问价，说明调用时序错了（正常路径 `Game.start` 已 await 过配置） */
let warnedMissing = false;

/**
 * 接入服务端定价（`configs/apply-snapshot` 调用）：defaultPrice = mall_settings 统一价，
 * prices = mall_prices 全量目录（price 为 null 的行是未定价，不入 Map）
 */
export function applyMallPricing(nextDefaultPrice: number, prices: Array<{ id: string; price: number | null }>): void {
  const map = new Map<string, number>();
  prices.forEach((entry) => {
    if (entry.price != null) map.set(entry.id, entry.price);
  });
  specialPrices = map;
  defaultPrice = nextDefaultPrice;
}

/**
 * 取某件物品在商城的售价（绑定元宝 / 件）：**特殊价优先，未定价走统一价**
 *
 * 与结算口径一致（服务端扣款用的就是这套规则）。快照没到就返回 0 并 warn 一次 ——
 * 不在这里兜一个「出厂价」，那等于又在客户端存一份价格。
 */
export function getMallPrice(good: Goods): number {
  if (defaultPrice == null) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn("[mall] 商城定价快照还没到就取价了（返回 0）：检查调用时序，正常应在 Loading 场景的 loadGameConfig（#604）之后");
    }
    return 0;
  }
  return specialPrices.get(good.id ?? "") ?? defaultPrice;
}

//#endregion

//#region 18 · 地图（原 configs/map.ts）

/**
 * 地图（#573：客户端只留**资源约定**，玩法配置全在服务端）
 *
 * ## 这里为什么空了
 *
 * 以前这张文件里是一张 `mapData` 表：11 张图的名称 / 类型 / 进入等级 / 进入战斗力 /
 * 进入战魂阶。那些是**玩法配置**，不是资源 —— 改一个进入等级要重打整个客户端包（3G），
 * 而它们本来就该由运营在管理端改。
 *
 * 现在的地图分两半：
 *
 * | 数据 | 在哪 | 谁能改 |
 * |---|---|---|
 * | TMX / 底图 / 预览图 / 碰撞盒 | 客户端资源包 `resources/map/<id>/` | 美术（随包发布） |
 * | 名称 / 类型 / 进入条件 / NPC 点位 / 复活点 / 刷怪区 | 服务端（`maps` / `map_npcs` / `map_spawn_areas`） | 运营（管理端「地图管理」，保存即生效） |
 *
 * **TMX 里只剩瓦片与碰撞**（#667 刷怪区、#672 NPC 与复活点先后搬到后台）：点位这类
 * 「运维天天要调」的东西留在资源包里，等于每改一次都要重打 3G 的包。
 *
 * 客户端要做的只有两件事：**按 id 拼资源路径**（`mapSrcOf`，目录约定）、
 * **进游戏时把服务端那份配置接住**（`configs/apply-snapshot` 的 `applyMapRows`）。
 *
 * ⚠ 所以 `maps` 在配置拉回来之前是**空的**，这不是 bug：
 * - 资源预加载 / 进图**不用查它**（路径由 `mapSrcOf` 算，见 ui/Game 与 Loading）；
 * - 显示层（小地图 / 传送弹窗）读空时用 `mapLabelOf` 的兜底文案，并随快照到达自动更新；
 * - NPC / 复活点 / 刷怪区标签**必须**有它（没有就一个都不摆，见 `MapObjectSpawner`）。
 */

/**
 * 地图文件里已经没有对象组了（#676）
 *
 * 以前这里有一份「Tiled 对象组名 → 客户端消费方」的约定（`collision` 是最后一个消费方）。
 * 碰撞盒搬进 `map_collisions` 之后，TMX 里**一个对象组都不存在**：地图 = 瓦片 + 图层，
 * 只负责显示；点位 / 刷怪区 / 碰撞盒全部来自配置快照。
 *
 * 这条不是建议而是边界：谁要是又想在客户端读 TMX 的对象组，先回答「为什么这份数据不能
 * 在管理端改」—— 那正是 `tools/strip-map-objects.cjs` 存在的理由。
 */

/**
 * 地图资源路径
 *
 * 唯一规则：`resources/map/<id>/<id>.tmx`（底图与预览图在同一个目录里）。
 * **只此一处**：客户端、服务端（`MapService.srcOf`）都按这条约定拼，谁都不存一个 `src` 字段 ——
 * 存了就会有人改它，而改它只会把客户端指到一张不存在的图上。
 */
export function mapSrcOf(id: MapId): string {
  return `map/${id}/${id}`;
}

/**
 * 运行时地图表（id → 玩法配置）
 *
 * 内容由服务端配置快照填充（`applyMapRows`，进游戏时一次）。**不要往这里写死数据** ——
 * 那等于把配置又搬回了客户端，`audit-shared-data` 与代码评审都盯着这一点。
 */
export const maps = new Map<MapId, MapConfig>();

/**
 * 地图类型分组（顺序 + 文案都由服务端下发）
 *
 * 传送弹窗按这个数组分桶展示；空数组表示「配置还没到」，那时弹窗不渲染分组。
 * 以前这份顺序与文案在客户端写死（`mapTypeGroups`），搬迁后归服务端 ——
 * 新增一种地图类型只改服务端，客户端跟着下发走。
 */
export const mapTypeGroups: Array<{ type: string; label: string }> = [];

/** 地图名（没拉到配置时给一个能看懂的兜底，不显示空白按钮） */
export function mapLabelOf(id: MapId): string {
  const config = maps.get(id);
  return config && config.label ? config.label : `地图 ${id}`;
}
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
      // 点位（#672）：坐标已经是世界坐标，客户端不再换算；缺段当「没有点位」而不是报错 ——
      // 老服务端配新客户端时少几个 NPC 比整个快照加载失败好
      npcs: (row.npcs ?? [])
        .filter((point) => point && typeof point.npcId === "string")
        .map((point) => ({ npcId: point.npcId, x: Number(point.x) || 0, y: Number(point.y) || 0 })),
      revive: row.revive ? { x: Number(row.revive.x) || 0, y: Number(row.revive.y) || 0 } : null,
      spawnAreas: (row.spawnAreas ?? [])
        .filter((area) => area && typeof area.monsterKey === "string")
        .map((area) => ({ monsterKey: area.monsterKey, cx: Number(area.cx) || 0, cy: Number(area.cy) || 0 })),
      // 碰撞盒（#676）：宽高必须为正 —— 零面积的盒子在客户端建出来是个「点了没反应的空节点」，
      // 直接丢掉比留着让人以为「这里明明有碰撞」好
      collisions: (row.collisions ?? [])
        .filter((box) => box && Number(box.w) > 0 && Number(box.h) > 0)
        .map((box) => ({ x: Number(box.x) || 0, y: Number(box.y) || 0, w: Number(box.w) || 0, h: Number(box.h) || 0 })),
    });
  }
  mapTypeGroups.length = 0;
  for (const group of groups) {
    if (!group || typeof group.type !== "string") continue;
    mapTypeGroups.push({ type: group.type, label: String(group.label ?? group.type) });
  }
}

//#endregion

//#region 19 · 界面特效（升级特效 + 掉落光效；原 configs/effect.ts）

/**
 * 特效配置
 * 技能特效的资源路径与作用对象见 configs/skill 的 effect / effectIsOnSelf（每个技能各自配置），
 * 这里只放**统一的挂点口径**：特效节点与角色外观节点同一套规则（锚点居中、原始尺寸），
 * 因此特效与角色美术天然对齐，通常不需要偏移；需要整体上下/左右微调时改下面的偏移量。
 */
export const skillEffect = {
  /** 挂在释放者身上时的世界坐标偏移（角色节点锚点在脚底，正数向上/向右） */
  selfOffset: new Vec2(0, 0),
  /** 挂在目标（怪物）身上时的世界坐标偏移 */
  targetOffset: new Vec2(0, 0),
};

/**
 * 状态特效的统一口径（进行中的状态在角色身上循环播放的特效，见 core/StatusManager）
 * 各状态用哪张图集在状态区的 effect 配置，这里只放共用的挂点偏移与播放帧率
 */
export const statusEffect = {
  /** 相对角色锚点（脚底）的世界坐标偏移 */
  offset: new Vec2(0, 0),
  /** 循环播放帧率（每秒帧数） */
  frameRate: 12,
};

/**
 * 选中怪物指示器的统一口径（选中怪物脚下循环播放的光圈，见 ui/components/hud/MonsterSelectIndicator）
 * 选中时创建、取消选中/目标失效即销毁，生命周期与怪物信息面板一致（见 core/RoleUIManager）
 */
export const selectIndicator = {
  /** 光圈图集（resources 路径，不含扩展名；TexturePacker 图集 plist + png 同名） */
  atlas: "effect/selected/select_monster@0",
  /** 相对怪物节点锚点的世界坐标偏移：怪物节点锚点居中（身体中心），负数向下压向脚底 */
  offset: new Vec2(0, -40),
  /** 循环播放帧率（每秒帧数） */
  frameRate: 10,
};

/**
 * 玩家受击的屏幕反馈（怪物普攻命中后全屏闪一下红，见 GameUiHelper.showHitScreenFlash）
 * 挂特效层、以相机为中心铺满可视区，淡入即淡出；无素材依赖（Graphics 画纯色矩形）
 */
export const hitScreenFlash = {
  /** 闪光颜色（配合 UIOpacity 淡入淡出，颜色本身不透明） */
  color: new Color(255, 0, 0, 255),
  /** 峰值不透明度（0~1）：只做一层薄红，闪一下提示即可，不能盖住画面 */
  maxOpacity: 0.16,
  /** 淡入时长（秒） */
  fadeIn: 0.05,
  /** 淡出时长（秒） */
  fadeOut: 0.25,
  /**
   * 限频间隔（毫秒）：连续挨打时不重触发，避免被围殴期间红屏常驻
   * （一次闪烁从淡入到淡出约 0.3 秒，限频略大于此即可看起来「每波命中闪一次」）
   */
  cooldownMs: 400,
  /** 铺满可视区再放大的倍率（镜头边缘/适配留白时防止四周露出未覆盖的底） */
  overscan: 1.2,
};

//#region 界面特效运行时表（#594 升级特效 / #634 掉落光效）

/**
 * 升级特效的兜底参数（= 服务端 `UI_EFFECT_DEFAULTS.upgrade` 的出厂值）
 *
 * 服务端表在、快照没到 / 表里没有 `upgrade` 行时用它 —— 搬家不改行为：
 * 出厂值在两端各有一份（同一注释放着），但**权威在服务端**，这里只是兜底。
 */
export const upgradeEffectDefaults: Omit<UiEffectConfig, "key"> = {
  offsetX: 0,
  offsetY: 90,
  scaleX: 1,
  scaleY: 1,
  rotate: 0,
  durationMs: 1000,
  enabled: true,
};

/**
 * 掉落光效（装备光柱）的出厂时长 —— key 是**素材名** `light_1`…`light_6`
 *
 * 时长 = 帧数 × 100ms（客户端原先写死 10fps 的等效口径）：1 号素材 14 帧 = 1400，
 * 2~6 号各 15 帧 = 1500。**换素材改帧数时这里与服务端 `UI_EFFECT_DEFAULTS` 要一起改**
 * （`client/tools/test-equipment-light.cjs` 拿 plist 的实际帧数逐条核对，对不上会红）。
 *
 * 顺带承担「哪些光柱 key 是登记过的」：不在表里的 key 一律不演（配置写错过，
 * 比如自定义表指到一个已删除的素材）。
 */
const dropLightFallbackDurations: Record<string, number> = {
  light_1: 1400,
  light_2: 1500,
  light_3: 1500,
  light_4: 1500,
  light_5: 1500,
  light_6: 1500,
};

/**
 * 运行时界面特效表（key → 表现参数，#594 / #634）
 *
 * 内容由服务端配置快照的 `uiEffects` 段填充（`applyUiEffectRows`，进游戏时一次，
 * **整表重建**）。**不要往这里写死数据** —— 那等于把配置又搬回了客户端。
 * key 的取值域由客户端的消费代码决定（`upgrade` + 掉落光效六档之外加特效 = 写消费代码 +
 * 服务端 `UI_EFFECT_KEYS` 登记，两端对上才有东西可演）。
 */
export const uiEffects = new Map<string, UiEffectConfig>();

/** 逐字段合并要走的字段（快照行覆盖它带来的字段，缺的字段留在兜底值） */
const UI_EFFECT_FIELDS = ["offsetX", "offsetY", "scaleX", "scaleY", "rotate", "durationMs", "enabled"] as const;

/**
 * 兜底值 + 快照行的逐字段合并
 *
 * 不直接 `{...fallback, ...row}` 展开：老快照缺新字段时会把 `undefined` 盖到兜底值上。
 * 这里全是标量，逐字段覆盖正好安全。
 */
function mergeUiEffect(fallback: UiEffectConfig): UiEffectConfig {
  const row = uiEffects.get(fallback.key);
  if (!row) return fallback;
  const merged: UiEffectConfig = { ...fallback };
  const source = row as unknown as Record<string, unknown>;
  for (const field of UI_EFFECT_FIELDS) {
    const value = source[field];
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[field] = value;
  }
  return merged;
}

/**
 * 取升级特效的表现参数（摆位与缩放都归服务端，见 GameUiHelper.createUpgradeEffect）
 */
export function upgradeEffectConfig(): UiEffectConfig {
  return mergeUiEffect({ key: "upgrade", ...upgradeEffectDefaults });
}

/**
 * 取某个掉落光柱的表现参数（#634：摆位 / 缩放 / 旋转 / 时长 / 开关都归服务端）
 *
 * 参数语义与升级特效同一套，只有**挂点**不同：偏移是相对**掉落物图标中心**的
 * （客户端把它加到 `dropItemLayout.iconOffsetY` 上，所以 (0,0) = 与图标同心，与 #634 之前一致）。
 *
 * @param lightKey 光柱 key（`light_1`…`light_6`，来自 configs/light 的前缀表 / 自定义表）
 * @returns 未登记的光柱返回 null（不演 —— 配置写错了，别拿默认参数演一个不存在的素材）；
 *          登记过的总返回配置（`enabled = false` 由调用方判断，与升级特效同一个口径）
 */
export function dropLightEffectConfig(lightKey: string): UiEffectConfig | null {
  const durationMs = dropLightFallbackDurations[lightKey];
  if (durationMs === undefined) return null;
  return mergeUiEffect({
    key: lightKey,
    offsetX: 0,
    offsetY: 0,
    scaleX: 1,
    scaleY: 1,
    rotate: 0,
    durationMs,
    enabled: true,
  });
}

/**
 * 覆写界面特效的表现参数（#594）
 *
 * 特效的摆位 / 缩放 / 旋转 / 时长 / 开关以前写死在 `GameUiHelper.createUpgradeEffect` 里 ——
 * 调一次摆位要重打 3G 的客户端包。现在这些值由服务端 `ui_effects` 表下发（管理端「特效管理」
 * 可改，与武器外观同一套取向），这里按 key 填进运行时表，消费方读 `upgradeEffectConfig()` /
 * `dropLightEffectConfig()`。
 *
 * 三条口径：
 * - **整表重建**（先 clear 再按行填）：特效行由服务端 seed 决定，客户端没有「本地兜底行」可言；
 * - **图集路径不在这里**（`upgrade` = `effect/<key>/<key>.plist`、掉落光效 = `effect/light/<key>.plist`，
 *   都是两端约定）：下发方永远改不到「客户端加载哪张图」—— 与这个文件开头那条「资源路径一律不覆写」完全一致；
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
//#endregion

//#region 20 · 装备几何锚点（原 configs/equipAlign.ts）
/**
 * 装备对齐口径（**唯一实现**：角色内观从这里取几何）
 *
 * ===========================================================================
 * #541：**外观已不再「算」—— 场景里的衣服与武器一律摆绝对位置**
 * ===========================================================================
 * 外观（场景里跟角色走的那套）的几何只认数据：管理端「装备对齐」工作台调好的
 * 8 向绝对位置经服务端 `game-config/equip-align` 每次进图下发（configs/apply-snapshot），
 * 客户端 `RoleAppearance.applyOutTransform` 原样摆上去 —— 曾经的「按身体帧内容 bbox
 * 自动贴握持点」算法（#505）已删除，因为它现场算出来的位置与工作台/服务端数据对不上，
 * 用户无法用工作台表达最终效果。本文件保留的纯函数仅供**内观**（RoleInShowView）
 * 与单测使用。
 *
 * ===========================================================================
 * 内观为什么仍要「算」（历史背景，即原外观算法的出处）
 * ===========================================================================
 * 素材的画布与裁剪留白每件都不一样（武器外观画布 245×234 ~ 570×608，身体 142×112 ~ 480×480），
 * 写死一个 inPosition / outPositions 只能对上一件身体：换一件衣服，武器就飘到脚底或头顶。
 * 内观仍由**运行时读到的帧几何**推导（武器缩放到身体高度的固定倍数、贴握持点），
 * 手调过的武器用 `inManual = true` 走绝对值（#523）。
 *
 * 帧几何一律用**内容 bbox**（`SpriteFrame.rect` + `SpriteFrame.offset`，见
 * GameUiHelper.spriteContentBox）—— 用节点框会随着裁剪留白漂移，正是原来的病根。
 */

/** 对齐口径的比例系数（改这里就同时改了场景与内观，别在调用方另写一份） */
export const EQUIP_ALIGN = {
  /** 握持点横向：相对身体半宽的比例（0.5 = 恰在身体边缘，>0.5 略向外） */
  handSideRatio: 0.52,
  /** 握持点纵向：相对身体高度的比例（0 = 脚底，1 = 头顶），0.52 约在胯部略上 */
  handHeightRatio: 0.52,
  /** 内观里武器的高度 = 身体高度 × 该倍数（展示口径，长短武器统一「规格」） */
  inWeaponHeightRatio: 1.15,
  /** 素材未就绪时的重试间隔（毫秒）：帧是异步落到 Sprite 上的，「就绪」回调里常常还读不到 */
  alignRetryDelayMs: 50,
  /** 重试次数上限（约 1 秒）：素材真的缺帧时就停手，不做无意义的重排 */
  alignRetryTimes: 20,
};

/** 精灵当前帧的内容 bbox（节点本地坐标，y 向上；由 GameUiHelper.spriteContentBox 给出） */
export interface ContentBox {
  /** 内容中心相对节点中心的横向偏移 */
  cx: number;
  /** 内容中心相对节点中心的纵向偏移 */
  cy: number;
  w: number;
  h: number;
}

/**
 * 握持点（宿主坐标）
 * @param body 身体内容 bbox（**已加上衣服节点的位置**，即宿主坐标系下的中心）
 * @param onLeft 武器是否在观众左侧（角色右手持械；面朝下时右手在观众左边）
 */
export function handAnchor(body: ContentBox, onLeft: boolean): { x: number; y: number } {
  const side = onLeft ? -1 : 1;
  return {
    x: body.cx + side * (body.w / 2) * EQUIP_ALIGN.handSideRatio,
    y: body.cy - body.h / 2 + body.h * EQUIP_ALIGN.handHeightRatio,
  };
}

/**
 * 武器节点位置（宿主坐标，内观用）
 *
 * 武器节点被摆到 `手部锚点 − 武器内容中心 × 缩放`，于是**武器的内容中心**正好落在握持点上。
 * 内容中心不等于节点中心（裁剪留白），所以必须减去 `weapon.cx/cy`，否则留白越多偏得越远。
 *
 * @param scale 武器缩放
 */
export function placeWeaponOnHand(body: ContentBox, weapon: ContentBox, scale: number, onLeft: boolean): { x: number; y: number } {
  const hand = handAnchor(body, onLeft);
  return { x: hand.x - weapon.cx * scale, y: hand.y - weapon.cy * scale };
}

/**
 * 内观：武器节点的缩放与位置
 *
 * 缩放让**武器内容高度**等于身体内容高度的固定倍数；位置同样把武器内容中心对到握持点。
 */
export function placeInShowWeapon(body: ContentBox, weapon: ContentBox, onLeft = true): { x: number; y: number; scale: number } {
  const scale = (body.h * EQUIP_ALIGN.inWeaponHeightRatio) / weapon.h;
  const pos = placeWeaponOnHand(body, weapon, scale, onLeft);
  return { x: pos.x, y: pos.y, scale };
}
//#endregion

//#region 21 · 音效（原 configs/audio.ts，#683）
/**
 * 音效配置表（key → 用哪个文件 / 多大声 / 循环不循环 / 开不开）
 *
 * ## 为什么这一段的资源路径可以覆写
 *
 * 本文件开头那条纪律是「资源路径与几何一律不覆写」—— 让服务端下发路径就能把客户端指到
 * 一张不存在的图上。音效是**唯一的例外**，而这条例外正是它存在的理由：
 * 图集 / 帧动画的路径按 id 拼（`effect/<key>/<key>.plist`、`map/<id>/<id>`），换美术必须重打包；
 * 音效文件是运营挑的，换一首登录曲只要新文件已经在资源包里。
 * 所以 `filePath` 进库、随快照下发。除它之外，这里没有任何路径字段。
 *
 * ## 没有本地兜底
 *
 * 快照没到之前这张表是空的，`audioConfigOf()` 返回 null = **不播**。
 * 写一份客户端默认值等于给「运营改了没生效」准备一个看不出来的解释。
 *
 * ## 「不播」的三种情况（判据都在 `audioConfigOf` 里，调用方不用各判一遍）
 * - 表里没有这个 key（服务端没下发 / 清单没登记）
 * - `enabled === false`（连文件都不读）
 * - `filePath` 为空（这一项还没配文件）
 */
export const audioConfigs = new Map<string, AudioConfigRow>();

/**
 * 取一个音效的播放配置（null = 不播）
 *
 * 刻意不返回「兜底参数」：调用方拿到 null 就该什么都不做。
 */
export function audioConfigOf(key: string): AudioConfigRow | null {
  const row = audioConfigs.get(key);
  if (!row || !row.enabled) return null;
  if (!row.filePath) return null;
  return row;
}

/**
 * 音效路径 → Cocos 资源路径（**去掉扩展名**）
 *
 * `sounds/login_bg.wav` → `sounds/login_bg`：服务端存的是带扩展名的文件路径（管理端要能直接拼
 * 试听地址、要和文件系统一一对应），而 `resources.load` 认的是不带扩展名的资源路径。
 * 转换只在这里做一次 —— 别让每个播放点自己 `split(".")`。
 */
export function audioResPathOf(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  const dot = filePath.lastIndexOf(".");
  return dot > slash ? filePath.slice(0, dot) : filePath;
}

/**
 * 覆写音效配置（#683，进游戏时一次 + 登录页拉一次公开接口）
 *
 * 三条口径与其它段一致：
 * - **整表重建**（先 clear 再按行填）：表里没有的 key 客户端就不该有；
 * - **坏行整条跳过**（缺 key / 音量不是数）：宁可这一项不响，也不要拿错参数播一次；
 * - **不校验路径合法性**：那是服务端的活（`audioPathProblem`），客户端只负责「路径给了就去 load，
 *   load 不到就不出声」—— 两处都判会让「为什么没声音」多一个可信度更低的原因。
 */
export function applyAudioRows(rows: AudioConfigRow[]): void {
  audioConfigs.clear();
  for (const row of rows ?? []) {
    if (!row || typeof row.key !== "string" || !row.key) continue;
    const volume = Number(row.volume);
    if (!Number.isFinite(volume)) continue;
    audioConfigs.set(row.key, {
      key: row.key,
      filePath: typeof row.filePath === "string" ? row.filePath.trim() : "",
      volume: Math.min(100, Math.max(0, Math.round(volume))),
      loop: row.loop === true,
      enabled: row.enabled === true,
    });
  }
}
//#endregion

