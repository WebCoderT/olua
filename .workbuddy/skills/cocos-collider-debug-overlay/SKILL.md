---
name: cocos-collider-debug-overlay
description: 在 Cocos Creator 3.x 游戏里把碰撞体的碰撞范围可视化（范围框 + 名称/尺寸），并规避「动态给已有节点加 UI 子元素」的三个高频坑：子节点被 Layout 自动重排、后加的子节点留在默认图层导致不可见（含让图层容器自动继承的根治写法）、用 removeAllChildren 重建内容时旧节点根本没被销毁。含范围框与引擎判定盒完全对齐的绘制公式（Graphics 本地坐标 == BoxCollider2D 判定盒坐标系，不受锚点影响）。触发场景：用户提到"碰撞体可视化"、"显示碰撞范围/区域指示线"、"给碰撞加调试框"、"动态加的子节点位置被改"、"新加的 Label/Sprite 不显示"、"界面刷新后内容整块消失、必须关掉重开才显示"。
agent_created: true
---

# Cocos Creator 碰撞范围可视化（调试用）

## 何时用

用户要求「把游戏里的碰撞范围显示出来」「给所有碰撞体加范围框/名称」，或你在给运行中的节点动态挂 UI 子元素（调试显示、动态角标）时遇到位置被自动重排 / 新节点看不见。

## 四条核心事实（读引擎源码确认，别猜）

### 1. 范围框的绘制公式必须与引擎判定盒同式

引擎里 BoxCollider2D 的判定盒（`physics-2d/box2d*/shapes/box-shape-2d.ts`）：

```ts
aabb.x = offset.x - size.width / 2;
aabb.y = offset.y - size.height / 2;
aabb.width = size.width;  aabb.height = size.height;
aabb.transformMat4ToPoints(collider.node.worldMatrix, ...);   // 只乘节点世界矩阵
```

Graphics 也只在**节点本地坐标**里画、由节点世界矩阵变换（`2d/assembler/graphics/*` 里没有任何 anchor 处理）。所以二者同系：

```ts
graphics.rect(collider.offset.x - size.width / 2, collider.offset.y - size.height / 2, size.width, size.height);
graphics.fill();
graphics.stroke();
```

**两个关键结论**：

- **一定从碰撞体组件读 `size`/`offset`，不要让调用方传 size** —— 这样显示范围与真实判定范围永远一致，也顺带覆盖了 offset 非零的情况（如角色节点 anchor 0.5/0、碰撞体 offset (0,35)，框仍是身体而不是脚底）。
- **Graphics 与碰撞体都不受 UITransform 锚点影响**，别想着按 anchor 补偿，那反而会错位。

其它碰撞体：CircleCollider2D 用 `graphics.circle(offset.x, offset.y, radius)`；PolygonCollider2D 按 `points` 走 `moveTo/lineTo`。

### 2. Layout 会重排「所有带 UITransform 的活动子节点」

`ui/layout.ts` 的 `_checkUsefulObj()`：

```ts
const uiTrans = child._getUITransformComp();
if (child.activeInHierarchy && uiTrans) this._usefulLayoutObj.push(uiTrans);
```

没有任何排除开关。所以给一个自身是 Layout 容器的节点（flexRow/flexCol 建的、带 `Layout` 的）直接 `addChild(名称Label)`，文字会被挪到布局槽位，甚至挤动原有子节点。

**做法**：把调试显示（文字等）挂到一个**不带 UITransform 的纯分组节点**上，再挂到目标节点：

```ts
/** UiHelper.createGroupNode：纯分组节点，不 addComponent(UITransform) */
const group = new Node();          // 注意：不要用 UiHelper.createNode（它必加 UITransform）
group.name = name; group.setPosition(x, y, 0);
target.addChild(group);
group.addChild(labelNode);         // Label 自带 UITransform，照常渲染
```

不带 UITransform 的父节点不影响子节点渲染（项目里的 layer 容器本身就是 `new Node(name)`，里面装着全部 UI）。Graphics 是**组件**不是子节点，画在目标节点自身上完全不受 Layout 影响。

### 3. 新建节点的图层不会自动继承（症状：界面刷新后内容整块消失）

引擎里 `new Node()` 的 layer 恒为 `Layers.Enum.DEFAULT`（1<<30），**不会随父节点继承**；而项目自己的相机 visibility 通常只含自定义图层位（MAP/DROP/GAME/MONSTER/EFFECT/UI…），默认层不在其中 → 这类节点**渲染不出来**。

于是「挂到图层容器的那一刻递归设层」的做法会漏：

```ts
static addToMapLayer(node) { this.setNodeToLayer(node, Layer.MAP); this.MapLayer.addChild(node); }  // 只覆盖既有子节点
```

**典型症状**：弹窗/面板打开时正常，一旦刷新内容（背包刷新重建物品图标、装备槽换装、属性列表重建、怪物面板切目标）就整块消失，**关掉再打开又正常**（重开时又走了一次 `addToUILayer` 递归设层）。这正是「必须关掉重开」类 bug 的第一嫌疑。

**根治写法**（一次性解决，之后所有动态新建节点自动继承）：让 `setNodeToLayer` 在递归设层的同时，为整棵子树注册 `CHILD_ADDED` 监听。引擎在 `Node._setParent` 里就有 `newParent.emit(NodeEventType.CHILD_ADDED, this)`（`addChild`/`insertChild`/改 `parent` 都会触发），所以钩子是官方路径、不用改引擎：

```ts
private static layerWatchers = new WeakSet<Node>();   // 同节点只注册一次；节点销毁时 eventProcessor.destroy() 自动清理

static setNodeToLayer(node: Node, layer: Layer) {
  node.layer = layer;
  this.watchChildAdded(node, layer);
  node.children.forEach((child) => this.setNodeToLayer(child, layer));   // 旧子节点也要挂监听
}

private static watchChildAdded(node: Node, layer: Layer) {
  if (this.layerWatchers.has(node)) return;
  this.layerWatchers.add(node);
  node.on(Node.EventType.CHILD_ADDED, (child: Node) => {
    // 父节点已被移出该图层就跳过，防残留监听把子节点刷回旧图层
    if (!isValid(node) || node.layer !== layer) return;
    this.setNodeToLayer(child, layer);
  });
}
```

要点：`createLayer` 建容器时也走 `setNodeToLayer`（容器本身也要挂监听）；`addToEffectLayer` 这类「只设自身」的方法改成统一的递归实现，行为才一致。

**兜底仍然要留**：节点若不在任何图层容器子树内（编辑器场景里手摆的节点、prefab 实例），没有监听可用，仍需在创建显示节点后显式补一次：

```ts
LayerManager.setNodeToLayer(view, node.layer);
```

### 4. 重建式刷新不要用 `removeAllChildren()`（它只摘除、不销毁）

引擎实现（`scene-graph/node.ts`）只有：

```ts
public removeAllChildren () {
    for (let i = children.length - 1; i >= 0; i--) { const node = children[i]; if (node) node.parent = null; }
    this._children.length = 0;
}
```

后果：① 每次刷新都留下一批「已摘下但未销毁」的节点；② 挂在子节点上的 `NODE_DESTROYED` 收尾逻辑永远不触发（例如物品图标的悬停详情弹窗，图标被摘掉后详情会永久留在屏幕上并挡住后续点击——右键穿装备时鼠标必然正悬停在图标上，必现）。

**做法**：统一用「先摘除、再销毁」的小工具（本项目为 `ui/utils/node/NodeTree.clearChildren`）：

```ts
export function clearChildren(node: Node) {
  const children = node.children.slice();
  node.removeAllChildren();              // 立刻不再渲染/命中
  children.forEach((child) => child.destroy());   // destroy 是帧末执行，所以顺序不能反
}
```

顺带一条可用事实：`NODE_DESTROYED` 在 `Node._onPreDestroyBase` 里**先于** `eventProcessor.destroy()` 被 emit（引擎注释 "this should before event processor destroy"），所以在自己的销毁回调里做清理是安全的。清理回调要写成幂等（`MOUSE_LEAVE` 与 `NODE_DESTROYED` 都会触发）。

## 标准做法（以某项目为例，可直接套用）

1. **一个总开关**放到 `configs/debug.ts`：

```ts
export const debugConfig = { colliderRange: true };
```

2. **一个统一入口**（放 UI 零件工厂，别散落在各生成器里）：

```ts
static showColliderRange(node: Node, name?: string, kind: "obstacle" | "role" = "obstacle") {
  if (!debugConfig.colliderRange) return null;
  const collider = node.getComponent(BoxCollider2D);
  if (!collider) return null;                       // 无碰撞体静默跳过
  const color = kind === "role" ? ROLE_COLOR : OBSTACLE_COLOR;
  // ① 范围框：节点自身 Graphics
  const g = node.addComponent(Graphics);
  g.lineWidth = 3; g.strokeColor = color;
  g.fillColor = new Color(color.r, color.g, color.b, 40);   // 低 alpha 不遮底图
  g.rect(collider.offset.x - collider.size.width / 2, collider.offset.y - collider.size.height / 2, collider.size.width, collider.size.height);
  g.fill(); g.stroke();
  // ② 名称 + 尺寸：纯分组节点，避开 Layout 重排
  const view = UiHelper.createGroupNode("collider_range_view", collider.offset);
  node.addChild(view);
  LayerManager.setNodeToLayer(view, node.layer);            // 兜住调用时机
  if (name ?? node.name) view.addChild(UiHelper.createLabel(..., `${name ?? node.name} ${Math.round(w)}×${Math.round(h)}`, ...));
  return view;
}
```

3. **所有产生碰撞体的地方都调一次**（清点方式：全局搜 `addComponent(BoxCollider2D)` / 项目自己的 `addObstacleCollider`），典型 4 处：Tiled 碰撞对象组生成器、NPC 生成、怪物生成、主角自身（主角用另一种配色区分）。**每个都在挂完碰撞体之后一行调用**。
4. 掉落物之类**没有碰撞体**的东西（靠距离判定拾取）不会被画到，不要在总结里漏掉这个区别。

## 收尾检查

- [ ] 遇到「界面刷新后内容消失/必须关掉重开」先在图层上找原因（第 3 条），再看是否用了 `removeAllChildren`（第 4 条）；
- [ ] 全局搜旧方法名/旧常量（如 `applyXxxDebugStyle`、`XXX_DEBUG_`）确认 0 残留；
- [ ] 全局搜 `removeAllChildren`：除「图层容器清空」这类由管理者负责销毁子节点的场景外，重建式刷新一律换成 `clearChildren`；
- [ ] `debugConfig` 只有一处定义、一处语义；
- [ ] 项目有编辑器运行时，改完延时 8~12 秒 `sed -n 'N,Mp'` 复检磁盘内容（编辑器会回写覆盖，见 skill `cocos-asset-refactor`）；
- [ ] tsc 过滤引擎 `.d.ts` 噪声后 assets 下 0 错误；
- [ ] 提醒用户关掉开关的方式（一个 `false`）。
