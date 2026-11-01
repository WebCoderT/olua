/** @generated 由 tools/import-spawn-areas.cjs 从客户端 Tiled 地图（client/assets/resources/map 目录）的 monster 对象组生成，勿手改（#295）
 *  坐标口径 = 客户端世界坐标（#566：地图节点原点在左上角、y 轴向上）：
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
    { name: "1号怪物", monsterKey: "1", min: 0, max: 10, cx: 1216, cy: -2880, w: 1664, h: 1664 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 10, cx: 6528, cy: -3584, w: 2304, h: 1536 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: 1728, cy: -4672, w: 2688, h: 1152 },
  ],
  "1": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 6, cx: 3968, cy: -704, w: 5888, h: 896 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 6, cx: 6528, cy: -7552, w: 2816, h: 768 },
  ],
  "2": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 10, cx: 640, cy: -4096, w: 768, h: 4096 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 10, cx: 7552, cy: -4096, w: 768, h: 4096 },
  ],
  "3": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: 1419.38, cy: -1110.47, w: 2304, h: 1536 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: 4122.18, cy: -973.94, w: 2048, h: 1449.53 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: 6860.76, cy: -1146.35, w: 2048, h: 1792 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 8, cx: 1133.83, cy: -3111.28, w: 1792, h: 1792 },
    { name: "5号怪物", monsterKey: "5", min: 0, max: 10, cx: 3033.11, cy: -2463.24, w: 2304, h: 1223.11 },
    { name: "BOSS200", monsterKey: "200", min: 0, max: 1, cx: 7350.72, cy: -4855.59, w: 1536, h: 1536 },
    { name: "6号怪物", monsterKey: "6", min: 0, max: 10, cx: 5509.36, cy: -2126.55, w: 2304, h: 1223.11 },
    { name: "8号怪物", monsterKey: "8", min: 0, max: 10, cx: 5809.32, cy: -4177.67, w: 2304, h: 1223.11 },
    { name: "7号怪物", monsterKey: "7", min: 0, max: 10, cx: 6866.87, cy: -3270.22, w: 2304, h: 1223.11 },
    { name: "10号怪物", monsterKey: "10", min: 0, max: 10, cx: 1339.65, cy: -5337.98, w: 2304, h: 1223.11 },
    { name: "9号怪物", monsterKey: "9", min: 0, max: 10, cx: 2452.04, cy: -4125.54, w: 2304, h: 1223.11 },
    { name: "11号怪物", monsterKey: "11", min: 0, max: 10, cx: 3764.17, cy: -5470.88, w: 2304, h: 1223.11 },
    { name: "12号怪物", monsterKey: "12", min: 0, max: 10, cx: 6091.69, cy: -5476, w: 2304, h: 1223.11 },
    { name: "13号怪物", monsterKey: "13", min: 0, max: 10, cx: 1344, cy: -6767.99, w: 2304, h: 1223.11 },
    { name: "14号怪物", monsterKey: "14", min: 0, max: 10, cx: 3808, cy: -6847.99, w: 2304, h: 1223.11 },
    { name: "15号怪物", monsterKey: "15", min: 0, max: 10, cx: 6240, cy: -6863.99, w: 2304, h: 1223.11 },
    { name: "BOSS201", monsterKey: "201", min: 0, max: 1, cx: 7280, cy: -2272, w: 1536, h: 1536 },
    { name: "BOSS202", monsterKey: "202", min: 0, max: 1, cx: 2368, cy: -4816, w: 1536, h: 1536 },
  ],
  "4": [
    { name: "30号怪物", monsterKey: "30", min: 0, max: 30, cx: 1440, cy: -2464, w: 1792, h: 1536 },
    { name: "32号怪物", monsterKey: "32", min: 0, max: 40, cx: 3312, cy: -2880, w: 1536, h: 1792 },
    { name: "33号怪物", monsterKey: "33", min: 0, max: 30, cx: 2064, cy: -3536, w: 1792, h: 1024 },
    { name: "31号怪物", monsterKey: "31", min: 0, max: 30, cx: 1568, cy: -1056, w: 2048, h: 1024 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 7152, cy: -864, w: 1536, h: 1024 },
    { name: "34号怪物", monsterKey: "34", min: 0, max: 30, cx: 1552, cy: -3904, w: 1792, h: 1024 },
    { name: "35号怪物", monsterKey: "35", min: 0, max: 30, cx: 3680, cy: -976, w: 1792, h: 1024 },
  ],
  "5": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: 1792, cy: -1664, w: 2048, h: 1792 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: 6528, cy: -1792, w: 1792, h: 1536 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: 1664, cy: -6528, w: 1792, h: 1792 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 8, cx: 3968, cy: -4608, w: 1792, h: 1536 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 2560, cy: -2176, w: 1536, h: 1280 },
  ],
  "6": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: 1664, cy: -4224, w: 1792, h: 1792 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: 6656, cy: -3968, w: 1536, h: 1792 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: 4224, cy: -7040, w: 2304, h: 1280 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 10, cx: 6528, cy: -1792, w: 1792, h: 1536 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 4608, cy: -3328, w: 1792, h: 1280 },
  ],
  "7": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: 1792, cy: -1792, w: 2048, h: 1536 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: 6528, cy: -2048, w: 1792, h: 1536 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: 1792, cy: -6400, w: 2048, h: 1536 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 10, cx: 6528, cy: -6656, w: 1792, h: 1536 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 4096, cy: -4096, w: 1536, h: 1536 },
  ],
  "8": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: 1152, cy: -1920, w: 1280, h: 1792 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: 3200, cy: -1536, w: 1280, h: 1536 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: 5248, cy: -1920, w: 1280, h: 1792 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 8, cx: 7296, cy: -3456, w: 1280, h: 1792 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 4096, cy: -6400, w: 2048, h: 1536 },
  ],
  "9": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 8, cx: 1664, cy: -1664, w: 1792, h: 1792 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 8, cx: 6528, cy: -1792, w: 1792, h: 1536 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 8, cx: 1664, cy: -6528, w: 1792, h: 1792 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 8, cx: 6528, cy: -4608, w: 1792, h: 1536 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 3584, cy: -1664, w: 1536, h: 1280 },
  ],
  "10": [
    { name: "1号怪物", monsterKey: "1", min: 0, max: 6, cx: 1664, cy: -1792, w: 1792, h: 1536 },
    { name: "2号怪物", monsterKey: "2", min: 0, max: 6, cx: 6528, cy: -1408, w: 1792, h: 1280 },
    { name: "3号怪物", monsterKey: "3", min: 0, max: 6, cx: 1536, cy: -6784, w: 1536, h: 1280 },
    { name: "4号怪物", monsterKey: "4", min: 0, max: 6, cx: 6656, cy: -7040, w: 1536, h: 1280 },
    { name: "BOSS1", monsterKey: "200", min: 0, max: 1, cx: 4096, cy: -4480, w: 1536, h: 1280 },
  ],
};
