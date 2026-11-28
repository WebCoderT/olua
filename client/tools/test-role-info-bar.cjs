#!/usr/bin/env node
/**
 * 角色信息栏 prefab 化单测（#1353，HUD prefab 化样板）
 *
 * A. prefab 结构：节点层级齐全、组件类型正确、静态外观（颜色 / 字号 / 位置 / 尺寸）已固化
 * B. 接线：Game 静态注入 prefab（@property + 构造传参 + 场景 uuid == meta）、动态色仍代码、placeLevel 读节点字号
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) return;
  failures += 1;
  console.log(`  [!!] ${name}${detail ? "：" + detail : ""}`);
};

// 组件取色：#rrggbbaa（按 prefab 里的 cc.Color）
const hex = (c) => "#" + [c.r, c.g, c.b, c.a].map((v) => v.toString(16).padStart(2, "0")).join("");

try {
  // ── A. prefab 结构 ──
  const prefabPath = path.join(PROJECT_ROOT, "assets/ui/prefabs/hud/RoleInfoBar.prefab");
  const objs = JSON.parse(fs.readFileSync(prefabPath, "utf8"));
  const nodes = objs.filter((o) => o.__type__ === "cc.Node");
  const byName = (name) => nodes.find((n) => n._name === name);
  const childrenOf = (name) => (byName(name)._children || []).map((c) => objs[c.__id__]);
  const pathOf = (p) => p.split("/").reduce((acc, part, i) =>
    i === 0 ? byName(part) : (acc ? childrenOf(acc._name).find((n) => n._name === part) : undefined), undefined);
  const compsOf = (p) => (pathOf(p) ? pathOf(p)._components.map((c) => objs[c.__id__]) : []);
  const comp = (p, type) => compsOf(p).find((c) => c.__type__ === type);
  const vec = (p, field) => pathOf(p)._lpos[field];

  check("prefab 有根节点 RoleInfoBar", !!byName("RoleInfoBar"));
  const rootUt = comp("RoleInfoBar", "cc.UITransform");
  check("根节点尺寸 344×84", rootUt && rootUt._contentSize.width === 344 && rootUt._contentSize.height === 84);
  check("根节点贴左上角(-768,480)", vec("RoleInfoBar", "x") === -768 && vec("RoleInfoBar", "y") === 480,
    vec("RoleInfoBar", "x") + "," + vec("RoleInfoBar", "y"));
  // 状态图标条是动态组件、自己按配置定位；挂载锚点必须在原点，否则双重偏移跑出信息栏
  check("StatusIcons 锚点在原点", vec("StatusIcons", "x") === 0 && vec("StatusIcons", "y") === 0,
    vec("StatusIcons", "x") + "," + vec("StatusIcons", "y"));

  // 节点层级齐全（与 roleInfoBarPrefab.nodes 契约一致）
  const required = [
    "Background", "AvatarFrame", "Avatar", "Name", "Level", "CurrencyBar",
    "CurrencyBar/CurrencyIcon", "CurrencyBar/CurrencyLabel", "CurrencyBar/CurrencyValue",
    "CombatDivider", "Combat", "Combat/CombatLabel", "Combat/CombatValue",
    "RealtimeStatus", "RealtimeStatus/StatusDot", "RealtimeStatus/StatusText", "StatusIcons",
  ];
  for (const p of required) check(`prefab 缺节点 ${p}`, !!pathOf(p));

  // nodes 映射 ↔ prefab 层级一致性（#1357：引擎 getChildByPath 逐段匹配不递归，
  // hud.ts 里的路径必须能在 prefab 里**从根逐段走到**，否则运行时取到 null 直接崩）
  const root = byName("RoleInfoBar");
  const resolveStrict = (p) => p.split("/").reduce((acc, part) => {
    if (!acc) return undefined;
    return (acc._children || []).map((c) => objs[c.__id__]).find((n) => n._name === part);
  }, root);
  const hud = read("assets/configs/layout/hud.ts");
  const mapMatch = /nodes:\s*\{([^}]*)\}/.exec(hud);
  check("hud.ts 有 nodes 映射", !!mapMatch);
  if (mapMatch) {
    const entries = [...mapMatch[1].matchAll(/(\w+):\s*"([^"]+)"/g)];
    check("nodes 映射非空", entries.length >= 9, `只解析到 ${entries.length} 项`);
    for (const [, key, p] of entries) check(`nodes.${key}="${p}" 从根可逐段解析`, !!resolveStrict(p));
  }

  // 组件类型：底板/头像框/头像/分隔线/状态点是 Sprite，文本是 Label
  for (const p of ["Background", "AvatarFrame", "Avatar", "CombatDivider", "RealtimeStatus/StatusDot"]) {
    check(`${p} 是 Sprite`, !!comp(p, "cc.Sprite"));
  }
  for (const p of ["Name", "Level", "CurrencyBar/CurrencyLabel", "CurrencyBar/CurrencyValue", "Combat/CombatLabel", "Combat/CombatValue", "RealtimeStatus/StatusText"]) {
    check(`${p} 是 Label`, !!comp(p, "cc.Label"));
  }

  // 静态外观固化：颜色（token 值）+ 字号
  check("底板色 = surface.glass #191209db", hex(comp("Background", "cc.Sprite")._color) === "#191209db",
    hex(comp("Background", "cc.Sprite")._color));
  check("名字色 = text1 #ede2ccff", hex(comp("Name", "cc.Label")._color) === "#ede2ccff");
  check("名字字号 16", comp("Name", "cc.Label")._fontSize === 16);
  check("等级色 = gold4 #e8c887ff", hex(comp("Level", "cc.Label")._color) === "#e8c887ff");
  check("等级字号 11", comp("Level", "cc.Label")._fontSize === 11);
  check("战斗力数值色 = ember3 #e0562fff", hex(comp("Combat/CombatValue", "cc.Label")._color) === "#e0562fff");
  check("战斗力数值字号 20", comp("Combat/CombatValue", "cc.Label")._fontSize === 20);
  check("底板引用入库纯色图", comp("Background", "cc.Sprite")._spriteFrame.__uuid__ === "3c6f7b8e-4d21-4f9a-9c30-8b5e2a1d7f44@f9941");

  // 引用完整性：所有 __id__ 在范围内
  let bad = 0;
  for (const o of objs) {
    const walk = (v) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) return v.forEach(walk);
      if ("__id__" in v && typeof v.__id__ === "number" && (v.__id__ < 0 || v.__id__ >= objs.length)) bad++;
      Object.keys(v).forEach((k) => walk(v[k]));
    };
    walk(o);
  }
  check("prefab 引用完整", bad === 0, `非法引用 ${bad} 处`);

  // ── B. 接线 ──
  const game = read("assets/ui/Game.ts");
  check("Game 有 @property(Prefab) roleInfoBarPrefab", /@property\(\{\s*type:\s*Prefab\s*\}\)[\s\S]{0,220}roleInfoBarPrefab/.test(game));
  check("Game 构造 RoleInfoBar 时传入 prefab", /new RoleInfoBar\(role,\s*this\.roleInfoBarPrefab!?\)/.test(game));

  const prefabMeta = JSON.parse(read("assets/ui/prefabs/hud/RoleInfoBar.prefab.meta"));
  const sceneText = read("assets/scenes/Game.scene");
  const sceneUuid = /"roleInfoBarPrefab"\s*:\s*\{\s*"__uuid__"\s*:\s*"([0-9a-f-]+)"/.exec(sceneText);
  check("Game.scene 注入 roleInfoBarPrefab uuid", !!sceneUuid);
  check("场景 uuid == prefab meta uuid", !!sceneUuid && sceneUuid[1] === prefabMeta.uuid,
    sceneUuid && `scene=${sceneUuid[1]} meta=${prefabMeta.uuid}`);

  const bar = read("assets/ui/components/hud/RoleInfoBar.ts");
  check("RoleInfoBar 实例化 prefab", /instantiate\(prefab\)/.test(bar));
  check("不再用 createText 拼名字", !/createText\(/.test(bar));
  check("不再用 createCombatPower 拼战力", !/createCombatPower\(/.test(bar));
  check("placeLevel 从节点字号读", /this\.nameLabel\.fontSize/.test(bar));
  check("placeLevel 宽度上限从分隔线节点读", /this\.combatDivider\.position\.x/.test(bar));
  check("动态色仍代码覆盖 statusDot", /this\.realtimeDot\.color\s*=/.test(bar));
  check("动态色仍代码覆盖 statusText", /this\.realtimeLabel\.color\s*=/.test(bar));
  check("飘字仍走动态工厂", /showCombatDelta\(/.test(bar));
  check("节点名不外泄到组件", !/getChildByName\(["']/.test(bar));
} catch (error) {
  failures += 1;
  console.log("  [!!] 单测抛异常：", error && error.stack ? error.stack.split("\n").slice(0, 3).join("\n") : error);
}

if (failures > 0) {
  console.log(`FAIL：${failures} 项`);
  process.exit(1);
}
console.log("PASS：角色信息栏 prefab 结构 / 静态外观固化 / 静态注入接线 / 动态色保留全部通过");
