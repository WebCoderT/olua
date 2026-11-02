/**
 * 时装出厂数据（#603 第十二域）—— **唯一书写处**
 *
 * ===========================================================================
 * 这张表管什么、不管什么
 * ===========================================================================
 * - **一套时装的全部可运营信息**（名称 / 文案 / 图标 / 内观资源 / 外观资源 / 售卖价 /
 *   八项属性加成）→ 本文件 → `fashions` 表（管理端「时装配置」可改）→
 *   `GET /game-config` 快照的 `fashions` 段 → 客户端整表重建。
 * - **穿着状态与外观几何**不在表里：谁穿着哪套是角色存档（服务端权威），
 *   外观位置 / 缩放是 `equip_aligns` 那套几何表。
 * - **获得渠道**（upgrade / grant / unavailable）是运营状态而非出厂数据：
 *   种子里一律 `unavailable`，由管理端按活动开放（见 `SEED_ACQUIRE_CHANNEL`）。
 *
 * ===========================================================================
 * 资源路径为什么入库
 * ===========================================================================
 * `cloth_2` 与 `clothes/out/001` 之间**没有可推导的约定**（编号与 id 不连续，
 * cloth_13 甚至没有内观图），所以路径必须跟着行走 —— 与药品 / 材料图标同一判断标准；
 * 而地图 `<id>/<id>`、特效 `effect/<key>/<key>.plist` 能按 id 推导，就不入库。
 *
 * ===========================================================================
 * id 清单为什么固定
 * ===========================================================================
 * 时装的 id 被角色存档（`fashion` 字段）与几何表引用，所以管理端只提供**修改**，
 * 不提供新建 / 删除（e2e 钉死 POST / DELETE 路由不存在）。
 */
export interface FashionSeedRow {
  /** 时装 id（如 "cloth_2"；主键，不可增删行） */
  id: string;
  /** 名称（运营文案） */
  label: string;
  /** 描述（运营文案，卖点） */
  description: string;
  /** 图标资源路径（resources 相对路径，不含扩展名） */
  icon: string;
  /** 内观资源路径（空串 = 这套时装没有内观图，如 cloth_13） */
  inRes: string;
  /** 外观资源路径（空串 = 无） */
  outRes: string;
  /** 售卖价（绑定元宝/件） */
  sellPrice: number;
  /** 最大生命加成 */
  maxHp: number;
  /** 每秒回血加成 */
  hpRecover: number;
  /** 物理攻击区间 */
  physicalAttack: FashionRangeSeed;
  /** 魔法攻击区间 */
  magicAttack: FashionRangeSeed;
  /** 道术攻击区间 */
  taoistAttack: FashionRangeSeed;
  /** 物理防御区间 */
  physicalDefense: FashionRangeSeed;
  /** 魔法防御区间 */
  magicDefense: FashionRangeSeed;
  /** 道术防御区间 */
  taoistDefense: FashionRangeSeed;
}

/** 属性区间（与快照 / 管理端的 ConfigAttributeRange 同形） */
export interface FashionRangeSeed {
  min: number;
  max: number;
}

/**
 * 时装出厂行（20 套）
 *
 * 字段名与**快照下发的形状**一致（`inRes` / `outRes` / 区间 `{min,max}`），
 * 这样沙箱里 `applyFashionData(种子)` 与线上 `applyFashionData(快照)` 走的是同一条路，
 * 不需要任何「两种形状都认一下」的转换。
 *
 * 属性当前全部为 0 —— 时装在玩法上还没接入战斗属性结算，先留出列位，
 * 运营要卖属性时在管理端填，不用重打客户端包。
 */
export const FASHION_SEED_ROWS: FashionSeedRow[] = [
  {
    id: "cloth_2",
    label: "妖绯巫女",
    description: "白红相间的东瀛巫女装束，周身缠绕着妖异的紫雾，据说来自异国的神秘祭司。",
    icon: "clothes/icon/001",
    inRes: "clothes/in/001",
    outRes: "clothes/out/001",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_3",
    label: "金棒阔少",
    description: "金发紫衫的富家公子，扛着鎏金球棒、拎着漆皮宝箱，走路都带风。",
    icon: "clothes/icon/002",
    inRes: "clothes/in/002",
    outRes: "clothes/out/002",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_4",
    label: "绯樱刀姬",
    description: "白裙红缨的女武士，裙摆沾着不灭的火光，太刀出鞘时如樱花绽落。",
    icon: "clothes/icon/003",
    inRes: "clothes/in/003",
    outRes: "clothes/out/003",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_5",
    label: "熔岩魔躯",
    description: "由熔岩凝成的魔神之躯，金角獠牙、鬃毛流火，行走时大地都被烧红。",
    icon: "clothes/icon/004",
    inRes: "clothes/in/004",
    outRes: "clothes/out/004",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_6",
    label: "兽首金甲",
    description: "肩披兽首的金甲战袍，红披风猎猎作响，佩剑燃着熊熊烈焰。",
    icon: "clothes/icon/006",
    inRes: "clothes/in/006",
    outRes: "clothes/out/006",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_7",
    label: "双焰鬼将",
    description: "双手各持一把燃烧魔刀的鬼面战将，双翼喷焰，凶戾无比。",
    icon: "clothes/icon/007",
    inRes: "clothes/in/007",
    outRes: "clothes/out/007",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_8",
    label: "红金机甲",
    description: "传说从异世界掉落的钢铁战衣，胸口能量核心散发着幽蓝的光芒。",
    icon: "clothes/icon/008",
    inRes: "clothes/in/008",
    outRes: "clothes/out/008",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_9",
    label: "星盾卫士",
    description: "身披星条战衣，手持坚不可摧的圆盾，正义感满满的老兵。",
    icon: "clothes/icon/009",
    inRes: "clothes/in/009",
    outRes: "clothes/out/009",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_11",
    label: "黄金圣翼",
    description: "铺展开的金色羽翼如神明降世，金光所照之处皆成圣域。",
    icon: "clothes/icon/011",
    inRes: "clothes/in/011",
    outRes: "",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_12",
    label: "英伦军花",
    description: "笔挺军装的英气女官，站姿标准得像在阅兵场上。",
    icon: "clothes/icon/012",
    inRes: "",
    outRes: "clothes/out/012",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_13",
    label: "军装丽人",
    description: "与军花气质相仿的礼服军装，英姿飒爽，气度不凡。",
    icon: "clothes/icon/013",
    inRes: "",
    outRes: "clothes/out/013",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_16",
    label: "暗黑骨甲",
    description: "由魔兽骨壳拼成的黑甲，浑身上下唯一的亮光是一双幽蓝的眼睛。",
    icon: "clothes/icon/016",
    inRes: "clothes/in/016",
    outRes: "clothes/out/016",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_18",
    label: "烈焰神拳",
    description: "火神附体般的魁梧战躯，双拳燃着不灭之火，头顶金环流焰。",
    icon: "clothes/icon/018",
    inRes: "clothes/in/018",
    outRes: "clothes/out/018",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_19",
    label: "赤绒猫娘",
    description: "红衣猫耳少女，绒爪轻挥也能挠出漫天火花。",
    icon: "clothes/icon/019",
    inRes: "clothes/in/019",
    outRes: "clothes/out/019",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_20",
    label: "招财福猪",
    description: "圆滚滚的福猪财主，怀里抱着吃不完的包子，是财运的象征。",
    icon: "clothes/icon/020",
    inRes: "clothes/in/020",
    outRes: "clothes/out/020",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_22",
    label: "蓝雷甲士",
    description: "头生双角的铠甲武士，全身缠绕着蓝色雷霆，怒目如电。",
    icon: "clothes/icon/022",
    inRes: "clothes/in/022",
    outRes: "clothes/out/022",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_24",
    label: "月宫仙子",
    description: "月下起舞的仙子，紫纱罗裙随风而动，疑似月宫下凡。",
    icon: "clothes/icon/024",
    inRes: "clothes/in/024",
    outRes: "clothes/out/024",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_25",
    label: "金翎雀帝",
    description: "背后展开金焰雀羽的男人，传说是南方神鸟转世。",
    icon: "clothes/icon/025",
    inRes: "clothes/in/025",
    outRes: "clothes/out/025",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_27",
    label: "金龙帝袍",
    description: "金龙盘冠的帝王战袍，举手投足间尽显威仪，似有龙吟环绕。",
    icon: "clothes/icon/027",
    inRes: "clothes/in/027",
    outRes: "clothes/out/027",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
  {
    id: "cloth_28",
    label: "金身财神",
    description: "金甲加身的财神爷，周身落满金币与火光，见者发财。",
    icon: "clothes/icon/028",
    inRes: "clothes/in/028",
    outRes: "clothes/out/028",
    sellPrice: 0,
    maxHp: 0,
    hpRecover: 0,
    physicalAttack: { min: 0, max: 0 },
    magicAttack: { min: 0, max: 0 },
    taoistAttack: { min: 0, max: 0 },
    physicalDefense: { min: 0, max: 0 },
    magicDefense: { min: 0, max: 0 },
    taoistDefense: { min: 0, max: 0 },
  },
];
