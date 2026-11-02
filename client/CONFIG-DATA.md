# 客户端配置（`assets/configs`）与服务端数据对照表

> 这份文件是**索引**，不是权威：字段含义看代码注释，接口契约看 `server/openapi.json`。
> 目的只有一个 —— 想改某个东西时，能一眼看出「它现在归谁、改哪儿、客户端什么时候拿到」。
> 最后更新：2026-11-02（#603 逐域搬迁收口：第十三域 role / monster 复核后判定不搬，见第六节）。

## 一、一句话规则

**客户端不存任何「运营会改的数据」**。`configs/` 里凡是被服务端下发覆盖的表，都是**空壳容器**：
模块加载时是空的，进游戏拉一次 `GET /game-config` 后整表重建。

客户端留下的三类东西，与服务端无关：

| 类别 | 例子 | 为什么留 |
|---|---|---|
| **资源约定** | `map.ts` 的 `mapSrcOf` / Tiled 对象组名、`animation.ts` 的方向下标 | 「加载哪张图 / 读哪个目录」是打包时的目录约定，不是运营数据；下发方永远改不到它 |
| **表现与手感** | `drop.ts` 的拾取半径、`role.ts` 的移动速度、`autoBattle.ts`、`layout/*` | 纯客户端手感 / 排版，改了要重新调手感，不是运营能盲调的 |
| **界面文案** | `texts.ts`、`loading.ts` | UI 字面量，跟玩法数值无关 |

## 二、服务端数据到客户端的唯一链路

```
游戏启动（选角 → Loading → Game）
  └─ ui/Game.ts：await loadGameConfig()          ← 必须在预加载之前，地图名/进入条件已不在客户端
       └─ ui/utils/net/ConfigLoader.ts
            ├─ GameConfigApi.snapshot()      GET /game-config                  快照只拉一次（进程内）
            ├─ GameConfigApi.equipAlign()    GET /game-config/equip-align      每次进图都拉
            └─ GameConfigApi.equipInAlign()  GET /game-config/equip-in-align   每次进图都拉
                 └─ configs/apply-snapshot.ts
                      ├─ applyConfigSnapshot(snapshot)      逐段落库（缺段跳过）
                      ├─ applyEquipAlignRows(rows)          外观几何（先还原出厂值再覆写）
                      └─ applyEquipInAlignRows(rows)        内观几何（同上）
                           └─ 落进各 configs 运行时表；消费方 `import { items } from configs/items` 读法不变
```

三个请求**并行**、失败**互不牵连**；任何一段拉不到就保留「空表 / 出厂值」，游戏照常能进
（配置是运营调优，不是必需依赖）。失败会 `console.warn`，不静默吞 —— #527 的教训。

## 三、快照段 → 落库函数 → 客户端表 → 服务端出厂 → 管理端页面

### 3.1 玩家侧快照（`GET /game-config`）

| 快照段 | 落库函数 | 落到哪个客户端表 | 服务端出厂（唯一书写处） | 管理端页面 |
|---|---|---|---|---|
| `combatWeights` | `applyCombatWeights` | `configs/battle.ts` `combatCalc` | `shared/combat-seed.ts` | ⚠ 无编辑页（待 #605） |
| `titles` | `applyTitleRows` | `configs/title.ts` `titles` | `shared/title-seed.ts` | `/titles` |
| `souls` | `applySoulRows` | `configs/soul.ts` `souls` | `shared/soul-seed.ts` | `/souls` |
| `ranks` | `applyRankRows` | `configs/rank.ts` `ranks` | `shared/rank-seed.ts` | `/ranks` |
| `levels` / `growthScalars` | `applyLevelRows` / `applyGrowthScalars` | `configs/level.ts` `levels`、`configs/growth.ts` 的等级上限 | `shared/growth-seed.ts` | `/growth` |
| `equipments` | `applyEquipments`（→ `applyEquipmentData`） | `configs/equipments.ts` 七张部位表 + `configs/items.ts` 的装备条目（基础件展开 555 变体） | `shared/equipment-seed.ts` → `equipments` 表 | `/equipments` |
| `equipmentSlots` | `applyEquipmentSlots` | `configs/equipments.ts` `equipmentSlots` / `equipmentSlotOrder` | `shared/equipment-seed.ts` → `equipment_slots` 表 | `/equipment-settings` |
| `equipmentMeta` | `applyEquipmentRules`（growth）/ `applyEquipmentQualityLabels`（equipments） | `configs/growth.ts` 的前后缀倍率 + 回收价曲线、`configs/equipments.ts` 的品质文案 | `shared/equipment-seed.ts` → `equipment_meta` 表 | `/equipment-settings` |
| `items` | `applyItemRows`（→ `applyItemBaseData`，整表重建） | `configs/material.ts` `materials` | `shared/item-seed.ts` → `items` 表 | `/items` |
| `drugs` | `applyDrugRows`（→ `applyDrugData`，整表重建） | `configs/drug.ts` `drugs` | `shared/item-seed.ts` → `drugs` 表 | `/drugs` |
| `monsters` | `applyMonsterRows` | `configs/monsterRuntime.ts` `monsterRuntime` | `shared/monster-seed.ts` → `monsters` 表 | `/monsters` |
| `monsterPresentations` | `applyMonsterPresentations` | `configs/monsterRuntime.ts` `monsterResource` | `shared/monster-presentation.generated.ts` | `/monsters`（掉落弹窗另有摘要） |
| `npcs` | `applyNpcRows` | `configs/npc.ts` `npcs` | `shared/npc-seed.ts` → `npcs` 表 | `/npcs` |
| `quests` | `applyQuestRows` | `configs/quest-data.ts` `questData` | `shared/quest-seed.ts` → `quests` 表 | `/quests` |
| `skills` | `applySkillRows`（→ `applySkillData`，整表重建） | `configs/skill-data.ts` `skillData` + `oeccupationSkills`（按行派生的职业映射） | `shared/skill-seed.ts` → `skills` 表 | `/skills` |
| `statuses` | `applyStatusRows` | `configs/status.ts` `statuses` | `shared/status-seed.ts` | `/statuses` |
| `fashions` | `applyFashionRows`（→ `applyFashionData`，整表重建） | `configs/fashionClothes.ts` `fashionData`（空数组）+ 取源规则 | `shared/fashion-seed.ts` → `fashions` 表 | `/fashions` |
| `mallPrices` / `mallSettings` | `applyMallPrices` / `applyMallPricing` | `configs/mall.ts`（特殊价 + 统一价，客户端无出厂值） | `shared/mall-seed.ts` → `mall_settings`；特殊价只在表里 | `/mall-pricing` |
| `maps` / `mapTypes` | `applyMapRows` | `configs/map.ts` `maps`、`mapTypeGroups` | `shared/map-config.ts` → `maps` 表 | `/maps` |
| `uiEffects` | `applyUiEffectRows` | `configs/effect.ts` `uiEffects` | `ui_effects` 表 | `/ui-effects` |

### 3.2 几何（两个独立接口，不进快照）

| 接口 | 落库函数 | 落到哪里 | 管理端页面 |
|---|---|---|---|
| `GET /game-config/equip-align` | `applyEquipAlignRows` | `configs/equipAlign.ts`（外观位置 / 缩放 / 手调开关） | `/equip-align` |
| `GET /game-config/equip-in-align` | `applyEquipInAlignRows` | `configs/equipAlign.ts`（内观：衣服对圆盘、武器对第一件衣服） | `/equip-in-align` |

**为什么这两个每次进图都拉、快照只拉一次**：几何是「人眼调一版、立刻要看效果」的东西，
验收动作就是退回选角再进图（场景重载、JS 上下文不重来）；只拉一次会被当成「保存没生效」。
内观还多一条「每次打开角色信息弹窗再拉」（`refreshInAlign()`），因为那一屏不需要重进图。

## 四、`configs/` 现有文件与归属

### 4.1 空壳运行时表（内容全部来自服务端）

| 文件 | 表 | 填充者 |
|---|---|---|
| `level.ts` | `levels` | `applyLevelRows` |
| `title.ts` / `soul.ts` / `rank.ts` | `titles` / `souls` / `ranks` | 各自的 `apply*Rows` |
| `status.ts` | `statuses` | `applyStatusRows`（所有未登记行一律写入） |
| `quest-data.ts` | `questData` | `applyQuestRows` |
| `npc.ts` | `npcs` | `applyNpcRows`（整表重建） |
| `battle.ts` | `combatCalc` | `applyCombatWeights` |
| `monsterRuntime.ts` | `monsterRuntime` / `monsterResource` | `applyMonsterRows` / `applyMonsterPresentations` |
| `mall.ts` | 特殊价 / 统一价（**无出厂值**） | `applyMallPricing` |
| `map.ts` | `maps` / `mapTypeGroups` | `applyMapRows` |
| `equipments.ts` | 七张部位表 / `equipmentSlots` / `equipmentSlotOrder` / 品质文案 | `applyEquipmentData` / `applyEquipmentSlots` / `applyEquipmentQualityLabels` |
| `growth.ts` | 前后缀倍率 / 回收价曲线（`roleMaxLevel` 也由 `growthScalars` 覆写） | `applyEquipmentRules` |
| `drug.ts` | `drugs`（**空数组**，含图标） | `applyDrugData`（整表重建） |
| `material.ts` | `materials`（**空数组**，含图标） | `applyItemBaseData`（整表重建） |
| `items.ts` | `items` 总表 = 装备 + 药品 + 材料的「id → 物品」索引 | `rebuildItemIndex()`（装备 → 药品 → 材料） |
| `skill-data.ts` | `skillData`（**空数组**）+ `oeccupationSkills`（按行派生） | `applySkillData`（整表重建，含职业映射重算） |
| `fashionClothes.ts` | `fashionData`（**空数组**）+ 外观取源规则（`getFashionOut` / `getFashionIn`） | `applyFashionData`（整表重建，含 icon / in / out） |

### 4.2 复核后判定「不搬」（#603 第十三域的结论）

| 文件 | 剩下什么 | 为什么不入库 |
|---|---|---|
| `role.ts` | `occupations`（3 行职业介绍）、移动速度、体型 / 碰撞盒、摇杆与鼠标死区、背包行列、快捷键布局、动作速度倍率 | 职业名的权威副本已在公共数据（生成物 `OCCUPATION_LABELS`）；介绍图路径按职业码可推导（`create_role/tips_<码>`），尺寸是素材量出来的；其余全是手感 / 布局参数（`client/README` 的「表现层」） |
| `monster.ts` | `monsterAI`（普攻间隔 / 停下出手距离 / 待机游走节奏 / 击退时长）、`monsterDefaultSpeedRate` | 动画节奏与手感；服务端 tick 读的 6 个数值已由生成器收进 `MONSTER_AI`（**两端同源，不是两份**）。怪物真正的数值（血量 / 六项攻防 / 掉落）早在 `monsters` 表 |

> 判据沿用项目既定三条：**能按 id 推导的资源路径不入库**、**素材尺寸不是运营数值**、
> **客户端只留资源约定与手感参数**。为了「搬完」而给 3 行 UI 文案建表 + 建页面，
> 收益不抵一处新的漂移面 —— 这一点已写进 `TODO-FOR-USER.md` 等拍板。

### 4.3 客户端自己的东西（与运营数据无关）

| 文件 | 内容 |
|---|---|
| `map.ts` | 资源约定：`mapSrcOf`、Tiled 对象组 / 属性名（**不含**任何玩法数值） |
| `npcClicks.ts` | NPC 点击行为（id → 弹窗）；会引 UI 组件，所以不能进 `npc.ts` |
| `drop.ts` | 掉落物手感：拾取半径、提示节流、散落间距、拾取应答超时 |
| `network.ts` | 服务端地址的唯一来源（按运行环境解析） |
| `texts.ts` | 界面文案（`getText(key, params)`，代码里不写中文） |
| `texts` 之外的 `layout/*`（`hudLayout.ts` 是 barrel） | 界面布局、尺寸、配色 |
| `animation.ts` / `cursor.ts` / `debug.ts` / `loading.ts` | 动画方向下标 / 鼠标指针 / 调试开关 / 加载条 |
| `equipAlign.ts` | 几何的运行时表 + 出厂值回落（快照例外之一） |
| `autoBattle.ts` / `bottomNav.ts` / `smallMap.ts` / `guide.ts` 等 | 面板与人机交互参数 |

> 「`configs/` 不许写中文文案」「布局只走 `layout/*`」「`configs` 与 `types` 不依赖 UI 层」
> 这三条由 `tools/audit-config-leak.cjs` 与 `audit-ui-click-through.cjs` 盯着。

## 五、调用数据的方法都在这几处

| 想做的事 | 调什么 | 在哪 |
|---|---|---|
| 进游戏时把服务端配置全部接住 | `await loadGameConfig()` | `ui/Game.ts` → `ui/utils/net/ConfigLoader.ts` |
| 只刷内观几何（开弹窗时） | `refreshInAlign()` | 同上 |
| 手动把一份快照灌进去（单测 / 调试） | `applyConfigSnapshot(snapshot)` | `configs/apply-snapshot.ts` |
| 单表覆写 | `applyTitleRows` / `applyNpcRows` / `applyMapRows` / … | 各自 `configs/<域>.ts` 或 `apply-snapshot.ts` |
| 读物品 / 装备 | `items`、`getItem()`、`getEquipment()` | `configs/items.ts` |
| 读怪物 | `monsterResourceOf()` / `monsterStatsOrDefault()` / `monsterLabelOf()` | `configs/monsterRuntime.ts` |
| 读 NPC | `npcs.get(id)`、`npcClicks[id]` | `configs/npc.ts` / `configs/npcClicks.ts` |
| 读地图 | `maps` / `mapTypeGroups` / `mapSrcOf` / `mapLabelOf` | `configs/map.ts` |
| 读商城价 | `getMallPrice(good)` | `configs/mall.ts` |
| 算装备战斗力 / 对比 | `equipmentCombatValue(...)`（权重读 `configs/battle.ts`） | `configs/equipments.ts` |
| 算装备回收价（基础件） | `equipmentRecyclePrice(level)` / `getRecyclePrice(equipment)` | `configs/growth.ts` / `configs/equipments.ts` |

## 六、搬迁进度（#603）

已搬完（客户端不再有出厂数据）：`monsterDrops`、`monster-skills`、`status`、`quest`、`achievement`、
`drop`（具名表 + 兜底表）、`battle`（战斗力权重）、`npc`、`mall`（默认售价）、
**`equipments` + `growth`（第九域：装备/槽位/倍率/回收价曲线，含 1080 行装备数据）**、
**`items` / `material` / `drug`（第十域：图标随行入库，物品总表只剩索引）**、
**`skill-data`（第十一域：15 条技能行 + 职业归属 / 击退距离，`oeccupationSkills` 改为派生）**、
**`fashionClothes`（第十二域：20 套时装，含 icon / in / out 资源路径 —— 路径不可按 id 推导，必须入库）**。

**`role` / `monster`（第十三域）：复核后判定不搬** —— 剩下的全是表现层（职业介绍图路径可推导、
尺寸取素材、AI 节奏与移动手感），判据见 4.2。至此 #603 的「运营数据进库」全部收口。

> 第九域的三层切分值得记住：**显示与规则**进 `equipments` / `equipment_slots` / `equipment_meta` 三张表；
> **八项战斗属性**不进表，由 `growth-seed.equipmentStats(level, slot)` 公式算（#590）；
> **几何**（内观锚点 / 外观 8 向）在表里是**出厂值**，工作台结果在 `equip_aligns` / `equip_in_aligns`、每次进图另发。

> 注：成就（`achievements`）虽然也在快照里，但客户端**不落表** —— 成就面板走
> `AchievementStore` + `/achievements/me`（进度与达成状态是玩家数据，不是配置）。这一段属于
> 「发了但没人读」，留着是为了以后要做「成就配置改动即时生效」时不用再改服务端。

**每一域的验收口径都一样**：重新生成 `server/src/shared/game-data.generated.ts` 必须**逐字节相同**
（或差异只在一句注释），否则说明数据在搬迁中被悄悄改了。
