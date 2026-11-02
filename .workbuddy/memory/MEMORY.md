# olua 长期记忆（索引；细节见 `.workbuddy/skills/` 与 `memory/2026-*.md`）

> **纪律**：issue → 分支 `type/n-slug` → PR（写「关联 #n」，别写 `Closes` → 会提前关单）→ 本地 `make ci` 全绿 → commit → CI 绿 → squash。
> 没本地全绿就提交 = 必翻车；记忆 / 技能同样走 PR。仓库 PUBLIC —— IP / 私钥 / 邀请码 / JWT 不进记忆。**website/ 永不改动**。
> 分支只剩 master；判断残留分支看**内容**（文件是否存在 + 有无独有提交），不是 `--merged`。

## 会再犯的坑（守点 = 脚本）
- **假绿 > 漏检**：扫描器吞异常会「扫 0 个也全绿」→ 断言模块数；错误断言精确匹配文案；重试写进被测助手；缓存 TTL 压 0；
  节点名用 key 不用图标；空态文案不能跨状态复用；`{type:"error"}` 是拒绝的唯一出口。
- **只信 Grep 工具**（BSD `grep "a\|b"` 恒空）；批量替换 `perl -pi -e`（本机 `sed -i ''` 异常）；改完看行尾（`GameUiHelper.ts` 是 CRLF）
  + `make client-check`。**别用 marker 切片批量改**（会把中间函数整段吃掉）→ 精确 old/new，坏了先 `git checkout`。
- 服务端 / 子进程 `env -u NODE_OPTIONS`；`curl --noproxy '*'`；起端口前 `lsof -nP -iTCP:3100`（abort 的 `make ci` 会残留进程）。
- **一份数据只能一个来源**：`shared/<域>-seed.ts` → `game-data.generated.ts` → 表 → 快照 → `apply-snapshot`；
  守点「重生成 + 逐字节」。种子常量别与生成物导出同名（审判断「同名 = 副本」，加 `_SEED`）；DTO 描述用 `OCCUPATION_HINT` / `SEX_HINT`。
- **客户端表变空 → 派生清单 / 沙箱静默变空**：生成器与 `configs-sandbox` 都「先灌种子，再用客户端同一个函数展开」。
  **整表重建后行对象是新建的** → 派生 Map 必须重建（`rebuildOccupationSkills` / `rebuildItemIndex`）。
- **e2e 读 `server/dist/.../game-data.generated.js`**：改了生成物要先 `cd server && npm run build`，否则「期望 undefined」= 读到旧产物。
- **嵌套 DTO 只写 `@ApiProperty` 等于没写校验**（`whitelist` 剥字段：`y` 变 0、曲线段变 `{}`）；给表加字段 DTO / service / SQL 三处都过一遍。
- **「保存即生效」= 三件事**：服务端存值（没有行 = 出厂值，重置 = 删行且幂等）；客户端**覆写前先还原出厂值**；几何每次进图都拉。
  **先写清用户用什么动作看效果再定拉取时机**（外观 = 退回选角进图；内观 = 再点弹窗）；布尔开关决定读不读时保存路径要替用户兜住；
  空 `catch` 会把 404 伪装成「没生效」。验收脚本动生产数据前抓快照、跑完写回。
- **浅拷贝共享数组引用**（15 变体共享 `outPositions`）→ 命中基础件要逐个对象赋值。**注释说 A 代码做 B 时先统一**。
- **babel loose**：`[...map.values()]` 装迭代器 → 一律 `Array.from`；客户端 tsconfig 无 ES2017 → 不用 `Object.entries`（`TS2550`）。
- **指针事件必须配 `UITransform`**（3.8.7），否则 `cameraPriority` 空指针、输入全废。
- **动画「引擎自己收尾」不可信**（3.8.7 #560）：循环片段的 `AnimationState` 留在全局管理器，每帧往已销毁 Sprite 写 frame → 永不停歇。
  必须在 `NODE_DESTROYED` 里逐个 `state.stop()`（`animate.stop()` 只停 cross-fade）；`destroy()` 同帧 `isValid` 仍 true，用 `isValid(node, true)`。
- **自适应分三层**（模板 / `applyScreenPolicy` / 场景贴边），模板只在 GUI 构建生效；游戏内坐标一律以相机为准；飘字挂场景 `Canvas`。
- **几何**：位置按帧 bbox 运行时算、配置只当微调；**外观锚点是画布中心不是脚下**（全 0 沉地下，裸模沉 31）。
  「以视觉为准」要翻译成能最大化的量：行/列直方图**逐行取小求和**互相关（披风翅膀带偏人体锚点：同衣 8 向 x 跨度 20~84 vs 裸模 ±1，
  互相关后 4~27）；NCC 会退化；**bbox 极值由最远一个像素决定** → 行列计数 ≥ 2。
- **并表/分表判据 = 重置要不要互不牵连**；`outManual`/`inManual` 是挡住运行时算法覆盖刚存的值。被复核对象不能挡住判据
  （列对齐装备画裸模之上、参考框最后画）；嵌套本地偏好逐项合并默认值。
- **拖拽工作台**：命中要给「内容不可见」留路，位移要封顶；「提醒里带三步操作 = 等于没做」。
  「保存没生效」三分诊：查库 + 「N 件未保存」计数 + 写请求，三者一对就知断在哪。
- **「尺寸取客户端、内容取库里」的回填要逐格保坐标**（按行优先压紧 = 把拖好的物品挤回左上角）；判据是「坐标没变」。
- **给权威清单加字段 = 必然有一批测试在测「客户端能改它」**：先 `grep "PUT roles/"`，造状态改走管理端 `PATCH`。
- 批量删代码用 node 脚本按行号区间（跨行正则会从文件头 `/**` 吃到函数尾）；`//#region` 有语义不能裁。e2e `checkEqual` 是 `===`，
  对象断言用 `JSON.stringify`。真机验证：真实 Chrome `headless:false` + playwright-core；自适应只测 `viewport:null`；`window.__cc` 要等 `__v.ready()`。

## 架构不变量（细节见 skills `olua-server` / `olua-admin` / `olua-client`）
- **服务端权威**：伤害 / 掉落 / 经验 / 进度 / 金币 / 背包 / 穿戴 / 建号一律服务端算；客户端不存数值与显示数据，只留资源约定 + 手感参数。
- 管理端接口必须 `@ApiAdminDoc({permissions})`；角色数据不透明（`guide` 例外：只校验、不补默认）；乐观锁 409+20006；
  `whitelist` 要 DTO + `@Type` + 登记 `SWAGGER_MODELS`；排序白名单 `sort-specs.ts`；`BizException` 默认 400。
- 新 operationId 模块段登记 `tools/gen-api.cjs` 的 `MODULES`；新仓储登记 `audit-server-boundaries` 的 `REPO_EDGES`。
- `configs/` 与 `types/` 不许引 UI 组件（`apply-snapshot` 链要在 Node 垫片里加载）。
- 部署：compose 四服务（admin:80 / game:8080 / server:3100 / realtime:3101），`/api` 与 `/game-resources/` 反代；密钥只在 `deploy.env`；
  先合 master 再发布；Cocos 只能 GUI 打包。
- 回归 = `make test-changed`；本机 client-test 基线 **58 套 / 54 过 4 红**（红全是素材未入库）；CI 不跑它，门禁看 `make ci`。

## 进度（细节见 `2026-*.md`）
- 已收官：战斗权威 #25~#37 · 管理端 #259 · 客户端对接 #293 · 社交 #387 · 玩法补全 #394 · 背包穿戴收权 #556 · 管理端风格 #564 ·
  地图原点左上 #566（锚点在 `tmxAsset` 赋值**之前**；建完图逐层补 `_syncAnchorPoint()`）· 地图管理 #571/#573 · 地图可视化 #580 ·
  世界权威上移 #581 · 怪物配掉落 #584 · 刷怪区边界 #586 · 服务端建号 #597 · 数字守卫清理 #598 · 消息补发 #437 · 邮件回收 #439。
- **#603 逐域搬迁 —— 全部收口（PR #624）**。模板：新建 `server/src/shared/<域>-seed.ts` → 生成器 `SOURCE_FILES` 减一项 →
  `compileServerShared` 增编该种子 → 服务端改读种子 → 客户端清成空表 + `apply*` 整表重建 → 守点「重生成逐字节不变」。
  已搬：monsterDrops #610 · monster-skills #612 · status #613 · quest #614 · achievement #615 · drop #617 · 战斗力权重 #618 ·
  npc #620 · mall #622 · equipments + growth #623（555 变体不写、八项属性走公式）· items/material/drug + skill-data + fashionClothes #624。
  **role / monster 判定不搬**：职介图按职业码可推导、职业名有权威副本、尺寸与 AI 节奏是素材 / 手感。
  **资源路径入库判据 —— 能按 id 推导的不入库**（`map/<id>/<id>`、`effect/<key>/<key>.plist`、`tips_<职业码>`），
  反之入库（药品 / 材料图标、时装 `icon/in/out`：`cloth_2` ↔ `clothes/out/001` 无约定、`cloth_13` 无内观图）。
  种子字段名 = 快照字段名 = 表列形状（区间 `{min,max}`），沙箱与线上走同一个 `apply*`。
- open：#8 官网 / #9 包体积 / #12~#19 素材 / #295 阶段三 / #403 帮会战 / #604 快照回落策略 / #605 战斗力权重编辑页 / #606 地图门槛硬拦。
  定保持现状：技能 1011 / 快捷键 6 格 / 药品 3 档 / 装备 7 部位。
- 用户待办见仓库根 `TODO-FOR-USER.md`（本地文件，不入库）。
