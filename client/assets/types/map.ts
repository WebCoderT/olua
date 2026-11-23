import { Vec3 } from "cc";

// npc接口
export interface NPC {
  // 名称
  label: string;
  // 地址
  src: string;
  // 放大倍率
  scale?: Vec3;
  // 位置
  position?: Vec3;
  // 点击事件
  onClick?: Function;
}

/**
 * NPC 数据条目（configs/npc 的 npcData）
 * id 只做关联（服务端 map_npcs / 掉落 / 任务里都用它），不参与数值计算
 */
export interface NpcData extends NPC {
  /** NPC 编号（唯一） */
  id: string;
}

/** 地图编号
 *
 * **不再是一串字面量联合类型**（#573）：地图清单的真相是服务端下发的配置
 * （行由资源清单 seed 出来）。客户端要是还枚举着 "0".."10"，加一张图就得改客户端代码 +
 * 重打包 —— 那正是这次搬迁要去掉的东西。这里只是 `resources/map/<id>/<id>.tmx` 的目录名。
 */
export type MapId = string;

/** NPC 点位（世界坐标：#672 起由管理端在地图上点放） */
export interface MapNpcPoint {
  /** NPC id（`npcs` 表的主键） */
  npcId: string;
  /** 世界坐标 x（原点 = 地图左上角） */
  x: number;
  /** 世界坐标 y（y 轴向上，故为负） */
  y: number;
}

/** 复活点（世界坐标；一张图最多一个） */
export interface MapRevivePoint {
  x: number;
  y: number;
}

/**
 * 刷怪区中心点（世界坐标）
 *
 * 只给「在小地图上标一下这一区刷的是什么怪」用：尺寸与数量在服务端（`map_spawn_areas`），
 * 客户端不需要——怪物实例由服务端按区域播种，客户端只收结果（`world` 帧）。
 */
export interface MapSpawnAreaPoint {
  monsterKey: string;
  cx: number;
  cy: number;
}

/**
 * 碰撞多边形（世界坐标；#676 起由管理端绘制，#1190 起从矩形升级为多边形）
 *
 * **可以超出地图边界**：每张图四面围墙本来就画在图外（`x = -64`、宽 8320），
 * 那是「把玩家关在图里」的手段 —— 别在下游加「在不在图内」的过滤，那会让围墙失效、
 * 玩家直接走出去。
 */
/**
 * 碰撞多边形（#1190：从矩形升级为任意简单多边形）
 *
 * `points` 是顶点序列 `[x, y][]`（服务端快照原样下发，世界坐标：原点 = 地图左上角、
 * y 轴向上故 y 为负；按绘制顺序、首尾自动闭合、不自交 —— 服务端入库时已校验）。
 * 客户端两处读：生成静态物理碰撞体（`CollisionAreaSpawner`）、自动战斗的静态障碍（A* 烙格）。
 */
export interface MapCollisionPolygon {
  /** 顶点序列 [x, y][]（世界坐标） */
  points: Array<[number, number]>;
}

/**
 * 地图的玩法配置 + 点位（**运行时**填充）
 *
 * ⚠ 客户端不存这些值的出厂数据（#573 之前它们写在 `configs/map.ts` 的 mapData 里）。
 * 进游戏时 `ConfigLoader` 拉 `gameConfig.snapshot`，由 `configs/apply-snapshot` 按 id
 * 覆写进 `configs/map` 的运行时表；资源路径不在其中（由 `mapSrcOf` 按目录约定拼）。
 *
 * 点位与碰撞盒（`npcs` / `revive` / `spawnAreas` / `collisions`）也一样：#672 / #676 起
 * TMX 不再是它们的来源（地图文件里已经没有对象组了），后台改完下次进图就生效
 * （正在图里的人要换图 / 重进）。
 */
export interface MapConfig {
  /** 地图名称（传送弹窗 / 小地图 / 预览图标题都读它） */
  label: string;
  /** 类型码（"0" 安全 / "1" 野外；#1177 收敛） */
  type: string;
  /** 类型名（服务端拼好的显示文案，客户端不再自己维护一份码表） */
  typeLabel: string;
  /** 进入所需等级（0 = 不限；门槛只剩这一项，#1177 删了战斗力 / 战魂阶） */
  level: number;
  /** NPC 点位（坐标已是世界坐标，进图直接摆节点） */
  npcs: MapNpcPoint[];
  /** 复活点（null = 这张图没有：进图不定位、死亡不在这张图复活） */
  revive: MapRevivePoint | null;
  /** 刷怪区中心（只给小地图标名字，不含尺寸与数量） */
  spawnAreas: MapSpawnAreaPoint[];
  /** 碰撞盒（静态碰撞体 + 自动战斗的静态障碍都用它；空数组 = 这张图没有阻挡） */
  collisions: MapCollisionPolygon[];
  /**
   * 单房间人数上限（#812；0 = 不限）
   *
   * 传送弹窗显示 `23/30` 的分母。**人数那一半还没有**：真实在线人数要等服务端给出
   * 「每张图当前几人」，那是分线（#1000）的活 —— 在此之前这个值只用来显示上限。
   */
  maxPlayersPerRoom: number;
  /** 分线数量（#812；1 = 不分线）。决定要不要显示「换线」入口（真正的开线逻辑在 #1000） */
  maxChannels: number;
  /** 传送花费（#812；0 = 免费）。**只用于提前提示**，扣款以服务端为准（#1001） */
  transferCostMoney: number;
}
