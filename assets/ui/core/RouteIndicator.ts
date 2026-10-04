import { Graphics, isValid, Node, UITransform, Vec2, Vec3 } from "cc";
import { autoBattle } from "../../configs/autoBattle";
import type RoleDisplay from "../components/role/RoleDisplay";
import GameUiHelper from "../helpers/GameUiHelper";
import AutoBattle from "./AutoBattle";

/**
 * 路线指示线（静态控制器）
 * 自动寻路期间（小地图左键点击寻路、快速攻击追怪、自动挂机追怪）在大地图地面上画出「角色 → 目标」的路线：
 * 起点取角色当前世界坐标，之后依次是 A* 的剩余路点，终点是实时目标点（追怪时目标在移动，故终点现取）；
 * 路线数据来自 AutoBattle.getRoutePoints（无路径时为空数组，例如已进入范围内原地出手）
 * 绘制载体是挂在地图节点下的一个 Graphics（见 GameUiHelper.createRouteLineLayer）：
 * 世界坐标经地图节点的 UITransform 换算到地图本地坐标后作画，因此与地图几何严格对齐；
 * 地图层的渲染顺序在怪物层/特效层之前，所以线贴地显示、不会盖住角色与怪物，换图后旧节点随旧地图销毁、下一帧自动重建
 * 无路线时立即清空绘制层；有路线时按 configs/autoBattle.routeLine.refreshInterval 节流重绘（起点随角色移动）
 * 由组合根在 Game.update 每帧调用 update，场景卸载时 reset 清引用
 */
export default class RouteIndicator {
  /** 路线绘制层（挂在地图节点下；换图后节点随旧地图销毁，isValid 校验会触发重建） */
  private static graphics: Graphics | null = null;
  /** 上次重绘时间戳 */
  private static lastDrawAt = 0;
  /** 绘制层当前是否为空（为空时不必重复 clear） */
  private static empty = true;

  /** 每帧驱动（组合根调用）：有路线就画，没有就立刻清空 */
  static update(roleDisplay: RoleDisplay | null) {
    const map = AutoBattle.getMapNode();
    const route = AutoBattle.getRoutePoints();
    if (!roleDisplay || !isValid(roleDisplay) || !map || route.length === 0) {
      this.clear();
      return;
    }
    const now = Date.now();
    if (!this.empty && now - this.lastDrawAt < autoBattle.routeLine.refreshInterval) return;
    this.lastDrawAt = now;
    const graphics = this.ensureGraphics(map);
    const position = roleDisplay.getWorldPosition();
    // 起点即角色本身（角色在移动，每次都现取）
    const worldPoints: Vec2[] = [new Vec2(position.x, position.y), ...route];
    const style = autoBattle.routeLine;
    GameUiHelper.drawRouteLine(graphics, worldPoints.map((point) => this.toMapLocal(map, point)), {
      color: style.color,
      dotRadius: style.dotRadius,
      dotGap: style.dotGap,
      endDotRadius: style.endDotRadius,
    });
    this.empty = false;
  }

  /** 场景卸载（组合根 onDestroy 调用）：绘制层随地图/场景销毁，这里只清引用 */
  static reset() {
    this.graphics = null;
    this.lastDrawAt = 0;
    this.empty = true;
  }

  //#region 内部实现

  /**
   * 取路线绘制层（挂在地图节点下，事件随地图切换重建）
   * 地图节点已换（旧节点连绘制层一起销毁）时重建，保证线总是画在当前地图上
   */
  private static ensureGraphics(map: Node): Graphics {
    const existed = this.graphics;
    if (existed && isValid(existed.node) && existed.node.parent === map) return existed;
    const graphics = GameUiHelper.createRouteLineLayer(map);
    this.graphics = graphics;
    this.empty = true;
    return graphics;
  }

  /** 清空路线（没有路线可画时调用；绘制层已失效则只置空标记，等下次重建） */
  private static clear() {
    if (this.empty) return;
    const graphics = this.graphics;
    if (graphics && isValid(graphics.node)) graphics.clear();
    this.empty = true;
  }

  /**
   * 世界坐标 -> 地图节点本地坐标的换算器
   * 走地图节点的 UITransform（与其余坐标换算同一口径），地图节点异常缺 UITransform 时退回「减去地图节点世界坐标」
   */
  private static toMapLocal(map: Node, point: Vec2): Vec2 {
    const transform = map.getComponent(UITransform);
    if (transform) {
      const local = transform.convertToNodeSpaceAR(new Vec3(point.x, point.y, 0), new Vec3());
      return new Vec2(local.x, local.y);
    }
    const origin = map.getWorldPosition();
    return new Vec2(point.x - origin.x, point.y - origin.y);
  }

  //#endregion
}
