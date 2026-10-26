import type {
  GameConfigSnapshot,
  GrowthScalar,
  GrowthSegment,
  LevelExp,
  MallPriceItem,
  Rank,
  Soul,
  Title,
} from "../ui/utils/net/ApiModels";
import type { RankAttributes, RankLevelConfig } from "../types/rank";
import type { SoulAttributes, SoulLevelConfig } from "../types/soul";
import type { TitleAttributes, TitleLevelConfig } from "../types/title";
import { titleLevels } from "./title";
import { soulLevels } from "./soul";
import { rankLevels } from "./rank";
import { applyMallPricing } from "./mall";
import { attributeRange, roleGrowth, setRoleMaxLevel } from "./growth";
import { expGain, levelMap, rebuildLevelMap } from "./level";

/**
 * 服务端配置快照落库（#294）
 *
 * 进游戏时拉到 `gameConfig.snapshot` 后，把管理端可改的字段**原地覆写**进本地
 * 配置数据（titleLevels / soulLevels / rankLevels / 商城定价 / 成长曲线与等级经验）——消费方拿到的
 * 引用不变、读取函数签名不变，所以弹窗 / 战力计算 / 名牌外显零改动即读新值。
 *
 * 覆写是**逐条按 key 对齐**的：快照里没有的行（服务端与本地行数不一致时）保留
 * 本地值兜底，绝不因为下发数据缺行而让配置变成 undefined。
 * 表现层资源（animation 目录）服务端 seed 自客户端同一份数据，覆写无害；
 * 真正生效的是文案 / 价格 / 属性 / 渠道这些管理端可改字段。
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

/** 快照总入口：逐表覆写；某表缺失（undefined）时跳过该表，保留本地兜底 */
export function applyConfigSnapshot(snapshot: GameConfigSnapshot): void {
  if (snapshot.titles) applyTitleRows(snapshot.titles);
  if (snapshot.souls) applySoulRows(snapshot.souls);
  if (snapshot.ranks) applyRankRows(snapshot.ranks);
  if (snapshot.mallPrices && snapshot.mallSettings) {
    applyMallPrices(snapshot.mallPrices, snapshot.mallSettings.defaultPrice);
  }
  applyGrowthSnapshot(snapshot);
  // 装备 / 药品 / 物品 / 怪物 / NPC / 时装的覆写在后续 issue 扩展（#362）
  // （下发协议已就绪，逐表加 apply 函数即可）
}
