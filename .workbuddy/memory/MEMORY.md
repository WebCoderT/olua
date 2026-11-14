# olua 长期记忆（索引）

> 跨域硬纪律 → 本文件；按域不变量 → `topics/架构不变量.md`；查坑 → `topics/踩坑速查.md`；「做过没有」→
> `topics/进度年表.md`；登记清单 → `topics/登记清单.md`；展开做法 → `.workbuddy/skills/`。

## 纪律（不可绕过）
- issue → 分支 → PR（「关联 #n」，**不写 Closes**）→ CI 绿 → squash → 手动 `gh issue close`；长正文一律 `--body-file`。
- **多会话并行 = worktree**（#948）：仓库有第二个人可能动笔时，改动一律在自己的 worktree（`~/worktrees/olua-<issue>`）；
  动笔前 `git status` 确认改动归属；只 `git add <明确路径>`；记忆/日志也只写自己 worktree。细则 → `.workbuddy/skills/olua-branch-worktree/`。
- 仓库 PUBLIC：密钥 / IP / 邀请码 / JWT 不进记忆、不进版本库。**`website/` 永不改动**。
- **现状 ≠ 正确**：issue 正文先按行号实测 `server/src` + `admin/src` 再动手。
- **待决定项实时问**（AskUserQuestion 一轮 1~4 个）；文档禁写「不做」（写「暂时放置 + 重开条件」）；
  「已定」只标用户亲口拍过的。用户说「我自己细化 / 我在改」→ 改完本地就停。
- 登记清单见 `topics/登记清单.md`（漏一处 = 静默失效；「新增配置行」走一次性补数据，不是加列）。

## 测试与门禁（细则见 `topics/踩坑速查.md`）
- 反证前确认 build 真过（管道吃退出码）· e2e 播种在 startServer 之后 · 改 src 先 build · 本机绿 ≠ CI 绿。
- 锁格式不锁数值 · 显示效果不写断言 · **假绿 > 漏检** · 断「路过」扫帧历史 · 源码断言钉方法体 ·
  血量类数「比上次低」次数（回血锯齿）· 时序别赌 wall-clock · 改日志格式要全仓搜测试文案断言。
- 工具链：只信 Grep 工具（BSD grep 交替恒空）· 批量替换 `perl -pi -e` · `curl --noproxy '*'` · 判进程 `kill -0`。

## 架构不变量（细节见 `topics/架构不变量.md`）
- **服务端权威**：BizException 400 · 乐观锁 409+20006 · 校验 40000 · 失败 `data` 恒 `null` · 客户端零决策、
  乐观锁「拉最新 + 丢弃本轮」不重推。
- 方向恒 `apply-snapshot → game-config → types`；一份数据一个来源；客户端零兜底；进 `SERVER_INVENTORY_FIELDS`
  的字段不得写也不得补默认值；纯服务端参数别进 `RuntimeParamsDto`。
- 已展开域见 `topics/架构不变量.md`（战斗 #822~#826 · AI #853~#858 · 背包 #835~#842 · 邮件 #866~#870 · 商城
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
- 细节 → `topics/进度年表.md`。最近：**#768 10Hz 提频+帧瘦身+序列化缓存（PR #945 `9202366c`，已关）** ·
  #767 同步延迟测量基线（PR #944 `ba846c6b`）· #809 Room 抽象 + 热重载（PR #942/#943，关 #809+#669）·
  #811 移动校验（#941）· #932 任务域（#933）· #826 战斗六项（#936）。
- **#772 系列顺序已拍板：#767→#768→#810**，前两刀已落地。下一刀 **#810 AOI**（#810 验收的序列化断言
  依赖 #767 的统计行）。
- 当前 open：#9 包体积 · #12~#19 素材 · #295 阶段三 · #403 帮会战 · #742 TLS · #808 地图重构（剩 **#810 AOI**、
  **#812 分线副本**；结算读 `map_rules`、掉落进 Room 暂未落地，重开条件见 docs/20）· #801~#805 掉落重构 ·
  #769/#770 同步系列 · #772 分片 · #438 群发。保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- `docs/14` 无生成脚本，改接口手工加行；现口径 **249 = 7 + 65 + 177**。client 单测可当门禁（65 过）。
  `docs/37` 是最高优先单一来源。
- **新增 env 键 / 文案 / 节点名 / 颜色的 PR，静态审计要预判两处登记**：`.env.example`（audit-api-hardcode）+
  `tools/config-leak-allowlist.json`（config-leak）。
- **CI 红的判据**：先在本地完整 verify（72 套）复跑——**本地能精确复现 = 代码/测试问题**（改字段名最容易漏
  「函数体内读点」，如 `find(m => m.instanceId === …)`）；只有本地绿而 CI 红才考虑分片负载，`gh run rerun --failed`。
  同一套件连续 ≥2 轮同断言红不要再当抖动。改广播帧字段后记得全量本地 verify，「本地绿」结论会过期。
