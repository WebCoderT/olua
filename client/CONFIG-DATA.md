# 客户端配置（`assets/configs`）与服务端数据对照表

> 这份文件是**索引**，不是权威：字段含义看代码注释，接口契约看 `server/openapi.json`。
> 目的只有一个 —— 想改某个东西时，能一眼看出「它现在归谁、改哪儿、客户端什么时候拿到」。
> 最后更新：2026-11-03（#634：掉落光效 `light_1`…`light_6` 纳入 `ui_effects`，摆位 / 缩放 / 旋转 / 时长 / 开关改由服务端下发；此前 #626 已把 21 个快照域文件合并为 `configs/game-config.ts`）。

## 一、一句话规则

**客户端不存任何「运营会改的数据」**。`configs/` 里凡是被服务端下发覆盖的表，都是**空壳容器**：
模块加载时是空的，进游戏拉一次 `GET /game-config` 后整表重建。

客户端留下的三类东西，与服务端无关：

| 类别 | 例子 | 为什么留 |
|---|---|---|
| **资源约定** | `game-config.ts` 第 18 区的 `mapSrcOf` / Tiled 对象组名、`animation.ts` 的方向下标 | 「加载哪张图 / 读哪个目录」是打包时的目录约定，不是运营数据；下发方永远改不到它 |
| **表现与手感** | `drop.ts` 的拾取半径、`role.ts` 的移动速度、`autoBattle.ts`、`layout/*` | 纯客户端手感 / 排版，改了要重新调手感，不是运营能盲调的 |
| **界面文案** | `texts.ts`、`loading.ts` | UI 字面量，跟玩法数值无关 |

## 二、服务端数据到客户端的唯一链路

```
游戏启动（选角 → Loading → Game）
  └─ ui/Loading.ts：await loadGameConfig()        ← 在 preloadGame **之前**（#604）：预载要读怪物/NPC/时装表
       └─ ui/utils/net/ConfigLoader.ts
            ├─ GameConfigApi.snapshot()      GET /game-config                  快照只拉一次（进程内）
            ├─ GameConfigApi.equipAlign()    GET /game-config/equip-align      每次进图都拉
            └─ GameConfigApi.equipInAlign()  GET /game-config/equip-in-align   每次进图都拉
                 └─ configs/game-config.ts 第 0 区   先校验契约（缺段 / 形状不对 → 抛错）
                 └─ configs/apply-snapshot.ts
                      ├─ applyConfigSnapshot(snapshot)      逐段整表重建（段必填，没有「缺段跳过」）
                      ├─ applyEquipAlignRows(rows)          外观几何（先还原出厂值再覆写）
                      └─ applyEquipInAlignRows(rows)        内观几何（同上）
                           └─ 落进 game-config 各分区的运行时表；消费方读法不变（`import { items } from configs/items`）
```

三个请求**并行**；**快照是硬依赖**（#604）：段缺失 / 形状不对 → `applyConfigSnapshot` 抛错 →
`loadGameConfig()` 返回 `ok:false` → **停在 Loading 界面**显示缺了哪几段、点屏幕重试，
不构建游戏世界（客户端出厂表已随 #603 全部退场，「回落」等于回落到空表）。

失败分两类，文案不同：`network`（服务端没起 / 断网 / 令牌失效，重试大概率就好）与
`contract`（服务端漏发段，要按 key 去补）。两类都**不置「已加载」**，下次进图重试。

两套**几何**失败仍不致命（缺行 = 按装备表里的出厂几何画，那正是「工作台没调过」的语义），
只 `console.warn` —— 但绝不静默：一个 404 会被当成「保存没生效」（#527）。

守点：`tools/audit-snapshot-contract.cjs` 钉住「客户端 `SNAPSHOT_SECTIONS` == 快照 DTO 字段 ==
`snapshot()` 实际返回的键」，并检查 `applyConfigSnapshot` 先校验后落库、Loading 先拉配置再预载。

## 三、快照段 → 落库函数 → 客户端表 → 服务端出厂 → 管理端页面

### 3.1 玩家侧快照（`GET /game-config`）

> 客户端表分两处住：**快照域全在 `configs/game-config.ts`**（按 `//#region` 分局，下表「区 N」就是它），
> 装备七张部位表与物品总表仍在 `configs/equipments.ts` / `configs/items.ts`（它们是「按 id 展开的算法」，不是快照段）。

| 快照段 | 落库函数 | 落到哪个客户端表 | 服务端出厂（唯一书写处） | 管理端页面 |
|---|---|---|---|---|
| `combatWeights` | `applyCombatWeights` | `game-config` 区 5 `combatCalc` | `config-sync.sql` → `combat_weights` 表 | `/combat-weights` |
| `titles` | `applyTitleRows` | `game-config` 区 1 `titleLevels`（全量）+ `titleUpgradeChain`（渠道 = upgrade 的行，按 `upgradeOrder`） | `config-sync.sql` → `titles` 表 | `/titles` |
| `souls` | `applySoulRows` | `game-config` 区 2 `soulLevels`（全量）+ `soulUpgradeChain`（全量，按 `upgradeOrder`） | `config-sync.sql` → `souls` 表 | `/souls` |
| `ranks` | `applyRankRows` | `game-config` 区 3 `rankLevels`（100 阶按阶就是链） | `config-sync.sql` → `ranks` 表 | `/ranks` |
| `levels` / `growthScalars` | `applyLevelRows` / `applyGrowthScalars` | `game-config` 区 4 `levelMap`、区 6 `roleMaxLevel` | `config-sync.sql` | `/growth` |
| `equipments` | `applyEquipments`（→ `applyEquipmentData`） | `configs/equipments.ts` 七张部位表 + `configs/items.ts` 的装备条目（基础件展开 555 变体） | `config-sync.sql` → `equipments` 表 | `/equipments` |
| `equipmentSlots` | `applyEquipmentSlots` | `configs/equipments.ts` `equipmentSlots` / `equipmentSlotOrder` | `config-sync.sql` → `equipment_slots` 表 | `/equipment-settings` |
| `equipmentMeta` | `applyEquipmentRules`（区 6）/ `applyEquipmentQualityLabels`（equipments） | `game-config` 区 6 的前后缀倍率 + 回收价曲线、`configs/equipments.ts` 的品质文案 | `config-sync.sql` → `equipment_meta` 表 | `/equipment-settings` |
| `items` | `applyItemRows`（→ `applyItemBaseData`，整表重建） | `game-config` 区 9 `materials` | `config-sync.sql` → `items` 表 | `/items` |
| `drugs` | `applyDrugRows`（→ `applyDrugData`，整表重建） | `game-config` 区 8 `drugs` | `config-sync.sql` → `drugs` 表 | `/drugs` |
| `monsters` | `applyMonsterRows` | `game-config` 区 16 `monsterRuntime` | `config-sync.sql` → `monsters` 表 | `/monsters` |
| `monsterPresentations` | `applyMonsterPresentations` | `game-config` 区 16 `monsterResource` | `config-sync.sql` → `monster_presentation` 表（几何由 `client/tools/gen-monster-config.cjs` 量素材写回） | `/monsters`（掉落弹窗另有摘要） |
| `npcs` | `applyNpcRows` | `game-config` 区 10 `npcs` | `config-sync.sql` → `npcs` 表 | `/npcs` |
| `quests` | `applyQuestRows` | `game-config` 区 11 `questData` + 区 12 `quests`（按行派生的注册表） | `config-sync.sql` → `quests` 表 | `/quests` |
| `skills` | `applySkillRows`（→ `applySkillData`，整表重建） | `game-config` 区 13 `skillData` + `oeccupationSkills`（按行派生的职业映射） | `config-sync.sql` → `skills` 表 | `/skills` |
| `statuses` | `applyStatusRows` | `game-config` 区 7 `statuses` | `config-sync.sql` | `/statuses` |
| `fashions` | `applyFashionRows`（→ `applyFashionData`，整表重建） | `game-config` 区 14 `fashionData`（空数组）+ 取源规则 | `config-sync.sql` → `fashions` 表 | `/fashions` |
| `mallPrices` / `mallSettings` | `applyMallPrices` / `applyMallPricing` | `game-config` 区 17（特殊价 + 统一价，客户端无出厂值） | `config-sync.sql` → `mall_settings`；特殊价只在表里 | `/mall-pricing` |
| `maps` / `mapTypes` | `applyMapRows` | `game-config` 区 18 `maps`、`mapTypeGroups` | `config-sync.sql` → `maps` 表 | `/maps` |
| `uiEffects` | `applyUiEffectRows` | `game-config` 区 19 `uiEffects`（升级特效 `upgrade` + 掉落光效 `light_1`…`light_6` 七行） | `ui_effects` 表 | `/ui-effects` |
| `runtimeParams` | `applyRuntimeParams`（→ `applyDropRuntime` / `applyAutoBattleParams`） | `configs/drop.ts` `dropRuntime`（对象引用不变）、`configs/autoBattle.ts` `autoBattle`（只覆写行为参数，`routeLine` 样式不动） | `config-sync.sql` → `runtime_params` 表 | `/runtime-params` |
| `guideSteps` | `applyGuideSteps`（整表替换） | `configs/guide.ts` `guideSteps`（表现层：遮罩配色 / 节点名 / 排版仍在客户端） | `config-sync.sql` → `guide_settings` 表 | `/guide-steps` |

### 3.2 三条成长线的「升级路径」（后台配，客户端照做）

称号 / 战魂 / 军衔的升级弹窗**不是**按等级号铺全表，而是按管理端配的成长链：

| 线 | 链的范围 | 顺序 | 管理端在哪配 |
|---|---|---|---|
| 称号 | **只含获得渠道 = 「称号升级」的行**（`acquire_channel = upgrade`） | `upgrade_order`（拖动排序，与等级号解耦） | `/titles` → 编辑弹窗改渠道；「称号成长列表」拖动 + 改价 |
| 战魂 | 37 阶全量（没有渠道概念） | `upgrade_order`（可拖动） | `/souls` → 「战魂成长列表」 |
| 军衔 | 100 阶全量 | 按阶（管理端不让拖，也没有 `upgrade_order` 列） | `/ranks` → 「军衔成长列表」只看价格 |

客户端三条口径（`configs/game-config` 的 `titleUpgradeChain` / `soulUpgradeChain` / `nextXxxUpgrade`）：

1. **列表只列链上的档** —— 运营没放出的等级不出现在弹窗里（以前是 34 阶全画出来，玩家会看到一串点不动的空档）；
2. **下一档 = 链上下一个**，不是 `level + 1` —— 链可能跳号、顺序可能被拖过；
   `StorageManager.upgradeXxx` 报给服务端的 `targetLevel` 与服务端 `roles.service.resolveGrowthTarget`
   算出的下一档必须一致（否则服务端以「目标阶位不合法」拒收）；
3. **三态分开**（`growthStepOf`）：`maxed` 到链尾 / `locked` 当前档不在链上（运营把玩家已有的称号切了渠道）
   / `closed` 链为空（一档都没开放）—— 都不能互相冒充，提示与按钮文案各不相同。

`getTitleLevel` / `getSoulLevel` / `getRankLevel` 仍按**等级号**读全表：头顶名牌、当前称号/军衔展示
走的是「玩家已获得的那一档」，与链序无关（运营改链不该让玩家头顶的称号消失）。

### 3.3 几何（两个独立接口，不进快照）

| 接口 | 落库函数 | 落到哪里 | 管理端页面 |
|---|---|---|---|
| `GET /game-config/equip-align` | `applyEquipAlignRows` | `game-config` 区 20（外观位置 / 缩放 / 手调开关） | `/equip-align` |
| `GET /game-config/equip-in-align` | `applyEquipInAlignRows` | `game-config` 区 20（内观：衣服对圆盘、武器对第一件衣服） | `/equip-in-align` |

**为什么这两个每次进图都拉、快照只拉一次**：几何是「人眼调一版、立刻要看效果」的东西，
验收动作就是退回选角再进图（场景重载、JS 上下文不重来）；只拉一次会被当成「保存没生效」。
内观还多一条「每次打开角色信息弹窗再拉」（`refreshInAlign()`），因为那一屏不需要重进图。

## 四、`configs/` 现有文件与归属

### 4.1 `game-config.ts` 的 21 个分区（#626 合并；内容全部来自服务端）

| 区 | 表 / 常量 | 填充者 | 原文件 |
|---|---|---|---|
| 0 | 契约 `SNAPSHOT_SECTIONS` | —（客户端自己的要求） | `snapshot-contract.ts` |
| 1 / 2 / 3 | `titleLevels` / `soulLevels` / `rankLevels`（+ 区 1/2 由表派生的 `titleUpgradeChain` / `soulUpgradeChain`） | 各自的 `apply*Rows` | `title.ts` / `soul.ts` / `rank.ts` |
| 4 | `levelMap` | `applyLevelRows` | `level.ts` |
| 5 | `combatCalc` | `applyCombatWeights` | `battle.ts` |
| 6 | 前后缀倍率 / 回收价曲线 / `roleMaxLevel` | `applyEquipmentRules` / `setRoleMaxLevel` | `growth.ts` |
| 7 | `statuses` | `applyStatusRows`（所有未登记行一律写入） | `status.ts` |
| 8 | `drugs`（**空数组**，含图标） | `applyDrugRows` → `applyDrugData`（整表重建） | `drug.ts` |
| 9 | `materials`（**空数组**，含图标） | `applyItemRows` → `applyItemBaseData`（整表重建） | `material.ts` |
| 10 | `npcs` | `applyNpcRows`（整表重建） | `npc.ts` |
| 11 / 12 | `questData` / `quests`（派生注册表） | `applyQuestRows` → `rebuildQuests()` | `quest-data.ts` / `quest.ts` |
| 13 | `skillData`（**空数组**）+ `oeccupationSkills`（按行派生） | `applySkillRows` → `applySkillData` | `skill-data.ts` |
| 14 | `fashionData`（**空数组**）+ 外观取源规则（`getFashionOut` / `getFashionIn`） | `applyFashionRows` → `applyFashionData` | `fashionClothes.ts` |
| 15 | `monsterAI` / `monsterDefaultSpeedRate`（**客户端手感**，见 4.2） | —（常量） | `monster.ts` |
| 16 | `monsterRuntime` / `monsterResource` | `applyMonsterRows` / `applyMonsterPresentations` | `monsterRuntime.ts` |
| 17 | 特殊价 / 统一价（**无出厂值**） | `applyMallPricing` | `mall.ts` |
| 18 | `maps` / `mapTypeGroups` + 资源约定（`mapSrcOf` / Tiled 名） | `applyMapRows` | `map.ts` |
| 19 | `uiEffects`（升级特效 + 掉落光效六档）+ 技能/状态/选中/受击闪屏四个表现常量 | `applyUiEffectRows` | `effect.ts` |
| 20 | 几何基线 / 手势锚点算法 | `applyEquipAlignRows`（在 `apply-snapshot`） | `equipAlign.ts` |

仍在原文件的两张「算法表」（不是快照段，靠 `applyEquipmentData` / `rebuildItemIndex` 填）：

| 文件 | 内容 |
|---|---|
| `equipments.ts` | 七张部位表 / `equipmentSlots` / `equipmentSlotOrder` / 品质文案 / 装备展开与几何纯函数 / `getMallGoods`（唯一要读七张表的读取函数，放这里避免成环） |
| `items.ts` | `items` 总表 = 装备 + 药品 + 材料的「id → 物品」索引（`rebuildItemIndex()` 按装备 → 药品 → 材料） |

### 4.2 复核后判定「不搬」（#603 第十三域的结论）

| 文件 / 区 | 剩下什么 | 为什么不入库 |
|---|---|---|
| `role.ts` | `occupations`（3 行职业介绍）、移动速度、体型 / 碰撞盒、摇杆与鼠标死区、背包行列、快捷键布局、动作速度倍率 | 职业名的权威副本已在公共数据（生成物 `OCCUPATION_LABELS`）；介绍图路径按职业码可推导（`create_role/tips_<码>`），尺寸是素材量出来的；其余全是手感 / 布局参数（`client/README` 的「表现层」） |
| `game-config` 区 15 | `monsterAI`（普攻间隔 / 停下出手距离 / 待机游走节奏 / 击退时长）、`monsterDefaultSpeedRate` | 动画节奏与手感；服务端 tick 读的 6 个数值已由生成器收进 `MONSTER_AI`（**两端同源，不是两份**）。怪物真正的数值（血量 / 六项攻防 / 掉落）早在 `monsters` 表 |

> 判据沿用项目既定三条：**能按 id 推导的资源路径不入库**、**素材尺寸不是运营数值**、
> **客户端只留资源约定与手感参数**。为了「搬完」而给 3 行 UI 文案建表 + 建页面，
> 收益不抵一处新的漂移面 —— 这一点已写进 `TODO-FOR-USER.md` 等拍板。

### 4.3 客户端自己的东西（与运营数据无关）

| 文件 / 区 | 内容 |
|---|---|
| `configs/animation.ts` | 动画方向下标、动作时长 |
| `configs/npcClicks.ts` | NPC 点击行为（id → 弹窗）；会引 UI 组件，所以不能进 `game-config` 区 10 |
| `configs/drop.ts` | 掉落物手感：拾取半径、提示节流、散落间距、拾取应答超时 |
| `configs/network.ts` | 服务端地址的唯一来源（按运行环境解析） |
| `configs/texts.ts` | 界面文案（`getText(key, params)`，代码里不写中文） |
| `configs/layout/*`（`hudLayout.ts` 是 barrel） | 界面布局、尺寸、配色 |
| `configs/cursor.ts` / `debug.ts` / `loading.ts` | 鼠标指针 / 调试开关 / 加载条 |
| `configs/autoBattle.ts` / `bottomNav.ts` / `smallMap.ts` / `guide.ts` 等 | 面板与人机交互参数 |
| `game-config` 区 18 | 地图资源约定：`mapSrcOf`、Tiled 对象组 / 属性名（**不含**任何玩法数值） |
| `game-config` 区 20 | 几何基线 + 手势锚点算法（出厂值回落，快照例外之一） |

> 「`configs/` 不许写中文文案」「布局只走 `layout/*`」「`configs` 与 `types` 不依赖 UI 层」
> 这三条由 `tools/audit-config-leak.cjs` 与 `audit-ui-click-through.cjs` 盯着。

## 五、调用数据的方法都在这几处

| 想做的事 | 调什么 | 在哪 |
|---|---|---|
| 进游戏时把服务端配置全部接住 | `await loadGameConfig()`（返回 `{ok, reason, problems}`，**必须看 ok**） | `ui/Loading.ts` → `ui/utils/net/ConfigLoader.ts` |
| 只刷内观几何（开弹窗时） | `refreshInAlign()` | 同上 |
| 手动把一份快照灌进去（单测 / 调试） | `applyConfigSnapshot(snapshot)` —— **必须是完整快照**，缺段会抛（#604） | `configs/apply-snapshot.ts` |
| 只灌某一类表（单测常用） | `applyContentSnapshot` / `applySkillSnapshot` / `applyGrowthSnapshot` | 同上（各自要求本入口的段都在） |
| 快照段清单 / 契约校验 | `SNAPSHOT_SECTIONS` / `checkSnapshotContract()` | `configs/game-config.ts` 区 0 |
| 单表覆写 | `applyTitleRows` / `applyNpcRows` / `applyMapRows` / … | `configs/game-config.ts` 对应分区（`applyEquipAlignRows` 在 `apply-snapshot.ts`） |
| 读物品 / 装备 | `items`、`getItem()`、`getEquipment()` | `configs/items.ts` / `configs/equipments.ts` |
| 读怪物 | `monsterResourceOf()` / `monsterStatsOrDefault()` / `monsterLabelOf()` | `configs/game-config.ts` 区 16 |
| 读 NPC | `npcs.get(id)`、`npcClicks[id]` | `configs/game-config.ts` 区 10 / `configs/npcClicks.ts` |
| 读地图 | `maps` / `mapTypeGroups` / `mapSrcOf` / `mapLabelOf` | `configs/game-config.ts` 区 18 |
| 读商城价 | `getMallPrice(good)` | `configs/game-config.ts` 区 17 |
| 算装备战斗力 / 对比 | `equipmentCombatValue(...)`（权重读区 5 `combatCalc`） | `configs/equipments.ts` |
| 算装备回收价（基础件） | `equipmentRecyclePrice(level)` / `getRecyclePrice(equipment)` | `configs/game-config.ts` 区 6 / `configs/equipments.ts` |

## 六、搬迁进度（#603）

已搬完（客户端不再有出厂数据）：`monsterDrops`、`monster-skills`、`status`、`quest`、`achievement`、
`drop`（具名表 + 兜底表）、`battle`（战斗力权重）、`npc`、`mall`（默认售价）、
**`equipments` + `growth`（第九域：装备/槽位/倍率/回收价曲线，含 1080 行装备数据）**、
**`items` / `material` / `drug`（第十域：图标随行入库，物品总表只剩索引）**、
**`skill-data`（第十一域：15 条技能行 + 职业归属 / 击退距离，`oeccupationSkills` 改为派生）**、
**`fashionClothes`（第十二域：20 套时装，含 icon / in / out 资源路径与 `acquireChannel` 获得渠道 —— 路径不可按 id 推导，必须入库；渠道随 #596 收权进表，`upgrade` 且有价才可购买）**。

**`role` / `monster`（第十三域）：复核后判定不搬** —— 剩下的全是表现层（职业介绍图路径可推导、
尺寸取素材、AI 节奏与移动手感），判据见 4.2。至此 #603 的「运营数据进库」全部收口。

> 第九域的三层切分值得记住：**显示与规则**进 `equipments` / `equipment_slots` / `equipment_meta` 三张表；
> **八项战斗属性**在 `equipment_variants` 表里逐条写明（#655：555 行，运行时零现算，回收价也在这张表）；
> **几何**（内观锚点 / 外观 8 向）在表里是**出厂值**，工作台结果在 `equip_aligns` / `equip_in_aligns`、每次进图另发。

> 注：成就（`achievements`）虽然也在快照里，但客户端**不落表** —— 成就面板走
> `AchievementStore` + `/achievements/me`（进度与达成状态是玩家数据，不是配置）。这一段属于
> 「发了但没人读」，留着是为了以后要做「成就配置改动即时生效」时不用再改服务端。

**验收口径**：出厂快照 `server/data/config-sync.sql` 必须与库**逐行相同**（`make config-check`）——
不相等就说明有人在库里改了配置却没重导快照，别人 `config-import` 之后会回到旧值。

## 七、为什么 21 个域合成一个文件（#626）

#603 搬完之后每个域只剩「一张空表 + 一个 `apply*` + 一两个读取函数」，平均 80 行；改一个快照段
要在二十个文件之间跳，而这些文件之间除「同属一份快照」外没有任何内聚关系。所以合并为
`configs/game-config.ts`（`configs/` 从 47 个 `.ts` 降到 27 个）。三条纪律写在文件头，违反会静默出事：

1. **只许引** `cc` 的四个纯数据类（`Vec2` / `Vec3` / `Size` / `Color`）、`../types/*`、
   以及 `../ui/utils/net/ApiModels` 的**类型**。它处客户端单测的 Node 垫片链上
   （`client/tools/lib/configs-sandbox.cjs` 只实现这四个类的构造函数），引一个 UI 组件就整条加载不起来。
   → 守点 `client/tools/test-skill-decouple.cjs`（import 白名单）。
2. **不许反向 import** `items` / `equipments` / `skill` / `apply-snapshot`：依赖方向永远是
   `apply-snapshot → game-config → types`。唯一例外是 `getMallGoods`（要读七个部位表）——
   它按语义住在 `equipments.ts`，不进 `game-config`。
3. **`//#region N · 标签（原 configs/xxx.ts）`** 是分区标识，编号稳定：守点按编号取区
   （`audit-world-authority` 的 `regionOf(source, 15)`）。**新增函数要放进它自己的分区里**，
   放到上一个区的尾巴上照样能编译，但按区取源码的守点会读不到。

#655 之后这条链上已经没有「生成物」了：数据只在库 → `config-sync.sql` → 服务端启动灌库 → 快照接口 →
客户端整表重建。相关工具是 `client/tools/lib/configs-sandbox.cjs`（单测垫片，喂的是快照）、
`tools/lib/snapshot-sql.cjs`（唯一的快照解析实现）、`tools/audit-snapshot-contract.cjs`（契约守点）、
`tools/audit-world-authority.cjs`（按区取怪物数值字段）。

**验收**：`make client-check` 0 错、`make client-test` 与合并前基线一致（55 过 / 4 红，红全是素材未入库）、
`make audit` 15 条全绿；`make config-check` 通过（快照与库逐行一致）。
