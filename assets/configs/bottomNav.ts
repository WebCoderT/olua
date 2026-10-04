import { bottomNavImage } from "./layout/images";

/**
 * 底部功能入口（按键区的数据表）
 *
 * 只描述「有哪些入口、长什么样」：名称 / 图标 / 解锁等级 / 显示用快捷键。
 * 点击行为（打开哪个弹窗、后续接哪个功能）由组件按 `key` 关联 —— configs 不依赖 UI，
 * 回调是代码不是配置，所以留在 ui/components/hud/BottomBar。
 *
 * 新增入口：这里加一条 + 在 BottomBar 的回调表里补一条同名 key（未补则点击无反应，不会报错）。
 */
export interface BottomNavItem {
  /** 入口标识（组件按它关联点击回调，同时用于节点命名） */
  key: string;
  /** 功能名称（未解锁提示与按钮名使用） */
  label: string;
  /** 图标资源（取图口径见 layout/images 的 bottomNavImage） */
  icon: string;
  /** 解锁等级（角色等级低于该值时图标置灰、点击只提示所需等级） */
  openLevel: number;
  /** 显示在图标上的快捷键名（仅展示用） */
  shortcutKey: string;
}

export const bottomNavItems: BottomNavItem[] = [
  { key: "role", label: "角色", icon: bottomNavImage("role"), openLevel: 1, shortcutKey: "C" },
  { key: "bag", label: "背包", icon: bottomNavImage("bag"), openLevel: 1, shortcutKey: "B" },
  { key: "friend", label: "好友", icon: bottomNavImage("friend"), openLevel: 10, shortcutKey: "F" },
  { key: "group", label: "组队", icon: bottomNavImage("group"), openLevel: 10, shortcutKey: "G" },
  { key: "task", label: "任务", icon: bottomNavImage("task"), openLevel: 1, shortcutKey: "Q" },
  { key: "skill", label: "技能", icon: bottomNavImage("skill"), openLevel: 1, shortcutKey: "K" },
  { key: "horse", label: "坐骑", icon: bottomNavImage("horse"), openLevel: 1, shortcutKey: "T" },
  { key: "mall", label: "商城", icon: bottomNavImage("mall"), openLevel: 1, shortcutKey: "M" },
  { key: "config", label: "设置", icon: bottomNavImage("config"), openLevel: 1, shortcutKey: "/" },
];
