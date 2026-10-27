---
name: olua-client
description: olua 项目客户端（Cocos Creator 3.8.7 + TypeScript，Cocos 工程在 `client/`，即 client/assets/）里「跟服务端打交道」的开发与改动做法。仓库是三端平级：client/（客户端）/ server/（NestJS）/ admin/（React），各自有 README 与 FAQ。核心心智模型：本地只是缓存、服务端才是权威，但游戏数据的唯一真相是客户端自己的 client/assets/configs（服务端不认识这些配置）。涵盖：ui/utils/net 的分工（生成物 ApiRoutes / ApiModels / Api 禁止手改，手写 HttpClient / ApiCodes / ApiError / Session / RoleSync / NetworkSetup）、地址唯一来源 client/assets/configs/network.ts（baseUrl timeout retry roleSyncDelay）、请求唯一出口 HttpClient（XHR、令牌注入、超时重试、统一包裹解包、ApiError 归一：文案优先用服务端 message、兜底走 configs/texts 的 net 开头文案 key、代码里禁写中文）、silent 模式（失败不弹全局提示但令牌失效仍回登录场景）、进游戏流程以服务端为准（RoleApi.select 拿完整数据 → StorageManager.cacheServerRole 带 revision → StorageManager.onlineRole → 进场景，数据不完整则不进场景）、落盘唯一出口 updateOnlineRole 同时是进度同步唯一触发点（RoleSync 防抖 1.5 秒、Game.onDestroy 里 flush 补推并摘除五个回调）、角色修订号乐观锁自愈链（onSaved 写回版本 / 命中 20006 不重试不覆盖而是静默拉最新交给 onConflict 后台改动优先 / 命中 20002 角色被删则 onMissing 清缓存回选角场景 / 命中 20007 被管理员下线则 onKicked 只清在线标记 clearOnlineRole 绝不删角色）、令牌作废 40103 回登录、失败降级不阻断游戏、新增脚本必须补 .meta、client/assets 改动后要 grep 核对磁盘并 sleep 20 秒复检编辑器回写、client/tools/lib/net-sandbox.cjs 与 client/tools/test-client-net.cjs 的沙箱单测写法（XMLHttpRequest 由测试注入）、仓库根 tools/audit-api-hardcode.cjs 与 audit-api-generated.cjs 两道守卫、每处理完一个问题按功能提交一次代码。触发场景：用户说"客户端连不上服务端""加一个客户端请求""登录注册选角出问题""角色进度没保存""后台改了角色玩家这边被覆盖""角色数据丢了""被踢下线了""提示已被管理员下线""改网络层""跑客户端网络层单测""接口报错提示不对""打包后请求失败""提交代码""commit"。
agent_created: true
---

# olua 客户端（Cocos Creator）：与服务端打交道的那一层

Cocos 工程在 **`client/`**（用它打开这个目录；资源在 `client/assets/`），没有 npm 脚本；用 Cocos Creator 3.8.7 打开 `client/` 运行。
`server/`（NestJS）与 `admin/`（React）是另外两个**平级**子工程；仓库根只放总 README / FAQ、跨端 `tools/` 与官网等。

## 一、两条必须记住的边界

1. **本地 `roles` 只是缓存，服务端才是权威。** 进游戏必须从服务端拿完整数据，拿不到**不进场景**；同时写入必须经过服务端。
2. **游戏数据的唯一真相是客户端自己的 `assets/configs`。** 服务端只存一份不透明 JSON，它不认识装备槽位名、技能 id、地图 id。所以「服务端校验失败」几乎总是**客户端发出去的形状不对**，而不是服务端不懂游戏。

## 二、`ui/utils/net` 的分工（生成物 / 手写）

| 文件 | 来源 | 干什么 |
|---|---|---|
| `ApiRoutes.ts` | **生成**（禁止手改） | 路径表 —— 客户端唯一的接口路径来源 |
| `ApiModels.ts` | **生成** | 服务端 DTO 的镜像（实体类型） |
| `Api.ts` | **生成** | 接口方法（`HealthApi` / `AuthApi` / `RoleApi`），并再导出模型类型 |
| `HttpClient.ts` | 手写 | 请求的唯一出口：XHR、令牌注入、超时与重试、包裹解包、`ApiError` 归一 |
| `ApiCodes.ts` | 手写 | OpenAPI 表达不了的三样：错误文案 key、`RELOGIN_BIZ_CODES`、`ROLE_SYNC_BIZ_CODES` |
| `ApiError.ts` | 手写 | 错误归一（kind：network / timeout / http / business）与 `needRelogin` |
| `Session.ts` | 手写 | 令牌与会话（localStorage） |
| `RoleSync.ts` | 手写 | 角色进度同步（防抖推送 + 乐观锁自愈） |
| `NetworkSetup.ts` | 手写 | 把请求层接到入口（`Game.ts`）的接线 |

**生成物的来源与服务端同源**：`server/openapi.json` → `tools/gen-api.cjs`。
改接口**只改服务端**再 `cd server && npm run gen:api`；生成物手改会被 `tools/audit-api-generated.cjs` 拦下。

## 三、地址与请求的唯一出口

- **地址**：`client/assets/configs/network.ts` 的 `baseUrl`（默认 `http://localhost:3100/api`）。客户端代码里**不允许**再出现任何服务端地址字面量；真机调试改成局域网 IP。
- **请求**：只能从 `ui/utils/net/HttpClient.ts` 发出。业务层不碰 XHR、不拼令牌、不判状态码。
- 同一配置文件里还有 `timeout`（单次超时）/ `retry`（**只重试网络层失败**，业务失败不重试）/ `roleSyncDelay`（进度同步防抖）。
- 守卫：在**仓库根**跑 `node tools/audit-api-hardcode.cjs`。

## 四、错误处理口径

- 三端统一响应包裹 `{ code, message, data, timestamp }`，`code === 0` 才是成功；请求层负责解包，业务层只拿 `data`。
- 失败统一归一成 `ApiError`，**提示文案优先用服务端的 `message`**，兜底才走 `configs/texts` 里的 `net_*_tip`（代码里禁止写中文文案）。
- **`silent` 模式**：失败不弹全局提示，但 `needRelogin` 仍然回登录场景。**角色进度同步必须走 silent** —— 否则后端一挂会按防抖节奏反复刷屏。
- 命中 `ApiCodes.RELOGIN_BIZ_CODES`（40100/40101/40102 + **40103 令牌被作废** + 10004 封禁）→ 清会话回登录。40103 出现在「管理员在后台重置了你的口令」时：不只是口令变了，**手里这个令牌已经作废**，只能重新登录。

## 五、角色数据流（进游戏 / 存档 / 自愈）

**进游戏**：

```
RoleApi.select(id)  →  StorageManager.cacheServerRole(detail)   // 连 revision 一起缓存
                    →  StorageManager.onlineRole(id)
                    →  进场景
```

**数据不完整（缺 data / 解析失败）→ 不进场景**，宁可留在选角界面也不能进一个空角色。

**存档**：`StorageManager.updateOnlineRole` 是**落盘唯一出口**，同时也是**同步唯一触发点**（内部 `RoleSync.schedule` 防抖 `roleSyncDelay`）。
`Game.onDestroy` 里要 `flush()` 补推切地图 / 退出前那一次，并把四个回调**全部置 null**。

**乐观锁自愈链**（`RoleSync` 五个静态回调）：

| 回调 | 触发 | 做什么 |
|---|---|---|
| `onSaved` | 推送成功 | `StorageManager.applyServerRevision` 把新版本写回本地基线 |
| `onConflict` | 命中 **20006**（别处改过） | **不重试、不覆盖**；静默 `RoleApi.detail(id, { silent: true })` 拉最新，交给入口缓存 + 飘字 `role_sync_conflict_tip` + 刷新界面（**后台改动优先**） |
| `onMissing` | 命中 **20002**（角色被删） | 飘字 `role_sync_missing_tip` + `deleteRole` + `loadScene("RoleSelector")` |
| `onKicked` | 命中 **20007**（被管理员下线） | 飘字 `role_sync_kicked_tip` + `StorageManager.clearOnlineRole()` + `loadScene("RoleSelector")`。**绝不能调 `deleteRole`** —— 角色还在，删了就真没了（`tools/test-client-net.cjs` 钉了「这段处理里不许出现 `deleteRole`」） |
| `onFailed` | 其它失败 | 留给下一轮防抖，不打断游戏 |

20002 与 20007 只差一个码，后果却完全相反：**前者是「这个角色没了」，后者是「这个角色不让你现在玩」**。写反了就是把玩家练的号删掉。

新增字段不影响旧行为：`revision` 是**可选**的，不带就是「最后写入者胜」。

**角色外观的取源只有一处**：`configs/fashionClothes` 的 `getFashionOut` / `getFashionIn`，优先级 **时装（`fashionCloth`，时装 id）> 装备衣服 > 性别默认外观**。
场景主角（`RoleAppearance`）、进图预载（`PreloadManager`）、弹窗内观（`RoleInShowView`）、**远端玩家（`OtherPlayerManager`，数据来自互见帧的 `appearance`）** 四处都调它 —— 谁自己判一遍，就会出现「弹窗换了、地图上还是旧的」「进图第一帧空着」或「别人看你还是旧衣服」。
`RoleAppearance` 收的是**结构化子集** `RoleOutSource`（`sex` / `equipments.cloth|weapon` / `fashionCloth` / `speedRate`）而不是 `Role`：远端玩家拿互见帧那四样字段拼个轻量对象就能复用同一份装配。**要加装配逻辑就加在这里**，别在别处再写一份（#383 之前远端玩家是自绘的蓝色占位圆，就是这个坑）。
服务端那侧的对应口径：互见帧 `appearance` 的「没穿」用**空串**，客户端 `toOutSource` 转成 `null`；外观与血条分母都按 `PLAYER_APPEARANCE_REFRESH_MS`（默认 5s）懒刷新 —— 换装 / 升级走 HTTP 存档，实时进程不会被告知。
时装**只换外观不换数值**：不重算 `combatCalc`、不动 `hp`；它也没有 `outPositions` / `outScale` 这类几何参数，所以缩放与偏移仍按装备那件（穿时装不会把角色挪位）。
⚠️ `findOnlineRole()` 每次都从 localStorage 解析**新对象**：改完字段要把**同一个对象**交回 `updateOnlineRole`，写成 `updateOnlineRole(findOnlineRole())` 会把改动丢掉。

## 五之二、实时帧的落点：一条帧 → 一个 Store → 只演不算

服务端推下来的东西（互见 / 怪物 AI / 结算 / 拾取 / 聊天 / 任务 / **队伍**）都走同一条链路：
`RealtimeClient.onFrame` 按 `type` 分发 → `CombatChannel.dispatchXxx`（只做形状校验）→ **一个静态 Store** → 界面订阅 Store。
**别在组件里直接吃帧**：帧是「变化事件」，界面是「当前状态」，中间少一层就会到处补「关掉弹窗后状态还在吗」这种逻辑。

| 帧 | 落点 | 谁读 |
|---|---|---|
| `players` | `OtherPlayerManager`（互见视图）+ `SocialStore`/`PartyStore`（关系原料） | 地图上的名字颜色、社交面板「附近」 |
| `chat` | `ChatStore` | 聊天弹窗与屏幕气泡 |
| `quest` | `QuestStore` | 追踪栏 / 任务弹窗 / NPC 头顶标记 |
| `party` / `partyInvite` / `expGain` | `PartyStore` | 队伍弹窗、队友金名、经验条 |

- **关系判定只有一个入口**：`configs/social.resolveRelation`，优先级 **拉黑 > 敌人 > 同队 > 同帮 > 好友 > 同地图 > 普通**（同队是 #399 插进去的，队友金）。判定要的两半 —— 我这一半 `SocialStore.relationSelf()`（其中 `partyId` 取自 `PartyStore`）、对方那一半来自互见帧 —— 都在本地，所以关系一变就 `applyRelations()` 就地改 `Label` 颜色，**不重建节点**。
- **Store 的 `clear()` 不拆订阅**：`OtherPlayerManager` 的「关系一变就重刷」是长期订阅，清订阅的症状是「换角色回来队友名字永远是白的」（`SocialStore.clear` / `PartyStore.clear` 都是这个口径，而 `QuestStore.reset` 因为弹窗自己订阅/退订才清 listen）。
- **服务端时钟的字段要换算**：`partyInvite.expiresAt` 是服务端毫秒，直接和本机 `Date.now()` 比会在两端差几分钟时「刚收到就过期」；收到时先算 `expiresAt - 现在` 折成本机到期时刻。
- **「队友分到的经验」必须照搬 `revision`**：那份经验是服务端直接入账的，`StorageManager.applyPartyExpGain` 只改 `exp / level / revision`，**不碰血量**（队友打怪不是我在挨打），不更新基线的话下一次防抖存档必撞 20006。
- 新增一条帧的固定动作：`CombatChannel` 加类型 + `onXxx` 出口 + `dispatchXxx`（形状校验）→ `RealtimeClient.onFrame` 加一条 `if` → `Game.ts` 接线并在 `onDestroy` 置 null → Store + 界面订阅。

## 五之三、HTTP 拉的榜 vs 帧推的状态（#400 排行榜）

榜**不开帧**：一分钟才变一次，开面板时拉一次就够；开成帧只会让「谁在什么时候看到哪一版榜」变得随机。
但它仍要一个 Store（`ui/core/LeaderboardStore.ts`），因为**多个界面要读同一份数据**、且要跨「打开/关闭弹窗」活。

- **`page` 与 `me` 必须并发拉同一份快照**：两个接口的 `computedAt` 相同，分开拉会有窗口期让「我第 37 名」和列表第 37 名不是同一个人 —— 那是这个面板最刺眼的不一致。写成 `Promise.all([page(...), me(...)])`，别写成「先列表、再补自己」。
- **切页签就 `reload`，不读缓存**：玩家打开榜就是想看新的；缓存会让他怀疑「我升级了怎么没动」。仓里**故意没有** `ensure`（「有数据就不拉」的语义留着就会让人以为切页能省一次请求）。
- **请求失败不清旧数据**：只置 `failed`，界面顶部提示一句，旧那份继续显示 —— 一次网络抖动不该把玩家正在看的榜擦成空白。
- **`clear()` 在 `Game.onDestroy` 里调**（跟 `PartyStore.clear()` 并列）：榜里的「我的名次」属于上一个角色，带过去会写错名字。
- **入口挂现成的装饰图**：底部功能栏十格已排满，排行榜用的是小地图本来就有的 `small-map/ranking-list`；`bindPointerAction` 绑上去即可，不新增素材。
- **`padStart` 用不了**（客户端 tsconfig 的 lib 没到 ES2017）：名次补零手写 `rank < 10 ? "0" + rank : String(rank)` 这类判断。
- 阈值/时长这类数字**别散在组件里**：`row.topRankThreshold`、`summary.freshMs` 放 `configs/layout/dialogs.ts`（`audit-config-leak` 会把裸比较打回）。

## 六、客户端改动的固定动作

1. **改接口相关** → 先改服务端，`cd server && npm run gen:api`，再改调用点（签名不兼容会**编译报错**）。
2. **新增脚本 / 资源** → **必须补 `.meta`**（uuid 由路径派生即可，`importer` 用 `typescript`、`ver` 照抄同目录既有文件），否则 Cocos 不导入、运行时报找不到模块。生成物由生成器自动补。
3. **改完 `client/assets/` 下任何文件** → `grep` 核对磁盘 + **sleep 20 秒后复检指纹**（本机编辑器会周期性回写覆盖外部修改）。
4. **批量转换只用 `Array.from` / `forEach`**：打包用 babel loose 模式，`[...迭代器]` 会被编译成 `[].concat()`，**结果是恒空数组**。

## 七、沙箱单测（不启动 Cocos 也能测请求层）

- `client/tools/lib/net-sandbox.cjs`：把 `configs/network` + `types/common` + `ui/utils/net/*` 编成 CommonJS 塞进沙箱，**`XMLHttpRequest` 由测试注入**，返回 `{ Api, HttpError, Session, RoleSync, ApiRoutes, ApiErrorTextKey, RELOGIN_BIZ_CODES, ROLE_SYNC_BIZ_CODES, getText, sys }`。
- `client/tools/test-client-net.cjs`：行为断言 + **源码接线断言**（正则匹配关键调用形态）。改请求层签名后要同步这里，否则会假失败。
- 沙箱加文件时**要同步 `net-sandbox.cjs` 的 `FILES` 清单**；`storage-sandbox.cjs` 更敏感 —— **改 `StorageManager` 的 import 就要同步它的 `STUB_IMPORTS`**，否则 7 套 storage 系单测一起挂。
- 沙箱库的 `PROJECT_ROOT = __dirname/../..` 自动指向 **`client/`**（因为脚本已住进 `client/tools/`），所以脚本里的 `PROJECT_ROOT/assets/...` 一律不用加前缀。
- 单测沙箱的通用做法见 skill `cocos-node-sandbox-test`。

## 八、验证闭环

> 仓库根有 Makefile：`make client-check` / `make client-test` / `make client-test-one T=xxx` /
> `make client-gen-monster` / `make client-clean-frames` / `make audit` 一条命令等价；`make help` 列全部。

客户端脚本住在 **`client/tools/`**（自带 `lib/` 沙箱），**在 `client/` 下跑**；跨端审计脚本住在**仓库根 `tools/`**，**在仓库根跑**：

```bash
# ① 在 client/ 下：类型检查（Cocos 自带 tsc）+ 单测
cd client
# 配置随仓库提交：client/tools/tsconfig.check.json（types 指 ../temp/declarations/cc，只开 noUnusedLocals）
node /Applications/Cocos/Creator/3.8.7/CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin/tsc -p tools/tsconfig.check.json
node tools/test-client-net.cjs          # 请求层单测（含自愈链五个回调与接线断言）
node tools/test-role-delete.cjs         # 角色删除 + clearOnlineRole（只清在线标记不删角色）
node tools/test-texts.cjs               # 文案 key 覆盖率
# 其余 tools/test-*.cjs 全跑一遍（背包 / 装备 / 摇杆 / 弹窗层级 / 排行榜…；套数以 ls 为准，别在文档里写死）
for t in tools/test-*.cjs; do node "$t" || exit 1; done

# ② 在仓库根：跨端审计（它们同时扫客户端 / 服务端 / 管理端）
cd ..
node tools/audit-api-hardcode.cjs       # 地址 / 请求 / 路径唯一来源
node tools/audit-api-generated.cjs      # 生成物与文档一致
node tools/audit-config-leak.cjs        # 可配置项有没有外泄
node tools/audit-ui-click-through.cjs   # UI 点击会不会穿透到世界
```

> 放在 `/tmp` 下的 tsconfig 在本机读写出过怪问题（`TS5058` 路径不存在 / `cp` ENOENT），所以用**随仓库提交的** `client/tools/tsconfig.check.json`（不是 `temp/`，temp 会被 Cocos 重建且不进版本库）。

本机（WorkBuddy 环境）跑 Node 子进程相关脚本，必要时清掉注入的环境变量：`env -u NODE_OPTIONS node tools/xxx.cjs`。
另：本机 Bash 的 `grep` 对 `client/assets/` 恒返回空（假阴性），检索该目录**一律用 Grep 工具**。

## 九、提交纪律（强制）

**每处理完一个问题，就按功能提交一次代码 —— 不要攒着。**

- 一个功能一个 commit，**改完立刻提交**；不要把多个不相关改动混在一次提交里（这样「哪次改动引入了回归」永远能二分出来）。
- 提交前把该跑的验证跑绿（见上一节），**全绿才提交**。
- 提交信息用 `feat|fix|refactor|docs|test|chore(端): 一句话说清做了什么`（`chore` 用于构建 / 工具 / 依赖），正文列关键改动与验证结果。端取 `client` / `server` / `admin`，跨端的用 `repo` 或省略。
- 按目录边界拆分提交最省事（`git add client` / `server` / `admin`）；涉及多个端的同一功能，拆成「服务端 / 客户端 / 管理端 / docs」几个提交，顺序按依赖（服务端先）。

```bash
cd /Users/tz/workspace/olua
git add client && git commit -F - <<'EOF'
feat(client): 被管理员下线时只清在线标记并回选角界面

- RoleSync.onKicked 自愈链第 5 条：只清在线标记，绝不 deleteRole
- 验证：tsc 0 错；test-client-net / test-role-delete / test-texts 全绿
EOF
```

## 十、相关

- **纯客户端玩法约定**（装备 15 变体与素材 trim 三规则 / 帧号基准 / 成长线同构 / `hpRecover` / 军衔头顶红字 / 弹窗置顶 / 摇杆 / 怪物生成器 / 掉落与伤害 / 单测沙箱表）：本技能内的 `references/gameplay-conventions.md`
- 契约从哪来（`operationId` / 装饰器 / 生成器 / 守卫）：skill `olua-server` 的 `references/contract-pipeline.md`
- 服务端怎么补接口与权限：skill `olua-server`
- 管理端怎么消费同一份生成物：skill `olua-admin`
- 在 node 里跑 Cocos 核心代码的沙箱做法：skill `cocos-node-sandbox-test`
- 可配置项收敛约定：skill `cocos-ui-layout-config`
