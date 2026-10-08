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
- [背包里的物品怎么拖到别的格子？](#背包里的物品怎么拖到别的格子)
- [装备的发光边框（品质光效）是怎么定的？想换边框 / 给某件装备单独配一个改哪里？](#装备的发光边框品质光效是怎么定的想换边框--给某件装备单独配一个改哪里)
- [装备详情弹窗的背景动画是怎么定的？想换背景 / 给某件装备单独配一个改哪里？](#装备详情弹窗的背景动画是怎么定的想换背景--给某件装备单独配一个改哪里)
- [称号系统是怎么解锁和升级的？想调称号强度 / 价格改哪里？](#称号系统是怎么解锁和升级的想调称号强度--价格改哪里)
- [商城怎么买东西？想改商品 / 价格改哪里？](#商城怎么买东西想改商品--价格改哪里)
- [鼠标放在装备上，详情弹窗出现在哪？为什么以前会偏到屏幕外？](#鼠标放在装备上详情弹窗出现在哪为什么以前会偏到屏幕外)
- [新建角色的背包里为什么有一堆同名武器？想改出生物品清单怎么办？](#新建角色的背包里为什么有一堆同名武器想改出生物品清单怎么办)
- [服务端怎么跑起来？接口文档在哪？](#服务端怎么跑起来接口文档在哪)
- [想换后端地址（局域网 / 线上域名），到底要改哪些文件？](#想换后端地址局域网--线上域名到底要改哪些文件)
- [角色进度是怎么同步到服务端的？为什么不是每次改动都发一次请求？](#角色进度是怎么同步到服务端的为什么不是每次改动都发一次请求)
- [登录、选角界面的错误提示为什么看不见？](#登录选角界面的错误提示为什么看不见)
- [管理端能做什么？玩家令牌为什么调不动管理端接口？](#管理端能做什么玩家令牌为什么调不动管理端接口)
- [接口文档是怎么分组的？为什么每个管理端接口都写着「所需权限」？](#接口文档是怎么分组的为什么每个管理端接口都写着所需权限)
- [管理员有几种角色？权限点在哪加？权限不够会怎样？](#管理员有几种角色权限点在哪加权限不够会怎样)
- [服务端为什么不校验角色数据的内容？](#服务端为什么不校验角色数据的内容)
- [角色数量上限想改，改哪边？](#角色数量上限想改改哪边)

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
- **全屏模态（死亡遮罩、确认框）反过来必须参与命中**：它们**绝不能被标成点击穿透**（`markClickThrough`），否则遮罩等于不存在 —— 点击照样穿到世界；触摸通道还得自己注册四个 `TOUCH_*` 并停冒泡，不然按下会落到遮罩下面的背包格子上、直接开始拖物品（见 `components/dialogs/ConfirmDialog`；标成穿透的判定由 `node tools/audit-ui-click-through.cjs` 兜底）
- 链路自检：`node tools/audit-ui-click-through.cjs` 第 2 段会逐个列出「有鼠标监听的节点 → 是否已有登记点」，第 5 段有「记的是派发命中目标」「归属判定含子树」等接线；行为侧用 `/tmp/olua-click-check/press-bubble-sim.cjs` 把五个阶段（原始 / 点击穿透修复 / 各记各的 / UI 根登记 / 本次修复）跑同一批点击场景对比

### 掉落想怎么调？

掉落优先级是 `怪物条目里的 drops / dropPicks` > `configs/monsterDrops` 每怪独立掉落表 > `configs/drop.monsterDrops` 按等级兜底生成。

- 改某只怪掉什么、掉多重、掉几件：直接改 `configs/monsterDrops` 里该 key 的 `entries`（每条独立配 `weight` 权重 / `chance` 概率 / `count` 数量区间）与 `picks`。`picks` 支持数字（固定件数）或 `[最小, 最大]` 区间（例 `[1, 10]` = 本次掉 1~10 件；**每次抽取独立随机、可重复命中同一条目**，重复的会合并数量，默认按定位 普通 `[1,3]` / 精英 `[2,6]` / BOSS `[3,10]`）
- 掉落物散落：`ui/utils/drop/DropScatter.scatterDropPositions` 以落点为圆心按最小间距 `configs/drop.dropRuntime.scatterMinDistance`(52px，= 图标 40 + 12 留白) 一圈圈贪心铺开，保证**任意两件掉落物都不重叠**（世界坐标无额外缩放，圆即屏幕上的圆）；件数越多圈数越大（10 件最外圈半径 ≈ 102）
- 地面掉落名：装备拼成「前缀 + 名称 + 后缀」三段并**分段着色**（前缀/名称用前缀色、后缀用后缀色），取段与取色**与详情弹窗同走 `configs/equipments.getEquipmentNameParts`** —— 两处永远一致，不各写一份色表；非装备仍单行白字，可叠加物品追加「x{数量}」段。几何（图标尺寸 / 名称字号行高 / 段间距 / 名称与数量颜色）全在 `configs/layout/hud.dropItemLayout`；名称行按内容宽度自适应（`Layout` 横向 CONTAINER + 各段 `Overflow.NONE`）并在图标正下方居中
- 装备条目口径：取「level ≤ 怪物等级且不超过 10 级、每部位最多 2 档」的基础装备，每件展开全部 15 个前后缀变体（`_p前缀s后缀`，普通的·人级沿用基础 id），权重按前后缀稀有度衰减（前缀 ×[1, 0.7, 0.45, 0.25, 0.12]、后缀 ×[1, 0.5, 0.22]、部位 ×1 / 0.9 / 0.8）
- 因此 555 件装备里：武器 / 衣服随各等级段的怪铺开，头盔 / 腰带 / 鞋子 / 项链 / 戒指目前**只有 1 级新手件**，所以只落在低等级怪（≤11 级）的列表里——补齐这些部位的高等级装备后，把 `EQUIP_LEVEL_GAP` 与 `MAX_TIER_PER_SLOT` 放宽重新生成即可覆盖到高等级怪
- 新增怪物时若忘了铺掉落，会退回 `configs/drop.monsterDrops(level, tier)` 的按等级兜底，不会出现「打死没东西掉」

### 界面上的数字/文案想改，到底该动哪个文件？

一条总原则：**核心代码（`assets/ui`、`assets/skills`、`assets/entities`）只做「怎么跑」，一切可调的东西都在 `assets/configs`**。按你改的东西对号入座：

| 想改什么 | 改哪里 |
| --- | --- |
| 数值/成长/掉落/装备/怪物/技能/地图 | 对应域配置 `configs/{growth,drop,equipments,monster,skill,map,…}.ts` |
| 装备边框（哪个组合用哪张 / 特殊装备自定义） | `configs/border.ts`（`prefixSuffixBorderData` / `customEquipmentBorderData`，显示口径在 `configs/layout/borders.ts`） |
| 装备详情背景（哪个组合用哪个 / 特殊装备自定义） | `configs/background.ts`（`prefixSuffixDetailBackgroundData` / `customEquipmentDetailBackgroundData`，帧率在 `configs/layout/backgrounds.ts`） |
| 玩家看到的任何字（提示、校验原因、标签、悬停详情、加载进度） | `configs/texts.ts`（模板写 `{占位符}`，取值用 `getText(key, params)`） |
| 界面位置/尺寸/图片/字号 | `configs/layout/{hud,dialogs,panels,scenes}.ts`（barrel：`configs/hudLayout`） |
| 通用零件长相（空节点调试边框、输入框占位色、飘字配色与时长） | `configs/layout/theme.ts`（`uiTheme`） |
| 碰撞范围可视化的线宽/透明度/配色 | `configs/debug.ts` 的 `rangeStyle` |
| 底部功能入口（名称/图标/解锁等级/快捷键） | `configs/bottomNav.ts`（点击回调留在组件里，按 `key` 关联） |
| 角色体型与碰撞盒、刚体参数 | `configs/role.ts` 的 `roleBody` / `roleRigid` |
| 掉落拾取半径、背包满提示节流、掉落物散开间距 | `configs/drop.ts` 的 `dropRuntime` |
| 地面掉落物的名称与几何（图标尺寸 / 名称字号行高 / 段间距 / 名称与数量颜色） | `configs/layout/hud.ts` 的 `dropItemLayout`（前后缀文案与取色见 `configs/equipments.ts` 的 `equipmentPrefixColors` / `equipmentSuffixColors`） |

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
- **整理 = 全部重排**：排完之后从**第一个格子（0 行 0 列）**起按行连续铺满，空格一律沉到末尾，中间不留空洞（单测里专门有一条 `isPackedPrefix` 盯这个口径，改搬运时别写出「带洞的整理」）
- **排序规则**在 `configs/items.compareBagGoods`：大类（装备 → 药品 → 材料 → 其他）→ 装备组内「等级降序 → 部位 → 前缀降序 → 后缀降序」→ id 兜底（同种物品必然相邻、结果可复现）。想改等级升序、想让药品排在装备前面，只动这一处比较方向
- **部位先后不另写一份**：`configs/equipments.equipmentSlotOrder` 直接按装备槽位配置 `equipmentSlotData` 的顺序生成 —— 改槽位配置顺序时，装备界面排列与背包整理一起生效
- **入口**：背包弹窗底部按钮 → `StorageManager.tidyBag()`，它只负责「取角色 → 调纯函数 → **有变动才落盘刷新**」（本来就很整齐时提示「背包已经很整齐了」，不重复写存储）
- **「点了整理像没反应」的坑**：判断「整不整理」比的是**整理前后的指纹**，而指纹**必须把空格也算进去**。否则「物品顺序没变、只是散着放」（例：把第 3 格的药拖到第 8 格）指纹与整理完之后一模一样 → `tidyBag` 判成「已经很整齐」直接返回，玩家看到的就是「点了没反应、东西没回到第一格」。修法：`bagSignature` 逐格拼接、空格占一位（`·`），「空背包」另用 `bagIsEmpty` 判断（不能再拿空串当空背包）
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

- **两种入口，两种确认形态**：
  - **拖出弹窗销毁（推荐）**：按住物品拖动，**拖到背包弹窗外面**松手 → 弹全屏确认框（写明物品名与整格数量）→「确定」整格销毁、「取消」物品回原位。拖出界时源格物品会**保持压暗**（被「扣住」），取消或确认后才恢复；
  - **丢弃模式**：底部「丢弃」→ 按钮变「退出丢弃」→ 点要丢的物品格（第一次只报物品名与数量，不改数据）→ 3 秒内再点**同一格**才真的丢掉。超时、点别的格子、点「一键整理/一键回收」、关掉弹窗都会放弃待确认状态
- **为什么拖出界要弹确认框、而点格子只用两步确认**：拖动松手是**一次性动作** —— 没有「可以再点一次」的按钮或格子，只能立个确认框问清楚；而点格子天然能再点一次，用「再点一次 = 确认」既省节点又避开层级/穿透的坑（见 `components/dialogs/ConfirmDialog` 的两路输入独占说明）
- **「取消」怎么回到原位**：拖动期间**数据从未被改过** —— 唯一被动的是源格物品的不透明度（拖动压暗 → 拖出后扣住保持压暗），所以「回到原位」不需要任何复原动作，放开扣留即恢复（`BagGridView.releaseDiscardHold`）。落点判定三条同时成立才走销毁：拖过阈值 + 没落在任何格子上 + 落在弹窗矩形之外（用弹窗自己的 `UITransform.hitTest`，与格子命中同一口径）
- **丢的是整格**：可叠加物品（药品/材料）一次丢光整格数量，目前**没有「只丢几个」的数量选择** —— 要做它得先引入数量输入控件，别在丢弃这条路上悄悄改语义
- **不可恢复**：本地存档里没有回收站，丢掉的物品找不回来（与删除角色同理，数据只存在浏览器 `localStorage`，没有服务端备份）
- **和「一键回收」不是一回事**：回收**只吃装备**且折算成绑定元宝；丢弃对装备/药品/材料**都生效、不返还任何东西**，用来清理杂物。两者都只动背包 —— 身上穿着的槽位天然不受影响
- **规则与提示都在数据层**：`StorageManager.getBagDiscardPreview`（报数，看一眼不动数据）与 `StorageManager.discardBagGood`（该格置空 → 落盘 → 刷新背包）。界面 `BagDialog` 只做模式分流与确认框接线：丢弃模式下点格子走丢弃，其余时候仍是左键使用、右键穿戴
- **确认框是全屏模态、两路输入都独占**：触摸通道上遮罩自己注册四个 `TOUCH_*` 并停冒泡（否则按下会穿过遮罩落到下面的背包格子上、直接开始拖物品），鼠标通道上 `blockClickThrough` 命中即中断（下层 UI 与世界都收不到这次点击）；全屏尺寸取**可见区**（`ScreenLayout.getVisibleSize`，NO_BORDER 下不等于设计分辨率）。点遮罩空白处**不做任何事** —— 销毁类操作必须明确选择
- **确认框挂在 UI 层、不随背包弹窗销毁**：所以关背包弹窗时必须显式收掉它（`BagDialog.closeDiscardConfirm`），否则会留下一个盖住屏幕的黑幕
- **文案与几何在配置里**：按钮文案 `configs/texts.label_bag_discard / label_bag_discard_exit`、确认框文案 `bag_discard_confirm_title / bag_discard_confirm_text` 与通用按钮 `label_confirm_ok / label_confirm_cancel`，提示见 `bag_discard_*_tip`；按钮位置与超时在 `configs/layout/dialogs.bagDialogLayout.discardButton`（底部三个按钮各错开 140 → 两两间距 17），确认框几何在 `configs/layout/dialogs.confirmDialogLayout`
- 回归单测：`node tools/test-bag-discard.cjs`（在沙箱里跑**真实的 StorageManager**：丢装备/药品/材料、整格数量一起丢、只动目标格、落盘生效、幂等、只动在线角色、不动装备槽、空格与越界防御、认不出的 id 也能清掉、预览只读，外加丢弃模式、拖出销毁与确认框的接线/配置/文案源码断言；共 117 项）

### 背包里的物品怎么拖到别的格子？

- **手势**：按住格子里的物品移动，位移超过 `configs/layout/panels.bagGridLayout.drag.threshold`（默认 10 像素）才算拖动 —— 阈值内松手仍是「点击」（左键使用、右键穿戴），手抖几像素不会变成拖动。松手时按**指针位置**定去向：落在格子上 = 搬运；落在**弹窗外面** = 销毁确认（见上面「背包里的东西怎么丢」，源格物品先扣住保持压暗）；落在弹窗内但不在格子上 = 什么都不做，物品回原位
- **落点规则**（纯函数 `configs/items.moveBagCellGrid`，按顺序判三类）：落点是**空格** → 整格搬过去（数量不变）；落点是**同种可叠加物** → 合并（超过单格上限 `maxStack` 的部分留在原格）；**其余**（不同种物品、装备这类不可叠加、配置表里认不出的 id）→ 两格交换。物品一件不丢，除起点与落点外其它格子**连引用都不换**
- **入口**：`StorageManager.moveBagGood(from, to)` 只负责「取角色 → 调纯函数 → **真的动了才落盘刷新**」，与「一键整理」同一口径：**不弹提示**（拖动的反馈就是物品位置/数量变化本身），无效拖动（拖空格、拖回原格、越界）静默返回 false
- **表现全在配置里**：拖动中跟随指针的幽灵图标（尺寸/不透明度）、源格物品压暗、落点高亮框（尺寸/描边宽度/内缩/颜色）都在 `bagGridLayout.drag`，组件里不写数值
- **为什么走 touch 通道（`TOUCH_START/MOVE/END`）而不是鼠标通道**：鼠标环境引擎会把 `MOUSE_DOWN/MOVE/UP` **模拟**成 `TOUCH_START/MOVE/END`（引擎 `input._simulateEventTouch`），所以一套代码两种环境通用（弹窗拖动 `Draggable` 也是这么做的）；而 touch 通道还有「`TOUCH_START` 命中的节点独占整段触摸」的语义 —— 按下之后指针拖到哪儿、松在谁身上，结束事件都回到起点格，中途路过的按钮抢不走它。**反过来绝不能在格子上监听 `MOUSE_MOVE`**：它会吞掉全局的指针追踪（光标样式、按住走路的方向都会卡住，见上面「弹窗里的功能突然全都不响应」）
- **拖完松手不会顺手把物品用掉/穿上**：同一次按压里只要拖动过（`BagGridView.pressDragged`），这次抬起的点击回调就被拦掉；标记在**下一次按下**时复位，所以不依赖「拖动的 `TOUCH_END` 与点击的 `MOUSE_UP` 谁先执行」
- **右键不拖动物品**：`TOUCH_*` 事件不带按键信息，另在鼠标通道用 `MOUSE_DOWN` 记一笔（`rightPress`），保住「右键 = 穿戴」的语义
- **拖物品不会把整个弹窗也拖走**：弹窗背景上挂着拖动组件（`components/input/Draggable`，按住弹窗可以整体搬走），而 touch 事件是**冒泡**的 —— 格子上的触摸会一路冒到弹窗背景，于是「拖物品」顺带把窗口也带跑了。修法是把网格区域内的触摸收在网格里（`BagGridView.setupTouchOwnership`：四个 `TOUCH_*` 一律 `propagationStopped = true`）：按**有物品的格子**时格子先独占这次触摸、冒泡到网格容器就被停下；按**空格子或网格空白处**时没有更深的节点认领，这次触摸由网格容器自己独占 —— 两种按下都到不了弹窗。`Draggable` 那边另有一条通用兜底：按下点**自带拖动手势**（注册过 `TOUCH_MOVE`）时弹窗不抢这次拖动，免得以后往弹窗里加滚动视图、滑条这类子手势时再踩同一个坑
- **背包一变，待确认状态全部复位**：拖动落子会刷新背包，`BagDialog.refresh` 顺手清掉「确认回收」的待确认、「待丢弃的那一格」与「拖出弹窗被扣住的那件物品」—— 否则拖走/换走了目标格的东西，再点一次（或再确认一次）会误伤
- **旧存档的背包尺寸**：读档时 `StorageManager.ensureRoleDefaults` 按 `bagRow × bagCol` 对齐（`configs/items.normalizeBagGrid`）—— 尺寸不符时补齐/裁掉，避免「物品铺进界面没有的格子」这种看着像丢东西的错位
- 回归单测：`node tools/test-bag-drag.cjs`（移动/合并/溢出/交换/认不出的 id/无效拖动、`normalizeBagGrid` 尺寸对齐、`StorageManager.moveBagGood` 落盘与只动在线角色，外加拖动接线的源码断言）

### 装备的发光边框（品质光效）是怎么定的？想换边框 / 给某件装备单独配一个改哪里？

- **显示位置**：背包格子和身上装备槽的物品图标上（唯一挂点 = `GameUiHelper.createGood`，两个入口共用）。边框是 `resources/borders` 下的图集（plist + 同名 png，8~12 帧）整包循环播放，挂在**图标节点**上 —— 拖动压暗图标时边框一起变暗，格子刷新销毁图标时边框随之销毁
- **哪个前后缀用哪张边框**：`configs/border` 的 `prefixSuffixBorderData` —— 5 前缀 × 3 后缀 = 15 种组合各一张，按强度升序取**前 15 张**（sfx_30123_0 ~ sfx_30137_0，先按后缀分人级/天级/神级三档、档内按前缀递增）。想换只改这张表
- **特殊装备自定义边框**：同一文件里的 `customEquipmentBorderData`，**优先于**前后缀表 —— 写变体 id（`weapon_20_p4s2`）只对那一个变体生效，写基础件 key（`weapon_20`）对**全部变体**生效；剩下的 69 张边框就是留给它的（素材长什么样见 `tools/border-preview.png` 索引图，黄框 = 已分配的 15 张）
- **全部 84 张边框都登记在系统里**（`configs/border.borderResources`，与磁盘文件一一比对的单测守着），只是暂时只有 15 张被分配
- **尺寸**：84 张边框分属 6 个原始尺寸家族（91×104 / 200×200 / 80×80 / 98×92 / 89×88），统一按 **contain**（保持各自宽高比）缩进 `configs/layout/borders.equipmentBorderLayout.size`（默认 56×56 = 格子 50 + 两侧各 3 溢出）里；帧率也在这里调
- **预加载**：进图前 `PreloadManager` 把前后缀表用到的边框图集全部载入（`configs/border.getAssignedBorders`），第一次开背包边框就在，不会晚一拍
- **一个引擎坑（为什么边框精灵 `trim = true`）**：这批边框图集**未裁剪但每帧 offset 全部非 0**，而 offset 只在 `trim = false` 的逆向补边路径里生效 —— 引擎会按它把整帧画面平移出去（边框整体挪出格子）；`trim = true` 时画面取 rect 全帧、完全不看 offset，未裁剪素材的 rect == 原始尺寸，正好铺满节点框且不变形。单测里守着「每帧 rect == 原始尺寸」这条前提，以后真加进来**裁剪过**的边框素材，记得把那件素材改成 `trim = false` 渲染
- 回归单测：`node tools/test-equipment-border.cjs`（资源表与磁盘一致、15 组合全覆盖且用前 15 张、取用优先级各分支、真实装备表抽查、帧序号/未裁剪守卫、界面接线源码断言；共 46 项）

### 装备详情弹窗的背景动画是怎么定的？想换背景 / 给某件装备单独配一个改哪里？

- **显示位置**：物品详情弹窗**自身**（唯一挂点 = `GameUiHelper.createGoodDetailDialog`，背包格子与身上装备槽悬停共用）。背景是 `resources/backgrounds` 下的帧序列目录（每个目录 6~20 帧逐帧 png）整包循环播放，**直接换弹窗节点的 spriteFrame** —— 不是子节点（弹窗是 Layout 容器，背景若作为子节点会被当成一行参与排版还会撑高容器），也不是只盖住局部，而是随弹窗自适应尺寸铺满整个面板；加载完成前先显示静态底图，非装备物品与未分配背景的装备保持静态底图
- **哪个前后缀用哪个背景**：`configs/background` 的 `prefixSuffixDetailBackgroundData` —— 5 前缀 × 3 后缀 = 15 种组合各一个，按强度升序取**前 15 个**（sfx_16000 ~ sfx_16014，先按后缀分人级/天级/神级三档、档内按前缀递增）。想换只改这张表
- **特殊装备自定义背景**：同一文件里的 `customEquipmentDetailBackgroundData`，**优先于**前后缀表 —— 写变体 id（`weapon_20_p4s2`）只对那一个变体生效，写基础件 key（`weapon_20`）对**全部变体**生效；剩下的 26 个背景就是留给它的
- **全部 41 个背景目录都登记在系统里**（`configs/background.detailBackgroundResources`，与磁盘目录一一比对的单测守着），只是暂时只有 15 个被分配
- **帧率**在 `configs/layout/backgrounds.equipmentDetailBackgroundLayout`（默认 10 帧/秒，与边框同一档）；背景随面板自适应铺满，没有独立尺寸配置
- **预加载**：进图前 `PreloadManager` 把前后缀表用到的背景目录全部载入（`configs/background.getAssignedDetailBackgrounds`），第一次悬停背景动画就在，不会晚一拍
- **一个引擎坑（为什么背景精灵 `trim = false`，和边框正好相反）**：这批背景帧按 auto-trim 导入（**真裁剪 + 非 0 offset**），`trim = false` 时引擎按 offset 把裁剪内容贴回原始画布 —— 各帧画布一致（单测守着「meta 原始画布 == PNG 尺寸」），画面帧间不跳；若改成 `trim = true` 则每帧只画自己的裁剪矩形并拉伸到面板，每帧裁剪范围不同会导致画面抖动。与边框（未裁剪素材必须 `trim = true`）结论相反，别照搬
- 回归单测：`node tools/test-equipment-detail-background.cjs`（资源表与磁盘一致、15 组合全覆盖且用前 15 个、取用优先级各分支、真实装备表抽查、帧序号/帧尺寸/画布守卫、界面接线源码断言）

### 称号系统是怎么解锁和升级的？想调称号强度 / 价格改哪里？

- **入口**：角色信息弹窗右下的「称 号」按钮（唯一入口，**不走 NPC**）；称号升级弹窗与战魂弹窗同构（左等级列表 / 中名牌动画与信息 / 右属性 + 绑定元宝 + 升级按钮），但没有「外显」勾选框
- **显示**：解锁称号（升到 1 阶）后名牌动画**常显**在角色头顶，节点挂在**头部信息栏容器**里（与角色名称/血条同一个 FlexCol，`RoleDisplay.updateTitleShow`）：位置由该容器的纵向布局自动排列（插在最上 = 排在名称之上），代码不手动定位、也**不缩放**（按素材原始尺寸显示）；插入位置与占位尺寸见 `configs/layout/hud.roleShowLayout.title`（`siblingIndex` / `size`）。名牌取代了头部信息栏里原来写死的「- 战神 * 女武神 -」文字占位；未激活时不显示
- **数据**：`configs/title.ts` —— 34 个帧目录（resources/titles 全登记）按强度排成 1~34 阶：sfx_13009~13020 江湖系（factor 1）→ 13031~13041 军阶系（1.15）→ 13060~13070「我能打」搞怪系（1.3）；名称与素材画面上烙的字一致
- **属性曲线**：与战魂同一套做法 —— 每阶映射一个「等效角色等级」，取裸属性再打 `titleGrowth.rate`（0.3，弱于战魂的 0.5）× 系列 factor 折；改 `configs/growth` 的等级曲线称号强度自动跟着走
- **价格曲线**：升到 N 阶 = `titleGrowth.priceBase`（200）× N² 绑定元宝（战魂是 300 × N²，见 `titleUpgradePrice`）；想整体调贵贱只改这两个数
- **存档**：旧档缺 `title` 字段自动补 0（`StorageManager.ensureRoleDefaults`）；升级走 `StorageManager.upgradeTitle`，属性与战斗力即时重算，头顶名牌同步刷新
- **预加载**：进图前 `PreloadManager` 把**当前称号**的帧目录一起预载（未激活跳过），名牌进图即出现
- 回归单测：`node tools/test-title.cjs`（等级序列对磁盘、属性/价格曲线逐级复算、素材守卫、接线与「占位文字称号已移除」断言）

### 鼠标放在装备上，详情弹窗出现在哪？为什么以前会偏到屏幕外？

- **位置规则**（纯函数 `ui/utils/layout/ScreenLayout.getPopupPosition`，摆放在 `GameUiHelper.createGoodDetailDialog`）：竖直与物品**同高居中**；水平摆在物品**靠屏幕中间的那一侧**（物品在左半屏就摆它右边、右半屏就摆它左边），这一侧放不下（会溢出可视区）才换另一侧，两边都放不下就取空得多的一侧；最后**整块夹进可见区**（四周留 `placement.screenMargin`）。弹窗比可见区本身还大（极端窄窗口）时退回屏幕中心居中，而不是被推到屏幕外
- **为什么这样**：详情弹窗（240 宽、自适应高度后 400+ 高）比物品格（50×50）大得多，贴着物品往屏幕外侧摆会被裁掉一半 —— 玩家的诉求是「弹窗尽量靠中间，装备信息才能全在可视范围内」，所以规则是「尽量挨着物品 + 一定整块可见」
- **想调手感**：改 `configs/layout/dialogs.goodDetailLayout.placement` 的 `gap`（弹窗边缘与物品格的间距）与 `screenMargin`（弹窗到可见区边缘的留白），组件不写数值
- **高度是自适应的**：弹窗由自身 Layout 撑开（`ResizeMode.CONTAINER`），首帧量到的是配置里的占位高度（200），内容撑开后按**最终尺寸**复夹一次（监听 `SIZE_CHANGED`，幂等，内容稳定后不再动）
- **以前为什么会「偏移得很严重」**：老实现把相机 `worldToScreen` 的**物理像素**坐标直接减**设计分辨率**的一半 —— 两个口径差一个 view 缩放系数（窗口越大偏得越多，纹理分辨率高的屏幕上直接飞出屏幕）；而且它中途把弹窗与两个子节点的锚点改成 0 / 1，Layout 会按新锚点重排内容，整块内容又跟着错位。现在统一用**屏幕中心系坐标**（`物品格世界坐标 − LayerManager.UILayer 世界坐标`，与左上角色栏/小地图等常驻 HUD 同一个口径）并按配置摆，锚点恒为 0.5/0.5，**不要**再拿 `worldToScreen` 去摆 UI
- 回归单测：`node tools/test-good-detail-placement.cjs`（4 种窗口尺寸 × 100 组锚点下弹窗整块可见、优先摆靠中间那侧、有空间时不遮物品、超大弹窗居中且不出 NaN、可见区取「窗口像素 ÷ 缩放」、纯函数不改入参，外加接线与「老 bug 不许回来」的源码断言；共 39 项）

### 新建角色的背包里为什么有一堆同名武器？想改出生物品清单怎么办？

出生物品全部来自 `configs/role.getNewRoleEquipments`，按顺序发这几组：

1. **通用件 5 件**：戒指 / 项链 / 鞋 / 头盔 / 腰带（各表的 `*_1`）；
2. **全部基础武器（20 件）+ 全部基础衣服（12 件）**：即各表里「普通的·人级」那一件（`getBaseEquipments`）；
3. **指定等级武器的其余前后缀变体**：由 `configs/role.newRoleVariantWeaponLevel` 控制（默认 `1`，设 `0` 关闭）。1 级只有 `weapon_1` 一件，于是它的 15 个品质变体（普通的·人级 → 超神的·神级）一起进背包 —— 出生就能把不同前缀/后缀的**外观与边框**摆在一起对比。

所以出生一共 `5 + 20 + 12 + 14 = 51` 件，那一堆同名武器就是 15 个品质的同一把 1 级武器。

- **想让别的等级/别的部位也整组发**：改 `newRoleVariantWeaponLevel` 的等级，或在函数里再加一行 `getEquipmentsByLevel(clothes, 等级)`（`configs/equipments.getEquipmentsByLevel` 是按等级取全部变体的通用查询）。
- **容量上限**：背包只有 `bagRow × bagCol = 7 × 11 = 77` 格。超出的条目会被 `entities/Role` 构造函数**截断丢弃**并打一条 `[role] 新手物品 N 件超出背包容量 77 格…` 的 warn —— 见到这条日志就说明该精简清单或调大 `configs/role.bagRow / bagCol`（两者也是背包界面格数的来源）。
- 回归单测：`node tools/test-new-role-bag.cjs`（15 个变体一个不少/不重、清单每件都能被物品总表解析、不超容量、原有基础件照发、背包结构与两角色互不共享、源码接线断言；共 32 项）

### 商城怎么买东西？想改商品 / 价格改哪里？

- **入口**：底部功能栏「商城」（快捷键 `M`，1 级解锁）。弹窗就是商城门面背景（`resources/mall/bg`），商品列表摆在门面的橱窗开口里
- **商品**：**系统内的全部装备** —— 七个部位的装备表全量收进来（`configs/mall.getMallGoods`），含前后缀品质变体（37 件基础 × 15 变体 = 555 件），按「部位序 → 等级 → 前缀 → 后缀」排好序。以后新增装备**自动上架**，不用改商城
- **价格**：默认全场统一 **1 绑定元宝/件**（`configs/mall.mallPrice`）。想给个别装备单独定价，往 `configs/mall` 的 `customPriceData` 加一条 `{ id, price }`（写变体 id 只影响那一件，写基础件 key 只对那一件生效——目前是精确 id 匹配），不在此表的走统一价
- **购买**：点行尾「购 买」→ 扣绑定元宝 → 装备直接进背包第一个空格（装备不可叠加，每次买 1 件占 1 格）。**三种失败都不改任何数据**：绑定元宝不足、背包已满（会原样退出）、商品 id 解析不出配置（已下架）。连买不受限，买多少次都行，钱够就成交
- **列表为什么滚动流畅（虚拟化）**：555 件商品如果全部常驻渲染会有几千个节点参与绘制与命中判定，滚动会卡；所以行节点只建一次、位置手动摆（固定行距），按滚动位置**只激活视口附近的几行**（`MallDialog.updateVirtualRows`）。改行高/间距后行距自动跟着变，不要在组件里另写一份行距
- **悬停看详情**：鼠标停在图标上显示完整装备详情（与背包格子同一套零件：三段着色名、属性、回收价、品质背景动画），移开即收；滚动列表时详情自动收起
- **文案与几何**：购买按钮 / 价签 / 提示在 `configs/texts`（`mall_*` / `label_mall_buy`）；弹窗尺寸、列表与行几何在 `configs/layout/dialogs.mallDialogLayout`（对着背景图的橱窗开口调的，换背景图要一起调）
- 回归单测：`node tools/test-mall.cjs`（商品表 = 物品注册表里的全部装备且无重复、排序稳定、全场 1 绑定元宝、真实 StorageManager 跑购买链路：扣款入包 / 连买 / 余额不足 / 背包满不扣钱 / 非装备与坏 id 拒绝 / 落盘可见，外加底部入口接线与配置源码断言；共 67 项）

## 服务端 / 管理端

### 服务端怎么跑起来？接口文档在哪？

- **启动**：`cd server && npm install && cp .env.example .env && npm run dev`（`npm run start` 跑已构建产物）。默认监听 `3100`、路由前缀 `api`，客户端默认连的就是 `http://localhost:3100/api`
- **接口文档**：<http://localhost:3100/api-docs>（Swagger UI；JSON 在 `/api-docs-json`）。文档**不带路由前缀**，因为它不是业务接口。所有接口都是「统一响应包裹 + 统一错误出口」，所以文档里每个接口的响应都是 `code / message / data / timestamp` 五件套，`data` 才是业务数据
- **数据库**：SQLite（Node 22 内置 `node:sqlite`，**不需要任何原生模块**），默认 `server/data/olua.db`，首次启动自动建 `accounts / roles / admins` 三张表。删账号由外键 `ON DELETE CASCADE` 级联删掉它的全部角色
- **回归**：`cd server && npm run test:e2e` —— 真实起服务进程 + 真实 HTTP 请求，**187 条断言**（注册登录 / 角色 CRUD 与上限重名 / 保存与切换在线 / 越权与令牌受众隔离 / 管理端全流程 / **文档三组分类与每个接口的权限标注** / **只读观察员四处越权被拒** / **超管保护**）。改动接口后**先跑它**
- **新增接口的规矩**：路径写在 `assets/ui/utils/net/ApiRoutes.ts`（客户端）/ `admin/src/api/*.api.ts`（管理端），请求一律走各自的请求层；地址、请求实现、令牌注入三样都不允许出现在别处，`node tools/audit-api-hardcode.cjs` 会替你把关

### 想换后端地址（局域网 / 线上域名），到底要改哪些文件？

三端各有一处**唯一来源**，改完就生效，代码里搜不到任何地址字面量：

- **客户端**：`assets/configs/network.ts` 的 `baseUrl`（真机调试改成局域网 IP；换域名同理）
- **管理端**：`admin/.env.development` / `.env.production` 的 `VITE_API_BASE_URL`（代码只读这个变量，见 `admin/src/api/config.ts`；生产也可以填相对路径 `/api` 走同域反向代理）
- **服务端**：`server/.env`（端口 / 前缀 / 数据库路径 / 密钥 / 上限 / 跨域来源全在这里，注释里逐项说明）

自查命令：`node tools/audit-api-hardcode.cjs`。它按行扫三端源码，命中「http 地址 / localhost / 裸 `fetch` / 裸 `XMLHttpRequest` / 自己拼 `Authorization` / 硬写接口路径」即报错，并检查管理端与服务端用到的环境变量键是否都在 `.env.example` 里登记过（避免新增配置项时模板悄悄落后）。注释与日志行不算（注释里写示例地址是文档，不是硬编码）。

### 角色进度是怎么同步到服务端的？

- **触发点只有一个**：角色落盘的唯一出口是 `StorageManager.updateOnlineRole`，打怪升级 / 拾取掉落 / 买卖 / 换装 / 吃药都会经过它 —— 所以同步也挂在这里，**不需要**在每个玩法里各写一次保存请求
- **必须防抖**：一次打怪会连着触发好几次落盘，每次都发请求会把服务端打爆。`ui/utils/net/RoleSync` 只记住「最后一份数据」，等操作停下 `configs/network.roleSyncDelay`（默认 1500ms）再推一次
- **场景切换要补推**：防抖窗口里那点改动如果赶上切地图（会重建 Game 场景），不推就随场景一起没了 —— 所以 `Game.onDestroy` 里显式 `RoleSync.flush()`
- **失败不阻塞、不刷屏**：同步请求走**静默模式**（`silent`），失败不弹通用提示；`RoleSync` 只在**连续失败的第一条**上提示一次（后端一挂，打怪期间不会每 1.5 秒弹一次）。本地存档已经落盘，下一次改动或下次进游戏会重新推
- 回归单测：`node tools/test-client-net.cjs`（包裹解包 / 业务码与文案 / 重试与不重试 / 令牌注入 / 静默与重登 / 防抖与 flush / Session 脏数据 / 各处接线）

### 登录、选角界面的错误提示为什么看不见？

- **原因**：飘字（含服务端返回的「账号或密码错误」这类文案）原来一律挂到 `LayerManager.UILayer`。但那个图层容器是 `LayerManager.initLayer` 在**游戏场景**里建的；登录 / 选角场景从不调它 —— 于是飘字挂到了一个**不在场景树里**的静态节点上，既不渲染也不跟随，玩家什么提示都看不到
- **现在怎么做的**：`GameUiHelper.mountFloatingTip` 按「容器是否在当前场景里」选挂载点 —— 游戏内照旧挂 UI 图层（保持临时层在最上，不参与弹窗置顶排序），登录 / 选角这类场景挂**当前场景根**（图层用默认值，与场景相机的 visibility 一致）。判据不是「当前是哪个场景」，以后新增场景不必回来改这里
- **别退回旧写法**：不要在业务里直接 `LayerManager.addToUILayer(tip)` 建提示 —— 那又只在游戏里可见。统一走 `GameUiHelper.createTip / createErrorTip`（固定文案，key 在 `configs/texts`）与 `createTipText / createErrorTipText`（动态文案，如服务端 message）
- 回归单测：`node tools/test-dialog-top.cjs`（含这条挂载口径的断言）与 `node tools/test-client-net.cjs`

### 管理端能做什么？玩家令牌为什么调不动管理端接口？

- **能做**：管理员注册 / 登录（注册要填 `server/.env` 的 `ADMIN_REGISTER_CODE`，留空则开放注册）；概览统计；账号分页检索、查看详情、**封禁 / 解封**、删除；打开某个账号看它的**全部角色**，改属性、切换在线角色、删除角色、**清空该账号全部角色**；**管理员管理**（改角色 / 启停 / 删除，仅超管可见）
- **角色管理**：列表可按关键字 / 在线状态 / 职业 / 性别 / 等级区间 / 账号六维筛选，支持多选批量删除；详情页分三块 —— **基础信息**（名称 / 职业 / 性别 / 等级 / 时装 / 头像 / 所在地图）、**常用数值**（金币 / 元宝 / 银两 / 经验 / 战魂 / 称号 / 军衔）、**运行时数据**（装备槽位 / 技能等级 / 背包格子）。详情见下面「后台改了角色，玩家那边什么时候生效？」
- **两套令牌受众隔离**：令牌里带 `aud`（`player` / `admin`），守卫按接口要求的受众校验 —— 玩家令牌调管理端接口一律 401。管理端账号存在独立的 `admins` 表，与玩家账号体系互不影响
- **权限点隔离**（管理端内部）：见下面的「管理员有几种角色」
- **封禁即时生效**：守卫每次请求都回查一次账号状态（不是等令牌过期），封禁后旧令牌下一次请求就失效（业务码 `10004`）
- **改角色只提交改动过的字段**（`RoleDetailPage.buildPatch`），避免把界面上没加载的字段一起写空。**例外**是装备 / 技能 / 背包这三项：服务端对它们是整体替换，所以只要有一处改动就提交完整的一份
- **越权防护**：玩家侧靠「令牌里的账号 + 角色归属校验」（读写别人的角色一律 403），管理侧靠受众守卫 + 权限点守卫，e2e 三条链路都覆盖

### 接口文档是怎么分组的？为什么每个管理端接口都写着「所需权限」？

- **三个分组 = 三种调用者**，顺序就是权限层级：
  1. **公共接口** —— 无需令牌：`/health`、玩家注册登录、管理员注册登录（共 5 个）
  2. **客户端** —— 需要 `player` 令牌，只能操作自己账号的数据（共 8 个）
  3. **管理端** —— 需要 `admin` 令牌，且每个接口还要求权限点（共 16 个）
- **分组是按「单个接口」标的，不是按控制器**：认证控制器里 `register/login` 属于「公共接口」、`me` 属于「客户端」，一个类里两种分组都有。所以控制器类上不写 `@ApiTags`，统一用 `common/decorators/api-doc.decorator` 里的组合装饰器（`ApiPublicDoc / ApiPlayerDoc / ApiAdminDoc`）——分组、令牌锁图标、权限说明一次到位
- **踩过的坑**：Nest 的 Swagger 有一个「没有类级 tag 就自动拿控制器类名当分组」的默认行为（`autoTagControllers`，默认开），于是文档里每个接口除了自己的分组还会多挂一个 `Health` / `Auth` / `AdminRoles` 之类的类名分组。已在 `main.ts` 的 `createDocument(..., { autoTagControllers: false })` 关掉；e2e 里钉了「每个接口恰好属于一个分组」的断言
- **「所需权限」不是手写的**：`ApiAdminDoc({ permissions })` 里传的权限点会①变成运行时校验（守卫真读这份元数据）②由 `ROLE_PERMISSIONS` 反查「哪些角色拥有」写进文档说明 ③以 `x-olua-permissions` 扩展挂在操作上（给机器读）。三者同源，不会出现「文档写了但没拦」或「拦了但文档没写」
- 新增接口时顺手做的事：加权限点 → 在控制器上 `@ApiAdminDoc({ permissions: [Permission.XXX] })` → 决定哪些角色拥有（只改 `ROLE_PERMISSIONS`）→ 跑 e2e

### 管理员有几种角色？权限点在哪加？权限不够会怎样？

- **三级角色**（`server/src/common/constants/permission.ts` 是唯一来源）：

| 角色 | 权限 |
| --- | --- |
| 超级管理员 `super_admin` | 全部权限（含「管理管理员」） |
| 管理员 `admin` | 除「管理管理员」外全部 —— 管理员之间不能互相提权 |
| 只读观察员 `viewer` | 只能看：概览 / 账号列表与详情 / 角色列表与详情 |

- **权限点**（10 个）：`stats:read`、`account:read`、`account:status`、`account:delete`、`role:read`、`role:write`、`role:select`、`role:delete`、`admin:read`、`admin:manage`。**加权限点只改 `ROLE_PERMISSIONS` 那张表**，不要在业务代码里写 `if (role === "admin")`
- **注册时怎么定角色**：**第一个**注册的管理员自动是超级管理员（否则没人能管管理员），之后一律普通管理员，提权由超管在管理端的「管理员」页改
- **权限不够会怎样**：`403` + 业务码 **30006**，提示会直接写出缺哪个权限（如「当前角色没有该操作权限：封禁 / 解封账号」）。管理端界面会**按权限点隐藏菜单与禁用按钮**，但那只是体验 —— 服务端每次请求都重新判一次，改地址栏硬闯也只有 403
- **改完立即生效**：守卫每次请求都从库里取管理员的角色（和账号封禁同一套逻辑），降权后旧的令牌下一次请求就受限，不用等令牌过期
- **两道保护（业务码 30007）**：不能把**最后一个启用中的超级管理员**降级 / 停用 / 删除 —— 否则后台就没人能管了。有第二个超管时自降是允许的（可以用来轮值）
- 回归：`cd server && npm run test:e2e` 的第七段（只读观察员四处写操作被拒、降权即时生效、超管保护、管理员列表与筛选）；角色相关改动另跑 `npm run build && node test/e2e-roles.cjs`（76 条）

### 后台改了角色，玩家那边什么时候生效？

- **不在线时**：下次进游戏就生效 —— 选角界面会调 `POST /roles/:id/select` 拿服务端最新完整数据、写进本地缓存（`StorageManager.cacheServerRole`），游戏内各处读的就是它
- **在线时（关键）**：玩家游戏里每 1.5 秒会把存档推回服务端，如果它拿的是「后台改动之前」的那份，直接推上去会把后台的改动**整体抹掉**。所以角色带一个**修订号** `revision`（每次落库 +1）：
  - 服务端落库一律 +1；管理端改一次也 +1
  - 玩家推送时带上「我这份数据基于哪一版」，对不上就拒收（`409` / 业务码 **20006**）
  - 客户端收到 20006 **不重试、也不覆盖**：改为拉一次角色详情，以服务端最新数据为基线（后台改动优先，玩家那 1.5 秒内的改动让位），然后飘字「角色数据已在后台被修改，已同步为最新数据」
  - 推送成功后必须把新的 `revision` 记回本地（`RoleSync.onSaved` → `StorageManager.applyServerRevision`），否则下一次推送会拿旧版本撞自己（自锁死循环）
- **角色被后台删了**：服务端回 20002，客户端飘字「角色已被删除，请重新选择角色」→ 清本地缓存 → 回选角场景（不这么做会卡在一个永远同步失败的游戏里）
- **旧存档兼容**：本地缓存里没有 `revision` 时不带这个字段（服务端按旧行为「最后写入者胜」处理），下次推送成功后自动补上，所以不需要清档
- **踩过的坑（写管理端新字段时必看）**：全局 `ValidationPipe({ whitelist: true })` 会把**嵌套裸对象**的属性剥光 —— 请求里的 `bag: [{row:0,col:0,id:"1",count:1}]` 到服务层会变成 `[[]]`（属性没了，静默变空数组）。所以嵌套结构必须声明成带装饰器的 DTO 类并挂 `@ValidateNested` + `@Type`（见 `RoleBagCellDto`），不能写成 `unknown[]`

### 服务端为什么不校验角色数据的内容？

- **角色数据是「不透明文档」**：背包 / 装备 / 技能 / 快捷键 / 新手物品全部由客户端 `configs/role` 这套配置驱动生成，服务端**不复制**游戏配置（复制必然漂移：改了配置忘了改服务端，就会出现「客户端有的东西服务端说非法」）。所以服务端只校验结构、归属、数量上限与重名，内容原样存
- **代价与代价的兜底**：服务端只把索引字段（id / name / occupation / sex / level）另存成独立列 —— 列表查询因此不用解析 JSON。改客户端配置**不需要**同步改服务端
- **改存档格式时注意**：`roles.data` 存的是 JSON **字符串**。读取路径用容错解析（坏数据当空对象），**编辑路径必须严格解析且解析失败直接报错** —— 绝不能用「空对象」兜底去写，那会把玩家的背包/装备清空（这是踩过的坑，e2e 里钉了断言）
- **上限在哪调**：见下一条

### 角色数量上限想改，改哪边？

- **权威在服务端**：`server/.env` 的 `ROLE_MAX_PER_ACCOUNT`（默认 3），创建时由服务端拒绝超限请求
- **客户端也有一份**：`configs/role.maxRoleCount` —— 它做两件事：创建前先拦一道省一次往返、以及和选角界面的站位数量对齐（`configs/layout/scenes.roleSelectorLayout.rolePositions` 只有几个站位，超出的角色界面上没地方放）
- **两边要一起改**，否则会出现「服务端说有 5 个位置但界面只画 3 个」
