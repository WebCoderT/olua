import { MapConfig, MapId, MapType } from "../types/common";

export const maps = new Map<MapId, MapConfig>();

maps.set("0", { label: "第一大陆", src: "map/0", type: MapType.SAFE });
maps.set("1", { label: "技能测试场景", src: "map/1", type: MapType.TEST });
