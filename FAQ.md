# 预览与常见问题

> 本文档收纳 olua 的**预览报错**与**踩坑记录**。
> 项目介绍、目录结构、功能清单见 [README.md](README.md)；怎么把项目跑起来见 [README.md 的运行方式](README.md#运行方式)。

## 目录

- [Cocos Creator 预览时报 reading 'width'](#cocos-creator-预览时报-reading-width)
- [传送后地图一片黑、动一下才恢复？](#传送后地图一片黑动一下才恢复)
- [打包后新建角色、背包里没有装备？](#打包后新建角色背包里没有装备)
- [点弹窗的关闭按钮，为什么把下面的 UI 也点开了？](#点弹窗的关闭按钮为什么把下面的-ui-也点开了)
- [点 NPC 弹出弹窗后，角色为什么一直在走？](#点-npc-弹出弹窗后角色为什么一直在走)
- [鼠标一动就报 Cannot read properties of null (reading 'cameraPriority')？](#鼠标一动就报-cannot-read-properties-of-null-reading-camerapriority)
- [弹窗里的功能突然全都不响应了（穿不上装备、卸不下、地图点不动）？](#弹窗里的功能突然全都不响应了穿不上装备卸不下地图点不动)
- [掉落想怎么调？](#掉落想怎么调)
- [界面上的数字/文案想改，到底该动哪个文件？](#界面上的数字文案想改到底该动哪个文件)
- [背包「一键整理」的排序想改（升序 / 部位先后 / 谁排前面）？](#背包一键整理的排序想改升序--部位先后--谁排前面)
- [背包「一键回收」的价想调（太贵/太便宜、想单独改某一件）？](#背包一键回收的价想调太贵太便宜想单独改某一件)
- [删掉的角色能找回吗？为什么删完之后「开始游戏」点不动了？](#删掉的角色能找回吗为什么删完之后开始游戏点不动了)
- [背包里的东西怎么丢？丢错了能找回吗？](#背包里的东西怎么丢丢错了能找回吗)

## 预览报错

### Cocos Creator 预览时报 reading 'width'

如果在 Cocos Creator 预览时出现类似下面的报错：

- TypeError: Cannot read properties of null (reading 'width')
- Preview Error: [Window] ... reading 'width'

通常表示编辑器预览阶段的 Camera / Canvas / Window 绑定尚未完成，或者场景中相机/画布初始化时访问了空的窗口对象。这个问题通常出现在 Cocos 编辑器的预览启动过程，而不是纯 TypeScript 逻辑本身。

建议检查：

- Canvas 节点是否存在且已正确绑定 Camera
- Camera 组件是否被挂载在 Canvas 的子节点
- 场景启动时是否有脚本在 Camera 尚未初始化完成前读取视口尺寸
- 是否在编辑器 Preview 与实际运行环境中切换过分辨率策略

如果遇到该错误，优先确认场景中 Camera 与 Canvas 的组件关系和初始化顺序，再重新运行预览。

### 传送后地图一片黑、动一下才恢复？

引擎的瓦片地图默认开启「按相机视口裁剪瓦片」（`TiledMap.enableCulling` 默认 `true`），而本工程相机是跟随角色移动的；裁剪范围由相机变换事件**同步**重算，此刻相机视图矩阵还没跟上本帧的位置变化，于是瞬移类操作（右键小地图传送 / 突进技能 / 进图复活点定位）会把可见范围算成跳变前的位置，目标区域整片瓦片不渲染。已在 `GameMap.loadMap` 中关闭该裁剪（引擎文档亦要求「瓦片地图采用了摄像机就要手动关闭裁剪」），本项目地图仅 2 层 64×64，全量提交开销可忽略。

### 打包后新建角色、背包里没有装备？

`configs/equipments.getBaseEquipments` 原来写的是 `[...map.values()].filter(...)`。编辑器里没问题，但**打包时 babel 以 loose 模式编译**，会把 `[...迭代器]` 降级成 `[].concat(迭代器)`，而 `Array.prototype.concat` 只展开数组、不认 Map 迭代器 → 结果恒为 `[MapIterator]` 一个元素，过滤后是空数组；新手背包只剩按 key `.get()` 取的 5 件通用件。已改为用 `map.forEach` 收集。

**项目约定：Map / Set 转数组一律用 `Array.from(map.values())` 或 `map.forEach`，不要写 `[...map.values()]` / `[...someSet]`**——后者只在打包产物上才出问题（且不报错，只是静默少数据）。排查方法：在 `build/<平台>/assets/main/index.js` 里搜 `[].concat(`，参数是 `.values()` / `.keys()` / `.entries()` 的就是隐患点。

### 点弹窗的关闭按钮，为什么把下面的 UI 也点开了？

引擎的输入派发是**两条互不相干的通道**（`cocos/2d/event/pointer-event-dispatcher`）：touch 通道只派发给「注册过 `TOUCH_*` 监听的节点」，mouse 通道只派发给「注册过 `MOUSE_*` 监听的节点」，各自按渲染顺序从上到下命中即中断。项目的按钮是 `Button` 组件（内部只注册 `TOUCH_*`），所以它**在 mouse 通道上完全不可见**——一次鼠标点击于是被派发两次：`TOUCH_END` 关掉弹窗，`MOUSE_UP` 继续往下找到小地图自己的 `MOUSE_UP` 监听，又把小地图弹窗打开。

修法是让 UI 点击元素在 mouse 通道上也登记一次（`utils/input/UiHit.blockClickThrough`）：命中即中断，下层再也收不到这次点击。已覆盖所有按钮/勾选/滚动区（`UiHelper.createButton`、`createToggle`、`createScrollView`）、弹窗面板（`GameUiHelper.createDialogBg`，点面板空白处也不穿透）、可拖拽节点（`Draggable`）以及底部栏/快捷键槽/战魂卡片等手写点击元素。

- 只登记 `MOUSE_UP`（防穿透靠引擎的「命中即中断」，与节点有没有 `MOUSE_DOWN` 监听无关），**故意不登记 `MOUSE_MOVE`**：鼠标位置是全局监听在用的（指针样式、按住拖动的方向），节点命中会吞掉 `MOUSE_MOVE`，加进去会让指针移到按钮上时样式与方向卡住
- 冒泡与父子顺序：引擎的优先级排序里**子节点优先于父节点**（后绘制在上），所以关闭按钮能正常收到 `TOUCH_END`
- 自查脚本：`node tools/audit-ui-click-through.cjs`——扫出所有 touch 点击注册点，回溯节点来源，报告哪些已覆盖、哪些漏登记（当前 25/25 全覆盖）。回溯取的是**注册行之前最近的一次赋值**：同名变量在文件里可能被赋值多次（例如 `this.recycleButton = null` 先清理残留引用、之后才由工厂创建），取「首个匹配」会把好好的工厂产物判成未登记 —— 这类「工具报假警」要先怀疑工具；`tools/audit-ui-click-through.cjs` 顶部的 `REVIEWED` 记录了几处「已核对无需登记」的元素与原因（世界侧的 NPC 就是刻意不登记的：登记会顶掉 `MOUSE_UP`，世界点击的全局监听就收不到；NPC 改由 `markWorldInteractive` + `LayerManager.isPointOnWorldInteractive` 在**世界侧**跳过）
- 另注：世界侧「点 UI 不影响角色操作」靠的是另一套判据 `LayerManager.isPointOnUi`（屏幕坐标命中测试），与节点监听无关，两者互补

### 点 NPC 弹出弹窗后，角色为什么一直在走？

两件事叠在一起：

1. NPC 既不在 UI 层、也不是怪物，世界侧的「按住走路」把它当成了空地 —— 按一下就先往 NPC 那边迈步（这就是「误触发鼠标按下的移动事件」）；
2. 上一节那套「命中即独占」会把这次点击的 `MOUSE_UP` 吃掉。而世界侧的按住走路**以按下为开始、以抬起为结束**（`RolePointerInput` 听的是全局 `input.MOUSE_UP`），抬起收不到 → 按住状态不解除 → 角色一直走。

修法（`ui/utils/input/Pointer.ts` 的「按压归属」一节）：

- **NPC 这类「世界侧可交互对象」**用 `UiHit.markWorldInteractive` 标记（`MapObjectSpawner` 里标在**挂了点击监听的节点**上，判定范围与点击范围天然一致）；世界侧在按下/点击前先问 `LayerManager.isPointOnWorldInteractive` → 不走路（`RolePointerInput`），也不清掉当前攻击目标、不打断挂机（`ScreenClickInput`）
- **界面独占抬起时，把这次按压的结束交还世界侧**（`releaseWorldPress()`）：`Pointer.bindMousePress` 与 `UiHit.blockClickThrough` 都接了这个交还；世界侧构造时用 `setWorldPressRelease` 登记一个**幂等**的收尾回调（没按住时什么都不做，所以界面无条件交还也不会误停走路）
- 顺手把 mouse 通道缺的那半截「一次按压归谁」补齐：按下那一刻记下**命中的界面元素**，抬起时只有「起点在本元素或其子树里」才响应这次点击（`isUiPressWithin`）—— 与 touch 通道「`TOUCH_START` 命中者独占整段手势（`claimedTouchIdList`）」的语义对齐。收益：按住走路把指针拖到小地图/按钮/弹窗面板上再松开时，**不会误触发那个界面元素**，同时角色正常停住
- 起点由**每个在鼠标通道上有监听的界面元素**自己登记（`trackUiPress(node)`，`bindMousePress` / `blockClickThrough` 内部自动调用），记的是 `event.target` 而**不是本节点**：节点事件是**冒泡**的，弹窗面板/滚动区这些祖先也会收到同一次按下；但同一次派发里 `event.target` 只有一个值（引擎 `dispatchEvent` 只在派发开始时赋值一次，冒泡阶段不变），所以「各记各的」写进去的值完全一样、与先后无关。反过来若记「本节点」，祖先会在冒泡阶段把内层元素的起点覆盖成自己 → 内层元素（背包格子/装备槽/地图预览图）抬起时匹配不上 → **弹窗里所有点击一起失灵**（背包穿不上/卸不下、地图弹窗点不动）
- 登记点必须是**有 `UITransform` 的节点**：不要图省事把起点挂到 UI 根（`LayerManager.UILayer`）上——它没有 `UITransform`，一注册鼠标事件就会让引擎每次鼠标事件都抛 `cameraPriority` 空指针（见下一条 FAQ）。所有注册入口都过同一道防呆 `ensureMouseHitTestable`
- 判定要认**子树**：背包格子/装备槽里的物品图标注册了 `MOUSE_ENTER`（悬浮详情），点它时命中目标是图标而不是格子，所以取「起点在我或我的子树里」（`target.isChildOf(node)`）
- 注意别自己裸注册 `node.on(Node.EventType.MOUSE_UP, ...)`：那样会在界面上「独占抬起」却没人交还世界侧。统一走 `bindMousePress` / `bindPointerAction` / `blockClickThrough`，自查脚本里有一条专门盯这个
- **只注册悬停事件（`MOUSE_ENTER` / `MOUSE_LEAVE`）的节点同样算「有鼠标监听」**：它是这次按下的命中目标，如果它所在子树里没有别的登记点，就要自己 `trackUiPress(node)`（例：`StatusIconBar` 的状态图标 —— 状态条、角色信息栏这一路都没有登记点），否则它的按下不会被记录、抬起时会读到上一次按下的旧起点
- 自查：`node tools/audit-ui-click-through.cjs` 现在有五段——① touch 点击元素是否都登记了 mouse 通道；② **有鼠标监听的节点是否都成了「按压起点登记点」**（自身 `trackUiPress`，或所在子树另有登记点且写明理由）；③ `blockClickThrough` 调用点；④ mouse 通道独占点是否都走共用助手；⑤ 按压归属的 **13 条关键接线**是否齐全（含一条负向检查：UI 根不得出现 `trackUiPress` / `Node.EventType.MOUSE_`），缺一条就退出码非 0

### 鼠标一动就报 Cannot read properties of null (reading 'cameraPriority')？

这是「把鼠标事件注册到了没有 `UITransform` 的节点上」——最典型的就是 UI 根节点 `LayerManager.UILayer`（`createLayer` 只建空 `Node`）：

- 引擎每个鼠标事件前先给监听节点列表排序（`pointer-event-dispatcher._sortPointerEventProcessorList`），逐个节点缓存相机优先级：`const trans = node._getUITransformComp(); cachedCameraPriority = trans!.cameraPriority;`
- 外层判断是 `if (node._uiProps)`，而 `_uiProps` 在 `Node` 构造函数里就 `new` 出来了（`node.ts` 的字段初始化），**对任何节点都成立**；里面那个 `trans!` 又是非空断言（同一文件 `_sortByPriority` 反而老老实实判了空）—— 于是没有 `UITransform` 的节点一进监听列表就必崩，而且每个鼠标事件刷一次，整个预览的鼠标交互全废
- 这类节点本来也命不中（`_handleMouseDown` 拿不到 comp 直接 `return false`），在它上面注册鼠标事件没有任何意义，纯粹是踩雷
- 防呆：`Pointer.ensureMouseHitTestable(node, api)` 在所有注册入口（`trackUiPress` / `bindMousePress` / `blockClickThrough`）先检查，拿不到 `UITransform` 就跳过注册并 `console.warn` 打出是谁在注册
- 因此「本次按压起点」**不能**挂在 UI 根上（前一版就是这么写的），只能由**每个在鼠标通道上有监听的界面元素**自己登记（见上一条 FAQ）
- 复查手法：审计脚本第 5 段有一条「UI 根不得出现 `trackUiPress` / `Node.EventType.MOUSE_`」的负向检查；模拟脚本 `/tmp/olua-click-check/press-bubble-sim.cjs` 第 0 段复刻了这段引擎排序，能直接复现「挂 UI 根 → 抛错」「同样写法但走防呆 → 被拦下、不崩」

### 弹窗里的功能突然全都不响应了（穿不上装备、卸不下、地图点不动）？

先看「按压归属」的登记方式是不是又走了两个极端之一：

- 节点事件（`TOUCH_*` / `MOUSE_*`）都会**冒泡**：引擎 `_handleMouseDown` 打完命中测试会 `event.bubbles = true` 再 `dispatchEvent`，沿祖先链把同一个事件发给所有监听者（`getBubblingTargets` 一路走到根）
- 而 `event.target` **只在派发开始时赋值一次**，冒泡阶段始终是最初命中的那个节点
- 极端一：**每个元素记「自己」**（第一版）→ 弹窗面板/滚动区这些祖先会在冒泡阶段**把内层元素的起点覆盖成自己**，内层元素抬起时匹配不上起点，弹窗内所有点击一起失灵
- 极端二：**把起点挪到 UI 根统一记一次**（第二版，逻辑是对的）→ UI 根没有 `UITransform`，一注册鼠标事件就把引擎打崩（见上一条 FAQ）
- 正解：登记点 = 有 `UITransform` 的界面元素，记的值 = `event.target`。所有登记点写的是同一个值，所以既与顺序无关、又不会踩 UITransform 的雷
- 链路自检：`node tools/audit-ui-click-through.cjs` 第 2 段会逐个列出「有鼠标监听的节点 → 是否已有登记点」，第 5 段有「记的是派发命中目标」「归属判定含子树」等接线；行为侧用 `/tmp/olua-click-check/press-bubble-sim.cjs` 把五个阶段（原始 / 点击穿透修复 / 各记各的 / UI 根登记 / 本次修复）跑同一批点击场景对比

### 掉落想怎么调？

掉落优先级是 `怪物条目里的 drops / dropPicks` > `configs/monsterDrops` 每怪独立掉落表 > `configs/drop.monsterDrops` 按等级兜底生成。

- 改某只怪掉什么、掉多重、掉几件：直接改 `configs/monsterDrops` 里该 key 的 `entries`（每条独立配 `weight` 权重 / `chance` 概率 / `count` 数量区间）与 `picks`。`picks` 支持数字（固定件数）或 `[最小, 最大]` 区间（例 `[1, 10]` = 本次掉 1~10 件；**每次抽取独立随机、可重复命中同一条目**，重复的会合并数量，默认按定位 普通 `[1,3]` / 精英 `[2,6]` / BOSS `[3,10]`）
- 掉落物散落：`ui/utils/drop/DropScatter.scatterDropPositions` 以落点为圆心按最小间距 `DROP_SCATTER_DISTANCE`(52px，= 图标 40 + 12 留白) 一圈圈贪心铺开，保证**任意两件掉落物都不重叠**（世界坐标无额外缩放，圆即屏幕上的圆）；件数越多圈数越大（10 件最外圈半径 ≈ 102）
- 装备条目口径：取「level ≤ 怪物等级且不超过 10 级、每部位最多 2 档」的基础装备，每件展开全部 15 个前后缀变体（`_p前缀s后缀`，普通的·人级沿用基础 id），权重按前后缀稀有度衰减（前缀 ×[1, 0.7, 0.45, 0.25, 0.12]、后缀 ×[1, 0.5, 0.22]、部位 ×1 / 0.9 / 0.8）
- 因此 555 件装备里：武器 / 衣服随各等级段的怪铺开，头盔 / 腰带 / 鞋子 / 项链 / 戒指目前**只有 1 级新手件**，所以只落在低等级怪（≤11 级）的列表里——补齐这些部位的高等级装备后，把 `EQUIP_LEVEL_GAP` 与 `MAX_TIER_PER_SLOT` 放宽重新生成即可覆盖到高等级怪
- 新增怪物时若忘了铺掉落，会退回 `configs/drop.monsterDrops(level, tier)` 的按等级兜底，不会出现「打死没东西掉」

### 界面上的数字/文案想改，到底该动哪个文件？

一条总原则：**核心代码（`assets/ui`、`assets/skills`、`assets/entities`）只做「怎么跑」，一切可调的东西都在 `assets/configs`**。按你改的东西对号入座：

| 想改什么 | 改哪里 |
| --- | --- |
| 数值/成长/掉落/装备/怪物/技能/地图 | 对应域配置 `configs/{growth,drop,equipments,monster,skill,map,…}.ts` |
| 玩家看到的任何字（提示、校验原因、标签、悬停详情、加载进度） | `configs/texts.ts`（模板写 `{占位符}`，取值用 `getText(key, params)`） |
| 界面位置/尺寸/图片/字号 | `configs/layout/{hud,dialogs,panels,scenes}.ts`（barrel：`configs/hudLayout`） |
| 通用零件长相（空节点调试边框、输入框占位色、飘字配色与时长） | `configs/layout/theme.ts`（`uiTheme`） |
| 碰撞范围可视化的线宽/透明度/配色 | `configs/debug.ts` 的 `rangeStyle` |
| 底部功能入口（名称/图标/解锁等级/快捷键） | `configs/bottomNav.ts`（点击回调留在组件里，按 `key` 关联） |
| 角色体型与碰撞盒、刚体参数 | `configs/role.ts` 的 `roleBody` / `roleRigid` |
| 掉落拾取半径、背包满提示节流、掉落物散开间距 | `configs/drop.ts` 的 `dropRuntime` |

- **文案的取法**：代码里只写 key 与参数，例如 `GameUiHelper.createTip("soul_bind_gold_tip", { need: 1200 })`；模板在 `configs/texts.ts` 里写 `"绑定元宝不足，升级需要 {need}"`。漏传参数会**保留占位符原文**（一眼能看出漏参），key 没登记会返回 key 本身并 `console.warn`
- **校验类文案不散落**：穿戴/进图校验（`GameHelper.getEquipmentRejectReason` / `getMapEnterRejectReason`）只产出 `TextRef`（`{key, params}`），由提示层统一取文案 —— 所以「为什么不能穿」这类判断里也看不到中文
- **`configs` 不依赖 UI**：配置只描述数据，回调/分支留在组件（例：`bottomNavItems` 有 `key`，`BottomBar` 里用一张 `Record<key, 回调>` 表接上）
- **自查（改完跑一下）**：
  - `node tools/audit-config-leak.cjs` —— 报出「散落在 ui/ 里的可配置项」+ 反向检查「代码引用的文案 key 是否都已在 `configs/texts` 登记」。开发期日志（`console.*`）与内部节点名不算外泄，前者直接跳过，后者登记在 `tools/config-leak-allowlist.json` 并写明原因
  - `node tools/test-texts.cjs` —— 文案模板单测（占位符替换、漏参保留、未登记 key 兜底）
- **改配置不生效？** 先看这条是不是「配置改了但代码里又存了一份」：审计脚本的第 1 段就是专门抓这个的，报 0 处才算收敛

### 背包「一键整理」的排序想改（升序 / 部位先后 / 谁排前面）？

搬运与排序是两层，改哪层都清楚：

- **搬运**（合并同类可叠加物 → 排序 → 空格沉底）是纯函数 `configs/items.tidyBagGrid(bag)`：吃二维背包、吐新的二维数组，不碰存档也不碰 UI。它守着两条不变量 —— **行列数不变**、**物品一件不丢**（按 id 汇总数量守恒）；配置表里已下架、解析不出数据的 id 原样保留并排在最后（不合并、不拆堆）
- **排序规则**在 `configs/items.compareBagGoods`：大类（装备 → 药品 → 材料 → 其他）→ 装备组内「等级降序 → 部位 → 前缀降序 → 后缀降序」→ id 兜底（同种物品必然相邻、结果可复现）。想改等级升序、想让药品排在装备前面，只动这一处比较方向
- **部位先后不另写一份**：`configs/equipments.equipmentSlotOrder` 直接按装备槽位配置 `equipmentSlotData` 的顺序生成 —— 改槽位配置顺序时，装备界面排列与背包整理一起生效
- **入口**：背包弹窗底部按钮 → `StorageManager.tidyBag()`，它只负责「取角色 → 调纯函数 → **有变动才落盘刷新**」（本来就很整齐时提示「背包已经很整齐了」，不重复写存储）
- 回归单测：`node tools/test-bag-tidy.cjs`（编译沙箱见 `tools/lib/configs-sandbox.cjs`：把 `configs/items.ts` 编成 CommonJS，再用只实现 `Vec2/Vec3/Size/Color` 的 `cc` 垫片顶替引擎，于是 node 里能跑**真实配置表 + 真实函数**；覆盖乱序混合、满包合并、maxStack 拆堆、部位/前后缀顺序、无效 id、幂等）

### 背包「一键回收」的价想调（太贵/太便宜、想单独改某一件）？

- **价是「等级曲线 × 前后缀倍率」**，唯一来源在 `configs/growth.equipmentRecyclePriceCurve`（6 档分段线性，和角色/怪物同一种曲线）：基础价按装备自己的 `level` 取（60 级约 4 万），前后缀变体再乘 `equipmentPrefixRates × equipmentSuffixRates`（超神·神级 = 基础价 × 4.2）。想整体调价**只改那一段曲线**
- **想给某件装备单独定价**：在它的条目里写 `recyclePrice`（覆盖曲线生成值，与「战斗属性可写可不写」同一套路）。基础件与它的 14 个变体都按这个基础价缩放
- **货币是绑定元宝**（`role.bindGold`，与战魂升级同一个钱包），回收后角色信息栏余额立即刷新；装备详情弹窗（鼠标悬停）里会显示这件装备的「回收价 N 绑定元宝」
- **只回收背包里的装备**：身上穿着的槽位一律不动；药品/材料/解析不出配置的 id 一概不碰、连格子引用都不换（`configs/items.recycleBagEquipmentGrid` 是纯函数，守着「行列不变 / 非装备一件不动」两条不变量）
- **为什么要点两次**：回收不可撤销，所以按钮是两步确认 —— 第一次点击只报数（件数 + 可得元宝）并把文案改成「确认回收」，再点一次才真的回收；3 秒超时或关掉弹窗自动复位（`bagDialogLayout.recycleButton`）。这样不必新造确认弹窗，也就不会多出一层要处理穿透与层级的节点
- 回归单测：`node tools/test-bag-recycle.cjs`（覆盖：每件装备都有价、计价口径与倍率、只搬装备且非装备引用不变、空/满/脏数据边界、幂等、预览与实际回收一致）

### 删掉的角色能找回吗？为什么删完之后「开始游戏」点不动了？

- **删了就找不回来**：角色数据只存在本地存档（`localStorage` 的 `roles` 数组），删除就是从数组里移除，没有服务端备份。想整体清档：清掉浏览器的 localStorage（或在控制台调 `StorageManager.clear()`）
- **入口**：选角界面左侧「管理」按钮 → 各角色站位上方出现红色「删除」按钮（挂舞台顶部提示条说明怎么操作）→ 点一次变「确认删除」→ 3 秒内再点一次才真的删。再点一次「管理」退出管理模式
- **删除按钮不挂在角色节点下**：角色预览自己绑了 `TOUCH_END`（点击选中角色），删除按钮若挂在它下面，点删除会**冒泡**成「选中该角色」。所以按钮挂舞台、位置由「站位 + `manageRole.deleteButtonOffset`」推导，列表变化时跟着重建
- **两步确认而不是确认弹窗**：与背包「一键回收」同一套口径（第一次点击报角色名、按钮改文案、3 秒超时自动复位，见 `roleSelectorLayout.manageRole.confirmTimeout`）——不新增节点与鼠标监听，也就没有层级与点击穿透的坑
- **删掉的正好是当前选中角色时会连带复位**：名称/等级回占位文案、「开始游戏」按钮重新置灰（否则留下一个点了没反应的选中态）；存档里的 `selectedRole` 也会被清掉，**这是必须的** —— 残留的选中项会让下次 `findOnlineRole()` 取到 `undefined`，进游戏直接卡在取角色那一步（`StorageManager.deleteRole` 同时会顺手清理本来就指向已不存在角色的脏选中项）
- 回归单测：`node tools/test-role-delete.cjs`（在沙箱里跑**真实的 StorageManager**：见 `tools/lib/storage-sandbox.cjs` —— 把 `StorageManager.ts` 连同它真正需要的 `entities/Role` 与 `configs` 复制出来、把指向 UI 层的 import 换成 stub，`cc` 垫片额外提供内存版 `sys.localStorage`；覆盖删存在/不存在/重复删/同名不同 id/删到空、剩余角色数据完整、落盘生效、三种选中项场景，外加对「管理按钮有没有绑事件」「删除按钮挂在哪」这类接线的源码断言）

### 背包里的东西怎么丢？丢错了能找回吗？

- **入口**：背包弹窗底部「丢弃」→ 按钮变「退出丢弃」，进入丢弃模式 → 点要丢的物品格（第一次只报物品名与数量，不改数据）→ 3 秒内再点**同一格**才真的丢掉。超时、点别的格子、点「一键整理/一键回收」、关掉弹窗都会放弃待确认状态
- **丢的是整格**：可叠加物品（药品/材料）一次丢光整格数量，目前**没有「只丢几个」的数量选择** —— 要做它得先引入数量输入控件，别在丢弃这条路上悄悄改语义
- **不可恢复**：本地存档里没有回收站，丢掉的物品找不回来（与删除角色同理，数据只存在浏览器 `localStorage`，没有服务端备份）
- **和「一键回收」不是一回事**：回收**只吃装备**且折算成绑定元宝；丢弃对装备/药品/材料**都生效、不返还任何东西**，用来清理杂物。两者都只动背包 —— 身上穿着的槽位天然不受影响
- **规则与提示都在数据层**：`StorageManager.getBagDiscardPreview`（报数，看一眼不动数据）与 `StorageManager.discardBagGood`（该格置空 → 落盘 → 刷新背包）。界面 `BagDialog` 只做模式分流：丢弃模式下点格子走丢弃，其余时候仍是左键使用、右键穿戴
- **为什么用模式开关而不是确认框**：背包没有选中态，确认框盖在弹窗上又要处理层级与点击穿透（见上面那条「弹窗里的功能突然全都不响应」）。模式开启后点击目标就是格子本身，按钮文案还会跟着变，当前状态一眼可见
- **文案与几何在配置里**：按钮文案 `configs/texts.label_bag_discard / label_bag_discard_exit`，提示见 `bag_discard_*_tip` 四条；按钮位置与超时在 `configs/layout/dialogs.bagDialogLayout.discardButton`（底部三个按钮各错开 140 → 两两间距 17）
- 回归单测：`node tools/test-bag-discard.cjs`（在沙箱里跑**真实的 StorageManager**：丢装备/药品/材料、整格数量一起丢、只动目标格、落盘生效、幂等、只动在线角色、不动装备槽、空格与越界防御、认不出的 id 也能清掉、预览只读，外加按钮接线与配置的源码断言；共 63 项）
