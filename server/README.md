# server · 服务端（NestJS）

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
| `npm run test:e2e:roles` | 角色管理专项（77 条） |
| `npm run test:e2e:guard` | 运营与安全底座专项（279 条） |
| `npm run test:e2e:backup` | 备份 / 恢复专项（25 条） |
| `npm run db:backup` | 备份数据文件（`VACUUM INTO`，服务运行中也能备） |
| `npm run db:restore` | 从备份恢复（带「服务可能在跑」检测与旧库留档） |
| `npm run verify:api` | `swagger:emit` + 生成物一致性审计 |
| `npm run verify` | **一条命令全验**：编译 + 四套 e2e + 生成物审计 |

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
| `ROLE_MAX_PER_ACCOUNT` | `3` | 每账号角色上限（**与客户端 `configs/role.maxRoleCount` 必须一致**） |
| `CORS_ORIGINS` | `*` | 允许的跨域来源，逗号分隔 |
| `NODE_ENV` | `development` | 只影响标记，不改变行为 |
| `LOG_REQUESTS` | `true` | 是否打印每请求日志（只打方法/路径/耗时，**不打请求体**） |
| `TRUST_PROXY` | `false` | 是否信任反代传来的客户端 IP（**双向陷阱，见下**） |
| `LOGIN_MAX_FAILURES` | `5` | 同一用户名连续失败多少次锁定 |
| `LOGIN_LOCK_MS` | `600000` | 用户名维度锁定时长（10 分钟） |
| `LOGIN_IP_MAX_FAILURES` | `20` | 同一 IP 在锁定时长内失败多少次锁定 |
| `LOGIN_IP_LOCK_MS` | `600000` | IP 维度锁定时长 |
| `AUDIT_LOG_MAX_ROWS` | `20000` | 操作日志保留上限（超出自动清最旧；`0` = 不清理） |

> **`TRUST_PROXY` 的双向陷阱**：挂在 Nginx / 网关后面**必须设 `true`** —— 否则所有请求的来源 IP 都是代理的，
> 登录限流会把全部玩家当成同一个人、一起锁死；反过来**直连暴露时必须保持 `false`** —— 开着等于允许调用方
> 随便伪造 `X-Forwarded-For` 绕过 IP 限流。这一条在 `.env.example` 里也写明了。

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
│   │   └── repositories/           account / admin / role / audit / system / announcement 六个仓储
│   ├── modules/
│   │   ├── auth/                   玩家注册登录（JWT、令牌版本）
│   │   ├── roles/                  角色 CRUD / 选角在线 / 存档推送（含 20006 / 20007 判定）
│   │   ├── admin/                  管理端：认证 / 账号 / 角色 / 管理员 / 口令 / 公告
│   │   ├── announcement/           公告：客户端拉「生效中」（公共）+ 管理端 CRUD
│   │   ├── audit/                  操作日志查询
│   │   ├── system/                 系统信息（运行时 / 各表行数 / 脱敏配置快照）
│   │   ├── token/                  JWT 签发与校验（双受众）
│   │   └── health/
│   └── swagger/
│       ├── setup.ts                文档挂载（抽成函数，好让测试也生成一次来验分组/权限/悬空 $ref）
│       ├── models.ts               文档用的响应模型
│       └── emit.ts                 ← 离线产出 openapi.json
├── scripts/                        备份 / 恢复（VACUUM INTO + 五步恢复，见 scripts/lib/db-tooling.cjs）
├── test/
│   ├── e2e.cjs                     248 条断言（真实起服务 + 真实 HTTP 请求）
│   ├── e2e-roles.cjs               77 条
│   ├── e2e-guard.cjs               279 条
│   └── backup.cjs                  25 条（运行中备份 / 恢复留档 / 保护性拒绝）
├── openapi.json                    机器可读契约（提交进仓库）
├── data/                           SQLite 数据文件（不进版本库）
└── .env.example · package.json · tsconfig.json · tsconfig.build.json
```

## 数据模型

五张表，全部由 `DatabaseService` 在启动时 `CREATE TABLE IF NOT EXISTS` 建出；**存量库靠 `ensureColumn`（PRAGMA table_info）补列**，不需要迁移脚本。

| 表 | 存什么 | 关键点 |
| --- | --- | --- |
| `accounts` | 玩家账号 | 口令存 scrypt 摘要；`status` 封禁位；**`token_version`** 令牌版本号 |
| `roles` | 角色 | `data` 列存客户端 `entities/Role` 的 **JSON 字符串**；索引字段（id/name/occupation/sex/level）另落列；**`revision`** 乐观锁版本；`online_role_id` 由账号侧指向当前在线角色 |
| `admins` | 管理端账号 | 独立于玩家账号体系；`role`（super_admin / admin / viewer）；**`token_version`** |
| `audit_logs` | 操作日志 | 动作 = 接口 `operationId`；`detail` 落请求体（已打码）；`success` / `status_code` / `actor_name` / `target_id` / `path` |
| `announcements` | 公告 | 标题 / 正文 / `level`（`important` 优先展示）/ `enabled`；`starts_at` / `ends_at` 组成生效时间窗，**「生效中」的判据就是这三列**（建了 `idx_announcements_window`） |

**角色数据是「不透明文档」**：服务端**不复制**游戏配置，只校验结构 / 归属 / 数量上限 / 重名，内容原样存。
原因与代价见 [FAQ.md](FAQ.md#服务端为什么不校验角色数据的内容)。

⚠️ 读写路径态度不同：**读取容错**（坏数据当空对象），**编辑必须严格解析、失败即报错** ——
用空对象兜底去写会把玩家的背包/装备清空（踩过的坑，e2e 里钉了断言）。

## 认证与权限

两层，**都在守卫里，业务代码禁止写角色判断**：

1. **受众**（`AuthGuard`）：令牌里的 `aud` 是 `player` 还是 `admin`，守卫按接口要求校验；
   并且**每次请求都回查一次库** —— 封禁 / 删除 / 改口令因此即时生效，不用等令牌过期
2. **权限点**（`PermissionGuard`，注册在 `AuthGuard` 之后）：直接用 `request.user.role` 不再查库

权限点的唯一来源是 `src/common/constants/permission.ts`（15 个权限点 / 3 种角色）：

| 角色 | 权限 |
| --- | --- |
| 超级管理员 `super_admin` | 全部（含「管理管理员」与「重置管理员密码」） |
| 管理员 `admin` | 除「管理管理员」外全部 —— 管理员之间不能互相提权 |
| 只读观察员 `viewer` | 只看：概览 / 账号列表与详情 / 角色列表与详情 / **公告列表**（**看不到操作日志，也看不到系统信息**） |

> 公告为什么给观察员留了**只读**：它是面向全服的公开内容，读了不等于能改；而「发布 / 编辑」是单列的
> `announcement:write`（对外发声，会直接推给玩家），观察员拿不到。

**加管理端接口必须用 `@ApiAdminDoc({ permissions: [Permission.X] })`** —— 它同时落三处：
① 文档说明 ② `x-olua-permissions` 扩展（给机器读）③ `RequirePermissions` 运行时元数据。
**漏了就是真放行**（曾只写文档不校验，权限全放行，被 e2e 抓出）。

拒绝时：无权限 `403` + 业务码 **30006**；保护性拒绝 `403` + **30007**（**最后一个启用中的超管**不能降级 / 停用 / 删除）。

## 接口与契约

当前 **46 个接口 / 37 条路径 / 60 个模型**，按「谁能调」分三组（`common/constants/swagger-tags.ts` 声明，顺序即展示顺序）：

| 分组 | 数量 | 令牌要求 |
| --- | --- | --- |
| 公共接口 | 6 | 无需令牌（健康检查、玩家注册登录、管理员登录注册、**拉取生效中的公告**） |
| 客户端 | 8 | `player` 令牌，只能操作自己账号的数据 |
| 管理端 | 32 | `admin` 令牌 + 每个接口各自的权限点 |

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

四套 e2e 都是**真实起服务进程 + 真实 HTTP 请求**（不是 mock）：

| 脚本 | 断言数 | 覆盖 |
| --- | --- | --- |
| `test/e2e.cjs` | **248** | 注册登录 / 角色 CRUD 与上限重名 / 保存与切换在线 / 越权与令牌受众隔离 / 管理端全流程 / **文档三组分类与每个接口的权限标注** / 只读观察员越权 / 超管保护 / **公告的公共拉取与生效时间窗** |
| `test/e2e-roles.cjs` | **77** | 角色管理专项：修订号乐观锁 / 六维筛选 / 结构化字段校验 / 批量与整账号删除 / 只读观察员越权 / 文档 |
| `test/e2e-guard.cjs` | **279** | 运营与安全底座：口令重置与令牌作废 / 自助改密 / 操作日志落库·打码·筛选·导出 / 用户名与 IP 双维度限流 / 踢下线 / 封禁闭环 / 看板 / 列表排序 / 系统信息与启动自检 |
| `test/backup.cjs` | **25** | 备份 / 恢复：运行中 `VACUUM INTO` 拿一致快照 / 恢复后旧库留档 / 坏文件与「服务可能在跑」的保护性拒绝 |

```bash
cd server && npm run verify          # 编译 + 四套 e2e + 生成物一致性，一条命令全验
env -u NODE_OPTIONS npm run verify   # 受限终端里要清掉 NODE_OPTIONS
```

改了哪块就优先跑对应那套（改角色接口 → `test:e2e:roles`；改口令 / 审计 / 限流 / 踢下线 → `test:e2e:guard`），
但**提交前 `npm run verify` 都该过一遍**。

## 相关文档

- [FAQ.md](FAQ.md) —— 启动、数据模型、权限、限流与审计的具体问题
- [../FAQ.md](../FAQ.md) —— 跨端机制（地址唯一来源、契约管线、三端联动、环境坑）
- [../README.md](../README.md) —— 项目总览、三端索引、目录结构
- [../admin/README.md](../admin/README.md) —— 消费这些接口的后台
- [../client/README.md](../client/README.md) —— 消费这些接口的客户端
