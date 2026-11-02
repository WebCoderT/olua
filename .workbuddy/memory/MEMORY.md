# olua 长期记忆（索引；细节见 `.workbuddy/skills/olua-*` 与 `memory/2026-*.md`）

> **纪律**：issue → 分支 `type/n-slug` → PR → **本地 `make ci` 全绿** → commit → CI 绿 → squash。跟踪单用「关联 #n」，
> 别写 `Closes`（会提前关 issue）。**没本地全绿就提交 = 必翻车**（#608 教训）。记忆/技能同样走 PR；记忆随仓库提交。
> 仓库 PUBLIC —— IP / 私钥 / 邀请码 / JWT 等实际值不进记忆。**website/ 永不改动**（用户没说更新就永远不管）。
> 分支只剩 master；判断残留分支看**内容**（文件/模块是否存在 + 有无独有提交），不是 `git branch --merged`。

## 会再犯的坑（守点 = 脚本，脚本名见括号）
- **假绿 > 漏检**：扫描器吞异常会「扫 0 个也全绿」（要断言模块数）。错误断言精确匹配文案；重试写进被测助手；缓存 TTL 压 0。
  节点名用 key 不用图标（`find()[0]` 会拿错）；空态文案不能跨状态复用；`{type:"error"}` 是拒绝的唯一出口。
- **只信 Grep 工具**（BSD `grep "a\|b"` 恒空 ≠ 已改完）；批量替换 `perl -pi -e`（`sed -i ''` 本机异常）；
  改完看行尾（`GameUiHelper.ts` 是 CRLF）与 `make client-check`；编辑器回写后 `sleep 20` 复检。
- 服务端/子进程 `env -u NODE_OPTIONS`；`curl --noproxy '*'`；起端口前 `lsof -nP -iTCP:3100`（abort 的 `make ci` 会残留进程）。
- **一份数据只能一个来源**（`configs` → `game-data.generated.ts` → 服务端 seed → `/game-config` 快照 → `apply-snapshot` 覆写）；
  守点 =「重生成 + 逐字节 + 结构断言」。派生清单不钉住会静默毁数据。
- **「保存即生效」= 三件事**（#513/#527）：服务端存值（**没有行 = 出厂值**，重置=删行且幂等）；客户端**覆写前先还原出厂值**；
  **几何每次进图都拉**（快照只拉一次，被 short-circuit 挡掉会被当成「功能没做」）。
  **先写清用户用什么动作看效果，再决定拉取时机**（外观=退回选角再进图；内观=再点开弹窗）。
  **布尔开关决定客户端读不读这条数据时，保存路径必须替用户兜住**；**空 `catch` 会把 404 伪装成「没生效」**。
  验收脚本动生产数据前先抓快照、跑完按原值写回。
- **浅拷贝共享的是数组引用**：15 个变体共享 `outPositions`，`outScale`/`outManual` 各自 → 按基础件命中全部变体要逐个对象赋值。
- **注释说 A、代码做 B 时先统一**（`ConfigLoader` 曾写「重进即见新值」而代码短路）。**枚举只能一处来源**（审计目标类型从 `@AuditTarget` 派生）。
- **babel loose**：`[...map.values()]` 装的是迭代器 → Map/Set 一律 `Array.from`（`audit-iterator-spread`）。
  客户端 tsconfig 无 ES2017 lib → `Object.entries` 直接 `TS2550`，用 `for..in` + `hasOwnProperty`。
- **指针事件必须配 `UITransform`**（3.8.7），否则 `cameraPriority` 空指针、输入全废。
- **动画节点的「引擎自己收尾」不可信**（3.8.7，#560）：带循环片段的节点 `destroy()` 后 `AnimationState` 留在**全局** `AnimationManager`，
  每帧往已销毁 Sprite 写 `spriteFrame` → 一帧一条永不停止。必须自己在 `NODE_DESTROYED`（引擎先发它）里**逐个 `state.stop()`**
  （`animate.stop()` 只停 cross-fade 权重）。`destroy()` 同帧 `isValid(node)` 仍 true，起动画前用 `isValid(node, true)`。
- **自适应分三层**（模板 / `applyScreenPolicy` / 场景贴边），模板只在 GUI 构建生效；游戏内坐标一律以相机为准。
  **飘字**挂场景里的 `Canvas`（不是场景根）；行内文字按 bbox 验，装不下要 `enableWrapText` + 行高自适应。
- **几何**：位置按帧内容 bbox 运行时算、配置只当微调（内容中心 = 节点中心 + `offset`，y 向上；衣服缩放要乘；空帧按面积判 4；
  `spriteSourceSize` 只有 2 个数）。**外观锚点是画布中心不是脚下**：全 0 会让身体沉到地下（裸模沉 31，#517）；判据固定在宿主原点。
- **并一张表还是分两张，判据是「重置要不要互不牵连」**（#523；字段形状不同不算理由）。`outManual`/`inManual` 的作用是
  **挡住运行时算法当场覆盖刚存的值**，不是「给个备用值」。实测基准（圆盘 `(-82.5,-149.5) r=90`）写进派生清单并注明「换图要重测」。
- **拖拽工作台：命中要给「内容不可见」留路，位移要封顶**（#531）：只认内容矩形 → 飞出格子后永远抓不回来（死锁）；
  `(指针-起点)/zoom` 不封顶 → 一次就能甩坏数据。**提醒里带三步操作 = 等于没做**（要一键做完并落库）。
  「保存没生效」先分诊：查库 + 「N 件未保存」计数 + 写请求，三者一对就知断在「没改动 / 改了没存 / 存了没生效」。
- **「以视觉为准」要翻译成能最大化的量**（#539）：披风/翅膀/飘带会让任何人体锚点带偏（同一衣服 8 方向 x 跨度 20~84，裸模 ±1）。
  可用判据 = 行/列直方图的**逐行取小求和**互相关（先 y 后 x，跨度降到 4~27）；NCC 会退化。**bbox 极值由最远一个像素决定** → 行列计数 ≥ 2。
- **被复核对象不能挡住判据**（#535）：工作台第一判据是眼睛 → 列对齐默认把装备画在裸模之上（`itemTop`）；**参考框一律最后画**。
  **嵌套本地偏好要逐项合并默认值**（`{...fallback, ...parsed}` 会顶掉整个 `guides`）。像素判据用量级不用严格 0。
- **「尺寸取客户端、内容取库里」的回填要逐格保坐标**（#556）：`adoptBagShape` 按行优先压紧会把玩家拖好的物品挤回左上角；
  判据是「坐标没变」不是「数量没丢」；装不下时整份退回原网格。
- **给权威清单加字段 = 必然有一批测试在测「客户端能改它」**（#550 踩四套 / #556 踩三套）：先 `grep "PUT roles/"`，
  把造状态改成管理端 `PATCH /admin/roles/:id`。
- **批量结构化删代码别用跨行正则**（#598 踩）：`/\/\*\*[\s\S]*?...\*\//` 会从文件头第一个 `/**` 吃到目标函数尾。
  用 node 脚本按行号区间；恢复时从「第一条守卫行起整段丢弃」；`//#region` 不算注释。e2e 助手 `checkEqual` 是 `===`，对象断言用 `JSON.stringify`。
  改 `render()` 模板时别在模板字符串里写反引号（会截断模板，报错行号指向 JS 源码）。
- 真机验证：真实 Chrome `headless:false` + playwright-core；自适应只测真实窗口（`viewport:null`）；`window.__cc` 要等 `__v.ready()`。

## 架构不变量（细节见 skills `olua-server` / `olua-admin` / `olua-client`）
- **服务端权威**：伤害/掉落/经验/进度/金币/背包/穿戴/建号一律服务端算，客户端只演。**客户端不存任何数值与显示数据**，
  只有「资源约定」（路径怎么拼、对象组名）与手感参数。
- 管理端接口必须 `@ApiAdminDoc({permissions})`；角色数据是不透明文档（`guide` 例外：只校验结构、**不补默认值**）；
  乐观锁 409+20006；`whitelist` 要 DTO + `@Type` + 登记 `SWAGGER_MODELS`；排序白名单 `sort-specs.ts`；`BizException` 默认 400。
- 新 operationId 模块段登记 `tools/gen-api.cjs` 的 `MODULES`；新仓储登记 `audit-server-boundaries` 的 `REPO_EDGES`。
- 部署：compose 四服务（admin:80 / game:8080 / server:3100 / realtime:3101），`/api` 与 `/game-resources/` 反代；密钥只在 `deploy.env`；
  先合 master 再发布；Cocos 只能 GUI 打包。
- 回归门槛 = **改动哪跑哪**：`make test-changed`（BASE=<ref> 可选）；客户端单测按内容匹配，服务端 e2e 按模块表，表外回落全量；
  已删文件要 `existsSync` 过滤。本机 client-test 基线 **58 套 / 53 过 5 红**（红是素材未入库）；CI 不跑它，门禁看 `make ci`。
  改了换装/背包/动画要自己跑一遍 `make client-test`。

## 进度（细节见 `2026-*.md`）
- 已收官：战斗权威 #25~#37 · 管理端 #259 · 客户端对接 #293 · 社交 #387 · 玩法补全 #394 十二刀 · 背包穿戴收权 #556 ·
  管理端风格统一 #564 · 地图原点左上 #566（锚点必须在 `tmxAsset` 赋值**之前**；建完图要逐层补 `_syncAnchorPoint()`，
  否则整屏黑 / 偏半张图）· 地图管理 #571/#573（**资源路径不入库**、不做新建删除、不在 `worldJoin` 拦进图）·
  地图可视化 #580 · 世界权威上移 #581 · 怪物配掉落 #584 · 刷怪区边界 #586 · 服务端建号 #597 · 数字守卫清理 #598。
- 2026-11-02 夜：#437 消息补发（权限点 `gameMail:send`；`@AuditTarget` 的 targetId 取 `:id` —— 路由参数必须叫 `:id`）·
  #439 邮件过期回收（`expires_at` 可空=永不过期；`DELETE...LIMIT` 依赖编译开关 → 先 SELECT id 再 DELETE IN）。
- **2026-11-02/03：客户端数据归属盘点 → #601~#606，逐域搬迁（#603）**
  模板（已固化）：新建 `server/src/shared/<域>-seed.ts` → `gen-shared-data.cjs` 的 `SOURCE_FILES` 减一项 →
  `compileServerShared` 增编该种子 → `load()` 加参数 → 数据来源改读种子 → 删客户端文件 →
  **守点：重新生成的 `game-data.generated.ts` 必须逐字节相同**。
  已完成域：monsterDrops #610 · monster-skills #612 · status #613 · quest #614 · achievement #615 · drop #617 · 战斗力权重 #618。
  待办域：`equipments`(1381 行 + 10 运行时函数 + 555 变体，与 `growth` 必须同轮) · `skill-data`(489) · `items`/`material`/`drug`
  （`applyItemRows`/`applyDrugRows` 只覆写已有行，要改成整表重建）· `npc-data`(49，要扩 `NpcDto` 表现字段 + 老库 ALTER，建议优先) ·
  `mall`(65) · `role`/`monster`(只剩职业表与 `monsterAI`)。
- open：#8 官网 / #9 包体积 / #12~#19 素材 / #295 阶段三 / #403 帮会战。定保持现状：技能 1011 / 快捷键 6 格 / 药品 3 档 / 装备 7 部位。
- 用户待办与需拍板事项见仓库根 `TODO-FOR-USER.md`（本地文件，不入库）。
