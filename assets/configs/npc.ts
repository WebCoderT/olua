import { Vec2, Vec3 } from "cc";
import { NPC } from "../types/map";
import MapTeleportDialog from "../ui/components/dialogs/MapTeleportDialog";

export const npcs = new Map<string, NPC>();

npcs.set("0001", { label: "大陆传送官(未激活)", src: "npc/npc_2124" });
npcs.set("0002", { label: "大陆传送官", src: "npc/npc_2125", scale: new Vec3(1.5, 1.5), position: new Vec3(11, 0), onClick: () => new MapTeleportDialog().open() });

npcs.set("1001", { label: "神装使者", src: "npc/npc_2108" });
npcs.set("1002", { label: "神装使者", src: "npc/npc_2109" });
npcs.set("1003", { label: "神装使者", src: "npc/npc_2110" });
npcs.set("1004", { label: "神装使者", src: "npc/npc_2111" });

npcs.set("2001", { label: "天赋刷新石(未激活)", src: "npc/npc_2112" });
npcs.set("2002", { label: "天赋刷新石", src: "npc/npc_2113" });

npcs.set("3001", { label: "地下通道(未激活)", src: "npc/npc_2114" });
npcs.set("3002", { label: "地下通道", src: "npc/npc_2115" });

npcs.set("4001", { label: "佛祖赐福(未激活)", src: "npc/npc_2116" });
npcs.set("4002", { label: "天佛赐福", src: "npc/npc_2117" });

npcs.set("5001", { label: "神丹熔炉(未激活)", src: "npc/npc_2118" });
npcs.set("5002", { label: "神丹熔炉", src: "npc/npc_2119" });

npcs.set("6001", { label: "前世今生(未激活)", src: "npc/npc_2120" });
npcs.set("6002", { label: "前世今生", src: "npc/npc_2121" });

npcs.set("7001", { label: "九莲宝灯(未激活)", src: "npc/npc_2122" });
npcs.set("7002", { label: "九莲宝灯", src: "npc/npc_2123" });

npcs.set("8001", { label: "天界飞升(未激活)", src: "npc/npc_2126" });
npcs.set("8002", { label: "天界飞升", src: "npc/npc_2127" });

npcs.set("8001", { label: "灵魂飞升(未激活)", src: "npc/npc_2128" });
npcs.set("8002", { label: "灵魂飞升", src: "npc/npc_2129" });
