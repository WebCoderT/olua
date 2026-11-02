/**
 * NPC 出厂数据（#603 第七域：唯一书写处）
 *
 * 以前这份数据写在客户端 `configs/npc-data.ts`（#258 数据与行为分家后拆出来的纯数据文件），
 * 客户端据它建 `npcs` 表渲染节点、预加载素材；管理端只能改名称与对话。本域把它整体搬到服务端：
 *
 * - **行只能来自这里**（`INSERT OR IGNORE` 幂等 seed）—— 与称号 / 战魂 / 军衔 / 装备基础件同一取向：
 *   NPC id 被 Tiled 地图对象组引用，清单固定，**没有新建 / 删除**（e2e 钉死 POST/DELETE 404）。
 * - 运营可改的是名称、对话文案，以及外观（`src` 素材目录 / `scale` 缩放 / `position` 偏移）——
 *   改完下次进游戏由 `GET /game-config` 快照下发，客户端 `configs/npc` 整表重建。
 * - **点击行为不进库**：`onClick` 是客户端组件（弹窗类），按 id 在 `configs/npc` 的 `NPC_CLICKS` 接线。
 *
 * `src` 是 `resources/` 下的相对目录（图集动画），不是「加载哪张图」那种会被下发方改坏的路径 ——
 * 它只决定这只 NPC 长什么样，运营改错的表现是「这个 NPC 不见了」，不会影响地图加载。
 */
export interface NpcSeedRow {
  /** NPC 编号（Tiled 对象组里的 `id` 属性与之对应） */
  id: string;
  /** 显示名称（管理端可改） */
  label: string;
  /** 素材目录（`resources/` 相对路径，图集动画） */
  src: string;
  /** 精灵缩放倍数（缺省 = 原尺寸） */
  scale?: { x: number; y: number };
  /** 精灵在节点内的偏移（缺省 = 0,0；「脚踩在地上」这类手工微调） */
  position?: { x: number; y: number };
}

export const NPC_SEED_ROWS: NpcSeedRow[] = [
  { id: "0001", label: "大陆传送官(未激活)", src: "npc/npc_2124" },
  { id: "0002", label: "大陆传送官", src: "npc/npc_2125", scale: { x: 1.5, y: 1.5 }, position: { x: 11, y: 0 } },

  { id: "9002", label: "战魂使者", src: "npc/npc_2121", scale: { x: 1.5, y: 1.5 } },

  { id: "1001", label: "神装使者", src: "npc/npc_2108" },
  { id: "1002", label: "神装使者", src: "npc/npc_2109" },
  { id: "1003", label: "神装使者", src: "npc/npc_2110" },
  { id: "1004", label: "神装使者", src: "npc/npc_2111" },

  { id: "2001", label: "天赋刷新石(未激活)", src: "npc/npc_2112" },
  { id: "2002", label: "天赋刷新石", src: "npc/npc_2113" },

  { id: "3001", label: "地下通道(未激活)", src: "npc/npc_2114" },
  { id: "3002", label: "地下通道", src: "npc/npc_2115" },

  { id: "4001", label: "佛祖赐福(未激活)", src: "npc/npc_2116" },
  { id: "4002", label: "天佛赐福", src: "npc/npc_2117" },

  { id: "5001", label: "神丹熔炉(未激活)", src: "npc/npc_2118" },
  { id: "5002", label: "神丹熔炉", src: "npc/npc_2119" },

  { id: "6001", label: "前世今生(未激活)", src: "npc/npc_2120" },
  { id: "6002", label: "前世今生", src: "npc/npc_2121" },

  { id: "7001", label: "九莲宝灯(未激活)", src: "npc/npc_2122" },
  { id: "7002", label: "九莲宝灯", src: "npc/npc_2123" },

  { id: "8001", label: "灵魂飞升(未激活)", src: "npc/npc_2128" },
  { id: "8002", label: "灵魂飞升", src: "npc/npc_2129" },
];
