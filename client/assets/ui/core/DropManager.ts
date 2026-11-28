import { isValid, Node, UITransform, Vec2, Vec3 } from "cc";
import { dropRuntime, FULL_SCREEN_PICKUP_RADIUS } from "../../configs/drop";
import { getGoodCursorStyle, cursorConfig } from "../../configs/cursor";
import { getItem } from "../../configs/items";
import { dropItemLayout } from "../../configs/layout/hud";
import { mapLabelOf } from "../../configs/game-config";
import { getText, TextParams } from "../../configs/texts";
import type { DropOwner } from "../../types/drop";
import type { MapId } from "../../types/map";
import type { Goods } from "../../types/good";
import { canPickLocally, protectSecondsLeft, timelineOf, type LocalPickVerdict } from "../utils/drop/DropRule";
import type {
  DropNoticeFrame,
  DropRemoveFrame,
  DropSnapshot,
  DropSpawnFrame,
  PickError,
  PickResult,
} from "../utils/net/CombatChannel";
import CombatChannel from "../utils/net/CombatChannel";
import RealtimeClient from "../utils/net/RealtimeClient";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "./LayerManager";
import CursorManager from "./CursorManager";
import StorageManager from "./StorageManager";
import AutoBagService from "./storage/auto-bag-service";
import PartyStore from "./PartyStore";
import GuideStore from "./GuideStore";
import SoundManager from "./SoundManager";
import { GUIDE_EVENT } from "../../types/guide";
import { getHitWindowId } from "../utils/input/Pointer";

/**
 * 地面上的一个掉落物（#804 起按 **dropId** 索引，不再按节点）
 *
 * 节点只是它的表现：换图 / 到期 / 被捡走时先把账清掉再拆节点，反过来的话迟到的
 * `picked` 应答会找不到东西可收。
 */
interface DropItem {
  /** 服务端实体的 id（`dropSpawn` / `world.drops` 给的那个，pick 帧也用它） */
  dropId: string;
  /** 物品数据（配置副本） */
  good: Goods;
  /** 掉落数量 */
  count: number;
  /** 地面节点 */
  node: Node;
  /** 归属标记（头像 + 「XX的」）：保护期结束时整块移除；自己的掉落 / 没画时为 null */
  ownerMark: Node | null;
  /** 归属者显示名（提示文案「XX 击杀的物品」用） */
  ownerName: string;
  /** 归属者账号 id（判「是不是我的」；空串 = 服务端没给） */
  ownerAccountId: string;
  /** 掉落那一刻归属者的队伍 id（空串 = 无队伍） */
  partyId: string;
  /** 时间轴是否算出来了（相对量缺失时为 false，所有时间判定放行） */
  hasExpiry: boolean;
  /** 本地到期时刻 */
  expireAtLocal: number;
  /** 本地保护期结束时刻 */
  protectUntilLocal: number;
  /** 兜底隐藏时刻（服务端 dropRemove 没到时用它，见 update） */
  fallbackHideAt: number;
}

/**
 * 拾取音的最小间隔（毫秒）
 *
 * 自动拾取会「走到哪捡到哪」，一片掉落物在几百毫秒内连着回十来个 `picked` 帧 ——
 * 每帧都响就成了持续的嗡嗡声。80ms 大致等于「一次弯腰能听清的间隔」，
 * 手动一个个点（人手间隔远大于它）不受影响。
 */
const PICKUP_SOUND_MIN_GAP_MS = 80;

/**
 * 拾取失败提示的最小间隔（毫秒，#804）
 *
 * 所有非「背包已满」的提示共用一个时间戳：踩在一件别人的掉落上时，自动拾取每帧都会
 * 判一次「还在保护期」，不节流就会刷成一列 —— 800ms 是「一眼能读完一句」的最短间隔。
 * 背包满单独用自己的 `fullTipInterval`（它还要顺带压制重试，不只是提示）。
 *
 * 为什么不做成运行时参数：这是「同一类提示别连刷」的表现层节流，与手感数值无关；
 * 开成配置项只会多一列没人会去调的参数（见 #747 的教训）。
 */
const DROP_TIP_MIN_GAP_MS = 800;

/**
 * 掉落管理器（静态类）
 *
 * **铺地只走服务端**（#802 / #804）：`dropSpawn` 增量 + `world.drops` 全量，两条路进同一个
 * `spawnOne`，所以「自己杀的」和「别人杀的」在地面上完全一样 —— 以前那套
 * 「击杀者走 settle 的 reward、旁观者走 monster-ai 的 kills」是两份实现，铺两遍、
 * 位置对不上、别人的还捡不起来，都出在这里。
 *
 * 客户端在这个链路里只有三件事：把服务端给的东西摆到它给的坐标上、按 `dropId` 发 pick 帧、
 * 把 `picked` 的九种结果翻成一句人话。**没有任何一件东西是客户端自己决定掉落的。**
 */
export default class DropManager {
  /** 地面上的掉落物：dropId → 数据（插入顺序即铺地顺序，点击命中按它反过来判） */
  private static items = new Map<string, DropItem>();
  /** 当前地图 id（帧里带的 mapId 与之不符时丢弃：换图途中的迟到广播不该铺到新图上） */
  private static currentMapId = "";
  /**
   * 自动拾取半径：角色节点原点即脚底，与掉落物节点距离小于该值视为踩在物品上（见 configs/drop.dropRuntime）
   * 背包已满的提示间隔同样取自 dropRuntime，避免每帧重复反序列化背包数据
   *
   * **必须用 getter 现读，不能写成 `static readonly`**（#605 踩过）：运营参数是进游戏后
   * 由快照覆写的，而静态字段的初始化发生在模块加载时 —— 那时快照还没到，取到的永远是
   * 出厂值，后台改了「没生效」且没有任何报错。同类的坑还有 `const X = cfg.y` 的模块级快照。
   */
  private static get autoPickupRadius(): number {
    // 全屏自动拾取（#1380）：开关开启时半径放宽到全屏（服务端距离闸同步放宽，
    // FULL_SCREEN_PICK_RANGE 同值——两端口径一致，否则客户端捡了服务端拒）
    if (dropRuntime.fullScreenPickup) return Math.max(dropRuntime.autoPickupRadius, FULL_SCREEN_PICKUP_RADIUS);
    return dropRuntime.autoPickupRadius;
  }
  private static get fullTipInterval(): number {
    return dropRuntime.fullTipInterval;
  }
  /** 上次背包已满提示时间戳 */
  private static fullTipTime = 0;
  /** 上次「其他拾取失败提示」时间戳（见 DROP_TIP_MIN_GAP_MS） */
  private static lastTipAt = 0;
  /** 拾取应答在途的掉落物：dropId → 发出 pick 帧的时刻（超过 pickReplyTimeout 允许重试） */
  private static readonly pendingPicks = new Map<string, number>();

  /**
   * 清空所有掉落物（**只**在换图 / 重连时调用）
   *
   * 日常不要拿它当「清屏幕」用：掉落是世界的，生命周期归服务端的 `expireAt` 与 `dropRemove`。
   */
  static reset() {
    this.items.forEach((drop) => {
      if (isValid(drop.node)) drop.node.destroy();
    });
    this.items.clear();
    this.pendingPicks.clear();
    this.currentMapId = "";
    LayerManager.clearDropLayer();
  }

  /**
   * 落一帧「地面掉落物的全量」（`world` 帧的 `drops`，#804）
   *
   * 换图与断线重连都走这里：**先清再按快照重建** —— 旧图的东西不能跟着进新图，
   * 重连后也不能留下「地上有、其实服务端早就没了」的幽灵节点。
   * @param drops 快照里的掉落物（可能为空数组或字段缺失）
   * @param mapId 这张图的 id（之后 `dropSpawn` 只认它）
   */
  static applySnapshot(drops: DropSnapshot[] | undefined, mapId: string): void {
    this.reset();
    this.currentMapId = mapId;
    if (!drops || drops.length === 0) return;
    // 这里**不响**掉落音：进图 / 重连看到的是「本来就躺在地上」的东西，没人在这一刻掉落。
    // 掉落音只跟 `dropSpawn`（真的刚掉下来）走。
    drops.forEach((snapshot) => this.spawnOne(snapshot));
  }

  /**
   * 铺一批新出现的掉落（`dropSpawn` 广播，#802）
   *
   * 这是**唯一**的增量铺地入口：击杀者自己也收这一帧（服务端广播含击杀者），
   * 所以「我看到自己打的怪掉东西」和「别人看到」是同一段代码。
   */
  static onDropSpawn(frame: DropSpawnFrame): void {
    if (!frame || !Array.isArray(frame.drops) || frame.drops.length === 0) return;
    // 换图途中的迟到广播：不是当前图的，铺上去就是幽灵
    if (this.currentMapId && frame.mapId && frame.mapId !== this.currentMapId) return;
    if (!this.currentMapId) this.currentMapId = frame.mapId ?? "";
    frame.drops.forEach((snapshot) => this.spawnOne(snapshot));
    void SoundManager.play("item_drop");
  }

  /**
   * 收掉一批掉落（`dropRemove`：#802 被捡走 / 过期 / 单图超限被挤掉）
   *
   * 客户端**不自己判生死**：到点不销毁、别人捡了也不靠猜 —— 等服务端说没了才拆节点。
   * 提前删会与「刚广播被捡走」打架，玩家看到的是「东西没了但包里没有」。
   */
  static onDropRemove(frame: DropRemoveFrame): void {
    if (!frame || !Array.isArray(frame.dropIds)) return;
    if (this.currentMapId && frame.mapId && frame.mapId !== this.currentMapId) return;
    frame.dropIds.forEach((dropId) => this.removeDropNode(dropId));
  }

  /**
   * 稀有掉落全服公告（`dropNotice`，#802）
   *
   * 用**现有系统飘字**显示一行（与升级飘字同款），不新开面板、不写进聊天 ——
   * 聊天没有全服频道，塞进去等于把「聊天」变成第二份公告。
   */
  static onDropNotice(frame: DropNoticeFrame): void {
    if (!frame || !Array.isArray(frame.items) || frame.items.length === 0) return;
    const names = frame.items
      .map((item) => getText("label_good_count", { name: item.label, count: item.count }))
      .join(getText("label_list_separator"));
    GameUiHelper.createTip("drop_notice_tip", {
      killer: frame.killerName,
      map: mapLabelOf(frame.mapId as MapId),
      monster: frame.monsterLabel,
      items: names,
    });
  }

  /**
   * 每帧驱动（组合根在 `Game.update` 里调）
   *
   * 只做两件本地事，都不参与绘制：
   * 1. 保护期结束 → 撤掉归属标记（头像 + 「XX的」前缀，一次性移除，不做动画）；
   * 2. 本地到期 + 宽限还留着 → 兜底拆掉（服务端 `dropRemove` 丢了才会走到这里，见 docs/18 §6.2）。
   *
   * 末段**没有任何表现**：不显示秒数、不变色、不改 alpha、不做缩放脉冲 —— 掉落的焦虑
   * 不该由客户端的呼吸灯制造（docs/18 已定项）。
   */
  static update(): void {
    if (this.items.size === 0) return;
    const now = Date.now();
    // 先收集再动手：Map 迭代中删元素在部分 js 引擎下会跳项
    for (const drop of Array.from(this.items.values())) {
      if (drop.ownerMark && drop.hasExpiry && now >= drop.protectUntilLocal) {
        if (isValid(drop.ownerMark)) drop.ownerMark.destroy();
        drop.ownerMark = null;
      }
      if (drop.hasExpiry && now >= drop.fallbackHideAt) this.removeDropNode(drop.dropId);
    }
  }

  /** 生成一个掉落物节点并挂到掉落层（快照与增量共用；坐标一律用服务端给的） */
  private static spawnOne(snapshot: DropSnapshot): void {
    if (!snapshot || !snapshot.dropId) return;
    // 同一件被铺两遍（进图全量与增量广播重叠）：以先到的为准，位置 / 时间都不重置，
    // 否则玩家会看到它「跳一下」并把保护期重新算一遍
    if (this.items.has(snapshot.dropId)) return;
    const good = getItem(snapshot.goodId);
    if (!good) {
      // 物品被运营下架：地面上不画（画了也只是个问号图标）；服务端那边它照样会到点过期
      console.warn(`[drop] 未知物品 ${snapshot.goodId}（dropId=${snapshot.dropId}），跳过铺地`);
      return;
    }
    const me = RealtimeClient.onlineUserId ?? "";
    // 自己的掉落不画归属标记：玩家知道自己是谁，挂个「我的」只会上地面变吵（docs/18 §6.7）
    const mine = !!me && snapshot.ownerAccountId === me;
    const owner: DropOwner | null = mine
      ? null
      : { name: snapshot.ownerName, occupation: snapshot.ownerClass, sex: snapshot.ownerSex };
    const timeline = timelineOf(Date.now(), snapshot.expireInMs, snapshot.protectInMs);
    const { node, ownerMark } = GameUiHelper.createDropItem(good, snapshot.count, dropItemLayout.iconSize, owner);
    LayerManager.addToDropLayer(node);
    node.setWorldPosition(snapshot.x, snapshot.y, 0);
    // 悬停显示该物品大类对应的指针颜色（拾取 / 收掉时注销）
    CursorManager.registerHover(node, cursorConfig.priority.drop, () => getGoodCursorStyle(good.type));
    this.items.set(snapshot.dropId, {
      dropId: snapshot.dropId,
      good,
      count: snapshot.count,
      node,
      ownerMark,
      ownerName: snapshot.ownerName ?? "",
      ownerAccountId: snapshot.ownerAccountId ?? "",
      partyId: snapshot.partyId ?? "",
      hasExpiry: timeline.hasExpiry,
      expireAtLocal: timeline.expireAtLocal,
      protectUntilLocal: timeline.protectUntilLocal,
      fallbackHideAt: timeline.fallbackHideAt,
    });
  }

  /**
   * 每帧自动拾取：角色走到掉落物上（脚底进入拾取范围）即请求拾取
   * 由组合根在 Game.update 中驱动
   * @param rolePosition 角色世界坐标（角色节点原点即脚底）
   * @param radius 拾取半径，缺省 dropRuntime.autoPickupRadius
   */
  static autoPickup(rolePosition: Vec3, radius: number = this.autoPickupRadius): void {
    if (this.items.size === 0) return;
    // 背包已满的节流期内直接跳过：既避免每帧刷提示，也避免每帧重复尝试入包
    if (Date.now() - this.fullTipTime < this.fullTipInterval) return;
    for (const drop of Array.from(this.items.values())) {
      const position = drop.node.getWorldPosition();
      const distance = Math.hypot(position.x - rolePosition.x, position.y - rolePosition.y);
      if (distance > radius) continue;
      const verdict = this.localVerdict(drop);
      // 还在保护期：不发请求，把「还要等几秒」先说清楚（服务端也会拒，但那条要等一个来回）
      if (verdict === "protected") {
        this.showProtectedTip(drop);
        continue;
      }
      // 本地已到期：服务端马上会发 dropRemove，这里静默跳过（主动点它时才提示「已消失」）
      if (verdict !== true) continue;
      this.requestPick(drop);
    }
  }

  /**
   * 获取被点击的掉落物节点（后铺的节点在上层，优先命中）
   * 命中用 hitTest（屏幕坐标口径，与怪物选中/走路换算一致；废弃的 isHit 在窗口非设计分辨率时会偏移）
   */
  static getClickedDrop(position: Vec2): Node | null {
    const drops = Array.from(this.items.values()).reverse();
    for (const drop of drops) {
      if (isValid(drop.node) && drop.node.getComponent(UITransform)?.hitTest(position, getHitWindowId())) return drop.node;
    }
    return null;
  }

  /**
   * 点击拾取掉落物
   *
   * 与自动拾取共用同一套预判：保护期内的点一下给「还要等几秒」，本地已到期的点一下给
   * 「物品已消失」并把节点收掉（**主动点**才提示，走过去不提示 —— docs/18 §6.2）。
   */
  static pickup(node: Node): boolean {
    const drop = this.findByNode(node);
    if (!drop) return false;
    const verdict = this.localVerdict(drop);
    if (verdict === "expired") {
      this.notifyTip("drop_expired_tip");
      this.removeDropNode(drop.dropId);
      return false;
    }
    if (verdict === "protected") {
      this.showProtectedTip(drop);
      return false;
    }
    this.requestPick(drop);
    return true;
  }

  /**
   * 请求拾取一件掉落物（自动拾取与点击拾取共用的唯一入口）
   *
   * 只做一件事：发 pick 帧，节点保留在地面 —— 入包与移除都等 `picked` 应答
   * （`applyPickedFrame`）。背包放不放得下只有服务端知道，本地先斩后奏会演出入包了其实没有。
   * 应答在途（或刚超时未到重发前）直接返回，不提示不重发。
   */
  private static requestPick(drop: DropItem): void {
    const sentAt = this.pendingPicks.get(drop.dropId);
    if (sentAt !== undefined) {
      if (Date.now() - sentAt < dropRuntime.pickReplyTimeout) return;
      // 应答超时（帧丢失 / 断线期间）：撤掉在途标记，允许重新拾取
      this.pendingPicks.delete(drop.dropId);
    }
    if (!CombatChannel.sendPick(drop.dropId)) return; // 通道不在线：等恢复后再试
    this.pendingPicks.set(drop.dropId, Date.now());
  }

  /**
   * 服务端拾取应答的落点（组合根把 `CombatChannel.onPicked` 接到这里）
   *
   * 成功：先把服务端实际写入的格子与修订号照搬进本地背包（StorageManager.applyPickResult），
   * 再移除地面节点 —— 顺序不能反，背包要合并的是「服务端落账后」的形状。
   * 失败：九种 code 每种一句话（docs/18 §6.4），该收节点的顺带收掉，不再无限重试。
   * 节点已不在（换图清场后的迟到应答）：入包照常应用，跳过地面部分。
   */
  static applyPickedFrame(data: PickResult): void {
    if (!data || typeof data !== "object") return;
    const drop = this.items.get(data.dropId);
    if (data.dropId) this.pendingPicks.delete(data.dropId);
    if (data.ok === false) {
      this.handlePickRejection(drop, data);
      return;
    }
    StorageManager.applyPickResult(data.placed, data.revision);
    // 拾取音（#685）：与铺到地上那声**同一个 key** —— 玩家听到的是「东西进包了」。
    // 挂在这里而不是 `pickup()`：发 pick 帧只是「请求」，背包满 / 被拒都拿不到这一声。
    // 带节流：自动拾取会连着回好几个 picked 帧（见 PICKUP_SOUND_MIN_GAP_MS）
    void SoundManager.play("item_drop", PICKUP_SOUND_MIN_GAP_MS);
    // 新手引导（#402）：「捡起来」那一步的判据是**服务端应答 ok**（包里真的多了东西），
    // 不是「走到掉落物上」—— 背包满了被拒的那次不该算学会。
    // **这三行不许动**（docs/18 §6.6）：位置、语义、连幂等重放也 notify 都照旧。
    GuideStore.notify(GUIDE_EVENT.PICKUP);
    if (!drop) return; // 节点已不在（换图清场等）：入包已应用，没有地面部分要收
    this.removeDropNode(drop.dropId);
    // 飘字用帧里带的东西（不再从地面节点上取）：节点可能被 dropRemove 先收走了
    // 不进消息记录（#1229）：进包那一刻 role-delta-log 会按背包差异记「获得 X ×N」——
    // 这里再记一条就是同一件事两条（而且那只覆盖拾取，覆盖不到购买/邮件/任务奖励）
    const label = getItem(data.goodId)?.label ?? data.goodId;
    GameUiHelper.createTip("pickup_tip", { names: getText("label_good_count", { name: label, count: data.count }) }, null);
  }

  /**
   * 拾取失败的九种 code（docs/18 §6.4 的表格，逐条对齐）
   *
   * 共同口径：**每种都有话说**。旧实现只认 `bag_full`，其余走 `console.warn` —— 玩家看到的是
   * 「点了没反应，一直点也没反应」。哪些要收节点也在这里定：`unknown_drop` / `item_gone` /
   * `already_picked` 都是「这件东西已经不可能再捡」，留着只会让自动拾取反复重试。
   */
  private static handlePickRejection(drop: DropItem | undefined, error: PickError): void {
    switch (error.code) {
      case "bag_full": {
        // 背包满沿用既有节流（fullTipInterval）：它同时压制重试，不只是提示
        this.notifyBagFull();
        // 自动回收（#1278）：勾了清单就回收腾格子，然后立刻重拾这件 ——
        // 显式重发走 requestPick，不受上面那个「防每帧刷屏」节流的压制；
        // 没勾任何东西时 onBagFullRejected 直接返回，行为与从前一致
        void AutoBagService.onBagFullRejected(() => {
          if (drop && this.items.has(drop.dropId)) this.requestPick(drop);
        });
        return;
      }
      case "protected": {
        const owner = error.ownerName || drop?.ownerName || "";
        const seconds = this.secondsOfWait(error.waitMs, drop);
        this.notifyTip("drop_protected_tip", { owner, n: seconds });
        return;
      }
      case "already_picked":
        this.notifyTip("drop_already_picked_tip", { name: error.byName || "" });
        if (drop) this.removeDropNode(drop.dropId);
        return;
      case "expired":
        this.notifyTip("drop_expired_tip");
        if (drop) this.removeDropNode(drop.dropId);
        return;
      case "too_far":
        this.notifyTip("drop_too_far_tip");
        return;
      case "not_on_map":
        // 不在同一张图：这个节点本来就不该在本地，收掉比留着更干净
        this.notifyTip("drop_not_on_map_tip");
        if (drop) this.removeDropNode(drop.dropId);
        return;
      case "item_gone":
        this.notifyTip("drop_item_gone_tip");
        if (drop) this.removeDropNode(drop.dropId);
        return;
      case "unknown_drop":
        // 静默收掉（docs/18 §6.4）：服务端已经没有这件了，再点还是这个答案，提示反而更烦
        console.warn(`[drop] 拾取未知掉落（dropId=${error.dropId}），节点已收掉`);
        if (drop) this.removeDropNode(drop.dropId);
        return;
      case "no_role":
      case "role_kicked":
        // 登录态异常：整条链路都不可用了，让玩家重新登录比反复点有用
        this.notifyTip("drop_login_abnormal_tip");
        return;
      default:
        this.notifyTip("drop_pick_failed_tip");
        console.warn(`[drop] 拾取被拒（dropId=${error.dropId} code=${error.code}）：${error.message}`);
        return;
    }
  }

  /** 「还要等几秒」：优先用服务端给的 waitMs，没有就用本地保护期时间轴（都没有就 0） */
  private static secondsOfWait(waitMs: number | undefined, drop: DropItem | undefined): number {
    if (typeof waitMs === "number" && Number.isFinite(waitMs) && waitMs > 0) return Math.ceil(waitMs / 1000);
    if (drop && drop.hasExpiry) return protectSecondsLeft(drop.protectUntilLocal, Date.now());
    return 0;
  }

  /** 本地预判（纯函数在 DropRule 里；这里只负责把当前身份喂进去） */
  private static localVerdict(drop: DropItem): LocalPickVerdict {
    return canPickLocally({
      now: Date.now(),
      me: RealtimeClient.onlineUserId ?? "",
      myPartyId: PartyStore.partyId(),
      drop: {
        hasExpiry: drop.hasExpiry,
        expireAtLocal: drop.expireAtLocal,
        protectUntilLocal: drop.protectUntilLocal,
        ownerAccountId: drop.ownerAccountId,
        partyId: drop.partyId,
      },
    });
  }

  /** 保护期提示（走统一节流：站在别人的掉落上自动拾取会每帧判一次） */
  private static showProtectedTip(drop: DropItem): void {
    this.notifyTip("drop_protected_tip", {
      owner: drop.ownerName,
      n: protectSecondsLeft(drop.protectUntilLocal, Date.now()),
    });
  }

  /** 按节点反查掉落数据（点击路径用；掉落数量一般几十个以内，线性找足够） */
  private static findByNode(node: Node): DropItem | null {
    for (const drop of this.items.values()) {
      if (drop.node === node) return drop;
    }
    return null;
  }

  /** 收掉一件掉落物（注销悬停 + 销毁节点 + 清登记） */
  private static removeDropNode(dropId: string): void {
    const drop = this.items.get(dropId);
    this.items.delete(dropId);
    this.pendingPicks.delete(dropId);
    if (!drop) return;
    if (drop.ownerMark && isValid(drop.ownerMark)) drop.ownerMark.destroy();
    CursorManager.unregisterHover(drop.node);
    if (isValid(drop.node)) drop.node.destroy();
  }

  /** 背包已满提示（按 fullTipInterval 节流，防止自动拾取时每帧刷屏） */
  private static notifyBagFull(): void {
    const now = Date.now();
    if (now - this.fullTipTime < this.fullTipInterval) return;
    this.fullTipTime = now;
    GameUiHelper.createTip("pickup_full_tip");
  }

  /** 拾取类提示（统一节流，见 DROP_TIP_MIN_GAP_MS） */
  private static notifyTip(name: string, params?: TextParams): void {
    const now = Date.now();
    if (now - this.lastTipAt < DROP_TIP_MIN_GAP_MS) return;
    this.lastTipAt = now;
    GameUiHelper.createTip(name, params);
  }
}
