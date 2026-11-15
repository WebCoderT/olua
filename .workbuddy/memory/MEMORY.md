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
- 仓库 PUBLIC：密钥 / IP / 邀请码 / JWT 不进记忆、不进版本库。**`website/` 永不改动**。
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
- **配置管理面的断言跟种子行 / 默认常量对齐，不手抄值**（#966 第七批）：逐字段比 `config-snapshot`，或比 dist
  导出的常量 —— 运营调值不假红，「没落库 / 脏值透传」照样红。
- **源码断言切方法体按大括号配对，不按缩进**（dist 里类方法 4 空格、命名空间函数 2 空格，写死一种会切到类结尾）；
  反证法：方法名写错必须拿到空串，空串一律判失败。
- **观测面收窄导致的假红，换权威快照不要放宽容差**（#966 第四批）：AOI 只裁广播，**进图 `worldJoin` 快照是全量的**。
- 锁格式不锁数值 · 显示效果不写断言 · **假绿 > 漏检** · 断「路过」扫帧历史 · 血量类数「比上次低」次数（回血锯齿）·
  时序别赌 wall-clock · 改日志格式要全仓搜测试文案断言 · 反证前确认 build 真过（管道吃退出码）·
  e2e 播种在 `startServer` 之后 · 改 src 先 build · **红的时候先读服务端日志再怀疑链路**（#805 那次「清空
  等不到 `doneAt`」其实是断言写错了字段名，服务端早就打出「清掉 1 件」）。
- **「每张表都必须归类」有常驻守点**（#438）：`e2e-guard` 拿 `sqlite_master` 全量清单与 `config-tables.cjs`
  两份清单做**双向**比对（`assertAllClassified()` 只在 `config-export` 跑，常年不导配置就发现不了）。
- **合并前的类型检查以 `make ci-static` 为准**（#804 踩到）：单跑 `make client-check` 0 错、`ci-static` 报两处真错。
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
- 守点已落地：`tools/audit-zone-scope.cjs` 五类判据 + 白名单（`zone-scope-allowlist.json`，不再命中或同名
  命中 >1 处都算红）；`audit-admin-zone`（挂 `ZoneContextGuard` 却不取区的路由必须登记 + 写理由）；
  `audit-server-boundaries` **对 type-only import 同样计数**；`audit-admin-ui` 七条。
- 已展开域 → `topics/架构不变量.md`（战斗 / AI / 背包 / 邮件+群发 / 商城 / 进图 / 任务 / 拾取 / 帮会 / 刷怪 /
  移动 / Room / 掉落 #802~#805 / 区边界 / 分片 #770 / 地图规则 #812 / 分线 #1000）。
- **分线（#1000）三条不变量**：选线结论只在世界层（`WorldService.pickRoom`，通道层不自己数人）·
  「`mapAt` == 目标图」的人容量一律放行（回来的人不能被自己那张图锁在门外）·
  **在场表 / 广播 / 分桶一律按房号三键（区:图:线）**，只比「区 + 图」= 跨线 ghost + 容量白算。

## 引擎坑 / 部署（展开 → `cocos-*` 技能 · `olua-deploy`）
指针事件配 `UITransform`；Game 挂 Canvas → 五世界层建好再 `setWorldPosition(0,0,0)`；显隐与摆位绑「片段就绪」。
compose 五服务：admin:80 唯一入口 / game:8080 / server:3100 / realtime:3101 / website 不映射端口；
出厂快照进镜像、卷 `olua_olua-data`；客户端地址由 `DEV_MODE` 唯一开关决定。

## admin 视觉 = legend 设计系统（#946，PR #947/#950/#951）
- token 唯一来源 `admin/src/index.css` 的 `@theme`（surface/line/ink/gold/ember/jade/warn 语义名）；设计稿单一
  来源 `design/legend-console/`。**Tailwind 内置色族与裸色值全禁**；四族职责不交叉；金底必配深字；SVG 用 `var(--color-*)`。
- 守点 `tools/audit-admin-ui.cjs` **七条**（结构 4：遮罩/页头/卡片/字段标签；词汇 3：旧色族/裸色值/必有 PageHeader）；
  改守点后必须反证。Badge/Notice tone 键 = `jade/ember/gold/warn/muted`。
- **新页面一律 `cd admin && npm run new:page -- <Name>` 起步**（合规骨架 + `__UI_CAPTURE__` 状态清单）；
  显示效果靠人眼看截图，不写断言。细则 → `.workbuddy/skills/olua-admin-ui/`。

## 进度与口径（细节 → `topics/进度年表.md`）
- **当前 open**：#9 包体积 · #12~#19 素材 · #295 阶段三 · #403 帮会战 · #742 TLS ·
  #808 地图重构（**剩 #1001 副本与传送代价 / #1016 分线客户端 UI**）。保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- **口径数字**：`docs/14` 无生成脚本、改接口手工加行，现 **266 = 8 + 68 + 190**；client 单测 **69 套**；
  e2e **91 套**；`make audit` **17 项**；`docs/37` 是最高优先单一来源。
- **新增 env 键 / 文案 / 节点名 / 颜色的 PR，静态审计预判三处登记**：`.env.example`（`audit-api-hardcode`）+
  `tools/config-leak-allowlist.json`（config-leak）+ 进了配置快照的键还要加 `e2e-guard` 的 `EXPECTED_CONFIG_KEYS`。
  新增 e2e 脚本别忘 `tools/run-e2e.cjs` 的 `WEIGHT`（漏了只是分片不均，不报错）。
- **CI 红的判据**（万一又被触发）：本地完整门禁能精确复现 = 代码/测试问题；只有本地绿而 CI 红才考虑分片负载；
  同一套件连续 ≥2 轮同断言红不要再当抖动（`realtime-shard` 的 EADDRINUSE 是残留进程，单跑必绿）。
- 掉落 epic **#801 已关**（#802 世界实体 / #803 终态流水 / #804 客户端 / #805 管理端四页全落）。
  区服 epic #954（P0~P7）全关；**#1009 推翻了 #962 的 P6 口径** —— 选区前移到登录页。
