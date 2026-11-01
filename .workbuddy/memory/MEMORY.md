# olua 长期记忆（索引，细节见 skills 与 2026-*.md）

> 纪律：一切提交走 issue → 分支 `type/n-slug` → PR（`Closes #n`）→ CI 绿 → squash；docs/记忆同样；写日志前先切分支。一个 PR = 一个功能；全绿才提交（`make ci`，数字实测）。记忆/技能随仓库提交；仓库 PUBLIC —— **IP / 私钥 / 邀请码 / JWT 不进记忆**。
> **分支只剩 `master`**（2026-11-02 清理）：portrait（移动端竖屏）按用户要求删除，原 SHA `7e52900bd4055d0fbb77439dc66bdf2e38f86531`（`git branch portrait <sha>` 可找回）；
> 其余 11 条都是「功能早已 squash 进 master、分支本身没被 `git branch --merged` 认出来」的残留 —— **判断依据是内容（文件/模块是否存在 + 有无独有提交），不是 `--merged`**。

## 会再犯的坑（守点 = 脚本，细节见对应 skill / 日志）
- **环境相关不进生成物**：清单带 `hasAsset` 会让逐字节守点在 CI 必然假红 → 运行时 `HEAD` 探测（403/404/410 才算缺）。
- 只信 Grep 工具（BSD grep 不吃 `\|`，恒空≠已改完）；批量替换 `perl -pi -e`；改完看行尾（`GameUiHelper.ts` 是 CRLF）与 `make client-check`；编辑器回写 `sleep 20` 复检。
- 服务端/子进程 `env -u NODE_OPTIONS`；`curl --noproxy '*'`；起端口前 `lsof` 探占用。
- **代码生成**：一份数据只能一个来源（`configs` → `game-data.generated.ts`），守点 =「重生成 + 逐字节 + 结构断言」；派生清单不钉住会静默毁数据。
- **「保存即生效」= 三件事，缺一件都表现为「保存没生效」**（#513）：服务端存值（**没有行 = 出厂值**，重置 = 删行且幂等）；客户端**覆写前先还原出厂值**（否则删行在重进后仍是旧位置）；**几何每次进图都拉**（快照只拉一次，被 short-circuit 挡掉会被当成功能没做）。
- **浅拷贝共享的是数组引用、不是字段**：15 个变体共享 `outPositions` 数组，`outScale`/`outManual` 各自 → 按基础件命中全部变体必须逐个对象赋值。
- **注释说 A、代码做 B 时先统一**：`ConfigLoader` 原写「重进即见新值」而代码短路 —— 自相矛盾的注释会被下一个人当成事实。
- **枚举只能一处来源**：审计目标类型从 `@AuditTarget` 派生、查询与写入共用（此前写死 5 种，`equipment`/`title` 筛不出来）。
- **babel loose**：`[...map.values()]` 装的是迭代器不是内容 → Map/Set 一律 `Array.from`（守点 `audit-iterator-spread`）。
- **指针事件必须配 `UITransform`**（3.8.7）：否则抛 `cameraPriority` 空指针、输入全废；静默跳过会吞证据。
- **动画节点的「引擎自己收尾」不可信**（3.8.7 的坑，#560）：带循环片段的节点 `destroy()` 后 `AnimationState` 会留在**全局** `AnimationManager` 里，每帧往已销毁的 Sprite 写 `spriteFrame` → `_applySpriteSize` 读 `self.node._uiProps` 抛错、一帧一条永不停歇（打怪 + 换图成批销毁时最容易命中）。必须自己在 `NODE_DESTROYED`（引擎**先**发它、**再**销毁子节点与组件）里**逐个 `state.stop()`** —— `animate.stop()` 只停 cross-fade 权重、状态还在管理器里。另：`destroy()` 同帧内 `isValid(node)` 仍是 true（只进了 `ToDestroy`），起动画前要用 `isValid(node, true)`。
- **自适应分三层**（模板 / `applyScreenPolicy` / 场景贴边），模板只在 GUI 构建生效；游戏内坐标一律以相机为准。
- **飘字**跨场景挂场景里的 `Canvas`（不是场景根）；行内文字按 bbox 验（CLAMP + 左对齐从框左缘起排），装不下要 `enableWrapText` + 行高自适应。
- **几何**：位置按帧内容 bbox 运行时算、配置只当微调（内容中心 = 节点中心 + `offset`，y 向上；衣服缩放要乘；空帧按面积判 4；`spriteSourceSize` 只有 2 个数）；改语义要渐进（`outManual`）。**外观锚点是画布中心、不是脚下**：`outPositions=0` 只是「画布中心落在脚下」，画布底部留白 25~66 → 全 0 会让身体沉到地下（裸模沉 31，#517）；判据（地面线/碰撞盒）固定在宿主原点，尺寸从 `catalog.body` 取。
- **并一张表还是分两张，判据是「重置要不要互不牵连」**（外观 8 向 / 内观 1 点两轴，#523；字段形状不同不算理由）。`outManual`/`inManual` 这类开关的作用是**挡住运行时算法当场覆盖刚存的值**，不是「给个备用值」；实测出来的基准（圆盘 `(-82.5,-149.5) r=90`）写进派生清单并注明「换图要重测」。
- **「保存即生效」先写清「用户会用什么动作看效果」，再决定拉取时机**（#527）：外观的验收动作是退回选角再进图（场景重载），内观是**再点开弹窗**（场景没重载）—— 同一条「每次进图拉一次」一个够用、一个必然失败。**布尔开关决定「客户端读不读这条数据」时，保存路径必须替用户兜住**（`inManual=false` 的行客户端整个不读，而「拖完就保存」正好是这条路）。**空 `catch` 会把 404 伪装成「没生效」**（界面无差、日志空白），失败可以不挡流程但要 warn。验收脚本动生产数据前先抓快照、跑完按原值写回（曾差点删光用户数据）。
- **拖拽工作台：命中要给「内容不可见」留路，位移要封顶**（#531）：要求点中内容矩形 → 内容飞出格子后**永远抓不回来**（死锁；只能靠方向键挪 170 单位）。`(指针-起点)/zoom` 不封顶 → 指针移出画布仍累加，一次就能把数据甩坏。画面为空时数字是唯一线索（标琥珀 +「出格」）。**提醒里带三步操作 = 等于没做**（对着基准一键做完并落库）。「保存没生效」先分诊：查库 + 读「N 件未保存」计数 + 看写请求，三者一对就知断在「没改动 / 改了没存 / 存了没生效」，别直接改保存链路。
- **「以视觉为准」要翻译成一个能最大化的量**（#539）：素材里混着披风 / 翅膀 / 飘带 / 影子 / 光效时，任何人体锚点（脚底中心 / 质心 / 躯干 / 头顶 / bbox 中心）都会被大面积装饰带偏 —— 同一件衣服 8 个方向的 x 跨度能到 20~84 单位（裸模自己只差 ±1，这就是现成的验收指标）。可用的判据是**行 / 列直方图的「逐行（列）取小求和」互相关**：`min` 让披风再宽也最多贡献「裸模那一列的像素数」，先对 y 再对 x，跨度降到 4~27。NCC 会退化（窄衣服时 sx 在 -63/+43 乱跳）。**bbox 的极值由"最远的那一个像素"决定** —— 1 个孤立噪点、一根飘带就能把"脚底"拉低 30 单位，所以行列计数 ≥ 2 才参与。
- **假绿 > 漏检**：扫描器吞异常会「扫 0 个也全绿」（要断言模块数）；错误断言精确匹配文案；重试写进被测助手；缓存逻辑 TTL 压 0。- **节点名用 key 不用图标**（`find()[0]` 会拿错）；空态文案不能跨状态复用；`{type:"error"}` 是拒绝的唯一出口；乐观 UI 要用服务端既有信号确认。
- **被复核对象不能挡住判据**（#535）：工作台的第一判据是眼睛，遮挡层次属于「被复核的东西」→ 列对齐默认把装备画在裸模之上（`itemTop` 开），按游戏层序复核只是偶尔做的开关。同理：**参考框一律压在所有图像之后画**（跟着各自图像画，身体在下面时框会被装备盖住 = 判据消失）。**嵌套对象的本地偏好要逐项合并默认值**（`{...fallback, ...parsed}` 会把整个 `guides` 顶掉，新字段 undefined = 新开关在老浏览器静默失效）。像素级判据用**量级**不用严格 0（1px 线状标记重绘会抖几十像素：正面 41~83 vs 整件衣服 800~1150）。
- **「尺寸取客户端、内容取库里」的回填要逐格保坐标**（#556）：`adoptBagShape` 首版按行优先把物品压紧进新网格
  → 每次存档都把玩家拖好的物品挤回左上角（拖动 = 白拖）。判据不是「数量没丢」，而是「坐标没变」；
  装不下（配置改小）时整份退回原网格，不静默挪位置。
- **给权威清单加字段 = 必然有一批测试在测「客户端能改它」**（#550 踩四套 / #556 踩三套：combat / dual / game-config）：
  先 `grep "PUT roles/"`，把造状态改成管理端 `PATCH /admin/roles/:id`（equipments/skills/bag 都支持结构化编辑）。
- **文档数字**：加审计/单测会连坐 FAQ/各端 README/官网/skills（`audit-doc-numbers` 给行号），双语还要数字次数相等（`audit-docs-en`）。**中英必须一起改**（只改中文会被判「中文多 1 次」；`0.5 透明` vs `50% opacity` 这种同义异写也算不等）；新页面还要补 `admin/README` 的页面表与结构树 —— 数字审计只管数字，漏行它不管。
  **根 README 从 #575 起不写数字句式**（「N 个接口 / 共 M 条 e2e」全删）：`audit-doc-numbers` 只在**匹配到句式**时校验、没有 MISS 检查，所以「不写」= 永不漂；比对处数从 58 降到 35（其余在 FAQ / 各端 README / 技能）。代价是 **`audit-docs-en` 的数字 multiset 仍要相等** —— 精简时中文写「三处 / 两个维度」而英文写 `3 / 2` 就会红，统一改成不带数字的写法最省事。
- 真机验证：真实 Chrome `headless:false` + playwright-core；自适应只测真实窗口（`viewport:null`）；`window.__cc` 要等 `__v.ready()`，`reload` 后重新 `ready()`。

## 架构不变量（细节 skill `olua-server` / `olua-admin` / `olua-client`）
- 服务端权威：伤害/掉落/经验/进度/金币一律服务端算，客户端只演。
- 管理端接口必须 `@ApiAdminDoc({permissions})`；角色数据是不透明文档（`guide` 例外：只校验结构、**不补默认值**）；乐观锁 409+20006；`whitelist` 要 DTO + `@Type` + 登记 `SWAGGER_MODELS`；排序白名单 `sort-specs.ts`；`BizException` 默认 400。
- 新 operationId 模块段登记 `tools/gen-api.cjs` 的 `MODULES`；新仓储登记 `audit-server-boundaries` 的 `REPO_EDGES`；新 e2e 登记 `audit-doc-numbers` 的 `E2E_SCRIPTS`。
- 部署：compose 四服务（admin:80 / game:8080 / server:3100 / realtime:3101），`/api` 与 `/game-resources/` 反代到内网；密钥只在 `deploy.env`；先合 master 再发布；Cocos 只能 GUI 打包。
- 本机 client-test 基线 **59 套 / 54 过 5 红**（红全是素材未入库）；CI 不跑它，门禁看 `make ci`。改了客户端动手最勤的地方（换装/背包/动画）要**自己跑一遍** `make client-test`，否则静态断言的假红会攒着没人发现（#557 就漏了一处）。

## 进度（细节见 2026-*.md）
- 已收官：战斗权威 #25~#37 · 管理端 #259 · 客户端对接 #293 · 社交 #387 · **玩法补全 #394 十二刀**。
- 2026-10-29：窗体感收尾 → 真机验证第三轮 #491~#498 → 位置对齐 #505/#506 → 对齐工作台 #509/#510 → **几何保存即生效 #513/#514**（新表 `equip_aligns` + `apply-snapshot` 例外之一）→ **裸模落地 #517/#518**（出厂几何按素材量，工作台以地面为准）→ **内观对齐 #523/#524**（新表 `equip_in_aligns`：衣服对圆盘、武器对第一件衣服，`inManual` 短路）→ **内观修复 #527/#528**（手势/写库自动开手调 + 开弹窗再拉一次 + 失败要 warn）→ **裸模拖拽修复 #531/#532**（飞出格子也能拖回、位置夹紧、出格标琥珀、横幅一键贴地并存库）→ **装备置顶 #535/#536**（背对 4 朝向不再被身体挡住，参考框统一压最上层）→ **12 件衣服批量对齐 #539**（行/列直方图互相关，数据落 `equip_aligns`，备份 `/tmp/olua-before-cloth-align.db`）。
- open：#8 官网 / #9 包体积 / #12~#19 素材 / #295 阶段三 / #403 帮会战。定保持现状：技能 1011 / 快捷键 6 格 / 药品 3 档 / 装备 7 部位。
- 2026-10-31：**背包与穿戴收权 #556** —— `bag`/`equipments`/`skills` 进权威清单（8 → 11 字段），
  `POST /roles/:id/bag-op` 一个接口五个动作（equip/unequip/discard 服务端算，move/tidy 只验守恒），
  `bag` 尺寸特例（内容取库里、尺寸取客户端、逐格保坐标）；客户端六个方法改 async 走 `runBagOp`。
- 2026-11-01：**管理端风格全站统一 #564/#565**（技能 `olua-admin-ui` + PageHeader/Modal/FilterBar 组件层 + 紧凑档 + 审计 `audit-admin-ui`）
  → **地图原点改左上角 #566**：地图节点锚点 (0,1)（**必须在 `tmxAsset` 赋值之前**，否则图层按旧锚点绘制 = 整体偏半张图），
  Tiled 坐标只剩 `(x,y)→(x,-y)`；刷怪区快照换口径 + `world_meta.coord_origin` 标记的一次性平移；守点 `audit-map-origin`。
  **补丁 #568**：光设锚点不够 —— 图层 `leftDownToCenter` 只在 `onEnable` 之后才跟着锚点事件重算，先建图后入场景会停在旧值
  （瓦片照旧铺中心 = 进图**整屏黑**，手动改一次锚点反而能看见），建完图必须逐个图层补一次 `_syncAnchorPoint()`。
  **判据**：整屏黑 = 这条；有图但偏半张图 = 锚点设在赋值之后。
  **精简 #570**：换算只剩 3 个导出（`mapPointToWorld` / `mapRectCenterToWorld` / `getMapWorldRect`），不再收 `map` 参数；
  前提是**地图节点恒在世界原点**（守点：`LayerManager.move` 不许动 MapLayer）。
- **管理端地图管理 #571（观测）/ #573（玩法配置可改）**：`GET /admin/maps` + `/:id`（`gameConfig:read`）+ `PATCH /:id`（`gameConfig:write`）；
  e2e 钉死 POST/PUT/DELETE 404（**没有新建/删除地图**：图存不存在由客户端 TMX 决定），响应带 `sources`（`db`/`config`/`snapshot`）供页面打徽标。
  `groups` 是 Tiled 原始口径、`spawnAreas` 是世界坐标，判据 = **同一个矩形的中心对得上**。
  两个坑：`new BizException(code,msg)` **默认 400**（要 `BizException.notFound`）；地图类型名/顺序的唯一来源在服务端 `MAP_TYPE_LABELS`。e2e `e2e-map.cjs` 122 条。
- **地图玩法配置归服务端 #573**（用户：「客户端不存储这些东西」）：客户端 `configs/map.ts` 只剩**资源约定**（`mapSrcOf` = `map/<id>/<id>`、对象组/属性名），
  `mapData` 11 条原样搬成 `constants/map-config.ts` 的 `MAP_DEFAULTS`（**只当 seed**，`MapRepository.seedRow` 用 `INSERT OR IGNORE` 按 `MAP_CONTENTS` 的键补行，
  运营改过的行重启不被盖回）；落 `maps` 表 → `GET /game-config` 下发 `maps` + `mapTypes` → 客户端 `applyMapRows` **整表重建**（先 clear）。
  三个关键决定：① **资源路径不入库**（两端按目录约定各拼，下发方永远改不到「加载哪张图」，请求里塞 `src` 被白名单剥掉）；
  ② **不做「新建/删除地图」**；③ **故意不在 `worldJoin` 拦进图条件** —— 登录与传送共用同一条消息、登录时进的就是脚下那张图，
  硬拦的后果是「运营把门槛调高 → 站在图里的低等级玩家下次登录黑屏且出不来」（22 套 e2e 都在 mapId=1 用 1 级角色，是最好的反证）；
  判定留在客户端 `StorageManager.changeOnMap`（所有传送的必经之路），服务端只提供数据。判据一律 `> 0` 且 `> 角色值`（0 = 不限制）。
  管理端地图名走 `api/mapCatalog.ts` 进程内缓存（`Layout` 挂载 `ensureMapCatalog()`、保存后 `refreshMapCatalog()`）——
  页面要在渲染中途**同步**读名字，而名字只在服务端。客户端 `Game.start` 的 `loadGameConfig()` 必须 **await**（地图名与进入条件已不在客户端）。
- **管理端地图可视化 #580**：`/maps` 主视图只剩「玩法配置 + 地图」，图层/NPC/刷怪区/场上怪物/对象组/数据来源全改弹窗；
  SVG 叠在 preview 上（`viewBox = detail.width/height`，不写死 8192），判据 = **服务端实线与 TMX 虚线重合**（两套坐标同图核对）。
- **世界权威上移 #581**：删掉客户端四条本地旁路（`MonsterAreaSpawner` 本地刷怪 / `DropManager.drop`+`DropRoller` 本地抽掉落 /
  `requestPick` 本地 `addGood` 入包 / `warrior.ts` 本地扣血回滚）；怪物只认 `sendWorldJoin`，掉落只认 settle 的 `reward` +
  `applyPickResult`，`spawnResults` 的 `castId` 与 `DropItem.pick` 变必填；`configs/drop` 只剩「出厂数据书写处」。守卫 `audit-world-authority`。
- 数字基线（#581 后）：166 接口 / 137 路径 / 256 模型 / 25 权限点 / 46 表 / 38 仓储；e2e **2625（26 套）**；单测 59；守卫 70；审计 16；管理端页面 34 + 侧栏 30 项。
- **回归门槛 = 改动哪跑哪**：`make test-changed`（tools/test-changed.cjs；BASE=<ref> 可选）。客户端单测按内容匹配；服务端 e2e 按模块表，表外/共享底座回落全量；已删文件要 existsSync 过滤（否则删除的审计还会进计划）；已知基线红 5 套（素材未入库）在 CLIENT_BASELINE_RED 容忍；全量门禁 make verify 只在发布前。
