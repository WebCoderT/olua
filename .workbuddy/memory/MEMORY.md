# olua 长期记忆（索引）

> 跨域硬纪律 → 本文件；按域不变量 → `topics/架构不变量.md`；查坑 → `topics/踩坑速查.md`；「做过没有」→
> `topics/进度年表.md`；登记清单 → `topics/登记清单.md`；展开做法 → `.workbuddy/skills/`。
> **本文件只留「每条 PR 都要照着做的规则」**；一次性结论 → 年表；展开细节 → topics（别把长文塞回来，本文件会超限被截断）。

## 纪律（不可绕过）
- issue → 分支 → PR（「关联 #n」，**不写 Closes**）→ 本地校验绿 → squash → 手动 `gh issue close`；长正文一律 `--body-file`。
- **不跑 CI（2026-11-14 拍板）**：门禁 = `make ci-static` + `make e2e-all`（+ `make client-test`），本地连跑 2~3 次绿就合；
  别为 CI 红反复改测试，也别推送去触发 CI。
- **多会话并行 = worktree**（#948）：改动只在自己的 `~/worktrees/olua-<issue>`；动笔前 `git status` 认领；只 `git add <明确路径>`。
  依赖要 `cp -al` 或自己 `npm ci`，**别 `ln -s` 到别人的 worktree**（对方 `npm ci` / `worktree remove` 会让你的依赖消失）。
  `make client-test` 另需两样 gitignore 产物：`client/temp/declarations`（`cp -R`，缺了 tsc 报 `Cannot find module 'cc'`）、
  `client/assets/resources`（`ln -s` 主工程即可，缺了成片 ENOENT）。
- 仓库 PUBLIC：密钥 / IP / 邀请码 / JWT 不进记忆不进库。**`website/` 默认不动**（例外只在用户亲口同意：#742 换 https、#1047 数字对账）；
  官网数字也会漂，`project.html` 指标区上方有每个数字的复算命令注释，改前先跑（「70 项已实现能力」无来源，别照抄）。
- **现状 ≠ 正确**：issue 正文先按行号实测 `server/src` + `admin/src` 再动手。
- **待决定项实时问**（AskUserQuestion 一轮 1~4 个）；文档禁写「不做」（写「暂时放置 + 重开条件」）；「已定」只标用户亲口拍过的。
  用户说「我自己细化 / 我在改」→ 改完本地就停。
- 登记清单见 `topics/登记清单.md`（漏一处 = 静默失效；「新增配置行」走一次性补数据，不是加列）。

## 测试与门禁
- **只校验代码，不校验数据**：帧形状 / 字段名 / 纯函数映射 / 状态机 / 方向 / 存在性进断言；只数 / 掉血 / 位移 / 事件次数 /
  由配置算出的期望值一律不进。要「确实发生」用 `waitFor` 等事件，别固定窗口 + 数值区间；准备步骤用 `changes`，别事后 `COUNT`。
- 阈值断言换相对关系（#966）；配置管理面逐字段比 `config-snapshot` / dist 常量，不手抄值；观测面收窄导致的假红换权威快照。
- 源码断言切方法体**按大括号配对、不按缩进**；反证法：方法名写错必须拿到空串，空串一律判失败。
- 锁格式不锁数值 · 显示效果不写断言 · 假绿 > 漏检 · 血量类数「比上次低」次数（回血锯齿）· 时序别赌 wall-clock ·
  改日志格式要全仓搜测试文案断言 · **改 src 先 build**（本次 e2e 全 94 套挂在「缺 `server/dist/main.js`」，`e2e-all` 自己不 build）·
  红时先读服务端日志再怀疑链路 · 验「贴脸」别站到血牛身上。
- 延迟类指标只打印分位数、不设阈值（#1043）。
- 「每张表必须归类」有守点（#438，`e2e-guard` 与 `config-tables.cjs` 双向比对）。
- **合并前类型检查以 `make ci-static` 为准**（#804）：单跑 `make client-check` 0 错，`ci-static` 仍可能报真错。
- 工具链：只信 Grep 工具（BSD grep 交替恒空）· 批量替换 `perl -pi -e` · `curl --noproxy '*'` · 判进程 `kill -0`。

## 架构不变量（全量 → `topics/架构不变量.md`）
- **服务端权威**：BizException 400 · 乐观锁 409+20006 · 校验 40000 · 失败 `data` 恒 `null` · 客户端零决策、零兜底；
  方向恒 `apply-snapshot → game-config → types`；进 `SERVER_INVENTORY_FIELDS` 的字段不得写也不得补默认值。
- **区 = 服务端算出的上下文，不是请求参数**（#954）：玩家侧接口零 `zoneId`；按 id 取别区对象一律 **404**；
  管理端不绑区但 `X-Zone-Id` 必填、无「全部区」；zone-scoped 仓储没有无区重载。
- **DTO 的 `boolean` 必须有 `@IsBoolean`**（#1010）：`ValidationPipe({ whitelist: true })` 会把无装饰器字段**静默剥掉**。
- **跨进程指令一律落表 + 轮询**（热重载 / 掉落清空 / 副本登记同一形状），管理端不直接改内存、不直接 `DELETE` 投影表。
- 守点：`audit-zone-scope`（五类判据 + `zone-scope-allowlist.json`）· `audit-admin-zone` · `audit-server-boundaries`
  （**type-only import 同样计数**）· `audit-admin-ui`（七条）。
- 副本（#1001）/ 分线（#1000+#1016）/ 战斗 / AI / 背包 / 邮件 / 商城 / 进图 / 任务 / 拾取 / 帮会 / 掉落 / 区边界 / 分片 → topics。

## 素材（`client/assets/resources` 不入库，2.4GB 走 Release）
- **「素材缺图」只看三处**：DB 里 9 张带 `icon` 的表对磁盘 · `images.ts` 的 `uiImages` 62 条 · `node tools/audit-resource-refs.cjs`。
  三处全绿 = 没缺图；`verify` 红只是**清单过期**（#1025）。
- 图集加载 `loadLoopFrames(dir)` 候选 `[dir, dir/<basename>]`，「图集优先、散帧兜底」。
- 发布：`make resources-manifest/pack/upload RES_VERSION=<新版本>` + 提交**仓库根**的 `resources.manifest.json`；
  sha1 口径只认 `resources_sync.py verify`，别造第二个真相。

## 引擎坑 / 部署
指针事件配 `UITransform`；Game 挂 Canvas → 五世界层建好再 `setWorldPosition(0,0,0)`；显隐与摆位绑「片段就绪」。
compose 五服务：admin:80 唯一入口 / game:8080 / server:3100 / realtime:3101 / website 不映射；卷 `olua_olua-data`。
**HTTPS（#742，`profiles: ["tls"]`）** 加 `edge`（独占 :80/:443，443 → admin:80）+ `certbot`，admin 退到 `127.0.0.1:8081`；
开关是 `deploy.env` 的 `OLUA_TLS=on` → `deploy.sh` 派生 `COMPOSE_PROFILES` + 端口变量，首签 `--tls-init`。

## admin 视觉 = legend 设计系统（#946）
- token 唯一来源 `admin/src/index.css` 的 `@theme`（surface/line/ink/gold/ember/jade/warn 语义名）；稿单一来源
  `design/legend-console/`。**Tailwind 内置色族与裸色值全禁**；四族职责不交叉；金底必配深字；SVG 用 `var(--color-*)`。
- 守点 `audit-admin-ui` 七条（结构 4 + 词汇 3），**改守点后必须反证**。Badge/Notice tone 键 = `jade/ember/gold/warn/muted`。
- 新页面一律 `cd admin && npm run new:page -- <Name>` 起步（合规骨架 + `__UI_CAPTURE__` 状态清单）；显示效果靠人眼看截图，不写断言。

## 进度与口径（细节 → `topics/进度年表.md`）
- **当前 open**（2026-11-15）：#1025 资源清单过期（已按 v2026-11-15-1 重生成并本地打包到 `resources_dist/`，**用户决定先不上传**）·
  #742 TLS（部署侧已落 #1033，只差 443 放行 + `--tls-init` + 外网核）· #403 帮会战（远期）·
  #808 地图重构 epic（子项全关，关不关由用户定）。保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- **客户端 UI 按 `design/olua-ui/` 重排**：#1059 批次一（令牌 + 共用组件 + 场景四屏）、#1075 批次二（05~20 十六屏弹窗）。
  `configs/layout/tokens.ts` 是全站唯一颜色/字号/间距来源，**不为稿造新档**（稿里 15 / 22 px 收敛到 f14 / f20）；
  新增颜色一律从 `T` 取，别写裸 hex —— **这条没有守点，只靠自觉**。
  坑：`createRolePreview` 的 size 只决定命中区、屏幕大小靠 `preview.setScale()`（帧图集 RAW 800×800、本体仅 216×372）；
  wrapped label 的配置 y 是**文字块上边缘**不是中心；稿的 `.panel` 高度可溢出、客户端有硬边界 → 取内容实际高度（05 背包 500→540）。
  刻意不按稿：14 聊天（常驻左下小窗 #469）、08 商城（现用整图美术）。
- **收口类 issue 关了就回去划文档的「缺口表」**：改法 `~~原文~~` + 已修（#nnnn）；优先级矩阵只标 ✅ 不重排（重排是玩法决策）。
- **口径数字**：`docs/14` 271 = 8 + 68 + 195（`/admin` path 前缀 198，差 3 个免令牌 `/admin/auth/*`）；client 单测 70 套；
  e2e **按 `test:e2e*` 脚本数 94 套**（`ls test/e2e*.cjs` 是 93，差 `test:e2e:backup`）；`make audit` 19 项；
  表 77 = 39 配置 + 38 运行时；管理端 53 页面 / 54 路由；客户端 32 Manager；`docs/37` 是最高优先单一来源。
- **派生数字守点**（口诀：**要么精确维护、要么不写**）：
  `audit-docs-toc` 守目录表四类（每篇登记 / 序号 == 文件名前缀 / 无死链 / `N 个接口` == `openapi.json`）·
  `audit-count-claims` 守 `N 项审计` / `N 套 e2e` / `N 套单测` / `N 张表` / Manager / 页面 / 路由，另含 `docs/13` §九 e2e 分组表
  判据 F（**只报红、不给 `--write`**：漏的套件挂哪组要人判断）。**加/删接口或表或 e2e 后跑 `--write`**（会连 Makefile / CI 注释 /
  官网 / skills 一起改）。`.workbuddy/memory/**` 永久排除（历史日志写的是当时的数）。
  `docs/README` 目录表的「行数」列**已删（#1045），别加回去** —— 改正文一个字就可能变。
- **新 PR 预判三处登记**：`.env.example`（`audit-api-hardcode`）+ `tools/config-leak-allowlist.json`（config-leak）+
  `e2e-guard` 的 `EXPECTED_CONFIG_KEYS`；新增 e2e 脚本补 `tools/run-e2e.cjs` 的 `WEIGHT`（漏了只是分片不均，不报错）。
- 掉落 epic #801 已关（四刀全落）；区服 epic #954（P0~P7）全关；**#1009 推翻 #962 的 P6 口径** —— 选区前移到登录页。
