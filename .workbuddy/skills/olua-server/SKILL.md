---
name: olua-server
description: olua 项目服务端（NestJS 12 + node:sqlite + JWT + Swagger）的开发与改接口做法。它同时是「三端接口契约的唯一源头」——控制器 + DTO + 装饰器产出 server/openapi.json，再由 tools/gen-api.cjs 生成客户端与管理端两端的接口文件，所以加接口的唯一正确顺序是「改服务端 → 补 operationId → npm run gen:api → 两端 build」。涵盖：三档分组装饰器 @ApiPublicDoc / @ApiPlayerDoc / @ApiAdminDoc（分组按方法标、控制器禁写类级 @ApiTags、createDocument 必须 autoTagControllers 传 false）、管理端接口必须带 permissions（同时落文档说明 + x-olua-permissions + RequirePermissions 运行时元数据，漏了就是真放行）、@ApiDataResponse 的 x-olua-data-schema 与 x-olua-data-nullable、@ApiQueryModel 的 x-olua-query-schema、两层守卫（AuthGuard 受众每次回查库 + PermissionGuard 权限点注册在其后，业务代码禁写角色判断）、统一响应包裹 code message data timestamp 与业务码分段（1xxxx 账号 / 2xxxx 角色 / 3xxxx 管理端 / 4xxxx 通用）、SQLite 四表仓储与 ensureColumn 存量补列、全局 ValidationPipe whitelist 会静默剥掉嵌套裸对象属性（必须带装饰器的 DTO 类加 ValidateNested each true 加 Type 并登记 SWAGGER_MODELS）、分页必须用 PageMetaDto 而非 isArray、同账号角色重名 20005、清在线标记必须早于删角色行、角色修订号 revision 乐观锁、口令管理（重置玩家口令 / 管理员自助改密 / token_version 让旧令牌立即作废 40103）、操作日志（审计拦截器只审写方法、action 复用 operationId、敏感字段递归打码、prune 限容、目标名用相关子查询、keyword 的 LIKE 通配符要转义）、登录限流（纯函数 rate-limit.util + 内存 LoginThrottleService、用户名与 IP 两维度、达阈值计数归零、TRUST_PROXY 双向陷阱）、踢下线（只清在线标记拦不住本地客户端，必须叠加存档写入拒收 20007 且判定放在乐观锁之前）、服务端不认识客户端配置只做结构体量与格式校验、swagger emit 与 gen api 与 verify api 与全部 e2e（e2e / e2e-roles / e2e-guard / mail / account-email / realtime / combat / world / dual / backup）与 verify 脚本的写法（真实起服务 + 真实请求 + setupSwagger 生成真文档验分组权限与悬空引用）、实时通道（一次性票据换 WebSocket 连接：握手复用 AuthGuard 的结论而不另写一套校验、拒连时回的是与其余接口同形的 HTTP 401 包裹体而不是先建连再关、协议层 ping/pong 存活探测、一账号一条连接、收连接必须写在 onModuleDestroy 而不是 onApplicationShutdown 否则死锁）、每处理完一个问题按功能提交一次代码（改接口的提交必须连 openapi.json 与两端生成物一起提交）。触发场景：用户说"改服务端接口""加一个接口""给接口补权限点""Swagger 分组不对""文档里少了某个接口""服务端校验失败""接口报 500""分页接口文档写成数组""e2e 挂了""数据库加一列""后台改角色""角色改名""乐观锁冲突""前端类型跟服务端对不上""重置密码""改密码""旧令牌还有效吗""操作日志""审计""谁改了什么""登录被锁""限流""踢下线""把玩家踢出去""反代拿不到真实 IP"。
agent_created: true
---

# olua 服务端（NestJS）：三端接口契约的唯一源头

`server/` 是三个**平级子工程**之一（另两个：客户端 Cocos 工程在 `client/`，管理端在 `admin/`；仓库根只放总 README / FAQ 与跨端 `tools/`）。
服务端只做四件事：

1. **鉴权** —— 玩家 / 管理端两套 JWT 受众；
2. **角色数据落库** —— SQLite，`roles.data` 存客户端 `entities/Role` 的 JSON 快照（**字符串**）；
3. **产出接口契约** —— Swagger 文档 → 客户端与管理端的接口文件**全部由它生成**；
4. **实时通道** —— 一条 WebSocket 长连接（目前只做「建连 + 心跳」，业务消息见 #34）。

**最重要的一条心智模型（#655 定稿）**：游戏数据（等级 / 装备 / 战魂 / 称号 / 军衔 / 技能 / 物品 / 怪物 / 掉落 / 地图 / 特效…）的
权威定义**只有一处 —— 数据库**。`server/data/config-sync.sql` 是它的**出厂快照**（32 张配置表，逐表整表替换），
空库启动时由 `bootstrapConfigSnapshot()` 整份灌进去；运营在管理端改的就是库里的行，`make config-export` 把库重导回那份 SQL。
代码里**没有第二份数值副本**：`server/src/shared/` 整个目录已删除，客户端 `configs/*` 全是**空的运行时表**
（进游戏由 `GET /game-config` 快照整表重建），管理端也不 import 任何生成物 —— 它直接调 `/admin/*` 读写库。
服务端只校验「结构 / 体量 / 归属 / 上限 / 重名」，不做任何派生计算（每级属性、每件装备的属性与回收价、
每个变体的前后缀都是库里逐条写好的列）。

**推论（改数据前先想清这四条）**：
- 想改一个数值 → 改**库**（管理端页面或 `config-sync.sql` + `make config-import`），不要改代码里的常量；
  改了代码常量而不在库里，等于写了个没人读的第二份。
- 想给某个域加一个可配项 → 建**列/行 + 管理端页面 + 快照段**三件套，`GROWTH_SCALAR_SPECS` 那种「代码里挂一个改了没用的旋钮」是反例。
- 测试只锁**字段格式与行为**，不锁数值（出厂值运营随时改，锁数值的红是假红）。
- 出厂快照只在**空库首启**整表替换；服务端启动之后再写库才有效（e2e 播种踩过两次）。

**地图是这条心智模型的一部分、不是例外**：资源本体（TMX / 底图 / 预览图）在客户端，靠 `map/<id>/<id>` 目录约定拼路径；
「对资源的整理」（名称 / 类型 / 进入条件 / 像素尺寸 / 刷怪区）在 `maps` / `map_spawn_areas` 表里。

**连「码的清单」与「文案」也不许手写**（#122）：`role-data.util.ts` 的 `ROLE_OCCUPATIONS` / `ROLE_SEXES`
派生自 `constants/game-enums.ts` 的 `ROLE_OCCUPATION_CODES` / `ROLE_SEX_CODES`（= `Object.keys(OCCUPATION_LABELS / SEX_LABELS)`），
DTO 里那行 `1 战士 / 2 魔法师 / …` 用 `OCCUPATION_HINT` / `SEX_HINT` —— 加一个职业码，校验清单与文档说明**自动跟着变**。
手动写回字面量（清单或文案）会被 `make audit-shared-data` 咬住。

## 一、目录与职责

```
server/src
  main.ts                         启动装配（ValidationPipe / 过滤器 / 拦截器 / setupSwagger / trust proxy）
  main.realtime.ts                实时进程入口（#37：AppModule.register 决定实时模块装不装，独立端口 REALTIME_PORT，不挂 Swagger）
  config/configuration.ts         环境变量的**唯一读取处**
  common/
    constants/biz-code.ts         业务码（0 成功；1xxxx 账号 / 2xxxx 角色 / 3xxxx 管理端 / 4xxxx 通用）
    constants/permission.ts       权限点 + 管理员角色 + ROLE_PERMISSIONS 映射（**唯一来源**）
    constants/swagger-tags.ts     文档分组声明（顺序即展示顺序）
    decorators/api-doc.decorator.ts            @ApiPublicDoc / @ApiPlayerDoc / @ApiAdminDoc（顺带落审计 action）
    decorators/api-data-response.decorator.ts  @ApiDataResponse
    decorators/api-query-model.decorator.ts    @ApiQueryModel
    decorators/audit-target.decorator.ts       @AuditTarget(type, source) 审计目标
    decorators/{audience,permission,public,current-user}.decorator.ts
    dto/api-envelope.dto.ts       统一包裹 + PageQueryDto（keyword 是公共字段，含义由各接口覆写说明）
    guards/auth.guard.ts          受众校验（每次请求回查库 + 比对令牌版本号 ver）
    guards/permission.guard.ts    权限点校验（注册在 AuthGuard **之后**）
    security/security.module.ts   @Global()：登录限流服务只在这里 provide / export
    security/login-throttle.service.ts  内存计数器（用户名 + IP 两维度）
    interceptors/audit.interceptor.ts   管理端写接口自动记日志（挂在 AuditModule 上，不在 AppModule）
    filters/ interceptors/ errors/ utils/password.util.ts utils/rate-limit.util.ts
  database/
    database.service.ts           建表+ migrate() 里的 ensureColumn 存量补列
    repositories/                 account / admin / role / audit / system / announcement / mail / world-monster / map-spawn-area / zone / title / soul / growth / rank / equipment / drug / item / monster / npc / mall / fashion / drop-table / monster-drop / skill / status / monster-skill / guild / social / quest / quest-progress / report / party / achievement / role-achievement / role-mail / equip-align / equip-in-align / ui-effect
  modules/
    auth/    玩家注册登录（限流 + 登录审计）
    roles/   角色 CRUD（存档写入必须校验「仍是账号当前在线角色」）+ role-data.util.ts（结构校验）
    admin/   管理端（认证 / 账号 / 角色 / 管理员）
    announcement/ 公告（客户端拉「生效中」的公共接口 + 管理端 CRUD）
    mail/    邮件通道（模板 + 投递队列 + 后台调度；发信接口只入队）
    party/   队伍（#399：邀请即建队 / 同意拒绝 / 退出踢人转让解散 / 队长退出自动移交；
             两张表落库（`role_id UNIQUE` 兜底一人一队），邀请存内存 30 秒过期；
             唯一写者是 PartyService，热路径只缓存 roleId→partyId）
    realtime/ 实时通道（取票据接口 + Upgrade 握手 + 心跳；票据与连接在**实时进程**内存里，单实例能力——可随主进程内嵌（默认）也可由 main.realtime.ts 独立成进程，见 #37/#175）
    world/   世界权威（怪物实例服务端持有 / tick 重生 / 空闲回收 / dirty 落盘；realtime 的 worldJoin 与 world 帧接它）
    audit/   操作日志查询（只读两接口；interceptor 与 service 同模块）
    system/  系统信息（运行时 / 各表行数 / 脱敏配置快照；快照走白名单，密钥只报形态）
    token/   JWT        health/  健康检查
    ⮑ 内部边界（#36）：跨模块 import 只能走 tools/audit-server-boundaries.cjs 的白名单边
      （ALLOWED_EDGES / REPO_EDGES）；仓储只由全局 DatabaseModule 装配（业务模块 providers 里
      再注册同名仓储 = 第二个实例，mail 踩过）；combat 纯函数只许引基础层。
  swagger/
    models.ts   SWAGGER_MODELS（要出现在文档里的 DTO 必须登记）
    setup.ts    buildSwaggerDocument() + setupSwagger(app)（main 与自动化测试**共用同一份**）
    emit.ts     离线产出 openapi.json（npm run swagger:emit）
openapi.json                     机器可读契约（**提交进仓库**）+ 两端接口文件的唯一输入
test/e2e.cjs                     全量回归
test/e2e-roles.cjs               角色管理专项
test/e2e-guard.cjs               口令 / 审计 / 限流 / 踢下线专项（起两台服务各验一轮）
test/e2e-mail.cjs                邮件通道专项（假发信器）
test/e2e-account-email.cjs       玩家邮箱字段专项
test/e2e-realtime.cjs            实时通道专项（真实 WebSocket 握手）
test/e2e-combat.cjs              伤害结算专项（世界权威适配）
test/e2e-world.cjs               世界权威专项（tick / 落盘 / 重启恢复）
test/e2e-dual.cjs                双进程形态专项（存档与实时分进程 / 踢下线巡检断连）
test/e2e-game-config.cjs         养成配置专项（称号 / 战魂 / 军衔阶位表）
test/backup.cjs                  备份 / 恢复专项
test/e2e-zone.cjs                区服专项（多开区 / 合并区）
test/e2e-guild.cjs               帮会专项（建帮 / 申请 / 审批 / 转让 / 解散）
test/e2e-social.cjs              社交专项（好友 / 敌人 / 互见身份）
test/e2e-chat.cjs                聊天专项（世界同图广播 / 私聊 / 限频）
test/e2e-quest.cjs               任务专项（四写入口 / 日常重接）
test/e2e-sell.cjs                出售专项（快照价结算 / 整单拒绝）
test/e2e-bag.cjs                 背包与穿戴专项（穿戴 / 卸下 / 丢弃 / 整理搬运守恒 / 权威边界 / 网格尺寸）
test/e2e-blocks.cjs              屏蔽与举报专项（聊天与互见按 role_blocks 过滤）
test/e2e-party.cjs               队伍专项（邀请 / 权限 / 移交 / 屏蔽优先 / 经验分成）
test/e2e-rank.cjs                排行榜专项（全服榜单）
test/e2e-achievement.cjs         成就专项（累计 / 状态两种存储 / 背包满转邮件）
test/e2e-game-mail.cjs           游戏内邮件专项（领奖 / 拒删看金币经验附件 / 先标后发同事务 / 一键领取逐封容错 / 频道与两处投递；71 条断言）
test/e2e-equip-align.cjs         装备对齐几何专项（#513）
test/e2e-equip-in-align.cjs      装备内观几何专项（73 条断言，#523）
```

## 二、加 / 改一个接口的标准动作

**顺序不能反**：先改服务端，再由生成器产出两端。

1. **写 DTO**（`modules/<域>/dto/*.dto.ts`）
   - 每个字段都要 `@ApiProperty` / `@ApiPropertyOptional`；可空字段要 `type` + `nullable: true`（**只写 `nullable` 生成器只能给 `unknown`**）；
   - **嵌套数组 / 对象必须**是带装饰器的 DTO 类 + `@ValidateNested({ each: true })` + `@Type(() => XxxDto)`（见坑 1，最容易静默出错的地方）；
   - 新 DTO 登记进 `swagger/models.ts` 的 `SWAGGER_MODELS`；
   - 分页响应**不要**写 `@ApiDataResponse(X, { isArray: true })`，用 `dto/page-result.dto.ts` 的 `XxxPageDto`（= `PageMetaDto` + list）。
2. **写控制器方法**，挂三档分组装饰器之一，**必须给 `operationId`**（`<模块>.<方法>`，如 `role.save`）：

   ```ts
   @ApiAdminDoc({
     operationId: "adminRole.patch",
     summary: "修改角色",
     description: "……",
     permissions: [Permission.ROLE_WRITE],   // 管理端接口**必带**，漏了就是真放行
   })
   @ApiQueryModel(RoleQueryDto)              // 有 query DTO 时（列表接口），否则 query 只能生成成裸对象
   @ApiDataResponse(RoleDto)                 // 有响应体时；无响应体的接口不写
   ```

   - 一个控制器里常同时有公共接口与需登录接口 → **控制器不写类级 `@ApiTags`**，分组按**方法**标；
   - 三档分别落：公共接口（无令牌）/ 客户端（`player` 令牌）/ 管理端（`admin` 令牌 + 权限点）。
3. **权限点先加在 `common/constants/permission.ts`**：加权限点 → 决定哪些角色拥有它（**只改 `ROLE_PERMISSIONS`**）→ 再在装饰器上引用。**业务代码里禁止写角色判断**。
4. 跑 **`npm run gen:api`**（= `swagger:emit` + `node ../tools/gen-api.cjs`）重新产出文档与两端接口文件。
5. 两端跑 `tsc` / `npm run build`，**签名不兼容会直接编译报错**（这正是设计目的），按报错改调用点。
6. 跑 **`npm run verify`**（编译 + **十套** e2e + 生成物一致性审计）。

> 契约管线的完整细节（`x-olua-*` 扩展对照表、生成器的 `MODULES` 映射、守卫脚本的分段检查）见
> `references/contract-pipeline.md`。

## 三、权限模型：两层，都在守卫里

| 层 | 谁管 | 解决什么 | 关键实现 |
|---|---|---|---|
| **受众** audience | `AuthGuard` | 「谁能进这扇门」 | `aud = player / admin` 两套令牌；**每次请求回查库** → 封禁 / 删除即时生效 |
| **权限点** permission | `PermissionGuard` | 「进门之后能干什么」 | 注册在 AuthGuard **之后**，直接用 `request.user.role`，不再查库 |

- 管理员账号在**独立 `admins` 表**（注册需 `ADMIN_REGISTER_CODE`；**第一个注册者自动是超管**）；
- 三级角色：`super_admin`（全给）/ `admin`（除 `admin:manage`）/ `viewer`（`stats:read` + `account:read` + `role:read`）；
- 服务端一共 **28 个权限点**（`config:read` / `config:restore` 是 #882 加的配置版本链）：`account:password`（重置玩家口令）、`account:email`（补录 / 查看玩家邮箱）、`announcement:write`（发公告）、`mail:read` / `mail:write`（投递记录与发信）、`audit:read`（查操作日志）、`system:read`（看系统信息）与 `gameConfig:read` / `gameConfig:write`（养成配置，#213）都是逐个后加的 —— **观察员只有 6 个读权限（`stats:read` / `account:read` / `role:read` / `announcement:read` / `gameConfig:read` / `zone:read`），上面这些一个都没有**（它只看业务数据，不该能接管账号、拿玩家联系方式或看部署形态；公告是面向全服的公开内容所以给它读，**投递记录里有玩家邮箱所以不给** —— 这条界线很容易被顺手抹掉）；
- 无权限 → `403` + `30006`（message 写出缺哪个权限）；保护性拒绝 → `30007`（**最后一个启用中的超管**不能降级 / 停用 / 删除）；
- `admins.role` 列由 `ensureColumn` 补 + `ensureSuperAdmin()` 兜底存量库；
- **加管理端接口必须 `@ApiAdminDoc({ permissions: [...] })`** —— 它同时落三处：文档说明、`x-olua-permissions` 扩展、`RequirePermissions` 运行时元数据。只写文档不写装饰器 = **权限全放行**（真出过，被 e2e 抓出来的）。
- **`@Public()` 只有一类正当理由：玩家还没拿到令牌那一刻要用的数据**。现有两处：`GET /announcements/active`
  （登录页弹公告）与 `GET /game-config/audio`（#683，登录场景要播背景音，而快照要令牌）。
  判据：**里面没有任何玩家数据 / 账号数据**，且客户端进到有令牌之后就不该再走它
  （音效进游戏后读快照的 `audio` 段，两条路同形状 —— 别让同一个值有两个来源）。

## 四、数据层规矩

**4.0 游戏数据的唯一权威 = 数据库**（#603 逐域上移，#655 收口）

`server/data/config-sync.sql` 是**全部配置表的出厂快照**（38 张；等级曲线 24 段、装备变体行、
怪物 / 掉落 / 地图 / 刷怪区 / 特效 / 运行时参数 / 货币道具 / 升级卷轴都在里面）。空库启动时 `bootstrapConfigSnapshot()`
整表灌入，之后运营在管理端改库，`make config-export` 把库重导回那份 SQL 提交 —— **多机同步靠 SQL，不靠种子**。

- **代码里没有第二份数值副本**：`server/src/shared/` 整个目录已删（旧的 `game-data.generated.ts`、
  19 个 `*-seed.ts`、5 个 `*.generated.ts` 全没了）。服务端读库或读启动时建的**内存投影**
  （`common/runtime-config-cache.ts`），客户端 `configs/*` 是空的运行时表（快照整表重建），
  管理端直接调 `/admin/*` 读写库 —— 三方都不 import 任何生成物。
- **派生值也落库**（#655）：`equipment_variants`（含前后缀名 / 八项属性 / sell_price）、
  `equip_aligns`（32）/ `equip_in_aligns`（31）。运行时**零现算**：`equipmentAttributesOf` /
  `sellPriceOf` 只读表，不回落到任何公式（旧兜底是 bug：生成物给的是 `[min,max]` 元组，读方按 `{min,max}` 取）。
  **等级是这条规则的例外（#786）**：100 万级存不下，库里只放段参数，`roleLevelAttributesOf(level)`
  按需求值并带 memo —— 于是「派生值落库」只剩装备这一条线。
- **曲线只在等级域**：`role_level_curves`（4 条 × 6 段 = 24 行，主键 `(curve, seq)`）；
  旧的 `growth_segments` / `level_exps` / `role_levels` 启动即 `DROP TABLE IF EXISTS`（老库收尾，新库空操作）。
  管理端「成长参数」= 4 张曲线段表 + **等级属性计算器**（`GET admin/level-curves/preview?level=`）
  + 四个全局标量（`roleMaxLevel` / `expGain.expPerLevel` / `expGain.maxLevelGap` / `mpRecoverPerSecond`）。
  `GROWTH_SCALAR_SPECS` 里**不许再挂没有消费方的键** —— `attributeRange.*` 那三个换算比率就是这么死掉的。
- **加一个可配项 = 三件套**：库里的列/行 + 管理端页面（含 DTO 与仓储 UPDATE 列清单，漏一处就是 200 但值不动）
  + 快照段（`createClientConfigDto` 与 `snapshot()` 同步加）。缺任何一件都不算配好。
- **后加的表要给存量库补数据**（#785 `money_items` / #787 `level_scrolls`）：已经跑过很久的库不会再自举
  （`config_meta` 里有 marker），只改 `config-sync.sql` 的话老库重启后表是空的 —— 管理端页面空白、玩家拿到道具也用不了，
  而且**没有任何报错**。做法是 `migrate()` 末尾一段 `INSERT OR IGNORE` + 自己的 marker
  （`seedMoneyItemsOnce` / `seedLevelScrollsOnce`），与 `common/constants/*-seed` 同源；运营改过的值不会被覆盖。
- **服务端要认识每张物品表**：`runtime-config-cache.ts` 的 `itemTypeOf` / `itemLabelOf` / `sellPriceOf` 三处
  加新表（回收价、掉落文案、道具判定都读它）—— 漏一处的表现是「回收价 0 / 名字显示 id / 认不出这个道具」，
  全都不报错。升级卷轴（#787）还多一条：`useLevelScroll` 判定读库，客户端那份只做本地预检。
- **`make audit-shared-data` 守的是什么**：配置快照完整（表齐 / 每张非空 / 行数自洽）+ 枚举与客户端逐值一致 +
  业务代码里没有第二份枚举 + 跨端常量对齐。它对的账是 `config-sync.sql`，不是生成物。
- **旧坑已不适用**：「seed 是 `INSERT OR IGNORE`、改种子不生效」是 #603 时代的问题；现在出厂值本身就是快照
  整表替换，改数据只有两条路 —— 管理端改库，或改 `config-sync.sql` 再 `make config-import`。


**4.0.4 配置同步：库 ↔ SQL 快照（#653）**

多人协作各自跑本地时，配置靠 `make config-export` / `make config-import` 对齐（不碰运行时数据）：

- **分类唯一处** `scripts/lib/config-tables.cjs`（38 张配置 + 24 张运行时）。库里出现**没归类的表**，
  导出直接报错 —— 新加表忘了分类由这条守点抓（比「漏同步」好查得多）。
- **整表替换**（每张表 `DELETE` + 逐行 `INSERT`）：upsert 表达不了删除，会让对方库里删掉的行永远留着。
  代价是文件必须全量，所以导入前校验「表清单完全一致 + 每表恰好一条 DELETE + 不含运行时表」，
  少一张就拒绝 —— 否则那张会被清空，而界面上只表现为「这一页空了」。
- **导入三道自保**：前留档 `data/backups/config-before-import-*.sql`；导入前校验；
  导入后**重新生成快照与文件逐字节比对**。别用「没抛异常」当成功。
- `make config-check` 报「哪张表第几行落后」，提交前自检；`--check` 落后退出码 1。
- **导入后必须重启服务端**：`RuntimeConfigService` 与实时进程各持一份内存副本。
- 仓库 PUBLIC：`server/data/*.db` 忽略，`config-sync.sql` 是唯一例外。忽略规则要写 `data/*` 而不是
  `data/` —— 父目录整体被排除时 `!data/config-sync.sql` 放不开（真踩过）。

**4.0.2 角色存档的权威边界：谁能写哪个字段**（#548）

`PUT /roles/:id` 是「客户端推**整份**存档」的形态（`data` 是不透明文档），所以「哪些字段归服务端」
必须有明文，否则就是**靠 review 记性**防作弊。边界定义在 `modules/roles/role-authority.ts`，
`save()` 按它分流 —— 判据在 `tools/audit-role-authority.cjs`（`make audit` 的一项）。

| 类别 | 字段 | 权威 | 依据 |
|---|---|---|---|
| 账本 | `gold` / `bindGold` / `silver` | **服务端** | 商城 / 回收 / 成长线 / 任务 / 成就 / 邮件 / 后台各有服务端写点；客户端只有 `applyServerRoleUpdate` 一个入口，**没有任何本地改写** |
| 成长线阶位 | `title` / `soulOfWar` / `rank` | **服务端** | 只有 `upgradeGrowth` 能推进（扣费 + 成长链校验都在那） |
| 派生值 | `combat` / `maxHp` / `hpRecover` / `maxMp` / 六项攻防 | **服务端重算** | `applyAuthoritativeAttributes` 每次写档现算覆盖，不走回填 |
| 客户端全权 | `bag` / `equipments` / `skills` / `hp` / `mp` / `onMap` / `fashionCloth` / `soulShow` / `avatar` / `shortcutKeys` / `speedRate` / `guide` | 客户端 | 换装、整理背包、丢弃、走图、喝药回血、引导推进都在本地；收权要先补一整套服务端接口 |

- **回填而不是拒收**：客户端报的账本值与库不符 → 用库值覆盖后继续落库，并打一条 warn。
  拒收（409）会把「客户端少收了一帧」变成玩不了；回填下一次 `roleUpdate` 自动纠正。
  **要拦的是「写进去」，不是「发过来」。**
- **库里没有这个字段就放行**：老存档（服务端接管前的本地档）首次上传时文档里没有 `bindGold` 这类键，
  这时客户端那份是唯一来源 —— 删掉等于把玩家的钱清零。只在「服务端写过」之后才回填。
- **建号是唯一没有旧值可比的口子**：#597 起 `create` 的入参只有名称 / 职业 / 性别三样，出厂文档
  由服务端 `initial-role.ts` 的 `buildInitialRoleData` 一次性造好（背包空、装备空、账本全 0、
  初始技能 1xxx 全 1）—— 旧的 `clampInitialCurrency` / `ROLE_INITIAL_CURRENCY` 口子已随
  「建号送钱」一起退场，不存在「客户端报多少初始货币」的问题了。
  缺字段按「没提要求」处理 → 给出厂值（与「没有行 = 出厂值」同一口径）。
- **血蓝夹在 `[0, 上限]`**（`clampVitals`，必须在重算之后调）：当前值归客户端（自然回复在本地），
  但超上限只可能是改包或存档错乱；客户端 `applyServerRoleUpdate` 自己也做同一条 `Math.min`。
- **还没收的（有意留白，别当成漏了）**：
  - `level` / `exp`：客户端有两条本地加经验的路（实时通道不可用时的结算兜底 `MonsterManager.awardKillExp`、
    泡点活动 `AutoUpgrade`），收权会让这两条路径的经验被静默丢弃。要收得先把泡点做成服务端 tick；
  - `bag` / `equipments` / `skills`：本地操作太多（换装 / 整理 / 移动 / 丢弃 / 穿时装），得先有对应的服务端接口；
  - `hp` / `mp`：自然回复与技能扣减在客户端，收权需要服务端出回复 tick。

- **47 张表**：`accounts` / `roles` / `admins` / `audit_logs` / `announcements` / `mail_queue` / `world_monsters` / `map_spawn_areas` / `zones` / `world_meta` / `titles` / `souls` / `ranks` / `equipments` / `drugs` / `items` / `monsters` / `npcs` / `fashions` / `mall_prices` / `mall_settings` / `drop_tables` / `monster_drops` / `level_exps` / `growth_segments` / `growth_scalars` / `skills` / `statuses` / `monster_skills` / `guilds` / `guild_members` / `guild_applications` / `role_friends` / `role_enemies` / `role_blocks` / `role_reports` / `quests` / `quest_progress` / `parties` / `party_members` / `achievements` / `role_achievements` / `role_mails` / `equip_aligns` / `equip_in_aligns` / `ui_effects`。删账号**级联删其角色**。
  - `world_monsters` 是**世界权威的状态表**：instanceId（`m<mapId>_<n>`，跨重启稳定发牌）/ map_id / monster_key / 出生点 x,y / hp / max_hp / alive / killed_at / respawn_at；`upsertBatch` 事务批量落盘，`listByMap` 供重载恢复。
  - `audit_logs` 是**日志表**（不是主数据）：`actor_name` / `target_id` 冗余存名字与 id（操作人可能被删、角色可能被删，只留外键事后谁也认不出这条记录说的是谁），三个索引（`created_at DESC` / `actor_id` / `(target_type, target_id)`）。
- **加列一律走 `migrate()` 里的 `ensureColumn`**（内部读 `PRAGMA table_info` 判断），别只改建表语句就完事 —— 存量库不会被重建。
- **角色数据是不透明文档**：
  - 读路径 `decodeStoredRoleData` **容错**（解析失败返回安全默认）；
  - **编辑路径 `parseStoredRoleData` 解析失败必须报错** —— 用空对象兜底等于**清空玩家背包与装备**；
  - `parseRoleData` 末尾要 `delete data.revision`（修订号是**索引列**，不留在文档里）。
- **删除相关**：`accounts.clearOnlineRole` 的 SQL 带 `AND online_role_id = ?`，**清在线标记必须早于删角色行** —— 角色行删掉后就判不出当初指向谁。
- **修订号 `revision`（乐观锁）**：`roles.revision` 列，每次落库 `revision = revision + 1` **写在 SQL 里**（不读出来加一再写回）；玩家 `PUT /roles/:id` 可选带 `revision`，对不上 → `409` + `20006`；**不带该字段 = 旧行为**（最后写入者胜，兼容旧客户端）。
- 结构化字段的校验与上限常量集中在 `modules/roles/role-data.util.ts`（`normalizeEquipments` / `normalizeSkills` / `normalizeBagCells` / `applyBagCells` / `normalizeGuide`）。**只校验结构与体量，不校验内容清单。**
  - **「不透明」唯一的例外是 `guide`（新手引导进度，`{ step, done, skipped }`）**：它确实是客户端体验状态，
    服务端也不该懂它的含义 —— 但完全不管就成了「随便存什么」。所以只把关**结构与体量**：
    `step` 必须是 `0 ~ ROLE_GUIDE_STEP_MAX(64)` 的**整数**（`Number.isInteger`，别用 `Number.isFinite`，否则 `1.5` 会过关）、
    `done` / `skipped` 必须是布尔、多余字段丢弃、结构不对一律 `BizCode.ROLE_DATA_INVALID`(20003)。
    **不校验步数与客户端配置是否一致** —— 配置会变，服务端一跟上就得跟着发布，`ROLE_GUIDE_STEP_MAX` 是体量上限（与 `ROLE_LEVEL_MAX` 同性质），不是步数。
  - **`guide` 没有字段就 `delete data.guide`，绝不补默认值**：客户端区分老号 / 新号靠的正是「文档里有没有 `guide`」
    （`normalizeGuideProgress(undefined)` → 已完成）。服务端一补默认值，**所有老号会被弹一脸引导**。这条比校验更容易踩。

### 四之四、存档的权威边界：一份文档里混着三种字段（#548 / #550）

`PUT /roles/:id` 收整份 `data`、只校验结构，所以同一个 JSON 里躺着三类字段，
处理方式**必须不同**。这条边界只在 `modules/roles/role-authority.ts` 里定义一次，
`save()` 按它分流，改也只改那里：

| 类别 | 字段 | 权威 | 落点 |
|---|---|---|---|
| 账本 | `gold` / `bindGold` / `silver` | 服务端 | 商城 / 回收 / 成长线 / 任务 / 成就 / 邮件 / 后台各有写点 |
| 成长线阶位 | `title` / `soulOfWar` / `rank` | 服务端 | 只有 `upgradeGrowth` 能推进 |
| 进度 | `level` / `exp` | 服务端 | 经验只由结算产生（击杀 / 队友分账 / 任务 / 成就 / 邮件 / 后台）|
| 背包与穿戴 | `bag` / `equipments` / `skills` | 服务端 | `POST /roles/:id/bag-op`（穿戴 / 卸下 / 丢弃 / 整理 / 搬运）；建号首次上传 |
| 派生值 | `combat` / 八项属性 | 服务端重算 | `applyAuthoritativeAttributes` 每次写档现算覆盖，**不走回填** |
| 客户端全权 | `hp` / `mp` / `onMap` / 外观 / 快捷键 / 引导 / 社交关系 | 客户端 | 这些若要收权，得先把本地那套操作全改成服务端接口 |

- **回填而不是拒收**：客户端推上来的值与库里不一致 → 用库里的值覆盖、继续落库。
  拒收（409）会把「客户端少收了一帧」变成玩不了；真正要拦的是「**写进去**」不是「发过来」。
- **库里没有这个字段就放行**：老存档首次上传时文档里没有 `bindGold` 这类键，删掉等于把玩家的钱清零。
- **`level` 是双份的（最容易写错的一处）**：它在 `roles` 表是**索引列**（排序 / 筛选读它），
  文档里也有一份。所以 `save()` 里要按「表列压过文档」构造回填的 `stored`，
  回填后**再从文档重取一次** `normalizeLevel(data.level)` 去写 `row.level` ——
  漏了这一步，列表按客户端报的等级排、详情按库里的等级显示，两边各说一套。
- **建号曾经是唯一没有旧值可比的口子**（#597 前的历史）：那时账本上界由 `clampInitialCurrency` 夹到
  `ROLE_INITIAL_CURRENCY`、等级由 `pinInitialLevel` 钉成 1（#554）。#597 起建号入参只剩名称 / 职业 / 性别，
  初始文档由 `buildInitialRoleData` 在服务端构造 —— 两个夹子随之整体退场，客户端没有任何「开号塞值」的路。
  所以那里现在**跳过必打 warn**（`ROLE_LEVEL_MAX` 是 1000，管理端 `PATCH level: 999` 也会走这条路）。
  要提等级只有一条正规路径：管理端 `PATCH /admin/roles/:id`。
- **守卫**：`tools/audit-role-authority.cjs`（第 13 项）—— 清单字段在客户端实体里有、`save`/`create` 挂了边界、
  **客户端对这些字段的赋值只能来自服务端应答**。第三条按 `role.` 接收者匹配（`level` 这个词满仓都是：
  任务目标的 `this.level`、怪物的 `monster.level`），右值里**引用**了 `update.` / `reward.` / `gain.` 等就算放行。
  清单名从 `SERVER_OWNED_FIELDS` 的展开项**自动派生**（#556 之前是手写三个常量名，加第四组时审计照样报
  「完好（8 个字段）」，新字段一个都没被检查 —— 假绿）；确有「对服务端那份做迁移 / 规整 / 回滚」的合法赋值走
  `ASSIGNMENT_EXCEPTIONS`（按文件 + 字段 + 行内特征逐条放行，**一条对不上就报过期**，避免例外清单变成遮羞布）。
- **客户端不许有本地加经验路径**（#550）：`onlineRoleGetExp` / `awardKillExp` 已删；`MonsterManager.hurt`
  保留但**只演伤害**（技能在实时通道不活跃时的兜底出手，早先按「零调用」判死代码被打回过 ——
  调用走 `SkillMonsterProvider` 接口，按实现类搜不到）；世界快照的兜底清场曾借 `applyDamage` 的 else 分支
  **白送经验**，那个分支已删。泡点 `AutoUpgrade` 组件已删，`ActivityController` 的开关保留并 warn
  （它是运行时 `addComponent` 挂的，不是死组件；要恢复得做成服务端 tick）。
- **`roleUpdate` 帧带什么**（`realtime.service.ts` 的 `buildRoleUpdate`）：等级 / 经验 / 血蓝 / 三货币 /
  战斗力 / 八项属性 / **成长线三件套 `title`+`soulOfWar`+`rank`（#551）** / 修订号。
  加字段时两条纪律：① 客户端 `CombatChannel.RoleAuthorityUpdate` 是**手写副本**（实时协议没有生成器），
  不同步就是「服务端推了、客户端读不到」；② 客户端落值后**只在该字段变了时**重建外显
  （称号 / 战魂是按角色数据重建动画，每帧重建会闪；军衔是头顶那行字，`updateUi → updateHead` 自动带出）。
- **回归门槛**：给权威清单加字段（或改建号口径）时，先 `grep` 一遍 e2e 里拿它造场景的地方 —— #550 一口气踩了四套
  （roles / e2e / combat / rank 都在用「存档改等级」当「改点东西」的载体），全部要改成管理端 `PATCH`；
  #554 又把「建号时直接给等级」这条造号路径删了，`e2e-roles` 里造 10 / 20 级角色改成 `raiseLevel()`
  （建号 → 管理端 PATCH）。**造号只在 1 级落库，任何「建个 N 级号」的写法都是假绿**。
  注意修订号：拿某个角色当修订号基线时，别对它多做一次 PATCH（多一次写库就把后面的数字全顶偏）。
  #556 收 `bag` / `equipments` / `skills` 时同样连坐两套：`e2e-combat`（补技能 / 换装 / 塞满背包造状态）
  与 `e2e-dual`（补技能），全部改成管理端 `PATCH /admin/roles/:id` 的结构化编辑。

### 四之四补、背包与穿戴收权（#556）：一个接口五个动作，两种口径

`POST /roles/:id/bag-op`（`role.bagOp`）一个入口五个动作，返回形状统一是「操作后的角色 + action/slot」：

| 动作 | 谁定结果 | 服务端要算的东西 |
|---|---|---|
| `equip` | 服务端 | 部位（`EQUIPMENT_SLOT_OF`）/ 等级门槛（`equipmentLevelOf`）/ 换下的旧装备回包 |
| `unequip` | 服务端 | 背包找第一个空格（满 → 20012），槽位名合法性 |
| `discard` | 服务端 | 销毁物品 |
| `move` / `tidy` | 客户端给排布，服务端**只验守恒** | `sameGridShape` + `sameBagContent`（同 id 总件数不变），不过 → 20022 |

- **为什么 move/tidy 不重算**：合并 / 交换 / 拆分是展示规则，客户端 `configs/items.moveBagCellGrid`
  已经有一份；服务端再实现一遍必然两端漂。**位置是展示，件数是钱** —— 只对后者下判断。
- **`equipments` 是属性重算的输入，必须先洗**：`roleAttributeSourceOf` → `collectEquipmentBundles`
  是**遍历所有值累加、不看键**的，同一件塞进 5 个槽位就能算 5 遍（改包刷战力）。
  `sanitizeEquipments` 三条口径：**认不出 id 原样保留**（可能客户端配置比服务端快照新）/
  部位不符能挪就挪 / 同一件只留第一个。`save()` 里洗一次，`bagOp` 里也洗一次。
- **`bag` 是回填的唯一特例**：内容取库里的、**尺寸取客户端这次的**（`reconcileBag` → `adoptBagShape`）。
  网格尺寸归客户端配置（`bagRow × bagCol`）管，整份照抄会让老角色的背包永远不长个；
  装不进新尺寸时保留原网格，**不静默丢东西**。这条也让「客户端首次上传带 4×10 空网格」继续成立
  （`e2e-combat` 的拾取前提就是它）。
- **穿 / 卸当场重算属性**：`applyAuthoritativeAttributes(existing.level, data)` + `clampVitals(data)` ——
  脱掉加体力的衣服时血量要跟着降，否则血条停在超上限的位置。
- **`equipmentLevelOf` 走运营覆盖层**（`runtime-overrides` 的 `equipmentLevels`，随 `applyEquipmentOverrides`
  重算、`resetRuntimeOverrides` 清空），缺省回落 `EQUIPMENT_BASES[id].level`；别直接读静态表，
  后台改过等级门槛就白改。
- **`skills` 目前没有任何玩家侧写入口**（客户端根本没有学技能 UI，`StorageManager` 里只有读）。
  收权后要靠管理端 `PATCH /admin/roles/:id` 或建号首次上传。哪天真做技能学习，
  得同步给它一个服务端接口 —— 否则「学了不生效」会是那种查半天查不出的 bug。

### 四之五、游戏事件总线：进度采集点唯一（#401）

「打怪 / 交付任务」这类事实会引出越来越多消费者（任务进度 → 成就进度 → 以后的活动、日常、战绩）。
`#396` 时是结算里直接调 `QuestService.onMonsterKilled`，加成就就是第三处、第四处 —— **每加一个消费者改一次结算代码**，
而且「漏接一处」的表现是「玩家怎么打都不解锁」，没有任何报错。现在的形状：

- `common/events/game-events.service.ts`：`GameEventPayloads` 是**唯一**的事件与载荷声明，
  `emit` 逐个订阅方 `try/catch` + `warn`；`listenerCount` 供启动自检与单测问「这条事件真有人接吗」。
- `common/events/game-events.module.ts`：`@Global()`。订阅方分散在 quest / achievement / realtime，
  每个都 `imports` 一遍只会让「漏写 imports 就静默收不到事件」变成常态故障。
- 结算（`realtime/combat-settlement.service.ts`）**只 emit** `monster:killed`，不认识任务也不认识成就；
  订阅方在各自 `onModuleInit` 里 `events.on(...)`。
- **同步分发**是硬约束：击杀结算返回时任务与成就进度必须已落库，否则「打完怪立刻打开任务面板」看到旧进度。
  所以这不是消息队列，别拿它跨进程 —— 跨进程广播是实时通道的事。

**进度类副作用一律可丢，世界状态是权威**：成就写库失败只打日志，绝不回滚一次真实击杀。
同理，消费者自己的 `try/catch` 再兜一层（总线兜的是「不影响别人」，消费者兜的是「日志能说清哪条链路坏了」）。

### 四之六、成就的两种存储（#401）

加「达成条件」时先问一句：**这个条件描述的是「做过多少次」还是「现在是什么样」**？

- **累计型**（`kill` / `quest`）：只有事件流知道 → 订阅总线把 `role_achievements.progress` +1；
- **状态型**（`level` / `combat` / `collect`）：真相本来就在角色存档 / 背包里 → **不落进度**，
  每次查询现算。存一份投影的唯一后果是「角色变强了进度没动」，还得再写一套同步逻辑。

配套三条：
- **达成与领取分离**：`achieved_at` 非空 = 可领、`claimed_at` 非空 = 已领，**不自动发奖**
  （上线瞬间给全员背包塞东西是事故，且背包满时自动发奖只能丢）；
- **状态型的 `achieved_at` 在领取时补写**：它没有单一达成时刻；**GET 绝不写库** ——
  读接口顺手改数据会让「刷新一下进度变了」永远解释不完；
- **进度钳到门槛**（`Math.min(raw, target)`）：累计型堆到 137/100 没有意义，客户端也不必自己夹；
- **状态型的两列必须 upsert**：它们没有进度行，`UPDATE … WHERE achieved_at IS NULL` 一行都改不到 →
  `achieved_at` / `claimed_at` 永远落不进库 → **每次 claim 都过校验，能无限刷奖励**（#429 的 e2e 抓到的真 bug）。
  仓储层 `markAchieved` / `markClaimed` 用 `INSERT … ON CONFLICT … DO UPDATE`，时间列写 `COALESCE(旧值, 新值)`
  —— 达成时刻只认第一次。

引用校验只剩**保存时一道**（`assertAchievementConsistency`，管理端 POST/PATCH 都过）：`kill` 目标必须是真实怪物 key
或 `"*"`、`collect` 必须是真实物品、奖励物品必须存在。原来还有「生成期」那道（`gen-shared-data.cjs` 的
`pickAchievements`），随生成器退场 —— 现在没有生成期，就靠保存时拦，所以**绕过管理端直接改 SQL 是不设防的**。
原因是这些错**不会报错**，只会让某条成就永远解锁不了。

**改成就数据之后必须先 `npm run build` 再跑 e2e**：`e2e-achievement.cjs` 起的是 `dist/`，
不重建就是拿旧快照在测（症状是「明明改了配置，快照还是 8 条」）。当前规模 24 条
（battle 10 / growth 8 / explore 6，含 3 条隐藏）；同分类内 `order` 按难度递增、奖励随之上抬。

### 四之七、游戏内邮件 = 奖励的第二出口（#429）

`role_mails` 是玩家收件箱；`mail_queue` 是**外发 SMTP 投递队列**（模板 + 尝试次数 + 后台调度）。
两者没有任何代码关系，**不要因为名字像就复用**。

- **附件在「领取」那一刻才入包**，且必须走 `RolesService.grantQuestRewards` —— 任务交付 / 成就领奖 / 邮件附件
  共用同一个发奖入口（一次落库 + revision +1），否则「邮件里的东西」与「背包里的东西」会出现差额；
- **未领奖励的邮件不能删**（`MAIL_UNCLAIMED 50143`）：删了等于替玩家扔掉奖励。
  「有奖励」= **金币 / 经验 / 附件任一**（#866，判据是 `hasUnclaimedReward()` 一处）——
  只看 `attachments` 会让「纯金币补偿邮件」被删掉；三样都没有的纯公告照常可删；
- **没有奖励的邮件不碰角色存档**：否则读一封公告也会顶 revision，客户端下一次保存撞乐观锁；
- **幂等写进 SQL**，不要先查再写：`UPDATE … WHERE id = ? AND claimed_at IS NULL`，`changes > 0` 才算真领到
  （并发点两次只发一份）；已读同理 `WHERE read_at IS NULL` —— 只留第一次看到的时刻；
- **发奖与标已领在同一事务里，且先标后发**（#868）：`BEGIN → markClaimed → grantQuestRewards → markRead → COMMIT`。
  先标后发让 `markClaimed` 命中 0 行成为**闸门**（并发请求 / 另一个进程的自动入包都拦得住 → 50142 整体回滚）；
  反过来「先发后标」在崩溃后会重发一份。这也是 API 与实时两进程同跑定时器时唯一的互斥手段；
- **一键领取逐封发，不合并**（#870）：每封一个独立事务 + 独立 `try/catch`，背包满**跳过继续**而不是 break
  （它只挡「要放物品」的那几封），回执带 `failedCount` + `failures[]`（`mailId` / `code` / `reason`）；
- **成就的背包满兜底**：捕获 20012 → 整份奖励（金币 / 经验 / 物品）转一封 `channel: "reward"` / `kind: "achievement"` 的邮件、
  **照常写 `claimed_at`**、返回 `mailId`。不写 `claimed_at` 就能反复点领取刷邮件。
  判业务码统一用 `isBizCode(error, code)`（`common/errors/biz.exception.ts`），不要各处手写 `instanceof`。

### 四之八、消息频道：`channel` 是分类，`kind` 是来源（#436）

四个频道收敛在 `game-mail/mail-channel.ts` 的 `MAIL_CHANNELS`（system / reward / social / combat），
**新增只能改这里** —— 客户端页签也按它对齐（`client/tools/test-mail.cjs` 逐项比对两端顺序）。

- **`channel` 与 `kind` 是两件事**：`channel` 是玩家视角的分类（必须收敛，否则消息会落进没有页签能装下的栏），
  `kind` 是来源标签（`achievement` / `friend` / `boss`，自由扩展，只用于日志与排查）。
  典型错位：`kind: "achievement"` 属于 `channel: "reward"` —— 玩家不关心它是哪个玩法发的；
- **接口不做频道过滤**：`GET /mails/me` 一次给全量 + `channels: [{channel, unread, unclaimed, total}]` 四栏角标，
  客户端本地筛。切页签零请求、红点与小结算永远按全量，不会「切回全部要重拉」；
- **四条角标必须固定出现**（`MAIL_CHANNELS.map`）：没消息的频道也要有条目，否则客户端切过去看不到「那栏有几条没看」；
- **非法频道报 `PARAM_INVALID 40000`，不能静默当「全部」**：这是发奖路径，玩家以为只领了一栏、实际整箱都领了 ——
  「宽容」在这里比报错危险（`scopeOf()` 是唯一收窄口）；
- **`send` 的 `channel` 必填**，落库前过 `toMailChannel()`（认不出的归 system，绝不丢消息）；
- **一键领取跟着页签走**：`claimAll(accountId, channel?)` → `listUnclaimed(roleId, channel)`，筛选下推 SQL；
- **战斗频道走订阅，不在结算里直接发信**：`GameMailEventsService` 订阅 `monster:killed`（事件载荷已带
  `monsterLabel` / `monsterTier`），**只对 boss 落消息** —— 普通怪一天几百只，每条一封就是把频道当日志。
  启动时打一条「订阅方 N 个」的日志：这类订阅少一个不报错，只会静默不生效；
- **社交消息是通知不是状态**：好友申请仍以 `social` 表的 `incomingRequests` 为准，邮件只是「不开面板也知道」；
  投递失败**只打日志**（关系已落库，为一条通知把接口打成 500 会让人重试并撞「已经发过申请了」）；
- **迁移**：`ensureColumn` 补 `channel`（默认 system）+ 一次性回填
  `UPDATE role_mails SET channel = 'reward' WHERE kind = 'achievement' AND channel = 'system'`（幂等）。

### 四之九、跨进程投影：实时进程写表，存档进程读表（#665）

两个进程之间**只有共享 SQLite 这一条路**。要在管理端展示「世界内存里的东西」（怪物点位 / 血量 /
重生倒计时 / 谁在图里 / 刚掉了什么），唯一的做法是**投影落库**，而不是加第二条 WS 或跨进程 RPC：

```
世界内存（实时进程）→ MapMonitorService 每 mapMonitorMs 采样 → map_monitor_state / map_monitor_events
                                                                    ↓
                          存档进程 GET /admin/maps/:id/monitor ← MapMonitorRepository（只读）
```

- **投影，不是权威**：删掉这两张表不影响游戏，重启后第一帧采样就补上；因此它们**不进 `config-sync.sql`**
  （那是配置表，整表替换），也不做乐观锁、不提供改单条；
- **只采「有人看的图」**（`world.viewedMaps()`）：没人看时 AI 不跑、也没有广播对象，采它等于给空气写库。
  代价是快照会停 —— 所以**必须把新鲜度发出去**（`sampledAt` / `updatedAt` / `staleMs`），
  否则「停更十小时」和「图里什么都没有」在页面上长得一模一样；
- **死怪的坐标要单独记**：`monsterAi.onMonsterKilled` 会把运行时删掉（重生要回出生点），之后
  `WorldMonster.x/y` 只剩出生点。所以结算侧**先取 `livePositionOf` 再清运行时**，采集器再用
  `lastPosition` 记住倒下点 —— 图上那颗灰色残点才落在它真正倒下的地方；
- **重生事件靠快照差分**（上一帧 dead → 这一帧 alive），不掺和 `WorldService.processRespawns`：
  少一条跨模块因果链，也就不用给 world 加钩子；
- **事件行要裁剪**（`mapMonitorEventKeep` / `mapMonitorTrimEvery`）：监控是「看最近发生了什么」，
  不是审计。攒够 N 条才裁一次（每杀一只都 `DELETE` 会让 WAL 白涨）；
- **游标语义**：`since=0` 取最新 `limit` 条（打开页面先看最近的事），`since>0` 取 `id > since` 升序；
  **没有新事件时原样回传 `since`** —— 往前跳一格就是永久漏事件；
- **`respawnInMs` 在读侧按 now 重算**，不要直接发快照里的值（快照是几百毫秒前的，倒计时会偏）；
- 掉落物**不逐件记坐标**：客户端 `DropManager` 以死亡坐标为中心铺开，所以「物品在哪」= 击杀点。
  给每件掉落另记坐标等于制造「表现层坐标的第二个来源」；
- 采集器失败**只 warn 不停摆**（监控不是游戏主链路），单图异常吞在心里，下个周期再来。

### 四之九补、精细日志：数值来自结算，过程来自 AI（#745）

「谁打了这只怪、这一下掉多少、它为什么开始追人、又为什么停下」—— 快照差分只能说「掉了血」，
说不出施法者与技能。所以事件流分成两种来源，**不能混着写**：

| 事件 | 写点 | 为什么不能换个地方写 |
| --- | --- | --- |
| `damage` 每一下伤害 | `CombatSettlementService.settleNew` | 只有结算知道出手者、技能、实际伤害、击退距离 |
| `cast` / `hit` 怪物出手 | `MonsterAiService` 的 `onLog` 回调 | AI 内部有目标、招式与命中结果，外部拿不到 |
| `chase` 追击起止 | 同上 | 起止与**成因**只在 AI 的决策分支里存在 |
| `kill` / `respawn` | 击杀侧 + 快照差分（见四之九） | 已有机制 |

四条硬规矩：

- **`onLog` 是单向回调，不是注入**：`MapMonitorService` 构造时已经依赖 `MonsterAiService`
  （采样要读 `livePositionOf`），AI 反过来注入它立刻循环依赖。手法与既有 `onBroadcast` 一致 ——
  宿主在 `onApplicationBootstrap` 里赋值、`onModuleDestroy` 里置 `null`，未接线则无人听。
  回调体内必须 `try/catch` 只 warn：**监控写失败绝不能影响战斗**；
- **`hpBefore = hpAfter + amount`**：世界层只回「扣完之后」的血量，前值反推。这样页面上
  「65 → 56（-9）」三个数**永远自洽**，不会出现「掉了 9 但差值 8」；
- **姓名要自己缓存**（`Map<string, string>` 账号 → 角色名）：`presence.identityOf()` 只在人在场时
  给名字，而「目标离线」恰恰是那个人已离开在场表的那一刻 —— 不缓存的话最需要看清的那条日志恰好没有名字；
- **「目标丢了」的四种成因必须分开**（目标离线 / 目标倒下 / 目标换图 / 位置上报超时）：
  排查时这是四个完全不同的故事。另外 `forgetTarget`（结算不出结果）与 `onMonsterKilled`
  也要补一条 `chase.end`，否则日志里会留下一堆没有结局的追击。

DTO 侧：六种 `kind` 共用一张宽表，**不适用的字段一律给默认值（空串 / 0 / false），不是缺字段** ——
客户端按 `kind` 分支渲染，缺字段会让「有没有这一栏」也变成契约的一部分。保留条数要跟着上调
（`mapMonitorEventKeep` 300 → 2000、`trimEvery` 25 → 100）：细到每一下伤害后条数消耗快一个数量级，
300 条在激烈战斗里只够十几秒。

e2e 写法（`test/e2e-map-monitor.cjs` 的「二·五」段）：想稳定看到 `chase`，得把玩家**站到怪身上**
（`target.x, target.y - 20`）并用 `setInterval` 每 800ms 重复上报（超过 3s 不报会被判「目标离线」，
那就只能看到 `chase.end` 的离线成因）。裁剪断言不能写「同时存在两条 kill」—— 新增的事件也占行，
按 `id` 大小比较才稳。

### 四之十、刷怪区归后台绘制（#667）：TMX 不再是来源

以前刷怪区只能改 TMX + 重跑 `import-spawn-areas.cjs`（整表替换）。现在**管理端在地图上拖框**：

```
地图页拖矩形（Tiled 口径）→ 管理端换算 → POST/PATCH/DELETE /admin/maps/:id/spawn-areas
                                            ↓
                              map_spawn_areas（世界坐标）→ 世界播种
```

- **工具改名 `tools/import-map-resources.cjs`**，只写 `maps` 的几何列 + `content`；它**不许**再出现
  `map_spawn_areas`（`audit-map-origin` 的守点按行扫，注释里提可以、代码里不行）。
  对象组后来在 #676 连碰撞盒一起收权时被 `tools/strip-map-objects.cjs` **整组删除**了 —— TMX 现在只剩
  瓦片与图层，一张图「有什么玩法」全在库里。
- **入参是世界坐标**（`cx/cy/w/h`），与读接口同构。换算只在管理端一处：
  `cx = x + w/2`、`cy = -(y + h/2)`。服务端**不做**第二套换算，`content` 保留 Tiled 原始口径。
- **`count` 一个数**：落库 `min = max = count`。表里两列但播种只读 `max`，表单摆两个数字
  只会让人问「min 填了为什么没反应」。
- **四道校验**（失败码各不同，前端能对着码提示）：地图存在且有像素尺寸（`50032`）→
  怪物 key 在 `monsters` 表（`50019`）→ 同图名字唯一（`20019`，409）→ 宽高 ≥ 16px 且**整块在图内**
  （`40000`）。越界现在是**直接拒**，不是 #586 那种「只告警」—— 人在图上画，没有理由画出图外。
- **跨图隔离**：`requireArea` 同时校验 `area.map_id === 路径里的 id`，否则拿 A 图的 areaId 能改 B 图。
- **生效时机是坑**：世界只在「该分域还没有实例」时按区域播种（`rows.length === 0`）。所以后台
  改完不会立刻变 —— 要等分域卸载（`worldMapIdleMs` 10 分钟没人）或重启实时进程。接口描述与
  页面上都照实写了这一条；「即时生效（分域重载请求）」是另一个 issue。
- **「画了区但进图没怪」先看生效时机，不是预加载**：#672 起客户端按**快照**的 `maps.spawnAreas`
  预加载怪物外观（不读 TMX 了），所以后台新加的怪种下次进图就在清单里。真正会「什么都没有」的是上面那条
  分域未卸载 —— 两种现象长得一样，判据是「换个分域进图（或重启实时进程）有没有」。未预加载的情况仍有兜底：
  `AnimationHelper.useManyNameAnimation` 会异步补加载（能显示，只是首帧慢）。

### 四之十一、在线状态要靠心跳兜底清算（#547）

`accounts.online_role_id` 是「角色在线」的唯一权威（角色列表在线徽标 / 排行榜在线角色 / 后台概览在线数都读它）。
它只在**踢下线 / 封禁 / 删角色 / 换角色**时被清 —— 玩家崩溃、杀进程、断网、直接关页面之后，标记会**永远残留**。

**断线不立刻清标记本身是对的**：短暂掉线重连不该被 `20007 ROLE_KICKED` 拒存档。缺的是兜底清算：

```
标记与心跳同生同灭（一条语句） → 活连接每拍续约 → 心跳过期（含 NULL）= 下线
```

- **新列** `accounts.online_heartbeat_at`（epoch ms）。写点全部收口到 `AccountRepository.setOnlineRole(accountId, roleId)`：
  选角 / 首角色自动在线 / 踢下线 / 封禁的 `statusPatch` 一律走它。**不许再用 `updateById` 单独动 `online_role_id`** ——
  两列分开写就会漏（漏了就是「标记在、心跳是 NULL」→ 下一拍被清算成一上线就被踢）。
- **续约**：实时进程的存活探测（`RealtimeService.sweep`）每拍对**还活着的连接**批量 `touchHeartbeats`（`UPDATE ... IN`），
  只动心跳列、**不碰 `updated_at`**（否则后台「最近活跃」会被心跳噪声刷满）。
- **清算**：同一拍 `clearStaleOnline(deadline)` 把心跳过期的行标记与心跳一起清；残留连接由既有踢下线巡检
  按「从有到无」收尾（清算本身只动库，不断连接）。
- **宽限期** `REALTIME_ONLINE_STALE_MS`：缺省 90s = 3×心跳；**下限强制 2×心跳**（配小了会在一次网络抖动里误清活连接）；
  `0` = 关闭清算。心跳周期本身是 `REALTIME_HEARTBEAT_MS`。
- **迁移要给存量在线标记垫一次心跳**：补列后老数据的心跳是 NULL，而 NULL 在判据里等于「已过期」→ 部署即 mass kick。
  `migrate` 里垫成启动时刻，给活连接留一个宽限窗。
- **坑**：`DatabaseService.migrate` 里的 `this.db` 是裸 `DatabaseSync`（没有仓储层那个 `run` 包装），带参数要
  `prepare().run()`；`exec` 传参会静默丢参。
- 客户端零改动：协议层 pong 由浏览器自动回，应用层 ping 照旧。

### 四之十二、人眼调参类数据不进快照（#739）

配置有两条下发通道，选错通道的症状是**「管理端明明改好了，客户端还是旧的」**——看起来像口径不一致，其实是缓存：

| 通道 | 拉取时机 | 放什么 |
|---|---|---|
| 配置快照 `GET /game-config/snapshot` | **进程内只拉一次** | 十几张表、只跟版本有关的结构性配置 |
| 单开接口（`/game-config/equip-align`、`/game-config/equip-in-align`、`/game-config/equipment-appearance`） | **每次进图拉**（内观再加一次「开弹窗就拉」） | 运营对着肉眼调出来的几何 / 效果 |

判据就一句话：**验收动作是不是「保存 → 退回选角再进图 → 看效果」**。是，就必须每次进图拉。
「退回选角再进图」只是场景重载、JS 上下文不重来，快照那条路永远拿旧值。

- 服务端给这类数据单开 `GET` 时**复用快照段同一个 DTO**（形状必须一致，e2e 直接比对两边的形状），
  这样客户端两处落库可以共用一个 `applyXxxSection`，不会出现「快照里有、接口少了半段」。
- 快照段里的同名字段**保留**：那是首帧兜底与老客户端兼容，新鲜度以单开接口为准（注释里写清，别让人以为重复）。
- 新增这种接口的动作：DTO（已登记 swagger）→ 控制器加 `@Get(...)` + `@ApiPlayerDoc({ operationId: "gameConfig.xxx" })` → `npm run gen:api` →
  客户端 `ConfigLoader` 加一路并行（失败只 warn）→ e2e 断言「与快照段形状一致」+ 无令牌 401。
- **排障顺序**（用户报「管理端对、客户端不对」时）：① 先比两边公式与素材（口径）→ ② 再查数据是否一致（库表 vs 接口）→
  ③ 最后查**生效时机**。#739 就是只差第 ③ 步被当成 ① 的一天。

### 四之十三、怪物 AI 全在服务端（#670）：多端画面一致靠三条链路

`realtime/monster-ai.service.ts` 是**唯一的行为决策处**（目标选择 / 待机游走 / 追击 / 普攻 /
技能 / 击退）。客户端 `ui/core/MonsterAI.ts` 只剩「朝服务端坐标趋近 + 按事件播动作」——
它以前并存过一套本地 AI（只在实时通道断开时跑），代价是同一只怪在两个人屏幕上走两条路。

| 链路 | 机制 | 缺了会怎样 |
|---|---|---|
| 位置 | `RealtimeService.withLiveMonsterPositions()` 在 **world 帧**（`worldJoin` 应答与 `broadcastWorld`）发出前，用 `monsterAi.livePositionOf()` 覆盖 `x/y`；增量靠 `monster-ai` 帧 | 晚进图的人先看到**出生点**再等帧纠正（world 快照里的 `x/y` 是存库的出生点），而**站着不动的怪永远不进增量帧**（判据是「有变化才发」）→ 永远停在出生点 |
| 血量 | `monster-ai` 帧带必填 `hp/maxHp`；血量变化本身也算「有变化」（`moved \|\| turn \|\| hurt`） | `hits` 只发给**结算给出手者本人**，别人打的伤害收不到 → 别人屏幕上怪满血 |
| 行为 | 客户端零决策 | 两套 AI 各自游走/选目标，位置与动作都对不上 |

**#670 的本体（「怪对着尸体放技能」）根因与修法**：`applyMonsterHit` 在玩家已倒下 / 不在线时
返回 `null`，而 AI 只把它当「这一下落空」→ `runtime.target` 不清、位置缓存里那条 hp>0 的记录
不删 → 下一拍又把尸体选成目标。修法不是去读血量缓存，而是**认结算结果**：
`forgetTarget(accountId)` 删位置记录 + 清掉所有怪身上指向该账号的 `target`；`castSkill()` 改成
**先结算再落账**（伤害型拿不到 hit → 不记冷却、不进硬直、不发 `casts`，返回 `false`）。

**击退也在服务端**：结算侧（`CombatSettlementService` 非击杀分支）读技能行的 `pushDistance`
调 `applyPush()`，方向 = 施法者 → 怪，时长取 `runtime_params.monster_ai.pushDuration`，
`stepMonster` 里击退优先于施法硬直，落点走普通位置广播（**不需要新协议帧**）。

**键名陷阱**：`skillOf()` 返回 `applySkillOverrides` 归一化后的**驼峰**对象
（`damageCoefficients / castLockMs / pushDistance`），写 `skill.push_distance` 拿到 `undefined`
→ 击退静默失效、不报错。加技能字段的顺序：`SkillSource` 补列 → 缓存里映射成驼峰 → 消费方读驼峰。

**e2e 写法**（`server/test/e2e-monster-ai.cjs`）：用 `pickPointInArea(cx, cy, 0, 0)` 把怪钉在
中心点，位置才可复现；量距离前先等**停稳**（连续两拍位移 < 0.5px）—— 广播 100ms 一拍、
击退 200ms，急着量只会量到推了一半的帧。死者场景用「客户端持续上报 hp=100 假装活着」把
「AI 不读客户端血量、只认结算结果」这个前提钉死。

## 五、运营与安全底座（口令 / 令牌作废 / 限流 / 审计 / 踢下线 / 公告 / 邮件 / 备份）

这几件事互相咬合，**改动时基本必须一起看**：

**1. 令牌版本号 = 无状态 JWT 的「主动作废」开关**
- `accounts` / `admins` 两表各一列 `token_version`；`TokenService.sign` 把 `ver` 写进载荷；`AuthGuard` **每次回查库比对**（admin 与 player 两条路径都要写，漏一条就是那端不作废）；
- 对不上 → `401` + `40103 TOKEN_REVOKED`；存量令牌没有 `ver` 按 `0` 处理（与 `ensureColumn` 的默认值一致 → 向后兼容）；
- 改密与版本号自增写在**同一条 SQL**（`updatePasswordAndBumpVersion`，自增在 SQL 里，避免并发丢自增），否则会出现「口令改了但版本号没加」的半截状态。

**2. 口令管理的两个入口，后果完全不同**
- 后台「重置密码」：前端生成随机口令（**只显示一次**，服务端只存 scrypt 哈希）→ 对方旧令牌当场全废 → 他需要重新登录。**不要给自己用这个入口**（管理端把它在自己那一行置灰）；
- 「我的账号」自助改密：验原密码 → 拒绝与旧口令相同 → 落新哈希 + 版本号 +1 → **必须回一个新令牌**（`AdminAuthResult`），否则管理员改完自己的密码会立刻被自己踢回登录页。客户端收到后覆盖本地会话。

**3. 登录限流：纯函数判定 + 内存计数**
- 判定全在 `common/utils/rate-limit.util.ts`（`createAttemptState` / `afterFailure` / `afterSuccess` / `lockedForMs` / `remainingAttempts` / `describeWait` / `isIdle`），**纯函数好测**（e2e 零段直接 require 编译产物跑边界值）；
- 计数放内存（`LoginThrottleService`，`SecurityModule` 设 `@Global()` 供 auth 与 admin 共用）：这是短命速率状态，落库只带来写放大与垃圾；代价是进程重启归零（单实例 SQLite 可接受）；
- 两个维度：用户名（`u:<去空格+小写>`）+ IP（`i:<ip>`）；**达阈值时把计数清零**（锁定期满从 0 重新计，正常用户被误锁不会一错再错）；`maxFailures <= 0` = 关闭该维度；
- 抛 `429` + 传入的业务码（玩家 `10005` / 管理端 `30009`）。

**4. 审计：写接口自动记，动作就是 operationId**
- `ApiAdminDoc` 里 `SetMetadata(AUDIT_ACTION_KEY, options.operationId)` → 「文档里的接口标识」与「日志里的 action」永远同一个字符串，**新增接口零额外工作**；
- `AuditInterceptor` 只审写方法（`WRITE_METHODS`），跳过 `@Public()` 与非管理端；**读接口不记**（否则一页列表刷满日志）；
- 目标与来源用 `@AuditTarget("role")` / `@AuditTarget("admin", "self")` 声明；
- 登录成功 / 失败走 `AuditService.recordLoginAttempt`（那时还没有已认证的操作人 → actor 留空、账号名放 `detail`）；
- `maskSensitive` 递归把命中 `/pass(word)?|secret|token|registercode|credential/i` 的值换成 `***`（**宁可多打**）；`record()` 吞掉一切异常（日志写不进去不该让封号失败）；每 200 次写 `prune(AUDIT_LOG_MAX_ROWS)`；
- 目标**当前**名字用相关子查询（`TARGET_NAME_SQL` 的三段 `CASE`），不是因为性能，是因为一张表打三种目标 JOIN 要写三段 UNION；
- 关键字查询的 LIKE 参数**必须转义** `\ % _`（否则玩家名里的下划线变成单字符通配符，静默多查出东西）。

**5. 踢下线：只清标记拦不住人**
- 后台清 `online_role_id` 之后，**本地还在跑的客户端照样会推存档**，所以 `RolesService.save` 必须叠加一道「推上来的角色仍是账号当前在线角色」，否则 `409` + `20007 ROLE_KICKED`；
- 这道判定要放在**乐观锁之前**：被踢的玩家该看到「回选角」，而不是反复重试「版本冲突」；
- 客户端侧对应 `RoleSync.onKicked`（**只清在线标记，绝不删角色** —— 那是 `20002` 的处理，写错就把玩家练的号删了）。

**6. 公告：全服触达只有一条通道，「生效中」是个 SQL 判据**
- `announcements` 表三列决定一切：`enabled` + `starts_at` + `ends_at`（建了 `idx_announcements_window`）；
- 客户端拉的是**免令牌**的 `GET /announcements/active`（归「公共接口」组）—— 登录页也要能看到；
- 已读状态**不进 `StorageManager`**（那是角色同步的状态机，混进去会触发一轮角色同步），单独一个 `AnnouncementReadStore`；
- 登录 / 选角场景没有 UILayer，弹窗只能挂调用方给的节点。

**7. 邮件通道：发信接口只入队，投递是另一条时间线**
- 渲染后的标题与正文**冻在入队那一刻**（模板后来改了不影响已入队的信）；
- 投递由后台调度器做：`status` / `attempts` / `next_retry_at` / `last_error`，指数退避，用尽上限标失败且原因可查；
- SMTP 走**可注入的传输层**（`MAIL_TRANSPORT=fake|fail`），所以 e2e 不需要真 SMTP —— 断言「有没有按预期调用」而不是「邮件到没到」；
- 未配置 SMTP 时**整体禁用**（不是「静默不发」）；密钥在系统信息页只报形态。

**8. 自动备份：与数据同卷是硬要求**
- `VACUUM INTO` 拿一致快照，**服务运行中也能备**；恢复要留档、要拒绝坏文件、要拒绝「服务可能在跑」；
- 容器部署时 `BACKUP_DIR` 必须挂在**与数据同卷**的路径上，否则容器一重建全丢，而「备份在跑」表面上完全看不出异常；
- 内存库（`:memory:`）**必须关着**自动备份 —— 没有文件可备份，开着只会每 tick 失败一次。

**9. 派生属性出口：服务端重算，客户端只是上报**
- `GET /roles/:id/derived` 返回服务端**自己算**的属性（`role-attributes.ts`），查的五张数据表**先经运营库覆盖层、缺省回落 4.0 那份公共生成物**（等级 / 战魂 / 称号 / 军衔 / 装备属性，见 4.0.1），#541 起客户端算子已删，这里是**唯一**的属性算法（没有对账对象）；
- 玩家上报存档时（`PUT /roles/:id`）服务端会**比对**上报的派生值与自算值 —— 这条是 #34「伤害结算上移」的地基。

**10. 屏蔽与举报（#398）：过滤必须在服务端，且不下发「谁拉黑了我」**
- `role_blocks` **单向一行**（`PRIMARY KEY (role_id, blocked_role_id)`），与 `role_enemies` 同形但语义更硬：敌人只影响名字颜色，屏蔽要由**服务端**拿去过滤内容；
- `BlockService`（`modules/realtime/block.service.ts`）把整表读进内存 `Map<roleId, Set<roleId>>`，按 `SOCIAL_BLOCK_CACHE_MS`（生产 2s，**e2e 设 0 立即生效**）懒刷新；每人最多 100 行，整表一次远比「每收件人查一次」便宜，何况过滤是双向判断（我拉黑他 / 他拉黑我）；
- 过滤点三处：`ChatService` 世界与帮会按收件人剔除、私聊**两个方向两种说法**（他拉黑我→只说「对方不在线」，把屏蔽当信号会引导换号再来；我拉黑他→明说「先解除」）、`RealtimeService` 的互见增量与 **full 快照**（不滤 `left`，漏发会留幽灵节点）；
- 社交快照只下发 `blocks`（我拉黑的人），**不下发 blockedBy**；好友申请是唯一能绕过屏蔽送达的通道，`addFriend` 里命中被拉黑就抛 `SOCIAL_ROLE_NOT_FOUND`（50109，刻意复用「找不到人」）；
- 举报 `role_reports` **不加外键**（证据不该随删号消失），名字 `LEFT JOIN` 查询时关联；同一对「我→他」只留一条 pending（50120）；管理端**只读**（处置需要「谁改的、凭什么改、能不能申诉」一整套，半成品按钮比没有更糟），`report:read` 不给观察员。

**11. 队伍（#399）：队伍态落库、动作走帧、经验走「击杀者全额 + 队友按自己等级差分一份」**
- 队伍**落库**（`parties` + `party_members`）：纯内存的队在实时进程重启时就全没了，而「重连回来还在队里」才是预期；
  「一人一队」交给 `party_members.role_id UNIQUE`（并发入队不必先查再写）；启动时 `onApplicationBootstrap` 整表灌 `roleId→partyId`；
- **队长是唯一写者**（`parties.leader_role_id`）：成员表**不存** `is_leader` —— 两个写者在转让时必然漂一次，症状是「两个人都能踢人」；
- 队伍动作**只走 WS 帧**（`party` 帧 + `action`）：邀请必须即时送达，而 HTTP 在存档进程、WS 在实时进程，存档进程推不到别人的通道；
  成功 = 给发起人一份他自己的最新快照，失败 = 带业务码的 `error` 帧 —— 客户端不必为每个动作另写一套本地状态镜像；
- 热路径**只缓存 `roleId → partyId`**（互见帧 200ms 一拍、每次击杀分经验都要问）：成员名单不缓存（改名 / 升级 / 入队 / 退队四条路径都要同步，
  多出来的只是漂移机会）。队伍表唯一写者是 `PartyService`，所以这张缓存不需要 TTL；
- 邀请**存内存 30 秒**（`PARTY_INVITE_TTL_MS`，懒清理、不落库）：帧丢了只等于「没收到邀请」，不留悬空状态；
- **队长退出自动移交**给最早加入的剩余成员（`ORDER BY joined_at, role_id`）：「队长不能退」在队长掉线不回来时会把整队锁死；
- 经验分成：击杀者拿 `settle.reward` 全额；**同图在线**队友每人 `floor(自己等级差经验 × PARTY_EXP_MATE_SHARE)`，服务端直接入账并推 `expGain` 帧
  （不带 `revision` 的话队友客户端基线停旧值，下一次防抖存档必撞 20006）。不均分（带人变慢会劝退邀请）、不加成（会引出多开刷经验）；
  队友那份走他自己的等级差，所以拉小号刷高级怪被公式本身挡住。掉落与任务进度只记击杀者；
- 互见帧带 `partyId`（`PlayerPresenceService` 每拍**现算**并进增量判据，走 5 秒外观懒刷新会让「刚组队还是白名」成常态）；
  进图时按**账号行 `online_role_id`** 补一份队伍快照（进图那一刻 `pos` 帧可能还没到，在场表里没条目就定位不到连接）；
- 屏蔽优先（#398 交叉）：双向都不能互邀，**两种说法分开** —— 我拉黑他 → 50130 明说「先解除」；他拉黑我 → 50128 只说「对方不在线」；
- e2e 坑：**跨连接的帧到达顺序没有保证**（邀请 A→B 与同意 B→服务端是两条连接），测「同意」前必须先 `waitFor` 邀请真的到达，
  而且邀请数组是累积的、要用 mark 取增量，别取 `[length - 1]`（会命中上一组的旧邀请 → 偶发 50126）。

**12. 排行榜（#400）：榜是 `roles` 的派生数据，物化在进程内、不落库**
- 三个榜（`level` / `combat` / `kills`）**不各写一套排序**：`scoreOfBoard` 一个 switch 决定比什么，`compare` 只做「分数降序 → `roleId` 升序」。
  同分二次键**不是可选项**：没有它，两次重算之间同分者会互换位置，玩家看到名次上下抖而实际什么都没变；
- **名次是竞赛排名**（并列同名次）：`if (previous === null || score !== previous) rank = index + 1` —— 名次按下标 +1 起算，遇到分数变化才换名次；
- **击杀数是 `roles` 行上的索引列**（`roles.kills`，`ensureColumn` 补，默认 0），不单开表：单列的表要多写一整套仓储 + 多一次 join，而这行本来就在同一笔结算里被读。
  唯一写者是 `RolesService.recordKill`（战斗结算在服务端 +1）；客户端 `PUT /roles/:id` 全量覆盖的是 `data`，`replace()` 的 SQL 原样保留 `kills`，**改不到**；
- `incrementKills` **不推 `revision`、不动 `updated_at`**：击杀数不是进度、客户端存档里没有它的基线，推修订号只会让玩家的防抖存档白撞 20006；
- **击杀数与经验分开记**：等级差过大时 `settleKillReward` 给的经验是 0（`exp > 0` 才入账），但这一杀算数；
- **物化不落库**：`BoardSnapshot { entries, byRole, computedAt }` 存进程内，首次请求惰性算一份，之后按 `LEADERBOARD_REFRESH_MS` 重算并**整份换引用**（读者永远看到完整一份，不撕裂）。
  落物化表就多出第二个真相（角色变了快照没变，谁对？）；重启代价只是「第一分钟要现算」，而首次请求本来就是惰性算的；
- **定时器第一次有人看榜才起**（`snapshotOf` 里 `startTimer`）：模块在 API 与实时两个进程都装载，但只有 API 进程收 HTTP —— 放 `onApplicationBootstrap` 起定时器等于让实时进程白扫全表。
  `setInterval(...).unref()` 不阻止进程退出（e2e `child.kill()` 要能立刻退），`LEADERBOARD_REFRESH_MS=0` = 不起定时器（e2e 用）；
- **名次在全量排序里算**：`byRole` 存全部角色，`entries` 只是截到 `topN` 的同一批对象切片 —— 所以排在很后面的人 `me` 也拿得到真实名次，不必把 `topN` 拉大；
  没有在线角色时 `rank = 0`（`LEADERBOARD_NO_RANK`，**不是 404**：榜本身是好的，只是这个人没名次）；
- **`size` 超 `LEADERBOARD_TOP_N` 夹到上限**（不报错）；非法 `board` 走 `assertBoard` 抛 40000 并**列出可选值**（干巴巴一句「参数错误」等于让人猜）；
- **条目只有八个字段**：不带 `accountId`、不带 `data`、**不带在线状态** —— 榜上标「在线」等于给人蹲点；
- **战力算不出来给 0**：等级 < 1（脏存档）/ 存档 JSON 坏掉是「这一个角色数据有问题」，不能让全服榜一起没了；战力必须是 `summarizeRoleAttributes().combat`（与角色详情同一个数），**不许在榜里另算一版**；
- 边界审计：`modules/leaderboard` 要读 `modules/combat/role-attributes.ts` 与 `role`/`account` 仓储 → 在 `tools/audit-server-boundaries.cjs` 的 `ALLOWED_EDGES` / `REPO_EDGES` 各补一条边（带注释说明为什么必须是同一个数）。

## 六、必踩的坑

1. **全局 `ValidationPipe({ whitelist: true })` 会静默剥掉嵌套裸对象的属性**。声明成 `bag?: unknown[]` 时，请求里的 `[{row, col, id, count}]` 到服务层会变成 `[[]]`（静默变空数组，不报任何错）。
   正解 = 带装饰器的 DTO 类 + `@ValidateNested({ each: true })` + `@Type(() => RoleBagCellDto)`，并登记 `SWAGGER_MODELS`。**任何嵌套数组 / 对象入参都要走这条。**
   定位手法：起一个探针脚本直接调 `ValidationPipe.transform`，看转换后的值 —— 比读代码猜快得多。
2. **`createDocument(..., { autoTagControllers: false })` 必须显式传**。默认 `true` 时会拿**控制器类名**当分组，`@ApiTags()` 空标签清不掉 → 文档分组全乱。e2e 钉了「每个接口**恰好**属于一个分组」。
3. **响应里的 `revision` 必须写 `existing.revision + 1`**。SQL 只管落库，内存对象不会自动加 —— 若返回旧值，客户端拿小 1 的基线做下一次推送会**立刻撞锁，自锁死循环**。
4. **列表筛选的 `online` 用字符串 `"true" | "false"`，不用 boolean**。class-transformer 的隐式转换会把 `"false"` 变成 `true`（非空字符串 → `Boolean`），表现为**静默筛错**。
5. **`min > max` 这类区间参数要在 `roleFilterOf` 里拦下来**（抛 `40000`），别让它落到 SQL 里返回空列表 —— 空列表会被当成「真的没有数据」。
6. **只写 `nullable: true` 不写 `type`** → 生成器只能给 `unknown`，两端类型退化。可空字段一律 `type` + `nullable: true` 一起写。
7. **新增 DTO 忘了登记 `SWAGGER_MODELS`** → 接口引用了它、文档里却没有 → 生成物出现**悬空 `$ref`**。`audit-api-generated.cjs` 的 D 段会报。
8. **分页接口写成 `isArray: true`** → 文档里 `data` 是数组，实际返回 `{list, total, page, size}` → 两端类型全错。用 `PageMetaDto` 派生。
9. **本机（WorkBuddy 环境）跑服务端 / 子进程必须 `env -u NODE_OPTIONS`**：环境注入了 `node-language-shim.cjs`，服务端会**不打日志、不监听端口**地静默起不来，e2e 表现为「等待服务启动超时」。同环境 `HTTP_PROXY` 会把 `curl 127.0.0.1` 打成 **502**（假故障），本机自测加 `--noproxy '*'`。
10. **业务码 / 权限点改动要同步两端**（客户端 `ApiCodes`、管理端 `types.ts`）。`audit-api-generated.cjs` 会比对两侧码值 —— **数字对不上就是静默失效**。
11. **新增模块必须登记到 `tools/gen-api.cjs` 的 `MODULES`**（`adminAudit: { target: "admin", export: "auditApi" }`），否则 `gen:api` 直接报「operationId 的模块段没登记」。
12. **子类覆写基类同名字段要加 `declare`**：`AuditQueryDto` 想给继承来的 `keyword` 换一条更具体的文档描述时，写成 `keyword?: string` 会 `TS2612`（will overwrite the base property）；改成 `declare keyword?: string;` 即可（装饰器照样生效，运行时不多一个字段）。
13. **`app.set("trust proxy", ...)` 需要 `NestFactory.create<NestExpressApplication>`**：普通 `INestApplication` 上没有 `set`（`TS2339`），而 `trust proxy` 又只对 Express 适配器有意义。
14. **拦截器要注册在它依赖的服务所在的那个模块**：`AuditInterceptor` 挂在 `AuditModule` 的 `providers` 里（`APP_INTERCEPTOR`）并 export `AuditService` —— 放 `AppModule` 容易出现「拦截器装了但服务没导出」的运行期问题。
15. **`db.transaction()` 现在可重入，但「吞异常」的写入在里面会静默丢数据**（#868 踩到）：SQLite 对嵌套 `BEGIN` 直接报错，而 `EventLogService.recordMany` 恰好是「写失败只 warn 绝不抛」—— 于是「发奖事务里记流水」看着成功、`event_logs` 一行没有（行数 > 1 时它自己会 `.transaction()` 包一层，行数为 1 走普通 `INSERT` 才碰巧没事）。`DatabaseService.transaction()` 已加深度计数：已在事务里就并入外层，不再发第二个 `BEGIN`。新写「事务里调别的事务」的代码时，**先确认被调方没有自己吞异常** —— 吞掉的那条路审计查不出来，只有 e2e 直读表能看见。
15. **`success` 这类筛选参数同样用字符串 `"true" | "false"`**（与 `online` 同一个坑：class-transformer 会把 `"false"` 变成 `true`）。
16. **`keyword` 忘了在仓储层实现就是静默无效**：生成物里字段一直都在（继承自 `PageQueryDto`），请求带上它也不报错，只是不筛。要么实现，要么从 DTO 里去掉 —— 别留一个「看起来能用」的空壳参数。
17. **两个进程之间没有通知通道**：管理端在存档进程改表，实时进程（AI / 结算）只能自己回查 —— 所以读「运营能改的配置」一律 **读库 + 短 TTL 缓存**（`MonsterAiService` 的 `SKILL_CACHE_TTL_MS = 1000` 读 skills / statuses / monster_skills 三表）。e2e 断言「改完生效」要留 ≥ TTL 的等待窗口，否则测的是缓存而不是逻辑。
18. **跨模块复用「JSON 列」的解析函数要放 `common/`**：`common/config-json.ts`（`parseCoefficientsJson` / `parseCombatJson` / `COMBAT_KEYS`）就是为此而生 —— 实时进程要读技能倍率与状态修正，若直接 import `modules/game-config/dto/*` 会被 `audit-server-boundaries.cjs` 判跨域违规（那条边只能靠白名单硬开，而这类纯函数不值得开边）。
19. **e2e 想收 `monster-ai` 帧必须先 `worldJoin`**：AI 广播按「谁在看这张图」派发（`world.viewedMaps`），只连 WS 不进图的连接一帧都收不到 —— 症状是「明明有怪在打人，测试却等超时」。同理，怪物在测试期间会移动，后续断言要用**快照里的当前坐标**而不是出生点。

20. **带缓存的过滤逻辑，e2e 必须把 TTL 压到 0**：`SOCIAL_BLOCK_CACHE_MS=0`（`chat` 类用 `CHAT_RATE_LIMIT` 同法放宽）。留默认 2 秒时「拉黑后立刻发不出」测的是缓存而不是逻辑，且会随机红。
21. **`EXPECTED_ASSERTIONS` 与实际条数差一条，最后那条「条数变了」就会把绿变红**（#396 / #397 / #398 都踩过）：加断言时同一次改完常量，别留着下次再补。
22. **没有 HTTP 出口的列，e2e 用 `node:sqlite` 直读**：#400 的 `roles.kills` 只在榜接口里以「排序结果」出现，没法断言「这一杀到底记没记」——
   `e2e-combat.cjs` 的 `readKills(dbPath, roleId)` 开只读连接直查该列，才有「打死一只 +1、再打死一只变 2」这种精确断言。
   同理：**别为了测试给正式接口开一个只有测试用的出口**。
23. **「能改什么」要按字段划线，不是按整页划线**（#571 → #573 地图管理）：第一版整页只读，e2e 断言
   `POST / PUT / PATCH / DELETE` 全 **404**；用户随后把玩法配置（名称 / 类型 / 进入等级 / 进入战斗力 / 进入战魂阶）
   划到服务端可改，于是只剩 `PATCH :id` 一个写入口，而**资源本体仍然不可改**：
   ① POST / PUT / DELETE 依旧 404（没有「新建 / 删除地图」—— 图存不存在由客户端 TMX 决定），
   ② 请求里塞 `src` 被白名单剥掉，返回仍是 `map/<id>/<id>` 目录约定算出来的值 —— 「下发方永远改不到客户端加载哪张图」；
   ③ 进图条件**判定在服务端**（#606 收权，之前只拦客户端 = 改包可绕）：判据唯一一处是
   `MapService.enterRejectOf(mapId, {level, combat, soulOfWar})` → `MapEnterReject | null`（只回结构化
   `field/need/mapLabel`，中文句子归客户端 `configs/texts`）。**凭什么知道玩家在哪 = 存档字段 `data.mapAt`**
   （服务端承认的位置，与客户端的 `onMap` 分开、进 `SERVER_EXCLUSIVE_FIELDS` 所以客户端上报会被回填/删掉，
   唯一正常写点是「被接受的 worldJoin」）。三条边界必须同时成立，否则会锁人或漏拦：
   **a.** 目标图 == `mapAt` → 无条件放行（登录 / 重连 / 回脚下那张图都不是换图。硬拦的后果是「运营调高门槛 →
   正站在图里的低等级玩家下次登录黑屏且出不来」）；**b.** `mapAt` 缺失（刚建号 / 老档第一次上线）→ 放行；
   **c.** 图没有配置行 → 放行（无行 = 无门槛）。协议两条：`mapEnter`（意图，不动世界状态）→ `mapEnterResult`
   `{mapId, ok, field?, need?, mapLabel?}`，放行与被拒同形；`worldJoin` 被拒也发同一帧（客户端只认一个形状）。
   客户端流程 = 本地预检 → `CombatChannel.requestMapEnter()` 等回帧（3s 超时按本地判据放行）→ 放行才
   `applyMapChange` 切场景 —— **不能「先切图再等拒绝」**：切场景先卸旧场景，world 帧回来人已在空图里，回滚代价远大于先问一句。
   判据一律写 `> 0` 且 `> 角色值`（0 = 不限制；安全地图是 0/0/0，写成 1 会挡住 1 级新号）。
   **403 与 404 不能混**：403 是「你没权限」，会诱导下一个人去补权限；404 是「这件事没有入口」。配套两条：
   `new BizException(code, msg)` **默认 400** —— 资源不存在必须 `BizException.notFound(code, msg)`，否则
   「地图 11 不存在」被报成「参数不合法」；写 DTO 只留**一个** `SaveMapConfigDto`（恰好五个字段，
   e2e 断言字段集合，多一个少一个都红），文档里没有 `Create*Map` / `Delete*Map`。
24. **静态审计校验生成物，运行时校验库表 —— 这是两条路，别只做一条**（#586 刷怪区越界）：`audit-map-origin` 第 6 条一直在
   校验 `spawn-areas.generated.ts` 的四边落在图内（当时 62 个全绿），但游戏里读的是 `map_spawn_areas` **表**，而表只在
   `countAll() === 0` 时按快照 seed 一次 —— 旧口径时期 seed 过的库会一直把怪刷在图外：审计绿、游戏错、管理端一个字都没有。
   于是判据挪进 `common/utils/spawn-area-bounds.util.ts`（唯一一处），由 `map.service.detail` 算进 DTO、`world.service`
   播种时告警、管理端只显示结论（页面自己再判一遍 = 第二个口径）。**容差 1px**（导入按浮点算中心、列是整数）。
   附带的两个反面提醒：① 越界在图上**看不见** —— 容器 `overflow-hidden` 会把越出部分裁掉，「区域在图外」表现为「区域不存在」，
   所以必须靠颜色/徽标，不能指望眼睛；② 契约字段不能通过接口构造时，直接 `require` `dist/` 里的纯函数测（e2e 跑在 build 之后，
   而「开个只给测试用的写入口」是更坏的选择）。
25. **击杀的跨端演出走 `monster-ai` 帧的 `kills`，不要「死亡时广播 world 帧」**（#689）：`applyDamage` 打死怪后若同步触发
   `onWorldChanged`，world 帧会在 settle 应答**之前**发到击杀者自己手上 —— 快照清场把节点拆了，随后到的 settle 找不到目标，
   击杀者的经验 / 掉落演出整个被吃掉。kills 搭 AI 广播的节拍（≤200ms），时序天然在 settle 之后；击杀者按 `accountId` 自跳，
   掉落账本（#325 归属）不动 —— 广播的只是**演出**（死亡清场 + 地面铺物），别人点拾取没有账可查、服务端照拒。

## 七、验证闭环

> 仓库根有 Makefile，这些命令都有等价目标：`make server-verify` / `make server-e2e-guard` / `make gen-api` /
> `make dev`（三端一起）—— 且已统一 `env -u NODE_OPTIONS`；`make help` 列全部。

```bash
cd server
env -u NODE_OPTIONS npm run verify           # build + e2e(248) + e2e:roles(110) + e2e:guard(283) + e2e:mail(120) + e2e:account-email(28) + e2e:realtime(50) + e2e:backup(87) + 生成物审计
env -u NODE_OPTIONS npm run test:e2e:roles   # 只跑角色管理专项（改角色接口时先跑它）
env -u NODE_OPTIONS npm run test:e2e:guard   # 只跑口令 / 审计 / 限流 / 踢下线专项
env -u NODE_OPTIONS npm run test:e2e:realtime # 只跑实时通道专项（改握手 / 票据 / 心跳时先跑它）
env -u NODE_OPTIONS npm run gen:api          # 改完接口重新产出 openapi.json + 两端接口文件
```
> 改过**数据**之后：管理端改库 → `make config-export` 重导 `server/data/config-sync.sql` 一起提交；
> 忘了导出会被 `make config-check` 逮住（它比的是库与那份 SQL，不是任何生成物）。

**e2e 的写法**（`test/e2e.cjs`、`test/e2e-roles.cjs`、`test/e2e-guard.cjs`）：真实起服务进程 + 真实 HTTP 请求 + **自带内存库**；
它们会调 `setupSwagger(app)` 生成**真文档**，用来验「分组 / 权限标注 / 悬空 `$ref`」。
加接口时**同步加断言** —— 这几套是服务端唯一的行为护栏（没有单测框架）。

- `test/e2e-roles.cjs` 的七段结构可直接照抄扩展：修订号 / 筛选 / 结构化字段 / 乐观锁联动 / 批量删除 / 权限 / 文档；
- `test/e2e-guard.cjs` 是**两段式启动**：第一台服务把 IP 维度放宽（`LOGIN_IP_MAX_FAILURES=1000`）好单独验用户名维度，第二台把它调到 1 专验 IP 维度；零段直接 `require("../dist/common/utils/rate-limit.util.js")` 跑纯函数边界（不必起服务）。
- `test/e2e-realtime.cjs` 用的是真 WebSocket 客户端（`ws`）：**拒连不是靠「连上再被关」验的**，而是听 `unexpected-response` 读回服务端手写的那份 HTTP 响应；存活探测靠 `autoPong: false` 让客户端故意不还 pong；优雅关闭靠给子进程发 `SIGTERM` 再断言「连接收到 `1001` + 进程确实退出了 + 日志落了收尾那一行」。把 `REALTIME_TICKET_TTL_MS` / `REALTIME_HEARTBEAT_MS` 调小（如 3000 / 1000）能让这些断言在秒级跑完。
- `test/e2e-map-monitor.cjs`（#665）是**跨进程投影**的唯一护栏，四个要点：① 用临时**文件库**（`:memory:` 看不到库里的行，裁剪那条要直接数）；② 刷怪区播种必须放在 `startServer()` **之后**（出厂快照会整表替换）；③ 玩家出现在监控里靠 `pos` 帧（在场表只由它建立，`worldJoin` 不建）；④ 「采集会停」用**断开连接 + 两次读数 staleMs 递增**来验 —— 这是页面上「采集已停」的唯一证据，别改成断言快照被清空。精细日志（#745）另有两坑：追击事件要**站到怪身上 + 每 800ms 重复上报**才稳定复现（否则先撞上「位置上报超时」），裁剪断言要按 `id` 比大小（新增事件也占行）。

## 八、提交纪律（强制）

**每处理完一个问题，就按功能提交一次代码 —— 不要攒着。**

- 一个功能一个 commit，**改完立刻提交**；不要把多个不相关改动混在一次提交里（这样「哪次改动引入了回归」永远能二分出来）。
- 提交前跑 `make test-changed`（改动哪跑哪）或 `env -u NODE_OPTIONS npm run verify`，绿了再提交。**全量门禁以 PR 上的 CI 为准**（`make ci` 是同一套的本机串行版；本机 e2e 在负载高时会假红在「等待超时」上）。客户端单测本地专属，需要 Cocos 工程与不入库的素材。
- 提交信息用 `feat|fix|refactor|docs|test|chore(端): 一句话说清做了什么`（`chore` 用于构建 / 工具 / 依赖），正文列关键改动与验证结果；服务端的端名取 `server`。
- **改了接口的提交必须连生成物一起提交**（`openapi.json` + 两端接口文件是同一笔改动的一部分，否则另外两端停在旧契约上）。
- 涉及多端的同一功能拆成几个提交，顺序按依赖（服务端先，再 `admin` / `client`，最后 `docs`）。

```bash
cd /Users/tz/workspace/olua
git add server tools/gen-api.cjs && git commit -F - <<'EOF'
feat(server): 操作审计关键字查询补实现（此前是空壳参数）

- audit.repository 补 keyword 四项模糊匹配，LIKE 通配符转义
- gen:api 重跑：<N> 接口 / <N> 路径 / <N> 模型（写实测值，别照抄这里）
- 验证：verify 全绿（e2e <n> / e2e-roles <n> / e2e-guard <n> … 各套条数）
EOF
```

## 九、相关

- 契约生成链的完整细节：本技能内的 `references/contract-pipeline.md`
- 客户端怎么消费生成物、怎么自愈乐观锁冲突：skill `olua-client`
- 管理端怎么消费生成物、怎么按权限渲染：skill `olua-admin`
- 三端地址 / 请求 / 路径的唯一来源与硬编码审计：`node tools/audit-api-hardcode.cjs`
