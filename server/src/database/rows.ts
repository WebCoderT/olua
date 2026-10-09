/** 数据库行类型（SQLite 列名是 snake_case，与对外 DTO 的 camelCase 分开，避免两套口径混用） */

export interface AccountRow {
  id: string;
  username: string;
  password: string;
  /** active | disabled */
  status: string;
  /** 当前选中（在线）的角色 id */
  online_role_id: string | null;
  /**
   * 令牌版本号（改密码时 +1）
   *
   * 令牌是无状态的，光改密码不会让已签发的旧令牌失效；签发时把版本号写进载荷、
   * 每次请求回查库比对，才能做到「改完密码旧设备立刻下线」（见 AuthGuard）。
   */
  token_version: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

export interface RoleRow {
  id: string;
  account_id: string;
  name: string;
  occupation: string;
  sex: string;
  level: number;
  /** 角色完整数据（客户端 entities/Role 的 JSON 快照；服务端按不透明文档存取） */
  data: string;
  /**
   * 修订号（每次落库 +1）
   *
   * 用途是**乐观锁**：客户端推进度时带上它读到的值，服务端发现对不上就拒收（见 BizCode.ROLE_REVISION_CONFLICT）。
   * 没有它的话，「管理员在后台改角色」与「玩家在游戏里每 1.5 秒推一次存档」会互相覆盖，
   * 谁最后写谁赢 —— 后台的改动静默丢失。
   */
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface AdminRow {
  id: string;
  username: string;
  password: string;
  /** active | disabled */
  status: string;
  /** 管理员角色：super_admin | admin | viewer（见 common/constants/permission） */
  role: string;
  /** 令牌版本号（改密码时 +1），含义同 AccountRow.token_version */
  token_version: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

/** 账号行 + 统计出来的角色数（列表接口用） */
export interface AccountWithCountRow extends AccountRow {
  role_count: number;
}

/** 角色行 + 所属账号名 / 账号当前在线角色（管理端列表用，一次查询拿全免得 N+1） */
export interface RoleWithAccountRow extends RoleRow {
  account_name: string | null;
  account_online_role_id: string | null;
}

/**
 * 操作日志行
 *
 * 设计取向：**把「当时发生了什么」原样冻住**，而不是只存外键。
 * `actor_name` / `target_id` 都冗余存一份 —— 操作人可能被删、目标角色可能被删，
 * 只留 id 的话事后谁也认不出这条记录说的是谁。目标当前的名字在查询时按 target_type 关联补。
 */
export interface AuditLogRow {
  id: string;
  /** 操作人 id / 用户名 / 角色（登录失败等匿名事件为空） */
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  /** 动作标识，直接复用接口的 operationId（如 adminRole.patch / auth.login） */
  action: string;
  /** 目标类型：account | role | admin（无目标为空） */
  target_type: string | null;
  target_id: string | null;
  /** 附加上下文（JSON 字符串）：请求体（已脱敏）或登录失败的用户名等 */
  detail: string | null;
  ip: string | null;
  method: string | null;
  path: string | null;
  /** HTTP 状态码 */
  status_code: number | null;
  /** 1 成功 / 0 失败 */
  success: number;
  error_code: number | null;
  error_message: string | null;
  created_at: number;
}

/** 操作日志行 + 关联出来的目标当前名字（目标已被删则为 null，界面退回显示 id） */
export interface AuditLogWithNameRow extends AuditLogRow {
  target_name: string | null;
}
