import { Vec3 } from "cc";
import type { NpcData } from "../types/map";

/**
 * NPC 纯数据表（#258 拆分：数据与行为分家）
 *
 * 这里**只有数据**（id / label / src / scale / position），不含任何行为字段 ——
 * 工具链 `tools/gen-shared-data.cjs` 要在 Node 垫片里编译加载本文件给三端生成
 * 公共数据快照，一旦引到 UI 组件（onClick → 弹窗 → 输入层）就会在加载期炸掉
 * （`sys.hasFeature` 之类引擎运行时 Node 里没有）。
 *
 * 想新增 NPC 就往这里加一条纯数据；点击行为去 `configs/npc` 的 NPC_CLICKS 按 id 接线。
 */
export type NpcDataEntry = Omit<NpcData, "onClick">;

const npcDataEntries: NpcDataEntry[] = [
  { id: "0001", label: "大陆传送官(未激活)", src: "npc/npc_2124" },
  { id: "0002", label: "大陆传送官", src: "npc/npc_2125", scale: new Vec3(1.5, 1.5), position: new Vec3(11, 0) },

  { id: "9002", label: "战魂使者", src: "npc/npc_2121", scale: new Vec3(1.5, 1.5) },

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

export { npcDataEntries as npcData };
