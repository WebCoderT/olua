import type { SortSpec } from "./sort.util";

/**
 * 列表排序白名单的**唯一来源**
 *
 * 集中放一处的原因有两个：
 * 1. 仓储只为「已登记的键」映射 SQL 列（`Record<K, string>` 少一个键就编译不过），
 *    接口文档又要列出同一份字段名 —— 各写一份必然漂移，这里给两边同一份；
 * 2. e2e 可以直接遍历这张表断言「白名单外的值一律退回默认排序」（防注入）。
 *
 * 键是**对外的字段名**（客户端与界面用的），值是 SQL 列（含表别名）。
 */

/** 账号列表：字段名 → 列；`roleCount` 是列表查询里的子查询别名 */
export const ACCOUNT_SORT: SortSpec<"username" | "status" | "roleCount" | "createdAt" | "lastLoginAt"> = {
  columns: {
    username: "a.username",
    status: "a.status",
    roleCount: "role_count",
    createdAt: "a.created_at",
    lastLoginAt: "a.last_login_at",
  },
  default: "createdAt",
  defaultOrder: "desc",
};

/** 角色列表：`accountName` 来自 join 出来的账号表 */
export const ROLE_SORT: SortSpec<"name" | "accountName" | "level" | "revision" | "createdAt" | "updatedAt"> = {
  columns: {
    name: "r.name",
    accountName: "a.username",
    level: "r.level",
    revision: "r.revision",
    createdAt: "r.created_at",
    updatedAt: "r.updated_at",
  },
  default: "updatedAt",
  defaultOrder: "desc",
};

/** 管理员列表：默认保持既有行为（创建时间升序，最早注册的在最前） */
export const ADMIN_SORT: SortSpec<"username" | "role" | "status" | "createdAt" | "updatedAt" | "lastLoginAt"> = {
  columns: {
    username: "username",
    role: "role",
    status: "status",
    createdAt: "created_at",
    updatedAt: "updated_at",
    lastLoginAt: "last_login_at",
  },
  default: "createdAt",
  defaultOrder: "asc",
};

/** 操作日志 */
export const AUDIT_SORT: SortSpec<"createdAt" | "actorName" | "action" | "targetType" | "success" | "statusCode" | "ip"> = {
  columns: {
    createdAt: "a.created_at",
    actorName: "a.actor_name",
    action: "a.action",
    targetType: "a.target_type",
    success: "a.success",
    statusCode: "a.status_code",
    ip: "a.ip",
  },
  default: "createdAt",
  defaultOrder: "desc",
};

/** 公告列表：默认按更新时间倒序（运营改完一条就能在列表顶部看到） */
export const ANNOUNCEMENT_SORT: SortSpec<"title" | "level" | "enabled" | "startsAt" | "endsAt" | "createdAt" | "updatedAt"> = {
  columns: {
    title: "title",
    level: "level",
    enabled: "enabled",
    startsAt: "starts_at",
    endsAt: "ends_at",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  default: "updatedAt",
  defaultOrder: "desc",
};

/** 邮件投递队列：默认按创建时间倒序（运营刚点的那封在最上面） */
export const MAIL_SORT: SortSpec<"toEmail" | "status" | "attempts" | "sentAt" | "createdAt" | "updatedAt"> = {
  columns: {
    toEmail: "m.to_email",
    status: "m.status",
    attempts: "m.attempts",
    sentAt: "m.sent_at",
    createdAt: "m.created_at",
    updatedAt: "m.updated_at",
  },
  default: "createdAt",
  defaultOrder: "desc",
};

/** 称号配置列表：默认按等级升序 —— 列表本身就是一张「升级价目表」（1 级在最上面） */
export const TITLE_SORT: SortSpec<"level" | "label" | "bindGold" | "acquireChannel" | "updatedAt"> = {
  columns: {
    level: "level",
    label: "label",
    bindGold: "bind_gold",
    acquireChannel: "acquire_channel",
    updatedAt: "updated_at",
  },
  default: "level",
  defaultOrder: "asc",
};

/** 战魂配置列表：默认按阶数升序（同称号的价目表语义） */
export const SOUL_SORT: SortSpec<"level" | "label" | "bindGold" | "updatedAt"> = {
  columns: {
    level: "level",
    label: "label",
    bindGold: "bind_gold",
    updatedAt: "updated_at",
  },
  default: "level",
  defaultOrder: "asc",
};

/** 把白名单里的字段名拼成一行，供接口文档说明用（`sort` 的取值） */
export function sortFieldNames<K extends string>(spec: SortSpec<K>): string {
  return Object.keys(spec.columns)
    .map((key) => `\`${key}\``)
    .join(" / ");
}

/** 等级经验列表：默认按等级升序（就是一张「升到下一级要多少经验」的价目表） */
export const LEVEL_EXP_SORT: SortSpec<"level" | "exp" | "updatedAt"> = {
  columns: {
    level: "level",
    exp: "exp",
    updatedAt: "updated_at",
  },
  default: "level",
  defaultOrder: "asc",
};

/** 成长曲线分段列表：默认按曲线键 + 段序升序（同一曲线的分段连成一片） */
export const GROWTH_SEGMENT_SORT: SortSpec<"curve" | "seq" | "fromLevel" | "toLevel" | "startValue" | "perLevel" | "updatedAt"> = {
  columns: {
    curve: "curve",
    seq: "seq",
    fromLevel: "from_level",
    toLevel: "to_level",
    startValue: "start_value",
    perLevel: "per_level",
    updatedAt: "updated_at",
  },
  default: "curve",
  defaultOrder: "asc",
};

/** 成长标量参数列表：默认按键名升序（同来源的参数排在一起，如 attributeRange.*） */
export const GROWTH_SCALAR_SORT: SortSpec<"key" | "value" | "updatedAt"> = {
  columns: {
    key: "key",
    value: "value",
    updatedAt: "updated_at",
  },
  default: "key",
  defaultOrder: "asc",
};

/** 军衔配置列表：默认按阶数升序（同称号的价目表语义） */
export const RANK_SORT: SortSpec<"level" | "label" | "tier" | "bindGold" | "updatedAt"> = {
  columns: {
    level: "level",
    label: "label",
    tier: "tier",
    bindGold: "bind_gold",
    updatedAt: "updated_at",
  },
  default: "level",
  defaultOrder: "asc",
};

/**
 * 装备基础件列表（#252）：默认按等级升序（等级是装备定强的主轴，同级内按 id 稳定排序）
 * 注：slot 是 TEXT 列，字典序与客户端槽位顺序无关 —— 部位只作筛选，不参与默认排序。
 */
export const EQUIPMENT_SORT: SortSpec<"id" | "slot" | "level" | "sellPrice" | "updatedAt"> = {
  columns: {
    id: "id",
    slot: "slot",
    level: "level",
    sellPrice: "sell_price",
    updatedAt: "updated_at",
  },
  default: "level",
  defaultOrder: "asc",
};

/** 药品配置列表（#253）：默认按 id 升序（血药组在前、蓝药组在后的分组习惯） */
export const DRUG_SORT: SortSpec<"id" | "label" | "level" | "sellPrice" | "updatedAt"> = {
  columns: {
    id: "id",
    label: "label",
    level: "level",
    sellPrice: "sell_price",
    updatedAt: "updated_at",
  },
  default: "id",
  defaultOrder: "asc",
};

/** 物品与材料列表（#255）：默认按 id 升序（物品 id 的字典序即分组习惯） */
export const ITEM_SORT: SortSpec<"id" | "type" | "label" | "sellPrice" | "updatedAt"> = {
  columns: {
    id: "id",
    type: "type",
    label: "label",
    sellPrice: "sell_price",
    updatedAt: "updated_at",
  },
  default: "id",
  defaultOrder: "asc",
};

/** 怪物基础数据列表（#258）：默认按等级升序（练级动线从低到高） */
export const MONSTER_SORT: SortSpec<"id" | "label" | "tier" | "level" | "maxHp" | "updatedAt"> = {
  columns: {
    id: "id",
    label: "label",
    tier: "tier",
    level: "level",
    maxHp: "max_hp",
    updatedAt: "updated_at",
  },
  default: "level",
  defaultOrder: "asc",
};

/** NPC 基础数据列表（#258）：默认按 id 升序（id 的分段习惯即功能分组） */
export const NPC_SORT: SortSpec<"id" | "label" | "updatedAt"> = {
  columns: {
    id: "id",
    label: "label",
    updatedAt: "updated_at",
  },
  default: "id",
  defaultOrder: "asc",
};

/** 时装配置列表（#257）：默认按 id 升序（配置文件里的声明顺序，即素材编号顺序） */
export const FASHION_SORT: SortSpec<"id" | "label" | "sellPrice" | "updatedAt"> = {
  columns: {
    id: "id",
    label: "label",
    sellPrice: "sell_price",
    updatedAt: "updated_at",
  },
  default: "id",
  defaultOrder: "asc",
};

/**
 * 每怪掉落列表（#254）：monsterKey 用数值序 —— key 是数字字符串，
 * TEXT 排序会 1,10,11…乱序，CAST 成整数才与怪物配置页同一动线
 */
export const MONSTER_DROP_SORT: SortSpec<"monsterKey" | "source" | "updatedAt"> = {
  columns: {
    monsterKey: "CAST(monster_key AS INTEGER)",
    source: "source",
    updatedAt: "updated_at",
  },
  default: "monsterKey",
  defaultOrder: "asc",
};

/**
 * 技能列表（#367）：默认按 id 的**数值序** —— id 是数字字符串，TEXT 排序会
 * 1000,1001,1002,1010,1011,9001… 之外还会把 9001 排到 1001 前面；
 * 角色技能用 1000 段、怪物技能用 9000 段，数值序天然把两边分块（owner 另有筛选）
 */
export const SKILL_SORT: SortSpec<"id" | "owner" | "label" | "levelReq" | "cooldown" | "updatedAt"> = {
  columns: {
    id: "CAST(id AS INTEGER)",
    owner: "owner",
    label: "label",
    levelReq: "level_req",
    cooldown: "cooldown",
    updatedAt: "updated_at",
  },
  default: "id",
  defaultOrder: "asc",
};

/** 状态列表（#367）：默认按 id 数值序（角色 2000 段 / 怪物 3000 段，与技能同一动线） */
export const STATUS_SORT: SortSpec<"id" | "owner" | "label" | "duration" | "updatedAt"> = {
  columns: {
    id: "CAST(id AS INTEGER)",
    owner: "owner",
    label: "label",
    duration: "duration",
    updatedAt: "updated_at",
  },
  default: "id",
  defaultOrder: "asc",
};

/** 任务配置列表（#396）：默认按 id 数值序（主线 8001 段 / 日常 8100 段，与技能同一动线） */
export const QUEST_SORT: SortSpec<"id" | "kind" | "label" | "minLevel" | "updatedAt"> = {
  columns: {
    id: "CAST(id AS INTEGER)",
    kind: "kind",
    label: "label",
    minLevel: "min_level",
    updatedAt: "updated_at",
  },
  default: "id",
  defaultOrder: "asc",
};

/**
 * 成就配置列表（#401）：默认按「分类 → 分类内顺序 → id」—— 成就 id 是语义串
 * （`ach_kill_10`），按 id 排没有意义，运营看的顺序就是面板里的顺序。
 */
export const ACHIEVEMENT_SORT: SortSpec<"id" | "category" | "label" | "sortOrder" | "updatedAt"> = {
  columns: {
    id: "id",
    category: "category",
    label: "label",
    sortOrder: "sort_order",
    updatedAt: "updated_at",
  },
  default: "sortOrder",
  defaultOrder: "asc",
};
