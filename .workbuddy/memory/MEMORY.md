# olua 项目长期记忆（精简版）

> 细节见 Skill `olua-server`/`olua-client`/`olua-admin`/`olua-deploy` 与 `cocos-*`；客户端约定主笔记 `PROJECT-NOTES.md`；逐日见 `2026-*.md`（已完成 epic 的逐刀细节都在日志里，本文件只留索引与仍生效的约定）。
> **技能与记忆都随仓库提交**（用户 2026-10-11 定）：`.gitignore` 白名单只放 `.workbuddy/memory` 与 `.workbuddy/skills`；改技能/记忆 = 改仓库文件，走 issue + PR。仓库 PUBLIC：**服务器 IP / 私钥 / 邀请码 / JWT 实际值不进记忆不进库**。

## 提交纪律（用户强制）
- 所有提交必须有 issue/PR：开 issue → 认领留痕（谁/哪台机器/分支）→ 分支 `type/n-slug` → 提交（`Closes #n`）→ PR → CI 绿 → squash 合并；docs 也不例外；写日志前先切分支（极易顺手 commit 到 master）。多机并行（Windows+Mac）：改动前后都必须 `git fetch` + 同步 master。
- 一个 PR = 一个 squash = 一个功能；接口改动连 `openapi.json` + 两端生成物同刀提交；全绿才提交（`make ci`，数字从命令输出实测别记死）。双语文档：中文主体 + 同目录 `X.en.md` 口径全等。
- issue 状态纪律：动手前先查评论/分支/PR（有人在做就不碰）；状态变更即评论；**禁止**「悄悄做完不关 issue」与「issue 开着但已放弃」。

## 分支线
- **master = 横屏线 1624×750**；**portrait = 竖屏线 750×1624**（竖屏改动只进 portrait，拆分 #152）。squash 仓库判短线是否已合并用 `git merge-tree --write-tree` 比树；旧提交从 `refs/pull/<n>/head` 取回。

## 工程风险（必读）
- **resources 以远程 Release 为唯一来源（2026-10-26 强制）**：不改远程、不手工补图；不一致就删本地/改代码适配。守点 = `resources_sync.py verify` + `audit-resource-refs`（CI 无素材自动跳过）。
- Cocos 编辑器周期性回写 assets：改完 `sleep 20` 复检；只信 Grep 工具与 `git diff`（BSD grep 不吃 `\|`、shell grep 输出串扰）。批量替换用 `perl -pi -e`，改完必须 `make client-check`。
- 服务端/子进程 `env -u NODE_OPTIONS`；`curl 127.0.0.1 --noproxy '*'`；起监听端口前先探测占用，冲突换端口。
- 打包 babel loose：`[...迭代器]` 恒空 → `Array.from`；飘字走 `GameUiHelper.createTip*`；客户端 tsc 用 `client/tools/tsconfig.check.json`；一次性产出大量中文会混入意外英文串。
- e2e「轮询+精确值」：先算窗口 vs 轮询间隔；问**字段有几个写者**，判据用只有目标路径写的字段；**错误断言必须精确匹配文案**——泛判据（`errors.length > 0`）会被无关路径满足、掩盖功能缺失（#395 离线拒绝假阳性教训）。

## 部署要点（细节 Skill `olua-deploy`）
- compose 四服务：admin :80 / game :8080 / server 内网 3100 / server-realtime :3101；`/api` 反代 server 同源，`/api/realtime*` 带 Upgrade 头反代实时进程。
- 密钥只在 gitignore 的 `deploy.env`；更新 = `git archive` → scp → `compose up -d --build`（服务器连不上 GitHub）；**先合并 master 再发布**；Cocos 只能 GUI 打包（~3.1G）；静态站 try_files 必须含 `$uri/`。

## 架构现状（细节 Skill）
- 游戏数据单一来源：`client/assets/configs` → `gen-shared-data.cjs` → `server/src/shared/game-data.generated.ts`（三端唯一），`audit-shared-data` 锁；装备/药品/物品/怪物/NPC/时装/掉落/skills/statuses/怪 AI 参数均已进快照。跨端数值（#124）：客户端站位=容量天花板，服务端 `ROLE_MAX_PER_ACCOUNT` 只降不升。
- 关键不变量：管理端接口必须 `@ApiAdminDoc({permissions})`；角色数据=不透明文档（编辑解析失败必须报错）；修订号乐观锁 409+20006；`ValidationPipe whitelist` 要 DTO + `@Type` + 登记 `SWAGGER_MODELS`；排序白名单唯一来源 `sort-specs.ts`；受击落账不推 revision（须 `updateDataKeepRevision`）；进程内起服走 `register({realtime:true})`；JSON 列解析下沉 `common/config-json.ts`；BizException 默认 400，404 用 `BizException.notFound()`；文本主键表用 findByKey，seed 用 INSERT OR IGNORE；DTO 坑：emitDecoratorMetadata 类顺序 TDZ、whitelist 只认校验装饰器、快照标量包成单行表、nullable @ApiProperty 不带 type → admin 模型 unknown。
- 本机 client-test 基线：39 通过 / 5 失败（红全是素材没入库，本机未铺 resources）；CI 不跑 client-test，门禁以 `make ci` 为准；沙箱型单测必须跟着真代码 import 一起改，源码正则断言会因变量改名而红。

## 主线进度（已完成，细节见逐日日志）
- **服务端战斗权威线收官**（#25~#37：伤害/世界权威/边界审计/拆进程 :3101）；**管理端收口 epic #259 全完**（2026-10-25，成长曲线/军衔/装备/药品/物品/怪物NPC/商城/时装/掉落九张配置表页）；**快照覆写扩展全完**（#361/#363：只覆写管理端能改的字段，资源路径/几何/AI 参数保留本地）；**客户端对接 epic #293 全关**（①配置下发 ②成长 ③商城 ④药品 ⑤掉落+经验 ⑥时装 + ⑦怪AI ⑧互见 ⑧b真外观 ⑨拾取权威，PR #296~#384）；**区服模型 epic #295 阶段一/二完**（PR #300/#312），剩阶段三管理端区服管理页；**技能/状态表化 #367 + 怪物挂载技能 #372 完**（`monster_skills` 挂载表、casts 帧不带伤害、状态在服务端生效）；**社交线 #387 全关**（#388 帮会三表 + #389 好友镜像两行/敌人单向行，关系判定客户端 `resolveRelation` 唯一入口、SocialStore 快照唯一来源）。
- **玩法补全 epic #394（2026-10-27 开线）**：① **聊天 #395 ✓（PR #404，master bca0ae5）**：realtime `chat` 帧**转发不存储**；三频道 = 世界**同图广播**（复用 viewersOf）/ 帮会**准入每次查库**（不用 5s 懒刷新缓存）/ 私聊定向且**离线整条拒绝**（`isConnected` 回调）；**回显即成功**（发送侧不本地追加，`ChatStore.applyEntry` 唯一落点，弹窗/气泡/角标三消费者订阅）；限频滑窗通过才计数、断线清窗；ChatStore 不 import cc。**坑**：e2e `waitFor` 空档超过 `MONSTER_AI_POS_STALE_MS`（默认 3s）会清在场条目→「还没进入世界」静默失效，测试须调大该值。剩余：#396 任务 → #397 经济出口 → #398 屏蔽 → #399 组队 → #400 排行 → #402 引导 → #401 成就 → #403 帮会战（远期）。
- 其他 open：#8 官网 / #9 包体积 3.1G 治理 / #12~#19 玩法素材。用户已定保持现状：技能 1011 / 快捷键 6 格 / 药品 3 档 / 装备 7 部位。
- **数字基线（#395 后）**：128 接口 / 106 路径 / 183 模型 / 24 权限点 / 34 表 / 28 仓储；e2e **1906（十五套）**；客户端单测 **45 套**；回归守卫 56；11 审计。
