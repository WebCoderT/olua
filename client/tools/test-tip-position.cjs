#!/usr/bin/env node
/**
 * 提示飘字落点单测（#1370：屏幕正上方、目标面板正下方，不与怪物头像面板重叠）
 *
 * 锁的是**空间关系**而不是外观精确值：
 * - tipsLayout 有 positionY / risePositionY；
 * - 上浮目标 + 飘字半高 < 目标面板底边（间隙 > 0），起点 < 上浮目标（上浮方向向上）；
 * - createFloatingTip 真的把飘字摆到 (0, positionY)（普通/错误共用一处）。
 * 面板/飘字的位置值改动时这里会红——提醒把间隙账一起重新核一遍（configs 注释同款口径）。
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) return;
  failures += 1;
  console.log(`  [!!] ${name}${detail ? "：" + detail : ""}`);
};
const finish = (passMessage) => {
  if (failures > 0) {
    console.log(`${passMessage} —— ${failures} 项未过`);
    process.exit(1);
  }
  console.log(passMessage);
};

function main() {
  const hudSrc = read("assets/configs/layout/hud.ts");
  const tipFxSrc = read("assets/ui/helpers/parts/tip-fx.ts");

  // 解析两个布局块的数值
  const num = (src, re) => {
    const m = re.exec(src);
    return m ? Number(m[1]) : NaN;
  };
  const tipsBlock = /export const tipsLayout = \{[\s\S]*?\n\};/.exec(hudSrc)?.[0] ?? "";
  const panelBlock = /export const monsterInfoPanelLayout = \{[\s\S]*?\n\};/.exec(hudSrc)?.[0] ?? "";
  check("hud.ts 有 tipsLayout 块", !!tipsBlock);
  check("hud.ts 有 monsterInfoPanelLayout 块", !!panelBlock);

  const positionY = num(tipsBlock, /positionY:\s*(\d+)/);
  const risePositionY = num(tipsBlock, /risePositionY:\s*(\d+)/);
  // size 的第二个数是高度（第一个是宽度 480，不能拿去算半高）
  const tipHeight = num(tipsBlock, /size:\s*new Size\(\d+,\s*(\d+)\)/);
  check("tipsLayout 有 positionY（#1370 起飘字起点）", Number.isFinite(positionY));
  check("tipsLayout 有 risePositionY", Number.isFinite(risePositionY));

  const panelY = num(panelBlock, /new Vec2\(0,\s*(\d+)\)/);
  const panelH = num(panelBlock, /size:\s*new Size\(\d+,\s*(\d+)\)/);
  check("monsterInfoPanelLayout 有 position (0, y)", Number.isFinite(panelY));
  check("monsterInfoPanelLayout 有 size", Number.isFinite(panelH));

  // 空间关系：上浮目标（+飘字半高）必须低于面板底边，起点低于上浮目标（向上浮）
  const panelBottom = panelY - panelH / 2;
  const tipHalf = (Number.isFinite(tipHeight) ? tipHeight : 24) / 2;
  check(
    `上浮目标 ${risePositionY}+半高${tipHalf} 须低于面板底边 ${panelBottom}（不重叠）`,
    risePositionY + tipHalf < panelBottom,
  );
  check(`起点 ${positionY} 须低于上浮目标 ${risePositionY}（向上浮动效）`, positionY < risePositionY);

  // createFloatingTip 落点接线：摆到 (0, positionY) 再上浮（普通/错误提示共用这一处）
  const floatBody = /export function createFloatingTip\([\s\S]*?\n  \}/.exec(tipFxSrc)?.[0] ?? "";
  check("tip-fx 有 createFloatingTip", !!floatBody);
  check(
    "createFloatingTip 把飘字摆到 (0, tipsLayout.positionY)",
    /setPosition\(0,\s*tipsLayout\.positionY/.test(floatBody),
  );
  check(
    "上浮目标取 tipsLayout.risePositionY（不散写裸值）",
    /tipsLayout\.risePositionY/.test(floatBody),
  );

  finish("tip 落点关系全部成立");
}

main();
