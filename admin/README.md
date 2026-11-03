# admin · 管理端（React）

> [English](README.en.md) | 简体中文

> 运营后台：账号 / 角色 / 管理员 / 公告 / 邮件 / 发消息 / 操作日志 / 玩家举报八块。界面按**权限点**显隐，服务端独立校验。
>
> 项目总览见 [../README.md](../README.md)；管理端的问题见 [FAQ.md](FAQ.md)；
> 客户端 / 服务端 / 跨端见 [../client/](../client/) · [../server/](../server/) · [../FAQ.md](../FAQ.md)。

## 技术栈

- **React 19** + **TypeScript** + **Vite**
- **Tailwind CSS v4**（`@tailwindcss/vite` 插件，无 `tailwind.config.js`，主题写在 `src/index.css`）
- **react-router-dom v7**（路由即权限外壳，见下）
- 接口层**不手写路径与类型**：`src/api/{routes,models,endpoints}.ts` 由服务端的 `openapi.json` 生成

## 环境要求

- **Node.js 20+**（与 Vite / React 19 要求一致）
- 服务端需先跑起来（默认 `http://localhost:3100`）

## 快速开始

```bash
cd admin
npm install
cp .env.example .env.development   # 首次：接口根地址在这里（VITE_API_BASE_URL）
npm run dev                        # 开发（默认 5173）；npm run build 产出 dist/
```

- 注册需要在 `server/.env` 里配 `ADMIN_REGISTER_CODE`（留空 = 开放注册），注册时填同一个注册码
- **第一个**注册的管理员自动成为超级管理员（全部权限），之后的都是普通管理员，要提权由超管在「管理员」页调整

## npm 脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 开发服务器（Vite，热更新） |
| `npm run build` | **类型检查 + 构建**（`tsc --noEmit && vite build`，产出 `dist/`） |
| `npm run preview` | 预览已构建产物 |
| `npm run typecheck` | 只做类型检查（不产出） |

> 仓库根的 `make` 是这些脚本的快捷方式：`make admin-dev` / `make admin-build` /
> `make admin-typecheck`；`make dev` 还能把服务端与管理端一起起来。`make help` 看全部。

## 环境变量

全部在 `admin/.env.development`（开发）与 `.env.production`（生产），模板见 `.env.example`。
代码里不允许再出现接口地址字面量 —— `node ../tools/audit-api-hardcode.cjs` 会检查「用到的键是否都在 `.env.example` 里登记过」。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:3100/api` | **接口地址唯一来源**（`src/api/config.ts` 只读它） |
| `VITE_API_TIMEOUT` | `15000` | 请求超时（毫秒） |
| `VITE_APP_TITLE` | `olua 管理端` | 页面标题（顶栏与浏览器标题） |

## 目录结构

```
admin/
├── src/
│   ├── main.tsx                    入口（挂载 App + 全局样式）
│   ├── App.tsx                     路由表 + 两处全局接线（需要重登 / 出错弹提示）
│   ├── index.css                   Tailwind 入口 + 主题变量
│   ├── api/
│   │   ├── config.ts               ← 接口地址 / 超时 / 标题的唯一读取处
│   │   ├── http.ts                 请求层：拦截器 / 超时 / 包裹解包 / 错误归一 / 401 跳登录
│   │   ├── routes.ts               ⚠️ 生成物：接口路径表
│   │   ├── models.ts               ⚠️ 生成物：接口类型（服务端 DTO 的镜像）
│   │   ├── endpoints.ts            ⚠️ 生成物：接口方法（accountsApi/adminsApi/announcementsApi/mailsApi/gameMailsApi/auditApi/authApi/rolesApi/statsApi/systemApi）
│   │   ├── types.ts                手写：业务码 / 权限点 / 动作与目标的中文字典 / 时间工具（**游戏数据不在这里**）
│   │   ├── gameData.ts             游戏数据：引用三端共用的那份生成物 + 查表函数（名字都从这里来）
│   │   └── index.ts                统一出口（页面只从这里 import）
│   ├── pages/                      页面（见下表）
│   │   ├── equipAlign/             对齐工作台的纯逻辑：atlas（plist+轮廓）/ model（几何）/ render（8 宫格）/ assets（素材 fetch）/ saved（服务端读写）
│   │   └── equipAlignIn/           内观工作台的纯逻辑：model（圆盘 / 手位 / 初值）/ render（单帧五层）/ saved（服务端读写）
│   ├── data/equip-align.catalog.json  ⚠️ 生成物：装备对齐清单（`tools/gen-equip-align-catalog.cjs` 产出，`audit-equip-align-catalog` 守）
│   ├── components/                 Layout / Pagination / ConfirmDialog / ResetPasswordDialog / BanDialog / BanStatus / AnnouncementDialog / RoleAttributesCard / ImagePicker（+ IconField）/ EntityPickButton / pickerStack（选择器 Esc 放行计数）/ sortable / charts / ToastHost / ui
│   │   └── entity/                 EntityPicker（选装备 / 物品 / 技能…）/ EntityPickerList / EntityImage / catalog（候选清单与取名口径）/ BagGrid / EquipSlots / SkillList / LevelLadder
│   │   └── map/                    MapCanvas（预览图 + SVG 叠加层，两套坐标同图核对）/ MapDialogs（图层 / 点位 / 刷怪区 / 场上怪物 / 对象组 / 数据来源）
│   └── store/
│       ├── session.ts              令牌与管理员的读写（含订阅机制 + hasPermission）
│       └── toast.ts                全局提示（成功 / 失败）
├── index.html
└── .env.example · vite.config.ts · tsconfig.json · package.json
```

## 页面

配置类列表页的**第一列是缩略图**：单图资源（装备 / 药品 / 物品 / 怪物 / 技能 / 状态 / 时装 / 商城商品）直接显示图标，称号 / 战魂 / NPC 显示图集动画的**首帧**（组件在 `components/GameImage.tsx`）。**缩略图可点击放大**（灯箱查看，Esc 关闭）。图片来源是客户端素材（dev 由 vite 中间件、prod 由 nginx 反代到 game 容器，同 `/game-resources/` 前缀），字段查三端共用的那份生成物 —— 素材缺失或 id 不在生成物里时显示「无图」占位，不影响列表。

**图标字段可以可视化挑**：所有「填一个 resources 路径」的字段都是「预览 + 路径 + **选择图片**」——弹窗里按目录分组铺开客户端素材的缩略图，点一张即选中（组件在 `components/ImagePicker.tsx`）。

页面里一律用 `<IconField>`（`ImagePicker.tsx` 导出），不要自己拼「预览 + 输入框 + 按钮 + 弹窗」：

| 字段类型 | 用法 | 选中值 | 覆盖的字段 |
| --- | --- | --- | --- |
| 单图 | `<IconField mode="image" rootDir="item" …>` | 这张图的路径 | 药品 / 物品 / 装备图标、技能与状态图标、部位底图 |
| 一套动画 | `<IconField mode="atlas" rootDir="clothes/out" …>` | 锚点 + 第一段目录 | 称号 / 战魂动画、NPC 素材、内观 / 外观、技能与状态特效、时装三件套 |

**物品 id 字段一样可视化挑**（#648）：掉落条目、任务 / 成就奖励物品、成就的「持有物品」条件、邮件附件都是 `<EntityPickButton>`（`components/entity/EntityPickButton.tsx`）——「图标 + 名字 + 一行说明」的按钮，点开就是 `<EntityPicker>` 里那一堆候选（带搜索与分组），不用再背 `drug_hp_1` / `weapon_1_p0s1`：

```tsx
<EntityPickButton value={draft.goodId} options={entityOptions("item")} onChange={(goodId) => …} />
```

候选清单与「叫什么、长什么样」全在 `components/entity/catalog.ts`（把 `api/gameData` 的生成物包成 `EntityOption`），页面不写游戏数据 —— 客户端加一件装备，选择器自动多一条。掉落条目的候选恰是服务端校验用的那份 `ITEM_LABELS`（装备全量变体 + 药品 + 材料），所以**能选出来的必定能存进去**；值不在清单里（旧数据）时字段会标黄色「清单里没有这个 id」，而不是装作空值。

**怪物 / NPC 的 id 也一样**（#651）：任务的目标对象与发布 NPC、成就「累计击杀」的目标都是同一个 `EntityPickButton`：

```tsx
<EntityPickButton value={form.objectiveTarget} options={entityOptions("monster")} kind="monster" onChange={…} />
```

`catalog` 的 `EntityKind` 覆盖 `equipment / item / skill / drug / fashion / map / monster / npc`。怪物与 NPC 的清单来自**服务端种子**（`monster-seed` / `npc-seed`，与 seed 进表的同一份），所以 220 只怪一只不少 —— 从前任务页用 `size: 100` 的列表接口，第 101 只之后的怪根本选不到，列表里也只显示裸 id。怪物名字是**出厂名**（运行时权威在 `monsters` 表，管理端可改），选中值永远是 id；成就的「任意怪」是 `*`，作为怪物清单里的第一个候选摆出来，不用再手打。

选择器一次只渲染 120 条（技能 1011 条、物品 2200+ 条一次性铺完会卡主线程），底部写「共 N 项，已画 M 项」并给**「再显示 N 项」**按钮 —— 能翻到底，不必靠猜关键词（分组不算救命：「普通怪」一组就有两百只）。

`mode="atlas"` 的「一套」由 `rootDir` 锚定（`clothes/out` 之下的 `001` 就是一套），一条规则同时覆盖三种磁盘形态（Cocos 图集目录 / 路径即基名 / 按动作分子目录），不会把 `001/a1` 这种内部动作目录漏给运营去选。

> 顺带一个必须记住的坑：**选择器叠在编辑弹窗上时，编辑弹窗的 `onClose` 要判 `anyPickerOpen()`**（`components/pickerStack.ts`，`IconField` / `EntityPickButton` 都会自动登记）。两个 `Modal` 各挂一个 window 的 Esc 监听，编辑弹窗先注册先收到 —— 不拦就会「关选择器顺带把编辑弹窗也关了」，改了一半的内容全丢。页面只需要改 `onClose` 那一行：`onClose={() => { if (!anyPickerOpen()) onCancel(); }}`。图片清单有两个来源、同一个 JSON 形状：**开发**用 vite 中间件的 `GET /game-resources/__list?dir=item` 直接扫 `client/assets/resources`（素材一放进来就能选，零额外步骤）；**生产** nginx 只是静态反代、没有目录列表能力，读落盘清单 `resources/image-manifest.json`（`make image-manifest` 生成，随素材包分发）。拿不到清单时弹窗里给的是**可执行的提示**（素材目录在哪 / 该跑哪条命令），不是一句「加载失败」。

| 页面 | 路由 | 需要的权限点 | 能做什么 |
| --- | --- | --- | --- |
| 登录 / 注册 | `/login` · `/register` | 无（公开） | 管理员登录；注册（首个注册者成为超管） |
| 概览 | `/` | `stats:read` | 账号 / 角色总量概览 |
| 账号管理 | `/accounts` | `account:read` | 分页检索（账号名模糊 + 状态）、封禁 / 解封、删除账号 |
| 账号详情 | `/accounts/:id` | `account:read` | 看名下角色、**重置玩家口令**、**踢下线**、清空该账号全部角色 |
| 角色管理 | `/roles` | `role:read` | 六维筛选（关键字 / 在线状态 / 职业 / 性别 / 等级区间 / 账号）、多选批量删除 |
| 角色详情 | `/roles/:id` | `role:read` | 改基础信息与常用数值；**装备 / 技能 / 背包结构化编辑**（清单以客户端配置为唯一真相）；**战斗属性对照卡片**——服务端按存档现算的那份与客户端上报的那份并排摆着，不一致的行标出来（只让它可见，不判定谁对） |
| 管理员 | `/admins` | `admin:read` | 看管理员列表；改角色 / 启停 / **重置密码** / 删除（写操作另需 `admin:manage`） |
| 公告 | `/announcements` | `announcement:read` | 发布 / 编辑 / 删除公告、启停、按关键字 / 级别 / 启停 / 生效状态筛选；**「生效中」用服务端返回的 `active` 列**（判据与玩家侧拉取接口同源，不靠本地时钟）（写操作另需 `announcement:write`） |
| 区服管理 | `/zones` | `zone:read` | 看区服清单（含已合并去向与账号分布）；**开新区**、**合并区**（一个事务搬走源区账号 + 世界实例重排续序，合并瞬间未落盘伤害丢弃 —— 弹窗二次确认写明代价；写操作另需 `zone:write`） |
| 帮会管理 | `/guilds` | `guild:read` | 看帮会清单（人数降序，带帮主与人数）与成员名单（职位上色）；**改名 / 改公告**（名字仍要全局唯一）、**强制解散**（成员与待审批申请一并清除、不可恢复 —— 二次确认写明代价；写操作另需 `guild:write`）。入帮审批是帮主自己的待办，管理端不代做 |
| 邮件 | `/mails` | `mail:read` | **发信**（选模板 → 填变量 → 入队）+ **投递记录**（状态 / 关键字筛选 + 分页 + 排序）。投递是**异步**的，所以有「待发送 / 重试中」中间态并自动刷新；只看得到已尝试次数与失败原因（写操作另需 `mail:write`） |
| 发消息（#437） | `/mail-send` | `gameMail:send` | **游戏内消息补发（单发）**：输入角色 id（角色详情页「发消息」按钮会带上）→ 选频道（只有 system / reward，social / combat 是系统事实记录）→ 标题 / 正文 / 可选附件（金币 / 经验 / 物品）。落库与成就兜底、好友申请走**同一个 send**；收件人不要求在线；**没有撤回**——发出去就归玩家。与上面的「邮件」（SMTP 外发投递）不是同一件事 |
| 特效管理（#594 / #634） | `/ui-effects` | `game-config:read` | **特效的表现参数**（摆位 / 缩放 / 旋转 / 时长 / 开关，与武器外观同一套取向）：一族一个页签（升级特效 / 掉落光效），左边改右边立刻按新参数演一遍，改完点保存，玩家下次触发即按新参数演（不用重打客户端包；写要 `game-config:write`，落 `ui_effects` 表并进审计）。两族的挂点不同：**升级特效**（`upgrade`）相对 UI 层锚点；**掉落光效**（`light_1`…`light_6`，装备掉在地上的品质光柱）相对掉落物图标中心，六档在页签内用**下拉框**选（不是六个页签）—— 预览里那个 40×40 虚线框就是图标，光柱压在它下层，与客户端层级一致。图集本体在客户端资源包里（升级 `effect/<key>/<key>.plist`、光柱 `effect/light/<key>.plist`），所以**没有新建 / 删除** —— 一行在不在由客户端的消费代码决定；「哪档装备用哪张光柱」也仍在客户端（`configs/light.ts` 是美术分配，不是表现参数） |
| 操作日志 | `/audit-logs` | `audit:read` | 7 项筛选（关键字 / 动作 / 目标类型 / 结果 / 起止时间 / 目标 id）+ 分页 + 展开看请求体 |
| 玩家举报 | `/reports` | `report:read` | 看玩家举报（关键字 / 类别 / 状态筛选 + 分页 + 行展开看描述与双方 id）。**这一版只有读**：处置需要「谁改的、凭什么改、能不能申诉」一整套，半成品按钮比没有更糟 |
| 我的账号 | `/me` | **不需要权限点** | 看自己的身份 / 登录情况 / 权限点；**自助改密**（要验原密码） |
| 装备对齐 | `/equip-align` | `game-config:read` | **8 方向比对工作台**：以裸模为唯一基准，把每件衣服 / 武器（以及裸模自己）在每个朝向上拖到位。参考框可开关（画布框 / 裁剪框 / **不透明轮廓** / **地面线**（宿主原点）/ **碰撞盒**（与客户端 `debug.colliderRange` 同一个框）/ 手位 / 原点 / **装备置顶**（默认开：背对朝向下衣服本来会被身体整件挡住，看不见就没法对齐；关掉即按游戏内遮挡层次复核）），每格左下角实时显示「脚底 ±N」—— 外观的锚点是**画布中心**，位置 0 不等于脚踩地面，这一栏就是判据；「脚底贴地」按轮廓把 8 个方向一次按到地面。拖动吸附 0.1、方向键 1、`Shift` 10、`Alt` 0.1、滚轮改缩放；「保存本件」直接写服务端（`equip_aligns` 表），客户端进游戏拉一次即覆盖本地几何；改动也实时存 localStorage，刷新不丢。导出 JSON 仍保留，只用于备份与「烧进出厂配置」（`tools/apply-equip-align.cjs`）。**页面只改配置，不碰角色存档** |
| 内观对齐 | `/equip-in-align` | `game-config:read` | **单帧比对工作台**（角色信息弹窗里那一个朝向，不是 8 方向）：衣服的基准是弹窗背景上的**金色圆盘**，武器的基准是**第一件衣服**。底图直接画真实弹窗背景，圆盘中心 / 半径由清单下发（实测值，**换背景图要重测**）；「脚踩圆盘」按不透明轮廓的底边中点对到圆盘中心，右栏实时给「脚底相对圆盘 ±N」（|Δ|>2 变琥珀色）。调武器时左侧固定叠一件 0.5 透明的第一件衣服（`cloth_1`）当参照，可画它的轮廓与手位；「按第一件衣服给初值」按轮廓算握持点并打开 `inManual`。**`inManual` 一旦为真，客户端就不再按当前衣服现算**——否则换一件衣服武器就飘、刚存的值当场被算法覆盖（与外观的 `outManual` 同一套路，未调的继续自动算）。「保存本件」直接写 `equip_in_aligns`（与外观是**两张表、两套接口**，重置互不牵连），客户端下次进图拉取即覆盖；`还原本件` 删行回出厂值。**武器的「手调」是硬约束**：没勾时客户端根本不读这些数字（`alignWeapon()` 按当前衣服现算），所以拖动 / 改数值会自动把它勾上、保存也会按手调存 —— 想回到自动算只有「还原本件」（删行）一条路。客户端每次打开角色信息弹窗还会再拉一次内观几何，所以「保存 → 关掉弹窗 → 再点开」就能看到，不必退回选角重进地图。页面只改配置，不碰角色存档 |
| 地图管理 | `/maps` | `game-config:read` | **玩法配置 + 点位 + 刷怪区全可编辑，而且就在地图上改**：左边 11 张图，右边上半「玩法配置」（名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶）可改可存（写要 `game-config:write`，落 `maps` 表并进审计），下半是**地图**——预览图上叠 SVG：刷怪区（实线）、NPC 点位、复活点、碰撞盒（可逐个开关）。**三种编辑模式**（#667 / #672）：绘制刷怪区（拖矩形 → 填怪物与数量）、放置 NPC（点空白 → 选 NPC 入库；已有点可拖动、松手即保存）、设复活点（点哪里设哪里，拖动可挪，另有「清除复活点」）。点已有对象打开对应弹窗（弹窗里的「编辑」回到图上表单并高亮那一行），密集的图可「放大」。越界由服务端判好随详情下发（`inBounds` / `overflow`）：越界的区域与点位在地图上描警示色虚线、弹窗「在图内」列标红、地图卡片出「越界 N」徽标 —— 容器会裁掉越出部分，「在图外」在图上表现为「不存在」，所以这一步不能靠眼睛。图层 / 点位 / 刷怪区 / 场上怪物 / 对象组 / 数据来源全部在弹窗里，页面只留配置与地图。**资源本体改不动**：TMX（瓦片 / 底图 / 预览图 / 碰撞盒）在客户端资源里，`src` 由 `map/<id>/<id>` 目录约定拼出来，请求里塞了也会被白名单剥掉；要换图只能改 TMX → 跑 `tools/import-map-resources.cjs` → 重新打包客户端（这个工具**不写**刷怪区 / NPC 点位 / 复活点，审计盯着） |

写操作会按权限点禁用按钮（`disabled`）并在表格上方提示「当前角色权限不足」；直接改地址栏硬闯，`RequirePermission` 外壳会就地给出「没有访问权限」而不是白屏。

## 游戏数据从哪来（三端共用一份）

装备 / 战魂 / 称号 / 军衔 / 技能 / 物品 / NPC / 时装 / 怪物 / 地图的名字与数值，**权威定义只有一处** —— **数据库**
（出厂值在 `server/data/config-sync.sql`，空库启动时由 `bootstrapConfigSnapshot()` 整份灌进去）。

**地图的玩法配置（#573）**：名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶 就在 `maps` 表里（与其它配置同一套做法，
管理端「地图管理」可改），客户端只保留资源约定（`map/<id>/<id>` 目录、对象组与属性名）。地图名录要**同步**读取
（角色详情、实体选择器都在渲染中途要名字），所以走 `src/api/mapCatalog.ts` 的进程内缓存：`Layout` 挂载时
`ensureMapCatalog()` 拉一次，地图页保存成功后再 `refreshMapCatalog()`。

管理端**不复制**一份数据：`src/api/gameData.ts` 登录后拉 `GET /admin/game-data`（与客户端 `GET /game-config` 同一份
快照），索引成几张 Map，之后所有查表都是同步读缓存。**代码里没有任何一份数据副本**。

- 改数值 / 改名字 → 在管理端对应的页面改（保存即落库）→ `make config-export` 把库同步回快照；忘了同步会被
  `make config-check` 逮住；
- **不许在这里或页面里再写一份字典型数据**：`make audit-shared-data` 会扫 `admin/src`，把枚举（职业 / 性别 / 部位 …）
  抄成第二份就 FAIL —— 枚举的唯一手写处是 `server/src/common/constants/game-enums.ts`；
- 页面上的名字都过查表函数（`gameData.ts` 的 `equipmentText` / `skillText` / `itemText` / `soulText` / `titleText` /
  `rankText`…，地图的是 `mapCatalog.ts` 的 `mapText`）。它们只做「查表 + 查不到就显示原 id」，不拼口径 ——
  装备显示名（含前后缀）与部位归属是快照里那几列（`equipment_variants.label`）。

> 缓存没到（还没登录完 / 请求失败）时，名字类查表回落 id 本身，一眼能看出「数据还没加载」。

## 权限模型

界面显隐**只是体验**，**服务端才是权威**。

- 权限点唯一来源在**服务端**（`server/src/common/constants/permission.ts`）；管理端 `src/api/types.ts` 的 `PERMISSION` 是它的镜像，一一对应
- 管理员信息随令牌一起在响应里下发，落到 `store/session`；`hasPermission(点)` 直接查这份数组
- **脏会话兜底**：`admin.permissions` 缺失时按**空数组**处理（最小权限），不会因为会话不完整而放开界面
- 导航项带 `permission` 字段，`Layout` 过滤后再渲染；`App.tsx` 的 `RequirePermission` 外壳守住直达路由
- **加管理端接口时**：服务端 `@ApiAdminDoc({ permissions: [Permission.X] })`（漏了就是真放行），管理端再在 `types.ts` 里补权限点常量（生成物不含权限点字典）

## 口令管理的两个入口（别混）

| 入口 | 在哪 | 校验 | 结果 |
| --- | --- | --- | --- |
| **重置别人** | 账号详情页 / 管理员列表行内 | 不需要原密码（凭权限点） | 前端生成随机口令、**只显示一次**；对方此前签发的令牌**全部作废**，需要重新登录 |
| **改自己** | 「我的账号」页 | **要验原密码** | 服务端**下发新令牌**，前端覆盖本地会话 —— 否则改完立刻被自己踢回登录页 |

管理员列表里「重置密码」对自己那一行是禁用的（提示去「我的账号」）。`ResetPasswordDialog` 是两阶段弹窗：先确认，成功后把口令**显示一次**并支持复制。

## 相关文档

- [FAQ.md](FAQ.md) —— 启动、权限、页面与接口层的具体问题
- [../FAQ.md](../FAQ.md) —— 跨端机制（地址唯一来源、契约管线、三端联动、环境坑）
- [../README.md](../README.md) —— 项目总览、三端索引、目录结构
- [../server/README.md](../server/README.md) —— 这些接口的服务端
