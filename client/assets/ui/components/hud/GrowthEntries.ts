import { instantiate, Node, Prefab, UITransform } from "cc";
import SoundManager from "../../core/SoundManager";
import { growthEntriesPrefab } from "../../../configs/layout/hud";
import { blockClickThrough } from "../../utils/input/UiHit";

/** 入口 key → 点击回调（称号 / 元神各一个；key 同时是节点查找的稳定名后半段） */
export type GrowthEntryHandlers = Record<string, () => void>;

/**
 * 成长线入口行（稿 04-hud `.nav-sub`：悬在底部功能按键排正上方的两颗胶囊，#1381）
 *
 * 静态外观（胶囊底 / 金描边 / 矢量图标 / 文字）全部固化在
 * `ui/prefabs/hud/GrowthEntries.prefab`，由 Game 场景注入（同 #1348 / #1361 口径），
 * 可在 Cocos 编辑器里直接可视化改版式 —— 改版式请改 prefab，别回代码拼节点。
 *
 * 本组件只做两件事：
 * 1. 实例化 prefab 并把子树挂到自身（摆位由 BottomBar.prefab 的 GrowthEntries 锚点承载）
 * 2. 按入口 key 找到节点接点击回调 + 点击音（key 见 `growthEntriesPrefab.nodes`，改名要同步那里）
 *
 * 缺 prefab / 缺节点只告警不让整块 HUD 崩（#1357 口径）。
 */
export default class GrowthEntries extends Node {
  constructor(prefab: Prefab, handlers: GrowthEntryHandlers) {
    super("growth_entries");
    if (!prefab) {
      console.warn("[growth-entries] prefab 未注入：请确认 Game 场景的 growthEntriesPrefab 字段已绑定");
      return;
    }
    const instance = instantiate(prefab) as Node;
    this.addComponent(UITransform).setContentSize(instance.getComponent(UITransform)!.contentSize);
    const children = instance.children.slice();
    for (const child of children) child.setParent(this);
    for (const key in growthEntriesPrefab.nodes) {
      const path = growthEntriesPrefab.nodes[key];
      const entry = this.getChildByPath(path);
      if (!entry) {
        console.warn(`[growth-entries] prefab 缺节点: ${path}`);
        continue;
      }
      const handler = handlers[key];
      if (!handler) continue;
      // 鼠标通道登记（点击不穿透到世界）；prefab 节点自带 UITransform，防呆不会静默跳过
      blockClickThrough(entry);
      SoundManager.bindClick(entry);
      entry.on(Node.EventType.TOUCH_END, handler, this);
    }
  }
}
