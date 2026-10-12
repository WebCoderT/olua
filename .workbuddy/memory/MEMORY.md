# olua 项目长期记忆

> 细节见 Skill `olua-server`/`olua-client`/`olua-admin`/`olua-deploy`；Cocos 坑见 `cocos-*`；逐日见 `.workbuddy/memory/2026-*.md`。
>
> **技能与记忆都随仓库提交**（用户 2026-10-11 定）：技能在项目级 `.workbuddy/skills/`（22 个，仅 `github` 留用户级），记忆在 `.workbuddy/memory/`；`.gitignore` 用白名单只放开这两个目录，`backup/` 等临时产物仍忽略。改技能/记忆同样是**改动仓库文件**，要按提交纪律走 issue + PR。仓库是 PUBLIC，**写记忆时不得落入服务器 IP / 私钥 / 邀请码 / JWT 密钥实际值**。

## 提交纪律（用户强制）
- **所有代码提交都必须有对应的 issue / PR，必须有记录**（用户 2026-10-10 定）：master 上不允许存在没有 issue 追踪的提交。流程 = 开 issue → 开分支（`git checkout -b <type>/<n>-<slug>`）→ 提交（正文带 `Closes #n` / `Refs #n`）→ 推分支开 PR → CI 绿 → squash 合并。**任何直接落在 master 上的提交都算违规**（文档 typo 也不例外，走 docs PR）。
- **一个功能一次提交**，不留混合改动；全绿才提交（`make verify` = 客户端 tsc + 25 单测 / 服务端五套 e2e / 管理端 build / 7 审计；CI 只跑 `make ci`）。
- **中英双语文档**：中文是主体，英文平铺在同目录成 `X.en.md`（README / FAQ 各一份），两份顶部各一行语言互链；索引 issue **#45**，子 issue #39 守卫 / #40 根 / #41 client / #42 admin / #43 server / #44 equip-aligner。译本 = 不改口径（章节数 / 表格行 / ✅❌ 数 / 数字 multiset 全等），术语表见 #45。
- **一个 PR = 一个 squash = 一个功能**（分支上攒了两件，就拆成两个分支各开 PR，`git rebase --autostash master` 接最新基）。
- 格式 `feat|fix|refactor|docs|test|chore(端): 一句话`；改接口必须连 `openapi.json` + 两端生成物一起提交。
- **一个 issue 含多个功能 → 先拆成多个小 issue 再做**（用户 2026-10-10 定）；大 issue 降级为只管顺序与取舍的索引，能动的工作都在子 issue 里。

## 仓库形态
根 = README/FAQ + 跨端 `tools/` + `Makefile`（命令入口，统一 `env -u NODE_OPTIONS`）。`client/` 是 Cocos 工程本体，脚本住 `client/tools/`；审计在根 `tools/audit-*.cjs`（`make audit` 自动发现）。

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
- 唯一来源还多两条线：**战斗规则** `gen-battle-rules.cjs` 把 `client/assets/configs` 快照成 `server/src/modules/combat/battle-rules.generated.ts`（`audit-battle-rules` 逐字节比对，防**数据**漂移）；**角色属性** `server/src/modules/combat/role-attributes.ts` 由 `audit-combat-parity` 锁住一致性（防**算法**漂移 —— 它把真的 `GameHelper.combatCalc` 编译进 Node 当期望值，不是再抄一版口径）。三张等级表的键 = 来源数组下标，客户端等级从 1 起，**差一位**。包裹 `{code,message,data,timestamp}`，0 成功；`silent` 不弹全局提示。
- 权限两层守卫；**加管理端接口必须 `@ApiAdminDoc({permissions})`**（漏 = 真放行）；业务代码禁写角色判断。
- 接口文件必须 `make gen-api` 生成（新模块登记 `MODULES`）；**别记死数字**：生成物 / 权限点 / 表数随时从 `openapi.json` 实测。
- CI 不覆盖客户端（要编辑器产物）；10 套单测断言真实素材 → 客户端门禁是本地专属。
- **e2e 里「轮询 + 精确值」的断言**：先算被观测状态能停多久，窗口 < 轮询间隔 = 必现 flake（本机恒绿/CI 偶红）。修法＝拉宽窗口，不是放宽断言；本地证伪＝在 predicate 里注入延迟模拟慢机器。
- 公告：`announcements` 表 → 免令牌 `GET /announcements/active` → 客户端登录页弹窗 + 公告板；已读进独立 `AnnouncementReadStore`（**不混进 StorageManager**，否则触发角色同步）。登录/选角场景没有 UILayer，弹窗挂调用方给的节点。
- 排序白名单唯一来源 `server/src/database/sort-specs.ts`。
- 角色数据 = 不透明文档：读容错、**编辑解析失败必须报错**（空对象兜底 = 清背包）；`updateOnlineRole` 是落盘与同步唯一出口。
- 修订号乐观锁：+1 写在 SQL 里，对不上 → 409+20006；自愈四支 `onSaved`/`onConflict`/`onMissing`/`onKicked`。
- `ValidationPipe({whitelist:true})` 剥嵌套裸对象属性 → DTO 类 + `@ValidateNested` + `@Type` + 登记 `SWAGGER_MODELS`。

## 服务端战斗权威化（#25：server-authoritative / 先单进程 / 暂不同步他人）
- 单一来源链路：`gen-battle-rules.cjs` 编译 `client/assets/configs` → `server/src/modules/combat/battle-rules.generated.ts`；`audit-battle-rules.cjs` 重生成后逐字节比对。已纳入：等级 60 / 权重 7 / 战魂 37 / 称号 34 / 军衔 100 / **装备 555 件**（37 件基础件，不是 7807）。
- 装备取舍 = **全量快照**：不让服务端现算 `round(基础值×前后缀倍率)`（那等于把进位口径复制出去）；`role.equipments` 存的本来就是展开后的物品 id。
- 未进链路：**技能**（数值与实现耦合，`skill.ts` import 了运行时实现）、**怪物**（与服务端持有刷怪实例是同一件事）。

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
