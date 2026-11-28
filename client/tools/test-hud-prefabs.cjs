#!/usr/bin/env node
/**
 * HUD prefab 化第二批单测（#1361：小地图 / 底部栏 / 聊天窗 / 消息记录）
 *
 * A. prefab 结构：四个 prefab 节点契约齐全、VectorPlate 组件在位、引用完整；
 *    —— 注意**不锁**颜色/字号/位置精确值：外观归 prefab，编辑器里随便改（#1359 口径）
 * B. 接线：Game 四个 @property + 场景 uuid == prefab meta；代码不再自定位/自配色
 *    （根位置与子组件摆位全部由 prefab 承载，配置里不留死字段）
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

// VectorPlate.ts 的压缩 uuid（脚本组件在 prefab 里的 __type__）
const BASE64_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const compressUuid = (uuid) => {
  const s = uuid.replace(/-/g, "");
  let out = s.slice(0, 5);
  for (let i = 5; i < 32; i += 3) {
    const a = parseInt(s[i], 16), b = parseInt(s[i + 1], 16), c = parseInt(s[i + 2], 16);
    out += BASE64_KEYS[(a << 2) | (b >> 2)] + BASE64_KEYS[((b & 3) << 4) | c];
  }
  return out;
};

try {
  const hud = read("assets/configs/layout/hud.ts");
  const vectorPlateType = compressUuid(JSON.parse(read("assets/ui/components/common/VectorPlate.ts.meta")).uuid);
  const sceneText = read("assets/scenes/Game.scene");
  const game = read("assets/ui/Game.ts");

  // 契约节点名从 hud.ts 解析（单一真相，测试不手抄节点名）
  const contractOf = (name) => {
    const m = new RegExp(`export const ${name} = \\{[\\s\\S]*?nodes: \\{([\\s\\S]*?)\\n  \\},`).exec(hud);
    if (!m) throw new Error(`hud.ts 缺 ${name} 契约`);
    const entries = [...m[1].matchAll(/(\w+): ("[^"]+"|\[[^\]]*\])/g)];
    return Object.fromEntries(entries.map(([_, k, v]) => [k, JSON.parse(v.replace(/'/g, '"'))]));
  };
  const contracts = {
    smallMapPrefab: contractOf("smallMapPrefab"),
    bottomBarPrefab: contractOf("bottomBarPrefab"),
    chatBoxPrefab: contractOf("chatBoxPrefab"),
    messageLogPrefab: contractOf("messageLogPrefab"),
  };

  const PREFABS = [
    ["SmallMap", contracts.smallMapPrefab],
    ["BottomBar", contracts.bottomBarPrefab],
    ["ChatBox", contracts.chatBoxPrefab],
    ["MessageLog", contracts.messageLogPrefab],
  ];

  // ── A. prefab 结构 ──
  for (const [name, contract] of PREFABS) {
    const objs = JSON.parse(read(`assets/ui/prefabs/hud/${name}.prefab`));
    const meta = JSON.parse(read(`assets/ui/prefabs/hud/${name}.prefab.meta`));
    const nodes = objs.filter((o) => o.__type__ === "cc.Node");
    const byName = (n) => nodes.find((x) => x._name === n);
    check(`${name} 有根节点`, !!byName(name) && !byName(name)._parent);
    // 引用完整性
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
    check(`${name} 引用完整`, bad === 0, `非法引用 ${bad} 处`);
    // 契约节点齐全（数组值逐项；对象值取字符串）
    const flatten = (v) => (Array.isArray(v) ? v : [v]);
    for (const [key, value] of Object.entries(contract)) {
      for (const p of flatten(value)) {
        check(`${name} 缺契约节点 ${key}="${p}"`, !!byName(p));
      }
    }
    // 场景注入 uuid == prefab meta uuid
    const injected = new RegExp(`"${name.charAt(0).toLowerCase() + name.slice(1).replace(/[A-Z]/g, (c) => c)}"`).test("");
    const field = name === "ChatBox" ? "chatBoxPrefab" : `${name.charAt(0).toLowerCase() + name.slice(1)}Prefab`;
    const sceneUuid = new RegExp(`"${field}"\\s*:\\s*\\{\\s*"__uuid__"\\s*:\\s*"([0-9a-f-]+)"`).exec(sceneText);
    check(`Game.scene 注入 ${field}`, !!sceneUuid);
    check(`${field} 场景 uuid == prefab meta uuid`, !!sceneUuid && sceneUuid[1] === meta.uuid,
      sceneUuid && `scene=${sceneUuid[1]} meta=${meta.uuid}`);
    void injected;
  }

  // VectorPlate 在位：SmallMap/Panel、ChatBox/Box、MessageLog/Plate
  for (const [file, node] of [["SmallMap", "Panel"], ["ChatBox", "Box"], ["MessageLog", "Plate"]]) {
    const objs = JSON.parse(read(`assets/ui/prefabs/hud/${file}.prefab`));
    const target = objs.find((o) => o.__type__ === "cc.Node" && o._name === node);
    const hasVp = target && target._components.some((c) => objs[c.__id__].__type__ === vectorPlateType);
    check(`${file}/${node} 挂 VectorPlate（面板外观可编辑器改）`, !!hasVp);
  }

  // #1363：BottomBar 的静态视觉在 prefab —— BackdropAnchor 挂 HudBackdrop、Vsep0/Vsep1 挂 VerticalRule
  const hudBackdropType = compressUuid(JSON.parse(read("assets/ui/components/common/HudBackdrop.ts.meta")).uuid);
  const verticalRuleType = compressUuid(JSON.parse(read("assets/ui/components/common/VerticalRule.ts.meta")).uuid);
  const bottomBarObjs = JSON.parse(read("assets/ui/prefabs/hud/BottomBar.prefab"));
  for (const [node, type, label] of [
    ["BackdropAnchor", hudBackdropType, "HudBackdrop"],
    ["Vsep0", verticalRuleType, "VerticalRule"],
    ["Vsep1", verticalRuleType, "VerticalRule"],
  ]) {
    const target = bottomBarObjs.find((o) => o.__type__ === "cc.Node" && o._name === node);
    const has = target && target._components.some((c) => bottomBarObjs[c.__id__].__type__ === type);
    check(`BottomBar/${node} 挂 ${label}（prefab 所见即运行时所得）`, !!has);
  }
  const hudBackdropSrc = read("assets/ui/components/common/HudBackdrop.ts");
  const verticalRuleSrc = read("assets/ui/components/common/VerticalRule.ts");
  check("HudBackdrop/VerticalRule 外观 @property 化 + 编辑器可见",
    /@property\n  public steps/.test(hudBackdropSrc) && /@property\n  public fadeRange/.test(verticalRuleSrc)
    && /executeInEditMode/.test(hudBackdropSrc) && /executeInEditMode/.test(verticalRuleSrc));

  // VectorPlate 是可序列化的属性组件 + 编辑器可见
  const vp = read("assets/ui/components/common/VectorPlate.ts");
  check("VectorPlate 全外观 @property 化", /@property\n  public fillColor/.test(vp) && /@property\n  public showRivet/.test(vp));
  check("VectorPlate executeInEditMode（编辑器里可见）", /executeInEditMode/.test(vp));

  // ── B. 接线 ──
  for (const field of ["smallMapPrefab", "bottomBarPrefab", "messageLogPrefab", "chatBoxPrefab", "growthEntryPrefab"]) {
    check(`Game 有 @property(Prefab) ${field}`,
      new RegExp(`@property\\(\\{\\s*type:\\s*Prefab\\s*\\}\\)[\\s\\S]{0,220}${field}`).test(game));
  }
  check("Game 构造 BottomBar 传 prefab + 聊天 prefab + 成长线入口 prefab",
    /new BottomBar\(role, this\.bottomBarPrefab!, this\.chatBoxPrefab!, this\.growthEntryPrefab\)/.test(game));
  check("Game 构造 SmallMap 传 prefab", /new SmallMap\(this\.roleDisplay, this\.smallMapPrefab!\)/.test(game));
  check("Game 构造 MessageLog 传 prefab", /new MessageLog\(this\.messageLogPrefab!\)/.test(game));

  // 代码不再自定位 / 不再引用已搬进 prefab 的配置
  const smallMap = read("assets/ui/components/hud/SmallMap.ts");
  check("SmallMap 根位置取 prefab 实例位置", /this\.setPosition\(instance\.position\.x, instance\.position\.y, 0\)/.test(smallMap));
  check("SmallMap 不再引用配置定位（position/entryGridPosition/positionBar/contentPosition）",
    !/smallMapLayout\.(position|entryGridPosition|positionBar|contentPosition)/.test(smallMap));

  const bottomBar = read("assets/ui/components/hud/BottomBar.ts");
  check("BottomBar 根位置取 prefab 实例位置", /this\.setPosition\(instance\.position\.x, instance\.position\.y, 0\)/.test(bottomBar));
  check("BottomBar 不再引用配置定位（position/settingsButton/backdrop/separators）",
    !/bottomBarLayout\./.test(bottomBar));
  check("BottomBar 底衬/分隔线视觉在 prefab（不再代码画）", !/createHudBackdrop|createVerticalRule/.test(bottomBar));
  check("BottomBar 子组件挂 prefab 锚点", /anchor\(paths\.navBar\)\.addChild/.test(bottomBar) && /anchor\(paths\.hpOrb\)\.addChild/.test(bottomBar));

  for (const f of ["RoleExpBar", "RoleHpOrb", "RoleMpOrb"]) {
    const src = read(`assets/ui/components/hud/${f}.ts`);
    check(`${f} 不再自定位`, !/this\.setPosition\(/.test(src));
  }
  for (const f of ["BottomNavBar", "ShortcutKeyBar"]) {
    const src = read(`assets/ui/components/hud/${f}.ts`);
    check(`${f} 行容器零点挂载（摆位归锚点）`, /applyRowStyle\(this, layout\.spacing, new Vec2\(\), layout\.size\)/.test(src));
  }
  const autoFight = read("assets/ui/helpers/parts/role-parts.ts");
  check("AutoFightButton 样式工厂不再自定位", !/node\.setPosition\(layout\.position\.x/.test(autoFight));

  const chat = read("assets/ui/components/dialogs/ChatDialog.ts");
  check("ChatDialog 窗体来自 prefab", /instantiate\(this\.chatPrefab\) as Node/.test(chat));
  check("ChatDialog 窗体挡穿透保留", /blockClickThrough\(this\.dialog\)/.test(chat));
  check("ChatDialog 不再走 createChatBox / 配置停靠位", !/createChatBox|layout\.position/.test(chat));

  const mlog = read("assets/ui/components/hud/MessageLog.ts");
  check("MessageLog 实例化 prefab", /instantiate\(prefab\) as Node/.test(mlog));
  check("MessageLog 根位置基准是 prefab 根位（rootHome）", /this\.rootHome = \{ x: instance\.position\.x/.test(mlog));
  check("MessageLog 不再引用配置停靠位", !/layout\.position/.test(mlog));
  check("MessageLog 行区整块重建（不再 clearChildren(this) 炸掉静态骨架）", /clearChildren\(this\.rowsAnchor\)/.test(mlog));

  // 配置不留死字段（搬进 prefab 的定位/配色项从 configs 移除）
  check("hud.ts 不留底部栏死定位", !/settingsButton: \{|positions: \[new Vec2\(-60/.test(hud));
  check("hud.ts 不留消息记录死定位", !/position: new Vec2\(764, -386\)|rivet: \{ offset: 9/.test(hud));
} catch (error) {
  failures += 1;
  console.log("  [!!] 单测抛异常：", error && error.stack ? error.stack.split("\n").slice(0, 3).join("\n") : error);
}

if (failures > 0) {
  console.log(`FAIL：${failures} 项`);
  process.exit(1);
}
console.log("PASS：HUD 第二批四块 prefab 结构 / 注入接线 / 零样式覆写全部通过");
