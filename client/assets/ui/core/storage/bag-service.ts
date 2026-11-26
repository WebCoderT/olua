import GameUiHelper from "../../helpers/GameUiHelper";
import GameHelper from "../GameHelper";
import SoundManager from "../SoundManager";
import RoleUIManager from "../RoleUIManager";
import { Role } from "../../../entities/Role";
import {
  BagCell,
  BagOrigin,
  Equipment,
  EQUIPMENT_TYPE,
  getGoodCount,
  Goods,
  isDrug,
  isEquipment,
  isLevelScroll,
  isMoneyItem,
  MoneyCurrency,
} from "../../../types/good";
import {
  collectBagRecycleEntries,
  findBagEquipmentUpgrade,
  getEquipment,
  getItem,
  MONEY_CURRENCY_LABELS,
  moveBagCellGrid,
  resolveDrugRecovery,
  tidyBagGrid,
  withBagMeta,
  wornIdOf,
} from "../../../configs/items";
import type { BagRecycleSelection } from "../../../configs/items";
import { equipmentBySlot, recycleLevelBands } from "../../../configs/equipments";
import { RoleApi } from "../../utils/net/Api";
import type { BagOp, BagOpResult } from "../../utils/net/ApiModels";
import { withRevision } from "./with-revision";
import RoleCache from "./role-cache";
import { getGoodDisplayName, guardRepeatedUse } from "./shared";
import { updateRoleUi } from "./ui-bridge";

/**
 * 背包服务（#1115 批次 6 自 StorageManager 拆出）：
 * 使用 / 穿脱 / 丢弃 / 整理 / 搬运 / 回收 / 入包 —— 五个写动作都经 runBagOp 走服务端权威。
 */
/**
 * 使用动作的可选项（#1278）：`quiet` = 自动路径（自动使用 / 自动穿戴）静默 ——
 * 失败与「用不了」的浮动提示一律不打（挂机时满血嗑药被拒这种事不该刷屏）；
 * 成功提示保留（玩家要知道东西被自动用了）。手动路径不传 = 照旧有提示。
 */
export interface UseOptions { quiet?: boolean }

export default class BagService {

  //#region 背包物品使用

  /**
   * 使用背包物品（统一入口：背包左键、快捷键等一切「使用物品」都走这里）
   * 按物品大类分发，新增物品类型时在此补一条分支并实现对应的 useXxx：
   * 装备 → 穿戴、药品 → 服用、货币道具 → 入账（#785）、升级卷轴 → 硬性 +1 级（#787）、
   * 材料/其他 → 暂未开放（后续合成、任务用途在此扩展）
   * @param row 背包行
   * @param col 背包列
   * @param opts `quiet` = 失败提示静默（自动路径用，见 UseOptions）
   * @returns 是否成功使用
   */
  static async useGood(row: number, col: number, opts: UseOptions = {}): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    const good = getItem(cell.id);
    if (!good) return false;
    if (isEquipment(good)) return await BagService.equipFromBag(row, col, opts);
    if (isDrug(good)) return await BagService.useDrug(row, col, opts);
    if (isMoneyItem(good)) return await BagService.useMoneyItem(row, col, opts);
    if (isLevelScroll(good)) return await BagService.useLevelScroll(row, col, opts);
    if (!opts.quiet) GameUiHelper.createTip("good_unsupported_tip");
    return false;
  }

  /**
   * 背包操作的统一出口（#556）：发出 `role.bagOp` 并把服务端那份结果抄回本地
   *
   * `bag` / `equipments` 从这一版起是**服务端独占字段**（见服务端 `role-authority.ts`）：
   * 本地改完会被下一次存档回填成库里的值 —— 所以五个背包动作都必须经过这里，
   * 否则表现就是「按下去没反应」（本地动了，推上去又被打回来）。
   *
   * 抄回来的是**整份**：背包、装备槽位、重算后的战斗属性、当前血量上限（服务端夹过）、修订号。
   * 只抄自己要改的那几格是不行的 —— 穿戴会换掉两处（格子 + 槽位），整理会动一整片。
   *
   * 不在这里刷界面：调用方各自的收尾不同（换装要刷内观与槽位、整理只刷网格），
   * 由它们自己接 `applyEquipmentChange` / `refreshBag`。
   *
   * @returns 服务端结果；失败（含乐观锁、被踢、校验拒绝）返回 null，提示已由请求层弹过
   */
  private static async runBagOp(role: Role, body: Omit<BagOp, "revision">): Promise<BagOpResult | null> {
    let result: BagOpResult;
    try {
      // 修订号带上做乐观锁：后台改过这个角色时（20006）服务端拒绝这次操作
      result = await RoleApi.bagOp(role.id, { ...body, revision: role.revision });
    } catch {
      return null; // 失败提示已由请求层弹过（非 silent 请求）
    }
    const data = result.data as Record<string, unknown>;
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    if (data.equipments && typeof data.equipments === "object" && !Array.isArray(data.equipments)) {
      role.equipments = data.equipments as typeof role.equipments;
    }
    // 穿脱会改属性，服务端当场重算过 —— 这里照搬，不必等下一个 roleUpdate 帧
    if (typeof data.combat === "number") role.combat = data.combat;
    if (typeof data.maxHp === "number") role.maxHp = data.maxHp;
    if (typeof data.maxMp === "number") role.maxMp = data.maxMp;
    if (typeof data.hpRecover === "number") role.hpRecover = data.hpRecover;
    // 血量当前值服务端会夹到新上限以内（脱掉加血装备时尤其需要），照搬比本地再判一次稳
    if (typeof data.hp === "number") role.hp = data.hp;
    if (typeof data.mp === "number") role.mp = data.mp;
    role.revision = result.revision;
    return result;
  }

  /** 背包内容转成接口要的**稀疏格子**（整理 / 搬运提交用：空格不报） */
  private static sparseBagCells(bag: BagCell[][]): Array<{ row: number; col: number; id: string; count: number }> {
    const cells: Array<{ row: number; col: number; id: string; count: number }> = [];
    bag.forEach((line, row) =>
      line.forEach((cell, col) => {
        if (cell) cells.push({ row, col, id: cell.id, count: Math.max(1, cell.count) });
      }),
    );
    return cells;
  }

  /**
   * 从背包穿戴装备（当前在线角色；穿戴由服务端判定与落库，#556）
   *
   * 本地仍留一道预检（格子解析得出装备、等级/性别/职业够）—— 它只为**即时提示**，
   * 服务端会再按库里的等级与真实的背包内容判一次：改包绕过预检也穿不上。
   * 旧装备由服务端放回刚腾出的那一格（格数守恒），这里不再自己算。
   *
   * @param row 背包行
   * @param col 背包列
   * @param opts `quiet` = 失败提示静默（自动穿戴路径用，见 UseOptions）
   * @returns 是否穿戴成功（失败原因已用浮动提示告知）
   */
  static async equipFromBag(row: number, col: number, opts: UseOptions = {}): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    // 格子只存物品 key，数据实时解析
    const good = getItem(cell.id);
    if (!good) return false;
    if (!isEquipment(good)) {
      if (!opts.quiet) GameUiHelper.createTip("equip_unsupported_tip");
      return false;
    }
    const reason = GameHelper.getEquipmentRejectReason(good, role);
    if (reason) {
      if (!opts.quiet) GameUiHelper.createTip(reason.key, reason.params);
      return false;
    }
    const result = await BagService.runBagOp(role, { action: "equip", row, col });
    if (!result) return false;
    BagService.applyEquipmentChange(role, (result.slot as EQUIPMENT_TYPE | null) ?? good.slot);
    // 穿戴成功音（#683）：服务端接受之后才响 —— 放在 `if (!result) return false` 后面，
    // 「点了但被拒」不该有成功音
    void SoundManager.play("equip_wear");
    return true;
  }

  /**
   * 脱下装备放入背包（放进第一个空格；背包已满时提示并放弃）
   *
   * 落点由服务端决定（第一个空格），本地不再自己找 —— 两边各找一套只会有一天对不上。
   * @param slot 装备槽位
   * @returns 是否脱下成功（失败原因已用浮动提示告知）
   */
  static async unequipToBag(slot: EQUIPMENT_TYPE): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    if (!role || !wornIdOf(role.equipments[slot])) return false;
    const result = await BagService.runBagOp(role, { action: "unequip", slot });
    if (!result) return false;
    BagService.applyEquipmentChange(role, slot);
    return true;
  }

  /**
   * 取身上某槽位穿戴的装备（未穿戴/解析不出返回 null）
   * 背包悬停详情「按住 Ctrl 对比」的数据源（见 GameUiHelper.createGood 的 compareWornProvider）
   * @param slot 装备槽位
   */
  static getWornEquipment(slot: EQUIPMENT_TYPE): Equipment | null {
    return getEquipment(wornIdOf(RoleCache.findOnlineRole()?.equipments[slot]));
  }

  /**
   * 背包里某槽位「更好的装备」在哪一格（角色信息弹窗提示角标的数据源）
   * 判定口径见 configs/items.findBagEquipmentUpgrade：同槽位 + 可穿（等级/性别/职业）+
   * 战斗力贡献严格大于当前穿戴件（空槽时任何可穿件都算提升）
   * @param slot 装备槽位
   * @returns 命中格坐标；没有更好的装备（或无角色）返回 null
   */
  static findBetterEquipmentInBag(slot: EQUIPMENT_TYPE): { row: number; col: number } | null {
    const role = RoleCache.findOnlineRole();
    if (!role) return null;
    const candidate = findBagEquipmentUpgrade(
      role.bag,
      slot,
      (equipment) => GameHelper.checkRoleCanUseEquipment(equipment, role),
      getEquipment(wornIdOf(role.equipments[slot])),
    );
    return candidate ? { row: candidate.row, col: candidate.col } : null;
  }

  /**
   * 一键换上背包里该槽位更好的装备（角色信息弹窗提示角标的点击入口、自动穿戴共用）
   * 复用 equipFromBag：校验/换装/旧装备回原格/属性重算与各处刷新都是同一条路
   * @param slot 装备槽位
   * @param opts `quiet` = 失败提示静默（自动穿戴路径用，见 UseOptions）
   * @returns 是否换上成功（没有更好的装备时返回 false，不打扰）
   */
  static async equipBetterFromBag(slot: EQUIPMENT_TYPE, opts: UseOptions = {}): Promise<boolean> {
    const better = BagService.findBetterEquipmentInBag(slot);
    if (!better) return false;
    return await BagService.equipFromBag(better.row, better.col, opts);
  }

  /**
   * 装备变更后的统一收尾：血量修正 → 落盘 → 刷新各视图
   * 装备影响 maxHp，脱下加血装备时当前血量要跟随上限下调，避免血量超过上限
   *
   * 属性与战斗力**不在客户端算**（#541 服务端权威，本游戏无离线形态）：
   * 落盘后服务端权威重算，roleUpdate 帧把结果带回来（applyServerRoleUpdate 统一落账）
   */
  private static applyEquipmentChange(role: Role, slot: EQUIPMENT_TYPE) {
    role.hp = Math.min(role.hp, role.maxHp);
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
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
    const role = RoleCache.findOnlineRole();
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
   * 置空这一步由服务端做（#556）：客户端只报「丢哪一格」，服务端按库里的那一格自己清 ——
   * 客户端报「结果」等于把销毁物品的权力交出去。丢弃不动属性/战力，故无需 updateUi
   * @param row 背包行
   * @param col 背包列
   * @returns 是否丢弃成功（空格子或越界时返回 false 并提示）
   */
  static async discardBagGood(row: number, col: number): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) {
      GameUiHelper.createTip("bag_discard_empty_tip");
      return false;
    }
    const label = getItem(cell.id)?.label ?? cell.id;
    const count = Math.max(1, cell.count);
    if (!(await BagService.runBagOp(role, { action: "discard", row, col }))) return false;
    // 服务端已清格：刷新显示（顺带把 updateOnlineRole 的防抖存档排上）
    RoleCache.updateOnlineRole(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("bag_discard_done_tip", { name: label, count });
    return true;
  }

  //#endregion

  //#region 背包整理

  /**
   * 一键整理背包（当前在线角色）
   *
   * 排序算法仍是纯函数 `configs/items.tidyBagGrid`（合并同类可叠加物 → 按等级/部位排序 →
   * **从第一个格子起铺满**）—— 它留在客户端是因为它是**展示规则**，而且单测（`test-bag-tidy`）
   * 跑的就是这一份。服务端不重算排布，只验**守恒**（同 id 总件数不变，见 `role.bagOp` 的 `tidy`）。
   *
   * 本地先算一遍的意义是「没变动就不发请求」：背包本来就整齐时点整理不该占一次网络往返。
   * @returns 是否有变动（无角色/背包为空/整理前后一致/请求失败时返回 false）
   */
  static async tidyBag(): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    if (!role) return false;
    if (BagService.bagIsEmpty(role.bag)) return false;
    const before = BagService.bagSignature(role.bag);
    const arranged = tidyBagGrid(role.bag);
    if (BagService.bagSignature(arranged) === before) return false;
    if (!(await BagService.runBagOp(role, { action: "tidy", cells: BagService.sparseBagCells(arranged) }))) return false;
    // 服务端那份才是权威排布（万一它按别的规则合并过），照它的结果刷新
    RoleCache.updateOnlineRole(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("bag_tidy_tip");
    // 整理成功音（#683）：与上面那句提示同一处 —— 只有「服务端接受 + 界面刷完」才算成功
    void SoundManager.play("bag_resort");
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
   * 其余 = 交换。本地算完之后把**整份排布**交给服务端（`role.bagOp` 的 `move`），
   * 由它验守恒（形状不变 + 同 id 总件数不变）—— 位置是展示规则，件数是钱，只有后者必须服务端说了算。
   *
   * 与「整理」同一口径：**不弹提示** —— 拖动的反馈就是物品的位置/数量变化本身，
   * 每次落子都飘一条字反而吵；无效拖动（拖空格、拖回原格）静默返回 false
   *
   * 只有「真的换成了新排布」才响整理音（#685，用户口径：位置一变就该有反馈）：
   * 请求失败那条分支已经先把界面还原了，那里不响。
   * @returns 是否有变动（起点为空、起终点相同、越界、无角色、请求失败时返回 false）
   */
  static async moveBagGood(fromRow: number, fromCol: number, toRow: number, toCol: number): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    if (!role) return false;
    const result = moveBagCellGrid(role.bag, { row: fromRow, col: fromCol }, { row: toRow, col: toCol });
    if (!result.moved) return false;
    // 拖动是高频操作：本地先摆好再发请求，界面在往返期间就已经是新位置；
    // 服务端拒绝（乐观锁 / 守恒不过）时把本地那份还原，别留一个「看着动了其实没动」的网格
    const previous = role.bag;
    role.bag = result.bag;
    RoleUIManager.refreshBag();
    if (!(await BagService.runBagOp(role, { action: "move", cells: BagService.sparseBagCells(result.bag) }))) {
      role.bag = previous;
      RoleUIManager.refreshBag();
      return false;
    }
    RoleCache.updateOnlineRole(role);
    RoleUIManager.refreshBag();
    // 背包位置变化音（#685）：与「一键整理」同一个 key —— 玩家听到的是「东西挪好了」。
    // 放在请求成功之后：上面失败分支已经把本地排布还原，那里不该响
    void SoundManager.play("bag_resort");
    return true;
  }

  //#endregion

  //#region 背包回收

  /**
   * 按勾选清单回收背包物品（当前在线角色）：按件折算**绑定元宝**入账（#1278）
   *
   * 「自动回收弹窗」里的一键回收与自动回收扫描共用这一个入口：
   * 勾了什么回收什么 —— 只可能是装备（部位 × 等级段，#1289），非装备不进清单；
   * 清单为空/背包里没有可回收的，就什么都不发。
   *
   * **结算在服务端**（#397）：本地只负责「把要卖的东西列出来」（goodId + 件数），
   * 价格与扣物都由 `role.sellGoods` 说了算 —— 客户端报的价一概不看，改存档也改不出钱。
   * 服务端返回的 bag / bindGold / revision 直接覆盖本地（与商城购买同一套手法，
   * 见 buyMallGood）：本地不再自己算「扣掉哪几格」，两边各算一套必然有一天对不上。
   *
   * @param selection 勾选清单（configs/items.BagRecycleSelection）
   * @param opts `quiet` = 空清单不弹提示（自动回收路径用）
   * @returns 回收件数与合计价（清单为空 / 无可回收 / 请求失败返回 null；
   *          失败提示已由请求层弹过，成功提示由调用方按场景决定措辞）
   */
  static async recycleBySelection(
    selection: BagRecycleSelection,
    opts: UseOptions = {},
  ): Promise<{ count: number; total: number } | null> {
    const role = RoleCache.findOnlineRole();
    if (!role) return null;
    const entries = collectBagRecycleEntries(role.bag, selection);
    const count = entries.reduce((sum, entry) => sum + entry.count, 0);
    if (!count) {
      if (!opts.quiet) GameUiHelper.createTip("bag_recycle_empty_tip");
      return null;
    }
    const result = await withRevision(role, (revision) => RoleApi.sellGoods(role.id, { entries, revision }));
    if (!result) return null; // 失败提示已由请求层弹过（非 silent 请求）
    const data = result.data as Record<string, unknown>;
    role.bindGold = Number(data.bindGold ?? role.bindGold);
    // 服务端已经扣完格子：以它那份为准整体替换（格子只存 key + 数量，无引用关系）
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    role.revision = result.revision;
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
    RoleUIManager.refreshBag();
    return { count: result.count, total: result.total };
  }

  /**
   * 一键回收背包内的全部装备（当前在线角色）：按件折算**绑定元宝**入账
   *
   * #1289 起勾选清单是「部位 × 等级段」；「全部装备」= 所有部位 × 全部等级段
   * （段边界现取 recycleLevelBands()，与弹窗清单同一份规则，不会各算一套）。
   *
   * 计价口径见共享快照的出售价表，与预览同一个来源。
   * @returns 是否回收成功（背包里没有可回收的装备时返回 false 并提示）
   */
  static async recycleBagEquipments(): Promise<boolean> {
    const bands = recycleLevelBands().map((band) => band.min);
    const slots: Record<string, number[]> = {};
    equipmentBySlot.forEach((_bucket, slot) => { slots[slot] = bands; });
    const result = await BagService.recycleBySelection({ slots });
    if (!result) return false;
    GameUiHelper.createTip("bag_recycle_tip", { count: result.count, price: result.total });
    return true;
  }

  //#endregion

  /**
   * 添加物品至背包（本地接口：拾取已改走服务端 `picked` 帧，见 applyPickResult）
   *
   * 可叠加物品优先合并到**绑定态相同**的已有格子，剩余数量再占用空格。
   * 绑定态不同不许并堆（#789）：绑定的那堆不可交易，混进可交易的堆就永远分不开了，
   * 反过来等于凭空洗白一件。
   *
   * @param good 物品（取其 id 与叠加规则；格子只存 key + 数量，不存物品数据）
   * @param count 数量，缺省取物品自身数量
   * @param meta 绑定与溯源（服务端判定好的；缺省 = 未绑定、无溯源）
   * @returns 是否全部放入（背包满时返回 false，可能有部分放入）
   */
  static addGood(good: Goods, count: number = getGoodCount(good), meta: { bound?: boolean; from?: BagOrigin } = {}): boolean {
    const role = RoleCache.findOnlineRole();
    // 掉落/奖励链路的物品都经 items 注册表带 id；没有 id 的物品无法入包
    const goodId = good.id;
    if (!role || count <= 0 || !goodId) return false;
    const stackable = !!good.stackable;
    const maxStack = good.maxStack ?? 99;
    const bound = meta.bound === true;
    let remaining = count;

    /** 剩余数量放入空格 */
    const fillEmptyCells = () => {
      for (let row = 0; row < role.bag.length && remaining > 0; row++) {
        for (let col = 0; col < role.bag[row].length && remaining > 0; col++) {
          if (role.bag[row][col]) continue;
          const add = stackable ? Math.min(maxStack, remaining) : 1;
          role.bag[row][col] = withBagMeta(goodId, add, { bound: meta.bound, from: meta.from });
          remaining -= add;
        }
      }
    };

    if (stackable) {
      const stackCells: BagCell[] = [];
      role.bag.forEach((row) =>
        row.forEach((cell) => {
          // 只并进同绑定态的堆：两侧 `bound` 都按「是否 === true」比，脏值不影响判定
          if (cell && cell.id === goodId && (cell.bound === true) === bound) stackCells.push(cell);
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
      RoleCache.updateOnlineRole(role);
      RoleUIManager.refreshBag();
    }
    return remaining <= 0;
  }

  /**
   * 消耗背包指定格子中的一个物品（减到 0 时清空格子；仅可叠加物品有数量概念）
   * @param role 目标角色，缺省取当前在线角色（注意：角色对象每次从存储反序列化，需与调用方用同一个实例）
   */
  static consumeBagGood(row: number, col: number, role: Role | undefined = RoleCache.findOnlineRole()) {
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return;
    const remaining = cell.count - 1;
    role.bag[row][col] = remaining > 0 ? { ...cell, count: remaining } : null;
  }

  /**
   * 使用药品（当前在线角色）：**回复结算与格子扣减都在服务端**（role.drugUse，#308）
   *
   * 回复量与药品管理端同源（drugs 表，管理端改回复量即时生效）；maxHp/maxMp 用服务端重算的
   * 战斗属性。本地预检（空格 / 非药 / 无生效效果 / 血蓝满提示）只做即时 UX —— 服务端结果为准，
   * 预检放行但服务端拒绝时（管理端并发改动、被踢、乐观锁冲突），提示经请求层失败出口弹给玩家。
   *
   * 成功后以服务端返回为准刷新本地存档（hp / mp / bag / revision），再走既有落盘与 UI 链路
   * （防抖推回 revision 与服务端一致，幂等）。用药不改战斗属性，无需重算。
   * @param row 背包行
   * @param col 背包列
   * @returns 是否成功使用（失败原因已用浮动提示告知）
   */
  static async useDrug(row: number, col: number, opts: UseOptions = {}): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    // 格子只存物品 key，数据实时解析
    const good = getItem(cell.id);
    if (!good || !isDrug(good)) return false;
    // 本地期望回复量（未封顶）：没有任何分量的药品等于没实现 —— 只做预检，服务端按库里配置算
    const recovery = resolveDrugRecovery(good.effects, role.maxHp, role.maxMp);
    const healsHp = recovery.hp > 0;
    const healsMp = recovery.mp > 0;
    if (!healsHp && !healsMp) {
      if (!opts.quiet) GameUiHelper.createTip("drug_unsupported_tip");
      return false;
    }
    // 血蓝都已满（该药对应的资源都回不动）→ 提示且不发请求（与服务端同一判定式）
    const hpFull = role.hp >= role.maxHp;
    const mpFull = role.mp >= role.maxMp;
    if ((!healsHp || hpFull) && (!healsMp || mpFull)) {
      // 自动使用路径静默：满血满蓝不嗑药是常态不是异常，刷提示只会打扰挂机
      if (!opts.quiet) GameUiHelper.createTip(healsHp ? "drug_full_tip" : "drug_mp_full_tip");
      return false;
    }
    // 连点节流（#848）：同一瓶药一秒内只发一次请求，冷却本身由服务端裁
    if (!guardRepeatedUse(`drug:${cell.id}`)) return false;
    const result = await withRevision(role, (revision) => RoleApi.drugUse(role.id, { row, col, revision }));
    if (!result) return false; // 失败提示已由请求层弹过（非 silent 请求）
    const data = result.data as Record<string, unknown>;
    if (data.hp !== undefined) role.hp = Number(data.hp);
    if (data.mp !== undefined) role.mp = Number(data.mp);
    // 服务端已扣减格子：以服务端那份为准整体替换（格子只存 key + 数量，无引用关系）
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    // revision 已由 withRevision 壳对齐
    // 保存并刷新（血蓝与背包）
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
    RoleUIManager.refreshBag();
    return true;
  }

  /**
   * 使用货币物品（当前在线角色）：**入账与格子扣减都在服务端**（role.moneyUse，#785）
   *
   * 金额与币种一律读服务端 `money_items` 表 —— 客户端只报「用哪一格」，报什么都不算数；
   * 管理端改面值 / 删掉一条，玩家手上的旧格子要么按新面值入账、要么被服务端判「用不了」。
   * 本地预检（空格 / 非货币道具）只做即时 UX，服务端结果为准。
   *
   * 成功后以服务端返回为准刷新本地存档（对应账本字段 / bag / revision），再走既有落盘与 UI 链路
   * （防抖推回 revision 与服务端一致，幂等）。入账不改战斗属性，无需重算。
   * @param row 背包行
   * @param col 背包列
   * @param opts `quiet` = 失败提示静默（自动使用路径用，见 UseOptions）
   * @returns 是否成功使用（失败原因已用浮动提示告知）
   */
  static async useMoneyItem(row: number, col: number, opts: UseOptions = {}): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    // 格子只存物品 key，数据实时解析（不是货币道具就当不了钱用）
    const good = getItem(cell.id);
    if (!good || !isMoneyItem(good)) {
      if (!opts.quiet) GameUiHelper.createTip("money_use_invalid_tip");
      return false;
    }
    // 连点节流（#847）：同一个道具一秒内只发一次请求（服务端另有 1 秒权威冷却）
    if (!guardRepeatedUse(`money:${cell.id}`)) return false;
    const result = await withRevision(role, (revision) => RoleApi.moneyUse(role.id, { row, col, revision }));
    if (!result) return false; // 失败提示已由请求层弹过（非 silent 请求）
    // `result` 是接口 DTO（本次明细 + 修订号），`result.data` 才是角色存档本身
    // （账本字段 / bag 都在里面）
    const data = (result.data ?? {}) as Record<string, unknown>;
    const currency = String(result.currency ?? "") as MoneyCurrency;
    // 账本字段与快照同源：只认服务端给的那一个字段（收敛后只有 bindGold），其余不动
    if (currency === "bindGold") {
      role[currency] = Number(data[currency] ?? role[currency]);
    }
    // 服务端已扣减格子：以服务端那份为准整体替换（格子只存 key + 数量，无引用关系）
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    // revision 已由 withRevision 壳对齐
    // 保存并刷新（HUD 金钱 + 背包）
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("money_use_success_tip", {
      name: getGoodDisplayName(good),
      amount: Number(result.amount ?? 0),
      currency: MONEY_CURRENCY_LABELS[currency] ?? "",
      balance: Number(result.balance ?? 0),
    });
    return true;
  }

  /**
   * 使用升级卷轴（当前在线角色）：**等级 +1 与属性重算都在服务端**（role.levelScrollUse，#787）
   *
   * 等级区间读服务端 `level_scrolls` 表 —— 客户端这份（`configs/game-config` 的 `levelScrolls`）
   * 只用来**先说一句**：等级不在区间里就不发请求（省一个往返），并提示当前该用哪一卷。
   * 服务端仍会照自己的库再判一次，改包跳过这一步也跳不出区间。
   *
   * 成功后以服务端返回为准刷新本地存档：等级 / 经验 / 血蓝上限与当前值（升级补满）/ 战斗力 / bag /
   * revision。**不本地 +1** —— 自增一版就会与服务端落库值漂开（下次存档被回填，表现成「等级弹回去」）。
   * @param row 背包行
   * @param col 背包列
   * @param opts `quiet` = 失败提示静默（自动使用路径用，见 UseOptions）
   * @returns 是否成功使用（失败原因已用浮动提示告知）
   */
  static async useLevelScroll(row: number, col: number, opts: UseOptions = {}): Promise<boolean> {
    const role = RoleCache.findOnlineRole();
    const cell = role?.bag[row]?.[col];
    if (!role || !cell) return false;
    const good = getItem(cell.id);
    if (!good || !isLevelScroll(good)) {
      if (!opts.quiet) GameUiHelper.createTip("level_scroll_use_invalid_tip");
      return false;
    }
    const level = Math.max(1, Math.floor(Number(role.level) || 1));
    if (level < good.minLevel || level > good.maxLevel) {
      // 这一句是玩家的主要反馈：卷轴不对口时他要立刻知道「该换哪一卷」
      // 自动使用路径静默：等级不对口是常态（挂机升级穿过区间），不该每捡一卷刷一条
      if (!opts.quiet) {
        GameUiHelper.createTip("level_scroll_level_out_of_range_tip", {
          name: getGoodDisplayName(good),
          min: good.minLevel,
          max: good.maxLevel,
          level,
        });
      }
      return false;
    }
    const result = await withRevision(role, (revision) => RoleApi.levelScrollUse(role.id, { row, col, revision }));
    if (!result) return false; // 失败提示已由请求层弹过（非 silent 请求）
    // `result` 是接口 DTO（跳级明细 + 修订号），`result.data` 才是角色存档本身
    const data = (result.data ?? {}) as Record<string, unknown>;
    // 服务端已经把「升级后」的整份数值算好：照搬，不在这里再推一遍
    // 等级读 **DTO 顶层**那一列：`row.level` 是唯一权威，存档里的 level 升级时不跟着写
    // （与击杀升级 `applyKillExp` 同一纪律），读存档那份会拿到「升级前的旧等级」
    if (typeof result.level === "number") role.level = result.level;
    if (typeof data.exp === "number") role.exp = data.exp;
    if (typeof data.maxHp === "number") role.maxHp = data.maxHp;
    if (typeof data.maxMp === "number") role.maxMp = data.maxMp;
    if (typeof data.hpRecover === "number") role.hpRecover = data.hpRecover;
    if (typeof data.combat === "number") role.combat = data.combat;
    if (typeof data.hp === "number") role.hp = data.hp;
    if (typeof data.mp === "number") role.mp = data.mp;
    // 服务端已扣减格子：以服务端那份为准整体替换（格子只存 key + 数量，无引用关系）
    if (Array.isArray(data.bag)) role.bag = data.bag as typeof role.bag;
    // revision 已由 withRevision 壳对齐
    // 保存并刷新（等级 / 血条上限 / 背包）
    RoleCache.updateOnlineRole(role);
    updateRoleUi(role);
    RoleUIManager.refreshBag();
    GameUiHelper.createTip("level_scroll_use_success_tip", {
      name: getGoodDisplayName(good),
      from: Number(result.fromLevel ?? level),
      level: Number(result.toLevel ?? role.level),
    });
    return true;
  }
}
