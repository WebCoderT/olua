import { Node, Size, Vec2 } from "cc";
import { Equipment, EQUIPMENT_TYPE } from "../../../types/good";
import { equipmentSlots } from "../../../configs/equipments";
import GameUiHelper from "../../helpers/GameUiHelper";

/** 装备槽分组方向（对应装备槽配置的 position） */
export type EquipmentSlotSide = "left" | "right" | "bottom";

/** 角色信息弹窗内三个装备槽分组的顺序 */
export const EQUIPMENT_SLOT_SIDES: EquipmentSlotSide[] = ["left", "right", "bottom"];

/** 槽位间距（弹窗内固定几何） */
const SLOT_SPACING = 10;

/** 各分组布局（弹窗内固定几何） */
const GROUP_LAYOUT: Record<EquipmentSlotSide, { name: string; position: Vec2; size: Size; horizontal: boolean }> = {
  left: { name: "equipment_slots_left", position: new Vec2(-240, 40), size: new Size(50, 290), horizontal: false },
  right: { name: "equipment_slots_right", position: new Vec2(80, 40), size: new Size(50, 290), horizontal: false },
  bottom: { name: "equipment_slots_bottom", position: new Vec2(-75, -140), size: new Size(170, 50), horizontal: true },
};

/**
 * 装备槽分组组件（自身即一个方向的槽位容器：左列/右列/底部横排）
 * 按方向取出装备槽配置生成槽位节点，并负责刷新单个槽位的装备显示
 * 槽位节点名称即装备槽位类型（EQUIPMENT_TYPE），便于按类型定位
 */
export default class EquipmentSlotGroup extends Node {
  /** 槽位节点（按装备槽位类型索引） */
  private slots = new Map<EQUIPMENT_TYPE, Node>();

  /**
   * @param side 分组方向
   * @param equipments 已穿戴装备（按槽位索引，未穿戴为 null）
   */
  constructor(side: EquipmentSlotSide, equipments: { [key in EQUIPMENT_TYPE]: Equipment | null }) {
    const layout = GROUP_LAYOUT[side];
    super(layout.name);
    if (layout.horizontal) GameUiHelper.applyRowStyle(this, SLOT_SPACING, layout.position, layout.size);
    else GameUiHelper.applyColumnStyle(this, SLOT_SPACING, layout.position, layout.size);
    equipmentSlots.forEach((slotConfig, type) => {
      // 只生成本方向的槽位，槽位顺序与配置顺序一致
      if (slotConfig.position !== side) return;
      const slot = GameUiHelper.createEquipmentSlot(type, slotConfig.imageSrc);
      this.slots.set(type, slot);
      this.addChild(slot);
      this.updateSlot(type, equipments[type]);
    });
  }

  /** 刷新槽位的装备显示（本分组无该槽位时忽略） */
  updateSlot(type: EQUIPMENT_TYPE, equipment: Equipment | null) {
    const slot = this.slots.get(type);
    if (!slot) return;
    slot.removeAllChildren();
    if (equipment) GameUiHelper.createGood(slot, equipment);
  }
}
