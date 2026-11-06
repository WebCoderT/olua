# olua 长期记忆（索引；细节在 `.workbuddy/skills/` 与 `memory/2026-*.md`）

> **纪律**：issue → 分支 `type/n-slug` → PR（「关联 #n」）→ 本地 `make test-changed` → CI 绿 → squash。
> 仓库 PUBLIC —— 密钥 / IP / 邀请码不进记忆。**website/ 永不改动**。docs-only 用户口头「更新」可直接推 master。
> 本机待办 `TODO-FOR-USER.md`（gitignore）。

## 过程纪律
- **测试锁「字段格式 + 行为」不锁数值**（运营随时改数）；用户说「数据我改过」= 停追红，改断言口径。
- **显示效果不写断言**（用户 2026-11-05 明确定）：动画/特效的位置、尺寸、帧率、画布对齐等观感一律**人眼看**。这类断言只会因为正常调配置而红，真出错（错位/太小/没播）反而抓不到。可留的只有：素材存在性（缺文件=静默不播）、代码执行顺序（如帧装载完再藏站立帧）、结构接线（按钮有没有绑事件）。
- **e2e**：期望值从快照算（`server/test/lib/config-snapshot.cjs` 的 rows/index/group）；播种放 `startServer()` 之后；`checkEqual` 是 `===`；改 `server/src` 先 `npm run build`（e2e 跑 `dist/`）；本机绿 ≠ CI 绿（耦合断言等一帧同时满足两边，超时盖过一个冷却周期）。
- **假绿 > 漏检**：扫描器断言模块数、错误精确匹配文案、缓存 TTL 压 0。
- **新增一张表的登记四处**：`config-tables.cjs` 两份清单 + `gen-api.cjs` MODULES + `audit-server-boundaries` REPO_EDGES + `audit-target.decorator` 类型。快照加段 = DTO / `snapshot()` / 客户端 `game-config.ts` 区 0 三处 + `audit-snapshot-contract` 守点。
- **config-sync.sql 加表**：只拼新增表的节 + 手改表头三行（整份重导会有几千行假 diff）；`cp` 库前 `PRAGMA wal_checkpoint(TRUNCATE)`；校验拿「同 schema 库副本」做 `config-import --db`。**`make config-check` 红在用户正在改的表时别整份 config-export**。
- 改 DTO 连描述都算改契约 → `swagger:emit` + `node tools/gen-api.cjs`；「管理页看不到新行」= 服务端 seed 没跑 → 重启 3100。
- **一份数据一个来源**（库表 → 快照段 → `apply*` 整表重建）；整表重建后派生 Map 必须重建。
- babel loose：`Array.from` 替 `[...map.values()]`；客户端 tsconfig 无 ES2017 不用 `Object.entries`。
- 工具：只信 Grep 工具（BSD grep 交替恒空）；批量替换 `perl -pi -e`（`sed -i ''` 异常、perl 里 `$(` 特殊）；`curl --noproxy '*'`；起端口前 `lsof`；行尾 `grep -c $'\r'`。

## 引擎坑（细节 → skills）
- 指针事件配 `UITransform`；`AnimationState` 手动 stop、`isValid(node, true)`；几何锚点是画布中心；自适应三层；**Game 挂 Canvas → 五世界层建好后 `setWorldPosition(0,0,0)`**（#692）。

## 架构不变量（→ skills olua-server / olua-admin / olua-client）
- **服务端权威**；管理端接口 `@ApiAdminDoc({permissions})`、`BizException` 默认 400、乐观锁 409+20006。
- `configs/`/`types/` 不引 UI 组件；方向恒为 `apply-snapshot → game-config → types`。
- 门禁看 CI（PR 跑一次）；`make test-changed` 定向回归；client-test 基线 4 红（素材未入库）。

## 部署（→ skill olua-deploy）
- compose 四服务：admin:80（唯一入口）/ game:8080 / server:3100 / realtime:3101。
- 管理端镜像 context 必须是**仓库根**（引 server 常量）；出厂快照打进镜像：`server/.dockerignore` = `data/*` + `!data/config-sync.sql`，compose 给 `CONFIG_SNAPSHOT_PATH`；验收前等健康检查；卷 `olua_olua-data`、数据在 `-wal`。
- `game.yimw.cn` 走管理端 nginx 按 server_name 反代 `game:80`；客户端 `network.ts` 按 host 判本机/公网。
- 资源发布：`make resources-manifest/pack/upload VERSION=x`；清单先合 master 再传 Release。

## 进度
- 已收官（细节见日报 / skills）：#25~#37 战斗权威 · #259/#564 管理端 · #293 对接 · #387/#394 社交玩法 · #556 背包穿戴 · #566~#586 地图与世界 · #597/#598 · #437/#439 邮件 · #596 存档权威 · #603/#604/#626 出厂数据上服务端 + 快照层 · #605 运营参数收权 · #643 药品 · #646/#648/#651 选择器体系 · #653 配置同步 · #655 派生数据落库 · #667/#672/#676 刷怪区/NPC/碰撞收后台 · #680/#683/#685 音效 · #689 击杀跨端（观看端掉落纯演出）· #693 玩家动作跨端（三路负载合并成一帧）。
- **#695 装备外观收权（PR #696 / `b31b9203`）**：`equipment_appearance` 单行表（四 JSON 列：15 组前后缀→边框/背景 + 特殊装备自定义）+ `GET/PATCH /admin/equipment-appearance` + 快照段 `equipmentAppearance` + 管理端「装备外观」棋盘页。**资源清单（key↔磁盘图集）留客户端**，服务端只存 key 只校格式、不校素材存在；坏数据自愈（映射坏整份回落出厂、自定义坏条目丢弃）；客户端无本地兜底（快照前 Map 为空）。旧客户端不消费新段，安全。改动要等客户端重新打包才可见。
- **#697 档位 CRUD + 变体重建（PR #698 / `62fcefcc`）**：「装备配置」页加「前后缀档位」弹窗（equipment_meta 四数组整份替换，1~10 档）+ `POST /admin/equipment-variants/rebuild`（属性=round(基础×前缀倍率×后缀倍率)、label/level 取基础件、**卖价保留**仅新组合公式垫底、`replaceAll` 事务重建）。外观 15 格改按 meta **文案长度**派生（扩档回落公式外推），棋盘动态渲染；客户端零改动。
- **#699/#700 边框/背景拆页 + 显示效果（PR #701 / `2bf2bdc4`）**：拆「装备边框」「装备详情背景」两页，端点拆 `GET/PATCH /admin/equipment-borders|backgrounds`（整边替换互不覆盖）；每条数据可带 `effect {x,y,scale}`（第一帧基准，缺省 = 现状），管理端首帧预览 + 效果工作台（拖拽/滑杆）；客户端详情弹窗重构（外层精灵 + 背景子节点 + 内层 content Layout），渲染应用 effect——**要重新打包才可见**。快照段结构不变，旧客户端安全。教训：Response DTO 必须在 swagger/models.ts 登记才会进 openapi。
- **#712/#714 前后缀独立页 + 边框/背景实体清单化（PR #713 / #715 / `d331f0b0`）**：「前后缀管理」页（档位 CRUD + 关联棋盘只做下拉引用）；边框/背景页 = 清单本体（key+effect，`border_items`/`background_items` 注册表列，快照与客户端契约零改动）；**清单 ∪ 引用**读法（老数据零迁移）、effect 单一来源写时传播进引用处、被引用禁删（PATCH 路径）。
- **#716 边框/背景从文件夹同步 + 表格化（PR #717 / `ae9be926`）**：`GET .../resources` 扫盘预览 + `POST .../sync` 以文件夹为准重建清单（effect 存活保留；**被引用条目也允许移除**——同步是唯一绕开「被引用不可删」的写路径，引用处显示异常 = 接受口径）。素材目录 `EQUIPMENT_APPEARANCE_RES_DIR`（缺省 `../client/assets/resources`；compose 挂 `game/resources` 只读到 server）。清单页改表格 + key 过滤。e2e 坑：spawn 子进程读不到测试中途的 env → env 起服前定好，目录坏/空用现场增删文件演；POST 默认 201。
- **#718 清单别名/分组 + 分页（PR #719 / `11bc0354`）**：清单条目加可选 `name`/`group`（≤32 字，纯管理端属性，快照不消费 items 客户端零改动）；同步整条保留（savedByKey 存整 item）；管理端表格加两列、过滤匹配 key/别名 + 分组下拉、客户端分页 20 条/页；引用处下拉显示「别名（key）」。DTO 空串放行（`@Length(0,..)`）service 归一化丢弃——写 `@Length(1,..)` 会把空串 400 拦住。e2e：受控 PATCH 互相覆盖，断言顺序按「写读→清空→摆回前提→同步」排。
- **#720 档位文字颜色收管理端（PR #721 / `255af1fd`）**：equipment_meta 加 `prefix_colors`/`suffix_colors`（`#RRGGBB`，与文案同下标；空数组=客户端内置色），快照 equipmentMeta 段下发（同段加可选字段不动 SNAPSHOT_SECTIONS）；客户端内置色降级为逐档回落值，**要重新打包**。PATCH 语义：显式传颜色才校验等长/空数组，没传而档数变了自动对齐（截短/末色垫补）——给部分更新接口加数组字段要区分「显式传」与「存量漂移」，否则扩档旧调用被 400 卡死。
- **#722 泡点上移服务端（PR #723 / `0b45e421`）**：realtime 模块 `SoakPointService` 每秒一醒、按 `soakTickSeconds` 拍给在线角色入账 `soakExpPerTick`（走 applyKillExp 升级链路 + 满级短路）。**tick 住 realtime 模块**（RolesModule 两进程都装会双份发经验）；「在线」= online_role_id（心跳清算兜底）。参数收 growth_scalars 两行（出厂 0=关闭）；**存量库拿新标量行** = database.service DDL 块（跑在快照自举之后）INSERT OR IGNORE。e2e 泡点断言用 revision 增量（rate 大时 exp 被升级消耗是正确表现）。
- **#724 客户端去管理端数据兜底（PR #725 / `71fba1f5`）**：新纪律 = **管理端数据客户端零兜底**（初始 空/0/false，唯一来源快照；0/空只在加载期）。删 `BUILTIN_PREFIX/SUFFIX_COLORS`（没给 = 空表不染色落白）、`upgradeEffectDefaults`/`dropLightFallbackDurations`/`mergeUiEffect`（缺行 = null 不演）、`dropRuntime`/autoBattle 可调字段/mpRecover/roleMaxLevel 出厂值（初始 0）。工具链三处灌表传颜色（factory-data equipmentMeta 补 colors + sandbox + client-config-compile）。「无色」回落用 `new Color()` 工厂，不共享 Color 常量（会被引用方改）。客户端要重新打包才可见。
- **#726 换装瞬间错位修复（PR #727 / `2b23866e`）**：外观未预加载时片段异步装载、旧片段还在播，而 `applyOutTransform` 同步摆新偏移 → 「旧帧+新偏移」错位。修法：`useManyNameAnimation` 加 `onReady`/`isStale` + `clipsReady`，`RoleAppearance.loadAnimation` 片段没就绪先藏节点（加载期显示为空）、装载完成才显示。纪律：**显隐与摆位要跟「片段是否就绪」绑定**；`gh issue/pr` 长正文一律 `--body-file`（内联反引号被 zsh 吞）。
- **#730 背包开着拾取不刷新（PR #731 / `ac125bd4`）**：`applyPickResult`（picked 帧落账）漏了 `RoleUIManager.refreshBag()`，补 `if (placed.length) refreshBag()`。纪律：**改 bag 数据的入口收尾必须带 refreshBag**（`updateUi` 只刷信息栏/底栏/血条，不含背包）；`BagDialog.refresh` 弹窗没开时是 no-op。
- **#735 战斗力抖动修复（PR #736 / `3979cb44`）**：根因双叠——① realtime 进程配置缓存漂移（refreshAll 进程内，管理端写后只有存档进程重装）→ realtime 按 `REALTIME_CONFIG_REFRESH_MS`（默认 10s）定期重装；② 客户端迟到帧回跳 → `applyServerRoleUpdate` revision 守卫（旧帧整帧丢）。体验：RoleInfoBar.updateCombat 变化驱动 + ±战力飘字（上升绿/下降红）。边界白名单加了 `realtime → game-config/runtime-config.service`。**并发纪律：amend 前必须确认当前分支；工作区异常先 reflog + stash list**。
- open：#669 刷怪区即时生效 · #9 包体积 · #12~#19 素材 · #295 阶段三 · #403 帮会战 · #742 站点 TLS（线上只监听 80）。
- 定保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- **#728 各端图标统一取自官网 logo（PR #729 / `26fccd2c`）**：`tools/gen-app-icons.py`（`make icons`）以 `website/assets/icons/logo-512.png` 为唯一来源，生成 管理端 `admin/public`（真·多尺寸 ICO 16~256 + 256 png）/ `build-templates/web-desktop`（原来引 favicon.ico 但文件从不存在 = 每次构建 404，已补 + index.ejs 三个 link）/ mac·iOS `AppIcon.appiconset`（按 Contents.json 逐条，1024 档由 512 放大）/ Android mipmap / Win .ico（不存在则跳过）。apple-touch-icon 必须**不透明底合成**（iOS 把透明渲染成黑）。**`client/native` 在 .gitignore** → 原生图标只落本机，换机器或重新生成原生工程后重跑 `make icons`；版本化的是脚本 + 官网 logo。mac 打包 Info.plist 的 `CFBundleIconName=AppIcon` 证明资产目录生效（`native/engine/mac/Icon.icns` 是模板残留）。
- **#733 选角选中态（show 动画 + 脚下特效）+ 显示效果零断言（PR #734 / `cc663253`）**：`GameUiHelper.setRolePreviewSelected` 按名字切换三个子节点（`*_stand_animation` / `*_show_animation` / `*_select_effect`，后缀常量模块级）；show 与特效首次选中才建、show 等帧装载完再藏站立帧（防闪空白）；特效 `setContentSize` + `SizeMode.CUSTOM`（RAW 会被每帧 sourceSize 覆盖回 134×72），offset/size 全走 `roleSelectorLayout.selection.effect`。白框（Graphics）及其配置已删。**测试纪律：显示效果不写断言**（帧率/尺寸/坐标/颜色/对齐/层级一律人眼看），只留素材存在性、取图单一来源、结构接线与执行顺序；据此删 4 个纯几何测试文件（layout-row-bbox / dialog-row-bounds / skill-row-layout / role-attr-list）。
- **#606 进图门槛上移服务端（PR #743 / `dbdcd48f`）**：判据唯一一处 `MapService.enterRejectOf(mapId, {level,combat,soulOfWar}) → {field,need,mapLabel} | null`（不下发中文，文案归客户端 `configs/texts` 的 `reject_map_level/combat/soul`）。**「玩家在哪」= 新存档字段 `data.mapAt`**（进 `SERVER_EXCLUSIVE_FIELDS`，客户端上报被回填；唯一正常写点是被接受的 `worldJoin`，`roles.setMapAt` 用 `updateDataKeepRevision` 不推 revision；管理端 PATCH `onMap` 同时写 `mapAt`）。**三条边界少一条就锁人或漏拦**：目标图 == `mapAt` 无条件放行（登录/重连不是换图，#573 的教训）/ `mapAt` 缺失放行 / 图无配置行放行。协议 `mapEnter`（意图，不动世界状态）+ `mapEnterResult`（放行与被拒同形，`worldJoin` 被拒也发同一帧）。客户端三段：本地预检 → `requestMapEnter()`（3s 超时按本地判据放行，`cancelMapEnter` 不回调）→ 放行才 `applyMapChange`——**不能先切图再等拒绝**（卸了旧场景人已在空图里）。e2e 38 套；`e2e-quest` 的 `check` 成功静默（只打失败），判绿看 exit code。
- **#670 怪物 AI 全部上服务端（多端画面一致）（PR #744 / `e6e091de`）**：`MonsterAiService` 是唯一决策处，客户端 `MonsterAI.ts` 只剩「趋近 + 按事件播动作」（465→220 行，本地 AI 全删，`serverAuthority` 开关也没了）。**三条一致性链路**：位置（`RealtimeService.withLiveMonsterPositions()` 在 world 帧发出前覆盖 `x/y`，因为快照里的坐标是**存库出生点**且增量帧「有变化才发」→ 站着不动的怪永不纠正）/ 血量（`monster-ai` 帧必填 `hp/maxHp`，`moved || turn || hurt` 才发；`hits` 只发给出手者本人）/ 行为（客户端零决策）。**「对尸体放技能」的正解 = 认结算结果**：`applyMonsterHit` 返回 null → `forgetTarget(accountId)`（删位置记录 + 清所有怪指向该账号的 target），`castSkill()` 先结算再落账（无 hit 不记冷却/不进硬直/不发 casts，返回 false）。**击退也在服务端**：`applyPush(instanceId, fromAccountId, distance)`，方向 = 施法者→怪，时长取 `runtime_params.monster_ai.pushDuration`（新字段 200），击退优先于施法硬直，落点走普通位置广播（无新协议帧）；客户端 `stepServer` 追赶步长 `max(moveSpeed, distance/0.2s)`。坑：`skillOf()` 返回**驼峰**归一化对象（`pushDistance`），写 `skill.push_distance` 静默拿 undefined；`MonsterAiParams` 缺字段 → `pushEndAt = NaN` 击退永不生效。e2e `e2e-monster-ai`（17 条，套数 38→39）：`pickPointInArea(cx,cy,0,0)` 钉死怪、量距离前必须等停稳（连续两拍 <0.5px）、死者场景用「客户端持续上报 hp=100 假装活着」钉死前提。
