import { levelMap } from "../../../configs/level";
import { mpRecoverPerSecond } from "../../../configs/role";
import type { Role } from "../../../entities/Role";

/**
 * 角色魔法值工具（静态类，纯数据操作）
 * 注意：角色在存储层是普通对象（StorageManager 每次从 localStorage 反序列化，见 getRoles），
 * 不具备 Role 的实例方法，所以魔法值的读写统一走这里，不要再在 Role 上挂实例方法；
 * 另外所有写操作都要配合 StorageManager.updateOnlineRole 落盘，否则下次读取会被覆盖
 */
export default class MpHelper {
  /** 补齐魔法值字段（新建角色自带；兼容魔法值上线前创建的旧存档） */
  static ensureDefaults(role: Role) {
    if (typeof role.maxMp !== "number") role.maxMp = levelMap.get(role.level)?.maxMp ?? 0;
    if (typeof role.mp !== "number") role.mp = role.maxMp;
    if (typeof role.mpRecoverAccumulator !== "number") role.mpRecoverAccumulator = 0;
  }

  /** 魔法值是否足够 */
  static hasEnough(role: Role, cost: number): boolean {
    this.ensureDefaults(role);
    return role.mp >= cost;
  }

  /** 扣除魔法值（不足时不扣并返回 false） */
  static spend(role: Role, cost: number): boolean {
    if (cost <= 0) return true;
    if (!this.hasEnough(role, cost)) return false;
    role.mp -= cost;
    return true;
  }

  /**
   * 按经过时间自然回复魔法值（回复速度见 configs/role.mpRecoverPerSecond）
   * @param deltaMs 距离上次结算的毫秒数
   * @returns 本次是否回复了整数点魔法值（调用方据此决定是否落盘与刷新视图）
   */
  static recover(role: Role, deltaMs: number): boolean {
    this.ensureDefaults(role);
    if (mpRecoverPerSecond <= 0 || role.mp >= role.maxMp) return false;
    const accumulated = role.mpRecoverAccumulator + (mpRecoverPerSecond * deltaMs) / 1000;
    const gain = Math.floor(accumulated);
    role.mpRecoverAccumulator = accumulated - gain;
    if (gain <= 0) return false;
    role.mp = Math.min(role.maxMp, role.mp + gain);
    return true;
  }
}
