#!/usr/bin/env node
/**
 * 商城系统单测（tools/test-mall.cjs）
 *
 * 盯的不变量（改商城后必须全绿）：
 * · 商品表 = 系统内全部装备（七个部位的装备 Map 全量，含 15 品质变体），无重复、id 都能解析回同一对象
 * · 排序稳定：部位序 → 等级 → 前缀 → 后缀
 * · 价格：默认统一 mallPrice（= 1 绑定元宝/件），getMallPrice 全场返回它
 * · 购买链路（在沙箱里跑**真实的 StorageManager**）：扣绑定元宝 → 物品进背包第一个空格；
 *   非装备/认不出的 id、余额不足、背包满三种情况都不改数据（不扣钱、不进包）
 * · 界面接线：底部导航「商城」入口 → MallDialog；弹窗无裸中文、几何与图片全走 configs；
 *   列表虚拟化（滚动时只激活视口附近的行）；悬停详情复用统一零件
 *
 * 用法：node tools/test-mall.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, check, finish, fail } = require("./lib/configs-sandbox.cjs");

let sandbox;
try {
  sandbox = require("./lib/storage-sandbox.cjs").prepareStorage("olua-mall");
} catch (error) {
  fail(`沙箱准备失败：${error.message}`);
  process.exitCode = 1;
}
if (sandbox) {
  const { StorageManager, Role, outDir } = sandbox;
  const { getItem, getItemsByType } = require(path.join(outDir, "configs/items.js"));
  const { getMallGoods, getMallPrice, mallPrice } = require(path.join(outDir, "configs/mall.js"));
  const { equipmentSlotOrder } = require(path.join(outDir, "configs/equipments.js"));

  const read = (rel) => fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
  const mallSource = read("assets/ui/components/dialogs/MallDialog.ts");
  const bottomBarSource = read("assets/ui/components/hud/BottomBar.ts");
  const textsSource = read("assets/configs/texts.ts");
  const dialogsSource = read("assets/configs/layout/dialogs.ts");
  const imagesSource = read("assets/configs/layout/images.ts");

  /** 造角色（Role 的 id 取时间戳，同毫秒会撞，测试里显式指定） */
  function makeRole(id, name) {
    const role = new Role(name, "1", "1");
    role.id = id;
    return role;
  }

  /** 重置存档：只留一个在线角色，清空自带初始装备后按给定格子预置背包与绑定元宝 */
  function seed(cells, bindGold = 0) {
    const role = makeRole("r1", "测试角色");
    // 新建角色自带初始装备，先清空背包（保持 7×11 结构），让断言只针对预置的格子
    role.bag = role.bag.map((row) => row.map(() => null));
    cells.forEach(({ row, col, id, count }) => {
      role.bag[row][col] = { id, count };
    });
    role.bindGold = bindGold;
    StorageManager.clear();
    StorageManager.setRoles([role]);
    StorageManager.onlineRole("r1");
    return role;
  }

  /** 从存储读回（每次都是反序列化的新对象，能真实反映落盘结果） */
  const online = () => StorageManager.findOnlineRole();
  /** 背包里所有非空格子 */
  function filledCells() {
    const list = [];
    online().bag.forEach((row, rowIndex) =>
      row.forEach((cell, colIndex) => {
        if (cell) list.push({ row: rowIndex, col: colIndex, id: cell.id, count: cell.count });
      }),
    );
    return list;
  }

  //#region A. 商品表：系统内全部装备

  console.log("\n— A. 商品表 = 系统内全部装备 —");
  const mallGoods = getMallGoods();
  const allEquipments = getItemsByType("equipment");
  check(mallGoods.length > 0, `商品表非空（${mallGoods.length} 件）`);
  check(
    mallGoods.length === allEquipments.length,
    "商品表覆盖系统内全部装备（含前后缀变体）",
    `商品 ${mallGoods.length} 件 / 物品注册表里的装备 ${allEquipments.length} 件`,
  );
  check(mallGoods.every((good) => good.type === "equipment"), "商品全部是装备（商城只上架装备）");
  check(mallGoods.every((good) => Boolean(good.id)), "每件商品都有 id（格子只存 id，购买链路依赖它）");
  const mallIds = new Set(mallGoods.map((good) => good.id));
  check(mallIds.size === mallGoods.length, "商品无重复（id 唯一）");
  // getItem 按设计返回**副本**（避免运行时数据污染配置表），所以这里比对内容而不是对象身份
  check(
    mallGoods.every((good) => {
      const item = getItem(good.id);
      return item && item.id === good.id && item.label === good.label && item.type === good.type;
    }),
    "每件商品都能用 getItem(id) 解析回同一件物品",
  );

  // 排序：部位序 → 等级 → 前缀 → 后缀
  const slotOrder = (good) => equipmentSlotOrder.get(good.slot) ?? Number.MAX_SAFE_INTEGER;
  const sortedPairs = mallGoods.slice(1).map((good, index) => [mallGoods[index], good]);
  const compare = (a, b) => slotOrder(a) - slotOrder(b) || a.level - b.level || a.prefix - b.prefix || a.suffix - b.suffix;
  check(sortedPairs.every(([a, b]) => compare(a, b) <= 0), "商品按 部位序 → 等级 → 前缀 → 后缀 排好序");
  check(
    mallGoods.length > equipmentSlotOrder.size,
    "商品件数远多于部位数（说明展开到了品质变体层面）",
    `${mallGoods.length} 件 / ${equipmentSlotOrder.size} 个部位`,
  );

  //#endregion

  //#region B. 价格：默认 1 绑定元宝

  console.log("\n— B. 价格（默认统一价）—");
  check(mallPrice === 1, `默认售价 = 1 绑定元宝/件（实际 ${mallPrice}）`);
  check(mallGoods.every((good) => getMallPrice(good) === mallPrice), "全场商品 getMallPrice 都返回统一价");

  //#endregion

  //#region C. 购买链路（真实 StorageManager）

  console.log("\n— C. 购买链路：StorageManager.buyMallGood —");
  const equipment = mallGoods[0];
  const drug = getItemsByType("drug")[0];
  check(Boolean(equipment) && Boolean(drug), "取到装备与药品样本");

  // 1. 正常购买：扣款 + 进背包第一个空格
  seed([], 10);
  check(StorageManager.buyMallGood(equipment.id) === true, "购买成功返回 true");
  check(online().bindGold === 9, "扣掉 1 绑定元宝（10 → 9）");
  check(filledCells().length === 1 && filledCells()[0].id === equipment.id, "商品进了背包");
  check(filledCells()[0].row === 0 && filledCells()[0].col === 0, "优先落在第一个空格 (0,0)");
  check(filledCells()[0].count === 1, "装备不可叠加，数量为 1");

  // 2. 连买两次：不可叠加 → 各占一格
  seed([], 2);
  StorageManager.buyMallGood(equipment.id);
  StorageManager.buyMallGood(equipment.id);
  check(filledCells().length === 2, "连买两件不可叠加装备 → 占两格（不会合并）");
  check(online().bindGold === 0, "两次购买共扣 2 绑定元宝");

  // 3. 余额不足：不改数据
  seed([], 0);
  check(StorageManager.buyMallGood(equipment.id) === false, "余额不足时购买失败");
  check(filledCells().length === 0, "余额不足时背包不变");
  check(online().bindGold === 0, "余额不足时不扣钱");

  // 4. 背包满：不扣钱
  {
    const full = [];
    for (let row = 0; row < 7; row++) for (let col = 0; col < 11; col++) full.push({ row, col, id: drug.id, count: 1 });
    seed(full, 5);
    const before = filledCells().length;
    check(StorageManager.buyMallGood(equipment.id) === false, "背包已满时购买失败");
    check(filledCells().length === before, "背包已满时物品没被塞进去");
    check(online().bindGold === 5, "背包已满时不扣钱（先扣款后入包，入包失败原路退回）");
  }

  // 5. 非装备 / 认不出的 id：都当已下架
  seed([{ row: 0, col: 0, id: drug.id, count: 1 }], 5);
  check(StorageManager.buyMallGood(drug.id) === false, "非装备（药品）买不了");
  check(StorageManager.buyMallGood("no_such_good") === false, "认不出的 id 买不了");
  check(online().bindGold === 5 && filledCells().length === 1, "被拒的购买不改余额与背包");

  // 6. 落盘：换一个新对象读回，数据仍在
  seed([], 3);
  StorageManager.buyMallGood(equipment.id);
  const reloaded = StorageManager.findOnlineRole();
  check(reloaded !== null && reloaded.bag[0][0]?.id === equipment.id && reloaded.bindGold === 2, "购买结果已落盘（重新读档可见）");

  //#endregion

  //#region D. 界面接线与配置

  console.log("\n— D. 界面接线与配置 —");
  check(/import MallDialog from "\.\.\/dialogs\/MallDialog";/.test(bottomBarSource), "底部栏引了商城弹窗");
  check(/private mallDialog = new MallDialog\(\);/.test(bottomBarSource), "底部栏持有商城弹窗实例");
  check(/mall: \(\) => this\.mallDialog\.open\(\)/.test(bottomBarSource), "「商城」入口接线到弹窗（configs/bottomNav 的 mall 项）");

  // 弹窗里不写裸中文（文案全部走 configs/texts），也不写裸资源路径（图片走 uiImages）
  const mallCode = mallSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check(!/[\u4e00-\u9fa5]/.test(mallCode), "MallDialog 里没有裸中文（文案全部走 configs/texts）");
  check(!/"(mall|common|buttons)\//.test(mallCode), "MallDialog 里没有裸资源路径（图片走 configs 的 uiImages）");

  // 关键接线
  check(/getMallGoods\(\)/.test(mallSource), "商品表来自 configs/mall.getMallGoods");
  check(/StorageManager\.buyMallGood\(/.test(mallSource), "购买走数据层 StorageManager.buyMallGood");
  check(/mallDialogLayout/.test(mallSource), "几何全部取自 configs/hudLayout.mallDialogLayout");
  check(/getText\("label_mall_buy"\)/.test(mallSource), "购买按钮文案走 configs/texts");
  check(/getText\("mall_price_note", \{ price: mallPrice \}\)/.test(mallSource), "统一价说明由配置价格填充（界面不写死 1）");
  check(/createGoodDetailDialog/.test(mallSource), "悬停图标看详情（复用统一详情零件）");
  check(/closeDetail\(\)/.test(mallSource), "有统一的详情收框入口（滚动/换悬停/关弹窗都收）");
  check(/anchor\.once\(Node\.EventType\.NODE_DESTROYED, \(\) => this\.closeDetail\(\), this\);/.test(mallSource), "图标被销毁也收详情（否则会永久留在屏幕上）");

  // 虚拟化：滚动时只激活视口附近的行
  check(/ScrollView\.EventType\.SCROLLING/.test(mallSource), "监听滚动事件（虚拟化按滚动位置重算可见区间）");
  check(/row\.active = index >= first && index <= last;/.test(mallSource), "只激活可见区间内的行（几百件商品不会全部参与渲染与命中）");
  check(/contentLayout\.type = Layout\.Type\.NONE;/.test(mallSource), "关掉列表自动排版（行随激活开关增减，交给 Layout 会整列塌缩）");
  check(/setContentSize\(layout\.list\.size\.width, goods\.length \* pitch\)/.test(mallSource), "内容高度按商品数与行距显式设置（ScrollView 才有滚动范围）");
  check(/trackUiPress\(icon\)/.test(mallSource), "悬停图标登记了按压起点（见 utils/input/Pointer）");

  // 文案 key
  ["mall_buy_success_tip", "mall_gold_not_enough_tip", "mall_good_missing_tip", "label_mall_buy", "mall_price_note"].forEach((key) =>
    check(new RegExp(`^\\s*${key}:`, "m").test(textsSource), `configs/texts 登记了${key}`),
  );

  // 布局配置块
  {
    const start = dialogsSource.indexOf("export const mallDialogLayout");
    const end = dialogsSource.indexOf("//#endregion", start);
    const block = dialogsSource.slice(start, end > start ? end : undefined);
    check(start > 0, "能定位 mallDialogLayout 配置块");
    ["background", "size", "titleStyle", "closeButton", "priceNote", "bindGold", "list", "row", "virtualBuffer"].forEach((key) =>
      check(new RegExp(`${key}:`).test(block), `mallDialogLayout 配了 ${key}`),
    );
    check(/row: \{[\s\S]{0,400}iconSize: new Size\(28, 28\)/.test(block), "商品行的图标尺寸在配置里");
    check(/buyButton: \{ size: new Size\(56, 24\), fontSize: 12 \}/.test(block), "购买按钮（小号）几何在配置里");
  }
  check(/mallBackground: mallImage\("bg"\)/.test(imagesSource), "商城背景图登记在 uiImages（resources/mall/bg）");
  check(/export const mallImage = \(name: string\) => `mall\/\$\{name\}`;/.test(imagesSource), "取图函数与目录收敛在 layout/images");
  check(fs.existsSync(path.join(PROJECT_ROOT, "assets/resources/mall/bg.png")), "商城背景图素材存在（resources/mall/bg.png）");
  check(fs.existsSync(path.join(PROJECT_ROOT, "assets/configs/mall.ts.meta")) && fs.existsSync(path.join(PROJECT_ROOT, "assets/ui/components/dialogs/MallDialog.ts.meta")), "新增的 .ts 都带 .meta（进 Cocos 工程的前提）");

  //#endregion

  finish("PASS: 商城商品表、价格、购买链路与界面接线全部通过");
}
