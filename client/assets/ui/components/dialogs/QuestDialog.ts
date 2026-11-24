import { Graphics, isValid, Label, Node, ScrollView, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import QuestStore from "../../core/QuestStore";
import type { QuestView } from "../../core/QuestStore";
import UiHelper from "../../helpers/UiHelper";
import { QuestApi } from "../../utils/net/Api";
import { QUEST_OBJECTIVE_LABELS } from "../../../configs/game-config";
import { monsterLabelOf } from "../../../configs/game-config";
import { npcs } from "../../../configs/game-config";
import { items } from "../../../configs/items";
import { questDialogLayout as layout } from "../../../configs/hudLayout";
import { buttonTone } from "../../../configs/hudLayout";
import type { ButtonTone } from "../../../configs/hudLayout";
import { clearChildren } from "../../utils/node/NodeTree";
import BaseDialog from "./dialog-kit";
import { createTabStrip, paintTabStrip } from "./tab-kit";

/** 两个页签（进行中 / 可接） */
type QuestTab = "active" | "available";

/** 页签顺序（与 layout.tabs.columns / layout.texts.tabs 一一对应） */
const TABS: QuestTab[] = ["active", "available"];

/**
 * 任务弹窗（#396：进行中 / 可接，接取与交付都在这里）
 *
 * ## 数据从哪来
 * 配置与我的状态都在 `QuestStore`（快照 + `/quests/me` + realtime `quest` 帧的合成）。
 * 弹窗只做两件事：**打开时拉一次全量**（`refresh`，服务端是权威）、**动作后吃响应**
 * （接取 / 交付的响应都带最新快照，`applyStates` 直接覆盖 —— 不必再请求一次，
 * 也就不会出现「提示成功了列表还是旧的」）。
 *
 * ## 为什么接取 / 交付不需要站在 NPC 旁边
 * v1 的取舍：服务端只校验等级、前置链与背包（`accept` / `submit` 都不看坐标），
 * 客户端也不做距离判定。理由是本项目的移动是**客户端权威**的（位置由客户端上报），
 * 拿它当准入判据等于让客户端自己说了算 —— 要真做距离校验得先把位置收归服务端。
 * NPC 头顶点 `!` / `?` 是引导，不是门禁。
 *
 * ## 交付后的奖励
 * 服务端把这次的奖励结算随响应带回（绑定元宝 / 经验 / 物品 / 是否升级），这里直接飘字，
 * 不再自己算一遍 —— 数值口径只有一处。
 */
export default class QuestDialog extends BaseDialog {
  /** 当前页签 */
  private tab: QuestTab = "active";
  /** 页签底图与文字（选中态重画） */
  private tabNodes = new Map<QuestTab, Node>();
  private tabLabels = new Map<QuestTab, Node>();
  /** QuestStore 订阅（打开期间有效；关闭时退订） */
  private unsubscribe: (() => void) | null = null;
  /** 正在动作中的任务 id（防连点；响应回来后清） */
  private busyQuestId = "";

  /** 打开 / 关闭弹窗（重复点即关闭） */
  open() {
    this.openFrame(layout, () => {
      this.createTabs();
      this.unsubscribe = QuestStore.onChange(() => {
        this.refreshTabCaptions();
        this.render();
      });
      this.select("active");
      // 打开即对账：帧只推变化，断线/多端切换后本地可能落后
      void this.refresh();
    });
  }

  /** 关闭弹窗时退订（销毁与清引用在 BaseDialog.close） */
  protected onClose() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  //#region 页签

  private createTabs() {
    const dialog = this.dialog;
    if (!dialog) return;
    const { nodes, labels } = createTabStrip(dialog, layout.name, TABS, layout.texts.tabs, layout.tabs, (tab) => this.select(tab));
    this.tabNodes = nodes;
    this.tabLabels = labels;
  }

  /** 切换页签（清空内容区重画） */
  private select(tab: QuestTab) {
    this.tab = tab;
    this.paintTabs();
    this.refreshTabCaptions();
    this.render();
  }

  private paintTabs() {
    paintTabStrip(this.tabNodes, this.tabLabels, TABS, this.tab, layout.tabs);
  }

  /** 页签角标：可交付数 / 可接数（数字才值得提醒，进行中不算） */
  private refreshTabCaptions() {
    const readyCount = QuestStore.active().filter((view) => view.status === "ready").length;
    const availableCount = QuestStore.available().length;
    const counts: Record<QuestTab, number> = { active: readyCount, available: availableCount };
    TABS.forEach((tab, index) => {
      const labelNode = this.tabLabels.get(tab);
      if (!labelNode || !isValid(labelNode)) return;
      const label = labelNode.getComponent(Label);
      if (!label) return;
      const base = layout.texts.tabs[index];
      const count = counts[tab];
      label.string = count > 0 ? `${base}·${count}` : base;
    });
  }

  //#endregion

  //#region 渲染

  private render() {
    const body = this.body;
    if (!body || !isValid(body)) return;
    clearChildren(body);
    const views = this.tab === "active" ? QuestStore.active() : QuestStore.available();
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    if (views.length === 0) {
      const emptyText = this.tab === "active" ? layout.texts.activeEmpty : layout.texts.availableEmpty;
      content.addChild(UiHelper.createLabel("quest_empty", emptyText, layout.row.metaColor, layout.row.textFontSize, new Vec2(), new Size(layout.row.size.width, 32)));
      return;
    }
    views.forEach((view) => content.addChild(this.createRow(view)));
  }

  /**
   * 一行任务（稿 `.qrow2`）：名称 + 状态/进度（左）+ 奖励列（右二）+ 动作（右一）
   *
   * 可交付行整行换玉色描边与淡染底（稿 `.qrow2.ready`，配色与详情卡同值）。
   */
  private createRow(view: QuestView) {
    const row = layout.row;
    const ready = view.status === "ready";
    const node = UiHelper.createNode(`quest_row_${view.quest.id}`, new Vec2(), row.size);
    const graphics = node.addComponent(Graphics);
    UiHelper.paintRoundedPanel(graphics, row.size, row.radius, ready ? row.readyFill : row.fill, ready ? row.readyBorder : row.border);

    node.addChild(
      UiHelper.createLabel(
        `quest_row_name_${view.quest.id}`,
        view.quest.label,
        row.nameColor,
        row.nameFontSize,
        new Vec2(row.nameX, row.nameY),
        row.nameSize,
        Label.HorizontalAlign.LEFT,
      ),
    );

    // 第二行：进行中看进度，可交付看「可交付」，可接看目标
    let meta = "";
    let metaColor = row.metaColor;
    if (view.status === "ready") {
      meta = layout.texts.ready;
      metaColor = row.readyColor;
    } else if (view.status === "accepted") {
      meta = layout.texts.progress.split("{done}").join(`${view.progress}`).split("{total}").join(`${view.target}`);
    } else {
      meta = layout.texts.objective
        .split("{type}")
        .join(QUEST_OBJECTIVE_LABELS[view.quest.objective.type] ?? view.quest.objective.type)
        .split("{target}")
        .join(this.targetName(view))
        .split("{count}")
        .join(`${view.quest.objective.count}`);
    }
    node.addChild(
      UiHelper.createLabel(
        `quest_row_meta_${view.quest.id}`,
        meta,
        metaColor,
        row.textFontSize,
        new Vec2(row.metaX, -12),
        row.metaSize,
        Label.HorizontalAlign.LEFT,
      ),
    );

    // 奖励列（稿 `.qrow2 .reward`：右对齐两行，经验 + 绑元，零值不显示整块）
    const rewardLines: string[] = [];
    if (view.quest.rewards.exp > 0) rewardLines.push(layout.texts.rewardExp.split("{value}").join(`${view.quest.rewards.exp}`));
    if (view.quest.rewards.bindGold > 0) rewardLines.push(layout.texts.rewardBindGold.split("{value}").join(`${view.quest.rewards.bindGold}`));
    if (rewardLines.length > 0) {
      node.addChild(
        UiHelper.createLabel(
          `quest_row_reward_${view.quest.id}`,
          rewardLines.join("\n"),
          row.rewardColor,
          row.rewardFontSize,
          new Vec2(row.rewardX, 0),
          row.rewardSize,
          Label.HorizontalAlign.RIGHT,
          Label.VerticalAlign.CENTER,
        ),
      );
    }

    // 动作区（右一）：可接 = ghost 接取；可交付 = 金键交付；进行中 = 灰角标（只示意状态，不可点）
    if (view.status === "available") {
      node.addChild(this.createAction(`quest_accept_${view.quest.id}`, layout.texts.accept, new Vec2(row.buttonX, 0), () => this.accept(view), buttonTone.ghost));
    } else if (view.status === "ready") {
      node.addChild(this.createAction(`quest_submit_${view.quest.id}`, layout.texts.submit, new Vec2(row.buttonX, 0), () => this.submit(view), buttonTone.gold));
    } else {
      node.addChild(this.createStateBadge(view));
    }
    return node;
  }

  /** 行内动作按钮（稿 `.btn--xs` 64×24 行内档，色调由状态决定：金=交付 / ghost=接取） */
  private createAction(name: string, text: string, position: Vec2, onTap: () => void, tone: ButtonTone) {
    const button = GameUiHelper.createToneButton(name, text, position, layout.row.actionSize, layout.row.actionFontSize, tone);
    button.on(Node.EventType.TOUCH_END, onTap, this);
    return button;
  }

  /** 「进行中」灰角标（稿 `.badge--muted`：与详情弹窗角标同配色，纯示意不可点） */
  private createStateBadge(view: QuestView) {
    const badge = layout.badge;
    const width = badge.text.length * badge.fontSize + 16;
    const size = new Size(width, badge.height);
    const node = UiHelper.createNode(`quest_row_badge_${view.quest.id}`, new Vec2(layout.row.buttonX, 0), size);
    const graphics = node.addComponent(Graphics);
    // 徽标无独立描边：fill 与 border 同色，paintRoundedPanel 画出来就是一块均匀淡染
    UiHelper.paintRoundedPanel(graphics, size, 2, badge.activeFill, badge.activeFill);
    node.addChild(UiHelper.createLabel(`${node.name}_text`, badge.text, badge.activeText, badge.fontSize, new Vec2(), size));
    return node;
  }

  //#endregion

  //#region 动作

  /** 全量对账（失败静默：任务面板拉不到不该打断游戏，玩家再点一次即可） */
  private async refresh(): Promise<void> {
    try {
      QuestStore.applyStates((await QuestApi.mine()).quests);
    } catch {
      /* 请求层已统一提示 */
    }
  }

  /** 接取：服务端复核等级 / 前置链，响应即最新快照 */
  private async accept(view: QuestView): Promise<void> {
    if (this.busyQuestId) return;
    this.busyQuestId = view.quest.id;
    try {
      QuestStore.applyStates((await QuestApi.accept({ questId: view.quest.id })).quests);
      GameUiHelper.createTipText(layout.texts.acceptedTip.split("{name}").join(view.quest.label));
    } catch {
      /* 错误文案由请求层统一弹出（20015 / 20016 说得比这里具体） */
    } finally {
      this.busyQuestId = "";
    }
  }

  /** 交付：奖励结算随响应回来，直接飘字（数值口径只有服务端一处） */
  private async submit(view: QuestView): Promise<void> {
    if (this.busyQuestId) return;
    this.busyQuestId = view.quest.id;
    try {
      const result = await QuestApi.submit({ questId: view.quest.id });
      QuestStore.applyStates(result.quests);
      const reward = layout.texts.rewards
        .split("{bindGold}")
        .join(`${result.reward.bindGold}`)
        .split("{exp}")
        .join(`${result.reward.exp}`);
      GameUiHelper.createTipText(reward);
      // 客户端里的绑定元宝/经验与等级由存档同步链自己刷新（服务端已落库，下一次同步带回）
    } catch {
      /* 同上：材料不足 / 背包放不下都由服务端给具体原因 */
    } finally {
      this.busyQuestId = "";
    }
  }

  //#endregion

  //#region 零件

  /** 目标键 → 可读名字（怪物 / NPC / 物品三张表轮流查；查不到原样显示键） */
  private targetName(view: QuestView): string {
    const key = view.quest.objective.target;
    const type = view.quest.objective.type;
    if (type === "kill") return monsterLabelOf(key);
    if (type === "talk") return npcs.get(key)?.label ?? key;
    return items.get(key)?.label ?? key;
  }

  //#endregion

  /** 释放引用（关闭后） */
  protected reset() {
    this.tab = "active";
    this.busyQuestId = "";
    this.tabNodes.clear();
    this.tabLabels.clear();
  }
}
