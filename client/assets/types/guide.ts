/**
 * 新手引导的类型（#402）
 *
 * 引导是**纯客户端的体验状态**：没有奖励、没有结算，所以不需要服务端权威 ——
 * 进度就存在角色存档里（`role.guide`），换设备 / 重连 / 重启都自然续走。
 * 服务端只把关：结构对不对、步数在不在体量上限内（见 server 的 `parseRoleData`）。
 */

/**
 * 引导的推进事件（有限集合 —— 这是刻意收的边界）
 *
 * 每一步的 `trigger` 就是这六个之一：**当前步的触发事件到了才前进**，别的事件不越级。
 * 想加一步「点 NPC 对话」这类新玩法，就得先在这里加一个事件 + 在对应位置 notify 一次
 * —— 那一刻本来就要写代码，所以「加一步不用改代码」的边界是「不改触发方式」。
 */
export const GUIDE_EVENT = {
  /** 累计移动超过阈值（配置在 configs/guide.tuning.moveDistance） */
  MOVE: "move",
  /** 首次击杀怪物（服务端结算落账那一刻，不论经验是否为 0） */
  KILL: "kill",
  /** 首次拾取成功（服务端应答 ok 才算） */
  PICKUP: "pickup",
  /** 打开过背包面板 */
  OPEN_BAG: "openBag",
  /** 打开过技能列表 */
  OPEN_SKILL: "openSkill",
  /** 打开过聊天面板 */
  OPEN_CHAT: "openChat",
} as const;
export type GuideEvent = (typeof GUIDE_EVENT)[keyof typeof GUIDE_EVENT];

/**
 * 高亮目标（`GuideOverlay` 按它去拿真实节点）
 *
 * 刻意不用「写死屏幕坐标」：HUD 是贴边重排的（HUD 位置见 hudLayout 各 position（固定值）），
 * 换窗口宽高比坐标就错位。所以这里存的是**语义位**，由 `GuideOverlay` 现取节点；
 * 取不到（面板未创建 / 被销毁）就退化为「只显示底部气泡」，不画洞也不报错。
 */
export const GUIDE_SPOT = {
  /** 左下角摇杆 */
  JOYSTICK: "joystick",
  /** 底部功能栏的某个入口（值与 configs/bottomNav 的 key 一致） */
  NAV_BAG: "nav:bag",
  NAV_SKILL: "nav:skill",
  NAV_CHAT: "nav:chat",
  /** 技能快捷键栏（打怪那一步指这里 —— 怪会跑，画个洞没意义） */
  SHORTCUT: "shortcut",
} as const;
export type GuideSpot = (typeof GUIDE_SPOT)[keyof typeof GUIDE_SPOT];

/**
 * 引导进度（存进角色存档的 `guide` 字段）
 *
 * - `step`：当前进行到第几步（0 起；等于步骤总数 = 走完了）
 * - `done`：走完过（`step` 到末尾时置 true；老档补齐也是 true）
 * - `skipped`：玩家主动跳过（之后不再弹，且**不再自动开始**）
 */
export interface GuideProgress {
  step: number;
  done: boolean;
  skipped: boolean;
}
