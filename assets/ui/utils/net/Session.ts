import { sys } from "cc";

/** 登录后保存的账号信息（服务端 AccountDto 的子集） */
export interface SessionAccount {
  id: string;
  username: string;
  status: string;
  onlineRoleId: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

/**
 * 会话（令牌 + 当前账号）
 *
 * 与角色数据分开存：角色在 StorageManager 的 roles 里（本地缓存，服务端为准），
 * 令牌只在登录场景写入、在请求层读取，两边互不覆盖。
 */
export default class Session {
  private static readonly TOKEN_KEY = "olua.token";
  private static readonly ACCOUNT_KEY = "olua.account";

  /** 访问令牌（未登录返回空串） */
  static get token(): string {
    return sys.localStorage.getItem(this.TOKEN_KEY) ?? "";
  }

  /** 是否已登录 */
  static get isLoggedIn(): boolean {
    return !!this.token;
  }

  /** 当前账号（解析失败返回 null） */
  static get account(): SessionAccount | null {
    const raw = sys.localStorage.getItem(this.ACCOUNT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionAccount;
    } catch {
      return null;
    }
  }

  /** 登录 / 注册成功后保存会话 */
  static save(token: string, account: SessionAccount) {
    sys.localStorage.setItem(this.TOKEN_KEY, token);
    sys.localStorage.setItem(this.ACCOUNT_KEY, JSON.stringify(account));
  }

  /** 更新账号信息（如在线角色变化） */
  static updateAccount(account: SessionAccount) {
    sys.localStorage.setItem(this.ACCOUNT_KEY, JSON.stringify(account));
  }

  /** 退出登录（清掉令牌与账号） */
  static clear() {
    sys.localStorage.removeItem(this.TOKEN_KEY);
    sys.localStorage.removeItem(this.ACCOUNT_KEY);
  }
}
