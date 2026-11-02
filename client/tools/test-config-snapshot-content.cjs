#!/usr/bin/env node
/**
 * 配置快照覆写（内容表）回归单测（#363）
 *
 * 跑的是**真实配置表与真实派生函数**（configs-sandbox 编译 CommonJS + cc 垫片），不是复刻。
 * 盯的五条口径：
 * · 数据覆写生效 —— 文案 / 价格 / 数值 / 回复量都换成服务端的
 * · 图标跟快照走 —— 装备 / 药品 / 材料的图标在服务端表里（客户端拼不出 `item/fs_2` 这类路径），
 *   而几何 / 时装资源（in / out）仍以发布素材包为准，不覆写
 * · 整表重建 —— 快照里没有的 id 客户端就不该有（#603 第九 / 十域，客户端没有出厂行）
 * · 装备变体重算 —— 只下发 37 个基础件，555 个变体按前后缀倍率重新展开
 * · 幂等 —— 同一份快照覆写两次结果一致（不能一代代滚雪球）
 *
 * 用法：node client/tools/test-config-snapshot-content.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

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

function main() {
  let outDir;
  try {
    outDir = prepare("olua-snapshot-content", ["configs/apply-snapshot.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const { items, getItem } = require(path.join(outDir, "configs/items.js"));
  const { drugs } = require(path.join(outDir, "configs/drug.js"));
  const { materials } = require(path.join(outDir, "configs/material.js"));
  const { monsterRuntime, monsterResource, applyMonsterPresentation, applyMonsterRuntimeStats } = require(path.join(outDir, "configs/monsterRuntime.js"));
  const { npcs } = require(path.join(outDir, "configs/npc.js"));
  const { fashionData } = require(path.join(outDir, "configs/fashionClothes.js"));
  const { equipmentPrefixRates, equipmentSuffixRates } = require(path.join(outDir, "configs/growth.js"));
  const snapshotApi = require(path.join(outDir, "configs/apply-snapshot.js"));

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
    icon: "clothes/icon/test",
    inAtlas: "clothes/in/test",
    outAtlas: "clothes/out/test",
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
  snapshotApi.applyConfigSnapshot({ equipments: [equipmentRow] });
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
    baseAfter.icon === "clothes/icon/test" && baseAfter.in === "clothes/in/test" && baseAfter.out === "clothes/out/test",
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

  console.log("\n=== 药品：整表重建 + 扁平四值还原成 effects（#603 第十域） ===");
  const drugBefore = drugs.find((drug) => drug.id === "drug_hp_1");
  check(drugs.length === 8, "快照到达前药品表有 8 种（沙箱按线上同一条路灌了种子）", `size=${drugs.length}`);
  snapshotApi.applyConfigSnapshot({
    drugs: [
      { id: "drug_hp_1", label: "测试金创药", description: "测试描述", icon: "item/fs_9", level: 1, sellPrice: 88, maxStack: 50, cooldown: 3, effectHp: 1234, effectMp: 0, effectHpPercent: 0, effectMpPercent: 25, updatedAt: 0 },
    ],
  });
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
  snapshotApi.applyConfigSnapshot({
    items: [{ id: "material_hide", type: "material", label: "测试兽皮", description: "测试材料", icon: "item/2010211", level: 1, sellPrice: 66, maxStack: 20, updatedAt: 0 }],
  });
  const materialAfter = getItem("material_hide");
  check(materialAfter.label === "测试兽皮" && materialAfter.description === "测试材料", "名称与描述已覆写", materialAfter.label);
  check(materialAfter.sellPirce === 66 && materialAfter.maxStack === 20, "价格与叠加上限已覆写", `${materialAfter.sellPirce} / ${materialAfter.maxStack}`);
  check(materialAfter.icon === "item/2010211", "图标跟快照走", materialAfter.icon);
  check(materialAfter.type === "material", "大类取快照原值（枚举），不再写死", String(materialAfter.type));
  check(materialBefore !== materialAfter, "重建换的是新对象（不再原地覆写）", "ok");
  check(getItem("material_iron") === null, "快照里没有的材料客户端就没有（整表重建）", "ok");

  console.log("\n=== 怪物：数值落运行时表 + 资源落运行时表（#588：客户端没有怪物数据文件） ===");
  // 资源行先落（真实路径：applyMonsterPresentation，几何/速度在落表时合成）
  applyMonsterPresentation("1", { icon: "monster/icon/1_00000", out: "monster/out/1", outOffset: { x: -2, y: -2 }, contentSize: { width: 44, height: 49 }, moveSpeed: 2, aggressive: false, detectRange: 200, speedRate: { stand: 2 } });
  const resourceAfter = monsterResource.get("1");
  check(resourceAfter && resourceAfter.out === "monster/out/1" && resourceAfter.contentSize.width === 44, "资源与表现已落运行时表", resourceAfter && `${resourceAfter.out} / ${resourceAfter.contentSize.width}×${resourceAfter.contentSize.height}`);
  check(resourceAfter.speedRate.stand === 2 && resourceAfter.speedRate.walk === 1, "speedRate 快照覆盖与默认表在落表时合成", `${resourceAfter.speedRate.stand} / ${resourceAfter.speedRate.walk}`);
  snapshotApi.applyConfigSnapshot({
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
  });
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
  check(npcs.size === 0, "快照到达前 NPC 表为空（客户端没有本地兜底）", `size=${npcs.size}`);
  snapshotApi.applyConfigSnapshot({
    npcs: [
      { id: "0002", label: "测试传送官", dialog: "你好", src: "npc/npc_9999", scaleX: 1.5, scaleY: 1.5, posX: 11, posY: 0, updatedAt: 0 },
      { id: "1001", label: "神装使者", dialog: "", src: "npc/npc_2108", scaleX: 1, scaleY: 1, posX: 0, posY: 0, updatedAt: 0 },
    ],
  });
  const npcAfter = npcs.get("0002");
  check(npcAfter && npcAfter.label === "测试传送官", "NPC 名称取快照", npcAfter && npcAfter.label);
  check(npcAfter && npcAfter.src === "npc/npc_9999", "素材目录取快照（客户端没有 src 兜底）", npcAfter && npcAfter.src);
  check(npcAfter && npcAfter.scale.x === 1.5 && npcAfter.scale.y === 1.5, "缩放取快照", npcAfter && JSON.stringify(npcAfter.scale));
  check(npcAfter && npcAfter.position.x === 11 && npcAfter.position.y === 0, "偏移取快照", npcAfter && JSON.stringify(npcAfter.position));
  check(npcs.size === 2, "整表重建：快照里没有的 NPC 不会残留", `size=${npcs.size}`);
  check(typeof (npcAfter && npcAfter.onClick) === "function", "点击行为按 id 延迟接线（npcClicks 注册表）", typeof (npcAfter && npcAfter.onClick));

  console.log("\n=== 时装：只覆写文案与数值 ===");

  const fashionBefore = fashionData.find((fashion) => fashion.id === "cloth_2");
  snapshotApi.applyConfigSnapshot({
    fashions: [
      {
        id: "cloth_2",
        label: "测试时装",
        description: "测试时装描述",
        icon: "clothes/icon/999",
        inRes: "clothes/in/999",
        outRes: "clothes/out/999",
        sellPrice: 4321,
        acquireChannel: "upgrade",
        attributes: attributes(500, 0, 40, 10),
        updatedAt: 0,
      },
    ],
  });
  const fashionAfter = fashionData.find((fashion) => fashion.id === "cloth_2");
  check(fashionAfter.label === "测试时装" && fashionAfter.description === "测试时装描述", "名称与描述已覆写", fashionAfter.label);
  check(fashionAfter.sellPrice === 4321, "售价已覆写", String(fashionAfter.sellPrice));
  check(fashionAfter.attributes.maxHp === 500 && fashionAfter.attributes.physicalAttack[1] === 40, "八项属性已覆写", JSON.stringify(fashionAfter.attributes));
  check(
    fashionAfter.icon === fashionBefore.icon && fashionAfter.in === fashionBefore.in && fashionAfter.out === fashionBefore.out,
    "时装的 icon / in / out 一律不动（服务端那份只是 seed 镜像）",
    `${fashionAfter.icon} / ${fashionAfter.in}`,
  );

  console.log("\n=== 幂等与兜底 ===");
  const monsterRow = { id: "1", label: "测试怪", tier: "normal", level: 33, maxHp: 54321, attributes: { physicalAttack: { min: 11, max: 22 }, magicAttack: { min: 0, max: 0 }, taoistAttack: { min: 0, max: 0 }, physicalDefense: { min: 3, max: 6 }, magicDefense: { min: 3, max: 6 }, taoistDefense: { min: 3, max: 6 } } };
  const once = JSON.stringify([getItem("cloth_1"), getItem(variantId), monsterRuntime.get("1")]);
  snapshotApi.applyConfigSnapshot({
    equipments: [equipmentRow],
    monsters: [monsterRow],
  });
  const twice = JSON.stringify([getItem("cloth_1"), getItem(variantId), monsterRuntime.get("1")]);
  check(once === twice, "同一份快照覆写两次结果一致（变体不会一代代乘倍率）");

  const hpBeforeEmpty = getItem("cloth_1").maxHp;
  snapshotApi.applyConfigSnapshot({});
  check(getItem("cloth_1").maxHp === hpBeforeEmpty, "空快照保留当前值（旧服务端不炸）");
  // #603 第九域起装备也是整表重建：快照里只有一件「不存在的装备」→ 旧的 555 件全部消失。
  // 这是设计口径（客户端没有出厂行），不是 bug —— 顺便证明「下架一件装备」真的会少一件。
  snapshotApi.applyConfigSnapshot({
    equipments: [{ id: "不存在的装备", attributes: attributes(1, 0, 1, 1), level: 1, label: "x", sellPrice: 0, slot: "cloth" }],
  });
  check(getItem("cloth_1") === null, "装备整表重建（快照里没有的客户端就没有）", "ok");
  check(
    items.size === 15 + drugs.length + materials.length,
    "物品总表条数 = 装备变体 + 药品 + 材料（三张表重建后自洽）",
    `${items.size} = 15 + ${drugs.length} + ${materials.length}`,
  );

  finish("配置快照内容表：全部断言通过");
}

main();
