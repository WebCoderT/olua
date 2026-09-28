import { Vec2 } from "cc";
import { MonsterConfig } from "../types/common";

export const monsters = new Map<string, MonsterConfig>();

monsters.set("1", {
  icon: "monster/icon/1",
  in: "monster/in/1",
  inOffset: new Vec2(),
  out: "monster/out/1",
  outOffset: new Vec2(),
  label: "赤焰斗鸡",
  level: 1,
  description: "赤焰斗鸡",
  sellPirce: 0,
  physicalAttack: [0, 1],
  magicAttack: [0, 0],
  taoistAttack: [0, 0],
  physicalDefense: [0, 0],
  magicDefense: [0, 0],
  taoistDefense: [0, 0],
  maxHp: 10,
});
