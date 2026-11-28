#!/usr/bin/env node
/**
 * 通用 NPC 对话框单测（#1337）
 *
 * A. 分页纯函数：跑真模块（不复制逻辑），空文本兜底 / 长文本切块 / 行数与字符双上限 / 无溢出
 * B. prefab 结构：节点层级、组件类型、纯色图引用、尺寸、按钮都在；按钮组是 cc.Layout 横向从右向左（#1348）
 * C. 接线：QuestTalk 把 dialog + quests 交给 NpcDialog；Game 静态注入 prefab（#1348）、销毁时清键盘监听
 */
const fs = require("fs");
const path = require("path");
const { prepare } = require("./lib/configs-sandbox.cjs");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
const readRepo = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, "..", rel), "utf8");

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) return;
  failures += 1;
  console.log(`  [!!] ${name}${detail ? "：" + detail : ""}`);
};

try {
  // ── A. 分页纯函数 ──
  const outDir = prepare("olua-npc-dialog", ["ui/utils/dialog/npc-dialog-pages.ts"]);
  const { paginateDialog, splitLongLine } = require(path.join(outDir, "ui/utils/dialog/npc-dialog-pages.js"));
  const opts = { maxChars: 130, maxLines: 3, emptyText: "（空）" };

  check("空文本兜底", paginateDialog("", opts).length === 1 && paginateDialog("", opts)[0] === "（空）");
  check("纯空格兜底", paginateDialog("   \n  ", opts)[0] === "（空）");
  check("短文本单页", paginateDialog("旅人，你终于来了。", opts).length === 1);
  const chunks = splitLongLine("一二三四五", 2);
  check("长行切块", chunks.length === 3 && chunks[0] === "一二" && chunks[2] === "五", JSON.stringify(chunks));
  const long = paginateDialog("甲".repeat(400), opts);
  check("400 字分多页", long.length > 1 && long.length <= 4, `页数=${long.length}`);
  check("每页不超字符上限", long.every((p) => p.length <= opts.maxChars), JSON.stringify(long.map((p) => p.length)));
  const lined = paginateDialog("一\n二\n三\n四\n五", opts);
  check("物理行数上限", lined.length === 2 && lined[0] === "一\n二\n三" && lined[1] === "四\n五", JSON.stringify(lined));
  check("段间空行不浪费版面", paginateDialog("一\n\n\n二", opts).length === 1);
  check("中文长度按字符计", paginateDialog("测".repeat(131), opts).length === 2);

  // ── B. prefab 结构 ──
  const prefabPath = path.join(PROJECT_ROOT, "assets/ui/prefabs/NpcDialog.prefab");
  const objs = JSON.parse(fs.readFileSync(prefabPath, "utf8"));
  const nodes = objs.filter((o) => o.__type__ === "cc.Node");
  const byName = (name) => nodes.find((n) => n._name === name);
  const childrenOf = (name) => (byName(name)._children || []).map((c) => objs[c.__id__]);
  const pathOf = (p) => p.split("/").reduce((acc, part, i) =>
    i === 0 ? byName(part) : (acc ? childrenOf(acc._name).find((n) => n._name === part) : undefined), undefined);

  check("prefab 有根节点", !!byName("NpcDialog"));
  check("根节点尺寸 1920×324", byName("NpcDialog")._components.some((c) => {
    const comp = objs[c.__id__];
    return comp.__type__ === "cc.UITransform" && comp._contentSize.width === 1920 && comp._contentSize.height === 324;
  }));
  const required = [
    "Backdrop", "TopLine", "Header/Name", "Header/Meta", "Header/PortraitGlyph", "Header/Hint",
    "Header/CloseButton", "Body/Text", "Footer/PageLabel", "Footer/Dots", "Footer/KeyHint",
    "Footer/Actions/AcceptButton", "Footer/Actions/SubmitButton", "Footer/Actions/NextButton",
  ];
  for (const p of required) check(`prefab 缺节点 ${p}`, !!pathOf(p));
  const componentTypes = (p) => (pathOf(p) ? pathOf(p)._components.map((c) => objs[c.__id__].__type__) : []);
  check("正文是 Label", componentTypes("Body/Text").indexOf("cc.Label") !== -1);
  check("底板是 Sprite", componentTypes("Backdrop").indexOf("cc.Sprite") !== -1);
  for (const b of ["Header/CloseButton", "Footer/Actions/AcceptButton", "Footer/Actions/SubmitButton", "Footer/Actions/NextButton"]) {
    check(`${b} 有 Button`, componentTypes(b).indexOf("cc.Button") !== -1);
  }
  // 按钮组用 cc.Layout 横向自适应、从右向左排序（#1348）：防止被改回手动摆位
  check("Actions 有 cc.Layout", componentTypes("Footer/Actions").indexOf("cc.Layout") !== -1);
  const actionsNode = pathOf("Footer/Actions");
  const layout = actionsNode && objs[actionsNode._components.map((c) => c.__id__).find((id) => objs[id].__type__ === "cc.Layout")];
  check("Layout 横向（_layoutType=1）", layout && layout._layoutType === 1, layout && `layoutType=${layout._layoutType}`);
  check("Layout 从右向左（_horizontalDirection=1）", layout && layout._horizontalDirection === 1, layout && `horizDir=${layout._horizontalDirection}`);
  check("Layout 容器宽自适应（_resizeMode=1）", layout && layout._resizeMode === 1, layout && `resizeMode=${layout._resizeMode}`);
  const spriteUuid = "3c6f7b8e-4d21-4f9a-9c30-8b5e2a1d7f44@f9941";
  const backdrop = objs[pathOf("Backdrop")._components.map((c) => c.__id__).find((id) => objs[id].__type__ === "cc.Sprite")];
  check("底板引用入库的纯色图", backdrop._spriteFrame && backdrop._spriteFrame.__uuid__ === spriteUuid);
  const gitIgnore = readRepo(".gitignore");
  // #1348：prefab 移到 ui/prefabs 正常入库，resources 不再有白名单特例
  check("prefab 已移出 resources", !fs.existsSync(path.join(PROJECT_ROOT, "assets/resources/ui/NpcDialog.prefab")));
  check(".gitignore 无 resources 白名单特例", gitIgnore.indexOf("!client/assets/resources/ui/") === -1);

  // ── C. 接线 ──
  const talk = read("assets/ui/utils/net/QuestTalk.ts");
  check("QuestTalk 打开对话条", /NpcDialog\.open\(npcId, result\.dialog, result\.quests\)/.test(talk));
  check("QuestTalk 仍先合并任务状态", talk.indexOf("QuestStore.applyState(state)") < talk.indexOf("NpcDialog.open"));
  const game = read("assets/ui/Game.ts");
  check("Game.onDestroy 清对话条", /NpcDialog\.clear\(\)/.test(game));
  // #1348 静态注入：Game 用 @property(Prefab) 持有 prefab，start 里注入；场景字段 uuid 与 prefab meta 一致
  check("Game 有 @property(Prefab) npcDialogPrefab", /@property\(\{\s*type:\s*Prefab\s*\}\)[\s\S]{0,160}npcDialogPrefab/.test(game));
  check("Game.start 注入 prefab", /NpcDialog\.setPrefab\(this\.npcDialogPrefab\)/.test(game));
  const prefabMeta = JSON.parse(read("assets/ui/prefabs/NpcDialog.prefab.meta"));
  const sceneText = read("assets/scenes/Game.scene");
  const sceneUuid = /"npcDialogPrefab"\s*:\s*\{\s*"__uuid__"\s*:\s*"([0-9a-f-]+)"/.exec(sceneText);
  check("Game.scene 注入 prefab uuid", !!sceneUuid, sceneUuid && sceneUuid[1]);
  check("场景引用 uuid == prefab meta uuid", !!sceneUuid && sceneUuid[1] === prefabMeta.uuid,
    sceneUuid && `scene=${sceneUuid[1]} meta=${prefabMeta.uuid}`);
  const dialog = read("assets/ui/components/dialogs/NpcDialog.ts");
  check("NPC 名字取快照配置", /npcs\.get\(NpcDialog\.npcId\)/.test(dialog));
  check("翻页用共享纯函数", /paginateDialog\(/.test(dialog));
  check("节点名不外泄到组件", !/getChildByName\(["']/.test(dialog));
  check("不再走 resources.load", !/resources\.load\s*\(/.test(dialog));
  check("提供 setPrefab 注入口", /static setPrefab\(/.test(dialog));
} catch (error) {
  failures += 1;
  console.log("  [!!] 单测抛异常：", error && error.stack ? error.stack.split("\n").slice(0, 3).join("\n") : error);
}

if (failures > 0) {
  console.log(`FAIL：${failures} 项`);
  process.exit(1);
}
console.log("PASS：分页纯函数 / prefab 结构 / 接线全部通过");
