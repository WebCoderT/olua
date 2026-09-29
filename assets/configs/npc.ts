import { Vec2, Vec3 } from "cc";
import { NPC } from "../types/map";
import MapSelectorDialog from "../ui/components/dialogs/MapSelectorDialog";

export const npcs = new Map<string, NPC>();

npcs.set("0", { label: "古兽战灵", src: "npc/0" });
npcs.set("1", { label: "王者之剑", src: "npc/1" });
npcs.set("2", { label: "奖励宝箱", src: "npc/2" });
npcs.set("3", { label: "未知-3", src: "npc/3" });
npcs.set("4", { label: "未知-4", src: "npc/4" });
npcs.set("5", { label: "未知-5", src: "npc/5" });
npcs.set("6", { label: "未知-6", src: "npc/6" });
npcs.set("7", { label: "未知-7", src: "npc/7" });
npcs.set("8", { label: "未知-8", src: "npc/8" });
npcs.set("9", { label: "未知-9", src: "npc/9" });
npcs.set("10", { label: "未知-10", src: "npc/10" });
npcs.set("11", { label: "未知-11", src: "npc/11" });
npcs.set("12", { label: "未知-12", src: "npc/12" });
npcs.set("13", { label: "未知-13", src: "npc/13" });
npcs.set("14", { label: "未知-14", src: "npc/14" });
npcs.set("15", { label: "未知-15", src: "npc/15" });
npcs.set("16", { label: "未知-16", src: "npc/16" });
npcs.set("17", { label: "未知-17", src: "npc/17" });
npcs.set("18", { label: "未知-18", src: "npc/18" });
npcs.set("19", { label: "未知-19", src: "npc/19" });
npcs.set("20", { label: "未知-20", src: "npc/20" });
npcs.set("21", { label: "未知-21", src: "npc/21" });
npcs.set("22", { label: "未知-22", src: "npc/22" });
npcs.set("23", { label: "未知-23", src: "npc/23" });
npcs.set("24", { label: "未知-24", src: "npc/24" });
npcs.set("25", { label: "大陆传送官", src: "npc/25", scale: new Vec3(1.5, 1.5), position: new Vec3(11, 0), onClick: () => new MapSelectorDialog().open() });
npcs.set("26", { label: "未知-26", src: "npc/26" });
npcs.set("27", { label: "未知-27", src: "npc/27" });
npcs.set("28", { label: "未知-28", src: "npc/28" });
npcs.set("29", { label: "未知-29", src: "npc/29" });

npcs.set("30", { label: "王者之剑-试炼", src: "npc/1" });
