# olua 长期记忆（索引）

> 跨域硬纪律 → 本文件；**按域不变量** → `memory/topics/架构不变量.md`；按域查坑 → `memory/topics/踩坑速查.md`；
> 「这事做过没有」→ `memory/topics/进度年表.md`；展开做法 → `.workbuddy/skills/`；系统全貌 → `docs/21~38`。
> 2026-11-08 起不写日报（正文在 git 历史）。

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
- **新功能的出厂「行」不是加列**：快照只在**空库首启**整份灌一次，新增配置行在存量库里根本不存在（症状：功能静默
  不生效、无报错）→ 一次性补数据 `seedXxxOnce()` + `config_meta` marker，取值放 `common/constants/*-seed.ts`：
  `INSERT OR IGNORE` 补行 + 只在出厂空值 / 0 时才写值。

## 测试与门禁
- **反证前确认 build 真过了**：`npm run build 2>&1 | tail -N && 跑测试` 的退出码来自 `tail`，编译失败照样往下跑 →
  反证跑在旧 `dist` 上看着全绿。不加管道或 `set -o pipefail`。
- e2e：期望值从快照算 · 播种在 `startServer()` 之后 · 改 `server/src` 先 build（跑 `dist/`）· 本机绿 ≠ CI 绿；
  `e2e-quest` 成功静默，判绿看 exit code。全套 `make e2e-all` 要重定向到日志后台跑（约 8 分钟）。
- **锁格式与行为，不锁数值**（运营随时改数）；**显示效果不写断言**（人眼看，只留素材存在性与接线）。
- **假绿 > 漏检**：断言模块数 / 精确匹配文案 / TTL 压 0 比漏检危险；**完整性**只能遍历全表查。
- **帧只发「有变化」的东西**：断「路过某点」要扫**帧历史**；命中帧全图广播，先按 `hit.accountId` 过滤。
- **源码断言钉在方法体上**（`methodBody(src, "submit")`），别用全文件 `includes` —— 新加的同名调用会误伤
  （#865 的 `abandon()` 删行，让「领奖不删行」假红）。断言口径过期比红更危险：会让人对红免疫。
- **血量类断言别用「窗口净变化」**：自然回血（`hpRecoverOfHp` 1%/秒）会把 DoT 曲线变成锯齿，净掉血量随相位漂
  → 改成**数「比上一次低」的次数**（#826 的 `e2e-status`）。同理：怪身上有 DoT 时别断「冻结期间血量不变」。
- **时序类用例别赌 wall-clock 窗口**：满负载并行跑时 tick 会被挤后（#833 的 `e2e-monster-ai` 追击段：一口气 1.1s
  跑出 600px → 整段没拿到 tick）。给窗口留 tick 挤后的余量，或拆成「停在范围内等它迈出一步」两段。
- 工具链：只信 Grep 工具（BSD grep 交替恒空、遇含 NUL 文件空手）；批量替换 `perl -pi -e`；`curl --noproxy '*'`；
  `ps`/`pgrep` 被禁，判进程用 `kill -0`；并发异常先 `reflog` + `stash list`。

## 架构不变量（细节见 `memory/topics/架构不变量.md`）
- **服务端权威**：`@ApiAdminDoc({permissions})` · `BizException` 默认 400 · 乐观锁 409 + **20006** · 校验失败 **40000** ·
  失败响应 `data` 恒 `null`（带数量给 `details`）· 客户端零决策；乐观锁客户端「拉最新 + 丢弃本轮」，**不重推**。
- 方向恒 `apply-snapshot → game-config → types`；**一份数据一个来源**（库表 → 快照段 → `apply*` 整表重建，客户端零兜底）。
- 客户端只报格子 / 增量，数值直读服务端回执；**进 `SERVER_INVENTORY_FIELDS` 的字段客户端不得写、也不得补默认值**。
- 已展开的域（各条一句话见 topic 文件）：战斗 #822~#825 · 状态层两侧 #826 · 怪物 AI #853~#858 · 背包与装备 #835~#842 ·
  装备穿戴规则 #838 · 邮件 #866~#870 · 道具冷却 #847/#848 · 配置版本链 #881~#883 · 商城 #846 · 进图权威 #859/#861 ·
  任务周期 #862~#865 · 拾取归属 #817 · 帮会门槛 #871/#872 · **成长线两条点数 #828/#833** · 刷怪密度 #930。
- 纯服务端消费的参数别并进 `RuntimeParamsDto`（那是客户端快照的形状，加一段动五处）。

## 引擎坑（→ `cocos-render` / `-input` / `-resource` / `-gameplay` / `-build-test`，旧技能原文在各自 `references/`）
指针事件配 `UITransform`；`AnimationState` 手动 stop、`isValid(node,true)`；Game 挂 Canvas → 五世界层建好再
`setWorldPosition(0,0,0)`；**显隐与摆位绑「片段是否就绪」**。

## 部署（→ olua-deploy）
compose **五个**服务：admin:80（唯一入口）/ game:8080 / server:3100 / realtime:3101 / website（不映射端口）。镜像 context =
仓库根，出厂快照打进镜像（`.dockerignore` 放行 `data/config-sync.sql`），卷 `olua_olua-data`（数据在 `-wal`）。客户端地址
由 `DEV_MODE` 唯一开关决定；资源发布 `make resources-manifest/pack/upload VERSION=x`。

## 进度
- 逐批细节 → `memory/topics/进度年表.md`（按日 450+ 条）。最近几条：
  #921 商城限购 · #922 进图权威 · #923 怪物 AI 六条（`d2590ac2`）· #924 背包守恒与装备不重叠（`e5b0509d`）·
  #925 货币收敛唯一 bindGold（`b61e0439`；**不迁移直接删字段，UI 叫「绑定元宝」**）· #926 货币命名统一（`c1cb0a5e`）·
  #930 世界刷怪四条（`866fded3`）· #932 任务域四缺口（`01b42dd0`，`e2e-quest-authority` 44 条；**客户端「放弃任务」
  暂时放置**）· #826 战斗六项收口（`0ae851d2`，`e2e-status` 55 条）· #828 技能升级（`afd620c0`）·
  **#833 属性点与自由加点（`7e1eadc9`，PR #938，`e2e-attr-points` 70 条）** ·
  **#834 等级差压制系数配置化（`ee192751`，PR #939，`e2e-level-gap` 45 条；命中侧暂时放置）** ·
  **#838 装备穿戴补职业/性别服务端校验（`2e05228d`，PR #940，`e2e-equip-rules` 48 条；双手/副手取消：本作没有副手槽）**。
- 当前 open：#9 包体积 · #12~#19 素材 · #295 阶段三 · #403 帮会战 · #742 站点 TLS · #816 / #817 后半 ·
  #801/#802~#805 掉落系统重构（epic）· #808 地图重构（Room/AOI/寻路）·
  #772 同步延迟（分片）· #438 运营群发 · #577 素材遗留 · 掉落表未按新装备重算 · 本地库有未导出改动（`make config-check` 常红，且该库**没有**
  2003/2004/2005 三条状态行 —— 重启一次 `seedCombatStatusesOnce` 会补上；`make config-import` 会覆盖本地手工调过的值）。
  **定保持现状**：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- **`docs/14-接口清单.md` 的生成脚本已不在仓库**（头部的「自动生成 / 不要手改」已过期）：改接口后要**手工**加行并
  重算三段的条数（#833 时补了 `role.skillUpgrade` / `role.attrAllocate` / `role.attrReset`）。
- **client 单测可当门禁（#928 / `bd772183`）**：65 通过 / 0 失败；`make client-test` 全绿才算过。
  **在 git worktree 里跑会假绿/假红**（`client/temp/declarations` 与 `resources/**` 被 gitignore → 脚本 crash 后
  grep `[!!]` 得 0 条，看起来全绿）→ 判基线要 `cp -R client/temp/declarations /tmp/<wt>/client/temp/`。
- **`docs/37` 是最高优先单一来源**（B/G/D 已拍板；B46/B47/G6/G7 与 D-13 已落 #932）。推翻旧设计的四条：
  删元宝/银子且金币不可流通、存档版本不符**拒登录**、换图即移除旧图观看者、补种改每秒按密度补缺（已落 #931）。
