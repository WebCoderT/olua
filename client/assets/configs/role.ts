import { ACTION, SpeedRate } from "../types/animation";
import { directions } from "./animation";
import { Equipment, EQUIPMENT_PREFIX, EQUIPMENT_SUFFIX } from "../types/good";
import { NeedSetShortcutKeyConfig, OECCUPATION, RELATION_SHIP, RoleOccupationInfo, SEX } from "../types/role";
import type { SkillId } from "../types/skill";
import { Size, Vec2 } from "cc";
import { belts, clothes, helmets, nicklaces, rings, shoes, weapons, getBaseEquipments, getEquipmentsByLevel } from "./equipments";

/** 角色移动速度-全局 */
export const ROLE_WALK_SPEED = 2;
/** 角色跑动速度-全局 */
export const ROLE_RUN_SPEED = 4;

/**
 * 角色体型与碰撞盒（显示与物理共用）
 * 角色锚点在脚下（0.5, 0），所以碰撞盒向上偏移身高的一半才正好罩住身体
 * 调体型（例如换成更瘦的职业模型）只改这里
 */
export const roleBody = {
  /** 角色显示尺寸（宽 × 高，世界单位） */
  size: new Size(40, 70),
  /** 碰撞盒尺寸与相对脚下原点的偏移 */
  colliderSize: new Size(40, 70),
  colliderOffset: new Vec2(0, 35),
};

/**
 * 角色刚体参数
 * 角色位移由代码驱动（键盘/鼠标/A* 寻路），刚体只用来参与碰撞检测：
 * 不施加重力、不允许旋转，否则会被物理仿真推着走
 */
export const roleRigid = {
  gravityScale: 0,
  fixedRotation: true,
};

/**
 * 角色数量**不设上限** —— 服务端不拦（创建只校验结构与重名），客户端也不拦（选角界面按
 * `roleSelectorLayout.roleScroll` 滚动网格排列：一排 6 个、排满一行自动换行、超出视口上下滚动）。
 *
 * （这里原本有两份上限数字：手写的 `maxRoleCount` 与服务端 `.env` 的 `ROLE_MAX_PER_ACCOUNT`，
 *   靠「两边一起改」的记性维持 —— 都已删掉，见 #124 的教训：同一个数写两份必然漂移。）
 */

/**
 * 鼠标操控角色（鼠标左键按住走路、右键按住跑动，抬起即停）
 * 移动方向 = 「指针位置相对角色的方位」按 360° 平分八块取其一（与角色八方向动画、八方向移动一致），
 * 按住期间指针移动会实时改向；由 components/input/RolePointerInput 负责取点与判定，这里只放手感参数
 */
export const pointerMove = {
  /** 死区：指针与角色的距离小于该值视为「原地」（按下时不定方向，按住期间保持上一次方向；世界单位；角色体型 40×70） */
  deadZone: 24,
};

/**
 * 操作摇杆（左下角常驻，按住拖动即移动；由 components/input/RoleJoystickInput 负责取点与判定）
 *
 * 两个阈值都是**拖动幅度占「可拖半径」的比例**（0~1，与分辨率无关；可拖半径见
 * configs/layout/hud.ts 的 joystickLayout.radius）：
 * 拖得少 = 走路、拖得多 = 跑动，就是这两个阈值划出来的三段。
 * 方向 = 手柄相对底座中心的方位按 360° 平分八块取其一（与键盘/鼠标操控、角色八方向动画同一口径）
 */
export const joystickMove = {
  /** 死区比例：拖动幅度小于该比例视为「原地」（不定方向、不移动） */
  deadZone: 0.15,
  /** 跑动阈值比例：拖动幅度达到该比例即跑动，介于死区与它之间为走路 */
  runThreshold: 0.6,
};

/**
 * 角色魔法值自然回复速度（点/秒），设为 0 即关闭自然回复
 * 最大魔法值见 configs/level 的等级配置（maxMp），技能消耗见 configs/skill 的 mpCost
 */
export const mpRecoverPerSecond = 2;

/**
 * 角色默认外观（未穿戴衣服时按性别回退）
 *
 * 字段与装备的外观字段同口径（out / outScale / outPositions）—— 于是「穿上衣服」与「脱下衣服回退默认身体」
 * 在 ui/components/role/RoleAppearance 里走的是同一套变换代码（缩放 + 按方向的位置）。
 * 目录若与另一套素材共用全局连续编号（如 role/2 的帧号从 600 起），
 * 帧号基准要去 configs/animation.animationFrameBases 登记，否则整包片段切不出来（外观全空白）。
 */
export interface RoleDefaultCloth {
  /** 外观帧动画目录（resources 下路径） */
  out: string;
  /** 外观缩放 */
  outScale: number;
  /**
   * 外观位置：按 8 方向各一个，下标顺序同 configs/animation.directions
   * （上 / 右上 / 右 / 右下 / 下 / 左下 / 左 / 左上）
   *
   * **全为 0 不等于「贴在脚下」** —— 详见下面 roleGroundPositions 的说明，那是这一层最容易踩的坑。
   */
  outPositions: Vec2[];
}

/**
 * 让一帧的**可见轮廓**踩到地面、并横向对到锚点上所需的偏移
 *
 * 口径（2026-10-29 施工时逐帧量图确认）：
 *   - 锚点 = 画布中心（Cocos 里外观节点是默认 anchor 0.5/0.5 的 Sprite），
 *     所以位置 (0,0) 的语义是「**画布中心**落在角色脚下」，不是「脚落在角色脚下」；
 *   - 美术画布底部还留着 25~66 单位不等的空白（role/1 画布 150×132、身体只有 71 高），
 *     于是「全 0」会把裸模整体沉到地面以下：role/1 脚底 -31、role/2 脚底 -26；
 *   - 客户端开着 `configs/debug.colliderRange` 时最明显：碰撞盒从脚下往上 70
 *     （见 roleBody.colliderOffset），而身体落在碰撞盒的下半部分 —— 看起来就是
 *     「人物外观的锚点跑到了身体正中间」。
 *
 * 衣服/武器的几何里一直带着 +34 一类的补偿（每件素材画布留白不同，见 equipments.ts），
 * 所以裸模缺这份补偿时的症状是**衣服站得住、身体沉下去**，很容易被误判成「衣服飘了」。
 *
 * 这组数值是「轮廓底边到 y=0、轮廓中心到 x=0」的偏移（四舍五入到 0.5），只作为出厂值：
 * 管理端「装备对齐」里可以点「脚底贴地」重算、也可以手拖后保存，服务端存的值会覆盖这里。
 */
function roleGroundPositions(points: Array<[number, number]>): Vec2[] {
  // 长度必须与 directions 对齐：少了方向会在 RoleAppearance 里回落到第 0 项（整件歪掉）
  if (points.length !== directions.length) throw new Error(`裸模默认外观需要 ${directions.length} 个方向的位置`);
  return points.map(([x, y]) => new Vec2(x, y));
}

/**
 * 各性别的默认外观（未穿戴衣服时使用）
 * 保证角色始终有身体，同时让「预加载角色外观」与 RoleAppearance 的回退取到同一份资源
 */
export const roleDefaultCloths = new Map<SEX, RoleDefaultCloth>();

roleDefaultCloths.set(SEX.BOY, {
  out: "role/1",
  outScale: 1,
  outPositions: roleGroundPositions([
    [1, 31], // up
    [-0.5, 31], // right_up
    [-1.5, 31], // right
    [0.5, 30], // right_down
    [0, 31], // down
    [-1.5, 32], // left_down
    [-1, 32], // left
    [1.5, 31], // left_up
  ]),
});
roleDefaultCloths.set(SEX.GRIL, {
  out: "role/2",
  outScale: 1,
  outPositions: roleGroundPositions([
    [-6, 26.5], // up
    [-8, 27.5], // right_up
    [-8.5, 27.5], // right
    [-5.5, 25.5], // right_down
    [-6, 26.5], // down
    [-8, 28.5], // left_down
    [-8.5, 27.5], // left
    [-6.5, 25.5], // left_up
  ]),
});

/**
 * 取某性别的默认外观
 * 未登记的性别（SEX.ALL、旧存档里的空值等）回落到男性 —— 角色任何情况下都必须有身体
 */
export function getRoleDefaultCloth(sex: SEX): RoleDefaultCloth {
  return roleDefaultCloths.get(sex) ?? roleDefaultCloths.get(SEX.BOY)!;
}

/** 职业介绍信息MAP */
export const occupations = new Map<OECCUPATION, RoleOccupationInfo>();

occupations.set(OECCUPATION.ZHAN, { name: "战士", description: "create_role/tips_1", descriptionSize: new Size(245, 51) });
occupations.set(OECCUPATION.FA, { name: "魔法师", description: "create_role/tips_2", descriptionSize: new Size(249, 69) });
occupations.set(OECCUPATION.DAO, { name: "道士", description: "create_role/tips_3", descriptionSize: new Size(249, 69) });

/** 关系的角色信息显示位置关系map */
export const roleInfoPositions = new Map<RELATION_SHIP, Vec2>();
roleInfoPositions.set(RELATION_SHIP.SELF, new Vec2(-648, 324));
roleInfoPositions.set(RELATION_SHIP.BROTHER, new Vec2());

// 背包插槽行数和列数
export const bagRow = 7; // 7行
export const bagCol = 11; // 11列

/** 初始金币数量 */
export const initialGold = 10000;
export const initialBindGold = 10000;
export const initialSilver = 10000;

/** 初始技能等级表（角色创建时全部解锁1级） */
export const initialSkills: { [key in SkillId]: number } = {
  "1000": 1,
  "1001": 1,
  "1002": 1,
  "1003": 1,
  "1004": 1,
  "1005": 1,
  "1006": 1,
  "1007": 1,
  "1008": 1,
  "1009": 1,
  "1010": 1,
  "1011": 1,
};

/** 初始快捷键配置（5 格 = 数字键 1~5） */
export const initialShortcutKeys: NeedSetShortcutKeyConfig[] = [
  { label: "1", key: 49, skillId: null },
  { label: "2", key: 50, skillId: null },
  { label: "3", key: 51, skillId: null },
  { label: "4", key: 52, skillId: null },
  { label: "5", key: 53, skillId: null },
];

/** 角色默认速度倍率 */
export const defaultRoleSpeedRate: SpeedRate = {
  [ACTION.STAND]: 1,
  [ACTION.WALK]: 1,
  [ACTION.RUN]: 1,
  [ACTION.ATTACK_NEAR]: 4,
  [ACTION.ATTACK_SKILL_1]: 1,
  [ACTION.TEST3]: 1,
  [ACTION.ATTACK_FAR]: 4,
  [ACTION.INJURED]: 1,
  [ACTION.A1]: 1,
  [ACTION.DIE]: 1,
  [ACTION.TEST1]: 1,
};

/**
 * 新角色背包额外预置：**该等级武器的全部前后缀变体**（每件 15 个）也放进背包
 *
 * 1 级只有 weapon_1 一件 → 出生背包里就有 15 个品质各异的同名武器（普通的·人级 → 超神的·神级），
 * 方便一进游戏就对比不同前缀/后缀的装备外观与边框；设 0 即关闭。
 *
 * ⚠️ 背包只有 bagRow × bagCol 格（见上），改大这个等级或再往这里加表之前先算总格数：
 * 超出的条目会被 entities/Role 构造函数丢弃（那里会打一条 warn）
 */
export const newRoleVariantWeaponLevel = 1;

/**
 * 根据职业与性别获取新手装备
 *
 * 组成（顺序即背包里的摆放顺序）：
 * 1. 通用件：戒指 / 项链 / 鞋 / 头盔 / 腰带（各表的 `*_1`）；
 * 2. 全部**基础件**（「普通的·人级」）：所有武器 + 所有衣服；
 * 3. `newRoleVariantWeaponLevel` 那个等级的武器，**补上其余前后缀变体**（基础件已在第 2 步发过，不重复发）。
 */
export function getNewRoleEquipments(occupation: OECCUPATION, sex: SEX): Equipment[] {
  // 通用装备（按 key 从各装备 Map 取；缺配置的自动跳过）
  const equipments: Equipment[] = [rings.get("ring_1"), nicklaces.get("necklace_1"), shoes.get("shoes_1"), helmets.get("helmet_1"), belts.get("belt_1")].filter((eq): eq is Equipment => !!eq);

  /** 将所有基础武器放在装备列表中（背包只有 bagRow×bagCol 格，绝不能把全部装备的 15 倍变体都塞进来） */
  const baseWeapons = getBaseEquipments(weapons);
  /** 将所有基础衣服放在装备列表中 */
  const baseClothes = getBaseEquipments(clothes);
  // 基础件筛选为空说明配置/编译踩坑（例如打包后 Map 遍历失效），此时背包会静默缺装备，留一条可查的日志
  if (baseWeapons.length === 0 || baseClothes.length === 0) {
    console.warn(`[role] 新手装备基础件为空（武器 ${baseWeapons.length} / 衣服 ${baseClothes.length}），背包将缺少装备`);
  }
  baseWeapons.forEach((weapon) => equipments.push(weapon));
  baseClothes.forEach((cloth) => equipments.push(cloth));

  // 指定等级的武器：整组前后缀变体一起发（基础件「普通的·人级」上面已发过，这里只补其余 14 个变体）
  if (newRoleVariantWeaponLevel > 0) {
    getEquipmentsByLevel(weapons, newRoleVariantWeaponLevel).forEach((weapon) => {
      if (weapon.prefix === EQUIPMENT_PREFIX.NORMAL && weapon.suffix === EQUIPMENT_SUFFIX.MORTAL) return;
      equipments.push(weapon);
    });
  }
  return equipments;
}
