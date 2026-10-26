#!/usr/bin/env node
/**
 * 时装穿戴系统单测（client/tools/test-fashion.cjs，issue #377）
 *
 * 盯的不变量（改时装 / 外观链后必须全绿）：
 * A. 数据：衣柜 = configs/fashionClothes 的 20 套（id 唯一、资源路径形状正确）
 * B. 存档：fashionCloth 是**时装 id**；旧档的数字 / 未知 id / 缺失一律迁成 null
 * C. 穿脱（沙箱里跑**真实的 StorageManager**）：穿上 / 脱下 / 重复穿 / 未知 id，
 *    以及「时装只换外观不换数值」—— 穿脱前后装备槽、血量上限、背包都不动
 * D. 外观取源：三处（场景主角 / 进图预载 / 弹窗内观）都走「时装 > 装备衣服 > 默认外观」
 * E. 界面接线：角色信息弹窗的「时装」入口 + 衣柜弹窗的几何与文案都来自 configs
 *
 * 素材只断言路径形状，不读文件（resources 以远程 Release 为唯一来源，本机不铺素材）。
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

let sandbox;
try {
  sandbox = require("./lib/storage-sandbox.cjs").prepareStorage("olua-fashion");
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  process.exitCode = 1;
}

const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");

if (sandbox) {
  const { StorageManager, Role, outDir } = sandbox;
  const { fashionData, getFashion, getFashionOut, getFashionIn } = require(path.join(outDir, "configs/fashionClothes.js"));
  const { getEquipment } = require(path.join(outDir, "configs/items.js"));

  /** 造一个在线角色（背包清空，避免初始装备干扰断言） */
  function seedRole(patch = {}) {
    const role = new Role("测试角色", "1", "1");
    role.id = "r1";
    role.bag = role.bag.map((row) => row.map(() => null));
    Object.assign(role, patch);
    StorageManager.clear();
    StorageManager.setRoles([role]);
    StorageManager.onlineRole("r1");
    return role;
  }
  const online = () => StorageManager.findOnlineRole();

  //#region A. 数据

  console.log("\n— A. 衣柜数据 —");
  check(Array.isArray(fashionData) && fashionData.length === 20, `衣柜 20 套时装（实得 ${fashionData.length}）`);
  check(new Set(fashionData.map((item) => item.id)).size === fashionData.length, "时装 id 唯一");
  check(
    fashionData.every((item) => item.label && item.description && item.icon.startsWith("clothes/")),
    "每套都有名称 / 描述 / clothes 目录下的图标",
  );
  check(
    fashionData.every((item) => !item.out || item.out.startsWith("clothes/out/")) && fashionData.every((item) => !item.in || item.in.startsWith("clothes/in/")),
    "外观与内观资源都指向 clothes/out|in（路径形状正确）",
  );
  check(fashionData.some((item) => item.out) && fashionData.some((item) => !item.out), "既有带外观的、也有只有内观的（两个分支都要能演）");
  check(getFashion("cloth_2")?.label === "妖绯巫女", "getFashion 按 id 取到配置");
  check(getFashion("no_such_fashion") === null && getFashion(null) === null, "未知 id / 空值返回 null（界面据此判空）");

  //#endregion

  //#region B. 存档迁移

  console.log("\n— B. 存档：fashionCloth 是时装 id，旧值一律迁成 null —");
  seedRole({ fashionCloth: 3 });
  check(online().fashionCloth === null, "旧档里的数字（历史遗留形状）迁成 null（不猜它指哪件）");
  seedRole({ fashionCloth: "no_such_fashion" });
  check(online().fashionCloth === null, "配置表里没有的 id 迁成 null");
  seedRole({ fashionCloth: "cloth_2" });
  check(online().fashionCloth === "cloth_2", "合法 id 原样保留");
  seedRole();
  check(online().fashionCloth === null, "缺失该字段的旧档补 null");

  //#endregion

  //#region C. 穿脱

  console.log("\n— C. 穿脱：只换外观，不换数值 —");
  seedRole();
  const before = online();
  const equipmentsBefore = JSON.stringify(before.equipments);
  const hpBefore = before.maxHp;

  check(StorageManager.wearFashion("cloth_2") === true, "穿上返回 true");
  check(online().fashionCloth === "cloth_2", "穿上已落盘（重新读档可见）");
  check(StorageManager.getWornFashion()?.id === "cloth_2", "getWornFashion 解析出当前时装");
  check(StorageManager.wearFashion("cloth_2") === true, "重复穿同一件返回 true（幂等，不重复落盘）");
  check(StorageManager.wearFashion("cloth_3") === true && online().fashionCloth === "cloth_3", "换另一件直接覆盖（不需要先脱）");
  check(StorageManager.wearFashion("no_such_fashion") === false && online().fashionCloth === "cloth_3", "未知 id 穿不上且不改当前穿戴");
  check(JSON.stringify(online().equipments) === equipmentsBefore, "穿时装不动装备槽");
  check(online().maxHp === hpBefore, "穿时装不动血量上限（数值仍由装备决定）");
  check(StorageManager.unwearFashion() === true && online().fashionCloth === null, "脱下返回 true 且落盘为 null");
  check(StorageManager.unwearFashion() === false, "没穿时脱下返回 false");
  check(online().maxHp === hpBefore && JSON.stringify(online().equipments) === equipmentsBefore, "脱下同样不动数值");

  // 装备与时装并存：外观由时装接管，装备槽里的那件仍然在（数值照旧）
  seedRole();
  const clothId = "cloth_1";
  // findOnlineRole 每次都从 localStorage 解析出新对象 —— 改完必须把**同一个**对象交回数据层
  const withCloth = online();
  withCloth.equipments.cloth = clothId;
  StorageManager.updateOnlineRole(withCloth);
  StorageManager.wearFashion("cloth_4");
  check(online().equipments.cloth === clothId, "穿着时装时装备槽里的衣服不丢（只是外观被时装盖住）");
  check(getFashionOut(online().fashionCloth) === getFashion("cloth_4").out, "外观取源：时装优先于装备");
  StorageManager.unwearFashion();
  check(getFashionOut(online().fashionCloth) === null, "脱下后取源回落到装备衣服（getFashionOut 返回 null）");

  //#endregion

  //#region D. 外观取源（三处必须同口径）

  console.log("\n— D. 外观取源：场景 / 预载 / 内观 —");
  const appearanceSource = read("assets/ui/components/role/RoleAppearance.ts");
  const preloadSource = read("assets/ui/core/PreloadManager.ts");
  const inShowSource = read("assets/ui/components/panel/RoleInShowView.ts");
  check(
    /getFashionOut\(source\.fashionCloth\) \|\| cloth\?\.out \|\| fallback\.out/.test(appearanceSource),
    "场景主角：时装 > 装备衣服 > 默认身体",
  );
  check(
    /export type RoleOutSource = \{[\s\S]*?fashionCloth: string \| null;/.test(appearanceSource),
    "装配的数据形状是结构化子集（远端玩家复用同一份代码，见 #383）",
  );
  check(
    /getFashionOut\(role\.fashionCloth\) \|\| getEquipment\(role\.equipments\.cloth\)\?\.out \|\| getRoleDefaultCloth\(role\.sex\)\.out/.test(preloadSource),
    "进图预载与场景同一口径（否则第一帧还是旧衣服）",
  );
  check(/getFashionIn\(role\.fashionCloth\)/.test(inShowSource), "弹窗内观用时装的内观资源");
  check(/服装|时装/.test(inShowSource) && /cloth/.test(inShowSource), "内观取源注释写清楚了优先级（下一个人不用猜）");
  // 时装只有外观资源，没有几何参数：外观变换仍按装备/默认身体那套（穿时装不会把角色挪位）
  check(/this\.clothTransform = cloth \?\? fallback;/.test(appearanceSource), "外观变换仍取装备（或默认身体）：时装只换帧目录");

  //#endregion

  //#region E. 界面接线

  console.log("\n— E. 界面接线 —");
  const roleInfoSource = read("assets/ui/components/dialogs/RoleInfoDialog.ts");
  const dialogSource = read("assets/ui/components/dialogs/FashionDialog.ts");
  const dialogsSource = read("assets/configs/layout/dialogs.ts");
  check(/new FashionDialog\(\)\.open\(\)/.test(roleInfoSource) && /roleInfoDialogLayout\.fashionButton/.test(roleInfoSource), "角色信息弹窗有「时装」入口（唯一入口，不走 NPC）");
  check(/fashionButton: \{ name: "role_fashion_button"/.test(dialogsSource), "入口按钮几何在 configs/layout/dialogs");
  check(/StorageManager\.wearFashion\(|StorageManager\.unwearFashion\(/.test(dialogSource), "衣柜弹窗的穿脱走数据层（不在界面里改存档）");
  check(/getFashionWardrobe|fashionData/.test(dialogSource) && /columns/.test(dialogsSource), "卡片按配置的列数铺（几何不写死）");
  check(/fashionDialogLayout/.test(dialogSource) && /stateText/.test(dialogsSource), "卡片状态文案来自 configs（无裸中文）");
  {
    // 四个入口按钮同列等距：x 都是 200，相邻 y 差 = 按钮高 36 + 间距 10
    const block = dialogsSource.slice(dialogsSource.indexOf("export const roleInfoDialogLayout"), dialogsSource.indexOf("export const fashionDialogLayout"));
    const posOf = (key) => {
      const match = block.match(new RegExp(`${key}: \\{ name: "[^"]+", position: new Vec2\\((-?\\d+), (-?\\d+)\\)`));
      return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
    };
    const buttons = ["fashionButton", "rankButton", "soulButton", "titleButton"].map(posOf);
    check(buttons.every((item) => item && item.x === 200), "四个入口按钮同列（x = 200）");
    const ys = buttons.map((item) => item.y);
    check(ys.every((y, index) => index === 0 || ys[index - 1] - y === 46), `四格等距 46（高 36 + 间距 10），实测 ${ys.join(" / ")}`);
  }
  check(fs.existsSync(path.join(PROJECT_ROOT, "assets/ui/components/dialogs/FashionDialog.ts.meta")), "新增弹窗带 .meta（进 Cocos 工程的前提）");

  //#endregion

  finish("PASS：时装穿戴（数据 / 存档迁移 / 穿脱 / 外观取源 / 界面接线）全部通过");
}
