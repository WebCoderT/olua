import GameUiHelper from "../../helpers/GameUiHelper";
import { RoleApi } from "../../utils/net/Api";
import type { MallLimit } from "../../utils/net/ApiModels";
import { getItem } from "../../../configs/items";
import { getMallPrice } from "../../../configs/game-config";
import { withRevision } from "./with-revision";
import RoleCache from "./role-cache";
import { getGoodDisplayName } from "./shared";
import { updateRoleUi } from "./ui-bridge";

/**
 * 商城服务（#1115 批次 6 自 StorageManager 拆出）：
 * 购买与限购库存（#304 / #846）—— 扣费与入包都在服务端，本地照搬回执。
 */
export default class MallService {

  //#region 商城

  /**
   * 商城购买（当前在线角色）：**扣费与入包都在服务端**（role.mallPurchase，#304）
   *
   * 商品与价格都读服务端（上架行就是唯一价格，与商城管理端同源，后台改价即时生效）；
   * 可售品类也是服务端目录说了算 —— 装备变体与药品（#763），客户端不另设白名单。
   * 物品由服务端放进存档背包网格（可叠加的药品会叠到已有格子）。
   * 本地预检只做即时 UX（下架/余额不足提示），服务端结果为准：
   * 服务端拒绝时（后台改价、被踢、乐观锁冲突）提示经请求层失败出口弹给玩家。
   *
   * 成功后以服务端返回为准刷新本地存档（bindGold / bag / revision），再走既有落盘与 UI 链路
   * （防抖推回 revision 与服务端一致，幂等）。买装备不改战斗属性，无需重算。
   * @returns 买完之后的限购/库存视图（调用方据它就地刷新卡片）；失败返回 null（原因已用浮动提示告知）
   */
  static async buyMallGood(id: string): Promise<MallLimit | null> {
    const good = getItem(id);
    // 解析不出配置 = 已下架 / 本体被删（本地预检，省一次请求）；品类不再在这里卡（#763 起有药品）
    if (!good) {
      GameUiHelper.createTip("mall_good_missing_tip");
      return null;
    }
    const role = RoleCache.findOnlineRole();
    if (!role) {
      GameUiHelper.createTip("mall_good_missing_tip");
      return null;
    }
    if (role.bindGold < getMallPrice(good)) {
      GameUiHelper.createTip("mall_bind_gold_not_enough_tip");
      return null;
    }
    const result = await withRevision(role, (revision) => RoleApi.mallPurchase(role.id, { goodId: id, revision }));
    if (!result) return null; // 失败提示已由请求层弹过（非 silent 请求）
    const data = result.data as Record<string, unknown>;
    role.bindGold = Number(data.bindGold ?? role.bindGold);
    // 服务端已把物品放进背包网格：以服务端那份为准整体替换（格子只存 key + 数量，无引用关系）
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    // revision 已由 withRevision 壳对齐
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
    GameUiHelper.createTip("mall_buy_success_tip", { name: getGoodDisplayName(good), price: result.consumed });
    // 回执里带着买完之后的「今日已购 / 已售 / 库存」：调用方就地更新卡片，不用再拉一次 mall-limits
    return {
      goodId: result.goodId,
      dailyBought: result.dailyBought,
      dailyLimit: result.dailyLimit,
      sold: result.sold,
      stock: result.stock,
      // 回执没有 purchasable（那是读取侧的合成分支），这里按同一判据现算：改完这一件之后还能不能再买
      purchasable:
        (result.dailyLimit <= 0 || result.dailyBought < result.dailyLimit) && (result.stock < 0 || result.sold < result.stock),
    };
  }

  /**
   * 商城的限购与库存（#846）：打开商城弹窗时拉一遍
   *
   * 快照里只有配置（`dailyLimit` / `stock`），「今天买了几个」「全服卖了几个」是运行时数字，
   * 服务端单独给一个只读接口。**失败返回空 Map**：商城陈列与购买不依赖它（服务端仍是权威），
   * 拿不到就只是不显示那几个小字，不该因此让商城打不开。
   */
  static async loadMallLimits(): Promise<Map<string, MallLimit>> {
    const role = RoleCache.findOnlineRole();
    if (!role) return new Map();
    try {
      const result = await RoleApi.mallLimits(role.id);
      const map = new Map<string, MallLimit>();
      (result.list ?? []).forEach((row) => map.set(row.goodId, row));
      return map;
    } catch {
      return new Map();
    }
  }
}
