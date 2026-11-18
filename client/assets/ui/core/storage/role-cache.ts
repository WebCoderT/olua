import { sys } from "cc";
import RoleSync from "../../utils/net/RoleSync";
import Session from "../../utils/net/Session";
import { Role } from "../../../entities/Role";
import { initialShortcutKeys, bagRow, bagCol } from "../../../configs/role";
import { BagCell, EQUIPMENT_TYPE, getGoodCount, Goods } from "../../../types/good";
import { NeedSetShortcutKeyConfig } from "../../../types/role";
import MpHelper from "../../utils/battle/MpHelper";
import HpHelper from "../../utils/battle/HpHelper";
import { bagMetaOf, normalizeBagGrid, withBagMeta, wornItemOf } from "../../../configs/items";
import { getFashion } from "../../../configs/game-config";
import { normalizeGuideProgress } from "../../utils/guide/guide-progress";
import { guideStepCount } from "../../../configs/guide";

/**
 * 本地角色缓存（#1115 批次 6 自 StorageManager 拆出）
 *
 * **本地 roles 是服务端数据的缓存，服务端才是权威**（账号体系见 ui/utils/net）：
 * - 进游戏前由选角场景拉一次完整数据写进缓存（见 cacheRole），游戏内各处照旧同步读；
 * - 任何一次落盘（updateOnlineRole）都会经 RoleSync 防抖推回服务端，不再有「只存本地」的改动；
 * - 账号与令牌不在这里，见 ui/utils/net/Session（clear 会一并清掉会话，避免清了存档还留着登录态）。
 */
export default class RoleCache {

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

  /**
   * 把服务端返回的角色完整数据写进本地缓存（按 id 覆盖）
   *
   * 调用时机只有两处，都是「服务端刚给了一份权威数据」的时刻：
   * 1. 选角场景选中角色（服务端返回完整数据，见 ui/RoleSelector.enterGame）；
   * 2. 选角场景创建角色（服务端落库后回传完整数据）。
   *
   * **不触发**服务端同步：这份数据本来就是从服务端拿的，推回去纯属白跑一趟。
   * 角色数量上限只在服务端（#878，默认 6 个）：本地不存这个数字、也不预拦，
   * 建号被拒时服务端返回 400 / 20018 并带上限，直接展示文案。
   * @param role 服务端返回的角色完整数据（服务端存的就是客户端 entities/Role 的快照）
   */
  static cacheRole(role: Role) {
    const roles = this.getRoles();
    const index = roles.findIndex((item) => item.id === role.id);
    if (index >= 0) roles[index] = role;
    else roles.push(role);
    this.setRoles(roles);
  }

  /**
   * 把**服务端接口返回的角色数据**（详情 / 创建 / 选中 / 冲突后拉取）写进本地缓存
   *
   * 与 cacheRole 的唯一区别：顺手记下服务端修订号（乐观锁基线，见 entities/Role.revision）。
   * 服务端返回的是统一包裹里的 data + 同级的 revision，映射收在这里，
   * 免得每个调用点自己拼 `{ ...data, revision }`（漏一处就一直拿旧版本去撞乐观锁）。
   * @returns 写进缓存的角色；数据不完整（没有 id）时返回 null 并跳过
   */
  static cacheServerRole(detail: { data: unknown; revision: number }): Role | null {
    const source = detail && detail.data && typeof detail.data === "object" ? (detail.data as Role) : null;
    if (!source || !source.id) {
      console.warn("[storage] 服务端返回的角色数据不完整，已跳过缓存");
      return null;
    }
    const role: Role = { ...source, revision: detail.revision };
    this.cacheRole(role);
    return role;
  }

  /**
   * 记下服务端刚给的修订号（推送成功后的基线更新）
   *
   * **不触发同步**：这只是把「我是基于哪一版」对齐，数据本身没变，
   * 推回去纯属白跑一趟（与 cacheRole 同一口径）。
   */
  static applyServerRevision(roleId: string, revision: number) {
    const roles = this.getRoles();
    let changed = false;
    roles.forEach((role) => {
      if (role.id !== roleId || role.revision === revision) return;
      role.revision = revision;
      changed = true;
    });
    if (changed) this.setRoles(roles);
  }

  /** 根据id获取角色 */
  static findRoleById(id: string) {
    return this.getRoles().find((i) => i.id === id);
  }

  /**
   * 删除角色的**本地缓存**（选角界面「管理」入口调用，见 ui/RoleSelector 的删除按钮）
   *
   * 真删在服务端：选角场景先调 RoleApi.remove，服务端删成功后才来这里清缓存
   * ——顺序反了会出现「本地没了但服务端还在」，下次拉列表角色又冒出来。
   * 本地这一步就是从数组移除并落盘，**不可恢复**。
   * 删完必须确认 selectedRole 不再指向已不存在的角色：玩家上次进游戏时选中过它，
   * 残留的选中项会让下一次 findOnlineRole 取到 undefined（进游戏直接卡在取角色那一步）；
   * 顺手也清掉「本来就指向不存在角色」的脏选中项（例如存档被外部改动过）。
   * @param id 角色 id（Role.id）
   * @returns 是否清理成功（角色不在本地缓存时返回 false，调用方据此区分提示）
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

  /**
   * 清空本地存储（角色缓存 + 当前会话）
   *
   * 登录场景启动时调用（**仅未登录时** —— 已有登录态的刷新会直接跳选角并保留缓存，
   * 见 ui/Login.start）：确保换账号重新登录时，上个账号的角色缓存与令牌不会串到下一个账号。
   *
   * 只删自己管的两个键 + 会话，**不调 `sys.localStorage.clear()`**：那个会把本机所有键一起抹掉，
   * 包括与账号无关的展示状态（如公告已读记录，见 AnnouncementReadStore）——
   * 一旦后续有别的模块往本机写东西，全清也会静默带走它们，而这处清缓存的意图只是「换账号重新来」。
   */
  static clear() {
    sys.localStorage.removeItem("roles");
    sys.localStorage.removeItem("selectedRole");
    Session.clear();
  }

  /**
   * 选中角色（本地视角：游戏内 findOnlineRole 认的是它）
   *
   * 服务端侧的「在线角色」由选角场景的 `RoleApi.select` 写入（见 ui/RoleSelector.enterGame），
   * 两者要在同一次进游戏流程里一起写，只写一边会出现「本地进的是 A、服务端记的是 B」。
   */
  static onlineRole(id: string) {
    sys.localStorage.setItem("selectedRole", id);
  }

  /**
   * 清掉本地「当前在线角色」标记（**不删角色数据**）
   *
   * 用在「角色被管理员下线」时（见 utils/net/RoleSync 的 kicked 分支）：角色存档还好好的，
   * 只是账号在服务端的在线角色被清了 —— 本地如果还认为自己在线，进游戏会一路同步失败（20007）。
   * 与 deleteRole 的区别：那个是真的删角色，这里只是让人回选角界面重新选一次。
   */
  static clearOnlineRole() {
    sys.localStorage.removeItem("selectedRole");
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

  /**
   * 更新在线角色（**本地落盘的唯一出口**，同时也是写穿服务端的唯一触发点）
   *
   * 打怪升级/拾取/买卖/换装/吃药都会走到这里，所以服务端同步必须防抖
   * （只推最后一份数据、失败不重排，见 utils/net/RoleSync）。
   * 调用方不需要关心同步结果：本地已经落盘，游戏内读到的永远是这一份。
   */
  static updateOnlineRole(role: Role) {
    const roles = this.getRoles().map((i) => {
      if (i.id === role.id) {
        // 修订号只信「有的那一边」：内存里的 role 可能是旧存档解析出来的（没有 revision 字段），
        // 直接 Object.assign 会把已存下的基线抹掉，下一次推送就退回「无乐观锁」的旧行为
        const revision = typeof role.revision === "number" ? role.revision : i.revision;
        Object.assign(i, role);
        if (typeof revision === "number") i.revision = revision;
        else delete i.revision;
      }
      return i;
    });
    this.setRoles(roles);
    RoleSync.schedule(role);
  }

  /**
   * 旧存档补齐（后续版本新增角色字段/新增配置项时都在这里补，保证读到的角色对象字段完整）
   * 调用时机：进入游戏取得在线角色之后（见 ui/Game.start）
   * - 魔法值：mp / maxMp / mpRecoverAccumulator（默认值规则见 utils/battle/MpHelper）
   * - 血量回复：hpRecover / hpRecoverAccumulator（默认值规则见 utils/battle/HpHelper）
   * - 快捷键：按 configs/role.initialShortcutKeys 的按键码对齐（保留玩家已绑定的技能，补齐新增的按键槽；
   *   存档里多出的按键（如曾有的第 6 格）自然丢弃，减格不报错）
   * - 装备槽：槽位值一律规整成 `{ id, bound?, from? }`（#816）。老存档是裸 id 或完整快照对象，
   *   两种都收敛成对象 —— 元数据（绑定 / 溯源）必须跟着走，否则「穿上再脱下」就洗白了
   * - 背包：旧存档格子存的是物品快照对象，迁移为 { id, count }（物品数据经配置表实时解析）
   */
  static ensureRoleDefaults(role: Role) {
    MpHelper.ensureDefaults(role);
    HpHelper.ensureDefaults(role);
    // #597 起服务端建号发空对象（槽位名是客户端枚举的事）—— 按 EQUIPMENT_TYPE 枚举补齐缺失槽；
    // 槽位值规整成 { id, bound?, from? }（#816）：老存档是裸 id / 完整快照，两种都收敛成对象
    role.equipments ??= {} as Role["equipments"];
    (Object.keys(EQUIPMENT_TYPE) as Array<keyof typeof EQUIPMENT_TYPE>).forEach((key) => {
      const slot = EQUIPMENT_TYPE[key];
      // wornItemOf 认裸 id（#816 之前）、完整快照（#597 之前）与对象三种形状；
      // 认不出的直接清空（脏数据不该让「槽位显示」与「属性」各读一半）
      role.equipments[slot] = wornItemOf(role.equipments[slot]);
    });
    // 背包格子迁移：旧快照（带 type 的完整物品对象）收敛为 { id, count }；新格式原样规整；无法确定 id 的格子丢弃
    // **元数据照原样带回**（bound / from，#789）：这里是每次读档都会走的路径，丢了就等于
    // 「重登一次，身上那件绑定装备的背包版就变可交易了」（详情弹窗的「已绑定」与溯源也会一起消失）
    role.bag = (Array.isArray(role.bag) ? role.bag : []).map((row) =>
      row.map((cell) => {
        if (!cell || typeof cell !== "object") return null;
        const snapshot = cell as Goods & Partial<BagCell>;
        const id = snapshot.id;
        if (!id) return null;
        // 旧快照带 type 字段：数量按物品叠加规则取（不可叠加恒 1）；新格式直接读 count
        const count = "type" in cell ? getGoodCount(cell as Goods) : Math.max(1, snapshot.count ?? 1);
        return withBagMeta(id, count, bagMetaOf(cell as BagCell));
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
    // 称号等级：旧存档缺失补 0（未激活）
    if (typeof role.title !== "number") role.title = 0;
    // 军衔阶数：旧存档缺失补 0（未授衔）
    if (typeof role.rank !== "number") role.rank = 0;
    // 时装（#377）：旧存档里的 fashionCloth 是历史遗留的数字（从没有人写过），
    // 或者干脆没有这个字段 —— 一律按「没穿」处理；不是字符串或不在配置表里也按没穿
    const fashion = role.fashionCloth as unknown;
    role.fashionCloth = typeof fashion === "string" && getFashion(fashion) ? fashion : null;
    // 时装拥有清单（#596）：归服务端书写，本地只照搬；旧档没有这一项按空清单处理
    role.fashionsOwned = Array.isArray(role.fashionsOwned)
      ? role.fashionsOwned.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    // 新手引导（#402）：读不到 guide 的存档 = 引导上线前就在的角色 → 补成「已完成」，
    // 老号不该突然被弹一脸引导；新角色的 guide 由 Role 构造函数写入第 0 步
    role.guide = normalizeGuideProgress(role.guide, guideStepCount());
  }
}
