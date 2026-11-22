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
 * 地图类型（#1177 收敛后只剩两种）
 *
 * 历史（#1177 前）有四类：安全 / 等级 / 战斗力 / 战魂（码 `"0"`..`"3"`）。
 * 收敛时**复用了码 `"1"`**（原来是等级地图）：存量 `"2"`（战斗力）与 `"3"`（战魂）
 * 由启动迁移 UPDATE 成 `"1"`，本来就是 `"1"` 的行原地变成野外 —— 不用二次改写。
 * 进入门槛只保留「进入等级」；战斗力与战魂阶两列已删（#1177），别再加回来。
 */
export const MapType = {
  /** 安全地图：不刷怪、不允许 PK、无门槛（主城 / 新手村） */
  NORMAL: "0",
  /** 野外地图：无限制 —— 可刷怪、可开 PK（`map_rules.allow_pk`）、最多一道进入等级门槛 */
  WILD: "1",
} as const;

export type MapTypeValue = (typeof MapType)[keyof typeof MapType];

/** 全部类型（DTO 枚举校验 / 管理端下拉用） */
export const MAP_TYPE_VALUES: MapTypeValue[] = Object.values(MapType);

/** 类型中文名（接口与界面展示的唯一来源） */
export const MAP_TYPE_LABELS: Record<MapTypeValue, string> = {
  [MapType.NORMAL]: "安全地图",
  [MapType.WILD]: "野外地图",
};

/** 传送弹窗的分组顺序（= 上面的声明顺序；快照原样下发，客户端不再自己排） */
export const MAP_TYPE_GROUPS: Array<{ type: MapTypeValue; label: string }> = MAP_TYPE_VALUES.map((type) => ({
  type,
  label: MAP_TYPE_LABELS[type],
}));

/**
 * 进入条件的取值上限（#1177 后只剩「进入等级」一项）
 *
 * 只是拦「明显拍错」（把进入等级写成 999 这类）：等级上限与角色的等级上限同源
 * （`GROWTH_SCALARS.roleMaxLevel` 出厂 200，这里给一点余量到 500 反而会放过错误值，
 * 所以直接按 200 封顶）。战斗力 / 战魂阶两个门槛已随 #1177 删掉，别在这里加回来。
 */
export const MAP_ENTER_LIMITS = {
  level: { min: 0, max: 200 },
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
  /** 密度系数取值域（#852）：0 = 清场，1 = 基准，5 = 五倍。再大基本是填错了 */
  density: { min: 0, max: 5 },
  /** 高峰时段写法（`"19:00-23:00"`，支持跨零点；空串 = 无峰谷） */
  peakHours: /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/,
  /** 矩形最短边（像素）；管理端画布也按它做「太小的框不提交」 */
  minSize: 16,
} as const;

/**
 * 碰撞多边形的限制（#676 起归后台；#1190 从矩形升级为多边形）
 *
 * 顶点数卡在 3~64：3 是封闭的最少顶点，64 顶点已经能描出足够精细的轮廓，而自交校验
 * 是 O(n²)（64² ≈ 4000 对边，毫秒级），放更宽只会让画布卡。边长下限 1px：相邻顶点
 * 太近构不成有效的边（重复点 / 抖动点），射线法与自交校验都会被退化边搅乱。
 * **不做越界判定**：四面围墙本来就画在图外（x = -64），那是「把玩家关在图里」的手段。
 */
export const COLLISION_POLY_LIMITS = {
  /** 最少顶点数（封闭的最少点数） */
  minVertices: 3,
  /** 最多顶点数 */
  maxVertices: 64,
  /** 相邻顶点最小间距（像素）：防重复点 / 抖动点 */
  minEdge: 1,
} as const;

/**
 * 开一场副本的取值域（#1001 第二刀）
 *
 * 与 `MAP_ENTER_LIMITS` 同一套写法：**DTO 的 `@Min/@Max` 与仓储的护栏读同一份数字**，
 * 不各写一个。上限不是玩法，是「填错了」的护栏 —— 时限填成 240 小时、人数填成 1000，
 * 那一定是把毫秒当分钟、或者多按了一个 0。
 */
export const INSTANCE_LIMITS = {
  /** 时限：至少 1 秒（0 等于「开出来就收场」），最多 24 小时 */
  ttlMs: { min: 1_000, max: 24 * 60 * 60_000 },
  /** 人数上限：0 = 不限（单机调试用），最多 100 */
  maxPlayers: { min: 0, max: 100 },
  /** 名单长度（一个队 / 一个团都够了；再长是把整张玩家表贴进来了） */
  ownersMax: 100,
} as const;

/** 一张图的出厂配置（落库前的默认值） */
export interface MapDefault {
  id: string;
  label: string;
  type: MapTypeValue;
  level: number;
}

/**
 * 出厂种子 —— **一次搬迁的产物，不是第二份配置**
 *
 * 这 62 条是 #1150 换图（旧 11 张客户端拼图 → 真彩地图 DT2101~DT2162）时重写的默认值：
 * 名称取素材目录后缀（无后缀用 DT 编号），类型一律安全地图、无门槛，玩法条件由运营在
 * 管理端逐张填。之后运营在管理端改的是 `maps` 表，**不是这里**：
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
  { id: "0", label: "望星台", type: MapType.NORMAL, level: 0 },
  { id: "1", label: "八卦台", type: MapType.WILD, level: 0 },
  { id: "2", label: "青石校场", type: MapType.WILD, level: 11 },
  { id: "3", label: "百旗围场", type: MapType.WILD, level: 0 },
  { id: "4", label: "阎罗大殿", type: MapType.WILD, level: 21 },
  { id: "5", label: "盘根断崖", type: MapType.WILD, level: 0 },
  { id: "6", label: "火焰洞窟", type: MapType.WILD, level: 31 },
  { id: "7", label: "陷坑矿场", type: MapType.WILD, level: 0 },
  { id: "8", label: "破败庙门", type: MapType.WILD, level: 41 },
  { id: "9", label: "石栏擂台", type: MapType.NORMAL, level: 0 },
  { id: "10", label: "紫泉洞窟", type: MapType.WILD, level: 51 },
  { id: "11", label: "四象圆台", type: MapType.WILD, level: 0 },
  { id: "12", label: "落日土径", type: MapType.WILD, level: 0 },
  { id: "13", label: "霜刺长廊", type: MapType.WILD, level: 0 },
  { id: "14", label: "熔脊浮岛", type: MapType.WILD, level: 0 },
  { id: "15", label: "金盘石堂", type: MapType.WILD, level: 0 },
  { id: "16", label: "迷雾柱顶", type: MapType.WILD, level: 0 },
  { id: "17", label: "绿野迷踪", type: MapType.WILD, level: 0 },
  { id: "18", label: "晶崖花径", type: MapType.WILD, level: 0 },
  { id: "19", label: "晶窟祭坛", type: MapType.WILD, level: 0 },
  { id: "20", label: "碧苔地牢", type: MapType.WILD, level: 0 },
  { id: "21", label: "紫光悬屿", type: MapType.WILD, level: 0 },
  { id: "22", label: "青焰石室", type: MapType.WILD, level: 0 },
  { id: "23", label: "十字水台", type: MapType.WILD, level: 0 },
  { id: "24", label: "紫曜大殿", type: MapType.WILD, level: 0 },
  { id: "25", label: "冰封五台", type: MapType.WILD, level: 0 },
  { id: "26", label: "金阙浮岛", type: MapType.WILD, level: 0 },
  { id: "27", label: "沉渊残台", type: MapType.WILD, level: 0 },
  { id: "28", label: "魂旗高台", type: MapType.WILD, level: 0 },
  { id: "29", label: "浮金迷城", type: MapType.WILD, level: 0 },
  { id: "30", label: "萤火草坛", type: MapType.WILD, level: 0 },
  { id: "31", label: "紫电浮阶", type: MapType.WILD, level: 0 },
  { id: "32", label: "浴龙池", type: MapType.WILD, level: 0 },
  { id: "33", label: "楼阁石台", type: MapType.NORMAL, level: 0 },
  { id: "34", label: "废土营寨", type: MapType.WILD, level: 0 },
  { id: "35", label: "紫晶悬岩", type: MapType.WILD, level: 0 },
  { id: "36", label: "熔岩祭坛", type: MapType.WILD, level: 0 },
  { id: "37", label: "寒玉石庭", type: MapType.WILD, level: 0 },
  { id: "38", label: "云海雷台", type: MapType.WILD, level: 0 },
  { id: "39", label: "圣翼圆盘", type: MapType.WILD, level: 0 },
  { id: "40", label: "花溪林地", type: MapType.WILD, level: 0 },
  { id: "41", label: "藏宝殿", type: MapType.WILD, level: 0 },
  { id: "42", label: "四方战场", type: MapType.WILD, level: 0 },
  { id: "43", label: "黑曜王座", type: MapType.WILD, level: 0 },
  { id: "44", label: "赤焰浮阁", type: MapType.WILD, level: 0 },
  { id: "45", label: "碧水方城", type: MapType.WILD, level: 0 },
  { id: "46", label: "沙瀑废村", type: MapType.WILD, level: 0 },
  { id: "47", label: "冰棘荒原", type: MapType.WILD, level: 0 },
  { id: "48", label: "星霜六角台", type: MapType.WILD, level: 0 },
  { id: "49", label: "八阵荒营", type: MapType.WILD, level: 0 },
  { id: "50", label: "冰湖雪野", type: MapType.WILD, level: 0 },
  { id: "51", label: "雪河废村", type: MapType.WILD, level: 0 },
  { id: "52", label: "孤崖木桥", type: MapType.WILD, level: 0 },
  { id: "53", label: "龙骨冰廊", type: MapType.WILD, level: 0 },
  { id: "54", label: "冰晶废墟", type: MapType.WILD, level: 0 },
  { id: "55", label: "幽谷石桥", type: MapType.WILD, level: 0 },
  { id: "56", label: "褐石残垣", type: MapType.WILD, level: 0 },
  { id: "57", label: "冰水残城", type: MapType.WILD, level: 0 },
  { id: "58", label: "幽灯石室", type: MapType.WILD, level: 0 },
  { id: "59", label: "土堡围城", type: MapType.WILD, level: 0 },
  { id: "60", label: "木栅庄园", type: MapType.WILD, level: 0 },
  { id: "61", label: "环水花庭", type: MapType.NORMAL, level: 0 },
];

/** 按 id 取出厂值（资源清单里有、这里没有的图返回 null，由调用方给空默认） */
export function mapDefaultOf(id: string): MapDefault | null {
  return MAP_DEFAULTS.find((item) => item.id === id) ?? null;
}
