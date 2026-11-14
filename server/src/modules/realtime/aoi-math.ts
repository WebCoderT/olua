/**
 * AOI 几何口径（#810）
 *
 * 只放**纯函数与常量**：格子怎么算、邻近哪 9 格、实体 id 怎么拼。索引与「谁看得到谁」
 * 的状态机在 `aoi.service.ts`。分开的理由与 `map-geometry` 拆纯函数一样 —— 这一层没有
 * 任何状态，改它不需要跑服务端，e2e 也能直接拿它算期望值。
 *
 * ## 为什么格子边长是常量而不是运行时参数
 * 改格子边长等于把**所有已成形的索引**重建一遍（实体在旧格里的位置全作废），而索引的
 * 生命周期挂在房间上、房间的生命周期跨重启（库里的世界）。做成热改参数就会出现「一半
 * 房间按 512 建、一半按 256 建」的时段，排查成本远大于收益。改它 = 发版。
 */

/** 格子边长（像素）。8192² 的图 → 16×16 = 256 格；一格视野 = 3×3 共 ±768px */
export const AOI_CELL = 512;

/**
 * 离开视野的延迟（毫秒）
 *
 * 站在格子边界来回走会让实体反复进出视野，客户端看到的是「怪闪一下」。所以「看不见了」
 * 先记账，1 秒内又看见就取消；真的走了才发 `entityLeave`。
 */
export const AOI_LEAVE_DELAY_MS = 1000;

/**
 * 单帧实体上限
 *
 * 防「怪围上来」：一个 3×3 视野里塞进几百只时，单帧 JSON 会顶到几十 KB，而玩家屏幕
 * 上根本放不下。超出就只留离**格心**最近的 200 个 —— 用格心而不是玩家自身坐标，是为了
 * 让同一格的人得到完全相同的集合（否则同一格的玩家无法共用一份序列化结果，
 * 那是这一刀收益的主体）。
 */
export const AOI_MAX_ENTITIES = 200;

/** 怪物的实体 id 前缀（与玩家共用一套格子索引，但 id 空间不同：实例 id vs 账号 id） */
export const MONSTER_ENTITY = "m:";

/** 玩家的实体 id 前缀 */
export const PLAYER_ENTITY = "p:";

/** 一只怪的实体 id */
export function monsterEntityOf(instanceId: string): string {
  return `${MONSTER_ENTITY}${instanceId}`;
}

/** 一个玩家的实体 id */
export function playerEntityOf(accountId: string): string {
  return `${PLAYER_ENTITY}${accountId}`;
}

/**
 * 坐标落在哪一格
 *
 * 世界坐标 y 轴**向上**（地面在 y=0，天在 y=-H），而 Tiled 的行号从上往下数 —— 所以行号
 * 取 `floor(-y / CELL)` 才与地图数据对得上。列号直接用 `floor(x / CELL)`。
 */
export function cellKeyOf(x: number, y: number): string {
  return `${Math.floor(x / AOI_CELL)}:${Math.floor(-y / AOI_CELL)}`;
}

/** 格子中心（世界坐标；距离上限裁剪用它当基准点） */
export function cellCenterOf(cellKey: string): { x: number; y: number } {
  const [col, row] = cellKey.split(":").map(Number);
  return { x: (col + 0.5) * AOI_CELL, y: -(row + 0.5) * AOI_CELL };
}

/**
 * 一个格子的 3×3 邻域（含自身，共 9 个键）
 *
 * 顺序固定（行优先），不依赖 Map 迭代顺序 —— 它只进 Set 做并集，顺序本身不影响语义，
 * 但固定下来方便测试比对。
 */
export function neighborCellKeys(cellKey: string): string[] {
  const [col, row] = cellKey.split(":").map(Number);
  const keys: string[] = [];
  for (let dRow = -1; dRow <= 1; dRow += 1) {
    for (let dCol = -1; dCol <= 1; dCol += 1) keys.push(`${col + dCol}:${row + dRow}`);
  }
  return keys;
}
