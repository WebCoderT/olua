import { Node, Size, Vec3 } from "cc";
import { debugConfig } from "../../../configs/debug";
import { monsters } from "../../../configs/monster";
import { MonsterSpawnArea } from "../../../types/monster";
import LayerManager from "../../core/LayerManager";
import MonsterManager from "../../core/MonsterManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import { getMapRectCenterPositionOnWorld } from "../../utils/map/MapPointMath";
import { getTiledObjects, TiledObject } from "../../utils/map/TiledObjects";

/**
 * 刷怪区域生成器
 * 读取 TiledMap 中名为 monster 的对象组，把其中每个矩形区域解析成刷怪区域
 * （自定义属性 id = 怪物编号、min/max = 该区域允许的最少/最多怪物数）并整体交给 MonsterManager：
 * 区域内的初始怪物由 MonsterManager 按区域一次性生成（怪物数据与节点统一由它管理），
 * 本类只负责「地图数据 -> 区域描述」的翻译与区域范围（调试）显示
 * 区域中心由 MapPointMath 换算成世界坐标（怪物节点用世界坐标定位），本类不自行翻转 y
 * 地图坐标换算依赖地图节点本身，因此构造时注入地图节点
 */
export default class MonsterAreaSpawner {
  /** 刷怪区域对象组名称 */
  private static readonly GROUP_NAME = "monster";

  /** 自定义属性名：怪物编号 */
  private static readonly PROPERTY_MONSTER_ID = "id";
  /** 自定义属性名：区域允许的最少怪物数 */
  private static readonly PROPERTY_MIN = "min";
  /** 自定义属性名：区域允许的最多怪物数 */
  private static readonly PROPERTY_MAX = "max";

  /** 地图节点（自身即地图，坐标换算需要） */
  private map: Node;

  constructor(map: Node) {
    this.map = map;
  }

  /** 解析并注册全部刷怪区域（地图没有该对象组时得到空数组，怪物层保持为空） */
  spawnAll() {
    const areas = getTiledObjects(this.map, MonsterAreaSpawner.GROUP_NAME)
      .map((object) => this.createArea(object))
      .filter((area): area is MonsterSpawnArea => area !== null);
    MonsterManager.spawnByAreas(areas);
  }

  /** 解析单个区域（点位、多边形、缺属性、怪物编号无配置等无效区域返回 null 并给出提示） */
  private createArea(object: TiledObject): MonsterSpawnArea | null {
    // 没有面积的元素（点、多边形）没有落点范围，无法刷怪
    if (object.width <= 0 || object.height <= 0) {
      console.warn(`[MonsterAreaSpawner] 区域「${object.name}」不是矩形，没有落点范围，已跳过`);
      return null;
    }
    const monsterId = `${object.properties[MonsterAreaSpawner.PROPERTY_MONSTER_ID] ?? ""}`;
    if (!monsterId) {
      console.warn(`[MonsterAreaSpawner] 区域「${object.name}」缺少 id 属性，已跳过`);
      return null;
    }
    if (!monsters.has(monsterId)) {
      console.warn(`[MonsterAreaSpawner] 区域「${object.name}」的怪物编号 ${monsterId} 没有对应的怪物配置，已跳过`);
      return null;
    }
    const min = Math.max(0, this.readNumber(object, MonsterAreaSpawner.PROPERTY_MIN, 0));
    let max = this.readNumber(object, MonsterAreaSpawner.PROPERTY_MAX, 0);
    if (max < min) {
      console.warn(`[MonsterAreaSpawner] 区域「${object.name}」的 max(${max}) 小于 min(${min})，已按 min 处理`);
      max = min;
    }
    const size = new Size(object.width, object.height);
    const center = getMapRectCenterPositionOnWorld(object.x, object.y, size.width, size.height, this.map);
    this.createAreaView(object.name, size, center, monsterId, min, max);
    return { label: object.name, monsterId, center, size, min, max };
  }

  /** 读取自定义属性为整数（缺失或非法时取 fallback） */
  private readNumber(object: TiledObject, property: string, fallback: number) {
    const value = Number(object.properties[property]);
    return Number.isFinite(value) ? Math.floor(value) : fallback;
  }

  /** 创建刷怪区域的可视化节点（仅调试期创建，由 debugConfig.areaRange 控制） */
  private createAreaView(label: string, size: Size, center: Vec3, monsterId: string, min: number, max: number) {
    if (!debugConfig.areaRange) return;
    const node = GameUiHelper.createMonsterAreaNode(label, size);
    LayerManager.addToMapLayer(node);
    node.setWorldPosition(center);
    GameUiHelper.showAreaRange(node, `${label} id=${monsterId} ${min}~${max}`);
  }
}
