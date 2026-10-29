#!/usr/bin/env node
/**
 * 装备**内观**几何下发（#523）单测：管理端「保存 → 客户端重开弹窗即见」的客户端半边
 *
 * 跑的是**真实配置表与真实覆写函数**（configs-sandbox 编译 CommonJS + cc 垫片），不是复刻。
 * 盯的八组口径：
 * · 覆写命中 —— 衣服 / 武器按基础件命中**全部 15 个变体**（背包里看到的与弹窗里画的必须同一套）
 * · 两轴独立 —— `inScaleX` / `inScaleY` 各写各的（衣服素材常有 1.3 / 1 这种不等比缩放）
 * · 只碰内观 —— 资源路径（icon / in / out）与**外观几何**（outScale / outPositions）一个都不动
 * · 武器开关 —— `inManual` 决定客户端走不走自动算法（关掉就该回到自动算）
 * · 重置 = 删行 —— 空列表 / 显式还原都要回到出厂值，否则「管理端重置了」重开弹窗仍是旧位置
 * · 坏数据只丢自己 —— 一条写坏的 id 不能拖累整张表
 * · 接线钉死 —— 内观**每次进图都拉**，覆写前必先还原，`RoleInShowView` 对手调武器短路
 *
 * 用法：node client/tools/test-equip-in-align-apply.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

/** 一条服务端内观行（字段与 EquipInAlignDto 一一对应） */
function inRow(id, patch = {}) {
  return { id, inScaleX: 1.5, inScaleY: 1.2, inPosition: { x: -10, y: 20 }, inManual: true, updatedAt: 0, ...patch };
}

/** 内观几何拍平成可比较的字符串（Vec2 实例不能直接 JSON 比） */
function inSnapshot(target) {
  return JSON.stringify({
    inScaleX: target.inScaleX ?? 1,
    inScaleY: target.inScaleY ?? 1,
    inPosition: [target.inPosition?.x ?? 0, target.inPosition?.y ?? 0],
    inManual: target.inManual === true,
  });
}

/** 外观几何拍平：内观覆写不该碰到它们 */
function outSnapshot(target) {
  return JSON.stringify({
    outScale: target.outScale,
    outPositions: (target.outPositions ?? []).map((point) => [point.x, point.y]),
    outManual: target.outManual === true,
  });
}

function main() {
  let outDir;
  try {
    outDir = prepare("olua-equip-in-align-apply", ["configs/apply-snapshot.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const { items } = require(path.join(outDir, "configs/items.js"));
  const applyApi = require(path.join(outDir, "configs/apply-snapshot.js"));

  const cloth = items.get("cloth_1");
  const otherCloth = items.get("cloth_10");
  const weapon = items.get("weapon_1");
  if (!cloth || !otherCloth || !weapon) {
    fail("配置表里找不到 cloth_1 / cloth_10 / weapon_1，单测前提不成立");
    return;
  }
  const clothVariants = [...items.keys()].filter((id) => id === "cloth_1" || id.startsWith("cloth_1_p"));

  console.log("\n=== 一、衣服：基础件 + 全部变体一起改（只改基础件 = 弹窗里还是原先） ===");
  check(clothVariants.length === 15, "cloth_1 展开成 15 件（基础件 + 14 个前后缀变体）", String(clothVariants.length));
  const clothFactory = inSnapshot(cloth);
  const clothOutFactory = outSnapshot(cloth);
  const clothPaths = JSON.stringify([cloth.icon, cloth.in, cloth.out]);
  applyApi.applyEquipInAlignRows([inRow("cloth:cloth_1")]);
  check(cloth.inScaleX === 1.5, "横向缩放到手", String(cloth.inScaleX));
  check(cloth.inScaleY === 1.2, "纵向缩放到手（两轴各自写，不互相牵制）", String(cloth.inScaleY));
  check(cloth.inPosition.x === -10 && cloth.inPosition.y === 20, "位置 y 是游戏坐标（向上为正，不做翻转）", `${cloth.inPosition.x},${cloth.inPosition.y}`);
  const missed = clothVariants.filter((id) => inSnapshot(items.get(id)) !== inSnapshot(cloth));
  check(missed.length === 0, "全部变体的内观几何与基础件一致", missed.slice(0, 3).join(",") || "无遗漏");
  check(JSON.stringify([cloth.icon, cloth.in, cloth.out]) === clothPaths, "资源路径一个都没动（icon / in / out）", clothPaths);
  check(outSnapshot(cloth) === clothOutFactory, "外观几何一个都没动（内观覆写不越界）");

  console.log("\n=== 二、按基础件精确命中：别把别的衣服也改了 ===");
  const otherFactory = inSnapshot(otherCloth);
  check(inSnapshot(otherCloth) === otherFactory, "cloth_5 不受 cloth_1 的影响（基础件 key 必须逐字相等）");

  console.log("\n=== 三、武器：inManual 是「这份绝对值生效」的开关 ===");
  applyApi.applyEquipInAlignRows([inRow("weapon:weapon_1", { inScaleX: 0.8, inScaleY: 0.8, inPosition: { x: -50, y: 12 }, inManual: true })]);
  check(weapon.inManual === true && weapon.inScaleX === 0.8, "手调过的武器用绝对位置", `${weapon.inManual} / ${weapon.inScaleX}`);
  check(weapon.inPosition.x === -50 && weapon.inPosition.y === 12, "武器位置同样落在 inPosition 上", `${weapon.inPosition.x},${weapon.inPosition.y}`);
  applyApi.applyEquipInAlignRows([inRow("weapon:weapon_1", { inManual: false })]);
  check(weapon.inManual === false, "改回 false 立刻回到自动算法（不用重新加载）", String(weapon.inManual));

  console.log("\n=== 四、重置 = 删行：回到出厂值，且删行与「从没调过」长得一样 ===");
  applyApi.applyEquipInAlignRows([inRow("cloth:cloth_1", { inScaleX: 4, inScaleY: 4, inPosition: { x: 99, y: 99 } })]);
  check(inSnapshot(cloth) !== clothFactory, "先确认真的被改过（否则下面的还原断言等于没测）");
  applyApi.applyEquipInAlignRows([]);
  check(inSnapshot(cloth) === clothFactory, "空列表 = 全部回到出厂值（服务端删行的落地方式）", inSnapshot(cloth));
  applyApi.applyEquipInAlignRows([inRow("cloth:cloth_1", { inScaleX: 4 })]);
  applyApi.resetEquipInAlignRows();
  check(inSnapshot(cloth) === clothFactory, "显式还原同样回到出厂值（重进游戏重新拉之前那一步）");

  console.log("\n=== 五、坏数据只丢自己，不连坐整张表 ===");
  const weaponBeforeBad = inSnapshot(weapon);
  applyApi.applyEquipInAlignRows([
    null,
    { id: 123 },
    { id: "cloth:" },
    { id: "role:1" },
    { id: "cloth:nope" },
    inRow("cloth:cloth_1", { inScaleX: 1.75 }),
  ]);
  check(cloth.inScaleX === 1.75, "同一批里的坏行没有拖累好行", String(cloth.inScaleX));
  check(inSnapshot(weapon) === weaponBeforeBad, "未知 id 不改任何东西（装备清单在客户端，服务端只校验形态）");
  let threw = false;
  try {
    applyApi.applyEquipInAlignRows(null);
    applyApi.applyEquipInAlignRows(undefined);
  } catch (error) {
    threw = true;
  }
  check(!threw, "接口给 null / undefined 不炸（旧服务端没有这个接口时就是空）");

  console.log("\n=== 六、幂等：同一份行覆写两次结果一致 ===");
  const rows = [inRow("cloth:cloth_1", { inScaleX: 1.3 }), inRow("weapon:weapon_1", { inManual: true })];
  applyApi.applyEquipInAlignRows(rows);
  const once = inSnapshot(cloth) + inSnapshot(weapon);
  applyApi.applyEquipInAlignRows(rows);
  check(inSnapshot(cloth) + inSnapshot(weapon) === once, "两次结果一致（不会因为「先还原再覆写」越叠越离谱）");
  applyApi.applyEquipInAlignRows([]);

  console.log("\n=== 七、接线钉死（这几处不接上，保存了也不会生效） ===");  const applySnapshot = read("assets/configs/apply-snapshot.ts");
  check(
    /export function applyEquipInAlignRows[\s\S]{0,160}?resetEquipInAlignRows\(\)/.test(applySnapshot),
    "applyEquipInAlignRows 先还原出厂值再覆写（否则删行在重开弹窗后仍是旧位置）",
  );
  check(!/target\.in\s*=/.test(applySnapshot) && !/target\.inRotate\s*=/.test(applySnapshot), "覆写函数不碰资源路径，也不碰旋转");

  const configLoader = read("assets/ui/utils/net/ConfigLoader.ts");
  check(/GameConfigApi\.equipInAlign\(/.test(configLoader), "ConfigLoader 拉的是 gameConfig.equipInAlign");
  check(
    /Promise\.all\(\[loadSnapshotOnce\(\), loadAlignEveryEntry\(\), loadInAlignEveryEntry\(\)\]\)/.test(configLoader),
    "内观与快照、外观并行拉",
  );
  check(
    /function loadInAlignEveryEntry[\s\S]{0,700}?inAlignLoading = null;/.test(configLoader) &&
      !/function loadInAlignEveryEntry[\s\S]{0,300}?snapshotLoaded/.test(configLoader),
    "内观每次进图都拉（被 loaded 短路会让重进看不到新位置）",
  );

  const roleInShow = read("assets/ui/components/panel/RoleInShowView.ts");
  check(/this\.weaponManual = weapon\.inManual === true;/.test(roleInShow), "weaponManual 取自配置的 inManual");
  check(/if \(this\.weaponManual\) return;/.test(roleInShow), "手调过的武器在 alignWeapon 里直接返回（否则保存会被自动算法当场覆盖）");

  console.log("\n=== 八、开弹窗就再拉一次（#527：不重进地图也要看到保存结果） ===");
  check(/export function refreshInAlign\(\): Promise<void>/.test(configLoader), "ConfigLoader 导出 refreshInAlign（弹窗打开时调）");
  check(
    /export function refreshInAlign[\s\S]{0,320}?return fetchInAlignGeometry\(\);/.test(configLoader) &&
      !/export function refreshInAlign[\s\S]{0,320}?inAlignLoading/.test(configLoader),
    "refreshInAlign 永远发新请求（被「进图那次」的 Promise 顶掉就等于没拉）",
  );
  check(
    /catch\(\(error: unknown\) => \{[\s\S]{0,420}?console\.warn\("\[config\] 内观几何拉取失败/.test(configLoader),
    "内观拉取失败要 warn（静默跳过会让「服务端旧版本 404」看起来像「保存没生效」）",
  );
  const roleInfo = read("assets/ui/components/dialogs/RoleInfoDialog.ts");
  check(/import \{ refreshInAlign \} from "\.\.\/\.\.\/utils\/net\/ConfigLoader";/.test(roleInfo), "RoleInfoDialog 引入了 refreshInAlign");
  check(
    /refreshInAlign\(\)\.then\([\s\S]{0,700}?this\.inShowView\?\.updateCloth\([\s\S]{0,220}?this\.inShowView\?\.updateWeapon\(/.test(roleInfo),
    "拉到新几何后就地重建内观（衣服 + 武器都刷，否则只有一半生效）",
  );

  const good = read("assets/types/good.ts");
  check(/inManual\?: boolean;/.test(good), "Equipment 上有 inManual 字段（几何覆写要能写进去）");

  finish("装备内观几何下发：全部断言通过");
}

main();
