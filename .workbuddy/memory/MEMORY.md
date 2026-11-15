# olua 长期记忆（索引）

> 跨域硬纪律 → 本文件；按域不变量 → `topics/架构不变量.md`；查坑 → `topics/踩坑速查.md`；「做过没有」→
> `topics/进度年表.md`；登记清单 → `topics/登记清单.md`；展开做法 → `.workbuddy/skills/`。

## 纪律（不可绕过）
- issue → 分支 → PR（「关联 #n」，**不写 Closes**）→ **本地校验绿** → squash → 手动 `gh issue close`；长正文一律 `--body-file`。
  **2026-11-14 起不跑 CI**：用户明确「只需要本地校验没问题就好了，不需要跑 CI」。门禁 = `make ci-static` + `make e2e-all`（+ `make client-test`），
  本地连跑 2~3 次绿就合；不要因为 CI 红反复改测试，也不要推送去触发 CI。
- **多会话并行 = worktree**（#948）：仓库有第二个人可能动笔时，改动一律在自己的 worktree（`~/worktrees/olua-<issue>`）；
  动笔前 `git status` 确认改动归属；只 `git add <明确路径>`；记忆/日志也只写自己 worktree。细则 → `.workbuddy/skills/olua-branch-worktree/`。
- 仓库 PUBLIC：密钥 / IP / 邀请码 / JWT 不进记忆、不进版本库。**`website/` 永不改动**。
- **现状 ≠ 正确**：issue 正文先按行号实测 `server/src` + `admin/src` 再动手。
- **待决定项实时问**（AskUserQuestion 一轮 1~4 个）；文档禁写「不做」（写「暂时放置 + 重开条件」）；
  「已定」只标用户亲口拍过的。用户说「我自己细化 / 我在改」→ 改完本地就停。
- 登记清单见 `topics/登记清单.md`（漏一处 = 静默失效；「新增配置行」走一次性补数据，不是加列）。

## 测试与门禁（细则见 `topics/踩坑速查.md`）
- **只校验代码，不校验数据（2026-11-14 拍板）**：帧形状 / 字段名 / 纯函数映射 / 状态机 / 方向 / 存在性进断言；
  只数 / 掉血 / 位移 / 事件次数 / 由配置算出的期望值**一律不进**。要「确实发生」就 `waitFor` 等事件，
  不要固定窗口 + 数值区间（会和结算周期抢相位）。准备步骤用 `changes`，别事后 `COUNT`（会和后台清理抢）。
  存量清理见 #966（**2026-11-15 已关，七批扫完**：服务端 84 套 + 客户端 66 套；留下的数字只剩
  测试自造输入 / 代码常量与资源契约（`AOI_CELL`、`50 条封顶`、`8 个方向`）/ 语义起点（版本号 0））。
- 反证前确认 build 真过（管道吃退出码）· e2e 播种在 startServer 之后 · 改 src 先 build。
- **源码断言切方法体按大括号配对，不按缩进**（2026-11-14 #966 踩到假绿）：dist 里类方法缩进 4 空格、
  命名空间函数 2 空格，写死一种就切到「从这个方法一直到类结尾」，断言被别的方法里的同名代码喂饱。
  反证法：方法名写错必须拿到空串，且空串一律判失败。
- 锁格式不锁数值 · 显示效果不写断言 · **假绿 > 漏检** · 断「路过」扫帧历史 · 源码断言钉方法体 ·
  血量类数「比上次低」次数（回血锯齿）· 时序别赌 wall-clock · 改日志格式要全仓搜测试文案断言。
- **阈值类断言换相对关系**（2026-11-14 #966 第三/四批）：`≥ 9 发被拒` → `被拒 > 放行`（闸失效就是 0 发被拒）；
  `一次命中 3 只` → 集合逐一对齐（已含数量）；「出厂 N 行」→ `> 0` 或「等于快照里符合条件的行数」。
  筛候选行时 `===` / `<=` 大量是错误码与 `data === null`，判据要落到「右边常量是不是配置表/公式算出来的」。
- **观测面收窄导致的假红，换权威快照不要放宽容差**（2026-11-14 #966 第四批）：`monster-ai` 帧只发「这一拍动过」
  的怪 + 3×3 格裁剪，A 跑到 850px 外就收不到出生点那一格的回程帧（全量连红两轮、单跑必绿）。
  改读 `worldJoin` 的权威快照 —— **进图快照是全量的，AOI 只裁广播**（`realtime.service.ts` worldJoin 段）。
- **配置管理面的断言跟「种子行 / 默认常量」对齐，不手抄值**（2026-11-15 #966 第七批）：`npc.scaleX = 1.5`、
  时装 `sellPrice = 0`、`prefixColors.length = 5` 这类都在抄种子；改成与 `config-snapshot` 的行逐字段比，
  或与 dist 导出的 `PARTY_MEMBER_LIMIT_DEFAULT` 比 —— 运营/策划调值不假红，「没落库 / 脏值透传」照样红。
- **「每张表都必须归类」有常驻守点**（2026-11-15 #438）：`e2e-guard` 用系统信息页给出的 `sqlite_master`
  全量清单，对 `config-tables.cjs` 的两份清单做**双向**比对（库里有清单没有 / 清单有库里没有）。
  `assertAllClassified()` 只在 `make config-export` 跑，常年没人导配置就发现不了 —— `zone_world_meta`（#961）
  就这么漏了一整轮，谁去导配置谁当场炸。改守点后按惯例做了反证（摘掉 `mail_broadcasts` → 红且指名道姓）。

- **合并前的类型检查以 `make ci-static` 为准**（2026-11-15 #804 踩到）：同一个提交，worktree 里单跑
  `make client-check` 报 0 错，`make ci-static`（自己先 `npm ci`）才报两处真错。别只信单跑一次的结果。
- 工具链：只信 Grep 工具（BSD grep 交替恒空）· 批量替换 `perl -pi -e` · `curl --noproxy '*'` · 判进程 `kill -0`。

## 架构不变量（细节见 `topics/架构不变量.md`）
- **服务端权威**：BizException 400 · 乐观锁 409+20006 · 校验 40000 · 失败 `data` 恒 `null` · 客户端零决策、
  乐观锁「拉最新 + 丢弃本轮」不重推。
- **区 = 服务端算出的上下文，不是请求参数**（#954 / docs/39 §2.4）：玩家侧接口**零 `zoneId`**（浏览期
  `accounts.active_zone_id`，进图后在线角色 `roles.zone_id`）；zone-scoped 仓储**没有无区重载**（删单参
  `findById(id)` 逼 tsc 交区）；按 id 取别区对象一律 **404**；管理端**不绑区**（所有管理员可见全区），
  但 `X-Zone-Id` 必填、无「全部区」视图，登录页与顶栏都能切。守点**已落地**（#956 / PR #968）：
  `tools/audit-zone-scope.cjs` 五类判据（controller 入参 / 入参 DTO / service 解构 / 仓储签名 / SQL 过滤 + schema 漂移），
  自动进 `make audit`（现 16 个）；白名单 `tools/zone-scope-allowlist.json` 18 条，**不再命中或同名命中 >1 处都算红**。
- 方向恒 `apply-snapshot → game-config → types`；一份数据一个来源；客户端零兜底；进 `SERVER_INVENTORY_FIELDS`
  的字段不得写也不得补默认值；纯服务端参数别进 `RuntimeParamsDto`。
- 已展开域见 `topics/架构不变量.md`（战斗 #822~#826 · AI #853~#858 · 背包 #835~#842 · 邮件 #866~#870 + **#438 群发**（每角色一行 + 批次号幂等 + 全服遍历未合并区）· 商城
  #846 · 进图 #859/#861 · 任务 #862~#865 · 拾取 #817 · 帮会 #871/#872 · 刷怪 #930 · 移动 #811 · **Room #809**：
  roomId 三键 `zone:map:slot` 唯一口径 `room-key.util.ts`，热重载 `world_reload_requests`）。

## 引擎坑（→ `cocos-*` 技能）
指针事件配 `UITransform`；Game 挂 Canvas → 五世界层建好再 `setWorldPosition(0,0,0)`；显隐与摆位绑「片段就绪」。

## 部署（→ olua-deploy）
compose 五服务：admin:80 唯一入口 / game:8080 / server:3100 / realtime:3101 / website 不映射端口。
出厂快照进镜像，卷 `olua_olua-data`；客户端地址由 `DEV_MODE` 唯一开关决定。

## admin 视觉 = legend 设计系统（#946 全部落地，PR #947/#950/#951）
- token 唯一来源 `admin/src/index.css` 的 `@theme`（surface/line/ink/gold/ember/jade/warn 语义名）；设计稿单一来源 `design/legend-console/`。**Tailwind 内置色族与裸色值全禁**；四族职责不交叉；金底必配深字；SVG 用 `var(--color-*)`。
- 守点 `tools/audit-admin-ui.cjs` **七条**（结构 4：遮罩/页头/卡片/字段标签；词汇 3：旧色族/裸色值/必有 PageHeader）；改守点后必须反证（违规探针全拦）。Badge/Notice tone 键 = `jade/ember/gold/warn/muted`。
- **新页面一律 `cd admin && npm run new:page -- <Name>` 起步**（合规骨架 + `__UI_CAPTURE__` 状态清单）；显示效果靠人眼看截图，不写断言。细则 → `.workbuddy/skills/olua-admin-ui/`（legend 版）。

## 进度
- 细节 → `topics/进度年表.md`。最近：**#1009 选区前移到登录页（PR #1014 `9269ecc1`，已关）**：
  登录页顶部「区服：X（点击切换）」+ 公共 `GET /zones`（登录前无令牌），默认区 = 本机记录（还开放）
  → 运营推荐 → 最新开放区；`submit` = 存会话 → `POST /zones/select` → 进选角页；选角页删掉整套
  `ensureZone` / 区名节点 / 弹窗，`start()` 直接 `loadRoles()`。`test-zone-select` 62 条、
  `test-scene-stage` 登录 6 / 选角 8 元素在画布内。
  **#957 P1 角色带区（PR #970 `706ddc19`，已关）**：
  `roles.zone_id` 是区归属唯一权威、`accounts.zone_id` 改名 `active_zone_id`（当前浏览区）；
  玩家侧零区参数、跨区 roleId 一律 20002；新增 `GET /zones/mine` + `POST /zones/select`（换区清在线角色）；
  合区搬角色 + 同账号同名**自动改名**。`e2e-zone-roles` 45 / `e2e-zone-no-param` 12 /
  `e2e-zone-migrate` 12（旧库升级幂等），e2e 清单 **89 套** · #956 P0 守点（PR #968）·
  **#810 AOI 视野裁剪（PR #953 服务端 + #965 客户端，已关）**：
  512px 格子 3×3 邻域、`entityEnter`/`entityLeave`、同格只序列化一次、离开延迟 1s 合并；
  客户端 upsert 建 / `despawn` 拆、快照缺席不演死亡。`e2e-aoi` 30 条 + 协议 38 条 + 客户端 66 套 ·
  #954 区服模型补完设计（docs/39，PR #955）+ 已拆 8 个子 issue
  #956~#963（P0 守点→P1 角色带区→P2 社交→P3 榜→P4 管理端→P5 运营合区→P6 客户端→P7 公告；
  P8 按区分片并入 #770 口径修订）·
  #768 10Hz 提频+帧瘦身+序列化缓存（PR #945 `9202366c`，已关） ·
  #767 同步延迟测量基线（PR #944 `ba846c6b`）· #809 Room 抽象 + 热重载（PR #942/#943，关 #809+#669）·
  #811 移动校验（#941）· #932 任务域（#933）· #826 战斗六项（#936）。
- **#812 地图规则接入结算（PR #1005 `98f7fbb5`，已关；epic #808 第四刀拆成 A/B/C）**：
  `expRate` 乘击杀者 + **队友分成**（同图同口径，否则「带人刷高倍率图」变成对队友的惩罚）；
  `dropRate` **乘 `chance` 封顶 1**（不乘 `picks` —— 那会让事件次数与产出一起翻倍）；
  `allowDrop=false` 一件都不抽（世界侧不生成实体，客户端也就没有 `dropSpawn`）。
  `maxPlayersPerRoom` 早在 #809 就接了，本轮只补快照三项（`maxPlayersPerRoom` / `maxChannels` /
  `transferCostMoney`），**倍率一律不进快照**（否则两端算的经验迟早漂）。
  规则读取走**地图域公开口** `MapService.rulesConfigOf(mapId)`：与给管理端的 `rulesOf` 刻意分开
  （后者带 `inherited` 与落款、地图不存在抛 404），运行时消费方不该为「读个倍率」多一条失败路径；
  `MapRules` 类型随地图域导出，消费方不摸仓储 —— **`audit-server-boundaries` 对 type-only import 同样计数**。
  B/C 已拆 #1000 分线 / #1001 副本与传送代价。`e2e-map-rules` 34 条。
- **`SaveMapRulesDto` 那个真 bug（2026-11-15）**：6 个布尔字段只挂 `@ApiProperty`、没有校验装饰器，
  `ValidationPipe({ whitelist: true })` 把它们**全部剥掉** → 保存一次规则就把所有开关写成 `false`
  （`allowDrop` 变 false，掉落一件都不出）。**写 DTO 的 `boolean` 必须有 `@IsBoolean`**；
  全仓 **78 处已一次修完**（PR #1011 `a7aaeab5`，31 文件：77 必填加 `@IsBoolean()`、
  1 可选加 `@IsOptional() @IsBoolean()`；13 个文件合并 import）。只读响应 DTO 也补 —— 运行期无影响，
  价值是复用为入参时不静默丢值。静态守点按用户口径**暂不加**（要加就单独立项）。
- **同步系列五刀全部落地**：#767 基线 → #768 10Hz+瘦身 → **#769 插值（PR #991 `14d7b285`，已关）**：
  `players` / `monster-ai` 两帧带**帧级 `t`**（同一拍共用一个值、AOI 裁剪后原样带上）；
  客户端 `ui/core/SnapshotInterpolator`（缓冲 4 条、线性插值、外插上限 100ms、同 t 覆盖 /
  乱序丢弃）+ `ui/utils/net/ServerClock`（welcome 粗校准 / pong 半程细校准）；
  **玩家与怪物共用同一个插值器**（怪物 `serverX/Y/moving/stepAt` 退役，缓冲挂 WeakMap）。
  手感参数在 `configs/network.realtime.interpolation`（120 / 4 / 100），**不进断言**。
  `e2e-protocol-slim` 38→45 · `e2e-aoi` 30→35 · client 68 套。
- **#770 按区分片（PR #997 `ae45086e`，已关）**：`shardOf(zoneId, N) = ((zoneId % N) + N) % N`，
  一个区只在一个实时进程里 → 世界/帮会/公告**不用跨进程广播**；路由 `/api/realtime/s<k>`
  （`/api/realtime` 恒第 0 片并取票），`N=1` 时行为与改造前一致。
  票从「随机字节 + 进程内 Map」改成**无状态加密票**（AES-256-GCM，密钥 `sha256(JWT_SECRET)`）：
  取票与握手会落在不同进程，票必须谁能解；**不改签名票**是因为票只能进 URL（nginx 日志 / 浏览器历史），
  签名票的 base64url JSON 会把用户名读出来 —— 老断言「票据不可解析」正好守着这条。
  三层闸门：路径 `s<k>` 不符 → `421/50150`；票里的区不符 → 同上且**不消耗票**；`worldJoin` 用角色
  **现在的**区复核 → `close(4003)`，客户端**重取票**后立刻重连（连错 ≥3 次才退回退避）。
  `REALTIME_EMBEDDED=true` 时 `shardCount()` 强制 1（配错不该让人起不来）。`e2e-realtime-shard` 27 条。
  下一步：**#812 分线/副本/map_rules**，或 **#805**（掉落 epic 最后一项；#802/#803/#804 已落）。
- **epic #954 区服模型补完 —— 全部完成**（P0~P7 八个子 issue 全关，2026-11-15 关 epic）：
  #956 守点 #968 · #957 角色带区 #970 · #958 社交 #976 · #959 排行榜 #978 · #960 管理端单区 #984 ·
  #961 运营合区 #985 · #963 公告按区 #986 · #962 客户端选服 #989（`f6d8f35c`）。
  **P6 原口径（#962）已被 #1009 推翻**：区改到**登录页**选（PR #1014 `9269ecc1`）——登录页顶部
  「区服：X（点击切换）」+ 公共 `GET /zones`（登录前没令牌，`/zones/mine` 调不了；也不需要角色数），
  默认区 = 本机 `ZoneStore`（还开放）→ 运营推荐 → 最新开放区；`Login.submit` = 存会话 →
  `applyZone()`（`POST /zones/select`）→ 进选角页；**选角页彻底不碰区**（无 `ensureZone` / 无区名节点，
  `start()` 直接 `loadRoles()`）。换区 = 返回登录页重选。弹窗仍**不自动弹**、单区服不响应。
  兜底：`select` 失败先看区还开不开 —— 还开放就是网络抖动**不换区**；确实进不去才换推荐 / 最新开放区，
  且等飘字走完再换场景（飘字挂在登录页 Canvas 上，立刻换场景会被销毁）。
  P8 按区分片并入 #770 口径；#438 群发按区等主体落地（docs/39 §3.7 有重开条件）。
- **#438 运营群发（PR #994 `c1ed3a9b`，已关）**：每角色一行 `role_mails`（+ `batch_id` 列与部分索引），
  `mail_broadcasts` 是幂等闸门兼进度账（`INSERT OR IGNORE` + `changes === 0` → `duplicated: true`，
  **一行不写**；不按标题+正文去重）。权限两个点：`gameMail:broadcast`（管理员，只发当前区）/
  `gameMail:broadcast-all`（超管），判断在业务里（同接口按入参决定权限，装饰器表达不了）。
  「全服」= 遍历 `ZoneService.states()` 里 `mergedInto === null` 的区逐个发，**不写不带区的 SQL**
  （`audit-zone-scope` 零豁免）；keyset 分页（`id > 上批末尾`）而非 OFFSET；一批一事务（插行 +
  累加 `sent_count`）；批间 `await setImmediate` —— `DatabaseService` 是同步驱动，不让出会堵死整个进程。
  群发邮件永不过期（`ttlMs: 0`）。`role_mails.batch_id` 刻意不给默认值（NULL = 不属于任何群发）。
  中断：`finished_at` 停在 NULL，已写行算数、不补不删。`e2e-game-mail-broadcast` 46 条（批大小调 2 强制跨批）。
- **#803 掉落终态流水（PR #999 `ef4760a8`，已关）**：`drop_records` append-only，四种终态各一行
  （`picked`/`expired`/`overflow`/`restart_lost`）；`resolve()` 只入队、`flush()` 一拍 `insertMany`
  一事务（**不阻塞拾取**，**先写流水再删投影**，失败只 warn）；`overflow` 用可空 `reason` 分
  `auto`/`manual_clear`（#805），**不加 result 枚举**；`lived_ms = resolved_at - created_at`。
  两道保留闸取先到：每图 2000 条（攒 200 裁）+ 7 天（每 6h 扫，`≤0` 关闭）。
  读接口 `GET /admin/drops/records` + `/summary`（`modules/drops`，区走 `X-Zone-Id`，权限复用
  `event:read`，排序白名单，**不按 `drop_id` 去重**，`summary` 不吃 `result` 且四态恒出现）。
  `e2e-drop` 38→60 · 新增 `e2e-drop-records` 37。客户端侧由 **#804** 接上（`sendPick(dropId)`）。
- 当前 open：#9 包体积 · #12~#19 素材 · #295 阶段三 ·
  #403 帮会战 · #742 TLS · #808 地图重构（**#812 规则层已关**，剩 **#1000 分线** / **#1001 副本与传送代价**；
  掉落进 Room 仍未落地，重开条件见 docs/20）· **#801 掉落 epic 剩 #805**。
  保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- **掉落已是世界实体（#802，PR #993 `89065e2a`，已关）**：`DropService` 是唯一权威（`ground`/`byId` + 终态
  `recent` 留 60s 接重发），`world_drops` 是投影（100ms 批量 upsert、重启清空），`drop_records` /
  `drop_clear_requests` 只建表（分别给 #803 / #805）。`pick` 只带 `dropId`、九步校验、11 种 `code`；
  第 2 步判图读 `roles.zoneOf` + `MapAtOfOnlineRole`（**不是在场表缓存**）。参数键名沿用库里的
  `pickAcceptRadius`（设计稿的 `pickRange` 已统一掉，0 = 闸关闭），新增只有 `ttlMs`/`protectMs`/
  `maxGroundPerMap`/`announceBoss`。客户端由 **#804** 接上（见下条）。
- **#804 客户端掉落重写（PR #1008 `78cfb1a9`，已关）**：客户端只剩 `dropId` 口径 —— `sendPick(dropId)`、
  铺地唯一入口（击杀者与旁观者同一广播同一形状）、`DropScatter.ts` 删除（坐标归服务端）、进图吃
  `world.drops` 全量 + `dropSpawn`/`dropRemove`/`dropNotice`；时间轴只认相对量（`expireInMs` → 本地
  + 3s 断网兜底，到期等 `dropRemove`）、**末段零提示**（issue 正文的「末 10 秒秒数」被参数表作废）；
  九码文案 + 800ms 共用节流；`canPickLocally` fail-open（只省请求，引导第 3 步靠它）；归属头像要服务端
  `ownerClass`/`ownerSex`（+`partyId`），客户端 `Mask.Type.GRAPHICS_ELLIPSE` 裁圆。
  纯逻辑在 `ui/utils/drop/DropRule.ts`（不 import cc，可沙箱跑），结构断言在 `client/tools/test-drop-rule.cjs`。
- `docs/14` 无生成脚本，改接口手工加行；现口径 **262 = 8 + 68 + 186**。client 单测可当门禁（**69 套**）。
  `docs/37` 是最高优先单一来源。
- **新增 env 键 / 文案 / 节点名 / 颜色的 PR，静态审计要预判三处登记**：`.env.example`（audit-api-hardcode）+
  `tools/config-leak-allowlist.json`（config-leak）+ **进了配置快照的键还要加 `e2e-guard` 的
  `EXPECTED_CONFIG_KEYS`**（#770 踩到：前两项都过了，`make e2e-all` 才在 guard 十节报「白名单之外的项」）。
  新增 e2e 脚本别忘了 `tools/run-e2e.cjs` 的 `WEIGHT`（漏了只是分片不均，不报错）。
- **CI 红的判据**：先在本地完整 verify（**89 套**）复跑——**本地能精确复现 = 代码/测试问题**（改字段名最容易漏
  「函数体内读点」，如 `find(m => m.instanceId === …)`）；只有本地绿而 CI 红才考虑分片负载，`gh run rerun --failed`。
  同一套件连续 ≥2 轮同断言红不要再当抖动。改广播帧字段后记得全量本地 verify，「本地绿」结论会过期。
