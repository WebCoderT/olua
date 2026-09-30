import { Node, Size, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import { cursorConfig, getGoodCursorStyle } from "../../../configs/cursor";
import CursorManager from "../../core/CursorManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { bindPointerAction, PointerButton } from "../../utils/input/Pointer";
import { clearChildren } from "../../utils/node/NodeTree";

/** 背包网格布局（弹窗内固定几何） */
const GRID_POSITION = new Vec2(0, 17);
const GRID_SIZE = new Size(580, 368);
/** 行间距：与 createRoleBagCellRow 内的行容器间距一致 */
const GRID_SPACING = 3;

/**
 * 背包格子的操作动作
 * - use：使用（左键/触屏点击，按物品大类分发）
 * - equip：穿戴（右键，仅装备有效）
 */
export type BagCellAction = "use" | "equip";

/** 背包格子操作回调：由弹窗注入（规则判定与提示在数据层，本组件只上报操作） */
export type BagCellHandler = (row: number, col: number, action: BagCellAction) => void;

/**
 * 背包格子网格组件（自身即背包网格容器）
 * 负责按角色背包数据填充物品图标与操作回调：左键（触屏点击）上报 use、右键上报 equip，
 * 物品能否使用由弹窗转交数据层判定，本组件不关心使用规则
 */
export default class BagGridView extends Node {
  /** 格子节点（[行][列]） */
  private cells: Node[][] = [];
  /** 格子操作回调 */
  private onCellAction: BagCellHandler;

  constructor(onCellAction: BagCellHandler) {
    super("bag_grid");
    this.onCellAction = onCellAction;
    GameUiHelper.applyColumnStyle(this, GRID_SPACING, GRID_POSITION, GRID_SIZE);
    // 行与格子由零件工厂生成（行容器为格子的 flex row）
    this.cells = GameUiHelper.createRoleBagCellRow(this);
  }

  /** 按背包数据刷新：先清空旧内容（真正销毁）与旧监听，再逐格填充物品与操作事件 */
  refresh(role: Role) {
    this.cells.forEach((row) =>
      row.forEach((cell) => {
        CursorManager.unregisterHover(cell);
        clearChildren(cell);
        cell.targetOff(this);
      }),
    );
    role.bag.forEach((row, rowIndex) => {
      row.forEach((good, colIndex) => {
        if (!good) return;
        const cell = this.cells[rowIndex][colIndex];
        GameUiHelper.createGood(cell, good);
        bindPointerAction(cell, (button) => this.onCellAction(rowIndex, colIndex, this.toAction(button)), this);
        // 鼠标移到格子里的物品上时显示该物品大类对应的指针颜色（界面物品优先于世界对象）
        CursorManager.registerHover(cell, cursorConfig.priority.ui, () => getGoodCursorStyle(good.type));
      });
    });
  }

  /** 指针按键转背包动作（左键使用、右键穿戴） */
  private toAction(button: PointerButton): BagCellAction {
    return button === "right" ? "equip" : "use";
  }
}
