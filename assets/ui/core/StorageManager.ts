import { sys } from "cc";
import RoleUIManager from "./RoleUIManager";
import SceneManager from "./SceneManager";
import SkillManager from "./SkillManager";
import { levelMap } from "../../configs/level";
import { roleMaxLevel } from "../../configs/growth";
import { initialShortcutKeys, bagRow, bagCol, maxRoleCount } from "../../configs/role";
import { Role } from "../../entities/Role";
import { BagCell, EQUIPMENT_TYPE, getGoodCount, Goods, isDrug, isEquipment } from "../../types/good";
import { MapId } from "../../types/map";
import { NeedSetShortcutKeyConfig } from "../../types/role";
import { SkillId } from "../../types/skill";
import GameHelper from "./GameHelper";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "./LayerManager";
import MpHelper from "../utils/battle/MpHelper";
import { skills } from "../../configs/skill";
import { getItem, moveBagCellGrid, normalizeBagGrid, recycleBagEquipmentGrid, summarizeBagRecycle, tidyBagGrid } from "../../configs/items";
import { getSoulLevel } from "../../configs/soul";

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
    if (roles.length < maxRoleCount) {
      roles.push(new Role(name, occupation, sex));
      this.setRoles(roles);
    } else {
      console.error(`角色超出上限（最多 ${maxRoleCount} 个）`);
    }
  }

  /** 根据id获取角色 */
  static findRoleById(id: string) {
    return this.getRoles().find((i) => i.id === id);
  }

  /**
   * 删除角色（选角界面「管理」入口调用，见 ui/RoleSelector 的删除按钮）
   *
   * 角色数据只存在本地存档的 roles 数组里，删除就是从数组移除并落盘，**不可恢复**。
   * 删完必须确认 selectedRole 不再指向已不存在的角色：玩家上次进游戏时选中过它，
   * 残留的选中项会让下一次 findOnlineRole 取到 undefined（进游戏直接卡在取角色那一步）；
   * 顺手也清掉「本来就指向不存在角色」的脏选中项（例如存档被外部改动过）。
   * @param id 角色 id（Role.id）
   * @returns 是否删除成功（角色不存在时返回 false，调用方据此区分提示）
   */
  static deleteRole(id: string): boolean {
    const roles = this.getRoles();
    const index = roles.findIndex((role) => role.id === id);
    if (index < 0) return false;
    roles.splice(index, 1);
    this.setRoles(roles);
    const selected = sys.localStorage.getItem("selectedRole");
    if (selected && !roles.some((role) => role.id === selected)) sys.localStorage.removeItem("selectedRole");
    return true;
  }

  /** 清空本地所有存储 */
  static clear() {
    sys.localStorage.clear();
  }

  /** 选择角色 */
  static onlineRole(id: string) {
    sys.localStorage.setItem("selectedRole", id);
  }

  /** 获取当前在线角色（每次读取都会补齐旧存档缺失的字段，见 ensureRoleDefaults） */
  static findOnlineRole() {
    const selectedRole = sys.localStorage.getItem("selectedRole");
    const role = this.getRoles().find((i) => i.id === selectedRole);
    // 存储里是 JSON.parse 出来的普通对象（非 Role 实例），字段可能缺后续版本新增的部分，
    // 统一在这里补齐，避免各调用方（快捷键栏/快捷键设置/落库）各自处理
    if (role) this.ensureRoleDefaults(role);
    return role;
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

  /**
   * 旧存档补齐（后续版本新增角色字段/新增配置项时都在这里补，保证读到的角色对象字段完整）
   * 调用时机：进入游戏取得在线角色之后（见 ui/Game.start）
   * - 魔法值：mp / maxMp / mpRecoverAccumulator（默认值规则见 utils/battle/MpHelper）
   * - 快捷键：按 configs/role.initialShortcutKeys 的按键码对齐（保留玩家已绑定的技能，补齐新增的按键槽，
   *   例如快捷键由 4 个扩展到 6 个后，旧存档会补出 5/6 两格，否则快捷键栏只显示旧有的 4 格）
   * - 装备槽：旧存档存的是装备快照对象，迁移为只存装备 id（新格式经配置表实时解析，改配置重启即生效）
   * - 背包：旧存档格子存的是物品快照对象，迁移为 { id, count }（物品数据经配置表实时解析）
   */
  static ensureRoleDefaults(role: Role) {
    MpHelper.ensureDefaults(role);
    (Object.keys(role.equipments) as EQUIPMENT_TYPE[]).forEach((slot) => {
      const value = role.equipments[slot] as unknown;
      if (value && typeof value === "object") {
        // 旧快照对象：取它的 id 作为槽位值（快照无 id 或 id 不在配置表时视为空槽）
        role.equipments[slot] = (value as Goods).id ?? null;
      } else if (typeof value !== "string") {
        role.equipments[slot] = null;
      }
    });
    // 背包格子迁移：旧快照（带 type 的完整物品对象）收敛为 { id, count }；新格式原样规整；无法确定 id 的格子丢弃
    role.bag = (Array.isArray(role.bag) ? role.bag : []).map((row) =>
      row.map((cell) => {
        if (!cell || typeof cell !== "object") return null;
        const snapshot = cell as Goods & Partial<BagCell>;
        const id = snapshot.id;
        if (!id) return null;
        // 旧快照带 type 字段：数量按物品叠加规则取（不可叠加恒 1）；新格式直接读 count
        const count = "type" in cell ? getGoodCount(cell as Goods) : Math.max(1, snapshot.count ?? 1);
        return { id, count };
      }),
    );
    // 背包尺寸对齐当前配置：旧存档的行/列数可能不是 bagRow × bagCol —— 尺寸不符时整理与拖动会按存档尺寸铺回，
    // 而界面格子是按当前配置生成的，两边对不上就会出现「物品铺进界面没有的格子」（见 configs/items.normalizeBagGrid）
    role.bag = normalizeBagGrid(role.bag, bagRow, bagCol);
    const saved: NeedSetShortcutKeyConfig[] = Array.isArray(role.shortcutKeys) ? role.shortcutKeys : [];
    role.shortcutKeys = initialShortcutKeys.map((config) => {
      const exist = saved.find((i) => i.key === config.key);
      return exist ? { ...config, ...exist } : { ...config };
    });
    // 战魂等级：旧存档缺失补 0（未激活）
    if (typeof role.soulOfWar !== "number") role.soulOfWar = 0;
    if (typeof role.soulShow !== "boolean") role.soulShow = false;
  }

  /**
   * 战魂升级（当前在线角色）：消耗下一级配置的绑定元宝升到下一级（见 configs/soul）
   * @returns 是否升级成功（失败原因已用浮动提示告知）
   */
  static upgradeSoul(): boolean {
    const role = this.findOnlineRole();
    if (!role) return false;
    const next = getSoulLevel(role.soulOfWar + 1);
    if (!next) {
      GameUiHelper.createTip("soul_max_tip");
      return false;
    }
    if (role.bindGold < next.bindGold) {
      GameUiHelper.createTip("soul_bind_gold_tip", { need: next.bindGold });
      return false;
    }
    role.bindGold -= next.bindGold;
    role.soulOfWar = next.level;
    // 战魂属性计入角色属性与战斗力，升级后重算
    Object.assign(role, GameHelper.combatCalc(role));
    this.updateOnlineRole(role);
    this.updateUi(role);
    GameUiHelper.createTip("soul_upgrade_tip", { level: next.level, label: next.label });
    return true;
  }

  /** 角色获得经验(当前在线角色) */
  static onlineRoleGetExp(exp: number) {
    const role = this.findOnlineRole();
    role.exp += exp;
    // 确认是否升级,经验满了则升级
    if (role.exp >= levelMap.get(role.level).exp) {
      // 扣除升级所需经验
      role.exp -= levelMap.get(role.level).exp;
      // 升级（等级上限跟成长曲线走，见 configs/growth 的 roleMaxLevel）
      if (role.level >= roleMaxLevel) role.level = roleMaxLevel;
      else role.level += 1;
      // 属性重新计算
      Object.assign(role, GameHelper.combatCalc(role));
      // 升级时补满血量与魔法值至最大值
      role.hp = role.maxHp;
      role.mp = role.maxMp;
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
    const role = this.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    const good = getItem(cell.id);
    if (!good) return false;
    if (isEquipment(good)) return this.equipFromBag(row, col);
    if (isDrug(good)) return this.useDrug(row, col);
    GameUiHelper.createTip("good_unsupported_tip");
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
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    // 格子只存物品 key，数据实时解析
    const good = getItem(cell.id);
    if (!good) return false;
    if (!isEquipment(good)) {
      GameUiHelper.createTip("equip_unsupported_tip");
      return false;
    }
    const reason = GameHelper.getEquipmentRejectReason(good);
    if (reason) {
      GameUiHelper.createTip(reason.key, reason.params);
      return false;
    }
    // 旧装备放回刚腾空的格子：格数守恒，换装不会丢装备（格子存 key，槽位也是 key）
    const wornId = role.equipments[good.slot];
    role.bag[row][col] = wornId ? { id: wornId, count: 1 } : null;
    role.equipments[good.slot] = good.id ?? cell.id;
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
    const equipmentId = role?.equipments[slot];
    if (!role || !equipmentId) return false;
    const cell = this.findEmptyBagCell(role);
    if (!cell) {
      GameUiHelper.createTip("bag_full_tip");
      return false;
    }
    // 从配置确认装备存在后，格子存 key（脱下后槽位清空）
    const equipment = getItem(equipmentId);
    if (!equipment) {
      GameUiHelper.createTip("equip_missing_tip");
      role.equipments[slot] = null;
      return false;
    }
    role.bag[cell.row][cell.col] = { id: equipmentId, count: 1 };
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

  //#region 背包丢弃

  /**
   * 取背包格子的丢弃预览（物品名 + 整格数量），供「两步确认」的第一次点击报数
   * 空格子 / 越界返回 null（调用方据此提示「这里没有可丢弃的物品」）；
   * id 已不在配置表时用 id 兜底当名字（丢弃本来就允许清理认不出的杂物）
   */
  static getBagDiscardPreview(row: number, col: number): { label: string; count: number } | null {
    const role = this.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!cell) return null;
    return { label: getItem(cell.id)?.label ?? cell.id, count: Math.max(1, cell.count) };
  }

  /**
   * 丢弃背包指定格子里的**整格**物品（当前在线角色，**不可恢复**）
   *
   * 与「一键回收」的分工：回收只吃装备、且折算成绑定元宝；丢弃对任何物品（装备/药品/材料）都生效、**不返还任何东西**，
   * 用来清理玩家不想要的东西。两者都会跳过身上穿着的装备 —— 槽位里的装备不在背包里，天然不受影响。
   *
   * 背包格子存的是 id + 数量，丢弃就是把该格置空：**可叠加物品整格一起丢**（不做「丢几个」的数量选择，
   * 要支持它得先引入数量输入控件，别在这里悄悄改语义，见 configs/texts.bag_discard_confirm_tip 的文案口径）。
   *
   * 规则判定与提示都在本层（界面只上报点击，见 BagDialog 的丢弃模式），丢弃不动属性/战力，故无需 updateUi
   * @param row 背包行
   * @param col 背包列
   * @returns 是否丢弃成功（空格子或越界时返回 false 并提示）
   */
  static discardBagGood(row: number, col: number): boolean {
    const role = this.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) {
      GameUiHelper.createTip("bag_discard_empty_tip");
      return false;
    }
    const label = getItem(cell.id)?.label ?? cell.id;
    const count = Math.max(1, cell.count);
    role.bag[row][col] = null;
    // 保存并刷新背包显示
    this.updateOnlineRole(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("bag_discard_done_tip", { name: label, count });
    return true;
  }

  //#endregion

  //#region 背包整理

  /**
   * 一键整理背包（当前在线角色）
   *
   * 搬运算法是纯函数 `configs/items.tidyBagGrid`（合并同类可叠加物 → 按等级/部位排序 → **从第一个格子起铺满**），
   * 这里只负责：取角色 → 调用 → **有变动才落盘刷新**，背包本来就整齐时不重复写存储
   * @returns 是否有变动（无角色/背包为空/整理前后一致时返回 false）
   */
  static tidyBag(): boolean {
    const role = this.findOnlineRole();
    if (!role) return false;
    if (this.bagIsEmpty(role.bag)) return false;
    const before = this.bagSignature(role.bag);
    role.bag = tidyBagGrid(role.bag);
    if (this.bagSignature(role.bag) === before) return false;
    // 保存并刷新背包显示
    this.updateOnlineRole(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("bag_tidy_tip");
    return true;
  }

  /** 背包是否一件东西都没有（空背包没什么可整理的） */
  private static bagIsEmpty(bag: BagCell[][]): boolean {
    return !bag.some((row) => row.some((cell) => !!cell));
  }

  /**
   * 背包内容指纹（整理前后比对用）：从第一格起逐格拼接，**空格也占一位**（`·`）
   *
   * 空格必须计入：否则「物品顺序没变、只是散着放」的背包（例：把第 3 格的药拖到第 8 格）指纹
   * 与整理完之后的一模一样，`tidyBag` 会判定「已经很整齐」直接返回 —— 玩家点整理却看不到东西
   * 回到第一个格子，这就是「整理要从第一个格子重新排列」这条反馈的来源。
   */
  private static bagSignature(bag: BagCell[][]): string {
    let signature = "";
    bag.forEach((row) =>
      row.forEach((cell) => {
        signature += cell ? `${cell.id}x${cell.count},` : "·";
      }),
    );
    return signature;
  }

  //#endregion

  //#region 背包格子搬运（拖动改变物品所在格子）

  /**
   * 拖动把背包一格里的物品搬到另一格（当前在线角色）
   *
   * 落点规则全在纯函数 `configs/items.moveBagCellGrid`：空格 = 移动、同种可叠加 = 合并（超过单格上限的留在原格）、
   * 其余 = 交换；这里只负责取角色 → 调用 → **真的动了才落盘刷新**。
   *
   * 与「整理」同一口径：**不弹提示** —— 拖动的反馈就是物品的位置/数量变化本身，
   * 每次落子都飘一条字反而吵；无效拖动（拖空格、拖回原格）静默返回 false
   * @returns 是否有变动（起点为空、起终点相同、越界、无角色时返回 false）
   */
  static moveBagGood(fromRow: number, fromCol: number, toRow: number, toCol: number): boolean {
    const role = this.findOnlineRole();
    if (!role) return false;
    const result = moveBagCellGrid(role.bag, { row: fromRow, col: fromCol }, { row: toRow, col: toCol });
    if (!result.moved) return false;
    role.bag = result.bag;
    // 保存并刷新背包显示
    this.updateOnlineRole(role);
    RoleUIManager.refreshBag();
    return true;
  }

  //#endregion

  //#region 背包回收

  /**
   * 背包里可回收装备的结算预览（件数 + 可得绑定元宝）
   * 回收不可撤销，所以按钮先要一份数给玩家看清楚（见 BagDialog 的二次确认）
   * 判定与计价都在配置层纯函数里（configs/items.summarizeBagRecycle），这里只取当前角色
   */
  static getBagRecycleSummary(): { count: number; totalPrice: number } {
    const role = this.findOnlineRole();
    if (!role) return { count: 0, totalPrice: 0 };
    return summarizeBagRecycle(role.bag);
  }

  /**
   * 一键回收背包内的全部装备（当前在线角色）：按件折算**绑定元宝**入账
   *
   * 只回收**背包里**的装备 —— 身上穿着的槽位不受影响；药品/材料/解析不出配置的 id 一概不动。
   * 搬运是纯函数 `configs/items.recycleBagEquipmentGrid`，这里只负责：
   * 取角色 → 调用 → 按合计价入账 → 落盘 → 刷新（角色信息栏的绑定元宝 + 背包格子）。
   * 计价口径见 configs/growth.equipmentRecyclePriceCurve（想调价只改那里）
   * @returns 是否回收成功（背包里没有可回收的装备时返回 false 并提示）
   */
  static recycleBagEquipments(): boolean {
    const role = this.findOnlineRole();
    if (!role) return false;
    const result = recycleBagEquipmentGrid(role.bag);
    if (!result.count) {
      GameUiHelper.createTip("bag_recycle_empty_tip");
      return false;
    }
    role.bag = result.bag;
    role.bindGold += result.totalPrice;
    // 保存并刷新（绑定元宝余额 + 背包格子）
    this.updateOnlineRole(role);
    this.updateUi(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("bag_recycle_tip", { count: result.count, price: result.totalPrice });
    return true;
  }

  //#endregion

  /**
   * 添加物品至背包（拾取掉落物/任务奖励等统一入口）
   * 可叠加物品优先合并到已有格子，剩余数量再占用空格
   * @param good 物品（取其 id 与叠加规则；格子只存 key + 数量，不存物品数据）
   * @param count 数量，缺省取物品自身数量
   * @returns 是否全部放入（背包满时返回 false，可能有部分放入）
   */
  static addGood(good: Goods, count: number = getGoodCount(good)): boolean {
    const role = this.findOnlineRole();
    // 掉落/奖励链路的物品都经 items 注册表带 id；没有 id 的物品无法入包
    const goodId = good.id;
    if (!role || count <= 0 || !goodId) return false;
    const stackable = !!good.stackable;
    const maxStack = good.maxStack ?? 99;
    let remaining = count;

    /** 剩余数量放入空格 */
    const fillEmptyCells = () => {
      for (let row = 0; row < role.bag.length && remaining > 0; row++) {
        for (let col = 0; col < role.bag[row].length && remaining > 0; col++) {
          if (role.bag[row][col]) continue;
          const add = stackable ? Math.min(maxStack, remaining) : 1;
          role.bag[row][col] = { id: goodId, count: add };
          remaining -= add;
        }
      }
    };

    if (stackable) {
      const stackCells: BagCell[] = [];
      role.bag.forEach((row) =>
        row.forEach((cell) => {
          if (cell && cell.id === goodId) stackCells.push(cell);
        }),
      );
      stackCells.forEach((cell) => {
        if (remaining <= 0) return;
        const canAdd = maxStack - cell.count;
        if (canAdd <= 0) return;
        const add = Math.min(canAdd, remaining);
        cell.count += add;
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
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return;
    const remaining = cell.count - 1;
    role.bag[row][col] = remaining > 0 ? { ...cell, count: remaining } : null;
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
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    // 格子只存物品 key，数据实时解析
    const good = getItem(cell.id);
    if (!good || !isDrug(good)) return false;
    // 当前仅实现回血（mp 等效果待资源字段补齐后在此扩展）
    const heal = good.effects.reduce((sum, effect) => sum + (effect.hp ?? 0), 0);
    if (heal <= 0) {
      GameUiHelper.createTip("drug_unsupported_tip");
      return false;
    }
    if (role.hp >= role.maxHp) {
      GameUiHelper.createTip("drug_full_tip");
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

  /** 跳转地图（不满足地图进入条件时提示并放弃，所有传送入口都经过这里） */
  static changeOnMap(mapId: MapId) {
    // 进入限制校验：等级/战斗力未达标时提示原因，不切换地图
    const reason = GameHelper.getMapEnterRejectReason(mapId);
    if (reason) {
      GameUiHelper.createTip(reason.key, reason.params);
      return;
    }
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

