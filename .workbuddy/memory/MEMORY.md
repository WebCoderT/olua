# olua 长期记忆（索引）

> **入口分工**：跨域硬纪律 → 本文件；按域查坑 → `memory/topics/踩坑速查.md`；
> 「这事做过没有」→ `memory/topics/进度年表.md`；展开做法 → `.workbuddy/skills/`；
> 系统全貌与重构设计 → `docs/21~36`。
> 2026-11-08 起**不再写日报**（31 篇日报已蒸馏成上面两篇后删除，正文在 git 历史里）。

**纪律**：issue → 分支 `type/n-slug` → PR（「关联 #n」）→ 本地 `make test-changed` → CI 绿 → squash → 手动 `gh issue close`（正文写「关联」不写 `Closes`）。
仓库 PUBLIC —— 密钥 / IP / 邀请码不进记忆。**website/ 永不改动**。docs-only 用户口头「更新」可直接推 master。
本机待办 `TODO-FOR-USER.md`（gitignore）。`gh issue/pr` 长正文一律 `--body-file`（内联反引号被 zsh 吞）。

## 过程纪律
- **现状 ≠ 正确**：先实测代码在做什么（`server/src` + `admin/src`），再谈改成什么；不要拿现状当基准。
- **待决定项实时问**：需要用户拍板的分支（默认值 / 做不做 / 语义二选一 / 落地顺序）→ 当场用 AskUserQuestion 问，一轮 1~4 个，答完再往下。**不许攒成文档的「待你确认的 N 个点」让用户自己翻**；文档里只留「已定」结论表作记录。
- **文档里禁止写「不做」**：一律写「**暂时放置** + 重开条件」。且「已定」只能标用户亲口拍过的项，自己的取舍必须标「待定」并去问（2026-11-08 明确）。
- **用户说「我自己细化 / 我在改」的分支：改完本地就停**——不 push、不盯 CI、不合并，除非用户明说。
- **测试锁「字段格式 + 行为」不锁数值**（运营随时改数）；用户说「数据我改过」= 停追红，改断言口径。
- **显示效果不写断言**：动画/特效的位置·尺寸·帧率·层级·对齐一律人眼看，只留素材存在性、执行顺序、结构接线。
- **e2e**：期望值从快照算；播种放 `startServer()` 之后；`checkEqual` 是 `===`；改 `server/src` 先 `npm run build`（e2e 跑 `dist/`）；本机绿 ≠ CI 绿（耦合断言超时盖过冷却周期）；`e2e-quest` 成功静默，判绿看 exit code。
- **假绿 > 漏检**：扫描器断言模块数、错误精确匹配文案、缓存 TTL 压 0；**完整性**（有没有东西没登记）只能靠遍历全表查，正确性审计查不出来。
- **新增一张表登记五处**：`config-tables.cjs` 两份清单 + `gen-api.cjs` MODULES + `audit-server-boundaries` REPO_EDGES + `audit-target.decorator` 类型。**快照加段 = DTO / `snapshot()` / 客户端 `game-config.ts` 区 0 三处 + `configs-sandbox` 三处 + `audit-snapshot-contract`**（漏一处 = 几十套客户端单测齐炸）。
- **新增一列登记三处**：`CREATE TABLE` / `ensureColumn` / 仓储的**写入列清单**（如 `skills` 的 `SKILL_COLUMNS`）——
  漏最后一项 = `update()` **静默不写**（PATCH 200 返回、库里一个字没变、结算侧一分不变）。再往下才是 DTO + `from()` + 客户端 types。
- **新道具表必须让 `sellPriceOf` / `itemLabelOf` / `itemTypeOf` 都认识**，否则回收价与物品解析静默失效；按素材批量加物品还要查 `rebuildItemIndex` / `getMallGoods` 是否覆盖到（#777 曾是「7 部位部分视图」）。
- **config-sync.sql 加表**：只拼新增表的节 + 手改表头三行（整份重导有几千行假 diff）；`cp` 库前 `PRAGMA wal_checkpoint(TRUNCATE)`；校验拿「同 schema 库副本」做 `config-import --db`；用户正改表时别整份 export。
- 改 DTO 连描述都算改契约 → `swagger:emit` + `node tools/gen-api.cjs`；Response DTO 不在 `swagger/models.ts` 登记就不进 openapi；`gen-api` 的 query 默认 `= {}` 只在**全字段可选**时给。
- **一份数据一个来源**（库表 → 快照段 → `apply*` 整表重建）；整表重建后派生 Map 必须重建；**管理端数据客户端零兜底**（初始空 / 0 / false，#724）。
- **「上限」类常量必须成对检查**（`ROLE_LEVEL_MAX` 与 `GROWTH_SCALAR_SPECS.max` 曾不同步，改一处会把合法值当脏数据拒）。
- babel loose：`Array.from` 替 `[...map.values()]`；客户端 tsconfig 无 ES2017 不用 `Object.entries`；`Map` 吃不下 `Partial<Record<>>`。
- 工具链：只信 Grep 工具（BSD grep 交替恒空）；批量替换 `perl -pi -e`（`sed -i ''` 异常）；`curl --noproxy '*'`；起端口前 `lsof`；`ps`/`pgrep` 被沙箱禁，判进程用 `kill -0`。
- **并发纪律**：amend 前确认当前分支；工作区异常先 `reflog` + `stash list`。

## 架构不变量（→ olua-server / olua-admin / olua-client）
- **服务端权威**；管理端 `@ApiAdminDoc({permissions})`、`BizException` 默认 400、乐观锁 409+20006、参数校验失败 **40000**；客户端零决策。
- `configs/` / `types/` 不引 UI 组件；方向恒为 `apply-snapshot → game-config → types`。
- 门禁看 CI；`make test-changed` 定向回归；`client-test` 基线红先怀疑本地 `network.ts` 硬编码 IP。
- 部分更新接口加数组字段要区分「显式传」与「存量漂移」，否则扩档旧调用被 400 卡死（#720）。
- 资源目录口径见 `client/RESOURCES.md`（14 顶层域平铺 + `ui/`）；改名三处同源：磁盘 + plist 自引用 → 库 19 个路径列 + `config-sync.sql` → 客户端 configs。
- **客户端只报格子，数值直读表**（#785 货币）；「玩家在哪」= 存档 `data.mapAt`；改 bag 数据收尾必须 `refreshBag()`。
- **物法分离看 `baseType`**（#823）：攻击类型来自技能系数 `damageCoefficients[].baseType`（`physicalAttack` / `magicAttack` / `taoistAttack`），
  不另开 `damage_type` 列。两张映射表 `DEFENSE_BY_ATTACK` / `MONSTER_STAT_COLUMN` 在 `common/constants/game-enums` 由结算与怪物 AI **两侧共用**；
  怪物该项攻击上限 = 0 视为**未配** → 跳过该技能并 warn（不派生、不刷数据）。抗性分系暂时放置。
- **装备属性汇总要自防**（#825）：`collectEquipmentBundles` 是所有读者的公共入口（结算 / 互见 / 榜 / 成就 / 管理端详情），
  同一件只算一次 + 部位不符不计（`slotMatches` 大小写不敏感，`actualSlot === null` 放行）—— 修在这里一处生效，且只算属性**不改写存档**（修档是 `sanitizeEquipments` 的活）。
- **目标形态看 `target_type` + `require_target`**（#824）：单体才要怪（`= "1"` 且 `require_target !== 0`，与客户端
  `SkillManager.tryCast` 同口径）；区域 / 群体由**服务端**算命中集合（落点夹到 `skills.distance` 内 ＝ 半径，
  最近 `AOE_MAX_TARGETS = 8` 只，每只独立掷骰），回执带 `hits[]`，空系数 = `noDamage`（1008 位移）。
  奖励逐只、掉落账本按一次施放合并（客户端 `dropIndexBase` 累计下标）。`max_targets` 还没进表（常量 + 重开条件见 docs/07 §2.1）。
- **离线发奖缺口**：`grantQuestRewards` 首行 `onlineRoleOrThrow` → 离线发不进去；要补 `grantByRoleId`（32/31 篇的共同前置）。
- **状态只有一份口径**（#822）：`modules/combat/status-combat.ts`（服务端，纯函数）＝「谁挂着什么」在 `role_status`（运行时表，不进快照/config-sync）。
  `category = "2"` 的技能**在目标校验之前**分流；客户端不自己 `apply`、不自己数秒。新增状态只加 `statuses` 行，不要另开一套。

## 引擎坑（→ `cocos-*` 技能）
> **2026-11-08 起 `cocos-*` 合并成 5 个索引技能**：`cocos-render` / `cocos-input` / `cocos-resource` /
> `cocos-gameplay` / `cocos-build-test`。17 个旧技能的原文一字未改，全在各自的
> `references/<旧名>.md` 下 —— 看到旧名（如 `cocos-monster-ai`）就去对应索引里的表跳转。
> 其余 7 个非 cocos 技能不变：`olua-server` / `olua-client` / `olua-admin` / `olua-admin-ui` /
> `olua-deploy` / `olua-numeric-tuning` / `olua-code-quality`。

指针事件配 `UITransform`；`AnimationState` 手动 stop、`isValid(node, true)`；几何锚点是画布中心；自适应三层；Game 挂 Canvas → 五世界层建好再 `setWorldPosition(0,0,0)`（#692）；**显隐与摆位要绑定「片段是否就绪」**（#726）；`loadLoopFrames` 两形态探测（平铺图集 / 目录内同名图集）。

## 部署（→ olua-deploy）
- compose **五个**服务：admin:80（唯一入口）/ game:8080 / server:3100 / realtime:3101 / website（不映射端口）。`docs/deploy.md` 曾写「四个」是漏了 website。
- 管理端镜像 context = **仓库根**；出厂快照打进镜像（`.dockerignore` 放行 `data/config-sync.sql`）；卷 `olua_olua-data`（数据在 `-wal`）。
- `game.yimw.cn` 走管理端 nginx 按 server_name 反代 `game:80`；客户端地址由 `DEV_MODE` 唯一开关决定（#775）。
- 资源发布：`make resources-manifest/pack/upload VERSION=x`；清单先合 master 再传 Release。

## 进度
- 已落地与 open 项的完整清单 → `memory/topics/进度年表.md`（445 条，按日）。
- 当前 open（截至 2026-11-08）：#669 刷怪区即时生效 · #9 包体积 · #12~#19 素材 · #295 阶段三 · #403 帮会战 · #742 站点 TLS ·
  **#826 只落了第一批**（暴击 + 破防；撞飞/格挡/灼烧/两段连击/拉人/1009 群体化/删 desc 精确数值/等级压制 sup 待排期）·
  掉落表未按新装备重算（`EQUIP_LEVEL_GAP` / `MAX_TIER_PER_SLOT`）· 本地库有未导出运营改动，`make config-check` 常红。
  阶段三功能批已收：#822 状态技能 ✅ · #823 物法分离 ✅ · #825 装备汇总自防 ✅（PR #901）· **#824 自身/区域/群体技能 ✅**（PR #902 + #903，合入 `57a0ce2e`）· **#827 幂等账 TTL ✅**（PR #904，合入 `4b5fa551`）；下一批 **#826**（技能描述里的暴击/撞飞/格挡/破防无实现，已拍板：先接既有能力 + 只删精确数值 + 暴击=技能行+角色属性 + 破防=穿透比例）· #905（status-player 在 CI 偶发红：角色先被打死）。
- 定保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- **阶段 2 地基五条进度（2026-11-08 夜）**：#818 存档版本 ✅ / #819 坏档拒登 ✅ / #820 乐观锁基线必填+落库复核 ✅ /
  #821 换图退出旧图观看者 ✅；**#816 后半**（装备槽存 `{id,bound,from}`）与 **#817 后半**（拾取距离闸，
  等位置源）待排期。乐观锁的客户端口径是「拉最新 + 丢弃本轮」，**不重推**（全量覆盖下重推 = 把后台改动盖回来）。
- **2026-11-08 起**：`docs/21~36` 是 16 个系统的重构设计稿（21 总表 + 22~36 逐系统），**动任何系统前先看对应那篇**。
- **`docs/37-代码逻辑实测与待修清单.md` 是最高优先的单一来源**：72 条 B/G（Bug / 缺口）+ 48 条 D 已拍板（A1~J5）。
  现状 ≠ 正确 —— 代码能跑通不代表逻辑对，动任何模块先对 37 篇查一遍。
  最硬的三个洞：cast 判定链缺 6 道闸（改包 1 秒清 BOSS）、商城允许 price=0（无限印钞）、日常领奖删行（无限重刷）。
- 48 条里**推翻旧设计**的四条：删元宝/银子且金币不可流通（26 篇重写，只做面对面以物易物）、
  存档版本不符**拒登录**（不是惰性迁移，走 `make migrate`）、换图即移除旧图观看者、补种改每秒按密度补缺。
