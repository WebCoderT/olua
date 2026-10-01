import { Node, Size } from "cc";
import { Role } from "../../../entities/Role";
import { getEquipment } from "../../../configs/items";
import GameUiHelper from "../../helpers/GameUiHelper";

/** 内观尺寸 */
const IN_SHOW_SIZE = new Size(400, 400);

/**
 * 角色内观组件（角色信息弹窗中的衣服 + 武器内观）
 * 本组件为原点包装节点，内部内观节点保持弹窗坐标系下的原有位置
 * 换装时对应内观按新装备重建（未装备则移除）
 * 装备槽只存 id，每次刷新都经 configs/items 实时解析，改配置后重开弹窗即生效
 */
export default class RoleInShowView extends Node {
  /** 衣服内观节点 */
  private clothInShow: Node | null = null;
  /** 武器内观节点 */
  private weaponInShow: Node | null = null;

  constructor(role: Role) {
    super("role_in_show");
    this.updateCloth(role);
    this.updateWeapon(role);
  }

  /** 换装后刷新衣服内观 */
  updateCloth(role: Role) {
    if (this.clothInShow) this.clothInShow.destroy();
    this.clothInShow = null;
    const cloth = getEquipment(role.equipments.cloth);
    if (!cloth) return;
    this.clothInShow = GameUiHelper.createRoleClothInShow(cloth, IN_SHOW_SIZE);
    this.addChild(this.clothInShow);
  }

  /** 换装后刷新武器内观 */
  updateWeapon(role: Role) {
    if (this.weaponInShow) this.weaponInShow.destroy();
    this.weaponInShow = null;
    const weapon = getEquipment(role.equipments.weapon);
    if (!weapon) return;
    this.weaponInShow = GameUiHelper.createRoleWeaponInshow(weapon, IN_SHOW_SIZE);
    this.addChild(this.weaponInShow);
  }
}
