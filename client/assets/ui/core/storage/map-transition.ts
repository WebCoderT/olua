import GameUiHelper from "../../helpers/GameUiHelper";
import GameHelper from "../GameHelper";
import SceneManager from "../SceneManager";
import { MapId } from "../../../types/map";
import CombatChannel, { type MapEnterResult } from "../../utils/net/CombatChannel";
import RoleCache from "./role-cache";

/**
 * 传送标记的有效期（毫秒）
 *
 * 传送 → Loading（加载新地图资源）→ Game.start，正常几秒到十几秒。超过这个时长说明
 * 那次进图中途失败了（配置没就绪被弹回 Loading、场景被切走），标记该作废 ——
 * 否则下次从登录进来会莫名其妙响一声传送音。60 秒足够盖住最慢的一次资源加载。
 */
const TELEPORT_MARK_TTL_MS = 60000;

/**
 * 道具使用的连点节流（#847 / #848）
 *
 * **权威冷却在服务端**（药品读 `drugs.cooldown` 秒、货币道具固定 1 秒，超了回 20030 / 20031
 * 带剩余毫秒）。这里只做一件小事：一秒内对**同一个道具**的重复点击不再发请求，
 * 免得玩家连点时被同一个提示刷屏。键里带物品 id，所以先红后蓝照样能用。
 *

/**
 * 地图切换（#1115 批次 6 自 StorageManager 拆出）：
 * 本地预检 → 服务端判定 → 放行才切图（#606 三段，顺序有意义）。
 */
export default class MapTransition {
  /**
   * 「这次进游戏场景是传送过来的」时间戳（0 = 不是传送，#685）
   *
   * 传送音不能点在传送那一刻响（那时还在 Loading 场景里转圈，玩家听不出是传送还是加载），
   * 要等角色真的出现在新地图上。而「进游戏场景」这件事本身分不出是登录进来的还是传送进来的，
   * 所以由 `changeOnMap` 留一个标记、`Game.start` 在角色显示出来后取走。
   */
  private static teleportArrivedAt = 0;

  /** 标记「接下来这次进图是传送」（由 changeOnMap 调用） */
  private static markTeleportArrival() {
    this.teleportArrivedAt = Date.now();
  }

  /**
   * 取走传送标记（只在 `Game.start` 里调一次）
   *
   * 带有效期作废（见 TELEPORT_MARK_TTL_MS）：进图流程中途失败时这个标记不该留到下一次进图，
   * 否则登录进来也会莫名其妙响一声传送音。
   */
  static consumeTeleportArrival(): boolean {
    const pending = this.teleportArrivedAt > 0 && Date.now() - this.teleportArrivedAt < TELEPORT_MARK_TTL_MS;
    this.teleportArrivedAt = 0;
    return pending;
  }
  /** 正在等服务端放行的一次换图（`null` = 当前没有；防止连点重复发意图） */
  private static mapEnterPending = false;

  /**
   * 跳转地图（所有传送入口都经过这里）
   *
   * 三段，顺序有意义（#606）：
   *
   * 1. **本地预检**：读配置快照判一次，不满足立刻提示 —— 不联也能给反馈，不必等一个往返；
   * 2. **服务端判定**：权威在服务端（改包跳过第 1 步也没用）。通道不在线时退回老行为
   *    （本地判据说了算），通道在就发 `mapEnter` 等 `mapEnterResult`；
   * 3. **放行才切图**：被拒就按服务端给的那一项提示（文案仍是客户端这份），原地不动。
   *
   * 为什么不能「先切图、等服务端拒绝再退回」：切场景会先卸掉旧场景再加载新图，
   * 等 world 帧回来人已经站在一张空图里了 —— 回滚代价远大于先问一句。
   */
  static changeOnMap(mapId: MapId) {
    // ① 进入限制校验：等级/战斗力未达标时提示原因，不切换地图
    const role = RoleCache.findOnlineRole();
    // ① 进入限制校验：等级/战斗力未达标时提示原因，不切换地图
    const reason = GameHelper.getMapEnterRejectReason(mapId, role);
    if (reason) {
      GameUiHelper.createTip(reason.key, reason.params);
      return;
    }
    if (!role) return;
    // 传送点就在脚下：不必问服务端（老行为照样重进一次场景）
    if (role.onMap === mapId) {
      MapTransition.applyMapChange(mapId);
      return;
    }
    // 上一次判定还没回来，忽略这次连点（否则两个回调都会去切场景）
    if (MapTransition.mapEnterPending) return;
    // 通道不在线：退回老行为，本地判据说了算（断线也有得玩）
    if (!CombatChannel.active) {
      MapTransition.applyMapChange(mapId);
      return;
    }
    // ② 服务端判定（超时 / 通道掉线由 CombatChannel 兜底成放行 —— 本地判据已经过了）
    MapTransition.mapEnterPending = true;
    CombatChannel.requestMapEnter(mapId, (result: MapEnterResult) => {
      MapTransition.mapEnterPending = false;
      if (!result.ok) {
        // ③ 被拒：按服务端指出缺的那一项提示（文案 key 与本地预检同一套）
        const reject = GameHelper.mapEnterRejectText(result);
        if (reject) GameUiHelper.createTip(reject.key, reject.params);
        return;
      }
      MapTransition.applyMapChange(mapId);
    });
  }

  /** 真正切图（服务端已放行或通道不可用时的本地路径） */
  private static applyMapChange(mapId: MapId) {
    const role = RoleCache.findOnlineRole();
    if (!role) return;
    // 更改所在地图
    role.onMap = mapId;
    // 保存
    RoleCache.updateOnlineRole(role);
    // 传送成功音（#685）：**不在这里响**。此处到新地图出现还隔着 Loading 场景的资源加载，
    // 现在响等于「点了传送就有声音」，玩家听不出成功。留标记，等 Game.start 把角色摆出来再播
    // （见 consumeTeleportArrival）
    MapTransition.markTeleportArrival();
    // 重新进入游戏场景，走过渡场景完成新地图资源加载后再进入
    SceneManager.loadScene("Game");
  }
}
