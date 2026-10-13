/**
 * 实时通道：协议与常量（**唯一来源**）
 *
 * 这一层刻意做得极薄 —— 它要解决的是「有一条随时能说话的管子」，不是「说话的内容」。
 * 因此协议只有三件事：
 *
 * 1. 连上先给一句 `welcome`（带上账号与心跳间隔，客户端据此配自己的定时器，
 *    而不是把间隔写死在客户端）；
 * 2. 客户端发 `ping`，服务端回 `pong` —— **应用层**心跳。浏览器拿不到协议层的 ping/pong 帧
 *    （那是 `ws` 自己处理的），客户端要量往返、要判断「多久没响应算掉线」，只能靠自己发；
 * 3. 其余一律回 `error` 帧，**不断开连接** —— 一条不认识的消息不该让玩家的通道断掉。
 *
 * 业务消息（战斗指令 / 结算结果等）在这条通道上跑，但协议**不在这里**，见 #34。
 */

/** 实时通道的路径段；HTTP 的取票据接口与 WS 的升级路径共用它（写在一处就不会两边对不上） */
export const REALTIME_PATH = "realtime";

/**
 * 一条连接代表的身份
 *
 * 由 HTTP 那侧（`POST /realtime/ticket`）填进来 —— 也就是 **AuthGuard 的结论**。
 * 实时通道自己不产生身份，只是把它带过握手这一段。
 */
export interface RealtimeIdentity {
  /** 账号 id */
  id: string;
  /** 账号名 */
  username: string;
}

/** 服务端 → 客户端：连接就绪 */
export interface RealtimeWelcomeMessage {
  type: "welcome";
  data: RealtimeWelcome;
}

export interface RealtimeWelcome {
  /** 连接代表的账号 id */
  userId: string;
  /** 账号名（客户端展示用） */
  username: string;
  /** 服务端存活探测间隔（毫秒），客户端据此决定自己的空闲判定 */
  heartbeatMs: number;
  /** 服务端当前时间（毫秒）—— 客户端可据此算一次性的时钟偏移 */
  serverTime: number;
}

/** 客户端 → 服务端：应用层心跳 */
export interface RealtimePingMessage {
  type: "ping";
}

/** 服务端 → 客户端：心跳应答 */
export interface RealtimePongMessage {
  type: "pong";
  data: {
    serverTime: number;
  };
}

/** 服务端 → 客户端：这条消息处理不了（连接照旧） */
export interface RealtimeErrorMessage {
  type: "error";
  data: {
    message: string;
  };
}

/** 服务端会发出的全部消息 */
export type RealtimeServerMessage = RealtimeWelcomeMessage | RealtimePongMessage | RealtimeErrorMessage;

/**
 * 关闭码
 *
 * `1001` 是标准码（对端要走）；`4000` 起是应用自定义段 —— 用来区分「服务端要关了」
 * 与「你这个账号在别处又连了一条」。客户端据此决定要不要立刻重连：
 * 被替换掉的那条连接**不该**马上抢回来（否则两条连接会互相踢，来回刷）。
 */
export const REALTIME_CLOSE = {
  /** 服务端正在关闭（优雅关闭时发这个） */
  GOING_AWAY: 1001,
  /** 同一账号的新连接上线，本条被替换 */
  REPLACED: 4000,
} as const;
