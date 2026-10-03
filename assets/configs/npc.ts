import { Vec3 } from "cc";
import { NpcData } from "../types/map";
import MapTeleportDialog from "../ui/components/dialogs/MapTeleportDialog";
import WarSoulDialog from "../ui/components/dialogs/WarSoulDialog";

/**
 * NPC 数据表
 * id 只做关联（Tiled 对象组里的 id 就是它），可以是任意字符串，不参与数值计算。
 * 想新增 NPC 就往 npcData 里加一条；onClick 等行为字段照写。
 */
const npcData: NpcData[] = [
  { id: "0001", label: "大陆传送官(未激活)", src: "npc/npc_2124" },
  { id: "0002", label: "大陆传送官", src: "npc/npc_2125", scale: new Vec3(1.5, 1.5), position: new Vec3(11, 0), onClick: () => new MapTeleportDialog().open() },

  { id: "9002", label: "战魂使者", src: "npc/npc_2121", scale: new Vec3(1.5, 1.5), onClick: () => new WarSoulDialog().open() },

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

/** NPC 配置（id → 配置）：由 npcData 统一构建，消费方照旧 npcs.get(id) */
export const npcs = new Map<string, NpcData>();
for (const npc of npcData) {
  npcs.set(npc.id, npc);
}
