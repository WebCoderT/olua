/**
 * 底部功能入口（按键区的数据表）
 *
 * 只描述「有哪些入口、长什么样」：名称 / 解锁等级 / 显示用快捷键。
 * 点击行为（打开哪个弹窗、后续接哪个功能）由组件按 `key` 关联 —— configs 不依赖 UI，
 * 回调是代码不是配置，所以留在 ui/components/hud/BottomBar。
 *
 * 外观是新稿（04-hud）的**矢量底板按钮**（玻璃底板 + 功能名 + 快捷键字母），
 * 不再使用带烙字的图标图（原 `ui/nav/*.png` 已删）。
 * 快捷键不只显示：BottomNavButton 会按 `shortcutKey` 监听全局键盘（见其文件头说明）。
 *
 * **顺序对齐 04-hud 稿**：角色 / 背包 / 技能 / 组队 / 好友 / 商城，最后单独一颗「设置」
 * （稿把它放在第二条竖分隔线之后，客户端目前没有设置弹窗 → 先按 comingSoon 占位，
 * 点了给「正在开发中」提示，不静默）。
 *
 * 新增入口：这里加一条 + 在 BottomBar 的回调表里补一条同名 key（未补则点击无反应，不会报错）。
 */
export interface BottomNavItem {
  /** 入口标识（组件按它关联点击回调，同时用于节点命名） */
  key: string;
  /** 功能名称（未解锁提示与按钮文字使用） */
  label: string;
  /** 解锁等级（角色等级低于该值时按钮灰显、点击只提示所需等级） */
  openLevel: number;
  /** 显示在按钮上的快捷键名（字母 = 对应键盘按键；同时是真实快捷键，见 BottomNavButton） */
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
  { key: "role", label: "角色", openLevel: 1, shortcutKey: "C", comingSoon: false },
  { key: "bag", label: "背包", openLevel: 1, shortcutKey: "B", comingSoon: false },
  { key: "skill", label: "技能", openLevel: 1, shortcutKey: "K", comingSoon: false },
  { key: "group", label: "组队", openLevel: 10, shortcutKey: "G", comingSoon: false },
  { key: "friend", label: "好友", openLevel: 10, shortcutKey: "F", comingSoon: true },
  { key: "mall", label: "商城", openLevel: 1, shortcutKey: "M", comingSoon: false },
  /** 稿的「设置」：独立一颗（第二条竖分隔线之后）；打开设置弹窗（选择角色 / 退出登录，稿 21-settings） */
  { key: "settings", label: "设置", openLevel: 1, shortcutKey: "ESC", comingSoon: false },
];
