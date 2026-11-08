# olua 长期记忆（索引；细节在 `.workbuddy/skills/` 与 `memory/2026-*.md`）

> **纪律**：issue → 分支 `type/n-slug` → PR（「关联 #n」）→ 本地 `make test-changed` → CI 绿 → squash → 手动 `gh issue close`（正文写「关联」不写 `Closes`）。
> 仓库 PUBLIC —— 密钥 / IP / 邀请码不进记忆。**website/ 永不改动**。docs-only 用户口头「更新」可直接推 master。
> 本机待办 `TODO-FOR-USER.md`（gitignore）。`gh issue/pr` 长正文一律 `--body-file`（内联反引号被 zsh 吞）。

## 过程纪律
- **待决定项实时问**：需要用户拍板的分支（默认值 / 做不做 / 语义二选一 / 落地顺序）→ 当场用 AskUserQuestion 问，一轮 1~4 个，答完再往下。**不许攒成文档的「待你确认的 N 个点」让用户自己翻**；文档里只留「已定」结论表作记录。
- **测试锁「字段格式 + 行为」不锁数值**（运营随时改数）；用户说「数据我改过」= 停追红，改断言口径。
- **显示效果不写断言**：动画/特效的位置·尺寸·帧率·层级·对齐一律人眼看，只留素材存在性、执行顺序、结构接线。
- **e2e**：期望值从快照算；播种放 `startServer()` 之后；`checkEqual` 是 `===`；改 `server/src` 先 `npm run build`（e2e 跑 `dist/`）；本机绿 ≠ CI 绿（耦合断言超时盖过冷却周期）；`e2e-quest` 成功静默，判绿看 exit code。
- **假绿 > 漏检**：扫描器断言模块数、错误精确匹配文案、缓存 TTL 压 0。
- **新增一张表登记五处**：`config-tables.cjs` 两份清单 + `gen-api.cjs` MODULES + `audit-server-boundaries` REPO_EDGES + `audit-target.decorator` 类型。**快照加段 = DTO / `snapshot()` / 客户端 `game-config.ts` 区 0 三处 + `configs-sandbox` 三处 + `audit-snapshot-contract`**（漏一处 = 几十套客户端单测齐炸）。
- **新道具表必须让 `sellPriceOf` / `itemLabelOf` / `itemTypeOf` 都认识**，否则回收价与物品解析静默失效；按素材批量加物品还要查 `rebuildItemIndex` / `getMallGoods` 是否覆盖到（#777 曾是「7 部位部分视图」）。
- **config-sync.sql 加表**：只拼新增表的节 + 手改表头三行（整份重导有几千行假 diff）；`cp` 库前 `PRAGMA wal_checkpoint(TRUNCATE)`；校验拿「同 schema 库副本」做 `config-import --db`；用户正改表时别整份 export。
- 改 DTO 连描述都算改契约 → `swagger:emit` + `node tools/gen-api.cjs`；Response DTO 不在 `swagger/models.ts` 登记就不进 openapi；`gen-api` 的 query 默认 `= {}` 只在**全字段可选**时给。
- **一份数据一个来源**（库表 → 快照段 → `apply*` 整表重建）；整表重建后派生 Map 必须重建；**管理端数据客户端零兜底**（初始空 / 0 / false，#724）。
- **「上限」类常量必须成对检查**（`ROLE_LEVEL_MAX` 与 `GROWTH_SCALAR_SPECS.max` 曾不同步，改一处会把合法值当脏数据拒）。
- babel loose：`Array.from` 替 `[...map.values()]`；客户端 tsconfig 无 ES2017 不用 `Object.entries`；`Map` 吃不下 `Partial<Record<>>`。
- 工具链：只信 Grep 工具（BSD grep 交替恒空）；批量替换 `perl -pi -e`（`sed -i ''` 异常）；`curl --noproxy '*'`；起端口前 `lsof`。
- **并发纪律**：amend 前确认当前分支；工作区异常先 `reflog` + `stash list`。

## 引擎坑（→ `cocos-*` 技能）
指针事件配 `UITransform`；`AnimationState` 手动 stop、`isValid(node, true)`；几何锚点是画布中心；自适应三层；Game 挂 Canvas → 五世界层建好再 `setWorldPosition(0,0,0)`（#692）；**显隐与摆位要绑定「片段是否就绪」**（#726）；`loadLoopFrames` 两形态探测（平铺图集 / 目录内同名图集）。

## 架构不变量（→ olua-server / olua-admin / olua-client）
- **服务端权威**；管理端 `@ApiAdminDoc({permissions})`、`BizException` 默认 400、乐观锁 409+20006、参数校验失败 **40000**；客户端零决策。
- `configs/` / `types/` 不引 UI 组件；方向恒为 `apply-snapshot → game-config → types`。
- 门禁看 CI；`make test-changed` 定向回归；`client-test` 基线红先怀疑本地 `network.ts` 硬编码 IP。
- 部分更新接口加数组字段要区分「显式传」与「存量漂移」，否则扩档旧调用被 400 卡死（#720）。
- 资源目录口径见 `client/RESOURCES.md`（14 顶层域平铺 + `ui/`）；改名三处同源：磁盘 + plist 自引用 → 库 19 个路径列 + `config-sync.sql` → 客户端 configs。
- **客户端只报格子，数值直读表**（#785 货币）；「玩家在哪」= 存档 `data.mapAt`；改 bag 数据收尾必须 `refreshBag()`。

## 部署（→ olua-deploy）
- compose 四服务：admin:80（唯一入口）/ game:8080 / server:3100 / realtime:3101。
- 管理端镜像 context = **仓库根**；出厂快照打进镜像（`.dockerignore` 放行 `data/config-sync.sql`）；卷 `olua_olua-data`（数据在 `-wal`）。
- `game.yimw.cn` 走管理端 nginx 按 server_name 反代 `game:80`；客户端地址由 `DEV_MODE` 唯一开关决定（#775）。
- 资源发布：`make resources-manifest/pack/upload VERSION=x`；清单先合 master 再传 Release。

## 进度（细节见 `memory/2026-*.md` 日报与技能）
- 收官批：#25~#37 战斗权威 · #259/#564 管理端 · #387/#394 社交 · #556 背包 · #566~#586 地图世界 · #596 存档权威 · #603/#626 快照层 · #643 药品 · #646/#651 选择器 · #653 配置同步 · #655 派生落库 · #667~#676 刷怪/NPC/碰撞 · #680~#685 音效 · #689/#693 跨端动作 · #722 泡点 · #724 去兜底 · #726/#730/#735 换装与战力 · #606 进图门槛 · #670 怪物 AI · #745 地图监控 · #747 死配置 · #749 边框选择器 · #751 怪物全配 · #753 资源重整 · #773 装备增删 · #775 局域网调试 · #777 批量装备 · #779 变体字段 · #781 变体并弹窗 · #783 属性曲线 · #785 货币道具 · #786 等级 100 万级曲线 · #787 升级卷轴。
- open：#669 刷怪区即时生效 · #9 包体积 · #12~#19 素材 · #295 阶段三 · #403 帮会战 · #742 站点 TLS · 掉落表未按新装备重算（`EQUIP_LEVEL_GAP` / `MAX_TIER_PER_SLOT`）· 本地库有未导出运营改动，`make config-check` 常红。
- 定保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
