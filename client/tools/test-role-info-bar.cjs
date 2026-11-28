#!/usr/bin/env node
/**
 * 角色信息栏 prefab 化单测（#1353 HUD prefab 化样板；#1359 口径：prefab 为准）
 *
 * A. prefab 结构：节点层级齐全、组件类型正确、引用完整
 *    —— 注意**不锁**颜色/字号/位置精确值：静态外观归 prefab，用户在编辑器里随便改，
 *       锁精确值会把合法的可视化改动误判成回归
 * B. 接线：Game 静态注入 prefab（@property + 构造传参 + 场景 uuid == meta）；
 *    代码对信息栏只写文字内容，不碰任何样式（无位置覆写、无颜色覆写）
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

// 组件取色器已随精确值断言移除（#1359：外观值归 prefab，不锁）

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

  check("prefab 有根节点 RoleInfoBar", !!byName("RoleInfoBar"));
  check("根节点有 UITransform", !!comp("RoleInfoBar", "cc.UITransform"));

  // 节点层级齐全（与 roleInfoBarPrefab.nodes 契约一致）
  const required = [
    "Background", "AvatarFrame", "Avatar", "Name", "Level", "CurrencyBar",
    "CurrencyBar/CurrencyIcon", "CurrencyBar/CurrencyLabel", "CurrencyBar/CurrencyValue",
    "CombatDivider", "Combat", "Combat/CombatLabel", "Combat/CombatValue",
    "RealtimeStatus", "RealtimeStatus/StatusDot", "RealtimeStatus/StatusText", "StatusIcons",
  ];
  for (const p of required) check(`prefab 缺节点 ${p}`, !!pathOf(p));

  // 节点都带 _lpos（摆位归 prefab；数值不锁——用户在编辑器里随便改）
  for (const p of required) check(`节点 ${p} 有 _lpos`, !!pathOf(p)._lpos);

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
    check("nodes 映射非空", entries.length >= 7, `只解析到 ${entries.length} 项`);
    for (const [, key, p] of entries) check(`nodes.${key}="${p}" 从根可逐段解析`, !!resolveStrict(p));
  }

  // 组件类型：底板/头像框/头像/分隔线/状态点是 Sprite，文本是 Label
  for (const p of ["Background", "AvatarFrame", "Avatar", "CombatDivider", "RealtimeStatus/StatusDot"]) {
    check(`${p} 是 Sprite`, !!comp(p, "cc.Sprite"));
  }
  for (const p of ["Name", "Level", "CurrencyBar/CurrencyLabel", "CurrencyBar/CurrencyValue", "Combat/CombatLabel", "Combat/CombatValue", "RealtimeStatus/StatusText"]) {
    check(`${p} 是 Label`, !!comp(p, "cc.Label"));
  }
  // 文本节点的 Label 带颜色/字号属性（外观值不锁精确值，用户在编辑器里随便改）
  for (const p of ["Name", "Level", "Combat/CombatValue"]) {
    const l = comp(p, "cc.Label");
    check(`${p} Label 带 _color/_fontSize`, !!l && "_color" in l && "_fontSize" in l);
  }

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
  // #1359：代码对信息栏只写文字内容，不碰任何样式
  check("不再运行时改 Level 位置（placeLevel 已删）", !/placeLevel/.test(bar));
  check("本人根节点位置取 prefab 实例位置", /applyFixedPosition\(instance\.position\)/.test(bar));
  check("子节点零 setPosition（根节点定位除外）", !/\w+\.node\.setPosition\(|levelLabel\.node\.setPosition/.test(bar));
  check("零颜色覆写（.color = 全无）", !/\.color\s*=/ .test(bar));
  check("字号零覆写", !/\.fontSize\s*=/ .test(bar));
  check("通道状态只切文案", /realtimeLabel\.string\s*=\s*getText\(/.test(bar));
  check("状态点不再换色（realtimeDot 已删）", !/realtimeDot/.test(bar));
  check("飘字仍走动态工厂（独立浮层，不碰信息栏样式）", /showCombatDelta\(/.test(bar));
  check("头像换图保留（数据内容而非样式）", /applyAvatar\(/.test(bar));
  check("节点名不外泄到组件", !/getChildByName\(["']/.test(bar));

  // StatusIconBar 也不自定位：摆位归 prefab 的 StatusIcons 锚点
  const iconBar = read("assets/ui/components/hud/StatusIconBar.ts");
  check("StatusIconBar 不自定位", !/setPosition/.test(iconBar));

  // 配置里不再有运行时样式覆写项
  const hudCfg = read("assets/configs/layout/hud.ts");
  check("realtimeColors 动态色配置已删", !/realtimeColors/.test(hudCfg));
  check("roleInfoBar 不再有 dividerX / position 自定位项", !/dividerX/.test(hudCfg));
} catch (error) {
  failures += 1;
  console.log("  [!!] 单测抛异常：", error && error.stack ? error.stack.split("\n").slice(0, 3).join("\n") : error);
}

if (failures > 0) {
  console.log(`FAIL：${failures} 项`);
  process.exit(1);
}
console.log("PASS：角色信息栏 prefab 结构 / prefab 为准接线 / 代码零样式覆写全部通过");
