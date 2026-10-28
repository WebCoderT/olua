import { Color } from "cc";
import { GUIDE_EVENT, GUIDE_SPOT } from "../types/guide";
import type { GuideEvent, GuideSpot } from "../types/guide";

/**
 * 新手引导的步骤表（#402）
 *
 * **步骤是数据不是代码**：文案 / 高亮目标 / 触发事件全在这里，`GuideStore` 只负责
 * 「当前这一步的 trigger 到了就 +1」，`GuideOverlay` 只负责把这一步画出来。
 * 加一步 = 在这里加一条（前提是触发方式复用已有事件，见 types/guide.GUIDE_EVENT 的注释）。
 *
 * 设计口径：
 * - **不锁操作**：遮罩只是视觉层，玩家随时能点「跳过」、随时能自己乱点；
 * - **每步都有确定的推进条件**，不依赖「点了某个按钮才继续」—— 玩家自己玩着玩着就过了；
 * - 步骤顺序即体验顺序：先会走路，再会打，再知道东西去哪了，最后指向聊天与任务
 *   （这两块是 #395 / #396 的成果，引导是它们的入口）。
 */
export interface GuideStepConfig {
  /** 步骤标识（落日志与单测用，不落存档） */
  id: string;
  /** 气泡标题 */
  title: string;
  /** 气泡正文（一句话说清「做什么」） */
  desc: string;
  /** 高亮目标（取不到节点时退化为只有气泡） */
  spot: GuideSpot;
  /** 推进事件：当前步收到它才前进 */
  trigger: GuideEvent;
}

export const guideSteps: GuideStepConfig[] = [
  {
    id: "move",
    title: "先动起来",
    desc: "拖住左下角的摇杆走两步；电脑上也可以按住方向键或点地面。",
    spot: GUIDE_SPOT.JOYSTICK,
    trigger: GUIDE_EVENT.MOVE,
  },
  {
    id: "fight",
    title: "打一只怪",
    desc: "走近怪物，点下面的技能（或按 1~6）就能出手。",
    spot: GUIDE_SPOT.SHORTCUT,
    trigger: GUIDE_EVENT.KILL,
  },
  {
    id: "loot",
    title: "把掉落捡起来",
    desc: "怪死了会掉东西，走上去就会自动拾取，东西直接进背包。",
    spot: GUIDE_SPOT.NAV_BAG,
    trigger: GUIDE_EVENT.PICKUP,
  },
  {
    id: "bag",
    title: "看看背包",
    desc: "刚捡的装备和药都在这里：点格子看详情，装备可以直接穿上。",
    spot: GUIDE_SPOT.NAV_BAG,
    trigger: GUIDE_EVENT.OPEN_BAG,
  },
  {
    id: "skill",
    title: "认识你的技能",
    desc: "技能列表里有全部技能和解锁等级，拖到快捷栏就能随时用。",
    spot: GUIDE_SPOT.NAV_SKILL,
    trigger: GUIDE_EVENT.OPEN_SKILL,
  },
  {
    id: "social",
    title: "别一个人玩",
    desc: "聊天分世界 / 帮会 / 私聊三页；任务在左边的追踪栏，点一下就能打开任务面板。",
    spot: GUIDE_SPOT.NAV_CHAT,
    trigger: GUIDE_EVENT.OPEN_CHAT,
  },
];

/** 步骤总数（`step` 到它就算走完） */
export function guideStepCount(): number {
  return guideSteps.length;
}

/** 取某一步（越界返回 null —— 调用方据此判定「已经走完」） */
export function guideStepAt(index: number): GuideStepConfig | null {
  return index >= 0 && index < guideSteps.length ? guideSteps[index] : null;
}

/**
 * 遮罩层的节点名与配色
 *
 * 名字与颜色**不写在组件里**：节点名是「按名取子节点」的契约（改一处、找孩子的两处一起坏），
 * 颜色是视觉口径 —— 两者都算配置（`audit-config-leak` 也会把组件里的字面量打回）。
 */
export const guideOverlayStyle = {
  names: {
    overlay: "guide_overlay",
    mask: "guide_mask",
    frame: "guide_frame",
    bubble: "guide_bubble",
    bubbleBackground: "guide_bubble_bg",
    title: "guide_title",
    desc: "guide_desc",
    progress: "guide_progress",
    skip: "guide_skip",
  },
  colors: {
    /** 遮罩：黑，透明度见 layout.maskOpacity */
    mask: new Color(0, 0, 0, 150),
    /** 高亮描边（金色） */
    frame: new Color(255, 214, 102, 255),
    /** 气泡底板（深蓝黑，半透明） */
    bubble: new Color(16, 20, 32, 235),
    /** 气泡描边（与高亮框同色） */
    bubbleBorder: new Color(255, 214, 102, 255),
    /** 标题 / 正文 / 进度三段文字 */
    title: new Color(255, 214, 102, 255),
    desc: new Color(226, 232, 240, 255),
    progress: new Color(148, 163, 184, 255),
  },
  /** 气泡圆角半径 */
  bubbleRadius: 12,
  /** 气泡描边线宽 */
  bubbleBorderWidth: 2,
};

/**
 * 引导的调参与文案
 *
 * 数字一律放配置：组件里出现裸阈值会被 `audit-config-leak` 打回，
 * 而且这类「手感值」本来就该能改。
 */
export const guideConfig = {
  /** 手感：累计移动多远算「会走路了」（世界坐标像素，不是屏幕像素） */
  tuning: {
    moveDistance: 260,
  },
  /** 遮罩与气泡的尺寸/间距（1624×750 设计分辨率下的裁剪值） */
  layout: {
    /** 遮罩不透明度（0~255；不能太黑，玩家要看得到世界） */
    maskOpacity: 150,
    /** 高亮框相对目标节点的外扩（像素） */
    spotPadding: 10,
    /** 高亮框线宽 */
    spotBorderWidth: 3,
    /** 气泡宽度 / 高度 / 内边距 / 与高亮框的间距 / 离屏幕边缘的安全边距 */
    bubbleWidth: 520,
    bubbleHeight: 190,
    bubblePadding: 20,
    bubbleGap: 18,
    /** 标题占位底部与正文顶部的间距（正文锚点在顶边向下长，见 GuideOverlay.createBubble） */
    descGap: 8,
    screenMargin: 24,
    /** 气泡里的三档字号 */
    titleFontSize: 26,
    descFontSize: 22,
    progressFontSize: 20,
  },
  /** 文案（分步文案在 guideSteps 里，这里只放全局的） */
  texts: {
    /** 左上角的进度，如「新手引导 2/6」 */
    progress: "新手引导 {index}/{total}",
    /** 跳过按钮 */
    skip: "跳过引导",
    /** 全部走完的飘字 */
    finished: "引导结束，去玩吧！",
    /** 主动跳过的飘字 */
    skipped: "已跳过新手引导",
  },
};
