---
name: cocos-screen-adapt-hud
description: Cocos Creator 3.x 里做「铺满窗口（NO_BORDER）的屏幕适配 + 常驻 HUD 贴边布局」，兼容任意窗口尺寸/宽高比。核心是三个必踩的引擎事实：① NO_BORDER 下 view.getVisibleSize() 恒返回**设计分辨率**（引擎把「视口」放大到超出画布再让画布裁掉溢出，_visibleRect 被反算回设计尺寸），拿它算贴边位置会把左上/右上区块排到屏幕外——真实可见区必须按 screen.windowSize / view.getScaleX|Y 反算（与相机 orthoHeight 同口径）；② 裁剪对设计中心对称 → 屏幕中心恒为坐标原点；③ 窗口尺寸变化时 Canvas._onResizeCamera 会把相机的 orthoHeight 与**世界坐标**改掉（拽回 Canvas 节点位置），且发生在 View 的 window-resize 监听之后、业务监听之前，所以尺寸变化后必须自己把相机/跟随层重新对齐到跟随目标。含贴边区块布局算法（anchor{edge,marginX,marginY} + getAnchoredPosition）、**整屏构图场景（选角/登录这类「一张设计图上摆满元素」）的「舞台 contain 等比缩放」做法**（含 EditBox 在缩放父节点下为何安全）、**跟着鼠标悬停元素走的浮层（tooltip / 物品详情弹窗）怎么摆：锚点中心 + 靠屏幕中间那侧 + 整块夹进可见区（getPopupPosition 纯函数、min>max 退回居中的夹取、自适应高度按 SIZE_CHANGED 幂等复夹）**、重排入口接线（screen 单例监听要在场景销毁取消）、以及一套按引擎公式枚举窗口尺寸做落位校核的验证脚本。触发场景：用户说"窗口变化后 UI 显示不全/被切掉"、"头像/地图区域被切"、"左侧按钮完全看不到"、"界面不贴边"、"换尺寸后 HUD 跑出屏幕"、"选角/登录界面在小窗口下元素跑出屏幕"、"要兼容更多分辨率"、"全屏铺满不留黑边"、"HUD 位置写死在 1624×750"、"getVisibleSize 拿到的是设计分辨率"、"鼠标悬停的弹窗位置不对/偏移很严重/跑到屏幕外"、"tooltip 被窗口裁掉"、"详情弹窗显示不全/想让它尽量靠中间"、"worldToScreen 换算出来的坐标摆 UI 偏了"、"改了节点锚点后布局内容整体错位"。
agent_created: true
---

# Cocos Creator 铺满窗口适配 + 常驻 HUD 贴边布局

> **本项目（olua）已不适用这一套**：自 #543 起 olua 只有一个分辨率 **1920×1080**，
> 运行时**不设置、不读**分辨率，也没有「可见区」概念 —— 舞台不缩放、HUD 贴边直接用
> `ScreenLayout.designResolution` 算常量、窗口比例不符时由引擎等比缩放留黑边。
> 本文保留给「必须兼容多种窗口尺寸」的场景（其它项目，或将来真的要重新支持多分辨率时）参考；
> 在 olua 里照抄 `applyScreenPolicy` / `getVisibleSize` / `getStageScale` 会被
> `client/tools/test-scene-stage.cjs` 的源码断言直接判红。

适用对象：**任意窗口尺寸/宽高比下都要贴边的常驻 HUD**（左上角色信息栏、右上小地图、底部导航栏、任务追踪条……），
「画面铺满窗口不留黑边」的适配策略（`ResolutionPolicy.NO_BORDER`），
以及**跟着鼠标悬停元素走的浮层**（tooltip / 物品详情弹窗，见第六节）。目标是**不写死坐标**：
配置里只保留「贴哪条边 + 边距」（HUD）或「间距 + 留白」（浮层），位置按当前真实可见区实时算出来。

## 一、必知引擎事实（源码级）

### 1. NO_BORDER 下 `view.getVisibleSize()` 恒等于设计分辨率 —— 不能用它算布局

引擎 `cocos/ui/view.ts` 的 `NoBorder.apply`：

```ts
// scale = max(sw/dw, sh/dh)；大的一轴决定 content 尺寸（content 比 canvas 大）
if (scaleX < scaleY) { scale = scaleY; contentW = designW * scale; contentH = containerH; }
else                 { scale = scaleX; contentW = containerW;    contentH = designH * scale; }
return this._buildResult(containerW, containerH, contentW, contentH, scale, scale);
```

`_buildResult` 把 viewport 算成 `Rect((containerW-contentW)/2, (containerH-contentH)/2, contentW, contentH)`，
**负偏移**（viewport 比画布还大），随后 `setDesignResolutionSize` 反算可见矩形：

```ts
vb.width = rv.width / this._scaleX;   // = designW
vb.height = rv.height / this._scaleY; // = designH
```

→ `view.getVisibleSize()` / `view.getVisibleRect()` **永远返回设计分辨率**（例如 1624×750），
与窗口大小无关。**绝不能**用它算 HUD 位置：窗口偏窄时贴左/贴右的区块会被排到屏幕外
（实测 1024×768 窗口下左上信息栏横向越界 293px、右上小地图越界 310px，而底部居中的那块看不出来）。

### 2. 真实可见区 = 窗口像素尺寸 / 缩放系数（与相机同口径）

引擎 `Canvas._onResizeCamera`：

```ts
const size = screen.windowSize;
this._cameraComponent.orthoHeight = size.height / view.getScaleY() / 2;   // 相机半高 = 可见半高
this.node.getWorldPosition(_worldPos);
this._cameraComponent.node.setWorldPosition(_worldPos.x, _worldPos.y, 1000); // ← 相机被拽走，见第 4 条
```

所以布局要按同一公式反算：

```ts
export function getVisibleSize() {
  const windowSize = screen.windowSize;           // 物理像素（dpr 上限 2），事件派发前已更新
  const scaleX = view.getScaleX();
  const scaleY = view.getScaleY();
  if (!windowSize.width || !windowSize.height || !scaleX || !scaleY) return view.getVisibleSize(); // 极端时机退回
  return new Size(windowSize.width / scaleX, windowSize.height / scaleY);
}
```

推论（设计分辨率 1624×750）：

| 窗口 | 真实可见区 | 说明 |
| --- | --- | --- |
| 1624×750 | 1624×750 | 完全等比 |
| 1920×1080 | 1333×750 | 偏窄：左右各裁 ~145 |
| 2560×1080 | 1624×685 | 超宽：上下各裁 ~32 |
| 1024×768 (4:3) | 1000×750 | 很窄：左右各裁 ~312 |

即 **一轴恒等于设计尺寸、另一轴更小**（更小的一轴就是被裁掉的量）。切换成 `SHOW_ALL`（有黑边）时
可见区就是设计区，公式要换回 `view.getVisibleSize()` —— 换策略务必同步改这里。

### 3. 裁剪对设计中心对称 → 屏幕中心恒为坐标原点

`_buildResult` 的偏移是 `(container - content)/2`，两侧对称，因此设计中心 = 画布中心 = 屏幕中心。
本工程相机与 UI 层由 `LayerManager.move(主角坐标)` 同点对齐（相机 ortho 框以相机节点为中心），
所以 **UI 层子节点的局部坐标原点就是屏幕中心**，贴边区块只需：

```ts
// 左上：x = -visW/2 + marginX + blockW/2，y = +visH/2 - marginY - blockH/2
// 右上：x = +visW/2 - marginX - blockW/2，同上 y
// 底部居中：x = 0，y = -visH/2 + marginY   ← marginY = 区块中心到屏幕下边缘（背景下沿本就溢出屏幕）
```

### 4. 窗口尺寸变化时相机被引擎改掉（必须自己补跟随）

`_updateAdaptResult`（注册在 `screen.on('window-resize')`，**引擎在 View.init 时注册，早于业务监听**）
→ `setDesignResolutionSize` → `emit('canvas-resize')` → `Canvas._onResizeCamera`：

1. 更新 `camera.orthoHeight`（这部分是我们想要的）；
2. **把相机世界坐标设成 Canvas 节点的世界坐标** —— 相机的跟随位置被清掉，画面视野跳回 Canvas 附近，
   而 UI 层还在跟随目标处 → UI 整体错位。

因为触发顺序是「引擎 → 业务」，所以在自己的重排回调里**先补一次跟随**：

```ts
this.offWindowResize = onWindowResize(() => {
  if (this.roleDisplay && isValid(this.roleDisplay)) LayerManager.move(this.roleDisplay.getWorldPosition());
  this.roleInfoBar?.applyAnchorPosition();
  this.smallMap?.applyAnchorPosition();
  this.bottomBar?.applyAnchorPosition();
});
```

> 相机跟随若只在「主角真的移动时」才 `LayerManager.move`（不是每帧），这个补位就**必须**做，否则静止时改窗口尺寸会看到地图视野错位。

### 5. 其它必知小项

- `Node.setPosition` **不接受 `Vec2`**（只吃 `Vec3` 或 `(x, y, z)` 三个数字）→ 算出的坐标要 `.x / .y` 拆开传。
- `screen` 是单例，**不随节点销毁回收** → 场景 `onDestroy` 必须显式 `off`（`onWindowResize` 返回取消函数）。
- 3.8 起 `view.setResizeCallback` 已废弃，用 `screen.on('window-resize')`（原生/小游戏同源）。
- 全屏图/黑遮罩用「设计分辨率」设尺寸仍然安全（可见区恒在设计区内部，等于多覆盖一圈）。

## 二、布局做法（贴边区块）

1. `configs/hudLayout.ts`（或同类配置）里每块只留
   `anchor: { edge: "top-left" | "top-right" | "bottom-center", marginX, marginY }`，
   其余子件坐标仍相对区块中心。
2. 纯函数 `getAnchoredPosition(blockSize, visibleSize, edge, marginX, marginY): Vec2`（见上第 3 条公式）。
3. 组件各自暴露 `applyAnchorPosition()`；**与「一次性挂背景/样式」的方法分开**，否则重排时会重复挂背景。
4. 重排入口只有一处（组合根的 `start`）：`applyScreenPolicy()`（各场景 start 幂等调用一次）+
   `onWindowResize(...)` 注册重排，`onDestroy` 取消。
5. 区块构造时就调一次 `applyAnchorPosition()`，保证首帧位置正确（此时 `applyScreenPolicy` 必须已经执行）。

## 三、验证方法（不跑游戏也能确认落位）

按引擎公式枚举窗口尺寸，逐个区块检查矩形是否落在可见区内（**别用 `view.getVisibleSize()` 验证**）：

```python
DW, DH = 1624, 750
def visible(sw, sh):
    s = max(sw/DW, sh/DH)                 # NO_BORDER 的 scale
    return (sw/s, sh/s)                   # 真实可见区（= 相机 orthoHeight*2 口径）
# 区块中心 -> 矩形 -> 判断 l >= -visW/2 and r <= visW/2 and t <= visH/2
```

实测结论（本项目）：1920×1080 / 2560×1080 / 1366×768 / 1024×768 / 1280×800 / 900×900 下
左上信息栏与右上小地图均完全在屏内；底部栏纵向「溢出」是设计如此（背景下沿本就出屏，
`marginY` 定义为中心到屏幕下边缘）。改完代码照工程约定跑 tsc 并 **sleep 20s 复检两轮**。

## 四、坑清单

- **区块声明尺寸 ≠ 视觉范围**：状态图标条比信息栏底边低 23px、小地图名称条比顶边高 2.5px —— 靠 margin 吸收，
  调 margin 时要一并考虑，否则内容会被裁。
- **区块比可见区还宽/高**时贴边救不了（4:3 窗口可见宽 1000 < 底部栏 1100，左右各溢出 ~50px）：
  需要另定策略（按可见宽度缩放、夹取、或让背景裁掉两端），不要指望 anchor 解决 ——
  **整屏固定构图（选角/登录这类）直接用第五节「舞台 contain 缩放」**。
- **固定坐标的其它 UI 会一起被裁**：居中弹窗/屏幕中间提示/怪物信息面板（如固定在 `(0, 330)`）
  在超宽窗口（可见高 685）会被顶出屏幕 —— 排查「显示不全」时别只盯着贴边的那几块。
- **别把 `getVisibleRect()` 和 `screen.windowSize` 混用**：前者是设计坐标系且（NO_BORDER 下）恒为设计分辨率，
  后者是物理像素；只有 `windowSize / scale` 才是设计坐标系下的真实可见区。
- **别拿相机 `worldToScreen` 的坐标去摆 UI**（真实事故：物品详情弹窗「偏移得很严重」）：
  `camera.worldToScreen` 返回的是**物理像素**，减 `view.getDesignResolutionSize()/2` 是把像素当设计坐标用,
  两个口径差一个 `view.getScaleX()` —— 窗口/屏幕越大偏得越离谱。要在屏幕中心系里定位界面元素，
  一律「元素世界坐标 − `UILayer` 世界坐标」。反过来说，`camera.screenToWorld`（指针 → 世界）是**对的**，
  因为 `EventMouse.getLocation()` 本来就是像素口径，两者配套。
- **中途改节点锚点会让 Layout 重排**：`Layout._doLayoutGrid` 取 `trans.anchorPoint` 当布局锚点，
  算子是 `boundary + (1 − anchorY) * height` —— 悬停时把弹窗锚点从 0.5 改成 0/1「贴边」，
  内容会整体平移一大截（弹窗里每个子件都跟着错位）。**摆放只挪位置（`setPosition`），排版交给 Layout**，
  锚点建好就别动；需要紧贴锚点元素就用上面第六节的间距，而不是改锚点。
- **自适应高度的弹窗，首帧量到的高度是「占位值」不是真高度**：`ResizeMode.CONTAINER` 的尺寸
  在 `AFTER_UPDATE` 才被 `setContentSize` 改掉（Label 的 `RESIZE_HEIGHT` 还要等渲染，
  可能连续两三帧），拿它算「夹取/居中」会先错一帧 —— 按 `SIZE_CHANGED` 复夹，别只算一次。
- **源码断言先剥注释再切片**（写测试的坑）：按字符偏移从原文件切片再剥注释，
  切片点落进一条多行注释中间时注释剥不掉，注释里的中文会被当成「裸中文文案」误报。
  顺序反一下（`strip(comments)` → `slice`）即可。

## 五、整屏构图（选角 / 登录类场景）：舞台 contain 缩放

贴边锚定只适合**各自独立**的 HUD 区块。像选角场景这种「一张设计图上摆满元素」的固定构图，锚定救不了：
元素横向铺得比可见区宽（本项目：设计宽 1624，最左元素 -777、最右 790，而 1024×768 窗口的可见区只有 1000 宽），
贴哪条边都会互相挤或重叠，只能**整块缩放**。

做法（本项目 `ui/RoleSelector.ts` + `configs/layout/scenes.ts`）：

1. 建「舞台」容器节点（`UITransform` 尺寸 = 设计分辨率），**除背景外所有元素都挂它下面**，
   坐标照旧按设计画布摆，配方里的坐标一个都不用改。
2. 纯函数 `getStageScale(stageSize, visibleSize = getVisibleSize()) = min(1, vw/sw, vh/sh)`
   （contain、只缩不放；NO_BORDER 下可见区必有一轴等于设计值，系数天然 ≤ 1）。
3. 舞台节点位于屏幕中心，`setScale(s, s, 1)` 即整体等比缩放且仍居中。
4. 背景**不进舞台**：全屏图按设计分辨率设尺寸恒覆盖可见区（见第一章第 5 条），
   舞台缩小后四周的留白由它兜底，所以不会露底。
5. 与 HUD 同一套接线：构造后先调一次保证首帧正确，`onWindowResize` 里重算，`onDestroy` 取消监听。

两个已核实的点（都查了引擎源码，别凭感觉）：

- **EditBox 在缩放的父节点下是安全的**：DOM 输入框的位置/尺寸 = `EditBoxImpl._updateMatrix()`
  用节点**世界矩阵**合成的 CSS matrix（含所有祖先 scale）× `setSize(本地 contentSize)` 的 px 尺寸，
  两者相乘就是屏幕尺寸，不会双重缩放；且 `setScale` 会经 `Node.invalidateChildren` 把脏标记
  传播给所有后代（`hasChangedFlags |= POSITION`），`beforeDraw` 因此会重算 DOM 位置，输入框跟着舞台走。
- 点击命中走世界变换，缩放不影响按钮/角色预览的可点性。

验证结论（照第三章枚举窗口尺寸逐个元素判越界）：

| 窗口 | 可见区 | 舞台缩放 | 未缩放时的越界元素 |
| --- | --- | --- | --- |
| 1920×1080 | 1333×750 | 82% | 左侧三按钮 / 底部栏 / 创建弹窗 |
| 1024×768 | 1000×750 | 62% | 左侧三按钮 / 底部栏 / 信息框 / 角色位 / 创建弹窗 |
| 2560×1080 | 1624×685 | 91% | 底部栏 / 开始按钮 / 信息框（上下被裁） |

缩放后所有尺寸下越界元素均为空。**代价**：窗口越窄越扁整块 UI 越小（900×1600 竖屏窗口 → 26%），
元素都在但很小；想要更好看得做「窄屏紧凑布局」（重排元素坐标/换排布），属额外工作量。

## 六、贴着某个元素的浮层（tooltip / 物品详情弹窗）：靠中间 + 整块可见

HUD 是「贴边」，浮层是另一类需求：**跟着鼠标悬停的那个元素走**（背包格子、装备槽、技能图标）。
它比锚点元素大得多（本项目详情弹窗 240×自适应 400+，物品格 50×50），所以「贴着锚点往外侧摆」
必然被屏幕裁掉一半 —— 玩家口径是「**弹窗尽量靠屏幕中间，信息才全在可视范围内**」。

做法（本项目 `ui/utils/layout/ScreenLayout.getPopupPosition` + `GameUiHelper.createGoodDetailDialog`）：

1. **坐标一律用屏幕中心系**：`锚点世界坐标 − LayerManager.UILayer 世界坐标`（与 HUD 同口径）；
   绝不用相机 `worldToScreen`（见坑清单）。这跟「跟随型节点挂哪个父节点」无关 —— 浮层挂在 UI 层，
   而 UI 层随相机移动，所以必须减 UI 层世界坐标，不能直接拿锚点的世界坐标当本地坐标。
2. **纯函数算位置**（`anchorCenter, anchorSize, popupSize, visibleSize, gap, screenMargin → Vec2`）：
   - 竖直：与锚点**同高居中**（视线不用上下跳）；
   - 水平：摆锚点**靠屏幕中间的那一侧**（锚点在左半屏摆右边、右半屏摆左边），这一侧放不下才换另一侧，
     两边都放不下取空得多的一侧；
   - 最后**整块夹进可见区**（四周留 `screenMargin`）；弹窗比可见区还大（极端窄窗口）时退回中心居中。
3. **夹取函数一条 `min > max` 分支就够**：区间对称时中点恰是屏幕中心，于是「塞不下」自动变成居中，
   既不会出 NaN 也不会把浮层推到屏幕外：
   ```ts
   const clampCenter = (v: number, min: number, max: number) => (min > max ? (min + max) / 2 : Math.min(max, Math.max(min, v)));
   ```
4. **间距/留白进配置**（`gap` / `screenMargin`），组件不写数值。
5. **自适应高度的浮层要复夹**：`Layout.ResizeMode.CONTAINER` 撑开尺寸要到 `AFTER_UPDATE`（甚至两帧，
   因为 Label 的 `RESIZE_HEIGHT` 在渲染阶段才定稿），首帧量到的只是配置里的占位高度 →
   先按当前尺寸摆一次，再监听 `Node.EventType.SIZE_CHANGED`（`UITransform.setContentSize` 派发）
   按最终尺寸重算。**重算必须幂等**（每次都从锚点与当前尺寸现算，而不是在当前坐标上累加），
   否则会随尺寸抖动叠加偏移。

单测怎么写（不用跑游戏，见第三章思路）：把 `ScreenLayout.ts` 这类「只依赖 cc 的纯逻辑模块」
丢进 configs 沙箱编译（垫片补 `screen` / `view` / `ResolutionPolicy`，
`tools/lib/configs-sandbox.prepare(name, entries, ccExtra)` 支持追加垫片源码），
然后枚举「窗口尺寸 × 缩放 × 锚点位置」检查浮层矩形是否整块落在 `getVisibleSize()` 内。

