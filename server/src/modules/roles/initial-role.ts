import { playerSkillIds } from "../../common/runtime-config-cache";
import { ROLE_DATA_VERSION } from "./role-migration";

/**
 * 新角色的初始数据（#597：建号职责整体搬到服务端）
 *
 * 客户端建号只传 **名称 / 职业 / 性别** 三样（客户端自己才有输入框与选中态），
 * 其余一切由这里构造。口径（用户 2026-11-02 定）：
 *
 * - **背包、装备、货币全空，不赠送任何物品** —— 此前客户端 `new Role(...)` 会塞一套
 *   新手装备与初始金币，整体废除；要给某个号发东西走管理端（`PATCH /admin/roles/:id`）。
 * - **技能保持「全部解锁 1 级」**：技能等级是玩法数据不是物品，全 0 会让新角色无法战斗。
 *   玩家技能 = `skills` 表里 `owner = role` 的行（怪物技能不发给玩家）。
 * - **「客户端配置才知道形状」的字段发空壳**：装备槽名（EQUIPMENT_TYPE 枚举）、
 *   背包尺寸（bagRow × bagCol）、快捷键按键码都在客户端配置里，服务端复制必然漂移 ——
 *   发空对象 / 空数组，客户端 `StorageManager.ensureRoleDefaults` 读档时按**当前配置**补齐。
 * - 等级钉 1 级；战斗属性由 `RolesService.applyAuthoritativeAttributes` 重算后回填
 *   （maxHp / 攻防 / 战斗力），`hp / mp` 按满值起。
 */

/** 初始技能等级表：`skills` 表里 owner=role 的技能全部 1 级（怪物技能不发给玩家） */
function buildInitialSkills(): Record<string, number> {
  const skills: Record<string, number> = {};
  for (const id of playerSkillIds()) skills[id] = 1;
  return skills;
}

/** 角色默认速度倍率（与客户端 configs/role.defaultRoleSpeedRate 同一份语义：普攻动作 4 倍速，其余 1） */
const DEFAULT_SPEED_RATE: Record<string, number> = {
  stand: 1,
  walk: 1,
  run: 1,
  attack_near: 4,
  attack_skill_1: 1,
  test3: 1,
  attack_far: 4,
  injured: 1,
  a1: 1,
  die: 1,
  test1: 1,
};

/** 构造一份新角色的初始 data 文档（战斗属性由调用方重算回填） */
export function buildInitialRoleData(id: string, name: string, occupation: string, sex: string): Record<string, unknown> {
  return {
    // 索引字段与列保持一致（管理端编辑走 parseRoleData，要求文档里带这些键）
    id,
    name,
    occupation,
    sex,
    level: 1,
    // 存档结构版本（#818）：新号从第一天就带当前版本 —— 否则「刚建的号」在库里是 v1，
    // 版本分布会永远挂着一档假的「老档」
    schemaVersion: ROLE_DATA_VERSION,
    exp: 0,
    // 账本从零起（#597）：不再有「初始金币」这种出厂馈赠。
    // 货币收敛（#843、#844）：唯一账本字段 bindGold（绑定元宝）
    bindGold: 0,
    // 装备槽全空（槽位名由客户端枚举补齐）；背包空网格（尺寸由客户端配置铺）
    equipments: {},
    bag: [],
    skills: buildInitialSkills(),
    shortcutKeys: [],
    speedRate: { ...DEFAULT_SPEED_RATE },
    fashionCloth: null,
    avatar: 0,
    // 关系显示位（RELATION_SHIP.SELF）；所在地图出生点（卧龙城）
    relationShip: "1",
    onMap: "0",
    soulOfWar: 0,
    soulShow: false,
    title: 0,
    rank: 0,
    // 新角色从第 0 步开始看引导（老号「没有 guide 字段 = 已完成」的判定不受影响）
    guide: { step: 0, done: false, skipped: false },
  };
}
