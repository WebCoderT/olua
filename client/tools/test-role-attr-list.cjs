#!/usr/bin/env node
/**
 * 角色属性列表几何单测（client/tools/test-role-attr-list.cjs，issue #470）
 *
 * 盯的不变量：
 * A. **属性列表不能压到右侧功能按钮列**（#470 的真问题）——列表锚点在顶边、高度由内容
 *    撑开，8 行基础属性一路向下长；而弹窗右侧那列按钮（称号/战魂/军衔/时装/社交）
 *    最上面一枚「社 交」就在 -49~-13。列表底边高于按钮顶边才算过。
 * B. 行高能装下字号（行高 ≥ 字号 × 1.4，压字也算排版问题）。
 * C. **不留空分节标题**：`applyRoleAttributeListStyle` 不再画「特殊属性」那种没有行跟着的标题
 *    （#470 排查时发现那行标题下面一直是空的，还正好压在最上面那枚按钮上）。
 *
 * 数字全部从**真实配置**算（configs/layout/panels + dialogs + sizes + configs/good 的行数），
 * 不是抄一份常量 —— 改配置改错了这里先红。
 *
 * 用法：node client/tools/test-role-attr-list.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

try {
  const outDir = prepare("olua-role-attr", [
    "configs/layout/panels.ts",
    "configs/layout/dialogs.ts",
    "configs/layout/sizes.ts",
    "configs/good.ts",
  ]);
  const { roleAttributeListLayout: L } = require(path.join(outDir, "configs/layout/panels.js"));
  const { roleInfoDialogLayout: DIALOG } = require(path.join(outDir, "configs/layout/dialogs.js"));
  const { uiSize } = require(path.join(outDir, "configs/layout/sizes.js"));
  const { goodShowAttributesLabel } = require(path.join(outDir, "configs/good.js"));

  //#region A. 列表底边 vs 按钮顶边

  console.log("\n— A. 属性列表不压右侧按钮列 —");

  const rows = goodShowAttributesLabel.size;
  check(rows > 0, `基础属性行数取自配置（${rows} 行）`);

  // 结构：1 个分节标题 + N 个属性行；相邻子件之间有 spacing，容器上下各 padding
  const height = L.padding * 2 + L.titleHeight + rows * L.rowHeight + rows * L.spacing;
  const bottom = L.position.y - height;
  const socialTop = DIALOG.socialButton.position.y + uiSize.middleButtonSize.height / 2;

  check(
    bottom >= socialTop + 4,
    `列表底边在「社 交」按钮之上（底边 ${bottom.toFixed(0)} ≥ 按钮顶边 ${socialTop.toFixed(0)} + 4；列表高 ${height.toFixed(0)}）`,
  );

  // 两者横向是重叠的（列表 142~292、按钮 138.5~261.5），垂直分离是唯一保障 —— 这句断言就是那个前提
  const listLeft = L.position.x - L.size.width / 2;
  const listRight = L.position.x + L.size.width / 2;
  const buttonLeft = DIALOG.socialButton.position.x - uiSize.middleButtonSize.width / 2;
  const buttonRight = DIALOG.socialButton.position.x + uiSize.middleButtonSize.width / 2;
  const xOverlap = listLeft < buttonRight && listRight > buttonLeft;
  check(
    !xOverlap || bottom >= socialTop + 4,
    `横向重叠（列表 ${listLeft.toFixed(0)}~${listRight.toFixed(0)} / 按钮 ${buttonLeft.toFixed(0)}~${buttonRight.toFixed(0)}）时必须有垂直分离`,
  );

  // 列表也不能顶到弹窗标题栏（锚点是顶边，内容向下长；标题栏占弹窗顶部约 40，锚点从 y=205 起排）
  check(L.position.y <= 210, `列表锚点在弹窗标题栏之下（${L.position.y} ≤ 210）`);

  //#endregion

  //#region B. 行高 vs 字号

  console.log("\n— B. 行高装得下字号 —");

  check(L.rowHeight >= L.rowFontSize * 1.4, `行高 ${L.rowHeight} ≥ 字号 ${L.rowFontSize} × 1.4 = ${(L.rowFontSize * 1.4).toFixed(1)}（不压字）`);
  check(L.titleHeight >= 14, `分节标题高度 ${L.titleHeight} ≥ 14`);

  //#endregion

  //#region C. 不留空分节标题

  console.log("\n— C. 不留空分节标题 —");

  const helper = read("assets/ui/helpers/GameUiHelper.ts");
  const body = /static applyRoleAttributeListStyle[\s\S]*?\n {2}\}/.exec(helper);
  check(!!body, "找到 applyRoleAttributeListStyle 函数体");
  if (body) {
    const titles = body[0].match(/createText\(\s*"[^"]*attributes[^"]*"/g) || [];
    check(titles.length === 1, `属性列表只画一个分节标题（实际 ${titles.length} 个：${titles.join(", ") || "无"}）`);
    check(!/label_attributes_special/.test(body[0]), "不再画没有行跟着的「特殊属性」标题（#470）");
  }

  //#endregion
} catch (error) {
  fail(error);
}

finish("✅ 属性列表几何单测全绿");
