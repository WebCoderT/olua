# olua 长期记忆（索引；细节见 `.workbuddy/skills/` 与 `memory/2026-*.md`）

> **纪律**：issue → 分支 `type/n-slug` → PR（写「关联 #n」，别写 `Closes`）→ 本地 `make test-changed` → commit → CI（PR）绿 → squash；
> 记忆 / 技能与代码**同一个 PR**（文档改动不触发 CI，但少一轮 PR 更省事）。全量 `make ci` 只在「发布前 / 心里没底」时手动跑。
> 仓库 PUBLIC —— IP / 私钥 / 邀请码 / JWT 不进记忆。**website/ 永不改动**。分支只剩 master（判断残留看内容，不看 `--merged`）。本机待办 `TODO-FOR-USER.md` 已在 `.gitignore`。

## 过程纪律（跨域，没被任何 skill 覆盖）
- **假绿 > 漏检**：扫描器吞异常会「扫 0 个也全绿」→ 断言模块数；错误断言精确匹配文案；缓存 TTL 压 0；重试写进被测助手；节点名用 key 不用图标。
- **工具**：只信 Grep 工具（BSD `grep "a\|b"` 恒空）；批量替换 `perl -pi -e`（本机 `sed -i ''` 异常）；改完看行尾（`GameUiHelper.ts` 历史上是 CRLF，现已统一 LF —— 动手前 `grep -c $'\r'` 确认，别凭记忆假设）；子进程 `env -u NODE_OPTIONS`；`curl --noproxy '*'`；起端口前 `lsof`。
- 删改代码用 node 按行号区间（跨行正则会从文件头 `/**` 吃到函数尾）；`//#region` 是有语义的注释，不能当注释裁。
- **一份数据只能一个来源**：`shared/<域>-seed.ts` → 生成物 → 表 → 快照 → `apply*`，守点「重生成 + 逐字节」；种子常量加 `_SEED` 防重名。整表重建后行对象是新的 → 派生 Map 必须重建（`rebuildSkills` / `rebuildItemIndex`），`configs-sandbox` 与生成器共用同一个 `apply*`。
- **「保存即生效」= 三件事**：服务端存值（没有行 = 出厂值，重置 = 删行且幂等）+ 客户端覆写前先还原出厂值 + 几何每次进图都拉。**先写清用户用什么动作看效果，再定拉取时机**；空 `catch` 会把 404 伪装成「没生效」；「没生效」三分诊 = 查库 + 「N 件未保存」计数 + 写请求。
- **给权威清单加字段 = 必然有一批测试在测「客户端能改它」**：先 `grep "PUT roles/"`，造状态改走 `PATCH /admin/roles/:id`。
- 浅拷贝共享的是**数组引用**（15 变体共享 `outPositions`）→ 按基础件命中全部变体要逐个对象赋值；回填「尺寸取客户端、内容取库里」要逐格保坐标；**注释说 A 代码做 B 时先统一**。
- **babel loose**：`[...map.values()]` 装迭代器 → 一律 `Array.from`；客户端 tsconfig 无 ES2017 → 不用 `Object.entries`（TS2550）。
- e2e `checkEqual` 是 `===`（对象用 `JSON.stringify`）；e2e 读 `server/dist/...generated.js`，改了 `shared/` 要先 `cd server && npm run build`；自适应只测 `viewport:null` 的真机窗口。
- **改 DTO 连描述都算改契约**：`audit-api-generated` 的 A 段是「现算一遍逐字节比对」→ 动过 `@ApiProperty({description})` 必须 `cd server && npm run swagger:emit` + `node tools/gen-api.cjs`，否则审计直接红。
- **「管理页看不到新行」先查服务端 seed 有没有跑**：`ui_effects` / `maps` 这类行只在 `onModuleInit` 按常量 `INSERT OR IGNORE` 补出来，跑着的进程还是老代码 → 库里没有新行、排序也还是旧的。**重启 3100 才生效，重启管理端没用**；页面列表只在进页面时拉一次，还得刷新。

## 引擎坑（细节在 skill 里，这里只留索引）
- 指针事件必须配 `UITransform`（否则 `cameraPriority` 空指针），UI 根绝不能挂鼠标事件 → `cocos-mouse-button-input`
- 动画 `AnimationState` 引擎不回收：`NODE_DESTROYED` 里逐个 `state.stop()`；`destroy()` 同帧 `isValid` 仍 true，用 `isValid(node, true)` → `cocos-view-lifecycle`
- 几何锚点是画布中心、不是脚下（全 0 会让身体沉地下）；「以视觉为准」翻译成行/列直方图逐行取小求和互相关 → `sprite-placement-align`
- 自适应分三层（模板 / `applyScreenPolicy` / 场景贴边），模板只在 GUI 构建生效；游戏内坐标一律以相机为准 → `cocos-screen-adapt-hud`

## 架构不变量（skills `olua-server` / `olua-admin` / `olua-client`）
- **服务端权威**：伤害 / 掉落 / 经验 / 进度 / 金币 / 背包 / 穿戴 / 建号一律服务端算；客户端只留资源约定 + 手感参数。
- 管理端接口必须 `@ApiAdminDoc({permissions})`；角色数据不透明（`guide` 例外：只校验、不补默认）；乐观锁 409+20006；`whitelist` 要 DTO + `@Type` + 登记 `SWAGGER_MODELS`；排序白名单 `sort-specs.ts`；`BizException` 默认 400。
- `configs/` 与 `types/` 不许引 UI 组件（只许 `cc` 四个纯数据类 + `types/*` + `ApiModels` 的**类型**）；新 operationId 模块段登记 `gen-api.cjs` 的 `MODULES`；新仓储登记 `audit-server-boundaries`。
- 部署：compose 四服务（admin:80 / game:8080 / server:3100 / realtime:3101），`/api` 与 `/game-resources/` 反代；密钥只在 `deploy.env`；Cocos 只能 GUI 打包。
- 回归 `make test-changed`；client-test 基线 59 套 / 55 过 4 红（红全是素材未入库）；门禁看 **CI（PR 上跑一次）**
  —— `make ci` 是它的本机串行版，别拿本机全量当硬门禁：负载一高就红在 e2e「等待超时」上（单跑全绿）。
  e2e 套件清单派生自 `server/package.json`（`tools/run-e2e.cjs`），新增脚本自动进 CI，不再维护 Makefile 清单。

## 进度
- 已收官：战斗权威 #25~#37 · 管理端 #259 · 客户端对接 #293 · 社交 #387 · 玩法补全 #394 · 背包穿戴收权 #556 · 管理端风格 #564 · 地图原点 #566 · 地图管理 #571/#573/#580 · 世界权威 #581 · 怪物配掉落 #584 · 刷怪区边界 #586 · 建号 #597 · 守卫清理 #598 · 邮件 #437/#439 · 掉落光效入特效管理 #634 · 成长线按后台升级路径 #635（客户端派生链 `titleUpgradeChain` / `soulUpgradeChain` + 四态 `growthStepOf`，空链 = closed 不许冒充满级；`getXxxLevel` 仍按等级号读全表，头顶外显不跟链序）· **存档权威化收官 #596（PR #639）**：hp/mp lazy 结算 + 复活接口 · 时装 buy/wear（清单独占字段）· 体验字段（shortcutKeys/guide/soulShow）帧云同步 · 互见位置最小仲裁（瞬移屏蔽 / 持续异常跟随）· **物品 id 字段可视化 #648（PR #649）**：`EntityPickButton`（字段自带 `EntityPicker`）铺到掉落条目 / 任务奖励 / 成就奖励 + 持有条件 / 邮件附件；`anyPickerOpen()` 收进 `components/pickerStack.ts`（`IconField` 与 `EntityPicker` 各自登记）。 **#651（PR #652）**：catalog 的 `EntityKind` 扩到 8 种（加 `monster` / `npc`，清单来自服务端种子）；任务目标 / 发布 NPC / 成就击杀条件全部可视化 —— **固定清单别用 `size: 100` 的分页接口当候选**（第 101 只怪选不到）。
- **#603 出厂数据逐域搬到服务端（PR #624）**：模板 = `shared/<域>-seed.ts` → 服务端读种子 → 客户端清空表 + `apply*` 整表重建 → 守点「重生成逐字节不变」。资源路径判据：能按 id 推导的不入库（`map/<id>/<id>`、`effect/<key>/<key>.plist`），反之入库（药品 / 材料图标、时装 `icon/in/out`）。
- **#604 / #626 快照层**：段清单唯一书写处 = `configs/game-config.ts` 区 0，缺段抛错并停在 Loading 重试（加一段 = DTO / `snapshot()` / 区 0 三处一起改）。
  #626 把 21 个域文件并进 `game-config.ts`（`//#region N · 标签（原 configs/xxx.ts）`，编号稳定、守点按编号取区）：**`apply*` 必须放进自己的区**（放到上一个区尾巴照样编译，但 `regionOf()` 读不到 —— 真踩过）；`items`/`equipments`/`skill`/`apply-snapshot` 不许被反向 import（方向恒为 `apply-snapshot → game-config → types`，`getMallGoods` 因此住 `equipments`）。工具链只换 require 名字（`configs-sandbox` / `client-config-compile` / `test-*.cjs` / `gen-shared-data` 的 `SOURCE_FILES` 只剩 4 个入口 / `audit-world-authority` 的 `MONSTER_REGION=15`）。
- **#646 图片选择器铺开（PR 见分支 `feat/646-image-picker-everywhere`）**：`ImagePicker` 加 `mode="image"|"atlas"`
  （atlas 的「一套」= `rootDir` 下第一段，覆盖图集目录 / 路径即基名 / 按动作分子目录三种形态），导出 `IconField`
  与 `anyPickerOpen()`（叠在编辑弹窗上时外层 onClose 放行，判据是模块级计数不是每页布尔）。
  接线 8 页 15 字段；时装 `icon/inRes/outRes` 开放（**DTO 与仓储 UPDATE 列清单两处都要改**，漏一处 = 接口 200 值不动）。
- **#643 药品补档 + 使用等级可编辑（PR 待合）**：金创药 5 档固定值（60/250/900/2600/15000，L1/5/10/20/35）+ 魔法药 3 档百分比（30/60/100%，最高档刻意=100%，再高被血蓝封顶吃掉）；`level` 管理端可改但**只影响展示与背包排序，服务端 useDrug 不拦**。种子唯一处 = `shared/item-seed.ts`（11 种）。
- **#605 客户端独有运营参数逐项评估收权（PR #645 五块）**：口径「除界面文案外全部可配」。
  五块：`mpRecoverPerSecond` → `growth_scalars`；`dropRuntime`/`autoBattle` → `runtime_params` 单行表（三组 JSON 列）；
  `guildRules` 由 `GuildService` 现读运行时参数（DTO 只留结构上限）；战斗力权重 → `combat_weights` KV 表 + `/combat-weights` 页；
  `guideSteps` → `guide_settings` 单行表（整份数组）+ `/guide-steps` 页，`GUIDE_SPOTS`/`GUIDE_EVENTS` 白名单即客户端能力边界。
  纯函数读运营值只能走 `shared/runtime-overrides` 覆盖层（`combatWeightsOf()`）；表现层（颜色 / 节点名 / 气泡排版 / 全局文案）仍留客户端。
- open：#8 官网 / #9 包体积 / #12~#19 素材 / #295 阶段三 / #403 帮会战 / #606 地图门槛硬拦。
- 定保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位（药品档位已由 #643 改为「金创药 5 + 魔法药 3」，不再保持 3 档）。
