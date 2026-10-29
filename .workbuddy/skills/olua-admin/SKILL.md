---
name: olua-admin
description: olua 项目管理端（React 19 + TypeScript + Vite + Tailwind CSS v4，目录 admin/）的开发做法。核心心智模型：界面按权限显隐只是体验，服务端才是权威；接口路径 / 方法 / 实体类型全部由服务端 Swagger 文档生成，禁止手写；页面从共享基件拼装（ui.tsx / Pagination / 弹窗 / Toast），不手写表格样式。涵盖：api 目录的生成物与手写边界（routes.ts 路径表 / models.ts 类型 / endpoints.ts 接口方法 accountsApi adminsApi announcementsApi auditApi authApi mailsApi rolesApi soulsApi statsApi systemApi titlesApi 都是生成物，config.ts http.ts types.ts gameData.ts index.ts 是手写）、地址唯一来源 admin/.env 的 VITE_API_BASE_URL（代码只读 src/api/config.ts）、请求唯一出口 http.ts（请求与响应拦截器 / AbortController 超时 / 统一包裹解包 / ApiError 归一 / ApiError.needRelogin 触发重新登录 / 错误观察者单槽位 / HttpOptions 的 auth 与 silent）、按权限渲染（api/types.ts 的 PERMISSION 现有 25 个权限点与服务端一一对应 + store/session.hasPermission 脏会话兜底空数组即最小权限 + 导航项带 permission 过滤 + 写按钮 disabled + App.tsx 的 RequirePermission 外壳）、共享 UI 组件（ui.tsx 的 Spinner Button Field Input Select Card Badge EmptyState StatCard 与 tableClass 系列、Pagination 服务端分页 10/20/50/100、ConfirmDialog、toastError/toastSuccess）、养成配置页面模式（TitlesPage / SoulsPage：GameConfigDialog 属性整份提交整份替换、价格不进编辑弹窗；GameGrowthListDialog 成长列表弹窗化、KIND_CONF 收敛两种配置的文案与接口适配、拖拽排序乐观更新失败回滚、行内改价；价格唯一显示与修改口 = 成长列表；升级链顺序与等级号解耦）、页面结构（Dashboard / Accounts / AccountDetail / Roles / RoleDetail / Admins / Announcements / Titles / Souls / Mails / Audit / System / MyAccount / Login / Register）、口令管理（AccountDetailPage 的重置密码 + 踢下线、AdminsPage 的重置密码且对自己置灰、MyAccountPage 的自助改密必须用返回的新令牌覆盖会话）、操作日志页（筛选 + 分页 + 展开请求体、动作中文名走 api/types 的 AUDIT_ACTION_LABELS 字典而动作清单从接口拉）、重置口令弹窗 ResetPasswordDialog 的两阶段（确认时前端生成随机口令、成功后只显示一次）、会话变化订阅 subscribeSession 让顶部身份栏跟着刷新、角色运行时数据编辑（KeyValueEditor 编辑装备与技能、背包稀疏格子编辑器含清空背包、buildPatch 对结构化字段整体提交其余只提交改动项）、业务码与展示字典（BIZ_CODE RELOGIN_CODES ADMIN_ROLE_LABELS PERMISSION_LABELS AUDIT_ACTION_LABELS AUDIT_TARGET_LABELS OCCUPATION_LABELS SEX_LABELS ROLE_BAG_AXIS_MAX PASSWORD_MIN_LENGTH formatTime formatTimeFull msToLocalInput localInputToMs）、枚举字段必须收口（as XxxQuery 字段名）、生成类型必须是 type 不能是 interface、接口数 / 管理端导航分组数等是 audit-doc-numbers 的受管数字（改接口必须连文档数字一起改）、新增页面或接口的标准步骤、验证命令 npm run build 等于 tsc --noEmit 加 vite build、提交走 issue + PR + CI 门禁。触发场景：用户说"改管理端页面""加一个管理端功能""后台要能改角色属性""加筛选条件""加批量操作""权限按钮不该显示""登录后跳转不对""管理端类型报错""新接口管理端调不到""按权限显隐菜单""后台重置密码""踢下线按钮""操作日志页""看谁改了什么""改自己的密码""管理端登录被锁""称号配置""战魂配置""成长列表""养成配置""做成分页""改成弹窗""拖拽排序"。
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
| `gameData.ts` | 引用**生成物** | 游戏数据的唯一入口：re-export 三端共用的 `server/src/shared/game-data.generated.ts`（相对路径 import，Vite 打包）+ 查表函数（`equipmentText` / `skillText` / `itemText` / `mapText` / `soulText` / `titleText` / `rankText` / `occupationLabel` / `sexLabel` / `slotLabel`） |
| `index.ts` | 手写 | barrel —— **页面 import 统一走 `../api`**，换生成物时页面一行都不用改 |

守卫（在**仓库根**跑）：`node tools/audit-api-generated.cjs`（生成物逐字节一致 + 生成标记 + 路径只在路径表）、
`node tools/audit-api-hardcode.cjs`（地址 / 请求 / 路径的唯一来源，且**唯一来源文件必须带生成标记**）、
`node tools/audit-shared-data.cjs`（公共游戏数据与客户端 configs 逐字节一致 + 每张表齐全非空 + **扫 `admin/src` 抓手抄的同名字典**）。

### 游戏数据：一份来源，三端共用（用户 2026-10-13 定的硬要求，issue #117~#119）

装备 / 战魂 / 称号 / 军衔 / 技能 / 物品 / 地图的名字与元数据，权威定义只有一处 —— 客户端
`client/assets/configs`（外加 `client/assets/types/role.ts` 的枚举注释：「全职业」职业码与三个性别名只写在那儿）。
管理端**不复制**：`api/gameData.ts` 按相对路径 import `server/src/shared/game-data.generated.ts`
（由 `tools/gen-shared-data.cjs` 生成），**服务端与管理端读的是同一个文件**。

- **此前管理端自己抄过一份** `OCCUPATION_LABELS` / `SEX_LABELS`（写在 `types.ts` 里）—— 客户端改了这边不会知道，
  已删掉改引用生成物；`audit-shared-data` 现在会扫 `admin/src` 抓「与生成物同名的字典型定义」。
- 改数值 / 改文案 → 改客户端配置 → `node tools/gen-shared-data.cjs`（`make gen-shared-data`）。
- 页面显示名字**一律过 `gameData.ts` 的查表函数**，不要自己拼（装备显示名含前后缀、部位归属都是生成器在
  客户端数据上算好的；三张等级表是「下标 = 等级 - 1」，那一位差也只在 `gameData.ts` 里处理）。
- **dev 模式**要读项目外的文件，`vite.config.ts` 放行了上层目录（`server.fs.allow: [".."]`）；构建不受影响。

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

- `api/types.ts` 的 `PERMISSION`（与服务端 `common/constants/permission.ts` **一一对应**，现 25 个权限点；`gameConfig:read/write` 养成配置、`account:password` 重置玩家口令、`account:email` 补录 / 查看玩家邮箱、`announcement:*` 公告、`mail:*` 邮件、`audit:read` 查操作日志与 `system:read` 看系统信息是逐个后加的）；
- `store/session.hasPermission`（**脏会话兜底空数组 = 最小权限**）；
- 导航项带 `permission` 过滤；写操作用 `disabled`；`App.tsx` 用 `RequirePermission` 外壳包住页面；
- **不需要权限点的页面**（如「我的账号」）直接挂路由，不进 `NAV_ITEMS`（它是每个人的私有页，放顶部身份栏更顺手）；
- 新增需要权限的界面：先在服务端加权限点 → 同步 `PERMISSION` → 再在导航 / 按钮 / 外壳上引用。

## 五、页面

| 页面 | 干什么 |
|---|---|
| `LoginPage` / `RegisterPage` | 登录注册（注册需服务端 `ADMIN_REGISTER_CODE`；**第一个注册者自动是超管**） |
| `DashboardPage` | 概览统计（`stats:read`） |
| `AccountsPage` | 账号列表：分页 + 状态检索 + 封禁 / 解封 + 删除 |
| `AccountDetailPage` | 账号信息 + 名下角色概要 + **重置密码** + **踢下线** + **清空该账号全部角色** |
| `RolesPage` | 角色列表：**六维筛选**（关键字 / 账号 / 在线 / 职业 / 性别 / 等级区间）+ 多选 + 批量删除确认框（列出角色名）+「修订」列 |
| `RoleDetailPage` | 三块卡片：基础信息 / 常用数值 / **运行时数据**（`KeyValueEditor` 编辑装备与技能、背包稀疏格子编辑器含「清空背包」） |
| `AnnouncementsPage` | 公告列表与发布 / 编辑（`announcement:read` 看见、`announcement:write` 改，编辑走 `AnnouncementDialog`） |
| `TitlesPage` / `SoulsPage` | **养成配置**（称号 / 战魂，`gameConfig:read/write`）：服务端分页主列表 + 顶部按钮唤起「成长列表」弹窗。见「养成配置页面模式」一节 |
| `RanksPage` | **养成配置**（军衔 #250）：同上模式，无拖动排序（100 阶天然按阶），主列表带大段 Badge；`GameConfigDialog` kind="rank"（无动画栏、加大段名输入） |
| `GrowthPage` | **养成配置**（成长曲线 #256）：三卡片（升级经验 / 曲线分段 / 标量参数）+ 共用 `NumberEditDialog`（fields spec 驱动）；分段保存走「先内存校验再落库」口径 |
| `EquipmentsPage` | **养成配置**（装备基础件 #252）：部位 / 等级段筛选 + 分页；**只收基础件**（37 件，变体在客户端按倍率展开）；编辑弹窗只开放等级 / 售卖价 / 八项属性（页面内 `EquipmentEditDialog`，不复用 GameConfigDialog —— 字段差异太大） |
| `MonstersPage` | **养成配置**（怪物基础数据 #258）：关键字 / 定位筛选 + 分页；编辑弹窗开放名称 / 等级 / 生命上限 / 六项攻防区间（页面内 `MonsterEditDialog`，区间字段复用 `RANGE_FIELDS`）；**改值即时生效**（世界播种与伤害结算直读 monsters 表） |
| `NpcsPage` | **养成配置**（NPC 基础数据 #258）：关键字筛选 + 分页；编辑弹窗只有名称 / 对话文案（对话 seed 为空串，客户端暂无消费） |
| `MallPricingPage` | **商城定价**（#251）：统一价卡片（单行改价）+ 商品定价列表（部位/关键字/定价状态筛选，商品清单来自生成物 555 件变体）；未定价行高亮「走统一价」；特殊价 PUT upsert /「回统一价」DELETE —— **全后台唯一允许增删行的定价数据** |
| `FashionsPage` | **时装配置**（#257）：关键字 / 获得渠道筛选 + 分页；编辑弹窗开放名称 / 描述 / 售卖价 / 渠道下拉 / 八项属性（maxHp/hpRecover + `RANGE_FIELDS` 六区间，复用 title.dto 的 ConfigAttributesDto 形状）；icon/inRes/outRes 资源路径不开放编辑；渠道中文名按时装语境另配（值域仍复用 ACQUIRE_CHANNEL） |
| `DropConfigPage` | **掉落配置**（#254）：上半部具名掉落表卡片组（新建 / 编辑 / 删除，picks 捞取次数 + entries 条目编辑器逐行 goodId（带物品名提示）/ 权重 / 概率 / 数量区间）；下半部每怪掉落列表（关键字 / 来源筛选 + 分页，编辑弹窗三选一：引用具名表 / 内联条目+必填 picks / 清空 none）；具名表被引用中的行拒删 |
| `MailsPage` | 邮件投递记录（`mail:read` 看记录、`mail:write` 发信，编辑走 `EmailDialog`） |
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
- 装备与技能的键**按角色自己数据里已有的键渲染，不硬编码清单** —— 服务端不认识客户端配置，硬编码清单一定会漂移。
  值那一侧现在是**有名字的**：行下面会用 `api/gameData.ts` 的 `equipmentText` / `skillText` / `slotLabel`
  显示「部位 · 装备名」与技能名，背包格子显示物品名，地图与战魂/称号/军衔也各带一行当前名 ——
  这些名字全来自三端共用的那份数据，页面不拼口径。

**筛选表单与查询分离**：表单状态与「已应用的查询」分开（`applied`），点「查询」才生效；刷新列表要**清空多选**。

## 五点五、共享 UI 组件与页面模式（新页面从这里拼，不手写样式）

**`components/ui.tsx` 是基件**：`Spinner` / `Button`（`tone` + `disabled`）/ `Field`（label + hint 包输入）/ `Input` / `Select` / `Card`（title + description + actions）/ `Badge`（`tone`）/ `EmptyState` / `StatCard`，以及表格类名常量 `tableClass` / `theadClass` / `thClass` / `tdClass`。页面表格统一这套类名，深色主题口径只在 ui.tsx 改一处。

**分页统一走 `Pagination` 组件**（服务端分页：只上报页码与条数，翻页由页面重新拉数据）：

- props：`page` / `size` / `total` / `onChange` / 可选 `onSizeChange`（传了才显示「每页」下拉，`PAGE_SIZE_OPTIONS = [10, 20, 50, 100]`）；
- 页面自己存 `page` + `size` 两个 state，**改条数要回第一页**（`setSize` 时连 `setPage(1)`）；
- 「基础数据」类页面（称号 / 战魂）**不要**为了省事一页 100 全量展示——一律接入服务端分页（#239 口径）。

**弹窗模式**：受控开合（`open` + `onClose`），内容自管状态；**每次打开重新初始化**（`useEffect([open, initial])` 重置表单），编辑另一条时不残留上一条；提交回调签名 `Promise<boolean>`，返回 `true` 才由页面关弹窗刷列表。

**提示统一走 Toast**（`store/toast` 的 `toastSuccess` / `toastError` / `toast`），不要页面自己挂浮层；危险操作统一 `ConfirmDialog`。

## 五点六、养成配置页面模式（TitlesPage / SoulsPage，称号与战魂同构）

养成配置 = 服务端启动 seed 的**固定等级序列**（称号 34 级 / 战魂 37 阶 / 军衔 100 阶 / 装备基础件 37 件），**只能改、不能增删**（POST/DELETE 接口根本不存在）。称号与战魂两页结构完全一致，改一处要想着另一处；军衔 / 成长曲线 / 装备各按自身字段形态复用或另起弹窗（见页面表）。

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
- **「本机上有什么」不许进生成物**：`client/assets/resources/` 是 gitignore 的，清单带 `hasAsset`
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
- **内观图集是另一种拼法**：外观是 `<dir>/stand/stand.{png,plist}`，内观是 `<dir>/in.{png,plist}`
  （路径本身即基名）。`assets.ts` 里 `inAtlasUrls` / `loadInAtlas` 与外观那套并列，别硬套 `/stand/stand`。
  取帧用 `firstFrameName()`（按名字排序取第一个**非空**帧 —— 空帧是 1×1 占位）。
- **没有裸模内观素材**：未穿衣服时客户端不画身体，所以 id 形态里没有 `role:*`（服务端用
  `equipInAlignId` 正则挡掉，e2e 用 `role:1` → 400 钉住）。

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
11. **接口数 / 路径数 / 模型数 / 管理端导航分组数是 `tools/audit-doc-numbers.cjs` 的受管数字**：改接口（哪怕只是加一个端点）或加导航项，必须连 README / FAQ 双语 / docs/resume.md / server README 双语里的数字一起改，否则审计红。跑 `node tools/audit-doc-numbers.cjs` 看差在哪。
12. **中文文案改动可能触发 `tools/audit-docs-en.cjs`**（双语文档口径全等）：页面内提示文案不影响，但若改动被文档引用（页面名、功能名），英文文档要同步。
13. **数组/对象断言在守卫脚本里不能用 `===`**（比较的是引用），要用 `JSON.stringify` 后比较——server e2e 里踩过。

## 七、加一个管理端功能的步骤

1. 服务端：写 DTO（含嵌套对象时用带装饰器的 DTO 类 + `@ValidateNested` + `@Type`）+ 控制器方法（`@ApiAdminDoc({ operationId, permissions })` + `@ApiQueryModel` / `@ApiDataResponse`）→ 必要时先在 `permission.ts` 加权限点。**注意：具名路由必须声明在 `:id` / `:level` 参数路由之前，否则被吞掉**。
2. `cd server && npm run gen:api` 重新产出文档与两端接口文件（`admin/src/api/endpoints.ts` / `models.ts` / `routes.ts`）。
3. 管理端：`npx tsc --noEmit` 看报错，按生成的方法签名改调用点；新增页面走 `RequirePermission` 外壳 + `PERMISSION` 常量 + `Layout.tsx` 导航项。
4. **同步受管文档数字**：接口数 / 路径数 / 模型数 / 管理端分组数变了就改 README / FAQ 双语 / resume / server README（见坑 11）。
5. 验证：`make admin-build`（= tsc + vite build）+ 服务端 `npm run verify`（e2e 全套 + 生成物一致性）+ 仓库根 `make audit`（13 项跨端审计）。
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
- 客户端怎么消费同一份生成物：skill `olua-client`
