#!/usr/bin/env node
/**
 * 弹窗行内文字边界单测（client/tools/test-dialog-row-bounds.cjs，issue #477）
 *
 * 盯的不变量：**行内文字必须真的在行里**。
 *
 * 背景：`UiHelper.createLabel` 默认 `overflow = CLAMP` + 左对齐，文字**从文本框左缘起排**；
 * 而布局里给的是文本框**中心 x**。行是 552 宽（半宽 276）时，`nameX = −180 / 宽 360`
 * 的文本框左缘是 −360 —— 跑出行外 84px，被 ScrollView 的遮罩裁掉，于是任务名整行看不见（#477）。
 * 这类错 tsc 不报、数据 e2e 不报、文字重叠审计也不报（被裁的部分压根没渲染），
 * 只能靠「拿配置算 bbox」这种静态断言拦。
 *
 * 覆盖四处同构行（都带 nameX/nameSize，都有右侧按钮列）：
 *   chatDialogLayout.row（消息行）/ questDialogLayout.row / partyDialogLayout.row /
 *   leaderboardDialogLayout.row
 *
 * 用法：node client/tools/test-dialog-row-bounds.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

/** 行内文字到行左右缘的最小留白（与各布局注释里的「左缘 + 16」一致） */
const INSET = 16;

try {
  const outDir = prepare("olua-row-bounds", ["configs/layout/dialogs.ts"]);
  const { chatDialogLayout, questDialogLayout, partyDialogLayout, leaderboardDialogLayout } = require(
    path.join(outDir, "configs/layout/dialogs.js"),
  );
  const { uiSize } = require(path.join(outDir, "configs/layout/sizes.js"));

  /** 文本框 bbox（锚点 0.5/0.5） */
  const box = (x, size) => ({ left: x - size.width / 2, right: x + size.width / 2, width: size.width });

  console.log("\n— A. 名字 / 次行文字框在行内 —");

  const cases = [
    { name: "chat", layout: chatDialogLayout, row: chatDialogLayout.row, label: "消息行" },
    { name: "quest", layout: questDialogLayout, row: questDialogLayout.row, label: "任务行" },
    { name: "party", layout: partyDialogLayout, row: partyDialogLayout.row, label: "队伍成员行" },
    { name: "partyInvite", layout: partyDialogLayout, row: partyDialogLayout.inviteRow, label: "队伍邀请行" },
    { name: "leaderboard", layout: leaderboardDialogLayout, row: leaderboardDialogLayout.row, label: "排行榜行" },
  ];

  for (const item of cases) {
    const row = item.row;
    const half = row.size.width / 2;
    const name = box(row.nameX, row.nameSize);
    check(
      name.left >= -half + INSET - 0.01,
      `${item.label}：名字框左缘在行内（${name.left.toFixed(1)} ≥ ${(-half + INSET).toFixed(1)}）`,
    );
    check(name.right <= half - INSET + 0.01, `${item.label}：名字框右缘在行内（${name.right.toFixed(1)} ≤ ${(half - INSET).toFixed(1)}）`);

    if (row.metaX !== undefined) {
      const meta = box(row.metaX, row.metaSize);
      check(
        meta.left >= -half + INSET - 0.01 && meta.right <= half - INSET + 0.01,
        `${item.label}：次行框在行内（${meta.left.toFixed(1)}~${meta.right.toFixed(1)} / 行 ±${half.toFixed(0)}）`,
      );
    }

    // 正文列（目前只有聊天消息行有）：既要在行内，也要与名字列 bbox 衔接不重叠
    if (row.textX !== undefined && row.textSize !== undefined) {
      const text = box(row.textX, row.textSize);
      check(
        text.left >= -half + INSET - 0.01 && text.right <= half - INSET + 0.01,
        `${item.label}：正文框在行内（${text.left.toFixed(1)}~${text.right.toFixed(1)} / 行 ±${half.toFixed(0)}）`,
      );
      check(name.right <= text.left + 0.01, `${item.label}：名字与正文不重叠（${name.right.toFixed(1)} ≤ ${text.left.toFixed(1)}）`);
    }
  }

  console.log("\n— B. 文字与右侧动作按钮不相交 —");

  const small = uiSize.smallButtonSize.width;
  const bottom = uiSize.middleButtonSize.width; // 背包 / 底部中号按钮宽（123）

  // 任务行 & 排行榜行 & 聊天行的动作按钮按中号/小号各自口径
  const buttonCases = [
    { label: "任务行", row: questDialogLayout.row, width: bottom, xs: [questDialogLayout.row.buttonX] },
    { label: "聊天选人行", row: chatDialogLayout.row, width: small, xs: [chatDialogLayout.pickRow.buttonX] },
    { label: "队伍行（两枚）", row: partyDialogLayout.row, width: small, xs: [partyDialogLayout.row.actionX, partyDialogLayout.row.action2X] },
    { label: "队伍邀请行（两枚）", row: partyDialogLayout.inviteRow, width: small, xs: [partyDialogLayout.inviteRow.acceptX, partyDialogLayout.inviteRow.declineX] },
  ];
  for (const c of buttonCases) {
    const row = c.row;
    const half = row.size.width / 2;
    // 文字框：名字与次行取更靠右的那个（聊天选人行没有 metaX，用 pickRow 的名字列）
    const nameX = row === chatDialogLayout.row ? chatDialogLayout.pickRow.nameX : row.nameX;
    const nameSize = row === chatDialogLayout.row ? chatDialogLayout.pickRow.nameSize : row.nameSize;
    const textRight = Math.max(box(nameX, nameSize).right, row.metaX !== undefined ? box(row.metaX, row.metaSize).right : -Infinity);
    for (const x of c.xs) {
      const left = x - c.width / 2;
      const right = x + c.width / 2;
      check(right <= half + 0.01, `${c.label}：按钮 @${x} 不越行右缘（${right.toFixed(1)} ≤ ${half.toFixed(0)}）`);
      check(left >= textRight - 0.01, `${c.label}：按钮 @${x} 不与文字重叠（${left.toFixed(1)} ≥ 文字右缘 ${textRight.toFixed(1)}）`);
    }
  }

  console.log("\n— C. ScrollView 遮罩比行更宽（遮罩不该切行内文字） —");

  const lists = [
    { label: "聊天列表", list: chatDialogLayout.list, row: chatDialogLayout.row },
    { label: "任务列表", list: questDialogLayout.list, row: questDialogLayout.row },
    { label: "队伍列表", list: partyDialogLayout.list, row: partyDialogLayout.row },
    { label: "排行榜列表", list: leaderboardDialogLayout.list, row: leaderboardDialogLayout.row },
  ];
  for (const item of lists) {
    check(
      item.list.size.width >= item.row.size.width,
      `${item.label}：列表宽 ${item.list.size.width} ≥ 行宽 ${item.row.size.width}（遮罩不切行本体）`,
    );
  }
} catch (error) {
  fail(error);
}

finish("✅ 弹窗行内文字边界单测全绿");
