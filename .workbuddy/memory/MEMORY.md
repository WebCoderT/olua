# olua 长期记忆（索引）

> 跨域硬纪律 → 本文件；按域不变量 → `topics/架构不变量.md`；查坑 → `topics/踩坑速查.md`；「做过没有」→
> `topics/进度年表.md`；登记清单 → `topics/登记清单.md`；展开做法 → `.workbuddy/skills/`。
> **本文件只留「每条 PR 都要照着做的规则」**；一次性结论 → 年表；展开细节 → topics（别把长文塞回来，本文件会超限被截断）。

## 纪律（不可绕过）
- issue → 分支 → PR（「关联 #n」，**不写 Closes**）→ 本地校验绿 → squash → 手动 `gh issue close`；长正文一律 `--body-file`。
- **主仓库工作区必须停在 master**（用户 2026-11-23 重申）：**所有改动（含建分支、写 WIP）一律在
  `~/worktrees/olua-<issue>`**，主仓库只做 `fetch` / `pull --ff-only` / `worktree` 管理，不许 checkout 别的分支、
  不许留脏文件。发现违反就当场纠正：`git diff > /tmp/<issue>.patch` → 还原 → `checkout master` →
  在 worktree 里 `apply` 补丁，**别丢别人的 WIP**。
- **合并完成必同步本地**（用户 2026-11-23 明确）：每次 PR squash 合并后，**立刻** `git pull --ff-only`
  把主仓库更到最新 master，删掉已合并的本地分支与 worktree，不许让本地停在旧提交上。
- **不跑 CI（2026-11-14 拍板）**：门禁 = `make ci-static` + `make e2e-all`（+ `make client-test`），本地连跑 2~3 次绿就合；
  别为 CI 红反复改测试，也别推送去触发 CI。
- **不自行构建客户端（2026-11-16 拍板）**：用户不说「你自己测试」就不许跑 Cocos 构建；改完代码 + `make client-check` 即停，构建与验证等用户开口。
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
- **写日日志（`memory/YYYY-MM-DD.md`）必须先 `tail` 看文件是否已存在**（2026-11-23 事故：多会话并行下
  `cat >` 把另一会话当天写的 85 行 #1166 日志整个覆盖，靠 git 找回）。追加一律 `cat >>` 或 Edit 工具；
  若今天日志不存在才允许 `cat >` 建档。

## 测试与门禁
- **只校验代码，不校验数据**：帧形状 / 字段名 / 纯函数映射 / 状态机 / 方向 / 存在性进断言；只数 / 掉血 / 位移 / 事件次数 /
  由配置算出的期望值一律不进。要「确实发生」用 `waitFor` 等事件，别固定窗口 + 数值区间；准备步骤用 `changes`，别事后 `COUNT`。
- 阈值断言换相对关系（#966）；配置管理面逐字段比 `config-snapshot` / dist 常量，不手抄值；观测面收窄导致的假红换权威快照。
- 源码断言切方法体**按大括号配对、不按缩进**；反证法：方法名写错必须拿到空串，空串一律判失败。
- 锁格式不锁数值 · 显示效果不写断言 · 假绿 > 漏检 · 血量类数「比上次低」次数（回血锯齿）· 时序别赌 wall-clock ·
  改日志格式要全仓搜测试文案断言 · **改 src 先 build**（`e2e-all` 自己不 build，缺 `server/dist/main.js` 会整片挂）·
  红时先读服务端日志再怀疑链路 · 验「贴脸」别站到血牛身上。
- **要造「出厂没有的刷怪区」必须在起服后、首次进图（房创建）前插**（#1084）：空库首启的出厂自举
  会整份灌 config-sync.sql，把启动前预插的 `map_spawn_areas` 行抹掉。
- 延迟类指标只打印分位数、不设阈值（#1043）。
- **「只有新加的没声音 / 图片」先查产物新旧**（#1301 后踩过）：`assets/resources/config.json` 里有没有该资源
  映射 + `assets/main/index.js` 里有没有调用点，两样都缺就是那份客户端产物比代码旧（重新构建即好），
  别一头扎进 SoundManager / 资源加载。
- 「每张表必须归类」有守点（#438，`e2e-guard` 与 `config-tables.cjs` 双向比对）。
- **合并前类型检查以 `make ci-static` 为准**（#804）：单跑 `make client-check` 0 错，`ci-static` 仍可能报真错。
- 工具链：只信 Grep 工具（BSD grep 交替恒空）· 批量替换 `perl -pi -e` · `curl --noproxy '*'` · 判进程 `kill -0`。

## 架构不变量（全量 → `topics/架构不变量.md`）
- **服务端权威**：BizException 400 · 乐观锁 409+20006 · 校验 40000 · 失败 `data` 恒 `null` · 客户端零决策、零兜底；
  方向恒 `apply-snapshot → game-config → types`；进 `SERVER_INVENTORY_FIELDS` 的字段不得写也不得补默认值。
  **刻意例外（2026-11-21 拍板，#1146）**：玩家移动 = 客户端演算 + 4Hz pos 上报，服务端只消费上报位置、
  保留 #811 三道校验（速度/穿墙/回拉）；服务端演算玩家位置（moveIntent 步进 / teleportTo / player_move 速度权威）不许再加回来。
- **区 = 服务端算出的上下文，不是请求参数**（#954）：玩家侧接口零 `zoneId`；按 id 取别区对象一律 **404**；
  管理端不绑区但 `X-Zone-Id` 必填、无「全部区」；zone-scoped 仓储没有无区重载。
- **DTO 的 `boolean` 必须有 `@IsBoolean`**（#1010）：`ValidationPipe({ whitelist: true })` 会把无装饰器字段**静默剥掉**。
- **校验失败的消息必须全中文**（#1172）：管道统一用 `httpValidationPipe()`（兜底翻译英文默认模板 + 路径前缀），
  **别再 `new ValidationPipe`**（测试内嵌管道也要用它）；新 DTO 的 `@Min/@Max` 要么带中文 message（带单位带边界），
  要么接受兜底的「路径：不能小于 N」。`IsNumber` 的 message 是第二个参数（`ValidationOptions`）。
- **跨进程指令一律落表 + 轮询**（热重载 / 掉落清空 / 副本登记同一形状），管理端不直接改内存、不直接 `DELETE` 投影表。
- 守点：`audit-zone-scope`（五类判据 + `zone-scope-allowlist.json`）· `audit-admin-zone` · `audit-server-boundaries`
  （**type-only import 同样计数**）· `audit-admin-ui`（七条）。
- 副本（#1001）/ 分线（#1000+#1016）/ 战斗 / AI / 背包 / 邮件 / 商城 / 进图 / 任务 / 拾取 / 帮会 / 掉落 / 区边界 / 分片 → topics。

## 素材（`client/assets/resources` 不入库；Release 分发链已下线 #1293）
- **「素材缺图」只看三处**：DB 里 9 张带 `icon` 的表对磁盘 · `images.ts` 的 `uiImages` 62 条 · `node tools/audit-resource-refs.cjs`。
  三处全绿 = 没缺图；`verify` 红只是**清单过期**（#1025）。
- 图集加载 `loadLoopFrames(dir)` 候选 `[dir, dir/<basename>]`，「图集优先、散帧兜底」。
- **分发已下线（#1293，2026-11-26）**：远端 4 个资源 Release 与 `resources-*` tag 已删（素材无异地副本，
  `resources_sync.py` / `resources.manifest.json` 留作本地核对与打包，素材包由维护者自管）；
  `make resources-*` 五个 target 已删，本地核对用 `python3 client/tools/resources_sync.py verify`；

## 引擎坑 / 部署
指针事件配 `UITransform`；Game 挂 Canvas → 五世界层建好再 `setWorldPosition(0,0,0)`；显隐与摆位绑「片段就绪」。
compose 五服务：admin:80 唯一入口 / game:8080 / server:3100 / realtime:3101 / website 不映射；卷 `olua_olua-data`。
**停服期只发官网**：`deploy.sh --no-build` 跳过 `compose up -d`，不会把已 `stop` 的 server/realtime/game 拉起；verify 的 game 502 属预期（#1290）。
**HTTPS（#742，`profiles: ["tls"]`）** 加 `edge`（独占 :80/:443，443 → admin:80）+ `certbot`，admin 退到 `127.0.0.1:8081`；
开关是 `deploy.env` 的 `OLUA_TLS=on` → `deploy.sh` 派生 `COMPOSE_PROFILES` + 端口变量，首签 `--tls-init`。
**`/game-resources/` 由 admin 自己的 nginx 出**（#1305/#1307）：`alias /usr/share/nginx/game-resources/` +
compose 挂 `./game/resources:...:ro`（与 server 的 `EQUIPMENT_APPEARANCE_RES_DIR` 同一宿主机目录），
**不许改回反代 game 容器**（game 一停就是 502，页面只会说「文件不在资源包里」）。
坑：nginx 自带 mime.types 没有 wav，且 **location 里写 `types{}` 会把父级映射整份顶掉**（json/png 一起变
octet-stream）→ 必须同层 `include /etc/nginx/mime.types;` 再补 `audio/wav wav;`。本机没有 docker/envsubst，
模板渲染与行为验证只能在服务器上做（`ssh -i olua.pem ubuntu@`，root 登不上）。

## admin 视觉 = legend 设计系统（#946）
- token 唯一来源 `admin/src/index.css` 的 `@theme`（surface/line/ink/gold/ember/jade/warn 语义名）；稿单一来源
  `design/legend-console/`。**Tailwind 内置色族与裸色值全禁**；四族职责不交叉；金底必配深字；SVG 用 `var(--color-*)`。
- 守点 `audit-admin-ui` 七条（结构 4 + 词汇 3），**改守点后必须反证**。Badge/Notice tone 键 = `jade/ember/gold/warn/muted`。
- 新页面一律 `cd admin && npm run new:page -- <Name>` 起步（合规骨架 + `__UI_CAPTURE__` 状态清单）；显示效果靠人眼看截图，不写断言。
- **动画预览采样口径（#1312）**：`FrameAnimation` 的 atlas 以 `effect/` 开头（边框/背景光效图集）= 双线性平滑
  （与游戏内 Cocos 线性过滤一致），其余像素素材保持最近邻 pixelated；判定在组件内 `frameSmoothOf`，别在调用点散写。
  背景：光效是软渐变，最近邻缩非整数倍会逐帧闪跳（"有的位置会抖"）。坑：帧间错位的互相关判据在细发光线上**退化**
  （平移 1~2px 重合度差 <2%），不能当证据，要目视对照帧图。

## 进度与口径（细节 → `topics/进度年表.md`）
- **当前 open**（2026-11-27）：只剩 #403 帮会战（远期占位）。**#1322 border-30123~30134 下线已合**
  （PR #1323 `4c5bc382`：清单 84→72、出厂基数 30123→30135、快照 appearance 行外科平移；
  坑：快照整体重导是待决项，重导会打红 drug-percent / monster-config 两个数据单测）·
  **#1286 前后缀掉落权重（变体随机掉落）已合**
  （PR #1292 `155f0a9b`：equipment_meta 加 prefix/suffix_drop_weights 两列（[] = 不抽档、行为与合并前一致），
  rollDrops 命中基础件时抽档改写 _pXsY，手写变体 id 不二次抽档；管理端装备规则页每档「掉落权重」列 0 = 不掉落；
  开抽档把权重配非零即可，无需迁移；变体 p0s0 的 id 就是基础件本身，抽档要特判）·
  **#1278 背包自动回收/使用/穿戴已合**
  （PR #1282 `f92f3039`：底部四键 + 两勾选弹窗 + 背包满自动回收/重拾 + 衣服槽下自动穿戴复选框；
  服务端零改动；偏好本机 localStorage 按角色分键，默认全不勾）·
  **#1280 配置快照按版本门控已合**（PR #1281：管理端改配置不重启进程下次进图即生效）·
  **#1266 配置快照可视化导入导出已合**
  （PR #1273 `66b2af9e`：SystemPage 新卡片 + 新权限点 `system:write` + spawn 同一份 CLI 单一真相；
  顺带修：**新库自举保留出厂任务线/刷怪区**——`clearQuestLinesOnce` 只对存量库生效，e2e-map 相应改型）·
  **#1215 星灯纪任务线已合**
  （PR #1216 `7d85e944`：28 环主线 7001~7028 严格 prev 链 + 怪物等级:=图等级（61~69 模板外推）+
  220 刷怪区按物种铺 58 野外图 + 9 NPC 1101~1109（立绘 npc/2130~2138 **缺帧用户补，补前 NPC 不显示**）；
  脚本 `oneoff-rebuild-quest-line.cjs` 幂等可重跑，部署机同步待用户跑）——**#1177 的「任务线下线」就此结束**；
  任务 id 口径：7000 段 = 星灯纪出厂主线，8000/8100 段 = e2e seed 与运营自建）·
  #1025 已发版 v2026-11-15-1（Release 15 卷 2.56GB，清单 `a03f83b1`）· #808 epic 已验收关闭 · #742 HTTPS 已上线
  （证书到 2027-02-13，certbot 自动续期，收尾缺陷 #1079 已修）。保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- **客户端 UI 按 `design/olua-ui/` 重排**：#1059 批次一（令牌 + 共用组件 + 场景四屏，PR #1070）·
  #1075 批次二（05~20 十六屏弹窗，PR #1076）**都已合**。20 稿剩下的两处暂时放置：Toast 四态（客户端无独立
  Toast 组件）、引导气泡配色（不在 16 屏范围）。`configs/layout/tokens.ts` 是全站唯一颜色/字号/间距来源，
  **不为稿造新档**（稿里 15 / 22 px 收敛到 f14 / f20）；新增颜色一律从 `T` 取，别写裸 hex —— **无守点，只靠自觉**。
  坑：`createRolePreview` 的 size 只决定命中区、屏幕大小靠 `preview.setScale()`（帧图集 RAW 800×800、本体仅 216×372）；
  wrapped label 的配置 y 是**文字块上边缘**不是中心；稿的 `.panel` 高度可溢出、客户端有硬边界 → 取内容实际高度（05 背包 500→540）。
  刻意不按稿：14 聊天（常驻左下小窗 #469）、08 商城（现用整图美术）。
- **收口类 issue 关了就回去划文档的「缺口表」**：改法 `~~原文~~` + 已修（#nnnn）；优先级矩阵只标 ✅ 不重排（重排是玩法决策）。
- **口径数字**：`docs/14` 284 个 operationId（以 `audit-docs-toc` 现算为准）；client 单测 75 套；
  e2e **按 `test:e2e*` 脚本数 97 套**（`ls test/e2e*.cjs` 是 96，差 `test:e2e:backup`）；`make audit` 19 项；
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

## 引擎坑（补）
- **滚动网格首行边框被 mask 裁掉**（#1104）：`createScrollView` 的 content `anchorY=1` 压视口顶边，
  网格 `paddingTop=0` 时首行子元素的边框正好压在裁剪线上整条消失。滚动区四边留 3px（> 边框厚），
  视口同步放大保持内容宽不变。排查「UI 缺一条边」先查 mask 裁剪再查绘制。
- **CCClass 子类（含 Node 子类）销毁后字段被 `_destruct` 置 null**（#1188）：场景销毁后对象还在、
  但构造器赋值的字段全是 null；静态 Store 的 onChange 监听器若不在 onDestroy 里**先退订再 reset**，
  销毁期 emit 回调摸这些字段就是 `null.open` 类崩溃。守点在 test-guide.cjs F 节（退订先于 reset）。