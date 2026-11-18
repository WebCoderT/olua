import { levelConfigOf } from "../../../configs/game-config";
import type { Role } from "../../../entities/Role";

/**
 * 角色魔法值工具（静态类，纯数据操作）
 * 注意：角色在存储层是普通对象（StorageManager 每次从 localStorage 反序列化，见 getRoles），
 * 不具备 Role 的实例方法，所以魔法值的读写统一走这里，不要再在 Role 上挂实例方法。
 *
 * 魔法值的**增减全部归服务端**（#1136 批次 1）：施法扣蓝在施法闸（#813）、自然回复在
 * status-tick 每秒结算，权威值经 roleUpdate 帧回流 —— 客户端本地不扣也不回
 * （本地写一份再被权威帧覆盖就是「数值弹回」，#1133 实测）。这里只剩预判与兜底。
 */
export default class MpHelper {
  /** 补齐魔法值字段（新建角色自带；兼容魔法值上线前创建的旧存档） */
  static ensureDefaults(role: Role) {
    if (typeof role.maxMp !== "number") role.maxMp = levelConfigOf(role.level)?.maxMp ?? 0;
    if (typeof role.mp !== "number") role.mp = role.maxMp;
    if (typeof role.mpRecoverAccumulator !== "number") role.mpRecoverAccumulator = 0;
  }

  /** 魔法值是否足够（施法前的快捷预判；权威判定在服务端施法闸，被拒会带 need/have 回来） */
  static hasEnough(role: Role, cost: number): boolean {
    this.ensureDefaults(role);
    return role.mp >= cost;
  }
}
