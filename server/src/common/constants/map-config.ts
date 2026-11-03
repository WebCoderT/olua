/**
 * 地图玩法配置的取值域与出厂种子（#573）
 *
 * ## 为什么在服务端
 *
 * 地图分两半：**资源本体**（TMX / 底图 / 预览图）在客户端资源包里，**玩法配置**
 * （名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶）是对这份资源的整理结果 ——
 * 按三端边界，整理结果归服务端，管理端可视化地改它，客户端进游戏时拉走。
 *
 * 所以客户端 `configs/map.ts` 里**一个字都不该有**（#573 之前那些值确实在那儿，
 * 改一个进入等级要重打 3G 的包）。
 *
 * ## 这段文案为什么也只有一份
 *
 * 类型码 → 显示名以前住在客户端 `mapTypeGroups`，靠生成物镜像给管理端。搬迁后
 * 三端都要用，就收到这里：管理端读接口返回的 `typeLabel`，客户端读快照里的
 * `mapTypes`（见 `ClientConfigService`），谁都不再自己抄一份。
 */

/**
 * 地图类型（码值与历史上的客户端 `types/map.MapType` 逐值一致）
 *
 * 注意 `SOUL_OF_WAR` 在旧客户端枚举里是**数字** 3、其余是字符串 —— 那种不一致是
 * 历史包袱，不是语义：落库与下发一律按字符串 `"3"`，省掉「这里要 String() 那里不要」。
 */
export const MapType = {
  /** 安全地图：无进入条件（主城 / 新手村） */
  NORMAL: "0",
  /** 等级地图：达到等级才能进 */
  LEVEL: "1",
  /** 战斗力地图：达到战力才能进 */
  COMBAT: "2",
  /** 战魂地图：达到战魂阶才能进 */
  SOUL_OF_WAR: "3",
} as const;

export type MapTypeValue = (typeof MapType)[keyof typeof MapType];

/** 全部类型（DTO 枚举校验 / 管理端下拉用） */
export const MAP_TYPE_VALUES: MapTypeValue[] = Object.values(MapType);

/** 类型中文名（接口与界面展示的唯一来源） */
export const MAP_TYPE_LABELS: Record<MapTypeValue, string> = {
  [MapType.NORMAL]: "安全地图",
  [MapType.LEVEL]: "等级地图",
  [MapType.COMBAT]: "战斗力地图",
  [MapType.SOUL_OF_WAR]: "战魂地图",
};

/** 传送弹窗的分组顺序（= 上面的声明顺序；快照原样下发，客户端不再自己排） */
export const MAP_TYPE_GROUPS: Array<{ type: MapTypeValue; label: string }> = MAP_TYPE_VALUES.map((type) => ({
  type,
  label: MAP_TYPE_LABELS[type],
}));

/**
 * 进入条件的取值上限
 *
 * 只是拦「明显拍错」（把进入等级写成 999、把战魂阶写成 500 这类）：
 * 等级上限与角色的等级上限同源（`GROWTH_SCALARS.roleMaxLevel` 出厂 200，
 * 这里给一点余量到 500 反而会放过错误值，所以直接按 200 封顶）；
 * 战力是派生值（血量 × 10 起步，几十万很正常），上限给 9 位；
 * 战魂阶的满阶在 `souls` 表里（37），给到 999 是为了运营将来加阶不用改这里。
 */
export const MAP_ENTER_LIMITS = {
  level: { min: 0, max: 200 },
  combat: { min: 0, max: 999_999_999 },
  soulOfWar: { min: 0, max: 999 },
} as const;

/** 地图名称的最大长度（超出就是粘错了东西，不是「名字长」） */
export const MAP_LABEL_MAX_LENGTH = 24;

/**
 * 刷怪区的取值域（#667 后台绘制）
 *
 * `name`：区域名是运营自己起的（同图内唯一），24 与地图名同一口径；
 * `count`：一个区维持多少只。上限 200 —— 一个区两百只已经会让「进图第一帧」的 world 帧
 *   大到几万字节，再往上多半是数量填错了（比如把坐标填进数量框）；
 * `minSize`：矩形最小边长（像素）。手抖点一下会得到一个 1×1 的框，那种区域能刷但不能用 ——
 *   挡在接口层，比事后在图上找一个针尖大的框容易。
 */
export const SPAWN_AREA_LIMITS = {
  name: { min: 1, max: 24 },
  count: { min: 1, max: 200 },
  /** 矩形最短边（像素）；管理端画布也按它做「太小的框不提交」 */
  minSize: 16,
} as const;

/**
 * 碰撞盒的限制（#676）
 *
 * 最短边只有 1px：碰撞盒可以是「一条缝」（贴墙的窄阻挡），拿刷怪区的 16px 去卡它会把
 * 正常数据判成错。这里只拦「零面积 / 负数」这种一定是算错了的输入 —— 不做越界判定，
 * 四面围墙本来就画在图外。
 */
export const COLLISION_BOX_LIMITS = {
  /** 最短边（像素） */
  minSize: 1,
} as const;

/** 一张图的出厂配置（落库前的默认值） */
export interface MapDefault {
  id: string;
  label: string;
  type: MapTypeValue;
  level: number;
  combat: number;
  soulOfWar: number;
}

/**
 * 出厂种子 —— **一次搬迁的产物，不是第二份配置**
 *
 * 这 11 条是 #573 从客户端 `configs/map.ts` 原样搬过来的（迁移那天玩家看到的东西
 * 一个字都不变）。之后运营在管理端改的是 `maps` 表，**不是这里**：
 * seed 只在「库里没有这张图的行」时插入（`INSERT OR IGNORE`），改过之后重启不会被盖回来。
 *
 * 用数组而不是 `Record<string, …>`：键清单那种形状容易被误读成「又维护了一份地图表」，
 * 而这张表的真实语义是「新库第一次启动时按资源清单补行的默认值」。
 *
 * 资源清单本身不在这里 —— 它是 `maps` 表的行（由 `tools/import-map-resources.cjs`
 * 扫 `client/assets/resources/map` 补出来）。这里没有的图会被补成「空名 / 安全地图 / 无门槛」，
 * 运营在管理端填上即可。
 */
export const MAP_DEFAULTS: MapDefault[] = [
  { id: "0", label: "新手村", type: MapType.NORMAL, level: 1, combat: 0, soulOfWar: 0 },
  { id: "1", label: "卧龙城", type: MapType.NORMAL, level: 10, combat: 0, soulOfWar: 0 },
  { id: "2", label: "王城", type: MapType.NORMAL, level: 40, combat: 0, soulOfWar: 0 },
  { id: "3", label: "雪域高原", type: MapType.LEVEL, level: 1, combat: 0, soulOfWar: 0 },
  { id: "4", label: "漠北草原", type: MapType.LEVEL, level: 10, combat: 0, soulOfWar: 0 },
  { id: "5", label: "大漠戈壁", type: MapType.LEVEL, level: 20, combat: 0, soulOfWar: 0 },
  { id: "6", label: "破碎神庙", type: MapType.LEVEL, level: 30, combat: 0, soulOfWar: 0 },
  { id: "7", label: "灼烧之地", type: MapType.LEVEL, level: 35, combat: 0, soulOfWar: 0 },
  { id: "8", label: "石林峡谷", type: MapType.LEVEL, level: 40, combat: 0, soulOfWar: 0 },
  { id: "9", label: "水乡泽国", type: MapType.LEVEL, level: 45, combat: 0, soulOfWar: 0 },
  { id: "10", label: "桃花源溪", type: MapType.LEVEL, level: 50, combat: 0, soulOfWar: 0 },
];

/** 按 id 取出厂值（资源清单里有、这里没有的图返回 null，由调用方给空默认） */
export function mapDefaultOf(id: string): MapDefault | null {
  return MAP_DEFAULTS.find((item) => item.id === id) ?? null;
}
