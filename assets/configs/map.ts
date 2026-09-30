import { MapConfig, MapId, MapType } from "../types/map";

export const maps = new Map<MapId, MapConfig>();

maps.set("0", { label: "第一大陆", src: "map/0", type: MapType.NORMAL, level: 0, combat: 0, soulOfWar: 0 });
maps.set("1", { label: "新手地图", src: "map/1", type: MapType.LEVEL, level: 0, combat: 0, soulOfWar: 0 });
maps.set("2", { label: "10级地图", src: "map/2", type: MapType.LEVEL, level: 10, combat: 0, soulOfWar: 0 });
