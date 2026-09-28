import { Node, resources, TiledMap, TiledMapAsset, UITransform } from "cc";
import { loadResourcesAsync } from "../utils/ResourceLoad";

const GameMapUiHelper = {
  // 创建地图
  async createMap(name: string, src: string) {
    const node = new Node();
    node.name = "map";
    const tiledMap = node.addComponent(TiledMap);
    await loadResourcesAsync<TiledMapAsset>("map", src, TiledMapAsset).then((map) => {
      tiledMap.tmxAsset = map;
    });
    return node;
  },
};

export default GameMapUiHelper;
