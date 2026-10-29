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
**外观位置的锚点是「画布中心」，不是「脚下」**：衣服 / 武器 / 裸模三个节点都是默认 `anchor 0.5/0.5` 的 Sprite，`outPositions = 0` 的语义是「**画布中心**落在角色脚下」；而美术画布底部还留着 25~66 单位的空白，所以全 0 会把外观整体沉到地面以下（裸模曾因此沉 31 —— 开着 `debug.colliderRange` 时一眼能看到身体落在碰撞盒的下半部分，看着像「锚点跑到人物身体正中间」）。踩地面的偏移只能按素材量：出厂值见 `configs/role`，其余件归管理端「装备对齐」（`/equip-align` 的「脚底贴地」按 alpha>200 的轮廓算）。别在运行时按内容 bbox 猜 —— 裁剪框里混着影子和光晕，按它算永远差几个像素。
**内观是另一套几何**（`in_position` + 两轴缩放 + `inManual`）：弹窗里只有一个朝向，衣服对背景图上的**圆盘**、武器对**第一件衣服**（管理端 `/equip-in-align`）。几何下发走 `apply-snapshot.ts` 的**第二处显式例外**（`applyEquipInAlignRows`，与外观那处并列；仍是「先还原出厂值再覆写」，且 `ConfigLoader` 每次进图都拉），所以别在别处再写一份覆盖逻辑。武器的 `inManual` 为真时 `RoleInShowView.alignWeapon()` **首行就短路**、用配置绝对值 —— 否则运行时算法会把刚保存的值当场覆盖（没勾的继续自动算）。
**内观几何还要「开弹窗就再拉一次」**（#527）：外观看的是场景里的角色，重进图必然重画；内观只在角色信息弹窗里出现，玩家保存完的第一反应是**再点开弹窗看一眼**，那时场景没重载 —— 只靠进图拉一次必然「看不到变化」。`ConfigLoader.refreshInAlign()` 每次开弹窗拉一次（1 个请求、几百字节），拉到后由 `RoleInfoDialog.open()` 就地重建内观节点；它**不复用**进图那次去重的 `inAlignLoading`（被上个 Promise 顶掉 = 没拉）。另外两套几何的 `catch` 都改成 `console.warn`：一个 404（服务端旧版本）与「保存没生效」长得一模一样，静默吞掉就是吞掉证据。
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

## 五之四、事件驱动式引导（#402，后续成就 / 图鉴 / 任务提示都复用这套）

新手引导（`configs/guide.ts` 六步 + `ui/utils/guide/guide-progress.ts` 纯函数 + `ui/core/GuideStore.ts` + `ui/components/GuideOverlay.ts`）
定型了几条与「引导」本身无关、但凡是**引导类 UI** 都适用的做法：

- **推进靠事件，不靠点「下一步」**：六个触发 `move`/`kill`/`pickup`/`openBag`/`openSkill`/`openChat`（`GUIDE_EVENT`），
  **只有当前步的 `trigger` 命中才前进**，别的事件一律不越级 —— 否则「先点背包」会把「走路 / 打怪 / 拾取」三步一起吃掉，
  玩家一句话没看就通关了。代价是每步都得有可观测触发点，所以步骤表是**有限触发集合**的配置，加步不改代码、加新触发方式才改代码。
- **移动按实际位移判**：`Game.update` 里 `Vec3.distance(当前, 上一帧)` 累计到 `tuning.moveDistance(260)` 才算一次。
  摇杆 / 方向键 / 点地面走都是「我在移动」的同一件事，别去监听某一个输入源。
- **高亮用语义位，不写坐标**：`GUIDE_SPOT`（`joystick` / `nav:bag` / `nav:skill` / `nav:chat` / `shortcut`）由组合根注册的
  `spotProvider` 换成真实节点。HUD 是贴边重排的，写死坐标换宽高比就偏；**取不到节点要退化成「只显示气泡」**，
  不能让整层不显示（少个高亮是小事，引导消失是事故）。
- **遮罩不拦点击、不锁移动**，只有跳过按钮是按钮（单测直接断言 `!/blockClickThrough|addComponent\(Button\)/`）。
  引导卡住比「玩家没看完」严重得多。
- **遮罩用四块矩形拼，不用 `Mask` 也不贴图**：洞的矩形取目标 `getBoundingBoxToWorld()` 的**两个对角点**分别
  `convertToNodeSpaceAR` 再算宽高 —— 父层带缩放时「中心 + 世界宽高」算出来会偏，而 HUD 正是带缩放的。
- **气泡贴边夹取**：洞在上半屏就放下面，反之放上面，再按 `screenMargin` 与自身尺寸四向夹，保证不出屏。
- **状态落盘走标准路径**：`GuideStore.apply` → `role.guide = next` → `StorageManager.updateOnlineRole(role)`。
  属性重算 / UI 刷新 / `RoleSync` 防抖都归它；**不开「只写本地」的旁路**，否则与服务端漂移。
- **`skipped` 是显式选择**：跳过落存档后不再弹也不再自动开始；「已跳过」与「走完了」是两条路，飘字必须分开。
- 老号判据是**「存档里有没有 `guide` 字段」**（`normalizeGuideProgress(undefined)` → 已完成），不是等级也不是建号时间。
- 组件里的节点名 / 颜色 / 阈值全部进 `configs/guide.ts`（`audit-config-leak` 会把它们打回，本刀被拦了 21 处）。



1. **改接口相关** → 先改服务端，`cd server && npm run gen:api`，再改调用点（签名不兼容会**编译报错**）。
2. **新增脚本 / 资源** → **必须补 `.meta`**（uuid 由路径派生即可，`importer` 用 `typescript`、`ver` 照抄同目录既有文件），否则 Cocos 不导入、运行时报找不到模块。生成物由生成器自动补。
3. **改完 `client/assets/` 下任何文件** → `grep` 核对磁盘 + **sleep 20 秒后复检指纹**（本机编辑器会周期性回写覆盖外部修改）。
4. **批量转换只用 `Array.from` / `forEach`**：打包用 babel loose 模式，`[...迭代器]` 会被编译成 `[].concat()`，**结果是恒空数组**。

## 五之五、成就面板：进度由服务端算，客户端只画（#401）

成就（`configs/achievement.ts` + `ui/core/AchievementStore.ts` + `ui/components/dialogs/AchievementDialog.ts`）
与排行榜同一取向（HTTP 拉，不开帧），但多一条更容易踩的纪律：

- **进度与达成判定一律来自服务端**：服务端给的是**已经钳到门槛**的 `progress` / `target` 与 `achieved`。
  客户端**不要再算一遍** —— 累计型的进度来自事件记账、状态型是查询时按「等级 / 战力 / 背包持有量」现算的，
  本地复算必然与服务端漂移（最典型：「背包里刚好有 20 张兽皮」）。面板只负责画。
- **切页签就 `reload`，不做「有数据就不拉」**：状态型的进度取决于角色当前状态，缓存一份十秒前的只会显示旧进度。
- **领取成功用返回值覆盖整份快照**（服务端返回的就是最新全量），不在本地拼装；**失败只清 `busyId`、保留旧数据** ——
  背包满（20012）时玩家清完格子直接再点一次，界面不该因为一次失败变成空列表。
- **业务码从 `ApiError.code` 取**，其余走通用失败文案。**背包满不再是失败**（#429 起服务端把整份奖励转成邮件）：
  `claim` 返回 `mailId` 非空就飘「奖励已发至邮箱」—— 玩家不会再停在「先清出格子」的死路上。
- **`busyId` 防连点**：`claim` 里先判 `if (this.state.busyId) return`，再置忙。
- **隐藏成就未达成时不剧透**：描述换成一句静态提示（`texts.hiddenHint`），条件只在达成后才可见。
- **按钮三态各走各的底色**（可领 / 已领 / 未达成），且**只有「可领且不在领取中」才绑点击** ——
  已领与未达成都不该有响应，比点了弹一句「不能领」干净。
- **入口用现成素材**：小地图左侧竖排第二颗 `small-map/achievement` 美术稿本来就有，之前是纯占位。
- `Game.onDestroy` 里 `AchievementStore.clear()`（成就墙是「这个角色」的，不能带给下一个角色）。
- **规模 24 条**（battle 10 / growth 8 / explore 6，含 3 条隐藏，#428）：扩容只改
  `configs/achievement-data.ts` 这一份纯数据，`gen-shared-data` 一跑服务端 seed / 管理端 / 客户端同到位。
  条数断言有三处（`test-achievement.cjs` 的配置条数、`e2e-achievement.cjs` 的快照条数与「管理端列表条数」），
  改数据必同改。同分类内 `order` 按难度递增、奖励随之上抬 —— 不允许「后一条奖励不如前一条」。

## 五之六、消息中心：一颗图标装两件事（#429）

小地图左侧的 `mail` 图标不再单指公告，而是**消息中心**：邮件面板里带公告入口
（`MailDialog` 的 `onOpenAnnouncement` 回调）。理由是竖排每加一颗图标都要挪整列，
而「邮件 + 公告」本来就同属「消息」。

- **红点口径 `unread + unclaimed`**：面板每渲染一次就把合计回吐给 `SmallMap`
  （`onUnreadChange?.(box.unread + box.unclaimed)`），红点 = 邮件未读 + 未领附件 + 未读公告，任一 > 0 就亮。
  配置里叫 `mailEntry` / `entryDot`（原 `announcementEntry` / `announcementDot`）—— 名字跟着语义走。
- **单列列表，不做左右两栏**：一屏能看全，每行「标题 / 附件摘要 / 领取 / 删除」一条线走到底。
  附件摘要用快照物品表 `items.get(goodId)?.label`，不硬编码名字。
- **删除按钮的可点条件写进渲染**（`row.claimed || hasNoAttachment(row)`）：附件没领就不能删，
  点了只飘一句 `removeUnclaimed`（服务端还有 50143 兜一层，但客户端不该让玩家点到才被拒）。
- **`MailStore` 的 `busyId: "*"`** 让「一键领取」与「单封领取」互斥 —— 同一封邮件被两条路径同时发奖
  是完全可避免的；单封领取用邮件 id 占位，判据只有 `if (this.state.busyId) return`。
- **领取结果用返回值覆盖整份 `MailBox`**（`toBox(result)`），失败只清 `busyId`；
  `claimAll` 返回 `claimedCount` + `stoppedByBag`，飘字据此分「全部领完 / 背包满停下」两句。
- 文案与几何全在 `configs/mail.ts`（`mailTexts` + `mailDialogLayout`，节点名 `mail_*`）——
  面板里不许出现字面量。

### 五之六·补：频道页签只筛不请求（#436）

面板顶部多了一行五个页签（`mailChannels`：全部 / 系统 / 奖励 / 社交 / 战斗），
**页签是纯本地筛选，不是请求参数**：

- `MailStore.visible(state)` 是唯一筛选口（`all` 原样返回，其余 `filter(mail => mail.channel === ...)`），
  面板里取行用它、**不要**直接用 `box.mails`；
- **切页签不发请求**（`setChannel` 只改本地 state + emit，同值直接 return 不重绘）：
  服务端一次给全量 + 四栏角标，切页签若重拉就会闪加载态、还会出现「切回全部要重拉」；
- **红点与顶部小结永远按全量**（`unread + unclaimed`），角标画在页签右上角（`>9` 显示 `9+`）；
- **一键领取跟着页签走**：`MailStore.claimAll()` 把当前频道带给 `GameMailApi.claimAll({ channel })`，
  「全部」页签才是不带参数；可点判据也换成当前栏的 `unclaimedIn(channel)`（别拿全量数字点亮它）；
- **两种空态分开写**：整箱为空 `emptyList`，这一栏为空 `emptyChannel`（后者切到「全部」还有别的邮件）；
- 页签几何在 `mailDialogLayout.tabs`（宽度 / 间距 / 选中态 / 角标偏移），整行居中按 `mailChannels.length` 算 ——
  加第六个页签不用手调坐标。

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
