import { Color } from "cc";
import { GUIDE_EVENT, GUIDE_SPOT } from "../types/guide";
import type { GuideEvent, GuideSpot } from "../types/guide";

/**
 * 新手引导的步骤表（#402；#605 起由服务端下发）
 *
 * **步骤是数据不是代码**：文案 / 高亮目标 / 触发事件全在数据里，`GuideStore` 只负责
 * 「当前这一步的 trigger 到了就 +1」，`GuideOverlay` 只负责把这一步画出来。
 *
 * ## #605：表搬到服务端了
 * 以前这张表写死在本文件（改一句文案要重打客户端包）。现在它来自配置快照的
 * `guideSteps` 段（出厂值在 `server/src/shared/guide-seed.ts`，运营在管理端「新手引导」页改），
 * 由 `applyGuideSteps()` **整表替换**：
 * - 进游戏拉到快照之前，`guideSteps` 是**空表** —— `guideStepCount()` 为 0，
 *   `normalizeGuideProgress` 会把存档里的进度按「已完成」处理（不会因为表还没到就把玩家
 *   卡在第 0 步，也不会把已经走完的老号重新弹一遍）；
 * - 快照到达后表才有内容（`ConfigLoader` 保证「配置就绪才进图」）。
 *
 * 本文件保留的是**客户端自己的那一半**：遮罩配色、节点名契约、气泡排版、全局文案 ——
 * 这些是表现层，运营改了也没有意义（改颜色要重看一遍 UI，改节点名会让代码取不到节点）。
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

/** 当前步骤表（快照到达前为空 —— 见文件头「#605」那段） */
export let guideSteps: GuideStepConfig[] = [];

/**
 * 整表替换（`apply-snapshot` 用）
 *
 * 逐行校验后**只认认识的步骤**：`spot` / `trigger` 是客户端能力白名单
 * （`types/guide.GUIDE_SPOT` / `GUIDE_EVENT`），服务端 DTO 已经卡过一遍，这里再卡一遍是因为
 * 「配了客户端不认识的值」的后果是**玩家卡在那一步永远推进不了**（事件永远不会命中）——
 * 与其卡死，不如跳过这一步：少一步引导不影响玩，卡住是致命的。
 *
 * 空数组视为「服务端把引导关了」→ 表为空 → 进度按已完成处理。
 */
export function applyGuideSteps(rows: unknown): void {
  if (!Array.isArray(rows)) return;
  // 用 Object.keys + 索引而不是 Object.values：客户端 tsconfig 的 lib 没有 ES2017（TS2550）
  const eventValues = Object.keys(GUIDE_EVENT).map((key) => GUIDE_EVENT[key as keyof typeof GUIDE_EVENT] as string);
  const spotValues = Object.keys(GUIDE_SPOT).map((key) => GUIDE_SPOT[key as keyof typeof GUIDE_SPOT] as string);
  const steps: GuideStepConfig[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const source = row as Record<string, unknown>;
    const id = typeof source.id === "string" ? source.id : "";
    const title = typeof source.title === "string" ? source.title : "";
    const desc = typeof source.desc === "string" ? source.desc : "";
    const spot = typeof source.spot === "string" ? source.spot : "";
    const trigger = typeof source.trigger === "string" ? source.trigger : "";
    if (!id || !title || !desc || seen.has(id)) continue;
    // 用 indexOf 而不是 includes：客户端 tsconfig 的 lib 只到 ES2015（TS2550）
    if (spotValues.indexOf(spot) < 0 || eventValues.indexOf(trigger) < 0) {
      console.warn(`[guide] 跳过第 ${steps.length + 1} 步「${id}」：高亮位 ${spot} / 推进事件 ${trigger} 不在客户端支持范围内`);
      continue;
    }
    seen.add(id);
    steps.push({ id, title, desc, spot: spot as GuideSpot, trigger: trigger as GuideEvent });
  }
  guideSteps = steps;
}

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
    next: "guide_next",
    /** 下一步按钮上的文字节点（`GameUiHelper.createMiddleButton` 按 `${name}_label` 生成，这里是那个契约） */
    nextLabel: "guide_next_label",
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
  /** 遮罩与气泡的尺寸/间距（按 1920×1080 的设计分辨率定的值） */
  layout: {
    /** 遮罩不透明度（0~255；不能太黑，玩家要看得到世界） */
    maskOpacity: 150,
    /** 高亮框相对目标节点的外扩（像素） */
    spotPadding: 10,
    /** 高亮框线宽 */
    spotBorderWidth: 3,
    /**
     * 气泡宽度 / 高度 / 内边距 / 与高亮框的间距 / 离屏幕边缘的安全边距
     *
     * 宽度按**最长一句正文能一行放下**定：正文可用宽 = bubbleWidth − padding×2 = 520，
     * 最长那句 24 个汉字 × 20 号 ≈ 480 —— 原来 520 宽（可用 480）配 22 号放不下，
     * 末行只剩「手。」（#466）。
     */
    bubbleWidth: 560,
    /**
     * 气泡高度 210（原来 190）
     *
     * 底部那一行原来只放一个「跳过引导」，现在并排放「跳过 + 下一步」（两个中号按钮 123×36 = 258 宽），
     * 正文折两行时的下沿要给它们让出位置，见 test-guide 的排版守点。
     */
    bubbleHeight: 210,
    bubblePadding: 20,
    bubbleGap: 18,
    /** 底部两个按钮之间的间距 */
    buttonGap: 12,
    /** 标题占位底部与正文顶部的间距（正文锚点在顶边向下长，见 GuideOverlay.createBubble） */
    descGap: 8,
    screenMargin: 24,
    /** 气泡里的三档字号 */
    titleFontSize: 26,
    descFontSize: 20,
    progressFontSize: 20,
  },
  /** 文案（分步文案在 guideSteps 里，这里只放全局的） */
  texts: {
    /** 左上角的进度，如「新手引导 2/6」 */
    progress: "新手引导 {index}/{total}",
    /** 跳过按钮 */
    skip: "跳过引导",
    /** 下一步按钮（非最后一步） */
    next: "下一步",
    /** 最后一步的按钮文案（点下去就是走完） */
    finish: "完成",
    /** 全部走完的飘字 */
    finished: "引导结束，去玩吧！",
    /** 主动跳过的飘字 */
    skipped: "已跳过新手引导",
  },
};
