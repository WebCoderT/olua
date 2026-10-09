import { levelMap } from "../../../configs/level";
import type { Role } from "../../../entities/Role";

/**
 * 角色血量工具（静态类，纯数据操作）
 *
 * 与 ui/utils/battle/MpHelper 同一套做法（角色在存储层是普通对象，两次读取之间是不同实例，
 * 所以读写统一走静态工具，不要往 Role 上挂实例方法；每次写都要配合
 * StorageManager.updateOnlineRole 落盘，否则下次读取会被覆盖）。
 *
 * 「每秒血量回复量」不是一个固定速度，而是**角色身上的一项属性**（role.hpRecover）：
 * 由等级曲线、防御装备、战魂、称号、军衔五处来源相加而成，见 ui/core/GameHelper.combatCalc。
 * 这里只负责按经过时间把它结算成血量。
 */
export default class HpHelper {
  /** 补齐血量相关字段（新建角色自带；兼容每秒回血上线前创建的旧存档） */
  static ensureDefaults(role: Role) {
    if (typeof role.maxHp !== "number") role.maxHp = levelMap.get(role.level)?.maxHp ?? 0;
    if (typeof role.hp !== "number") role.hp = role.maxHp;
    // 旧存档没有这一项：先按等级裸回血兜底（够用就不会显示 0），完整值由下一次 combatCalc 重算覆盖
    if (typeof role.hpRecover !== "number") role.hpRecover = levelMap.get(role.level)?.hpRecover ?? 0;
    if (typeof role.hpRecoverAccumulator !== "number") role.hpRecoverAccumulator = 0;
  }

  /**
   * 按经过时间自然回复血量（回复速度 = 角色的 hpRecover 属性，点/秒）
   * @param deltaMs 距离上次结算的毫秒数
   * @returns 本次是否回复了整数点血量（调用方据此决定是否落盘与刷新视图）
   */
  static recover(role: Role, deltaMs: number): boolean {
    this.ensureDefaults(role);
    // 死亡不回复：血量归零到复活之间绝不能被回血「拉起来」，否则会跟死亡流程（死亡动画 + 复活弹窗）打架
    if (role.hp <= 0 || role.maxHp <= 0) return false;
    if (role.hpRecover <= 0 || role.hp >= role.maxHp) return false;
    const accumulated = role.hpRecoverAccumulator + (role.hpRecover * deltaMs) / 1000;
    const gain = Math.floor(accumulated);
    role.hpRecoverAccumulator = accumulated - gain;
    if (gain <= 0) return false;
    role.hp = Math.min(role.maxHp, role.hp + gain);
    return true;
  }
}
