#!/usr/bin/env node
/**
 * 行内文字 bbox 全量扫描（client/tools/test-layout-row-bbox.cjs，issue #483）
 *
 * 为什么不逐个弹窗手写断言：`createLabel` 是 CLAMP + **左对齐**，文字从**文本框左缘**起排，
 * 而布局里给的是文本框**中心 x** —— 只要「中心 x − 宽/2」跑出行的左右缘，文字就被行/遮罩裁掉，
 * 而且节点和字符串都还在（数据 e2e、文本重叠审计都发现不了）。这个坑已经在 #477（任务/队伍/
 * 排行榜/聊天）与 #483（成就）各犯一次，说明**必须机器扫，不能靠记性**。
 *
 * 扫描规则（不用知道具体弹窗，纯按约定）：
 *   1. 遍历 `configs/layout/*.ts` 与 `configs/{achievement,quest,mail,social}.ts` 的全部导出；
 *   2. 递归找「带 `size` 且宽 ≥ 100」的对象 —— 认作「行 / 面板」；
 *   3. 行内任何 `xxxX + xxxSize`（中心 x 是数字）或 `xxxPosition + xxxSize`（中心是 Vec2），
 *      当 `xxx` 属于文字键名（name/desc/text/meta/progress/label/title/sub）时，算 bbox 与行宽比较；
 *   4. 越界即失败，并打印越界像素数（照这个数改 x 即可）。
 *
 * 局限（有意不做的）：只查「行内文字是否在行里」，不查文字之间是否重叠 ——
 * 那是 `client/tools/test-dialog-row-bounds.cjs`（手写、带业务语义）与真机排版扫描（ui-audit-dialogs）的活。
 *
 * 用法：node client/tools/test-layout-row-bbox.cjs
 */
const path = require("path");
const fs = require("fs");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

/** 行内文字到行左右缘的最小留白（与各布局注释里的「左缘 + 16」一致） */
const INSET = 16;
/** 小于这个宽度的 size 不当作「行 / 面板」（按钮、图标之类） */
const MIN_ROW_WIDTH = 100;
/** 视为「行内文字」的键名前缀 */
const TEXT_KEYS = /^(name|desc|text|meta|progress|label|title|sub)$/;

const isVec2 = (v) => v && typeof v === "object" && typeof v.x === "number" && typeof v.y === "number" && typeof v.width !== "number";
const isSize = (v) => v && typeof v === "object" && typeof v.width === "number";

try {
  const assetsDir = path.join(PROJECT_ROOT, "assets");
  const layoutDir = path.join(assetsDir, "configs/layout");
  const entries = [
    ...fs
      .readdirSync(layoutDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `configs/layout/${f}`),
    // 不放在 layout/ 下、但同样定义了「行」的布局
    "configs/achievement.ts",
    "configs/quest.ts",
    "configs/mail.ts",
    "configs/social.ts",
  ];
  const outDir = prepare("olua-row-bbox-scan", entries);

  const violations = [];
  const visited = new Set();

  const scan = (obj, trail) => {
    if (!obj || typeof obj !== "object" || visited.has(obj)) return;
    visited.add(obj);

    if (isSize(obj.size) && obj.size.width >= MIN_ROW_WIDTH) {
      const half = obj.size.width / 2;
      const report = (key, centerX, width) => {
        const left = centerX - width / 2;
        const right = centerX + width / 2;
        if (left < -half + 0.01 || right > half - 0.01) {
          const detail = [
            left < -half + 0.01 ? `左越界 ${(-half - left).toFixed(1)}px` : "",
            right > half - 0.01 ? `右越界 ${(right - half).toFixed(1)}px` : "",
          ]
            .filter(Boolean)
            .join(" / ");
          violations.push(`${trail}.${key} bbox ${left.toFixed(1)}~${right.toFixed(1)}，行 ±${half.toFixed(0)} → ${detail}`);
        }
      };
      for (const key of Object.keys(obj)) {
        // 约定一：xxxX（数字中心 x）+ xxxSize
        if (/X$/.test(key) && typeof obj[key] === "number") {
          const base = key.slice(0, -1);
          const size = obj[base + "Size"];
          if (TEXT_KEYS.test(base) && isSize(size)) report(key, obj[key], size.width);
        }
        // 约定二：xxxPosition（Vec2 中心）+ xxxSize
        if (/Position$/.test(key) && isVec2(obj[key])) {
          const base = key.replace(/Position$/, "");
          const size = obj[base + "Size"];
          if (TEXT_KEYS.test(base) && isSize(size)) report(key, obj[key].x, size.width);
        }
      }
    }

    for (const key of Object.keys(obj)) {
      if (obj[key] && typeof obj[key] === "object") scan(obj[key], `${trail}.${key}`);
    }
  };

  let loaded = 0;
  const loadErrors = [];
  for (const entry of entries) {
    const jsPath = path.join(outDir, entry.replace(/\.ts$/, ".js"));
    let mod;
    try {
      mod = require(jsPath);
    } catch (error) {
      // 加载失败必须报错：静默跳过会让「扫了 0 个模块」也显示全绿（本次实现踩过）
      loadErrors.push(`${entry}: ${String(error.message).split("\n")[0]}`);
      continue;
    }
    loaded++;
    for (const key of Object.keys(mod)) scan(mod[key], `${path.basename(entry, ".ts")}.${key}`);
  }

  console.log(`\n— 扫描 ${loaded} 个布局模块（行内文字 bbox vs 行宽，留白 ${INSET}）—`);
  check(loadErrors.length === 0, "所有布局模块都能加载", loadErrors.join(" | "));
  check(loaded === entries.length, `模块全部参与扫描（${loaded} / ${entries.length}）`);
  check(violations.length === 0, "没有行内文字越出行的左右缘", violations.length ? "\n    " + violations.join("\n    ") : "");
} catch (error) {
  fail(error);
}

finish("✅ 行内文字 bbox 全量扫描通过");
