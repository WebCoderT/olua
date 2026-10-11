---
name: cocos-mouse-button-input
description: Cocos Creator 3.x 中处理「鼠标左右键 + 触屏点击」的交互：为什么不能同时监听 MOUSE_* 与 TOUCH_*（引擎把鼠标事件无条件模拟成 touch）、**按住拖动一个 UI 元素（拖拽换格子/拖拽排序）为什么该走 touch 通道：MOUSE_MOVE 不能注册在节点上（会吞掉全局指针追踪），touch 通道的「TOUCH_START 命中节点独占整段触摸」语义让落点必须自己用 hitTest 算，以及阈值区分点击/拖动（pressDragged 拦掉同一次抬起的点击）、右键不拖动（TOUCH_* 不带按键）、event.getLocation() 的向量会被下一次事件改写（跨事件保存必须 clone）、跟随指针的幽灵节点挂哪一层**、如何用 EventMouse.getButton() 区分左右键、如何用 sys.hasFeature(sys.Feature.EVENT_MOUSE) 做跨端回退、全局 input 监听为何也必须判按键、**点中 UI 元素为何仍会触发全局监听（引擎派发仲裁：只有把事件注册在节点上才会吞掉事件）以及如何用 UITransform.hitTest 做「点 UI 不影响世界操作」的命中检测**、**UI 层级之间的点击穿透（两条事件通道各看各的监听表：Button 只注册 TOUCH_* 所以在 mouse 通道上不可见，点弹窗关闭按钮会连带触发下层 HUD；修法与 blockClickThrough）**、**独占抬起的代价（界面在 mouse 通道「命中即独占」会吞掉 MOUSE_UP，让「以按下为开始、以抬起为结束」的世界操作卡死——按住走路角色一直走；修法 = 按压归属 trackUiPress / releaseWorldPress / bindMousePress，以及 MOUSE_UP 先模拟 TOUCH_END 再派发的顺序）**、**按压归属最容易踩的坑（两版都翻过车）：① 让每个元素记「自己」——节点事件会冒泡，祖先（弹窗面板/滚动区）会覆盖内层元素的起点 → 弹窗里所有功能一起失灵（穿不上装备/卸不下/地图弹窗点不动），判定必须含子树（格子里的物品图标只注册了 MOUSE_ENTER）；② 把起点挪到 UI 根统一记一次——UI 根没有 UITransform，一注册鼠标事件就让引擎每次鼠标事件抛 `Cannot read properties of null (reading 'cameraPriority')`（_sortPointerEventProcessorList 里的 `trans!` 非空断言 + `node._uiProps` 恒为真），整个预览的鼠标交互全废；正解 = 登记点必须是有 UITransform 的界面元素、记的值是 event.target（所有登记点写的都是同一个值 → 与登记顺序无关），只注册悬停事件的节点若自身是命中目标、链路上又没有登记点，必须自己 trackUiPress**、**世界侧也有可点对象（NPC/传送门/宝箱）不能当空地：markWorldInteractive + isPointOnWorldInteractive，按下不走路、点击不清选中**、**getLocation 与 getUILocation 的坐标系之争（hitTest 吃哪个、为什么混用会偏）**、**按住鼠标移动角色（左键走/右键跑/抬起停、360° 平分八方向、方向随指针 MOUSE_MOVE 实时改向、方向基准取身体中心、死区的两面用法、与键盘/自动战斗的优先级收敛）**、web 端右键菜单已被引擎屏蔽、一套可复用的绑定工具函数写法。触发场景：用户提到"右键点击/右键操作"、"区分左右键"、"点击触发了两次"、"背包右键穿戴"、"右键脱下装备"、"PC 与手机点击行为不一致"、"右键弹出浏览器菜单"、"点界面把选中目标清了/角色停止打怪"、"点击 UI 打断了自动战斗"、"点击穿透"、"点关闭按钮把下面的界面点开了"、"弹窗和 HUD 重叠时点上面触发下面"、"点一次触发两个按钮"、"鼠标移动角色"、"点击移动/按住走路/右键跑动"、"按住拖动转向/拖动时方向不跟着变"、"八方向移动"、"拖动物品时整个弹窗也跟着拖/拖东西把窗口一起拖走"、"子节点的拖动带动了父级窗口"、"节点没有 UITransform 却注册了触摸事件"、"左键点击直接攻击/右键只选中怪物"、"点 NPC 角色一直走/一直移动停不下来"、"弹出弹窗后角色还在走"、"按住走路松开在界面上角色不停"、"点 NPC 误触发移动"、"点了会开界面的世界对象"、"弹窗里的功能全都点不动"、"背包无法使用装备/无法卸下装备"、"地图弹窗点不了（无法寻路/飞行）"、"弹窗内的按钮突然全部失效"、"按压起点被覆盖"、"鼠标一动就报错/刷屏"、"Cannot read properties of null (reading 'cameraPriority')"、"cameraPriority 空指针"、"UI 根/图层容器上注册了鼠标事件"、"鼠标事件全废/界面点不动"、"节点鼠标事件必须挂 UITransform"、"拖动物品换格子"、"拖拽排序"、"UI 拖动没反应"、"拖动物品松手变成点击/顺手用掉了"、"拖动时指针样式卡住"等。
agent_created: true
---

# Cocos Creator 鼠标左右键与触屏点击

## 先记住一条引擎行为（否则必然重复触发）

`cocos/input/input.ts` 的 `_registerEvent()`（3.8.7 约 383~398 行）里，鼠标分支是**成对派发**的：

```ts
mouseInput.on(InputEventType.MOUSE_DOWN, (event) => {
    self._needSimulateTouchMoveEvent = true;
    self._simulateEventTouch(event);   // ← 先造一个 TOUCH_START 派发出去
    self._dispatchEventMouse(event);   // ← 再派发 MOUSE_DOWN
});
mouseInput.on(InputEventType.MOUSE_UP, (event) => {
    self._needSimulateTouchMoveEvent = false;
    self._simulateEventTouch(event);   // ← 先造一个 TOUCH_END
    self._dispatchEventMouse(event);
});
```

`_simulateEventTouch()` 用 `pointerEventTypeMap[eventMouse.type]` 造 `EventTouch`（MOUSE_DOWN→TOUCH_START、MOUSE_UP→TOUCH_END），**全程不看 `getButton()`**。

→ 结论：**一次鼠标点击（含右键）会同时产生 TOUCH_* 和 MOUSE_* 两套事件。**
所以同一节点既监听 `TOUCH_END` 又监听 `MOUSE_UP`，一次点击就会走两次回调（先后顺序：TOUCH 先，MOUSE 后）。

这也解释了为什么项目里按钮用 `TOUCH_END` 在 PC 上照样能点（靠模拟），以及为什么"右键也会触发左键逻辑"。

## 推荐写法：一个按平台二选一的绑定函数

把绑定收敛到一个工具函数里，凡是需要"点一下"的节点都走它：

```ts
import { EventMouse, Node, sys } from "cc";

export type PointerButton = "left" | "right";

/** 是否鼠标环境（有鼠标事件时才存在左右键区分） */
export const HAS_MOUSE = sys.hasFeature(sys.Feature.EVENT_MOUSE);

export function getPointerButton(event: EventMouse): PointerButton | null {
  if (event.getButton() === EventMouse.BUTTON_LEFT) return "left";
  if (event.getButton() === EventMouse.BUTTON_RIGHT) return "right";
  return null;
}

export function bindPointerAction(node: Node, handler: (button: PointerButton) => void, target?: unknown) {
  if (!HAS_MOUSE) {
    node.on(Node.EventType.TOUCH_END, () => handler("left"), target);   // 手机：只有触摸
    return;
  }
  bindMousePress(node, (event) => {                                     // PC：只监听鼠标，别再加触摸
    const button = getPointerButton(event);
    if (button) handler(button);
  }, target);
}
```

要点：
- **二选一，不是两个都监听**。按 `HAS_MOUSE` 分支，PC 只走鼠标、手机只走触摸，天然不会重复。
- 回调参数用语义化联合类型（`"left" | "right"`）而不是裸数字，调用方读起来即懂；以后要加中键只需扩类型。
- `target` 传调用方自身，配合 `node.targetOff(this)` 就能在刷新节点时统一解绑（列表/格子重建必用）。
- `EventMouse.BUTTON_LEFT` / `BUTTON_RIGHT` 是 `EventMouse` 上的静态常量；`Node.EventType.MOUSE_UP` 在 3.8 是 `"mouse-up"`。
- **别裸写 `node.on(MOUSE_UP, ...)`**：mouse 通道没有"按下起点"的概念（每个事件各自 `hitTest` 当前点），会变成"按下在 A、抬起到 B 也触发 B"；而且一旦有界面元素在 mouse 通道上独占抬起（下一节），世界侧就收不到它了。统一走 `bindMousePress`（内部负责归属判定 + 交还世界侧）。

## 全局 input 监听同样要判按键

`input.on(Input.EventType.MOUSE_UP, handler)` 拿到的是**所有**按键，包括右键。世界里"点击拾取/选中目标"这类逻辑如果不判按键，右键操作 UI 时会连带触发世界点击（例如右键点背包顺带选中了身后的怪物）。

```ts
private checkClickTarget(event: EventMouse) {
  if (event.getButton() !== EventMouse.BUTTON_LEFT) return;   // 右键属于界面操作
  // ...
}
```

## 点中 UI 元素，全局 `input` 监听照样会触发（必须自己判）

**症状**：角色正在自动打怪，点一下背包/挂机按钮，当前选中目标被清掉、自动战斗被打断（点空地取消选中的逻辑被 UI 点击误触发）。

**原因**（引擎 `cocos/2d/event/pointer-event-dispatcher.ts` + `cocos/input/input.ts`）：
- `input._emitEvent` 按 `EventDispatcherPriority` **降序**依次派发给 dispatcher：`UI`(1) 在前、`GLOBAL`(0) 在后，**前一个返回 false（吃掉了事件）就不再派发**。
- `PointerEventDispatcher` 只遍历**注册过指针事件的节点**（`_pointerEventProcessorList`，靠 `NodeEventProcessor` 的 ADD/REMOVE 事件维护），逐个 `UITransform.hitTest`，命中就 `event.propagationStopped = true` 并返回 false。
- 关键：**Button 组件只注册 `TOUCH_*`**（靠鼠标→touch 的模拟事件走），所以鼠标 `MOUSE_UP` 不会被它吞掉 → 一路走到 GLOBAL dispatcher → `input.on(MOUSE_UP, ...)` 的全局监听**照常执行**。只有自己用 `MOUSE_UP` 绑定的节点（如项目里的 `bindPointerAction`）才会把事件吃掉。

**修法**：世界点击入口自己先做 UI 命中检测，命中就整体 return（别只跳过"选中怪物"——顺手也能避免误拾取 UI 背后的掉落物）。

```ts
// ui/utils/input/UiHit.ts —— 递归遍历 UI 根节点子树
export function isPointOnUi(root: Node, screenPoint: Vec2): boolean {
  if (!isValid(root)) return false;
  return hitNode(root, screenPoint);
}

function hitNode(node: Node, screenPoint: Vec2): boolean {
  if (!node.activeInHierarchy || clickThroughNodes.has(node)) return false;  // 穿透标记见下
  const children = node.children;
  for (let i = children.length - 1; i >= 0; i--) {        // 后加的先判：同屏重叠时上层优先
    if (hitNode(children[i], screenPoint)) return true;
  }
  const transform = node.getComponent(UITransform);
  return !!transform && transform.hitTest(screenPoint);   // ★ 传屏幕坐标
}
```

要点：
- `UITransform.hitTest(point)` 要的是**屏幕坐标**（`EventMouse.getLocation()`，物理像素——引擎自己的派发 `node-event-processor._handleMouseDown` 与 `Button` 判定用的都是它），不是 UI 坐标（`getUILocation()`，设计分辨率下、已除掉 `view._scaleX`）。两者**只有画布物理尺寸恰好等于设计分辨率时才相等**（`getUILocation = 物理像素 / min(画布宽/设计宽, 画布高/设计高)`），混用会让命中点整体偏移，画布越大偏得越多。判世界命中用的 `UITransform.isHit(uipoint)` 才是 UI 坐标口径。**两个坐标系别搞混**（同一个回调里可能两个都要用）。
- 结论：项目里凡是要做命中检测（UI 命中、怪物命中、掉落物命中、光标悬停）的取点都收敛到一个工具函数（olua 的 `ui/utils/input/Pointer.getHitScreenPoint(event)` → `event.getLocation()`），别再各自写 `getLocation()` / `getUILocation()`——同一个回调里两种写法并存时，一改窗口尺寸就会出现"按下判定"与"抬起判定"对不上的怪现象。
- 判定层级容器要在**调用侧**传入：`LayerManager.isPointOnUi(point) → isPointOnUi(this.UILayer, point)`，这样 utils 保持纯净、不反向依赖 core。
- 没挂 `UITransform` 的纯分组节点（`createGroupNode`）自然不遮挡，其子节点照常参与判定，无需特判。
- **临时装饰要标"点击穿透"**：屏幕中间上浮的飘字提示（拾取提示会高频出现）、升级特效这类，视觉上在 UI 层但不该拦住世界点击。用一个 `WeakSet<Node>` + `markClickThrough(node)` 标记即可（节点销毁自动回收，不需要新组件、不需要清理）。
- 性能：只在点击时判定一次，整棵 UI 子树遍历 + 每节点一次 `hitTest` 完全可接受；不要放进 `MOUSE_MOVE`（见下条自定义指针的节流说明）。

## UI 层级之间的点击穿透：点上面的按钮，却触发了下面的 UI

**症状**：打开任意弹窗，点它的关闭按钮，弹窗关掉的同时**下层 HUD 也被点了**——关闭按钮正好压在小地图上时，关掉弹窗后会立刻弹出小地图弹窗。点弹窗面板的空白处（非按钮）同样会穿透。

**根因**：上一节说"Button 吞不掉 `MOUSE_UP` 所以全局监听会收到"，同一件事还有另一半——**下层的 UI 节点也会收到**。引擎按**两条互不相干的通道**派发（`cocos/2d/event/pointer-event-dispatcher.ts`，3.8.7）：
- `dispatchEventTouch:125` —— 只遍历 `shouldHandleEventTouch === true`（注册过 `TOUCH_*`）的节点；TOUCH_START 命中的那个节点会 claim 住 touchId，后续 TOUCH_* 只给它
- `dispatchEventMouse:101` —— 只遍历 `shouldHandleEventMouse === true`（注册过 `MOUSE_*`）的节点，按渲染优先级从上到下逐个 `hitTest`（`node-event-processor._handleMouseUp:555` 命中即 `dispatch + return true`），**命中即 break**

**Button 组件内部只注册 `TOUCH_*`**，于是它在 mouse 通道上**完全不可见**。一次鼠标点击被派发两次：`TOUCH_END` 关掉弹窗，`MOUSE_UP` 继续往下找到"自己注册了 `MOUSE_UP` 的元素"（项目里 `bindPointerAction` 绑的小地图、背包格、装备槽都属于这类）→ 把它点开。

**修法：让点击元素在 mouse 通道上也登记一次（命中即中断，回调不做任何事）**

```ts
// ui/utils/input/UiHit.ts（配合 utils/input/Pointer 的「按压归属」：本节点自己记下引擎给的命中目标 + 抬起交还世界侧，见下一节）
export function blockClickThrough(node: Node) {
  if (!HAS_MOUSE) return;                 // 触屏没有 mouse 通道：touch 通道本身"命中唯一"，不存在穿透
  if (clickBlockedNodes.has(node)) return;
  if (!ensureMouseHitTestable(node, "blockClickThrough")) return;   // ★ UITransform 防呆，见「节点鼠标事件必须挂在有 UITransform 的节点上」
  clickBlockedNodes.add(node);            // WeakSet 去重，节点销毁自动回收
  trackUiPress(node);                     // 本节点在鼠标通道上有监听，顺手把"按压起点"记上
  node.on(Node.EventType.MOUSE_UP, () => releaseWorldPress(), node);    // 独占抬起的同时交还世界侧收尾
}
```

要点：
- **只登记 `MOUSE_UP`，别登记 `MOUSE_DOWN` / `MOUSE_MOVE`**：
  - `MOUSE_MOVE` 是**全局监听**在用的（指针样式跟踪、按住拖动的方向实时改），节点一旦在 mouse 通道命中就会连它一起吞掉 → 指针移到按钮上时样式与拖动方向都会卡住。这个坑很容易顺手加错。
  - `MOUSE_DOWN` 不必登记也能拦住：`_handleMouseDown:499` 只要 `hitTest` 通过就 `dispatch + return true`（**与节点有没有该类型监听无关**）→ 一样中断派发。这里只是让 `trackUiPress(node)` 借同一次按下记下"按压起点"：**记的是引擎给的命中目标 `event.target`，不是本节点**；面板、滚动区、格子、图标各记各的也没关系，因为同一个事件里 `event.target` 只有一个值。**一旦改成记"本节点"，祖先会在冒泡阶段把内层元素的起点覆盖掉，弹窗里所有点击一起失灵**（见下一节）。
- **独占抬起必须交还世界侧**（`releaseWorldPress()`，见下一节）：否则"以按下为开始、以抬起为结束"的世界操作（按住走路）永远收不到结束。
- **应用面要"工厂级"而不是逐个按钮**：`UiHelper.createButton` / `createToggle` / `createScrollView`（覆盖全项目按钮）、弹窗面板根 `GameUiHelper.createDialogBg`（**只登记按钮不够**——点面板空白处照样穿透）、可拖拽节点 `Draggable.start()`、以及不走 createButton 的手写点击元素（`addComponent(Button)` + `on(TOUCH_END)` 的卡片/勾选框、`createRolePreview` 之类的可点节点）。
- **世界侧对象（NPC 等）不要登记**：它们一登记就会顶掉 `MOUSE_UP`，全局监听收不到。正确做法是**在世界侧跳过**：给节点打 `markWorldInteractive`（标在挂点击监听的那个节点上，判定范围与点击范围一致），按下/点击前问一句"点是不是落在世界侧可交互对象上"→ 是就当作交互（不走路、不清选中）。见「世界侧也有可点对象」一节。
- **绕不开的冒泡**：节点事件会冒泡给祖先链上所有监听者（`getBubblingTargets`），所以"点面板空白处"其实也命中了面板上的监听；反过来说，内层元素的按下/抬起**一定会走到祖先**。对"整次派发只有一个答案"的信息（按压起点就是），有两条路：① 只在祖先链末端记一次（但那个节点必须有 `UITransform`，UI 根没有 → 会把引擎打崩）；② 每个登记点都写**同一个值**（`event.target`），与顺序无关。落地用 ②。
- **父子顺序**：`_sortByPriority` 对父子节点的比较最终返回「子节点优先」（父链上提后 `n1 === node1` → `return 1`），也就是后绘制的在上——这正是关闭按钮能正常收到 `TOUCH_END` 的原因。所以"拦截者"只需要落在**弹窗这一层**即可，不必精确到某个子节点。
- `markClickThrough`（飘字等"要穿透"的装饰）与 `blockClickThrough` 是**相反方向**的标记，别在同一节点上混用。
- **自查脚本**：扫出所有 touch 点击注册点 → 回溯节点来源 → 报告是否已覆盖（工厂产物 / 直接登记 / 已核对白名单），跑一次就能发现漏登记的点击元素；白名单里每条要写明"为什么安全"（例：世界侧 NPC 属于刻意不登记，改由世界侧命中判定跳过）。olua 的实现在 `tools/audit-ui-click-through.cjs`（25/25 覆盖 PASS，另含"有鼠标监听的节点是否都有按压起点登记点""独占点必须走共用助手""关键接线"等段）。
  - ⚠️ **「回溯节点来源」要从注册行往前取最近一次赋值**，不能取文件里首个同名赋值：同一个名字常被赋值多次（`private btn: Node | null = null;` → `this.btn = null;`（清理残留引用）→ `const btn = createButton(...)`），取首个会把好好的工厂产物判成「未登记」。**被审计拦下时先确认是不是这类假警**，别急着重构业务代码。
- 复刻引擎两条通道做个几十行的派发模拟脚本验证因果很划算：改动前后各跑一遍，能直接看到「touch → 关闭按钮 / mouse → 下层元素」变成「mouse → 关闭按钮(拦截)」，也能确认"点弹窗外世界"两侧行为不变（无回归）。**冒泡也要一起复刻**（同一事件发给祖先链上的监听者、`event.target` 不变），否则「各记各的起点」这一类 bug 在模拟里根本复现不出来。

## 独占抬起的代价：按住走路收不到 mouseup，角色一直走

**症状**：点 NPC（或任何"点了会开界面"的世界对象），弹窗出现后**角色一直走不停**；按住鼠标走路，把指针拖到小地图/按钮/弹窗面板上再松开，也会一直走。

**根因（两件事叠加）**：
1. 若那个世界对象既不在 UI 层、也不是"怪物"这类已有的特判目标，按住走路的第一次排除就没拦住它 → 按一下先往它那边迈步（哪怕它是弹窗触发点）；
2. 上一节那套"命中即独占"会把这次点击的 `MOUSE_UP` **吃掉**（`dispatchEventMouse` 里命中即 `break`，`dispatchEvent` 返回 false → `input._emitEvent` 不再派发给 GLOBAL 优先级的全局 `input` 监听）。而世界侧按住走路**以按下为开始、以抬起为结束**（听全局 `Input.EventType.MOUSE_UP`）→ 抬起收不到 → 按住状态永不解除。
   注意派发顺序（`input.ts:394`）：`MOUSE_UP` 是**先 `_simulateEventTouch`（`TOUCH_END` 在这一步触发，弹窗就是这时候被创建出来的）再 `_dispatchEventMouse`** —— 所以"弹窗半路出现、把同一次点击的抬起抢走"是必然会发生的，不是偶发。

**修法一：把 mouse 通道缺的"一次按压归谁"补齐（对齐 touch 通道语义）**

touch 通道本来就有这个语义：`dispatchEventTouch` 里 `TOUCH_START` 命中的节点把 touchId 记进 `claimedTouchIdList`，后续事件只派发给它；mouse 通道**没有**（每个事件各自 `hitTest` 当前点）。补上它：

**⚠️ 最关键的一条：这个"起点"必须记「引擎给的命中目标」（`event.target`），不能记「本节点」。**

两版都踩过，把两边的因果都写清楚：

节点事件（`TOUCH_*` / `MOUSE_*`）**都会冒泡**：引擎 `_handleMouseDown` 打完命中测试后 `event.bubbles = true; node.dispatchEvent(event)`，接着 `node-event-processor.dispatchEvent` 进入 `BUBBLING_PHASE`，按 `getBubblingTargets`（从命中节点一路走到根）把**同一个事件**发给祖先链上所有监听者。而 `event.target` 在 `dispatchEvent` 开头赋一次值（`event.target = owner`），**冒泡阶段始终不变 = 最初命中的那个节点**。

于是：

- **各记各的「自己」（第一版）** → 弹窗面板、滚动区这些祖先在冒泡阶段**把内层元素的起点覆盖成自己**（冒泡从内往外，最后写进去的是最外层）→ 内层元素（背包格子 / 装备槽 / 地图预览图）抬起时匹配不上起点 → **弹窗里所有点击一起失灵**（穿不上装备、卸不下、地图弹窗点不动）。这个坑踩过一次，代价是所有弹窗功能全废。
- **只在 UI 根记一次（第二版，逻辑正确）** → 任何界面元素上的按下都会冒泡到祖先链末端、只记一次、记的是 `event.target`，看着完美；**但 UI 根没有 `UITransform`，一注册鼠标事件就让引擎每次鼠标事件都抛 `cameraPriority` 空指针**，整个预览的鼠标交互全废（见「节点鼠标事件必须挂在有 UITransform 的节点上」一节）。这条路走不通。
- **正解（落地版）**：登记点 = **每个在鼠标通道上有监听的界面元素**（都带 `UITransform`），记的值 = `event.target`。所有登记点写进去的是**同一个值**，所以既与顺序无关、又不碰 UITransform 的雷。

```ts
// ui/utils/input/Pointer.ts
let pressTarget: Node | null = null;                   // 本次按压命中的界面元素（null = 不在界面上）
let worldPressRelease: (() => void) | null = null;      // 世界侧登记的收尾回调（必须幂等）
const pressTrackedNodes = new WeakSet<Node>();          // 已登记的节点（节点销毁自动回收）
const PRESS_TRACKER = {};                               // 记录监听固定用这个哨兵当 target，免得被调用方的 off/targetOff 摘掉

// 全局 MOUSE_DOWN 只在「没有任何界面节点命中这次按下」时才会派发到（界面命中即中断），
// 所以收到它就等于"起点不在界面上"；顺带把上一次的归属清掉
input.on(Input.EventType.MOUSE_DOWN, () => { pressTarget = null; });

/** 在节点上登记「本次按压命中的界面元素」——凡是在节点上注册了鼠标事件的元素都要调它 */
export function trackUiPress(node: Node) {
  if (!HAS_MOUSE || pressTrackedNodes.has(node)) return;
  if (!ensureMouseHitTestable(node, "trackUiPress")) return;     // ★ UITransform 防呆，见下一节
  pressTrackedNodes.add(node);
  // 记的是 event.target（引擎给的命中目标），不是 node 自己：同一个事件里它只有一个值，
  // 所以面板 / 滚动区 / 格子 / 图标各记各的也不会互相覆盖
  node.on(Node.EventType.MOUSE_DOWN, (event: Event) => { pressTarget = event.target ?? null; }, PRESS_TRACKER);
}

/** 起点是否落在本节点（含整棵子树）内 —— 抬起时用 */
export function isUiPressWithin(node: Node) {
  const t = pressTarget;
  if (!t || !isValid(t)) return false;
  return t === node || t.isChildOf(node);   // 含子树：见下面「内层只监听悬浮事件」那条
}

export function setWorldPressRelease(release: (() => void) | null) { worldPressRelease = release; }
export function releaseWorldPress() { worldPressRelease?.(); }

export function bindMousePress(node: Node, handler: (event: EventMouse) => void, target?: unknown) {
  if (!HAS_MOUSE) return;
  if (!ensureMouseHitTestable(node, "bindMousePress")) return;   // ★ UITransform 防呆
  trackUiPress(node);                                            // ★ 本节点也登记按压起点
  node.on(Node.EventType.MOUSE_UP, (event: EventMouse) => {
    releaseWorldPress();                     // 抬起无论归不归我，都把这次按压的结束交还世界侧
    if (!isUiPressWithin(node)) return;       // 起点不在我（或我的子树）里：不响应这次点击
    handler(event);
  }, target);
}
```

**为什么必须判"含子树"**：内层节点自己也可能注册鼠标监听 —— 背包格子里的物品图标注册了 `MOUSE_ENTER`（悬浮物品详情），点它时 `event.target` 是**图标**而不是格子，若只判 `=== node`，格子照样收不到点击。凡是"可点区域的内部还有只监听 `MOUSE_ENTER/LEAVE` 的装饰节点"，就必须按子树判定。

世界侧（按住走路那个组件）构造时登记一个**幂等**收尾：
```ts
setWorldPressRelease(() => this.releasePress());   // releasePress 里 `if (!this.pressed) return;` 开头
// 宿主 NODE_DESTROYED → destroy 里 clearWorldPressRelease(同一函数引用)（按引用比对，别顶掉新场景的）
```
幂等是关键：界面因此可以**无条件**交还（起点在界面上时世界侧本来没按住，交还等于空操作），不需要两边协商归属。

**只注册悬停事件的节点也别漏**：`MOUSE_ENTER` / `MOUSE_LEAVE` 同样让节点进鼠标监听列表、同样会成为某次按下的命中目标。如果它所在子树里没有别的登记点（例：状态图标 → 状态图标条 → 角色信息栏 → UI 根，一路都没有），就必须自己 `trackUiPress(node)`；否则它的按下不会被记录，抬起时会读到**上一次按压的旧起点**（"按下状态图标、拖到背包格子上松开 → 误用了物品"就是这么来的）。审计脚本第 2 段专门盯这条。

**修法二：世界侧的"可交互对象"要有判据，别拿"不在 UI 层"当空地**

```ts
// UiHit：与 isPointOnUi 共用同一个递归命中器，只是多传一个"谁算命中目标"的谓词
export function isPointOnUi(root, p) { return hitNode(root, p, () => true); }
export function isPointOnWorldInteractive(root, p) { return hitNode(root, p, (n) => worldInteractiveNodes.has(n)); }
// 标记打在「挂了点击监听的节点」上（判定范围与点击范围天然一致），生成时一行：
markWorldInteractive(npcNode);
```
然后世界侧按下前多一句 `if (LayerManager.isPointOnWorldInteractive(p)) return;`（不走路），世界点击前也加一句（不清掉当前选中、不打断挂机）；**掉落物优先级要放在它前面**（压在 NPC 上的掉落物仍应能拾取）。

**验证**：把"引擎派发顺序 + 归属逻辑"复刻成状态机脚本，按**五个阶段**（原始 / 加穿透拦截后 / 加归属但各记各的 / 起点记在 UI 根 / 本次修复）× 场景（点弹窗里的格子与预览图、点 NPC、拖到小地图松开、拖到面板松开、原地松开、按下只监听悬停事件的图标再拖到格子上松开）各跑一遍：能清楚看到"按下接管走路 → 抬起被吞、卡死 ✗ → 弹窗内点击被跳过 ✗ → 全程不动/动作触发 ✓"，并确认"点小地图"的动作没被归属判定误伤、原地松开无回归。**引擎监听列表排序那段也要单独复刻一遍**（见下一节）：它能直接证明"挂 UI 根 → 抛 `cameraPriority` 空指针 / 加防呆 → 被拦下不崩"。

## 节点鼠标事件必须挂在有 UITransform 的节点上

**症状**：鼠标一动就刷 `TypeError: Cannot read properties of null (reading 'cameraPriority')`（`[Window]` / `[PreviewInEditor]` 各刷一行），堆栈落在
`PointerEventDispatcher._sortPointerEventProcessorList → dispatchEventMouse → Input._emitEvent`，整个预览的鼠标交互全废。

**根因（引擎 3.8.7，`pointer-event-dispatcher.ts:209` 起）**：

```ts
private _sortPointerEventProcessorList (): void {
    if (!this._isListDirty) return;
    const pointerEventProcessorList = this._pointerEventProcessorList;   // 注册过任意指针事件（MOUSE_* 或 TOUCH_*）的节点
    for (let i = 0; i < length; ++i) {
        const node = pointerEventProcessorList[i].node;
        if (node._uiProps) {                                             // ← 恒为真
            const trans = node._getUITransformComp();                    // ← 没挂 UITransform 时为 null
            pointerEventProcessor.cachedCameraPriority = trans!.cameraPriority;   // ← 非空断言，崩在这里
        }
    }
    ...
}
```

- `node._uiProps` **对任何节点都成立**：`node.ts` 里是字段初始化 `public _uiProps = new NodeUIProperties(this);`，构造时就有了，所以那个 `if` 拦不住任何东西；
- `_getUITransformComp()` 返回 `this._uiProps.uiTransformComp`，节点没挂 `UITransform` 时是 `null`，而引擎在这里写了 `trans!`（同一个文件里的 `_sortByPriority` 反而老老实实判了 `_getUITransformComp()`）；
- 结论：**只要一个没有 `UITransform` 的节点注册了任意指针事件（`MOUSE_*` 或 `TOUCH_*`，含 `MOUSE_ENTER` / `MOUSE_LEAVE`），下一次指针事件就必崩，而且每个指针事件刷一遍**。
  - 触屏/拖动也一样中招：`dispatchEventTouch`（同文件 `:125` 起）第一句同样是 `_sortPointerEventProcessorList()`，排序遍历的是**整张监听列表**（里面既有鼠标节点也有触摸节点）。所以「给某容器登记四个 `TOUCH_*` 来收住冒泡」之前，务必先让它有 `UITransform`（olua 是 `applyColumnStyle(this, ...)` 之后才登记）。
- 这类节点本来也命不中：`node-event-processor._handleMouseDown:499` 开头就是 `if (!node || !uiTransformComp) return false;`（`_handleTouchStart:638` 同样）。所以**在它上面注册指针事件没有任何意义，纯粹是踩雷**。
- 最典型的踩雷对象是**图层容器 / UI 根节点**（`LayerManager.createLayer` 只 `new Node(name)`，没有任何组件）。olua 里"把按压起点登记到 UI 根"那一版就是死在这条上。

**修法：所有注册入口加同一道防呆**（拿不到 `UITransform` 就跳过注册 + `console.warn` 打出是谁在注册，比在引擎里崩掉好诊断）：

```ts
export function ensureMouseHitTestable(node: Node, api: string): boolean {
  if (isValid(node) && node.getComponent(UITransform)) return true;
  console.warn(`[input] ${api}：节点「${node?.name}」没有 UITransform，鼠标事件既命不中、`
    + `又会在引擎排序监听列表时抛 cameraPriority 空指针，已跳过注册`);
  return false;
}
// trackUiPress / bindMousePress / blockClickThrough 三个入口的第一句都调用它
```

**要点**：
- 防呆判的是"**有没有 `UITransform` 组件**"（`node.getComponent(UITransform)`），不要用 `_getUITransformComp()`：后者要等组件 `__preload` 之后才有值，节点刚建好就绑监听会被误判成"没有"而静默丢弃所有鼠标事件（比崩溃更难查）。
- 顺手把这条写进静态审计：**图层容器/UI 根上不得出现任何 `Node.EventType.MOUSE_*`**（olua 的 `tools/audit-ui-click-through.cjs` 第 5 段有一条负向检查）。
- 模拟脚本里也能复现：写一个几行的 `engineSortProcessors`（`const trans = node.uiTransform ? {...} : null; p.cachedCameraPriority = trans.cameraPriority;`），把"监听列表里放一个没有 UITransform 的节点"跑一遍就知道为什么会崩，再跑"走防呆/不走防呆"两版对照。
- 这条与"按压归属记哪里"是同一个决策的两面：**登记点既要"能收到事件"（有 UITransform、能命中），又要"写同一个值"（`event.target`）**。两者同时满足的最简形态就是"每个在鼠标通道上有监听的元素自己登记"。
- 边界：**引擎自带组件不会自己注册节点鼠标监听**（3.8.7 里 `Button` / `EditBox` / `ScrollView` / `Toggle` 都只用 `TOUCH_*` 或全局 `Input.EventType.MOUSE_*`，翻 `cocos/ui/` 无 `node.on(Node.EventType.MOUSE_*)`），所以"有鼠标监听的节点"这一类全部来自**自己项目里的注册点**，静态审计能完整覆盖（扫描 `Node.EventType.MOUSE_*` 的注册点即可）。万一将来引入了会自注册的组件，让它所在容器落在一个登记点子树里就行。

## 世界侧也有可点对象（NPC / 传送门 / 宝箱）：别当成空地

- **现象**：点 NPC 会先往它那边走一步（甚至弹窗出来后一直走）、点 NPC 会把当前攻击目标清掉、打断自动战斗/挂机。
- **判据**：世界侧容器（`MapLayer`）里标记过的节点 + `LayerManager.isPointOnWorldInteractive(point)`，与 UI 命中检测共用同一个递归命中器（子节点倒序、`activeInHierarchy` 校验）。
- **两种点都要判**：① 按下（决定要不要接管成"按住走路"）；② 抬起/点击（决定要不要改选中目标）。只判其中一个就会出现"能走但选不中"或"能选中但先走一步"。
- **别用"鼠标通道登记"来拦**：那会把 `MOUSE_UP` 从全局监听那里抢走，世界点击反而收不到。

## 按住拖动一个 UI 元素（拖拽换格子 / 拖拽排序）：该走 **touch 通道**

上面那条「鼠标事件会被模拟成 touch」正是拖动要用 touch 通道的原因 —— 一套手势代码鼠标与触屏通用：

```ts
// ✅ 正确：手势走 TOUCH_*（鼠标环境由引擎模拟，触屏原生就是它）
cell.on(Node.EventType.TOUCH_START, onStart, this);   // 记起点（屏幕坐标）
cell.on(Node.EventType.TOUCH_MOVE,  onMove,  this);   // 超阈值才算拖动；跟随指针
cell.on(Node.EventType.TOUCH_END,   onEnd,   this);   // 用指针位置 hitTest 找落点
cell.on(Node.EventType.TOUCH_CANCEL, onCancel, this);
```

- **为什么不用鼠标通道**：`MOUSE_MOVE` **不能**注册在节点上（见「UI 层级之间的点击穿透」一节：节点一旦命中就吞掉它，全局的指针追踪、光标样式、按住走路的方向全卡住）。Touch 通道没有这个副作用。
- **touch 通道还白送一个语义**：`TOUCH_START` 命中的节点**独占整段触摸** —— 按下之后指针拖到哪儿、松在谁身上，`TOUCH_END` 都回到**起点节点**。所以落点必须自己算：遍历目标格子用 `UITransform.hitTest(screenPoint)`（屏幕坐标口径），不要指望"松手时命中的节点就是落点"。反过来这也意味着拖动途中路过的按钮抢不走这次抬起。
- **阈值区分「点击」与「拖动」**：位移小于阈值（olua 用 10 屏幕像素）就当点击，交给原有的 `bindPointerAction`（左键使用 / 右键穿戴）。**共存的关键是拦掉同一次抬起的点击回调**：用一个 `pressDragged` 标记，进入拖动时置位、**在下一次按下（TOUCH_START）时复位** —— 不要在落点处理里清，因为鼠标环境 `MOUSE_UP` 与 `TOUCH_END` 谁先执行都不该成为前提（引擎当前是 TOUCH 先，别把它写成依赖）。
- **右键不要触发拖动**：`TOUCH_*` 事件不带按键（`_simulateEventTouch` 全程不看 `getButton()`），所以在鼠标通道用 `MOUSE_DOWN` 记一个 `rightPress` 标记，拖动开始时判断它。
- **跨事件保存的坐标必须 clone**：`event.getLocation()` 返回的是会被下一次事件改写的**同一个** `Vec2`（`event.getUILocation()` 同理）。`start = event.getLocation().clone()`，只用于当帧比较的临时值可以不 clone。
- **跟随指针的表现节点**：挂到弹窗/容器下并**最后 addChild**（渲染在最上层），用 `parent.getComponent(UITransform).convertToNodeSpaceAR(camera.screenToWorld(point))` 换算坐标（父节点自己可能被拖动过，别省这一步）；再 `markClickThrough(node)`，别让它参与"点是否落在 UI 上"的判定。
- **别让父级的手势把这次拖动也一起拖走**（真实反馈：「拖拽物品时，整个弹窗也会跟着拖拽」）：节点 `TOUCH_*` 是**冒泡**的（引擎 `node-event-processor` 派发时 `event.bubbles = true`），所以「弹窗背景可拖动」这类父级手势会收到子节点里冒泡上来的 `TOUCH_START` —— 你拖的是格子，玩家看到的是整个弹窗跟着跑。两条修法（推荐都做，一条管「网格区域」，一条管「以后新加的子手势」）：
  - ① **子手势所在的容器把四个触摸事件收住**：容器上 `TOUCH_START/MOVE/END/CANCEL` 一律 `event.propagationStopped = true`。一处登记即可兜住两种按下 —— 按到子节点时事件从子节点冒泡、路过容器被停；按到容器自己的空白处时没有更深的节点认领，由容器自己独占。**别在每个子节点上各收各的**。
  - ② **父级「整窗拖动」组件不抢子节点的手势**：`onTouchStart` 里判「按下点是否自带拖动手势」→ `event.target.hasEventListener(Node.EventType.TOUCH_MOVE)` 为真就直接 return（`ScrollView` / `Slider` / 拖动格子内部都注册了 `TOUCH_MOVE`）。**必须排掉 `this.node` 自己**（拖拽柄也注册了 `TOUCH_MOVE`，一并拦掉窗口就永远拖不动了）；`event.target` 是引擎给的**最初命中目标**，冒泡全程不变。
  - ⚠️ 反过来别滥用：只有**自己有拖动/滑动/长按手势**的子节点才需要收住或拒绝被抢 —— 按钮这类点击子节点本来就该让弹窗能拖（按在按钮上想搬窗口是正常操作）。
- 落点规则（移动/合并/交换）与背包场景的完整落地见 skill `cocos-bag-tidy`（含触摸归属那一节）。

## 按住鼠标移动角色（左键走路 / 右键跑动 / 抬起即停）

需求形态：按下点没怪 → 按「指针相对画面的方位」移动，360° 平分八块，抬起停，左键走、右键跑。
**按住期间指针继续移动也要实时改向**（不是只在按下那一刻把方向定死）——这是最容易漏的一半，只写 `MOUSE_DOWN` 到手感就是"按下瞬间指哪走哪"。

**取点与判定（按下那一刻做的排除，顺序不能反）**：
```ts
private onMouseDown(event: EventMouse) {
  const run = event.getButton() === EventMouse.BUTTON_RIGHT;
  if (!run && event.getButton() !== EventMouse.BUTTON_LEFT) return;   // 中键等忽略
  const screenPoint = getHitScreenPoint(event);                      // ① 统一屏幕坐标
  if (LayerManager.isPointOnUi(screenPoint)) return;                 // ② 点 UI：界面操作，世界侧不接管
  if (LayerManager.isPointOnWorldInteractive(screenPoint)) return;   // ③ 点 NPC 等世界可交互对象：交互，不走路
  if (MonsterManager.getClickedMonster(screenPoint)) return;         // ④ 点怪：选中/攻击，不移动
  this.pressed = true;
  this.setDirection(this.getDirectionByScreenPoint(screenPoint), run); // 死区内返回零向量 → 只记按下状态
}
```
③ 是很容易漏的一条：NPC 既不在 UI 层也不是怪物，不排除就会"按一下先往 NPC 那边迈步"（见「世界侧也有可点对象」一节）。

**按住期间改向**：收全局 `Input.EventType.MOUSE_MOVE`（它在 `InputEventMap` 里，类型收得下），**必须判 `pressed`**，否则鼠标随便动一下就自己走起来。
```ts
/** 按住期间指针移动：方向跟着指针实时改；落在死区里不改方向也不停下，抬起才停 */
private onMouseMove(event: EventMouse) {
  if (!this.pressed) return;
  const direction = this.getDirectionByScreenPoint(getHitScreenPoint(event));
  if (direction.lengthSqr() <= 0) return;
  this.setDirection(direction, this.run);
}

/** 抬起：任何键抬起都停 */
private onMouseUp() {
  if (!this.pressed) return;
  const wasMoving = this.direction.lengthSqr() > 0;
  this.pressed = false; this.run = false; this.direction = new Vec2();
  if (wasMoving) this.onStateChanged();      // 死区内按下又原地松开，不必惊动宿主
}

/** 方向或走/跑真的变了才通知宿主（同扇区内的高频 move 不空刷动作） */
private setDirection(direction: Vec2, run: boolean) {
  const changed = !this.direction.equals(direction) || this.run !== run;
  this.direction = direction; this.run = run;
  if (changed) this.onStateChanged();
}
```
- 鼠标 move 可达几百 Hz，八方向量化后绝大多数回调算出的方向与上次相同 → `setDirection` 里的**等值判断是必要的节流**：不判就会每次 move 都 `refreshMotion()` → 反复 `crossFade`/重播动画。
- 拖动途中**不做** UI/怪物命中判定：划过界面或怪物不应中断移动（只有"按下那一刻"才排除）。
- 参考基准取**角色身体中心**（`节点世界坐标 + BoxCollider2D.offset`）而不是节点原点：角色锚点在脚底，用原点会让"点角色头顶"变成向上走。别用 `worldAABB` 当基准（它依赖物理步进，首帧可能还是空矩形）。
- 死区（`offset.length() < configs.role.pointerMove.deadZone`，约半个身位）的两面用法：**按下时**返回零向量表示"先不接管"（只记 `pressed`，指针拖出死区后由 move 回调补上方向，所以踩在脚下按下再拖出去照样能走）；**按住期间**落在死区则直接 `return` 保持上一次方向——既不转向也不停下，避免指针拖过角色身上时一停一走。

**方位 → 八方向**：屏幕点 → 世界点用 `camera.screenToWorld(new Vec3(screenPoint.x, screenPoint.y, 0), new Vec3())`（**必须传 out**，否则引擎会把相机节点自身位置当返回值写坏），再减去基准点；量化与移动向量都用同一张八方向表：
```ts
export function getDirectionByVector(v: Vec2): DIRECTION {              // 已有：atan2 每 45° 一瓣
  const octant = (Math.round(Math.atan2(v.y, v.x) / (Math.PI / 4)) + 8) % 8;
  return directionByOctant[octant];                                     // [RIGHT, RIGHT_UP, UP, ...]
}
export function getVectorByDirection(d: DIRECTION): Vec2 {              // 反函数：拿去当移动向量
  const angle = directionByOctant.indexOf(d) * (Math.PI / 4);
  return new Vec2(Math.cos(angle), Math.sin(angle));
}
```
量化后再走位（而不是沿鼠标原始角度走），移动方向就与八方向动画朝向严格一致，不会出现"朝右跑步却斜着飘"。

**接入角色状态机**：别复用自动战斗的 `setAutoMove`（会把 `isAutoMoving()` 变成 true，屏幕上会冒出「自动寻路中」提示）。正确做法是把它当**第三种玩家输入**，与键盘同级收敛到一个入口：
```ts
/** 玩家操控的移动意图：键盘优先（按下即接管），其次鼠标按住的八方向（方向随指针实时更新），都没有返回 null */
private getMoveIntent(): { vector: Vec2; run: boolean } | null {
  const keyboard = this.keyboardInput;
  if (keyboard?.isMoving) return { vector: keyboard.moveDirection, run: keyboard.isSprinting };
  const pointer = this.pointerInput;
  if (pointer?.isMoving) return { vector: pointer.moveDirection, run: pointer.isRunning };
  return null;
}
```
`updateAction`（STAND/WALK/RUN）、`updateDirection`（`getDirectionByVector(intent.vector)`）、`updateWorldPosition`（键盘 > 鼠标 > 自动战斗的 autoMove > 停）三处都改为读 `getMoveIntent()`；原来键盘分支里那一串 `isUp && isLeft` 的八方向 if-else 可以直接删掉（`getDirectionByVector(键盘向量)` 等价）。对外把 `isMovementKeyDown()` 扩成 `isManualMoving()`，自动战斗的"玩家接管"判断（快速攻击结束/挂机暂停）一并覆盖鼠标。

**组件形态照抄键盘输入**：`components/input/RolePointerInput.ts` —— 构造注入 `host` 与 `onStateChanged` 回调，只存 `pressed/run/direction` 三个状态 + 三个 getter；宿主在 `init()` 里 `new` 出来，`host.once(NODE_DESTROYED)` 里 `off` 全局监听。角色每帧读状态，状态变化时回调宿主 `refreshMotion()`（攻击锁期间只记录、解锁后自动恢复移动）。

**抬起兜底**：引擎 web 端把 `mouseup` 同时挂在 canvas 与 **window** 上，所以拖出画布再松手一样收得到 `MOUSE_UP`。想监听"鼠标移出画布"顺手停下的话注意：`Input.EventType.MOUSE_LEAVE`（值 `mouse-leave-window`）**不在 `InputEventMap` 里**，运行时引擎有转发但 `input.on()` 的类型签名收不下 → 会 `TS2345`，别硬写（可用 `as never` 强转，但没必要）。

**但"window 上的 mouseup"并不等于"一定能收到"**：只要这次抬起被某个界面节点在 mouse 通道上独占（`blockClickThrough` / `bindMousePress`），全局监听就整条被跳过 → 按住状态卡死、角色一直走。所以世界侧必须在构造时把收尾登记出去（`setWorldPressRelease(幂等回调)`），由界面在独占抬起时交还（详见「独占抬起的代价」一节）。**改完按住类交互后，务必手测这两个场景**：① 按住走路把指针拖到 HUD/弹窗上松开；② 点一个"会开界面"的世界对象（NPC）。

## 世界点击的按键语义：左键攻击 / 右键只选中

同一个「点击怪物」动作要分左右键时，先看全局 `MOUSE_UP` 上原本是不是写着 `if (button !== LEFT) return;`（"右键属于界面操作"）——**要支持右键就必须先放开这个判断**。不用担心界面被抢：`LayerManager.isPointOnUi` 已把 UI 上的点击整条滤掉（背包右键穿戴/脱下装备照旧）。

```ts
private checkClickTarget(event: EventMouse) {
  const isAttack = event.getButton() === EventMouse.BUTTON_LEFT;
  if (!isAttack && event.getButton() !== EventMouse.BUTTON_RIGHT) return;  // 中键忽略
  const screenPoint = getHitScreenPoint(event);
  if (LayerManager.isPointOnUi(screenPoint)) return;                       // UI 上的点击整条跳过
  if (isAttack) {                                                          // 拾取只认左键
    const drop = DropManager.getClickedDrop(screenPoint);
    if (drop) { DropManager.pickup(drop); return; }
  }
  if (LayerManager.isPointOnWorldInteractive(screenPoint)) return;         // NPC 等：它自己的交互，不清选中/不打断挂机
  const monster = MonsterManager.getClickedMonster(screenPoint);
  this.roleDisplay.setTarget(monster);            // 左右键都更新选中（点空地 = 取消选中）
  if (isAttack && monster) SkillManager.release(basicAttackSkillId);       // 左键点怪 = 直接攻击
}
```
- **攻击不要另写一套伤害逻辑**：走 `SkillManager.release(普攻技能id)`——冷却（`cooldown / speedRate[action]`，本项目普攻折算后 0.1s，连点不刷提示）、魔法值、距离校验、特效、伤害结算全在里面；**超出距离时 canAuto 技能会自己委托 AutoBattle 走过去继续打**（快速攻击），玩家手动移动即让位。
- 普攻技能 id 别散落成魔法字符串：放 `configs/skill.basicAttackSkillId`，点怪处只引用它。
- 与「按住拖动走路」的分工天然成立：按在怪物身上时 `RolePointerInput` 本来就 `return`（不走路也不跑），所以左键点怪不会既走又打；按在 UI 上两边都跳过。
- 站在「屏幕点击」与「拖动走路」的分界上看：**走路 = 按下那一刻（MOUSE_DOWN）决定并在按住期间更新，攻击/选中 = 抬起时（MOUSE_UP）结算**，两者共用同一套取点与 UI 过滤，不会互相打架。

## 其他已知事实（省得再查）

- **web 端右键菜单不用自己处理**：引擎在 `cocos/gfx/device-manager.ts:148` 已设置 `this._canvas.oncontextmenu = () => false`（仅 web/有 canvas 的平台）。
- **`Node.EventType.MOUSE_ENTER/MOUSE_LEAVE`** 同样来自鼠标事件、会命中检测，可用于 hover 详情；它们不受上面"成对派发"影响（touch 侧没有对应模拟，所以 hover 逻辑不会因触摸而重复触发）。
- **子节点会冒泡**：给"槽位/格子"这类容器绑定时，容器里的图标是子节点，事件会冒泡上来，只需监听容器本身，不必逐个给子节点绑；除非某个子节点自己 `propagationStopped = true`。
- **移动端**：`sys.hasFeature(sys.Feature.EVENT_MOUSE)` 为 false，此时没有右键概念，`bindPointerAction` 固定回调 `"left"`，业务侧"右键=穿戴/脱下"等操作在手机上就自然退化为"点击=使用"，这是符合预期的降级。
- **自定义鼠标指针（hover 换光标）**：引擎**没有任何 cursor API**（cc.d.ts 里 cursor 只有 EventMouse 取坐标）。Web 端唯一途径是 CSS：`element.style.cursor = 'url("<dataURI>") hotX hotY, <fallback>'`，图片用离屏 canvas 画形状再 `toDataURL("image/png")`（颜色/尺寸零美术资源，按「形状+颜色+尺寸」缓存 data URI）。注意：
  - 挂载点用 `document.querySelector("canvas")`（web 模板 body 上有 `cursor: default`，挂 body 也能继承但挂 canvas 最稳）；尺寸 ≤32px，大了部分浏览器直接忽略整个自定义指针。
  - 原生平台没有 DOM：入口统一用 `!sys.isNative && typeof document !== "undefined"` 把关，不可用就整体不接管（注册可以照常，判定空转）。
  - 引擎无 MOUSE_MOVE 节点事件的"节流"：高回报率鼠标 move 事件可达几百 Hz，**不要在事件回调里直接做命中检测**（每节点一次 `UITransform.isHit` 含两次矩阵求逆），正确做法是事件里只记位置置 dirty，命中判定放到每帧一次（组合根 update 调管理器 `tick()`）。
  - hover 目标用注册表模式：对象生成时 `registerHover(node, priority, style|getter)`、销毁时注销；判定时遍历顺手清理 `!isValid` 的残留，按 priority 排序取最上层（UI 里的物品要高于世界里的对象，否则弹窗盖住的怪物会透出攻击指针）。
  - 参考实现：olua 项目 `configs/cursor.ts`（样式集中配置）+ `ui/utils/cursor/CursorPainter.ts`（栅格化）+ `ui/core/CursorManager.ts`（注册表与判定）。

## 自检清单（改完 UI 交互后过一遍）

1. 该节点是否**同时**存在 `TOUCH_*` 与 `MOUSE_*` 监听？有就是重复触发的隐患（引擎把鼠标事件无条件模拟成 touch）——按下/抬起这类"点击"逻辑**二选一**，按 `HAS_MOUSE` 分支。
2. 全局 `input.on(MOUSE_*)` 是否判了 `getButton()`？
3. 列表/格子这类动态重建的节点，是否用统一 `target` 解绑（`targetOff`）再重绑，避免旧监听堆积？
4. 右键操作是否覆盖了"槽位为空/物品不可用"的状态？静默无反应 vs 提示文案要一致（本项目约定：不可用动作给 `GameUiHelper.createTip` 提示）。
5. 世界点击（选中目标/拾取/移动）入口是否先做了 UI 命中检测？新增的临时装饰（飘字、特效）是否标了点击穿透？**"点了会开界面的世界对象"（NPC 等）有没有标记成世界侧可交互对象**（`markWorldInteractive`），按下与点击两处都跳过？
6. 新增的"按住鼠标/拖动"这类有状态的输入，是否在**抬起**、**宿主销毁**两条路径上都清了状态与全局监听？（否则切场景后角色自己走、或重进场景收两次事件）**抬起是否还依赖"全局监听一定收得到"**——界面独占抬起时必须能交还世界侧（`setWorldPressRelease` + `releaseWorldPress`）。
7. 同一份交互里所有命中取点是否都走了同一个 `getHitScreenPoint`（别混用 `getLocation` 与 `getUILocation`）？
8. 新增的点击元素是否都在鼠标通道登记过（`blockClickThrough`）？会与 HUD 重叠的弹窗/面板是否**整体**登记（只登记按钮不够——点面板空白处照样穿透）？新增元素后重跑一次点击穿透审计脚本。
9. 有没有**裸写 `node.on(Node.EventType.MOUSE_UP/MOUSE_DOWN, ...)`**？这是唯一会让"抬起被吞掉却没人交还"的写法，统一走 `bindMousePress` / `bindPointerAction` / `blockClickThrough`；审计脚本里有一条专门扫它 + 盯「按压归属」的关键接线是否齐全。
10. 有没有把**只有唯一答案的信息**（本次按压起点、当前手势归属…）让每个节点记**自己**？节点事件会**冒泡**，祖先一定会在内层之后覆盖掉它 —— 这类信息只有两条出路：① 只在祖先链末端记一次（**但那个节点必须有 `UITransform`**，UI 根/图层容器没有，会把引擎打崩）；② 每个登记点都写**同一个值**（`event.target`，本 skill 采用）。改完弹窗交互后，**务必手点一遍弹窗内的功能**（穿装备/卸装备/预览图寻路），这类 bug 静态检查看不出来（`tsc` 全绿、审计也全绿）。
11. **新注册鼠标事件的节点有没有 `UITransform`？** 没有就别注册（引擎 `_sortPointerEventProcessorList` 读 `trans!.cameraPriority` 会抛空指针，每次鼠标事件刷一遍、整个预览的鼠标交互全废）——统一走带防呆的注册入口。别忘**只注册悬停事件（`MOUSE_ENTER`/`MOUSE_LEAVE`）的节点也算**：它要么在链路上已有别的登记点，要么自己 `trackUiPress`（否则它的按下不留痕，抬起时会用上一次按压的旧起点）。**触摸监听同样需要（`dispatchEventTouch` 也会排序整张监听列表）**：要给容器登记 `TOUCH_*` 之前先确保它有 `UITransform`。
12. **拖动/滑动这类子手势，父级会不会跟着动？** 父级（弹窗背景/滚动容器）若挂了「按住拖动」或滑动组件，子节点里冒泡上去的 `TOUCH_*` 会让父级也动起来（现象：拖物品把整个窗口拖跑）。两侧都要看一眼：子手势所在容器有没有收住四个触摸事件、父级拖动组件有没有「按下点自带拖动手势就不抢」的判定。改完**手点一遍**：拖子元素时父级不动、拖父级空白处仍能动。

## 悬停详情弹窗（hover tooltip，olua 已落地模板）

需求形态：鼠标移到图标上弹出详情（状态/技能/物品），移开或图标销毁即收起，剩余时间类文案要每帧刷新。

- **事件**：`Node.EventType.MOUSE_ENTER / MOUSE_LEAVE`，DOM 式 enter/leave 语义（移入子节点不触发父 LEAVE），且不受"鼠标→touch 成对模拟"影响，PC 专属、手机整体不绑即可。
- **创建/销毁用图标侧事件对**：MOUSE_ENTER 里创建弹窗，MOUSE_LEAVE **和** NODE_DESTROYED（`once`）都调 hide——背包/图标条是重建式刷新，图标被销毁时不会触发 MOUSE_LEAVE，只绑 LEAVE 弹窗会永久残留（物品详情弹窗当年就踩过）。
- **动态行（剩余时间/冷却）**：悬停期间每帧刷新，别在 MOUSE_MOVE 里做；项目做法 = 静态管理器持 `remainingProvider` + 组合根 update 调 `tick()`，状态到期（归零）整体收起、技能冷却结束改文案「就绪」不收。
- **定位别走 worldToScreen**：`camera.worldToScreen` 出来的是画布物理像素，与设计分辨率换算在 NO_BORDER 下必有偏差。UI 层容器与主相机对齐且无缩放时，**弹窗坐标 = 锚点世界坐标 − UILayer 世界坐标**（逐分量相减即屏幕中心系坐标），再用可见尺寸夹边：优先图标上方（anchorY=0 向上生长）→ 放不下摆下方（anchorY=1）→ 都放不下贴屏幕上沿。
- **高度自适应的时序坑**：纵向 Layout `ResizeMode.CONTAINER` 的容器高度要到下一帧才撑开，首帧摆放用**内容估算高度**（padding + 标题行 + 行数×行高 + 描述估算行数），别指望 `contentSize` 立即可用。
- **弹窗标记 markClickThrough**：详情是被动浮层，不参与 UI 命中判定，不挡世界点击。
- **循环依赖**：GameUiHelper（helpers）不要 import HoverTipManager（core）来绑事件——在**调用方组件**（StatusIconBar/ShortcutKeySlot/SkillListDialog）里绑，GameUiHelper 只出样式零件。
- 参考实现：olua `ui/core/HoverTipManager` + `ui/components/dialogs/HoverTipDialog` + `configs/layout/dialogs.hoverTipLayout`；更早的 `createGoodDetailDialog`（GameUiHelper）是同一模式的简化版。
