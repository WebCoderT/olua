/**
 * 掉落规则（纯函数，**不 import 任何引擎与网络模块**）
 *
 * 为什么单独一个文件：这套判定要能被 `client/tools/test-drop-rule.cjs` 在 node 里直接跑
 * （沙箱只认不依赖 cc 的模块，见 tools/lib/configs-sandbox.cjs），而 `DropManager` 里
 * 每个方法都摸 `Node` / `Sprite`，一进去就编不动。判定本身是「时间 + 三个 id」的算术，
 * 与引擎无关，拆出来才能测真逻辑而不是复刻一份。
 *
 * ## 客户端预判的边界（#804，docs/18 §6.3 / §6.6）
 *
 * 这里的结论**只用来省请求**（别对着一件别人的掉落每帧发 pick 帧），**不是权限判断** ——
 * 能不能捡始终由服务端九步校验裁定。所以每个判不出来的分支都必须放行（fail-open）：
 * 时间戳缺失、账号未知、队伍未知一律 `true`。收紧这里不会让玩家更安全，只会让
 * 「明明能捡却捡不起来」这种问题藏进客户端。
 */

/** 本地预判的三种结论：可捡 / 还在保护期 / 本地已过期 */
export type LocalPickVerdict = true | "protected" | "expired";

/**
 * 一件掉落物的本地时间轴
 *
 * 全部是**相对量 + 本地时钟**（`receivedAt` 是收到 `dropSpawn` / `world` 那一刻的
 * `Date.now()`）：服务端给的 `protectUntil` / `expireAt` 是它自己的钟，客户端钟慢 3 分钟
 * 就会出现「东西还在却判过期」。绝对时间只用于排查，不参与判定。
 */
export interface DropTimeline {
  /** 收到这一件的本地时刻（毫秒） */
  receivedAt: number;
  /** 本地到期时刻 = receivedAt + expireInMs */
  expireAtLocal: number;
  /** 本地保护期结束时刻 = receivedAt + protectInMs */
  protectUntilLocal: number;
  /** 兜底隐藏时刻 = expireAtLocal + 宽限（服务端 dropRemove 没到时用它） */
  fallbackHideAt: number;
  /** 时间戳是否算出来了；false 时所有时间判定放行 */
  hasExpiry: boolean;
}

/** 兜底隐藏的宽限（毫秒）：服务端 `dropRemove` 丢失时，本地最多多留这么久 */
export const DROP_FALLBACK_GRACE_MS = 3000;

/**
 * 由「收到时刻 + 服务端给的相对量」算本地时间轴
 *
 * 相对量缺失或不是有限数（旧服务端 / 字段被裁掉）时 `hasExpiry = false` —— 不是当成 0，
 * 因为「0 毫秒后过期」会让一件正常掉落立刻被判 expired 并删掉。
 */
export function timelineOf(receivedAt: number, expireInMs: unknown, protectInMs: unknown): DropTimeline {
  const expire = typeof expireInMs === "number" && Number.isFinite(expireInMs) ? expireInMs : null;
  const protect = typeof protectInMs === "number" && Number.isFinite(protectInMs) ? protectInMs : null;
  if (expire === null) {
    return { receivedAt, expireAtLocal: 0, protectUntilLocal: 0, fallbackHideAt: 0, hasExpiry: false };
  }
  const expireAtLocal = receivedAt + Math.max(0, expire);
  // 保护期比过期还长时按过期截断（服务端 `protect = min(protectMs, ttl)` 同口径）
  const protectUntilLocal = receivedAt + Math.min(Math.max(0, protect ?? 0), Math.max(0, expire));
  return {
    receivedAt,
    expireAtLocal,
    protectUntilLocal,
    fallbackHideAt: expireAtLocal + DROP_FALLBACK_GRACE_MS,
    hasExpiry: true,
  };
}

/** `canPickLocally` 的输入：当前身份 + 这一件掉落物的归属与时间 */
export interface LocalPickInput {
  /** 现在（毫秒） */
  now: number;
  /** 我的账号 id（空串 = 还不知道自己是谁） */
  me: string;
  /** 我此刻所在的队伍 id（空串 = 没队伍 / 队伍状态还没到） */
  myPartyId: string;
  drop: {
    hasExpiry: boolean;
    expireAtLocal: number;
    protectUntilLocal: number;
    /** 归属者账号 id（空串 = 服务端没给） */
    ownerAccountId: string;
    /** 掉落那一刻归属者的队伍 id（空串 = 无队伍 / 字段没下发） */
    partyId: string;
  };
}

/**
 * 本地预判「这一件我现在能不能捡」（**只为省请求，见文件头**）
 *
 * 只有「明确是别人的、且明确还在保护期」才判 `protected`；任何一环判不出来就放行：
 * - 时间戳没算出来 → 放行（旧帧形状，服务端才是权威）
 * - 我自己是谁不知道 / 归属者账号为空 → 放行
 * - 归属者是我 → 恒可捡（**新手引导第 3 步就靠这条**：新号自己杀的怪归自己）
 * - 保护期已过 → 放行
 * - 掉落时同队（两边的队伍 id 都非空且相等）→ 放行
 */
export function canPickLocally(input: LocalPickInput): LocalPickVerdict {
  const { drop, now, me, myPartyId } = input;
  if (!drop.hasExpiry) return true;
  if (now >= drop.expireAtLocal) return "expired";
  if (!me || !drop.ownerAccountId) return true;
  if (drop.ownerAccountId === me) return true;
  if (now >= drop.protectUntilLocal) return true;
  if (drop.partyId && myPartyId && drop.partyId === myPartyId) return true;
  return "protected";
}

/**
 * 保护期还剩几秒（**向上取整**，给「还可拾取 N 秒」的提示用）
 *
 * 向上取整而不是向下：还剩 0.4 秒时提示「1 秒」比「0 秒」更像话（0 秒读起来像「现在就能捡」，
 * 但这时服务端还会拒）。已过保护期返回 0。
 */
export function protectSecondsLeft(protectUntilLocal: number, now: number): number {
  const left = protectUntilLocal - now;
  if (!(left > 0)) return 0;
  return Math.ceil(left / 1000);
}
