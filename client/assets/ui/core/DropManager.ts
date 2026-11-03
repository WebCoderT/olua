import { isValid, Node, UITransform, Vec2, Vec3 } from "cc";
import { dropRuntime } from "../../configs/drop";
import { getGoodCursorStyle, cursorConfig } from "../../configs/cursor";
import { getItem } from "../../configs/items";
import { getText } from "../../configs/texts";
import type { DropResult } from "../../types/drop";
import type { Goods } from "../../types/good";
import { scatterDropPositions } from "../utils/drop/DropScatter";
import type { PickResult } from "../utils/net/CombatChannel";
import CombatChannel from "../utils/net/CombatChannel";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "./LayerManager";
import CursorManager from "./CursorManager";
import StorageManager from "./StorageManager";
import GuideStore from "./GuideStore";
import SoundManager from "./SoundManager";
import { GUIDE_EVENT } from "../../types/guide";

/** 掉落物运行时数据（节点 -> 物品与数量） */
interface DropItem {
  /** 物品数据（配置副本） */
  good: Goods;
  /** 掉落数量 */
  count: number;
  /**
   * 服务端结算的拾取定位（#325）：击杀那次的 castId + reward.drops 下标。
   * **必填**（#581）：自己击杀的掉落只可能来自 settle 帧的 reward —— 以前「缺省 = 本地口径的掉落，
   * 直接进本地背包」那条回滚已经删掉（它等于给客户端开了一条「自己造物品」的路）。
   * **可缺省**（#689）：别人的击杀经 monster-ai 帧的 kills 广播铺场 —— 纯演出，
   * 没有账本定位（pick 账在击杀者名下），不可拾取（见 requestPick 的守卫）。
   */
  pick?: { castId: number; index: number };
}

/** 一次拾取请求的结果：pending = 已发 pick 帧等应答（**唯一**的正常结果）；full = 背包已满 */
type PickOutcome = "pending" | "full";

/**
 * 拾取音的最小间隔（毫秒）
 *
 * 自动拾取会「走到哪捡到哪」，一片掉落物在几百毫秒内连着回十来个 `picked` 帧 ——
 * 每帧都响就成了持续的嗡嗡声。80ms 大致等于「一次弯腰能听清的间隔」，
 * 手动一个个点（人手间隔远大于它）不受影响。
 */
const PICKUP_SOUND_MIN_GAP_MS = 80;

/** 拾取请求的返回值（#581 起没有「本地已入包」这一种：入包只能等服务端应答） */
interface PickRequest {
  outcome: PickOutcome;
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
   *
   * **必须用 getter 现读，不能写成 `static readonly`**（#605 踩过）：运营参数是进游戏后
   * 由快照覆写的，而静态字段的初始化发生在模块加载时 —— 那时快照还没到，取到的永远是
   * 出厂值，后台改了「没生效」且没有任何报错。同类的坑还有 `const X = cfg.y` 的模块级快照。
   */
  private static get autoPickupRadius(): number {
    return dropRuntime.autoPickupRadius;
  }
  private static get fullTipInterval(): number {
    return dropRuntime.fullTipInterval;
  }
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
   * 把一份**已经结算好**的掉落结果铺到指定位置（#316：掉落内容由服务端决定，这里只演）
   * @param results 掉落结果列表（goodId + count；可为空数组 —— 什么都没掉就不铺）
   * @param position 掉落位置（一般取怪物死亡时的世界坐标）
   * @param castId 结算的出手序号（**必填**：#581 起掉落物一律带服务端账本定位，
   *               拾取走 pick 帧、入包以 picked 帧为准）
   * @returns 原样返回 results（便于日志/统计）
   */
  static spawnResults(results: DropResult[], position: Vec3, castId: number): DropResult[] {
    return this.spawnAt(results, position, (result, index, offsets) => {
      const good = getItem(result.goodId);
      if (!good) {
        console.warn(`掉落物品不存在：${result.goodId}`);
        return;
      }
      this.createDropNode(good, result.count, position, offsets[index], { castId, index });
    });
  }

  /**
   * 把**别人击杀**的掉落铺到地面（#689：monster-ai 帧的 kills 事件）
   *
   * 与 spawnResults 的差别只有一样：没有 pick 定位 —— 服务端的掉落账本按击杀者的
   * castId 记（#325 归属设计），别人的账号既没有账也不该能拾。所以这些节点：
   * 不注册拾取指针（悬停不显示「可拾取」光标）、自动拾取跳过、点击不发 pick 帧。
   * 演出部分（掉落音 / 散落 / 图标与数量）与自己的掉落完全同一套。
   */
  static spawnRemoteDrops(results: DropResult[], position: Vec3): DropResult[] {
    return this.spawnAt(results, position, (result, index, offsets) => {
      const good = getItem(result.goodId);
      if (!good) {
        console.warn(`掉落物品不存在：${result.goodId}`);
        return;
      }
      this.createDropNode(good, result.count, position, offsets[index], null);
    });
  }

  /** 铺场共用骨架：掉落音 + 散落点计算 + 逐件落节点（pickable 决定每件带不带拾取定位） */
  private static spawnAt(
    results: DropResult[],
    position: Vec3,
    place: (result: DropResult, index: number, offsets: Vec2[]) => void,
  ): DropResult[] {
    // 掉落音（#683）：一次结算只响一次 —— 按件播会在「一堆怪同时死」时叠成一串噪音
    if (results.length > 0) void SoundManager.play("item_drop");
    // 先算全部散落点，再统一铺放：保证任意两件掉落物都不落在同一点上
    const offsets = scatterDropPositions(results.length);
    results.forEach((result, index) => place(result, index, offsets));
    return results;
  }

  /** 生成掉落物节点并挂载到掉落层（offset 为相对落点的散落偏移；pick 为 null = 纯演出不可拾取） */
  private static createDropNode(good: Goods, count: number, position: Vec3, offset: Vec2, pick: { castId: number; index: number } | null) {
    const { node } = GameUiHelper.createDropItem(good, count);
    LayerManager.addToDropLayer(node);
    node.setWorldPosition(position.x + offset.x, position.y + offset.y, position.z);
    this.dropMap.set(node, { good, count, pick: pick ?? undefined });
    // 鼠标移到掉落物上时显示该物品大类对应的指针颜色（拾取/换图时注销，见 removeDropNode / reset）；
    // 别人的掉落不可拾取（#689），不注册 —— 悬停不显示「可拾取」光标，避免误导
    if (pick) CursorManager.registerHover(node, cursorConfig.priority.drop, () => getGoodCursorStyle(good.type));
  }

  /**
   * 每帧自动拾取：角色走到掉落物上（脚底进入拾取范围）即请求拾取
   * 由组合根在 Game.update 中驱动
   * @param rolePosition 角色世界坐标（角色节点原点即脚底）
   * @param radius 拾取半径，缺省 AUTO_PICKUP_RADIUS
   * @returns 无（#581：入包只能等 picked 应答，这里没有「捡到了几件」可报）
   */
  static autoPickup(rolePosition: Vec3, radius: number = this.autoPickupRadius): void {
    // 背包已满的节流期内直接跳过：既避免每帧刷提示，也避免每帧重复尝试入包
    if (Date.now() - this.fullTipTime < this.fullTipInterval) return;
    Array.from(this.dropMap.keys()).forEach((node) => {
      // 已销毁的残留节点直接清理
      if (!isValid(node)) {
        this.dropMap.delete(node);
        return;
      }
      const position = node.getWorldPosition();
      const distance = Math.hypot(position.x - rolePosition.x, position.y - rolePosition.y);
      if (distance > radius) return;
      // 别人的击杀掉落（#689）不可拾取：踩上去不触发任何请求
      if (!this.dropMap.get(node)?.pick) return;
      const outcome = this.requestPick(node);
      if (outcome.outcome === "full") {
        this.notifyBagFull();
        return;
      }
    });
    // 提示在 picked 帧回来时给（applyPickedFrame）—— 那时才知道真的入包了
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
    return true;
  }

  /**
   * 请求拾取一个掉落物（自动拾取与点击拾取共用的唯一入口）
   *
   * 只做一件事：发 pick 帧，节点保留在地面 —— 入包与移除都等 picked 应答
   * （applyPickedFrame）。背包放不放得下只有服务端知道，本地先斩后奏会演出入包了其实没有。
   * 应答在途（或刚超时未到重发前）返回 pending，不提示不重发。
   *
   * #581 删掉了「没有 pick 定位就直接进本地背包」那条回滚：掉落物现在必带服务端账本定位，
   * 没有定位的节点只可能是脏数据 —— 与其静默入包，不如留在地面并告警。
   */
  private static requestPick(node: Node): PickRequest {
    const drop = this.dropMap.get(node);
    if (!drop) return { outcome: "pending" }; // 竞态：刚被别的路径拾走，不当背包满处理
    // 别人的击杀掉落（#689）：没有账本定位，本来就不该发 pick 帧（服务端也会拒）——
    // 自动拾取在上游已跳过，这里是点击路径的兜底：当作无事发生
    if (!drop.pick) return { outcome: "pending" };
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
    // 拾取音（#685）：与铺到地上那声**同一个 key** —— 玩家听到的是「东西进包了」。
    // 挂在这里而不是 `pickup()`：发 pick 帧只是「请求」，背包满 / 被拒都拿不到这一声。
    // 带节流：自动拾取会连着回好几个 picked 帧（见 PICKUP_SOUND_MIN_GAP_MS）
    void SoundManager.play("item_drop", PICKUP_SOUND_MIN_GAP_MS);
    // 新手引导（#402）：「捡起来」那一步的判据是**服务端应答 ok**（包里真的多了东西），
    // 不是「走到掉落物上」—— 背包满了被拒的那次不该算学会
    GuideStore.notify(GUIDE_EVENT.PICKUP);
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
    if (now - this.fullTipTime < this.fullTipInterval) return;
    this.fullTipTime = now;
    GameUiHelper.createTip("pickup_full_tip");
  }
}
