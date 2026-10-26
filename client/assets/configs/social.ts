import { Color } from "cc";

/**
 * 社交：玩家关系（#388 帮会 / #389 好友与敌人）
 *
 * ## 关系是**客户端判定的**，服务端只下发原料
 * 「我和他什么关系」需要三份数据：**我的**好友 / 敌人 / 帮会（登录后拉一次快照），
 * 以及**对方的** `roleId` / `guildId`（随互见帧下发）。服务端不需要为每个观看者
 * 各算一遍（那是 O(n²)），客户端拿自己的快照一比即可。
 *
 * ## 优先级是**唯一一处**，改这里就全改
 * 敌人 > 同帮 > 好友 > 同地图 > 普通：
 * - 敌意覆盖一切 —— 把一个人标成敌人，就是要不管他是不是我好友/同帮都看得见红名；
 * - 帮会身份强于私人好友 —— 同帮派是「组织关系」，比「我们互加了好友」更能说明立场。
 *
 * 判定的入口只有 `resolveRelation`：别在别处再写一遍 if/else，否则改优先级时必然漏一处
 * （典型症状：地图上名字是蓝的，社交面板里写着「好友」）。
 */

/** 关系种类（对外展示的六种） */
export const RELATION = {
  /** 自己（互见帧里会被过滤掉，留着是为了判定函数的口径完整） */
  SELF: "self",
  /** 敌人：我把他标成了敌人（后续 PvP 击杀也会自动入列） */
  ENEMY: "enemy",
  /** 同帮派：guildId 相同且不为空 */
  GUILD: "guild",
  /** 好友：双向好友关系（服务端两行都 accepted） */
  FRIEND: "friend",
  /** 同地图：此刻在同一张图里看得见（互见帧里的人） */
  MAP: "map",
  /** 普通：以上都不是（好友列表里不在线的人、不同图的人） */
  NORMAL: "normal",
} as const;

export type RelationKind = (typeof RELATION)[keyof typeof RELATION];

/** 判定优先级（**从高到低**；`resolveRelation` 按这个顺序取第一个命中的） */
export const RELATION_PRIORITY: RelationKind[] = [
  RELATION.SELF,
  RELATION.ENEMY,
  RELATION.GUILD,
  RELATION.FRIEND,
  RELATION.MAP,
  RELATION.NORMAL,
];

/**
 * 关系配色（名字颜色）
 *
 * 「同地图」用白色 = 现状的默认名色（`roleShowLayout.name.color`）：陌生人还是那个白名，
 * 只把「有关系的」染出来 —— 满屏花花绿绿反而看不清谁是谁。
 */
export const relationColors: Record<RelationKind, Color> = {
  [RELATION.SELF]: new Color(255, 255, 255, 255),
  [RELATION.ENEMY]: new Color(255, 91, 91, 255),
  [RELATION.GUILD]: new Color(110, 168, 255, 255),
  [RELATION.FRIEND]: new Color(123, 224, 123, 255),
  [RELATION.MAP]: new Color(255, 255, 255, 255),
  [RELATION.NORMAL]: new Color(200, 200, 200, 255),
};

/** 关系中文名（社交面板每行右侧的标签） */
export const relationLabels: Record<RelationKind, string> = {
  [RELATION.SELF]: "自己",
  [RELATION.ENEMY]: "敌人",
  [RELATION.GUILD]: "同帮",
  [RELATION.FRIEND]: "好友",
  [RELATION.MAP]: "同地图",
  [RELATION.NORMAL]: "普通",
};

/** 判定所需的一方资料（我的快照与对方的帧条目都归一到这个形状） */
export interface RelationTarget {
  roleId: string;
  /** 所属帮会 id（空串 = 无帮会） */
  guildId: string;
}

/** 我的社交快照（登录后 / 社交面板操作后刷新；只存 id，不含名字） */
export interface RelationSelf extends RelationTarget {
  friendIds: string[];
  enemyIds: string[];
}

/**
 * 判定两个人之间的关系
 *
 * 参数里没有「是否同图」这一项：能拿到对方的帧条目，就说明此刻同图 ——
 * 所以 `sameMap` 是调用方的语境（互见帧里传 true，好友列表里传 false）。
 */
export function resolveRelation(self: RelationSelf, target: RelationTarget, sameMap: boolean): RelationKind {
  if (self.roleId === target.roleId) return RELATION.SELF;
  // 用 indexOf 而不是 includes：客户端编译目标是 ES2015，includes 要 ES2016 的 lib
  if (self.enemyIds.indexOf(target.roleId) >= 0) return RELATION.ENEMY;
  if (self.guildId && target.guildId && self.guildId === target.guildId) return RELATION.GUILD;
  if (self.friendIds.indexOf(target.roleId) >= 0) return RELATION.FRIEND;
  return sameMap ? RELATION.MAP : RELATION.NORMAL;
}

/** 关系对应的名字颜色（未知关系按普通处理，不炸） */
export function getRelationColor(relation: RelationKind): Color {
  return relationColors[relation] ?? relationColors[RELATION.NORMAL];
}

//#region 帮会口径（与服务端 common/constants/social.ts 同值）

/**
 * 帮会名长度 / 公告长度 / 人数上限的**客户端镜像**
 *
 * 为什么会有两份：这份只用于**输入时的即时提示**（超长就标红、按钮置灰），
 * 真正的判定在服务端（DTO 校验 + `GUILD_MEMBER_LIMIT` 配置）。两处不一致时
 * 以服务端为准 —— 客户端最多是「允许你输入但提交被拒」。
 */
export const guildRules = {
  nameMin: 2,
  nameMax: 12,
  noticeMax: 200,
};

/** 帮会职位（与服务端 GUILD_RANK 同值；中文名由服务端下发，这里只用于本地比较） */
export const GUILD_RANK = {
  LEADER: "leader",
  VICE: "vice",
  MEMBER: "member",
} as const;

//#endregion
