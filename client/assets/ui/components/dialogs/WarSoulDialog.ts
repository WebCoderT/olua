import { Label, isValid, Node, ScrollView, Sprite, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import RoleUIManager from "../../core/RoleUIManager";
import UiHelper from "../../helpers/UiHelper";
import { getSoulLevel, nextSoulUpgrade, soulUpgradeChain } from "../../../configs/game-config";
import type { SoulLevelConfig } from "../../../types/soul";
import { warSoulDialogLayout } from "../../../configs/hudLayout";
import { buttonTone } from "../../../configs/layout/sizes";
import { getText } from "../../../configs/texts";
import { clearChildren } from "../../utils/node/NodeTree";

/** 弹窗布局（尺寸与各栏位置、配色统一见 configs/hudLayout.warSoulDialogLayout） */
const layout = warSoulDialogLayout;

/**
 * 打开时默认选中的阶：当前已获得且在链上 → 它自己；否则链首（链为空时回落到当前阶）
 */
function defaultSelectedLevel(current: number): number {
  if (soulUpgradeChain.some((config) => config.level === current)) return current;
  return soulUpgradeChain[0]?.level ?? Math.max(1, current);
}

/**
 * 战魂弹窗（左中右三栏）
 * 左：**升级链上的**战魂卡片竖向滚动列表（37 阶全量都在链上，顺序由管理端拖动决定）
 * 中：所选等级的战魂动画 + 名称/描述/当前战魂信息 + 外显勾选框（勾选后当前等级动画挂主角右上角）
 * 右：所选等级的战魂属性（带链上下一阶的增量）+ 绑定元宝余额 + 升级按钮
 * 升级消耗与「下一阶是哪一档」都来自服务端配置（`upgradeOrder` 链，见 configs/game-config），
 * 成功后整体刷新弹窗
 */
export default class WarSoulDialog {
  /** 当前预览的战魂等级（点击左侧卡片切换） */
  private selectedLevel = 1;
  /** 弹窗内的可刷新部件 */
  private listContent: Node | null = null;
  private animationSlot: Node | null = null;
  private animationNode: Node | null = null;
  private infoSlot: Node | null = null;
  private attributeSlot: Node | null = null;
  private upgradeButton: Node | null = null;
  private costValue: Node | null = null;
  private bindGoldLabel: Node | null = null;

  /** 打开弹窗 */
  open() {
    const role = StorageManager.findOnlineRole();
    // 默认预览当前战魂阶（链上找不到时停在链首）
    this.selectedLevel = defaultSelectedLevel(role?.soulOfWar ?? 0);
    const dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), layout.size, layout.eyebrow);
    // 页脚（稿 17-growth 的 .panel-foot）
    dialog.addChild(
      GameUiHelper.createDialogFoot("war_soul_foot", layout.size.width, layout.foot, layout.footTexts.left, layout.footTexts.right),
    );
    // 中栏容器（稿 .gcenter：边框 + 深底，垫在动画与文字之下）
    dialog.addChild(GameUiHelper.createGrowthCenter("soul_center", layout.center));
    // 左：战魂等级列表（可上下滑动）
    const list = GameUiHelper.createScrollView(layout.list.name, layout.list.position, layout.list.size, layout.list.gap, 3);
    this.listContent = list.getComponent(ScrollView).content;
    dialog.addChild(list);
    // 中：战魂动画与信息（槽位节点内容随选中等级重建）
    this.animationSlot = UiHelper.createGroupNode("soul_animation_slot", layout.animation.position);
    dialog.addChild(this.animationSlot);
    this.infoSlot = UiHelper.createGroupNode("soul_info_slot", new Vec2());
    dialog.addChild(this.infoSlot);
    // 右：属性面板 / 消耗与余额 / 提示行 / 升级按钮（稿 .gside 与 .gcost）
    this.attributeSlot = UiHelper.createGroupNode("soul_attribute_slot", layout.attribute.position);
    dialog.addChild(this.attributeSlot);
    dialog.addChild(GameUiHelper.createGrowthCostDivider("soul_cost_divider", layout.cost));
    dialog.addChild(GameUiHelper.createGrowthCostRow("soul_cost", getText("label_growth_cost"), getText("label_growth_cost_none"), layout.cost.costY, layout.cost));
    dialog.addChild(GameUiHelper.createGrowthCostRow("soul_balance", getText("label_growth_balance"), "", layout.cost.balanceY, layout.cost));
    this.costValue = dialog.getChildByName("soul_cost")?.getChildByName("soul_cost_value") ?? null;
    this.bindGoldLabel = dialog.getChildByName("soul_balance")?.getChildByName("soul_balance_value") ?? null;
    dialog.addChild(GameUiHelper.createGrowthShowline("soul_showline", layout.showline.text, layout.showline));
    this.upgradeButton = GameUiHelper.createToneButton(
      "soul_upgrade_button",
      layout.upgradeButton.text,
      layout.upgradeButton.position,
      layout.upgradeButton.size,
      layout.upgradeButton.fontSize,
      buttonTone.primary,
    );
    this.upgradeButton.on(
      Node.EventType.TOUCH_END,
      async () => {
        // 升级成功后整体刷新（失败时 StorageManager 已弹出原因提示）；外显已勾选时同步换掉主角身上的战魂动画
        if (await StorageManager.upgradeSoul()) {
          RoleUIManager.updateSoulShow();
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
    if (!soulUpgradeChain.some((item) => item.level === this.selectedLevel)) {
      this.selectedLevel = defaultSelectedLevel(role.soulOfWar);
    }
    const config = getSoulLevel(this.selectedLevel);
    if (!config) return;
    // 左列表：按运营配置的成长链顺序（不是阶数顺序），点击切换预览
    clearChildren(this.listContent);
    if (soulUpgradeChain.length === 0) {
      this.listContent.addChild(
        GameUiHelper.createChainEmptyLabel("soul_chain_empty", layout.list.cardSize.width, layout.list.lockedColor, layout.list.cardFontSize),
      );
    }
    /** 当前战魂在链上的位置（-1 = 不在链上，正常情况下不会发生：37 阶全量都在链里） */
    const currentIndex = soulUpgradeChain.findIndex((item) => item.level === role.soulOfWar);
    const reached = (item: SoulLevelConfig) =>
      currentIndex >= 0 ? soulUpgradeChain.indexOf(item) <= currentIndex : item.level <= role.soulOfWar;
    soulUpgradeChain.forEach((item) =>
      this.listContent.addChild(
        GameUiHelper.createSoulCard(item, reached(item), item.level === this.selectedLevel, () => {
          if (this.selectedLevel === item.level) return;
          this.selectedLevel = item.level;
          this.refresh();
        }),
      ),
    );
    // 中间动画：先销毁旧的再重建（不同等级图集不同）
    if (this.animationNode && isValid(this.animationNode)) this.animationNode.destroy();
    this.animationNode = GameUiHelper.createSoulAnimation(config);
    this.animationSlot.addChild(this.animationNode);
    // 中间信息：名称 / 描述 / 当前战魂（位置、尺寸、字号与配色见 layout.info；坐标是大盘绝对坐标）
    clearChildren(this.infoSlot);
    const info = layout.info;
    this.infoSlot.addChild(UiHelper.createLabel("soul_name", config.label, info.name.color, info.name.fontSize, info.name.position, info.name.size));
    // 描述是长文本：换行 + 高度自适应（position.y 是文字块上边缘）
    this.infoSlot.addChild(
      UiHelper.createWrappedLabel("soul_desc", config.description, info.description.color, info.description.fontSize, info.description.lineHeight, info.description.position, info.description.width, undefined, info.description.height),
    );
    const current = getSoulLevel(role.soulOfWar);
    this.infoSlot.addChild(
      UiHelper.createLabel("soul_current", current ? getText("label_soul_current", { level: role.soulOfWar, label: current.label }) : getText("label_soul_none"), info.current.color, info.current.fontSize, info.current.position, info.current.size),
    );
    // 外显勾选框：勾选后把当前等级的战魂动画挂到主角右上角（状态持久在角色数据 role.soulShow）
    // 勾选后立刻刷新主角身上的战魂动画（RoleUIManager → RoleDisplay，后者用前重读角色数据，见 RoleDisplay.updateSoulShow）
    const showToggle = GameUiHelper.createSoulShowToggle(role.soulShow, () => {
      role.soulShow = !role.soulShow;
      StorageManager.updateOnlineRole(role);
      RoleUIManager.updateSoulShow();
      this.refresh();
    });
    showToggle.setPosition(info.toggle.position.x, info.toggle.position.y);
    this.infoSlot.addChild(showToggle);
    // 右侧属性：所选阶属性 + 链上下一阶的增量（不是「阶数 + 1」—— 运营可拖动排序）
    clearChildren(this.attributeSlot);
    const nextStep = nextSoulUpgrade(this.selectedLevel);
    this.attributeSlot.addChild(GameUiHelper.createSoulAttributeList(config, nextStep.kind === "next" ? nextStep.config : null));
    // 升级按钮与消耗/余额（按钮始终针对当前战魂在链上的下一阶；到链尾 / 断链都置灰，文案分开）
    const step = nextSoulUpgrade(role.soulOfWar);
    if (this.upgradeButton) {
      const sprite = this.upgradeButton.getComponent(Sprite);
      const label = this.upgradeButton.getChildByName("soul_upgrade_button_label")?.getComponent(Label);
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
    // 消耗行：下一阶的价格（满级 / 断链时没有下一阶，显示占位符）
    const costLabel = this.costValue?.getComponent(Label);
    if (costLabel) costLabel.string = step.kind === "next" ? getText("label_growth_cost_value", { value: step.config.bindGold }) : getText("label_growth_cost_none");
    const balanceLabel = this.bindGoldLabel?.getComponent(Label);
    if (balanceLabel) balanceLabel.string = `${role.bindGold}`;
  }
}
