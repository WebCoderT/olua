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
 * - 世界权威（#35）：把解析出的刷怪计划（每区域 max 只、区域内随机落点）经 CombatChannel
 *   发 worldJoin 播种，权威快照（实例 id / 血量 / 存活）由 world 帧回来后经
 *   MonsterManager.applyWorldState 落场；死亡后的重生由服务端 tick 驱动并广播；
 * - 回滚路径（通道不可用）：照旧由 MonsterManager 按区域一次性生成、不刷新。
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

  /** 解析并注册全部刷怪区域（地图没有该对象组时得到空数组，怪物层保持为空） */
  spawnAll() {
    const areas = getTiledObjects(this.map, tiledGroupNames.monster)
      .map((object) => this.createArea(object))
      .filter((area): area is MonsterSpawnArea => area !== null);
    if (CombatChannel.active) {
      // 世界权威：客户端只贡献「哪里刷、刷几只」的播种计划（区域配置在 Tiled 里，服务端拿不到），
      // 实例的身份 / 血量 / 存活以服务端 world 帧为准（已有实例的图整份沿用，plan 被忽略）
      CombatChannel.sendWorldJoin(this.mapId, this.buildSpawnPlan(areas));
      return;
    }
    // 回滚路径：与上移前同一套本地生成
    MonsterManager.spawnByAreas(areas);
  }

  /** 把刷怪区域展开成播种计划：每区域按 max 在矩形内随机落点，一条一只 */
  private buildSpawnPlan(areas: MonsterSpawnArea[]) {
    const plan: Array<{ monsterKey: string; x: number; y: number }> = [];
    areas.forEach((area) => {
      for (let index = 0; index < area.max; index++) {
        const position = this.getRandomAreaPosition(area);
        plan.push({ monsterKey: area.monsterId, x: position.x, y: position.y });
      }
    });
    return plan;
  }

  /** 取区域内随机一点的坐标（地图节点未旋转缩放，在区域矩形内均匀取值即可） */
  private getRandomAreaPosition(area: MonsterSpawnArea) {
    const { center, size } = area;
    return new Vec3(center.x + (Math.random() - 0.5) * size.width, center.y + (Math.random() - 0.5) * size.height);
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
