import { levelConfigOf } from "../../../configs/game-config";
import type { Role } from "../../../entities/Role";

/**
 * 角色血量工具（静态类，纯数据操作）
 *
 * 与 ui/utils/battle/MpHelper 同一套做法（角色在存储层是普通对象，两次读取之间是不同实例，
 * 所以读写统一走静态工具，不要往 Role 上挂实例方法）。
 *
 * 「每秒血量回复量」不是一个固定速度，而是**角色身上的一项属性**（role.hpRecover）：
 * 由等级曲线、防御装备、战魂、称号、军衔五处来源相加而成，权威值由服务端重算并经
 * roleUpdate 帧下发（#541，客户端只消费不下算）。
 *
 * 血量的**增减全部归服务端**（#1136 批次 1）：受击在实时进程落账（#323）、自然回复在
 * status-tick 每秒结算并落库 —— 客户端不再本地回血（本地算一份再被权威帧覆盖就是
 * 「数值弹回」，#1133 实测）。这里只剩字段兜底。
 */
export default class HpHelper {
  /** 补齐血量相关字段（新建角色自带；兼容每秒回血上线前创建的旧存档） */
  static ensureDefaults(role: Role) {
    if (typeof role.maxHp !== "number") role.maxHp = levelConfigOf(role.level)?.maxHp ?? 0;
    if (typeof role.hp !== "number") role.hp = role.maxHp;
    // 旧存档没有这一项：先按等级裸回血兜底（够用就不会显示 0），完整值由服务端 roleUpdate 帧覆盖
    if (typeof role.hpRecover !== "number") role.hpRecover = levelConfigOf(role.level)?.hpRecover ?? 0;
    if (typeof role.hpRecoverAccumulator !== "number") role.hpRecoverAccumulator = 0;
  }
}
