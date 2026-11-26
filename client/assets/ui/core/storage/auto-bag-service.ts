import { EQUIPMENT_TYPE } from "../../../types/good";
import { findUsableCells, hasRecycleSelection } from "../../../configs/items";
import { equipmentSlots } from "../../../configs/equipments";
import GameUiHelper from "../../helpers/GameUiHelper";
import BagService from "./bag-service";
import RoleCache from "./role-cache";
import * as AutoBagPrefs from "./auto-bag-prefs";

/**
 * 背包自动化服务（#1278）：自动回收 / 自动使用 / 自动穿戴的**触发层**
 *
 * 三个能力都是「客户端替玩家按按钮」：判定与执行全部复用既有数据层
 * （回收 = BagService.recycleBySelection → 服务端 sellGoods；
 * 使用 = BagService.useGoodsBatch → 服务端 bagUseBatch（#1304：一次请求用掉能用的全部，
 * 单条接口仍留给手动点击）；穿戴 = BagService.equipBetterFromBag（quiet）），
 * 本类只回答「什么时候做、做几次」，不新增任何一条服务端链路。
 *
 * 触发点（唯二）：
 * · 背包变化 → `onBagChanged`（RoleUIManager.refreshBag 汇聚点）：自动使用 + 自动穿戴 + 自动回收扫描；
 * · 拾取被拒（服务端回 `bag_full`）→ `onBagFullRejected`（DropManager）：自动回收 + 重拾。
 *
 * #1289 重做：回收从「勾选物品清单、背包满才触发」改成「部位 × 等级段勾选 + 开关」——
 * 开关开着就**持续扫描**（背包每变一次扫一遍），符合勾选的装备直接回收成绑定元宝。
 *
 * 勾选偏好在本机（auto-bag-prefs，按角色分键）；**没勾的东西永远不会被自动处理**。
 */

/** 连发背包变化的合并窗口（毫秒）：拾取一波 / 自动使用逐格会把 refreshBag 连发十几次 */
const AUTO_BAG_SCAN_DEBOUNCE_MS = 150;

/**
 * 一次批量使用最多报多少格（#1304）
 *
 * 与服务端 `BagUseBatchDto` 的 `ArrayMaxSize(BAG_USE_BATCH_MAX_APPLY)` 对齐：
 * 报多了整个请求会被 40000 拒掉，所以客户端先截断，剩下的交给下一轮扫描。
 */
const AUTO_USE_BATCH_MAX = 64;

export default class AutoBagService {
  /** onBagChanged 的重入闸：自动使用/穿戴自身会改背包再触发 refreshBag，用闸把递归拍平 */
  private static busy = false;
  /** busy 期间又有背包变化：收尾后把变更再跑一遍（保证最终一致，不漏最后一次变化） */
  private static pending = false;
  /** 自动回收的在途闸：bag_full 拒绝可能连着来（自动拾取逐帧重试），回收请求别叠单 */
  private static recycling = false;
  /**
   * 尾随防抖句柄（#1300）：连发的背包变化并成一次扫描
   *
   * 拾取一波 / 自动使用逐格会把 refreshBag 连发十几次 —— 每次都直起一轮扫描的话，
   * 三段自动化（使用/穿戴/回收）会被空跑十几遍。150ms 内的变化合并成一次；
   * 扫描执行中（busy）的变化走原有 pending 闸，收尾的 do-while 消费，最终一致语义不变。
   */
  private static debounceHandle: ReturnType<typeof setTimeout> | null = null;

  /**
   * 背包变化后的统一检查：自动使用 + 自动穿戴（勾了才做，没勾零开销）
   *
   * 防重入：执行中的每一次背包变化都记进 `pending`，收尾后重跑一遍直到稳定 ——
   * 比「执行中直接忽略」稳：最后一件药吃完触发的刷新不会被吞掉。
   * 调用方（RoleUIManager.refreshBag）不 await：fire-and-forget，失败静默。
   */
  static onBagChanged(): void {
    AutoBagService.pending = true;
    // 扫描在跑：pending 会被收尾的 do-while 消费，不重复排班
    if (AutoBagService.busy) return;
    // 已排了一场扫描：这次变化等防抖到点一起算
    if (AutoBagService.debounceHandle !== null) return;
    AutoBagService.debounceHandle = setTimeout(() => {
      AutoBagService.debounceHandle = null;
      AutoBagService.startDrain();
    }, AUTO_BAG_SCAN_DEBOUNCE_MS);
  }

  /** 防抖到点起跑（busy 时直接返回：在跑的那轮的 do-while 会消费 pending） */
  private static startDrain(): void {
    if (AutoBagService.busy) return;
    AutoBagService.busy = true;
    void (async () => {
      try {
        await AutoBagService.drain();
      } finally {
        AutoBagService.busy = false;
      }
    })();
  }

  /** 至少跑一遍；执行期间积压的变化（busy 闸里记下的）收尾后继续跑，直到稳定 */
  private static async drain(): Promise<void> {
    do {
      AutoBagService.pending = false;
      await AutoBagService.runOnce();
    } while (AutoBagService.pending);
  }

  /** 一轮自动使用 + 自动穿戴 */
  private static async runOnce(): Promise<void> {
    const role = RoleCache.findOnlineRole();
    if (!role) return;
    // ── 自动使用：背包里勾选了的、可使用的物品，逐格用掉 ──
    const useIds = AutoBagPrefs.getUseIds(role.id);
    if (useIds.size > 0) {
      // 一次请求把「能用的都用了」（#1304 批量接口）：服务端逐条判血蓝满 / 冷却 / 等级区间，
      // 用不动的留在包里等下一轮扫描 —— 不再一格一次 HTTP。
      // count = 这一格的堆叠数：叠着的药 / 卷轴一次用完，不用一轮一轮啃。
      const targets = findUsableCells(role.bag, useIds)
        .slice(0, AUTO_USE_BATCH_MAX)
        .map((cell) => ({
          row: cell.row,
          col: cell.col,
          count: Math.max(1, Math.floor(role.bag[cell.row]?.[cell.col]?.count ?? 1)),
        }));
      if (targets.length > 0) {
        const result = await BagService.useGoodsBatch(targets);
        if (result && result.used > 0) GameUiHelper.createTip("auto_use_scan_tip", { count: result.used });
      }
    }
    // ── 自动穿戴：勾上后，背包里有「更好的」装备就换上（findBetterEquipmentInBag 口径；
    //    没穿的槽位任何可穿即穿）。quiet：等级/职业不够这类被拒不该刷屏 ──
    if (AutoBagPrefs.getAutoWear(role.id)) {
      const slots = Array.from(equipmentSlots.keys()) as EQUIPMENT_TYPE[];
      for (const slot of slots) {
        await BagService.equipBetterFromBag(slot, { quiet: true });
      }
    }
    // ── 自动回收：开关开着才扫；**放在最后** —— 先让自动穿戴把「更好的」拿走，
    //    剩下的才轮到回收，不然刚捡到的好装备会被先卖掉。quiet：没勾中就安静收场 ──
    if (AutoBagPrefs.getAutoRecycle(role.id)) {
      const selection = AutoBagPrefs.getRecycleSelection(role.id);
      if (hasRecycleSelection(selection)) {
        const result = await BagService.recycleBySelection(selection, { quiet: true });
        if (result) GameUiHelper.createTip("auto_recycle_scan_tip", { count: result.count, price: result.total });
      }
    }
  }

  /**
   * 拾取被拒（服务端回 `bag_full`）：按勾选清单自动回收腾格子，成功后重拾被拒的掉落物
   *
   * · **开关没开**（#1289 起自动回收必须显式打开）或清单全空 → 什么都不做：
   *   自动回收的安全边界是「开关 + 勾选，二者都满足才动手」；
   * · 回收请求在途时再来 bag_full → 直接忽略（回收完那一次请求自然腾出格子，
   *   自动拾取的节流窗口过后会继续捡剩下的）；
   * · 回收成功 → 飘一条「自动回收」提示，并立刻重试被拒的那件（走 requestPick 显式重发，
   *   不受自动拾取的背包满节流压制 —— 那个节流是防每帧刷屏的，不是防「腾完格子再捡」）。
   *
   * @param retryPickup 重拾回调（DropManager 提供：掉落物还在地面才重发 pick 帧）
   */
  static async onBagFullRejected(retryPickup: () => void): Promise<void> {
    const role = RoleCache.findOnlineRole();
    if (!role || AutoBagService.recycling) return;
    if (!AutoBagPrefs.getAutoRecycle(role.id)) return;
    const selection = AutoBagPrefs.getRecycleSelection(role.id);
    if (!hasRecycleSelection(selection)) return;
    AutoBagService.recycling = true;
    try {
      const result = await BagService.recycleBySelection(selection, { quiet: true });
      if (!result) return; // 没勾中的物品在包里 / 请求失败：安静收场
      GameUiHelper.createTip("auto_recycle_tip", { count: result.count, price: result.total });
      retryPickup();
    } finally {
      AutoBagService.recycling = false;
    }
  }
}
