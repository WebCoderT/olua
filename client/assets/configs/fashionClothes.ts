/**
 * 时装配置表（#257 启用；#603 第十二域起**客户端零出厂数据**）
 *
 * ===========================================================================
 * #603 第十二域：数据搬走，取源规则留下
 * ===========================================================================
 * 名称 / 文案 / 图标 / 内观资源 / 外观资源 / 售卖价 / 八项属性加成的唯一书写处是
 * 服务端 `server/src/shared/fashion-seed.ts` → `fashions` 表（管理端「时装配置」可改）→
 * `GET /game-config` 快照的 `fashions` 段 → 这里整表重建（`applyFashionData`）。
 *
 * 留在本文件的是**取源规则**（外观优先时装、其次装备衣服、最后性别默认外观）与
 * 按 id 查询的几个函数 —— 那是玩法逻辑，不是运营数据。
 *
 * **客户端加载期 `fashionData` 是空的** —— 进游戏前时装弹窗里一套都没有不是 bug，
 * 那只是快照还没到。
 *
 * 资源路径为什么跟着行走：cloth_2 与 clothes/out/001 之间没有可推导的约定
 * （编号与 id 不连续，cloth_13 连内观图都没有），所以路径必须入库；
 * 而地图 `<id>/<id>`、特效 `effect/<key>/<key>.plist` 能按 id 推导，就不入库。
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
    hpRecover?: number;
    physicalAttack?: [number, number];
    magicAttack?: [number, number];
    taoistAttack?: [number, number];
    physicalDefense?: [number, number];
    magicDefense?: [number, number];
    taoistDefense?: [number, number];
  };
}

/** 协议里的区间是 `{min,max}` 对象（与装备 / 称号同一形状），客户端内部用 [min,max] 元组 */
export interface FashionRangeLike {
  min: number;
  max: number;
}

/** 服务端时装行（快照 `fashions` 段；与 `fashion-seed.ts` 的 `FashionSeedRow` 同源） */
export interface FashionSeedLike {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** 注意服务端字段名带 Res 后缀（inRes / outRes），客户端沿用 in / out */
  inRes: string;
  outRes: string;
  sellPrice: number;
  attributes: {
    maxHp?: number;
    hpRecover?: number;
    physicalAttack?: FashionRangeLike;
    magicAttack?: FashionRangeLike;
    taoistAttack?: FashionRangeLike;
    physicalDefense?: FashionRangeLike;
    magicDefense?: FashionRangeLike;
    taoistDefense?: FashionRangeLike;
  };
}

/** 时装运行时表（内容全部来自服务端；加载期为空） */
export const fashionData: FashionDataEntry[] = [];

/** 协议区间 → 客户端元组（缺省 = [0,0]；全 0 也要照写，运营可能就是把加成清零） */
function toRange(range: FashionRangeLike | undefined): [number, number] {
  return range ? [Number(range.min) || 0, Number(range.max) || 0] : [0, 0];
}

/**
 * 整表重建时装（#603 第十二域）
 *
 * **整表重建而不是覆写已有行**：客户端已经没有出厂行了，快照里没有的 id 客户端就不该有。
 * 数组是同一个引用（只 clear + push），弹窗 / 预载拿着的引用不变。
 */
export function applyFashionData(rows: FashionSeedLike[]): void {
  fashionData.length = 0;
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id) continue;
    const source = row.attributes ?? {};
    fashionData.push({
      id: row.id,
      label: String(row.label ?? ""),
      description: String(row.description ?? ""),
      icon: String(row.icon ?? ""),
      in: String(row.inRes ?? ""),
      out: String(row.outRes ?? ""),
      sellPrice: Number(row.sellPrice) || 0,
      attributes: {
        maxHp: Number(source.maxHp) || 0,
        hpRecover: Number(source.hpRecover) || 0,
        physicalAttack: toRange(source.physicalAttack),
        magicAttack: toRange(source.magicAttack),
        taoistAttack: toRange(source.taoistAttack),
        physicalDefense: toRange(source.physicalDefense),
        magicDefense: toRange(source.magicDefense),
        taoistDefense: toRange(source.taoistDefense),
      },
    });
  }
}

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
