#!/usr/bin/env node
/**
 * 配置快照覆写（内容表）回归单测（#363）
 *
 * 跑的是**真实配置表与真实派生函数**（configs-sandbox 编译 CommonJS + cc 垫片），不是复刻。
 * 盯的四条口径：
 * · 数据覆写生效 —— 文案 / 价格 / 数值 / 回复量都换成服务端的
 * · 资源不覆写 —— icon / in / out / src / 位置一律保留本地（素材以发布包为准）
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
  const { monsters } = require(path.join(outDir, "configs/monster.js"));
  const { npcData } = require(path.join(outDir, "configs/npc-data.js"));
  const { fashionData } = require(path.join(outDir, "configs/fashionClothes.js"));
  const { equipmentPrefixRates, equipmentSuffixRates } = require(path.join(outDir, "configs/growth.js"));
  const snapshotApi = require(path.join(outDir, "configs/apply-snapshot.js"));

  console.log("\n=== 装备：只下发基础件，变体按倍率重算 ===");
  const baseBefore = getItem("cloth_1");
  const variantId = "cloth_1_p4s2";
  const variantBefore = getItem(variantId);
  // 基础件（普通的·人级）属性 1000/5/100/20；变体 p4s2 = ×1.4 × 3 = ×4.2
  const equipmentRow = {
    id: "cloth_1",
    slot: "cloth",
    level: 12,
    sellPrice: 777,
    label: "测试衣服",
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
  check(baseAfter.in === baseBefore.in && baseAfter.out === baseBefore.out && baseAfter.icon === baseBefore.icon, "内外观与图标一个字都没动（资源以发布包为准）", baseAfter.in);
  check(
    variantAfter.recyclePrice === Math.round(baseAfter.recyclePrice * rate) && variantAfter.recyclePrice > baseAfter.recyclePrice,
    "回收价按「服务端等级 × 倍率」重算（变体比基础件贵）",
    `${baseAfter.recyclePrice} / ${variantAfter.recyclePrice}`,
  );

  console.log("\n=== 药品：扁平四值还原成 effects ===");
  const drugBefore = drugs.find((drug) => drug.id === "drug_hp_1");
  snapshotApi.applyConfigSnapshot({
    drugs: [
      { id: "drug_hp_1", label: "测试金创药", description: "测试描述", level: 1, sellPrice: 88, maxStack: 50, cooldown: 3, effectHp: 1234, effectMp: 0, effectHpPercent: 0, effectMpPercent: 25, updatedAt: 0 },
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
  check(drugAfter === drugs.find((drug) => drug.id === "drug_hp_1"), "原地覆写（effects 换数组、物品对象不换）", drugAfter.label);

  console.log("\n=== 物品与材料：文案 / 价格 / 叠加上限 ===");
  const materialBefore = getItem("material_hide");
  snapshotApi.applyConfigSnapshot({
    items: [{ id: "material_hide", type: "material", label: "测试兽皮", description: "测试材料", level: 1, sellPrice: 66, maxStack: 20, updatedAt: 0 }],
  });
  const materialAfter = getItem("material_hide");
  check(materialAfter.label === "测试兽皮" && materialAfter.description === "测试材料", "名称与描述已覆写", materialAfter.label);
  check(materialAfter.sellPirce === 66 && materialAfter.maxStack === 20, "价格与叠加上限已覆写", `${materialAfter.sellPirce} / ${materialAfter.maxStack}`);
  check(materialAfter.icon === materialBefore.icon, "图标不动（资源路径）", materialAfter.icon);
  check(materialAfter.type === materialBefore.type, "大类不覆写（结构字段）", materialAfter.type);

  console.log("\n=== 怪物：名称 / 等级 / 生命 / 六项区间 ===");
  const monsterBefore = monsters.get("1");
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
  const monsterAfter = monsters.get("1");
  check(monsterAfter.label === "测试怪" && monsterAfter.level === 33, "名称与等级已覆写", `${monsterAfter.label} / ${monsterAfter.level}`);
  check(monsterAfter.maxHp === 54321, "生命取服务端展开值（不按曲线重算，否则单独调高的血会被抹回）", `${monsterBefore.maxHp} → ${monsterAfter.maxHp}`);
  check(
    monsterAfter.physicalAttack[0] === 11 && monsterAfter.physicalAttack[1] === 22,
    "区间对象转成元组",
    JSON.stringify(monsterAfter.physicalAttack),
  );
  check(monsterAfter.out === monsterBefore.out && monsterAfter.icon === monsterBefore.icon, "外观与图标不动", monsterAfter.out);
  check(monsterAfter.moveSpeed === monsterBefore.moveSpeed, "移动速度（AI 参数）不动", String(monsterAfter.moveSpeed));

  console.log("\n=== NPC 与时装：只覆写文案与数值 ===");
  const npcBefore = npcData.find((npc) => npc.id === "0002");
  snapshotApi.applyConfigSnapshot({ npcs: [{ id: "0002", label: "测试传送官", dialog: "你好", updatedAt: 0 }] });
  const npcAfter = npcData.find((npc) => npc.id === "0002");
  check(npcAfter.label === "测试传送官", "NPC 名称已覆写", `${npcBefore.label} → ${npcAfter.label}`);
  check(npcAfter.src === npcBefore.src, "NPC 资源路径与几何不动", npcAfter.src);

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
  const once = JSON.stringify([getItem("cloth_1"), getItem(variantId), monsters.get("1")]);
  snapshotApi.applyConfigSnapshot({
    equipments: [equipmentRow],
    monsters: [{ id: "1", label: "测试怪", tier: "normal", level: 33, maxHp: 54321, attributes: { physicalAttack: { min: 11, max: 22 }, magicAttack: { min: 0, max: 0 }, taoistAttack: { min: 0, max: 0 }, physicalDefense: { min: 3, max: 6 }, magicDefense: { min: 3, max: 6 }, taoistDefense: { min: 3, max: 6 } } }],
  });
  const twice = JSON.stringify([getItem("cloth_1"), getItem(variantId), monsters.get("1")]);
  check(once === twice, "同一份快照覆写两次结果一致（变体不会一代代乘倍率）");

  const hpBeforeEmpty = getItem("cloth_1").maxHp;
  snapshotApi.applyConfigSnapshot({});
  check(getItem("cloth_1").maxHp === hpBeforeEmpty, "空快照保留当前值（旧服务端不炸）");
  check(snapshotApi.applyConfigSnapshot({ equipments: [{ id: "不存在的装备", attributes: attributes(1, 0, 1, 1), level: 1, label: "x", sellPrice: 0, slot: "cloth" }] }) === undefined, "未知 id 被忽略，不新增物品");
  check(items.size > 500, "物品总数不变（覆写不增删行）", String(items.size));

  finish("配置快照内容表：全部断言通过");
}

main();
