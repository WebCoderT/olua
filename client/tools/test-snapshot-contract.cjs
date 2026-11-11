#!/usr/bin/env node
/**
 * 配置快照契约回归（#604）
 *
 * 盯的是「快照是不是唯一来源」这件事本身，不是某张表的内容：
 * · 完整快照 → 校验通过，且每段都真的落进了运行时表；
 * · 缺任意一段 → **抛错**并点名（key + 中文名），不再「缺段静默跳过、回落本地」；
 * · 形状不对（null / 对象当数组 / 数组当对象）→ 抛错；
 * · 关键段空表（levelCurves / equipmentSlots）→ 抛错；业务段空表（drugs / skills / quests…）**允许**
 *   —— 运营把一张表清空是合法数据状态，不是服务端 bug；
 * · 装备规则的倍率数组 → 空 / 非正数 / 与文案不同长都要报（#603 第九域踩过：倍率空了装备表全空还不报错）；
 * · 先校验后落库 → 抛错时表一点没动（不能出现「校验失败但前几段已经写进去了」）。
 *
 * 用法：node client/tools/test-snapshot-contract.cjs
 */
const path = require("path");
const { prepare, check, finish, fail } = require("./lib/configs-sandbox.cjs");

/** 服务端八项属性形状（区间是 {min,max} 对象） */
const attributes = (maxHp, attack, defense) => ({
  maxHp,
  hpRecover: 0,
  physicalAttack: { min: attack, max: attack },
  magicAttack: { min: 0, max: 0 },
  taoistAttack: { min: 0, max: 0 },
  physicalDefense: { min: defense, max: defense },
  magicDefense: { min: defense, max: defense },
  taoistDefense: { min: defense, max: defense },
});

const equipmentRow = () => ({
  id: "cloth_1",
  slot: "cloth",
  level: 12,
  sellPrice: 100,
  label: "测试衣服",
  description: "测试描述",
  occupation: "4",
  sex: "3",
  icon: "equipment/clothes/icon/1",
  inAtlas: "equipment/clothes/in/1",
  outAtlas: "equipment/clothes/out/1",
  tags: [],
  outScale: 1,
  inScaleX: 1,
  inScaleY: 1,
  inRotate: 0,
  inPosX: 0,
  inPosY: 0,
  outPositions: Array.from({ length: 8 }, () => ({ x: 0, y: 0 })),
  attributes: attributes(100, 10, 5),
  updatedAt: 0,
});

const skillRow = (id, occupation) => ({
  id,
  owner: "role",
  label: `技能${id}`,
  icon: "skill/icon",
  category: "attack",
  targetType: "single",
  action: "attack_near",
  effect: "",
  effectOnSelf: false,
  cooldown: 1000,
  mpCost: 0,
  distance: 100,
  levelReq: 1,
  description: "",
  damageCoefficients: [{ baseType: "physicalAttack", baseTypeRate: 1 }],
  statusId: "",
  castLockMs: 0,
  requireTarget: true,
  canAuto: true,
  occupation,
  pushDistance: 0,
  updatedAt: 0,
});

const statusRow = (id) => ({
  id,
  owner: "role",
  label: `状态${id}`,
  icon: "status/icon",
  duration: 1000,
  source: "skill",
  description: "",
  effect: "",
  effectHoldLast: false,
  updatedAt: 0,
});

const questRow = (id) => ({
  id,
  kind: "main",
  label: `任务${id}`,
  description: "",
  prevQuestId: "",
  minLevel: 1,
  npcId: "0002",
  objective: { type: "kill", target: "1", count: 3 },
  rewards: { bindGold: 0, exp: 0, items: [] },
  updatedAt: 0,
});

/**
 * 一份**完整合法**的快照（每段都在、形状都对）
 *
 * 只放最少必要的行（契约只要求「段在 + 形状对」，内容多少是数据问题不是契约问题）——
 * 除 levelCurves / equipmentSlots 这两个关键段外，其余数组都可以是空的。
 */
function completeSnapshot(over = {}) {
  return {
    titles: [],
    souls: [],
    ranks: [],
    equipments: [equipmentRow()],
    drugs: [],
    moneyItems: [],
    // #787：升级卷轴（业务段，空表也合法 —— 运营可以一卷都不开）
    levelScrolls: [],
    items: [],
    monsters: [],
    monsterPresentations: [],
    npcs: [],
    fashions: [],
    // #786：等级段是 4 条曲线（每条至少一段）—— 少一条就有一个等级算不出属性
    levelCurves: [
      { curve: "exp", seq: 1, fromLevel: 1, toLevel: 1000000, startValue: 10, perLevel: 0, accel: 0, updatedAt: 0 },
      { curve: "hp", seq: 1, fromLevel: 1, toLevel: 1000000, startValue: 100, perLevel: 0, accel: 0, updatedAt: 0 },
      { curve: "attack_max", seq: 1, fromLevel: 1, toLevel: 1000000, startValue: 2, perLevel: 0, accel: 0, updatedAt: 0 },
      { curve: "defense_max", seq: 1, fromLevel: 1, toLevel: 1000000, startValue: 2, perLevel: 0, accel: 0, updatedAt: 0 },
    ],
    growthScalars: [{ key: "roleMaxLevel", value: 3, description: "", updatedAt: 0 }],
    combatWeights: { maxHp: 1, physicalAttack: 2 },
    mallCategories: [{ id: "default", label: "默认分类", sortOrder: 0, goodCount: 1, updatedAt: 0 }],
    mallGoods: [{ id: "cloth_1", categoryId: "default", price: 5, requiredLevel: 0 }],
    dropTables: [],
    monsterDrops: [],
    skills: [skillRow("1000", "1")],
    statuses: [statusRow("1")],
    quests: [questRow("q1")],
    achievements: [],
    maps: [{ id: "1", label: "测试图", type: "field", typeLabel: "野外", level: 0, combat: 0, soulOfWar: 0, updatedAt: 0 }],
    mapTypes: [{ type: "field", label: "野外" }],
    uiEffects: [],
    equipmentSlots: [{ key: "cloth", label: "衣服", imageSrc: "ui/slot_cloth", position: "bottom", order: 0 }],
    equipmentMeta: {
      prefixRates: [1, 1.4, 1.8, 2.2, 2.6],
      suffixRates: [1, 2, 3],
      prefixLabels: ["普通的", "精良的", "优秀的", "史诗的", "传说的"],
      suffixLabels: ["人级", "地级", "天级"],
      updatedAt: 0,
    },
    // #605：运行时参数也是契约的一段（单行三组；全字段给齐，段缺失的用例才能只怪那一处）
    runtimeParams: {
      drop: { autoPickupRadius: 40, fullTipInterval: 1500, scatterMinDistance: 52, pickReplyTimeout: 5000 },
      autoBattle: {
        maxTargetDistance: 0,
        moveByRun: true,
        cellSize: 40,
        clearance: 20,
        repathInterval: 400,
        waypointTolerance: 14,
        stuckInterval: 500,
        stuckDistance: 8,
        stuckRetryLimit: 3,
        targetBanDuration: 5000,
        targetSearchInterval: 500,
        arriveTolerance: 20,
        teleportSnapRadius: 12,
        dashSnapRadius: 60,
      },
      guild: { nameMin: 2, nameMax: 12, noticeMax: 200, applicationMessageMax: 50 },
      updatedAt: 0,
    },
    // #605：新手引导步骤（数组顺序 = 体验顺序）
    guideSteps: [{ id: "move", title: "先动起来", desc: "走两步。", spot: "joystick", trigger: "move" }],
    // #683：音效（客户端形状只有播放要用的五个字段）
    audio: [{ key: "bgm", filePath: "audio/bg.wav", volume: 60, loop: true, enabled: true }],
    // #695：装备外观（四组映射；服务端保证 15 组合覆盖，客户端契约只看数组在不在）
    equipmentAppearance: {
      borders: Array.from({ length: 15 }, (_, i) => ({ prefix: i % 5, suffix: Math.floor(i / 5), key: `border-${30123 + i}` })),
      backgrounds: Array.from({ length: 15 }, (_, i) => ({ prefix: i % 5, suffix: Math.floor(i / 5), key: `bg-${16000 + i}` })),
      customBorders: [],
      customBackgrounds: [],
      updatedAt: 0,
    },
    ...over,
  };
}

/** 抓一次调用是否抛错（返回错误信息，没抛返回空串） */
function thrown(run) {
  try {
    run();
    return "";
  } catch (error) {
    return String((error && error.message) || error);
  }
}

function main() {
  let outDir;
  try {
    outDir = prepare("olua-snapshot-contract", ["configs/apply-snapshot.ts", "configs/game-config.ts"]);
  } catch (error) {
    fail(String(error.message ?? error));
    return;
  }

  const contract = require(path.join(outDir, "configs/game-config.js"));
  const snapshotApi = require(path.join(outDir, "configs/apply-snapshot.js"));
  const { levelCurves, levelConfigOf } = require(path.join(outDir, "configs/game-config.js"));
  const { equipmentSlots } = require(path.join(outDir, "configs/equipments.js"));
  const { skillData } = require(path.join(outDir, "configs/game-config.js"));
  const { statuses } = require(path.join(outDir, "configs/game-config.js"));
  const { questData } = require(path.join(outDir, "configs/game-config.js"));
  const { items } = require(path.join(outDir, "configs/items.js"));
  const { maps, mapTypeGroups } = require(path.join(outDir, "configs/game-config.js"));
  const { getMallPrice } = require(path.join(outDir, "configs/game-config.js"));

  console.log("\n=== 清单自检 ===");
  check(contract.SNAPSHOT_SECTIONS.length >= 20, "契约清单非空（少于 20 段说明清单被删了）", `${contract.SNAPSHOT_SECTIONS.length} 段`);
  const keys = contract.SNAPSHOT_SECTIONS.map((section) => section.key);
  check(new Set(keys).size === keys.length, "清单里没有重复 key", `${new Set(keys).size} 个唯一 key`);
  check(
    contract.SNAPSHOT_SECTIONS.every((section) => section.label && section.kind),
    "每段都有中文名与形状（报错文案靠它，别留空）",
  );

  console.log("\n=== 完整快照：通过且真的落了库 ===");
  check(contract.checkSnapshotContract(completeSnapshot()).length === 0, "完整快照没有问题项");
  check(thrown(() => snapshotApi.applyConfigSnapshot(completeSnapshot())) === "", "applyConfigSnapshot 不抛错");
  check(levelCurves.length === 4 && levelConfigOf(1).maxHp === 100, "等级曲线落库（levelCurves 段，1 级 = 100 血）", `${levelCurves.length} 段`);
  check(equipmentSlots.size === 1, "槽位表落库（equipmentSlots 段）", `${equipmentSlots.size} 个槽位`);
  check(items.size === 15, "装备展开成 15 个变体（装备规则已先装）", `items=${items.size}`);
  check(skillData.length === 1 && skillData[0].id === "1000", "技能表落库（skills 段）", `${skillData.length} 条`);
  check(statuses.size === 1 && statuses.has("1"), "状态表落库（statuses 段）", `${statuses.size} 条`);
  check(questData.length === 1 && questData[0].id === "q1", "任务表落库（quests 段）", `${questData.length} 条`);
  check(maps.size === 1 && mapTypeGroups.length === 1, "地图与类型分组落库", `${maps.size} 张 / ${mapTypeGroups.length} 组`);
  check(getMallPrice({ id: "cloth_1" }) === 5, "商城售价落库（mallGoods.price）", String(getMallPrice({ id: "cloth_1" })));

  console.log("\n=== 缺任意一段 → 抛错并点名（逐段扫）===");
  let missingOk = 0;
  const missingMisses = [];
  for (const section of contract.SNAPSHOT_SECTIONS) {
    const broken = completeSnapshot();
    delete broken[section.key];
    const problems = contract.checkSnapshotContract(broken);
    const named = problems.length === 1 && problems[0].key === section.key;
    const error = thrown(() => snapshotApi.applyConfigSnapshot(broken));
    const thrownRight = error.indexOf(section.key) >= 0 && error.indexOf(section.label) >= 0;
    if (named && thrownRight) missingOk++;
    else missingMisses.push(`${section.key}(${problems.length} 项 / 抛错=${error ? "是" : "否"})`);
  }
  check(missingOk === contract.SNAPSHOT_SECTIONS.length, "每一段缺失都报错且错误里带 key 与中文名", missingMisses.length ? missingMisses.join("、") : `${missingOk}/${contract.SNAPSHOT_SECTIONS.length}`);

  console.log("\n=== 形状不对 → 抛错（不是「跳过这一段」）===");
  check(thrown(() => snapshotApi.applyConfigSnapshot(completeSnapshot({ skills: null }))).indexOf("skills") >= 0, "数组段给 null → 抛错");
  check(thrown(() => snapshotApi.applyConfigSnapshot(completeSnapshot({ maps: {} }))).indexOf("maps") >= 0, "数组段给对象 → 抛错");
  check(thrown(() => snapshotApi.applyConfigSnapshot(null)).length > 0, "整份快照是 null → 抛错");
  check(thrown(() => snapshotApi.applyConfigSnapshot([])).length > 0, "整份快照是数组 → 抛错");

  console.log("\n=== 关键段空表 → 抛错；业务段空表 → 允许 ===");
  check(
    ["levelCurves", "等级曲线"].some((key) =>
      thrown(() => snapshotApi.applyConfigSnapshot(completeSnapshot({ levelCurves: [] }))).includes(key),
    ),
    "levelCurves 空表 → 抛错（血蓝全 0 的游戏没法玩）",
  );
  check(
    thrown(() => snapshotApi.applyConfigSnapshot(completeSnapshot({ equipmentSlots: [] }))).indexOf("equipmentSlots") >= 0,
    "equipmentSlots 空表 → 抛错（背包没有装备格）",
  );
  check(
    thrown(() =>
      snapshotApi.applyConfigSnapshot(completeSnapshot({ drugs: [], items: [], skills: [], statuses: [], quests: [], achievements: [], fashions: [] })),
    ) === "",
    "业务表清空是**合法数据状态**（运营下架全部药品不该被契约拦住）",
  );

  console.log("\n=== 装备规则的倍率（#603 第九域那个静默失败）===");
  const metaWith = (over) => completeSnapshot({ equipmentMeta: { ...completeSnapshot().equipmentMeta, ...over } });
  check(thrown(() => snapshotApi.applyConfigSnapshot(metaWith({ prefixRates: [] }))).indexOf("prefixRates") >= 0, "倍率空数组 → 抛错（一件变体都展开不出来）");
  check(thrown(() => snapshotApi.applyConfigSnapshot(metaWith({ suffixRates: [1, 0, 3] }))).indexOf("suffixRates") >= 0, "倍率里有 0 → 抛错（落库时会被滤掉）");
  check(
    thrown(() => snapshotApi.applyConfigSnapshot(metaWith({ prefixLabels: ["普通的"] }))).indexOf("prefixLabels") >= 0,
    "倍率与文案不同长 → 抛错（品质名会取到 undefined）",
  );

  console.log("\n=== 先校验后落库：失败时表一点没动 ===");
  snapshotApi.applyConfigSnapshot(completeSnapshot());
  const before = JSON.stringify([levelCurves.length, equipmentSlots.size, skillData.length, statuses.size, questData.length, items.size]);
  thrown(() => snapshotApi.applyConfigSnapshot(completeSnapshot({ levelCurves: [] })));
  const after = JSON.stringify([levelCurves.length, equipmentSlots.size, skillData.length, statuses.size, questData.length, items.size]);
  check(before === after, "契约不过时不会写进任何一段（不是「先写前几段再报错」）", after);

  console.log("\n=== 整表重建：快照里没有的客户端就没有 ===");
  snapshotApi.applyConfigSnapshot(completeSnapshot({ skills: [skillRow("1001", "2")], statuses: [], quests: [] }));
  check(skillData.length === 1 && skillData[0].id === "1001", "技能表整表重建（旧 id 不残留）", skillData.map((row) => row.id).join(","));
  check(statuses.size === 0, "状态表整表重建（快照给空表 → 表就空）", `${statuses.size}`);
  check(questData.length === 0, "任务表整表重建（快照给空表 → 表就空）", `${questData.length}`);

  finish("配置快照契约：全部断言通过");
}

main();
