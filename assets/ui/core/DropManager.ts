import { isValid, Node, UITransform, Vec2, Vec3 } from "cc";
import { resolveDropTable } from "../../configs/drop";
import { getGoodCursorStyle, cursorConfig } from "../../configs/cursor";
import { getItem } from "../../configs/items";
import type { DropResult, DropSource } from "../../types/drop";
import type { Goods } from "../../types/good";
import { rollDropTable } from "../utils/drop/DropRoller";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "./LayerManager";
import CursorManager from "./CursorManager";
import StorageManager from "./StorageManager";

/** 掉落物运行时数据（节点 -> 物品与数量） */
interface DropItem {
  /** 物品数据（配置副本） */
  good: Goods;
  /** 掉落数量 */
  count: number;
}

/**
 * 掉落管理器（静态类）
 * 统一管理怪物死亡掉落：结算掉落表 → 生成掉落物节点挂掉落层 → 角色踩上去自动拾取（也可点击拾取）→ 换图清空
 * 掉落物节点一律挂载到 LayerManager 掉落层（Layer.DROP）
 */
export default class DropManager {
  /** 已生成掉落物：掉落物节点 -> 掉落数据 */
  private static dropMap = new Map<Node, DropItem>();
  /** 一次掉落多件时的散落半径（避免完全重叠，只散开一半高度） */
  private static readonly SCATTER_RADIUS = 36;
  /**
   * 自动拾取半径：角色节点原点即脚底，与掉落物节点距离小于该值视为踩在物品上
   * 取值 = 掉落物图标半宽(20) + 脚部容差(20)
   */
  private static readonly AUTO_PICKUP_RADIUS = 40;
  /** 背包已满的提示间隔（毫秒）：同时也是两次入包尝试之间的间隔，避免每帧重复反序列化背包数据 */
  private static readonly FULL_TIP_INTERVAL = 1500;
  /** 上次背包已满提示时间戳 */
  private static fullTipTime = 0;

  /** 清空所有掉落物（切换地图时调用） */
  static reset() {
    this.dropMap.forEach((_, node) => {
      if (isValid(node)) node.destroy();
    });
    this.dropMap.clear();
    LayerManager.clearDropLayer();
  }

  /**
   * 结算一次掉落并在指定位置生成掉落物
   * @param source 怪物掉落配置（具名掉落表 id 或内联掉落表，缺省用默认掉落表）
   * @param position 掉落位置（一般取怪物死亡时的世界坐标）
   * @returns 本次掉落结果（便于日志/统计；为空表示没掉东西）
   */
  static drop(source: DropSource | undefined, position: Vec3): DropResult[] {
    const results = rollDropTable(resolveDropTable(source));
    results.forEach((result, index) => {
      const good = getItem(result.goodId);
      if (!good) {
        console.warn(`掉落物品不存在：${result.goodId}`);
        return;
      }
      this.createDropNode(good, result.count, position, index, results.length);
    });
    return results;
  }

  /** 生成掉落物节点并挂载到掉落层 */
  private static createDropNode(good: Goods, count: number, position: Vec3, index: number, total: number) {
    const { node } = GameUiHelper.createDropItem(good, count);
    LayerManager.addToDropLayer(node);
    // 多件掉落时围绕落点均匀散开，单件直接落在落点
    const radius = total > 1 ? this.SCATTER_RADIUS : 0;
    const angle = (Math.PI * 2 * index) / Math.max(1, total);
    node.setWorldPosition(position.x + Math.cos(angle) * radius, position.y + Math.sin(angle) * radius * 0.5, position.z);
    this.dropMap.set(node, { good, count });
    // 鼠标移到掉落物上时显示该物品大类对应的指针颜色（拾取/换图时注销，见 takeDrop / reset）
    CursorManager.registerHover(node, cursorConfig.priority.drop, () => getGoodCursorStyle(good.type));
  }

  /**
   * 每帧自动拾取：角色走到掉落物上（脚底进入拾取范围）即收进背包
   * 由组合根在 Game.update 中驱动
   * @param rolePosition 角色世界坐标（角色节点原点即脚底）
   * @param radius 拾取半径，缺省 AUTO_PICKUP_RADIUS
   * @returns 本次拾取到的物品数量
   */
  static autoPickup(rolePosition: Vec3, radius: number = this.AUTO_PICKUP_RADIUS): number {
    // 背包已满的节流期内直接跳过：既避免每帧刷提示，也避免每帧重复尝试入包
    if (Date.now() - this.fullTipTime < this.FULL_TIP_INTERVAL) return 0;
    const picked: string[] = [];
    Array.from(this.dropMap.keys()).forEach((node) => {
      // 已销毁的残留节点直接清理
      if (!isValid(node)) {
        this.dropMap.delete(node);
        return;
      }
      const position = node.getWorldPosition();
      const distance = Math.hypot(position.x - rolePosition.x, position.y - rolePosition.y);
      if (distance > radius) return;
      const drop = this.takeDrop(node);
      if (!drop) {
        this.notifyBagFull();
        return;
      }
      picked.push(`${drop.good.label} x${drop.count}`);
    });
    // 同一帧拾取的多件物品合并为一条提示，避免互相遮挡
    if (picked.length) GameUiHelper.createTip("pickup_tip", `拾取 ${picked.join("、")}`);
    return picked.length;
  }

  /** 获取被点击的掉落物节点（后掉落的节点在上层，优先命中） */
  static getClickedDrop(position: Vec2): Node | null {
    const nodes = Array.from(this.dropMap.keys()).reverse();
    for (const node of nodes) {
      if (isValid(node) && node.getComponent(UITransform)?.isHit(position)) return node;
    }
    return null;
  }

  /** 获取掉落物数据（无此掉落物返回 null） */
  static getDropItem(node: Node): DropItem | null {
    return this.dropMap.get(node) ?? null;
  }

  /** 点击拾取掉落物（放入背包，背包满则保留在原地面并提示） */
  static pickup(node: Node): boolean {
    const drop = this.takeDrop(node);
    if (!drop) {
      // 只有确实还在场上（即背包满）才提示，节点已不存在时不提示
      if (this.dropMap.has(node)) this.notifyBagFull();
      return false;
    }
    GameUiHelper.createTip("pickup_tip", `拾取 ${drop.good.label} x${drop.count}`);
    return true;
  }

  /** 从掉落物取出物品放入背包（成功则移除节点）；背包放不下或节点已失效返回 null */
  private static takeDrop(node: Node): DropItem | null {
    const drop = this.dropMap.get(node);
    if (!drop) return null;
    if (!StorageManager.addGood(drop.good, drop.count)) return null;
    this.dropMap.delete(node);
    CursorManager.unregisterHover(node);
    if (isValid(node)) node.destroy();
    return drop;
  }

  /** 背包已满提示（按 FULL_TIP_INTERVAL 节流，防止自动拾取时每帧刷屏） */
  private static notifyBagFull() {
    const now = Date.now();
    if (now - this.fullTipTime < this.FULL_TIP_INTERVAL) return;
    this.fullTipTime = now;
    GameUiHelper.createTip("pickup_full_tip", "背包已满");
  }
}
