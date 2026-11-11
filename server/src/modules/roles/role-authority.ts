/**
 * 角色存档的**权威边界**：谁能写哪个字段
 *
 * 背景：`PUT /roles/:id` 是「客户端推整份存档」的形态（`data` 是不透明文档），
 * 校验只到结构为止。于是同一个 `data` 里混着三类字段，处理方式**必须**不同 ——
 * 这一份就是那三条线的唯一定义，`save` 按它分流，改动也只改这里。
 *
 * | 类别 | 字段 | 权威 | 为什么 |
 * |---|---|---|---|
 * | 账本 | `bindGold`（唯一货币，#843、#844 收敛后 旧币种字段已删） | **服务端** | 商城、回收、成长线、任务、成就、邮件、后台都有各自的服务端写点；客户端只从 `roleUpdate` 帧照搬，**没有任何本地改写的代码**（`StorageManager.applyServerRoleUpdate` 是唯一入口）|
 * | 成长线阶位 | `title` / `soulOfWar` / `rank` | **服务端** | 只有 `RolesService.upgradeGrowth` 能推进（扣费 + 成长链校验都在那）；客户端 `upgradeGrowthOnServer` 只把服务端返回值抄回来 |
 * | 进度 | `level` / `exp` | **服务端** | 经验只由服务端结算（击杀 / 队友分账 / 任务 / 成就 / 邮件 / 后台），客户端**没有**本地加经验路径（#550 删掉了泡点组件与"实时通道不可用"的兜底；那条路上连伤害都不结算，留着只是给改包留门）|
 * | 背包与穿戴 | `bag` / `equipments` / `skills` | **服务端** | 穿戴 / 卸下 / 丢弃 / 整理 / 搬运五个动作全都走 `POST /roles/:id/bag-op`（#556），客户端不再本地改；`equipments` 还是属性重算的输入 —— 不收权等于把「塞一件没拥有的顶级装备」变成刷战力 |
 * | 派生值 | `combat` / `maxHp` / `hpRecover` / `maxMp` / 六项攻防 | **服务端重算** | 每次写档由 `applyAuthoritativeAttributes` 现算覆盖，**不走本文件的回填**（回填反而会把刚算好的值盖回旧的）|
 * | 血蓝 | `hp` / `mp`（+ 两个回复累加器与 `vitalsSettledAt` 游标） | **服务端结算**（#596） | 受击 / 用药 / 升级补满各有服务端写点，自然回复由 `settleVitalsAuthority` 在每次写档时按经过时间补齐，复活走 `POST /roles/:id/revive`；客户端那份只是血条平滑用的**演出预测**，save 时整体覆盖 |
 * | 时装 | `fashionCloth` / `fashionsOwned`（清单） | **服务端**（#596） | 购买（扣费 + 渠道校验）与穿脱（拥有才给穿）各有一个接口；清单是**独占字段**（上报整份删除），穿着态走回填。改穿在另一台设备发生时由 `roleUpdate` 帧带回，客户端换外观 |
 * | 体验状态 | `shortcutKeys` / `guide` / `soulShow` | 客户端书写、服务端存证（#596 云同步） | 纯本地体验（换设备要跟着走，但篡改无收益）；save 照收、`roleUpdate` 帧原样带回 |
 * | 客户端全权 | `onMap` / `avatar` / `speedRate` / `relationShip` | 客户端 | 走图 / 头像 / 速度倍率 / 关系展示都发生在本地且不改数值；`onMap` 的位置自报另有**互见最小仲裁**（实时侧：非有限拒绝、瞬移帧屏蔽、持续异常跟随，见 `player-presence.service`）。**进图门槛不读它**：门槛读服务端独占的 `mapAt`（#606，见下）|
 *
 * 两条纪律：
 *
 * 1. **回填而不是拒收**：客户端推上来的账本值与库里不一致时，用库里的值覆盖、继续落库。
 *    拒收（409）会把「客户端少收了一帧」这种无害情况变成玩不了；回填则下一次 `roleUpdate`
 *    就自动纠正。真正要拦的是「写进去」，不是「发过来」。
 * 2. **库里没有这个字段也不采信客户端那份**（#819 起）：一律按该字段的空值回填。
 *    老规则是「库里没有就放行，客户端那份是唯一来源」—— 它保的是服务端接管之前的本地档，
 *    但同一条规则也是「坏档 → 空档」的提权入口：`data` 解析失败被折成 `{}` 之后，
 *    每个字段都「库里没有」，改包只要制造一次坏档就能自己写绑定元宝 / 背包 / 装备。
 *    坏档现在在入口就被拦住（`decodeStoredRoleDataStrict` + 20029），这条通道没有了；
 *    真要救一个字段缺失的老号，走管理端 PATCH（人工决定），不要留一条自动通道。
 *
 * 建号（#597 起）不再是「客户端推一份初始存档」：入参只有名称 / 职业 / 性别，
 * 初始文档由服务端构造（`initial-role.ts`）—— 上面这条规则里「建号没有旧值可比」的
 * 例外口子（`clampInitialCurrency` / `pinInitialLevel`）随之整体退场。
 */

import { adoptBagShape, readBagGrid } from "./role-inventory";

/** 账本：只有服务端能改（客户端上报值一律丢弃）。货币收敛后只有 bindGold 一种（#843、#844） */
export const SERVER_LEDGER_FIELDS = ["bindGold"] as const;

/** 已删除的 legacy 账本键（#843、#844）：收权时顺手剥掉，不让改包的键随整份存档留在库里 */
export const LEGACY_LEDGER_FIELDS = ["gold", "silver"] as const;

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
 * 时装（#596）：穿着态 `fashionCloth` 与拥有清单 `fashionsOwned` 都归服务端
 *
 * - `fashionCloth`：穿 / 脱走 `POST /roles/:id/fashion-wear`（服务端校验「拥有才给穿」）；
 * - `fashionsOwned`：拥有清单只能由**购买**（`fashion-buy`）与**管理端发放**（PATCH）书写。
 *
 * `fashionCloth` 走普通的「回填」规则没问题 —— 存档里一直有这个键（#377 起建号就写 null）。
 * `fashionsOwned` 是新字段，没有「老档放行」可言：上线时不存在会写它的旧客户端，
 * 所以进 `SERVER_EXCLUSIVE_FIELDS` —— 库里没有就**删掉**上报值，而不是照单全收
 * （否则改包第一次 PUT 就能白得全部时装）。
 */
export const SERVER_FASHION_FIELDS = ["fashionCloth"] as const;

/**
 * 独占字段：库里没有也不放行（见 `SERVER_FASHION_FIELDS` 注释）
 *
 * - `fashionsOwned`：时装拥有清单，只能由购买 / 管理端发放写入；
 * - `mapAt`（#606）：**服务端承认的角色当前位置**，进图门槛拿它当「他现在在哪」。
 *   客户端连这个字段都不该知道 —— 唯一写点是「被接受的 worldJoin」（`RolesService.setMapAt`）
 *   与管理端摆位（PATCH 带 `onMap` 时一并写）。它一旦可被客户端书写，
 *   「改包先把位置改成高级图再登录进去」就绕过了门槛，整条收权白做。
 *
 *   注意它**不是** `onMap`：`onMap` 仍是客户端自报的位置（走图 / 统计 / 复活点都用它，
 *   见上表最后一行），`mapAt` 只回答「服务端认为你在哪」，两者故意分开 ——
 *   混成一个字段就只能在「相信客户端」和「不信客户端」之间二选一。
 */
export const SERVER_EXCLUSIVE_FIELDS = ["fashionsOwned", "mapAt"] as const;

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

/** 服务端独占的全部字段（= 账本 + 阶位 + 进度 + 背包穿戴 + 时装穿着；派生值另算） */
export const SERVER_OWNED_FIELDS: readonly string[] = [
  ...SERVER_LEDGER_FIELDS,
  ...SERVER_GROWTH_FIELDS,
  ...SERVER_PROGRESS_FIELDS,
  ...SERVER_INVENTORY_FIELDS,
  ...SERVER_FASHION_FIELDS,
];

/** 一次回填里的一个字段差异（只用于日志，不参与判定） */
export interface AuthorityDrift {
  field: string;
  /** 库里的值（权威） */
  stored: unknown;
  /** 客户端报上来的值（被丢弃） */
  reported: unknown;
}

/** 建号等级（#597 起由服务端构造初始文档时直接写死，不再有「客户端上报值」这回事） */
export const ROLE_INITIAL_LEVEL = 1;

/** 只认自有属性（`data.bindGold` 与 `data.toString` 不是一回事） */
function hasOwn(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * 某个服务端字段「空着」时该写什么（#819：库里没有这个键时的回填值）
 *
 * 每次都返回**新对象**：`bag` / `equipments` / `skills` 是会被后续步骤就地改写的结构，
 * 共享一个常量会把两个角色的数据串到一起。
 */
function emptyServerValueOf(field: string): unknown {
  if (field === "bag") return [];
  if (field === "equipments" || field === "skills") return {};
  if (field === "fashionCloth") return null;
  // 等级的空值是 1 而不是 0：`normalizeLevel` 的合法区间从 1 起，写 0 会让整次存档 400
  if (field === "level") return 1;
  return 0;
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
    const present = hasOwn(stored, field);
    if (present && sameValue(stored[field], incoming[field])) continue;
    drift.push({ field, stored: stored[field], reported: incoming[field] });
    if (!present) {
      // 库里没有这个字段（#819：不再放行客户端那份）→ 按空值回填，并记一条 drift 供排查
      incoming[field] = emptyServerValueOf(field);
      continue;
    }
    incoming[field] = field === "bag" ? reconcileBag(stored[field], incoming[field]) : stored[field];
  }
  for (const field of SERVER_EXCLUSIVE_FIELDS) {
    // 独占字段（#596 时装拥有清单）：库里没有就删掉上报值 —— 没有「老档放行」例外，
    // 否则改包第一次 PUT 就能把清单填满（见 SERVER_FASHION_FIELDS 注释）
    if (!hasOwn(stored, field)) {
      if (hasOwn(incoming, field)) {
        drift.push({ field, stored: undefined, reported: incoming[field] });
        delete incoming[field];
      }
      continue;
    }
    if (sameValue(stored[field], incoming[field])) continue;
    drift.push({ field, stored: stored[field], reported: incoming[field] });
    incoming[field] = stored[field];
  }
  // legacy 账本键（#843、#844 收敛）：gold / silver 已不是任何字段，上报值不回填也不放行 ——
  // 直接剥掉。旧档里残留的同名死键会在下一次整份保存时被这一步洗掉。
  for (const field of LEGACY_LEDGER_FIELDS) {
    if (hasOwn(incoming, field)) delete incoming[field];
  }
  return drift;
}

/** 回复结算的存档字段（服务端独占；客户端那份只是演出预测，save 时整体覆盖） */
export const SERVER_VITALS_FIELDS = [
  "hp",
  "mp",
  "hpRecoverAccumulator",
  "mpRecoverAccumulator",
  "vitalsSettledAt",
] as const;

/**
 * 血蓝收权（#596）：以**库里上次落账的值**为基线，按经过时间结算自然回复后覆盖上报值
 *
 * 血蓝的权威链路在 #596 之后是：
 * - 受击（怪 → 玩家）：实时进程 `applyMonsterHit` 落账（#323 起已有）；
 * - 用药：`useDrug` 落账（#308）；
 * - 升级补满：`applyKillExp` 落账（#316）；
 * - **自然回复：本函数在每次服务端写档时按「距上次结算的经过时间」补齐**（lazy 结算，
 *   不需要定时器 —— 上限夹取保证离开三天也只补到满，不会溢出）；
 * - 复活：`POST /roles/:id/revive` 满血（客户端改包上报满血无效）。
 *
 * 客户端存档里带的 hp / mp / 两个 accumulator 只是它的**演出预测**（本地按帧回血让血条平滑），
 * 一律丢弃。`vitalsSettledAt` 是结算游标：库里没有（部署后第一次写档）→ 不补发回复
 * （避免给老号白送一大段「离线回血」），只落一个当前时间当下次结算的起点。
 *
 * 死亡（基线 hp ≤ 0）不回复血量 —— 满血复活必须走 revive 接口；魔法照常回复（与客户端
 * MpHelper 同一口径，死亡流程不受蓝量影响）。
 *
 * 在**调用方**的顺序要求：`applyAuthoritativeAttributes` 之后调 —— 回复上限要用它算出的
 * maxHp / maxMp；算不出上限（等级在曲线外）时跳过回复、只落结算游标。之后仍要 `clampVitals`
 * 兜一道（本函数已保证区间内，这层纯防御）。
 *
 * @param stored  库里当前的存档文档
 * @param incoming 客户端上报、且**已完成属性权威重算**的文档（会被就地覆盖血蓝四件套）
 * @param now     本次结算时间（Date.now()，参数化只为测试可复现）
 * @param mpRecoverPerSecond 魔法自然回复速度（点/秒，管理端「成长配置」可改；缺省用出厂值）
 */
export function settleVitalsAuthority(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
  now: number,
  mpRecoverPerSecond: number,
): void {
  const settledAt = Number(stored.vitalsSettledAt);
  const baseHp = Math.max(0, Math.floor(Number(stored.hp) || 0));
  const baseMp = Math.max(0, Math.floor(Number(stored.mp) || 0));
  // 游标不存在（老档第一次过服务端 / 部署后首写）→ 不补发回复，只落游标
  const elapsed = Number.isFinite(settledAt) && settledAt > 0 ? Math.max(0, now - settledAt) : 0;

  const maxHp = Math.floor(Number(incoming.maxHp) || 0);
  const maxMp = Math.floor(Number(incoming.maxMp) || 0);
  // 上限算不出（等级不在成长曲线的边角档）→ 保留基线血蓝，别把人改没
  if (maxHp <= 0 || maxMp <= 0) {
    incoming.hp = baseHp;
    incoming.mp = baseMp;
    incoming.vitalsSettledAt = now;
    return;
  }

  // 生命：死亡不回复（复活走 revive 接口）；魔法照常
  const hpAccumulated = Math.max(0, Number(stored.hpRecoverAccumulator) || 0) +
    ((Number(incoming.hpRecover) || 0) * elapsed) / 1000;
  const hpGain = baseHp > 0 ? Math.floor(hpAccumulated) : 0;
  incoming.hp = Math.min(maxHp, baseHp + hpGain);
  incoming.hpRecoverAccumulator = hpGain > 0 ? hpAccumulated - hpGain : Math.min(hpAccumulated, 0.999);

  // 回复速度为负 = 配置拍错，按 0 处理（倒扣蓝比不回复更糟）
  const mpRate = Number.isFinite(mpRecoverPerSecond) ? Math.max(0, mpRecoverPerSecond) : 0;
  const mpAccumulated = Math.max(0, Number(stored.mpRecoverAccumulator) || 0) +
    (mpRate * elapsed) / 1000;
  const mpGain = Math.floor(mpAccumulated);
  incoming.mp = Math.min(maxMp, baseMp + mpGain);
  incoming.mpRecoverAccumulator = mpGain > 0 ? mpAccumulated - mpGain : Math.min(mpAccumulated, 0.999);

  incoming.vitalsSettledAt = now;
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
