import { Node, Size, Vec2 } from "cc";
import { Role } from "../../../entities/Role";
import { Goods } from "../../../types/good";
import GameUiHelper from "../../helpers/GameUiHelper";

/** 背包网格布局（弹窗内固定几何） */
const GRID_POSITION = new Vec2(0, 17);
const GRID_SIZE = new Size(580, 368);
/** 行间距：与 createRoleBagCellRow 内的行容器间距一致 */
const GRID_SPACING = 3;

/** 物品使用回调：由弹窗注入（按物品大类分发穿戴/服用等行为） */
export type UseGoodHandler = (good: Goods, row: number, col: number) => void;

/**
 * 背包格子网格组件（自身即背包网格容器）
 * 负责按角色背包数据填充物品图标与点击使用回调，不关心物品使用规则（由弹窗注入回调）
 */
export default class BagGridView extends Node {
  /** 格子节点（[行][列]） */
  private cells: Node[][] = [];
  /** 物品使用回调 */
  private onUseGood: UseGoodHandler;

  constructor(onUseGood: UseGoodHandler) {
    super("bag_grid");
    this.onUseGood = onUseGood;
    GameUiHelper.applyColumnStyle(this, GRID_SPACING, GRID_POSITION, GRID_SIZE);
    // 行与格子由零件工厂生成（行容器为格子的 flex row）
    this.cells = GameUiHelper.createRoleBagCellRow(this);
  }

  /** 按背包数据刷新：先清空旧内容与旧监听，再逐格填充物品与点击事件 */
  refresh(role: Role) {
    this.cells.forEach((row) =>
      row.forEach((cell) => {
        cell.removeAllChildren();
        cell.targetOff(this);
      }),
    );
    role.bag.forEach((row, rowIndex) => {
      row.forEach((good, colIndex) => {
        if (!good) return;
        const cell = this.cells[rowIndex][colIndex];
        GameUiHelper.createGood(cell, good);
        cell.on(Node.EventType.TOUCH_END, () => this.onUseGood(good, rowIndex, colIndex), this);
      });
    });
  }
}
