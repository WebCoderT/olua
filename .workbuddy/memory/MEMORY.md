# olua 长期记忆（索引）

> **入口分工**：跨域硬纪律 → 本文件；按域查坑（433 条）→ `memory/topics/踩坑速查.md`；
> 「这事做过没有」→ `memory/topics/进度年表.md`（450 条）；展开做法 → `.workbuddy/skills/`；
> 系统全貌与重构设计 → `docs/21~36`。
> 2026-11-08 起**不再写日报**（31 篇日报已蒸馏成上面两篇后删除，正文在 git 历史里）。

**纪律**：issue → 分支 `type/n-slug` → PR（「关联 #n」）→ 本地 `make test-changed` → CI 绿 → squash → 手动 `gh issue close`（正文写「关联」不写 `Closes`）。
仓库 PUBLIC —— 密钥 / IP / 邀请码不进记忆。**website/ 永不改动**。docs-only 用户口头「更新」可直接推 master。
本机待办 `TODO-FOR-USER.md`（gitignore）。`gh issue/pr` 长正文一律 `--body-file`（内联反引号被 zsh 吞）。

## 过程纪律
- **新开 issue 至少一个 `功能:` 标签**：29 个功能域边界见 `docs/38`。三条规则：最多 3 个（超了该拆）·
  `docs(memory)` 归档跟着**被归档的功能线**打 · 与技术栈标签正交。判据：「所有配置表都受益」→ `功能:配置管理`。
- **现状 ≠ 正确，issue 正文也不是事实**：先按它指的行号实测 `server/src` + `admin/src` 再谈改法；范围要收窄就
  在 issue 里写明并改验收，不许默默只做一半。
- **反证前确认 build 真过了**：`npm run build 2>&1 | tail -N && 跑测试` 的退出码来自 `tail`，编译失败也照样往下跑
  → 反证跑在旧 `dist` 上、看着全绿。不加管道或 `set -o pipefail`。
- **待决定项实时问**（AskUserQuestion，一轮 1~4 个），不许攒成文档的「待确认的 N 个点」让用户自己翻。
- **文档里禁止写「不做」**：一律「**暂时放置** + 重开条件」；「已定」只标用户亲口拍过的，自己的取舍标「待定」并去问。
- **用户说「我自己细化 / 我在改」→ 改完本地就停**：不 push、不盯 CI、不合并，除非他明说。
- **测试锁「字段格式 + 行为」不锁数值**（运营随时改数）；**显示效果不写断言**（位置/尺寸/帧率/对齐人眼看）。
- **e2e 五条**：期望值从快照算 · 播种放 `startServer()` 之后 · `checkEqual` 是 `===` · 改 `server/src` 先
  `npm run build`（跑 `dist/`）· 本机绿 ≠ CI 绿。`e2e-quest` 成功静默，判绿只看 exit code。
- **假绿 > 漏检**：扫描器断言模块数、错误精确匹配文案、缓存 TTL 压 0 —— 这类「看着绿」比漏检更危险；
  **完整性**（有没有东西没登记）只能靠遍历全表查，正确性审计查不出来。
- **新增一张表登记五处**：`config-tables.cjs` 两份清单 · `gen-api.cjs` MODULES · `audit-server-boundaries`
  REPO_EDGES · `audit-target.decorator` 类型。**横切服务（如 `event-log`）再加 `ALLOWED_EDGES`**（它只在
  `make audit` 里，`npm run verify` 不跑）。controller `description` 别贴 `/admin/xxx` 字面量。
  同毫秒多行的排序兜底键用 `rowid` 不用随机 uuid。**快照加段 = DTO / `snapshot()` / 客户端区 0 三处 +
  `configs-sandbox` 三处 + `audit-snapshot-contract`**（漏一处 = 几十套客户端单测齐炸）。
- **新增一列登记三处**：`CREATE TABLE` · `ensureColumn` · 仓储的**写入列清单**（漏最后一项 = `update()`
  **静默不写**：PATCH 200、库里没变、结算一分不动）。再往下才是 DTO + `from()` + 客户端 types。
- **新道具表必须让 `sellPriceOf` / `itemLabelOf` / `itemTypeOf` 都认识**，否则回收价与解析静默失效。
- **config-sync.sql 加表**：只拼新增表的节 + 手改表头三行（整份重导有几千行假 diff）；`cp` 库前
  `PRAGMA wal_checkpoint(TRUNCATE)`；校验用「同 schema 库副本」；用户正改表时别整份 export。
- **改 DTO 连描述都算改契约** → `swagger:emit` + `gen-api`；Response DTO 不在 `swagger/models.ts` 登记就不进 openapi。
- **一份数据一个来源**（库表 → 快照段 → `apply*` 整表重建）；整表重建后派生 Map 必须重建；
  **管理端数据客户端零兜底**（初始空 / 0 / false）。**「上限」类常量要成对检查**。
- babel loose：`Array.from` 替 `[...map.values()]`；客户端 tsconfig 无 ES2017 不用 `Object.entries`；
  `Map` 吃不下 `Partial<Record<>>`。
- 工具链：只信 Grep 工具（BSD grep 交替恒空）；批量替换 `perl -pi -e`（`sed -i ''` 异常）；
  `curl --noproxy '*'`；起端口前 `lsof`；`ps`/`pgrep` 被沙箱禁，判进程用 `kill -0`。
- **并发纪律**：amend 前确认当前分支；工作区异常先 `reflog` + `stash list`。

## 架构不变量（展开见 `olua-server` / `olua-client` / `olua-admin` 技能）
- **服务端权威**：管理端 `@ApiAdminDoc({permissions})` · `BizException` 默认 400 · 乐观锁 409 + **20006** ·
  参数校验失败 **40000** · 客户端零决策。
- `configs/` / `types/` 不引 UI 组件；方向恒为 `apply-snapshot → game-config → types`。
- 门禁看 CI；`make test-changed` 定向回归；`client-test` 基线红先怀疑本地 `network.ts` 硬编码 IP。
- 部分更新接口加数组字段要区分「显式传」与「存量漂移」，否则扩档旧调用被 400 卡死（#720）。
- 资源目录口径见 `client/RESOURCES.md`；改名三处同源：磁盘 + plist 自引用 → 库 19 个路径列 +
  `config-sync.sql` → 客户端 configs。
- **客户端只报格子，数值直读表**（#785）；「玩家在哪」= 存档 `data.mapAt`；改 bag 收尾必须 `refreshBag()`。
- **战斗口径四件**（#822~#825）：① 「谁挂着什么」唯一在 `modules/combat/status-combat.ts` + `role_status`
  （运行时表，不进快照），`category = "2"` 的技能在目标校验**之前**分流，客户端不自己数秒；② 物法分离看系数里的
  `baseType`，**不另开 `damage_type` 列**，两张映射表结算与怪物 AI 共用；③ 目标形态看 `target_type` +
  `require_target`，区域/群体的命中集合由**服务端**算（夹到 `skills.distance`、最近 8 只）；
  ④ `collectEquipmentBundles` 是装备属性的公共入口，自防同件重复 + 部位不符，且**只算不改档**。
- **邮件（#866~#870）**：过期两条腿必须**成对**（`GameMailAutoClaimService` 自动入包 + `purgeExpired` 判据），
  单改一边 = 行永久留库、玩家依旧看不到；跨进程互斥靠 `markClaimed` 的 `WHERE claimed_at IS NULL`；
  保质期三态：不传 30 天 / `0` 永久 / `>0` 指定；离线发奖走 `grantByRoleId`，**`accountId` 从行上取**。
- **道具冷却（#847/#848）**：① 判在业务前置**之后**（满血点药不吃冷却）；② **占位在写库之前**，落库失败要退；
  ③ 内存不落库（两个进程各一份也不会被绕过）。**别给快照表加冷却列**（一列要动五处）。
  **改既有行为要同步跟改既有套件**（等待时长动态读库算，别写死秒数）。
- **配置版本链（#881~#883）**：写配置 +1 的判据是**权限点 `gameConfig:write`**（按路径列清单必漏）；
  304 必须 `@Res()` 非 passthrough 自己 `status().end()`；`config-sync.sql` 带 `-- config-version: N`，
  比对**先剥版本行**，导入比库旧即拒（`--force` 放行）。
- **商城限购/库存（#846）**：额度在 `mall_goods.daily_limit` / `stock`（进快照），销量在运行时表
  `mall_sales(role_id, good_id, day)` / `mall_stock(good_id, sold)`；**只准条件自增占位**（`changes > 0` 判成没成）、
  **占位与扣款同一个事务**、**下架要清 `sold`**。两个哨兵值语义相反：`daily_limit = 0` 不限购 / `stock = 0` 售罄。
  限购**按角色**（钱包本身就按角色）。新码 50029 / 50030 走 `details`。
- **`db.transaction()` 可重入**：已在事务里就并入外层，不再发第二个 `BEGIN`（SQLite 嵌套 BEGIN 直接报错）。
  起因是「发奖事务里记流水」被内层自己包的事务吞掉 —— **事务里调「会吞异常」的写入前先想这一步**。
- **失败响应 `data` 恒 `null`**，带数量的失败另给 `details`（`remainingMs` / `bought` / `sold` 等）。
  别借 `data` 夹带 —— 混进去后「成功与否」要二次判断。

## 引擎坑（→ `cocos-*` 技能）
> **2026-11-08 起合并成 5 个索引技能**：`cocos-render` / `cocos-input` / `cocos-resource` /
> `cocos-gameplay` / `cocos-build-test`。17 个旧技能原文一字未改，在各自 `references/<旧名>.md`。
> 其余 7 个非 cocos 技能不变：`olua-server` / `olua-client` / `olua-admin` / `olua-admin-ui` /
> `olua-deploy` / `olua-numeric-tuning` / `olua-code-quality`。

指针事件配 `UITransform`；`AnimationState` 手动 stop、`isValid(node, true)`；几何锚点是画布中心；自适应三层；Game 挂 Canvas → 五世界层建好再 `setWorldPosition(0,0,0)`；**显隐与摆位要绑定「片段是否就绪」**；`loadLoopFrames` 两形态探测。

## 部署（→ olua-deploy）
- compose **五个**服务：admin:80（唯一入口）/ game:8080 / server:3100 / realtime:3101 / website（不映射端口）。
- 管理端镜像 context = **仓库根**；出厂快照打进镜像（`.dockerignore` 放行 `data/config-sync.sql`）；
  卷 `olua_olua-data`（数据在 `-wal`）。
- `game.yimw.cn` 走管理端 nginx 按 server_name 反代 `game:80`；客户端地址由 `DEV_MODE` 唯一开关决定。
- 资源发布：`make resources-manifest/pack/upload VERSION=x`；清单先合 master 再传 Release。

## 进度
- **逐批细节 → `memory/topics/进度年表.md`**（450 条，按日）。本节只留「还没收的」。
- 2026-11-10 一天收了 8 个 PR：#915 配置版本链 · #916 行为流水与审计 · #917 监控保留闸 ·
  #918 邮件四连 · #919 过期自动入包 · #920 经济与道具冷却 · #921 商城限购/库存（`5d436296`）。口径全在上一节。
- 当前 open：#669 刷怪区即时生效 · #9 包体积 · #12~#19 素材 · #295 阶段三 · #403 帮会战 · #742 站点 TLS ·
  #826 余项（眩晕/麻痹/灼烧/两段连击/拉人/等级压制 sup）· #816 后半（装备槽存 `{id,bound,from}`）·
  #817 后半（拾取距离闸，等位置源）· 掉落表未按新装备重算 · 本地库有未导出运营改动（`make config-check` 常红）。
- **定保持现状**：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- **`docs/37` 是最高优先的单一来源**：72 条 B/G + 48 条 D 已拍板。动任何模块先对 37 篇查一遍。
  三个最硬的旧洞（均已修，留作反面教材）：cast 判定链缺 6 道闸、商城允许 `price=0`（无限印钞）、日常领奖删行。
- **`docs/21~36`** 是 16 个系统的重构设计稿，动系统前先看对应那篇。48 条 D 里**推翻旧设计**的四条：
  删元宝/银子且金币不可流通、存档版本不符**拒登录**（走 `make migrate`）、换图即移除旧图观看者、补种改每秒按密度补缺。
- 乐观锁的客户端口径是「拉最新 + 丢弃本轮」，**不重推**（全量覆盖下重推 = 把后台改动盖回来）。
