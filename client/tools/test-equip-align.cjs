#!/usr/bin/env node
/**
 * 装备位置对齐单测（client/tools/test-equip-align.cjs，issue #504）
 *
 * 盯的不变量：
 * A. **对齐口径本身**（configs/equipAlign 的纯函数）：武器内容中心永远落在身体 bbox 的握持点上，
 *    与被穿的身体多大、武器多长无关 —— 这正是「换上不同衣服武器就飘走」的病根。
 * B. **内观**：武器缩放到身体高度的固定倍数，位置同样贴握持点。
 * C. **配置层不许再回到手调绝对值**：武器的 inPosition / outPositions 只能当微调（|值| ≤ 4），
 *    出现几十上百的数字说明有人又把「只对一件身体成立」的坐标写回去了。
 * D. **接线**：场景与内观都必须走纯函数（不许在组件里另写一份公式），且内观要等素材就绪再对齐。
 *
 * 用法：node client/tools/test-equip-align.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

try {
  const outDir = prepare("olua-equip-align", ["configs/equipAlign.ts", "configs/equipments.ts"]);
  const align = require(path.join(outDir, "configs/equipAlign.js"));
  const { weapons, clothes } = require(path.join(outDir, "configs/equipments.js"));

  //#region A. 对齐口径（外观）

  console.log("\n— A. 武器内容中心落在握持点（与被穿身体、武器长度无关） —");

  const { handAnchor, placeWeaponOnHand, EQUIP_ALIGN } = align;
  const bodySmall = { cx: 0, cy: 4, w: 60, h: 70 };
  const bodyBig = { cx: -3, cy: 79, w: 252, h: 206 };
  const weaponTall = { cx: 4, cy: -65, w: 40, h: 174 };
  const weaponShort = { cx: -22, cy: 12, w: 80, h: 60 };

  /** 摆完之后，武器内容中心（世界坐标）= pos + 内容偏移 × 缩放 */
  const centerAfter = (body, weapon, scale, nudge, onLeft) => {
    const pos = placeWeaponOnHand(body, weapon, scale, nudge, onLeft);
    return { x: pos.x + weapon.cx * scale, y: pos.y + weapon.cy * scale };
  };

  for (const [bodyName, body] of [["小身体 70", bodySmall], ["大身体 206", bodyBig]]) {
    for (const [weaponName, weapon] of [["长武器 174", weaponTall], ["短武器 60", weaponShort]]) {
      for (const onLeft of [true, false]) {
        const hand = handAnchor(body, onLeft);
        const center = centerAfter(body, weapon, 1, { x: 0, y: 0 }, onLeft);
        const dx = Math.abs(center.x - hand.x);
        const dy = Math.abs(center.y - hand.y);
        check(dx < 1e-6 && dy < 1e-6, `${bodyName} + ${weaponName} + ${onLeft ? "左手" : "右手"}：内容中心 = 握持点`, `偏差 (${dx.toFixed(3)}, ${dy.toFixed(3)})`);
      }
    }
  }

  const handSmall = handAnchor(bodySmall, true);
  const handBig = handAnchor(bodyBig, true);
  check(
    Math.abs(handSmall.x - bodySmall.cx) < bodySmall.w / 2 + 1e-6 && Math.abs(handSmall.y - (bodySmall.cy - bodySmall.h / 2 + bodySmall.h * EQUIP_ALIGN.handHeightRatio)) < 1e-6,
    "握持点在身体范围内（横向在 bbox 内、纵向在胯部附近）",
  );
  check(
    Math.abs(handBig.y - (bodyBig.cy - bodyBig.h / 2 + bodyBig.h * EQUIP_ALIGN.handHeightRatio)) < 1e-6,
    "握持点纵向 = 脚底 + 身体高 × handHeightRatio",
  );
  const leftHand = handAnchor(bodySmall, true);
  const rightHand = handAnchor(bodySmall, false);
  check(Math.abs(rightHand.x - leftHand.x - bodySmall.w * EQUIP_ALIGN.handSideRatio) < 1e-6, "左右手互为镜像（横向相差 身体宽 × handSideRatio）");

  const nudged = placeWeaponOnHand(bodySmall, weaponTall, 1, { x: 3, y: -2 }, true);
  const plain = placeWeaponOnHand(bodySmall, weaponTall, 1, { x: 0, y: 0 }, true);
  check(Math.abs(nudged.x - plain.x - 3) < 1e-6 && Math.abs(nudged.y - plain.y + 2) < 1e-6, "逐件微调只平移，不参与公式");

  //#endregion

  //#region B. 内观

  console.log("\n— B. 内观：缩放 = 身体高 × 1.15 / 武器高，位置贴左手位 —");

  const { placeInShowWeapon } = align;
  for (const [bodyName, body] of [["小身体 70", bodySmall], ["大身体 206", bodyBig]]) {
    for (const [weaponName, weapon] of [["长武器 174", weaponTall], ["短武器 60", weaponShort]]) {
      const placed = placeInShowWeapon(body, weapon);
      const expectedScale = (body.h * EQUIP_ALIGN.inWeaponHeightRatio) / weapon.h;
      check(Math.abs(placed.scale - expectedScale) < 1e-6, `${bodyName} + ${weaponName}：缩放 ${placed.scale.toFixed(3)} = ${expectedScale.toFixed(3)}`);
      const hand = handAnchor(body, true);
      const cx = placed.x + weapon.cx * placed.scale;
      const cy = placed.y + weapon.cy * placed.scale;
      check(Math.abs(cx - hand.x) < 1e-6 && Math.abs(cy - hand.y) < 1e-6, `${bodyName} + ${weaponName}：武器内容中心 = 左手位`);
      check(
        Math.abs(weapon.h * placed.scale - body.h * EQUIP_ALIGN.inWeaponHeightRatio) < 1e-6,
        `${bodyName} + ${weaponName}：武器显示高度 = 身体高 × ${EQUIP_ALIGN.inWeaponHeightRatio}`,
      );
    }
  }

  //#endregion

  //#region C. 配置层不许写死绝对坐标

  console.log("\n— C. 武器配置里的几何字段只当微调（|值| ≤ 4） —");

  const NUDGE_LIMIT = 4;
  const baseWeapons = [...weapons.entries()].filter(([key]) => /^weapon_\d+$/.test(key));
  check(baseWeapons.length >= 20, `武器基础条目数 ${baseWeapons.length}（按 weapon_<id> 取）`);
  // `outManual` 的武器是管理端「装备对齐」工作台以裸模为基准手调过的绝对值（#509），
  // 它们的数值本来就该是几十上百 —— 这条只约束**仍走自动算法**的那些。
  const offenders = [];
  const manualWeapons = [];
  for (const [key, weapon] of baseWeapons) {
    if (weapon.outManual) {
      manualWeapons.push(key);
      continue;
    }
    const values = [weapon.inPosition.x, weapon.inPosition.y, ...weapon.outPositions.flatMap((p) => [p.x, p.y])];
    const bad = values.filter((v) => Math.abs(v) > NUDGE_LIMIT);
    if (bad.length) offenders.push(`${key}(${bad.map((v) => v.toFixed(1)).join(",")})`);
  }
  check(offenders.length === 0, "没有「自动算法」的武器写手调绝对坐标（手调过的必须置 outManual）", offenders.slice(0, 5).join(" "));
  console.log(`  · 已手调（outManual）的武器：${manualWeapons.length ? manualWeapons.join(", ") : "暂无（等工作台产出）"}`);
  check(
    baseWeapons.every(([, weapon]) => weapon.outPositions.length === 8),
    "每把武器的 outPositions 仍是 8 个方向（下标与 configs/animation.directions 对齐）",
  );

  //#endregion

  //#region D. 接线：组件必须走纯函数

  console.log("\n— D. 组件接线（不许另写一份公式） —");

  const appearance = read("assets/ui/components/role/RoleAppearance.ts");
  const inShow = read("assets/ui/components/panel/RoleInShowView.ts");
  const helper = read("assets/ui/helpers/GameUiHelper.ts");

  check(/placeWeaponOnHand\(/.test(appearance), "RoleAppearance 用 placeWeaponOnHand 算武器位置");
  check(!/handSideRatio|handHeightRatio/.test(appearance), "RoleAppearance 里没有另写一份手部比例");
  check(/applyWeaponTransform\(\)/.test(appearance), "武器走独立的 applyWeaponTransform（衣服仍走 applyOutTransform）");
  check(/applyOutTransform\(this\.cloth/.test(appearance), "衣服走 applyOutTransform（恒为绝对位置）");
  const manualBranch = /if \(this\.weaponTransform\?\.outManual\) \{\s*this\.applyOutTransform\(this\.weapon, this\.weaponTransform\);\s*return;\s*\}/.test(appearance);
  check(manualBranch, "outManual 的武器直接摆到绝对位置并提前返回（不再叠一层自动算法）");
  check(/spriteContentBox\(this\.weapon\)/.test(appearance) && /spriteContentBox\(this\.cloth\)/.test(appearance), "位置由「武器帧 + 身体帧」两边的内容 bbox 推出来");
  check(/const clothScale = this\.cloth\.scale\.x/.test(appearance), "身体 bbox 按衣服节点缩放换算（衣服带 outScale 时握持点不能少乘）");
  check(/retryAlign\(\)/.test(appearance), "素材未就绪时有重试（首帧还没落到 Sprite 上时不能拿 (0,0) 硬算）");
  check(/EQUIP_ALIGN\.alignRetryTimes/.test(appearance) && /EQUIP_ALIGN\.alignRetryDelayMs/.test(inShow), "重试次数与间隔取自配置 EQUIP_ALIGN（不在组件里写魔法数字）");
  check(EQUIP_ALIGN.alignRetryTimes > 0 && EQUIP_ALIGN.alignRetryDelayMs > 0, `重试配置有效：${EQUIP_ALIGN.alignRetryTimes} 次 × ${EQUIP_ALIGN.alignRetryDelayMs}ms`);

  const goodTypes = read("assets/types/good.ts");
  check(/outManual\?:\s*boolean/.test(goodTypes), "OutTransform 上有 outManual 开关（武器绝对位置语义）");
  // 写回脚本在**仓库根**的 tools/ 下（本文件的 read() 相对 client/）
  const applyTool = fs.readFileSync(path.join(PROJECT_ROOT, "..", "tools", "apply-equip-align.cjs"), "utf8");
  check(/roleDefaultCloths/.test(applyTool) && /EQUIPMENTS_FILE/.test(applyTool), "写回脚本同时覆盖 equipments.ts 与 role.ts（裸模也能调）");

  check(/placeInShowWeapon\(/.test(inShow), "RoleInShowView 用 placeInShowWeapon 算内观位置与缩放");
  check(/const clothScale = this\.clothInShow\.scale\.x/.test(inShow), "内观身体 bbox 按衣服节点缩放换算（cloth_5 的 inScaleX = 1.3）");
  check(!/WEAPON_IN_HEIGHT_RATIO|HAND_SIDE_RATIO/.test(inShow), "RoleInShowView 里没有另写一份比例常量");
  check(/createRoleClothInShow\([^)]*\(\) => this\.alignWeapon\(\)/.test(inShow), "衣服内观素材就绪后触发一次对齐");
  check(/createRoleWeaponInshow\([^)]*\(\) => this\.alignWeapon\(\)/.test(inShow), "武器内观素材就绪后触发一次对齐");

  check(/static spriteContentBox\(/.test(helper), "GameUiHelper.spriteContentBox 存在（帧内容 bbox 的唯一读法）");
  check(/frame\.offset/.test(helper) && /frame\.getRect\(\)/.test(helper), "spriteContentBox 用 SpriteFrame.offset + rect 还原裁剪偏移");
  check(/rect\.width \* rect\.height <= BLANK_FRAME_MAX_AREA/.test(helper), "占位空帧按面积判（武器空帧是 2×2，边长判据会把它当真实帧去算中心）");
  check(/playLoopAtlasWithDuration\([^)]*\)\.then\(/.test(helper) || /void AnimationHelper\.playLoopAtlasWithDuration/.test(helper), "内观创建把「素材就绪」回调接在异步加载上");

  //#endregion

  finish("test-equip-align：全部通过");
} catch (error) {
  fail(`test-equip-align 失败：${error.message}`);
}
