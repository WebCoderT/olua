import { Node } from "cc";
import { Role } from "../../../entities/Role";
import { getEquipment } from "../../../configs/items";
import { getFashionIn } from "../../../configs/fashionClothes";
import GameUiHelper from "../../helpers/GameUiHelper";
import { roleInShowLayout } from "../../../configs/hudLayout";
import { EQUIP_ALIGN, placeInShowWeapon } from "../../../configs/equipAlign";

/**
 * 角色内观组件（角色信息弹窗中的衣服 + 武器内观）
 * 本组件为原点包装节点，内部内观节点保持弹窗坐标系下的原有位置（尺寸见 configs/hudLayout.roleInShowLayout）
 * 换装时对应内观按新装备重建（未装备则移除）
 * 装备槽只存 id，每次刷新都经 configs/items 实时解析，改配置后重开弹窗即生效
 *
 * **武器位置为什么是算出来的**（2026-10-29）：素材内观画布 212×375 ~ 420×420、身体 100×100 ~ 400×400，
 * 写死一个 inPosition 只能对上一件。改成「读身体内观当前帧的内容 bbox，把武器缩放到它的 1.15 倍、
 * 贴到它的左手位」（算法唯一来源见 configs/equipAlign）—— 换任何衣服都成立，新增武器也不必手调数字。
 * 帧是异步落到 Sprite 上的，所以对齐挂在素材就绪回调里；两件素材谁后到都能触发一次重算。
 */
export default class RoleInShowView extends Node {
  /** 衣服内观节点 */
  private clothInShow: Node | null = null;
  /** 武器内观节点 */
  private weaponInShow: Node | null = null;
  /**
   * 对齐重试计数
   *
   * 「素材就绪」回调是在动画片段开始播放之后给的，而 Sprite 上的帧要等下一帧渲染才落上去，
   * 所以回调里常常还读不到帧（真机实测：武器停在 (0,0)、缩放还是 1）。这里按 50ms 重试，
   * 最多 20 次（≈1 秒）；素材真的缺帧时就停在那儿，不做无意义的重排。
   */
  private alignRetry = 0;

  constructor(role: Role) {
    super("role_in_show");
    this.updateCloth(role);
    this.updateWeapon(role);
  }

  /**
   * 换装 / 换时装后刷新衣服内观
   *
   * 取源：时装内观 > 装备衣服内观（#377）。时装只有内观资源、没有几何参数，
   * 所以位置/缩放仍按装备那件走（都没有时用默认值）。
   */
  updateCloth(role: Role) {
    if (this.clothInShow) this.clothInShow.destroy();
    this.clothInShow = null;
    const cloth = getEquipment(role.equipments.cloth);
    const fashionIn = getFashionIn(role.fashionCloth);
    if (!cloth && !fashionIn) return;
    const source = fashionIn ? { ...(cloth ?? {}), in: fashionIn } : cloth;
    if (!source) return;
    // 身体帧换了 → 握持点跟着变（素材就绪后再算一次）
    this.clothInShow = GameUiHelper.createRoleClothInShow(source, roleInShowLayout.size, () => this.alignWeapon());
    this.addChild(this.clothInShow);
  }

  /** 换装后刷新武器内观 */
  updateWeapon(role: Role) {
    if (this.weaponInShow) this.weaponInShow.destroy();
    this.weaponInShow = null;
    const weapon = getEquipment(role.equipments.weapon);
    if (!weapon) return;
    this.weaponInShow = GameUiHelper.createRoleWeaponInshow(weapon, roleInShowLayout.size, () => this.alignWeapon());
    this.addChild(this.weaponInShow);
  }

  /**
   * 把武器内观对齐到身体的握持点（算法见 configs/equipAlign.placeInShowWeapon）
   * 素材还没就绪（帧为 null）时什么都不做 —— 就绪回调会再来一次
   */
  private alignWeapon() {
    const clothBox = GameUiHelper.spriteContentBox(this.clothInShow);
    const weaponBox = GameUiHelper.spriteContentBox(this.weaponInShow);
    if (!clothBox || !weaponBox || !this.weaponInShow || !this.clothInShow) {
      this.retryAlign();
      return;
    }
    this.alignRetry = 0;
    // 身体内容 bbox（弹窗坐标系：衣服内观节点自身带着 inPosition，且可能带 inScaleX —— 如 cloth_5 是 1.3 倍）
    const clothPos = this.clothInShow.position;
    const clothScale = this.clothInShow.scale.x;
    const body = {
      cx: clothPos.x + clothBox.cx * clothScale,
      cy: clothPos.y + clothBox.cy * clothScale,
      w: clothBox.w * clothScale,
      h: clothBox.h * clothScale,
    };
    const placed = placeInShowWeapon(body, weaponBox);
    this.weaponInShow.setScale(placed.scale, placed.scale, 1);
    this.weaponInShow.setPosition(placed.x, placed.y, 0);
  }

  /** 素材还没落到 Sprite 上：隔一会儿再算（上限与间隔见 configs/equipAlign.EQUIP_ALIGN） */
  private retryAlign() {
    if (this.alignRetry >= EQUIP_ALIGN.alignRetryTimes) return;
    this.alignRetry += 1;
    setTimeout(() => {
      if (this.isValid) this.alignWeapon();
    }, EQUIP_ALIGN.alignRetryDelayMs);
  }
}
