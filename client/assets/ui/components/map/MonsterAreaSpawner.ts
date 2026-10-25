import { Node, Size, Vec3 } from "cc";
import { debugConfig } from "../../../configs/debug";
import { tiledGroupNames, tiledPropertyNames } from "../../../configs/map";
import { monsters } from "../../../configs/monster";
import { MonsterSpawnArea } from "../../../types/monster";
import LayerManager from "../../core/LayerManager";
import MonsterManager from "../../core/MonsterManager";
import GameUiHelper from "../../helpers/GameUiHelper";
import CombatChannel from "../../utils/net/CombatChannel";
import { getMapRectCenterPositionOnWorld } from "../../utils/map/MapPointMath";
import { getTiledObjects, TiledObject } from "../../utils/map/TiledObjects";

/**
 * 刷怪区域生成器
 * 读取 TiledMap 中名为 monster 的对象组，把其中每个矩形区域解析成刷怪区域
 * （自定义属性 id = 怪物编号、min/max = 该区域允许的最少/最多怪物数）：
 *
 * - 世界权威（#35 + #295 阶段一）：刷怪区配置已从 Tiled 导入服务端（map_spawn_areas），
 *   进图只发 worldJoin（仅地图 id），播种完全由服务端按区域随机落点完成；
 *   权威快照（实例 id / 血量 / 存活）由 world 帧回来后经 MonsterManager.applyWorldState 落场；
 *   死亡后的重生由服务端 tick 驱动并广播；
 * - 本类保留 Tiled 解析，只服务两件事：调试期的区域可视化（debugConfig.areaRange）、
 *   以及通道不可用时的本地回滚路径（照旧由 MonsterManager 按区域一次性生成、不刷新）。
 *
 * 区域中心由 MapPointMath 换算成世界坐标（怪物节点用世界坐标定位），本类不自行翻转 y
 * 地图坐标换算依赖地图节点本身，因此构造时注入地图节点与地图 id（worldJoin 要用）
 */
export default class MonsterAreaSpawner {
  /** 地图节点（自身即地图，坐标换算需要） */
  private map: Node;
  /** 地图 id（configs/map 的 key；进图播种的 worldJoin 带它） */
  private mapId: string;

  constructor(map: Node, mapId: string) {
    this.map = map;
    this.mapId = mapId;
  }

  /** 解析刷怪区域（地图没有该对象组时得到空数组）：世界在线只报图 id；通道不可用才本地生成 */
  spawnAll() {
    const areas = getTiledObjects(this.map, tiledGroupNames.monster)
      .map((object) => this.createArea(object))
      .filter((area): area is MonsterSpawnArea => area !== null);
    if (CombatChannel.active) {
      // 世界权威（#295 阶段一）：刷怪区配置在服务端库里（从 Tiled 导入一次），
      // 实例的身份 / 血量 / 存活 / 出生点全部以服务端 world 帧为准 —— 这里只报地图 id。
      // areas 仍然解析：调试区域可视化在 createArea 里顺带完成。
      CombatChannel.sendWorldJoin(this.mapId);
      return;
    }
    // 回滚路径：与上移前同一套本地生成
    MonsterManager.spawnByAreas(areas);
  }

  /** 解析单个区域（点位、多边形、缺属性、怪物编号无配置等无效区域返回 null 并给出提示） */
  private createArea(object: TiledObject): MonsterSpawnArea | null {
    // 没有面积的元素（点、多边形）没有落点范围，无法刷怪
    if (object.width <= 0 || object.height <= 0) {
      console.warn(`[MonsterAreaSpawner] 区域「${object.name}」不是矩形，没有落点范围，已跳过`);
      return null;
    }
    const monsterId = `${object.properties[tiledPropertyNames.id] ?? ""}`;
    if (!monsterId) {
      console.warn(`[MonsterAreaSpawner] 区域「${object.name}」缺少 id 属性，已跳过`);
      return null;
    }
    if (!monsters.has(monsterId)) {
      console.warn(`[MonsterAreaSpawner] 区域「${object.name}」的怪物编号 ${monsterId} 没有对应的怪物配置，已跳过`);
      return null;
    }
    const min = Math.max(0, this.readNumber(object, tiledPropertyNames.min, 0));
    let max = this.readNumber(object, tiledPropertyNames.max, 0);
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
