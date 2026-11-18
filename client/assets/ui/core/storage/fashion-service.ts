import { EQUIPMENT_TYPE } from "../../../types/good";
import { Role } from "../../../entities/Role";
import { RoleApi } from "../../utils/net/Api";
import { fashionData, getFashion } from "../../../configs/game-config";
import RoleUIManager from "../RoleUIManager";
import RoleCache from "./role-cache";
import { updateRoleUi } from "./ui-bridge";

/**
 * 时装服务（#1115 批次 6 自 StorageManager 拆出）：
 * 穿脱 / 购买 / 拥有清单（#377 / #596）—— 只换外观，不换数值。
 */
export default class FashionService {

  //#region 时装（#377 穿脱 / #596 拥有清单与购买：只换外观，不换数值）

  /**
   * 是否拥有某件时装（#596：清单归服务端，本地只读 `role.fashionsOwned`）
   */
  static ownsFashion(fashionId: string): boolean {
    const owned = RoleCache.findOnlineRole()?.fashionsOwned;
    return owned ? owned.indexOf(fashionId) !== -1 : false;
  }

  /**
   * 购买时装（#596：扣费与拥有清单都在服务端）
   *
   * 服务端校验渠道（upgrade = 可购买）与价格（fashions 表，管理端改价即时生效），
   * 扣绑定元宝后把清单带回 —— 本地照搬（清单是服务端独占字段，本地造的无效）。
   * 失败（渠道没开 / 钱不够 / 已拥有）走请求层的失败出口提示，这里返回 false。
   *
   * @returns 是否购买成功
   */
  static async buyFashion(fashionId: string): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    if (!role) return false;
    const revision = typeof role.revision === "number" ? role.revision : undefined;
    let result: Awaited<ReturnType<typeof RoleApi.fashionBuy>>;
    try {
      result = await RoleApi.fashionBuy(role.id, { fashionId, revision });
    } catch {
      return false; // 失败提示已由请求层弹过（非 silent 请求）
    }
    role.fashionsOwned = result.owned;
    role.bindGold = result.bindGold;
    role.revision = result.revision;
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
    return true;
  }

  /**
   * 穿上时装（#596：穿着态归服务端，「拥有才给穿」在服务端校验）
   *
   * 服务端成功才改本地穿着态（fashionCloth 照搬返回值）；穿时装不重算任何数值
   * （只换外观，与 applyFashionChange 的口径一致）。
   *
   * @returns 是否穿上
   */
  static async wearFashion(fashionId: string): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    const fashion = getFashion(fashionId);
    if (!role || !fashion) return false;
    const revision = typeof role.revision === "number" ? role.revision : undefined;
    let result: Awaited<ReturnType<typeof RoleApi.fashionWear>>;
    try {
      result = await RoleApi.fashionWear(role.id, { fashionId, revision });
    } catch {
      return false; // 失败提示已由请求层弹过（未拥有 / 乐观锁冲突等）
    }
    role.fashionCloth = result.fashionCloth;
    role.fashionsOwned = result.owned;
    role.revision = result.revision;
    this.applyFashionChange(role);
    return true;
  }

  /**
   * 脱下当前时装（#596：与服务端 fashion-wear 同一条路；没穿时服务端幂等返回成功）
   * @returns 是否成功（服务端拒绝 = false，本地不动）
   */
  static async unwearFashion(): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    if (!role) return false;
    const revision = typeof role.revision === "number" ? role.revision : undefined;
    let result: Awaited<ReturnType<typeof RoleApi.fashionWear>>;
    try {
      result = await RoleApi.fashionWear(role.id, { fashionId: null, revision });
    } catch {
      return false; // 失败提示已由请求层弹过
    }
    role.fashionCloth = result.fashionCloth;
    role.fashionsOwned = result.owned;
    role.revision = result.revision;
    this.applyFashionChange(role);
    return true;
  }

  /**
   * 时装变更后的统一收尾（与时装无关的数值一概不动）
   *
   * 外观有三处要看：地图上的主角（RoleAppearance）、角色信息弹窗的内观（RoleInShowView）、
   * 下次进图的预载（PreloadManager）。前两处走 RoleUIManager，第三处读的就是 role 本身。
   * **不重算属性、不改血量** —— 时装只换外观，数值仍由装备决定（这是与「换衣服」最大的区别）。
   */
  static applyFashionChange(role: Role) {
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
    RoleUIManager.updateRoleOutShow(role);
    RoleUIManager.updateEquipmentDialog(EQUIPMENT_TYPE.CLOTH);
  }

  /** 当前穿戴的时装（没穿/配置里没有这件 → null） */
  static getWornFashion() {
    return getFashion(RoleCache.findOnlineRole()?.fashionCloth);
  }

  /** 衣柜清单（表里全部时装，界面按这个渲染） */
  static getFashionWardrobe() {
    return fashionData;
  }

  //#endregion
}
