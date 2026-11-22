import { Color, Graphics, Label, Node, ScrollView, Size, Vec2, isValid } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import AutoBattle from "../../core/AutoBattle";
import QuestStore from "../../core/QuestStore";
import type { QuestView } from "../../core/QuestStore";
import UiHelper from "../../helpers/UiHelper";
import { QuestApi } from "../../utils/net/Api";
import { QUEST_OBJECTIVE_LABELS, maps, monsterLabelOf, npcs } from "../../../configs/game-config";
import { items } from "../../../configs/items";
import { questDetailDialogLayout as layout } from "../../../configs/hudLayout";
import { buttonTone } from "../../../configs/hudLayout";
import { clearChildren } from "../../utils/node/NodeTree";
import BaseDialog, { createListEmpty } from "./dialog-kit";

/**
 * 任务详情弹窗（#1191，稿 11-quest 的 `#state=detail` 面板：480×560）
 *
 * ## 与任务面板的分工
 * 面板（QuestDialog）管「接 / 交付」——按行点按钮；这里管「看得懂」——一卡一任务把
 * 描述、目标进度条、奖励明细、交付 NPC 全部展开。入口是 HUD 任务追踪块标题行的「详」。
 *
 * ## 数据从哪来（稿规格注记）
 * 描述 / 目标 / 奖励来自 quests 快照（`QuestView.quest`），进度来自 `/quests/me`
 * + realtime `quest` 帧 —— 都在 `QuestStore`，这里订阅 onChange 就地重画，
 * 打开时照面板的口径再拉一次全量对账。
 *
 * ## 「放弃」两步确认（与回收 / 丢弃 / 删角色同一套口径）
 * 首点变「确认放弃」金框，3 秒未确认复位；确认后走 `POST /quests/abandon`
 * （服务端拒绝进行中被引用的环），响应即最新快照。
 *
 * ## 「前往」= 关弹窗 + 寻路至交付 NPC
 * 交付出发前不校验距离（服务端不看坐标，移动是客户端权威）；交付 NPC 不在本地图时
 * 不做跨图传送，只提示它在哪张图。
 */
export default class QuestDetailDialog extends BaseDialog {
  /** QuestStore 订阅（打开期间有效；关闭时退订） */
  private unsubscribe: (() => void) | null = null;
  /** 正在动作中的任务 id（防连点；响应回来后清） */
  private busyQuestId = "";
  /** 待确认放弃的任务 id（两步确认的第一步） */
  private armedQuestId = "";
  /** 待确认超时定时器（到点自动复位） */
  private abandonTimer: ReturnType<typeof setTimeout> | null = null;

  /** 打开 / 关闭弹窗（重复点即关闭） */
  open() {
    this.openFrame(layout, () => {
      this.unsubscribe = QuestStore.onChange(() => this.render());
      this.render();
      // 打开即对账：帧只推变化，断线/多端切换后本地可能落后
      void this.refresh();
    });
  }

  /** 关闭弹窗时退订 + 清两步确认的定时器（销毁与清引用在 BaseDialog.close） */
  protected onClose() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.clearAbandonPending();
  }

  //#region 渲染

  private render() {
    const body = this.body;
    if (!body || !isValid(body)) return;
    clearChildren(body);
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    body.addChild(list);
    const content = list.getComponent(ScrollView)?.content;
    if (!content) return;
    const views = QuestStore.active();
    if (views.length === 0) {
      content.addChild(createListEmpty("quest_detail_empty", layout.texts.empty, { color: layout.card.objColor, fontSize: layout.card.descFontSize, width: layout.list.size.width, height: 32 }));
      return;
    }
    views.forEach((view) => content.addChild(this.createCard(view)));
  }

  /**
   * 一张详情卡（稿 `.qcard` 五段：头 / 描述 / 目标+进度条 / 奖励 chip / 交付 NPC+前往）
   *
   * 卡高按描述行数算：全角字符宽 ≈ 字号，每行字数 = 排版宽 / 字号（只多不少——
   * 半角与标点更窄，多估只多留白不裁字），行高走配置。
   */
  private createCard(view: QuestView) {
    const card = layout.card;
    const textWidth = card.width - card.paddingX * 2;
    const charsPerLine = Math.max(1, Math.floor(textWidth / card.descFontSize));
    const descLines = Math.max(1, Math.ceil(view.quest.description.length / charsPerLine));
    const descHeight = descLines * card.descLineHeight;
    const rewards = this.rewardChips(view);
    const hasRewards = rewards.length > 0;
    const height =
      card.padTop +
      card.nameSize.height +
      card.descGapTop +
      descHeight +
      card.descGapBottom +
      card.objSize.height +
      (hasRewards ? card.chipMarginTop + card.chipHeight : 0) +
      card.goGapTop +
      1 +
      card.goGapTop +
      card.goHeight +
      card.padBottom;
    const size = new Size(card.width, height);
    const ready = view.status === "ready";

    const node = UiHelper.createNode(`quest_detail_card_${view.quest.id}`, new Vec2(), size);
    const graphics = node.addComponent(Graphics);
    UiHelper.paintRoundedPanel(graphics, size, card.radius, ready ? card.readyFill : card.fill, ready ? card.readyBorder : card.border);

    const top = height / 2;
    const left = -card.width / 2 + card.paddingX;

    // ── 头：名称 + 状态角标 + 放弃 ──
    const headY = top - card.padTop - card.nameSize.height / 2;
    node.addChild(
      UiHelper.createLabel(
        `quest_detail_name_${view.quest.id}`,
        view.quest.label,
        card.nameColor,
        card.nameFontSize,
        new Vec2(left + card.nameSize.width / 2, headY),
        card.nameSize,
        Label.HorizontalAlign.LEFT,
        Label.VerticalAlign.CENTER,
      ),
    );
    // 角标跟在名称后面（两种状态文案等长，宽一致：字数×字号 + 16 内距）
    const badgeWidth = layout.badge.texts.ready.length * layout.badge.fontSize + 16;
    node.addChild(this.createBadge(view, new Vec2(left + card.nameSize.width + 10 + badgeWidth / 2, headY)));
    this.paintAbandonButton(node, view, new Vec2(card.width / 2 - card.paddingX - layout.abandon.size.width / 2, headY));

    // ── 描述（定高换行：多估行数只多留白，不会压到下面的目标行） ──
    const descY = headY - card.nameSize.height / 2 - card.descGapTop - descHeight / 2;
    node.addChild(
      UiHelper.createWrappedLabel(
        `quest_detail_desc_${view.quest.id}`,
        view.quest.description,
        card.descColor,
        card.descFontSize,
        card.descLineHeight,
        new Vec2(left + textWidth / 2, descY),
        textWidth,
        Label.HorizontalAlign.LEFT,
        descHeight,
      ),
    );

    // ── 目标 + 进度条 ──
    const objY = descY - descHeight / 2 - card.descGapBottom - card.objSize.height / 2;
    const objText = layout.texts.objective
      .split("{type}")
      .join(QUEST_OBJECTIVE_LABELS[view.quest.objective.type] ?? view.quest.objective.type)
      .split("{target}")
      .join(this.targetName(view));
    node.addChild(
      UiHelper.createLabel(
        `quest_detail_obj_label_${view.quest.id}`,
        layout.texts.objLabel,
        card.objColor,
        card.descFontSize,
        new Vec2(left + 18, objY),
        new Size(36, card.objSize.height),
        Label.HorizontalAlign.LEFT,
        Label.VerticalAlign.CENTER,
      ),
    );
    const objValueWidth = objText.length * card.descFontSize + 8;
    node.addChild(
      UiHelper.createLabel(
        `quest_detail_obj_value_${view.quest.id}`,
        objText,
        card.objValueColor,
        card.descFontSize,
        new Vec2(left + 40 + objValueWidth / 2, objY),
        new Size(objValueWidth, card.objSize.height),
        Label.HorizontalAlign.LEFT,
        Label.VerticalAlign.CENTER,
      ),
    );
    const numText = `${view.progress} / ${view.target}`;
    const barLeft = left + 44 + objValueWidth + 8;
    const barRight = card.width / 2 - card.paddingX - 44;
    node.addChild(this.createBar(view, new Vec2((barLeft + barRight) / 2, objY), new Size(Math.max(24, barRight - barLeft), card.barHeight)));
    node.addChild(
      UiHelper.createLabel(
        `quest_detail_obj_num_${view.quest.id}`,
        numText,
        card.objValueColor,
        card.descFontSize,
        new Vec2(card.width / 2 - card.paddingX - 18, objY),
        new Size(40, card.objSize.height),
        Label.HorizontalAlign.RIGHT,
        Label.VerticalAlign.CENTER,
      ),
    );

    // ── 奖励 chip ──
    if (hasRewards) {
      const chipY = objY - card.objSize.height / 2 - card.chipMarginTop - card.chipHeight / 2;
      let chipX = left;
      rewards.forEach((text, index) => {
        const chipWidth = text.length * layout.badge.fontSize + 18;
        node.addChild(this.createChip(`quest_detail_chip_${view.quest.id}_${index}`, text, new Vec2(chipX + chipWidth / 2, chipY), chipWidth));
        chipX += chipWidth + card.chipGap;
      });
    }

    // ── 交付 NPC + 前往 ──
    const dividerY = top - height + card.padBottom + card.goHeight + card.goGapTop + 0.5;
    node.addChild(this.createDivider(`quest_detail_divider_${view.quest.id}`, card.width - card.paddingX * 2, dividerY, card.goDivider));
    const goY = dividerY - card.goGapTop - card.goHeight / 2;
    const npc = npcs.get(view.quest.npcId);
    const goText = layout.texts.goNpc
      .split("{npc}")
      .join(npc?.label ?? view.quest.npcId)
      .split("{map}")
      .join(this.npcMapLabel(view.quest.npcId));
    node.addChild(
      UiHelper.createLabel(
        `quest_detail_go_${view.quest.id}`,
        goText,
        card.goColor,
        card.goFontSize,
        new Vec2(left + (textWidth - card.goButtonSize.width - 10) / 2, goY),
        new Size(textWidth - card.goButtonSize.width - 10, card.goHeight),
        Label.HorizontalAlign.LEFT,
        Label.VerticalAlign.CENTER,
      ),
    );
    const goButton = GameUiHelper.createToneButton(
      `quest_detail_go_button_${view.quest.id}`,
      layout.texts.goButton,
      new Vec2(card.width / 2 - card.paddingX - card.goButtonSize.width / 2, goY),
      card.goButtonSize,
      card.goButtonFontSize,
      ready ? buttonTone.gold : buttonTone.ghost,
    );
    goButton.on(Node.EventType.TOUCH_END, () => this.go(view), this);
    node.addChild(goButton);
    return node;
  }

  /** 状态角标（稿 `.badge--jade` 可交付 / `.badge--muted` 进行中） */
  private createBadge(view: QuestView, position: Vec2) {
    const badge = layout.badge;
    const ready = view.status === "ready";
    const text = ready ? badge.texts.ready : badge.texts.active;
    const width = text.length * badge.fontSize + 16;
    const size = new Size(width, badge.height);
    const node = UiHelper.createNode(`quest_detail_badge_${view.quest.id}`, position, size);
    const tint = ready ? badge.readyFill : badge.activeFill;
    const graphics = node.addComponent(Graphics);
    // 徽标无独立描边：fill 与 border 同色，paintRoundedPanel 画出来就是一块均匀淡染
    UiHelper.paintRoundedPanel(graphics, size, 2, tint, tint);
    node.addChild(
      UiHelper.createLabel(
        `quest_detail_badge_text_${view.quest.id}`,
        text,
        ready ? badge.readyText : badge.activeText,
        badge.fontSize,
        new Vec2(),
        size,
      ),
    );
    return node;
  }

  /** 奖励 chip 一枚（稿 `.qc-rw .chip`：黑底弱框金字） */
  private createChip(name: string, text: string, position: Vec2, width: number) {
    const chip = layout.card;
    const size = new Size(width, chip.chipHeight);
    const node = UiHelper.createNode(name, position, size);
    const graphics = node.addComponent(Graphics);
    UiHelper.paintRoundedPanel(graphics, size, 2, chip.chipFill, chip.chipBorder);
    node.addChild(
      UiHelper.createLabel(`${name}_text`, text, chip.chipColor, chip.chipFontSize, new Vec2(), size),
    );
    return node;
  }

  /** 目标进度条（稿 `.qc-obj .bar`：黑底弱框，可交付换 jade 填充） */
  private createBar(view: QuestView, position: Vec2, size: Size) {
    const card = layout.card;
    const node = UiHelper.createNode(`quest_detail_bar_${view.quest.id}`, position, size);
    const graphics = node.addComponent(Graphics);
    const ratio = view.target > 0 ? Math.min(1, view.progress / view.target) : 0;
    graphics.fillColor = card.barBorder;
    graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, size.height / 2);
    graphics.fill();
    graphics.fillColor = card.barBg;
    graphics.roundRect(-size.width / 2 + 1, -size.height / 2 + 1, size.width - 2, size.height - 2, size.height / 2 - 1);
    graphics.fill();
    if (ratio > 0) {
      const fill = view.status === "ready" ? card.barFillReady : card.barFill;
      graphics.fillColor = fill;
      graphics.roundRect(-size.width / 2 + 1, -size.height / 2 + 1, Math.max(size.height - 2, (size.width - 2) * ratio), size.height - 2, size.height / 2 - 1);
      graphics.fill();
    }
    return node;
  }

  /** 1px 横向分隔线（虚线用实线近似：Graphics 的 1px 描边在 web 构建里整条不渲染） */
  private createDivider(name: string, width: number, y: number, color: Color) {
    const node = UiHelper.createNode(name, new Vec2(0, y), new Size(width, 1));
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = color;
    graphics.rect(-width / 2, -0.5, width, 1);
    graphics.fill();
    return node;
  }

  //#endregion

  //#region 动作

  /** 全量对账（失败静默：详情弹窗拉不到不该打断游戏，玩家再点一次即可） */
  private async refresh(): Promise<void> {
    try {
      QuestStore.applyStates((await QuestApi.mine()).quests);
    } catch {
      /* 请求层已统一提示 */
    }
  }

  /**
   * 「放弃」按钮：两步确认（首点变「确认放弃」金框，3 秒未确认复位）
   *
   * 按钮是整卡重建的：armed 状态切换直接换一枚金键 —— 不去重画旧按钮的底板，
   * 换节点比在 Graphics 上补一层「金框」可靠（旧底还垫在下面）。
   */
  private paintAbandonButton(card: Node, view: QuestView, position: Vec2) {
    const armed = this.armedQuestId === view.quest.id;
    const button = GameUiHelper.createToneButton(
      `quest_detail_abandon_${view.quest.id}`,
      armed ? layout.abandon.confirmText : layout.abandon.text,
      position,
      layout.abandon.size,
      layout.abandon.fontSize,
      armed ? buttonTone.gold : buttonTone.danger,
    );
    button.on(
      Node.EventType.TOUCH_END,
      () => {
        if (!armed) {
          this.armAbandon(view);
          this.paintAbandonButton(card, view, position);
          return;
        }
        this.clearAbandonPending();
        void this.abandon(view);
      },
      this,
    );
    card.addChild(button);
  }

  /** 进入待确认态：记住目标 + 3 秒到点自动复位（免得挂着被无意再点一次） */
  private armAbandon(view: QuestView) {
    this.clearAbandonPending();
    this.armedQuestId = view.quest.id;
    this.abandonTimer = setTimeout(() => {
      this.armedQuestId = "";
      this.abandonTimer = null;
      this.render();
    }, layout.abandon.confirmTimeout);
  }

  /** 退出待确认态（清定时器 + 忘掉目标） */
  private clearAbandonPending() {
    if (this.abandonTimer !== null) {
      clearTimeout(this.abandonTimer);
      this.abandonTimer = null;
    }
    this.armedQuestId = "";
  }

  /** 放弃：服务端复核（进行中被引用的环拒绝），响应即最新快照 */
  private async abandon(view: QuestView): Promise<void> {
    if (this.busyQuestId) return;
    this.busyQuestId = view.quest.id;
    try {
      QuestStore.applyStates((await QuestApi.abandon({ questId: view.quest.id })).quests);
      GameUiHelper.createTipText(layout.texts.abandonedTip.split("{name}").join(view.quest.label));
    } catch {
      /* 错误文案由请求层统一弹出 */
    } finally {
      this.busyQuestId = "";
    }
  }

  /**
   * 「前往」：关弹窗 + 寻路至交付 NPC（稿：出发前不校验距离，服务端不看坐标）
   *
   * NPC 点位在快照 maps 表里（#672 起服务端权威）；目标格被 NPC 障碍挡住时
   * `PathGrid.findPath` 会就近改寻可行走格（走到身边停住），不用自己挪点。
   */
  private go(view: QuestView) {
    this.close();
    const npcId = view.quest.npcId;
    const npcLabel = npcs.get(npcId)?.label ?? npcId;
    const current = maps.get(AutoBattle.getMapId());
    const point = current?.npcs.find((item) => item.npcId === npcId);
    if (point) {
      if (!AutoBattle.requestMoveTo(new Vec2(point.x, point.y))) {
        GameUiHelper.createTipText(layout.texts.goRefuseTip);
      }
      return;
    }
    // 不在本地图：不做跨图传送，告诉玩家它在哪张图（大地图换图后再点一次前往）
    for (const config of maps.values()) {
      if (config.npcs.some((item) => item.npcId === npcId)) {
        GameUiHelper.createTipText(
          layout.texts.goOtherMapTip.split("{npc}").join(npcLabel).split("{map}").join(config.label),
        );
        return;
      }
    }
    GameUiHelper.createTipText(layout.texts.goUnknownTip.split("{npc}").join(npcLabel));
  }

  //#endregion

  //#region 零件

  /** 目标键 → 可读名字（与 QuestDialog 同一套三表轮查；查不到原样显示键） */
  private targetName(view: QuestView): string {
    const key = view.quest.objective.target;
    const type = view.quest.objective.type;
    if (type === "kill") return monsterLabelOf(key);
    if (type === "talk") return npcs.get(key)?.label ?? key;
    return items.get(key)?.label ?? key;
  }

  /** 奖励 chip 文案（零值不显示；物品名查 items 表，查不到显示 goodId） */
  private rewardChips(view: QuestView): string[] {
    const rewards = view.quest.rewards;
    const chips: string[] = [];
    if (rewards.exp > 0) chips.push(layout.texts.chipExp.split("{value}").join(`${rewards.exp}`));
    if (rewards.bindGold > 0) chips.push(layout.texts.chipBindGold.split("{value}").join(`${rewards.bindGold}`));
    for (const item of rewards.items) {
      if (item.count <= 0) continue;
      chips.push(`${items.get(item.goodId)?.label ?? item.goodId} ×${item.count}`);
    }
    return chips;
  }

  /** 交付 NPC 所在地图名（快照 maps 表反查；查不到给「未知区域」占位） */
  private npcMapLabel(npcId: string): string {
    for (const config of maps.values()) {
      if (config.npcs.some((item) => item.npcId === npcId)) return config.label;
    }
    return layout.texts.goUnknownMap;
  }

  //#endregion

  /** 释放引用（关闭后） */
  protected reset() {
    this.busyQuestId = "";
    this.armedQuestId = "";
    this.abandonTimer = null;
  }
}
