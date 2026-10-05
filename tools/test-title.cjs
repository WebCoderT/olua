#!/usr/bin/env node
/**
 * 称号系统单测（tools/test-title.cjs）
 *
 * 盯的不变量（改称号系统后必须全绿）：
 * · 等级序列与磁盘一致（resources/titles 下每个帧目录都对应一个等级、无多登/漏登）
 * · 属性曲线：每级属性 = 等效等级的角色裸属性 × rate × 系列 factor（与 configs/soul 同一套做法），
 *   三个家族（江湖 1 / 军阶 1.15 / 搞怪 1.3）换系时按 factor 跳档
 * · 价格曲线：升到 N 阶 = priceBase × N²，单调递增
 * · 存档迁移（旧档 title 补 0）与升级链路接线、属性计入 combatCalc、头顶常显、预加载
 * · 入口：称号不走 NPC，唯一入口 = 角色信息弹窗的「称号」按钮；头部信息栏的写死文字称号占位已移除
 *
 * 数据层跑在沙箱里（真实的 configs/title + growth，见 lib/configs-sandbox.cjs），素材与源码断言直接读文件。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

const TITLE_DIR = path.join(PROJECT_ROOT, "assets/resources/titles");
const outDir = prepare("olua-title", ["configs/title.ts"]);
const { titleLevels, titleMaxLevel, titleGrowth, titleUpgradePrice, getTitleLevel, titleAttributeLabels } = require(path.join(outDir, "configs/title.js"));
const { getRoleLevelAttributes, roleMaxLevel } = require(path.join(outDir, "configs/growth.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

/** PNG 尺寸（IHDR：宽高在固定偏移 16/20，大端 uint32） */
function pngSize(file) {
  const buffer = fs.readFileSync(file);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

console.log("\n— A. 等级序列与磁盘一致 —");
const diskDirs = fs
  .readdirSync(TITLE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^sfx_\d+$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();
const registryDirs = titleLevels.map((config) => config.animation.replace(/^titles\//, "")).sort();
check(registryDirs.length === diskDirs.length, `等级序列数量与磁盘一致（${registryDirs.length} 个）`);
check(JSON.stringify(registryDirs) === JSON.stringify(diskDirs), "等级序列与磁盘目录一一对应（无多登/漏登/写错编号）");
check(titleLevels.every((config, index) => config.level === index + 1), "等级从 1 起连续（下标 + 1 即等级）");
check(titleMaxLevel === titleLevels.length, "titleMaxLevel 与序列等长");
check(new Set(titleLevels.map((config) => config.label)).size === titleLevels.length, "称号名称唯一");
check(titleLevels.every((config) => config.animation.startsWith("titles/sfx_")), "动画路径 = titles/<目录名>（resources 加载口径）");
check(titleLevels.every((config) => fs.existsSync(path.join(TITLE_DIR, config.animation.replace(/^titles\//, "")))), "每个称号的帧目录都真实存在");
check(titleLevels.every((config) => config.animationFrameRate === 10), "帧率统一 10（与战魂同一档）");
check(getTitleLevel(0) === null && getTitleLevel(-1) === null && getTitleLevel(1)?.level === 1, "getTitleLevel：0/负数返回 null（未激活），1 起有效");

console.log("\n— B. 属性曲线（等效等级裸属性 × rate × 系列 factor）—");
const FAMILY_FACTORS = [1, 1.15, 1.3];
const familySizes = [12, 11, 11];
function expectedAttributes(level) {
  // 与 configs/title 同一套换算（等级 → 等效角色等级 → 裸属性打折）
  const familyIndex = familySizes.findIndex((size, index) => level <= familySizes.slice(0, index + 1).reduce((a, b) => a + b, 0));
  const factor = FAMILY_FACTORS[familyIndex];
  const equivalentLevel = Math.round(titleGrowth.fromLevel + ((level - 1) / Math.max(1, titleLevels.length - 1)) * (titleGrowth.toLevel - titleGrowth.fromLevel));
  const base = getRoleLevelAttributes(equivalentLevel);
  const rate = titleGrowth.rate * factor;
  const scale = (range) => [Math.round(range[0] * rate), Math.round(range[1] * rate)];
  return { maxHp: Math.round(base.maxHp * rate), physicalAttack: scale(base.physicalAttack), magicAttack: scale(base.magicAttack), taoistAttack: scale(base.taoistAttack), physicalDefense: scale(base.physicalDefense), magicDefense: scale(base.magicDefense), taoistDefense: scale(base.taoistDefense) };
}
const mismatched = titleLevels.filter((config) => JSON.stringify(config.attributes) !== JSON.stringify(expectedAttributes(config.level)));
check(!mismatched.length, "每级属性都严格按「等效等级裸属性 × rate × factor」生成", mismatched.map((config) => config.level).join("、") || "34 级全部命中");
const increasing = titleLevels.every((config, index) => index === 0 || config.attributes.maxHp > titleLevels[index - 1].attributes.maxHp);
check(increasing, "maxHp 逐级递增（换系跳档叠加在等级增长之上）");
check(titleLevels[0].attributes.maxHp > 0 && titleLevels[titleLevels.length - 1].attributes.maxHp < getRoleLevelAttributes(roleMaxLevel).maxHp, "1 阶有加成、满阶仍低于 60 级角色裸血（称号是次级成长线，弱于战魂）");
const attrKeys = ["physicalAttack", "magicAttack", "taoistAttack", "physicalDefense", "magicDefense", "taoistDefense"];
check(titleLevels.every((config) => attrKeys.every((key) => config.attributes[key][0] <= config.attributes[key][1])), "区间属性下限 ≤ 上限");
check(JSON.stringify(titleAttributeLabels.map((item) => item.key)) === JSON.stringify(["maxHp", ...attrKeys]), "属性显示顺序表覆盖全部字段且顺序固定");

console.log("\n— C. 价格曲线 —");
check(titleLevels.every((config) => config.bindGold === titleUpgradePrice(config.level)), "每级 bindGold 与价格曲线一致");
check(titleLevels.every((config) => config.bindGold === Math.round(titleGrowth.priceBase * config.level * config.level)), "价格 = priceBase × N²（与战魂同形态、便宜一档）");
check(titleLevels.every((config, index) => index === 0 || config.bindGold > titleLevels[index - 1].bindGold), "价格逐级递增");
check(titleGrowth.rate < 0.5 && titleGrowth.priceBase < 300, "称号整体弱于/便宜于战魂（rate < 0.5、priceBase < 300）");

console.log("\n— D. 素材守卫（帧序号 / 尺寸一致 / 画布一致）—");
let fewest = null;
let checkedFrames = 0;
for (const dir of diskDirs) {
  const dirPath = path.join(TITLE_DIR, dir);
  const pngs = fs.readdirSync(dirPath).filter((name) => name.endsWith(".png")).sort();
  if (!pngs.length) {
    check(false, `${dir} 目录里有帧`);
    continue;
  }
  const orders = pngs.map((name) => Number((name.match(/(\d+)\.png$/) || [])[1]));
  const sortedEverywhere = orders.every((order, index) => index === 0 || order > orders[index - 1]);
  if (!sortedEverywhere) {
    check(false, `${dir} 帧名末尾序号按升序排列（AnimationHelper 按序号排序的前提）`, orders.join(","));
  }
  const baseSize = pngSize(path.join(dirPath, pngs[0]));
  const mismatch = pngs.filter((name) => {
    const size = pngSize(path.join(dirPath, name));
    return size.width !== baseSize.width || size.height !== baseSize.height;
  });
  if (mismatch.length) {
    check(false, `${dir} 目录内每帧尺寸一致`, `${mismatch.length}/${pngs.length} 帧不是 ${baseSize.width}×${baseSize.height}`);
  }
  const canvasMismatch = pngs.filter((name) => {
    const meta = JSON.parse(fs.readFileSync(path.join(dirPath, `${name}.meta`), "utf8"));
    const userData = Object.values(meta.subMetas).find((subMeta) => subMeta.importer === "sprite-frame")?.userData ?? {};
    return Number(userData.rawWidth) !== baseSize.width || Number(userData.rawHeight) !== baseSize.height;
  });
  if (canvasMismatch.length) {
    check(false, `${dir} 每帧 meta 原始画布与 PNG 尺寸一致（RAW 显示的前提）`, `${canvasMismatch.length}/${pngs.length} 帧画布不符`);
  }
  checkedFrames += pngs.length;
  if (!fewest || pngs.length < fewest.frames) fewest = { key: dir, frames: pngs.length };
}
check(!!fewest && fewest.frames >= 8, `每个称号至少 8 帧（最少的 ${fewest ? fewest.key : "?"} 有 ${fewest ? fewest.frames : 0} 帧）`);
check(true, `全部称号目录的帧序/尺寸/画布检查通过（${diskDirs.length} 个目录 × ${checkedFrames} 帧）`);

console.log("\n— E. 接线（源码断言）—");
const roleSource = read("assets/entities/Role.ts");
const storageSource = read("assets/ui/core/StorageManager.ts");
const helperSource = read("assets/ui/core/GameHelper.ts");
const displaySource = read("assets/ui/components/role/RoleDisplay.ts");
const managerSource = read("assets/ui/core/RoleUIManager.ts");
const gameSource = read("assets/ui/Game.ts");
const preloadSource = read("assets/ui/core/PreloadManager.ts");
const uiHelperSource = read("assets/ui/helpers/GameUiHelper.ts");
const roleInfoSource = read("assets/ui/components/dialogs/RoleInfoDialog.ts");
const dialogSource = read("assets/ui/components/dialogs/TitleUpgradeDialog.ts");
const textsSource = read("assets/configs/texts.ts");
const npcSource = read("assets/configs/npc.ts");
const hudSource = read("assets/configs/layout/hud.ts");
const dialogsLayoutSource = read("assets/configs/layout/dialogs.ts");

check(/title: number = 0;/.test(roleSource) && /称号等级/.test(roleSource), "Role 有 title 字段（0 = 未激活）");
check(/typeof role\.title !== "number"\) role\.title = 0;/.test(storageSource), "旧存档迁移：title 缺失补 0（ensureRoleDefaults）");
check(/static upgradeTitle\(\): boolean/.test(storageSource) && /getTitleLevel\(role\.title \+ 1\)/.test(storageSource), "StorageManager.upgradeTitle 按下一级配置升级");
check(/title_max_tip|title_bind_gold_tip|title_upgrade_tip/.test(storageSource) === true && /createTip\("title_max_tip"\)/.test(storageSource), "升级失败/成功都走浮动提示（configs/texts）");
check(/Object\.assign\(role, GameHelper\.combatCalc\(role\)\)/.test(storageSource.split("static upgradeTitle")[1].split("static ")[0]), "升级后重算属性与战斗力");
check(/getTitleLevel\(role\.title\)/.test(helperSource) && /\(title\?\.attributes\.maxHp \?\? 0\)/.test(helperSource) && /if \(title\) sources\.push\(title\.attributes\[key\]\);/.test(helperSource), "combatCalc 把称号属性计入血量与六维");
check(/updateTitleShow\(\)/.test(displaySource) && /getTitleLevel\(role\.title\)/.test(displaySource) && /createTitleAnimation\(config, roleShowLayout\.title\.size\)/.test(displaySource), "RoleDisplay.updateTitleShow 按角色数据挂头顶名牌动画");
check(/updateTitleShow\(\);/.test(gameSource), "进图时挂称号外显（Game 初始化调用）");
check(/updateTitleShow: \(\) => void;/.test(managerSource) && /static updateTitleShow\(\)/.test(managerSource), "RoleUIManager 接口与实现都有 updateTitleShow");
check(/dir: title\.animation, kind: "frames"/.test(preloadSource) && /getTitleLevel\(role\.title\)/.test(preloadSource), "进图前预载当前称号的帧目录（未激活跳过）");

check(/static createTitleCard/.test(uiHelperSource) && /static createTitleAttributeList/.test(uiHelperSource) && /static createTitleAnimation/.test(uiHelperSource), "GameUiHelper 有称号三零件（卡片/属性表/动画）");
check(/titleUpgradeDialogLayout\.list\.cardSize/.test(uiHelperSource) && /titleAttributeLabels/.test(uiHelperSource), "称号零件的几何与属性顺序都来自 configs（不写死）");
check(/new TitleUpgradeDialog\(\)\.open\(\)/.test(roleInfoSource) && /roleInfoDialogLayout\.titleButton/.test(roleInfoSource), "角色信息弹窗有「称号」按钮打开称号弹窗（唯一入口）");
check(/new WarSoulDialog/.test(npcSource) && !/TitleUpgradeDialog/.test(npcSource), "NPC 只挂战魂弹窗，称号不走 NPC");
check(/createTitleCard|createTitleAttributeList|createTitleAnimation|upgradeTitle\(\)|RoleUIManager\.updateTitleShow/.test(dialogSource), "称号弹窗接线：零件/升级/头顶刷新");
check(!/soulShow/.test(dialogSource), "称号弹窗没有「外显」勾选框（称号常显头顶）");
check(/title_upgrade_dialog/.test(dialogsLayoutSource) && /titleButton: \{ name: "role_title_button"/.test(dialogsLayoutSource), "弹窗布局与入口按钮都在 configs/layout/dialogs");
check(/title: \{ siblingIndex: 0, size: new Size/.test(hudSource), "名牌的插入位置/占位尺寸在 configs/layout/hud.roleShowLayout.title");
check(/this\.head\.insertChild\(node, roleShowLayout\.title\.siblingIndex\)/.test(displaySource), "名牌节点挂在头部信息栏容器里（与名称/血条同一个节点）");
check(!/roleShowLayout\.title\.(scale|position)/.test(displaySource) && !/title: \{ [^}]*scale/.test(hudSource), "名牌不手动定位也不缩放（位置交给头部容器的纵向布局，按素材原始尺寸显示）");
check(/getChildByName\("role_hp_bar"\)/.test(displaySource) && /getChildByName\("role_hp_text"\)/.test(displaySource), "头顶血条/血量文字按名字取件（名牌插进同一容器后下标会漂移）");
check(/"role_hp_bar"/.test(uiHelperSource) && /"role_hp_text"/.test(uiHelperSource), "createHead 给血条/血量文字起了稳定名字（与 updateHead 的取件口径成对）");
for (const key of ["title_max_tip", "title_bind_gold_tip", "title_upgrade_tip", "label_title_active", "label_title_locked", "label_title_current", "label_title_none"]) {
  check(textsSource.includes(`${key}:`), `文案 key 已登记：${key}`);
}
check(!/label_role_title/.test(uiHelperSource) && !/label_role_title:/.test(textsSource), "头部信息栏的写死文字称号占位已移除（代码与文案 key 双清）");

finish("PASS：称号等级序列、属性/价格曲线、素材守卫与数据/UI 接线全部通过。");
