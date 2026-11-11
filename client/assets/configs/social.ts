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
 * 拉黑 > 敌人 > 同队 > 同帮 > 好友 > 同地图 > 普通：
 * - **拉黑最高**：被拉黑的人本来就不该出现在我屏幕上（服务端也会把他的聊天与位置滤掉），
 *   万一有残帧漏进来（拉黑前已在场），也要按「拉黑」处理而不是按旧关系上色；
 * - 敌意覆盖其余一切 —— 把一个人标成敌人，就是要不管他是不是我好友/同帮都看得见红名；
 * - **同队强于同帮强于好友**（#399）：组队是「此刻一起打怪」的临时关系，比组织与私交都更即时 ——
 *   一个好友进了我的队，我要看得到「他是我队友」，而不是继续显示好友绿；
 * - 帮会身份强于私人好友 —— 同帮派是「组织关系」，比「我们互加了好友」更能说明立场。
 *
 * 判定的入口只有 `resolveRelation`：别在别处再写一遍 if/else，否则改优先级时必然漏一处
 * （典型症状：地图上名字是蓝的，社交面板里写着「好友」）。
 */

/** 关系种类（对外展示的七种） */
export const RELATION = {
  /** 自己（互见帧里会被过滤掉，留着是为了判定函数的口径完整） */
  SELF: "self",
  /** 已拉黑（#398）：他的聊天与位置由服务端过滤，本地见到也一律不显示 */
  BLOCK: "block",
  /** 敌人：我把他标成了敌人（后续 PvP 击杀也会自动入列） */
  ENEMY: "enemy",
  /** 同队（#399）：partyId 相同且不为空 —— 此刻一起打怪的人，名字是金色的 */
  PARTY: "party",
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
  RELATION.BLOCK,
  RELATION.ENEMY,
  RELATION.PARTY,
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
  // 拉黑用暗灰：正常情况下根本看不到这个人（服务端已过滤），这个颜色只用在名单里
  [RELATION.BLOCK]: new Color(120, 126, 138, 255),
  [RELATION.ENEMY]: new Color(255, 91, 91, 255),
  // 同队用金色（#399）：比同帮的蓝更暖、比好友的绿更亮，满屏里一眼能挑出「自己人」
  [RELATION.PARTY]: new Color(255, 209, 102, 255),
  [RELATION.GUILD]: new Color(110, 168, 255, 255),
  [RELATION.FRIEND]: new Color(123, 224, 123, 255),
  [RELATION.MAP]: new Color(255, 255, 255, 255),
  [RELATION.NORMAL]: new Color(200, 200, 200, 255),
};

/** 关系中文名（社交面板每行右侧的标签） */
export const relationLabels: Record<RelationKind, string> = {
  [RELATION.SELF]: "自己",
  [RELATION.BLOCK]: "已拉黑",
  [RELATION.ENEMY]: "敌人",
  [RELATION.PARTY]: "同队",
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
  /**
   * 所在队伍 id（#399；空串 / 不传 = 没队伍）
   *
   * 可选：好友列表、聊天记录这类「他此刻可能不在线」的地方拿不到队伍 ——
   * 没队伍就等同于「不同队」，判定结果落回同帮 / 好友那一档。
   */
  partyId?: string;
}

/** 我的社交快照（登录后 / 社交面板操作后刷新；只存 id，不含名字） */
export interface RelationSelf extends RelationTarget {
  friendIds: string[];
  enemyIds: string[];
  /** 我拉黑的人（#398；单向，只会有「我拉黑的」，不会有「谁拉黑了我」） */
  blockIds: string[];
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
  if (self.blockIds.indexOf(target.roleId) >= 0) return RELATION.BLOCK;
  if (self.enemyIds.indexOf(target.roleId) >= 0) return RELATION.ENEMY;
  // 同队（#399）：两边都有 partyId 且相同才算 —— 空串相等不能算「都叫没队伍的人」是一队
  if (self.partyId && target.partyId && self.partyId === target.partyId) return RELATION.PARTY;
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
 * 帮会门槛的**客户端镜像**（帮会名长度 / 公告长度 / 建帮等级与花费）
 *
 * 两个用途，都只是「提前告诉玩家」：
 * - 输入框的 `maxLength` 与「名字要几个字」的即时提示；
 * - 建帮按钮下方的门槛说明（等级 / 绑定元宝）。
 *
 * 真正的判定在服务端（DTO 结构校验 + `GuildService` 按运行时参数判），两处不一致时
 * 以服务端为准 —— 客户端最多是「允许你输入但提交被拒」，失败文案里写着服务端认的数字。
 *
 * **登录拉快照时会整份覆写**（`apply-snapshot.applyRuntimeParams` 的 `guild` 段，运营在
 * 管理端「运行时参数」页改），所以这里写的初值只在「快照还没到」的那一瞬间有效 ——
 * 别把它当成第二份配置去改数值（改了也不会影响线上）。
 */
export const guildRules = {
  nameMin: 2,
  nameMax: 12,
  noticeMax: 200,
  /** 建帮最低等级（0 = 不限） */
  createLevelMin: 10,
  /** 建帮消耗绑定元宝（0 = 免费） */
  createCostBindGold: 100000,
};

/**
 * 用快照覆写上面这份镜像（登录取配置时调一次）
 *
 * 逐键覆写、只认有限数字：服务端漏字段 / 坏数据就保持当前值，别把「名字要几个字」覆写成
 * `NaN` 或 0（0 会让输入框一个字符都打不进去）。**对象引用不变** —— GuildPanel 拿的是同
 * 一个对象的引用，换对象等于把改动写在空气里（与 `applyDropRuntime` 同一条纪律）。
 */
export function applyGuildRules(params: Partial<typeof guildRules> | undefined): void {
  if (!params) return;
  (Object.keys(guildRules) as Array<keyof typeof guildRules>).forEach((key) => {
    const value = Number(params[key]);
    if (Number.isFinite(value)) guildRules[key] = value;
  });
}

/** 帮会职位（与服务端 GUILD_RANK 同值；中文名由服务端下发，这里只用于本地比较） */
export const GUILD_RANK = {
  LEADER: "leader",
  VICE: "vice",
  MEMBER: "member",
} as const;

//#endregion
