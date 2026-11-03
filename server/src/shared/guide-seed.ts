/**
 * 新手引导步骤（**唯一书写处**，#605）
 *
 * 引导本身是纯客户端的体验状态（没有奖励、没有结算，进度存在角色存档 `role.guide` 里），
 * 但**步骤表是运营内容**：先教走路、还是先教打怪，文案怎么写、每一步高亮哪里、
 * 什么事件推进下一步 —— 这些以前写死在 `client/assets/configs/guide.ts`，改一句文案都要发版。
 *
 * 现在只在这里写出厂值：seed 进 `guide_settings` 单行表 → 管理端「新手引导」页可改 →
 * 配置快照 `guideSteps` 段下发 → 客户端 `applyGuideSteps()` 整表替换。
 *
 * ## 什么可以运营改、什么不行
 * - **改**：步骤的增删、顺序、文案（标题 / 正文）、高亮语义位、推进事件；
 * - **不改**：两套枚举本身（`GUIDE_SPOTS` / `GUIDE_EVENTS`）。它们是**客户端代码里的能力边界**：
 *   一个新的高亮位要 `GuideOverlay` 认识这个节点，一个新的推进事件要在玩法代码里 `notify` 一次
 *   —— 那一刻本来就要写代码。所以这里只做白名单校验：配了白名单外的值，客户端会跳过那一步
 *   （而不是让玩家卡在一步永远推进不了的引导上）。
 *
 * ## 步数上限
 * `GUIDE_STEP_MAX` 同时是**服务端存档校验**的上限（`role.guide.step` 不能超过它）：
 * 配置里能加到多少步，存档里就必须能存多少步，两处必须是同一个数（曾经是两个常量）。
 */
/** 引导步骤上限（= 存档里 `guide.step` 的合法上界） */
export const GUIDE_STEP_MAX = 64;

/** 高亮语义位白名单（与客户端 `types/guide.GUIDE_SPOT` 逐值一致） */
export const GUIDE_SPOTS = ["joystick", "nav:bag", "nav:skill", "nav:chat", "shortcut"] as const;

/** 推进事件白名单（与客户端 `types/guide.GUIDE_EVENT` 逐值一致） */
export const GUIDE_EVENTS = ["move", "kill", "pickup", "openBag", "openSkill", "openChat"] as const;

/** 高亮语义位 / 推进事件的取值类型（由上面两个白名单推导，写错值在编译期就红） */
export type GuideSpotValue = (typeof GUIDE_SPOTS)[number];
export type GuideEventValue = (typeof GUIDE_EVENTS)[number];

/** 步骤表的一行（形状与客户端 `configs/guide.GuideStepConfig` 一致） */
export interface GuideStepSeed {
  /** 步骤标识（落日志与单测用，不落存档；同一份配置里必须唯一） */
  id: string;
  /** 气泡标题（一句话的名字） */
  title: string;
  /** 气泡正文（说清「做什么」，一句话） */
  desc: string;
  /** 高亮语义位（`GuideOverlay` 按它现取节点；取不到就退化成只有气泡） */
  spot: GuideSpotValue;
  /** 推进事件：当前步收到它才前进（别的事件不越级） */
  trigger: GuideEventValue;
}

/**
 * 出厂步骤表（顺序即体验顺序：先会走路，再会打，再知道东西去哪了，最后指向聊天与技能）
 *
 * 文案口径：一句话说清「做什么」，不讲玩法名词（玩家此刻还不知道什么叫快捷栏）。
 */
export const GUIDE_STEP_SEEDS: GuideStepSeed[] = [
  {
    id: "move",
    title: "先动起来",
    desc: "拖住左下角的摇杆走两步；电脑上也可以按住方向键或点地面。",
    spot: "joystick",
    trigger: "move",
  },
  {
    id: "fight",
    title: "打一只怪",
    desc: "走近怪物，点下面的技能（或按 1~6）就能出手。",
    spot: "shortcut",
    trigger: "kill",
  },
  {
    id: "loot",
    title: "把掉落捡起来",
    desc: "怪死了会掉东西，走上去就会自动拾取，东西直接进背包。",
    spot: "nav:bag",
    trigger: "pickup",
  },
  {
    id: "bag",
    title: "看看背包",
    desc: "刚捡的装备和药都在这里：点格子看详情，装备可以直接穿上。",
    spot: "nav:bag",
    trigger: "openBag",
  },
  {
    id: "skill",
    title: "认识你的技能",
    desc: "技能列表里有全部技能和解锁等级，拖到快捷栏就能随时用。",
    spot: "nav:skill",
    trigger: "openSkill",
  },
  {
    id: "social",
    title: "别一个人玩",
    desc: "聊天分世界 / 帮会 / 私聊三页；任务在左边的追踪栏，点一下就能打开任务面板。",
    spot: "nav:chat",
    trigger: "openChat",
  },
];
