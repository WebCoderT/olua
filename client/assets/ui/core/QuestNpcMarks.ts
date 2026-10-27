import { isValid, Label, Node, Vec2, Vec3 } from "cc";
import QuestStore from "./QuestStore";
import LayerManager from "./LayerManager";
import UiHelper from "../helpers/UiHelper";
import { questNpcMarkLayout as layout } from "../../configs/hudLayout";

/**
 * NPC 头顶的任务标记（#396：`!` 可接 / `?` 可交付）
 *
 * ## 为什么不在 NPC 节点里挂
 * `GameUiHelper.createNpcNode` 建的是纵向 FlexCol（名字 + 立绘），往里塞子节点会被布局重排；
 * 而 NPC 是静止的，所以这里在地图层单独放一个标签，位置 = NPC 世界坐标 + 配置的 offset。
 *
 * ## 谁更新
 * 订阅 `QuestStore.onChange` 就地刷新字符（没有可接/可交付就整块隐藏）。
 * 每个 NPC 一次订阅 —— NPC 数量是地图级常量（二十来个），不值得做共享广播。
 */
export default class QuestNpcMarks {
  /** npcId → 标记节点与退订函数（reset 时统一清） */
  private static marks = new Map<string, { node: Node; unsubscribe: () => void }>();

  /** 给一个已落位的 NPC 节点挂标记（MapObjectSpawner 在设完世界坐标后调用） */
  static attach(npcNode: Node, npcId: string): void {
    this.detach(npcId);
    const node = UiHelper.createLabel(
      `${layout.name}_${npcId}`,
      "",
      layout.availableColor,
      layout.fontSize,
      new Vec2(),
      layout.size,
    );
    // 与 NPC 同一个世界坐标，再按配置抬到头顶
    const origin = npcNode.getWorldPosition();
    node.setWorldPosition(new Vec3(origin.x + layout.offset.x, origin.y + layout.offset.y, origin.z));
    LayerManager.addToMapLayer(node);
    const unsubscribe = QuestStore.onChange(() => this.paint(npcId));
    this.marks.set(npcId, { node, unsubscribe });
    this.paint(npcId);
  }

  /** 清掉全部标记（切图 / 退出游戏：Game.destroy 调用） */
  static reset(): void {
    for (const npcId of [...this.marks.keys()]) this.detach(npcId);
  }

  /** 按当前状态刷新一个 NPC 的标记 */
  private static paint(npcId: string): void {
    const entry = this.marks.get(npcId);
    if (!entry || !isValid(entry.node)) return;
    const mark = QuestStore.markOf(npcId);
    const label = entry.node.getComponent(Label);
    entry.node.active = mark !== null;
    if (!mark || !label) return;
    label.string = mark === "?" ? layout.texts.ready : layout.texts.available;
    label.color = mark === "?" ? layout.readyColor : layout.availableColor;
  }

  /** 摘掉一个 NPC 的标记（重复挂 / 重进图先摘干净） */
  private static detach(npcId: string): void {
    const entry = this.marks.get(npcId);
    if (!entry) return;
    entry.unsubscribe();
    if (isValid(entry.node)) entry.node.destroy();
    this.marks.delete(npcId);
  }
}
