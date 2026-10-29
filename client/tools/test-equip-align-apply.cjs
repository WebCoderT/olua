#!/usr/bin/env node
/**
 * 装备外观几何下发（#513）单测：管理端「保存 → 客户端重新加载即见」的客户端半边
 *
 * 跑的是**真实配置表与真实覆写函数**（configs-sandbox 编译 CommonJS + cc 垫片），不是复刻。
 * 盯的八组口径：
 * · 覆写命中 —— 衣服 / 武器按基础件命中**全部 15 个变体**（只改基础件会「背包预览对了、穿上身还歪」）
 * · 只碰几何 —— 资源路径（icon / in / out）一个都不动（这是快照纪律里唯一开口的地方）
 * · 裸模按性别 —— role:1 只改男、role:2 只改女
 * · 重置 = 删行 —— 空列表 / 显式还原都要回到出厂值，否则「管理端重置了」在重进游戏后仍显示旧位置
 * · 接线钉死 —— 几何**每次进图都拉**（快照只拉一次），且覆写前必先还原出厂值
 * · 出厂几何踩地 —— 裸模的 outPositions 不能是全 0（锚点是画布中心，全 0 = 身体沉到地面以下）
 *
 * 用法：node client/tools/test-equip-align-apply.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

/** 8 个方向的坐标（顺序与 configs/animation 的 directions 一致） */
function eightPositions(base) {
  return Array.from({ length: 8 }, (_, index) => ({ x: base + index, y: base * 10 + index }));
}

/** 一条服务端对齐行（字段与 EquipAlignDto 一一对应） */
function alignRow(id, patch = {}) {
  return { id, outScale: 1.5, outPositions: eightPositions(100), outManual: false, updatedAt: 0, ...patch };
}

/** 把几何拍平成可比较的字符串（Vec2 实例不能直接 JSON 比） */
function snapshotOf(target) {
  return JSON.stringify({
    outScale: target.outScale,
    outPositions: (target.outPositions ?? []).map((point) => [point.x, point.y]),
    outManual: target.outManual === true,
  });
}

function main() {
  let outDir;
  try {
    outDir = prepare("olua-equip-align-apply", ["configs/apply-snapshot.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const { items } = require(path.join(outDir, "configs/items.js"));
  const { roleDefaultCloths } = require(path.join(outDir, "configs/role.js"));
  const { SEX } = require(path.join(outDir, "types/role.js"));
  const applyApi = require(path.join(outDir, "configs/apply-snapshot.js"));

  const cloth = items.get("cloth_1");
  const weapon = items.get("weapon_1");
  const boy = roleDefaultCloths.get(SEX.BOY);
  const girl = roleDefaultCloths.get(SEX.GRIL);
  if (!cloth || !weapon || !boy || !girl) {
    fail("配置表里找不到 cloth_1 / weapon_1 / 裸模，单测前提不成立");
    return;
  }
  const clothVariants = [...items.keys()].filter((id) => id === "cloth_1" || id.startsWith("cloth_1_p"));

  console.log("\n=== 一、衣服：基础件 + 全部变体一起改（只改基础件 = 穿上身还是歪） ===");
  check(clothVariants.length === 15, "cloth_1 展开成 15 件（基础件 + 14 个前后缀变体）", String(clothVariants.length));
  const clothFactory = snapshotOf(cloth);
  const clothPaths = JSON.stringify([cloth.icon, cloth.in, cloth.out]);
  applyApi.applyEquipAlignRows([alignRow("cloth:cloth_1", { outScale: 2.5 })]);
  check(cloth.outScale === 2.5, "基础件的缩放到手", String(cloth.outScale));
  check(cloth.outPositions.length === 8, "8 个方向都写上（少一个方向就少一个朝向的位置）", String(cloth.outPositions.length));
  check(
    cloth.outPositions[3].x === 103 && cloth.outPositions[3].y === 1003,
    "坐标按方向下标落位（第 4 个方向 = 数组第 4 项）",
    `${cloth.outPositions[3].x},${cloth.outPositions[3].y}`,
  );
  const missed = clothVariants.filter((id) => snapshotOf(items.get(id)) !== snapshotOf(cloth));
  check(missed.length === 0, "全部变体的几何与基础件一致（背包预览 / 穿在身上同一套）", missed.slice(0, 3).join(",") || "无遗漏");
  check(JSON.stringify([cloth.icon, cloth.in, cloth.out]) === clothPaths, "资源路径一个都没动（icon / in / out）", clothPaths);

  console.log("\n=== 二、武器：outManual 是「这是绝对位置」的开关 ===");
  applyApi.applyEquipAlignRows([alignRow("weapon:weapon_1", { outScale: 3, outManual: true })]);
  check(weapon.outManual === true && weapon.outScale === 3, "手调过的武器走绝对位置", `${weapon.outManual} / ${weapon.outScale}`);
  check(
    weapon.outPositions[0].x === 100 && weapon.outPositions[7].y === 1007,
    "武器 8 方向坐标同样按方向下标落位",
    `${weapon.outPositions[0].x},${weapon.outPositions[7].y}`,
  );
  applyApi.applyEquipAlignRows([alignRow("weapon:weapon_1", { outManual: false })]);
  check(weapon.outManual === false, "改回 false 立刻回到运行时算位置（不用重新加载）", String(weapon.outManual));

  console.log("\n=== 三、裸模按性别：role:1 只改男、role:2 只改女 ===");
  const girlBefore = snapshotOf(girl);
  applyApi.applyEquipAlignRows([alignRow("role:1", { outScale: 1.2 })]);
  check(boy.outScale === 1.2, "role:1 落到男裸模", String(boy.outScale));
  check(snapshotOf(girl) === girlBefore, "女裸模不受影响（别把两个性别的裸模写成同一个对象）");
  applyApi.applyEquipAlignRows([alignRow("role:2", { outScale: 0.8 })]);
  check(girl.outScale === 0.8 && boy.outScale !== 0.8, "role:2 只落到女裸模", `${girl.outScale} / ${boy.outScale}`);

  console.log("\n=== 四、重置 = 删行：回到出厂值，且删行与「从没调过」长得一样 ===");
  applyApi.applyEquipAlignRows([alignRow("cloth:cloth_1", { outScale: 4 })]);
  check(snapshotOf(cloth) !== clothFactory, "先确认真的被改过（否则下面的还原断言等于没测）");
  applyApi.applyEquipAlignRows([]);
  check(snapshotOf(cloth) === clothFactory, "空列表 = 全部回到出厂值（服务端删行的落地方式）", snapshotOf(cloth));
  applyApi.applyEquipAlignRows([alignRow("cloth:cloth_1", { outScale: 4 })]);
  applyApi.resetEquipAlignRows();
  check(snapshotOf(cloth) === clothFactory, "显式还原同样回到出厂值（重进游戏重新拉之前那一步）");
  check(boy.outScale === 1 && girl.outScale === 1, "裸模也一起回到出厂值", `${boy.outScale} / ${girl.outScale}`);

  console.log("\n=== 五、坏数据只丢自己，不连坐整张表 ===");
  const weaponBeforeBad = snapshotOf(weapon);
  applyApi.applyEquipAlignRows([
    null,
    { id: 123 },
    { id: "cloth:" },
    { id: "cloth:nope" },
    alignRow("cloth:cloth_1", { outScale: 1.75 }),
  ]);
  check(cloth.outScale === 1.75, "同一批里的坏行没有拖累好行", String(cloth.outScale));
  check(snapshotOf(weapon) === weaponBeforeBad, "未知 id 不改任何东西（装备清单在客户端，服务端只校验形态）");
  let threw = false;
  try {
    applyApi.applyEquipAlignRows(null);
    applyApi.applyEquipAlignRows(undefined);
  } catch (error) {
    threw = true;
  }
  check(!threw, "接口给 null / undefined 不炸（旧服务端没有这个接口时就是空）");

  console.log("\n=== 六、幂等：同一份行覆写两次结果一致 ===");
  const rows = [alignRow("cloth:cloth_1", { outScale: 1.3 }), alignRow("role:1", { outScale: 1.1 })];
  applyApi.applyEquipAlignRows(rows);
  const once = snapshotOf(cloth) + snapshotOf(boy);
  applyApi.applyEquipAlignRows(rows);
  check(snapshotOf(cloth) + snapshotOf(boy) === once, "两次结果一致（不会因为「先还原再覆写」把值越叠越离谱）");
  applyApi.applyEquipAlignRows([]);

  console.log("\n=== 七、接线钉死（这几处不接上，保存了也不会生效） ===");
  const applySnapshot = read("assets/configs/apply-snapshot.ts");
  check(
    /export function applyEquipAlignRows[\s\S]{0,160}?resetEquipAlignRows\(\)/.test(applySnapshot),
    "applyEquipAlignRows 先还原出厂值再覆写（否则删行在重进后仍是旧位置）",
  );
  check(!/target\.out\s*=/.test(applySnapshot), "覆写函数不碰资源路径（只写 outScale / outPositions / outManual）");

  const configLoader = read("assets/ui/utils/net/ConfigLoader.ts");
  check(/GameConfigApi\.equipAlign\(/.test(configLoader), "ConfigLoader 拉的是 gameConfig.equipAlign");
  check(
    /Promise\.all\(\[loadSnapshotOnce\(\), loadAlignEveryEntry\(\)\]\)/.test(configLoader),
    "快照与几何并行拉（串行会平白多一个 RTT，而这个 RTT 卡在进游戏路径上）",
  );
  check(
    /if \(snapshotLoaded\) return Promise\.resolve\(\)/.test(configLoader) &&
      !/function loadAlignEveryEntry[\s\S]{0,200}?snapshotLoaded/.test(configLoader),
    "几何每次进图都拉（只有快照被 loaded 短路 —— 否则退回选角再进图看不到新位置）",
  );

  const game = read("assets/ui/Game.ts");
  check(/void loadGameConfig\(\)/.test(game), "Game 场景启动时调 loadGameConfig（每次进图都走一遍）");

  console.log("\n=== 八、裸模出厂几何必须真的踩在地面上 ===");
  // 坑：外观节点是默认 anchor 0.5/0.5 的 Sprite，位置的语义是「**画布中心**落在脚下」，
  // 而美术画布底部留着 25~66 单位的空白 —— 全 0 会让身体沉到地面以下 26~31 个单位
  // （客户端开着 debug.colliderRange 时表现为「锚点跑到人物身体正中间」）。
  // 这里只钉「补偿还在」：具体数值由管理端「装备对齐 / 脚底贴地」调，量图得到的出厂值见 configs/role.ts。
  const boyYs = boy.outPositions.map((point) => point.y);
  const girlYs = girl.outPositions.map((point) => point.y);
  check(boyYs.length === 8 && girlYs.length === 8, "两套裸模都是 8 个方向（缺项会回落到第 0 项，整件歪掉）", `${boyYs.length}/${girlYs.length}`);
  check(boyYs.every((y) => y >= 20), "男裸模 8 个方向都带着「画布留白」的补偿（全 0 = 身体沉到地面以下）", boyYs.join(","));
  check(girlYs.every((y) => y >= 20), "女裸模同口径", girlYs.join(","));

  finish("装备外观几何下发：全部断言通过");
}

main();
