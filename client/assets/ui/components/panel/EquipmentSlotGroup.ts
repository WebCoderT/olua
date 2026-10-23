import { Node } from "cc";
import { Equipment, EQUIPMENT_TYPE } from "../../../types/good";
import { equipmentSlots } from "../../../configs/equipments";
import { getEquipment } from "../../../configs/items";
import { cursorConfig, getGoodCursorStyle } from "../../../configs/cursor";
import CursorManager from "../../core/CursorManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { bindPointerAction } from "../../utils/input/Pointer";
import { clearChildren } from "../../utils/node/NodeTree";
import { equipmentSlotLayout } from "../../../configs/hudLayout";

/** 装备槽分组方向（对应装备槽配置的 position） */
export type EquipmentSlotSide = "left" | "right" | "bottom";

/** 角色信息弹窗内三个装备槽分组的顺序（配置在 configs/hudLayout.equipmentSlotLayout.sides） */
export const EQUIPMENT_SLOT_SIDES: EquipmentSlotSide[] = equipmentSlotLayout.sides;

/** 装备槽操作回调：右键点击槽位 = 脱下、左键点击提示角标 = 换上更好的（由弹窗转交数据层判定与提示） */
export type EquipmentSlotHandler = (type: EQUIPMENT_TYPE) => void;

/**
 * 装备槽分组组件（自身即一个方向的槽位容器：左列/右列/底部横排）
 * 按方向取出装备槽配置生成槽位节点，并负责刷新单个槽位的装备显示
 * 槽位节点名称即装备槽位类型（EQUIPMENT_TYPE），便于按类型定位
 * 槽位右键上报脱下操作（是否真能脱下由数据层判定）；
 * 槽位右上角的「更好装备」角标（背包里有更好的可穿装备时由弹窗点亮）左键上报一键替换
 */
export default class EquipmentSlotGroup extends Node {
  /** 槽位节点（按装备槽位类型索引） */
  private slots = new Map<EQUIPMENT_TYPE, Node>();
  /** 「更好装备」提示角标（按装备槽位类型索引；updateSlot 清格子后重挂，常驻子节点只切显隐） */
  private hints = new Map<EQUIPMENT_TYPE, Node>();
  /** 槽位操作回调（右键脱下 / 角标左键替换） */
  private onUnequip: EquipmentSlotHandler;
  private onEquipBetter: EquipmentSlotHandler;

  /**
   * @param equipments 已穿戴装备（按槽位存装备 id，未穿戴为 null；装备数据经配置表实时解析）
   * @param onUnequip 槽位右键操作回调
   * @param onEquipBetter 提示角标左键操作回调（是否真有更好的装备由数据层判定）
   */
  constructor(
    side: EquipmentSlotSide,
    equipments: { [key in EQUIPMENT_TYPE]: string | null },
    onUnequip: EquipmentSlotHandler,
    onEquipBetter: EquipmentSlotHandler,
  ) {
    const layout = equipmentSlotLayout.groups[side];
    super(layout.name);
    this.onUnequip = onUnequip;
    this.onEquipBetter = onEquipBetter;
    if (layout.horizontal) GameUiHelper.applyRowStyle(this, equipmentSlotLayout.slotSpacing, layout.position, layout.size);
    else GameUiHelper.applyColumnStyle(this, equipmentSlotLayout.slotSpacing, layout.position, layout.size);
    equipmentSlots.forEach((slotConfig, type) => {
      // 只生成本方向的槽位，槽位顺序与配置顺序一致
      if (slotConfig.position !== side) return;
      const slot = GameUiHelper.createEquipmentSlot(type, slotConfig.imageSrc);
      this.slots.set(type, slot);
      // 槽位内的装备图标与角标是子节点，节点事件会冒泡到槽位本身，因此监听槽位即可
      bindPointerAction(
        slot,
        (button) => {
          if (button === "right") this.onUnequip(type);
        },
        this,
      );
      this.addChild(slot);
      this.updateSlot(type, getEquipment(equipments[type]));
    });
  }

  /** 刷新槽位的装备显示（本分组无该槽位时忽略） */
  updateSlot(type: EQUIPMENT_TYPE, equipment: Equipment | null) {
    const slot = this.slots.get(type);
    if (!slot) return;
    clearChildren(slot);
    CursorManager.unregisterHover(slot);
    if (equipment) {
      GameUiHelper.createGood(slot, equipment);
      // 鼠标移到已穿戴的装备上时显示装备对应的指针颜色（界面物品优先于世界对象）
      CursorManager.registerHover(slot, cursorConfig.priority.ui, () => getGoodCursorStyle(equipment.type));
    }
    this.attachUpgradeHint(slot, type);
  }

  /** 切换槽位「更好装备」提示角标的显隐（本分组无该槽位时忽略） */
  updateUpgradeHint(type: EQUIPMENT_TYPE, visible: boolean) {
    const hint = this.hints.get(type);
    if (hint) hint.active = visible;
  }

  /**
   * 槽位的「更好装备」提示角标（updateSlot 清空子节点后重挂，所以每次刷新都调一次）
   * 角标是槽位的子节点：左键点击冒泡到槽位的指针监听（只认右键）不受影响，
   * 角标自己的左键监听负责一键替换（是否真有更好的装备由数据层现判，不依赖点亮时的旧结论）
   */
  private attachUpgradeHint(slot: Node, type: EQUIPMENT_TYPE) {
    const hint = GameUiHelper.createEquipmentUpgradeHint();
    hint.active = this.hints.get(type)?.active ?? false;
    bindPointerAction(
      hint,
      (button) => {
        if (button === "left") this.onEquipBetter(type);
      },
      this,
    );
    slot.addChild(hint);
    this.hints.set(type, hint);
  }
}
