/** @generated 由 tools/import-spawn-areas.cjs 从客户端 Tiled 地图（client/assets/resources/map 目录）的 monster 对象组生成，勿手改（#295）
 *  坐标口径 = 客户端世界坐标（地图节点在原点）：cx/cy 是区域中心、w/h 是区域尺寸，
 *  服务端随机落点公式与客户端旧版 MonsterAreaSpawner 完全一致。
 *  min/max = 该区域允许的最少/最多怪物数（播种按 max 展开成逐只落点）。
 */
export interface SpawnAreaConfig {
  /** 区域名（Tiled 对象名，如「1号怪物」） */
  name: string;
  /** 怪物 key（configs/monster 的关联键；播种时对照 monsters 表，不认识的跳过） */
  monsterKey: string;
  min: number;
  max: number;
  /** 区域中心 x（世界坐标） */
  cx: number;
  /** 区域中心 y（世界坐标） */
  cy: number;
  /** 区域宽 */
  w: number;
  /** 区域高 */
  h: number;
}

/** mapId → 该图的刷怪区域列表 */
export const SPAWN_AREAS: Record<string, SpawnAreaConfig[]> = {
  "0": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 10, cx: -2880, cy: 1216, w: 1664, h: 1664 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 10, cx: 2432, cy: 512, w: 2304, h: 1536 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: -2368, cy: -576, w: 2688, h: 1152 },
  ],
  "1": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 6, cx: -128, cy: 3392, w: 5888, h: 896 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 6, cx: 2432, cy: -3456, w: 2816, h: 768 },
  ],
  "2": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 10, cx: -3456, cy: 0, w: 768, h: 4096 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 10, cx: 3456, cy: 0, w: 768, h: 4096 },
  ],
  "3": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: -2676.62, cy: 2985.53, w: 2304, h: 1536 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: 26.18, cy: 3122.06, w: 2048, h: 1449.53 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: 2764.76, cy: 2949.65, w: 2048, h: 1792 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 8, cx: -2962.17, cy: 984.72, w: 1792, h: 1792 },
    { name: "5号怪物", monsterKey: "5", min: 0, max: 10, cx: -1062.89, cy: 1632.76, w: 2304, h: 1223.11 },
    { name: "BOSS200", monsterKey: "200", min: 0, max: 1, cx: 3254.72, cy: -759.59, w: 1536, h: 1536 },
    { name: "6号怪物", monsterKey: "6", min: 0, max: 10, cx: 1413.36, cy: 1969.45, w: 2304, h: 1223.11 },
    { name: "8号怪物", monsterKey: "8", min: 0, max: 10, cx: 1713.32, cy: -81.68, w: 2304, h: 1223.11 },
    { name: "7号怪物", monsterKey: "7", min: 0, max: 10, cx: 2770.87, cy: 825.78, w: 2304, h: 1223.11 },
    { name: "10号怪物", monsterKey: "10", min: 0, max: 10, cx: -2756.35, cy: -1241.99, w: 2304, h: 1223.11 },
    { name: "9号怪物", monsterKey: "9", min: 0, max: 10, cx: -1643.96, cy: -29.55, w: 2304, h: 1223.11 },
    { name: "11号怪物", monsterKey: "11", min: 0, max: 10, cx: -331.83, cy: -1374.89, w: 2304, h: 1223.11 },
    { name: "12号怪物", monsterKey: "12", min: 0, max: 10, cx: 1995.69, cy: -1380, w: 2304, h: 1223.11 },
    { name: "13号怪物", monsterKey: "13", min: 0, max: 10, cx: -2752, cy: -2671.99, w: 2304, h: 1223.11 },
    { name: "14号怪物", monsterKey: "14", min: 0, max: 10, cx: -288, cy: -2751.99, w: 2304, h: 1223.11 },
    { name: "15号怪物", monsterKey: "15", min: 0, max: 10, cx: 2144, cy: -2767.99, w: 2304, h: 1223.11 },
    { name: "BOSS201", monsterKey: "201", min: 0, max: 1, cx: 3184, cy: 1824, w: 1536, h: 1536 },
    { name: "BOSS202", monsterKey: "202", min: 0, max: 1, cx: -1728, cy: -720, w: 1536, h: 1536 },
  ],
  "4": [
    { name: "30号怪物", monsterKey: "30", min: 0, max: 30, cx: -2656, cy: 1632, w: 1792, h: 1536 },
    { name: "32号怪物", monsterKey: "32", min: 0, max: 40, cx: -784, cy: 1216, w: 1536, h: 1792 },
    { name: "33号怪物", monsterKey: "33", min: 0, max: 30, cx: -2032, cy: 560, w: 1792, h: 1024 },
    { name: "31号怪物", monsterKey: "31", min: 0, max: 30, cx: -2528, cy: 3040, w: 2048, h: 1024 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 3056, cy: 3232, w: 1536, h: 1024 },
    { name: "34号怪物", monsterKey: "34", min: 0, max: 30, cx: -2544, cy: 192, w: 1792, h: 1024 },
    { name: "35号怪物", monsterKey: "35", min: 0, max: 30, cx: -416, cy: 3120, w: 1792, h: 1024 },
  ],
  "5": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: -2304, cy: 2432, w: 2048, h: 1792 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: 2432, cy: 2304, w: 1792, h: 1536 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: -2432, cy: -2432, w: 1792, h: 1792 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 8, cx: -128, cy: -512, w: 1792, h: 1536 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: -1536, cy: 1920, w: 1536, h: 1280 },
  ],
  "6": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: -2432, cy: -128, w: 1792, h: 1792 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: 2560, cy: 128, w: 1536, h: 1792 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: 128, cy: -2944, w: 2304, h: 1280 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 10, cx: 2432, cy: 2304, w: 1792, h: 1536 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 512, cy: 768, w: 1792, h: 1280 },
  ],
  "7": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: -2304, cy: 2304, w: 2048, h: 1536 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: 2432, cy: 2048, w: 1792, h: 1536 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: -2304, cy: -2304, w: 2048, h: 1536 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 10, cx: 2432, cy: -2560, w: 1792, h: 1536 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 0, cy: 0, w: 1536, h: 1536 },
  ],
  "8": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: -2944, cy: 2176, w: 1280, h: 1792 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: -896, cy: 2560, w: 1280, h: 1536 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: 1152, cy: 2176, w: 1280, h: 1792 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 8, cx: 3200, cy: 640, w: 1280, h: 1792 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 0, cy: -2304, w: 2048, h: 1536 },
  ],
  "9": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: -2432, cy: 2432, w: 1792, h: 1792 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: 2432, cy: 2304, w: 1792, h: 1536 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: -2432, cy: -2432, w: 1792, h: 1792 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 8, cx: 2432, cy: -512, w: 1792, h: 1536 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: -512, cy: 2432, w: 1536, h: 1280 },
  ],
  "10": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 6, cx: -2432, cy: 2304, w: 1792, h: 1536 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 6, cx: 2432, cy: 2688, w: 1792, h: 1280 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 6, cx: -2560, cy: -2688, w: 1536, h: 1280 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 6, cx: 2560, cy: -2944, w: 1536, h: 1280 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 0, cy: -384, w: 1536, h: 1280 },
  ],
};
