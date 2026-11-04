# olua 长期记忆（索引；细节在 `.workbuddy/skills/` 与 `memory/2026-*.md`）

> **纪律**：issue → 分支 `type/n-slug` → PR（写「关联 #n」，别写 `Closes`）→ 本地 `make test-changed` → commit → CI 绿 → squash；
> 记忆 / 技能与代码同一个 PR。全量 `make ci` 只在发布前或心里没底时手动跑。
> 仓库 PUBLIC —— 服务器 IP / 私钥 / 邀请码 / JWT 不进记忆。**website/ 永不改动**。分支只剩 master（判断残留看内容）。
> 本机待办写 `TODO-FOR-USER.md`（已 gitignore）。docs-only 改动用户口头「更新」即可直接推 master。

## 过程纪律（跨域）
- **测试只锁「字段格式 + 行为」，不锁数值**：出厂数值运营随时改。断言写「是非负数字 / 行都在 / 单调 / 接口 == 库那一列」，
  要预算就按快照算（`mallPriceOf()`），别假定统一价。**用户说「数据我改过」= 停追红，先改断言口径。**
- **e2e 在 `startServer()` 之前写库无效**：`bootstrapConfigSnapshot()` 整表替换配置。播种放启动之后并先 `DELETE` 出厂行。
- **假绿 > 漏检**：扫描器吞异常会「扫 0 个也全绿」→ 断言模块数；错误断言精确匹配文案；缓存 TTL 压 0；节点名用 key。
- **跨时间耦合断言别钉「第一个匹配」**（#670）：权威侧拒绝为尸体结算（`applyMonsterHit` hp≤0 返回 null，`casts` 照发），
  第一帧可能只有动作没数值 → 改成「等一帧同时满足两边」，超时盖过一个冷却周期。本机绿 ≠ CI 绿。
- **新增表 → `server/scripts/lib/config-tables.cjs` 两份清单同时登记**（配置 / 运行时），`assertAllClassified()` 会全量比对。
- **校验 config-sync 只能拿同 schema 的库副本**（`cp` 后 `config-import --db`，脚本自带回读）；新建空库会失败在列亲和性上。
- **加表别整份重导 `config-sync.sql`**：新库导出的列顺序与仓库那份不同（历史 ALTER vs CREATE）→ 只拼接新增那张表的节，
  再手改表头三行。`cp` 库文件前先 `PRAGMA wal_checkpoint(TRUNCATE)`，否则新表还在 `-wal` 里。
- **`make config-check` 常红在「用户正在改的那张表」**：逐表比行数定位，与本轮无关就**不要整份 `config-export`**（会打包他未定稿的改动）。
- **工具**：只信 Grep 工具（BSD `grep "a\|b"` 恒空）；批量替换用 `perl -pi -e`（本机 `sed -i ''` 异常，且 **`$(` 在 perl 里是特殊变量**，
  改 Makefile 语法必须用 Edit）；改完看行尾（`grep -c $'\r'`）；子进程 `env -u NODE_OPTIONS`；`curl --noproxy '*'`；起端口前 `lsof`。
- 删改代码用 node 按行号区间（跨行正则会从文件头 `/**` 吃到函数尾）；`//#region` 有语义，不能当注释裁。
- **一份数据只能一个来源**：库表（`config-sync.sql` 是导出物）→ 快照段 → `apply*` 整表重建，守点「导出一致 + 行数自洽」。
  代码里不许有第二份种子（`server/src/shared/` 已删）。整表重建后行对象是新的 → 派生 Map 必须重建（`rebuildSkills` / `rebuildItemIndex`）。
- **「保存即生效」= 三件事**：服务端存值（没有行 = 出厂值，重置 = 删行且幂等）+ 客户端覆写前先还原出厂值 + 几何每次进图都拉。
  空 `catch` 会把 404 伪装成「没生效」；「没生效」三分诊 = 查库 + 「N 件未保存」计数 + 写请求。
- 给权威清单加字段 = 必然有测试在测「客户端能改它」：先 `grep "PUT roles/"`，造状态改走 `PATCH /admin/roles/:id`。
- 浅拷贝共享**数组引用** → 按基础件命中全部变体要逐个对象赋值；回填「尺寸取客户端、内容取库里」要逐格保坐标。
- **babel loose**：`[...map.values()]` 装迭代器 → 一律 `Array.from`；客户端 tsconfig 无 ES2017 → 不用 `Object.entries`。
- e2e `checkEqual` 是 `===`（对象用 `JSON.stringify`）；改 `server/src` 的 DTO / 常量要先 `cd server && npm run build`（e2e 跑 `dist/`）。
- **e2e 期望值一律从快照算**（`server/test/lib/config-snapshot.cjs`）：`rows()` / `index()` / `group()` / `count()`，空表用 `optionalRows()`。
- **改 DTO 连描述都算改契约**：动过 `@ApiProperty({description})` 必须 `npm run swagger:emit` + `node tools/gen-api.cjs`。
- **「管理页看不到新行」先查服务端 seed 有没有跑**（`onModuleInit` 里 `INSERT OR IGNORE`）：**重启 3100 才生效**，重启管理端没用；页面列表只在进页面拉一次。

## 引擎坑（细节见 skill）
- 指针事件必须配 `UITransform`（否则 `cameraPriority` 空指针），UI 根不能挂鼠标事件 → `cocos-mouse-button-input`
- `AnimationState` 引擎不回收：`NODE_DESTROYED` 里逐个 `state.stop()`；`destroy()` 同帧 `isValid` 仍 true → 用 `isValid(node, true)` → `cocos-view-lifecycle`
- 几何锚点是画布中心不是脚下（全 0 会沉地下）；「以视觉为准」= 行/列直方图逐行取小求和互相关 → `sprite-placement-align`
- 自适应三层（模板 / `applyScreenPolicy` / 场景贴边），模板只在 GUI 构建生效；游戏内坐标一律以相机为准 → `cocos-screen-adapt-hud`
- **Game 脚本挂在 Canvas 上** → `initLayer()` 建的图层容器是 Canvas 子节点，引擎把 Canvas 对齐到屏幕中心（1920×1080 → 世界 960,540）；
  世界侧实体走 `setWorldPosition` 不受影响，唯独按本地 (0,0) 挂的地图瓦片错开半屏。修法：五个世界层建好后 `setWorldPosition(0,0,0)`（运行时算，别写死 designResolution/2），UILayer 不钉。（#692）

## 架构不变量（skills `olua-server` / `olua-admin` / `olua-client`）
- **服务端权威**：伤害 / 掉落 / 经验 / 进度 / 金币 / 背包 / 穿戴 / 建号一律服务端算；客户端只留资源约定 + 手感参数。
- 管理端接口必须 `@ApiAdminDoc({permissions})`；角色数据不透明（`guide` 例外：只校验不补默认）；乐观锁 409+20006；
  `whitelist` 要 DTO + `@Type` + 登记 `SWAGGER_MODELS`；排序白名单 `sort-specs.ts`；`BizException` 默认 400。
- `configs/` 与 `types/` 不许引 UI 组件（只许 `cc` 四个纯数据类 + `types/*` + `ApiModels` 的类型）；新 operationId 模块段登记 `gen-api.cjs` 的 `MODULES`；新仓储登记 `audit-server-boundaries`。
- 回归 `make test-changed`；client-test 基线 59 套 / 55 过 4 红（素材未入库）；门禁看 CI（PR 上跑一次），
  `make ci` 是本机串行版，负载高会红在 e2e「等待超时」（单跑全绿）。e2e 清单派生自 `server/package.json`（`tools/run-e2e.cjs`）。

## 部署（细节见 `docs/deploy.md` + skill `olua-deploy`）
- compose 四服务：`admin:80`（唯一入口）/ `game:8080` / `server:3100` / `server-realtime:3101`；`/api` 与 `/game-resources/` 反代；
  密钥只在 `deploy.env`；**Cocos 只能 GUI 打包**。
- **管理端镜像构建上下文必须是仓库根**：`admin/src/api/gameData.ts` 引 `server/src/common/constants/game-enums` → context `./admin` 时路径出界（TS2307，
  后接一串 `unknown not assignable to ReactNode` 都是级联）。compose 用 `context: .` + `dockerfile: admin/Dockerfile`，根 `.dockerignore` 挡大目录。
- **出厂快照必须打进服务端镜像**：`server/.dockerignore` 用 `data/*` + `!data/config-sync.sql`（写 `data` 会整目录跳过使取反失效），
  Dockerfile `COPY data/config-sync.sql ./config-sync.sql`，compose 两服务给 `CONFIG_SNAPSHOT_PATH: /app/config-sync.sql`；
  否则 `/app/data` 被卷盖住 → 空库、配置表全空。
- **验收前等健康检查转绿**（`up -d` 返回时容器还在 starting，立刻打接口必假 502），`deploy.sh verify()` 已内置轮询。
- 卷名是 **`olua_olua-data`**（compose 项目名前缀）；`docker run -v olua-data:` 会新建空卷。线上库本体只有 4KB、数据在 `-wal`，备份要连 WAL 一起拷。
- **域名**：`game.yimw.cn` 走管理端 nginx 按 `server_name` 整站反代到 `game:80`（不新建容器/端口），`:8080` 直连保留。
  客户端 `network.ts` 按 host 判：本机/内网 → `localhost:3100/api`，公网/域名 → 同源 `/api`（旧产物若写死 localhost 需重构建）。

## 进度（细节在 skills / 日报）
- 已收官：战斗权威 #25~#37 · 管理端 #259 · 客户端对接 #293 · 社交 #387 · 玩法补全 #394 · 背包穿戴收权 #556 · 管理端风格 #564 ·
  地图原点 #566 · 地图管理 #571/573/580 · 世界权威 #581 · 怪物配掉落 #584 · 刷怪区边界 #586 · 建号 #597 · 守卫清理 #598 · 邮件 #437/439。
- **#596 存档权威化（PR #639）**：hp/mp lazy 结算 + 复活接口；时装 buy/wear（清单独占字段）；体验字段（shortcutKeys/guide/soulShow）帧云同步；
  互见位置最小仲裁（瞬移屏蔽 / 持续异常跟随）。
- **#603 + #604/#626 出厂数据上服务端 + 快照层**：段清单唯一处 = `configs/game-config.ts` 区 0（加一段 = DTO / `snapshot()` / 区 0 三处改）；
  21 个域文件并进 `game-config.ts`（`//#region N`，**`apply*` 必须放进自己的区**，放上一区尾照样编译但 `regionOf()` 读不到）；
  方向恒为 `apply-snapshot → game-config → types`。资源路径判据：能按 id 推导的不入库，反之入库。
- **#605 客户端独有运营参数收权**：`mpRecoverPerSecond`→`growth_scalars`；`dropRuntime`/`autoBattle`→`runtime_params` 单行表；
  战斗力权重→`combat_weights` + `/combat-weights`；`guideSteps`→`guide_settings` + `/guide-steps`。纯函数读运营值走 `shared/runtime-overrides`。
- **#643 药品**：金创药 5 档（60/250/900/2600/15000，L1/5/10/20/35）+ 魔法药 3 档百分比（30/60/100%）；`level` 只影响展示与排序，`useDrug` 不拦。
- **#646/#648/#651 选择器体系**：`ImagePicker` 有 `mode="image"|"atlas"`；`IconField` / `EntityPickButton`（字段自带 `EntityPicker`）；
  `anyPickerOpen()` 收在 `components/pickerStack.ts`（模块级计数）。`EntityKind` 8 种含 monster/npc —— **固定清单别用 `size:100` 的分页接口当候选**。
  时装 `icon/inRes/outRes` 开放时 **DTO 与仓储 UPDATE 列清单两处都要改**（漏一处 = 接口 200 值不动）。
- **#653 配置同步**：`make config-export/import/check`，31 张配置表整表替换写成 `server/data/config-sync.sql`。**种子是 `INSERT OR IGNORE`，只对空库生效**（多机同步不能靠改种子）。
- **#655 派生数据落库 + 曲线下架**：`role_levels` 60 行、`equipment_variants` 555 行（自带属性与 `sell_price`）；运行时零现算，只读表；
  `admin/level-exps`、`admin/growth-segments` 下线，两张表启动 DROP；回收价曲线整条链删；`roleMaxLevel` 校验 = 行数。
- **#667 刷怪区改后台绘制**（PR #668）· **#672 NPC 点位 + 复活点归后台**（PR #673，TMX 只剩瓦片+碰撞；`revive_cx/cy` 可空，垫 0 会飞左上角；
  管理端 `MapCanvas` 四模式 + NPC 拖动松手即存）· **#676 碰撞盒收权**（PR #677，`map_collisions` 三条接口，TMX 对象组整组删除；
  不判越界、只标 `fullyOutside`、不做拖动）· 迁移链：`migrate-map-points` → `migrate-map-collisions` → `strip-map-objects` → `import-map-resources` → `config-export`。
- **#680/#683/#685 音效**：`audio_settings`（`audio_key` 主键）+ `GET/PATCH /admin/audio-settings`；**`file_path` 入库且带扩展名**（全项目唯一允许服务端覆写的资源路径），
  只允许英文名（`audioPathProblem()` 唯一判据）；11 项 4 类，分类写在服务端常量不进库；下发 = 快照 `audio` 段 + 公开 `GET /game-config/audio`（登录场景无令牌）。
  客户端 `SoundManager` 三路 AudioSource（music / loop / sfx），点击音统一走 `bindClick(node)`（技能栏 / 世界对象 / 拖拽刻意不响）；
  移动脚步音由 `Game.tickMoveSound` 按移动状态驱动（起步 playMove 强制单次，450ms 后接循环，停下 stopLoop）。
  列表显式按 `AUDIO_KEYS` 排序（rowid 不可靠）。加 key 顺序：**先播种真实库 → config-export → 复跑 e2e**。
- **#689 击杀跨端（PR #690）**：monster-ai 帧加 `kills` 段（`{instanceId, accountId, x, y, drops[]}`），与 hits/casts 同节拍。
  **判据**：不要「死亡时广播 world 帧」——`applyDamage` 同步触发 `onWorldChanged` 会让 world 帧抢在 settle 应答前到，快照清场吃掉击杀者的经验/掉落。
  击杀者按 accountId 自跳；观看端掉落是**纯演出不可拾取**（账本归击杀者）。
- **#693 玩家动作跨端（PR #694）**：players 帧加 `actions` 段（`{accountId, skillId, targetId?}`，普攻也是技能）。**broadcast 必须三路负载按图合并成一帧**
  （增量 / 动作 / 离开）——站着不动的人出手时增量里没有他。`playRemoteAction` 是 crossFade 一次性动作、不跳过同名（与 `playInjured` 防抖相反）。
  **边界**：挨打 / 倒地仍不跨端演（hits 只带血量）。
- open：#669 刷怪区即时生效（分域重载）· #670 打尸体仍放技能 · #8 官网 / #9 包体积 / #12~#19 素材 / #295 阶段三 / #403 帮会战 / #606 地图门槛硬拦。
- 定保持现状：技能 1011 / 快捷键 6 格 / 装备 7 部位。
- 资源发布：`make resources-manifest/pack/upload VERSION=x`（`VERSION=` 与 `RES_VERSION=` 都收）；清单先合入 master 再上传 Release。
