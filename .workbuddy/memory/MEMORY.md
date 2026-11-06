# olua 长期记忆（索引；细节在 `.workbuddy/skills/` 与 `memory/2026-*.md`）

> **纪律**：issue → 分支 `type/n-slug` → PR（「关联 #n」）→ 本地 `make test-changed` → CI 绿 → squash → 手动 `gh issue close`（正文写「关联」不写 `Closes`）。
> 仓库 PUBLIC —— 密钥 / IP / 邀请码不进记忆。**website/ 永不改动**。docs-only 用户口头「更新」可直接推 master。
> 本机待办 `TODO-FOR-USER.md`（gitignore）。`gh issue/pr` 长正文一律 `--body-file`（内联反引号被 zsh 吞）。

## 过程纪律
- **测试锁「字段格式 + 行为」不锁数值**（运营随时改数）；用户说「数据我改过」= 停追红，改断言口径。
- **显示效果不写断言**（2026-11-05 明确定）：动画/特效的位置、尺寸、帧率、层级、对齐一律**人眼看**——这类断言只因正常调配置而红，真出错反而抓不到。只留素材存在性、执行顺序、结构接线。
- **e2e**：期望值从快照算；播种放 `startServer()` 之后；`checkEqual` 是 `===`；改 `server/src` 先 `npm run build`（e2e 跑 `dist/`）；本机绿 ≠ CI 绿（耦合断言超时盖过冷却周期）；`e2e-quest` 成功静默，判绿看 exit code。
- **假绿 > 漏检**：扫描器断言模块数、错误精确匹配文案、缓存 TTL 压 0。
- **新增一张表登记四处**：`config-tables.cjs` 两份清单 + `gen-api.cjs` MODULES + `audit-server-boundaries` REPO_EDGES + `audit-target.decorator` 类型。快照加段 = DTO / `snapshot()` / 客户端 `game-config.ts` 区 0 三处 + `audit-snapshot-contract` 守点。
- **config-sync.sql 加表**：只拼新增表的节 + 手改表头三行（整份重导有几千行假 diff）；`cp` 库前 `PRAGMA wal_checkpoint(TRUNCATE)`；校验拿「同 schema 库副本」做 `config-import --db`；`make config-check` 红在用户正改的表时别整份 export。
- 改 DTO 连描述都算改契约 → `swagger:emit` + `node tools/gen-api.cjs`；Response DTO 不在 `swagger/models.ts` 登记就不进 openapi。
- **一份数据一个来源**（库表 → 快照段 → `apply*` 整表重建）；整表重建后派生 Map 必须重建；**管理端数据客户端零兜底**（初始空 / 0 / false，唯一来源快照，见 #724）。
- babel loose：`Array.from` 替 `[...map.values()]`；客户端 tsconfig 无 ES2017 不用 `Object.entries`。
- 工具链：只信 Grep 工具（BSD grep 交替恒空）；批量替换 `perl -pi -e`（`sed -i ''` 异常）；`curl --noproxy '*'`；起端口前 `lsof`。
- **并发纪律**：amend 前确认当前分支；工作区异常先 `reflog` + `stash list`。

## 引擎坑（细节 → `cocos-*` 技能）
指针事件配 `UITransform`；`AnimationState` 手动 stop、`isValid(node, true)`；几何锚点是画布中心；自适应三层；Game 挂 Canvas → 五世界层建好再 `setWorldPosition(0,0,0)`（#692）；**显隐与摆位要跟「片段是否就绪」绑定**（#726）。

## 架构不变量（→ olua-server / olua-admin / olua-client）
- **服务端权威**；管理端接口 `@ApiAdminDoc({permissions})`、`BizException` 默认 400、乐观锁 409+20006。
- `configs/` / `types/` 不引 UI 组件；方向恒为 `apply-snapshot → game-config → types`。
- 门禁看 CI（PR 跑一次）；`make test-changed` 定向回归；client-test 基线 4 红（素材未入库）。
- 部分更新接口加数组字段要区分「显式传」与「存量漂移」，否则扩档旧调用被 400 卡死（#720）。

## 部署（→ olua-deploy）
- compose 四服务：admin:80（唯一入口）/ game:8080 / server:3100 / realtime:3101。
- 管理端镜像 context 必须是**仓库根**；出厂快照打进镜像（`.dockerignore` = `data/*` + `!data/config-sync.sql`，compose 给 `CONFIG_SNAPSHOT_PATH`）；卷 `olua_olua-data`，数据在 `-wal`。
- `game.yimw.cn` 走管理端 nginx 按 server_name 反代 `game:80`；客户端 `network.ts` 按 host 判本机/公网。
- 资源发布：`make resources-manifest/pack/upload VERSION=x`；清单先合 master 再传 Release。

## 进度
- 收官批（细节见日报 / 技能）：#25~#37 战斗权威 · #259/#564 管理端 · #293 对接 · #387/#394 社交 · #556 背包穿戴 · #566~#586 地图世界 · #437/#439 邮件 · #596 存档权威 · #603/#604/#626 出厂数据上服务端 + 快照层 · #605 运营参数收权 · #643 药品 · #646/#651 选择器体系 · #653 配置同步 · #655 派生数据落库 · #667/#672/#676 刷怪区/NPC/碰撞 · #680/#683/#685 音效 · #689 击杀跨端（观看端掉落纯演出）· #693 玩家动作跨端 · #728 各端图标统一取官网 logo · #733 选角选中态。
- **装备外观体系 #695→#720**（PR #696/#698/#701/#713/#715/#717/#719/#721）：`equipment_appearance` 单行表 → 拆「前后缀管理 / 装备边框 / 装备详情背景」三页 → 边框背景改**实体清单**（`border_items` / `background_items` 注册表 + 引用处并存，**清单 ∪ 引用**读法零迁移；effect 单一来源写时传播进引用处；被引用禁删，唯「文件夹同步」可绕开）+ 扫盘同步 + 别名/分组/分页 + 档位文字颜色。**快照结构与客户端契约全程不变**，旧客户端安全；**资源清单留客户端**，服务端只存 key 只校格式；坏数据自愈（坏整份回落出厂 / 坏条目丢弃）；客户端要重新打包才可见。
- **#722 泡点上移服务端**（PR #723 / `0b45e421`）：`SoakPointService` 每秒一醒按 `soakTickSeconds` 给在线角色入账；**tick 必须住 realtime 模块**（RolesModule 两进程都装会双份发经验）；「在线」= online_role_id；存量库拿新标量行靠 database.service 的 DDL 块 `INSERT OR IGNORE`（跑在快照自举之后）。
- **#724 客户端去兜底**（PR #725 / `71fba1f5`）：删 `BUILTIN_*_COLORS` 与各 `*Fallback*`；「无色」用 `new Color()` 工厂，不共享 Color 常量（会被引用方改）；缺行 = null 不演。
- **#726 / #730 / #735**（PR #727 `2b23866e` / #731 `ac125bd4` / #736 `3979cb44`）：换装错位靠 `onReady`/`isStale` + `clipsReady`（片段没就绪先藏节点）；**改 bag 数据的入口收尾必须 `refreshBag()`**（`updateUi` 不含背包，`BagDialog.refresh` 未开时 no-op）；战力抖动 = realtime 配置缓存漂移（按 `REALTIME_CONFIG_REFRESH_MS` 定期重装）+ 客户端迟到帧（`applyServerRoleUpdate` revision 守卫整帧丢）。
- **#606 进图门槛上移服务端**（PR #743 / `dbdcd48f`）：判据唯一一处 `MapService.enterRejectOf()`（不下发中文，文案归客户端 `configs/texts`）；**「玩家在哪」= 存档字段 `data.mapAt`**（进 `SERVER_EXCLUSIVE_FIELDS`，唯一正常写点是被接受的 `worldJoin`，`setMapAt` 不推 revision）。**三条边界缺一就锁人或漏拦**：目标图 == `mapAt` 放行 / `mapAt` 缺失放行 / 图无配置行放行。协议 `mapEnter`（意图）+ `mapEnterResult`（放行与被拒同形），客户端「本地预检 → 请求 → 放行才 `applyMapChange`」，**不能先切图再等拒绝**。
- **#670 怪物 AI 全上服务端**（PR #744 / `e6e091de`）：`MonsterAiService` 唯一决策处，客户端只剩「趋近 + 按事件播动作」。三条一致性链路 —— 位置（`withLiveMonsterPositions()` 发帧前覆盖，快照里是**存库出生点**且增量帧「有变化才发」）/ 血量（`monster-ai` 帧必填 hp）/ 行为（客户端零决策）。**「对尸体放技能」= 认结算结果**：`applyMonsterHit` 返 null → `forgetTarget`，`castSkill()` 先结算再落账。击退也在服务端（`applyPush`，时长取 `runtime_params.monster_ai.pushDuration`）。坑：`skillOf()` 返回**驼峰**对象；参数缺字段 → `pushEndAt = NaN`。
- **#745 地图监控精细日志**（PR #746 / `0499f4a7`）：文字流扩到六类（+damage/chase/cast/hit）。**数值来自结算、过程来自 AI**——`hpBefore = hpAfter + amount` 反推保证「65 → 56（-9）」自洽；`onLog` 走**单向回调**（监控服务已依赖 AI，注入即循环依赖）；「目标丢了」四种成因分开；**姓名要自己缓存**（离线那刻在场表已没人）；`mapMonitorEventKeep` 2000。管理端：毫秒 + 间隔、六类分色、类型 chips 带条数、点地图上的怪只看它。
- **#747 清弹窗死配置**（PR #748 / `85254b79`）：删 `createDialogTitle` / `createCloseButton` 与 4 处死字段（`dialogFrame.title.defaultPosition/defaultSize`、两处 `titleColor/titleFontSize`、`guildDialogLayout.member` 的两个 `position`）。方法 = 真编译配置 × 扫 `assets/ui/**/*.ts` 成员访问链取差集（脚本一次性、不挂 CI，→ `cocos-ui-layout-config` 六之二）；**真死字段的共同特征：注释写的用途已和代码现状不符**；**经参数传递的不许删**。九宫化后 `createDialog` 的标题 / 关闭按钮几何本身没问题。
- **#749 边框/背景关联改可视化选择器**（PR #750 / `4c105a89`）：棋盘每格 `GameFrame + Select`（84 条原始 key）→ 「帧动画预览 + 别名 + key」整块按钮 + `EntityPicker`。**不新造选择器**：`EntityOption.image.animate` 开逐帧播（缺省仍首帧）、`EntityPicker(List)` 加 `imageSize`（默认 32，这类 56）、`catalog.appearanceOptions()` 把清单条目直接映射成选项（别名当 label、分组当 group，缺省「未分组」否则 chips 漏条）。引用已不在清单里要**照实显示 key 并标黄**（客户端对坏 key 安静跳过）。服务端/快照/客户端零改动。
- open：#669 刷怪区即时生效 · #9 包体积 · #12~#19 素材 · #295 阶段三 · #403 帮会战 · #742 站点 TLS（线上只监听 80）。
- 定保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
