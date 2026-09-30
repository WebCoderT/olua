import { Node, Size, Vec2 } from "cc";
import { Equipment, EQUIPMENT_TYPE } from "../../../types/good";
import { equipmentSlots } from "../../../configs/equipments";
import { cursorConfig, getGoodCursorStyle } from "../../../configs/cursor";
import CursorManager from "../../core/CursorManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { bindPointerAction } from "../../utils/input/Pointer";

/** 装备槽分组方向（对应装备槽配置的 position） */
export type EquipmentSlotSide = "left" | "right" | "bottom";

/** 角色信息弹窗内三个装备槽分组的顺序 */
export const EQUIPMENT_SLOT_SIDES: EquipmentSlotSide[] = ["left", "right", "bottom"];

/** 装备槽操作回调：右键点击槽位 = 脱下（由弹窗转交数据层判定与提示） */
export type EquipmentSlotHandler = (type: EQUIPMENT_TYPE) => void;

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
 * 槽位右键上报脱下操作（是否真能脱下由数据层判定）
 */
export default class EquipmentSlotGroup extends Node {
  /** 槽位节点（按装备槽位类型索引） */
  private slots = new Map<EQUIPMENT_TYPE, Node>();
  /** 槽位操作回调（右键脱下） */
  private onUnequip: EquipmentSlotHandler;

  /**
   * @param side 分组方向
   * @param equipments 已穿戴装备（按槽位索引，未穿戴为 null）
   * @param onUnequip 槽位右键操作回调
   */
  constructor(side: EquipmentSlotSide, equipments: { [key in EQUIPMENT_TYPE]: Equipment | null }, onUnequip: EquipmentSlotHandler) {
    const layout = GROUP_LAYOUT[side];
    super(layout.name);
    this.onUnequip = onUnequip;
    if (layout.horizontal) GameUiHelper.applyRowStyle(this, SLOT_SPACING, layout.position, layout.size);
    else GameUiHelper.applyColumnStyle(this, SLOT_SPACING, layout.position, layout.size);
    equipmentSlots.forEach((slotConfig, type) => {
      // 只生成本方向的槽位，槽位顺序与配置顺序一致
      if (slotConfig.position !== side) return;
      const slot = GameUiHelper.createEquipmentSlot(type, slotConfig.imageSrc);
      this.slots.set(type, slot);
      // 槽位内的装备图标是子节点，节点事件会冒泡到槽位本身，因此监听槽位即可
      bindPointerAction(
        slot,
        (button) => {
          if (button === "right") this.onUnequip(type);
        },
        this,
      );
      this.addChild(slot);
      this.updateSlot(type, equipments[type]);
    });
  }

  /** 刷新槽位的装备显示（本分组无该槽位时忽略） */
  updateSlot(type: EQUIPMENT_TYPE, equipment: Equipment | null) {
    const slot = this.slots.get(type);
    if (!slot) return;
    slot.removeAllChildren();
    CursorManager.unregisterHover(slot);
    if (!equipment) return;
    GameUiHelper.createGood(slot, equipment);
    // 鼠标移到已穿戴的装备上时显示装备对应的指针颜色（界面物品优先于世界对象）
    CursorManager.registerHover(slot, cursorConfig.priority.ui, () => getGoodCursorStyle(equipment.type));
  }
}
