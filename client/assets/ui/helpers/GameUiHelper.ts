/**
 * 游戏 UI 零件工厂（聚合出口；epic #1115 批次 1 由 3947 行单文件按域拆分而来）
 *
 * 实现按域拆在 helpers/parts/ 下（机械搬移、零行为变化）：
 * - parts/ui-parts.ts       通用零件薄代理（转发 UiHelper）与无样式节点工具
 * - parts/dialog-builder.ts 弹窗骨架与按钮（弹窗框/玻璃板/眉题/页脚/按钮/悬停详情/物品详情弹窗）
 * - parts/growth-parts.ts   成长线三窗零件（战魂/称号/军衔的卡片/属性/动画/绑定元宝行）
 * - parts/tip-fx.ts         Tip 浮层与战斗反馈（提示/伤害飘字/技能/经验）
 * - parts/item-parts.ts     物品与装备零件（物品/背包格/边框/详情背景/光效/掉落物/格式化）
 * - parts/role-parts.ts     角色与 HUD 零件（货币/战力/头像/血条/头顶/预览/底部导航/属性行）
 * - parts/skill-parts.ts    技能零件（技能点/列表/技能行）
 * - parts/monster-parts.ts  怪物与 NPC 零件（怪物身体/头顶/NPC/碰撞与刷怪区调试）
 * - parts/minimap-parts.ts  小地图与路线指示线
 *
 * 调用方不受影响：default 导出仍是「全部方法同名可调」的对象（原静态类语义），
 * 命名导出经 export * 透传各域（SmallMapDot / BottomNavBarButton 等类型照旧从这里拿）。
 */

import * as ui_partsNs from "./parts/ui-parts";
import * as dialog_builderNs from "./parts/dialog-builder";
import * as growth_partsNs from "./parts/growth-parts";
import * as tip_fxNs from "./parts/tip-fx";
import * as item_partsNs from "./parts/item-parts";
import * as role_partsNs from "./parts/role-parts";
import * as skill_partsNs from "./parts/skill-parts";
import * as monster_partsNs from "./parts/monster-parts";
import * as minimap_partsNs from "./parts/minimap-parts";

export * from "./parts/ui-parts";
export * from "./parts/dialog-builder";
export * from "./parts/growth-parts";
export * from "./parts/tip-fx";
export * from "./parts/item-parts";
export * from "./parts/role-parts";
export * from "./parts/skill-parts";
export * from "./parts/monster-parts";
export * from "./parts/minimap-parts";

const GameUiHelper = {
  ...ui_partsNs,
  ...dialog_builderNs,
  ...growth_partsNs,
  ...tip_fxNs,
  ...item_partsNs,
  ...role_partsNs,
  ...skill_partsNs,
  ...monster_partsNs,
  ...minimap_partsNs,
};

export default GameUiHelper;
