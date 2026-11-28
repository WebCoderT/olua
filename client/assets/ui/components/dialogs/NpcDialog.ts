import {
  Button,
  EventKeyboard,
  Input,
  isValid,
  KeyCode,
  Label,
  Node,
  Prefab,
  UITransform,
  input,
  instantiate,
  resources,
} from "cc";
import { npcs } from "../../../configs/game-config";
import { npcDialogLayout, npcDialogTexts } from "../../../configs/layout/dialogs/npcDialog";
import { getText } from "../../../configs/texts";
import { designResolution } from "../../utils/layout/ScreenLayout";
import { paginateDialog } from "../../utils/dialog/npc-dialog-pages";
import { blockClickThrough } from "../../utils/input/UiHit";
import { QuestApi } from "../../utils/net/Api";
import type { QuestState } from "../../utils/net/ApiModels";
import QuestStore from "../../core/QuestStore";
import SoundManager from "../../core/SoundManager";
import LayerManager from "../../core/LayerManager";
import GameUiHelper from "../../helpers/GameUiHelper";

/** 一次对话里最多给两个任务快捷按钮（可接 + 可交付各一个，多了挤不下） */
const MAX_ACTIONS = 2;

type DialogAction = { kind: "accept" | "submit"; questId: string };

/**
 * 通用 NPC 对话框（#1337）
 *
 * 面板本体在 `resources/ui/NpcDialog.prefab`，改版式直接在 Cocos 编辑器里改 prefab；
 * 本类只负责四件事：加载实例 → 贴到屏幕底边 → 填文案/翻页 → 任务快捷按钮。
 * 节点名集中在 `npcDialogLayout.nodes`；同名节点不存在时只警告，不让整块 UI 崩掉。
 */
export default class NpcDialog {
  private static node: Node | null = null;
  private static npcId = "";
  private static prefab: Prefab | null = null;
  private static loading: Promise<Prefab | null> | null = null;
  private static pages: string[] = [];
  private static pageIndex = 0;
  private static actions: DialogAction[] = [];
  private static busy = false;

  /** 打开（或刷新）对话框：无文案且无可操作任务时静默跳过，专属 NPC 弹窗不受影响 */
  static open(npcId: string, dialog: string, quests: QuestState[] = []): void {
    const actions = actionsOf(quests);
    const text = dialog && dialog.trim().length > 0 ? dialog : getText(npcDialogTexts.intro);
    if (!dialog && actions.length === 0) return;
    NpcDialog.npcId = npcId;

    NpcDialog.pages = paginateDialog(text, {
      maxChars: npcDialogLayout.maxChars,
      maxLines: npcDialogLayout.maxLines,
      emptyText: getText(npcDialogTexts.empty),
    });
    NpcDialog.pageIndex = 0;
    NpcDialog.actions = actions;
    NpcDialog.busy = false;

    if (NpcDialog.node && isValid(NpcDialog.node) && NpcDialog.node.active) {
      NpcDialog.render();
      NpcDialog.node.setSiblingIndex(NpcDialog.node.parent ? NpcDialog.node.parent.children.length : 0);
      return;
    }
    NpcDialog.node = null;
    NpcDialog.load().then((prefab) => {
      if (!prefab) return;
      if (!NpcDialog.node) NpcDialog.node = NpcDialog.mount(prefab);
      NpcDialog.render();
    });
  }

  static close(): void {
    if (NpcDialog.node && isValid(NpcDialog.node)) NpcDialog.node.destroy();
    NpcDialog.node = null;
    NpcDialog.pages = [];
    NpcDialog.actions = [];
    NpcDialog.busy = false;
  }

  /** 场景销毁时可主动清引用（节点销毁监听里也会自清） */
  static clear(): void {
    NpcDialog.close();
  }

  private static load(): Promise<Prefab | null> {
    if (NpcDialog.prefab) return Promise.resolve(NpcDialog.prefab);
    if (NpcDialog.loading) return NpcDialog.loading;
    NpcDialog.loading = new Promise<Prefab | null>((resolve) => {
      resources.load(npcDialogLayout.prefabPath, Prefab, (err, prefab) => {
        if (err || !prefab) {
          console.warn("[npc-dialog] prefab 加载失败：", err && err.message);
          resolve(null);
          return;
        }
        NpcDialog.prefab = prefab;
        resolve(prefab);
      });
    }).then((prefab) => {
      NpcDialog.loading = null;
      return prefab;
    });
    return NpcDialog.loading;
  }

  private static mount(prefab: Prefab): Node {
    const node = instantiate(prefab);
    const transform = node.getComponent(UITransform);
    const height = transform ? transform.contentSize.height : npcDialogLayout.size.height;
    // UILayer 以屏幕中心为原点（见 LayerManager.initLayer）；面板锚点 0.5/0.5，
    // 因此 y = -设计半屏 + 面板半高，正好贴底边。宽度沿用 prefab，代码不覆写。
    node.setPosition(0, -designResolution.height / 2 + height / 2, 0);
    LayerManager.addToUILayer(node);
    blockClickThrough(node);

    const nodes = npcDialogLayout.nodes;
    NpcDialog.bindButton(node, nodes.close, () => NpcDialog.close());
    NpcDialog.bindButton(node, nodes.next, () => NpcDialog.advance());
    NpcDialog.bindButton(node, nodes.accept, () => NpcDialog.runAction("accept"));
    NpcDialog.bindButton(node, nodes.submit, () => NpcDialog.runAction("submit"));
    const textNode = node.getChildByName(nodes.text);
    if (textNode) {
      // 正文整块可点翻页：它自己也要占住鼠标通道，否则这一下会穿透到底下的世界/HUD
      blockClickThrough(textNode);
      textNode.on(Node.EventType.TOUCH_END, () => NpcDialog.advance(), NpcDialog);
    }
    node.once(Node.EventType.NODE_DESTROYED, () => {
      input.off(Input.EventType.KEY_DOWN, NpcDialog.onKeyDown, NpcDialog);
      if (NpcDialog.node === node) NpcDialog.node = null;
    });
    input.on(Input.EventType.KEY_DOWN, NpcDialog.onKeyDown, NpcDialog);
    return node;
  }

  private static bindButton(root: Node, name: string, handler: () => void): void {
    const target = root.getChildByPath(NpcDialog.pathOf(name));
    if (!target) return;
    SoundManager.bindClick(target);
    const button = target.getComponent(Button);
    if (button) target.on(Button.EventType.CLICK, handler, NpcDialog);
  }

  /** 节点名都在 prefab 的父子层级里，路径在布局配置旁边拼，避免组件里散写字符串 */
  private static pathOf(name: string): string {
    const nodes = npcDialogLayout.nodes;
    if (name === nodes.name || name === nodes.meta || name === nodes.portraitGlyph || name === nodes.hint) {
      return "Header/" + name;
    }
    if (name === nodes.text) return "Body/" + name;
    if (name === nodes.page || name === nodes.dots || name === nodes.keyHint) return "Footer/" + name;
    if (name === nodes.accept || name === nodes.submit || name === nodes.next) return npcDialogLayout.paths.actions + name;
    return name;
  }

  private static onKeyDown(event: EventKeyboard): void {
    if (event.keyCode === KeyCode.ENTER) NpcDialog.advance();
    if (event.keyCode === KeyCode.ESCAPE) NpcDialog.close();
  }

  private static advance(): void {
    if (NpcDialog.pageIndex + 1 < NpcDialog.pages.length) {
      NpcDialog.pageIndex += 1;
      NpcDialog.render();
    } else {
      NpcDialog.close();
    }
  }

  private static render(): void {
    const root = NpcDialog.node;
    if (!root || !isValid(root) || !root.active) return;
    const nodes = npcDialogLayout.nodes;
    // NPC 名字取客户端快照（服务端 npcs 表整表下发），没配过名字时用统一兜底文案
    const label = (npcs.get(NpcDialog.npcId) && npcs.get(NpcDialog.npcId)!.label) || getText(npcDialogTexts.unknownNpc);
    NpcDialog.setString(root, "Header/" + nodes.name, label);
    NpcDialog.setString(root, "Header/" + nodes.meta, getText(npcDialogTexts.meta, { id: NpcDialog.npcId }));
    NpcDialog.setString(root, "Header/" + nodes.portraitGlyph, label.slice(0, 1));
    NpcDialog.setString(root, "Header/" + nodes.hint, getText(npcDialogTexts.hint));
    NpcDialog.setString(root, "Body/" + nodes.text, NpcDialog.pages[NpcDialog.pageIndex] || "");
    NpcDialog.setString(root, "Footer/" + nodes.page, `${NpcDialog.pageIndex + 1} / ${NpcDialog.pages.length}`);
    NpcDialog.setString(root, "Footer/" + nodes.keyHint, getText(npcDialogTexts.keyHint));

    const dots = root.getChildByPath("Footer/" + nodes.dots);
    if (dots) {
      for (let i = 0; i < dots.children.length; i++) dots.children[i].active = i < NpcDialog.pageIndex + 1 && i < npcDialogLayout.maxDots;
    }
    const accept = NpcDialog.actionNode(root, "accept");
    const submit = NpcDialog.actionNode(root, "submit");
    if (accept) accept.active = NpcDialog.hasAction("accept");
    if (submit) submit.active = NpcDialog.hasAction("submit");
    const next = NpcDialog.actionNode(root, "next");
    if (next) {
      const done = NpcDialog.pageIndex + 1 >= NpcDialog.pages.length;
      NpcDialog.setString(root, NpcDialog.pathOf(nodes.next), done ? getText(npcDialogTexts.done) : getText(npcDialogTexts.next));
      if (next.getComponent(Button)) next.getComponent(Button)!.interactable = !NpcDialog.busy;
    }
  }

  private static setString(root: Node, path: string, value: string): void {
    const node = root.getChildByPath(path);
    if (!node) return;
    const label = node.getComponent(Label);
    if (label) label.string = value;
  }

  private static actionNode(root: Node, kind: "accept" | "submit" | "next"): Node | null {
    const name = kind === "accept" ? npcDialogLayout.nodes.accept : kind === "submit" ? npcDialogLayout.nodes.submit : npcDialogLayout.nodes.next;
    return root.getChildByPath(NpcDialog.pathOf(name));
  }

  private static hasAction(kind: "accept" | "submit"): boolean {
    for (let i = 0; i < NpcDialog.actions.length; i++) {
      if (NpcDialog.actions[i].kind === kind) return true;
    }
    return false;
  }

  private static async runAction(kind: "accept" | "submit"): Promise<void> {
    if (NpcDialog.busy) return;
    let action: DialogAction | null = null;
    for (let i = 0; i < NpcDialog.actions.length; i++) {
      if (NpcDialog.actions[i].kind === kind) action = NpcDialog.actions[i];
    }
    if (!action) return;
    NpcDialog.busy = true;
    NpcDialog.render();
    try {
      if (kind === "accept") {
        QuestStore.applyStates((await QuestApi.accept({ questId: action.questId })).quests);
        GameUiHelper.createTipText(getText(npcDialogTexts.accepted));
      } else {
        const result = await QuestApi.submit({ questId: action.questId });
        QuestStore.applyStates(result.quests);
        GameUiHelper.createTipText(
          getText(npcDialogTexts.submitted, { exp: result.reward.exp, bindGold: result.reward.bindGold }),
        );
      }
      NpcDialog.close();
    } catch {
      // 业务失败文案由请求层统一弹（等级/前置链/材料不足都有具体原因）
      NpcDialog.busy = false;
      NpcDialog.render();
    }
  }
}

/** 从服务端带回的该 NPC 任务状态里取「可接 / 可交付」各一个，顺序固定：交付优先 */
export function actionsOf(quests: QuestState[]): DialogAction[] {
  const result: DialogAction[] = [];
  for (let i = 0; i < quests.length && result.length < MAX_ACTIONS; i++) {
    const q = quests[i];
    if (q.status === "ready") result.push({ kind: "submit", questId: q.questId });
  }
  for (let i = 0; i < quests.length && result.length < MAX_ACTIONS; i++) {
    const q = quests[i];
    if (q.status === "available") result.push({ kind: "accept", questId: q.questId });
  }
  return result;
}
