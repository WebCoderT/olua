import { EventMouse, EventTouch, isValid, Node, Sprite, UITransform, Vec2, Vec3 } from "cc";
import { Role } from "../../../entities/Role";
import { cursorConfig, getGoodCursorStyle } from "../../../configs/cursor";
import { getItem } from "../../../configs/items";
import { BagCellPos } from "../../../types/good";
import CursorManager from "../../core/CursorManager";
import StorageManager from "../../core/StorageManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { bindPointerAction, getPointerButton, PointerButton } from "../../utils/input/Pointer";
import { clearChildren } from "../../utils/node/NodeTree";
import { bagGridLayout } from "../../../configs/hudLayout";

/**
 * 背包格子的操作动作
 * - use：使用（左键/触屏点击，按物品大类分发）
 * - equip：穿戴（右键，仅装备有效）
 */
export type BagCellAction = "use" | "equip";

/** 背包格子操作回调：由弹窗注入（规则判定与提示在数据层，本组件只上报操作） */
export type BagCellHandler = (row: number, col: number, action: BagCellAction) => void;

/** 一次拖动的进行中状态（没在按下/拖动时为 null） */
interface BagDragState {
  /** 起点格 */
  from: BagCellPos;
  /** 按下时的屏幕坐标（判断是否越过拖动阈值；必须 clone，见 onCellTouchStart 的说明） */
  start: Vec2;
  /** 是否已越过阈值、真的进入拖动（进入之前一律按点击处理） */
  active: boolean;
  /** 起点格物品的图标地址（幽灵图标按它取图） */
  icon: string;
  /** 起点格里的物品图标节点（拖动中压暗，松手/取消时恢复） */
  sourceGood: Node | null;
  /** 跟随指针的幽灵图标（进入拖动时才创建，挂在弹窗下） */
  ghost: Node | null;
  /** 落点高亮框（进入拖动时才创建，摆在指针下的格子上） */
  highlight: Node | null;
  /** 当前指针下的落点格（没落在格子上为 null） */
  target: BagCellPos | null;
}

/**
 * 背包格子网格组件（自身即背包网格容器）
 *
 * 三件事：
 * 1. 按角色背包数据填充物品图标（左右键操作：左键使用、右键穿戴，规则判定在数据层）；
 * 2. 新增物品时，鼠标移到物品上显示该大类对应的指针颜色；
 * 3. **按住物品拖动改变所在格子**：空格 = 移动、同种可叠加 = 合并、其余 = 交换（规则在数据层
 *    `configs/items.moveBagCellGrid`，本组件只负责手势与表现）。
 *
 * 网格内的触摸归网格自己：弹窗背景是可拖动的（弹窗可以整体搬走），而触摸事件会冒泡，
 * 不把网格区域的触摸收住的话，一拖物品整个弹窗就跟着跑（见 setupTouchOwnership）。
 *
 * 拖动为什么走 touch 通道（TOUCH_START / TOUCH_MOVE / TOUCH_END）而不是鼠标通道：
 * 鼠标环境引擎会把 MOUSE_DOWN/MOVE/UP **模拟**成 TOUCH_START/MOVE/END（见引擎 input 的
 * `_simulateEventTouch`，与 ui/utils/input/Pointer 的说明一致），于是同一套代码在触屏原生环境
 * （本来就是 TOUCH_*）与鼠标环境都能用；而 touch 通道还有「TOUCH_START 命中的节点独占整段触摸」
 * 的语义 —— 按下之后不管指针拖到哪儿、松在谁身上，结束事件都回到起点格，落点则用指针位置自己算，
 * 不必担心中途经过别的按钮被抢走事件。反过来，鼠标通道**不能**用来拖动：节点上注册 MOUSE_MOVE
 * 会吞掉全局的指针追踪（光标样式与按住走路都会卡住，见 Pointer/blockClickThrough 的长注释）。
 */
export default class BagGridView extends Node {
  /** 格子节点（[行][列]） */
  private cells: Node[][] = [];
  /** 格子操作回调（由弹窗注入） */
  private handleCellAction: BagCellHandler;
  /** 进行中的拖动（按下后到松手/取消之间才有值） */
  private drag: BagDragState | null = null;
  /**
   * 本次按压是否已经拖动过物品
   *
   * 拖动松手后，同一次抬起的「点击」回调还会来（鼠标环境是 MOUSE_UP、触屏是 TOUCH_END 上的
   * 点击监听），不拦掉就会顺手把物品用掉/穿上。这里用「本次按压拖动过」这个标记拦：
   * 它在**下一次按下**（TOUCH_START）时复位，于是不管点击回调与拖动落点谁先执行都不会漏。
   */
  private pressDragged = false;
  /** 本次按压是不是鼠标右键（touch 通道看不出按键；右键按住只做穿戴，不该拖动物品） */
  private rightPress = false;

  constructor(onCellAction: BagCellHandler) {
    super(bagGridLayout.name);
    this.handleCellAction = onCellAction;
    // 网格几何见 configs/hudLayout.bagGridLayout（行容器尺寸与格子尺寸决定行列数）
    GameUiHelper.applyColumnStyle(this, bagGridLayout.rowSpacing, bagGridLayout.position, bagGridLayout.size);
    // 行与格子由零件工厂生成（行容器为格子的 flex row）
    this.cells = GameUiHelper.createRoleBagCellRow(this);
    // 网格内的触摸不外传（否则一拖物品，整个弹窗也跟着拖）
    this.setupTouchOwnership();
  }

  /** 按背包数据刷新：先清空旧内容（真正销毁）与旧监听，再逐格填充物品与操作事件 */
  refresh(role: Role) {
    // 刷新会重建格子节点，进行中的拖动（幽灵、高亮、压暗）随之作废，先收干净
    this.endDrag();
    this.cells.forEach((row) =>
      row.forEach((cell) => {
        CursorManager.unregisterHover(cell);
        clearChildren(cell);
        cell.targetOff(this);
      }),
    );
    role.bag.forEach((row, rowIndex) => {
      row.forEach((bagCell, colIndex) => {
        if (!bagCell) return;
        // 格子只存物品 key，显示数据实时解析（id 失效的格子跳过不渲染）
        const good = getItem(bagCell.id);
        if (!good) return;
        const cell = this.cells[rowIndex][colIndex];
        GameUiHelper.createGood(cell, good);
        // 拖动手势（只有有物品的格子才需要：空格没什么可拖的，落点则用指针位置单独判定）
        cell.on(Node.EventType.TOUCH_START, (event: EventTouch) => this.onCellTouchStart(rowIndex, colIndex, event), this);
        cell.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => this.onCellTouchMove(event), this);
        cell.on(Node.EventType.TOUCH_END, (event: EventTouch) => this.onCellTouchEnd(event), this);
        cell.on(Node.EventType.TOUCH_CANCEL, () => this.endDrag(), this);
        // 右键按住不该拖动物品：TOUCH_* 事件不带按键，另在鼠标通道记一笔（触屏环境收不到，恒为左键）
        cell.on(Node.EventType.MOUSE_DOWN, (event: EventMouse) => this.onCellMouseDown(event), this);
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

  /** 格子点击：本次按压拖动过物品就不再算点击（见 pressDragged 的说明） */
  private onCellAction(row: number, col: number, action: BagCellAction) {
    if (this.pressDragged) return;
    this.handleCellAction(row, col, action);
  }

  //#region 触摸归属（网格内的触摸不外传）

  /**
   * 把网格区域内的触摸收在网格里：四个触摸事件一律停住冒泡，不再往上传给弹窗
   *
   * 为什么必须收：背包弹窗的背景上挂着可拖动组件（GameUiHelper.createDialogBg → components/input/Draggable），
   * 按住弹窗能把它整个搬走；而节点的触摸事件是**冒泡**的（引擎 node-event-processor 派发 TOUCH_* 时
   * 一律 `event.bubbles = true`），在格子上按下的触摸会一路冒泡到弹窗背景 ——
   * 于是玩家一拖物品，弹窗也跟着一起跑。
   *
   * 为什么登记在网格容器上、而不是每个格子各收各的（两种按下一次兜住）：
   * · 按在有物品的格子上：格子自己注册了 TOUCH_START，先独占这次触摸，之后事件从格子往上冒泡
   *   （格子 → 行容器 → 网格容器 → 弹窗），路过这里就被停下，弹窗收不到；
   * · 按在空格子或网格的空白处：没有更深的节点认领，这次触摸由**网格容器自己**独占
   *   （它在命中列表里、也有 UITransform），事件同样到不了弹窗。
   * 于是「网格区域内怎么按都不会拖动弹窗」，而「按住物品拖动的是物品」照旧成立。
   *
   * 反向的兜底在 Draggable 那边：按下点自带拖动手势（注册过 TOUCH_MOVE）时弹窗不抢这次拖动，
   * 免得以后往弹窗里加滚动视图、滑条这类子手势时再踩同一个坑。
   */
  private setupTouchOwnership() {
    this.on(Node.EventType.TOUCH_START, this.stopTouchBubble, this);
    this.on(Node.EventType.TOUCH_MOVE, this.stopTouchBubble, this);
    this.on(Node.EventType.TOUCH_END, this.stopTouchBubble, this);
    this.on(Node.EventType.TOUCH_CANCEL, this.stopTouchBubble, this);
  }

  /** 停住这次触摸的冒泡（不再传给弹窗背景的拖动，见 setupTouchOwnership 的说明） */
  private stopTouchBubble(event: EventTouch) {
    event.propagationStopped = true;
  }

  //#endregion

  //#region 拖动改变格子

  /**
   * 取消进行中的拖动（收掉幽灵、高亮与压暗，不动数据）
   * 弹窗关闭前调用：那些临时节点虽然挂在弹窗下会随弹窗销毁，但引用留在这里，先清干净更省心
   */
  cancelDrag() {
    this.endDrag();
  }

  /** 按下：只记起点，此时还不知道玩家是要点击还是要拖动 */
  private onCellTouchStart(row: number, col: number, event: EventTouch) {
    // 新的一次按压开始：上一次按压留下的「已拖动」标记在这里复位（见 pressDragged 的说明）
    this.pressDragged = false;
    this.endDrag();
    const cell = StorageManager.findOnlineRole()?.bag[row]?.[col];
    const good = cell ? getItem(cell.id) : null;
    // 空格、或配置表里认不出的物品（界面上也没渲染出来）不参与拖动
    if (!good) {
      this.drag = null;
      return;
    }
    // 屏幕坐标必须 clone：事件对象的 getLocation 返回的是会被下一次事件改写的同一个向量
    this.drag = {
      from: { row, col },
      start: event.getLocation().clone(),
      active: false,
      icon: good.icon,
      sourceGood: null,
      ghost: null,
      highlight: null,
      target: null,
    };
  }

  /** 鼠标按下：记下是不是右键（右键按住只做穿戴，见 rightPress） */
  private onCellMouseDown(event: EventMouse) {
    this.rightPress = getPointerButton(event) === "right";
  }

  /** 移动：越过阈值才算拖动（阈值内的位移仍按点击处理），拖动中更新幽灵与落点高亮 */
  private onCellTouchMove(event: EventTouch) {
    const drag = this.drag;
    if (!drag) return;
    if (!drag.active && this.rightPress) return;
    const point = event.getLocation();
    if (!drag.active) {
      if (Vec2.distance(point, drag.start) < bagGridLayout.drag.threshold) return;
      this.beginDrag(drag);
    }
    this.updateDrag(drag, point);
  }

  /**
   * 松手：按指针位置找落点并搬过去
   * 没越过阈值（仍算点击）或没落在任何格子上时不搬 —— 前者交给点击逻辑，后者等于把东西放回原处
   */
  private onCellTouchEnd(event: EventTouch) {
    const drag = this.drag;
    if (!drag) return;
    const active = drag.active;
    const from = drag.from;
    const hit = active ? this.hitCell(event.getLocation()) : null;
    const target = hit ?? drag.target;
    // 先收干净再落子：搬运会刷新网格（格子节点重建），幽灵与高亮不能留到那之后
    this.endDrag();
    if (!active || !target) return;
    StorageManager.moveBagGood(from.row, from.col, target.row, target.col);
  }

  /** 进入拖动：压暗源格物品 + 建出幽灵图标与落点高亮框 */
  private beginDrag(drag: BagDragState) {
    drag.active = true;
    this.pressDragged = true;
    const sourceCell = this.cells[drag.from.row]?.[drag.from.col];
    drag.sourceGood = sourceCell?.children.find((child) => !!child.getComponent(Sprite)) ?? null;
    GameUiHelper.setNodeOpacity(drag.sourceGood, bagGridLayout.drag.sourceOpacity);
    // 幽灵与高亮挂在弹窗（网格的父节点）下、排在弹窗原有子节点之后 → 画在最上层
    if (!this.parent || !isValid(this.parent)) return;
    drag.ghost = GameUiHelper.createBagDragGhost(drag.icon);
    drag.highlight = GameUiHelper.createBagDragHighlight();
    drag.highlight.active = false;
    this.parent.addChild(drag.ghost);
    this.parent.addChild(drag.highlight);
  }

  /** 拖动中：幽灵跟随指针，落点高亮摆到指针下的格子上 */
  private updateDrag(drag: BagDragState, point: Vec2) {
    if (drag.ghost) GameUiHelper.followScreenPoint(drag.ghost, new Vec3(point.x, point.y, 0));
    const target = this.hitCell(point);
    // 落点没变就不折腾高亮（拖动期间每帧都在移动，这里省掉无谓的换算）
    const current = drag.target;
    if ((!target && !current) || (target && current && target.row === current.row && target.col === current.col)) return;
    drag.target = target;
    if (!drag.highlight || !isValid(drag.highlight)) return;
    const targetCell = target ? this.cells[target.row]?.[target.col] : null;
    if (!targetCell) {
      drag.highlight.active = false;
      return;
    }
    GameUiHelper.alignNodeToNode(drag.highlight, targetCell);
    drag.highlight.active = true;
  }

  /** 收掉拖动：恢复源格物品的透明度并销毁幽灵与高亮（不动数据，落子与取消都走它） */
  private endDrag() {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    GameUiHelper.setNodeOpacity(drag.sourceGood, bagGridLayout.drag.restoreOpacity);
    if (drag.ghost && isValid(drag.ghost)) drag.ghost.destroy();
    if (drag.highlight && isValid(drag.highlight)) drag.highlight.destroy();
  }

  /**
   * 屏幕坐标命中的背包格子（含空格子；没落在网格上返回 null）
   * 一律用 UITransform.hitTest（屏幕坐标口径，与怪物选中/走路换算一致；废弃的 isHit 会随窗口尺寸偏移）
   */
  private hitCell(screenPoint: Vec2): BagCellPos | null {
    for (let row = 0; row < this.cells.length; row++) {
      const line = this.cells[row];
      for (let col = 0; col < line.length; col++) {
        const transform = line[col].getComponent(UITransform);
        if (transform && transform.hitTest(screenPoint)) return { row, col };
      }
    }
    return null;
  }

  //#endregion
}
