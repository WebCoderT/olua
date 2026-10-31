import { bottomNavImage } from "./layout/images";

/**
 * 底部功能入口（按键区的数据表）
 *
 * 只描述「有哪些入口、长什么样」：名称 / 图标 / 解锁等级 / 显示用快捷键。
 * 点击行为（打开哪个弹窗、后续接哪个功能）由组件按 `key` 关联 —— configs 不依赖 UI，
 * 回调是代码不是配置，所以留在 ui/components/hud/BottomBar。
 *
 * 当前只放 6 个入口（角色 / 背包 / 好友 / 组队 / 技能 / 商城）——按键区背景图最右侧
 * 是一个宽格子，**什么都不放**（留白）；以后要加入口先看构图还装不装得下。
 * 快捷键不只显示：BottomNavButton 会按 `shortcutKey` 监听全局键盘（见其文件头说明）。
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
  /** 显示在图标上的快捷键名（字母 = 对应键盘按键；同时是真实快捷键，见 BottomNavButton） */
  shortcutKey: string;
  /**
   * 功能是否还没做（入口先放出来占位）
   *
   * 这条是**给玩家看的承诺**：`true` 时点击飘字「{功能}功能正在开发中」，
   * 而不是静默无反应 —— 静默最糟，玩家会以为 UI 坏了（#485）。
   * 接上回调后把它改成 `false`；`client/tools/test-bottom-nav.cjs` 会核对这份名单。
   */
  comingSoon: boolean;
}

export const bottomNavItems: BottomNavItem[] = [
  { key: "role", label: "角色", icon: bottomNavImage("role"), openLevel: 1, shortcutKey: "C", comingSoon: false },
  { key: "bag", label: "背包", icon: bottomNavImage("bag"), openLevel: 1, shortcutKey: "B", comingSoon: false },
  { key: "friend", label: "好友", icon: bottomNavImage("friend"), openLevel: 10, shortcutKey: "F", comingSoon: true },
  { key: "group", label: "组队", icon: bottomNavImage("group"), openLevel: 10, shortcutKey: "G", comingSoon: false },
  { key: "skill", label: "技能", icon: bottomNavImage("skill"), openLevel: 1, shortcutKey: "K", comingSoon: false },
  { key: "mall", label: "商城", icon: bottomNavImage("mall"), openLevel: 1, shortcutKey: "M", comingSoon: false },
];
