import { Color, Graphics, isValid, Label, Node, Size, Vec2 } from "cc";
import UiHelper from "../../helpers/UiHelper";
import { blockClickThrough } from "../../utils/input/UiHit";

/**
 * 多页弹窗的公共零件（聊天 / 任务 / 队伍 / 排行榜 / 社交 / 成就六个弹窗共用）
 *
 * 页签条的「建出来 + 重画选中态」与行底板的「圆角填充 + 描边」在这六个弹窗里逐字相同，
 * 收到这里；各弹窗保留自己的 select 语义（标已读 / 重画内容）与页签角标。
 */

/** 页签条的几何与配色（各弹窗 layout.tabs 的公共形状，多余字段无妨） */
export interface TabStripStyle {
  y: number;
  size: Size;
  columns: number[];
  radius: number;
  activeFill: Color;
  activeText: Color;
  idleFill: Color;
  idleText: Color;
  idleBorder: Color;
  fontSize: number;
}

/** 建一排页签挂到弹窗上（texts 与 tabs 一一对应；点击回调由调用方给） */
export function createTabStrip<T extends string>(
  dialog: Node,
  namePrefix: string,
  tabs: readonly T[],
  texts: readonly string[],
  style: TabStripStyle,
  onSelect: (tab: T) => void,
): { nodes: Map<T, Node>; labels: Map<T, Node> } {
  const nodes = new Map<T, Node>();
  const labels = new Map<T, Node>();
  tabs.forEach((tab, index) => {
    const node = UiHelper.createNode(`${namePrefix}_tab_${tab}`, new Vec2(style.columns[index], style.y), style.size);
    node.addComponent(Graphics);
    const label = UiHelper.createLabel(
      `${namePrefix}_tab_${tab}_label`,
      texts[index],
      style.idleText,
      style.fontSize,
      new Vec2(),
      style.size,
    );
    node.addChild(label);
    node.on(Node.EventType.TOUCH_END, () => onSelect(tab));
    blockClickThrough(node);
    dialog.addChild(node);
    nodes.set(tab, node);
    labels.set(tab, label);
  });
  return { nodes, labels };
}

/** 重画页签选中态（选中金底暗字，未选中暗底描边亮字） */
export function paintTabStrip<T extends string>(
  nodes: Map<T, Node>,
  labels: Map<T, Node>,
  tabs: readonly T[],
  active: T,
  style: TabStripStyle,
): void {
  tabs.forEach((tab) => {
    const node = nodes.get(tab);
    const labelNode = labels.get(tab);
    if (!node || !isValid(node) || !labelNode) return;
    const isActive = tab === active;
    const graphics = node.getComponent(Graphics);
    if (graphics) {
      const half = style.size;
      graphics.clear();
      graphics.roundRect(-half.width / 2, -half.height / 2, half.width, half.height, style.radius);
      graphics.fillColor = isActive ? style.activeFill : style.idleFill;
      graphics.fill();
      if (!isActive) {
        graphics.lineWidth = 1;
        graphics.strokeColor = style.idleBorder;
        graphics.roundRect(-half.width / 2, -half.height / 2, half.width, half.height, style.radius);
        graphics.stroke();
      }
    }
    const label = labelNode.getComponent(Label);
    if (label) label.color = isActive ? style.activeText : style.idleText;
  });
}

/** 圆角底板（行底 / 面板）：填充 + 1px 描边 + 挡点击穿透；尺寸与配色由调用方给 */
export function createRoundedPanel(name: string, size: Size, fill: Color, border: Color, radius: number): Node {
  const node = UiHelper.createNode(name, new Vec2(), size);
  const graphics = node.addComponent(Graphics);
  const path = () => graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, radius);
  graphics.fillColor = fill;
  path();
  graphics.fill();
  graphics.lineWidth = 1;
  graphics.strokeColor = border;
  path();
  graphics.stroke();
  blockClickThrough(node);
  return node;
}
