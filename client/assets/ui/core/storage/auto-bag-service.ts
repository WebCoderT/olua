import { EQUIPMENT_TYPE } from "../../../types/good";
import { equipmentSlots, findUsableCells } from "../../../configs/items";
import GameUiHelper from "../../helpers/GameUiHelper";
import BagService from "./bag-service";
import RoleCache from "./role-cache";
import * as AutoBagPrefs from "./auto-bag-prefs";

/**
 * 背包自动化服务（#1278）：自动回收 / 自动使用 / 自动穿戴的**触发层**
 *
 * 三个能力都是「客户端替玩家按按钮」：判定与执行全部复用既有数据层
 * （回收 = BagService.recycleBySelection → 服务端 sellGoods；
 * 使用 = BagService.useGood（quiet）；穿戴 = BagService.equipBetterFromBag（quiet）），
 * 本类只回答「什么时候做、做几次」，不新增任何一条服务端链路。
 *
 * 触发点（唯二）：
 * · 背包变化 → `onBagChanged`（RoleUIManager.refreshBag 汇聚点）：自动使用 + 自动穿戴；
 * · 拾取被拒（服务端回 `bag_full`）→ `onBagFullRejected`（DropManager）：自动回收 + 重拾。
 *
 * 勾选偏好在本机（auto-bag-prefs，按角色分键）；**没勾的东西永远不会被自动处理**。
 */
export default class AutoBagService {
  /** onBagChanged 的重入闸：自动使用/穿戴自身会改背包再触发 refreshBag，用闸把递归拍平 */
  private static busy = false;
  /** busy 期间又有背包变化：收尾后把变更再跑一遍（保证最终一致，不漏最后一次变化） */
  private static pending = false;
  /** 自动回收的在途闸：bag_full 拒绝可能连着来（自动拾取逐帧重试），回收请求别叠单 */
  private static recycling = false;

  /**
   * 背包变化后的统一检查：自动使用 + 自动穿戴（勾了才做，没勾零开销）
   *
   * 防重入：执行中的每一次背包变化都记进 `pending`，收尾后重跑一遍直到稳定 ——
   * 比「执行中直接忽略」稳：最后一件药吃完触发的刷新不会被吞掉。
   * 调用方（RoleUIManager.refreshBag）不 await：fire-and-forget，失败静默。
   */
  static onBagChanged(): void {
    if (AutoBagService.busy) {
      AutoBagService.pending = true;
      return;
    }
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
      // 上限护栏：一格一格用（每用一格背包都会被服务端那份整体替换，重新扫），
      // 64 轮足以清空任何背包；用不动（冷却 / 等级区间 / 服务端拒绝）就停，别对同一格刷请求
      for (let guard = 0; guard < 64; guard++) {
        const cell = findUsableCells(role.bag, useIds)[0];
        if (!cell) break;
        const ok = await BagService.useGood(cell.row, cell.col, { quiet: true });
        if (!ok) break;
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
  }

  /**
   * 拾取被拒（服务端回 `bag_full`）：按勾选清单自动回收腾格子，成功后重拾被拒的掉落物
   *
   * · 没勾任何东西（清单全空）→ 什么都不做：自动回收的安全边界是「未勾选永不回收」；
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
    const selection = AutoBagPrefs.getRecycleSelection(role.id);
    if (!selection.allEquipment && selection.ids.size === 0) return;
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
