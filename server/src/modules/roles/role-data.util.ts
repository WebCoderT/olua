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

//#region 结构化字段（管理端可改的那部分运行时数据）

/**
 * 结构化字段的体量上限
 *
 * 这些字段（装备槽 / 技能等级 / 背包格子）由**客户端配置**定义内容，
 * 服务端只认结构 —— 所以上限的作用是「挡住荒谬体量的写入」，不是业务规则。
 */
export const ROLE_EQUIPMENT_SLOT_MAX = 64;
export const ROLE_SKILL_ENTRY_MAX = 128;
export const ROLE_BAG_CELL_MAX = 512;
export const ROLE_BAG_AXIS_MAX = 64;
export const ROLE_FIELD_KEY_MAX_LENGTH = 64;
export const ROLE_FIELD_VALUE_MAX_LENGTH = 128;

/** 背包格子（管理端提交的稀疏格式：只报「哪一格放了什么」） */
export interface BagCellInput {
  row: number;
  col: number;
  id: string;
  count: number;
}

/** 一个非数组的普通对象（逐字段搬移时用，避免数组被当成对象处理） */
function asRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BizException(BizCode.ROLE_DATA_INVALID, `${label}格式不正确`);
  }
  return input as Record<string, unknown>;
}

/** 取一个「非空短字符串」字段 */
function asKey(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > ROLE_FIELD_KEY_MAX_LENGTH) throw new BizException(BizCode.ROLE_DATA_INVALID, `${label}不合法`);
  return text;
}

/**
 * 规整装备穿戴表（槽位 → 装备 id）
 *
 * **不校验槽位名与装备 id 是否存在**：那份清单是客户端配置（configs/equipments 与 items）的唯一真相，
 * 服务端复制一份必然漂移（客户端加了装备、服务端说非法）。服务端只保证「结构对、值不是垃圾」。
 */
export function normalizeEquipments(input: unknown): Record<string, string | null> {
  const source = asRecord(input, "装备数据");
  const keys = Object.keys(source);
  if (keys.length > ROLE_EQUIPMENT_SLOT_MAX) {
    throw new BizException(BizCode.ROLE_DATA_INVALID, `装备槽位最多 ${ROLE_EQUIPMENT_SLOT_MAX} 个`);
  }
  const result: Record<string, string | null> = {};
  for (const key of keys) {
    const slot = asKey(key, "装备槽位名");
    const value = source[key];
    if (value === null || value === "") {
      result[slot] = null;
      continue;
    }
    if (typeof value !== "string" || value.length > ROLE_FIELD_VALUE_MAX_LENGTH) {
      throw new BizException(BizCode.ROLE_DATA_INVALID, `装备槽位「${slot}」的装备 id 不合法`);
    }
    result[slot] = value;
  }
  return result;
}

/** 规整技能等级表（技能 id → 等级）；技能 id 的合法性同样由客户端配置定义 */
export function normalizeSkills(input: unknown): Record<string, number> {
  const source = asRecord(input, "技能数据");
  const keys = Object.keys(source);
  if (keys.length > ROLE_SKILL_ENTRY_MAX) throw new BizException(BizCode.ROLE_DATA_INVALID, `技能条目最多 ${ROLE_SKILL_ENTRY_MAX} 条`);
  const result: Record<string, number> = {};
  for (const key of keys) {
    const id = asKey(key, "技能 id");
    const value = Number(source[key]);
    if (!Number.isInteger(value) || value < 0 || value > ROLE_SKILL_ENTRY_MAX ** 2) {
      throw new BizException(BizCode.ROLE_DATA_INVALID, `技能「${id}」的等级必须是非负整数`);
    }
    result[id] = value;
  }
  return result;
}

/**
 * 规整背包格子的**稀疏提交**
 *
 * 管理端只提交「有东西的格子」（row / col / id / count），而不是整个二维数组 ——
 * 二维数组的尺寸由客户端配置（bagRow × bagCol）决定，服务端不认识它，
 * 所以只负责把稀疏格子铺进「原网格（不够则扩到刚好放下）」，
 * 玩家那边读到后由 StorageManager.ensureRoleDefaults → normalizeBagGrid 按**当前配置**重塑。
 */
export function normalizeBagCells(input: unknown): BagCellInput[] {
  if (!Array.isArray(input)) throw new BizException(BizCode.ROLE_DATA_INVALID, "背包格子必须是数组");
  if (input.length > ROLE_BAG_CELL_MAX) throw new BizException(BizCode.ROLE_DATA_INVALID, `背包格子最多 ${ROLE_BAG_CELL_MAX} 个`);
  const seen = new Set<string>();
  return input.map((item) => {
    const cell = asRecord(item, "背包格子");
    const row = Number(cell.row);
    const col = Number(cell.col);
    if (!Number.isInteger(row) || row < 0 || row >= ROLE_BAG_AXIS_MAX) {
      throw new BizException(BizCode.ROLE_DATA_INVALID, `背包格子行号需为 0 ~ ${ROLE_BAG_AXIS_MAX - 1} 的整数`);
    }
    if (!Number.isInteger(col) || col < 0 || col >= ROLE_BAG_AXIS_MAX) {
      throw new BizException(BizCode.ROLE_DATA_INVALID, `背包格子列号需为 0 ~ ${ROLE_BAG_AXIS_MAX - 1} 的整数`);
    }
    const key = `${row},${col}`;
    if (seen.has(key)) throw new BizException(BizCode.ROLE_DATA_INVALID, `背包格子（第 ${row + 1} 行第 ${col + 1} 列）重复`);
    seen.add(key);
    const count = Number(cell.count);
    if (!Number.isInteger(count) || count < 1 || count > 999_999) {
      throw new BizException(BizCode.ROLE_DATA_INVALID, "背包物品数量需为 1 ~ 999999 的整数");
    }
    if (typeof cell.id !== "string" || !cell.id.trim() || cell.id.length > ROLE_FIELD_VALUE_MAX_LENGTH) {
      throw new BizException(BizCode.ROLE_DATA_INVALID, "背包物品 id 不合法");
    }
    return { row, col, id: cell.id.trim(), count };
  });
}

/**
 * 把稀疏格子铺进网格（尺寸沿用原网格，不够则扩到刚好放下）
 *
 * 空数组 = **清空背包**（网格保留原尺寸、全部置空），这也是管理端的「清空背包」动作。
 */
export function applyBagCells(currentBag: unknown, cells: BagCellInput[]): Array<Array<{ id: string; count: number } | null>> {
  const current = Array.isArray(currentBag) ? (currentBag as unknown[][]) : [];
  let rows = current.length;
  let cols = current.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  for (const cell of cells) {
    rows = Math.max(rows, cell.row + 1);
    cols = Math.max(cols, cell.col + 1);
  }
  const grid: Array<Array<{ id: string; count: number } | null>> = [];
  for (let row = 0; row < rows; row++) grid.push(new Array<{ id: string; count: number } | null>(cols).fill(null));
  for (const cell of cells) grid[cell.row][cell.col] = { id: cell.id, count: cell.count };
  return grid;
}

//#endregion

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
  // revision 是服务端的索引列（乐观锁），客户端把它一起带在快照里 —— 落库前剔掉，
  // 免得文档里留一份与列不同步的旧值（下一句读回来时以列为准，见 RoleDto.from）
  delete data.revision;
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
