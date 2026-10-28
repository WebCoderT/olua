/**
 * 文本排版估算（纯函数，不 import cc —— 单测可直接跑真代码）
 *
 * 用途：给「按宽度换行的窄容器」算行高。`Label` 的真实高度要等字体加载 + 渲染数据刷新，
 * 而布局在创建那一刻就要定下来（行高决定 ScrollView 里每行的位置），所以用估算：
 *
 *   - 中文 / 全角：1 个字宽 = fontSize（宋体方块字，实测误差 < 5%）
 *   - ASCII / 半角：0.55 个字宽（数字与字母在宋体下明显窄于汉字）
 *   - **宁可多算半行留白，也不能少算**：少算一行 = 最后一行字被 CLAMP 切掉，
 *     多算一行只是行底多几像素空白（#481 的教训就是说明被单行 CLAMP 切掉后半句）
 *
 * 与 `client/tools/test-skill-row-layout.cjs` 配套：那里逐条断言技能说明在 maxLines 内放得下。
 */

/** 全角字符区间（中文、日文假名、韩文、全角标点、CJK 兼容区） */
const FULL_WIDTH = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

/** 单个字符占几个「字宽」（1 字宽 = fontSize 像素） */
export function charWidthRatio(char: string): number {
  if (char === "\n") return 0;
  return FULL_WIDTH.test(char) ? 1 : 0.55;
}

/**
 * 按宽度换行后占几行（0 表示空文本不占行）
 *
 * @param text 文本（可用 `\n` 强制换行）
 * @param width 容器宽度（像素）
 * @param fontSize 字号（像素）
 * @returns 行数
 */
export function wrappedLineCount(text: string, width: number, fontSize: number): number {
  if (!text) return 0;
  if (width <= 0 || fontSize <= 0) return 0;
  // 用 Array.from 而不是 for..of：打包走 babel loose，字符串迭代器会被降级出问题
  const chars = Array.from(text);
  let lines = 1;
  let used = 0;
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === "\n") {
      lines += 1;
      used = 0;
      continue;
    }
    const w = charWidthRatio(char) * fontSize;
    if (used + w > width + 0.01) {
      lines += 1;
      used = w;
    } else {
      used += w;
    }
  }
  return lines;
}

/**
 * 按宽度换行、并受最大行数限制后，**实际能显示的行高**（像素）
 *
 * 行高取「估算行数」与「最大行数」的较小值 —— 超出的部分由 Label 的 CLAMP 自己裁。
 */
export function wrappedHeight(text: string, width: number, fontSize: number, lineHeight: number, maxLines: number): number {
  const lines = Math.min(wrappedLineCount(text, width, fontSize), Math.max(1, maxLines));
  return lines * lineHeight;
}
