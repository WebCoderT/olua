# olua 项目长期记忆（精简版）

> 细节见 Skill `olua-server`/`olua-client`/`olua-admin`/`olua-deploy` 与 `cocos-*`；客户端约定主笔记 `PROJECT-NOTES.md`；逐日见 `2026-*.md`（已收官史诗的逐刀细节都在日志里，本文件只留索引与仍生效的约定）。
> **技能与记忆都随仓库提交**（用户 2026-10-11 定）：`.gitignore` 白名单只放 `.workbuddy/memory` 与 `.workbuddy/skills`；改技能/记忆 = 改仓库文件，走 issue + PR。仓库 PUBLIC：**服务器 IP / 私钥 / 邀请码 / JWT 实际值不进记忆不进库**。

## 提交纪律（用户强制）
- 所有提交必须有 issue/PR：开 issue → 认领留痕（谁/哪台机器/分支）→ 分支 `type/n-slug` → 提交（`Closes #n`）→ PR → CI 绿 → squash 合并；docs 也不例外；写日志前先切分支（极易顺手 commit 到 master）。
- 一个 PR = 一个 squash = 一个功能；接口改动连 `openapi.json` + 两端生成物同刀提交；全绿才提交（`make ci`，数字从命令输出实测）。双语文档：中文主体 + 同目录 `X.en.md` 口径全等。
- issue 状态纪律：动手前先查评论/分支/PR（有人在做就不碰）；状态变更即评论；**禁止**「悄悄做完不关 issue」与「issue 开着但已放弃」。
- 多机并行（Windows+Mac）：改动前后都必须 `git fetch` + 同步 master。

## 分支线
- **master = 横屏线 1624×750**；**portrait = 竖屏线 750×1624**（竖屏改动只进 portrait，拆分 #152）。squash 仓库判短线是否已合并用 `git merge-tree --write-tree` 比树；旧提交从 `refs/pull/<n>/head` 取回。

## 工程风险（必读）
- **resources 以远程 Release 为唯一来源（2026-10-26 强制）**：不改远程、不手工补图；不一致就删本地/改代码适配。守点 = `resources_sync.py verify` + `audit-resource-refs`（CI 无素材自动跳过）。
- Cocos 编辑器周期性回写 assets：改完 `sleep 20` 复检；只信 Grep 工具与 `git diff`（BSD grep 不吃 `\|`）；批量替换用 `perl -pi -e`，改完必须 `make client-check`。
- 服务端/子进程 `env -u NODE_OPTIONS`；`curl 127.0.0.1 --noproxy '*'`；起监听端口前先探测占用。
- 打包 babel loose：`[...迭代器]` 恒空 → `Array.from`；飘字走 `GameUiHelper.createTip*`；客户端 tsc 用 `client/tools/tsconfig.check.json`。
- e2e 纪律：先算轮询窗口 vs 过期时间；问**字段有几个写者**，判据用只有目标路径写的字段；**错误断言必须精确匹配文案**（泛判据会被无关路径满足、掩盖功能缺失）；**重试写在被测助手内部**（#396 `killOne` 只取一次世界快照 → CI 上 6 条连环假红）；**带缓存的逻辑 e2e 要把 TTL 压到 0**（#398 `SOCIAL_BLOCK_CACHE_MS=0`，否则测的是缓存不是逻辑）；`EXPECTED_ASSERTIONS` 与条数差一条就会把绿变红。

## 部署要点（细节 Skill `olua-deploy`）
- compose 四服务：admin :80 / game :8080 / server 内网 3100 / server-realtime :3101；`/api` 反代 server 同源，`/api/realtime*` 带 Upgrade 头反代实时进程。
- 密钥只在 gitignore 的 `deploy.env`；更新 = `git archive` → scp → `compose up -d --build`（服务器连不上 GitHub）；**先合并 master 再发布**；Cocos 只能 GUI 打包（~3.1G）；静态站 try_files 必须含 `$uri/`。

## 架构不变量（细节 Skill）
- 游戏数据单一来源：`client/assets/configs` → `gen-shared-data.cjs` → `server/src/shared/game-data.generated.ts`（三端唯一），`audit-shared-data` 锁；装备/药品/物品/怪物/NPC/时装/掉落/skills/statuses/怪AI/任务 均已进快照。
- 服务端权威：伤害 / 掉落 / 经验 / 进度 / 金币一律服务端结算，客户端只演（#396 任务四写入口全在 `QuestService`；#395 聊天转发不存储）。
- 管理端接口必须 `@ApiAdminDoc({permissions})`；角色数据=不透明文档（解析失败必须报错；唯一例外是 `guide` 引导进度：只校验结构与体量，**无字段不补默认值**）；修订号乐观锁 409+20006；`ValidationPipe whitelist` 要 DTO + `@Type` + 登记 `SWAGGER_MODELS`；排序白名单唯一来源 `sort-specs.ts`；受击落账不推 revision（`updateDataKeepRevision`）；进程内起服走 `register({realtime:true})`；JSON 列解析下沉 `common/config-json.ts`；`BizException` 默认 400，404 用 `notFound()`；文本主键表 `findByKey`，seed 用 `INSERT OR IGNORE`。
- DTO / 快照坑：emitDecoratorMetadata 类顺序 TDZ；whitelist 只认校验装饰器；快照标量要包成单行表；nullable `@ApiProperty` 不带 type → admin 模型 unknown。
- 本机 client-test 基线：**43 通过 / 5 失败**（48 套；红全是素材没入库，resources 未铺：`equipment-appearance` / `equipment-detail-background` / `monster-config` / `role-default-cloth` / `role-frames`）；CI 不跑 client-test，门禁以 `make ci` 为准；沙箱型单测跟着真代码 import 改，源码正则断言会因改名而红。

## 主线进度（细节见逐日日志）
- 已收官：服务端战斗权威线 #25~#37 · 管理端收口 epic #259（九张配置表）· 快照覆写扩展 #361/#363 · 客户端对接 epic #293（九刀，PR #296~#384）· 社交线 #387（#388 帮会 / #389 好友敌人）。
- **玩法补全 epic #394（2026-10-27 开线）**：① 聊天 #395 ✓（PR #404，bca0ae5）→ ② 任务 #396 ✓（PR #407，b449455：quests/quest_progress 两表 + accept/submit/npcTalk/onMonsterKilled 四写入口 + 可接态客户端算 + daily 删行可重接 + `quest` 帧只推本人）→ ③ 经济 #397 ✓（PR #410，7c6b869：`POST /roles/:id/sell`，价格只认快照 `SELL_PRICES`、客户端只报「卖什么几件」、同 id 合并、整单结算；一键回收改服务端结算）→ ④ 屏蔽与举报 #398 ✓（PR #413，7a28fe8：`role_blocks`/`role_reports` 两表 + `BlockService` 整表缓存 + 聊天与互见三处服务端过滤 + **不下发 blockedBy** + 举报只落库/管理端只读 + `report:read`）→ ⑤ 组队 #399 ✓（PR #416，4ea3205：`parties`/`party_members` 两表 + 七个动作全走 WS 帧 + 队长退出自动移交 + 同图队友 50% 经验（`expGain` 带 revision）+ 互见帧 `partyId` + 屏蔽优先两种说法；客户端 `RELATION.PARTY` 队友金 + `PartyStore` + 队伍弹窗）→ ⑥ 排行榜 #400 ✓（PR #419，3d92b44：`GET /leaderboards/:board` + `/me`，等级/战力/击杀三榜；排序·名次·截断·裁剪全在服务端；竞赛排名（并列同名次 + roleId 二次键）、离线也上榜、物化在进程内不落库按 `LEADERBOARD_REFRESH_MS` 整份换引用、定时器首次有人看榜才起；`me` 在全量排序里算名次（榜外也真实，无活跃角色 rank=0）；条目八字段不带 accountId/data/在线状态；击杀数 = `roles.kills` 索引列，服务端 +1 且不推 revision；客户端 `LeaderboardStore` 并发拉 page+me、切页就重拉、入口挂小地图现成图）→ ⑦ 新手引导 #402 ✓（PR #422，755c5e6：进度存角色存档 `role.guide = { step, done, skipped }`，**不新开表**（无奖励无结算，换设备/重连自然续走）；服务端只校验结构与体量（`step` 为 0~64 的整数、两标记为布尔、多余字段丢弃），**没有字段就不补默认值**（客户端靠「有没有 guide」分老号/新号）；推进靠六个事件（move/kill/pickup/openBag/openSkill/openChat）且**只有当前步命中才前进**、不越级；移动按 `Vec3.distance` 累计 260 判定；遮罩不拦点击不锁移动、只有跳过按钮是按钮；高亮用语义位 `GUIDE_SPOT` 由组合根换真实节点（取不到退化为只有气泡）；四块矩形挖洞（两对角点算宽高）+ 气泡贴边夹取；`skipped` 是显式选择、与走完两句不同飘字；落盘走 `updateOnlineRole` 不开旁路）→ ⑧ 成就 #401 ✓（PR #425，60cc742：`achievements`/`role_achievements` 两表 + **条件分两类**（累计型 `kill`/`quest` 事件记账落 progress、状态型 `level`/`combat`/`collect` **不落进度查询现算**）+ 击杀采集点收成 `GameEventsService`（`@Global`，同步分发 + 订阅方异常隔离，结算只 emit）+ **达成与领取分离**（`achieved_at` 可领 / `claimed_at` 已领、不自动发奖、背包满 20012 不消耗资格、状态型 achieved_at 领取时补写、GET 不写库）+ 生成期与管理端两道引用校验 + 有记录拒删 + 客户端 `AchievementStore`/三分类面板挂小地图现成入口）→ 剩余 #403 帮会战。
- 其他 open：#8 官网 / #9 包体积 3.1G 治理 / #12~#19 玩法素材 / #295 阶段三（管理端区服页）。用户已定保持现状：技能 1011 / 快捷键 6 格 / 药品 3 档 / 装备 7 部位。
- **数字基线（#401 后）**：**149 接口 / 123 路径 / 227 模型 / 25 权限点 / 42 表 / 34 仓储**；e2e **2209（二十一套）**；客户端单测 **49 套**；回归守卫 60；11 项审计（脚本 12 个）。
