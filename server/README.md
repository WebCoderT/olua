# server · 服务端（NestJS）

> [English](README.en.md) | 简体中文

> 账号 / 角色 / 管理接口的服务端，SQLite 落库，Swagger 文档。
> **它同时是三端接口契约的唯一源头** —— 客户端的 `ApiRoutes/ApiModels/Api.ts` 与管理端的 `routes/models/endpoints.ts` 都由它的 `openapi.json` 生成。
>
> 项目总览见 [../README.md](../README.md)；服务端的问题见 [FAQ.md](FAQ.md)；
> 客户端 / 管理端 / 跨端见 [../client/](../client/) · [../admin/](../admin/) · [../FAQ.md](../FAQ.md)。

## 技术栈

- **NestJS 12** + TypeScript
- **`node:sqlite`**（Node 22 内置，**不需要任何原生模块**，不用编译 sqlite3）
- **JWT**（`@nestjs/jwt`）—— 玩家与管理端两套受众（`aud`）
- **Swagger**（`@nestjs/swagger`）—— 既是人工文档，也是两端接口文件的机器可读来源
- 口令：`node:crypto` 的 `scrypt`（自带盐 + `timingSafeEqual`，格式 `scrypt$salt$hash`，可平滑换算法）

## 环境要求

- **Node.js 22+**（`node:sqlite` 需要 22.5 以上）
- 无需 Docker / 无需外部数据库

## 快速开始

```bash
cd server
npm install
cp .env.example .env     # 首次：端口 / 密钥 / 上限都在这里；注释里逐项说明
npm run dev              # 开发（ts-node 热启动）；npm run build && npm run start 跑构建产物
```

- 接口文档：<http://localhost:3100/api-docs>（JSON 在 `/api-docs-json`，可直接喂给 Postman / 代码生成）
- 健康检查：<http://localhost:3100/api/health>
- 数据库：默认 `server/data/olua.db`（SQLite，WAL 模式；首次启动自动建表 + 补列）

> ⚠️ **在受限终端里跑不起来**（不打日志、不监听端口、看不到任何报错）通常是环境注入了 `NODE_OPTIONS`：
> `env -u NODE_OPTIONS npm run dev`。见 [FAQ.md](FAQ.md#跑测试时一直等待服务启动超时也不打日志为什么)。

## npm 脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（ts-node 直接跑源码） |
| `npm run build` | 编译到 `dist/` |
| `npm run start` | 跑已构建产物 |
| `npm run swagger:emit` | 编译 + 由源码产出 `openapi.json`（契约的唯一来源） |
| `npm run gen:api` | `swagger:emit` + `node ../tools/gen-api.cjs` —— **重新生成两端接口文件** |
| `npm run test:e2e` | 主 e2e（248 条断言） |
| `npm run test:e2e:roles` | 角色管理专项（120 条） |
| `npm run test:e2e:guard` | 运营与安全底座专项（283 条） |
| `npm run test:e2e:mail` | 邮件通道专项（120 条；**假发信器**，不需要 SMTP 服务器） |
| `npm run test:e2e:account-email` | 玩家邮箱字段专项（28 条） |
| `npm run test:e2e:realtime` | 实时通道专项（50 条；**真实 WebSocket 握手**，不需要浏览器） |
| `npm run test:e2e:blocks` | 屏蔽与举报专项（50 条；拉黑单向 / 聊天与互见服务端过滤 / 举报落库与去重） |
| `npm run test:e2e:party` | 队伍专项（79 条；邀请即建队 / 转让与移交 / 经验分成 / 屏蔽优先） |
| `npm run test:e2e:rank` | 排行榜专项（55 条；三榜名次与数值 / 并列竞赛排名 / 分页与 `me` / 快照与定时重算） |
| `npm run test:e2e:backup` | 备份 / 恢复专项（87 条） |
| `npm run db:backup` | 备份数据文件（`VACUUM INTO`，服务运行中也能备） |
| `npm run db:restore` | 从备份恢复（带「服务可能在跑」检测与旧库留档） |
| `npm run verify:api` | `swagger:emit` + 生成物一致性审计 |
| `npm run verify` | **一条命令全验**：编译 + 二十套 e2e + 生成物审计 |

> 仓库根的 `make` 是这些脚本的快捷方式：`make server-dev` / `make server-verify` /
> `make gen-api` / `make server-e2e-guard` 等，`make help` 看全部。
> Makefile 已统一处理 `env -u NODE_OPTIONS`，受限终端里不用再手写前缀。

## 环境变量

全部在 `server/.env`（模板见 `.env.example`，**每一项都有注释说明**）。
代码里不允许再出现这些值的字面量 —— `node ../tools/audit-api-hardcode.cjs` 会检查「用到的键是否都在 `.env.example` 里登记过」。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3100` | 监听端口 |
| `API_PREFIX` | `api` | 全局路由前缀（Swagger 固定在 `/api-docs`，不带前缀） |
| `DB_PATH` | `data/olua.db` | SQLite 文件（相对 `server/`）；`:memory:` 则进程退出即丢 |
| `JWT_SECRET` | 开发占位值 | **生产必须换成随机长串** |
| `JWT_EXPIRES_IN` | `7d` | 令牌有效期 |
| `ADMIN_REGISTER_CODE` | 有值 | 管理端注册码；留空 = 开放注册 |
| `ROLE_MAX_PER_ACCOUNT` | `3` | 每账号角色上限（**只能调低**：不得超过客户端选角界面的站位数量 `roleSelectorLayout.rolePositions`，守卫在查） |
| `CORS_ORIGINS` | `*` | 允许的跨域来源，逗号分隔 |
| `NODE_ENV` | `development` | 只影响标记，不改变行为 |
| `LOG_REQUESTS` | `true` | 是否打印每请求日志（只打方法/路径/耗时，**不打请求体**） |
| `TRUST_PROXY` | `false` | 是否信任反代传来的客户端 IP（**双向陷阱，见下**） |
| `LOGIN_MAX_FAILURES` | `5` | 同一用户名连续失败多少次锁定 |
| `LOGIN_LOCK_MS` | `600000` | 用户名维度锁定时长（10 分钟） |
| `LOGIN_IP_MAX_FAILURES` | `20` | 同一 IP 在锁定时长内失败多少次锁定 |
| `LOGIN_IP_LOCK_MS` | `600000` | IP 维度锁定时长 |
| `AUDIT_LOG_MAX_ROWS` | `20000` | 操作日志保留上限（超出自动清最旧；`0` = 不清理） |
| `MAIL_RETENTION_DAYS` | `90` | 投递记录保留天数（早于该天数的自动清理；`0` = 不按时间清理） |
| `MAIL_QUEUE_MAX_ROWS` | `20000` | 投递记录保留上限（只对已发送 / 已失败生效，避免删掉还没发出去的信；`0` = 不清理） |
| `REALTIME_TICKET_TTL_MS` | `30000` | 实时连接票据的有效期（一次性、用过即焚；票据可以出现在 URL 里，所以只能活 30 秒） |
| `REALTIME_HEARTBEAT_MS` | `30000` | WebSocket 存活探测间隔（服务端发协议层 ping；客户端用它决定应用层 `ping` 的节奏） |
| `REALTIME_EMBEDDED` | `true` | 实时通道是否内嵌主进程；`false` = 独立进程形态（主进程不挂 WS 与取票接口，由 `main.realtime.ts` 单独起实时进程，#37） |
| `REALTIME_PORT` | `3101` | 实时进程的监听端口（只有独立进程形态会用到；nginx 把 `/api/realtime*` 反代到它） |
| `REALTIME_KICK_POLL_MS` | `3000` | 踢下线巡检间隔（轮询库里的在线角色标记，发现被清就断开连接；`0` = 关闭） |
| `CHAT_MAX_LENGTH` | `120` | 单条聊天消息的最大长度（字符；服务端净化后量长度，客户端校验只是省往返） |
| `CHAT_RATE_LIMIT` | `5` | 限频窗口内的最大发言条数（滑窗；超限回 error 帧而不是静默丢弃） |
| `CHAT_RATE_WINDOW_MS` | `10000` | 限频窗口宽度（毫秒；下限 1000，防把窗口配成零等于关掉限频） |

> **`TRUST_PROXY` 的双向陷阱**：挂在 Nginx / 网关后面**必须设 `true`** —— 否则所有请求的来源 IP 都是代理的，
> 登录限流会把全部玩家当成同一个人、一起锁死；反过来**直连暴露时必须保持 `false`** —— 开着等于允许调用方
> 随便伪造 `X-Forwarded-For` 绕过 IP 限流。这一条在 `.env.example` 里也写明了。

> **`ROLE_MAX_PER_ACCOUNT` 只能往下降**：「能建几个角色」在客户端那边是**界面容量** ——
> 选角布局 `configs/layout/scenes` 的 `roleSelectorLayout.rolePositions` 有几个**站位**，界面上就能站几个，
> 而客户端的提前拦截就是「站位满了」。所以这个值**不得超过站位数量**：调大了玩家能建出界面上没处放的
> 角色（多出来的会叠在原点）。二者不再是「同一件事」，因此也不需要一起改 ——
> 加站位是布局 / 美术的活，调这个只往下走。仓库里的默认值由 `tools/audit-shared-data.cjs` 守着；
> **部署那台的 `.env` 不进仓库**，守卫看不到，所以别把它调过站位数量。

## 目录结构

```
server/
├── src/
│   ├── main.ts                     引导（NestExpressApplication + trust proxy + ValidationPipe + CORS）
│   ├── app.module.ts
│   ├── config/configuration.ts     ← 所有环境变量的唯一读取处（含类型转换与默认值）
│   ├── common/
│   │   ├── constants/biz-code.ts       业务码（1xxxx 账号 / 2xxxx 角色 / 3xxxx 管理端 / 4xxxx 通用）
│   │   ├── constants/permission.ts     ← 权限点与管理员角色的唯一来源
│   │   ├── constants/swagger-tags.ts   文档分组（顺序即展示顺序）
│   │   ├── constants/status.ts         状态常量
│   │   ├── decorators/                 api-doc / api-data-response / api-query-model /
│   │   │                               audience / audit-target / current-user / permission / public
│   │   ├── dto/api-envelope.dto.ts     统一响应包裹
│   │   ├── errors/biz.exception.ts     业务异常
│   │   ├── filters/all-exceptions.filter.ts   统一错误出口
│   │   ├── guards/auth.guard.ts        受众校验 + 每次回查库（封禁/删除/令牌版本即时生效）
│   │   ├── guards/permission.guard.ts  权限点校验（注册在 AuthGuard 之后）
│   │   ├── interceptors/audit.interceptor.ts   管理端写接口自动记日志
│   │   ├── interceptors/transform.interceptor.ts · logging.interceptor.ts
│   │   ├── interfaces/api-envelope.interface.ts
│   │   ├── security/login-throttle.service.ts   内存计数器（用户名 + IP 双维度）
│   │   └── utils/password.util.ts（scrypt）· rate-limit.util.ts（限流纯函数）
│   ├── database/
│   │   ├── database.service.ts     连接 / 建表 / ensureColumn 补列 / ensureSuperAdmin 兜底
│   │   ├── database.module.ts
│   │   ├── rows.ts                 行类型与 JSON 列解析
│   │   └── repositories/           account / admin / role / audit / system / announcement / mail / world-monster / map-spawn-area / zone / title / soul / growth / rank / equipment / drug / item / monster / npc / mall / fashion / drop-table / monster-drop / skill / status / monster-skill / guild / social / quest / quest-progress / report / party 32 个仓储
│   ├── modules/
│   │   ├── auth/                   玩家注册登录（JWT、令牌版本）
│   │   ├── roles/                  角色 CRUD / 选角在线 / 存档推送（含 20006 / 20007 判定）
│   │   ├── admin/                  管理端：认证 / 账号 / 角色 / 管理员 / 口令 / 公告
│   │   ├── announcement/           公告：客户端拉「生效中」（公共）+ 管理端 CRUD
│   │   ├── mail/                   邮件：模板 + 投递队列 + 后台调度（发信只入队）
│   │   ├── zone/                   区服（#295 阶段二）：活区列表（公共）/ 开区 / 合并区
│   │   ├── social/                 社交：帮会（#388：创建 / 申请 / 审批 / 成员 / 转让 / 解散，管理端改名与强制解散）+ 好友与敌人（#389）+ 屏蔽与举报（#398：拉黑单向一行 / 举报只落库 + 管理端只读列表 + `report:read`）
│   │   ├── party/                  队伍（#399）：邀请即建队 / 同意拒绝 / 踢人转让 / 队长退出自动移交 / 解散；
│   │   │                           队伍与成员两表落库（一人一队由 `role_id UNIQUE` 兜底），邀请存内存 30 秒过期
│   │   ├── leaderboard/            排行榜（#400）：等级 / 战力 / 击杀三榜，进程内物化按周期重算，
│   │   │                           排序·名次·截断·字段裁剪全在服务端（击杀数读 `roles.kills` 索引列）
│   │   ├── realtime/               实时通道：票据换 WebSocket 连接 / 心跳 / 优雅关闭 / 聊天转发（#395：世界=同图 / 帮会 / 私聊，限频与长度上限在服务端；#398 起聊天与互见都按 `role_blocks` 逐收件人剔除）
│   │   ├── audit/                  操作日志查询
│   │   ├── system/                 系统信息（运行时 / 各表行数 / 脱敏配置快照）
│   │   ├── token/                  JWT 签发与校验（双受众）
│   │   └── health/
│   ├── shared/
│   │   ├── game-data.generated.ts  公共游戏数据快照（**三端唯一的游戏数据来源**；@generated，
│   │   │                           重生成 = node tools/gen-shared-data.cjs）
│   │   └── game-data.ts            服务端门面（手写）：从上面那份派生职业 / 性别码清单与文档文案
│   └── swagger/
│       ├── setup.ts                文档挂载（抽成函数，好让测试也生成一次来验分组/权限/悬空 $ref）
│       ├── models.ts               文档用的响应模型
│       └── emit.ts                 ← 离线产出 openapi.json
├── scripts/                        备份 / 恢复（VACUUM INTO + 五步恢复，见 scripts/lib/db-tooling.cjs）
├── test/
│   ├── e2e.cjs                     248 条断言（真实起服务 + 真实 HTTP 请求）
│   ├── e2e-roles.cjs               120 条
│   ├── e2e-guard.cjs               283 条
│   ├── e2e-mail.cjs                120 条（假发信器：入队 / 投递 / 重试上限 / 未启用时禁用）
│   ├── e2e-account-email.cjs       28 条（邮箱可见性 / 补录去重 / 发信按账号兜底）
│   ├── e2e-realtime.cjs            50 条（票据换连接 / 握手拒连 / 心跳与顶连接 / 优雅关闭）
│   ├── e2e-combat.cjs              32 条（伤害结算上移：服务端算伤 / 幂等重发 / 目标查世界实例 / 清账不复活）
│   ├── e2e-world.cjs               24 条（世界权威：服务端按刷怪区自播种 / 结算落世界 / tick 重生 / 关闭落盘 / 重启恢复）
│   ├── e2e-dual.cjs                14 条（双进程形态：存档与实时分进程 / 跨进程令牌校验 / 踢下线巡检断连 / WAL 跨进程写）
│   ├── e2e-zone.cjs                32 条（区服：注册选区 / 合并区边界 / 世界按区隔离 / 合并生效与代际失效）
│   ├── e2e-guild.cjs               60 条（帮会：建帮与重名 / 申请覆盖 / 审批权限 / 人数上限 / 踢人转让退出 / 解散级联）
│   ├── e2e-social.cjs              47 条（社交：好友申请与互加直接同意 / 拒绝不留痕 / 撤回与删除 / 敌人单向 / 镜像行 / 互见帧身份）
│   ├── e2e-chat.cjs                35 条（聊天：世界同图广播 / 正文净化 / 限频读配置 / 帮会准入查库 / 私聊校验与离线整条拒绝）
│   ├── e2e-quest.cjs               48 条（任务：接取门控 / talk·kill·collect 三目标推进 / 交付发奖一次落库 / 日常领奖后可重接）
│   ├── e2e-sell.cjs                24 条（出售：快照价结算 / 同 id 多格合并 / 客户端报价无效 / 不可卖 / 整单拒绝 / 乐观锁 / 越权）
│   ├── e2e-blocks.cjs              50 条（屏蔽与举报：单向拉黑 / 聊天与互见服务端过滤 / 举报去重与落库 / 管理端只读列表）
│   ├── e2e-party.cjs               79 条（队伍：邀请即建队 / 同意拒绝 / 踢人转让 / 队长退出移交 / 解散 / 经验分成 / 屏蔽优先）
│   ├── e2e-rank.cjs                55 条（排行榜：三榜名次与数值 / 并列竞赛排名 / 分页与 size 夹上限 / me 榜外名次 / 快照与定时重算 / 条目八字段）
│   └── backup.cjs                  87 条（运行中备份 / 恢复留档 / 保护性拒绝 / 自动定时备份）
├── openapi.json                    机器可读契约（提交进仓库）
├── data/                           SQLite 数据文件（不进版本库）
└── .env.example · package.json · tsconfig.json · tsconfig.build.json
```

## 数据模型

40 张表，全部由 `DatabaseService` 在启动时 `CREATE TABLE IF NOT EXISTS` 建出；**存量库靠 `ensureColumn`（PRAGMA table_info）补列**，不需要迁移脚本。

| 表 | 存什么 | 关键点 |
| --- | --- | --- |
| `accounts` | 玩家账号 | 口令存 scrypt 摘要；`status` 封禁位；**`token_version`** 令牌版本号 |
| `roles` | 角色 | `data` 列存客户端 `entities/Role` 的 **JSON 字符串**；索引字段（id/name/occupation/sex/level）另落列；**`revision`** 乐观锁版本；`online_role_id` 由账号侧指向当前在线角色 |
| `admins` | 管理端账号 | 独立于玩家账号体系；`role`（super_admin / admin / viewer）；**`token_version`** |
| `audit_logs` | 操作日志 | 动作 = 接口 `operationId`；`detail` 落请求体（已打码）；`success` / `status_code` / `actor_name` / `target_id` / `path` |
| `announcements` | 公告 | 标题 / 正文 / `level`（`important` 优先展示）/ `enabled`；`starts_at` / `ends_at` 组成生效时间窗，**「生效中」的判据就是这三列**（建了 `idx_announcements_window`） |
| `mail_queue` | 邮件投递队列 | **渲染后的**标题与正文（冻在入队那一刻）/ `status` / `attempts` / `next_retry_at` / `last_error`；发信接口只入队，投递由后台调度器做 |
| `world_monsters` | 世界权威的怪物实例 | **服务端持有怪物状态**：instanceId（`m<mapId>_z<zone>_<n>` 发牌、带区段、跨重启稳定）/ zone_id / mapId / monsterKey / 出生点 x,y / hp / alive / killed_at / respawn_at；tick 检查重生 + dirty 批量落盘 |
| `zones` | 区服（#295 阶段二） | 一行 = 一个游戏区；注册时选定归属区（`accounts.zone_id` 引用）；合并区在 `merged_into` 打去向标记（不删行，历史可查）；一区 seed 恒在（id=1，默认区） |
| `guilds` | 帮会（#388） | 帮会名**全局唯一**；`leader_id` 是帮主的**第一份身份**（第二份是 `guild_members.rank='leader'` 那行，转让必须同一事务改两处）；`level` / `funds` 只占位（等级与资金业务未做）；人数上限**不在这里**，走 `GUILD_MEMBER_LIMIT` 配置 |
| `guild_members` | 帮会成员（#388） | `PRIMARY KEY (guild_id, role_id)` + **`role_id` 唯一索引** —— 「一个人只能在一个帮会」是库约束，不是业务自觉（并发两次入帮靠自觉必然留下两条）；`rank`（leader / vice / member） |
| `guild_applications` | 入帮申请（#388） | `PRIMARY KEY (guild_id, role_id)`：**重复申请只覆盖留言**，不会堆出两条待办；拒绝 = 直接删行（不留记录）；通过 = 写成员行 + 删申请 + 清掉申请人挂在别处的申请（同一事务） |
| `role_friends` | 好友关系（#389） | **镜像两行**：A↔B 各一行（`PRIMARY KEY (role_id, friend_id)`），`status`（pending / accepted）+ `requested_by` 记发起人。所有查询都是一次主键前缀查，不必 `OR` 两方向再判方向；代价是同意 / 拒绝 / 删除要**成对改**（一律走事务）。只有两态，**没有拉黑**（本项目无私聊，多一态只会让每处查询多记一个合法值） |
| `role_enemies` | 敌人标记（#389） | **单向一行**：`PRIMARY KEY (role_id, enemy_id)`，我标我的，对方既不知道也不受影响（没有通知、不需要事务）。关系优先级里敌意压过同帮与好友 |
| `quests` | 任务配置（#396） | 单目标（kill / talk / collect）+ 奖励（金币 / 经验 / 物品 JSON 列）；`kind` 分主线（一次性）与日常（领奖删行可重接）；`prev_quest_id` 组线性链，环检测在 service（`assertQuestConsistency`）。管理端可增删改，改完随配置快照下发 |
| `quest_progress` | 玩家任务进度（#396） | `PRIMARY KEY (role_id, quest_id)`；`status`（accepted / ready / claimed）+ `progress`。kill 由实时进程在击杀结算时直写，talk 由 NPC 对话推进，collect 在交付时查背包；主线领奖后留 `claimed` 行作链门控，日常领奖删行 |
| `world_meta` | 世界代际（#295 阶段二） | 单行表（id 恒为 1）；合并区时 `epoch`+1，两个进程的世界内存靠轮询它作废旧状态（跨进程的「库被改写过」信号） |
| `map_spawn_areas` | 刷怪区（#295 阶段一） | **从客户端 Tiled 导入一次后归服务端**：`tools/import-spawn-areas.cjs` 生成 SPAWN_AREAS 快照（提交进仓库），启动时空表自动 seed；每区域按 max 在矩形内随机落点播种，worldJoin 只收 mapId |
| `level_exps` | 升级经验（#256） | 等级序列固定（1..roleMaxLevel），只可改不可增删；一行 = 升到下一级所需经验 |
| `growth_segments` | 成长曲线分段（#256） | 四条分段线性曲线 × 段；改段必须保持连续覆盖 1..roleMaxLevel（跨行校验） |
| `growth_scalars` | 成长标量参数（#256） | 等级上限 / 属性区间倍率 / 经验节奏；各键取值域见服务端常量 |
| `ranks` | 军衔配置（#250） | 阶数序列固定（1..100），只可改不可增删；衔名 / 大段名 / 晋升价格 / 八项属性 |
| `equipments` | 装备基础件配置（#252） | 主键是基础件 id（如 `cloth_1`，变体不进库）；部位 / 等级需求 / 售卖价 / 八项属性；id / 部位结构固定，只可改不可增删 |
| `drugs` | 药品配置（#253） | 主键是药品 id（如 `drug_hp_1`，被掉落表与背包引用）；名称 / 描述 / 售卖价 / 堆叠 / 冷却 / 四项回复量（effects 按键求和）；id 清单固定，只可改不可增删 |
| `items` | 物品与材料配置（#255） | 主键是物品 id（如 `material_hide`，被掉落表与脚本引用）；只收 MATERIAL / OTHER 大类；名称 / 描述 / 售卖价 / 堆叠；id 清单固定，只可改不可增删 |
| `monsters` | 怪物基础数据（#258） | 主键是怪物 key（configs/monster 的关联键，被地图刷怪点 / 掉落表引用）；名称 / 等级 / 生命 / 六项攻防区间；**世界播种与伤害结算直读本表（改值即时生效）**；key 清单固定，只可改不可增删 |
| `npcs` | NPC 基础数据（#258） | 主键是 NPC id（Tiled 对象组的关联键）；名称 / 对话文案（seed 为空串，客户端暂无对话数据形态）；id 清单固定，只可改不可增删 |
| `skills` | 技能配置（#367） | 主键是技能 id；**角色与怪物同表**，`owner`（`role` / `monster`）区分并可按归属筛选；分类 / 目标类型 / 动作 / 特效 / 冷却 / 耗蓝 / 距离 / 等级 / 伤害系数（JSON，下标 = 等级 - 1）/ 挂载状态 `status_id` / **释放限制**（`cast_lock_ms` 动作锁、`require_target`）；跨字段约束在 service（状态型必须挂状态、主动至少一条倍率、`status_id` 必须存在）；**怪物技能（9000 段）可增删**（角色技能清单固定，id 被技能栏 / 快捷键 / 存档引用；被怪物挂载引用中的行拒删） |
| `statuses` | 状态配置（#367） | 主键是状态 id（被 `skills.status_id` 引用）；`owner` 同上分流；时长 / 来源 / 图标 / 身上特效 / `combat`（JSON：格挡概率、格挡系数、防御倍率、**攻击倍率**，缺省 = 该维度不参与）——**角色侧公式在客户端 `BattleMath`，怪物侧在服务端 `MonsterAiService`**（#372：狂怒乘出手伤害、硬化皮肤乘防御项）；id 清单固定，只可改不可增删 |
| `monster_skills` | 怪物技能挂载（#372） | 复合主键（`monster_key` + `skill_id`）；一只怪放哪些技能、`priority`（越小越先）、`cooldown`（秒，NULL = 用技能自身的冷却）；**整份替换**（PUT 这份清单就是全部，空数组 = 只普攻）；校验技能必须存在且 `owner=monster`、同怪不重复挂 |
| `fashions` | 时装配置（#257） | 主键是时装 id（configs/fashionClothes，如 `cloth_2`）；名称 / 描述 / 售卖价 / 获得渠道（复用 AcquireChannel，seed 默认 unavailable）/ 八项属性（seed 全 0）；`icon` / `in_res` / `out_res` 资源路径不开放编辑；id 清单固定，只可改不可增删；**角色存档的 `fashionCloth` 存的就是这里的 id**（#377 穿戴系统，null = 没穿） |
| `mall_prices` | 商城特殊定价（#251） | 主键是商品 id（装备变体 id，商品清单来自生成物）；**全库唯一允许动态增删的配置表**（PUT upsert / DELETE 回统一价）；未定价商品走 `mall_settings` 的统一价 |
| `mall_settings` | 商城统一价（#251） | 单行表（id 恒为 1）；全场默认售价 seed 自生成物 MALL_DEFAULT_PRICE（客户端 configs/mall 的 mallPrice），运营可改 |
| `drop_tables` | 掉落表（#254） | 主键是表 id（`[a-z][a-z0-9_]{0,49}`）；`picks`（捞取次数）与 `entries`（goodId / 权重 / 概率 / 数量区间）都是 JSON 列，结构校验在 service（goodId 必须在生成物 ITEM_LABELS 里）；**允许动态增删的配置表**（同 mall_prices 定位），被 `monster_drops.table_id` 引用中的行拒删；seed 三张具名表 common / elite / boss + default 兜底 |
| `monster_drops` | 怪物掉落（#254） | 主键是怪物 key（configs/monster 关联键）；`source` 三选一：`table`（引用 drop_tables）/ `entries`（内联条目 + 必填 picks）/ `none`（清空）；key 与怪物一一对应，只有 list + PATCH 整份替换，不可增删 |

**角色数据是「不透明文档」**：服务端**不复制**游戏配置，只校验结构 / 归属 / 数量上限 / 重名，内容原样存。
原因与代价见 [FAQ.md](FAQ.md#服务端为什么不校验角色数据的内容)。

文档里唯一例外被单独校验的是**新手引导进度**（`guide`，#402）：`step` 必须是整数且不超过体量上限
（`ROLE_GUIDE_STEP_MAX`，与等级上限同性质，**不是「客户端的引导配置有几步」**）、
`done` / `skipped` 必须是布尔、多余字段丢弃；**没有这个字段时服务端不会补默认值** ——
客户端正是靠「文档里有没有 `guide`」区分老号（视为已完成，不弹引导）与新号。

⚠️ 读写路径态度不同：**读取容错**（坏数据当空对象），**编辑必须严格解析、失败即报错** ——
用空对象兜底去写会把玩家的背包/装备清空（踩过的坑，e2e 里钉了断言）。

## 内部边界：跨模块调用走白名单边

模块按职责分域：**gateway**（`realtime/`：HTTP 取票 + WS 入口 + 伤害结算）、**world**（`world/`：怪物实例与 tick）、**combat**（`combat/`：属性汇总与比对**纯函数**）、**存档**（`auth/` `roles/` `admin/` 与仓储层）。规矩有三条，全由 `tools/audit-server-boundaries.cjs` 机器把守：

- **跨域 import 走白名单边**：不在这张表里的跨模块引用，CI 直接 fail —— 加新边 = 改 `ALLOWED_EDGES` / `REPO_EDGES` = 有意识的决策，而不是顺手 `import` 一下；
- **仓储只由全局 `DatabaseModule` 装配**（32 个仓储都在它那里 provide + export）：业务模块的 providers 里再注册一个同名仓储类，会与全局单例并存出**第二个实例**（mail 踩过：本地又注册了一遍 `AccountRepository`）；
- **combat 只许引基础层**（common / shared / config）：它被存档与结算两侧引用，往上引任何实现都会成环。

## 进程拆分：存档进程与实时进程（#175）

同一份代码、两个入口，按需装配（`AppModule.register({ realtime })`）：

| | 存档进程（`main.ts`） | 实时进程（`main.realtime.ts`） |
| --- | --- | --- |
| 端口 | `PORT`（默认 3100） | `REALTIME_PORT`（默认 3101） |
| 装载 | 全部 HTTP 模块（玩家 / 管理端 / 公告 / 邮件 / 备份） | 实时通道 + 取票 + 世界权威 + 结算 |
| 默认形态 | `REALTIME_EMBEDDED=true` 时**兼载**实时模块（单进程，本地开发与全部 e2e 的形态） | 只在独立部署时起 |

- **客户端零改动**：取票与 WS 走同一个 `/api/realtime*` 路径前缀，部署时 nginx 按路径把这一段反代到实时进程 —— `configs/network.ts` 的单一来源约定不破；
- **踢下线跨进程**：管理端在存档进程清 `online_role_id`（库），实时进程按 `REALTIME_KICK_POLL_MS` 巡检发现连接对应的账号已无在线角色 → 主动断开（`4000`）。内嵌形态下同样生效（补上「踢下线不立即断 WS」的欠账）；
- **令牌作废天然跨进程**：`token_version` 每次请求对库比对，两进程各读各的库就是同一份真相；
- **存储**：两进程共享同一个 SQLite 文件（WAL + `busy_timeout`，见根 FAQ「为什么选 SQLite」）—— 实时进程写 `world_monsters` 与结算血量，存档进程写账号 / 角色表，各写各的表。

## 怪物 AI 与技能释放（#323 / #372）

怪物的**行为权威在服务端**（`MonsterAiService`，tick 100ms / 广播按 200ms 节流）：
目标选择、追击、待机游走、普攻、以及**放技能**都由服务端决定，客户端只做演出。

- **技能从表里来**：`monster_skills` 决定「这只怪放哪些、什么顺序」（先状态型 buff、再伤害型，
  同类型内 `priority` 升序、同优先级按技能 id 稳定排序），`skills` 提供动作 / 特效 / 倍率 / 距离 /
  施法硬直，`statuses` 提供状态时长与数值修正。三者都**读库 + 1 秒 TTL 缓存** ——
  管理端改完最多 1 秒生效（两个进程只能靠共享 SQLite 交换改动，没有通知通道）；
- **`casts` 帧**：`{ instanceId, skillId, statusId? }`。客户端据它播动作与特效，
  **不带伤害**（数值权威在 `hits` 帧），所以状态型技能（没有伤害）也能被演出来；
  普攻没有单独的出手事件，客户端用 `hits` 反推并跳过已被 `casts` 覆盖的实例；
- **状态在服务端真的生效**：`attackMultiplier` 乘出手伤害、`defenseMultiplier` 乘被玩家打时的防御项
  （`CombatSettlementService` 调 `defenseMultiplierOf`）；到期惰性清理，同状态刷新不叠层；
- **施法硬直**：`castLockMs`（0 回落到普攻动作时长）期间既不移动也不出手，普攻间隔一并推后；
- **刻意不做的**：怪物位置不落盘（持久真相是出生点）、玩家位置不权威（客户端节流上报当 AI 输入）、
  怪物不消耗魔法值。

## 认证与权限

两层，**都在守卫里，业务代码禁止写角色判断**：

1. **受众**（`AuthGuard`）：令牌里的 `aud` 是 `player` 还是 `admin`，守卫按接口要求校验；
   并且**每次请求都回查一次库** —— 封禁 / 删除 / 改口令因此即时生效，不用等令牌过期
2. **权限点**（`PermissionGuard`，注册在 `AuthGuard` 之后）：直接用 `request.user.role` 不再查库

权限点的唯一来源是 `src/common/constants/permission.ts`（25 个权限点 / 3 种角色）：

| 角色 | 权限 |
| --- | --- |
| 超级管理员 `super_admin` | 全部（含「管理管理员」与「重置管理员密码」） |
| 管理员 `admin` | 除「管理管理员」外全部 —— 管理员之间不能互相提权 |
| 只读观察员 `viewer` | 只看：概览 / 账号列表与详情 / 角色列表与详情 / **公告列表** / **养成配置列表** / **区服列表** / **帮会列表**（**看不到操作日志、系统信息，也看不到邮件投递记录与玩家举报**） |

> 公告为什么给观察员留了**只读**：它是面向全服的公开内容，读了不等于能改；而「发布 / 编辑」是单列的
> `announcement:write`（对外发声，会直接推给玩家），观察员拿不到。
>
> 邮件**反过来**不给观察员（`mail:read` 不在它的六个读权限里）：投递记录里有玩家的**邮箱地址**，
> 属于个人信息 —— 观察员的定位是看业务数据，不该顺手拿到一份可导出的玩家联系方式。
> 这条界线看起来像「只是又一个读权限」，很容易顺手加错。

**加管理端接口必须用 `@ApiAdminDoc({ permissions: [Permission.X] })`** —— 它同时落三处：
① 文档说明 ② `x-olua-permissions` 扩展（给机器读）③ `RequirePermissions` 运行时元数据。
**漏了就是真放行**（曾只写文档不校验，权限全放行，被 e2e 抓出）。

拒绝时：无权限 `403` + 业务码 **30006**；保护性拒绝 `403` + **30007**（**最后一个启用中的超管**不能降级 / 停用 / 删除）。

## 接口与契约

当前 **143 个接口 / 119 条路径 / 212 个模型**，按「谁能调」分三组（`common/constants/swagger-tags.ts` 声明，顺序即展示顺序）：

| 分组 | 数量 | 令牌要求 |
| --- | --- | --- |
| 公共接口 | 7 | 无需令牌（健康检查、玩家注册登录、管理员登录注册、拉取生效中的公告、**拉取活区列表**） |
| 客户端 | 40 | `player` 令牌，只能操作自己账号的数据 |
| 管理端 | 96 | `admin` 令牌 + 每个接口各自的权限点 |

**分组是按「方法」标的，不是按控制器**：一个控制器里常同时有公共与需登录接口（例如 `auth` 的 `register/login` 属公共、`me` 属客户端）。
所以**控制器不写类级 `@ApiTags`**，统一用 `common/decorators/api-doc.decorator` 的组合装饰器；
并且 `createDocument(..., { autoTagControllers: false })` 必须关掉（默认 `true` 会拿控制器类名当分组，文档里会多出一堆
`Health` / `Auth` 之类的类名分组）。e2e 钉了「每个接口恰好属于一个分组」。

### 改接口 = 改服务端 + 重新生成两端

```bash
cd server && npm run gen:api     # = swagger:emit + node ../tools/gen-api.cjs
```

**唯一的代码生成方向**：

```
server/src（控制器 + DTO + 装饰器）   ← 唯一手写的地方
      │ npm run swagger:emit
      ▼
server/openapi.json（提交进仓库的契约）
      │ node ../tools/gen-api.cjs
      ▼
client/assets/ui/utils/net/{ApiRoutes,ApiModels,Api}.ts
admin/src/api/{routes,models,endpoints}.ts
```

生成器认文档里的这几个字段（由装饰器写入，不靠猜）；完整的字段表见
[../README.md 的「改接口 = 改服务端 + 重新生成」](../README.md#4-改接口--改服务端--重新生成)。
生成物禁止手改，`../tools/audit-api-generated.cjs` 会逐字节盯着。

## 运营与安全底座

四块能力放在一起说，因为它们是同一批补上的运营缺口：

### 口令管理

- 玩家**没有找回流程**，只能客服在管理端重置；管理端注册码由 `ADMIN_REGISTER_CODE` 控制
- 管理员**改自己的密码**走「我的账号」（要验证原密码），成功后服务端**下发新令牌** ——
  否则库里版本号已 +1、旧令牌当场失效，改完立刻被自己踢回登录页
- 改密与版本号自增写在**同一条 SQL** 里，避免「口令改了但版本号没加」的半截状态

### 令牌主动作废

无状态 JWT 光改口令踢不掉旧令牌，所以 `accounts` / `admins` 各加一列 `token_version`：
签发令牌时写进载荷（`ver`），`AuthGuard` 每次请求回查库比对，不符就 `401` + 业务码 **40103**。
存量令牌没有 `ver` 字段按 `0` 处理（向后兼容，不需要清库）。

### 登录限流

- **纯函数 + 内存计数器**：判定全在 `common/utils/rate-limit.util.ts`（`afterFailure` / `lockedForMs` /
  `remainingAttempts` / `describeWait`…），计数在 `LoginThrottleService` 的 Map 里（`u:<小写用户名>` 与 `i:<ip>`）
- **两个维度**任一超限即锁；**达阈值时计数归零**（锁定期满从 0 重算）—— 把「误锁之后一错再错」的体验问题，
  换成「爆破速率上限 = 阈值 ÷ 锁定时间」
- **用户名去空格 + 转小写**后再计数，换个大小写绕不开限流
- `maxFailures <= 0` = 关闭该维度（e2e 正是靠它把 IP 维度放宽到 1000，才能单独验用户名维度）
- 不落库：这是短命速率状态，落库只会带来写放大与垃圾；代价是进程重启归零，单实例 SQLite 可接受，
  将来换 Redis 接口形状不变

### 踢下线

只清 `online_role_id` 是拦不住人的 —— 玩家本地还在跑，1.5 秒后照样把存档推上来。
所以 `RolesService.save` 加了一道判定：**推上来的角色必须仍是账号当前的在线角色**，否则 `409` + 业务码 **20007**。
判定放在**乐观锁之前** —— 被踢的玩家该看到「回选角」，而不是反复重试「版本冲突」。

### 操作审计

- 只看 `POST/PUT/PATCH/DELETE`，跳过 `@Public()` 与玩家令牌。**读接口不记** —— 否则翻一页列表就把日志刷满
- **动作就是接口标识**：`@ApiAdminDoc({ operationId })` 顺带 `SetMetadata(AUDIT_ACTION_KEY, operationId)`，
  于是「文档里的接口标识」与「日志里的 action」永远是同一个字符串，**新增接口零额外工作**
- **登录成功与失败都记**（那时还没有已认证的操作人，所以操作人留空、把尝试的账号名放进 `detail`）
- **敏感字段递归打码**：字段名命中 `/pass(word)?|secret|token|registercode|credential/i` 就换成 `***`，宁可多打
- **绝不影响主流程**：`record()` 内部吞掉一切异常（日志表写不进去也不该让一次封号失败）；超量时每写 200 条顺手清一次最旧的
- 目标名字用相关子查询取当前值（一张表打三种目标，JOIN 要写三段 UNION），目标已删就显示「（已删除）」+ id

## 测试与回归

二十套 e2e 都是**真实起服务进程 + 真实 HTTP 请求**（不是 mock）：

| 脚本 | 断言数 | 覆盖 |
| --- | --- | --- |
| `test/e2e.cjs` | **248** | 注册登录 / 角色 CRUD 与上限重名 / 保存与切换在线 / 越权与令牌受众隔离 / 管理端全流程 / **文档三组分类与每个接口的权限标注** / 只读观察员越权 / 超管保护 / **公告的公共拉取与生效时间窗** |
| `test/e2e-roles.cjs` | **120** | 角色管理专项：修订号乐观锁 / 六维筛选 / 结构化字段校验 / 批量与整账号删除 / 只读观察员越权 / 文档 |
| `test/e2e-guard.cjs` | **283** | 运营与安全底座：口令重置与令牌作废 / 自助改密 / 操作日志落库·打码·筛选·导出 / 用户名与 IP 双维度限流 / 踢下线 / 封禁闭环 / 看板 / 列表排序 / 系统信息与启动自检 |
| `test/e2e-mail.cjs` | **120** | 邮件通道：入队即返回 / 后台投递到已发送 / **指数退避重试与用尽上限后标失败**（原因可查）/ 手动重投把次数归零 / 未配置 SMTP 时整体禁用 / 密钥只报形态 / 模板必填变量缺失即拒发。用**可注入的假发信器**（`MAIL_TRANSPORT=fake|fail`），不需要真实 SMTP |
| `test/e2e-account-email.cjs` | **28** | 玩家邮箱字段：只读观察员看不到也改不了 / 补录·查看·清空 / 格式校验与同邮去重（大小写不敏感）/ 发信按关联账号邮箱兜底 / 契约权限点标注 |
| `test/e2e-realtime.cjs` | **50** | 实时通道：票据一次性（换完即焚 / 过期 / 伪造 / 串号都拒）/ **握手被拒时回答的是一个 HTTP 401 包裹体而不是「先建连再关」** / 应用层 ping→pong / 一账号一条连接（新连接顶掉旧的，关闭码 `4000`）/ 协议层存活探测 / SIGTERM 时连接收到 `1001` 且进程立刻退出 |
| `test/e2e-combat.cjs` | **32** | 伤害结算上移（世界权威适配）：非法出手全被拒（bad_request / unknown_skill / unknown_target / skill_not_learned）/ **伤害由服务端按快照数值算出**（落点在公式带内、血量算术自洽）/ 同 castId 幂等重发（duplicate、不重掷、不多扣血）/ 死亡由服务端判（killed 恰好一次、之后 target_dead）/ **目标查世界实例**（不存在的 instanceId 拒收）/ 清账不复活死怪 / 快照带重生倒计时 / 换图往返状态保持 / 重连 rejoin 不翻倍 |
| `test/e2e-world.cjs` | **24** | 世界权威：**空图按刷怪区播种**（不认识的怪物 key 跳过、落点在区域矩形内、重复 join 不翻倍、账号间共享同一实例）/ 结算直接落世界（快照血量 = 结算血量、B 视角同步）/ 打死怪进重生队列 / **tick 到点重生并广播** / 优雅关闭全量落盘 / **重启后实例身份与血量原样恢复**（到期重生一次性补处理） |
| `test/e2e-dual.cjs` | **14** | 双进程形态（#175）：存档进程（`REALTIME_EMBEDDED=false`）没有实时接口（取票 404）/ 实时进程凭**同一份库**校验令牌（取票 → WS → welcome）/ worldJoin 播种与 cast 结算在实时进程跑通 / 落盘后**测试进程开只读连接可见** `world_monsters`（WAL 承接跨进程写）/ 管理端在存档进程踢下线 → 实时进程巡检间隔内断连（close `4000`）/ 存档进程重置密码 → 旧令牌在实时进程取票被拒（`token_version` 对库比对） |
| `test/backup.cjs` | **87** | 备份 / 恢复：运行中 `VACUUM INTO` 拿一致快照 / 恢复后旧库留档 / 坏文件与「服务可能在跑」的保护性拒绝 / 自动定时备份（真实进程、失败可见、到点判定纯函数） |
| `test/e2e-rank.cjs` | **55** | 排行榜（#400）：**三个榜（等级 / 战力 / 击杀）的名次与数值逐个对** / 并列时同名次（竞赛排名，同分再按 roleId 升序）/ 战力榜与等级榜不同序（证明不是照抄等级）/ 分页切片、空页、`size` 夹上限与非法分页 `/ `me` 榜内榜外名次都真实、当前无在线角色时返回「没有名次」、未登录被拒 / 刷新周期设为零时快照不随存档变、`computedAt` 不动 / 条目恰好八个字段且不带 `accountId`·`data`·在线状态 / 周期定时重算真的换了一份 |


```bash
cd server && npm run verify          # 编译 + 二十套 e2e + 生成物一致性，一条命令全验
env -u NODE_OPTIONS npm run verify   # 受限终端里要清掉 NODE_OPTIONS
```

改了哪块就优先跑对应那套（改角色接口 → `test:e2e:roles`；改口令 / 审计 / 限流 / 踢下线 → `test:e2e:guard`；改邮件 → `test:e2e:mail`；改屏蔽 / 举报 → `test:e2e:blocks`；改排行榜 → `test:e2e:rank`；改实时通道 → `test:e2e:realtime`），
但**提交前 `npm run verify` 都该过一遍**。

## 相关文档

- [FAQ.md](FAQ.md) —— 启动、数据模型、权限、限流与审计的具体问题
- [../FAQ.md](../FAQ.md) —— 跨端机制（地址唯一来源、契约管线、三端联动、环境坑）
- [../README.md](../README.md) —— 项目总览、三端索引、目录结构
- [../admin/README.md](../admin/README.md) —— 消费这些接口的后台
- [../client/README.md](../client/README.md) —— 消费这些接口的客户端
