# olua 长期记忆（索引）

> 跨域硬纪律 → 本文件；按域不变量 → `topics/架构不变量.md`；查坑 → `topics/踩坑速查.md`；「做过没有」→
> `topics/进度年表.md`；登记清单 → `topics/登记清单.md`；展开做法 → `.workbuddy/skills/`。
> **本文件只留「每条 PR 都要照着做的规则」**；一次性结论 / 某个 issue 做过什么 → 年表。

## 纪律（不可绕过）
- issue → 分支 → PR（「关联 #n」，**不写 Closes**）→ **本地校验绿** → squash → 手动 `gh issue close`；长正文一律 `--body-file`。
- **2026-11-14 起不跑 CI**：用户明确「只需要本地校验没问题就好了，不需要跑 CI」。门禁 = `make ci-static` +
  `make e2e-all`（+ `make client-test`），本地连跑 2~3 次绿就合；不要因为 CI 红反复改测试，也不要推送去触发 CI。
- **多会话并行 = worktree**（#948）：改动一律在自己的 worktree（`~/worktrees/olua-<issue>`）；动笔前 `git status`
  确认改动归属；只 `git add <明确路径>`；记忆/日志也只写自己 worktree。细则 → `.workbuddy/skills/olua-branch-worktree/`。
  依赖要 **`cp -al` 硬链接或自己 `npm ci`**，**别 `ln -s` 到别人的 worktree** —— 对方 `npm ci` / `worktree remove`
  一执行你的依赖就没了（#805 踩到，e2e 报 `No driver (HTTP) has been selected`）。**`make client-test` 另需两样
  gitignore 产物**：`client/temp/declarations`（`cp -R`，缺了 tsc 报 `Cannot find module 'cc'`）与
  `client/assets/resources`（`ln -s` 主工程即可，2.4GB 素材；缺了 14 套 ENOENT）。
- 仓库 PUBLIC：密钥 / IP / 邀请码 / JWT 不进记忆、不进版本库。**`website/` 默认不动**（要动先问；
  #742 把四个域名的链接换成 https 是用户亲口同意的例外）。
- **现状 ≠ 正确**：issue 正文先按行号实测 `server/src` + `admin/src` 再动手。
- **待决定项实时问**（AskUserQuestion 一轮 1~4 个）；文档禁写「不做」（写「暂时放置 + 重开条件」）；
  「已定」只标用户亲口拍过的。用户说「我自己细化 / 我在改」→ 改完本地就停。
- 登记清单见 `topics/登记清单.md`（漏一处 = 静默失效；「新增配置行」走一次性补数据，不是加列）。

## 测试与门禁（细则见 `topics/踩坑速查.md`）
- **只校验代码，不校验数据（2026-11-14 拍板）**：帧形状 / 字段名 / 纯函数映射 / 状态机 / 方向 / 存在性进断言；
  只数 / 掉血 / 位移 / 事件次数 / 由配置算出的期望值**一律不进**。要「确实发生」就 `waitFor` 等事件，
  不要固定窗口 + 数值区间；准备步骤用 `changes`，别事后 `COUNT`（会和结算周期 / 后台清理抢相位）。
- **阈值类断言换相对关系**（#966）：`≥ 9 发被拒` → `被拒 > 放行`；「出厂 N 行」→ `> 0` 或与快照里符合条件的
  行数比。筛候选行时 `===` / `<=` 大量是错误码与 `data === null`，判据要落到「右边常量是不是配置表算出来的」。
  配置管理面**逐字段比 `config-snapshot` 或 dist 常量**，不手抄值；观测面收窄导致的假红**换权威快照**不放宽容差
  （AOI 只裁广播，进图 `worldJoin` 快照是全量的）。
- **源码断言切方法体按大括号配对，不按缩进**（dist 里类方法 4 空格、命名空间函数 2 空格，写死一种会切到类结尾）；
  反证法：方法名写错必须拿到空串，空串一律判失败。
- 锁格式不锁数值 · 显示效果不写断言 · **假绿 > 漏检** · 断「路过」扫帧历史 · 血量类数「比上次低」次数（回血锯齿）·
  时序别赌 wall-clock · 改日志格式要全仓搜测试文案断言 · 反证前确认 build 真过（管道吃退出码）·
  e2e 播种在 `startServer` 之后 · 改 src 先 build · **红时先读服务端日志再怀疑链路** ·
  **验「贴脸」别站到血牛身上**（一击打死 1 级角色 → 之后每条出手都被存活闸拦成 `dead`，单跑绿、全量挂）。
- **「每张表都必须归类」有常驻守点**（#438）：`e2e-guard` 拿 `sqlite_master` 全量清单与 `config-tables.cjs`
  **双向**比对（`assertAllClassified()` 只在 `config-export` 跑，常年不导配置就发现不了）。
- **合并前的类型检查以 `make ci-static` 为准**（#804）：单跑 `make client-check` 0 错、`ci-static` 报两处真错。
- 工具链：只信 Grep 工具（BSD grep 交替恒空）· 批量替换 `perl -pi -e` · `curl --noproxy '*'` · 判进程 `kill -0`。

## 架构不变量（细节见 `topics/架构不变量.md`）
- **服务端权威**：BizException 400 · 乐观锁 409+20006 · 校验 40000 · 失败 `data` 恒 `null` · 客户端零决策、
  乐观锁「拉最新 + 丢弃本轮」不重推。方向恒 `apply-snapshot → game-config → types`；一份数据一个来源；
  客户端零兜底；进 `SERVER_INVENTORY_FIELDS` 的字段不得写也不得补默认值；纯服务端参数别进 `RuntimeParamsDto`。
- **区 = 服务端算出的上下文，不是请求参数**（#954 / docs/39 §2.4）：玩家侧接口**零 `zoneId`**（浏览期
  `accounts.active_zone_id`，进图后在线角色 `roles.zone_id`）；zone-scoped 仓储**没有无区重载**；按 id 取别区
  对象一律 **404**；管理端**不绑区**但 `X-Zone-Id` 必填、无「全部区」。
- **DTO 的 `boolean` 必须有 `@IsBoolean`**（#1010）：`ValidationPipe({ whitelist: true })` 会把没校验装饰器的
  字段**静默剥掉** —— 曾经保存一次地图规则就把所有开关写成 `false`（`allowDrop` 变 false，掉落一件都不出）。
- **跨进程指令一律落表 + 轮询，不在管理端直接改内存 / 直接 `DELETE` 投影表**：热重载 `world_reload_requests`、
  掉落清空 `drop_clear_requests` 是同一形状（3100 插一行返回受理 → 3101 每秒读 pending 执行 → 回写结果）。
- 守点已落地：`audit-zone-scope` 五类判据 + 白名单（`zone-scope-allowlist.json`，不再命中或同名命中 >1 处都红）·
  `audit-admin-zone`（挂 `ZoneContextGuard` 却不取区的路由必须登记 + 理由）· `audit-server-boundaries`
  （**type-only import 同样计数**）· `audit-admin-ui` 七条。
- 已展开域 → `topics/架构不变量.md`（战斗 / AI / 背包 / 邮件+群发 / 商城 / 进图 / 任务 / 拾取 / 帮会 / 刷怪 /
  移动 / Room / 掉落 #802~#805 / 区边界 / 分片 #770 / 地图规则 #812 / 分线 #1000）。
- **分线（#1000 + #1016）不变量**：选线结论只在世界层（`WorldService.pickRoom`，通道层不自己数人）·
  「`mapAt` == 目标图」的人容量一律放行 · **在场表 / 广播 / 分桶一律按房号三键（区:图:线）**，只比「区 + 图」
  = 跨线 ghost + 容量白算 · 客户端 `maxChannels` **读配置快照**（不给 world 帧补字段）· 换线一次只留一条在途 ·
  线号 = 服务端 `channel + 1`（公共线 0 不加后缀）· 换线全程**不碰 `SceneManager`**。

## 素材（`client/assets/resources` 不入库，2.4GB 走 GitHub Release）
- **「素材缺图」只看三处，别把清单 `verify` 红当缺图**（2026-11-15 实测）：① DB 里 9 张带 `icon` 的表对磁盘
  （978 处缺 0）② `images.ts` 的 `uiImages` 62 条（缺 0）③ `node tools/audit-resource-refs.cjs`（1436 处）。
  三处全绿 = 没缺图；`verify` 红只是**清单过期**（本机比清单多 1944 个文件，见 #1025）。
- 图集加载：`loadLoopFrames(dir)` 候选 `[dir, dir/<basename>]`（`effect/upgrade` 命中 `effect/upgrade/upgrade.plist`）；
  「图集优先、散帧兜底」，两样全缺才是整片空白。
- 发布：`make resources-manifest/pack/upload RES_VERSION=<新版本>` + 提交**仓库根**的 `resources.manifest.json`。
  `make audit` 里的 `audit-resource-refs` 末尾会按**存在性 + 大小**打印清单体检（**只警告不判红**，#1027）；
  sha1 口径只认 `resources_sync.py verify`，别造第二个真相。

## 引擎坑 / 部署（展开 → `cocos-*` 技能 · `olua-deploy`）
指针事件配 `UITransform`；Game 挂 Canvas → 五世界层建好再 `setWorldPosition(0,0,0)`；显隐与摆位绑「片段就绪」。
compose 五服务：admin:80 唯一入口 / game:8080 / server:3100 / realtime:3101 / website 不映射端口；
出厂快照进镜像、卷 `olua_olua-data`；客户端地址由 `DEV_MODE` 唯一开关决定。
**开 HTTPS（#742，`profiles: ["tls"]`）时加 `edge`（独占 :80/:443，443 → admin:80）与 `certbot`**，
admin 退回 `127.0.0.1:8081` —— 宿主机 `:80` 只能有一个主人；开关是 `deploy.env` 的 `OLUA_TLS=on`，
由 `deploy.sh` 派生 `COMPOSE_PROFILES=tls` + 两行端口变量，首次签发 `--tls-init`（standalone）。

## admin 视觉 = legend 设计系统（#946，PR #947/#950/#951）
- token 唯一来源 `admin/src/index.css` 的 `@theme`（surface/line/ink/gold/ember/jade/warn 语义名）；设计稿单一
  来源 `design/legend-console/`。**Tailwind 内置色族与裸色值全禁**；四族职责不交叉；金底必配深字；SVG 用 `var(--color-*)`。
- 守点 `tools/audit-admin-ui.cjs` **七条**（结构 4：遮罩/页头/卡片/字段标签；词汇 3：旧色族/裸色值/必有 PageHeader）；
  改守点后必须反证。Badge/Notice tone 键 = `jade/ember/gold/warn/muted`。
- **新页面一律 `cd admin && npm run new:page -- <Name>` 起步**（合规骨架 + `__UI_CAPTURE__` 状态清单）；
  显示效果靠人眼看截图，不写断言。细则 → `.workbuddy/skills/olua-admin-ui/`。

## 进度与口径（细节 → `topics/进度年表.md`）
- **当前 open**（2026-11-15 核）：**#1025 资源清单过期**（verify 红，暂缓发布）· **#1001 副本 instance**
  （#808 epic 只剩这一刀；第一刀「传送代价 + 空房 tick + 管理端」已落，见年表）· #772 epic 延迟与分片 ·
  **#742 TLS**（部署侧已落 #1033：边缘 edge + certbot、官网链接换 https；**只差 443 放行 + `--tls-init` + 外网核**）·
  #403 帮会战（远期占位）。保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- **口径数字**：`docs/14` 无生成脚本、改接口手工加行，现 **268 = 8 + 68 + 192**（tag 口径，`cast_range`
  两个接口后；`/admin` path 前缀是 **195**，差 3 个是免令牌的 `/admin/auth/*`）；
  client 单测 **70 套**；
  e2e **92 套**（**按 `test:e2e*` 脚本数**，`ls server/test/e2e*.cjs` 是 91 个文件，差的那 1 个是
  `test:e2e:backup` → `test/backup.cjs`；全仓一律按脚本数，别再写 90/91）；`make audit` **18 项**；
  表 **76 = 39 配置 + 37 运行时**；管理端 **53 页面 / 54 路由**；客户端 **32 个 Manager**；结算缓存 **14**；
  `docs/37` 是最高优先单一来源。
- **`docs/README` 的目录表有守点**（#1039 / #1042 / #1045）：`audit-docs-toc` 守**四类**——每篇都要登记
  （编号表或附录表）、序号 == 文件名前缀、链接不得死链、`N 个接口` / `N 个 admin 接口` == `openapi.json`
  现算；**加/删接口后合并前跑 `node tools/audit-docs-toc.cjs --write`**，否则 `make audit` 红。
- **「行数」列已删除（#1045）**，别再往目录表加回去：行数是唯一「改任何一篇正文一个字都可能变」的
  派生数字，冲突面 100%，并行会话「算完 → 合并」之间必漂（#1042 加守点首跑就红）。原则：**派生数字
  要么精确维护、要么不写**，写「大致准」的行数等于假精确。
- **新增 env 键 / 文案 / 节点名 / 颜色的 PR，静态审计预判三处登记**：`.env.example`（`audit-api-hardcode`）+
  `tools/config-leak-allowlist.json`（config-leak）+ 进了配置快照的键还要加 `e2e-guard` 的 `EXPECTED_CONFIG_KEYS`。
  新增 e2e 脚本别忘 `tools/run-e2e.cjs` 的 `WEIGHT`（漏了只是分片不均，不报错）。
- **CI 红的判据**（万一又被触发）：本地完整门禁能精确复现 = 代码/测试问题；只有本地绿而 CI 红才考虑分片负载；
  同一套件连续 ≥2 轮同断言红不要再当抖动（`realtime-shard` 的 EADDRINUSE 是残留进程，单跑必绿）。
- 掉落 epic **#801 已关**（#802 世界实体 / #803 终态流水 / #804 客户端 / #805 管理端四页全落）。
  区服 epic #954（P0~P7）全关；**#1009 推翻了 #962 的 P6 口径** —— 选区前移到登录页。
