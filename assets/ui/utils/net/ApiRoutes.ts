/**
 * 路由表（客户端**唯一的接口路径来源**）
 *
 * 只登记路径，不带 host（host 在 configs/network）；请求层拼装时统一加前缀。
 * 新增接口在这里加一条，业务层不允许手写路径字符串。
 */
export const ApiRoutes = {
  /** 认证：注册 / 登录 / 当前账号 */
  auth: {
    register: "/auth/register",
    login: "/auth/login",
    me: "/auth/me",
  },
  /** 角色：客户端只能操作自己账号下的角色（服务端按令牌判定归属） */
  role: {
    /** 列表（概要，选角列表用） */
    list: "/roles",
    /** 创建（body 里的 data 是完整角色对象） */
    create: "/roles",
    /** 当前在线角色（完整数据） */
    online: "/roles/online",
    /** 详情（完整数据） */
    detail: (id: string) => `/roles/${encodeURIComponent(id)}`,
    /** 保存进度（全量覆盖） */
    save: (id: string) => `/roles/${encodeURIComponent(id)}`,
    /** 选中（进入）角色：服务端记为该账号的在线角色，返回完整数据 */
    select: (id: string) => `/roles/${encodeURIComponent(id)}/select`,
    /** 删除角色 */
    remove: (id: string) => `/roles/${encodeURIComponent(id)}`,
  },
} as const;

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
  10004, // 账号被封禁
] as const;

/**
 * 需要**特殊处理**的角色业务码（服务端 common/constants/biz-code.ts 的子集）
 *
 * 这两个码意味着「本地存档已经不代表服务端现状」，所以不能当成普通失败提示一下就算了，
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
} as const;
