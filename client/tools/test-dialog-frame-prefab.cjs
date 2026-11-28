#!/usr/bin/env node
/**
 * 弹窗骨架 prefab 化单测（#1386 第一期：DialogFrame / DialogFoot）
 *
 * A. prefab 结构：节点契约齐全（frame.ts 的 dialogFramePrefab / dialogFootPrefab.nodes 为单一真相）、
 *    组件在位（VectorPlate / DialogFrame / Draggable / FillRect / DialogFoot / cc.Button）、引用完整；
 *    —— 注意**不锁**颜色/字号/位置精确值：外观归 prefab，编辑器里随便改（#1359 口径）
 * B. 接线：Game 两个 @property + 场景 uuid == prefab meta；createDialog / createDialogFoot 只写
 *    文案与尺寸（零样式覆写），行为接线在 DialogFrame.start()
 * C. 反证：节点名/组件 uuid 写错必须拿到空匹配（空串一律判失败）
 *
 * 用法：node client/tools/test-dialog-frame-prefab.cjs
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
  const frameConfig = read("assets/configs/layout/dialogs/frame.ts");
  const sceneText = read("assets/scenes/Game.scene");
  const game = read("assets/ui/Game.ts");
  const builder = read("assets/ui/helpers/parts/dialog-builder.ts");
  const frameComponent = read("assets/ui/components/dialogs/DialogFrame.ts");

  // 契约节点名从 frame.ts 解析（单一真相，测试不手抄节点名）
  const contractOf = (name) => {
    const m = new RegExp(`export const ${name} = \\{[\\s\\S]*?nodes: \\{([\\s\\S]*?)\\n  \\},`).exec(frameConfig);
    if (!m) throw new Error(`frame.ts 缺 ${name} 契约`);
    const entries = [...m[1].matchAll(/(\w+): ("[^"]+")/g)];
    return Object.fromEntries(entries.map(([_, k, v]) => [k, JSON.parse(v)]));
  };
  const dialogFrameContract = contractOf("dialogFramePrefab");
  const dialogFootContract = contractOf("dialogFootPrefab");
  check("dialogFramePrefab 契约五件", ["headDrag", "eyebrow", "closeButton", "title", "titleRule"].every((k) => k in dialogFrameContract));
  check("dialogFootPrefab 契约三件", ["rule", "left", "right"].every((k) => k in dialogFootContract));

  const TYPES = {
    vectorPlate: compressUuid(JSON.parse(read("assets/ui/components/common/VectorPlate.ts.meta")).uuid),
    fillRect: compressUuid(JSON.parse(read("assets/ui/components/common/FillRect.ts.meta")).uuid),
    draggable: compressUuid(JSON.parse(read("assets/ui/components/input/Draggable.ts.meta")).uuid),
    dialogFrame: compressUuid(JSON.parse(read("assets/ui/components/dialogs/DialogFrame.ts.meta")).uuid),
    dialogFoot: compressUuid(JSON.parse(read("assets/ui/components/dialogs/DialogFoot.ts.meta")).uuid),
  };

  const loadPrefab = (name) => {
    const objs = JSON.parse(read(`assets/ui/prefabs/dialogs/${name}.prefab`));
    const meta = JSON.parse(read(`assets/ui/prefabs/dialogs/${name}.prefab.meta`));
    return { objs, meta };
  };

  //#region A. prefab 结构

  console.log("\n— A. prefab 结构 —");

  {
    const { objs, meta } = loadPrefab("DialogFrame");
    const nodes = objs.filter((o) => o.__type__ === "cc.Node");
    const byName = (n) => nodes.find((x) => x._name === n);
    check("DialogFrame 有根节点", !!byName("DialogFrame") && !byName("DialogFrame")._parent);
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
    check("DialogFrame 引用完整", bad === 0, `非法引用 ${bad} 处`);
    for (const [_, nodeName] of Object.entries(dialogFrameContract)) {
      check(`DialogFrame 子件 ${nodeName} 在位`, !!byName(nodeName), "契约节点缺失（prefab 改层级要同步 frame.ts）");
    }
    const types = objs.map((o) => o.__type__);
    check("DialogFrame 底板 = VectorPlate", types.includes(TYPES.vectorPlate));
    check("DialogFrame 编排组件在位", types.includes(TYPES.dialogFrame));
    check("DialogFrame 拖拽柄 = Draggable", types.includes(TYPES.draggable));
    check("DialogFrame 短金线 = FillRect", types.includes(TYPES.fillRect));
    check("DialogFrame 关闭键 = cc.Button", types.includes("cc.Button"));
    // @property 引用绑定齐全（引用字段非空 —— 走序列化绑定，不做名字查找）
    const comp = objs.find((o) => o.__type__ === TYPES.dialogFrame);
    check("DialogFrame 组件五件引用已绑定", ["headDrag", "eyebrowLabel", "closeButtonNode", "titleLabel", "titleRule"].every((k) => comp[k] && typeof comp[k].__id__ === "number"), "组件引用字段缺失（prefab 里没绑上）");
    check("DialogFrame 组件无空引用", !JSON.stringify(comp).includes('"__id__": null'));
    // #1391：节点必须有 PrefabInfo、组件必须有 CompPrefabInfo（漏接线 = 编辑器一运行 instantiate 就崩 isChildOf）
    for (const [pi, o] of objs.entries()) {
      if (o.__type__ === "cc.Node") {
        const info = o._prefab && objs[o._prefab.__id__];
        check(`DialogFrame 节点 ${o._name || pi} 有 PrefabInfo`, !!info && info.__type__ === "cc.PrefabInfo" && !!info.fileId && info.root && info.asset, "节点缺 _prefab 接线（编辑器实例化会崩）");
      } else if (o.__type__ !== "cc.Prefab" && o.__type__ !== "cc.PrefabInfo" && o.__type__ !== "cc.CompPrefabInfo" && "node" in o) {
        const info = o.__prefab && objs[o.__prefab.__id__];
        check(`DialogFrame 组件 ${o.__type__} 有 CompPrefabInfo`, !!info && info.__type__ === "cc.CompPrefabInfo" && !!info.fileId, "组件缺 __prefab 接线（编辑器实例化会崩）");
      }
    }
  }

  {
    const { objs, meta } = loadPrefab("DialogFoot");
    const nodes = objs.filter((o) => o.__type__ === "cc.Node");
    const byName = (n) => nodes.find((x) => x._name === n);
    check("DialogFoot 有根节点", !!byName("DialogFoot") && !byName("DialogFoot")._parent);
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
    check("DialogFoot 引用完整", bad === 0, `非法引用 ${bad} 处`);
    for (const [_, nodeName] of Object.entries(dialogFootContract)) {
      check(`DialogFoot 子件 ${nodeName} 在位`, !!byName(nodeName));
    }
    const types = objs.map((o) => o.__type__);
    check("DialogFoot 编排组件在位", types.includes(TYPES.dialogFoot));
    check("DialogFoot 分隔线 = FillRect", types.includes(TYPES.fillRect));
    const comp = objs.find((o) => o.__type__ === TYPES.dialogFoot);
    check("DialogFoot 组件三件引用已绑定", ["rule", "leftLabel", "rightLabel"].every((k) => comp[k] && typeof comp[k].__id__ === "number"));
    // #1391：同 DialogFrame，PrefabInfo / CompPrefabInfo 接线必须齐全
    for (const [pi, o] of objs.entries()) {
      if (o.__type__ === "cc.Node") {
        const info = o._prefab && objs[o._prefab.__id__];
        check(`DialogFoot 节点 ${o._name || pi} 有 PrefabInfo`, !!info && info.__type__ === "cc.PrefabInfo" && !!info.fileId && info.root && info.asset, "节点缺 _prefab 接线（编辑器实例化会崩）");
      } else if (o.__type__ !== "cc.Prefab" && o.__type__ !== "cc.PrefabInfo" && o.__type__ !== "cc.CompPrefabInfo" && "node" in o) {
        const info = o.__prefab && objs[o.__prefab.__id__];
        check(`DialogFoot 组件 ${o.__type__} 有 CompPrefabInfo`, !!info && info.__type__ === "cc.CompPrefabInfo" && !!info.fileId, "组件缺 __prefab 接线（编辑器实例化会崩）");
      }
    }
  }

  //#endregion

  //#region B. 接线

  console.log("\n— B. 接线（Game 注入 + 零样式覆写）—");

  check("Game 有 dialogFramePrefab @property", /@property\(\{ type: Prefab \}\)\s*\n\s*dialogFramePrefab/.test(game));
  check("Game 有 dialogFootPrefab @property", /@property\(\{ type: Prefab \}\)\s*\n\s*dialogFootPrefab/.test(game));
  check("Game start 注入 DialogFrame.setPrefab", /DialogFrame\.setPrefab\(this\.dialogFramePrefab\)/.test(game));
  check("Game start 注入 DialogFoot.setPrefab", /DialogFoot\.setPrefab\(this\.dialogFootPrefab\)/.test(game));

  for (const [field, prefabName] of [["dialogFramePrefab", "DialogFrame"], ["dialogFootPrefab", "DialogFoot"]]) {
    const sceneMatch = new RegExp(`"${field}": \\{\\s*\n\\s*"__uuid__": "([0-9a-f-]+)"`).exec(sceneText);
    check(`Game.scene 注入 ${field}`, !!sceneMatch, "场景里没绑 prefab 引用");
    if (sceneMatch) {
      const metaUuid = JSON.parse(read(`assets/ui/prefabs/dialogs/${prefabName}.prefab.meta`)).uuid;
      check(`${field} 场景 uuid == prefab meta`, sceneMatch[1] === metaUuid, `${sceneMatch[1]} ≠ ${metaUuid}`);
    }
  }

  // 零样式覆写（#1359 口径：prefab 为准，代码只写文案与尺寸）
  const createDialogBody = builder.split("export function createDialog(")[1]?.split("\n  }")[0] ?? "";
  check("createDialog 用 instantiate 实例化 prefab", /instantiate\(prefab\)/.test(createDialogBody), "骨架必须来自 prefab，不许再手拼节点");
  check("createDialog 只写文案与尺寸", /setTitle\(title\)/.test(createDialogBody) && /setEyebrow\(eyebrow\)/.test(createDialogBody) && /setSize\(size\)/.test(createDialogBody));
  check("createDialog 不再碰样式", !/createLabel|addComponent\(Graphics\)|fillColor|fontSize/.test(createDialogBody), "工厂里出现样式调用 = 双路径回潮");
  check("createDialog 未注入时抛错", /getPrefab\(\)/.test(createDialogBody) && /throw new Error/.test(createDialogBody), "prefab 未注入必须当场暴露，不许静默兜底");
  const createFootBody = builder.split("export function createDialogFoot(")[1]?.split("\n  }")[0] ?? "";
  check("createDialogFoot 用 instantiate 实例化 prefab", /instantiate\(prefab\)/.test(createFootBody));
  check("createDialogFoot 只写几何与文案", /setGeometry\(foot\)/.test(createFootBody) && /setTexts\(leftText, rightText\)/.test(createFootBody));
  check("createDialogBg 已删（骨架工厂只剩 prefab 一条路径）", !/function createDialogBg/.test(builder));
  check("bindDialogRaiseOnPress 由 DialogBehavior re-export（无循环依赖）", /export \{ bindDialogRaiseOnPress \} from "\.\.\/\.\.\/utils\/input\/DialogBehavior"/.test(builder));
  // 行为接线在组件 start()（编辑器 executeInEditMode 不跑 start）
  check("DialogFrame 摆位与行为分离", /protected onLoad\(\)[\s\S]*?relayout\(\)/.test(frameComponent) && /protected start\(\)[\s\S]*?blockClickThrough/.test(frameComponent));

  //#endregion

  //#region C. 反证（断言写错必须红，防止假绿）

  console.log("\n— C. 反证 —");

  const prefabTypes = loadPrefab("DialogFrame").objs.map((o) => o.__type__);
  check("反证：不存在的组件 uuid 判不出（compressUuid 正确性）", !prefabTypes.includes(compressUuid("00000000-0000-0000-0000-000000000000")));
  check("反证：契约解析写错拿不到节点", !(() => {
    const nodes = loadPrefab("DialogFrame").objs.filter((o) => o.__type__ === "cc.Node");
    return nodes.find((x) => x._name === "不存在的节点名");
  })());
  const badSplit = builder.split("export function createDialogNonexistent(")[1]?.split("\n  }")[0] ?? "";
  check("反证：源码切分写错拿到空串（空串一律判失败）", badSplit === "");

  //#endregion

  if (failures === 0) {
    console.log("\nPASS：弹窗骨架 prefab 化（DialogFrame / DialogFoot）结构、接线、反证全部通过。");
  } else {
    console.log(`\n失败 ${failures} 条`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\n测试执行失败：${error.message}`);
  process.exitCode = 1;
}
