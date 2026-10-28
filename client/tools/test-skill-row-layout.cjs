#!/usr/bin/env node
/**
 * 技能行排版单测（client/tools/test-skill-row-layout.cjs，issue #481）
 *
 * 盯的不变量：
 *   1. `TextLayout.wrappedLineCount` 的估算口径（中文 1 字宽 / ASCII 0.55 字宽 / 显式换行 / 空串）；
 *   2. 技能行的几何自洽（行宽 = 图标 + 间距 + 说明列）；
 *   3. **`configs/skill-data.ts` 里每一条说明都能在 `maxLines` 行内显示完** ——
 *      这条是重点：说明曾经是单行 CLAMP，205 宽只有 ~20 字，40~73 字的说明后半句直接看不到（#481）。
 *      将来有人把说明写得更长，这里先红，而不是等玩家在游戏里看不见。
 *
 * 用法：node client/tools/test-skill-row-layout.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

try {
  const outDir = prepare("olua-skill-row", [
    "configs/layout/dialogs.ts",
    "configs/skill.ts",
    "ui/helpers/TextLayout.ts",
  ]);
  const { wrappedLineCount, wrappedHeight } = require(path.join(outDir, "ui/helpers/TextLayout.js"));
  const { skillListDialogLayout } = require(path.join(outDir, "configs/layout/dialogs.js"));
  const { skillData } = require(path.join(outDir, "configs/skill-data.js"));

  const desc = skillListDialogLayout.row.desc;

  console.log("\n— A. 换行估算口径 —");
  {
    const cpl = Math.floor(desc.width / desc.fontSize); // 20 字（205 / 10）
    check(wrappedLineCount("", desc.width, desc.fontSize) === 0, "空文本不占行（0 行）");
    check(
      wrappedLineCount("字".repeat(cpl), desc.width, desc.fontSize) === 1,
      `${cpl} 个汉字恰好一行（${desc.width} / ${desc.fontSize}）`,
    );
    check(
      wrappedLineCount("字".repeat(cpl + 1), desc.width, desc.fontSize) === 2,
      `${cpl + 1} 个汉字换到第二行`,
    );
    check(wrappedLineCount("第一行\n第二行", desc.width, desc.fontSize) === 2, "显式 \\n 强制换行");
    // ASCII 更窄：同样宽度能放下的字符数比汉字多（205 / 5.5 ≈ 37 个字母）
    const lettersPerLine = Math.floor(desc.width / (desc.fontSize * 0.55));
    check(
      lettersPerLine > cpl && wrappedLineCount("a".repeat(lettersPerLine), desc.width, desc.fontSize) === 1,
      `ASCII 按 0.55 字宽算（${lettersPerLine} 个字母一行；同样宽度只放得下 ${cpl} 个汉字）`,
    );
    check(
      wrappedLineCount("a".repeat(lettersPerLine + 1), desc.width, desc.fontSize) === 2,
      `再多一个字母就换行（${lettersPerLine + 1} 个 → 2 行）`,
    );
    check(
      wrappedHeight("字".repeat(cpl * 3), desc.width, desc.fontSize, desc.lineHeight, desc.maxLines) === 3 * desc.lineHeight,
      "高度 = 行数 × 行高",
    );
    check(
      wrappedHeight("字".repeat(cpl * 10), desc.width, desc.fontSize, desc.lineHeight, desc.maxLines) === desc.maxLines * desc.lineHeight,
      `超长文本被 maxLines 截住（${desc.maxLines} × ${desc.lineHeight}）`,
    );
  }

  console.log("\n— B. 行内几何自洽 —");
  {
    const row = skillListDialogLayout.row;
    check(
      row.width === row.iconSize + row.gap + row.desc.width,
      `行宽 = 图标 + 间距 + 说明列（${row.width} = ${row.iconSize} + ${row.gap} + ${row.desc.width}）`,
    );
    check(row.desc.width <= skillListDialogLayout.list.size.width, `说明列不宽于列表（${row.desc.width} ≤ ${skillListDialogLayout.list.size.width}）`);
    check(row.iconSize <= row.width, `图标不宽于行（${row.iconSize} ≤ ${row.width}）`);
  }

  console.log("\n— C. 每条技能说明都能在 maxLines 内显示完 —");
  {
    let worst = { id: "", lines: 0, len: 0 };
    const overflow = [];
    for (const item of skillData) {
      const text = item.description ?? "";
      const lines = wrappedLineCount(text, desc.width, desc.fontSize);
      if (lines > worst.lines) worst = { id: item.id, lines, len: Array.from(text).length };
      if (lines > desc.maxLines) overflow.push(`${item.id}（${lines} 行 / ${Array.from(text).length} 字）`);
      // 行高下限：一行说明的技能不该比图标矮
      const height = Math.max(
        skillListDialogLayout.row.iconSize,
        desc.nameHeight + desc.gap + wrappedHeight(text, desc.width, desc.fontSize, desc.lineHeight, desc.maxLines) + desc.paddingY * 2,
      );
      if (height < skillListDialogLayout.row.iconSize) overflow.push(`${item.id} 行高低于图标（${height}）`);
    }
    check(skillData.length > 0, `技能数据非空（${skillData.length} 条）`);
    check(overflow.length === 0, `全部说明在 ${desc.maxLines} 行内放得下`, overflow.length ? overflow.join(" / ") : "");
    check(worst.lines <= desc.maxLines, `最长一条 ${worst.id}：${worst.lines} 行 / ${worst.len} 字（上限 ${desc.maxLines} 行）`);
  }
} catch (error) {
  fail(error);
}

finish("✅ 技能行排版单测全绿");
