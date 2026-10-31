import { Camera, Vec3 } from "cc";
import { TextRef } from "../../types/common";
import { Equipment } from "../../types/good";
import { OECCUPATION, SEX } from "../../types/role";
import StorageManager from "./StorageManager";
import { maps } from "../../configs/map";
import { getText, textRef } from "../../configs/texts";
import { MapId } from "../../types/map";

/**
 * 游戏工具（静态类）
 * 负责坐标系换算与装备校验（战斗属性/战斗力的计算在服务端，#541 —— 客户端只消费 roleUpdate 帧）
 */
export default class GameHelper {
  static camera: Camera | null = null;

  /** 初始化游戏全局工具 */
  static init(camera: Camera) {
    this.camera = camera;
  }

  /**
   * 屏幕坐标转世界坐标
   * 用途：把指针位置（屏幕坐标）换算到某个 UI 容器的本地坐标，例如拖动中的物品幽灵图标
   * 注意：反方向（世界 → 屏幕）**没有**配对接口，也不该有 —— 相机 worldToScreen 给出的是物理像素口径，
   * 与 UI 的设计坐标系差一个 view 缩放系数，拿它去摆 UI 会严重偏移（详情弹窗踩过这个坑）：
   * 要在屏幕中心系里定位一个界面元素，一律用「元素世界坐标 − LayerManager.UILayer 世界坐标」
   * （见 ui/utils/layout/ScreenLayout.getPopupPosition 与 HoverTipDialog.placeByAnchor）
   * @param screenPos 屏幕坐标（物理像素，与 EventMouse/EventTouch 的 getLocation 同口径）
   */
  static screenPositionToWorldPosition(screenPos: Vec3) {
    const worldPos = new Vec3();
    // 相机未就绪（进场景之前）时退回原点，调用方按父节点坐标系摆放即可，不会崩
    if (!this.camera) return worldPos;
    this.camera.screenToWorld(screenPos, worldPos);
    return worldPos;
  }

  /** 角色是否能穿上装备 */
  static checkRoleCanUseEquipment(equipment: Equipment) {
    return this.getEquipmentRejectReason(equipment) === null;
  }

  /**
   * 取装备不可穿戴的原因（可穿戴返回 null）
   * 判定项与顺序：等级 → 性别 → 职业
   * 只产出「用哪条文案 + 参数」（TextRef），具体中文取自 configs/texts，方便提示层直接展示
   * @param equipment 待校验装备
   */
  static getEquipmentRejectReason(equipment: Equipment): TextRef | null {
    const role = StorageManager.findOnlineRole();
    if (!role) return textRef("reject_no_role");
    if (equipment.level > role.level) return textRef("reject_equip_level", { level: equipment.level });
    if (equipment.sex !== role.sex && equipment.sex !== SEX.ALL) {
      return textRef("reject_equip_sex", { sex: getText(equipment.sex === SEX.BOY ? "label_sex_boy" : "label_sex_girl") });
    }
    if (equipment.occupation !== role.occupation && equipment.occupation !== OECCUPATION.ALL) return textRef("reject_equip_occupation");
    return null;
  }

  /**
   * 取进入地图的限制原因（满足条件返回 null）
   * 判定项与顺序：等级 → 战斗力 → 战魂等级；同样只产出 TextRef（见 getEquipmentRejectReason）
   * @param mapId 目标地图编号
   */
  static getMapEnterRejectReason(mapId: MapId): TextRef | null {
    const role = StorageManager.findOnlineRole();
    if (!role) return textRef("reject_no_role");
    const config = maps.get(mapId);
    if (!config) return textRef("reject_map_missing");
    if (config.level > role.level) return textRef("reject_map_level", { map: config.label, level: config.level });
    if (config.combat > role.combat) return textRef("reject_map_combat", { map: config.label, combat: config.combat });
    if (config.soulOfWar > role.soulOfWar) return textRef("reject_map_soul", { map: config.label, soul: config.soulOfWar });
    return null;
  }

}

