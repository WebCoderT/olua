#!/usr/bin/env node
/**
 * 地面掉落名（拼前后缀 + 着色）单测（tools/test-drop-name.cjs）
 *
 * 盯的不变量（改掉落名/前后缀配色后必须全绿）：
 * · 装备名称三段（前缀 + 名称 + 后缀）在数据层对**全部 15 种前后缀组合**都能拼出，
 *   且段配色直接取自 configs/equipments 的两张配色表（**引用同一个 Color 对象**）——
 *   这就是「地面与详情显示规则一致」的地基：两处同走 getEquipmentNameParts，不各写一份色表
 * · 前后缀越界时回退普通/人级（异常数据不会渲染出 undefined）
 * · 非装备物品不带前后缀段（走单行白字，可叠加物品带数量）
 * · 几何全部来自 configs/layout/hud.dropItemLayout（代码里不写死尺寸/字号/颜色）
 * · 接线：createDropItem → createDropNameRow → getEquipmentNameParts，
 *   名称行「按内容宽 + 锚点 (0.5,1)」居中（CONTAINER / Overflow.NONE / 锚点三处成对，缺一个就不居中）
 *
 * 数据层跑在沙箱里（真实的 configs/items + equipments，见 lib/configs-sandbox.cjs），素材与源码断言直接读文件。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish } = require("./lib/configs-sandbox.cjs");

// 默认入口 configs/items.ts 会把 equipments / drug / material 一起带进来（物品总表即掉落解析口径）
const outDir = prepare("olua-drop-name", ["configs/layout/hud.ts"]);
const { items } = require(path.join(outDir, "configs/items.js"));
const {
  getEquipmentNameParts,
  equipmentPrefixLabels,
  equipmentPrefixColors,
  equipmentSuffixLabels,
  equipmentSuffixColors,
} = require(path.join(outDir, "configs/equipments.js"));
const { dropItemLayout } = require(path.join(outDir, "configs/layout/hud.js"));
const { isEquipment } = require(path.join(outDir, "types/good.js"));

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

/**
 * 从（已剥注释的）源码里取某个方法的完整方法体
 * 左括号取「签名所在行的最后一个 `{`」——本仓库 K&R 风格（签名与左括号同行），
 * 这样带返回类型注解的方法（`: { row: Node; … } {`）不会被类型里的花括号截断
 */
function methodBody(code, signature) {
  const start = code.indexOf(signature);
  if (start < 0) return "";
  const lineEnd = code.indexOf("\n", start);
  const open = code.lastIndexOf("{", lineEnd < 0 ? code.length : lineEnd);
  if (open < start) return "";
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  return "";
}

console.log("\n— A. 装备名称三段与配色（全部前后缀组合）—");
const equipments = [];
items.forEach((good, id) => {
  if (isEquipment(good)) equipments.push({ id, good });
});
check(equipments.length > 0, `物品总表里有装备（${equipments.length} 件变体）`);

const combos = new Set();
let missingSegment = 0;
let wrongPrefixColor = 0;
let wrongSuffixColor = 0;
let wrongNameColor = 0;
equipments.forEach(({ good }) => {
  const parts = getEquipmentNameParts(good);
  if (!parts.prefix.label || !parts.label || !parts.suffix.label) missingSegment++;
  // 颜色取的是配置表里的**同一个对象**（引用相等），不是等值的另一份 —— 这样配色只有一处来源
  if (parts.prefix.color !== equipmentPrefixColors[good.prefix]) wrongPrefixColor++;
  if (parts.suffix.color !== equipmentSuffixColors[good.suffix]) wrongSuffixColor++;
  // 名称段跟前缀段同色（详情弹窗的口径：前缀/名称用前缀色，后缀用后缀色）
  if (parts.prefix.color !== equipmentPrefixColors[good.prefix]) wrongNameColor++;
  combos.add(`${good.prefix}-${good.suffix}`);
});
check(missingSegment === 0, "每件装备都能拼出完整三段（前缀/名称/后缀均非空）");
check(wrongPrefixColor === 0, "前缀段颜色 = equipmentPrefixColors[前缀]（引用同一对象）");
check(wrongSuffixColor === 0, "后缀段颜色 = equipmentSuffixColors[后缀]（引用同一对象）");
check(wrongNameColor === 0, "名称段与前缀段同色（与详情弹窗口径一致）");

const expectCombos = equipmentPrefixLabels.length * equipmentSuffixLabels.length;
check(expectCombos === 15, `前后缀组合数 = 5 × 3 = 15（实际 ${expectCombos}）`);
check(combos.size === expectCombos, `物品总表覆盖全部前后缀组合（实际 ${combos.size}/${expectCombos}）`);
check(equipmentPrefixLabels.length === equipmentPrefixColors.length, "前缀文案与配色表等长");
check(equipmentSuffixLabels.length === equipmentSuffixColors.length, "后缀文案与配色表等长");
check(new Set(equipmentPrefixColors.map((color) => color.hex ?? `${color.r},${color.g},${color.b}`)).size === equipmentPrefixColors.length, "5 档前缀配色互不重复");
check(new Set(equipmentSuffixColors.map((color) => color.hex ?? `${color.r},${color.g},${color.b}`)).size === equipmentSuffixColors.length, "3 档后缀配色互不重复");

const fallback = getEquipmentNameParts({ prefix: 99, suffix: 99, label: "越界件" });
check(fallback.prefix.label === equipmentPrefixLabels[0] && fallback.prefix.color === equipmentPrefixColors[0], "前缀越界回退到第一档（普通的）");
check(fallback.suffix.label === equipmentSuffixLabels[0] && fallback.suffix.color === equipmentSuffixColors[0], "后缀越界回退到第一档（人级）");
check(fallback.label === "越界件", "回退时名称原样保留");

console.log("\n— B. 非装备物品（单行白字分支）—");
const others = [];
items.forEach((good) => {
  if (!isEquipment(good)) others.push(good);
});
check(others.length > 0, `物品总表里有非装备物品（${others.length} 件）`);
check(others.every((good) => typeof good.label === "string" && good.label.length > 0), "非装备物品的名称都非空（地面直接显示 label）");
check(others.every((good) => good.prefix === undefined && good.suffix === undefined), "非装备物品没有前后缀字段（isEquipment 是唯一分叉判据）");

console.log("\n— C. 掉落物几何（全部来自 configs/layout/hud.dropItemLayout）—");
check(!!dropItemLayout, "configs/layout/hud 导出 dropItemLayout");
check(
  dropItemLayout.iconOffsetY === dropItemLayout.nodeExtraHeight / 2,
  `图标偏移 = 额外高度的一半（${dropItemLayout.iconOffsetY} = ${dropItemLayout.nodeExtraHeight} / 2，图标偏上、名称落在下方）`,
);
check(dropItemLayout.iconSize.width > 0 && dropItemLayout.iconSize.height > 0, `默认图标尺寸为正（${dropItemLayout.iconSize.width}×${dropItemLayout.iconSize.height}）`);
check(dropItemLayout.name.spacing > 0, `名称各段之间留了横向间距（${dropItemLayout.name.spacing}）`);
check(dropItemLayout.name.fontSize > 0 && dropItemLayout.name.lineHeight > 0, `名称字号/行高为正（${dropItemLayout.name.fontSize} / ${dropItemLayout.name.lineHeight}）`);
check(dropItemLayout.name.offsetY >= 0, `名称行相对图标下沿的偏移是配置项（${dropItemLayout.name.offsetY}）`);
check(!!dropItemLayout.nameColor && !!dropItemLayout.countColor, "非装备名称色与数量色都在配置里（代码不写死 Color）");

console.log("\n— D. 接线（源码断言）—");
const helperSource = read("assets/ui/helpers/GameUiHelper.ts");
const dropManagerSource = read("assets/ui/core/DropManager.ts");
const barrelSource = read("assets/configs/hudLayout.ts");
const hudSource = read("assets/configs/layout/hud.ts");
// 先剥注释再切片：注释里的中文/数字不会被当成「裸文案/写死数值」
const helperCode = helperSource.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const dropItemBody = methodBody(helperCode, "static createDropItem");
const dropNameBody = methodBody(helperCode, "static createDropNameRow");

check(dropItemBody.length > 0 && dropNameBody.length > 0, "两个方法都在 GameUiHelper 里（createDropItem / createDropNameRow）");
check(
  /dropItemLayout\.iconSize/.test(dropItemBody) && /dropItemLayout\.nodeExtraHeight/.test(dropItemBody) && /dropItemLayout\.iconOffsetY/.test(dropItemBody),
  "掉落物节点几何全部走 dropItemLayout（图标尺寸/节点额外高度/图标偏移）",
);
check(!/Color\.WHITE/.test(dropItemBody) && !/\bnew Size\(40/.test(dropItemBody), "createDropItem 里不写死颜色与图标尺寸");
check(/getEquipmentNameParts\(good\)/.test(dropNameBody), "名称段走 getEquipmentNameParts（地面与详情同一个函数 = 同一套文案与配色）");
check(
  /parts\.prefix\.label/.test(dropNameBody) && /parts\.label/.test(dropNameBody) && /parts\.suffix\.label/.test(dropNameBody),
  "三段都拼上了：前缀 + 名称 + 后缀",
);
check((dropNameBody.match(/parts\.prefix\.color/g) || []).length >= 2, "前缀段与名称段共用前缀色（与详情口径一致）");
check(/parts\.suffix\.color/.test(dropNameBody), "后缀段用后缀色");
check(/dropItemLayout\.nameColor/.test(dropNameBody) && /dropItemLayout\.countColor/.test(dropNameBody), "非装备名称色与数量段色也走配置");
check(/isEquipment\(good\)/.test(dropNameBody), "装备/非装备在名称行里分叉（判据与详情弹窗相同）");

check(/Layout\.ResizeMode\.CONTAINER/.test(dropNameBody), "名称行按内容宽自适应（CONTAINER：宽度 = 各段之和）");
check(/setAnchorPoint\(0\.5, 1\)/.test(dropNameBody), "名称行锚点 (0.5, 1)：整行在图标正下方居中、向下生长");
check(/Label\.Overflow\.NONE/.test(dropNameBody), "各段宽度随文字自适应（CLAMP 会把宽度压成 0，CONTAINER 就求和出错）");
check(/createFlexRow\("drop_name"/.test(dropNameBody), "名称行由横向弹性容器拼成（段间距走配置的 spacing）");

check(!/[\u4e00-\u9fa5]/.test(dropItemBody + dropNameBody), "掉落名相关代码没有裸中文文案");
check(!/\b(40|14|12|10)\b/.test(dropNameBody), "名称行代码没有写死的尺寸/字号（全在 dropItemLayout）");
check(/^export const dropItemLayout = \{/m.test(hudSource), "dropItemLayout 定义在 configs/layout/hud（不是散在 ui 里）");
check(/export \* from "\.\/layout\/hud";/.test(barrelSource), "hudLayout barrel 导出（组件仍从 configs/hudLayout 取）");

check((helperCode.match(/getEquipmentNameParts\(/g) || []).length >= 2, "getEquipmentNameParts 被详情弹窗与地面掉落名共用（同一函数，两处必然一致）");
check(/GameUiHelper\.createDropItem\(good, count\)/.test(dropManagerSource), "DropManager 仍按「物品 + 数量」调用（口径未变）");

finish("PASS：掉落名三段拼装、前后缀配色同源、几何入配置与界面接线全部通过。");
