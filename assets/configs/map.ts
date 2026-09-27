import { MapConfig, MapId } from "../types/common";

export const maps = new Map<MapId, MapConfig>();

maps.set("0", { label: "第一大陆", src: "map/0" });
