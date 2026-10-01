import { isValid, Node, UITransform, Vec2 } from "cc";
import { CursorStyle, cursorConfig } from "../../configs/cursor";
import { buildCursorCss, canPaintCursor } from "../utils/cursor/CursorPainter";
import { HAS_MOUSE } from "../utils/input/Pointer";

/** 悬停目标注册项 */
interface CursorHoverTarget {
  /** 命中优先级（见 configs/cursor 的 priority） */
  priority: number;
  /** 指针样式（传函数则每次判定时取，便于物品按类型取色） */
  style: CursorStyle | (() => CursorStyle);
  /** 注册序号：同优先级时后注册的优先（后挂载的节点在上层） */
  order: number;
}

/**
 * 鼠标指针管理器（静态类）
 * 统一接管游戏内的鼠标指针样式：
 * 可交互对象（怪物/物品）在生成时把自己的节点注册进来 → 鼠标移到它上面时按优先级选中该对象声明的样式 → 写入画布 cursor
 * 判定每帧最多一次（由组合根在 Game.update 调用 tick），鼠标位置由 CursorInput 上报，
 * 避免高回报率鼠标拖动时每帧重复做命中检测
 * 指针样式（形状/颜色/尺寸/热点）全部来自 configs/cursor，本类不含任何样式常量
 * 无鼠标环境（触屏）与原生平台不接管指针，注册与判定整体空转
 */
export default class CursorManager {
  /** 指针挂载的元素（Web 端为游戏画布） */
  private static element: HTMLElement | null = null;
  /** 已注册的悬停目标 */
  private static targets = new Map<Node, CursorHoverTarget>();
  /** 注册序号自增计数 */
  private static order = 0;
  /** 上次鼠标位置（屏幕坐标，命中检测与 UITransform.hitTest 同一口径，见 utils/input/Pointer.getHitScreenPoint） */
  private static location = new Vec2();
  /** 是否需要重新判定（鼠标移动或悬停目标变化时置位） */
  private static dirty = false;
  /** 当前已写入元素的 cursor 取值（值未变化时不再写，避免每帧触碰 DOM 样式） */
  private static currentCss = "";

  /** 初始化（场景启动时由组合根调用）：定位画布并写入默认指针 */
  static init() {
    if (!canPaintCursor() || !HAS_MOUSE) return;
    this.element = (document.querySelector("canvas") as HTMLCanvasElement | null) ?? document.body;
    this.apply(cursorConfig.default);
  }

  /** 释放（场景卸载时由组合根调用）：清空悬停目标与元素引用 */
  static destroy() {
    this.targets.clear();
    this.element = null;
    this.currentCss = "";
  }

  /**
   * 注册悬停目标：鼠标移到该节点上时使用给定样式
   * @param node 目标节点（需有 UITransform；节点销毁后会自动失效并被清理）
   * @param priority 命中优先级（大的先判定）
   * @param style 指针样式，或返回样式的函数（物品按类型取色时用函数）
   */
  static registerHover(node: Node, priority: number, style: CursorStyle | (() => CursorStyle)) {
    this.targets.set(node, { priority, style, order: this.order++ });
    this.dirty = true;
  }

  /** 注销悬停目标（对象销毁/拾取/脱下时调用） */
  static unregisterHover(node: Node) {
    if (this.targets.delete(node)) this.dirty = true;
  }

  /** 清空全部悬停目标（换图等整体重置时调用） */
  static clearHover() {
    if (!this.targets.size) return;
    this.targets.clear();
    this.dirty = true;
  }

  /** 上报鼠标位置（由 input 组件在鼠标移动时调用，只记录不判定；坐标为屏幕坐标） */
  static setLocation(screenPoint: Vec2) {
    this.location.set(screenPoint);
    this.dirty = true;
  }

  /** 每帧检查（由组合根在 Game.update 调用）：鼠标位置或悬停目标有变化时才重新判定 */
  static tick() {
    if (!this.element || !this.dirty) return;
    this.dirty = false;
    this.apply(this.resolveStyle());
  }

  /** 判定当前鼠标下的指针样式：取命中且优先级最高的悬停目标，没有命中则用默认指针 */
  private static resolveStyle(): CursorStyle {
    const candidates: CursorHoverTarget[] = [];
    this.targets.forEach((target, node) => {
      // 已销毁的注册项顺手清理（弹窗关闭、怪物死亡都可能留下残留）
      if (!isValid(node)) {
        this.targets.delete(node);
        return;
      }
      if (!node.activeInHierarchy) return;
      if (!node.getComponent(UITransform)?.isHit(this.location)) return;
      candidates.push(target);
    });
    if (!candidates.length) return cursorConfig.default;
    candidates.sort((a, b) => a.priority - b.priority || a.order - b.order);
    const best = candidates[candidates.length - 1];
    const style = typeof best.style === "function" ? best.style() : best.style;
    return style ?? cursorConfig.default;
  }

  /** 写入指针样式（总开关关闭或值未变化时不写） */
  private static apply(style: CursorStyle) {
    if (!this.element) return;
    const css = cursorConfig.enabled ? buildCursorCss(style) : "default";
    if (css === this.currentCss) return;
    this.currentCss = css;
    this.element.style.cursor = css;
  }
}
