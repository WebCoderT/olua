/**
 * 货币物品（绑定元宝 / 元宝 / 银子）—— 出厂清单与取值域
 *
 * ===========================================================================
 * 这是什么
 * ===========================================================================
 * 背包里可以「使用」的道具，使用后直接给角色账本入账一笔钱：
 *
 * · `bindGold` → 绑定元宝（`data.bindGold`，商城 / 成长线扣的就是它）
 * · `gold`     → 元宝（`data.gold`）
 * · `silver`   → 银子（`data.silver`）
 *
 * 每种货币 8 种面值（10 / 50 / 100 / 200 / 500 / 1000 / 5000 / 100000），
 * 共 24 条。**行本身归运营**：管理端「货币物品」页可新建 / 删除 / 改数值，
 * 这里的清单只是**出厂快照**（见下面「两处清单」）。
 *
 * ===========================================================================
 * 为什么清单在这里（而不是只躺在 config-sync.sql）
 * ===========================================================================
 * 口径仍然是「库里是权威，`config-sync.sql` 是出厂快照」—— 新库首启把快照整份灌进去。
 * 但这张表是**后加的**：已经跑过很久的库不会再自举（`config_snapshot` 有 marker），
 * 光改快照文件的话，存量库重启后既没有这张表的数据、也没有任何报错，
 * 表现就是「管理端货币物品页空白、使用道具入不了账」。
 *
 * 所以 `DatabaseService.migrate()` 在建表之后补一段 `INSERT OR IGNORE`（见那里的注释），
 * 那条 DDL 块与这份清单是同一份——新增 / 调面值只改这里。
 *
 * ⚠ 空库不受影响：自举的 SQL 是「DELETE + INSERT」，会把这条兜底插入的行整表替换掉，
 *   所以两处**不会叠加成双份**。`server/test/config-sync.cjs` 会比对两边逐行一致。
 */

/** 三种货币（取值 = 角色存档 `data` 里的字段名，服务端账本字段也是这三个） */
export const MONEY_KINDS = ["bindGold", "gold", "silver"] as const;

/** 货币类型 */
export type MoneyKind = (typeof MONEY_KINDS)[number];

/** 货币中文名（管理端下拉、客户端提示、出厂名称都用这一份） */
export const MONEY_KIND_LABELS: Record<MoneyKind, string> = {
  bindGold: "绑定元宝",
  gold: "元宝",
  silver: "银子",
};

/** 出厂面值（8 档；运营可以自己再加别的面值） */
export const MONEY_AMOUNTS = [10, 50, 100, 200, 500, 1_000, 5_000, 100_000] as const;

/** 单件金额上限（防御性：账本字段是整数，100 万够任何面值用） */
export const MONEY_AMOUNT_MAX = 1_000_000;

/** 单格叠加上限（货币道具是叠着用的，不占格子） */
export const MONEY_ITEM_STACK_MAX = 999;

/** 名称 / 描述长度上限（与药品 / 物品同一档） */
export const MONEY_ITEM_LABEL_MAX = 20;
export const MONEY_ITEM_DESCRIPTION_MAX = 200;

/** id 形状：小写字母开头，字母数字下划线（与装备 / 药品的 id 风格一致） */
export const MONEY_ITEM_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/** 一条货币物品（出厂清单的行形状；与 `money_items` 表逐列对应） */
export interface MoneyItemSeed {
  id: string;
  label: string;
  description: string;
  icon: string;
  currency: MoneyKind;
  amount: number;
  maxStack: number;
  sellPrice: number;
}

/** 货币 id 前缀（`money_bind_gold_10` 里的 `bind_gold`） */
const CURRENCY_ID_PART: Record<MoneyKind, string> = {
  bindGold: "bind_gold",
  gold: "gold",
  silver: "silver",
};

/** 图标文件名前缀（resources 命名纪律：全小写 + 连字符，见 client/RESOURCES.md） */
const CURRENCY_ICON_PART: Record<MoneyKind, string> = {
  bindGold: "bind-gold",
  gold: "gold",
  silver: "silver",
};

/**
 * 按货币 + 面值生成一条出厂行
 *
 * id / 图标路径都由这两个值派生，所以「同一种货币的 8 档」天然成套；
 * 运营在管理端新建时也走同一个派生（见 `GameConfigService.createMoneyItem`）。
 */
export function moneyItemSeedOf(currency: MoneyKind, amount: number): MoneyItemSeed {
  const label = `${MONEY_KIND_LABELS[currency]}（${amount}）`;
  return {
    id: `money_${CURRENCY_ID_PART[currency]}_${amount}`,
    label,
    description: `使用后获得 ${amount} 点${MONEY_KIND_LABELS[currency]}。`,
    icon: `item/currency/${CURRENCY_ICON_PART[currency]}-${amount}`,
    currency,
    amount,
    maxStack: MONEY_ITEM_STACK_MAX,
    sellPrice: 0,
  };
}

/** 出厂清单：3 种货币 × 8 档面值 = 24 条（顺序即列表默认顺序：货币 → 面值升序） */
export const MONEY_ITEM_SEEDS: MoneyItemSeed[] = MONEY_KINDS.flatMap((currency) =>
  MONEY_AMOUNTS.map((amount) => moneyItemSeedOf(currency, amount)),
);
