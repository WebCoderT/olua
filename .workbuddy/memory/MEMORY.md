# olua 项目长期记忆

> 细节见 Skill `olua-server`/`olua-client`/`olua-admin`/`olua-deploy`；Cocos 坑见 `cocos-*`；逐日见 `.workbuddy/memory/2026-*.md`。
>
> **技能与记忆都随仓库提交**（用户 2026-10-11 定）：技能在项目级 `.workbuddy/skills/`（22 个，仅 `github` 留用户级），记忆在 `.workbuddy/memory/`；`.gitignore` 用白名单只放开这两个目录，`backup/` 等临时产物仍忽略。改技能/记忆同样是**改动仓库文件**，要按提交纪律走 issue + PR。仓库是 PUBLIC，**写记忆时不得落入服务器 IP / 私钥 / 邀请码 / JWT 密钥实际值**。

## 分支线（用户 2026-10-20 定）
- **master = 横屏线**：回退到竖屏改造之前（`478e658`，#133 实时通道），设计分辨率 **1624×750**。横屏线不再含竖屏那批改动。
- **portrait = 竖屏线**：**750×1624** + 按 `design/` 重排的登录/选角 + 单角色 + 本机账号（原 #135/#138/#141/#144/#146/#149 与它们的记忆提交都在这条线上）。竖屏相关的改动只进 `portrait`，不回 master。
- 拆分记录 issue **#152**；本地标签 `pre-rollback-master` 指向拆分前的 master（`7e52900`），作为兜底快照。**两条线的差异约 63 个文件**（`git diff --stat master portrait`），合并两边改动前先跑一次这条命令看范围。
- **对外说明写在根 `README.md` · `README.en.md` 的「分支」一节**（「三个端」之后，#154 / PR #155）：两分支的分辨率与内容、怎么切、差异怎么看、素材不随分支切换。`design/`（设计稿）与 `client/assets/resources/` 一样已在 `.gitignore` —— 两者都不入库，两条分支共用本机同一份，所以切分支后背景素材仍是上一版（竖屏那轮 `gen-ui-assets.py` 原地改写过 `login/login_bg.png` 与 `create_role/bg.png`）。

## 提交纪律（用户强制）
- **所有代码提交都必须有对应的 issue / PR，必须有记录**（用户 2026-10-10 定）：master 上不允许存在没有 issue 追踪的提交。流程 = 开 issue → 开分支（`git checkout -b <type>/<n>-<slug>`）→ 提交（正文带 `Closes #n` / `Refs #n`）→ 推分支开 PR → CI 绿 → squash 合并。**任何直接落在 master 上的提交都算违规**（文档 typo 也不例外，走 docs PR）。
- **一个功能一次提交**，不留混合改动；全绿才提交（`make verify` = 客户端 tsc + 29 套单测 / 服务端九套 e2e 980 条 / 管理端 build / 9 审计；CI 只跑 `make ci`）。**别记死数字**，从 `make verify` 与 `node tools/audit-doc-numbers.cjs` 的输出实测。
- **中英双语文档**：中文是主体，英文平铺在同目录成 `X.en.md`（README / FAQ 各一份），两份顶部各一行语言互链；索引 issue **#45**，子 issue #39 守卫 / #40 根 / #41 client / #42 admin / #43 server / #44 equip-aligner。译本 = 不改口径（章节数 / 表格行 / ✅❌ 数 / 数字 multiset 全等），术语表见 #45。
- **一个 PR = 一个 squash = 一个功能**（分支上攒了两件，就拆成两个分支各开 PR，`git rebase --autostash master` 接最新基）。
- 格式 `feat|fix|refactor|docs|test|chore(端): 一句话`；改接口必须连 `openapi.json` + 两端生成物一起提交。
- **一个 issue 含多个功能 → 先拆成多个小 issue 再做**（用户 2026-10-10 定）；大 issue 降级为只管顺序与取舍的索引，能动的工作都在子 issue 里。

## 仓库形态
根 = README/FAQ + 跨端 `tools/` + `Makefile`（命令入口，统一 `env -u NODE_OPTIONS`）。`client/` 是 Cocos 工程本体，脚本住 `client/tools/`；审计在根 `tools/audit-*.cjs`（`make audit` 自动发现）。

**分支整理判据（2026-10-20 定）**：仓库全是 squash 合并，所以 `git branch --merged` **判不出**短线是否已合并（squash 后没有祖先关系）。正确做法是比树 —— `git merge-tree --write-tree <目标分支> <待判分支>` 的首行若等于 `git rev-parse <目标分支>^{tree}`，说明该分支**没有新内容**；配合 `gh pr list --head <分支> --state all` 核对 PR 已 MERGED 即可删。删掉的提交仍可从 `refs/pull/<n>/head` 取回（`git fetch origin pull/<n>/head`）。

## 部署（线上，细节见 Skill `olua-deploy`）
- 三容器：**admin :80**（管理端 SPA）/ **game :8080**（Cocos Web 产物，nginx 静态）/**server 仅内网 3100**（不对外暴露）；game 与 admin 各自把 `/api` 反代到 `server:3100`，所以**游戏站与服务端是同源**，客户端 `baseUrl` 线上解析成 `/api`。
- 同步游戏产物 `deploy.sh --game`（rsync **增量**、不带 `-z`）；**只改 nginx 配置不必整份重发**：scp 对应 conf 到 `$DEPLOY_DIR/deploy/` 后 `docker exec <容器> nginx -t && nginx -s reload`（bind mount 直通）。
- **静态站 `location /` 的 try_files 必须含 `$uri/`**（`$uri $uri/ =404`）：不带会让根路径 `/` 404、只有 `/index.html` 能开；`tools/audit-deploy.cjs` 第 8 条守着这条。Cocos 不是 SPA，**不做** `/index.html` 回落，缺失资源如实 404。
- **Cocos 客户端只能用 GUI 打包**（本机 CLI 走不通，见 2026-10-12 日志）；产物 ~3.1G，首传是硬成本。
- 站点一上线即刻会被外部扫描/IP 试探（看到 106.55.x 等段在抓 assets 与 `/api/roles`），注册仍靠邀请码兜着。

## 工程风险（必读）
- **编辑器周期性回写 assets**：改完 Grep 核对 + `sleep 20` 复检；**工具输出会串扰** → 只信 `git diff`。BSD `grep` 的 `\|` 不是或运算（用 Grep 工具，`-e`）。
- 服务端/子进程必须 `env -u NODE_OPTIONS`（注入的 shim 会让服务静默不监听端口）；`curl 127.0.0.1` 加 `--noproxy '*'`。
- **用户默认常驻启动项目，开发/服务进程会占用端口**（用户 2026-10-11 定）：跑 e2e / 起服务 / 起任何会监听端口的进程前，**先探测端口是否已被用户实例占用**；若冲突，优先换端口或复用用户已在跑的实例，别盲目 kill / 重启用户的进程。
- 打包 babel loose：`[...迭代器]` → `[].concat()` 恒空 → 只用 `Array.from`/`forEach`。
- `isValid` 不查「待销毁」→ 失效判据叠数据判据；飘字走 `GameUiHelper.createTip*`；素材扩展名必须等于真实格式；`resources/` 不入库，删前备份。
- 客户端 tsc 用 `client/tools/tsconfig.check.json`（放 `/tmp` 会 TS5058）。
- **一次性产出大量中文（脚本/issue/PR 正文）会混乱码** → 写完先扫非预期英文串，再落盘发布。

## 三端架构（细节全在 Skill）
- **游戏数据只有一份**（用户 2026-10-13 定的硬要求，issue #117 索引 / #118 生成物与守卫 / #119 管理端接入 / #122 码清单与文案也派生）：权威定义 = 客户端 `client/assets/configs`；`tools/gen-shared-data.cjs` 把它快照成 `server/src/shared/game-data.generated.ts`（**三端唯一的那份**，管理端 import 同一个文件，Vite 直接打包），`tools/audit-shared-data.cjs` 重生成逐字节比对 + 断言 24 张表齐全非空。原来的 `battle-rules.generated.ts` 已并进去并删除（两份快照并存必然各自漂移）。**算法**一侧仍由 `audit-combat-parity` 锁（把真的 `GameHelper.combatCalc` 编译进 Node 当期望值，不是再抄一版口径）。三张等级表的键 = 来源数组下标，客户端等级从 1 起，**差一位**。包裹 `{code,message,data,timestamp}`，0 成功；`silent` 不弹全局提示。
  - 生成物放 `server/src/shared/` 而不是顶层 `shared/`：服务端 `tsc` 单包编译（`rootDir` = `server/src`，产物 `dist/main.js`），放到 `server/` 外会把产物路径改成 `dist/server/src/main.js`，连带九套 e2e、Dockerfile、deploy 一起改。
  - **管理端**不复制：`admin/src/api/gameData.ts` 按相对路径 import 同一个生成物（Vite 打包；dev 模式要在
    `vite.config.ts` 里 `server.fs.allow: [".."]`），页面显示名字一律过它的查表函数（`equipmentText` /
    `skillText` / `itemText` / `mapText` / `soulText` / `titleText` / `rankText`…）。**性别名与职业码「全职业」
    只存在于 `client/assets/types/role.ts` 的枚举注释里**，生成器按注释抽（`readEnumLabels`，抓不到就抛错）。
  - **服务端门面** `server/src/shared/game-data.ts`（手写，与管理端那个对称）：`ROLE_OCCUPATION_CODES` /
    `ROLE_SEX_CODES`（`Object.keys` 取标签表键）与 `OCCUPATION_HINT` / `SEX_HINT`（DTO 描述那一行）。
    `roles/role-data.util.ts` 的 `ROLE_OCCUPATIONS` / `ROLE_SEXES` 引它，两处 DTO 描述插值 hint ——
    客户端加一个职业码，服务端**一行都不用改**（实测：往生成物的表里注入一个码，清单与文案同时变）。
    两处 DTO 描述改了，`openapi.json` 却能**逐字节无变化**（派生出来的文案与原手写完全一致）。
  - 守卫的三条「内容被抄」判据（#122）：①与生成物**同名**的字典定义；②短标签表（键数 ≤ 8、值全字符串）的
    键清单被写成数组字面量；③抄表的行文（`1 战士`）。**扫前必须剥注释**（注释里写反例是正常的，不剥就会
    逼着人把文档改丑）、**跳过带 `@generated` 的文件**（两端 `models.ts`/`ApiModels.ts` 镜像着 DTO 描述）。
  - 不在范围：掉落（`configs/monsterDrops` 依赖 UI 模块，留后续）；时装（`configs/fashionClothes` 整份被注释，没有活的来源）。怪物战斗数值已进（#34）；怪物实例状态归世界权威 #35（不进生成物）。
  - **文档约定**：`N 张表` 这个句式归 SQLite 表数（守卫在查）；说生成物里的数据集写 **`N 张数据表`**，否则守卫误判。生成物的行数 / KB / 数据表数**没有守卫**（`audit-doc-numbers` 明说不查行数），改了生成器记得顺手改技能 4.0 节（#122 就撞见过一次 23→24 的过期）。
  - **跨端数值约定（#124，第三种破法「同一个数两端各写一份」）**：不再靠注释「两边要一起改」，改成**两层含义**——客户端 `roleSelectorLayout.rolePositions.length` = **界面容量/天花板**（站位有几个就能站几个）；服务端 `ROLE_MAX_PER_ACCOUNT` = **业务上限，只能往下降**（不得超容量）。两者不是同一件事，关系由 `audit-shared-data` 的机械判据锁：**编译布局取站位真值**（tsc + `cc` 垫片后 `require`，不数 `new Vec2(`）断言仓库两处默认值（`.env.example` + `configuration.ts` 兜底）≤ 容量，且禁止客户端再出现第二份上限数字。客户端 `maxRoleCount` 已删（`configs/role.ts` 只留指路注释）。**拒绝「服务端下发 + 站位动态化」的关键事实**：`rolePositions` 是手工调的不规则坐标，动态化=重做构图；且「可运维调」价值为空（调大也不放行，真放行第 4 个会因 `?? new Vec2()` 叠原点）。**守卫盲区写在明处**：部署那台 `server/.env` 不进仓库 → 守卫读不到，靠文档 + 客户端运行期 `console.warn` 兜底。
- 权限两层守卫；**加管理端接口必须 `@ApiAdminDoc({permissions})`**（漏 = 真放行）；业务代码禁写角色判断。
- 接口文件必须 `make gen-api` 生成（新模块登记 `MODULES`）；**别记死数字**：生成物 / 权限点 / 表数随时从 `openapi.json` 实测。
- CI 不覆盖客户端（要编辑器产物）；29 套单测断言真实素材 → 客户端门禁是本地专属。
- **e2e 里「轮询 + 精确值」的断言**：先算被观测状态能停多久，窗口 < 轮询间隔 = flake（本机恒绿/CI 偶红）。**但先问一句：我等的这个字段有几个写者**（#110）——`GET /admin/system` 的 `lastAttemptAt` 既被 `syncFromDisk()`（按磁盘回填）写、又被 `refresh()`（本轮结账）写，于是「备份文件一落盘」它就成立而这一轮还没记账（`lastOk` 仍是 null、体积还是半成品）。判据只能用**只由结账路径写的那个字段**（`lastOk`），且必须先拿到一个"已结账"的快照，后续判据才可靠。修法不一定是拉宽窗口：**#110 实测窗口与超时都够，坏的是判据**（CI 上第二轮稳定 +12.2s / 30s 窗口）。本地证伪＝把窗口**放大到必然可见**（造大库拖慢脚本，比 predicate 里塞 sleep 更贴近真机）。
- 公告：`announcements` 表 → 免令牌 `GET /announcements/active` → 客户端登录页弹窗 + 公告板；已读进独立 `AnnouncementReadStore`（**不混进 StorageManager**，否则触发角色同步）。登录/选角场景没有 UILayer，弹窗挂调用方给的节点。
- 排序白名单唯一来源 `server/src/database/sort-specs.ts`。
- 角色数据 = 不透明文档：读容错、**编辑解析失败必须报错**（空对象兜底 = 清背包）；`updateOnlineRole` 是落盘与同步唯一出口。
- 修订号乐观锁：+1 写在 SQL 里，对不上 → 409+20006；自愈四支 `onSaved`/`onConflict`/`onMissing`/`onKicked`。
- `ValidationPipe({whitelist:true})` 剥嵌套裸对象属性 → DTO 类 + `@ValidateNested` + `@Type` + 登记 `SWAGGER_MODELS`。

## 服务端战斗权威化（#25：server-authoritative / 先单进程 / 暂不同步他人）
- 单一来源链路（#118 后统一为一条）：`gen-shared-data.cjs` 编译 `client/assets/configs` → `server/src/shared/game-data.generated.ts`；`audit-shared-data.cjs` 重生成后逐字节比对。已纳入：等级 60 / 权重 7 / 战魂 37 / 称号 34 / 军衔 100 / **装备 555 件**（37 件基础件，不是 7807）/ 技能 12。
  - 合并前实测过：新生成物的 9 个战斗导出与旧 `battle-rules.generated.ts` **逐值相同**（`COMBAT_RANGE_KEYS`/`COMBAT_SINGLE_KEYS`/五张等级表/`EQUIPMENT_ATTRIBUTES`/`SKILLS`），所以删旧文件不影响 `audit-combat-parity`（2849 组输入 × 10 项比对仍全绿）。
- 装备取舍 = **全量快照**：不让服务端现算 `round(基础值×前后缀倍率)`（那等于把进位口径复制出去）；`role.equipments` 存的本来就是展开后的物品 id。
- 显示名与槽位归属也在生成器里算好（复用客户端 `getEquipmentNameParts` 与条目的 `slot`），消费方不做拼接。
- 已进链路（#34，PR #162）：**怪物战斗数值** = `MONSTER_COMBAT`（220 只怪 maxHp + 攻防六项区间），configs/monster.ts 在 cc 垫片下能干净编译（#44 注记过时）。**技能已进**（#31）。**仍未进：掉落**。

## 世界权威（#35，PR #164，master = dbe6696）
- **边界**：服务端持有怪物实例（instanceId/mapId/monsterKey/出生点/hp/alive/respawnAt）；不持有游走移动（表现层）、掉落经验（独立 issue 后续）、刷怪区域（Tiled 素材不入库）。
- **播种协议**：客户端进图发 `worldJoin`（mapId+spawnPlan），服务端**只在空图采纳**（plan 无身份，逐条补缺=假去重翻倍，踩过坑）；权威快照走 `world` 帧（viewersOf 广播，重生 onWorldChanged）。
- **节奏**：TICK=1000 / PERSIST=5000（dirty 批量 upsert）/ RESPAWN=30000 / MAP_IDLE=600000；空闲回收重载时 `processRespawns` 补到期重生（**tick 与重载共用同一条纯函数**）。
- **SQLite**：文件库 `busy_timeout=5000`；**Nest shutdown 跑完会再收一次 SIGTERM 以 signal 退出（exitCode null + signalCode SIGTERM）——设计行为**；instanceId=`m<mapId>_<n>` 从库 max(parseSeq) 续起跨重启稳定。
- **#34 连锁**：删账号 targets 登记簿 → 结算目标查 WorldService.find()（共享跨账号）；targetsReset 只清幂等账，死怪不因清账复活。
- **客户端**：applyWorldState 差量合并**不回写已存在节点血量**（settle 实时维护）、0 伤害不飘字、断线重连 resendWorldJoin；实时通道不可用回退本地生成。

## 线上部署（腾讯云 Ubuntu 24.04 + Docker CE；技能 `olua-deploy`）
- **IP / SSH 私钥 / 邀请码 / JWT 密钥一律不进记忆、不进版本库**（用户 2026-10-11 定）：只放根目录 `deploy.env`（gitignore），仓库只提交模板 `deploy.env.example`。服务器上 `server/.env` 由它渲染（也被 `server/.gitignore` 排除）。
- **更新通道是「本地 `git archive` → scp → 解压 → `compose up -d --build`」，不是 `git pull`**：实测该服务器访问 GitHub 不可用（clone 10 分钟无进展、`curl github.com` 000）。服务器上因此**没有 `.git`**，别在上面跑 git 命令。
- **先提交合入 master 再发布**：`git archive HEAD` 只导出**已提交**状态，未提交的改动不会上线且极难发现。
- 顺序不能换：`server/.env` 必须在**解压之后**传（否则 `server/` 还不存在）。`scripts/deploy.sh` 已固化（含 `--verify` / `--env-only` / `--no-build`）。
- 覆盖式解压**不删**服务器上已删的文件；含文件删除的更新要先清空目录（保留 `server/.env` 与 `backup/`）。
- 拓扑：对外只开 :80（管理端 nginx + `/api` 同源反代，故不需 CORS）；服务端 3100 **不映射宿主机**（`docker compose ps` 显示 `3100/tcp` 是正确状态）；**当前不上 HTTPS**。云厂商防火墙只能在控制台开，脚本改不了。
- 完整手册 `docs/deploy.md`；坑位清单 `references/gotchas.md`（含 zsh 不分词、`pkill -f` 自杀、BSD `sed -i ''` 静默失效且回显密钥、`docker info` 因 socket 权限误报未启动等）。

## 待办 → 全部登记为 GitHub issue（见 `#8~#24`）
玩法缺口 = #11~#19；服务端 = #20 邮箱字段 / #21 审计与队列清理 / #22 自动备份；工程 = #8 官网上线 / #9 包体积 / #10 在线 demo / #23 `.DS_Store` / #24 CI 是否覆盖客户端。**用户已定保持现状**：技能 1011 / 快捷键 6 格 / 药品 3 档 / 装备 7 部位。
后续批次：**#117 索引（全局数据单一来源）→ #118 生成物与守卫（已做）→ #119 管理端接入（已做）→ #122 服务端码清单与文案（已做）→ #124 角色上限跨端数值（已做，PR #130）** —— **#117 这条线已收官**；服务端战斗权威：#25 / **#34 伤害结算上移（已做，PR #162）** → **#35 世界权威（已做，PR #164）** → 下一刀 **#36 内部边界治理** → #37 世界权威拆进程（最后）。#34/#35 的取舍与坑见 2026-10-21 日志（castId 幂等 / 死怪不因清账复活 / 播种只在空图采纳 / SIGTERM 双段退出 / [combat-parity] 告警文案必须英文）。
