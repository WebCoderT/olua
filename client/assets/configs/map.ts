import type { MapConfig, MapId } from "../types/map";

/**
 * 地图（#573：客户端只留**资源约定**，玩法配置全在服务端）
 *
 * ## 这里为什么空了
 *
 * 以前这张文件里是一张 `mapData` 表：11 张图的名称 / 类型 / 进入等级 / 进入战斗力 /
 * 进入战魂阶。那些是**玩法配置**，不是资源 —— 改一个进入等级要重打整个客户端包（3G），
 * 而它们本来就该由运营在管理端改。
 *
 * 现在的地图分两半：
 *
 * | 数据 | 在哪 | 谁能改 |
 * |---|---|---|
 * | TMX / 底图 / 预览图 | 客户端资源包 `resources/map/<id>/` | 美术（随包发布） |
 * | 名称 / 类型 / 进入条件 | 服务端 `maps` 表 | 运营（管理端「地图管理」，保存即生效） |
 *
 * 客户端要做的只有两件事：**按 id 拼资源路径**（`mapSrcOf`，目录约定）、
 * **进游戏时把服务端那份配置接住**（`configs/apply-snapshot` 的 `applyMapRows`）。
 *
 * ⚠ 所以 `maps` 在配置拉回来之前是**空的**，这不是 bug：
 * - 资源预加载 / 进图**不用查它**（路径由 `mapSrcOf` 算，见 ui/Game 与 Loading）；
 * - 显示层（小地图 / 传送弹窗）读空时用 `mapLabelOf` 的兜底文案，并随快照到达自动更新。
 */

/** Tiled 对象组名称（地图文件与游戏代码之间的约定，改名只需改这里） */
export const tiledGroupNames = {
  /** NPC 与复活点 */
  npc: "npc",
  /** 兼容早期地图：NPC 与复活点画在 objects 组 */
  legacyObjects: "objects",
  /** 刷怪区域 */
  monster: "monster",
  /** 碰撞区域 */
  collision: "collision",
};

/** Tiled 对象的自定义属性名（地图文件与游戏代码之间的约定） */
export const tiledPropertyNames = {
  /** 编号（NPC 编号 / 怪物编号） */
  id: "id",
  /** 刷怪区域允许的最少怪物数 */
  min: "min",
  /** 刷怪区域允许的最多怪物数 */
  max: "max",
};

/** Tiled 对象的对象类取值（对象标签上的 class/type） */
export const tiledObjectClasses = {
  /** NPC（有外观点位） */
  npc: "npc",
  /** 复活点（只是坐标，没有外观） */
  revive: "revive",
};

/**
 * 地图资源路径
 *
 * 唯一规则：`resources/map/<id>/<id>.tmx`（底图与预览图在同一个目录里）。
 * **只此一处**：客户端、服务端（`MapService.srcOf`）都按这条约定拼，谁都不存一个 `src` 字段 ——
 * 存了就会有人改它，而改它只会把客户端指到一张不存在的图上。
 */
export function mapSrcOf(id: MapId): string {
  return `map/${id}/${id}`;
}

/**
 * 运行时地图表（id → 玩法配置）
 *
 * 内容由服务端配置快照填充（`applyMapRows`，进游戏时一次）。**不要往这里写死数据** ——
 * 那等于把配置又搬回了客户端，`audit-shared-data` 与代码评审都盯着这一点。
 */
export const maps = new Map<MapId, MapConfig>();

/**
 * 地图类型分组（顺序 + 文案都由服务端下发）
 *
 * 传送弹窗按这个数组分桶展示；空数组表示「配置还没到」，那时弹窗不渲染分组。
 * 以前这份顺序与文案在客户端写死（`mapTypeGroups`），搬迁后归服务端 ——
 * 新增一种地图类型只改服务端，客户端跟着下发走。
 */
export const mapTypeGroups: Array<{ type: string; label: string }> = [];

/** 地图名（没拉到配置时给一个能看懂的兜底，不显示空白按钮） */
export function mapLabelOf(id: MapId): string {
  const config = maps.get(id);
  return config && config.label ? config.label : `地图 ${id}`;
}
