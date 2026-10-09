import { Node, TiledMap } from "cc";

/**
 * Tiled 对象组读取（纯函数模块）
 * 把 TiledMap 对象组的原始记录收敛成统一的 TiledObject（坐标保持 Tiled 原样：
 * 原点在地图左上角、y 轴向下，换算交给 MapPointMath），并对"地图没画该对象组"做空安全处理。
 *
 * 两种读法，结果一致：
 * - readTiledObjects：从 TMX 原文（TiledMapAsset.tmxXmlStr）直接解析，
 *   不需要地图节点，因此**资源预加载阶段**（还没有地图节点）也能读出对象组里的 NPC / 怪物编号
 * - getTiledObjects：按地图节点取它的 TMX 原文后走同一套解析（游戏内生成对象时用）
 *
 * 为什么不用引擎解析出来的对象组：Tiled 给对象设置的 Class（1.9 之前叫 Type）导出为
 * <object> 标签上的 class/type 属性，而 Cocos 的 TMX 解析器只把自己的形状枚举
 * （RECT/POLYGON/...）写进 object.type，**对象类被整个丢弃**；另外 TiledObjectGroup._init
 * 会把 object.y 原地改写成「地图像素高 - y」（换成 y 轴向上），坐标也被翻过一次。
 * 直接读 TMX 原文则两者都是原值，无需再绕开引擎行为。
 */

/** 对象标签上承载「对象类」的属性名（Tiled 1.9+ 写 class，为兼容旧读法通常也写 type） */
const OBJECT_CLASS_ATTRIBUTES = ["class", "type"];

/** Tiled 对象（只保留地图生成器用到的字段） */
export interface TiledObject {
  /** 对象 id（Tiled 内全局唯一） */
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
  /** 自定义属性（Tiled 里给对象加的 properties，取值保持 TMX 原文的字符串） */
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

/** 读取对象标签上的对象类（class 优先，其次兼容旧写法的 type；都没写时为空串） */
function readObjectClass(attributes: string): string {
  for (const attribute of OBJECT_CLASS_ATTRIBUTES) {
    const objectClass = readXmlAttribute(attributes, attribute);
    if (objectClass) return objectClass;
  }
  return "";
}

/** 读取对象的自定义属性（值写在 value 属性里，或写在标签体内，两种 Tiled 写法都支持） */
function readObjectProperties(body: string): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const propertyPattern = /<property\b([^>]*?)(?:\/>|>([\s\S]*?)<\/property>)/g;
  let match: RegExpExecArray | null;
  while ((match = propertyPattern.exec(body))) {
    const name = readXmlAttribute(match[1], "name");
    if (!name) continue;
    const value = readXmlAttribute(match[1], "value");
    properties[name] = value || (match[2] ?? "").trim();
  }
  return properties;
}

/**
 * 从 TMX 原文读取对象组中的全部对象（不需要地图节点）
 * 地图没有该对象组时返回空数组，调用方不必自行判空
 * @param xml TMX 原文（TiledMapAsset.tmxXmlStr）
 * @param groupName 对象组名称
 */
export function readTiledObjects(xml: string, groupName: string): TiledObject[] {
  const groupXml = readObjectGroupXml(xml, groupName);
  if (!groupXml) return [];
  const objects: TiledObject[] = [];
  // 对象不嵌套：一个 <object> 的内容到它自己的 </object> 为止
  const openTagPattern = /<object\b([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = openTagPattern.exec(groupXml))) {
    const attributes = match[1];
    const id = readXmlAttribute(attributes, "id");
    if (!id) continue;
    const bodyStart = openTagPattern.lastIndex;
    const bodyEnd = match[2] === "/" ? bodyStart : groupXml.indexOf("</object>", bodyStart);
    const body = bodyEnd < 0 ? "" : groupXml.slice(bodyStart, bodyEnd);
    objects.push({
      id,
      name: readXmlAttribute(attributes, "name"),
      objectClass: readObjectClass(attributes),
      x: Number(readXmlAttribute(attributes, "x")) || 0,
      y: Number(readXmlAttribute(attributes, "y")) || 0,
      width: Number(readXmlAttribute(attributes, "width")) || 0,
      height: Number(readXmlAttribute(attributes, "height")) || 0,
      properties: readObjectProperties(body),
    });
    // 跳过已读过的对象体，避免把体里的标签误当对象
    if (bodyEnd > bodyStart) openTagPattern.lastIndex = bodyEnd;
  }
  return objects;
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
  return readTiledObjects(getTmxXml(map), groupName);
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

/**
 * 从 TMX 原文读取多个候选对象组中第一个有内容的组（预加载阶段用，不需要地图节点）
 */
export function readTiledObjectsFrom(xml: string, ...groupNames: string[]): TiledObject[] {
  for (const groupName of groupNames) {
    const objects = readTiledObjects(xml, groupName);
    if (objects.length) return objects;
  }
  return [];
}
