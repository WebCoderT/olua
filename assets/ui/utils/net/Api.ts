import HttpClient from "./HttpClient";
import { ApiRoutes } from "./ApiRoutes";

//#region 返回类型（与服务端 DTO 对应）

/** 账号信息 */
export interface AccountInfo {
  id: string;
  username: string;
  status: string;
  onlineRoleId: string | null;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

/** 登录 / 注册成功 */
export interface AuthResult {
  token: string;
  expiresIn: string;
  account: AccountInfo;
}

/** 角色概要（列表用，不含 data） */
export interface RoleSummary {
  id: string;
  accountId: string;
  name: string;
  occupation: string;
  sex: string;
  level: number;
  online: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 角色完整数据（data 就是客户端 entities/Role 的快照） */
export interface RoleDetail extends RoleSummary {
  data: Record<string, unknown>;
}

//#endregion

/** 认证接口（注册 / 登录 / 当前账号） */
export const AuthApi = {
  register: (username: string, password: string) => HttpClient.post<AuthResult>(ApiRoutes.auth.register, { username, password }, { auth: false }),
  login: (username: string, password: string) => HttpClient.post<AuthResult>(ApiRoutes.auth.login, { username, password }, { auth: false }),
  me: () => HttpClient.get<AccountInfo>(ApiRoutes.auth.me),
};

/**
 * 角色接口
 *
 * 服务端以令牌里的账号为准，所以这些方法都不带账号参数 —— 客户端也无法操作别人的角色。
 * 完整的角色对象由客户端按自身配置生成（见 entities/Role），服务端只校验结构、归属与数量上限。
 */
export const RoleApi = {
  /** 角色列表（概要） */
  list: () => HttpClient.get<RoleSummary[]>(ApiRoutes.role.list),
  /** 创建角色：role 是 new Role(...) 出来的完整对象 */
  create: (role: unknown) => HttpClient.post<RoleDetail>(ApiRoutes.role.create, { data: role }),
  /** 角色详情（完整数据） */
  detail: (id: string) => HttpClient.get<RoleDetail>(ApiRoutes.role.detail(id)),
  /**
   * 保存进度（全量覆盖）
   * @param id 角色 id
   * @param role 角色完整数据（entities/Role 的快照）
   * @param silent 后台同步用：失败不弹提示（由调用方自己决定，见 utils/net/RoleSync）
   */
  save: (id: string, role: unknown, silent = false) => HttpClient.put<RoleDetail>(ApiRoutes.role.save(id), { data: role }, { silent }),
  /** 选中（进入）角色：服务端同步在线角色并返回完整数据 */
  select: (id: string) => HttpClient.post<RoleDetail>(ApiRoutes.role.select(id)),
  /** 删除角色 */
  remove: (id: string) => HttpClient.del<null>(ApiRoutes.role.remove(id)),
  /** 当前在线角色（未选角色时为 null） */
  online: () => HttpClient.get<RoleDetail | null>(ApiRoutes.role.online),
};
