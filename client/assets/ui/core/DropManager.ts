import { isValid, Node, UITransform, Vec2, Vec3 } from "cc";
import { dropRuntime, resolveDropTable } from "../../configs/drop";
import { getGoodCursorStyle, cursorConfig } from "../../configs/cursor";
import { getItem } from "../../configs/items";
import { getText } from "../../configs/texts";
import type { DropPicks, DropResult, DropSource } from "../../types/drop";
import type { Goods } from "../../types/good";
import { scatterDropPositions } from "../utils/drop/DropScatter";
import { rollDropTable } from "../utils/drop/DropRoller";
import type { PickResult } from "../utils/net/CombatChannel";
import CombatChannel from "../utils/net/CombatChannel";
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
  /**
   * 服务端结算的拾取定位（#325）：击杀那次的 castId + reward.drops 下标。
   * 存在 = 服务端口径的掉落，拾取要走 pick 帧（入包权威在服务端）；
   * 缺省 = 本地口径的掉落（实时通道不可用的回滚路径），走本地入包。
   */
  pick?: { castId: number; index: number };
}

/** 一次拾取请求的结果：picked = 已入包（本地口径）；pending = 服务端应答在途；full = 背包放不下 */
type PickOutcome = "picked" | "pending" | "full";

/** 拾取请求的返回值：本地口径已入包时一并带回掉落物数据（节点此时已移除，提示要用它） */
interface PickRequest {
  outcome: PickOutcome;
  drop?: DropItem;
}

/**
 * 掉落管理器（静态类）
 * 统一管理怪物死亡掉落：结算掉落表 → 生成掉落物节点挂掉落层 → 角色踩上去自动拾取（也可点击拾取）→ 换图清空
 * 掉落物节点一律挂载到 LayerManager 掉落层（Layer.DROP）
 */
export default class DropManager {
  /** 已生成掉落物：掉落物节点 -> 掉落数据 */
  private static dropMap = new Map<Node, DropItem>();
  /**
   * 自动拾取半径：角色节点原点即脚底，与掉落物节点距离小于该值视为踩在物品上（见 configs/drop.dropRuntime）
   * 背包已满的提示间隔同样取自 dropRuntime，避免每帧重复反序列化背包数据
   */
  private static readonly AUTO_PICKUP_RADIUS = dropRuntime.autoPickupRadius;
  private static readonly FULL_TIP_INTERVAL = dropRuntime.fullTipInterval;
  /** 上次背包已满提示时间戳 */
  private static fullTipTime = 0;
  /** 拾取应答在途的掉落物：节点 → 发出 pick 帧的时刻（超过 pickReplyTimeout 允许重试） */
  private static readonly pendingPicks = new Map<Node, number>();

  /** 清空所有掉落物（切换地图时调用） */
  static reset() {
    this.dropMap.forEach((_, node) => {
      if (isValid(node)) node.destroy();
    });
    this.dropMap.clear();
    this.pendingPicks.clear();
    LayerManager.clearDropLayer();
  }

  /**
   * 结算一次掉落并在指定位置生成掉落物（**本地口径**：实时通道不可用时的回滚路径；
   * 服务端结算在线时击杀掉落由 settle 帧的 reward 给定，走 spawnResults）
   * @param source 怪物掉落配置（条目数组 / 具名掉落表 id / 内联掉落表，缺省用默认掉落表）
   * @param position 掉落位置（一般取怪物死亡时的世界坐标）
   * @param picks 掉落件数：数字 = 固定件数，[最小, 最大] = 件数区间（例 [1, 10] 掉 1~10 件）；
   *              仅 source 为条目数组时生效（怪物按自己的掉落配置传 dropPicks）
   * @returns 本次掉落结果（便于日志/统计；为空表示没掉东西）
   */
  static drop(source: DropSource | undefined, position: Vec3, picks?: DropPicks): DropResult[] {
    return this.spawnResults(rollDropTable(resolveDropTable(source, picks)), position);
  }

  /**
   * 把一份**已经结算好**的掉落结果铺到指定位置（#316：掉落内容由服务端决定，这里只演）
   * @param results 掉落结果列表（goodId + count；可为空数组 —— 什么都没掉就不铺）
   * @param position 掉落位置（一般取怪物死亡时的世界坐标）
   * @param castId 结算的出手序号（#325：带上后拾取走 pick 帧、入包权威在服务端；
   *               缺省 = 本地口径的掉落，拾取直接进本地背包）
   * @returns 原样返回 results（便于日志/统计）
   */
  static spawnResults(results: DropResult[], position: Vec3, castId?: number): DropResult[] {
    // 先算全部散落点，再统一铺放：保证任意两件掉落物都不落在同一点上
    const offsets = scatterDropPositions(results.length);
    results.forEach((result, index) => {
      const good = getItem(result.goodId);
      if (!good) {
        console.warn(`掉落物品不存在：${result.goodId}`);
        return;
      }
      this.createDropNode(good, result.count, position, offsets[index], castId === undefined ? undefined : { castId, index });
    });
    return results;
  }

  /** 生成掉落物节点并挂载到掉落层（offset 为相对落点的散落偏移，保证各掉落物不重叠） */
  private static createDropNode(good: Goods, count: number, position: Vec3, offset: Vec2, pick?: { castId: number; index: number }) {
    const { node } = GameUiHelper.createDropItem(good, count);
    LayerManager.addToDropLayer(node);
    node.setWorldPosition(position.x + offset.x, position.y + offset.y, position.z);
    this.dropMap.set(node, { good, count, pick });
    // 鼠标移到掉落物上时显示该物品大类对应的指针颜色（拾取/换图时注销，见 removeDropNode / reset）
    CursorManager.registerHover(node, cursorConfig.priority.drop, () => getGoodCursorStyle(good.type));
  }

  /**
   * 每帧自动拾取：角色走到掉落物上（脚底进入拾取范围）即请求拾取
   * 由组合根在 Game.update 中驱动
   * @param rolePosition 角色世界坐标（角色节点原点即脚底）
   * @param radius 拾取半径，缺省 AUTO_PICKUP_RADIUS
   * @returns 本次拾取到的物品数量（服务端口径的拾取在应答回来后才算数，这里不计）
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
      const outcome = this.requestPick(node);
      if (outcome.outcome === "full") {
        this.notifyBagFull();
        return;
      }
      if (outcome.outcome === "picked" && outcome.drop) picked.push(`${outcome.drop.good.label} x${outcome.drop.count}`);
    });
    // 同一帧拾取的多件物品合并为一条提示，避免互相遮挡
    if (picked.length) GameUiHelper.createTip("pickup_tip", { names: picked.join(getText("label_list_separator")) });
    return picked.length;
  }

  /**
   * 获取被点击的掉落物节点（后掉落的节点在上层，优先命中）
   * 命中用 hitTest（屏幕坐标口径，与怪物选中/走路换算一致；废弃的 isHit 在窗口非设计分辨率时会偏移）
   */
  static getClickedDrop(position: Vec2): Node | null {
    const nodes = Array.from(this.dropMap.keys()).reverse();
    for (const node of nodes) {
      if (isValid(node) && node.getComponent(UITransform)?.hitTest(position)) return node;
    }
    return null;
  }

  /** 获取掉落物数据（无此掉落物返回 null） */
  static getDropItem(node: Node): DropItem | null {
    return this.dropMap.get(node) ?? null;
  }

  /** 点击拾取掉落物（服务端口径：发出 pick 帧即算受理，入包结果在 picked 帧回来后处理；背包满则保留在原地面并提示） */
  static pickup(node: Node): boolean {
    const request = this.requestPick(node);
    if (request.outcome === "full") {
      this.notifyBagFull();
      return false;
    }
    if (request.outcome === "picked" && request.drop) {
      const { good, count } = request.drop;
      GameUiHelper.createTip("pickup_tip", { names: getText("label_good_count", { name: good.label, count }) });
    }
    return true;
  }

  /**
   * 请求拾取一个掉落物（自动拾取与点击拾取共用的唯一入口）
   *
   * 服务端口径（带 pick 定位，#325）：发 pick 帧、节点保留在地面，入包与移除都等
   * picked 应答（applyPickedFrame）——背包放不放得下只有服务端知道，本地先斩后奏
   * 会演出入包了其实没有。应答在途（或刚超时未到重发前）返回 pending，不提示不重发。
   * 本地口径（回滚路径）：直接进本地背包，放不下返回 full。
   */
  private static requestPick(node: Node): PickRequest {
    const drop = this.dropMap.get(node);
    if (!drop) return { outcome: "pending" }; // 竞态：刚被别的路径拾走，不当背包满处理
    if (drop.pick) {
      const sentAt = this.pendingPicks.get(node);
      if (sentAt !== undefined) {
        if (Date.now() - sentAt < dropRuntime.pickReplyTimeout) return { outcome: "pending" };
        // 应答超时（帧丢失 / 断线期间）：撤掉在途标记，允许重新拾取
        this.pendingPicks.delete(node);
      }
      if (!CombatChannel.sendPick(drop.pick.castId, drop.pick.index)) return { outcome: "pending" }; // 通道不在线：等恢复后再试
      this.pendingPicks.set(node, Date.now());
      return { outcome: "pending" };
    }
    if (!StorageManager.addGood(drop.good, drop.count)) return { outcome: "full" };
    this.removeDropNode(node);
    return { outcome: "picked", drop };
  }

  /**
   * 服务端拾取应答的落点（#325；组合根把 CombatChannel.onPicked 接到这里）
   *
   * 成功：先把服务端实际写入的格子与修订号照搬进本地背包（StorageManager.applyPickResult），
   * 再移除地面节点 —— 顺序不能反，背包要合并的是「服务端落账后」的形状。
   * 拒绝：bag_full 走既有的节流提示（地面掉落物保留），其余记到 console。
   * 节点已不在（换图清场后的迟到应答）：入包照常应用，跳过地面部分。
   */
  static applyPickedFrame(data: PickResult): void {
    if (!data || typeof data !== "object") return;
    const node = this.findNodeByPick(data.castId, data.index);
    if (node) this.pendingPicks.delete(node);
    if (data.ok === false) {
      if (data.code === "bag_full") this.notifyBagFull();
      else console.warn(`[drop] 拾取被拒（castId=${data.castId} index=${data.index} code=${data.code}）：${data.message}`);
      return;
    }
    StorageManager.applyPickResult(data.placed, data.revision);
    if (!node) return; // 节点已不在（换图清场等）：入包已应用，没有地面部分要收
    const drop = this.dropMap.get(node);
    this.removeDropNode(node);
    // 幂等重放（alreadyPicked）没有新格子，但节点还留着说明上一份应答丢了 —— 照常收尾
    if (drop) GameUiHelper.createTip("pickup_tip", { names: getText("label_good_count", { name: drop.good.label, count: drop.count }) });
  }

  /** 按 castId + 下标找掉落物节点（picked 应答只带这两个数，倒查定位） */
  private static findNodeByPick(castId: number, index: number): Node | null {
    for (const [node, drop] of this.dropMap) {
      if (drop.pick && drop.pick.castId === castId && drop.pick.index === index) return node;
    }
    return null;
  }

  /** 收掉一个已入包的掉落物（注销悬停 + 销毁节点 + 清登记） */
  private static removeDropNode(node: Node) {
    this.dropMap.delete(node);
    this.pendingPicks.delete(node);
    CursorManager.unregisterHover(node);
    if (isValid(node)) node.destroy();
  }

  /** 背包已满提示（按 FULL_TIP_INTERVAL 节流，防止自动拾取时每帧刷屏） */
  private static notifyBagFull() {
    const now = Date.now();
    if (now - this.fullTipTime < this.FULL_TIP_INTERVAL) return;
    this.fullTipTime = now;
    GameUiHelper.createTip("pickup_full_tip");
  }
}
