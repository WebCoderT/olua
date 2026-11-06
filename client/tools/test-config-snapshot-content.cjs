#!/usr/bin/env node
/**
 * 配置快照覆写（内容表）回归单测（#363）
 *
 * 跑的是**真实配置表与真实派生函数**（configs-sandbox 编译 CommonJS + cc 垫片），不是复刻。
 * 盯的五条口径：
 * · 数据覆写生效 —— 文案 / 价格 / 数值 / 回复量都换成服务端的
 * · 图标跟快照走 —— 装备 / 药品 / 材料的图标在服务端表里（客户端拼不出 `item/drug-hp-1` 这类路径），
 *   而几何 / 时装资源（in / out）仍以发布素材包为准，不覆写
 * · 整表重建 —— 快照里没有的 id 客户端就不该有（#603 第九 / 十域，客户端没有出厂行）
 * · 装备变体重算 —— 只下发 37 个基础件，555 个变体按前后缀倍率重新展开
 * · 幂等 —— 同一份快照覆写两次结果一致（不能一代代滚雪球）
 *
 * 用法：node client/tools/test-config-snapshot-content.cjs
 */
const fs = require("fs");
const path = require("path");
const { PROJECT_ROOT, prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");
/** #655 起配置的唯一来源是数据库快照（server/data/config-sync.sql） */
const factory = require("./lib/factory-data.cjs");

/** 构造服务端的八项属性（区间是 {min,max} 对象，客户端用元组） */
const attributes = (maxHp, hpRecover, attack, defense) => ({
  maxHp,
  hpRecover,
  physicalAttack: { min: attack, max: attack },
  magicAttack: { min: 0, max: 0 },
  taoistAttack: { min: 0, max: 0 },
  physicalDefense: { min: defense, max: defense },
  magicDefense: { min: defense, max: defense },
  taoistDefense: { min: defense, max: defense },
});

/**
 * #604 起 `applyConfigSnapshot` 是**显式契约**：缺段直接抛，不再「缺段跳过」。
 * 单测要验的是某一段的落库口径，所以改用分段入口（`applyContentSnapshot` / `applySkillSnapshot`），
 * 由下面两个助手补齐该入口必需的段 —— 别在测试里喂「半份快照」，那正是 #604 要禁止的用法。
 */
const contentSnapshot = (over = {}) => ({
  equipments: [],
  drugs: [],
  items: [],
  monsters: [],
  monsterPresentations: [],
  npcs: [],
  quests: [],
  fashions: [],
  ...over,
});
const skillSnapshot = (over = {}) => ({ skills: [], statuses: [], ...over });

function main() {
  let outDir;
  try {
    outDir = prepare("olua-snapshot-content", ["configs/apply-snapshot.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const { items, getItem } = require(path.join(outDir, "configs/items.js"));
  const { drugs } = require(path.join(outDir, "configs/game-config.js"));
  const { materials } = require(path.join(outDir, "configs/game-config.js"));
  const { monsterRuntime, monsterResource, applyMonsterPresentation, applyMonsterRuntimeStats } = require(path.join(outDir, "configs/game-config.js"));
  const { npcs } = require(path.join(outDir, "configs/game-config.js"));
  const { fashionData } = require(path.join(outDir, "configs/game-config.js"));
  const { equipmentPrefixRates, equipmentSuffixRates } = require(path.join(outDir, "configs/game-config.js"));
  const snapshotApi = require(path.join(outDir, "configs/apply-snapshot.js"));

  // 沙箱的「快照到达前」状态：客户端自身零出厂行，表是 hydrateSnapshotTables 按服务端种子灌的。
  // **必须在任何 apply* 之前断言** —— 分段入口是整表重建，后跑的分段会把别的表清空。
  console.log("\n=== 快照到达前的表（沙箱按线上同一条路灌种子）===");
  check(drugs.length === 11, "药品表 11 种（#603 第十域：数据在 item-seed；金创药 5 档 + 魔法药 3 档 + 太阳水 + 两种百分比药）", `size=${drugs.length}`);
  check(fashionData.length === 20, "时装表 20 套（#603 第十二域：数据在 fashion-seed）", String(fashionData.length));
  // #655：沙箱里这张表由快照灌满（线上也是同一条 apply* 链），所以判据从「空」改成「行数 = 快照行数」；
  // 「客户端没有本地兜底」由源码断言守（game-config.ts 里 npcs 以空 Map 起）
  check(npcs.size === factory.npcs().length, "NPC 表行数 = 快照行数（客户端自身零出厂行）", `size=${npcs.size}`);

  console.log("\n=== 装备：只下发基础件，变体按倍率重算 ===");
  const baseBefore = getItem("cloth_1");
  const variantId = "cloth_1_p4s2";
  const variantBefore = getItem(variantId);
  // 基础件（普通的·人级）属性 1000/5/100/20；变体 p4s2 = ×1.4 × 3 = ×4.2
  // #603 第九域：客户端 `configs/equipments` 已经没有装备数据，显示字段也在快照里 ——
  // 这张假行必须带齐（少了就等于「运营把图标清空了」）
  const equipmentRow = {
    id: "cloth_1",
    slot: "cloth",
    level: 12,
    sellPrice: 777,
    label: "测试衣服",
    description: "测试描述",
    occupation: "4",
    sex: "3",
    icon: "equipment/clothes/icon/test",
    inAtlas: "equipment/clothes/in/test",
    outAtlas: "equipment/clothes/out/test",
    tags: ["测试"],
    outScale: 1.5,
    inScaleX: 1.2,
    inScaleY: 1.1,
    inRotate: 0,
    inPosX: 10,
    inPosY: 20,
    outPositions: Array.from({ length: 8 }, (_, index) => ({ x: 1 + index, y: 2 })),
    attributes: attributes(1000, 5, 100, 20),
    updatedAt: 0,
  };
  snapshotApi.applyContentSnapshot(contentSnapshot({ equipments: [equipmentRow] }));
  const baseAfter = getItem("cloth_1");
  const variantAfter = getItem(variantId);
  const rate = equipmentPrefixRates[4] * equipmentSuffixRates[2];
  check(baseAfter.maxHp === 1000, "基础件 maxHp 直接取服务端值（倍率 1×1）", `${baseBefore.maxHp} → ${baseAfter.maxHp}`);
  check(baseAfter.hpRecover === 5, "基础件回血同样取服务端值", `${baseAfter.hpRecover}`);
  check(
    variantAfter.maxHp === Math.round(1000 * rate),
    "变体 p4s2 的属性 = 服务端基础值 × 4.2（不是在上一次结果上再乘）",
    `${variantBefore.maxHp} → ${variantAfter.maxHp}（rate=${rate}）`,
  );
  check(
    variantAfter.physicalAttack[0] === Math.round(100 * rate) && variantAfter.physicalAttack[1] === Math.round(100 * rate),
    "变体攻击区间两端同时缩放",
    JSON.stringify(variantAfter.physicalAttack),
  );
  check(baseAfter.label === "测试衣服" && baseAfter.level === 12, "基础件名称与等级跟着服务端走", `${baseAfter.label} / ${baseAfter.level}`);
  check(variantAfter.label === "测试衣服", "变体共用同一份文案（基础件与变体共享对象）", variantAfter.label);
  check(variantAfter.sellPirce === 777, "售卖价按服务端值（客户端字段名是 sellPirce）", String(variantAfter.sellPirce));
  check(
    baseAfter.icon === "equipment/clothes/icon/test" && baseAfter.in === "equipment/clothes/in/test" && baseAfter.out === "equipment/clothes/out/test",
    "图标 / 内观 / 外观图集跟着快照走（#603 第九域起资源路径归服务端）",
    `${baseBefore.icon} → ${baseAfter.icon}`,
  );
  check(baseAfter.tags.length === 1 && baseAfter.outScale === 1.5, "标签与外观缩放跟着快照走", `${baseAfter.tags} / ${baseAfter.outScale}`);
  check(
    baseAfter.outPositions.length === 8 && baseAfter.outPositions[0].x === 1 && baseAfter.inPosition.x === 10,
    "8 向位置与内观锚点转成 Vec2 落表（数量与逐项数值都要对）",
    `${baseAfter.outPositions.length} 向 / in.x=${baseAfter.inPosition.x}`,
  );
  check(
    variantAfter.recyclePrice === Math.round(baseAfter.recyclePrice * rate) && variantAfter.recyclePrice > baseAfter.recyclePrice,
    "回收价按「服务端等级 × 倍率」重算（变体比基础件贵）",
    `${baseAfter.recyclePrice} / ${variantAfter.recyclePrice}`,
  );

  // #655：服务端下发的是**展开后的变体行**（自带 prefix / suffix / 最终价），
  // 客户端必须原样建表 —— 再乘一次倍率就会变成 4.2² 倍，这是最容易踩的回归
  console.log("\n=== 装备变体行：数值是最终值，客户端不再乘倍率（#655） ===");
  const variantRow = {
    ...equipmentRow,
    id: "cloth_1_p4s2",
    sellPrice: 4321,
    level: 12,
    prefix: 4,
    suffix: 2,
    attributes: attributes(4321, 21, 420, 84),
    updatedAt: 0,
  };
  snapshotApi.applyContentSnapshot(contentSnapshot({ equipments: [variantRow] }));
  const directVariant = getItem("cloth_1_p4s2");
  check(!!directVariant, "变体行能按 id 建进装备表", String(Boolean(directVariant)));
  check(
    directVariant.maxHp === 4321,
    "变体 maxHp = 服务端行原值（不再 × 前后缀倍率）",
    `${directVariant.maxHp}（若被再乘一次会变成 ${Math.round(4321 * rate)}）`,
  );
  check(
    directVariant.physicalAttack[0] === 420 && directVariant.recyclePrice === 4321,
    "变体攻击区间与回收价同样原样落地",
    `${JSON.stringify(directVariant.physicalAttack)} / ${directVariant.recyclePrice}`,
  );
  check(
    directVariant.prefix === 4 && directVariant.suffix === 2,
    "前后缀序号取自服务端行（详情弹窗按它取品质文案与颜色）",
    `${directVariant.prefix}/${directVariant.suffix}`,
  );

  console.log("\n=== 药品：整表重建 + 扁平四值还原成 effects（#603 第十域） ===");
  const drugBefore = drugs.find((drug) => drug.id === "drug_hp_1");
  // 「到达前有 11 种」已在文件开头断言（分段入口会整表重建，这里再判就没意义了）
  snapshotApi.applyContentSnapshot(
    contentSnapshot({
      drugs: [
        { id: "drug_hp_1", label: "测试金创药", description: "测试描述", icon: "item/fs_9", level: 1, sellPrice: 88, maxStack: 50, cooldown: 3, effectHp: 1234, effectMp: 0, effectHpPercent: 0, effectMpPercent: 25, updatedAt: 0 },
      ],
    }),
  );
  const drugAfter = drugs.find((drug) => drug.id === "drug_hp_1");
  check(drugAfter.label === "测试金创药" && drugAfter.sellPirce === 88, "文案与售价已覆写", `${drugAfter.label} / ${drugAfter.sellPirce}`);
  check(drugAfter.maxStack === 50 && drugAfter.cooldown === 3, "叠加上限与冷却已覆写", `${drugAfter.maxStack} / ${drugAfter.cooldown}`);
  check(
    drugAfter.effects.length === 1 && drugAfter.effects[0].hp === 1234 && drugAfter.effects[0].mpPercent === 25,
    "固定值与百分比合并进同一条效果",
    JSON.stringify(drugAfter.effects),
  );
  check(drugAfter.effects[0].mp === undefined, "管理端填 0 的效果不写进数组（0 = 没有该效果）", JSON.stringify(drugAfter.effects[0]));
  check(drugAfter.icon === "item/fs_9", "图标跟快照走（客户端不再自带图标）", drugAfter.icon);
  // 整表重建：快照里只有一种药 → 客户端就只剩这一种（管理端下架会如实反映）
  check(drugs.length === 1, "整表重建（客户端没有出厂行可兜底）", `size=${drugs.length}`);
  check(items.get("drug_hp_1") === drugAfter, "物品总表指向重建后的同一个对象（索引已重建）", "ok");
  check(drugBefore !== drugAfter, "重建换的是新对象（不再原地覆写）", "ok");

  console.log("\n=== 物品与材料：整表重建（#603 第十域） ===");
  const materialBefore = getItem("material_hide");
  snapshotApi.applyContentSnapshot(
    contentSnapshot({
      items: [{ id: "material_hide", type: "material", label: "测试兽皮", description: "测试材料", icon: "item/2010211", level: 1, sellPrice: 66, maxStack: 20, updatedAt: 0 }],
    }),
  );
  const materialAfter = getItem("material_hide");
  check(materialAfter.label === "测试兽皮" && materialAfter.description === "测试材料", "名称与描述已覆写", materialAfter.label);
  check(materialAfter.sellPirce === 66 && materialAfter.maxStack === 20, "价格与叠加上限已覆写", `${materialAfter.sellPirce} / ${materialAfter.maxStack}`);
  check(materialAfter.icon === "item/2010211", "图标跟快照走", materialAfter.icon);
  check(materialAfter.type === "material", "大类取快照原值（枚举），不再写死", String(materialAfter.type));
  check(materialBefore !== materialAfter, "重建换的是新对象（不再原地覆写）", "ok");
  check(getItem("material_iron") === null, "快照里没有的材料客户端就没有（整表重建）", "ok");

  console.log("\n=== 怪物：数值落运行时表 + 资源落运行时表（#588：客户端没有怪物数据文件） ===");
  // 资源行先落（真实路径：applyMonsterPresentation，几何/速度在落表时合成）
  applyMonsterPresentation("1", { icon: "monster/icon/1", out: "monster/out/1", outOffset: { x: -2, y: -2 }, contentSize: { width: 44, height: 49 }, moveSpeed: 2, aggressive: false, detectRange: 200, speedRate: { stand: 2 } });
  const resourceAfter = monsterResource.get("1");
  check(resourceAfter && resourceAfter.out === "monster/out/1" && resourceAfter.contentSize.width === 44, "资源与表现已落运行时表", resourceAfter && `${resourceAfter.out} / ${resourceAfter.contentSize.width}×${resourceAfter.contentSize.height}`);
  check(resourceAfter.speedRate.stand === 2 && resourceAfter.speedRate.walk === 1, "speedRate 快照覆盖与默认表在落表时合成", `${resourceAfter.speedRate.stand} / ${resourceAfter.speedRate.walk}`);
  snapshotApi.applyContentSnapshot(
    contentSnapshot({
      monsters: [
        {
          id: "1",
          label: "测试怪",
          tier: "normal",
          level: 33,
          maxHp: 54321,
          attributes: {
            physicalAttack: { min: 11, max: 22 },
            magicAttack: { min: 0, max: 0 },
            taoistAttack: { min: 0, max: 0 },
            physicalDefense: { min: 3, max: 6 },
            magicDefense: { min: 3, max: 6 },
            taoistDefense: { min: 3, max: 6 },
          },
        },
      ],
    }),
  );
  const monsterAfter = monsterRuntime.get("1");
  check(monsterAfter && monsterAfter.label === "测试怪" && monsterAfter.level === 33, "数值落运行时表（名称 / 等级）", monsterAfter && `${monsterAfter.label} / ${monsterAfter.level}`);
  check(monsterAfter.maxHp === 54321, "生命取服务端展开值（不按曲线重算）", String(monsterAfter.maxHp));
  check(
    monsterAfter.physicalAttack[0] === 11 && monsterAfter.physicalAttack[1] === 22,
    "区间对象转成元组",
    JSON.stringify(monsterAfter.physicalAttack),
  );
  check(resourceAfter === monsterResource.get("1") && resourceAfter.out === "monster/out/1", "数值落表不碰资源（两半分开，各自整段替换）", resourceAfter.out);

  console.log("\n=== NPC：整表重建（客户端不再存任何 NPC 数据）===");
  // 「到达前 NPC 表为空」已在文件开头断言
  snapshotApi.applyContentSnapshot(
    contentSnapshot({
      npcs: [
        { id: "0002", label: "测试传送官", dialog: "你好", src: "npc/9999", scaleX: 1.5, scaleY: 1.5, posX: 11, posY: 0, updatedAt: 0 },
        { id: "1001", label: "神装使者", dialog: "", src: "npc/2108", scaleX: 1, scaleY: 1, posX: 0, posY: 0, updatedAt: 0 },
      ],
    }),
  );
  const npcAfter = npcs.get("0002");
  check(npcAfter && npcAfter.label === "测试传送官", "NPC 名称取快照", npcAfter && npcAfter.label);
  check(npcAfter && npcAfter.src === "npc/9999", "素材目录取快照（客户端没有 src 兜底）", npcAfter && npcAfter.src);
  check(npcAfter && npcAfter.scale.x === 1.5 && npcAfter.scale.y === 1.5, "缩放取快照", npcAfter && JSON.stringify(npcAfter.scale));
  check(npcAfter && npcAfter.position.x === 11 && npcAfter.position.y === 0, "偏移取快照", npcAfter && JSON.stringify(npcAfter.position));
  check(npcs.size === 2, "整表重建：快照里没有的 NPC 不会残留", `size=${npcs.size}`);
  check(typeof (npcAfter && npcAfter.onClick) === "function", "点击行为按 id 延迟接线（npcClicks 注册表）", typeof (npcAfter && npcAfter.onClick));

  console.log("\n=== 时装：整表重建（资源路径也取快照）===");

  // 「沙箱已灌 20 套」已在文件开头断言
  snapshotApi.applyContentSnapshot(
    contentSnapshot({
      fashions: [
        {
          id: "cloth_2",
          label: "测试时装",
          description: "测试时装描述",
          icon: "equipment/clothes/icon/999",
          inRes: "equipment/clothes/in/999",
          outRes: "equipment/clothes/out/999",
          sellPrice: 4321,
          acquireChannel: "upgrade",
          attributes: attributes(500, 0, 40, 10),
          updatedAt: 0,
        },
      ],
    }),
  );
  const fashionAfter = fashionData.find((fashion) => fashion.id === "cloth_2");
  check(fashionData.length === 1, "整表重建：快照只给 1 行 → 衣柜里就只剩这 1 套", String(fashionData.length));
  check(fashionAfter.label === "测试时装" && fashionAfter.description === "测试时装描述", "名称与描述来自快照", fashionAfter.label);
  check(fashionAfter.sellPrice === 4321, "售价来自快照", String(fashionAfter.sellPrice));
  check(fashionAfter.attributes.maxHp === 500 && fashionAfter.attributes.physicalAttack[1] === 40, "八项属性来自快照（区间 {min,max} → 客户端元组）", JSON.stringify(fashionAfter.attributes));
  // 与地图那套相反：时装 id 与资源目录编号没有可推导的约定，路径只能跟着行走
  check(
    fashionAfter.icon === "equipment/clothes/icon/999" && fashionAfter.in === "equipment/clothes/in/999" && fashionAfter.out === "equipment/clothes/out/999",
    "icon / inRes / outRes 也取快照（路径不可按 id 推导，必须入库）",
    `${fashionAfter.icon} / ${fashionAfter.in}`,
  );
  check(fashionData.find((fashion) => fashion.id === "cloth_3") === undefined, "快照里没有的时装不会残留（下架如实反映）");

  console.log("\n=== 幂等 + 契约（#604：缺段不再静默跳过） ===");
  const monsterRow = { id: "1", label: "测试怪", tier: "normal", level: 33, maxHp: 54321, attributes: { physicalAttack: { min: 11, max: 22 }, magicAttack: { min: 0, max: 0 }, taoistAttack: { min: 0, max: 0 }, physicalDefense: { min: 3, max: 6 }, magicDefense: { min: 3, max: 6 }, taoistDefense: { min: 3, max: 6 } } };
  const idempotent = contentSnapshot({ equipments: [equipmentRow], monsters: [monsterRow] });
  snapshotApi.applyContentSnapshot(idempotent);
  const once = JSON.stringify([getItem("cloth_1"), getItem(variantId), monsterRuntime.get("1")]);
  snapshotApi.applyContentSnapshot(idempotent);
  const twice = JSON.stringify([getItem("cloth_1"), getItem(variantId), monsterRuntime.get("1")]);
  check(once === twice, "同一份快照覆写两次结果一致（变体不会一代代乘倍率）");

  // #604：空快照 = 契约破坏（服务端把整份 return 删了），必须当场抛错。
  // 以前这里是「保留当前值，旧服务端不炸」—— 那条兜底正是「改了没生效」类问题的温床。
  const hpBeforeEmpty = getItem("cloth_1").maxHp;
  let contractError = "";
  try {
    snapshotApi.applyConfigSnapshot({});
  } catch (error) {
    contractError = String((error && error.message) || error);
  }
  check(
    contractError.indexOf("skills") >= 0 && contractError.indexOf("技能配置") >= 0,
    "空快照直接抛错，错误里带 key 与中文名（服务端开发按 key 查、运营按中文名认）",
    contractError.slice(0, 70),
  );
  check(getItem("cloth_1").maxHp === hpBeforeEmpty, "先校验后落库：抛错时不会半途写坏表", `maxHp=${getItem("cloth_1").maxHp}`);

  // #603 第九域起装备也是整表重建：快照里只有一件「不存在的装备」→ 旧的 555 件全部消失。
  // 这是设计口径（客户端没有出厂行），不是 bug —— 顺便证明「下架一件装备」真的会少一件。
  snapshotApi.applyContentSnapshot(
    contentSnapshot({
      equipments: [{ id: "不存在的装备", attributes: attributes(1, 0, 1, 1), level: 1, label: "x", sellPrice: 0, slot: "cloth" }],
    }),
  );
  check(getItem("cloth_1") === null, "装备整表重建（快照里没有的客户端就没有）", "ok");
  check(
    items.size === 15 * 1 && drugs.length === 0 && materials.length === 0,
    "物品总表 = 装备变体 + 药品 + 材料（三张表同一份快照重建后自洽）",
    `items=${items.size} / drugs=${drugs.length} / materials=${materials.length}`,
  );

  //#region 运行时参数（#605）

  console.log("\n=== 运行时参数：掉落手感 / 自动战斗随快照覆写 ===");
  const { dropRuntime, applyDropRuntime } = require(path.join(outDir, "configs/drop.js"));
  const { autoBattle, applyAutoBattleParams } = require(path.join(outDir, "configs/autoBattle.js"));
  const dropRef = dropRuntime;
  const tuning = {
    drop: { autoPickupRadius: 72, scatterMinDistance: 60, pickReplyTimeout: 3000, fullTipInterval: 800 },
    autoBattle: { maxTargetDistance: 300, moveByRun: false, cellSize: 24, clearance: 12, repathInterval: 200 },
  };
  snapshotApi.applyRuntimeParams(tuning);
  check(dropRef === dropRuntime, "dropRuntime 对象引用不变（消费方持有的是同一个对象）");
  check(dropRuntime.autoPickupRadius === 72 && dropRuntime.scatterMinDistance === 60, "掉落半径 / 散落间距按快照覆写", JSON.stringify(dropRuntime));
  check(dropRuntime.pickReplyTimeout === 3000 && dropRuntime.fullTipInterval === 800, "拾取超时 / 满包间隔也覆写", JSON.stringify(dropRuntime));
  check(autoBattle.maxTargetDistance === 300 && autoBattle.cellSize === 24, "自动战斗距离与网格边长覆写", `dist=${autoBattle.maxTargetDistance} cell=${autoBattle.cellSize}`);
  check(autoBattle.moveByRun === false, "布尔开关（移动用跑步）也能覆写");
  check(autoBattle.stuckRetryLimit === 0 && autoBattle.dashSnapRadius === 0, "快照里没给的键保持当前值（#724 无出厂值，初始 0 = 快照没给）", `retry=${autoBattle.stuckRetryLimit}`);
  check(autoBattle.routeLine && autoBattle.routeLine.dotRadius === 3, "样式参数（routeLine）不受快照影响 —— 它不在下发范围");

  // 坏值守卫：0 是合法值（关闭半径 / 关闭节流），负数与非数字一律保持当前值
  applyDropRuntime({ autoPickupRadius: -5, scatterMinDistance: Number.NaN });
  check(dropRuntime.autoPickupRadius === 72 && dropRuntime.scatterMinDistance === 60, "负数 / 非数字不覆盖（坏配置不会把半径变成 0 或 NaN）", JSON.stringify(dropRuntime));
  applyDropRuntime({ autoPickupRadius: 0 });
  check(dropRuntime.autoPickupRadius === 0, "0 是合法值（可以作为「关闭自动拾取」用）");
  applyAutoBattleParams({ cellSize: 0, stuckRetryLimit: 0 });
  check(autoBattle.cellSize === 24 && autoBattle.stuckRetryLimit === 0, "网格边长有下限 1（0 会让寻路失去意义），没配过的键保持 0", `cell=${autoBattle.cellSize}`);

  //#endregion

  //#region 新手引导步骤（#605）

  console.log("\n=== 新手引导步骤：整表替换 / 坏行跳过 / 空表 = 关闭 ===");
  const guideConfig = require(path.join(outDir, "configs/guide.js"));
  check(guideConfig.guideStepCount() === 0 || guideConfig.guideSteps.length >= 0, "引导步骤表可读（快照到达前为空表是正常状态）");
  // 接线：整份快照的落库结尾必须调它（这段守「忘了接」—— 表在服务端，忘了接就等于引导永远关着）
  check(
    /applyGuideSteps\(snapshot\.guideSteps\)/.test(fs.readFileSync(path.join(PROJECT_ROOT, "assets/configs/apply-snapshot.ts"), "utf8")),
    "applyConfigSnapshot 结尾接了 applyGuideSteps(snapshot.guideSteps)",
  );
  guideConfig.applyGuideSteps([
    { id: "move", title: "先动起来", desc: "拖摇杆走两步。", spot: "joystick", trigger: "move" },
    { id: "fight", title: "打一只怪", desc: "点技能出手。", spot: "shortcut", trigger: "kill" },
  ]);
  check(guideConfig.guideStepCount() === 2, "整表替换：快照给两步就是两步", String(guideConfig.guideStepCount()));
  check(guideConfig.guideStepAt(0).id === "move" && guideConfig.guideStepAt(1).trigger === "kill", "顺序即体验顺序（数组下标 = 第几步）");
  check(guideConfig.guideStepAt(2) === null, "越界返回 null（调用方据此判定「走完了」）");

  guideConfig.applyGuideSteps([
    { id: "ok", title: "好人", desc: "合法", spot: "joystick", trigger: "move" },
    { id: "badSpot", title: "坏高亮", desc: "客户端不认识这个高亮位", spot: "nav:unknown", trigger: "move" },
    { id: "badEvent", title: "坏事件", desc: "客户端不认识这个推进事件", spot: "joystick", trigger: "teleport" },
    { id: "ok", title: "重复", desc: "标识撞了", spot: "joystick", trigger: "move" },
  ]);
  check(guideConfig.guideStepCount() === 1, "坏行跳过（未知高亮位 / 未知事件 / 重复标识），好行留下 —— 少一步不影响玩，卡住才致命", String(guideConfig.guideStepCount()));

  guideConfig.applyGuideSteps([]);
  check(guideConfig.guideStepCount() === 0, "空数组 = 服务端把引导关了（步数 0，进度按已完成处理）");

  //#endregion

  finish("配置快照内容表：全部断言通过");
}

main();
