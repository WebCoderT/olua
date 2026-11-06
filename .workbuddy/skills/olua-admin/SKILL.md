---
name: olua-admin
description: olua 项目管理端（React 19 + TypeScript + Vite + Tailwind CSS v4，目录 admin/）的开发做法。核心心智模型：界面按权限显隐只是体验，服务端才是权威；接口路径 / 方法 / 实体类型全部由服务端 Swagger 文档生成，禁止手写；页面从共享基件拼装（ui.tsx / Pagination / 弹窗 / Toast），不手写表格样式。涵盖：api 目录的生成物与手写边界（routes.ts 路径表 / models.ts 类型 / endpoints.ts 接口方法 accountsApi adminsApi announcementsApi auditApi authApi mailsApi rolesApi soulsApi statsApi systemApi titlesApi 都是生成物，config.ts http.ts types.ts gameData.ts index.ts 是手写）、地址唯一来源 admin/.env 的 VITE_API_BASE_URL（代码只读 src/api/config.ts）、请求唯一出口 http.ts（请求与响应拦截器 / AbortController 超时 / 统一包裹解包 / ApiError 归一 / ApiError.needRelogin 触发重新登录 / 错误观察者单槽位 / HttpOptions 的 auth 与 silent）、按权限渲染（api/types.ts 的 PERMISSION 与服务端一一对应 + store/session.hasPermission 脏会话兜底空数组即最小权限 + 导航项带 permission 过滤 + 写按钮 disabled + App.tsx 的 RequirePermission 外壳）、共享 UI 组件（ui.tsx 的 Spinner Button Field Input Select Card Badge EmptyState StatCard 与 tableClass 系列、Pagination 服务端分页 10/20/50/100、ConfirmDialog、toastError/toastSuccess）、养成配置页面模式（TitlesPage / SoulsPage：GameConfigDialog 属性整份提交整份替换、价格不进编辑弹窗；GameGrowthListDialog 成长列表弹窗化、KIND_CONF 收敛两种配置的文案与接口适配、拖拽排序乐观更新失败回滚、行内改价；价格唯一显示与修改口 = 成长列表；升级链顺序与等级号解耦）、页面结构（Dashboard / Accounts / AccountDetail / Roles / RoleDetail / Admins / Announcements / Titles / Souls / Mails / Audit / System / MyAccount / Login / Register）、口令管理（AccountDetailPage 的重置密码 + 踢下线、AdminsPage 的重置密码且对自己置灰、MyAccountPage 的自助改密必须用返回的新令牌覆盖会话）、操作日志页（筛选 + 分页 + 展开请求体、动作中文名走 api/types 的 AUDIT_ACTION_LABELS 字典而动作清单从接口拉）、重置口令弹窗 ResetPasswordDialog 的两阶段（确认时前端生成随机口令、成功后只显示一次）、会话变化订阅 subscribeSession 让顶部身份栏跟着刷新、角色运行时数据编辑（KeyValueEditor 编辑装备与技能、背包稀疏格子编辑器含清空背包、buildPatch 对结构化字段整体提交其余只提交改动项）、业务码与展示字典（BIZ_CODE RELOGIN_CODES ADMIN_ROLE_LABELS PERMISSION_LABELS AUDIT_ACTION_LABELS AUDIT_TARGET_LABELS OCCUPATION_LABELS SEX_LABELS ROLE_BAG_AXIS_MAX PASSWORD_MIN_LENGTH formatTime formatTimeFull msToLocalInput localInputToMs）、枚举字段必须收口（as XxxQuery 字段名）、生成类型必须是 type 不能是 interface、新增页面或接口的标准步骤、验证命令 npm run build 等于 tsc --noEmit 加 vite build、提交走 issue + PR + CI 门禁。触发场景：用户说"改管理端页面""加一个管理端功能""后台要能改角色属性""加筛选条件""加批量操作""权限按钮不该显示""登录后跳转不对""管理端类型报错""新接口管理端调不到""按权限显隐菜单""后台重置密码""踢下线按钮""操作日志页""看谁改了什么""改自己的密码""管理端登录被锁""称号配置""战魂配置""成长列表""养成配置""做成分页""改成弹窗""拖拽排序""角色详情太长""做成可视化""用图挑装备/称号/时装""一屏看完""抽个公共组件"。
agent_created: true
---

# olua 管理端（React + Vite）：后台角色 / 账号 / 管理员

`admin/` 与 `server/`（NestJS）、客户端（Cocos 工程，在 `client/`）是**三个平级子工程**，各自有 README 与 FAQ；仓库根只放总 README / FAQ 与跨端 `tools/`。

```bash
cd admin
npm install
cp .env.example .env.development   # 首次：接口根地址在这里（VITE_API_BASE_URL）
npm run dev                        # 开发；npm run build 产出 dist（= tsc --noEmit && vite build）
```

## 一、两条必须记住的边界

1. **界面按权限显隐只是体验，服务端才是权威。** 即使按钮被强行点出来，请求也会被 `PermissionGuard` 拦成 `403` + `30006`。
2. **接口路径 / 方法 / 实体类型全部是生成物，禁止手写。** 改接口只改服务端，然后 `cd server && npm run gen:api`。

## 二、`src/api` 的分工（生成物 / 手写）

| 文件 | 来源 | 干什么 |
|---|---|---|
| `routes.ts` | **生成**（禁止手改） | 路径表 —— 唯一的接口路径来源 |
| `models.ts` | **生成** | 实体类型（服务端 DTO 的镜像） |
| `endpoints.ts` | **生成** | 接口方法：`accountsApi` / `adminsApi` / `announcementsApi` / `auditApi` / `authApi` / `mailsApi` / `rolesApi` / `soulsApi` / `statsApi` / `systemApi` / `titlesApi`（随服务端控制器自动增减，别背清单，以文件为准） |
| `config.ts` | 手写 | 读 `VITE_API_BASE_URL` + `buildUrl` + `API_TIMEOUT`（地址唯一来源） |
| `http.ts` | 手写 | 请求唯一出口（见下） |
| `types.ts` | 手写 | **服务端文档里没有的东西**：`ApiEnvelope` / `PageResult<T>` / `ApiError` / `BIZ_CODE` / `RELOGIN_CODES` / `PERMISSION` / 权限点与审计动作的中文名字典 / 时间与输入框换算。**游戏数据不在这里** |
| `gameData.ts` | 手写（**数据来自接口**） | 游戏数据的唯一查表入口：登录后 `Layout` 调一次 `ensureGameData()` 拉 `GET /admin/game-data`（与客户端快照同形，**源头是库**），索引成几张 Map，之后同步查（`equipmentText` / `skillText` / `itemText` / `soulText` / `titleText` / `rankText` / `occupationLabel` / `sexLabel` / `slotLabel`）；缓存没到回落显示 id 本身 |
| `mapCatalog.ts` | 手写 | **地图名录的进程内缓存**（#573：地图名只在服务端 `maps` 表，而角色详情 / 实体选择器要**同步**读）—— `Layout` 挂载时 `ensureMapCatalog()` 拉一次，地图页保存成功后 `refreshMapCatalog()`；`mapText(id)` 缓存没到时回落显示 id |
| `index.ts` | 手写 | barrel —— **页面 import 统一走 `../api`**，换生成物时页面一行都不用改 |

守卫（在**仓库根**跑）：`node tools/audit-api-generated.cjs`（生成物逐字节一致 + 生成标记 + 路径只在路径表）、
`node tools/audit-api-hardcode.cjs`（地址 / 请求 / 路径的唯一来源，且**唯一来源文件必须带生成标记**）、
`node tools/audit-shared-data.cjs`（公共游戏数据与客户端 configs 逐字节一致 + 每张表齐全非空 + **扫 `admin/src` 抓手抄的同名字典**）。

### 游戏数据：唯一权威是数据库（用户 2026-10-13 定的硬要求，issue #117~#122；#655 收口）

装备 / 战魂 / 称号 / 军衔 / 技能 / 物品 / 怪物的名字与元数据，权威定义只有一处 —— **数据库**
（出厂快照 = `server/data/config-sync.sql`）。管理端**没有生成物可读**：`api/gameData.ts` 登录后
`GET /admin/game-data` 拉一次快照（与客户端 `GET /game-config` 同一份、同一个 `snapshot()`），
之后所有查表都是同步的。代码里没有任何数据副本，`server/src/shared/` 整个目录已删。

**地图不在这一套里（#573）**：地图的玩法配置（名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶）在 `maps` 表，
客户端只留资源约定（`map/<id>/<id>` 目录），页面上的地图名走 `api/mapCatalog.ts`。

- **枚举是例外、必须在两端逐值一致**：职业 / 性别 / 怪物定位的中文名住在服务端 `common/constants/game-enums.ts`
  （客户端 `assets/types/*` 镜像同一批值），管理端按相对路径 import 它 —— 加一个职业码只改一处，两边自动跟着变；
  `audit-shared-data` 会扫 `admin/src` 抓「与枚举同名的字典型定义」（以前这里自己抄过一份 `OCCUPATION_LABELS`）。
- 改数值 / 改文案 → 在管理端页面上改（就是改库）→ `make config-export` 重导快照提交，别人 `make config-import` 拿到。
- 页面显示名字**一律过 `gameData.ts` 的查表函数**，不要自己拼（装备显示名含前后缀、部位归属都在
  `equipment_variants` 表里逐条写好了；等级表不是「下标 = 等级 - 1」而是按 `level` 列查）。
- **dev 模式**要读项目外的枚举文件，`vite.config.ts` 放行了上层目录（`server.fs.allow: [".."]`）；构建不受影响。

## 三、请求层口径（`http.ts`）

- 唯一出口；令牌注入在默认请求拦截器里（`auth: false` 的接口不带）。
- 超时用 `AbortController`；**统一包裹解包**：拿不到 `{code, message, data, timestamp}` 就说明这条链路不是后端给的（网关 502 之类），按业务异常处理。
- 失败统一归一成 `ApiError`（`code` / `status` / `needRelogin`）；页面只写一种 `catch`。
- `ApiError.needRelogin` → 调 `reloginHandler`（由入口接到路由跳转，**http 层不依赖路由**）。
- 错误观察者**单槽位**（重复注册即替换，避免组件重复挂载弹两次）；`silent: true` 时跳过全局提示。
- 业务侧可传的选项统一是 `HttpOptions`（`query` / `auth` / `silent`），**`path` / `method` / `body` 由生成的方法填好**。

```ts
await rolesApi.batchRemove({ ids });                  // body 是结构化对象
await accountsApi.updateStatus(id, { status: next }); // 不是裸值
await authApi.login({ username, password }, { silent: true }); // 表单自己就地展示错误
```

## 四、按权限渲染

- `api/types.ts` 的 `PERMISSION`（与服务端 `common/constants/permission.ts` **一一对应**；`gameConfig:read/write` 养成配置、`account:password` 重置玩家口令、`account:email` 补录 / 查看玩家邮箱、`announcement:*` 公告、`mail:*` 邮件、`audit:read` 查操作日志与 `system:read` 看系统信息是逐个后加的）；
- `store/session.hasPermission`（**脏会话兜底空数组 = 最小权限**）；
- 导航项带 `permission` 过滤；写操作用 `disabled`；`App.tsx` 用 `RequirePermission` 外壳包住页面；
- **导航是三级结构**（`Layout.tsx`，#710 从「组 → 项」细分成「组 → 小节 → 页」）：顶层独立项 `NAV_TOP`（概览）+ `NAV_GROUPS` 四个功能域（运营管理 / 战斗与装备 / 养成与玩法 / 系统管理）+ 其下 10 个小节（账号与区服 / 玩家与社区 / 装备 / 对齐工作台 / 战斗配置 / 世界与表现 / 参数与引导 / 角色养成 / 物品与商城 / 玩法）+ 41 个页面叶子；
  子树里**全部无权限时整棵隐藏**（小节与组都是）；组与小节都可折叠，展开 key = 各级 label 用 `/` 连接（改名 = 那棵子树偏好重置，无损），偏好记在 localStorage `olua-admin-nav-expanded`；路由仍是扁平路径（`App.tsx` 不动），层级只是侧栏的视觉与交互；
  加页面 = 往某个小节里塞一个 `NavLeaf`（`to` / `label` / `permission`），**别为了放不下就新开一个组** —— 先看现有小节语义是否覆盖；
- **不需要权限点的页面**（如「我的账号」）直接挂路由，不进 `NAV_TOP` / `NAV_GROUPS`（它是每个人的私有页，放顶部身份栏更顺手）；
- 新增需要权限的界面：先在服务端加权限点 → 同步 `PERMISSION` → 再在导航 / 按钮 / 外壳上引用。

## 五、页面

| 页面 | 干什么 |
|---|---|
| `LoginPage` / `RegisterPage` | 登录注册（注册需服务端 `ADMIN_REGISTER_CODE`；**第一个注册者自动是超管**） |
| `DashboardPage` | 概览统计（`stats:read`） |
| `AccountsPage` | 账号列表：分页 + 状态检索 + 封禁 / 解封 + 删除 |
| `AccountDetailPage` | 账号信息 + 名下角色概要 + **重置密码** + **踢下线** + **清空该账号全部角色** |
| `RolesPage` | 角色列表：**六维筛选**（关键字 / 账号 / 在线 / 职业 / 性别 / 等级区间）+ 多选 + 批量删除确认框（列出角色名）+「修订」列 |
| `RoleDetailPage` | **一屏看完**的角色详情（见「五点十一」）：左栏一张**只读**「角色」卡（身份 / 货币与经验 / 战斗属性），右栏一张可改的「装备」卡（穿戴槽位 + 时装 + 成长阶位）；技能 / 背包 / 原始数据各自进弹窗 |
| `ZonesPage` | **区服管理**（#314）：清单（含已合并 / 账号分布）+ 开新区 + 合并区。**合并是重操作**（一个事务搬走源区全部账号、世界怪物重排发牌、实时进程世界内存按代际作废），必须二次确认并把代价写进弹窗；区是账号的归属分身，注册时定、平时不变 |
| `AnnouncementsPage` | 公告列表与发布 / 编辑（`announcement:read` 看见、`announcement:write` 改，编辑走 `AnnouncementDialog`） |
| `TitlesPage` / `SoulsPage` | **养成配置**（称号 / 战魂，`gameConfig:read/write`）：服务端分页主列表 + 顶部按钮唤起「成长列表」弹窗。见「养成配置页面模式」一节 |
| `RanksPage` | **养成配置**（军衔 #250）：同上模式，无拖动排序（100 阶天然按阶），主列表带大段 Badge；`GameConfigDialog` kind="rank"（无动画栏、加大段名输入） |
| `GrowthPage` | **养成配置**（成长参数 #256 / #655）：**只剩标量参数一栏**（`roleMaxLevel` / `expGain.*` / `mpRecoverPerSecond` 四个全局数）+ `NumberEditDialog`；升级经验与每级属性搬到「角色等级」页。曲线分段随曲线下架 —— 别再往这页加「一段带动十级」的旋钮 |
| `RoleLevelsPage` | **角色等级表**（#655）：60 行 = 每级的**最终裸属性 + 升级经验**，是战斗结算与客户端等级表的唯一来源。**逐级改，没有曲线** —— 曲线「改一个参数十级一起变」，改坏要半天才发现；逐级之后改第 30 行就是改第 30 级，服务端立刻按新值结算。数字先按字符串收（空串 ≠ 0） |
| `EquipmentsPage` | **养成配置**（装备基础件 #252）：部位 / 等级段筛选 + 分页；**只收基础件**（37 件，变体在客户端按倍率展开）；编辑弹窗只开放等级 / 售卖价 / 八项属性（页面内 `EquipmentEditDialog`，不复用 GameConfigDialog —— 字段差异太大） |
| `EquipmentTiersPage` | **前后缀管理**（#712 / #714）：前后缀**档位定义**（文案 + 属性倍率，1~10 档，`equipment_meta` 单行整份替换；改档数要回「装备变体」页点重建）+ **两张关联棋盘**（前后缀组合 → 边框 / 背景），棋盘每格只是从清单里**选一个 key**。见「五点十六」 |
| `EquipmentVariantsPage` | **装备变体逐件配置**（#655）：555 行 = 37 基础件 × 5 前缀 × 3 后缀，**每行都是最终值**（改一件的 +4 前缀不再连带其余 14 件）。品质文案从 `equipment_meta` 取（改一次全场跟着变，不动 555 行）；不能新建 / 删除 —— 组合由档位定义决定，增删走「重新生成变体」 |
| `EquipmentSettingsPage` | **槽位与规则**（#603）：槽位表 13 行（名称 / 底图 / 位置分组 / 排序，排序同时是背包「一键整理」的部位序）+ 装备规则单行。**槽位 key 不可改**（= `EQUIPMENT_TYPE` 枚举值，客户端按它分表与画底图，改 key 等于改代码）；回收价不在这页（逐条在变体页改 `sellPrice`） |
| `EquipmentAppearanceKindPage` | **装备边框页 / 装备详情背景页**（#714 起是**实体清单**页，两路由 `/equipment-borders` 与 `/equipment-backgrounds` 共用一套编辑器）：清单本体（key + 显示效果 + 可选别名 / 分组）+ 特殊装备绑定（customs）+ **从文件夹同步**（以资源文件夹为准整批增删清单）。保存是**整边替换**（items + assignments + customs 一起提交）。见「五点十六」 |
| `SkillsPage` | **技能配置**（#372）：同表按 `owner` 分两种纪律 —— **角色技能只改**（id 被技能栏 / 快捷键 / 存档引用），**怪物技能（9000 段，`/^9\d{3}$/`）可新增 / 删除**；删被怪物挂载引用中的技能服务端 400 拒。见「五点七」 |
| `StatusesPage` | **状态配置**（#367）：与技能同一张表的姊妹页，角色与怪物同表（`owner` 区分），**只可编辑不可增删**；修正只有三个维度（格挡概率 / 格挡系数 / 防御倍率），**留空 = 不参与（不是 0）** —— 全空即「纯表现状态」；加维度要同时改客户端 `BattleMath`，否则存了不生效 |
| `MonstersPage` | **养成配置**（怪物基础数据 #258 / 掉落 #584 / 行为参数 #751）：关键字 / 定位筛选 + 分页；编辑弹窗分三节（**基础数值**：名称 / 定位 / 等级 / 生命上限 / 六项攻防；**行为参数**：主动攻击 / 检测范围 / 移动速度 / 动作速度覆盖；**资源与几何只读**：icon / 图集 / 偏移 / 身体尺寸），区间字段复用 `RANGE_FIELDS`。**一张怪横跨两张表**：`monsters`（数值 + 定位，改完即时生效，世界播种与伤害结算直读）与 `monster_presentation`（行为参数，服务端 AI 有 1 秒 TTL、**画面表现要重进地图**；几何列只归 `gen-monster-config.cjs`）。`speedRate` 留空 = 不覆盖，全空提交 `{}` = 清空回客户端默认。列表定位列带「主动 / 被动」徽标（无表现行时标「无表现行」），另有「掉落」列（来源徽标 + `dropSummaryText`：`common · 2~5 件 · 12 条` / `内联 3 条 · 抽 1~2` / `兜底表 default`）与行内「掉落」按钮 → `components/drop/MonsterDropDialog`（弹窗自己按 key 拉 `GET /admin/monster-drops/:key` + 具名表清单，写入只有 `PATCH /admin/monster-drops/:key` 一条路）。摘要来自服务端 `drop` 字段，**玩家侧快照不带它**（客户端不结算掉落） |
| `CombatWeightsPage` | **战斗力权重**（#605）：七项倍率决定「一点属性算多少战力」（区间属性按上下限之和、生命按单值、每秒回血不计），战力又是**地图准入门槛的刻度** —— 改这里等于改全服准入标尺。**没有增删**：权重有哪几项由 `computeCombat` 决定，能加一行就是「存了不生效」的假功能。保存后服务端立刻按新倍率重算属性，客户端下次进图拉快照才同步 |
| `NpcsPage` | **养成配置**（NPC 基础数据 #258）：关键字筛选 + 分页；编辑弹窗只有名称 / 对话文案（对话 seed 为空串，客户端暂无消费） |
| `MapsPage` | **地图管理（#571 观测 / #573 玩法配置可改 / #580 可视化 / #667 刷怪区绘制 / #672 NPC 与复活点）**：左侧 11 张图，右侧 = 上半「玩法配置」（可改可存，`PATCH /admin/maps/:id` 落 `maps` 表并进审计）+ 下半 **`components/map/MapCanvas`**（预览图上叠 SVG：刷怪区 + NPC/复活点/碰撞盒，可逐个开关、可「放大」到 72vh、点区域打开 `SpawnAreaForm`、点 NPC 打开点位弹窗）。**刷怪区在图上画**（#667）：切到「绘制刷怪区」模式（`mode="spawn"`，四种模式 `view / spawn / npc / revive` 之一），指针拖矩形（`pointerdown/move/up` + `setPointerCapture`，虚线预览 + 实时尺寸，`Esc` 取消，小于 16px 当没画），松手打开 `components/map/SpawnAreaForm` 填名字 / 怪物（`EntityPickButton kind="monster"`）/ 数量；编辑同一表单，删除也在里面（`ConfirmDialog`）—— **删除路径只留一处**。坐标换算只在 `MapCanvas` 的 `worldBoxOf`（`cx = x + w/2`、`cy = -(y + h/2)`）与 `tiledBoxOf`（反函数），`viewBox` 就是 TMX 像素、`preserveAspectRatio="none"`，屏幕坐标按 `getBoundingClientRect` 各自换算 x/y。**#667 起 TMX 的 monster 组不再是来源**：画布上那层「Tiled 原始矩形虚线」与 `SpawnAreasDialog` 的对照列都删了（没有第二份真相，也就没什么可对）。其余观测块在 `components/map/MapDialogs`（图层 / 点位 / 刷怪区 / 场上怪物 / 对象组 / 数据来源）；**刷怪区越界**由服务端算好后显示（`inBounds/overflow`：弹窗「在图内」列 + 地图上红色虚线 + 卡片 >0 时出徽标）—— 容器 `overflow-hidden` 会把越出 viewBox 的部分裁掉，「区域在图外」在图上表现为「区域不存在」，不能指望眼睛发现。**地图本身仍然不能新建/删除**（一张图存不存在由 TMX 决定，`PATCH /admin/maps/:id` 之外没有 POST/DELETE，`src` 塞进来会被白名单剥掉）。保存成功后要 `refreshMapCatalog()` —— 地图名走 `api/mapCatalog.ts` 的进程内缓存（`Layout` 挂载时 `ensureMapCatalog()`），不刷新的话角色详情与实体选择器还显示旧名字 |
| `MallPricingPage` | **商城定价**（#251）：统一价卡片（单行改价）+ 商品定价列表（部位/关键字/定价状态筛选，商品清单来自 `equipment_variants` 555 行）；未定价行高亮「走统一价」；特殊价 PUT upsert /「回统一价」DELETE —— **全后台唯一允许增删行的定价数据** |
| `FashionsPage` | **时装配置**（#257）：关键字 / 获得渠道筛选 + 分页；编辑弹窗开放名称 / 描述 / 售卖价 / 渠道下拉 / 八项属性（maxHp/hpRecover + `RANGE_FIELDS` 六区间，复用 title.dto 的 ConfigAttributesDto 形状）；icon/inRes/outRes 资源路径用 `IconField` 现挑（#641）；渠道中文名按时装语境另配（值域仍复用 ACQUIRE_CHANNEL） |
| `DropConfigPage` | **掉落模版仓库**（#254 / #661 / #663）：只有具名掉落表卡片组（新建 / 编辑 / 删除，picks 捞取次数 + entries 条目编辑器；「批量添加」走 `EntityPicker multiple` 多选）。条目池是**固定列宽栅格**（`ENTRY_GRID`：序 / 物品 / 权重 / 概率 / 数量 / 删，列头与行共用同一串 `grid-cols-[…]`）；**概率那一格按百分比填**（`EntryDraft.chancePct` 0~100，落库 ÷100），留空 = 必掉。具名表被引用中的行拒删。**每怪掉落不在这页** —— 怪物列表里每只怪自己一行「掉落」（`MonsterDropDialog`），两处列同一份数据只会互相打架。编辑器与弹窗是共用件（`components/drop/DropEditors.tsx` + `components/drop/MonsterDropDialog.tsx`）—— 别再在页面里各写一套三选一 |
| `ItemsPage` | **物品与材料配置**（#255）：**只收 MATERIAL / OTHER 大类**（装备 / 药品字段形态不同，各有自己的表与页）；**没有新建 / 删除**（id 清单固定，被掉落表与脚本引用，启动时 seed 落库）；`type` / `level` 不开放编辑（大类与等级属客户端结构约定）；商城售价不在这页 |
| `DrugsPage` | **药品配置**（#253）：只有编辑（id 清单固定）；使用等级自 #643 起可改 —— 只影响展示与背包排序，**服务端用药不拦等级**（血少时越级吃药是合理操作）；四项回复量是 `effects` 按键求和后的单值，魔法药走百分比、金创药走固定值，同一张表两种口径并存 |
| `QuestsPage` | **任务配置**（#396）：**允许动态增删**（运营内容）；弹窗一次展示整条任务（身份 / 接取条件 / 目标 / 奖励 / 对话）。目标与发布 NPC 一律 `EntityPickButton`，候选走 `catalog` 全量清单（220 只怪一只不少）—— 别退回「拉前 100 行」的老做法（第 101 只之后全显示裸 id） |
| `AchievementsPage` | **成就配置**（#401）：允许增删，但**有玩家成就记录时拒删**（先清记录）；页面标出「累计型 / 状态型」是因为**进度来源不同** —— 累计型由事件流记账（改门槛只影响「还要做多少次」），状态型每次查询现算（把 10 级改成 1 级，所有人立刻可领） |
| `UiEffectsPage` | **特效表现参数**（#594 / #634，`game-config:read/write`）：一族一个页签（升级特效 / 掉落光效），左栏预览右栏参数，改一个数左边立刻重画（未保存也生效）。图集路径是两端约定，所以没有新建 / 删除 |
| `AudioSettingsPage` | **音效配置**（#680）：一个音效项一张卡 —— 文件路径（`sounds/xxx.wav`，**只能英文名**）/ 音量 / 循环 / 启用 + **试听**（按表单当前值播）。路径**入库**（与特效的差别），服务端不查文件存在性，验证靠试听；**分 4 类 tab**（分类随接口下发）、**已下发客户端**（快照 audio 段 + 公开接口）—— 见「五点十五」 |
| `RuntimeParamsPage` | **运行时参数**（#605）：三组原本写死在客户端源码里的数（掉落手感 / 自动战斗与寻路 / 帮会规则）。**按组保存、不是整页一个保存按钮** —— 三组各管一件事，整页提交会让并发编辑的两个人互相覆盖；数字先按字符串收 |
| `GuideStepsPage` | **新手引导步骤**（#605）：推进逻辑在客户端（走到第几步存存档），服务端只存这张有序小表（出厂 6 步、上限 64 步）。**整份保存**：顺序本身就是要改的内容，逐行存会让「上移 / 下移」变成多次请求且中间态可见；任何一步不合法整份 40000 不落库。id 只给日志与单测用，改 id 会让历史日志对不上 |
| `MailsPage` | 邮件投递记录（`mail:read` 看记录、`mail:write` 发信，编辑走 `EmailDialog`） |
| `MailSendPage` | **发消息 / 人工补发**（#437）：单发一封，频道只给 `system` / `reward`（`social` / `combat` 是系统自动产生的事实记录，不许人写）；附件是「预告」，玩家在消息中心点领取才真到手 —— 落库仍走 `GameMailService.send` 同一条口子；附件候选 = 物品总表 + **单独的时装**（时装不在物品表里） |
| `GuildsPage` | **帮会管理**（#388）：只给运营看组织关系（谁建的 / 多少人 / 成员有谁），入帮申请是帮主自己的待办不在这里；改名 / 改公告 / 强制解散，**解散连删成员表**所以二次确认写清代价 |
| `ReportsPage` | **玩家举报**（#398，**只读**）：举报的处理需要「谁改的状态 / 凭什么改 / 能不能申诉 / 处罚落到哪」一整套，半成品的处置按钮比没有更糟 —— 这一刀只把举报摆出来。双方角色名是查询时关联出来的（改名跟着变、删号显示 id），与审计日志同一口径 |
| `AdminsPage` | 管理员列表与改角色 / 启停 / **重置密码**（自己那一行置灰）/ 删除（`admin:manage`） |
| `AuditPage` | **操作日志**：关键字（操作人 / 动作 / 目标 id / 路径）+ 动作下拉（清单从接口拉）+ 目标类型 + 结果 + 时间范围 + 目标 id → 分页表格，行可展开看请求体（`audit:read`） |
| `SystemPage` | 系统信息（部署形态、版本等，`system:read`） |
| `MyAccountPage` | **我的账号**：身份 / 权限点 / 自助改密（不需权限点，任何已登录管理员都能进） |

**口令管理的两个入口，别混**（详见 skill `olua-server` 的底座一节）：

- **重置别人的**（`AccountDetailPage` / `AdminsPage`）：弹 `ResetPasswordDialog` → 前端生成随机口令（只显示一次）→ 对方旧令牌当场全废，他需要重新登录。**「管理员列表」里对自己那一行要禁用**（改自己的密码走「我的账号」，那边会回新令牌续上会话）；
- **改自己的**（`MyAccountPage`）：验原密码 → `authApi.changePassword` → **必须 `saveSession(result.token, result.admin)` 覆盖本地令牌**，否则改完立刻被自己踢回登录页。成功后会 `emitSession`，顶部身份栏跟着刷新（`Layout` 里 `useEffect(() => subscribeSession(setAdmin), [])`）。

**`ResetPasswordDialog` 的两个阶段**：先给一个可「换一个」的随机口令 + 说明后果 → 确认后进「结果」阶段把口令**显示一次**并给复制按钮（服务端只存哈希，关掉就查不到了）。

**`AuditPage` 的两条约定**：
- 动作的中文名只是 `api/types.ts` 里的展示字典（`auditActionLabel`，未登记的原样显示标识符）；**动作清单从 `/admin/audit-logs/actions` 拉**，界面不写死；
- 时间范围用 `<input type="datetime-local">`（本地时间），提交前用 `localInputToMs` 换算；`min > max` 就地拦下不提交。

**`RoleDetailPage` 的两条约定**：
- 结构化字段（装备 / 技能 / 背包）**整体提交**；其余字段**只提交改动项**（`buildPatch`）；
- 装备槽的键**按角色自己数据里已有的键渲染，不硬编码清单** —— 部位表只负责「排序 + 补全空槽」，
  旧存档带了已删掉的部位时那件装备仍要看得见（只按部位表渲染 = 存一次就真没了）。
  值与名字的可视化见「五点十一」：槽位卡、档位卡、背包格子全部来自 `components/entity/`，
  图标 / 名字 / 部位 / 等级门槛一律走 `api/gameData.ts`，页面不拼口径、也不画「id 输入框 + 名字提示」。

**筛选表单与查询分离**：表单状态与「已应用的查询」分开（`applied`），点「查询」才生效；刷新列表要**清空多选**。

## 五点五、共享 UI 组件与页面模式（新页面从这里拼，不手写样式）

**`components/ui.tsx` 是基件**：`Spinner` / `Button`（`tone` + `disabled`）/ `Field`（label + hint 包输入）/ `Input` / `Select` / `Card`（title + description + actions，`dense` 只压内边距）/ `Badge`（`tone`）/ `EmptyState` / `StatCard`，以及表格类名常量 `tableClass` / `theadClass` / `thClass` / `tdClass`。页面表格统一这套类名，深色主题口径只在 ui.tsx 改一处。

**`Card` 的 `dense` 只压内边距**（header `px-5 py-4`→`px-4 py-2.5`、正文 `p-5`→`p-4`），标题 / 说明 / 内容一样不少。
详情页里「四张卡加起来的内边距」往往比内容更吃高度 —— 要一屏放下时先开这个，别去删内容。

**分页统一走 `Pagination` 组件**（服务端分页：只上报页码与条数，翻页由页面重新拉数据）：

- props：`page` / `size` / `total` / `onChange` / 可选 `onSizeChange`（传了才显示「每页」下拉，`PAGE_SIZE_OPTIONS = [10, 20, 50, 100]`）；
- 页面自己存 `page` + `size` 两个 state，**改条数要回第一页**（`setSize` 时连 `setPage(1)`）；
- 「基础数据」类页面（称号 / 战魂）**不要**为了省事一页 100 全量展示——一律接入服务端分页（#239 口径）。

**弹窗模式**：受控开合（`open` + `onClose`），内容自管状态；**每次打开重新初始化**（`useEffect([open, initial])` 重置表单），编辑另一条时不残留上一条；提交回调签名 `Promise<boolean>`，返回 `true` 才由页面关弹窗刷列表。

**提示统一走 Toast**（`store/toast` 的 `toastSuccess` / `toastError` / `toast`），不要页面自己挂浮层；危险操作统一 `ConfirmDialog`。

**资源路径字段一律用 `IconField`**（`components/ImagePicker.tsx` 导出，#641）：

- `<IconField mode="image" rootDir="item" value={form.icon} onChange={…}/>` —— 单图（药品 / 物品 / 装备图标、技能与状态图标、部位底图）；
- `<IconField mode="atlas" rootDir="clothes/out" …/>` —— 一套动画（称号 / 战魂 `/titles` `/war-soul`、NPC `npc`、内观 `clothes/in`、外观 `clothes/out`、技能特效 `effect/skill`、状态特效 `effect/status`、时装三件套）。
- `mode="atlas"` 的「一套」= `rootDir` 之下的**第一段**，所以 `clothes/out/001` 不会拆成 `001/a1` 让运营去选动作。
- **图标 / 动画字段别自己拼输入框 + 弹窗**：还要处理 `anyPickerOpen()` 的 Esc 放行，漏了就是「关选择器顺带把编辑弹窗关了」（弹窗嵌套时两个 Modal 各挂一个 window 监听，外层先注册先收到）。计数在 `components/pickerStack.ts`，`IconField` / `ImagePicker` / `EntityPicker` 各自登记，调用方只问 `anyPickerOpen()`。

**物品 / 装备 / 技能 / 怪物 / NPC 的 id 字段一律用 `EntityPickButton`**（`components/entity/EntityPickButton.tsx`，#648 / #651）：图标 + 名字 + 一行说明的按钮，点开就是 `EntityPicker`（搜索 + 分组 + 网格）。**不许再让运营手填 `drug_hp_1` 这类 id，也不要用 2000 项的原生 `<select>`**：

- `<EntityPickButton value={draft.goodId} options={entityOptions("item")} onChange={…}/>` —— 任务 / 成就奖励、成就「持有物品」条件、邮件附件（邮件是 item + fashion 两份拼接，时装不在物品总表）；
- **掉落条目用 `dropItemOptions()`，不是 `entityOptions("item")`**：装备只列 37 个基础件，555 个前后缀变体的候选被滤掉（掉出来是哪一档由变体表决定，不是靠掉落条目点名 `xxx_p2s1`）。药品 / 材料照旧。多选走 `<EntityPicker multiple onSelectMany={ids => …}/>`（勾若干项一次追加成多行）；
- `<EntityPickButton kind="monster" options={entityOptions("monster")} …/>` —— 任务目标（按类型切 monster / npc / item）、成就「累计击杀」的目标；`*`（任意怪）**不是清单里的行**，要调用方自己塞进候选第一位；
- 任务「发布 NPC」、`talk` 类型目标用 `entityOptions("npc")`（缩略图是图集首帧）；
- 候选清单统一来自 `entity/catalog.ts`（`entityOptions(kind)` 带模块级缓存），**页面不许自己拼候选数组**；
- **别用「列表接口 + size: 100」当候选**：怪物 220 只、物品 2200+ 件，`size: 100` 那套会让第 101 只之后的怪根本选不到（任务页踩过，列表里还全显示裸 id）。固定清单（怪物 / NPC / 物品 / 装备 / 技能）走 catalog 静态清单，只有**可增删**的表（任务、掉落具名表）才该走接口；
- 服务端校验口径比界面宽一档：掉落条目卡的是 `ITEM_LABELS`（装备全量变体 + 药品 + 材料，`itemExists`），界面只放基础件 —— 界面是**子集**，所以能选出来就必定存得进去；反过来（库里留着旧变体 id）仍然读得出名字、也存得回去。
- 怪物名字来自 `monsters` 表（出厂行随快照灌库，管理端可改）：选择器显示表里的名字、**选中值永远是 id**。

## 五点六、养成配置页面模式（TitlesPage / SoulsPage，称号与战魂同构）

养成配置 = 库里的**固定等级序列**（称号 34 级 / 战魂 37 阶 / 军衔 100 阶 / 角色等级 60 行 / 装备基础件 37 件 + 变体 555 行），**只能改、不能增删**（POST/DELETE 接口根本不存在）。称号与战魂两页结构完全一致，改一处要想着另一处；军衔 / 角色等级 / 装备各按自身字段形态复用或另起弹窗（见页面表）。

**主列表**：服务端分页（`Pagination`，10/20/50/100）+ 「编辑」按钮弹 `GameConfigDialog` + 顶部「成长列表」按钮弹 `GameGrowthListDialog`。**主列表不显示价格**（#232/#234：价格唯一显示与修改口 = 成长列表）。

**`GameConfigDialog`（编辑弹窗，两 kind 共用）**：

- 属性八项全部展示、全部回填，**整份提交、整份替换**（服务端口径），没有只改一行的快捷路径——避免「以为只改攻击结果把防御清零」；
- **弹窗不提供价格输入**：提交时价格原样带回当前值（页面侧写死 `bindGold: editing.bindGold`），弹窗保存绝不碰价格；
- 渠道下拉仅称号出现（战魂没有渠道概念）。

**`GameGrowthListDialog`（成长列表弹窗，两 kind 共用）**：

- 成长列表 = 独立于主列表的「升级链」视图，**顺序与等级号解耦**（后端 `upgrade_order` 列）；称号按渠道进出（改成「称号升级」自动追加尾、切走清序号价格保留），战魂 37 阶全量；
- 顶部按钮唤起弹窗，**每次打开现拉数据**（不被主列表编辑弄脏），页面只管开关；
- **拖拽排序**：原生 HTML5 drag（`draggable` 行 + `dragFrom` ref），**乐观更新**——先改本地顺序再调接口，失败回滚重拉；重排接口是**整串提交**（`reorder({ levels })`，levels 必须与集合完全一致）；
- **行内改价**：每行价格输入框 + 保存按钮（未改动时禁用），保存调 `update(level, { bindGold })`；
- 观察员（无 `gameConfig:write`）可看顺序与价格，拖动与改价都禁用（`canWrite` 一个开关收敛）；
- **两种配置的差异收敛在 `KIND_CONF`**：文案（等级/阶数、价格/消耗）+ 三个接口适配函数（`fetch` / `reorder` / `updatePrice`）。新增第三种养成配置时扩展 `KIND_CONF` 即可，弹窗主体不用动。

## 五点七、可增删与「挂载」型页面（SkillsPage / MonstersPage，#372）

养成配置里有两处**不是「只改不增删」**，页面形状因此不同，别照着上面那套硬套：

- **技能页（`SkillsPage`）**：技能同表、按 `owner` 分两种纪律 —— **角色技能只改**（id 被技能栏 / 快捷键 /
  存档引用），**怪物技能（9000 段）可新增 / 删除**。做法：行内「删除」只对 `owner === "monster"` 渲染，
  弹窗 id 用 `/^9\d{3}$/` 前端预校验（服务端 DTO 同一口径）；删被怪物挂载引用中的技能会被服务端 400 拒掉
  （提示只能靠请求层统一报错，页面别自己猜）。
- **怪物页（`MonstersPage`）的「技能」弹窗**：挂载关系独立于技能表（一个技能可被多只怪共用，挂在技能行上
  会复制两份并漂移）。**提交是整份替换**（`PUT /admin/monsters/:id/skills`）——弹窗里删掉一行就等于解绑，
  所以每次打开都现拉 `listSkills` + 候选池 `skillsApi.list({ owner: "monster" })`，候选池 = 全量减已挂。
- 两个弹窗都遵守同一条：**数字字段用字符串承载**（空串 = 用默认值），提交前统一校验，
  别让「空输入」静默变 0（`cooldown` 留空要表达的是「用技能自身的冷却」，不是 0 秒）。

## 五点八、可视化比对工作台（EquipAlignPage，#509）

不是「表单页」也不是「配置页」：它把一批**图片按语义叠在一张 canvas 上**给人眼比对，再把结果导出成
配置。形状与纪律都跟前面几节不同：

- **数据从哪来**：客户端的 `configs`（管理端 import 不了那些 .ts，它们 `import { Vec2 } from "cc"`）→
  `tools/gen-equip-align-catalog.cjs` 用 cc 垫片 + tsc 编译出值，快照成
  `admin/src/data/equip-align.catalog.json`。**这是派生清单，不手改**；`audit-equip-align-catalog.cjs`
  重生成后逐字节比对（清单过期 = 页面拿旧值给你调、导出写回，第二次悄悄覆盖第一次）。
- **几何必须与游戏同一套语义**：节点框 = `spriteSourceSize`（锚点居中），内容 = `textureRect`，
  内容中心 = 节点中心 + `spriteOffset·scale`（plist 与引擎 `SpriteFrame.offset` 同号同值、y 向上），
  屏幕 y 向下取反。页面自己发明第二种摆法 = 「页面调好了、游戏里歪」。
- **素材要同源**：`getImageData` 量轮廓（alpha>200 的真实轮廓，不是裁剪框 —— 裁剪框含影子）要求
  plist/png 与页面同源。生产走 `admin/nginx.conf` 的 `/game-resources/` 反代 game 容器，开发走
  `vite.config.ts` 的 `gameResources()` 中间件；**同一个 URL 前缀**，页面里不要写环境分支。
- **`fetch` 只能出现在 `src/pages/equipAlign/assets.ts`**：`audit-api-hardcode` 只放行这一个文件
  （读静态素材），页面里直接写 fetch 会被判成「请求绕开 `http.ts`」。
- **「本机上有什么」不许进快照**：`client/assets/resources/` 是 gitignore 的，清单带 `hasAsset`
  会让逐字节守点在 CI 上必然假红 → 运行时 `probeAtlas`（HEAD，只有 403/404/410 才算缺）。
- **改语义要渐进**：武器的 `outPositions` 原本是「对自动算法的微调」，工作台直接写绝对值等于把它们
  全推到原点 → 加 `outManual` 标记，勾了才走绝对位置，没勾继续走运行时算法。
- **保存直连服务端**（#513）：位置存 `equip_aligns`（`PUT /admin/equip-aligns/:id` 整份覆盖、
  `DELETE` = 回到出厂值且**幂等**），客户端进游戏拉 `GET /game-config/equip-align` 后按 id 覆盖本地几何。
  所以流程是**调 → 保存 → 刷新客户端**，不需要重新打包。
- **三份数据的优先级**：页面临时改动（localStorage）> 服务端已保存 > `catalog.json`（出厂值）。
  少了中间那层，第二次进页面会把上次调好的位置当成没调过；`baseOf(item) = saved[id] ?? item.base`
  是页面里唯一的基线来源（`equipAlign/saved.ts` 的 `useAlignStore`）。
- **`fetch` 只有两个口子**：`equipAlign/assets.ts`（读静态素材 plist/png）与 `equipAlign/saved.ts`
  （走生成的 `equipAlignsApi`）。`audit-api-hardcode` 按文件放行，页面里直接写 fetch 会被判成
  「请求绕开 `http.ts`」。
- **导出 JSON 只剩一个用途**：备份 / 把定稿烧进出厂配置（`tools/apply-equip-align.cjs` 写
  `client/assets/configs`，只改几何字段、注释缩进保留、2 位小数）。**它不是主流程** ——
  别再把「导出再跑脚本」写进用户文档。页面只改配置，**不碰角色存档**。
- **审计目标类型是派生来的**：`common/decorators/audit-target.decorator.ts` 的
  `AUDIT_TARGET_TYPES` 是唯一来源，`@AuditTarget` 的类型与查询筛选的 `@IsIn` 都从它推导 ——
  加新类型只改那个数组（曾经两处各写一份，查询侧停在 5 种，后面全筛不出来）。

## 五点九、内观工作台（EquipInAlignPage，#523）：同一套路，两个不同的基准

角色信息弹窗里那**一个**朝向（不是 8 方向）。形状复用五点八，差异只在基准与数据：

- **一张大视图 + 叠层，不是 8 宫格**：内观只有一个朝向，格子的概念在这里没有意义。
  逻辑拆成 `pages/equipAlignIn/{model,render,saved}.ts`，`atlas.ts` / `assets.ts` / `model.ts` 的
  通用部分从 `equipAlign/` 复用 —— 别把两套几何算法抄成两份。
- **衣服的基准是弹窗背景上的圆盘**：底图画真实 `personal-information-bg`，圆盘中心 / 半径由清单
  下发（`inShow.plate`，从原图 858×908 实测换算，`center (-82.5,-149.5) / r 90`）。
  这组值是**量出来的**，注释里必须写「换背景图要重测」—— 没有任何守点能替你验它。
- **武器的基准是第一件衣服**（`inShow.baseClothKey`，实为 `cloth_1`）：调武器时固定叠一件 0.5 透明
  的参照层 + 它的轮廓与手位十字，不跟当前选中项变。初值按轮廓算握持点（0.52/0.52）、高度 ×1.15，
  与客户端 `placeInShowWeapon` 同口径但用 alpha>200 的不透明轮廓（影子不参与）。
- **两张表两套接口，不要合并**（`equip_in_aligns` / `/admin/equip-in-aligns`）：字段形状不同只是表象，
  真正的理由是**重置必须互不牵连**（e2e 钉住「存外观 → 重置内观 → 外观行还在」）。
- **`inManual` 是短路开关，不是备用值**：内观武器的位置原本由 `alignWeapon()` 按当前衣服现算，
  直接写绝对值等于「保存完就被算法覆盖」。勾了才走绝对位置 —— 缺省仍自动，渐进不砸存量。
- **手调必须「人一动就勾上」，而且保存时强制勾上**（#527）：没勾的武器行客户端**根本不读**，
  于是「拖好了 → 保存 → 服务端有行 → 游戏里一动不动」，每一层都看不出错。
  所以手势（拖动 / 滚轮 / 方向键 / 数值输入）走 `patchUserGeometry` 自动置 `manual = true`，
  写库那一层（`saved.ts` 的 `save`）再按 `weapon:` 前缀兜一次 —— 页面可以改，
  但**客户端会不会读**这件事不能靠「用户记得勾」。回到自动算的唯一语义是**删行**（`还原本件`）。
- **内观图集是另一种拼法**：外观是 `<dir>/stand/stand.{png,plist}`，内观是 `<dir>/in.{png,plist}`
  （路径本身即基名）。`assets.ts` 里 `inAtlasUrls` / `loadInAtlas` 与外观那套并列，别硬套 `/stand/stand`。
  取帧用 `firstFrameName()`（按名字排序取第一个**非空**帧 —— 空帧是 1×1 占位）。
- **没有裸模内观素材**：未穿衣服时客户端不画身体，所以 id 形态里没有 `role:*`（服务端用
  `equipInAlignId` 正则挡掉，e2e 用 `role:1` → 400 钉住）。

## 五点十、版式：整页一屏，超出只让**那个区域**滚

后台骨架（`components/Layout.tsx`）不是「整页往下滚」，而是**外壳锁死一屏 + 三个区域各自滚**：

| 区域 | 行为 |
|---|---|
| 外层 `<div>` | `h-screen overflow-hidden` —— 文档高度恒等于视口（`documentElement.scrollHeight === clientHeight`） |
| 左侧 `<aside>` | `overflow-hidden` + 标题 `shrink-0`；里面 `<nav>` 是 `min-h-0 flex-1 overflow-y-auto`，**42 个叶子（概览 + 四个功能域 / 10 个小节）全在这条侧栏里滚** |
| 顶栏 `<header>` | `shrink-0`，永远可见（不随内容滚走） |
| 内容 `<main>` | `min-h-0 min-w-0 flex-1 overflow-y-auto`，页面内容再长也只滚这一块 |

三条容易写错的地方：

1. **`min-h-0` 是必需的**：flex 子项默认 `min-height: auto`，会被内容撑到自然高度，`overflow-y-auto`
   就永远不触发 —— 表现为「明明写了 overflow，整页还是越滚越长」。`flex-1` + `min-h-0` 才是「占满剩余高度」。
2. **换页面要手动把 `main` 滚回顶部**：滚动容器从文档变成了 `main`，浏览器「换 URL 自动回顶」管不着它。
   `Layout` 里按 `location.pathname` 做 `mainRef.current.scrollTo({ top: 0 })`，否则从长列表点下一页会停在半空。
3. **当前导航项要滚进视野**：菜单一屏放不下时，直接进 `/system` 看不到自己被高亮在哪。
   当前项所在分组会先自动展开，再由 `NavLink` 选中自带的 `aria-current="page"`
   按它的矩形与 nav 的可视矩形做「nearest」微调（不把整列甩到顶）。

新增页面只要遵守一条：**根元素用 `flex flex-col gap-4`，别写 `h-screen` / `min-h-screen`**
（那是给登录 / 注册这类独立整页用的）。需要「页内某块自己滚」时才加 `max-h-* + overflow-auto`
（现状：弹窗 `max-h-[90vh] overflow-y-auto`、两个对齐工作台的侧边列表 `max-h-[520/560px] overflow-auto`）。

验证不看代码看实测（探针 `/tmp` 脚本口径，量三个数）：文档 `scrollHeight === clientHeight`、
`nav.scrollHeight > nav.clientHeight`（1440×620 下必成立）、`main.scrollHeight > main.clientHeight`，
再滚 `main` 断言 `header.top` 与首个导航项 `top` 不变。

## 五点十一、可视化实体组件层（`components/entity/`，#562）

「装备 / 物品 / 技能 / 地图 / 时装 / 称号」这些**游戏内容**在后台一律用图挑，不写 id 输入框。
这一层是四段拼起来的，**上层只认识 `catalog` 的数据形状**：

| 层 | 文件 | 职责 |
|---|---|---|
| 目录 | `entity/catalog.ts` | `entityOptions(kind)`（`kind` = equipment / item / skill / drug / fashion / map / **monster** / **npc**）/ `entityLabel` / `entityNote` / `entityImage`（单图 or 图集首帧）+ `levelOptions(kind)` / `levelLabel` / `levelNote` / `levelImage` / `levelDescription`；模块级 `Map` 缓存，**数据只从 `api/gameData` 取** |
| 原子 | `entity/EntityImage.tsx` | 单图 / 图集首帧 / **空值虚线方块**（不画「无图」占位：未激活、没穿时装是正常状态，画成缺资源会让人去找那张图） |
| 卡片 | `entity/EntityCard.tsx` | 一张可点卡（图标 + 主标题 + 副标题 + 角标），空值画虚线、有值右上角 `×` 清除 |
| 选择器 | `entity/EntityPickerList.tsx`（无壳）/ `entity/EntityPicker.tsx`（`Modal` 外壳） | 搜索 + 分组 chips + 网格；一次最多画 120 条，底部「共 N 项，已画 M 项」+ **「再显示 N 项」**（分组救不了「普通怪」这种两百只的组）；开着时登记到 `pickerStack`（Esc 放行） |
| 字段 | `entity/EntityPickButton.tsx` | 「图标 + 名字 + 一行说明」的行内按钮，点开即选择器（#648）——**页面里的物品 / 装备 / 技能 id 字段一律用它**，别再写 `Input` 或 2000 项原生 `select`；值不在清单里标黄「清单里没有这个 id」 |
| 业务 | `entity/EquipSlots.tsx` / `LevelLadder.tsx` / `SkillList.tsx` / `BagGrid.tsx` | 部位槽位 / 档位阶梯 / 技能行 / 背包网格 |

复用它要记的四条：

1. **`EntityPickerList` 根节点必须 `h-full`**：父级给了 `flex-1` 而自己不撑满时，列表按内容自然高度长出去、压到底部按钮上
   （`overflow-y-auto` 因此永远不触发）。这是「弹窗列表糊到按钮上」的唯一根因。
2. **候选要按「业务约束」过滤，但要给脏数据留路**：装备槽默认只列本部位（服务端会校验，列别的等于给一个必被拒的操作），
   部位表里**根本没有**这个槽（旧存档脏键）时才退回全量；合法但客户端没配装备的部位（`other1`/`other2`）
   给空列表 + `emptyHint` 说明，别放开成全量。
3. **排序按「同款聚在一起、从普通到超神」**：装备 id 的 `_pXsY` 是变体段，先按基础件名字排、再按 `p/s` 序号排。
   只按 id 字典序排会把「超神的…」全堆在第一屏，运营根本找不到那件普通的。
4. **`item` 的 label 优先用 `equipmentName`**：装备变体在 `ITEM_LABELS` 里同名（15 个都叫「唯一深爱(衣)」），
   拿总表的 label 会让选择器里一片同名。

**角色详情的一屏版式**（1440×900 实测 `main.scrollHeight === clientHeight`）：

- 左窄栏 340~420：**一张只读的「角色」卡**，三段用 `border-t` 分隔 ——
  身份（头像按**职业 + 性别**取 `avatars/<occ>-<sex>.png`；所在地图预览图是 **`.jpg`**）/
  货币与经验 / 战斗属性（`<RoleAttributesCard bare />`）；
- 右宽栏：**一张可改的「装备」卡** = 穿戴槽位（有装备用大卡、空槽压成一行小按钮）+ 分隔线 +
  「时装与成长阶位」（`EntityCard` + 三个 `LevelLadder compact` 并排一行）；
- 技能列表、7×11 背包网格、原始 JSON 各自进 `Modal`（弹窗里有草稿 `draftSkills` / `draftBag`，
  点「保存并关闭」才 `save({ ...form, draft })` 落库 —— `setForm` 还没生效就调保存会拿到旧表单）；
- 顶部一行入口按钮（技能 N / 背包 N/M / 原始数据 / 返回 / 在线 / 删除），底部保存条。

**「这张卡不允许改」要写成纯文本，不是禁用态的输入框**（用户 2026-11-01 定：身份 / 货币 / 属性只读，
装备卡仍可改）。灰输入框看起来像「没权限」、会让人去找那个能解锁的开关；纯文本才是「这里本来就不改」。
落成结构：`ReadOnlyValue`（标签 + 值，`tabular-nums`）+ `EntityImage` 画地图小图，卡里 `input/select`
数量 = 0 —— 这条可以直接断言（`main section` 里按标题取卡片，数 `input,select,textarea`）。

三个高度陷阱：**属性别在窄栏用表格**（三列表头会折成「服务端重 / 算」，`406 ~ 550` 也折行，
10 行吃掉 300px；`bare` 那档走竖排列表，同样宽度只要一半）、**空槽别用大卡**（13 个部位里 11 个常年为空，
全用大卡平白吃四行）、**四张卡的内边距比内容更吃高度**（`Card dense`）。

**弹窗内容也要紧凑**（技能 / 背包，用户 2026-11-01 追加）：

- 技能列表：**双列**（`repeat(auto-fit, minmax(280px, 1fr))`）+ `EntityCard compact`（序号跟在名字前，
  不再独占一行）+ 右侧窄等级框 —— 12 个技能从 12 行变 6 行；
- 背包网格：格子**封顶 46px**（`repeat(cols, minmax(28px, 46px))` + `justifyContent: start`），
  不要 `1fr` 撑满 —— 撑满 720 时 7 行就是 455px 高；
- **`Input` / `Select` 的基础类带 `w-full`**（`CONTROL_CLASS`），再写 `w-11` / `h-8` 是同一属性的冲突，
  谁生效取决于 CSS 生成顺序 —— 实测把 `flex-1` 的技能卡挤成 **10px** 宽（文字全被 truncate 掉）。
  要限定宽度就套一层定宽容器，别跟基础类抢同一个属性。

**属性面板那一列叫「存档旧值」，不叫「客户端上报」**：客户端从 #541 起不再计算属性，
每次写档由 `applyAuthoritativeAttributes` 现算覆盖 `combat` / `maxHp`，客户端只是把下发值抄回来。
所以差异的含义是「**存档旧了**」（配置漂移 / 某次改动没触发重算），不是「客户端说了算」、更不是作弊；
只在**与重算值不同**时才把旧值摆出来（一样的时候它没有信息量，窄栏每行多一个数字就挤一分）。

## 五点十二、「看此刻」的监控弹窗（`components/map/MapMonitor.tsx`，#665）

后台绝大多数页面是「读配置 → 改 → 存」，少数页面要看**运行时状态**（实时地图监控：怪物在哪、
谁在图里、刚才谁打死了什么掉了什么）。这类页面有四个不属于增删改的坑：

1. **轮询，不加第二条 WS**：`POLL_MS = 1200`（服务端 1 秒采一次）。监控是「看」不是「玩」，
   多一条实时连接就多一套鉴权 / 重连 / 跨域；`Modal` 关掉就停表，别挂在页面级。
2. **轮询依赖的值走 `ref`，不进 effect 依赖**：`cursorRef` / `zoneRef` / `pausedRef` ——
   放进依赖数组会让**每次响应**都重建定时器（响应本身又触发渲染），表就再也走不到 1.2 秒。
3. **陈旧必须写在脸上**：`staleMs > 5000` 就换成 `Badge tone="amber"`「采集已停」+ 底部
   「最后采样 N 秒前」。没有这一条，「停更十小时」和「图里什么都没有」在页面上长得一模一样 ——
   而运维会据此判断「这图是不是空的」。
4. **事件流别抢用户的滚动**：自动滚到底只在「他本来就在底部」时做（`stickBottom = scrollHeight - scrollTop - clientHeight < 24`），
   上翻查看历史时来了新事件不能把他弹回底部。

#745 把文字流从两类事件扩到六类（击杀 / 伤害 / 追击起止 / 怪物技能 / 普攻 / 刷新）之后又多了三条：

5. **筛选放上层，不要塞进列表子组件**：底栏与流头都要显示「显示 N / 共 M 条」，
   两处各自过滤必然出现「底栏说 12 条、流里只有 8 条」。同时**筛选不改游标** ——
   关掉某一类只是显示层的事，拉取仍混着拉（改了游标就等于把被筛掉的事件永久丢弃）。
6. **一秒内可能连发四条**（普攻 → 掉血 → 目标倒下 → 结束追击）：时间显示到**毫秒**，
   并在时间列下方给「与上一条的间隔」（`+0ms` / `+3ms`）。只显示到秒时，这四条看起来是同时发生的。
7. **聚焦按实例 id，且换图必须清**：点图上的怪 → 只看它的日志（它加白色虚线外圈、其余退到 30%）；
   `instanceId` 只在同图同区唯一，切图 / 切区 / 重开弹窗不清掉，就会「筛出来永远是 0 条」。
   详情行里的数值口径由服务端保证自洽（`hpBefore - hpAfter === amount`），页面**不要自己算差值**。

另一半是**坐标口径**：服务端给世界坐标（原点左上角、y 轴向上），画到 `<img>` 上的 SVG 要 `y = -worldY`，
与 `MapCanvas` 里刷怪区的换算必须是同一套（两处不一致 = 点位与区域错位，而且看起来都很「正常」）。
底图用 `gameResUrl(mapPreview(mapId), "jpg")`，`<svg preserveAspectRatio="none">` 铺满，
半径按 `width / 150` 缩放（写死 40 在 8192 的图上只有半个像素）。

## 五点十三、在图上改点位（`MapCanvas` 五模式 + 拖动，#672 / #676）

刷怪区 / NPC / 复活点 / 碰撞盒四样都在**同一张预览图**上改，所以画布不再是「一个绘制开关」，而是
`mode: "view" | "spawn" | "npc" | "revive" | "collision"`。四个教训与引擎无关，纯粹是「在 SVG 上做编辑器」：

1. **「空白处按下」挂垫底的透明 `<rect>`，不要挂 `<svg>`。** 挂 svg 时点到子元素会**双触发**
   （子元素 handler 先跑，父元素那次渲染还看不到「已被子元素处理」的标记，靠 ref 打补丁只会越补越多）。
   垫一层 `fill="transparent"`（`fill="none"` 不收事件）铺满 viewBox，子元素天然优先。
2. **`pointOf(event)` 的基准必须是 `svg.getBoundingClientRect()`。** 用 `event.currentTarget` 时，
   点在 `<g>` / `<circle>` 上拿到的是那个小圆的包围盒 —— 拖动坐标会算到图外，而且看不出是哪一步错的。
3. **`pointerup` 里先判位移，再决定「点击」还是「提交」**（阈值 `dotRadius * 0.5`）。点位模式下
   「点一下已有点」的语义就是「拖了 0 像素」，所以 `PointDot` **不能**再挂 `onClick` —— 两个入口会各开一次弹窗
   （`draggable` 与 `openOnClick` 是两件事：编辑模式只给前者，查看模式只给后者）。
4. **编辑模式下把刷怪区的 `pointerEvents` 关掉。** 否则「在刷怪区里点一下放 NPC」会先弹开区域表单。
   同理 `spawn` 模式里点位也不吃事件。

复活点**没有表单**：它只有一个坐标，所以「点它」的下一步是「切到能拖它的模式」，不是弹一个两个数字的框
再让人关掉。清除单独一个按钮（`DELETE /revive-point` 幂等，连点两次不报错）。

坐标仍然只走两个口子：`tiledPointOf` / `worldPointOf`（点）、`tiledBoxOf` / `worldBoxOf`（矩形）。
**页面不重算越界**：`inBounds` 由服务端按地图尺寸算（容差 1px），页面再算一遍就是第二个口径；
同图同 NPC 唯一也是服务端的唯一索引（页面先查一遍只是为了当场说话，判据必须与服务端一致）。

## 五点十四、碰撞盒：越界是合法的，「整块在图外」才是信号（#676）

碰撞盒（`map_collisions`）与刷怪区长得一样，但**判据完全相反**，这一节记的就是这个反差：

1. **不许做「在图内」判定**。每张图四面围墙本来就画在图外（`-64` 起、宽 8320），那是「把玩家
   关在图里」的手段。拿刷怪区那套「越界就拒」的判据套上来，第一张图开局就 4 个错 ——
   判据错了比没有判据更糟。服务端只校验「宽高 ≥ 1px」（碰撞盒可以是一条贴墙的缝，
   不能拿「区域起码 16px」去卡它）。
2. **要标的是「整块在图外」**（`fullyOutside`）：画面上完全看不到、对游戏毫无影响，却会一直躺在
   列表里。判据是「四条边里有一对完全错开」，两条 y 方向的口径**最容易写反**：
   图占 `y ∈ [-H, 0]`，所以「在图上方之外」是 `bottom >= 0`、「在图下方之外」是 `top <= -H`
   （写成 `top <= 0` / `bottom >= -H` 会让 0 号图 99 个里 97 个亮红灯，而且不报错）。
   `map.service.collisionDtoOf` 是唯一算它的地方，测试用「图内 / 半截在外 / 整块在外」三条同时钉。
3. **不做拖动**。拖动一个「可能延伸到图外」的大矩形要处理「抓住框内哪一点」与「指针出了 viewBox
   怎么算」两件事，收益只是省两次坐标输入。所以：画布上拖 = 新建，点已有 = 开表单填四个数
   （表单里带 Tiled 口径对照 + 地图范围提示 + 「整块在图外」的 amber 提示）。
4. **`tiledBoxOf` 收结构类型**（`{ cx, cy, w, h }`），别为碰撞盒再写一个：刷怪区与碰撞盒是同一个
   矩形换算，两份迟早分叉。`MIN_COLLISION_DRAW_PX = 4` 单独一个阈值 —— 刷怪区那个 16 对碰撞盒太大。
5. **迁移与删除工具都要能重跑**：`db:migrate-map-collisions`（幂等判据 = 「这张图已有行则跳过」，
   没有天然唯一键，可能有两个同位置同尺寸的盒子）+ `tools/strip-map-objects.cjs`（删 TMX 的
   `<objectgroup>`，支持 `--dry` / `--dir`）。顺序错了就是「搬出 0 行」：先迁点位 → 再迁碰撞 →
   再删对象组 → 再 `import-map-resources` 刷 content → 最后 `config-export`。

## 五点十五、音效配置：路径入库，靠「试听」验证（#680 / #685）

音效页（`/audio`，`AudioSettingsPage`）与特效页（`/ui-effects`）长得像，但有一处**根本差别**，
这一节记的就是它：

1. **路径入库，不是两端约定**。特效图集路径由 key 推导（`effect/<key>/<key>.plist`），换美术必须
   重打包，所以那张表里没有路径列；音效的文件是**运营挑的**（`audio_settings.file_path` =
   `sounds/xxx.wav`，相对 `client/assets/resources/`，**带扩展名**），换一首登录曲只要新文件已在
   资源包里。带扩展名的理由：与文件系统一一对应，目录列表 / 试听地址可以直接拼；客户端对接时
   去掉扩展名再 `resources.load(path, AudioClip)`。
2. **文件名只允许英文**（用户 2026-11-04 定）：字母 / 数字 / 下划线 / 短横线 + `sounds/` 前缀 +
   扩展名白名单（`.wav .mp3 .ogg .m4a`）。资源目录里临时放的中文名要先改名 —— 所以**选择器要把
   不合规的文件名挡在列表外**，别让人选完保存才吃 400（页面会提示「另有 N 个文件名不是英文」）。
   空串 = 未配置（合法状态，这一项不响），不是错误。
   **命名约定：文件名与 key 同名**（`ui_click` → `sounds/ui_click.wav`，#685 用户授权统一改名）。
   不是校验规则（运营可换任何合规文件名），纯粹为了对齐：翻资源目录一眼看出对应哪个配置项。
   改文件时**连同 `.meta` 一起改**（uuid 在 meta 上，`resources.load` 按路径找，两边都对才不丢引用）。
3. **服务端不检查文件是否存在**。资源包不在服务端（镜像里没有 `client/assets/resources`），强行查
   只会掩盖「本地有、线上没有」。所以**试听按钮是这个页面的核心**：能播 = 路径对、MIME 对、文件在。
   试听按表单当前值播（音量 / 循环都取未保存的值），与「保存后会是什么样」保持一致。
4. **分类与文案都随接口下发，页面不写死**（#683）：每行带 `category` / `categoryLabel`（唯一书写处是
   服务端 `AUDIO_DEFAULTS`），tab 栏**按行的出现顺序分组**（= `AUDIO_KEYS` 登记顺序，按分类成组），
   所以加一个音效项 / 加一个分类只改服务端常量 —— 页面自动多一个 tab，不会留下空 tab。
   `CATEGORY_ACCENTS` 里只有装饰色（tab 圆点 / 卡片左色条），未知分类落到默认色，加分类也不花。
5. **已下发客户端**（#683）：`ClientConfigService.snapshot()` 的 `audio` 段 + 公开接口
   `GET /game-config/audio`（登录场景没有令牌，而背景音正是那时要响的）。两条路同形状（`AudioConfigDto`：
   只有 key / filePath / volume / loop / enabled，**不带**展示名 / 分类 / 追账），客户端只有一套读法。
   页面文案因此改成「保存后下次进游戏生效」，不再是「只落库不出声」。
   **#685 起点击音是全站共用**（key `ui_click`，展示名「按钮点击音」，分类标签「界面与交互」）——
   它不再只是登录按钮的音，改它会影响所有按钮；`item_drop` 在捡起物品时也响、`bag_resort` 在拖动搬格时也响、
   `map_teleport` 挪到「传送后角色显示出来」那一刻。`move`（移动脚步音，#685）特殊：**循环由客户端
   按移动状态起停**（点地面走一步播一声、长按循环、停下即停），这项的「循环」开关不改变播放方式 ——
   运营打开它也不会让脚步声变成背景音式的常驻循环。
6. **改 key / 改出厂值都要能落地到老库**（#685）：`INSERT OR IGNORE` 只在「没有这行」时插入，
   已有行一个字段都不动。所以 `login_click` → `ui_click` 之后老库那行还在（管理端多出一项
   「客户端不认的 key」，点了没声音也看不出原因），而改了出厂文件路径的老行**还指着旧文件名**。
   `AudioSettingService.onModuleInit` 两件事都做：`rebaseOnPreset`（只动 `updated_at = 0` 的行 ——
   运营改过的行一个字都不改）+ `deleteOrphans(AUDIO_KEYS)`（清清单外的 key）。
   安全前提：**行只来自 seed**（没有新建接口），清单外的 key 只可能是我们改名或下线。
7. **素材清单两个来源同形状**（与图片选择器一个道理）：生产 `resources/audio-manifest.json`
   （`make image-manifest` 一并生成，带扩展名）、开发 `/game-resources/__list?dir=sounds&audio=1`
   （vite 中间件扫盘）。都拿不到就降级成「手填 + 试听」，不阻塞配置。
8. **静态素材读取要进审计白名单**：`fetch('/game-resources/...')` 直接写在页面里会被
   `audit-api-hardcode` 判红（管理端请求只许从 `api/http.ts` 发）。做法是像 `equipAlign/assets.ts`
   那样单独一个文件（`pages/audioSettings/assets.ts`）并在审计的 `adminAssets` 里登记，
   页面里连 `fetch` 都不出现。**提示文案里也别写 `http://localhost:8080`** —— 那同样算硬编码地址。

页面版面的四层（#683）：页头 → 概览（`StatCard` ×4：音效项 / 已启用 / 缺少文件 / 未保存）→
分类 tab（`role="tablist"` + 每类计数）→ 音效卡（左侧展示名 + key + 循环/追账，右侧文件行 + 试听 +
音量 + 两个开关 + 保存）。「未保存」既在页头给总数、也在行上标 —— 一个音效一项一张卡时，
没有行级提示会漏掉「改了但没存」的那一张。

## 五点十六、装备外观体系：五张页面的分工，别放错（#695 ~ #721）

装备相关的东西被切成**五个互不重叠的页面**，因为它们的「一行代表什么」完全不同。放错页面的典型症状是
「改了一个地方，另一个页面显示的还是旧值」，然后有人去加同步逻辑 —— 那是在给错误的分工打补丁。

| 页面 | 一行 / 一格的语义 | 能不能增删 |
|---|---|---|
| `EquipmentsPage` 装备配置 | 一件**基础件**（37 件） | 不能 |
| `EquipmentTiersPage` 前后缀管理 | **档位定义**（1~10 档文案 + 属性倍率）+ **两张引用棋盘**（组合 → 边框 / 背景 key） | 档位可增删（1~10），棋盘格子只选 key |
| `EquipmentVariantsPage` 装备变体 | 一个**最终组合**（555 行，每行都是最终值） | 不能直接增删，走「重新生成变体」 |
| `EquipmentSettingsPage` 槽位与规则 | 一个**槽位**（13 行）+ 一行装备规则 | 不能 |
| 装备边框 / 装备详情背景 | 一个**素材实体**（key + 显示效果 + 别名 / 分组） | 能（含「从文件夹同步」整批重建） |

三条贯穿这一族的纪律：

1. **「清单」与「引用」是两回事，读法是「清单 ∪ 引用」**（#714）：清单本体（`border_items` / `background_items`）
   说了「游戏里有哪些素材」，关联棋盘与特殊装备绑定**只引用 key**。老数据里可能存在「只有引用、没有清单行」的 key ——
   读的时候并集，**不做迁移**（迁移会把一份可能被回滚的数据写死）。effect 只有清单一处来源，保存时服务端
   **写时传播**进引用处，所以棋盘里看到的效果永远是清单的值。
2. **被引用的条目禁删，但「从文件夹同步」可以删**（#716）：同步是**唯一**绕开「被引用不可删」的写路径 ——
   素材文件夹才是真相，删掉素材后引用处显示异常是**接受的口径**。别为了「禁删」给同步加例外判断，
   那样清单会永远追不上文件夹。
3. **素材目录只有一个来源**：`EQUIPMENT_APPEARANCE_RES_DIR`（缺省 `../client/assets/resources`，
   compose 里挂 `game/resources`，只给 server 读）。页面上的「扫盘预览」与「同步」都走服务端这条目录，
   **管理端自己不去扫盘**（浏览器没有文件系统）。

**同步的两个实现细节**（踩过）：① 受控 PATCH 会互相覆盖 —— 清单页保存 items、棋盘页保存 assignments，
e2e 里断言顺序必须排成「写读 → 清空 → 摆回前提 → 同步」，否则你验的是上一条的残留；
② spawn 出来的服务端子进程读不到测试中途设的 env，`EQUIPMENT_APPEARANCE_RES_DIR` 必须在起服前定好，
目录坏 / 空这类场景用**现场增删文件**演（比换目录可靠）。POST 默认 201，断言别写 200。

**档位与颜色**（#697 / #720）：改档数**不会**自动重建变体（要回变体页点「重新生成」），但档位文案、
`prefix_colors` / `suffix_colors` 是即时生效的显示口径。PATCH 语义要注意「显式传」与「存量漂移」的区别：
**显式传了颜色**才校验等长 / 允许空数组，**没传而档数变了**则自动对齐（截短 / 末色垫补）——
否则老调用方扩档就被 400 卡死。客户端没收到颜色时逐档回落内置色。

**显示效果工作台**（`AppearanceEffectWorkbench`，#700）以素材**第一帧**为基准：边框走 `contain`（居中缩进 +
scale 乘在缩进结果上），详情背景走 `width-top`（宽 = 基准框宽 × scale、高按原始比例、顶边贴基准框顶）。
画布上的相对关系与客户端同一套口径，**但不是游戏** —— 没有动画、没有周边 UI。判据仍然是「人眼看」，
不要给它写几何断言（见 skill `olua-client` 的「显示效果零断言」）。

**这些页面改完，客户端要重新打包才可见**（或至少重进图拉新快照）：外观段是快照的一部分，
而「边框 / 背景要播放动画」这件事本身由客户端实现。所以管理端的所有提示文案统一写
「退回选角再进图即生效」这类可操作的句子，不要写「已生效」。

## 六、必踩的坑

1. **生成的类型必须是 `type` 不是 `interface`**。`interface` 没有隐式索引签名，赋给请求层的 `Record<string, string | number | null | undefined>`（query 参数）会被 TS 拒。生成器已经统一产出 `export type X = { ... }`，别再手写回 interface。
2. **受控表单的枚举字段要收口**：下拉 / 输入框给的是字符串，赋值时写 `as XxxQuery["field"]` / `as XxxPatch["field"]`（非法值服务端也会拒，但类型层面必须过）。
3. **分页结果用 `PageResult<T>`**（与服务端 `XxxPageDto` 结构一致，可互相赋值）。
4. **业务码 / 权限点改动要同步**：服务端在 `server/src/common/constants/`，管理端在 `src/api/types.ts`，两边的值与文案要一起改（数字对不上就是静默失效）。
5. **`npm run build` 自带 `tsc --noEmit`**，所以「build 过了」就等于类型也过了；改完页面**必须跑一次**。
6. 页面里**不要出现路径字面量**（如 `"/admin/roles"`）——只允许调 `endpoints.ts` 里的方法。
7. **JSX 文本里写 `**加粗**` 会原样显示星号**：markdown 只在 `.md` 里生效，页面上要写成 `<strong>`。
8. **`ApiError.needRelogin` 判的是 `status === 401 || RELOGIN_CODES`** —— 所以新增的「令牌作废」码（`40103`）即使不加进 `RELOGIN_CODES` 也会回登录页（因为它就是 401）。加进去是为了让意图显式，别把它当唯一开关。
9. **改自己的密码不能用「重置密码」那套**：服务端会作废旧令牌，所以必须用返回的新令牌覆盖会话（`saveSession(result.token, result.admin)`）；否则请求一发完，下一次点击就把自己送回登录页。
10. **生成随机口令用 `crypto.getRandomValues`**，别用 `Math.random`；字符集去掉 `0/O`、`1/l/I` 这类念给玩家容易听错的字符（口令是要线下念的）。
11. **数组/对象断言在守卫脚本里不能用 `===`**（比较的是引用），要用 `JSON.stringify` 后比较——server e2e 里踩过。

## 七、加一个管理端功能的步骤

1. 服务端：写 DTO（含嵌套对象时用带装饰器的 DTO 类 + `@ValidateNested` + `@Type`）+ 控制器方法（`@ApiAdminDoc({ operationId, permissions })` + `@ApiQueryModel` / `@ApiDataResponse`）→ 必要时先在 `permission.ts` 加权限点。**注意：具名路由必须声明在 `:id` / `:level` 参数路由之前，否则被吞掉**。
2. `cd server && npm run gen:api` 重新产出文档与两端接口文件（`admin/src/api/endpoints.ts` / `models.ts` / `routes.ts`）。
3. 管理端：`npx tsc --noEmit` 看报错，按生成的方法签名改调用点；新增页面走 `RequirePermission` 外壳 + `PERMISSION` 常量 + `Layout.tsx` 导航项。
4. **同步受管文档数字**：接口数 / 路径数 / 模型数 / 管理端分组数变了就改 README / FAQ 双语 / resume / server README（见坑 11）。
5. 验证：`make admin-build`（= tsc + vite build）+ 服务端 `npm run verify`（e2e 全套 + 契约审计）+ 仓库根 `make audit`（16 项跨端审计）。
6. 仓库根 Makefile 等价目标：`make admin-build` / `make admin-typecheck` / `make gen-api` / `make verify`（全门禁）；`make help` 列全部。

## 八、提交纪律（强制，与仓库根纪律一致）

**所有提交必须有 issue / PR 追踪**：开 issue → 分支 `type/n-slug`（分支号 = issue 号）→ 提交（提交信息带 `Closes #n`）→ 推送开 PR → **CI 全绿才能合并** → squash 合并 → 同步本地 master（`git pull --ff-only`）。

- 一个 PR = 一个 squash = 一个功能；**改完立刻提交，不要攒着**，也不要把多个不相关改动混进一个 PR（「哪次改动引入了回归」永远能二分出来）。
- 开分支前先 `git fetch` + 同步 master（多机并行开发是常态，master 随时可能被另一台机器推进）；合并后再拉一次确认本地 = 远端。
- 提交信息用 `feat|fix|refactor|docs|test|chore(端): 一句话说清做了什么`（管理端的端名取 `admin`），正文列关键改动与验证结果。
- 涉及多端的同一功能拆成几个提交，顺序按依赖（服务端先，再 `admin` / `client`，最后 `docs`）。

```bash
cd /Users/tz/workspace/olua
gh issue create -t "feat(admin): 一句话说清做了什么" -b "需求与方案"
git checkout -b feat/<issue号>-slug
git add admin && git commit -m "feat(admin): 一句话说清做了什么 (Closes #<issue号>)"
git push -u origin feat/<issue号>-slug
gh pr create --fill && gh pr checks --watch && gh pr merge --squash --delete-branch
git checkout master -q && git pull --ff-only -q
```

## 九、相关

- 契约从哪来（`operationId` / 装饰器 / 生成器 / 守卫）：skill `olua-server` 的 `references/contract-pipeline.md`
- 服务端权限模型与接口写法：skill `olua-server`
- 客户端怎么消费同一份快照：skill `olua-client`
