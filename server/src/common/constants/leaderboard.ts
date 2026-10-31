/**
 * 排行榜（#400）
 *
 * 三个榜的口径、物化参数都住在这里 —— 服务与 e2e 读同一份，别在别处再写一遍 `"level"` 这种字面量。
 */

/**
 * 榜单种类
 *
 * - `LEVEL`：角色等级（`roles.level` 索引列，升级路径一直在维护它）；
 * - `COMBAT`：战斗力（`summarizeRoleAttributes().combat`，#541 起属性算法只有服务端一份）
 *   ——它把等级、装备、战魂、称号、军衔全算进去了，是「谁更能打」最接近的答案；
 * - `KILLS`：击杀数（`roles.kills`，服务端结算路径 +1）。
 *
 * 三个榜都用同一套「排序 + 竞赛排名」实现，所以新增一个榜只需要在这里加一项、
 * 在服务的比较器里加一条 —— 不用再写一套分页与名次逻辑。
 */
export const LEADERBOARD_BOARD = {
  LEVEL: "level",
  COMBAT: "combat",
  KILLS: "kills",
} as const;
export type LeaderboardBoard = (typeof LEADERBOARD_BOARD)[keyof typeof LEADERBOARD_BOARD];

/** 全部榜单（服务按这个顺序物化、文档按这个顺序列） */
export const LEADERBOARD_BOARDS: LeaderboardBoard[] = [
  LEADERBOARD_BOARD.LEVEL,
  LEADERBOARD_BOARD.COMBAT,
  LEADERBOARD_BOARD.KILLS,
];

/** 榜单中文名（错误提示与文档用；客户端有自己的展示文案，不从这里取） */
export const LEADERBOARD_BOARD_LABELS: Record<LeaderboardBoard, string> = {
  [LEADERBOARD_BOARD.LEVEL]: "等级",
  [LEADERBOARD_BOARD.COMBAT]: "战力",
  [LEADERBOARD_BOARD.KILLS]: "击杀",
};

/** 榜单重算周期默认值（毫秒；可用 `LEADERBOARD_REFRESH_MS` 覆盖） */
export const LEADERBOARD_REFRESH_MS_DEFAULT = 60_000;

/**
 * 物化保留条数默认值（可用 `LEADERBOARD_TOP_N` 覆盖）
 *
 * 100 条 = 「榜有多长」也是分页 `size` 的实际上限。要做到「人人都看得到自己」靠 `me`
 * 接口（名次在全量排序里取），而不是把这条拉大。
 */
export const LEADERBOARD_TOP_N_DEFAULT = 100;

/**
 * 名次排不下时的占位值（`me` 接口在「没角色 / 榜里没有他」时返回 0）
 *
 * 用 0 而不是 null：客户端判 `rank > 0` 就能决定要不要画那一行，不必区分
 * 「没登录」「没角色」「榜单还没算」三种情况的区别 —— 界面上它们都是「你还没有名次」。
 */
export const LEADERBOARD_NO_RANK = 0;
