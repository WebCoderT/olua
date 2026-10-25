import type { GameConfigSnapshot, MallPriceItem, Rank, Soul, Title } from "../ui/utils/net/ApiModels";
import type { RankAttributes, RankLevelConfig } from "../types/rank";
import type { SoulAttributes, SoulLevelConfig } from "../types/soul";
import type { TitleAttributes, TitleLevelConfig } from "../types/title";
import { titleLevels } from "./title";
import { soulLevels } from "./soul";
import { rankLevels } from "./rank";
import { applyMallPricing } from "./mall";

/**
 * 服务端配置快照落库（#294）
 *
 * 进游戏时拉到 `gameConfig.snapshot` 后，把管理端可改的字段**原地覆写**进本地
 * 配置数据（titleLevels / soulLevels / rankLevels / 商城定价）——消费方拿到的
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

/** 快照总入口：逐表覆写；某表缺失（undefined）时跳过该表，保留本地兜底 */
export function applyConfigSnapshot(snapshot: GameConfigSnapshot): void {
  if (snapshot.titles) applyTitleRows(snapshot.titles);
  if (snapshot.souls) applySoulRows(snapshot.souls);
  if (snapshot.ranks) applyRankRows(snapshot.ranks);
  if (snapshot.mallPrices && snapshot.mallSettings) {
    applyMallPrices(snapshot.mallPrices, snapshot.mallSettings.defaultPrice);
  }
  // 装备 / 药品 / 物品 / 怪物 / NPC / 时装 / 成长曲线的覆写在后续 issue 扩展
  // （下发协议已就绪，逐表加 apply 函数即可）
}
