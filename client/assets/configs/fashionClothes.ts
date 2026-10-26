/**
 * 时装配置表（#257 启用）
 *
 * 历史状态：本文件曾整份被注释（零导出、零消费方），#257 恢复为
 * **纯数据文件** —— 工具链 `tools/gen-shared-data.cjs` 要在 Node 垫片里编译加载
 * 本文件给三端生成公共数据快照（FASHION），所以这里只有数据、没有任何引擎依赖。
 *
 * 原注释数据里的表现层参数**全部是常量**（level=1 / sex=ALL / occupation=ALL /
 * sellPirce=0 / maxHp=0 / 六项攻防区间全 [0,0] / inPosition=(0,0) / outScale=1 /
 * outPositions 八向 (7.3,34.2) / tags 与 prefix、suffix 为空），未随恢复保留 ——
 * 等客户端时装穿戴功能落地时再按需恢复（原注释在 git 历史）。
 *
 * 可选字段：in / out 是内观 / 外观资源路径（resources 相对路径，空串 = 无）；
 * sellPrice 与 attributes（maxHp + 六项区间）当前全部缺省（= 0），管理端
 * 「时装配置」可改，未来客户端需要非零值时在这里补数据后重新生成。
 */
export interface FashionDataEntry {
  /** 时装 id（如 cloth_2；fashions 表主键，序列固定不可增删） */
  id: string;
  label: string;
  description: string;
  /** 图标资源路径（resources 相对路径，如 clothes/icon/001） */
  icon: string;
  /** 内观资源路径（空串 = 无） */
  in?: string;
  /** 外观资源路径（空串 = 无） */
  out?: string;
  /** 售卖价（原配置字段名 sellPirce，这里用正确拼写；缺省 0） */
  sellPrice?: number;
  /** 战斗属性加成（缺省全 0） */
  attributes?: {
    maxHp?: number;
    physicalAttack?: [number, number];
    magicAttack?: [number, number];
    taoistAttack?: [number, number];
    physicalDefense?: [number, number];
    magicDefense?: [number, number];
    taoistDefense?: [number, number];
  };
}

export const fashionData: FashionDataEntry[] = [
  {
    id: "cloth_2",
    label: "妖绯巫女",
    description: "白红相间的东瀛巫女装束，周身缠绕着妖异的紫雾，据说来自异国的神秘祭司。",
    icon: "clothes/icon/001",
    in: "clothes/in/001",
    out: "clothes/out/001",
  },
  {
    id: "cloth_3",
    label: "金棒阔少",
    description: "金发紫衫的富家公子，扛着鎏金球棒、拎着漆皮宝箱，走路都带风。",
    icon: "clothes/icon/002",
    in: "clothes/in/002",
    out: "clothes/out/002",
  },
  {
    id: "cloth_4",
    label: "绯樱刀姬",
    description: "白裙红缨的女武士，裙摆沾着不灭的火光，太刀出鞘时如樱花绽落。",
    icon: "clothes/icon/003",
    in: "clothes/in/003",
    out: "clothes/out/003",
  },
  {
    id: "cloth_5",
    label: "熔岩魔躯",
    description: "由熔岩凝成的魔神之躯，金角獠牙、鬃毛流火，行走时大地都被烧红。",
    icon: "clothes/icon/004",
    in: "clothes/in/004",
    out: "clothes/out/004",
  },
  {
    id: "cloth_6",
    label: "兽首金甲",
    description: "肩披兽首的金甲战袍，红披风猎猎作响，佩剑燃着熊熊烈焰。",
    icon: "clothes/icon/006",
    in: "clothes/in/006",
    out: "clothes/out/006",
  },
  {
    id: "cloth_7",
    label: "双焰鬼将",
    description: "双手各持一把燃烧魔刀的鬼面战将，双翼喷焰，凶戾无比。",
    icon: "clothes/icon/007",
    in: "clothes/in/007",
    out: "clothes/out/007",
  },
  {
    id: "cloth_8",
    label: "红金机甲",
    description: "传说从异世界掉落的钢铁战衣，胸口能量核心散发着幽蓝的光芒。",
    icon: "clothes/icon/008",
    in: "clothes/in/008",
    out: "clothes/out/008",
  },
  {
    id: "cloth_9",
    label: "星盾卫士",
    description: "身披星条战衣，手持坚不可摧的圆盾，正义感满满的老兵。",
    icon: "clothes/icon/009",
    in: "clothes/in/009",
    out: "clothes/out/009",
  },
  {
    id: "cloth_11",
    label: "黄金圣翼",
    description: "铺展开的金色羽翼如神明降世，金光所照之处皆成圣域。",
    icon: "clothes/icon/011",
    in: "clothes/in/011",
    out: "",
  },
  {
    id: "cloth_12",
    label: "英伦军花",
    description: "笔挺军装的英气女官，站姿标准得像在阅兵场上。",
    icon: "clothes/icon/012",
    in: "",
    out: "clothes/out/012",
  },
  {
    id: "cloth_13",
    label: "军装丽人",
    description: "与军花气质相仿的礼服军装，英姿飒爽，气度不凡。",
    icon: "clothes/icon/013",
    in: "",
    out: "clothes/out/013",
  },
  {
    id: "cloth_16",
    label: "暗黑骨甲",
    description: "由魔兽骨壳拼成的黑甲，浑身上下唯一的亮光是一双幽蓝的眼睛。",
    icon: "clothes/icon/016",
    in: "clothes/in/016",
    out: "clothes/out/016",
  },
  {
    id: "cloth_18",
    label: "烈焰神拳",
    description: "火神附体般的魁梧战躯，双拳燃着不灭之火，头顶金环流焰。",
    icon: "clothes/icon/018",
    in: "clothes/in/018",
    out: "clothes/out/018",
  },
  {
    id: "cloth_19",
    label: "赤绒猫娘",
    description: "红衣猫耳少女，绒爪轻挥也能挠出漫天火花。",
    icon: "clothes/icon/019",
    in: "clothes/in/019",
    out: "clothes/out/019",
  },
  {
    id: "cloth_20",
    label: "招财福猪",
    description: "圆滚滚的福猪财主，怀里抱着吃不完的包子，是财运的象征。",
    icon: "clothes/icon/020",
    in: "clothes/in/020",
    out: "clothes/out/020",
  },
  {
    id: "cloth_22",
    label: "蓝雷甲士",
    description: "头生双角的铠甲武士，全身缠绕着蓝色雷霆，怒目如电。",
    icon: "clothes/icon/022",
    in: "clothes/in/022",
    out: "clothes/out/022",
  },
  {
    id: "cloth_24",
    label: "月宫仙子",
    description: "月下起舞的仙子，紫纱罗裙随风而动，疑似月宫下凡。",
    icon: "clothes/icon/024",
    in: "clothes/in/024",
    out: "clothes/out/024",
  },
  {
    id: "cloth_25",
    label: "金翎雀帝",
    description: "背后展开金焰雀羽的男人，传说是南方神鸟转世。",
    icon: "clothes/icon/025",
    in: "clothes/in/025",
    out: "clothes/out/025",
  },
  {
    id: "cloth_27",
    label: "金龙帝袍",
    description: "金龙盘冠的帝王战袍，举手投足间尽显威仪，似有龙吟环绕。",
    icon: "clothes/icon/027",
    in: "clothes/in/027",
    out: "clothes/out/027",
  },
  {
    id: "cloth_28",
    label: "金身财神",
    description: "金甲加身的财神爷，周身落满金币与火光，见者发财。",
    icon: "clothes/icon/028",
    in: "clothes/in/028",
    out: "clothes/out/028",
  },
];

//#region 读取（#377 穿戴系统：外观取源规则只在这里写一遍）

/** 按 id 取时装（无此 id 返回 null） */
export function getFashion(id: string | null | undefined): FashionDataEntry | null {
  if (!id) return null;
  return fashionData.find((fashion) => fashion.id === id) ?? null;
}

/**
 * 时装的**外观**帧目录（没穿时装 / 该时装没有外观资源 → null）
 *
 * 取源优先级：**时装 > 装备衣服 > 该性别默认外观**。场景里的主角（RoleAppearance）、
 * 进图预载（PreloadManager）都走这一条，别各自判一遍 —— 三处口径不一致会变成
 * 「弹窗里换了衣服、地图上还是旧的」或者「预载漏了、进图第一帧空着」。
 */
export function getFashionOut(id: string | null | undefined): string | null {
  return getFashion(id)?.out || null;
}

/** 时装的内观资源（没穿 / 该时装没有内观 → null，调用方回落到装备内观） */
export function getFashionIn(id: string | null | undefined): string | null {
  return getFashion(id)?.in || null;
}

//#endregion
