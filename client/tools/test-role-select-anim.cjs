#!/usr/bin/env node
/**
 * 选角「选中态」单测（client/tools/test-role-select-anim.cjs，issue #733）
 *
 * 选中一个角色 = 站立帧换成展示帧（show，循环）+ 脚底循环 select-player@0，**不再画白色选中框**。
 *
 * ⚠️ **显示效果不写断言**（项目约定）：动画好不好看、特效摆得对不对、尺寸大小、帧率快慢，
 * 一律靠人眼看，任何数值断言都只是把「某一刻的观感」钉死，改配置必红、真出错时又抓不到。
 * 这里只守两类**改不坏就静默**的东西：
 * A. 素材守卫：六个「职业-性别」组合的 show / stand 图集、脚下特效，plist + png 都在磁盘上
 *    —— 缺文件的表现是「选中了什么都不播」，运行时不报错
 * B. 接线契约：取图函数还是走约定的资源目录；选角组件只经 `setRoleSelected` 切选中态（三处调用）、
 *    白色选中框那套（Graphics / selectionFrame）没被改回来；展示帧装载完成才收站立帧（顺序，非数值）
 *
 * 选角组件依赖整套引擎与面板，node 里跑不起来（与 test-bottom-nav 同一取向）：
 * 素材走真文件，界面接线做源码契约断言，**实际观感由真机验证**。
 *
 * 用法：node client/tools/test-role-select-anim.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(PROJECT_ROOT, rel));

/** 职业-性别六个组合（configs/role 的 occupations × 两个性别） */
const COMBOS = [
  ["1", "1"],
  ["1", "2"],
  ["2", "1"],
  ["2", "2"],
  ["3", "1"],
  ["3", "2"],
];

try {
  const outDir = prepare("olua-role-select-anim", ["configs/layout/images.ts", "configs/layout/scenes.ts"]);
  const images = require(path.join(outDir, "configs/layout/images.js"));
  const scenes = require(path.join(outDir, "configs/layout/scenes.js"));
  const layout = scenes.roleSelectorLayout;

  console.log("\n— A. 素材守卫（show / stand / 脚下特效的 plist+png 都在） —");
  {
    const missing = [];
    for (const [occupation, sex] of COMBOS) {
      for (const kind of ["show", "stand"]) {
        // #753：选角预览图集收在 ui/create-role/preview 下，命名 <职业>-<性别>-<show|stand>@0
        const rel = images.uiCreateRole(`preview/${occupation}-${sex}-${kind}@0`);
        for (const ext of [".plist", ".png"]) {
          if (!exists(path.join("assets/resources", `${rel}${ext}`))) missing.push(`${rel}${ext}`);
        }
      }
    }
    check(missing.length === 0, "六个组合的 show / stand 图集 plist+png 齐全", missing.join(", "));

    const effect = images.roleSelectEffectImage;
    const effectMissing = [".plist", ".png"].filter((ext) => !exists(path.join("assets/resources", `${effect}${ext}`)));
    check(effectMissing.length === 0, `脚下选中特效 ${effect} 的 plist+png 齐全`, effectMissing.join(", "));
  }

  console.log("\n— B. 取图单一来源（拼出来的路径 = 约定的资源目录） —");
  {
    const pairs = [
      ["createRolePreviewImage", images.createRolePreviewImage("3", "2"), "ui/create-role/preview/3-2-stand@0"],
      ["createRoleShowImage", images.createRoleShowImage("3", "2"), "ui/create-role/preview/3-2-show@0"],
      ["roleSelectEffectImage", images.roleSelectEffectImage, "ui/create-role/select-player@0"],
    ];
    const wrong = pairs.filter(([, actual, expected]) => actual !== expected).map(([name, actual, expected]) => `${name}=${actual}（期望 ${expected}）`);
    check(wrong.length === 0, "取图函数拼的路径与约定一致", wrong.join("; "));

    check(!("selectionFrame" in layout), "roleSelectorLayout.selectionFrame（白框配置）已删除");
    check(!!layout.selection, "roleSelectorLayout.selection 存在（选中态配置入口没丢）");
  }

  console.log("\n— C. 接线契约（选角组件 / 零件工厂） —");
  {
    const selector = read("assets/ui/RoleSelector.ts");
    const helper = read("assets/ui/helpers/GameUiHelper.ts");

    check(!/\bGraphics\b/.test(selector), "选角组件不再用 Graphics 画框");
    check(!/selectionFrame/.test(selector), "选角组件不再有 selectionFrame 残留");
    check((selector.match(/this\.setRoleSelected\(/g) ?? []).length >= 3, "点选 / 复位 / 列表重建后三处都切选中态");
    check(selector.includes("ROLE_PREVIEW_PREFIX"), "预览节点按统一前缀命名（才能按 id 找回）");
    check(/private setRoleSelected\(/.test(selector), "setRoleSelected 一处收口（不散落在各调用点）");

    check(/static setRolePreviewSelected\(/.test(helper), "零件工厂有 setRolePreviewSelected");
    check(/createRoleShowImage\(occupation, sex\)/.test(helper), "选中态按「职业-性别」取 show 图集");
    check(/roleSelectEffectImage/.test(helper), "脚下特效走统一的取图函数");
    // 先装载再藏站立帧：这是顺序契约（防止「站立已藏、展示帧还没到」的空窗），不是观感数值
    const loadAt = helper.indexOf("loadFramesFromAtlas(atlas)");
    const hideAt = helper.indexOf("stand.active = false", loadAt >= 0 ? loadAt : 0);
    check(loadAt > 0 && hideAt > loadAt, "展示帧装载完成后才收掉站立帧（不闪空白）");
  }
} catch (error) {
  fail(error);
}

finish("✅ 选角选中态单测全绿（观感请真机查看）");
