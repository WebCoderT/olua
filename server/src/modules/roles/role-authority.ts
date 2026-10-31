/**
 * 角色存档的**权威边界**：谁能写哪个字段
 *
 * 背景：`PUT /roles/:id` 是「客户端推整份存档」的形态（`data` 是不透明文档），
 * 校验只到结构为止。于是同一个 `data` 里混着三类字段，处理方式**必须**不同 ——
 * 这一份就是那三条线的唯一定义，`save` 按它分流，改动也只改这里。
 *
 * | 类别 | 字段 | 权威 | 为什么 |
 * |---|---|---|---|
 * | 账本 | `gold` / `bindGold` / `silver` | **服务端** | 商城、回收、成长线、任务、成就、邮件、后台都有各自的服务端写点；客户端只从 `roleUpdate` 帧照搬，**没有任何本地改写的代码**（`StorageManager.applyServerRoleUpdate` 是唯一入口）|
 * | 成长线阶位 | `title` / `soulOfWar` / `rank` | **服务端** | 只有 `RolesService.upgradeGrowth` 能推进（扣费 + 成长链校验都在那）；客户端 `upgradeGrowthOnServer` 只把服务端返回值抄回来 |
 * | 进度 | `level` / `exp` | **服务端** | 经验只由服务端结算（击杀 / 队友分账 / 任务 / 成就 / 邮件 / 后台），客户端**没有**本地加经验路径（#550 删掉了泡点组件与"实时通道不可用"的兜底；那条路上连伤害都不结算，留着只是给改包留门）|
 * | 背包与穿戴 | `bag` / `equipments` / `skills` | **服务端** | 穿戴 / 卸下 / 丢弃 / 整理 / 搬运五个动作全都走 `POST /roles/:id/bag-op`（#556），客户端不再本地改；`equipments` 还是属性重算的输入 —— 不收权等于把「塞一件没拥有的顶级装备」变成刷战力 |
 * | 派生值 | `combat` / `maxHp` / `hpRecover` / `maxMp` / 六项攻防 | **服务端重算** | 每次写档由 `applyAuthoritativeAttributes` 现算覆盖，**不走本文件的回填**（回填反而会把刚算好的值盖回旧的）|
 * | 客户端全权 | `hp` / `mp` / `onMap` / `fashionCloth` / `soulShow` / `avatar` / `shortcutKeys` / `speedRate` / `guide` / `relationShip` | 客户端 | 走图、喝药回血、时装外观、引导推进**都发生在本地**，且都不改数值（`hp`/`mp` 只做夹取，见 `clampVitals`）；时装还没有「拥有清单」，收权要先把获取渠道做出来 |
 *
 * 两条纪律：
 *
 * 1. **回填而不是拒收**：客户端推上来的账本值与库里不一致时，用库里的值覆盖、继续落库。
 *    拒收（409）会把「客户端少收了一帧」这种无害情况变成玩不了；回填则下一次 `roleUpdate`
 *    就自动纠正。真正要拦的是「写进去」，不是「发过来」。
 * 2. **库里没有这个字段就放行**：老存档（服务端接管之前的本地档）第一次上传时，文档里
 *    没有 `bindGold` 这类键 —— 这时客户端那份就是唯一来源，删掉等于把玩家的钱清零。
 *    所以只在「服务端写过这个字段」之后才执行回填，其余情况原样放行并记一条 warn。
 *
 * 建号是这条规则的例外口子（库里还没有值可比）：账本由 `clampInitialCurrency` 封上界，
 * 等级由 `pinInitialLevel` 直接钉成出厂值 —— 两处都是「没有旧值可比，所以换个办法定死」。
 */

import { ROLE_INITIAL_CURRENCY } from "../../shared/game-data.generated";
import { adoptBagShape, readBagGrid } from "./role-inventory";

/** 账本：只有服务端能改（客户端上报值一律丢弃） */
export const SERVER_LEDGER_FIELDS = ["gold", "bindGold", "silver"] as const;

/** 成长线阶位：只有 `upgradeGrowth` 能推进 */
export const SERVER_GROWTH_FIELDS = ["title", "soulOfWar", "rank"] as const;

/**
 * 进度：经验与等级只由服务端结算（#550）
 *
 * `level` 还多一层：它在 `roles` 表里是**索引列**（列表排序 / 筛选都读它），
 * 存档文档里也有一份（客户端整份推上来）。所以回填之后，`save` 必须用文档里的新值
 * 重新取一次索引列 —— 否则「列表里的等级」与「详情里的等级」会各说一套。
 */
export const SERVER_PROGRESS_FIELDS = ["level", "exp"] as const;

/**
 * 背包与穿戴（#556）：五个写操作全在 `RolesService.bagOp`
 *
 * `equipments` 是**属性重算的输入**（`roleAttributeSourceOf` 直接读它），所以它必须与
 * 账本同权：否则「塞一件没拥有的顶级装备进文档」就等于白拿属性 —— #541 把算法收到
 * 服务端之后，这条路的收益反而被做实了。
 *
 * `skills` 目前客户端一个写点都没有（技能升级入口未开），但文档字段本身可写 ——
 * 改包填满级就能吃到伤害公式里。清单宁可比写点宽一格：宽了只是不允许本地改，
 * 窄了就是留一个没人看着的口子。
 */
export const SERVER_INVENTORY_FIELDS = ["bag", "equipments", "skills"] as const;

/**
 * 派生值：由 `applyAuthoritativeAttributes` 重算覆盖
 *
 * 这里**只登记**（给文档与审计一个可读清单），回填逻辑不碰它们 ——
 * 顺序上回填在前、重算在后，回填旧属性只会被重算再盖一次，纯属噪音。
 */
export const SERVER_DERIVED_FIELDS = [
  "combat",
  "maxHp",
  "hpRecover",
  "maxMp",
  "physicalAttack",
  "magicAttack",
  "taoistAttack",
  "physicalDefense",
  "magicDefense",
  "taoistDefense",
] as const;

/** 服务端独占的全部字段（= 账本 + 阶位 + 进度 + 背包穿戴；派生值另算） */
export const SERVER_OWNED_FIELDS: readonly string[] = [
  ...SERVER_LEDGER_FIELDS,
  ...SERVER_GROWTH_FIELDS,
  ...SERVER_PROGRESS_FIELDS,
  ...SERVER_INVENTORY_FIELDS,
];

/** 一次回填里的一个字段差异（只用于日志，不参与判定） */
export interface AuthorityDrift {
  field: string;
  /** 库里的值（权威） */
  stored: unknown;
  /** 客户端报上来的值（被丢弃） */
  reported: unknown;
}

/**
 * 建号时把账本夹到「配置给的起点」以内（就地改 `incoming`）
 *
 * 建号是**唯一**一处服务端没有旧值可比的地方（`enforceServerAuthority` 要有库里的值才回填），
 * 而建号这份存档同样是客户端构造出来推上来的 —— 把 `initialGold` 改成九位数就能开号即暴富。
 * 上界来自共享生成物的 `ROLE_INITIAL_CURRENCY`（客户端 `configs/role` 那三个常量），
 * 不在这里写死数字：改配置 → 重生成 → 两边同时变。
 *
 * 缺字段按「没提要求」处理 → 给出厂值（与「没有行 = 出厂值」同一口径），不是 0。
 */
export function clampInitialCurrency(incoming: Record<string, unknown>): void {
  for (const [field, ceiling] of Object.entries(ROLE_INITIAL_CURRENCY)) {
    const value = Number(incoming[field]);
    const normalized = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : ceiling;
    incoming[field] = Math.min(normalized, ceiling);
  }
}

/**
 * 建号时的出厂等级（与客户端 `Role.level` 的默认值同一个数）
 *
 * 建号请求里的 `level` **没有任何合法用途**：正常客户端是 `new Role()` 构造出来的，
 * 恒为 1；而接口是公开的 —— 放行等于「改个包就开号满级」（#554）。
 *
 * 满级号不只是个数字难看：`roles.level` 是索引列（门槛判定 / 排序 / 筛选全读它），
 * 而等级属性曲线只到 60 级（`ROLE_LEVEL_ATTRIBUTES`），曲线外的等级**算不出属性**，
 * `applyAuthoritativeAttributes` 会静默跳过 —— 客户端自报的战斗力就这样绕过重算落了库。
 *
 * 要「提等级」只有一条正规路径：管理端 `PATCH /admin/roles/:id`。
 */
export const ROLE_INITIAL_LEVEL = 1;

/** 建号等级钉死的结果（上报值只用于日志） */
export interface InitialLevelPin {
  /** 落库用的等级（恒为 `ROLE_INITIAL_LEVEL`） */
  level: number;
  /** 客户端这次上报的等级（没带就是 `undefined`，正常客户端就是这种情况） */
  reported: unknown;
}

/**
 * 把建号等级钉成出厂值（就地改 `incoming`）
 *
 * 与 `clampInitialCurrency` 的区别：账本是「夹到上界」（起点本身是个配置值），
 * 等级是「钉死」（起点只有一个值，没有可夹的区间）。
 */
export function pinInitialLevel(incoming: Record<string, unknown>): InitialLevelPin {
  const reported = incoming.level;
  incoming.level = ROLE_INITIAL_LEVEL;
  return { level: ROLE_INITIAL_LEVEL, reported };
}

/** 只认自有属性（`data.gold` 与 `data.toString` 不是一回事） */
function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** 值的比较：存档里的都是标量（数字 / 字符串 / 布尔），JSON 化后逐字比即可 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `bag` 的回填特例：**内容取库里的、尺寸取客户端这次的**
 *
 * 网格尺寸归客户端配置管（`bagRow × bagCol`，服务端不认识它 —— 见
 * `role-data.util.normalizeBagCells` 的注释）。整份照抄库里的值，第一次改格子数之后
 * 老角色的背包就永远不长个了；整份照抄客户端的，又等于把背包还给客户端。
 *
 * 两边都解析不出（库里的行坏了 / 客户端报了个不是二维数组的东西）→ 退回库里的原值，
 * 不用一个解析失败去拦掉整次存档：背包动不了总比玩不了强。
 */
export function reconcileBag(stored: unknown, incoming: unknown): unknown {
  try {
    return adoptBagShape(readBagGrid(stored, "库里的背包"), readBagGrid(incoming, "上报的背包"));
  } catch {
    return stored;
  }
}

/**
 * 把服务端独占字段以**库里的值**为准（就地改 `incoming`）
 *
 * @param stored  库里当前的存档文档（`decodeStoredRoleData(existing.data)`）
 * @param incoming 客户端这次推上来的、已通过结构校验的文档（会被就地修改）
 * @returns 被纠正的字段清单（空 = 客户端没动过这些字段，正常情况）
 */
export function enforceServerAuthority(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): AuthorityDrift[] {
  const drift: AuthorityDrift[] = [];
  for (const field of SERVER_OWNED_FIELDS) {
    // 服务端从没写过这个字段（老存档首次上传）→ 客户端那份是唯一来源，放行
    if (!hasOwn(stored, field)) continue;
    if (sameValue(stored[field], incoming[field])) continue;
    drift.push({ field, stored: stored[field], reported: incoming[field] });
    incoming[field] = field === "bag" ? reconcileBag(stored[field], incoming[field]) : stored[field];
  }
  return drift;
}

/**
 * 把血蓝夹回 `[0, 上限]`
 *
 * 血蓝的**当前值**归客户端（自然回复与技能扣减都在本地，服务端只做受击与用药两处减法），
 * 所以不能收权；但「超过上限」只可能是改包或者存档错乱 —— 客户端 `applyServerRoleUpdate`
 * 自己也做 `Math.min(hp, maxHp)`，服务端夹一次只是把同一条不变式补在写入侧。
 *
 * 必须在 `applyAuthoritativeAttributes` **之后**调用：上限是它算出来的。
 */
export function clampVitals(data: Record<string, unknown>): void {
  for (const [current, max] of [
    ["hp", "maxHp"],
    ["mp", "maxMp"],
  ] as const) {
    const ceiling = Number(data[max]);
    if (!Number.isFinite(ceiling) || ceiling <= 0) continue;
    const value = Number(data[current]);
    const normalized = Number.isFinite(value) ? Math.floor(value) : 0;
    data[current] = Math.min(Math.max(0, normalized), Math.floor(ceiling));
  }
}
