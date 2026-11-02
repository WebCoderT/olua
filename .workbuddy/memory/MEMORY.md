# olua 长期记忆（索引；细节见 `.workbuddy/skills/` 与 `memory/2026-*.md`）

> **纪律**：issue → 分支 `type/n-slug` → PR（写「关联 #n」，别写 `Closes` → 会提前关单）→ 本地 `make ci` 全绿 → commit → CI 绿 → squash；
> 记忆 / 技能同样走 PR。仓库 PUBLIC —— IP / 私钥 / 邀请码 / JWT 不进记忆。**website/ 永不改动**（没说更新就永远不管）。
> 分支只剩 master；判断残留分支看**内容**（文件是否存在 + 有无独有提交），不是 `--merged`。用户待办在仓库根 `TODO-FOR-USER.md`（本地文件，不入库）。

## 过程纪律（跨域，没被任何 skill 覆盖）
- **假绿 > 漏检**：扫描器吞异常会「扫 0 个也全绿」→ 断言模块数；错误断言精确匹配文案；缓存 TTL 压 0；重试写进被测助手；节点名用 key 不用图标。
- **只信 Grep 工具**（BSD `grep "a\|b"` 恒空）；批量替换 `perl -pi -e`（本机 `sed -i ''` 异常）；改完看行尾（`GameUiHelper.ts` 是 CRLF）+ `make client-check`。
- 服务端 / 子进程 `env -u NODE_OPTIONS`；`curl --noproxy '*'`；起端口前 `lsof -nP -iTCP:3100`（abort 的 `make ci` 会残留进程）。
- 批量删改代码用 node 按行号区间（跨行正则会从文件头 `/**` 一路吃到函数尾）；别用 marker 切片；`//#region` 是有语义的注释不能裁。
- e2e `checkEqual` 是 `===`，对象断言用 `JSON.stringify`；e2e 读 `server/dist/...generated.js`，改了 `shared/` 要先 `cd server && npm run build`。
- **给权威清单加字段 = 必然有一批测试在测「客户端能改它」**：先 `grep "PUT roles/"`，造状态改走管理端 `PATCH /admin/roles/:id`。
- **一份数据只能一个来源**：`shared/<域>-seed.ts` → 生成物 → 表 → 快照 → `apply-snapshot`，守点「重生成 + 逐字节」；种子常量加 `_SEED` 防与生成物同名。
- **客户端表整表重建后行对象是新的** → 派生 Map 必须重建（`rebuildSkills` / `rebuildItemIndex`）；`configs-sandbox` 与生成器共用同一个 `apply*`。
- **「保存即生效」= 三件事**：服务端存值（没有行 = 出厂值，重置 = 删行且幂等）+ 客户端覆写前先还原出厂值 + 几何每次进图都拉。
  **先写清用户用什么动作看效果，再定拉取时机**；空 `catch` 会把 404 伪装成「没生效」；「没生效」三分诊 = 查库 + 「N 件未保存」计数 + 写请求。
- **浅拷贝共享的是数组引用**（15 变体共享 `outPositions`）→ 按基础件命中全部变体必须逐个对象赋值；**注释说 A 代码做 B 时先统一**。
- **babel loose**：`[...map.values()]` 装迭代器 → 一律 `Array.from`；客户端 tsconfig 无 ES2017 → 不用 `Object.entries`（TS2550）。
- **回填「尺寸取客户端、内容取库里」要逐格保坐标**（按行优先压紧 = 把拖好的物品挤回左上角）；判据是「坐标没变」。
- 真机验证：真实 Chrome `headless:false` + playwright-core；自适应只测 `viewport:null`；`window.__cc` 要等 `__v.ready()`。

## 引擎坑（细节在 skill 里，这里只留索引）
- 指针事件必须配 `UITransform`（否则 `cameraPriority` 空指针），UI 根绝不能挂鼠标事件 → `cocos-mouse-button-input`
- 动画 `AnimationState` 引擎不回收：`NODE_DESTROYED` 里逐个 `state.stop()`；`destroy()` 同帧 `isValid` 仍 true，用 `isValid(node, true)` → `cocos-view-lifecycle`
- 几何锚点是画布中心、不是脚下（全 0 会让身体沉地下）；「以视觉为准」翻译成行/列直方图逐行取小求和互相关 → `sprite-placement-align`
- 自适应分三层（模板 / `applyScreenPolicy` / 场景贴边），模板只在 GUI 构建生效；游戏内坐标一律以相机为准 → `cocos-screen-adapt-hud`

## 架构不变量（skills `olua-server` / `olua-admin` / `olua-client`）
- **服务端权威**：伤害 / 掉落 / 经验 / 进度 / 金币 / 背包 / 穿戴 / 建号一律服务端算；客户端只留资源约定 + 手感参数。
- 管理端接口必须 `@ApiAdminDoc({permissions})`；角色数据不透明（`guide` 例外：只校验、不补默认）；乐观锁 409+20006；
  `whitelist` 要 DTO + `@Type` + 登记 `SWAGGER_MODELS`；排序白名单 `sort-specs.ts`；`BizException` 默认 400。
- `configs/` 与 `types/` 不许引 UI 组件（只许 `cc` 四个纯数据类 + `types/*` + `ApiModels` 的**类型**）；新 operationId 模块段登记 `tools/gen-api.cjs` 的 `MODULES`；新仓储登记 `audit-server-boundaries`。
- 部署：compose 四服务（admin:80 / game:8080 / server:3100 / realtime:3101），`/api` 与 `/game-resources/` 反代；密钥只在 `deploy.env`；Cocos 只能 GUI 打包。
- 回归 `make test-changed`；本机 client-test 基线 59 套 / 55 过 4 红（红全是素材未入库）；门禁看 `make ci`（e2e 偶发 `EADDRINUSE` 是端口撞车，单跑那套即可，不是代码问题）。

## 进度
- 已收官：战斗权威 #25~#37 · 管理端 #259 · 客户端对接 #293 · 社交 #387 · 玩法补全 #394 · 背包穿戴收权 #556 · 管理端风格 #564 ·
  地图原点 #566 · 地图管理 #571/#573/#580 · 世界权威 #581 · 怪物配掉落 #584 · 刷怪区边界 #586 · 建号 #597 · 守卫清理 #598 · 邮件 #437/#439。
- **#603 出厂数据逐域搬到服务端（PR #624 收口）**：模板 = `shared/<域>-seed.ts` → 生成器减一项 → 服务端读种子 → 客户端清空表 + `apply*` 整表重建 → 守点「重生成逐字节不变」。
  资源路径判据：能按 id 推导的不入库（`map/<id>/<id>`、`effect/<key>/<key>.plist`），反之入库（药品 / 材料图标、时装 `icon/in/out`）。
- **#604 快照显式契约**：段清单的唯一书写处现在是 `configs/game-config.ts` 区 0（#626 前是 `configs/snapshot-contract.ts`），缺段抛错并挡住进游戏（停在 Loading + 重试），`tools/audit-snapshot-contract.cjs` 钉三方一致。
- **#626 二十一个快照域并成 `configs/game-config.ts`**（PR #627）：`//#region N · 标签（原 configs/xxx.ts）` 按域分区（编号稳定，守点按编号取区），`apply*` 必须放在自己的区里（放到上一个区尾巴上照样编译，但 `regionOf()` 读不到）；`items`/`equipments`/`skill`/`apply-snapshot` 不许被反向 import（依赖方向 `apply-snapshot → game-config → types`，`getMallGoods` 因此住 `equipments`）。
  工具链跟着换 require 名字：`configs-sandbox` / `client-config-compile` / `gen-shared-data`（`SOURCE_FILES` 只剩 4 个入口）/ `audit-snapshot-contract` / `audit-world-authority`（`MONSTER_REGION = 15`）。生成物逐字节不变是验收口径。
- open：#8 官网 / #9 包体积 / #12~#19 素材 / #295 阶段三 / #403 帮会战 / #605 战斗力权重编辑页 / #606 地图门槛硬拦。
- 定保持现状：技能 1011 / 快捷键 6 格 / 药品 3 档 / 装备 7 部位。
