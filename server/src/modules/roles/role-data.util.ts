import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";

/** 允许的职业（与客户端 types/role.OECCUPATION 一致） */
export const ROLE_OCCUPATIONS = ["1", "2", "3", "4"] as const;
/** 允许的性别（与客户端 types/role.SEX 一致） */
export const ROLE_SEXES = ["1", "2", "3"] as const;
/** 角色名长度上限（与客户端创建角色输入框约定一致） */
export const ROLE_NAME_MAX_LENGTH = 12;
/** 角色 id 长度上限（客户端用时间戳字符串，留足冗余） */
export const ROLE_ID_MAX_LENGTH = 64;
/** 等级上限（客户端成长曲线 roleMaxLevel 之下，服务端只做防脏数据的上界） */
export const ROLE_LEVEL_MAX = 1000;

/** 服务端从角色数据里提取并落成索引列的字段 */
export interface RoleIndexFields {
  id: string;
  name: string;
  occupation: string;
  sex: string;
  level: number;
}

/** 管理端可直接改的「数据内的常用数值字段」（其余字段属于游戏运行时细节，管理端不动） */
export const ROLE_PATCH_NUMBER_FIELDS = ["gold", "bindGold", "silver", "exp", "soulOfWar", "title", "rank"] as const;

/**
 * 校验并规整客户端提交的角色数据
 *
 * 设计取舍：角色数据（背包、装备、技能、快捷键…）由**客户端配置驱动生成**，
 * 服务端不复制那套配置（复制必然漂移）。服务端只保证：
 * 1. 结构是个对象；2. 索引字段（id / 名称 / 职业 / 性别 / 等级）合法；3. 归属与数量上限。
 * 于是游戏侧改配置（加装备、调初始金币…）不必同步改服务端。
 * @throws BizException ROLE_DATA_INVALID
 */
export function parseRoleData(input: unknown): { fields: RoleIndexFields; data: Record<string, unknown> } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BizException(BizCode.ROLE_DATA_INVALID, "角色数据格式不正确");
  }
  const source = { ...(input as Record<string, unknown>) };

  const id = typeof source.id === "string" ? source.id.trim() : "";
  if (!id || id.length > ROLE_ID_MAX_LENGTH) throw new BizException(BizCode.ROLE_DATA_INVALID, "角色 id 不合法");

  const name = normalizeName(source.name);
  const occupation = normalizeEnum(source.occupation, ROLE_OCCUPATIONS, "职业");
  const sex = normalizeEnum(source.sex, ROLE_SEXES, "性别");
  const level = normalizeLevel(source.level);

  // 规整后的索引字段回写进 data，保证「列表里看到的名字」与「详情里的名字」永远一致
  const data: Record<string, unknown> = { ...source, id, name, occupation, sex, level };
  return { fields: { id, name, occupation, sex, level }, data };
}

/**
 * 解析**数据库里**的角色数据列（roles.data 存的是 JSON 字符串）
 *
 * 对外读取（详情接口）容忍脏数据：解析不出来就当空对象，避免一行坏数据打断整个列表；
 * 要编辑的路径则不能容忍 —— 见 parseStoredRoleData。
 */
export function decodeStoredRoleData(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* 落到下面的空对象 */
  }
  return {};
}

/**
 * 解析数据库里的角色数据列（**编辑用**：解析不出来直接报错）
 *
 * 管理端要基于已有数据做「改几个字段、其余原样保留」，数据坏了必须报错，
 * 不能悄悄拿空对象去覆盖 —— 那等于把角色的背包装备全清了。
 */
export function parseStoredRoleData(raw: string): Record<string, unknown> {
  const parsed = decodeStoredRoleData(raw);
  if (Object.keys(parsed).length === 0) throw new BizException(BizCode.ROLE_DATA_INVALID, "角色数据已损坏，无法编辑");
  return parsed;
}

/** 角色名规整（去空白 + 长度校验） */export function normalizeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new BizException(BizCode.ROLE_DATA_INVALID, "角色名称不能为空");
  if (name.length > ROLE_NAME_MAX_LENGTH) throw new BizException(BizCode.ROLE_DATA_INVALID, `角色名称最多 ${ROLE_NAME_MAX_LENGTH} 个字`);
  return name;
}

/** 枚举字段规整 */
export function normalizeEnum<T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  const text = typeof value === "string" ? value : "";
  if (!allowed.includes(text)) throw new BizException(BizCode.ROLE_DATA_INVALID, `${label}取值不合法`);
  return text as T[number];
}

/** 等级规整（整数，1 ~ ROLE_LEVEL_MAX） */
export function normalizeLevel(value: unknown): number {
  const level = Number(value ?? 1);
  if (!Number.isFinite(level) || level < 1 || level > ROLE_LEVEL_MAX) {
    throw new BizException(BizCode.ROLE_DATA_INVALID, `等级需为 1 ~ ${ROLE_LEVEL_MAX} 之间的整数`);
  }
  return Math.floor(level);
}
