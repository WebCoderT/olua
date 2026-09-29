import { Node, TiledMap, Vec2, Vec3, view } from "cc";

// 获取地图上尺寸偏移
export function getMapOffset(map: TiledMap) {
  const width = map.getMapSize().width * map.getTileSize().width;
  const screenWidth = view.getDesignResolutionSize().width;
  return new Vec3((width - screenWidth) / 2, 0);
}

// 获取地图上点的坐标，归一化处理
export function getMapPointPositionOnWorld(position: Vec3, map: Node) {
  const tiledMap = map.getComponent(TiledMap);
  const height = tiledMap.getMapSize().height * tiledMap.getTileSize().height;
  const width = tiledMap.getMapSize().width * tiledMap.getTileSize().width;
  const mapWorldPosition = map.getWorldPosition();
  return new Vec3(position.x - width / 2 + mapWorldPosition.x, position.y - height / 2 + mapWorldPosition.y);
}

// 获取地图上点的坐标
export function getMapPointPosition(position: Vec3, map: Node) {
  const tiledMap = map.getComponent(TiledMap);
  const height = tiledMap.getMapSize().height * tiledMap.getTileSize().height;
  const width = tiledMap.getMapSize().width * tiledMap.getTileSize().width;
  return new Vec3(position.x - width / 2, position.y - height / 2);
}
