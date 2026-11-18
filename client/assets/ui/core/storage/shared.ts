import { AttrPointKey } from "../../../types/role";
import { Goods, isEquipment } from "../../../types/good";
import { getEquipmentNameParts } from "../../../configs/equipments";


/**
 * 道具使用的连点节流（#847 / #848）
 *
 * **权威冷却在服务端**（药品读 `drugs.cooldown` 秒、货币道具固定 1 秒，超了回 20030 / 20031
 * 带剩余毫秒）。这里只做一件小事：一秒内对**同一个道具**的重复点击不再发请求，
 * 免得玩家连点时被同一个提示刷屏。键里带物品 id，所以先红后蓝照样能用。
 *
 * 用 1 秒而不是读配置：客户端快照里没有 `drugs.cooldown` 这一列，
 * 而猜短一点只是「偶尔被服务端拒一次」，猜长才会挡住正常操作。
 */
const USE_GUARD_MS = 1000;
const useGuardUntil = new Map<string, number>();

/**
 * 服务端下发的四维 → 本地那份（#833）
 *
 * 只做「收口成非负整数、只留四个键」，**不补任何策略**：四维怎么算都在服务端
 * （`common/utils/attr-points.util.ts`），客户端在这里做一次清洗只是为了让面板
 * 不出现 `undefined` / `NaN`。抽成函数是因为 `roleUpdate` 帧与加点回执两处都要用，
 * 抄两遍就会有一处漏掉某个键。
 */
export function attrAllocationFrom(value: unknown): Record<AttrPointKey, number> {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    str: Math.max(0, Math.floor(Number(source.str) || 0)),
    agi: Math.max(0, Math.floor(Number(source.agi) || 0)),
    vit: Math.max(0, Math.floor(Number(source.vit) || 0)),
    spi: Math.max(0, Math.floor(Number(source.spi) || 0)),
  };
}

/** 一秒内重复点同一个道具 → false（不发请求，也不弹提示） */
export function guardRepeatedUse(key: string): boolean {
  const now = Date.now();
  if ((useGuardUntil.get(key) ?? 0) > now) return false;
  useGuardUntil.set(key, now + USE_GUARD_MS);
  return true;
}

/** 物品展示名（装备 = 前缀 + 名称 + 后缀，段文案与配色同走 getEquipmentNameParts，与详情/地面掉落一致） */
export function getGoodDisplayName(good: Goods): string {
  if (!isEquipment(good)) return good.label;
  const parts = getEquipmentNameParts(good);
  return `${parts.prefix.label}${parts.label}${parts.suffix.label}`;
}
