/**
 * 接口相关的常量（**手写**，不属于 OpenAPI 能描述的东西）
 *
 * 接口的路径 / 类型 / 方法都由 `tools/gen-api.cjs` 从服务端文档生成（见 ApiRoutes.ts、
 * ApiModels.ts、Api.ts），但下面三样是**客户端的本地约定**，服务端文档里没有它们的位置：
 *
 * - `ApiErrorTextKey`：请求层失败时的兜底文案 key（文案在 configs/texts）；
 * - `RELOGIN_BIZ_CODES`：命中就要回登录场景的业务码；
 * - `ROLE_SYNC_BIZ_CODES`：角色同步需要**特殊处理**（自愈）的业务码。
 *
 * 它们对应的服务端业务码定义在 `server/src/common/constants/biz-code.ts`，
 * 改服务端时要来这边同步（数字对不上就是静默失效，所以守卫脚本
 * `tools/audit-api-generated.cjs` 会比对这两边的码值）。
 */

/** 错误提示的兜底文案 key（登记在 configs/texts；服务端给了文案时优先用服务端的） */
export const ApiErrorTextKey = {
  unreachable: "net_unreachable_tip",
  timeout: "net_timeout_tip",
  parse: "net_parse_tip",
  unknown: "net_unknown_tip",
} as const;

/** 需要重新登录的业务码（服务端 common/constants/biz-code.ts 的子集） */
export const RELOGIN_BIZ_CODES = [
  40100, // 未登录（缺令牌）
  40101, // 令牌非法
  40102, // 令牌过期
  40103, // 令牌已被主动作废（管理员重置了密码）
  10004, // 账号被封禁
] as const;

/**
 * 需要**特殊处理**的角色业务码（服务端 common/constants/biz-code.ts 的子集）
 *
 * 这三个码意味着「本地存档已经不代表服务端现状」，所以不能当成普通失败提示一下就算了，
 * 见 utils/net/RoleSync 的处理分支。
 */
export const ROLE_SYNC_BIZ_CODES = {
  /**
   * 角色已被别处修改（乐观锁冲突）
   *
   * 玩家在游戏里、管理员在后台改了这个角色：本地那份存档是「改之前」的基线，
   * 直接推上去会把后台的改动覆盖掉，所以服务端拒收。
   */
  revisionConflict: 20006,
  /** 角色不存在（被后台删了）：本地还在玩一个已经被删掉的角色 */
  missing: 20002,
  /**
   * 角色已被管理员下线（账号的「在线角色」被清掉了）
   *
   * 与「角色不存在」必须分开处理：**角色本身还在**（可以重新选回来），
   * 清掉本地这个角色会把玩家辛苦练的号直接删了。
   */
  kicked: 20007,
} as const;
