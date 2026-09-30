import { sys } from "cc";
import RoleUIManager from "./RoleUIManager";
import SceneManager from "./SceneManager";
import SkillManager from "./SkillManager";
import { levelMap } from "../../configs/level";
import { Role } from "../../entities/Role";
import { EQUIPMENT_TYPE, getGoodCount, Goods, isDrug, isEquipment } from "../../types/good";
import { MapId } from "../../types/map";
import { SkillId } from "../../types/skill";
import GameHelper from "./GameHelper";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "./LayerManager";
import { skills } from "../../configs/skill";

/**
 * 存储管理器
 * 负责本地角色数据的读写，以及数据变更后的属性重算、UI刷新与外观更新
 */
export default class StorageManager {
  /** 获取角色列表 */
  static getRoles(): Role[] {
    const roles = sys.localStorage.getItem("roles");
    if (roles) return JSON.parse(roles);
    return [];
  }

  /** 更新角色列表 */
  static setRoles(roles: Role[]) {
    sys.localStorage.setItem("roles", JSON.stringify(roles));
  }

  /** 创建新角色 */
  static createRole(name: string, occupation: Role["occupation"], sex: Role["sex"]): void {
    const roles = this.getRoles();
    if (roles.length < 3) {
      roles.push(new Role(name, occupation, sex));
      this.setRoles(roles);
    } else {
      console.error("角色超出3个");
    }
  }

  /** 根据id获取角色 */
  static findRoleById(id: string) {
    return this.getRoles().find((i) => i.id === id);
  }

  /** 清空本地所有存储 */
  static clear() {
    sys.localStorage.clear();
  }

  /** 选择角色 */
  static onlineRole(id: string) {
    sys.localStorage.setItem("selectedRole", id);
  }

  /** 获取当前在线角色 */
  static findOnlineRole() {
    const selectedRole = sys.localStorage.getItem("selectedRole");
    return this.getRoles().find((i) => i.id === selectedRole);
  }

  /** 更新在线角色 */
  static updateOnlineRole(role: Role) {
    const roles = this.getRoles().map((i) => {
      if (i.id === role.id) {
        Object.assign(i, role);
      }
      return i;
    });
    this.setRoles(roles);
  }

  /** 角色获得经验(当前在线角色) */
  static onlineRoleGetExp(exp: number) {
    const role = this.findOnlineRole();
    role.exp += exp;
    // 确认是否升级,经验满了则升级
    if (role.exp >= levelMap.get(role.level).exp) {
      // 扣除升级所需经验
      role.exp -= levelMap.get(role.level).exp;
      // 升级
      if (role.level >= 30) role.level = 30;
      else role.level += 1;
      // 属性重新计算
      Object.assign(role, GameHelper.combatCalc(role));
      // 升级时补满血量至最大血量
      role.hp = role.maxHp;
      // 播放升级特效
      LayerManager.addToUILayer(GameUiHelper.createUpgradeEffect());
    }
    // 保存
    this.updateOnlineRole(role);
    // 更新UI
    this.updateUi(role);
  }

  //#region 背包物品使用

  /**
   * 使用背包物品（统一入口：背包左键、快捷键等一切「使用物品」都走这里）
   * 按物品大类分发，新增物品类型时在此补一条分支并实现对应的 useXxx：
   * 装备 → 穿戴、药品 → 服用、材料/其他 → 暂未开放（后续合成、任务用途在此扩展）
   * @param row 背包行
   * @param col 背包列
   * @returns 是否成功使用
   */
  static useGood(row: number, col: number): boolean {
    const good = this.findOnlineRole()?.bag[row]?.[col];
    if (!good) return false;
    if (isEquipment(good)) return this.equipFromBag(row, col);
    if (isDrug(good)) return this.useDrug(row, col);
    GameUiHelper.createTip("good_unsupported_tip", "该物品暂无可以使用的方式");
    return false;
  }

  /**
   * 从背包穿戴装备：脱下同槽位的旧装备并放回刚腾出的格子
   * 等级/性别/职业不符时提示原因并放弃（校验与文案由 GameHelper 给出）
   * @param row 背包行
   * @param col 背包列
   * @returns 是否穿戴成功
   */
  static equipFromBag(row: number, col: number): boolean {
    const role = this.findOnlineRole();
    const good = role?.bag[row]?.[col];
    if (!role || !good) return false;
    if (!isEquipment(good)) {
      GameUiHelper.createTip("equip_unsupported_tip", "该物品不能穿戴");
      return false;
    }
    const reason = GameHelper.getEquipmentRejectReason(good);
    if (reason) {
      GameUiHelper.createTip("equip_reject_tip", reason);
      return false;
    }
    // 旧装备放回刚腾空的格子：格数守恒，换装不会丢装备
    const worn = role.equipments[good.slot];
    role.bag[row][col] = worn ? { ...worn } : null;
    // 复制一份入槽，避免背包与装备槽共享同一个物品对象
    role.equipments[good.slot] = { ...good };
    this.applyEquipmentChange(role, good.slot);
    return true;
  }

  /**
   * 脱下装备放入背包（放进第一个空格；背包已满时提示并放弃）
   * @param slot 装备槽位
   * @returns 是否脱下成功
   */
  static unequipToBag(slot: EQUIPMENT_TYPE): boolean {
    const role = this.findOnlineRole();
    const equipment = role?.equipments[slot];
    if (!role || !equipment) return false;
    const cell = this.findEmptyBagCell(role);
    if (!cell) {
      GameUiHelper.createTip("bag_full_tip", "背包已满，无法脱下装备");
      return false;
    }
    role.bag[cell.row][cell.col] = { ...equipment };
    role.equipments[slot] = null;
    this.applyEquipmentChange(role, slot);
    return true;
  }

  /** 找背包的第一个空格（没有空格返回 null） */
  private static findEmptyBagCell(role: Role) {
    for (let row = 0; row < role.bag.length; row++) {
      for (let col = 0; col < role.bag[row].length; col++) {
        if (!role.bag[row][col]) return { row, col };
      }
    }
    return null;
  }

  /**
   * 装备变更后的统一收尾：属性重算 → 血量修正 → 落盘 → 刷新各视图
   * 装备影响 maxHp，脱下加血装备时当前血量要跟随上限下调，避免血量超过上限
   */
  private static applyEquipmentChange(role: Role, slot: EQUIPMENT_TYPE) {
    Object.assign(role, GameHelper.combatCalc(role));
    role.hp = Math.min(role.hp, role.maxHp);
    this.updateOnlineRole(role);
    this.updateUi(role);
    RoleUIManager.updateRoleOutShow(role);
    RoleUIManager.updateEquipmentDialog(slot);
    RoleUIManager.refreshBag();
  }

  //#endregion

  /**
   * 添加物品至背包（拾取掉落物/任务奖励等统一入口）
   * 可叠加物品优先合并到已有格子，剩余数量再占用空格
   * @param good 物品（内部会复制一份，避免污染配置表）
   * @param count 数量，缺省取物品自身数量
   * @returns 是否全部放入（背包满时返回 false，可能有部分放入）
   */
  static addGood(good: Goods, count: number = getGoodCount(good)): boolean {
    const role = this.findOnlineRole();
    if (!role || count <= 0) return false;
    const stackable = !!good.stackable;
    const maxStack = good.maxStack ?? 99;
    let remaining = count;

    /** 剩余数量放入空格 */
    const fillEmptyCells = () => {
      for (let row = 0; row < role.bag.length && remaining > 0; row++) {
        for (let col = 0; col < role.bag[row].length && remaining > 0; col++) {
          if (role.bag[row][col]) continue;
          const add = stackable ? Math.min(maxStack, remaining) : 1;
          role.bag[row][col] = { ...good, count: add };
          remaining -= add;
        }
      }
    };

    if (stackable) {
      const stackCells: Goods[] = [];
      role.bag.forEach((row) =>
        row.forEach((cell) => {
          if (cell && cell.type === good.type && cell.id === good.id) stackCells.push(cell);
        }),
      );
      stackCells.forEach((cell) => {
        if (remaining <= 0) return;
        const canAdd = maxStack - getGoodCount(cell);
        if (canAdd <= 0) return;
        const add = Math.min(canAdd, remaining);
        cell.count = getGoodCount(cell) + add;
        remaining -= add;
      });
    }
    // 剩余数量放入空格
    fillEmptyCells();

    if (remaining < count) {
      // 保存并刷新背包显示
      this.updateOnlineRole(role);
      RoleUIManager.refreshBag();
    }
    return remaining <= 0;
  }

  /**
   * 消耗背包指定格子中的一个物品（减到 0 时清空格子；仅可叠加物品有数量概念）
   * @param role 目标角色，缺省取当前在线角色（注意：角色对象每次从存储反序列化，需与调用方用同一个实例）
   */
  static consumeBagGood(row: number, col: number, role: Role | undefined = this.findOnlineRole()) {
    const good = role?.bag[row]?.[col];
    if (!role || !good) return;
    const remaining = getGoodCount(good) - 1;
    role.bag[row][col] = remaining > 0 ? { ...good, count: remaining } : null;
  }

  /**
   * 使用药品（当前在线角色）：按 effects 恢复血量并消耗一个
   * 魔法/增益类效果待角色具备对应资源字段（mp/maxMp）后在此扩展
   * @param row 背包行
   * @param col 背包列
   * @returns 是否成功使用（格子为空、非药品、无可生效效果、已满血时返回 false 且不消耗）
   */
  static useDrug(row: number, col: number): boolean {
    const role = this.findOnlineRole();
    const good = role?.bag[row]?.[col];
    if (!role || !good || !isDrug(good)) return false;
    // 当前仅实现回血（mp 等效果待资源字段补齐后在此扩展）
    const heal = good.effects.reduce((sum, effect) => sum + (effect.hp ?? 0), 0);
    if (heal <= 0) {
      GameUiHelper.createTip("drug_unsupported_tip", "该药品效果暂未开放");
      return false;
    }
    if (role.hp >= role.maxHp) {
      GameUiHelper.createTip("drug_full_tip", "血量已满");
      return false;
    }
    role.hp = Math.min(role.maxHp, role.hp + heal);
    // 消耗一个（复用同一个角色实例，保证消耗结果一起落盘）
    this.consumeBagGood(row, col, role);
    // 保存并刷新（血量与背包）
    this.updateOnlineRole(role);
    this.updateUi(role);
    RoleUIManager.refreshBag();
    return true;
  }

  /** 跳转地图 */
  static changeOnMap(mapId: MapId) {
    // 获取最新信息
    const role = this.findOnlineRole();
    // 更改所在地图
    role.onMap = mapId;
    // 保存
    this.updateOnlineRole(role);
    // 重新进入游戏场景，走过渡场景完成新地图资源加载后再进入
    SceneManager.loadScene("Game");
  }

  /** 更新UI */
  static updateUi(role: Role) {
    RoleUIManager.updateRoleData(role);
  }

  /** 更换快捷键技能 */
  static changeShortcutKey(index: number, skillId: SkillId) {
    const role = this.findOnlineRole();
    role.shortcutKeys[index].skillId = skillId;
    this.updateOnlineRole(role);
    const skill = skills.get(skillId);
    // 触发统一走 SkillManager（图标更新，回调改为按技能 id 释放，并同步冷却绑定）
    RoleUIManager.updateShortcutIcon(role.shortcutKeys[index].key, skill?.icon, () => SkillManager.release(skillId), skillId);
  }
}

