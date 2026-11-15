/**
 * 实时连接票据（#770 分片后改为**无状态加密票**）
 *
 * ===========================================================================
 * 为什么不能再用「进程内 Map」
 * ===========================================================================
 * 分片之后，取票请求可能落在**任意一个**实时进程上（nginx 只按路径分流，不知道玩家在哪个区），
 * 而握手一定落在**玩家那个区的进程**上。票据只存在发票那个进程的内存里 → 跨片必掉。
 *
 * 三种解法里选了「无状态票」：
 * - 库表（`realtime_tickets`）：跨进程天然一致，但每次连接多两次库写，还要一张清理表；
 * - 网关代转：把连接固定在网关、帧转发给分片 —— 等于每帧多一次跨进程往返，
 *   把 #767~#769 好不容易省下来的延迟又还回去（docs/28 §2.4 明确否掉）；
 * - **无状态票**：票自带结论（账号 / 区 / 过期时刻），任何分片都能独立解开，
 *   不需要共享存储。代价是「用掉即焚」只能靠**本进程**的 nonce 去重（见下）。
 *
 * ## 为什么是「加密」而不是「签名 + 明文」
 * 票一定要进 URL（WS 握手没法带自定义头），于是它会出现在 nginx 访问日志与浏览器历史里。
 * 签名票的 payload 是 base64url 的 JSON —— 谁看到 URL 谁就能读出账号 id 与**用户名**。
 * AES-256-GCM 一次把两件事都办了：内容不可读（保密）+ 篡改必失败（认证），
 * 仍然是**一个** URL 安全串、仍然无状态。（原来的随机字节票据之所以不可解析，
 * 也是同一个理由：URL 里的东西不该自己招供。）
 *
 * ## 一次性怎么保证
 * 无状态票理论上 30 秒内可以重复拿来连。但：
 * - 分片键是区，一张票只可能落在**一个**分片上（`shardOf(zoneId)`），所以
 *   「见过这个 nonce」这件事只需要**本进程**记得 —— 不需要跨片共享；
 * - 就算被重放，`adopt()` 的规则是「一个账号只留一条连接」，重放的结果只是把
 *   自己刚建的那条顶掉，拿不到第二个会话。所以重放不是提权，最多是自己踢自己。
 *
 * ## 为什么不复用 JWT
 * JWT 是给「长期凭证」用的（7 天、带 `aud`/`sub`/`ver`、能被到处校验）。票据要的恰恰相反：
 * 30 秒、一次性、只给握手用。拿 JWT 那套库来封装一个 30 秒的东西，会让人误以为它可以被
 * 别的接口接受 —— 一个专门的、格式极简的票据反而更难被误用。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** 票据里带的结论（字段名压短：解出来的 JSON 很短，URL 也就短） */
export interface TicketPayload {
  /** 账号 id */
  a: string;
  /** 账号名（welcome 帧与日志要用，省一次回查） */
  u: string;
  /** 玩家当前所在区（分片归属按它算，见 `shardOf`） */
  z: number;
  /** 一次性随机数（本进程 30 秒内去重） */
  n: string;
  /** 过期时刻（毫秒时间戳） */
  e: number;
}

/** GCM 的 IV 长度（96 位是 GCM 的推荐值）与认证标签长度 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** 新 nonce（16 字节足够，抗碰撞即可 —— 它不是密钥，只是一次性标记） */
export function newTicketNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** 由 `JWT_SECRET` 派生票据密钥（哈希一次：JWT 密钥可以任意长度，AES-256 只认 32 字节） */
function ticketKey(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** 封一张票：`base64url(IV ‖ 认证标签 ‖ 密文)` —— 一个串，URL 安全，内容不可读 */
export function sealTicket(payload: TicketPayload, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", ticketKey(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/**
 * 解票并校验
 *
 * 返回 `null` 表示「这张票不能信」—— 密文被动过 / 密钥不对 / 结构坏了 / 字段缺失，
 * **一律同一句话**：客户端只需要知道「重新取票」，区分具体原因只会让它多写一个分支，
 * 也等于告诉伪造者「你差在哪一步」。
 * **过期不在这里判**（由调用方判）：过期要给 `TOKEN_EXPIRED`（让客户端知道是等太久），
 * 而「解不开」要给 `TOKEN_INVALID`（让它知道这票有问题）—— 两个结论不能混。
 */
export function openTicket(ticket: string, secret: string): TicketPayload | null {
  const raw = Buffer.from(ticket, "base64url");
  // 太短的一律不是我们的票（也顺手挡住空串：GCM 至少要 IV + 标签）
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;

  let plain: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", ticketKey(secret), raw.subarray(0, IV_BYTES));
    // 标签不对时 final() 会抛：这就是「篡改必失败」的落点，不需要再自己比一遍
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as Partial<TicketPayload>;
  if (typeof payload.a !== "string" || payload.a === "") return null;
  if (typeof payload.u !== "string") return null;
  if (typeof payload.n !== "string" || payload.n === "") return null;
  if (!Number.isFinite(payload.z) || !Number.isFinite(payload.e)) return null;
  return { a: payload.a, u: payload.u, z: Number(payload.z), n: payload.n, e: Number(payload.e) };
}
