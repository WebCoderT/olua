import { instantiate, Label, Node, Prefab, UITransform } from "cc";
import SoundManager from "../../core/SoundManager";
import { growthEntryButton } from "../../../configs/layout/hud";
import { blockClickThrough } from "../../utils/input/UiHit";
import GrowthEntryButton from "./GrowthEntryButton";

/** 入口 key → 点击回调（key 见 `growthEntryButton.entries`，改名要同步那里） */
export type GrowthEntryHandlers = Record<string, () => void>;

/**
 * 成长线入口行（稿 04-hud `.nav-sub`：悬在底部功能按键排正上方的胶囊排，#1381/#1387）
 *
 * 样式只有一份：通用单按钮 prefab `ui/prefabs/hud/GrowthEntryButton.prefab`
 * （胶囊底 + 描边/图标 + 文字），由 Game 场景注入（同 #1348 / #1361 口径），
 * 编辑器里改这一份 prefab 即可改所有入口按钮的版式。
 *
 * 本组件按 `growthEntryButton.entries` 配置实例化 N 份：
 * - 传**名称**（label → prefab 内 Label 节点文字）
 * - 传**图标**（kind → GrowthEntryButton 组件属性，改写后 repaint）
 * - 横排等间距摆放（间距见 `growthEntryButton.gap`）
 *
 * 点击回调由 BottomBar 按 key 接；缺 prefab / 缺回调只告警不让整块 HUD 崩（#1357 口径）。
 */
export default class GrowthEntries extends Node {
  constructor(prefab: Prefab, handlers: GrowthEntryHandlers) {
    super("growth_entries");
    if (!prefab) {
      console.warn("[growth-entries] prefab 未注入：请确认 Game 场景的 growthEntryPrefab 字段已绑定");
      return;
    }
    const { entries, gap, labelNode } = growthEntryButton;
    const sample = instantiate(prefab) as Node;
    const size = sample.getComponent(UITransform)!.contentSize;
    sample.destroy();
    const total = entries.length * size.width + Math.max(entries.length - 1, 0) * gap;
    this.addComponent(UITransform).setContentSize(total, size.height);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const btn = instantiate(prefab) as Node;
      // 图标：kind 由配置传入（prefab 里是默认值），改写后立即重画
      const look = btn.getComponent(GrowthEntryButton);
      if (look) {
        look.kind = entry.kind;
        look.repaint();
      } else {
        console.warn("[growth-entries] prefab 缺 GrowthEntryButton 组件，图标用 prefab 默认");
      }
      // 名称：label 由配置传入；左缘固定在图标右侧（图标中心 -w/2+16 → 右缘约 -w/2+23，留 5px），
      // overflow 改 NONE 让 Label 自适应宽度，位置按字数估宽（中文 ≈ fontSize/字；Latin 略窄，可接受）
      const labelComp = btn.getChildByPath(labelNode)?.getComponent(Label) as Label | undefined;
      if (labelComp) {
        labelComp.overflow = Label.Overflow.NONE;
        labelComp.string = entry.label;
        const textW = entry.label.length * labelComp.fontSize;
        labelComp.node.setPosition(-size.width / 2 + 28 + textW / 2, 0, 0);
      } else {
        console.warn(`[growth-entries] prefab 缺文字节点: ${labelNode}`);
      }
      // 摆位：横排等间距
      btn.setPosition(-total / 2 + size.width / 2 + i * (size.width + gap), 0, 0);
      // 鼠标通道登记（点击不穿透到世界）+ 点击音 + 回调
      blockClickThrough(btn);
      SoundManager.bindClick(btn);
      const handler = handlers[entry.key];
      if (handler) btn.on(Node.EventType.TOUCH_END, handler, this);
      else console.warn(`[growth-entries] 入口 ${entry.key} 没有接点击回调`);
      this.addChild(btn);
    }
  }
}
