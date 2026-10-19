import { sys } from "cc";

/** 本机自动生成的账号凭据（服务端认的就是这一对账号 / 密码） */
export interface DeviceCredentials {
  /** 账号名（服务端 RegisterDto：3~20 位字母、数字或下划线） */
  username: string;
  /** 密码（服务端 RegisterDto：6~32 位） */
  password: string;
  /** 生成时间（毫秒时间戳，仅用于排查「这个号是什么时候在这台设备上建的」） */
  createdAt: number;
}

/**
 * 本机账号（登录页自动生成的账号密码）
 *
 * 玩法上不再让玩家注册 / 记密码，所以账号由本机生成、存在 localStorage 里，
 * 点「进入游戏」时拿它去 `POST /auth/login`；本地没有（或本地这份在服务端已不成立）就重新生成一套。
 *
 * 三个约束：
 * - **生成规则必须落在服务端 `RegisterDto` 的校验范围内**（账号 3~20 位 `/^[A-Za-z0-9_]{3,20}$/`、密码 6~32 位）。
 *   改这里之前先看 `server/src/modules/auth/dto/register.dto.ts`，否则注册会直接 400。
 * - **存储键与 Session 分开**（`olua.deviceAccount` vs `olua.account`）：Session 里那份是服务端返回的账号快照，
 *   `StorageManager.clear()` 会把它清掉；本机凭据必须活过「清缓存重新登录」，否则点一次清缓存就换号丢角色。
 * - 读**容错**：JSON 坏了、字段缺失一律当「本机没有账号」返回 null（调用方会重新生成），绝不抛异常 ——
 *   登录页是整个游戏的入口，这里抛错等于把玩家锁在门外。
 *
 * 随机用 `Math.random` 而不是 `crypto`：账号名只是个标识，撞名由服务端唯一性校验兜底（注册回 10001 会换一个重试），
 * 而 `crypto.getRandomValues` 在原生平台上并不保证存在。
 */
export default class DeviceAccount {
  private static readonly KEY = "olua.deviceAccount";
  /** 账号前缀（凑够长度、也便于在后台一眼认出是自动生成的号） */
  private static readonly USERNAME_PREFIX = "olua_";
  /** 账号随机段长度：前缀 5 位 + 10 位 = 15 位，落在服务端 3~20 位之内 */
  private static readonly USERNAME_RANDOM_LENGTH = 10;
  /** 密码长度：20 位，落在服务端 6~32 位之内 */
  private static readonly PASSWORD_LENGTH = 20;
  private static readonly ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

  /** 读本机凭据（没有 / 读不出来返回 null） */
  static load(): DeviceCredentials | null {
    const raw = sys.localStorage.getItem(this.KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<DeviceCredentials>;
      if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
      if (!parsed.username || !parsed.password) return null;
      return {
        username: parsed.username,
        password: parsed.password,
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      };
    } catch {
      return null;
    }
  }

  /** 存本机凭据（注册之前就落盘：注册响应丢失时下次还能用同一对账号去登录） */
  static save(credentials: DeviceCredentials) {
    sys.localStorage.setItem(this.KEY, JSON.stringify(credentials));
  }

  /** 清掉本机凭据（本地账号在服务端已不成立时调用，调用方随后会重新生成） */
  static clear() {
    sys.localStorage.removeItem(this.KEY);
  }

  /** 生成一套新的账号密码（只生成，不落盘） */
  static generate(): DeviceCredentials {
    return {
      username: this.USERNAME_PREFIX + this.random(this.USERNAME_RANDOM_LENGTH),
      password: this.random(this.PASSWORD_LENGTH),
      createdAt: Date.now(),
    };
  }

  /** 生成指定长度的随机小写字母 / 数字串 */
  private static random(length: number): string {
    let text = "";
    for (let index = 0; index < length; index++) {
      text += this.ALPHABET.charAt(Math.floor(Math.random() * this.ALPHABET.length));
    }
    return text;
  }
}
