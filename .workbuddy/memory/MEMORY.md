# olua 项目长期记忆（精简版）

> 细节见 Skill `olua-server`/`olua-client`/`olua-admin`/`olua-deploy` 与 `cocos-*`；客户端约定主笔记 `PROJECT-NOTES.md`；逐日见 `2026-*.md`（9 月两份旧日志已蒸馏进本文件后删除，见 #181）。
>
> **技能与记忆都随仓库提交**（用户 2026-10-11 定）：`.gitignore` 白名单只放 `.workbuddy/memory` 与 `.workbuddy/skills`；改技能/记忆 = 改仓库文件，按提交纪律走 issue + PR。仓库 PUBLIC：**服务器 IP / 私钥 / 邀请码 / JWT 实际值不进记忆不进库**。

## 提交纪律（用户强制，2026-10-10 定）
- 所有提交必须有 issue/PR：开 issue → 分支 `type/n-slug` → 提交（`Closes/Refs #n`）→ PR → CI 绿 → squash 合并；master 不允许无追踪提交（docs 也不例外）。
- **一个 PR = 一个 squash = 一个功能**；一个 issue 含多功能先拆小 issue。格式 `feat|fix|docs|…(端): 一句话`；改接口必须连 `openapi.json` + 两端生成物一起提交。
- 全绿才提交：`make verify`（客户端 tsc + 全套单测（套数别记死，README 为准）/ 服务端十套 e2e / 管理端 build / 10 审计）。**别记死数字**，从命令输出实测。
- **改动前后必须拉取（用户强制，2026-10-24 定）**：每次改代码前先 `git fetch` + 同步 master（落后就 `git pull --ff-only`，工作分支定期 rebase/merge origin/master）；改完合并/推送后再拉一次确认本地 master = origin/master。多机并行开发（Windows + Mac），这条是硬性规则。
- 双语文档：中文主体 + 同目录 `X.en.md`，口径全等（索引 #45）。

## 分支线（2026-10-20 定）
- **master = 横屏线 1624×750**（回退竖屏前 `478e658`）；**portrait = 竖屏线 750×1624**（登录/选角重排 + 单角色 + 本机账号）。竖屏改动只进 portrait。拆分记录 #152；差异约 63 文件（`git diff --stat master portrait`）；对外说明在根 README「分支」节。
- squash 仓库判短线是否已合并要用 `git merge-tree --write-tree` 比树（`git branch --merged` 判不出）；旧提交可从 `refs/pull/<n>/head` 取回。

## 工程风险（必读）
- **Cocos 编辑器周期性回写 assets**：改完 Read/Grep 核对 + `sleep 20` 复检，一次通过不代表稳定；shell grep 输出会串扰且 BSD grep 不支持 `\|` → 只信 Grep 工具与 `git diff`。
- 服务端/子进程 `env -u NODE_OPTIONS`；`curl 127.0.0.1 --noproxy '*'`；起监听端口进程前先探测是否被用户常驻实例占用，冲突换端口。
- 打包 babel loose：`[...迭代器]` 恒空 → `Array.from`/`forEach`；`isValid` 要叠数据判据；飘字走 `GameUiHelper.createTip*`；素材扩展名=真实格式；`resources/` 不入库删前备份；客户端 tsc 用 `client/tools/tsconfig.check.json`。
- 一次性产出大量中文会混乱码，落盘前扫非预期英文串。
- e2e「轮询+精确值」：先算窗口 vs 轮询间隔；再问**字段有几个写者**（#110 `lastAttemptAt` 双写者教训），判据用只有目标路径写的字段。

## 部署要点（细节 Skill `olua-deploy`）
- compose 四服务：admin :80 / game :8080 / server 内网 3100 / server-realtime :3101；game/admin 把 `/api` 反代 server:3100 同源，`/api/realtime*` 带 Upgrade 头反代实时进程。
- 密钥只在 gitignore 的 `deploy.env`；更新通道 = `git archive` → scp → 解压 → `compose up -d --build`（服务器连不上 GitHub、无 `.git`）；**先合并 master 再发布**；`server/.env` 解压后传。
- 静态站 try_files 必须含 `$uri/`（audit-deploy 守）；Cocos 只能 GUI 打包（产物 ~3.1G）。

## 架构现状（细节 Skill）
- 游戏数据单一来源：`client/assets/configs` → `gen-shared-data.cjs` → `server/src/shared/game-data.generated.ts`（三端唯一，管理端直接 import），`audit-shared-data` 锁；掉落/时装未进。跨端数值（#124）：客户端站位=容量天花板，服务端 `ROLE_MAX_PER_ACCOUNT`=业务上限只降不升。
- **服务端战斗权威线已收官**（#25/#34/#35/#36/#37 全关）：伤害结算 / 世界权威（播种只在空图、结算落世界、tick 重生、重启恢复）/ 边界审计 `audit-server-boundaries`（deny-by-default 白名单）/ 拆进程（`AppModule.register({realtime})` + `main.realtime.ts` :3101 + 踢下线巡检轮询 `online_role_id`）；e2e-dual 14 条，共十套 994 条。进程内起服要走 `register({realtime:true})`。
- 关键不变量：管理端接口必须 `@ApiAdminDoc({permissions})`；接口文件 `make gen-api`；角色数据=不透明文档（编辑解析失败必须报错）；修订号乐观锁 409+20006；`ValidationPipe whitelist` 要 DTO + `@Type` + 登记 `SWAGGER_MODELS`；公告已读走独立 `AnnouncementReadStore`；排序白名单唯一来源 `sort-specs.ts`。

## 剩余 open（2026-10-23）
#8 官网 / #9 包体积 3.1G 治理（解锁 #10 Demo）/ #12~#19 玩法素材（#14 待用户确认解冻）。用户已定保持现状：技能 1011 / 快捷键 6 格 / 药品 3 档 / 装备 7 部位。
