import { Node, TiledMap } from "cc";

/**
 * Tiled 对象组读取（纯函数模块）
 * 把 TiledMap 对象组的原始记录收敛成统一的 TiledObject（坐标保持 Tiled 原样：
 * 原点在地图左上角、y 轴向下，换算交给 MapPointMath），并对"地图没画该对象组"做空安全处理。
 *
 * 两个必须绕开的引擎行为：
 * 1. 「对象类」：Tiled 给对象设置的 Class（1.9 之前称为 Type）导出为 <object> 标签上的
 *    class/type 属性，而 Cocos 的 TMX 解析器只把自己的形状枚举（RECT/POLYGON/...）写进
 *    object.type，**对象类被整个丢弃**。因此这里从 TiledMapAsset.tmxXmlStr（编辑器导入时
 *    原样保留的 TMX 文本）里读出对象类，再按对象 id 合并回引擎的解析结果。
 * 2. 「y 轴」：TiledObjectGroup._init 会把 object.y 原地改写成「地图像素高 - y」，
 *    getObjects() 给到的是改写后的值；原始 Tiled 坐标只留在 object.offset 里，见 getTiledObjects。
 */

/** 对象标签上承载「对象类」的属性名（Tiled 1.9+ 写 class，为兼容旧读法通常也写 type） */
const OBJECT_CLASS_ATTRIBUTES = ["class", "type"];

/** Tiled 对象（只保留地图生成器用到的字段） */
export interface TiledObject {
  /** 对象 id（Tiled 内全局唯一，用于把 TMX 原文里的对象类合并回来） */
  id: string;
  /** 对象名称（Tiled 里给点位起的名字） */
  name: string;
  /** 对象类（Tiled 的 Class 字段，如 npc / revive；未设置时为空串） */
  objectClass: string;
  /** 对象 x（Tiled 坐标） */
  x: number;
  /** 对象 y（Tiled 坐标，y 轴向下） */
  y: number;
  /** 对象宽（点对象为 0） */
  width: number;
  /** 对象高（点对象为 0） */
  height: number;
  /** 自定义属性（Tiled 里给对象加的 properties） */
  properties: Record<string, unknown>;
}

/** 读取 XML 标签的属性值（属性名前要求空白或开头，避免命中 xxxname 这类后缀同名的属性） */
function readXmlAttribute(attributes: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attributes);
  return match ? match[1] : "";
}

/** 取某个对象组在 TMX 原文里的内容片段（对象组不嵌套，其后最近的 </objectgroup> 即为其结束） */
function readObjectGroupXml(xml: string, groupName: string): string {
  const openTagPattern = /<objectgroup\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = openTagPattern.exec(xml))) {
    const attributes = match[1];
    // 自闭合的空对象组没有内容
    if (/\/\s*$/.test(attributes)) continue;
    if (readXmlAttribute(attributes, "name") !== groupName) continue;
    const contentStart = match.index + match[0].length;
    const contentEnd = xml.indexOf("</objectgroup>", contentStart);
    return contentEnd < 0 ? "" : xml.slice(contentStart, contentEnd);
  }
  return "";
}

/**
 * 读取对象组里每个对象的对象类（键为对象 id，未设类的对象不进入结果）
 * 注意：<objectgroup> 不会命中 <object\b（o 后面是 g，构不成单词边界）
 */
function readObjectClasses(groupXml: string): Map<string, string> {
  const classes = new Map<string, string>();
  const objectPattern = /<object\b([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = objectPattern.exec(groupXml))) {
    const attributes = match[1];
    const id = readXmlAttribute(attributes, "id");
    if (!id) continue;
    for (const attribute of OBJECT_CLASS_ATTRIBUTES) {
      const objectClass = readXmlAttribute(attributes, attribute);
      if (objectClass) {
        classes.set(id, objectClass);
        break;
      }
    }
  }
  return classes;
}

/** 取地图的 TMX 原文（编辑器导入时原样保留，运行时可读） */
function getTmxXml(map: Node): string {
  const tiledMap = map.getComponent(TiledMap);
  return tiledMap && tiledMap.tmxAsset ? tiledMap.tmxAsset.tmxXmlStr : "";
}

/**
 * 读取 TiledMap 对象组中的全部对象
 * 地图没有画该对象组时返回空数组，调用方不必自行判空
 * @param map 地图节点（自身挂有 TiledMap 组件）
 * @param groupName 对象组名称
 */
export function getTiledObjects(map: Node, groupName: string): TiledObject[] {
  const group = map.getComponent(TiledMap).getObjectGroup(groupName);
  if (!group) return [];
  const classes = readObjectClasses(readObjectGroupXml(getTmxXml(map), groupName));
  return group.getObjects().map((object) => {
    const id = `${object.id ?? ""}`;
    // 注意：引擎在 TiledObjectGroup._init 里会把 object.y 原地改写成「地图像素高 - y」
    // （换成 y 轴向上），并在改写前把 Tiled 原始坐标存进 object.offset（同一循环里赋值，
    // 二者必然同时存在）；可读到的对象组一定已执行过 _init，故这里优先取 offset，
    // 保证对外给出的坐标始终是 Tiled 原始值（原点左上、y 轴向下），与 MapPointMath 的约定一致
    const tiled = object.offset ?? object;
    return {
      id,
      name: object.name ?? "",
      objectClass: classes.get(id) ?? "",
      x: tiled.x,
      y: tiled.y,
      width: object.width ?? 0,
      height: object.height ?? 0,
      properties: (object.properties ?? {}) as Record<string, unknown>,
    };
  });
}

/**
 * 读取多个候选对象组中第一个有内容的组（兼容同名不同叫法的地图）
 * 从前往后取第一个非空结果，全部为空时返回空数组
 */
export function getTiledObjectsFrom(map: Node, ...groupNames: string[]): TiledObject[] {
  for (const groupName of groupNames) {
    const objects = getTiledObjects(map, groupName);
    if (objects.length) return objects;
  }
  return [];
}
