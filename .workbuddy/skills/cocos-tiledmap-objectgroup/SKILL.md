---
name: cocos-tiledmap-objectgroup
description: Cocos Creator 3.x 中把 Tiled（.tmx）对象组在游戏内实例化的正确做法，含三个必踩的引擎坑（对象「类」被解析器丢弃、object.y 被 _init 原地改写导致坐标翻两次、TiledMap 的瓦片裁剪 enableCulling 在相机跳变后会算错可见范围）、对象坐标换算、静态碰撞体生成、属性驱动的区域玩法（刷怪区 min/max，默认开图时一次性生成；含数量维持类需求的设计取舍与 tick 归属）、区域名称/指示线的调试显示、点位驱动的出生位置（类 revive 的点 = 进图/传送后的出生点，含「地图异步加载 vs 角色创建」的先后坑与回调式注册）；以及"没有地图节点时直接读 TMX 原文解析对象组"（资源预加载阶段推导地图内 NPC/怪物外观目录用）。触发场景：用户提到"Tiled 对象组 / 对象层"、"collision 碰撞图层"、"地图碰撞区域动态创建"、"NPC/刷怪点/复活点坐标"、"进图在复活点出生/复活点定位"、"按对象类/Class 判断"、"地图坐标转世界坐标"、"对象位置上下镜像/反了"、"monster 刷怪层 / 区域刷怪 / min max 数量 / 怪物刷新"、"不实例化地图就读出对象组/预加载地图内容"、"传送后地图一片黑 / 地图不渲染 / 动一下才显示 / 瓦片裁剪 / enableCulling"等。
agent_created: true
---

# Cocos TiledMap 对象组实例化

## 先记住三条引擎行为（否则必错）

### 坑 1：对象的「类 / Class」被解析器直接丢掉

Tiled 给对象设的 Class（1.9 之前叫 Type）导出为 `<object>` 标签上的 `type`/`class` 属性，但引擎
`cocos/tiledmap/tmx-xml-parser.ts` 的 `_parseObjectGroup()` **从不读这个属性**：`object.type` 被写成
引擎自己的形状枚举 `TMXObjectType`（RECT/ELLIPSE/POLYGON/POLYLINE/IMAGE/TEXT）。
→ **`getObjects()` 拿不到对象类，只能拿到自定义属性 `properties`。**

要在游戏里按「对象类」分流，唯一的办法是读原始 TMX 文本：

```ts
const xml = mapNode.getComponent(TiledMap)?.tmxAsset?.tmxXmlStr ?? "";  // 编辑器导入时原样保留，运行时可读
// <objectgroup ...> 内容片段（对象组不嵌套，其后最近的 </objectgroup> 即结束）
const openRe = /<objectgroup\b([^>]*)>/g;
// <object\b 不会命中 <objectgroup（o 后面是 g，无单词边界）；属性值里的 / 也不会让标签提前收尾
const objectRe = /<object\b([^>]*?)\/?>/g;
// 属性名要带 (?:^|\s) 前缀，避免命中 xxxname 这类后缀同名属性
```

拿到对象 id 后用 **对象 id**（Tiled 内全图唯一）把类合并回引擎解析结果。
对象类属性名两个都试：`class` 优先、`type` 兜底（Tiled 为兼容旧读法通常写 `type`）。
注意 `<property name="type" .../>` 是自定义属性，与对象类不是一回事——别混用，否则会踩「改了 Class 却不生效」。

**进阶（推荐）：整个对象只从 TMX 原文解析，彻底不碰 `getObjectGroup()`。**
`x/y/width/height`、`class/type`、`<properties>` 全都在原文里，因此**没有地图节点时也能读对象组**——
资源预加载阶段就是这样推导"这张地图要预加载哪些 NPC / 怪物外观"的（此时地图节点还没创建）：

- 对象不嵌套：一段 `<object ...>` 的内容读到它自己的 `</object>` 为止；解析完把 `lastIndex` 跳到该位置，
  避免把体内标签当对象。
- 自定义属性两种写法都要认：`<property name="id" value="1"/>` 与 `<property name="id">1</property>`。
- 读数一律 `Number(属性值) || 0`；属性值保持字符串（调用方按 `Number()`/模板串处理，别在这里猜类型）。
- 两条读法统一到 XML 之后，坑 1/坑 2 自然消失，而且**游戏内生成对象与预加载推导用的是同一套解析**，
  不会出现"预加载算了 5 个怪、进图只生成 4 个"这类两边读法不一致的问题。

### 坑 2：`object.y` 已被引擎翻转过，不能再翻一次

`tiled-object-group.ts` 的 `_init()` 对正交地图**原地**执行 `object.y = height - object.y`，并且
`this._objects = objects` 存的正是这批被改写过的对象 → **`getObjects()` / `getObject()` 给出的 y 是「引擎坐标系」的值（y 轴向上），不是 Tiled 原始值。**

原始 Tiled 坐标只留在同一循环里提前存下的 `object.offset` 里：

```ts
object.offset = new Vec2(object.x, object.y);   // 原始值（y 轴向下）
object.y = height - object.y;                    // 随后被改写
```

且 `offset` 与「y 被改写」必然同时发生：`_init` 的循环对每个对象都无条件先存 offset 再翻 y；
而 `getObjectGroup()` 只能取到 `_buildLayerAndGroup()` 里已执行过 `_init()` 的组 → **能读到对象就一定有 offset**。
所以按 `offset ? 用 offset : 用 x/y` 取值，两种情况下都是原始 Tiled 坐标，天然安全。

### 坑 3：相机跟随角色移动时，必须关掉瓦片裁剪 `TiledMap.enableCulling`

**症状**：瞬移/传送类操作（右键小地图传送、突进技能、进图后在复活点定位）之后，整张地图**一片黑**，
再手动移动一下角色画面才恢复。编辑器场景里看不出来（编辑器非预览时引擎自己强制关掉了裁剪）。

**原因**（引擎源码 `cocos/tiledmap/tiled-layer.ts` + `assembler/simple.ts`）：

1. `TiledMap.enableCulling` 默认 `true`，图层按相机视口裁剪瓦片：
   `if (comp.enableCulling) { leftDown = cullingRect.leftDown; rightTop = cullingRect.rightTop; } else { leftDown = {0,0}; rightTop = comp.rightTop; }`
   —— **关掉裁剪即从 (0,0) 遍历到整层右下角，即「全量渲染」**（不是什么都不画）。
2. 裁剪范围只在 `TiledLayer.updateCulling()` 里算，它被挂在**相机节点 / 层节点 / 父节点的
   `TRANSFORM_CHANGED`、`SIZE_CHANGED`** 上 —— 也就是「相机一动就**同步**重算」。
3. 而 `updateCulling` 内部用 `camera.screenToWorld()` 取视口两角，依赖相机视图矩阵；相机移动的**当帧**
   该矩阵尚未刷新（引擎自己在 `onEnable` 里把首次裁剪 `scheduleOnce` 延后一帧，注释原文
   *"delay 1 frame, since camera's matrix data is dirty"*）。
4. 于是「相机跨屏跳变」会把裁剪范围算成**跳变前**的位置 → 目标区域整片不在裁剪矩形内、不渲染；
   因为相机的这次变化已经消费掉，之后不再触发重算，画面就一直黑到「相机下次变化」（= 角色移动一点）。

**修法**（本工程做法，一行）：

```ts
const tiledMap = this.addComponent(TiledMap);
tiledMap.tmxAsset = mapAsset;          // 先赋资源（图层此时才创建）
tiledMap.enableCulling = false;        // 再关裁剪：setter 会转发给所有 TiledLayer
```

- 引擎对 `enableCulling` 的注释就是 *「瓦片地图如果设置了 skew, rotation 或者**采用了摄像机**的话，需要手动关闭，否则渲染会出错」* —— 相机跟随角色的项目正中这一条。
- 代价：每帧全量提交瓦片。屏幕外的格子会被裁剪阶段丢掉，只多花顶点处理；本工程地图 2 层 64×64
  （每层 4096 格）完全无感。真遇到超大地图再考虑「每次瞬移后**下一帧**补一次 `layer.updateCulling()`」的替代方案。
- 放在 `tmxAsset` 赋值**之后**最稳：图层是在赋值时 `_buildLayerAndGroup()` 创建的，setter 才能遍历到它们；
  放在之前也可以（图层构建时会继承 map 上的 `_enableCulling`）。

## 坐标换算（两种写法，必须配对应来源）

| 坐标系 | 原点 | y 方向 |
|---|---|---|
| Tiled 对象原始坐标（`object.offset`，或 Tiled 编辑器里看到的） | 地图**左上角** | **向下**（北小南大） |
| Cocos 地图节点本地坐标 | 地图**中心** | 向上 |

```
// ✅ 推荐：取原始坐标（object.offset），按 Tiled 语义换算
localX = tiledX - mapPixelWidth  / 2
localY = mapPixelHeight / 2 - tiledY          // 点对象
localY = mapPixelHeight / 2 - (tiledY + h/2)  // 矩形对象，先取几何中心（Tiled 的 y 是矩形上边）

// ✅ 等价：直接用 getObjects() 的运行时值（已翻转过一次），就不要再翻
localY = object.y - mapPixelHeight / 2
```

**两套不能混用**：`H/2 - y` 配「原始 y」，`y - H/2` 配「运行时 y」，配错了就是翻了两次 → 上下镜像。

`mapPixelWidth = mapSize.width * tileSize.width`，`mapPixelHeight = mapSize.height * tileSize.height`。

### 依据（引擎源码，不要靠猜）

- `tiled-map.ts` 的 `_syncAnchorPoint()`：对象组节点 **anchor 强制 (0.5, 0.5)**，位置 (0,0)，且是地图节点的子节点
  → **对象组本地坐标 == 地图节点本地坐标**（无需再叠加偏移）；地图节点 contentSize = 地图像素尺寸、默认 anchor (0.5,0.5)
  → **地图节点原点 = 地图中心**。
- `tiled-object-group.ts` 的 `_init()`：`object.y = height - object.y`，子对象按 `object.y - height*0.5` 定位
  → 引擎自己的对象节点坐标就是 `y_runtime - H/2`，这是「视觉正确」的权威参照。
- `set tmxAsset` → `_applyFile()` → `_buildLayerAndGroup()` → `group._init(...)` **全同步**，所以赋值完 tmxAsset
  再读对象组时，y 一定已被改写。

### 两条自检法（比看代码更快发现方向错）

1. **语义边界**：Tiled 里叫「北/上/top」的对象换算后 y 必须 **> 0**，「南/下/bottom」< 0；四周墙的包围盒应各自跨在对应边缘（±W/2、±H/2）上。
2. **与历史可用公式对齐**：若项目里曾有过能跑通的换算（如旧提交里的复活点/相机定位），拿同一点位代入，两种写法必须得到**完全相同**的数值。数值一致才算改对——只做「看起来合理」的数值自检会漏掉整体镜像（四周都有围墙时镜像肉眼几乎看不出）。

## 实例化流程

```ts
const tiledMap = mapNode.getComponent(TiledMap);    // 地图节点自身挂 TiledMap
const group = tiledMap.getObjectGroup("npc");        // 组名即 Tiled 里的对象层名
if (!group) return;                                  // 别假设每个地图都有该层
group.getObjects().forEach((object) => { ... });
```

- `getObjects()` 返回的是 TMX 记录（`x/y/width/height/name/properties/type`），不是节点；`x` 不受 y 翻转影响，只有 `y` 被改写。
- 只有 `TEXT` / `IMAGE` 类型对象引擎会自动建节点；**`RECT` / 点对象不会**，必须自己换算坐标建节点。
- 类型：`getObjectGroup()` 返回 `TiledObjectGroup | null`，元素类型是引擎内部的 `__private._cocos_tiledmap_tiled_types__TMXObject`。
  不要硬写这个类型名——在项目里自定义一个只含所需字段的 `interface`（name/id/x/y/width/height/properties/offset），
  结构兼容即可通过类型检查（`offset?: Vec2` 在 d.ts 里是有声明的）。
- 建议把所有读取收敛到一个工具函数里（返回空数组而不是 null），并在这里统一处理 offset 取值与对象类合并，
  这样调用方拿到的一定是「Tiled 原始坐标 + 对象类」，不会再各自翻错。
- 自建节点的尺寸/名称：UITransform 尺寸 = 区域尺寸，节点名带上 Tiled 对象名（如 `collision_树根3`），便于在编辑器层级里定位。
- 点位用途分流建议按对象类做（`npc` / `revive` / …），而不是靠自定义属性 `type`；对无法识别的点位 `console.warn` 打出来，
  免得在 Tiled 里漏设 Class 时静默不生成、排查半天。

## 生成静态碰撞体

```ts
const rigidBody = node.addComponent(RigidBody2D);
rigidBody.type = ERigidBody2DType.Static;
const collider = node.addComponent(BoxCollider2D);
collider.size = node.getComponent(UITransform).contentSize;   // 尺寸取自 UITransform
```

节点必须挂到**相机可见的图层容器**下（物理与图层无关，但 2D 渲染的 Graphics/Label 需要）。若项目有 LayerManager 之类的图层容器，
走统一的 `addToXxxLayer(node)`，并在其中**递归**设置整棵子树的 layer，否则后加的子节点会留在默认 layer 上而不渲染。

## 调试显示（对象名称 + 区域指示线）

- 指示线：`Graphics`，`rect(-w/2, -h/2, w, h)` → `fill()` → `stroke()`（先 fill 再 stroke）；填充用低透明度（alpha 30~50）避免遮挡底图。
- 名称：`Label` 放区域中心；Label 的 UITransform 宽度要给足（如 200），窄区域的名称超出节点宽度是期望行为。
- **框要与引擎判定盒完全对齐**：读节点上的 `BoxCollider2D` 的 `size`/`offset` 来画（`rect(offset.x - w/2, offset.y - h/2, w, h)`），
  而不是让调用方传尺寸——这样显示范围永远等于真实判定范围，且二者都不受 UITransform 锚点影响。
- 做成可关闭的调试项（静态开关或全局 debug 配置），核对完能一键关掉。

## 属性驱动的「区域」玩法（刷怪区 / 采集区…）

对象组里画矩形 + 自定义属性（如 `id` / `min` / `max`）来描述一块**区域玩法**时的分工：

- spawner（地图侧）只做「地图数据 → 区域描述对象」的翻译（矩形转中心 + 尺寸，含 min/max 等属性），
  再把描述数组整体交给 core 里的管理器；**物体（怪物/掉落）的生成留在管理器内**，避免地图侧与运行时状态互相耦合。
- 描述对象的坐标给**世界坐标**（管理器生成物体时用 `setWorldPosition`），换算仍走统一的坐标工具；
  矩形转中心要记得 Tiled 的 `x/y` 是**左上角**：先取几何中心再换算。
- **默认按「开图时一次性生成」实现**：每个区域按其 `max` 在矩形内随机落点生成，之后不再变动，管理器也不需要为它存任何状态。
  数量维持/定时补刷属于后续需求，别顺手一起做——本项目就写过一版「按编号聚合 + 定时检测补充」，
  随即被要求整段移除（只保留首次生成），白做一遍还留下 min/max 语义歧义。
- 若确实要做数量维持（后续需求）：同一 key 可能分布在多个区域，聚合规则要先想清楚并写进注释
  （常见做法「按 key 的存活总数 < 各区域 min 之和 → 补到各区域 max 之和」，落点在各区域间随机）；
  且 **tick 不能放在 `extends Node` 的「组件」里**（没有 `update` 生命周期），要挂在**静态管理器**上暴露
  `update(deltaTime)`，由组合根（场景里的 `Component.update(deltaTime)`）每帧调用；计时用「剩余秒数 - deltaTime」累减，
  比 `Date.now()` 差值更抗掉帧与后台挂起。
- **min/max 的语义必须先确认**再实现：`min` 到底是「触发补充的下限」（则 `min=0` = 不设下限 = 永不补充）
  还是「开局保底数量」。本项目没确认就实现，交付时只能补一句「当前地图 min 全是 0，按你的规则不会触发补充」，
  返工的直接原因就是这个歧义 —— 涉及「最少/最多」这类词时先问清楚。
- 无碰撞体的区域也能复用同一套范围显示：把绘制实现抽成一个私有方法（读 `BoxCollider2D` 的 size/offset，
  或读 `UITransform.contentSize`），`showColliderRange` / `showAreaRange` 各自取数后调用它，两个调试开关分开控制。
- 属性缺失/非法的区域要 `console.warn` 打出来（缺 id、矩形宽高为 0、配置里查不到该 id、max < min），
  不要静默跳过——Tiled 端漏填属性是最常见的原因。
- 区域数量的**性能提醒**：每个物体都会重建动画/血条/调试框（帧动画无缓存时尤甚），
  单图 `max` 总量上百时进图会明显卡顿，交付时提醒一下或建议给动画加载加缓存。

## 点位驱动的出生位置（复活点）

用对象组里的一个点（类 `revive`）作为「进这张图时角色的出生/复活位置」的完整做法：

- spawner 只负责**记录坐标**（不建节点）：`this.revivePoint = new Vec3(object.x, object.y)`（Tiled 原始坐标），
  换图时随地图节点一起重建；`getRevivePoint()` 暴露给地图组件。
- 定位**不要写在地图里**：地图组件算出世界坐标（`getMapPointPositionOnWorld(revivePoint, mapNode)`）后，
  交给组合根注入的接收者去挪角色 —— 地图不认识角色组件，保持单向依赖。
- **顺序坑（必踩）**：地图资源是**异步**加载的（`await loadResourceAsync(TiledMapAsset)`），
  而角色节点通常在 `new GameMap()` 之后才创建 → 「等地图加载完再定位」会在角色还不存在时空跑，
  「角色创建后再定位」又可能地图还没好。**用「谁后就绪谁触发」的回调式注册**，两边都安全：

  ```ts
  // 地图侧
  private reviveWorldPosition: Vec3 | null = null;
  private reviveHandler: ((worldPosition: Vec3) => void) | null = null;

  /** 注册定位回调：地图已就绪时注册即立刻回调一次 */
  setReviveHandler(handler: (worldPosition: Vec3) => void) {
    this.reviveHandler = handler;
    if (this.reviveWorldPosition) handler(this.reviveWorldPosition);
  }

  // 地图加载完成、生成完全部对象后
  private goToRevivePoint(revivePoint: Vec3 | null) {
    if (!revivePoint) { console.warn(`${this.name} 未标复活点`); return; }   // 只 warn，绝不抛
    this.reviveWorldPosition = getMapPointPositionOnWorld(revivePoint, this as Node);
    this.reviveHandler?.(this.reviveWorldPosition);
  }

  // 组合根（地图与角色都建好之后）
  this.gameMap.setReviveHandler((pos) => this.roleDisplay.setWorldPositionByTransfer(pos));
  ```

- **复活点缺失只 `console.warn`**，不要 throw：`loadMap` 是无人在 `await` 的 async 函数，
  抛异常会静默 reject 并把其后的生成全部中断（表现是「NPC 和碰撞区都不见了」，极难定位）。
- 角色侧提供 `setWorldPositionByTransfer(worldPosition)`：`setWorldPosition` 之后**必须再调一次跟随逻辑**
  （如 `LayerManager.move(this.getWorldPosition())` 把相机/UI 层挪过去），否则角色瞬移了而镜头没跟、看起来像没生效。
- 需求若只是「每次进图/传送都从复活点开始」，**不必把坐标落盘**：每张图的出生点由该图的点位决定，进图即定位最省事；
  只有「记住上次下线位置」这类需求才需要持久化角色坐标。

## 生命周期

- 换图时这些节点要和地图一起清理（清空地图图层容器即可）；异步加载地图时必须等 `TiledMap` 组件挂载 + `tmxAsset` 赋值完成后再读对象组，否则拿不到 group。
- 同一图层容器内**后 add 的子节点渲染在上层**，调试显示放在 NPC 之后即可盖住它们。
- 一处抛异常会连坐：如果在生成流程中间（尤其是「无人 await 的 async 函数」里）抛错，后面的生成全部不执行。
  缺数据时用 `console.warn` 提示而不是抛异常，否则现象会表现为「只少了某几类对象」，极难定位。
