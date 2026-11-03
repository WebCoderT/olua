import { Color, isValid, Label, Node, ScrollView, Sprite, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import RoleUIManager from "../../core/RoleUIManager";
import UiHelper from "../../helpers/UiHelper";
import { getTitleLevel, nextTitleUpgrade, titleUpgradeChain } from "../../../configs/game-config";
import type { TitleLevelConfig } from "../../../types/title";
import { titleUpgradeDialogLayout } from "../../../configs/hudLayout";
import { getText } from "../../../configs/texts";
import { clearChildren } from "../../utils/node/NodeTree";

/** 弹窗布局（尺寸与各栏位置、配色统一见 configs/hudLayout.titleUpgradeDialogLayout） */
const layout = titleUpgradeDialogLayout;

/**
 * 打开时默认选中的档：当前已获得且在链上 → 它自己；否则链首（链为空时回落到当前阶，列表会是空的）
 */
function defaultSelectedLevel(current: number): number {
  if (titleUpgradeChain.some((config) => config.level === current)) return current;
  return titleUpgradeChain[0]?.level ?? Math.max(1, current);
}

/**
 * 称号升级弹窗（左中右三栏，结构与战魂弹窗一致）
 * 左：**升级链上的**称号卡片竖向滚动列表（按管理端配置的顺序排列，已激活/未激活/选中三种状态）
 * 中：所选等级的称号名牌动画 + 名称/描述/当前称号信息（称号常显头顶，没有「外显」勾选框）
 * 右：所选等级的称号属性（带链上下一个的增量）+ 绑定元宝余额 + 升级按钮
 * 升级消耗绑定元宝与「下一级是哪一档」都来自服务端配置（`upgradeOrder` 链，见 configs/game-config），
 * 成功后整体刷新弹窗并刷新头顶名牌
 * 入口在角色信息弹窗的「称号」按钮（不走 NPC，见 RoleInfoDialog）
 */
export default class TitleUpgradeDialog {
  /** 当前预览的称号等级（点击左侧卡片切换） */
  private selectedLevel = 1;
  /** 弹窗内的可刷新部件 */
  private listContent: Node | null = null;
  private animationSlot: Node | null = null;
  private animationNode: Node | null = null;
  private infoSlot: Node | null = null;
  private attributeSlot: Node | null = null;
  private upgradeButton: Node | null = null;
  private bindGoldLabel: Node | null = null;

  /** 打开弹窗 */
  open() {
    const role = StorageManager.findOnlineRole();
    // 默认预览当前称号（不在链上时停在链首 —— 列表里本来就没有它）
    this.selectedLevel = defaultSelectedLevel(role?.title ?? 0);
    const dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size);
    // 左：称号等级列表（可上下滑动）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size);
    this.listContent = list.getComponent(ScrollView).content;
    dialog.addChild(list);
    // 中：称号动画与信息（槽位节点内容随选中等级重建）
    this.animationSlot = UiHelper.createGroupNode("title_animation_slot", layout.animation.position);
    dialog.addChild(this.animationSlot);
    this.infoSlot = UiHelper.createGroupNode("title_info_slot", layout.info.position);
    dialog.addChild(this.infoSlot);
    // 右：属性面板 / 绑定元宝 / 升级按钮
    this.attributeSlot = UiHelper.createGroupNode("title_attribute_slot", layout.attribute.position);
    dialog.addChild(this.attributeSlot);
    this.bindGoldLabel = UiHelper.createLabel("title_bind_gold", "", Color.WHITE, layout.bindGold.fontSize, layout.bindGold.position, layout.bindGold.size);
    dialog.addChild(this.bindGoldLabel);
    this.upgradeButton = GameUiHelper.createMiddleButton("title_upgrade_button", layout.upgradeButton.text, layout.upgradeButton.position);
    this.upgradeButton.on(
      Node.EventType.TOUCH_END,
      async () => {
        // 升级成功后整体刷新（失败时 StorageManager 已弹出原因提示）；称号常显头顶，同步换掉主角头顶的名牌动画
        if (await StorageManager.upgradeTitle()) {
          RoleUIManager.updateTitleShow();
          this.refresh();
        }
      },
      this,
    );
    dialog.addChild(this.upgradeButton);
    LayerManager.addDialogToUILayer(dialog);
    this.refresh();
  }

  /** 整体刷新（选中等级切换、升级成功后调用）：列表状态 / 动画 / 信息 / 属性 / 按钮全部重建 */
  private refresh() {
    const role = StorageManager.findOnlineRole();
    if (!role || !this.listContent || !this.animationSlot || !this.infoSlot || !this.attributeSlot) return;
    // 选中档被运营从链上摘掉时回落到链首（同一份快照不会中途变，但刷新路径不止一条）
    if (!titleUpgradeChain.some((item) => item.level === this.selectedLevel)) {
      this.selectedLevel = defaultSelectedLevel(role.title);
    }
    const config = getTitleLevel(this.selectedLevel);
    if (!config) return;
    // 左列表：只列升级链上的档（运营没放出的等级不出现），点击切换预览
    clearChildren(this.listContent);
    if (titleUpgradeChain.length === 0) {
      this.listContent.addChild(
        GameUiHelper.createChainEmptyLabel("title_chain_empty", layout.list.cardSize.width, layout.list.lockedColor, layout.list.cardFontSize),
      );
    }
    /** 当前称号在链上的位置（-1 = 不在链上，例如运营把已获得的称号切去了「系统赠送」渠道） */
    const currentIndex = titleUpgradeChain.findIndex((item) => item.level === role.title);
    /**
     * 是否已到达：当前档在链上时按**链序**比（运营拖过顺序也准），
     * 不在链上时按等级号兜底 —— 玩家手上确实有这个称号，列表里比它低的不该显示成未解锁
     */
    const reached = (item: TitleLevelConfig) =>
      currentIndex >= 0 ? titleUpgradeChain.indexOf(item) <= currentIndex : item.level <= role.title;
    titleUpgradeChain.forEach((item) =>
      this.listContent.addChild(
        GameUiHelper.createTitleCard(item, reached(item), item.level === this.selectedLevel, () => {
          if (this.selectedLevel === item.level) return;
          this.selectedLevel = item.level;
          this.refresh();
        }),
      ),
    );
    // 中间动画：先销毁旧的再重建（不同等级帧目录不同）
    if (this.animationNode && isValid(this.animationNode)) this.animationNode.destroy();
    this.animationNode = GameUiHelper.createTitleAnimation(config);
    this.animationSlot.addChild(this.animationNode);
    // 中间信息：名称 / 描述 / 当前称号（位置、尺寸、字号与配色见 layout.info）
    clearChildren(this.infoSlot);
    const info = layout.info;
    this.infoSlot.addChild(UiHelper.createLabel("title_name", config.label, info.name.color, info.name.fontSize, info.name.position, info.name.size));
    this.infoSlot.addChild(UiHelper.createLabel("title_desc", config.description, info.description.color, info.description.fontSize, info.description.position, info.description.size));
    const current = getTitleLevel(role.title);
    this.infoSlot.addChild(
      UiHelper.createLabel("title_current", current ? getText("label_title_current", { level: role.title, label: current.label }) : getText("label_title_none"), info.current.color, info.current.fontSize, info.current.position, info.current.size),
    );
    // 右侧属性：所选等级属性 + 链上下一个的增量（不是「等级 + 1」—— 链上可能跳号）
    clearChildren(this.attributeSlot);
    const nextStep = nextTitleUpgrade(this.selectedLevel);
    this.attributeSlot.addChild(GameUiHelper.createTitleAttributeList(config, nextStep.kind === "next" ? nextStep.config : null));
    // 升级按钮与绑定元宝（按钮始终针对当前称号在链上的下一档；到链尾 / 断链都置灰，文案分开）
    if (this.upgradeButton) {
      const sprite = this.upgradeButton.getComponent(Sprite);
      const label = this.upgradeButton.getChildByName("title_upgrade_button_label")?.getComponent(Label);
      const step = nextTitleUpgrade(role.title);
      if (label) {
        label.string =
          step.kind === "next"
            ? layout.upgradeButton.text
            : step.kind === "maxed"
              ? layout.upgradeButton.maxedText
              : layout.upgradeButton.lockedText;
      }
      if (sprite) sprite.grayscale = step.kind !== "next";
    }
    if (this.bindGoldLabel) this.bindGoldLabel.getComponent(Label).string = getText("label_bind_gold", { value: role.bindGold });
  }
}
