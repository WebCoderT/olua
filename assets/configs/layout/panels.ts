import { Size, Vec2 } from "cc";
import { uiImages } from "./images";

/**
 * 角色信息弹窗内的面板零件布局
 *
 * 坐标系：子件坐标以**弹窗中心**为原点（弹窗尺寸见 dialogs.dialogFrame.size）
 */

//#region 装备槽分组（左列 / 右列 / 底部横排）

/** 装备槽分组布局（分组顺序与各分组的容器几何） */
export const equipmentSlotLayout = {
  /** 分组排列顺序（与装备槽配置 configs/equipments.equipmentSlots 的 position 对应） */
  sides: ["left", "right", "bottom"] as ("left" | "right" | "bottom")[],
  /** 槽位间距与单个槽位尺寸 */
  slotSpacing: 10,
  slotSize: new Size(50, 50),
  /** 各分组容器（name = 节点名，horizontal = 横排还是竖排） */
  groups: {
    left: { name: "equipment_slots_left", position: new Vec2(-240, 40), size: new Size(50, 290), horizontal: false },
    right: { name: "equipment_slots_right", position: new Vec2(80, 40), size: new Size(50, 290), horizontal: false },
    bottom: { name: "equipment_slots_bottom", position: new Vec2(-75, -140), size: new Size(170, 50), horizontal: true },
  },
};

//#endregion

//#region 背包格子网格

/** 背包格子网格布局（弹窗内固定几何；行列数见 configs/role 的 bagRow / bagCol） */
export const bagGridLayout = {
  name: "bag_grid",
  position: new Vec2(0, 17),
  size: new Size(580, 368),
  /** 行间距与单行尺寸（行宽 ÷ 格子宽决定每行格子数） */
  rowSpacing: 3,
  rowSize: new Size(580, 50),
  /** 单个格子尺寸与底图 */
  cellSize: new Size(50, 50),
  cellImage: uiImages.bagSlotGrid,
};

//#endregion

//#region 属性列表

/** 属性列表布局（尺寸高度 0 = 由内容自适应） */
export const roleAttributeListLayout = {
  name: "role_attributes",
  position: new Vec2(217, 205),
  size: new Size(150, 0),
  /** 条目纵向间距与容器内边距 */
  spacing: 5,
  padding: 10,
  /** 分组标题（基础属性 / 特殊属性）与属性行的高度 */
  titleHeight: 14,
  rowHeight: 20,
  /** 属性行字号 */
  rowFontSize: 12,
};

//#endregion

//#region 内观（衣服 + 武器）

/** 内观尺寸（衣服与武器共用；内观节点保持弹窗坐标系下的原有位置，见装备配置 in/inPosition） */
export const roleInShowLayout = {
  name: "role_in_show",
  size: new Size(400, 400),
};

//#endregion
