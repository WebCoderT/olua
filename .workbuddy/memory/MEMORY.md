# olua 长期记忆（索引）

> 跨域硬纪律 → 本文件；按域查坑 → `memory/topics/踩坑速查.md`；「这事做过没有」→ `memory/topics/进度年表.md`；
> 展开做法 → `.workbuddy/skills/`；系统全貌 → `docs/21~38`。2026-11-08 起不写日报（正文在 git 历史）。

## 纪律（不可绕过）
- issue → 分支 `type/n-slug` → PR（正文写「关联 #n」，**不写 `Closes`**）→ CI 绿 → squash → 手动 `gh issue close`。
- 仓库 PUBLIC：密钥 / IP / 邀请码 / JWT 不进记忆、不进版本库（只放 gitignore 的 `deploy.env`）。**`website/` 永不改动**。
- 新 issue 至少一个 `功能:` 标签（29 域见 `docs/38`，最多 3 个）；docs-only 口头「更新」可直接推 master；
  `gh issue/pr` 长正文一律 `--body-file`（内联反引号会被 zsh 吞）。
- **现状 ≠ 正确，issue 正文也不是事实**：先按它指的行号实测 `server/src` + `admin/src`；收窄范围要在 issue 里写明并改验收。
- **待决定项实时问**（AskUserQuestion，一轮 1~4 个）；**文档禁止写「不做」**（写「暂时放置 + 重开条件」，「已定」只标
  用户亲口拍过的）。用户说「我自己细化 / 我在改」→ 改完本地就停（不 push、不盯 CI、不合并）。

## 改数据的登记清单（漏一处 = 静默失效）
- **新增一张表**五处：`config-tables.cjs` 两份清单 · `gen-api.cjs` MODULES · `audit-server-boundaries` REPO_EDGES ·
  `audit-target.decorator`；**横切服务**再加 `ALLOWED_EDGES`（只在 `make audit` 里，`npm run verify` 不跑）。
- **新增一列**三处：`CREATE TABLE` · `ensureColumn` · 仓储**写入列清单**（漏最后一项 = `update()` 静默不写：
  PATCH 200、库里没变、结算不动）→ 再往上是 DTO + `from()` + 客户端 types。
- **快照加一段**：DTO / `snapshot()` / 客户端 `game-config` 区 0 + `configs-sandbox` 三处 + `audit-snapshot-contract`。
- **新道具表**要让 `sellPriceOf` / `itemLabelOf` / `itemTypeOf` 都认识，否则回收价与解析静默失效。
- `config-sync.sql` 加表：只拼新增节的 diff + 手改表头三行；`cp` 库前 `PRAGMA wal_checkpoint(TRUNCATE)`。
- 改 DTO 连描述都算改契约 → `swagger:emit` + `node tools/gen-api.cjs`；Response DTO 要进 `swagger/models.ts`。
- **改列名**（不是加列）：`renameColumnIfExists(table, from, to)` 幂等改名（`PRAGMA table_info` 判存在 + 新名已存在则跳），
  放 `migrate()` 末尾；**别删列重建** —— 存量数据（如已发的奖励金额）会丢。改名后 DDL / `rows.ts` / 仓储 SQL / DTO /
  测试字面量五处一起改（#926 货币命名）。
- controller `description` 别贴 `/admin/xxx`；同毫秒多行排序兜底键用 `rowid`，不用随机 uuid。

## 测试与门禁
- **反证前确认 build 真过了**：`npm run build 2>&1 | tail -N && 跑测试` 的退出码来自 `tail`，编译失败照样往下跑 → 反证
  跑在旧 `dist` 上看着全绿。不加管道或 `set -o pipefail`。
- e2e：期望值从快照算 · 播种在 `startServer()` 之后 · 改 `server/src` 先 build（跑 `dist/`）· 本机绿 ≠ CI 绿；
  `e2e-quest` 成功静默，判绿看 exit code。
- **锁格式与行为，不锁数值**（运营随时改数）；**显示效果不写断言**（人眼看，只留素材存在性与接线）。
- **假绿 > 漏检**：断言模块数 / 精确匹配文案 / TTL 压 0 比漏检危险；**完整性**只能遍历全表查。
- **帧只发「有变化」的东西**：断「路过某点」要扫**帧历史**；命中帧全图广播，先按 `hit.accountId` 过滤。
- **源码断言钉在方法体上**（`methodBody(src, "submit")`），别用全文件 `includes` —— 新加的同名调用会误伤
  （#865 的 `abandon()` 删行，让「领奖不删行」假红）。断言口径过期比红更危险：会让人对红免疫。
- 工具链：只信 Grep 工具（BSD grep 交替恒空、遇含 NUL 文件空手）；批量替换 `perl -pi -e`；`curl --noproxy '*'`；
  `ps`/`pgrep` 被禁，判进程用 `kill -0`；并发异常先 `reflog` + `stash list`。

## 架构不变量（展开见 `olua-server` / `olua-client` / `olua-admin`）
- **服务端权威**：`@ApiAdminDoc({permissions})` · `BizException` 默认 400 · 乐观锁 409 + **20006** · 校验失败 **40000** ·
  失败响应 `data` 恒 `null`（带数量给 `details`）· 客户端零决策。
- 方向恒 `apply-snapshot → game-config → types`（`configs/` 不引 UI）；`client-test` 基线红先怀疑本地 `network.ts` 硬编码 IP；
  `db.transaction()` 可重入。**一份数据一个来源**：库表 → 快照段 → `apply*` 整表重建（派生 Map 要重建，客户端零兜底）。
- 部分更新接口加数组字段要区分「显式传」与「存量漂移」，否则扩档旧调用被 400 卡死（#720）。
- 客户端只报格子、数值直读表（#785）；「玩家在哪」= `data.mapAt`；改 bag 收尾必须 `refreshBag()`；
  `Array.from` 替 `[...map.values()]`、不用 `Object.entries`、`Map` 吃不下 `Partial<Record<>>`。
- 资源目录 `client/RESOURCES.md`；改名三处同源：磁盘 + plist → 库 19 个路径列 + `config-sync.sql` → 客户端 configs。
- **战斗（#822~#825）**：① 状态唯一在 `combat/status-combat.ts` + `role_status`，`category="2"` 在目标校验**之前**分流；
  ② 物法分离看系数 `baseType`，不另开 `damage_type` 列；③ 目标形态看 `target_type` + `require_target`，区域/群体命中
  集合由**服务端**算（夹到 `skills.distance`、最近 8 只）；④ `collectEquipmentBundles` 是装备属性公共入口（只算不改档）。
- **怪物 AI（#853~#858，见 `olua-server` 四之十三补）**：位置与血量**唯一副本在 `PlayerPresenceService`**
  （`markHp` 不刷 `updatedAt`）；`state = idle/chase/return`，**牵引半径判定放在出手之前**，`endChase` 是脱战唯一收口
  （清 target + 清 `provoked`）；移动 `slideMove` + `clampToMap`，击退 `pushPoint`（被挡原地）；**卡住门槛 0.01px 不是
  1px**（出厂 `move_speed` 2px/s 每帧 0.1px）；没人看只冻结 10 分钟后回收；`applyPush` 依赖在场表（超时的人推不动）。
- **纯服务端消费的参数别并进 `RuntimeParamsDto`**（那是客户端快照的形状，加一段动五处）。
- **背包与装备（#835~#842，见 `olua-server` 四之十六）**：**装备格 count 恒 1 是硬不变式**（用户口径「任何情况下
  不允许重叠」）—— 创建侧全堵死（管理端 20003 / 搬运 20022），存量脏格唯一出路是**穿戴拆散**（空格不够整步失败
  20012 不落库）；**单格上限唯一出口 `resolveMaxStack`**（装备 1 / 四表各读 / 认不出 99），禁止就地写默认值；
  move/tidy 三层判据（形状 → 绑定守恒 → `findOverstackedCell`）。**管理端 PATCH 角色三条收口（#836）**：槽位键
  大小写归一 + 存在性/部位裁决；PATCH 完属性当场重算（`applyAttributeSummary` 与玩家侧共用）+ `clampVitals`；
  PATCH bag 走 `reconcileBagCells` 元数据认领（`applyBagCells` 会整体洗白绑定，别退回去）。admin 引
  role-inventory/role-authority/combat 三条白名单边已登记，别删。
- **邮件（#866~#870）**：过期两条腿必须成对（`GameMailAutoClaimService` + `purgeExpired`）；跨进程互斥靠 `markClaimed`
  的 `WHERE claimed_at IS NULL`；保质期三态 30 天 / `0` 永久 / `>0`；离线发奖 `grantByRoleId`，`accountId` 从行上取。
- **道具冷却（#847/#848）**：判在业务前置**之后** · 占位在写库**之前**（失败要退） · 内存不落库 · 别给快照表加列；
  改既有行为要同步跟改既有套件。
- **配置版本链（#881~#883）**：+1 的判据是权限点 `gameConfig:write`；304 必须 `@Res()` 非 passthrough；
  `config-sync.sql` 带 `-- config-version: N`，比对先剥版本行，导入比库旧即拒。
- **商城（#846）**：额度在 `mall_goods`，销量在 `mall_sales` / `mall_stock`；只准条件自增占位（`changes > 0`）+ 与扣款
  同一事务；下架清 `sold`；`daily_limit=0` 不限购 / `stock=0` 售罄 / `-1` 不限量。
- **进图权威（#859/#861）**：`mapAt` 缺失只准进 `START_MAP_ID("0")`，未知图直接拒（`unknown` 先于 `start`）；在场条目的
  图只由 `join()` 写，`updatePosition` 图不一致整帧丢弃；`join()` 换图重置仲裁基线。
- **任务交互与周期（#862~#865，见 `olua-server` 任务章）**：`accept` / `npcTalk` 共用 `requireNearNpc`
  （`QUEST_NPC_RADIUS` 120px + `QUEST_POS_STALE_MS` 10s，返 **20032**）；位置读 `role_positions` —— **唯一写者是实时进程**
  （`broadcast()` 里 `flushPositions()`，1s 节流 + 坐标指纹不变不写 + `join()` 即写 + `dropAccount()` 删行），
  **查不到 / 太旧一律拒绝**（放行等于给「不上报位置」开开关）。`map_npcs` 本图查不到要分两种：`countByNpc > 0`（只摆在别的图）
  拒；`= 0`（配置缺口，现网 8004→9002 就是）**放行 + 告警一次**，点位补上自动生效。周期一把尺子：`reset_day` = **本轮起点
  天号**（日常 `resetDayOf` / 周常 `weekStartDayOf`，都 05:00 切），`isStale` 一处覆盖 接取/下发/交付/推进度；
  `abandon` 只删非 `claimed`（那是「本轮领过」的唯一证据）；超时**不加列**，跨轮交付 **20033**。
- 乐观锁客户端口径「拉最新 + 丢弃本轮」，**不重推**。

## 引擎坑（→ `cocos-render` / `-input` / `-resource` / `-gameplay` / `-build-test`，旧技能原文在各自 `references/`）
指针事件配 `UITransform`；`AnimationState` 手动 stop、`isValid(node,true)`；Game 挂 Canvas → 五世界层建好再
`setWorldPosition(0,0,0)`；**显隐与摆位绑「片段是否就绪」**。

## 部署（→ olua-deploy）
compose **五个**服务：admin:80（唯一入口）/ game:8080 / server:3100 / realtime:3101 / website（不映射端口）。镜像 context =
仓库根，出厂快照打进镜像（`.dockerignore` 放行 `data/config-sync.sql`），卷 `olua_olua-data`（数据在 `-wal`）。客户端地址
由 `DEV_MODE` 唯一开关决定；资源发布 `make resources-manifest/pack/upload VERSION=x`。

## 进度
- 逐批细节 → `memory/topics/进度年表.md`（450+ 条按日）。最近：#921 商城限购 · #922 进图权威三条 · #923 怪物 AI 六条
  （`d2590ac2`）· #924 背包守恒与装备不重叠（`e5b0509d`）· #925 货币收敛唯一 bindGold（`b61e0439`，#843/#844 已关：
  **不迁移直接删字段、legacy 道具 16 条删行不兼容、UI 叫「绑定元宝」**，账本键收权时剥离 LEGACY_LEDGER_FIELDS）·
  #926 货币命名彻底统一（`c1cb0a5e`，PR #927）：`rewards.bindGold` / `role_mails.bind_gold` / `reward_bind_gold` /
  `cost_bind_gold` / `GROWTH_BIND_GOLD_NOT_ENOUGH` / `mall_bind_gold_not_enough_tip` / `{bindGold}` / `bind-gold` 三套写法
  按层固定；存量库用 `renameColumnIfExists` 幂等改名（不删列重建，保已发奖励）；只有 `LEGACY_LEDGER_FIELDS` 留 gold 字面量。·
  #930 世界刷怪四条（`866fded3`，PR #931；#849~#852 已关）：见下「刷怪密度」条。
- #932 任务域四缺口（`01b42dd0`，PR #933；#862~#865 已关）：NPC 距离闸 120px + `role_positions` 位置快照 ·
  放弃接口 `POST /quests/abandon` · 跨轮交付 20033 · 周常周一 05:00 切。新套件 `e2e-quest-authority` 44 条。
  **客户端「放弃任务」按钮暂时放置**（服务端先行；重开条件 = 任务面板改版或玩家反馈要主动放弃）。
- **刷怪密度（#930，落地口径）**：表单只有「数量」= `max`，`min` 恒 0（老库 `min = max` 一次性抹平，否则下限顶死
  系数）；目标 `clamp(round(max × 时段系数 × 人数系数), min, max × density_peak)`，人数取**本图观看者**；tick 每秒
  差量对齐、每 tick 至多补 2 只、超出裁「死等重生 → 最久没被攻击」的，`lastDamagedAt` 5 秒内不裁；统计用**实例数**
  不用存活数（否则打一只变两只）。公式唯一副本 `common/utils/spawn-density.util.ts`（管理端 `targetNow` 与 tick 共用）。
  `world_monsters.area_id` 记归属（老档 `findAreaAt` 回填），删区按它清孤儿。代际作废只对「有人看且库里有行」的分域
  重载（0 行不重播，否则合区白做），合区后 5 分钟只补不裁。越界区不整区丢弃：先取「区域 ∩ 地图」，整块在图外才退回
  原区域取点再 `clampPointToMap`。
- 当前 open：#9 包体积 · #12~#19 素材 · #295 阶段三 · #403 帮会战 · #742 站点 TLS · #826 余项
  （眩晕/麻痹/灼烧/两段连击/拉人/等级压制 sup）· #816 / #817 后半 · #838 装备穿限制（放置）· 掉落表未按新装备重算 ·
  本地库有未导出改动（`make config-check` 常红）。**定保持现状**：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- **client 单测已全绿（#928 / `bd772183`，2026-11-11）**：65 通过 / 0 失败。此前两套存量红的根因 ——
  `test-mall` 6 条是断言还在比 boolean 而 `buyMallGood` 自 #921 起返回 `MallLimit | null`；`test-skill-decouple`
  7 条是深比较把 `description` 也锁死了（文案归运营，已剔出比较）+ 1009 期望是旧单体形态（已按库对齐）。
  **`make client-test` 现在能当门禁用，全绿才算过。**
- **在 git worktree 里跑 client 单测会假绿/假红**（2026-11-11 实测）：`client/temp/declarations/cc.d.ts`（Cocos 生成）
  与 `client/assets/resources/**`（大资源）都被 gitignore，worktree 里没有 → `prepare()` 直接抛「配置表编译失败」，
  脚本 crash 后 grep `[!!]` 得 0 条，**看起来全绿**；资源存在性断言则假红。判基线必须先
  `cp -R client/temp/declarations /tmp/<wt>/client/temp/` 并接受资源类断言不可比。
- **`docs/37` 是最高优先单一来源**（72 条 B/G + 50 条 D 已拍板；B46/B47/G6/G7 与 D-13 已落 #932，D-08/D-09 已落）。推翻旧设计的四条：
  删元宝/银子且金币不可流通（C1 落地口径 2026-11-11 三处修改见 33 篇 3.4）、存档版本不符**拒登录**、
  换图即移除旧图观看者、补种改每秒按密度补缺（已落 #931）。
