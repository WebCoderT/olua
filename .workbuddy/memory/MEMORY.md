# olua 项目长期记忆（精简版）

> 细节见 Skill `olua-server`/`olua-client`/`olua-admin`/`olua-deploy` 与 `cocos-*`；客户端约定主笔记 `PROJECT-NOTES.md`；逐日见 `2026-*.md`（9 月两份旧日志已蒸馏进本文件后删除，见 #181）。
>
> **技能与记忆都随仓库提交**（用户 2026-10-11 定）：`.gitignore` 白名单只放 `.workbuddy/memory` 与 `.workbuddy/skills`；改技能/记忆 = 改仓库文件，按提交纪律走 issue + PR。仓库 PUBLIC：**服务器 IP / 私钥 / 邀请码 / JWT 实际值不进记忆不进库**。

## 提交纪律（用户强制，2026-10-10 定）
- 所有提交必须有 issue/PR：开 issue → 分支 `type/n-slug` → 提交（`Closes/Refs #n`）→ PR → CI 绿 → squash 合并；master 不允许无追踪提交（docs 也不例外）。
  - ⚠️ 实操教训（2026-10-25 犯了两次）：写日志后**极易顺手在 master 上 commit+push**。写日志前先切到功能分支或单独 docs 分支；若已在 master 上提交，立即 `git push origin <hash>:refs/heads/docs/...` → 回退 master（force）→ 补 PR。
- **一个 PR = 一个 squash = 一个功能**；一个 issue 含多功能先拆小 issue。格式 `feat|fix|docs|…(端): 一句话`；改接口必须连 `openapi.json` + 两端生成物一起提交。
- 全绿才提交：`make verify`（客户端 tsc + 全套单测（套数别记死，README 为准）/ 服务端十套 e2e / 管理端 build / 10 审计）。**别记死数字**，从命令输出实测。
- **改动前后必须拉取（用户强制，2026-10-24 定）**：每次改代码前先 `git fetch` + 同步 master（落后就 `git pull --ff-only`，工作分支定期 rebase/merge origin/master）；改完合并/推送后再拉一次确认本地 master = origin/master。多机并行开发（Windows + Mac），这条是硬性规则。
- **issue 状态纪律（用户强制，2026-10-26 定）——防止一个问题多人改动**：多机（Windows + Mac）/多人并行时，「issue 开着但没人知道谁在做」比没 issue 更糟。所以：
  1. **动手前先查状态**：接手任何 issue 前先看它的评论 / 关联分支 / 关联 PR——已有人认领在做就**不碰**，去问或另开一刀；
  2. **认领即留痕**：决定做某个 issue，建分支后**立刻在 issue 上评论**（谁 / 哪台机器 / 分支名），让另一端看得见「这个正在被做」；
  3. **状态变更即评论**：暂停 / 放弃 / 转交都要在 issue 上说明，**不许让 issue 挂着假装还在做**；
  4. **收尾自动关**：PR 描述写 `Closes #n`，合并即关；不写 Closes 的合并后手动关；
  5. **处理任何问题必须先有 issue**（哪怕一行小改），不开 issue 的改动 master 不收。禁止两种坏状态：悄悄做完不关 issue；issue 开着但实际已放弃。
- 双语文档：中文主体 + 同目录 `X.en.md`，口径全等（索引 #45）。

## 分支线（2026-10-20 定）
- **master = 横屏线 1624×750**（回退竖屏前 `478e658`）；**portrait = 竖屏线 750×1624**（登录/选角重排 + 单角色 + 本机账号）。竖屏改动只进 portrait。拆分记录 #152；差异约 63 文件（`git diff --stat master portrait`）；对外说明在根 README「分支」节。
- squash 仓库判短线是否已合并要用 `git merge-tree --write-tree` 比树（`git branch --merged` 判不出）；旧提交可从 `refs/pull/<n>/head` 取回。

## 工程风险（必读）
- **resources 以远程 Release 为唯一来源（用户 2026-10-26 强制）**：不改远程、不发新包、不手工补图；本地与清单不一致就「删本地多余文件 / 改代码适配」。素材一致性守点 = `resources_sync.py verify`（14017 文件 / version=2026-10-25-1）+ `audit-resource-refs`（11 套审计之一，CI 无素材自动跳过）。
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
- 游戏数据单一来源：`client/assets/configs` → `gen-shared-data.cjs` → `server/src/shared/game-data.generated.ts`（三端唯一，管理端直接 import），`audit-shared-data` 锁；掉落（#254）与时装（#257）已进快照。跨端数值（#124）：客户端站位=容量天花板，服务端 `ROLE_MAX_PER_ACCOUNT`=业务上限只降不升。
- **服务端战斗权威线已收官**（#25/#34/#35/#36/#37 全关）：伤害结算 / 世界权威（播种只在空图、结算落世界、tick 重生、重启恢复）/ 边界审计 `audit-server-boundaries`（deny-by-default 白名单）/ 拆进程（`AppModule.register({realtime})` + `main.realtime.ts` :3101 + 踢下线巡检轮询 `online_role_id`）；e2e-dual 14 条，共十套 994 条。进程内起服要走 `register({realtime:true})`。
- 关键不变量：管理端接口必须 `@ApiAdminDoc({permissions})`；接口文件 `make gen-api`；角色数据=不透明文档（编辑解析失败必须报错）；修订号乐观锁 409+20006；`ValidationPipe whitelist` 要 DTO + `@Type` + 登记 `SWAGGER_MODELS`；公告已读走独立 `AnnouncementReadStore`；排序白名单唯一来源 `sort-specs.ts`。

## 剩余 open（2026-10-26）
- **世界服务端控制（epic #295）**：阶段一 刷怪区表 + 世界播种读表 ✓（PR #300）→ 阶段二 区服模型（多开区/合并区：zones + world_meta epoch + 世界按区隔离 + 合并事务）✓（PR #312）→ 阶段三起：管理端区服管理页（拆后续 issue）。合并瞬间未落盘伤害丢弃是文档化取舍（epoch 作废不落盘）。
- **客户端对接（epic #293，2026-10-26 开线）**：拆刀 ①配置下发通道+运行时配置层 ✓（#294，PR #296 服务端 + #297 客户端）→ ②成长线升级收权 ✓（#248/#249 关闭 + #250 一并，PR #301）→ ③商城购买收权 ✓（#304，PR #305）→ ④药品用药收权 ✓（#308，PR #309）→ ⑤掉落+经验结算收权 ✓（#316，PR #320，master = 9dc765b；settle 帧 reward，经验/升级服务端落账，掉落读库抽取，客户端只演不掷）→ ⑥时装穿戴系统（新玩法，**唯一剩余项**，未开）。**快照覆写扩展 ✓ 全部完成**（#361 数值底座 PR #362：曲线整条替换 + 重建 levelMap + 经验表压轴；#363 内容表 PR #364：装备按基础件重算 555 变体、药品四值合并、物品/NPC/时装改文案价签；**只覆写管理端能改的字段，资源路径/几何/AI 参数一律保留本地**，master = e7e3e94）。
- **多人同步线（epic #293 拆刀 7-9）**：⑦怪物 AI 收权 ✓（#323，PR #335：MonsterAiService 状态机 + pos/monster-ai 帧 + 受击落账不推 revision【replace() SQL 硬编码 revision+1，须用 updateDataKeepRevision】+ AI 参数进共享快照 MONSTER_AI）→ ⑧玩家互见 ✓（#324，PR #338：PlayerPresenceService 在场表 = pos 帧镜像、players 帧三件套、换图显式 left、客户端 OtherPlayerManager 纯演出）→ ⑨掉落归属与拾取权威 ✓（#325，PR #358，master = e74d443：**拾取走 realtime pick 帧**——账本在实时进程内存，HTTP 拿不到；dropLedgers 按账号+castId 记 drops，标记已拾放**入包成功之后**；RolesService.pickDrop 叠加语义，整份放不下 20012 且存档不动；客户端节点留地面等 picked 应答）。已知边界：状态数值（格挡）不参与怪物伤害；玩家位置服务端不权威；掉落不跨会话持久、不做竞拾。当前数字：103 接口 / 88 路径 / 163 模型 / 28 张表 / 25 仓储 / e2e 1697（十二套，战斗套 102 · 养成配置 599）。
- **技能/状态表化 ✓（#367，PR #368，master = 8ea2e33）**：`skills` / `statuses` 两表 + `owner` 分流（角色与怪物同构，分表必漂移）；只有 list/update；释放限制 `castLockMs`（直通 RoleDisplay 兜底超时）+ `requireTarget`；跨字段约束 `assertSkillConsistency` **只在动了 category/damageCoefficients/statusId 时校验**（1008 是「主动但倍率空」的历史行）；快照下发 skills/statuses，客户端按 owner 分流覆写 + `rebuildSkills()`；`skillStatusMap`/`applyStatusOfSkill` 已废除。管理端技能页 / 状态页。**下一刀 = #12 主体**：怪物技能可增删（同表 owner=monster）+ 服务端 AI 释放 + 怪物侧特效验证。
- 管理端收口（epic #259）**全部完成（2026-10-25）**：#256 成长曲线 ✓（PR #263）→ #250 军衔 ✓（PR #265）→ #252 装备 ✓（PR #267）→ #253 药品 ✓（PR #271）→ #255 物品材料 ✓（PR #272）→ #258 怪物NPC ✓（PR #275）→ #251 商城定价 ✓（PR #278）→ #257 时装 ✓（PR #282）→ #254 掉落表 ✓（PR #285）。
- #254 新增：掉落两表两种纪律——drop_tables 允许动态增删（被 monster_drops 引用中的行拒删）、monster_drops 与怪物一一对应（PATCH 整份替换三选一 table/entries/none）；picks/entries JSON 列结构校验下沉 service（DTO 只认键）；每怪排序 CAST(monster_key AS INTEGER)；POST 默认 201、DELETE 无 data 用 @ApiVoidResponse；**掉落/经验结算仍在客户端，服务端结算权威切换与客户端对接同刀**。
- #258 新增：怪物战斗数值**读库**（世界播种+伤害结算直读 monsters 表，双进程共享 SQLite/WAL，改值即时生效）；npc 数据与行为分家（configs/npc-data.ts 纯数据 + npc.ts 接线，生成器加载 UI 链会炸）。DTO 踩坑：emitDecoratorMetadata 类顺序 TDZ（被引用类必须先声明）；whitelist 只认校验装饰器（嵌套属性只挂 @ApiProperty 会被剥掉）。
- #251 新增：商城定价 = 目录在生成物（555 件装备变体）+ DB 只存价格层（mall_prices 动态增删 + mall_settings 单行）；BizException 默认 400，404 必须 `BizException.notFound()`；快照标量要包成单行表（裸标量被判空表）；nullable @ApiProperty 不带 type → admin 模型 unknown。
- #257 新增：fashionClothes 整份注释直接重写为纯数据文件（零消费无需保形状）；快照 attributes 缺省要 `pickAttributes(x ?? {})`（undefined 返回 null）；perl 批量替换中文全角括号形态要去 \b；复用 title.dto 属性形状时行结构同构即可直接共用 attributesFromRow/attributeColumns。
- 配置表 issue 模板已稳定（#252/#253/#255 三连）：生成器 pick+render+audit → 三件套 → DTO/service/controller → e2e region → admin 页 → 文档 perl 批量替换 → make ci → PR；文本主键（id）表用 findByKey，seed 用 INSERT OR IGNORE。
- 其他：#8 官网 / #9 包体积 3.1G 治理（解锁 #10 Demo）/ #12~#19 玩法素材（#14 待用户确认解冻）。用户已定保持现状：技能 1011 / 快捷键 6 格 / 药品 3 档 / 装备 7 部位。
- 本机 make client-test 有 2 套常红（test-action-atlas / test-equipment-light，resources/ 未入库素材缺失），CI 不跑 client-test，门禁以 `make ci` 为准（2026-10-25 确认）。
