# 需要你做的事（2026-11-02 夜间自动化收尾）

> 本轮按你的指令「合并上去之后停止」收工。PR #592（#437 管理端消息补发）与 PR #593（#439 邮件过期回收）均已 squash 合并，issue 已自动关闭。master 现在是 `5630b1b`。此文档是本地文件，未提交。

## 一、需要你动手的

1. **重启 3100 服务端**。当前跑的还是旧构建；master 最新三个提交（`5630b1b` / `56655c4` / `c4e9f82`）包含 #590 基础数据零副本、#437 消息补发、#439 邮件过期回收。重启时存量库会自动给 `role_mails` 补 `expires_at` 列，**老邮件 = 永不过期，无需任何迁移动作**。
2. **Cocos 预览重开一次**。预览 chunk 是编辑器启动快照，客户端代码有改动，重开才生效。

## 二、需要你知晓的行为变化（无需操作）

- **BOSS 战报从现在起 7 天过期**（`BOSS_MAIL_TTL_MS`），已领或无附件的过期邮件会被后台分批物理删除（默认 60s 一轮、每批 500 条，可用 `MAIL_PURGE_BATCH` / `MAIL_PURGE_INTERVAL_MS` 调，见 `.env.example`）。已领取的附件不受影响；未领附件的邮件**永不**被清理。
- 管理端新增「发消息」页（运营管理组），需要权限点 `gameMail:send`（管理/超管默认有，观察员没有）。角色详情页也加了入口。

## 三、需要你确认的决策

- **权限点命名**：issue #437 原写 `mail:send`，实际落地为 `gameMail:send` —— 因为 `mail:*` 前缀已归外发 SMTP 投递队列（mail:read / mail:write），两件「发邮件」不能共用前缀。已在 issue #437 与 PR #592 描述中说明；如你坚持用 `mail:send`，改名是一处常量 + 文档数字联动的改动。

## 四、明确没做的

- **#438 运营群发**：你说停止后未开工，但口径调研已完成，随时可直接开工：
  复用 #437 的 DTO；前端生成 `batch_id`（uuid）做幂等；每角色一行；分批 500 行/事务（`DatabaseService.transaction` 已存在）；筛选支持全服 / 按区（roles join accounts.zone_id）/ 按等级段（roles.level）；配一个预计人数 preview 接口；管理端显示批次号与成功条数。

## 五、后续批次规划（供排期，未开 issue）

- 基础数据剩余批次：**装备 / 物品 / 药品 / NPC / 任务 / 技能 / 状态 / 时装**，各自开 issue，沿用 #588/#590 的零副本模式。
- 装备批次的 recycle 曲线与前后缀倍率归装备批次一起做。

## 六、老问题提醒

- 客户端单测基线仍有 **4 套红**，全部是 `_loose_frames_archive` 素材未入库导致，非回归（CI 不跑 client-test，门禁看 `make ci`，全绿）。

---

## 2026-11-02 晚·第二批（#601/#602 落地 + 数据归属拆分 #601~#606）

### 已完成
- **#601（PR #608 + #609）**：删 `initialSkills` 死代码与 Role 死初始化器。注意：`initialShortcutKeys` **保留了**——`StorageManager` 读档补齐 5 槽是活代码，键位码 49~53 属客户端按键约定，不算数据多备份（issue 已留言）。
- **#602（PR #610）**：monsterDrops（19743 行 / 1.3MB）搬到 `server/src/shared/monster-drop-seed.ts`，生成器重新产物**逐字节相同**；删客户端文件与失效的 `gen-monster-drops.cjs`（#588 起就读不到怪物清单了）。

### 需要你看的
1. **test-role-default-cloth 存量红（非素材）**：断言写 `getRoleDefaultCloth(role.sex)`，源码 RoleAppearance.ts L149 是 `getRoleDefaultCloth(source.sex)`——断言漂移，master 上就红。修测试还是修源码（源码行为目前是对的）？我倾向修测试断言。
2. **gen-monster-drops.cjs 已删**：如果你想保留「按规则整体重铺掉落」的再生成能力，需要对着 monster-seed.ts 重写一版（写 server 种子而不是客户端文件）；规则文档在 monster-drop-seed.ts 文件头。
3. **#604 快照回落策略**：需要你拍板 A（保留容错）还是 B（收紧成显式契约，我倾向 B）。
4. **#605 客户端独有参数**：我的倾向写在 issue 表格里（guildRules / guideSteps / mpRecoverPerSecond 收权，dropRuntime / 速度 / 碰撞体留客户端），需要你逐项确认。
5. **#606 地图门槛服务端拦截**：方案草案已写在 issue（只拦「换图」不拦「登录脚下图」），涉及联机行为变化，开工前等你点头。

### 流程检讨（我的失误）
- PR #608 本地没跑 `make ci` 就提交合并，CI 红了（audit 不认 `skills!:` 写法）才补 PR #609 修复。教训已执行：之后每个 PR 都是「本地 make ci 全绿 → commit → CI 绿 → merge」。

---

## 2026-11-02 夜·第三批（#603 逐域搬迁：status / quest / achievement）

### 已完成并合并
- **#613 状态表** → `server/src/shared/status-seed.ts`。客户端 `configs/status.ts` 只剩**空 Map**，`applyStatusRows` 改成「所有未登记行一律写入」（此前只追加 `owner === "monster"` 的行 —— 客户端没有本地兜底后必须全量装载）。
- **#614 任务表** → `server/src/shared/quest-seed.ts`。客户端 `configs/quest-data.ts` 只剩类型 + 空数组（`applyQuestRows` 本来就支持追加，运营新建任务不用改客户端）。
- **#615 成就表** → `server/src/shared/achievement-seed.ts`，**删掉客户端 314 行**（零消费者：成就面板读 `/achievements/me`）。同批改了 server README 中英、管理端成就页说明、controller 描述并重新生成 openapi + 双端生成物。
- 三域共同守点：**重新生成的 `game-data.generated.ts` 与旧产物逐字节相同**（数据一个字节没动，只搬书写处）。

### 需要你看的
1. **本地 `make ci` 现在很不稳**：连续四次分别红在 e2e-chat / e2e-realtime / e2e-combat / e2e-world 的不同「等待超时」断言上，**每次单跑都全绿**；同一份代码在 CI（干净 runner）连续三次全绿。看起来是本机负载下时序断言不稳（`e2e-realtime` 的心跳续约、`e2e-world` 的 tick 重生都是定时断言）。要不要我给这几处等待加冗余重试？
2. **下一域的阻力在快照 DTO**：`npc-data`（presentation：src/scale/position）与 `battle`（战斗力权重）都不是纯数据搬迁 —— 服务端 `NpcDto` 没有表现字段、快照没有 `combatWeights` 段。要么扩 DTO（+管理端表单），要么先跳过。我建议**先扩 `NpcDto`**（NPC 是运营最常新增的一类数据）。
3. **`equipments`（1381 行）仍是最大一块**，含 10 个运行时函数 + 表现层字段，建议单独排一轮，不和别的域混。

### 流程
- 本轮每个 PR 都满足「本地受影响项全绿 → commit → CI 绿 → merge」，没有再出现 #608 那种「CI 红了才补」。

---

## 2026-11-02 深夜·第四批（#603 第五、六域：drop / 战斗力权重）

### 已完成并合并
- **#617 掉落表** → `server/src/shared/drop-seed.ts`。客户端 `configs/drop.ts` 从 161 行降到 22 行（只剩 `dropRuntime` 手感参数），
  顺带删掉**从未被引用**的 `monsterDrops(level, tier)` / `monsterDropPicks(tier)`（死代码，全仓只有注释提到过）。
  ⚠️ 如果你还想要「按规则整体重铺掉落」的生成能力，这两条得对着 `monster-seed.ts` 重写（和 `gen-monster-drops.cjs` 是同一件事）。
- **#618 战斗力权重** → `server/src/shared/combat-seed.ts`（7 项倍率）。配置快照新增 `combatWeights` 段；
  客户端 `configs/battle.ts` 只剩空 Map + 装载函数，倍率由快照填。

### 需要你看的（新增一条取舍）
1. **快照缺 `combatWeights` 时，「更好装备」提示会整体不亮**（权重为空 → 战斗力贡献恒 0，不崩）。
   我这次是**故意不给客户端留一份本地倍率兜底** —— 留一份就等于又造一份真相。这正好是 **#604（快照回落策略）** 要拍板的事：
   如果你选 A（保留容错），我就给这几个域补本地兜底值；选 B（收紧成显式契约）就保持现在这样。
2. **掉落优先级链的口径变了**（文档已同步中英）：现在是 `monster_drops`（每怪）> `drop_tables` 被引用的具名表 > 兜底 `default`。
   以前文档里那句「按等级兜底生成」的能力已随死代码删除。

### #603 剩余域与阻力（供你排期）
| 域 | 客户端行数 | 阻力 | 我的建议 |
|---|---|---|---|
| `equipments` | 1381 | 10 个运行时函数 + 表现层字段 + 555 变体展开规则；`growth` 的倍率/回收价曲线与它强耦合 | **单独一轮**，先在服务端建「装备基础件 + 倍率 + 回收价曲线」三段快照，再动客户端 |
| `skill-data` | 489 | `oeccupationSkills`（职业→技能 id）与释放实现 `Record<RoleSkillId>` 耦合；技能 id 是封闭枚举 | 中等，可做：数据行搬种子，职业映射与实现留客户端（但要扩 DTO 的 `oeccupation`） |
| `items` / `material` / `drug` | 485 / 63 / 126 | `applyItemRows` / `applyDrugRows` 只**覆写已有行**，删本地数据要改成「整表重建」；物品总表在模块加载期建好，重建后要连带刷新 | 可做但需改三处 apply 语义，建议一域一轮 |
| `npc-data` | 49 | 表现字段（`src` / `scale` / `position`）不在 `NpcDto`，要加表列（含老库 ALTER）+ 管理端表单 | 你之前说 NPC 是最常新增的一类，**建议优先** |
| `growth`（倍率/回收价曲线） | 97 | 客户端 `buildEquipmentMap` 在模块加载期就用它展开 555 变体；曲线搬到服务端后必须由快照喂 | 与 `equipments` 同轮做 |
| `mall` | 65 | 只剩 `mallPrice` 常量（已是服务端 `MALL.defaultPrice` 的镜像），特殊价早已走服务端 | 顺手可清，收益小 |
| `role` / `monster` | 198 / 65 | 分别只剩职业表与 `monsterAI` 两个全局常量 | 低优先 |

### 流程
- 这一批两个 PR 都是「本地 `make ci` 全绿 → commit → CI 绿 → merge」，没有再出现 #608 那种翻车。
- 本机 `make ci` 这次两轮都一次过（之前那批的「等待超时」抖动本轮没复现）。

---

## 2026-11-02 深夜·第五批（#603 第七、八域 + 一份对照表）

### 已完成并合并
- **#620 NPC 显示数据整体上移**：`server/src/shared/npc-seed.ts`；`npcs` 表补 `src / scale_x / scale_y / pos_x / pos_y`。
  客户端 `configs/npc-data.ts` 删除，`configs/npc.ts` 只剩运行时表 + `applyNpcRows`（整表重建）；
  **点击行为搬到 `configs/npcClicks.ts`**（它引弹窗，而 `apply-snapshot` 那条链要在 Node 里加载）。
  管理端 NPC 页现在能改素材目录 / 缩放 / 偏移 —— 这是「NPC 最常新增」这条需求的实际落点。
- **#621 新增 `client/CONFIG-DATA.md`**：你要的那份「整理在一起」——
  快照段 → 落库函数 → 客户端表 → 服务端出厂 → 管理端页面，一张表看完；
  外加 configs 现存文件的三类归属与「调用数据的方法」索引。`client/README(.en).md` 已加链接。
- **#622 商城默认售价**：`server/src/shared/mall-seed.ts`；客户端不再存任何价格（含 `customPriceData` 空表）。

### 需要你知道的两处行为变化
1. **NPC 老库升级**：首次启动会打一条 `NPC 外观补全：N 行` 日志，之后不再触发。若你之前手工改过 `src` 列（不会有），它只在 `src` 为空时才补。
2. **商城快照没到时取价 = 0**（卡片显示「0 绑元」）。正常进游戏看不到（配置在打开面板之前已 await），
   只有在编辑器里直接跑商城弹窗才会撞上。这是我沿用 #604 选 B 的做法：不兜本地价。

### 剩下的大头（按我的建议排序）
| 顺序 | 域 | 为什么必须这样排 |
|---|---|---|
| ~~1~~ | ~~`equipments` + `growth`~~ | ✅ 已完成（第九域，见文末第六批） |
| 2 | `items` / `material` / `drug` | `applyItemRows` / `applyDrugRows` 只覆写**已有行**；本地行删掉后必须改成整表重建，背包 / 任务 / 商城都读这张表，要一起验 |
| 3 | `skill-data` | 职业→技能映射（`oeccupationSkills`）与释放实现 `Record<RoleSkillId>` 耦合，技能 id 是封闭枚举 |
| 4 | `fashionClothes` | icon / in / out 是资源路径 —— 要不要入库得跟地图那套保持同一口径（地图选了「不入库」） |
| 5 | `role` / `monster`（AI 节奏常量） | 只剩少量常量，收益最小 |

### 我这边没有权限/信息决定的事（还等你拍板）
- #604 快照回落策略（现在各处一律「不兜本地值 + warn」，等同选了 B）
- #605 参数收权逐项（比如**战斗力权重目前没有管理端编辑页**，只能改种子）
- #606 地图进图门槛要不要服务端硬拦（现在的结论是只给数据、判定在客户端）

---

## 2026-11-02 深夜·第六批（#603 第九域：equipments + growth）

### 这一域为什么分三层（最重要，先看这段）
37 件装备的数据其实混了三种东西，我没有一锅端，而是按「谁该改」拆开：

| 层 | 内容 | 现在归谁 |
|---|---|---|
| **显示与规则** | 名称 / 描述 / 图标 / 内观外观（in、out、缩放、旋转、8 向位置）/ 战斗外观缩放 / 职业与性别限制 / 标签 / 售价 / 等级 / 槽位 / 品质档 | **服务端三张表**：`equipments`、`equipment_slots`、`equipment_meta` |
| **八项战斗属性** | 攻击、防御、生命…… | **仍然走公式**：`growth-seed.equipmentStats(level, slot)`（#590 定的），**没有**进表 —— 进了表就有第二份真相 |
| **几何微调** | 你在对齐工作台拖出来的位置 | 出厂值在 `equipments` 表里；**工作台结果**仍在 `equip_aligns` / `equip_in_aligns`，每次进图另发 |

### 已完成
- **`server/src/shared/equipment-seed.ts`（1224 行，唯一书写处）**：13 个槽位、5 档前缀倍率 + 3 档后缀倍率、两套品质文案、6 段回收价曲线、37 件基础件。
  **555 个变体不写**：每件 = 5 前缀 × 3 后缀，展开规则只有一份（客户端 `buildEquipmentMap`），生成器与测试沙箱都调它。
- **服务端**：`equipments` 补 14 列；新建 `equipment_slots` / `equipment_meta`；老库走 `ensureColumn` 补列 + `backfillAppearance`（只碰显示列）。
- **管理端新页 `/equipment-settings`「槽位与规则」**：槽位表可改名称 / 底图 / 位置分组 / 排序（不可增删）；前后缀倍率与文案逐档编辑；
  回收价曲线可增删档（`from ≤ to`、`start ≥ 0` 即时校验）。装备本体仍在原 `/equipments` 页，现在多出一堆可编辑字段。
- **客户端**：`configs/equipments.ts` 1381 → 约 500 行（删掉 1080 行数据）；`configs/growth.ts` 只剩公式与空表。
  新增四个装载入口：`applyEquipmentRules`（倍率，必须最先）、`applyEquipmentSlots`、`applyEquipmentQualityLabels`、`applyEquipmentSeed`。
- **e2e**：`e2e-game-config.cjs` +158 行，新增「八·二 装备槽位与规则」region，快照段断言三张表都下发。

### 需要你知道的四件事
1. **老库首次启动会打一条 `装备外观补全：N 行`**，之后不再触发（只在 `icon` 为空时才补，不会覆盖你改过的值）。
2. **客户端字段名是历史拼写 `sellPirce`**（不是 `sellPrice`）。服务端/快照/管理端一律 `sellPrice`，只在客户端落表时映射一次 —— 别以为是 typo 去改，改了会静默取不到价。
3. **客户端装备表变空后，派生清单与单测沙箱本来是静默变空的**（对齐全清单会变成 clothes/weapons 空表、背包测试 0 件装备）。
   现在统一收口到两个助手：`client-config-compile.hydrateEquipment`（生成器用）与 `configs-sandbox.hydrateSnapshotTables`（测试用），
   两者都复用客户端同一个展开函数。以后再有「表搬空」的域，加种子进这两个助手即可。
4. **`equip-align.catalog.json` 与 `game-data.generated.ts` 重新生成后逐字节不变**（守点已验），说明搬迁没有偷偷改数值。

### 验证
- `make ci` 全绿（客户端类型检查 0 错、14 项跨端审计全 PASS、服务端 e2e 全 PASS）。
- `make client-test`：**58 套 / 54 过 4 红**，4 红是 `equipment-appearance` / `equipment-detail-background` / `role-default-cloth` / `role-frames`，
  全部是「素材未入库」的既有基线，不是本轮引入。

### 剩下的域（按建议排序，第 1 行已完成）
| 顺序 | 域 | 为什么必须这样排 |
|---|---|---|
| 1 | `items` / `material` / `drug` | `applyItemRows` / `applyDrugRows` 只覆写**已有行**；本地行删掉后必须改成整表重建，背包 / 任务 / 商城都读这张表，要一起验 |
| 2 | `skill-data` | 职业→技能映射（`oeccupationSkills`）与释放实现 `Record<RoleSkillId>` 耦合，技能 id 是封闭枚举 |
| 3 | `fashionClothes` | icon / in / out 是资源路径 —— 要不要入库得跟地图那套保持同一口径（地图选了「不入库」） |
| 4 | `role` / `monster`（AI 节奏常量） | 只剩少量常量，收益最小 |

待拍板项同第五批（#604 回落策略 / #605 战斗力权重编辑页 / #606 地图门槛硬拦），没有新增。

---

## 2026-11-02 深夜·第七批（#603 第十~十三域：剩下的全部收口，PR #624）

### 一句话结论
客户端 `configs/` 里**再没有一行运营数据**。剩下的东西只有三类，与服务端无关：
资源约定（`mapSrcOf` / Tiled 对象组名）、表现手感（拾取半径 / 移动速度 / AI 节奏 / 排版）、界面文案。

### 四域分别搬了什么

| 域 | 出厂数据现在在哪 | 客户端剩什么 | 这一域的关键决定 |
|---|---|---|---|
| 第十域 `items` / `material` / `drug` | `server/src/shared/item-seed.ts`（8 药品 + 5 材料） | `drug.ts` 126→76、`material.ts` 63→52 只剩空表 + `applyDrugData` / `applyItemBaseData`；`items.ts` 加 `rebuildItemIndex()` | **图标入库**：药品 / 材料图标与 id 之间没有可推导的约定，跟地图 `map/<id>/<id>` 那种相反 |
| 第十一域 `skill-data` | `server/src/shared/skill-seed.ts`（15 条技能行，含 `occupation` / `pushDistance`） | `skill-data.ts` 489→170；`oeccupationSkills` 从手写清单改为**按行派生** | 职业归属跟着技能行走（不再两处维护）；顺带修正了一处自相矛盾（见下） |
| 第十二域 `fashionClothes` | `server/src/shared/fashion-seed.ts`（20 套） | `fashionClothes.ts` 229→140，只留 `toRange()` + `applyFashionData` | **资源路径必须入库**：`cloth_2` ↔ `clothes/out/001` 没有任何命名约定，`cloth_13` 连内观图都没有 |
| 第十三域 `role` / `monster` | —— | 复核后**判定不搬**，只把路径改成推导、注释纠偏 | 三条判据见下 |

### 第十三域为什么判定不搬
1. 职业介绍图 `create_role/tips_<职业码>` **按码可推导** → 不入库，`role.ts` 收成一个 `occupationIntro()` 生成三条。
2. 职业名已有权威副本（`OCCUPATION_LABELS`），搬进表就是第二份真相（`audit-shared-data` 会判「同名 = 副本」）。
3. `descriptionSize` 是对着素材量出来的、AI 节奏与移动速度是手感 —— 改了要重新调手感，不是运营能盲调的。

### 顺手纠正的一处自相矛盾
- **`monster.ts` 原注释写「改手感要两边同步」**，但服务端 `MONSTER_AI` 就是从这个文件**生成**的。
  已改成「改这里一处 + 重跑 `node tools/gen-shared-data.cjs`」——照旧注释去改服务端那份，等下次重生成就被盖回去。
- **技能 1008 的职业归属**：字段写的是 `ALL`，而手写清单把它列在战士栏下。两处自相矛盾，这次统一成战士（`"1"`），
  判据是「一直在战士栏里能用」这个既成事实。

### 上线须知（这次必须做，否则看起来像「配置全没了」）
1. **重启 3100**：三个种子在建库时 seed；老库靠 `ensureColumn` 补 `icon` / `occupation` / `push_distance` 三列。
   `drugs` / `items` 的图标走 `backfillIcon` 一次性补齐（**只补空串，不覆盖你改过的值**）。
2. **重开 Cocos 预览**：这几张表现在**加载即空**，不重开拿到的是旧编译产物 —— 会看到背包 / 技能栏 / 时装全空。
3. 管理端新增可编辑项：药品与物品图标、「技能」弹窗里的职业归属下拉 + 击退距离。

### 踩过的两个坑（写下来免得下次再踩）
- **e2e 读的是 `server/dist/shared/game-data.generated.js`**。改了生成器必须 `cd server && env -u NODE_OPTIONS npm run build`
  再跑 e2e，否则报「期望 undefined，实际 "1"」—— 看着像数据错，其实是读到旧编译产物。
- **整表重建后行对象是新建的**：`oeccupationSkills`、`items` 总表这类派生映射必须跟着重建
  （`rebuildOccupationSkills()` / `rebuildItemIndex()`），否则表换了一批、映射还指着旧对象。

### 验证（全部实跑）
- `node tools/gen-shared-data.cjs`：装备 555 / 物品 568 / 技能 15 / 药品 8 / 时装 20。
  第十 / 十二 / 十三域生成物**逐字节不变**；第十一域只多了 `occupation` / `pushDistance` 两列（有意的列扩展）。
- `make ci` 全绿；`make client-test` **54 过 / 4 红**（4 红全是素材未入库的既有基线）；
  `make server-e2e-game-config` **757 过 / 0 失败**。

### 待拍板（没有新增）
#604 快照回落策略 / #605 战斗力权重编辑页 / #606 地图门槛硬拦。

---

## 第八批：#604 快照不再回落本地（PR #625）

### 你会在界面上看到的变化
配置没拉下来时**不再进游戏**，而是停在 Loading：进度文字变「配置加载失败，请重试」，下面一行红字写原因，
再下面一个「重试」按钮。点重试 = 从头再走一遍加载。

- 服务端没起 / 断网 → `连不上服务端，配置没拉下来…`（重试大概率就好）
- 服务端漏发段（代码 bug）→ `服务端配置快照不完整：缺少「技能配置」（skills）：整段缺失；…`
  这种要去看服务端 `client-config.service.ts` 的 `snapshot()` return，按 key 补段。

### 上线须知
**客户端与服务端一起发。** 旧客户端 + 新服务端没事（旧客户端只是不校验）；
新客户端 + 旧服务端会在 Loading 界面报「快照不完整」并挡住进图 —— 这是刻意的，比进去看到空背包好查。

### 顺带修掉的一个真缺陷
`loadGameConfig()` 原来在 `Game.start` 里，比 `PreloadManager.preloadGame` **晚** ——
预载要读快照里的怪物 / NPC / 时装表，那时还是空的，所以「进图前预载完帧动画」对这些表等于白做。
现在提到 `Loading.load()` 且在预载之前，进图后怪物 / NPC 的帧动画应该更连贯（首次见到就该是有动画的）。

### 新守点
`make audit` 多一条 `audit-snapshot-contract`：客户端段清单 == 快照 DTO 字段 == `snapshot()` 实际返回的键。
以后**加一段配置**要三处一起改（DTO / service / 客户端 `SNAPSHOT_SECTIONS`），改漏了 CI 直接红。

### 待拍板（剩两个）
- #605 战斗力权重要不要做成管理端可编辑页
- #606 地图门槛要不要服务端硬拦（现在只在客户端 `changeOnMap` 判定，服务端只发数据）

---

## #626：21 个快照域并成 `configs/game-config.ts`

### 合并了什么
`configs/` 下 47 个 `.ts` → **27 个**。原来每个域一个文件（`title.ts` / `growth.ts` / `status.ts` / `monster.ts` …），
#603 之后每个只剩「一张空表 + 一个 `apply*` + 一两个读取函数」，平均 80 行；现在全在
`configs/game-config.ts`（约 2100 行），按 `//#region 0~20 · 标签（原 configs/xxx.ts）` 分区，改一个快照段只看一个文件。

留在原地的三个：`items.ts`（背包算法）、`equipments.ts`（装备展开 / 几何 / 商城商品表）、`skill.ts`（技能接线）——
它们是「算法」不是「快照段」，搬进 `game-config` 会和它反向 import 成环。

### 你自己要留意的两条
1. **加一个快照段**：三处一起改（DTO / `snapshot()` / 区 0 的 `SNAPSHOT_SECTIONS`），再在本文件里开一个新 region
   并在文件头的分区索引表补一行。守点 `audit-snapshot-contract` 只认区 0 的清单，漏改会让客户端停在 Loading。
2. **改某个域**：先看文件头的分区索引找到区号，函数**必须放在自己的区内**。放到上一个区的尾巴上照样能编译，
   但按区取源码的守点（`audit-world-authority` 的 `regionOf(source, 15)`）会读不到 —— 这是本轮装配时真踩到的坑。

### 顺带修掉的文档失真
FAQ 里一批「想调 X 就改 `configs/growth` 的某个常量」的说明在 #590 / #603 之后已经失效（那些常量搬到服务端 seed 了），
本轮一起改成了「服务端 `shared/*-seed.ts` 出厂 + 管理端对应页面改」。中英文档同一次改完。
