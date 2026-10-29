---
name: olua-server
description: olua 项目服务端（NestJS 12 + node:sqlite + JWT + Swagger）的开发与改接口做法。它同时是「三端接口契约的唯一源头」——控制器 + DTO + 装饰器产出 server/openapi.json，再由 tools/gen-api.cjs 生成客户端与管理端两端的接口文件，所以加接口的唯一正确顺序是「改服务端 → 补 operationId → npm run gen:api → 两端 build」。涵盖：三档分组装饰器 @ApiPublicDoc / @ApiPlayerDoc / @ApiAdminDoc（分组按方法标、控制器禁写类级 @ApiTags、createDocument 必须 autoTagControllers 传 false）、管理端接口必须带 permissions（同时落文档说明 + x-olua-permissions + RequirePermissions 运行时元数据，漏了就是真放行）、@ApiDataResponse 的 x-olua-data-schema 与 x-olua-data-nullable、@ApiQueryModel 的 x-olua-query-schema、两层守卫（AuthGuard 受众每次回查库 + PermissionGuard 权限点注册在其后，业务代码禁写角色判断）、统一响应包裹 code message data timestamp 与业务码分段（1xxxx 账号 / 2xxxx 角色 / 3xxxx 管理端 / 4xxxx 通用）、SQLite 四表仓储与 ensureColumn 存量补列、全局 ValidationPipe whitelist 会静默剥掉嵌套裸对象属性（必须带装饰器的 DTO 类加 ValidateNested each true 加 Type 并登记 SWAGGER_MODELS）、分页必须用 PageMetaDto 而非 isArray、同账号角色重名 20005、清在线标记必须早于删角色行、角色修订号 revision 乐观锁、口令管理（重置玩家口令 / 管理员自助改密 / token_version 让旧令牌立即作废 40103）、操作日志（审计拦截器只审写方法、action 复用 operationId、敏感字段递归打码、prune 限容、目标名用相关子查询、keyword 的 LIKE 通配符要转义）、登录限流（纯函数 rate-limit.util + 内存 LoginThrottleService、用户名与 IP 两维度、达阈值计数归零、TRUST_PROXY 双向陷阱）、踢下线（只清在线标记拦不住本地客户端，必须叠加存档写入拒收 20007 且判定放在乐观锁之前）、服务端不认识客户端配置只做结构体量与格式校验、swagger emit 与 gen api 与 verify api 与十套 e2e（e2e / e2e-roles / e2e-guard / mail / account-email / realtime / combat / world / dual / backup）与 verify 脚本的写法（真实起服务 + 真实请求 + setupSwagger 生成真文档验分组权限与悬空引用）、实时通道（一次性票据换 WebSocket 连接：握手复用 AuthGuard 的结论而不另写一套校验、拒连时回的是与其余接口同形的 HTTP 401 包裹体而不是先建连再关、协议层 ping/pong 存活探测、一账号一条连接、收连接必须写在 onModuleDestroy 而不是 onApplicationShutdown 否则死锁）、每处理完一个问题按功能提交一次代码（改接口的提交必须连 openapi.json 与两端生成物一起提交）。触发场景：用户说"改服务端接口""加一个接口""给接口补权限点""Swagger 分组不对""文档里少了某个接口""服务端校验失败""接口报 500""分页接口文档写成数组""e2e 挂了""数据库加一列""后台改角色""角色改名""乐观锁冲突""前端类型跟服务端对不上""重置密码""改密码""旧令牌还有效吗""操作日志""审计""谁改了什么""登录被锁""限流""踢下线""把玩家踢出去""反代拿不到真实 IP"。
agent_created: true
---

# olua 服务端（NestJS）：三端接口契约的唯一源头

`server/` 是三个**平级子工程**之一（另两个：客户端 Cocos 工程在 `client/`，管理端在 `admin/`；仓库根只放总 README / FAQ 与跨端 `tools/`）。
服务端只做四件事：

1. **鉴权** —— 玩家 / 管理端两套 JWT 受众；
2. **角色数据落库** —— SQLite，`roles.data` 存客户端 `entities/Role` 的 JSON 快照（**字符串**）；
3. **产出接口契约** —— Swagger 文档 → 客户端与管理端的接口文件**全部由它生成**；
4. **实时通道** —— 一条 WebSocket 长连接（目前只做「建连 + 心跳」，业务消息见 #34）。

**最重要的一条心智模型**：游戏数据（装备 / 战魂 / 称号 / 军衔 / 技能 / 物品 / 地图）的权威定义**只有一处** —— 客户端 `client/assets/configs`。
服务端**不复制**它，而是引用它的引擎无关快照 `src/shared/game-data.generated.ts`（`node tools/gen-shared-data.cjs` 生成，`make audit-shared-data` 逐字节守着重生成必然一致）；管理端 import 的是**同一个文件**。
三端**没有第二份副本**，谁都不许自己维护一份。服务端只校验「结构 / 体量 / 归属 / 上限 / 重名」，从不复制一份游戏配置过来。

**连「码的清单」与「文案」也不许手写**（#122）：`role-data.util.ts` 的 `ROLE_OCCUPATIONS` / `ROLE_SEXES`
是 `Object.keys(OCCUPATION_LABELS / SEX_LABELS)`，DTO 里那行 `1 战士 / 2 魔法师 / …` 是
`shared/game-data.ts` 的 `OCCUPATION_HINT` / `SEX_HINT` —— 客户端加一个职业码，这两处**自动跟着变**。
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
    database.service.ts           建表（43 张表）+ migrate() 里的 ensureColumn 存量补列
    repositories/                 account / admin / role / audit / system / announcement / mail / world-monster / map-spawn-area / zone / title / soul / growth / rank / equipment / drug / item / monster / npc / mall / fashion / drop-table / monster-drop / skill / status / monster-skill / guild / social / quest / quest-progress / report / party / achievement / role-achievement / role-mail（35 个仓储）
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
  shared/
    game-data.generated.ts        公共游戏数据快照（**三端唯一的游戏数据来源**；@generated，
                                  重生成 = node tools/gen-shared-data.cjs，守卫 = tools/audit-shared-data.cjs）
    game-data.ts                  服务端门面（**手写**）：只做「派生 + 拼文案」——
                                  ROLE_OCCUPATION_CODES / ROLE_SEX_CODES（取标签表的键）
                                  与 OCCUPATION_HINT / SEX_HINT（DTO 描述里那一行）。
                                  与管理端的 admin/src/api/gameData.ts 对称，数据都在上面那个文件里
  swagger/
    models.ts   SWAGGER_MODELS（要出现在文档里的 DTO 必须登记）
    setup.ts    buildSwaggerDocument() + setupSwagger(app)（main 与自动化测试**共用同一份**）
    emit.ts     离线产出 openapi.json（npm run swagger:emit）
openapi.json                     机器可读契约（**提交进仓库**）+ 两端接口文件的唯一输入
test/e2e.cjs                     全量回归（248 条断言）
test/e2e-roles.cjs               角色管理专项（110 条断言）
test/e2e-guard.cjs               口令 / 审计 / 限流 / 踢下线专项（283 条断言，起两台服务各验一轮）
test/e2e-mail.cjs                邮件通道专项（120 条断言，假发信器）
test/e2e-account-email.cjs       玩家邮箱字段专项（28 条断言）
test/e2e-realtime.cjs            实时通道专项（50 条断言，真实 WebSocket 握手）
test/e2e-combat.cjs              伤害结算专项（32 条断言，世界权威适配）
test/e2e-world.cjs               世界权威专项（22 条断言，tick / 落盘 / 重启恢复）
test/e2e-dual.cjs                双进程形态专项（14 条断言，存档与实时分进程 / 踢下线巡检断连）
test/e2e-blocks.cjs              屏蔽与举报专项（50 条断言，聊天与互见按 role_blocks 过滤）
test/e2e-chat.cjs                聊天专项（35 条断言，世界同图广播 / 私聊 / 限频）
test/e2e-quest.cjs               任务专项（48 条断言，四写入口 / 日常重接）
test/e2e-sell.cjs                出售专项（24 条断言，快照价结算 / 整单拒绝）
test/e2e-party.cjs               队伍专项（79 条断言，邀请 / 权限 / 移交 / 屏蔽优先 / 经验分成）
test/e2e-achievement.cjs         成就专项（39 条断言，累计 / 状态两种存储 / 背包满转邮件）
test/e2e-game-mail.cjs           游戏内邮件专项（51 条断言，附件领取 / 拒删 / 一键领取到背包满 / 频道与两处投递）
test/backup.cjs                  备份 / 恢复专项（87 条断言）
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
- 服务端一共 **25 个权限点**：`account:password`（重置玩家口令）、`account:email`（补录 / 查看玩家邮箱）、`announcement:write`（发公告）、`mail:read` / `mail:write`（投递记录与发信）、`audit:read`（查操作日志）、`system:read`（看系统信息）与 `gameConfig:read` / `gameConfig:write`（养成配置，#213）都是逐个后加的 —— **观察员只有 6 个读权限（`stats:read` / `account:read` / `role:read` / `announcement:read` / `gameConfig:read` / `zone:read`），上面这些一个都没有**（它只看业务数据，不该能接管账号、拿玩家联系方式或看部署形态；公告是面向全服的公开内容所以给它读，**投递记录里有玩家邮箱所以不给** —— 这条界线很容易被顺手抹掉）；
- 无权限 → `403` + `30006`（message 写出缺哪个权限）；保护性拒绝 → `30007`（**最后一个启用中的超管**不能降级 / 停用 / 删除）；
- `admins.role` 列由 `ensureColumn` 补 + `ensureSuperAdmin()` 兜底存量库；
- **加管理端接口必须 `@ApiAdminDoc({ permissions: [...] })`** —— 它同时落三处：文档说明、`x-olua-permissions` 扩展、`RequirePermissions` 运行时元数据。只写文档不写装饰器 = **权限全放行**（真出过，被 e2e 抓出来的）。

## 四、数据层规矩

**4.0 游戏数据三端共用一份**（用户 2026-10-13 定的硬要求，见 issue #117~#122）

装备 / 战魂 / 称号 / 军衔 / 技能 / 物品 / 地图的权威定义**只有一处**：客户端 `client/assets/configs`。
服务端**不复制**，引用它的引擎无关快照 `src/shared/game-data.generated.ts`；管理端 import 的是**同一个文件**
（Vite 按相对路径打包）—— **三端没有第二份副本**。

- **生成** `node tools/gen-shared-data.cjs`（= `make gen-shared-data`）：编客户端纯配置 → 在 Node 里加载 → 快照。
  改数值 / 改文案都改客户端配置，然后重新生成。产物 ~255 KB / 3410 行 / 24 张数据表。
- **守卫** `tools/audit-shared-data.cjs`（= `make audit-shared-data`）：重生成后**逐字节**比对，并断言数据表
  **每张都在且非空** —— 逐字节比对发现不了「生成器自己少产一张数据表」（同一份代码必然一致，而消费方拿到
  `undefined`：管理端页面空白、服务端查表得 0）。算法一侧另有人守：`audit-combat-parity.cjs` 把**真的**
  `GameHelper.combatCalc` 编译进 Node 当期望值。
- **它还会扫两端源码**，抓「自己维护一份」的三种破法（#122）：①与生成物**同名**的字典定义；②把**短标签表**
  （键数 ≤ 8、值全是字符串）的键清单写成数组字面量（`["1","2","3","4"]`）；③抄表的**行文**（`1 战士`）。
  另有第三条专查 `roles/role-data.util.ts` 的 `ROLE_OCCUPATIONS` / `ROLE_SEXES` 必须是从公共数据**派生**的
  （右侧不得是字面量数组）。扫之前**剥掉注释、跳过带 `@generated` 的文件** —— 注释里写反例是正常的，
  两端的 `models.ts` / `ApiModels.ts` 本来就镜像着 DTO 描述。
- **消费**：`modules/combat/role-attributes.ts` 只查表加总，**不做任何自行推算**；管理端拿它把裸 id 变成名字
  （此前它自己抄了一份职业名与性别名 —— 那正是这条线要消灭的）。装备的**显示名与所属槽位在生成器里算好**
  （复用客户端的 `getEquipmentNameParts` 与条目自带的 `slot`），消费方不做拼接。
  **连「码的清单」与「文案」也派生**：`shared/game-data.ts`（手写门面，与管理端的 `api/gameData.ts` 对称）
  给出 `ROLE_OCCUPATION_CODES` / `ROLE_SEX_CODES` 与 `OCCUPATION_HINT` / `SEX_HINT` ——
  客户端加一个职业码，服务端的校验清单与 DTO 里那行 `1 战士 / 2 魔法师 / …` **自动跟着变**（不必改服务端一行）。
- **不在范围**：掉落（`configs/monsterDrops` 依赖 UI 模块，留待后续上移）；时装（`configs/fashionClothes`
  整份被注释，没有活的来源 —— 不凭空造一份）。怪物战斗数值已进快照（#34，MONSTER_COMBAT）；怪物实例
  属世界权威（#35，服务端持有状态、客户端进图播种）。
- 生成物放在 `server/src/shared/` 而不是顶层 `shared/`：服务端是 `tsc -p tsconfig.build.json` 单包编译
  （`rootDir` = `server/src`，产物 `dist/main.js`），放到 `server/` 外会把产物路径改成 `dist/server/src/main.js`，
  连带 7 套 e2e、Dockerfile、deploy 一起改 —— 代价与收益不匹配。

- **43 张表**：`accounts` / `roles` / `admins` / `audit_logs` / `announcements` / `mail_queue` / `world_monsters` / `map_spawn_areas` / `zones` / `world_meta` / `titles` / `souls` / `ranks` / `equipments` / `drugs` / `items` / `monsters` / `npcs` / `fashions` / `mall_prices` / `mall_settings` / `drop_tables` / `monster_drops` / `level_exps` / `growth_segments` / `growth_scalars` / `skills` / `statuses` / `monster_skills` / `guilds` / `guild_members` / `guild_applications` / `role_friends` / `role_enemies` / `role_blocks` / `role_reports` / `quests` / `quest_progress` / `parties` / `party_members` / `achievements` / `role_achievements` / `role_mails`。删账号**级联删其角色**。
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

引用校验要有两道：生成期（`tools/gen-shared-data.cjs` 的 `pickAchievements`，`kill` 目标必须是真实怪物 key 或 `"*"`、
`collect` 必须是真实物品、奖励物品必须存在）+ 管理端保存时（`assertAchievementConsistency`）。
原因是这些错**不会报错**，只会让某条成就永远解锁不了。

**改成就数据之后必须先 `npm run build` 再跑 e2e**：`e2e-achievement.cjs` 起的是 `dist/`，
不重建就是拿旧快照在测（症状是「明明改了配置，快照还是 8 条」）。当前规模 24 条
（battle 10 / growth 8 / explore 6，含 3 条隐藏）；同分类内 `order` 按难度递增、奖励随之上抬。

### 四之七、游戏内邮件 = 奖励的第二出口（#429）

`role_mails` 是玩家收件箱；`mail_queue` 是**外发 SMTP 投递队列**（模板 + 尝试次数 + 后台调度）。
两者没有任何代码关系，**不要因为名字像就复用**。

- **附件在「领取」那一刻才入包**，且必须走 `RolesService.grantQuestRewards` —— 任务交付 / 成就领奖 / 邮件附件
  共用同一个发奖入口（一次落库 + revision +1），否则「邮件里的东西」与「背包里的东西」会出现差额；
- **未领附件的邮件不能删**（`MAIL_UNCLAIMED 50143`）：删了等于替玩家扔掉奖励。已领或本来就没附件才可删；
- **没有奖励的邮件不碰角色存档**：否则读一封公告也会顶 revision，客户端下一次保存撞乐观锁；
- **幂等写进 SQL**，不要先查再写：`UPDATE … WHERE id = ? AND claimed_at IS NULL`，`changes > 0` 才算真领到
  （并发点两次只发一份）；已读同理 `WHERE read_at IS NULL` —— 只留第一次看到的时刻；
- **一键领取逐封发，不合并**：遇 `MALL_BAG_FULL` 停下并如实回报 `stoppedByBag`，已领的照常落库 ——
  不是整单失败，也不是整单回滚；
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
- `GET /roles/:id/derived` 返回服务端**自己算**的属性（`role-attributes.ts`），查的五张数据表来自 4.0 那份公共生成物（等级 / 战魂 / 称号 / 军衔 / 装备属性），与客户端 `GameHelper.combatCalc` 的一致性由 `tools/audit-combat-parity.cjs` 锁住（它把真的客户端算法编译进 Node 当期望值，不是再抄一版口径）；
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
- **战力算不出来给 0**：等级超出成长曲线 / 存档 JSON 坏掉是「这一个角色数据有问题」，不能让全服榜一起没了；战力必须是 `summarizeRoleAttributes().combat`（与角色详情同一个数，`audit-combat-parity` 锁着），**不许在榜里另算一版**；
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
> 改过客户端 `configs` 之后：`node tools/gen-shared-data.cjs` 重新生成公共数据（`make gen-shared-data`），
> 忘了生成会被 `make audit-shared-data` 逮住。

**e2e 的写法**（`test/e2e.cjs`、`test/e2e-roles.cjs`、`test/e2e-guard.cjs`）：真实起服务进程 + 真实 HTTP 请求 + **自带内存库**；
它们会调 `setupSwagger(app)` 生成**真文档**，用来验「分组 / 权限标注 / 悬空 `$ref`」。
加接口时**同步加断言** —— 这几套是服务端唯一的行为护栏（没有单测框架）。

- `test/e2e-roles.cjs` 的七段结构可直接照抄扩展：修订号 / 筛选 / 结构化字段 / 乐观锁联动 / 批量删除 / 权限 / 文档；
- `test/e2e-guard.cjs` 是**两段式启动**：第一台服务把 IP 维度放宽（`LOGIN_IP_MAX_FAILURES=1000`）好单独验用户名维度，第二台把它调到 1 专验 IP 维度；零段直接 `require("../dist/common/utils/rate-limit.util.js")` 跑纯函数边界（不必起服务）。
- `test/e2e-realtime.cjs` 用的是真 WebSocket 客户端（`ws`）：**拒连不是靠「连上再被关」验的**，而是听 `unexpected-response` 读回服务端手写的那份 HTTP 响应；存活探测靠 `autoPong: false` 让客户端故意不还 pong；优雅关闭靠给子进程发 `SIGTERM` 再断言「连接收到 `1001` + 进程确实退出了 + 日志落了收尾那一行」。把 `REALTIME_TICKET_TTL_MS` / `REALTIME_HEARTBEAT_MS` 调小（如 3000 / 1000）能让这些断言在秒级跑完。

## 八、提交纪律（强制）

**每处理完一个问题，就按功能提交一次代码 —— 不要攒着。**

- 一个功能一个 commit，**改完立刻提交**；不要把多个不相关改动混在一次提交里（这样「哪次改动引入了回归」永远能二分出来）。
- 提交前跑绿 `env -u NODE_OPTIONS npm run verify`（编译 + 十套 e2e + 生成物审计），**全绿才提交**。（CI 跑的是 `make ci`：服务端十套 e2e + 管理端构建 + 13 个跨端审计；客户端门禁是本地专属，需要 Cocos 工程与不入库的素材。）
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
