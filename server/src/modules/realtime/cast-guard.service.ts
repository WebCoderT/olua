import { Injectable } from "@nestjs/common";
import { RolesService } from "../roles/roles.service";

/**
 * 出手判定链的六道闸（#813 / docs/37 A1~A3）
 *
 * ===========================================================================
 * 为什么需要它
 * ===========================================================================
 * `settleNew` 原来只有「技能存在 → 目标存在 → 同区 → 目标活着 → 角色在线 → 已学习 →
 * 有系数 → 扣血」这几步：**冷却、耗蓝、距离、跨图、施法者存活、出手频率全都没有**。
 * 也就是说一份改了包的客户端可以无限施法、隔整张图打怪、尸体继续输出、单连接万次/秒。
 * 六道闸就是把这些「客户端本来会自己守、但服务端不能相信它守了」的规则搬到服务端。
 *
 * 顺序固定（A1）：`存活 → 跨图 → 距离 → 冷却 → 耗蓝 → 频率 → 结算`。
 * 依据是「越便宜、越不可能通过的先判」，且所有**会改状态**的动作（扣蓝、记冷却、扣令牌）
 * 都在最后一步统一提交 —— 前面任何一道失败都不需要回滚。
 *
 * **本轮落地五道，距离闸挂起**（#811 位置源收口后补第三道）：理由见下面第三道那段注释 ——
 * 位置是客户端 4Hz 自报的样本，与客户端自己的预测差一两拍，现在接上会把站在攻击边缘的
 * 正常出手判成超距。跨**图**的远程出手已经被跨图闸拦住（`mapAt` 是权威的），
 * 剩下的「同图隔远打」等 #811。
 *
 * ===========================================================================
 * 两个数值口径（都与客户端同源，不另立一份）
 * ===========================================================================
 * - **冷却**：`skills.cooldown`（秒）÷ `data.speedRate[skills.action]`。
 *   客户端 `SkillManager.getEffectiveCooldown` 就是这个式子（speedRate = 每秒循环数），
 *   基础剑术 `1.0s ÷ 4 = 250ms`。**不能直接用 cooldown**：那会把 4 刀/秒的攻速按 1 刀/秒判，
 *   正常玩家每次出手都被拒。
 * - **令牌桶**：容量 3、补充速率 = 上面那个有效冷却的倒数（基础攻速 = 4/秒）。
 *   A2 原文写的是「每秒补 1」，那等于全服 DPS 砍到 1/4（2026-11-08 拍板改为按攻速折算）：
 *   桶的职责是挡「比合法攻速更快」的连发，不是限速本身。
 *
 * ===========================================================================
 * 位置与死亡的来源（#811 之前是「够用」，不是「权威」）
 * ===========================================================================
 * - 跨图读存档 `data.mapAt`（服务端写，`worldJoin` 放行时才写）—— 这一条是权威的；
 * - 存活读存档 `data.hp`（`applyMonsterHit` 写的，权威）；
 * - 距离要读的坐标不是权威的（客户端自报），所以第三道挂起，见下。
 *
 * ===========================================================================
 * 状态的生命周期
 * ===========================================================================
 * 冷却与令牌桶都是**进程内内存态**：重启丢一次（玩家多放一次技能）可接受，与掉落那套
 * 「重启清场」同取向。断线清掉（不占内存），**换图不重置**（A2：否则换图刷桶）。
 */

/** 六道闸的拒绝原因（A3：settle 帧的 `rejected` 取值，不新增帧类型） */
export type CastRejectReason = "dead" | "cross_map" | "range" | "cooldown" | "mp" | "rate";

/** 判定结果：放行，或带原因的拒绝 */
export type CastGuardVerdict =
  | { ok: true }
  | {
      ok: false;
      rejected: CastRejectReason;
      message: string;
      /** 冷却闸专用：还要等多少毫秒（客户端可用来转圈，不至于一排红字） */
      remainMs?: number;
      /** 耗蓝闸专用：这一发需要多少法力 */
      need?: number;
      /** 耗蓝闸专用：当前法力 */
      have?: number;
    };

/** 一次出手要判的输入（全部来自服务端自己的对象，不信任客户端传参） */
export interface CastGuardInput {
  accountId: string;
  /** 技能配置行（`skillOf` 的结果；调用方已确认真实存在） */
  skill: Record<string, unknown>;
  skillId: string;
  /** 角色存档（`RoleDto.data`）：hp / mp / mapAt / speedRate 都在里面 */
  roleData: Record<string, unknown>;
  /** 目标实例的当前坐标与所在地图（世界服务持有） */
  target: { mapId: string; x: number; y: number };
}

/** 令牌桶容量（A2）：只用来吸收网络抖动，不是「每秒能放几次」 */
const CAST_BUCKET_CAPACITY = 3;

/**
 * 补充速率的防御性上限（次/秒）
 *
 * 运营把某个技能冷却调到 0 时「1/冷却」会变成无穷大 —— 那会让令牌桶彻底失效。
 * 20 次/秒已经远高于任何合法攻速（当前最快的 0.25s 一刀 = 4 次/秒），
 * 到这个量级只可能是配置手滑。
 */
const CAST_TOKENS_MAX_PER_SEC = 20;

@Injectable()
export class CastGuardService {
  /** `账号:技能id` → 上次被接受的出手时刻（毫秒） */
  private readonly lastCastAt = new Map<string, number>();
  /** 账号 → 令牌桶（容量 3；补充速率随所施技能的攻速走） */
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly roles: RolesService) {}

  /**
   * 判一次出手能不能打出去（不改世界状态，只改判定链自己的三样东西：冷却、令牌、法力）
   *
   * 放行时副作用已经提交（冷却记上、令牌扣掉、法力扣掉）；拒绝时**什么都没动**。
   */
  guard(input: CastGuardInput): CastGuardVerdict {
    const now = Date.now();

    // —— 一、施法者存活（存档里的 hp 是服务端写的，权威）——
    const hp = Math.floor(Number(input.roleData.hp) || 0);
    if (hp <= 0) {
      return { ok: false, rejected: "dead", message: "角色已死亡，不能出手（先复活）" };
    }

    // —— 二、跨图：目标必须在自己**服务端记下的位置**那张图上 ——
    // `mapAt` 是 worldJoin 放行时写进去的（#606）；没有这个键（老档 / 刚建号）时不拦，
    // 与进图门槛的纪律一致（那一刻“他在哪”还没有服务端的答案，拦下来只会误伤）。
    const mapAt = typeof input.roleData.mapAt === "string" ? input.roleData.mapAt : "";
    if (mapAt && mapAt !== input.target.mapId) {
      return {
        ok: false,
        rejected: "cross_map",
        message: `目标在 ${input.target.mapId}，你在 ${mapAt}（服务端只认自己放行过的图）`,
      };
    }

    // —— 三、距离：**这一步暂时空着，#811 落地后接上** ——
    // 判据本来很简单（`skills.distance > 0` 且超出就拒），问题在**位置源还不是权威**：
    // 现在的坐标是客户端 4Hz 自报 + 最小仲裁（`presence.positionOf`），与客户端自己的
    // 预测位置差一拍到两拍；怪物位置又是服务端 AI 模拟的。两边各差一拍，站在攻击边缘的
    // 正常出手就会被判成超距 —— 而「打不出伤害」比「漏判一次远程出手」难受得多。
    // 所以距离闸随 #811（位置源收口：单帧即拒 + `posCorrect` 硬拉回 + AI 只读仲裁后坐标）
    // 一起上；在那之前，跨**图**的远程出手已经被上面第二道拦住（`mapAt` 是权威的），
    // 剩下的只是「同一张图里隔远打」，等 #811 补齐。重开条件：`#811` 合并。
    //
    // 保留这段说明而不是直接删掉的理由：A1 的顺序里它就是第三道，接上时插在这里即可
    // （在存活、跨图之后，冷却之前），不需要重排。

    // —— 四、冷却（配置冷却 ÷ 动作速度倍率，与客户端 getEffectiveCooldown 同式）——
    const cooldownMs = this.cooldownMsOf(input.skill, input.roleData);
    if (cooldownMs > 0) {
      const key = `${input.accountId}:${input.skillId}`;
      const last = this.lastCastAt.get(key);
      if (last !== undefined && now - last < cooldownMs) {
        const remainMs = Math.ceil(cooldownMs - (now - last));
        return {
          ok: false,
          rejected: "cooldown",
          message: `${input.skillId} 冷却中，还需 ${remainMs}ms`,
          remainMs,
        };
      }
    }

    // —— 五、耗蓝：先只读判「够不够」，真正扣在最后统一提交 ——
    const mpCost = Math.max(0, Math.floor(Number(input.skill.mpCost) || 0));
    if (mpCost > 0) {
      const vitals = this.roles.vitalsOf(input.accountId);
      if (!vitals) {
        return { ok: false, rejected: "mp", message: "读不到在线角色的法力，无法施法" };
      }
      if (vitals.mp < mpCost) {
        return {
          ok: false,
          rejected: "mp",
          message: `法力不足：需要 ${mpCost}，当前 ${vitals.mp}`,
          need: mpCost,
          have: vitals.mp,
        };
      }
    }

    // —— 六、频率（令牌桶；补充速率 = 该技能的有效攻速）——
    const tokensPerSecond = cooldownMs > 0 ? 1000 / cooldownMs : CAST_TOKENS_MAX_PER_SEC;
    const bucket = this.takeBucket(input.accountId, now, tokensPerSecond);
    if (bucket.tokens < 1) {
      return {
        ok: false,
        rejected: "rate",
        message: "出手太快（超出任何合法攻速的连发被丢弃）",
      };
    }

    // —— 全部通过：统一提交副作用 ——
    if (mpCost > 0 && !this.roles.spendCastMp(input.accountId, mpCost)) {
      // 极端竞态（两个帧同时到、蓝只够一次）：这一发按蓝不足拒，冷却与令牌不记
      return { ok: false, rejected: "mp", message: `法力不足：需要 ${mpCost}`, need: mpCost };
    }
    bucket.tokens -= 1;
    if (cooldownMs > 0) this.lastCastAt.set(`${input.accountId}:${input.skillId}`, now);
    return { ok: true };
  }

  /** 连接断开：清掉本账号的冷却与令牌桶（内存不陪断线玩家涨；换图**不**清，见文件头） */
  dropAccount(accountId: string): void {
    this.buckets.delete(accountId);
    const prefix = `${accountId}:`;
    for (const key of [...this.lastCastAt.keys()]) {
      if (key.startsWith(prefix)) this.lastCastAt.delete(key);
    }
  }

  //#region 内部

  /**
   * 这个技能的实际冷却（毫秒）= `cooldown × 1000 ÷ speedRate[action]`
   *
   * speedRate 是「每秒循环数」（客户端 `EffectManager.actionDuration` 用 `1 / rate` 算
   * 动作时长，同一口径）。缺这个键 / 值 <= 0 时按 1 处理，与客户端 `(rate > 0 ? rate : 1)` 一致。
   */
  private cooldownMsOf(skill: Record<string, unknown>, roleData: Record<string, unknown>): number {
    const seconds = Number(skill.cooldown);
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    const action = typeof skill.action === "string" ? skill.action : "";
    const rates = roleData.speedRate;
    const raw = action && rates && typeof rates === "object"
      ? Number((rates as Record<string, unknown>)[action])
      : 1;
    const rate = Number.isFinite(raw) && raw > 0 ? raw : 1;
    return (seconds * 1000) / rate;
  }

  /**
   * 取这个账号的令牌桶并按时间补令牌（懒补充：不跑定时器，出手时才结算）
   *
   * 补充速率每次现算（随所施技能的攻速）：`tokens += (now - at) / 1000 × perSecond`。
   * 这样玩家在「4 刀/秒」与「1/60 秒的增益技能」之间切换时，桶始终按当前合法攻速补充，
   * 不会因为上一次放的是慢技能就长期欠账。
   */
  private takeBucket(accountId: string, now: number, tokensPerSecond: number): { tokens: number; at: number } {
    const existed = this.buckets.get(accountId);
    if (!existed) {
      const fresh = { tokens: CAST_BUCKET_CAPACITY, at: now };
      this.buckets.set(accountId, fresh);
      return fresh;
    }
    const rate = Math.min(CAST_TOKENS_MAX_PER_SEC, Math.max(0, tokensPerSecond));
    const gained = ((now - existed.at) / 1000) * rate;
    existed.tokens = Math.min(CAST_BUCKET_CAPACITY, existed.tokens + Math.max(0, gained));
    existed.at = now;
    return existed;
  }

  //#endregion
}
