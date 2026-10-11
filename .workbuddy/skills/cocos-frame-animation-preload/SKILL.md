---
name: cocos-frame-animation-preload
description: Cocos Creator 3.x 里给「帧动画驱动」的游戏做资源预加载、缓存与播放，解决几类典型症状：进图/切场景卡顿（几十上百个节点各自 resources.loadDir 同一个目录、各自把几百帧切成几十个 AnimationClip）、一部分外观进图后一段时间才出现甚至不出现、以及 TexturePacker 图集（plist）来源的帧动画播放异常（帧序乱/缺帧/速度不对/特效不出现）。含：帧序列缓存 + 动画片段跨节点共用（AnimationClip 可共享、AnimationState 每节点独立）、从 TMX 原文推导"这张图要用哪些动画目录"、按目录并发池预加载与进度上报（过渡场景 Loading）、组件复用（同帧 destroy+addComponent 会出现两个组件）、Animation.clips 清空语义、场景切换 autoReleaseAssets 对 JS 缓存的影响；图集来源另有 4 个坑（帧名带扩展名导致 Number("00000.png")=NaN 排序静默失效、同一动画分页 @0/@1 需用 getDirWithPath 同步索引合并、帧号是组号+序号按数值排、sourceSize 即美术世界尺寸故用 RAW+trim=false）、播放速度语义（createWithSpriteFrames 第二参是帧率 sample；动作动画总时长 = 1/speedRate；本类 play 系列"时长秒"与 playLoopWithFrames"每秒帧数"的区别与踩过的 bug）、技能特效的一次性播放与挂在自己/目标身上的接线、**常驻循环装饰动画（装备品质边框：几十个格子共用同一图集的 clip 缓存、多尺寸家族 contain 适配、未裁剪但 offset 非 0 的图集必须 trim=true 否则整帧跑偏）**。触发场景：用户提到"首次加载很卡/进图卡顿"、"怪物/NPC/装备外观没加载出来"、"预加载地图资源"、"预加载帧动画"、"loadDir 重复加载"、"切场景资源重新加载"、"Loading 进度"、"技能特效/特效播放速度"、"帧动画顺序不对/不播放"、"plist 图集"、"装备边框/品质光效/格子发光边框"、"边框位置不对/偏移/跑出格子"、"边框显示成斜的/变形"。
agent_created: true
---

# Cocos 帧动画预加载与缓存

## 一、症状 → 根因

**症状**：进图/切场景明显卡顿；进图后一部分怪物/NPC/角色外观"没加载进来"（过一会儿才出现，或场景切走前一直不出现）。

**根因**：帧动画是**逐节点异步加载**的——每个节点自己去 `resources.loadDir(dir, SpriteFrame, cb)` 加载自己那套几百帧，回来后还要把整包帧切成一张动画表（角色/怪物是 `动作 × 8 方向`，通常 60~90 个动画名）。

设 N 个节点用 M 套外观（N 常常远大于 M：某张图 4 种怪各刷 30 只 = 120 个节点 / 4 套外观），代价是：

- `loadDir` 调用 N 次（目录扫描 N 次；帧资源本身按 uuid 命中缓存，但回调与切片不会省）
- `spliceAnimation` 级别的过滤跑 N 次：M 套 × 88 个动画名 × 每套 ~200 帧 ≈ 每次十几万次比较，再乘 N
- 造 `N × 88` 个 `AnimationClip`（真正的大头，每个 clip 都要建 track/keyframe）
- 节点已经挂进场景但 `Sprite` 还没有 spriteFrame → 视觉上"东西不见了"，异步回调来得越晚越明显

> 一句话：**同一个目录被反复加载、反复切片、反复造片段**。缓存目录 + 共用片段后，代价从 N 份降到 M 份。

## 二、修法（三层，缺一层都效果有限）

1. **帧序列缓存**：`目录 -> SpriteFrame[]`，一个目录只向引擎请求一次（含"加载中"的去重 promise）。
2. **动画片段缓存**：`(动画种类 | 目录 | 速度倍率) -> (动画名 -> AnimationClip)`，**多个节点共用同一批 clip**。
3. **预加载编排**：在过渡场景（Loading）里按进度把"进图马上要用的目录"全部加载完，再进游戏；
   主场景 `start()` 里再兜底调一次（命中缓存立即返回），这样"直接跑主场景"（编辑器里单跑 Game）也不卡。

## 三、必须知道的引擎事实

### 1. `AnimationClip` 可以跨节点共用
`animation.addClip(clip, name)` 只是把 clip 存进组件的 `_clips` 并 `createState(clip, name)`；
`AnimationState` 是**每个组件、每个 clip 一份**，`state.initialize(node)` 把 clip 的 track 绑到本节点（懒初始化，`getState`/`onLoad` 时触发）。
→ 共享 clip 是安全的，只要运行时**不修改 clip**（本类做法：`enableTrsBlending = false`、`wrapMode` 建好后不再改）。

### 2. `Animation.clips = []` 的语义（换外观时必须用）
setter 会：`_crossFade.clear()` → 逐个 `_removeStateOfAutomaticClip` → `createState(新 clips)` → 重置 defaultClip。
`addClip` 遇到同名会 `createState` → `removeState(name)` 覆盖，**但不会清掉"新集合里没有的旧片段"**。

→ 复用同一个动画组件换一套外观（换装、换怪）时，必须先清空：
```ts
if (animate.clips.length) animate.clips = [];   // 否则旧外观有、新外观缺帧的动作会被播成旧外观
clips.forEach((clip, name) => animate.addClip(clip, name));
```

### 3. 别用 `destroy() + addComponent()` 换组件
`Component.destroy()` 只是打标记，真正 `node._removeComponent` 在帧末（`CCObject._deferredDestroy`）。
同一帧里 `getComponent(Animation)?.destroy()` 紧接着 `addComponent(Animation)` 会让节点上**同时存在两个 Animation**，
而且 `getComponent` 返回的是数组里第一个（可能正是那个正在销毁的），两个组件会互相抢同一个 `Sprite.spriteFrame`。
→ 换配置应该**复用组件**：清空 `clips` 重新装，或者只改字段。取组件统一走一个 `useAnimation(node)`：
```ts
const animate = node.getComponent(Animation) ?? node.addComponent(Animation);
```

### 4. 场景切换会不会把 JS 缓存的资源释放掉？默认不会
`director.runSceneImmediate` 里会调 `releaseManager._autoRelease(oldScene, newScene, persistRootNodes)`，它只对**旧场景的依赖列表**做 `asset.decRef(TEST || oldScene.autoReleaseAssets)`：

- `Scene.autoReleaseAssets` 默认 `false`（可直接查场景 JSON：`assets/scenes/*.scene` 里的 `autoReleaseAssets`），
  且 `decRef(false)` 只减计数、不销毁 → **动态 `loadDir` 进来的帧在切场景后依然有效**，可以放心长期缓存。
- 一旦把该开关打开（或显式调 `releaseUnusedAssets`），计数器为 0 的资源会被真的 destroy →
  JS 里缓存的 `SpriteFrame` 变成失效对象，动画会静默不显示。**开启自动释放时，缓存必须配 `frame.addRef()`**。

### 5. 地图资源与它的图集依赖
`resources.load/preload(mapSrc, TiledMapAsset, cb)` 会把 tmx 的依赖（图集纹理）一起加载，所以"预加载地图信息"只需这一个调用，不必自己去找 tileset 图片。

## 四、"这张图要用哪些动画目录"怎么推导（别硬编码）

从地图对象组读编号 → 查配置表拿资源目录。**不需要地图节点**：直接读 TMX 原文即可（预加载阶段还没有地图节点）：

```ts
const xml = mapAsset.tmxXmlStr ?? "";                 // TiledMapAsset 上就有，编辑器导入时原样保留
readTiledObjectsFrom(xml, "npc", "objects")           // 见 skill cocos-tiledmap-objectgroup：从 XML 解析对象
  .filter((o) => o.objectClass === "npc")             // 复活点没有外观，按对象类过滤
  .forEach((o) => tasks.push({ dir: npcs.get(`${o.properties.id}`).src, kind: "frames" }));
readTiledObjects(xml, "monster")
  .forEach((o) => tasks.push({ dir: monsters.get(`${o.properties.id}`).out, kind: "monster", speedRate: 怪物.speedRate }));
```

角色穿戴同理：`role.equipments.cloth?.out || 默认外观`、`role.equipments.weapon?.out`（空串表示这件装备没有外观，别拿空串去 loadDir）。
**用途标签（NPC / 怪物 / 衣服 / 武器）与地图、配置必须一一对应**，漏一个目录，那部分外观就退回"进图异步加载"。

## 五、预加载编排（进度 + 并发）

```ts
// 过渡场景：先 preloadScene（0~50），再做游戏资源预加载（50~100）
await director.preloadScene(scene, onProgress, onComplete);       // 或 await 包一层 Promise
await PreloadManager.preloadGame(mapSrc, role, (ratio, tip) => setProgress(50 + ratio * 50, tip));
```

- **并发池**：一个目录动辄几百张图，同时涌入太多解码任务反而更卡（进度条会卡住不动）。
  用「队列 + N 个 worker」的固定并发（本项目 `configs/loading.ts` 的 `animationConcurrency: 4`）。
- **进度要有阶段文字**：`帧动画 3/7`，否则进度条长时间不动会被当成卡死。
- **目录去重**：`kind|dir` 做 Set 去重，同一个外观被多个点位引用只加载一次。
- **失败要缓存空结果**：目录配错（改名/漏资源）时 `loadDir` 会报错，若不缓存，每次生成节点都会重试并刷一条错误日志（30 只怪 = 30 条）。

## 六、主场景侧的接线（两个容易忘的点）

1. `start()` 改成 `async`，在**创建任何节点之前** `await` 预加载；`
   预加载完成前 `update()` 必须直接 return（`ready` 门闩），否则会用到还没创建的组件。
   跨 `await` 之后要 `if (!isValid(this)) return;`——等待期间场景可能已被切走。
2. `LayerManager.initLayer` 这类**同步且很便宜**的初始化放在 `await` 之前做，让容器先就位。

## 七、验证清单

- 目录清单：脚本化核对"地图对象组里的每个 id 都能查到配置，且目录真实存在"，别靠肉眼。
  用 Python/Node 直接读 `*.tmx` + `configs/*.ts` 对一遍，几秒就能发现漏配或目录改名。
- 同名/同目录复用：同一目录的多个节点应共用同一批 clip（打印 clip 数量或观察内存）。
- 速度倍率进缓存键：`动画表种类 | 目录 | 整套 speedRate`（本类做法整包拼键），否则改了倍率还在播旧片段。
- 断言"进图后第一帧就完整"：进图瞬间截图，怪物/NPC/角色外观应全部有图。
- 直接单跑主场景（不经过渡场景）也要正常，说明兜底预加载接对了。

## 八、可复用的落地结构（本类项目的分层）

| 位置 | 职责 |
| --- | --- |
| `configs/loading.ts` | 并发数、地图信息占进度比例（调快慢只改这里） |
| `ui/helpers/AnimationHelper` | 帧缓存 / 片段缓存 / `prepare(dir, kind, speedRate)` / 同步建动画 / 复用动画组件 |
| `ui/core/PreloadManager` | 从地图+配置推导目录清单 → 并发池加载 → 进度上报 |
| `ui/Loading`（过渡场景） | 进度分配与阶段文字 |
| `ui/Game`（主场景） | `start` 里 await 兜底预加载 + `ready` 门闩 |

## 九、图集（TexturePacker plist）来源的帧动画：这类资源必踩的 4 个坑

目录帧（一堆 `00000.png`）之外，技能特效、UI 提示这类资源常是 **plist + png 同名图集**（引擎按 `SpriteAtlas` 导入，
`resources.load(path, SpriteAtlas, cb)`，路径不含扩展名，如 `effect/skill/s_1002@0`），而且**同名 png 与 plist 共存**，
路径查询可能命中图片资源 → 必须带类型过滤，并保留 `loadDir` 前缀兜底。

1. **帧序排序会静默失效**：帧名常带路径与扩展名（`1002/attack/00000.png`），
   `Number(name.split("/").pop())` = `Number("00000.png")` = **NaN**，比较器返回 NaN 等于"不排序"，
   顺序全靠 plist 原始顺序侥幸正确（换个导出工具就乱）。
   → 取序号先剥扩展名：`Number(tail.replace(/\.[^.]*$/, ""))`，取不到时按 0（`NaN > 0` 为 false 天然兜底）。
2. **同一个动画会被分页**（`s_1102@0` + `s_1102@1`，帧名 `00000@页0`/`00001@页1` 交错）。
   只 load 传入那一页会缺帧。→ 用 **`resources.getDirWithPath(dir, SpriteAtlas)`**（bundle 的**同步目录索引**，
   不加载资源、缺页**不会报错**）取出同名 `@N` 全部分页，逐页 `load` 后合并再统一排序；
   索引拿不到（自定义 bundle）时退回只加载传入那一页。不要用"探测 `@1/@2` 是否存在"的写法去 load 不存在的路径。
3. **帧名里的数字是"组号+序号"**（`40006` = 组 4 第 6 帧），按**数值**升序就是播放顺序（`0 < 2 < 3 < 10009 < 40006`），
   别按字符串排。图集里还常有 3×3 的空占位帧（`sourceSize` 是源画布、`frame` 只有 3×3），保留即可（等价于短暂空帧）。
4. **尺寸口径**：特效/外观图集的 `sourceSize`（如 800×700）就是美术世界尺寸（角色衣服帧常见 400×400），
   所以特效节点应当 **`sizeMode = RAW` + `trim = false` + 锚点居中**，与角色外观节点完全同口径、逐帧不抖动；
   **不要**给特效节点设自定义尺寸（会把 800×700 的美术强行拉伸到别的尺寸）。
   位置直接用作用对象的世界坐标即可（美术自带 offset 已表达相对角色的偏移）。

## 十、播放速度语义（最容易写反的地方）

`AnimationClip.createWithSpriteFrames(spriteFrames, sample)` 的第二个参数是 **sample = 帧率（帧/秒）**，
不是时长：引擎内部 `clip.duration = 帧数 / sample`。

- **角色/怪物动作动画**：`sample = 帧数 × speedRate` → **动作动画总时长 = 1 / speedRate 秒**
  （所以 speedRate 是"每秒循环几遍"：默认 1 → 1 秒一遍；攻击设为 10 → 0.1 秒一遍）。
  写技能特效/连击/冷却的"与动作同步"时，一律用这个换算：特效总时长 = 1 / speedRate。
- **一次性播放 API**：本类 `AnimationHelper` 里 `play`/`playOnceWithDir`/`playLoopWithDir`/`playOnceWithFrames`
  的时长参数都是**总时长（秒）**（内部 `sample = 帧数 / 时长`）；只有 `playLoopWithFrames` 的第 4 参是**每秒帧数**
  （内部按 `帧数 / 帧率` 折算）。
  ⚠️ 踩过的真 bug：`playLoopWithFrames` 文档写"每秒帧数"，实现却把这个值当总时长传下去 →
  15 帧图集传 20 得到"一轮 20 秒、每帧 1.33 秒"的假动画（看起来像没动）。**改语义时务必同步改所有调用点的含义。**
- `wrapMode = Normal` 时 `play` 里注册的 `FINISHED` 回调会 `node.destroy()`，**一次性特效不需要自己回收**；
  但帧还没加载完节点就被销毁（切场景）时要在 `then` 里 `isValid(node)` 守卫。
- 技能特效的统一挂载点应放在**技能释放的统一入口**（校验通过后、调用技能实现前），别写进每个技能实现里；
  "特效挂在自己还是目标身上"用配置字段（如 `effectIsOnSelf`），目标无效（无目标/已死亡技能）时退回释放者。

## 十一、常驻循环装饰动画（装备边框这类「几十个格子挂同一种光效」）

UI 上要给**很多个小格子**挂同一种循环光效（装备品质边框：背包 77 格 + 13 个装备槽）时，
在图集帧缓存之上还要多缓存一层「**片段**」，否则一次背包刷新就造几十个 clip：

- **入口收敛到一个**：`playLoopAtlas(name, node, atlasSrc, frameRate)` —— 图集帧走已有的
  `loadFramesFromAtlas` 缓存，clip 按 `图集|帧率` 缓存（`createWithSpriteFrames(frames, frameRate)`，
  第二参是**帧率**不是时长，见第十节）；`then` 里 `isValid(node) && isValid(animate)` 守卫
  （格子刷新/弹窗关闭会重建边框，加载回来时节点可能已销毁）。
- **挂载位置选「图标的子节点」而不是「格子的子节点」**：边框随图标的 UIOpacity 一起被拖动压暗、
  随图标销毁（不用单独清理），而且格子按子节点找「图标精灵」的逻辑（`children.find(有 Sprite)`）不会误命中边框。
- **多尺寸家族的素材用 contain 适配**：同一批装饰素材常分属多个原始尺寸家族
  （边框实测 91×104 / 200×200 / 80×80 / 98×92 / 89×88 五种）。帧加载完成后取首帧
  `originalSize`，`scale = Math.min(box.w / w, box.h / h)` 后 `UITransform.setContentSize`（**不能** `node.setContentSize`，Node 上没有这个方法），
  外框尺寸进布局配置（格子 50 → 外框 56 = 两侧各 3 溢出，光效刚好压住格子）。
- **预加载「分配表用到的」而不是全部**：84 张素材只分配了 15 张时，预加载只加载分配表命中的
  （`configs` 出一个 `getAssignedBorders()`，`PreloadManager` 进图前 `Promise.all` 拉平），
  未分配的留给以后按需加载。小图集不占进度条。
- **素材索引图**：素材多时用 Python/PIL 按图集 rect（rotated 的先转正）把每张首帧裁出来拼一张
  编号索引图（tools/border-preview.png），调「哪个品质用哪张」的映射表时对着图挑，别靠编号猜。

### ⚠️ 未裁剪但 offset 非 0 的图集：必须 `trim = true`（渲染会整体跑偏的真坑）

TexturePacker 语义里 `offset` = 「原始中心 → 裁剪中心」的距离，**未裁剪的帧 offset 必须是 0**；
但实践中会遇到导出工具给未裁剪帧也写了非 0 offset（边框 84 张全部如此，如 `{-46,58}`）。两条渲染路径的差别：

- `trim = false`（逆向补边路径）：引擎 simple 装配器按 `trimmedBorder = offset + (原始-裁剪)/2`
  **平移整帧画面** → 非 0 offset 会把边框整体挪出节点框（56×56 的框挪出约 28×36 像素）；
- `trim = true`：四边形 = 节点内容尺寸，UV 取 `rect` 全帧、**完全不看 offset** → 未裁剪素材
  rect == 原始尺寸，正好铺满节点框且不变形（这批素材唯一正确的路径）。

配套的守卫：单测断言「每帧 rect 尺寸 == sourceSize」—— 以后真混进来**裁剪过**的素材，
这条断言会提醒你那一件要改回 `trim = false`（否则裁剪帧会被拉伸变形）。

配套的帧序坑：帧名没有 `/` 分段时（`sfx_30123_0_0007`），「剥扩展名后整段 Number」= NaN →
序号全 0，排序失效只能赌图集原始序。→ 比较器最后**再退回按末尾连续数字解析**（`/(\d+)$/`），
对带路径的帧名（`1002/attack/00000`）结果不变，对挂前缀名的帧序号才正确。

