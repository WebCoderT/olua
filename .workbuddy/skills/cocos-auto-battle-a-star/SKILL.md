---
name: cocos-auto-battle-a-star
description: Cocos Creator 3.x 里给角色做「自动战斗 + A* 寻路走位」的成套做法：快速攻击（按 canAuto 技能无目标/超距时自动选最近怪、走位到技能范围连续出手、移动键或目标死亡结束）、自动挂机（开关常驻、目标死亡换下一个无限重复、不可达目标短期拉黑）、以及一套不依赖节点生命周期的 Tiled 地图 A* 网格（静态障碍来自 TMX 对象组、动态障碍每次寻路前重烙、8 向禁切角、视线拉直、目标格就近修正）。必踩的坑：给 Node 驱动的角色注入自动移动必须「键盘优先 + 动作/朝向变化守卫」（每帧 crossFade 会把动画拉回第一帧）、外部模块持有目标/地图节点必须随场景与换图 reset（换图不 reset 会对着已销毁节点寻路）、SkillManager 手动入口与自动入口要拆成两个（否则 release→AutoBattle→release 互相递归）、A* 结果要补精确目标点但目标格被挡时不得补。触发场景：用户提到"自动挂机/挂机打怪"、"快速攻击/自动攻击"、"自动选最近的怪"、"A星寻路/A* 寻路"、"自动走位/绕过障碍物"、"canAuto 自动释放技能"、"角色自动移动/外挂移动输入"、"路线指示线/路径线/寻路路线/把 A* 路径画到地图上"等。
agent_created: true
---

# Cocos 角色自动战斗 + A* 寻路（olua 项目实战）

## 一、总体结构（三块分离）

1. **AutoBattle（core，静态类）**：唯一的状态机。持有 `hangEnabled`（挂机开关）、`pendingSkill`（快速攻击的技能）、`target`、`path/pathIndex`、卡住检测计时、拉黑表。每帧由组合根 `Game.update` 调 `AutoBattle.tick(keyboardMoving)`，**放在主角 update 之前**——本帧写入的自动移动方向当帧生效。
2. **PathGrid（utils/map，纯工具类）**：格子化 + A* + 视线拉直，只吃世界坐标数字，**不持有任何节点**（换图不残留）。
3. **SkillManager 拆两个入口**：`release()`（玩家手动，失败弹提示，canAuto 且无目标/超距时委托 AutoBattle）与 `releaseAuto()`（AutoBattle 出手专用：静默失败、绝不再委托自动接战）。都收敛到私有 `tryCast(skillId, fromAutoBattle)`。**不拆就会 release → requestSkill → tick → release 互相打环**。

## 二、快速攻击 vs 自动挂机（一张表定行为）

| | 快速攻击（pendingSkill） | 自动挂机（hangEnabled） |
|---|---|---|
| 触发 | 按 canAuto 技能且无目标/目标超距（SkillManager 委托） | 挂机按钮开关 |
| 出手技能 | 玩家按的那个 | `findAutoSkill()`：按配置顺序第一个「已学习且 canAuto」 |
| 目标 | 手动选中的目标，否则全图最近（`getNearestMonster(pos, 0)`） | 永远全图最近 |
| 目标死亡 | **结束**（cancel） | 换下一个，无限重复 |
| 移动键按下 | **结束** | 暂停（不移动不出手），松手继续 |
| 无法接近 | cancel + 提示 | 拉黑目标 5s 换下一个（不卡死在一棵树上） |
| 换图/重进场景 | 清空 | 开关保留，目标重选（挂机是玩家意志，跨图继续） |

- 挂机开启前校验 `findAutoSkill()` 存在，否则提示且不开启（防「开了挂机却站着不动」的死状态）。
- 场上没怪：挂机原地等，**限频扫描**（`targetSearchInterval`，默认 500ms），别每帧全图 forEach。
- 自动选目标同步 `roleDisplay.setTarget(node)`（怪物信息面板跟着显示），只在**目标变化时**调——每帧调会和玩家点击空白处取消选中打架。

## 三、A* 网格（核心取舍）

- **障碍数据从 TMX 读，不从节点收集**：静态障碍 = `readTiledObjects(xml, "collision")` 矩形（用 `getMapRectCenterPositionOnWorld` 转 world，别自己翻 y）+ NPC 点位按估算体型（60×90）占位；动态障碍 = `MonsterManager.getBlockingRects(excludeTarget)`——**当前追击目标不烙进网格**，否则目标格永远 blocked，路径只能到隔壁格。
- **网格以世界坐标为基准**（地图节点在原点，本地=世界）；bounds = 地图像素尺寸。每次 `rebuild(dynamicRects)` 重烙全部格子（几百矩形 × 几千格，<1ms，repathInterval 400ms 一次完全没问题）。
- 格子阻挡判定用**格中心是否落在矩形内**（不是矩形覆盖即挡），配合 clearance（角色半宽 20）外扩，走廊不至于被吃光。
- 8 向 A* **必须禁切角**（对角移动要求两个正交邻格都可走），否则斜穿墙角。
- 起点/目标格被挡时就近找可走格（切比雪夫逐圈外扩，起点半径 4、目标半径 6）。
- **视线拉直（string pulling）**：从每个路点尽量直连最远可视路点；采样步长 = cellSize/2。拉直后路点数量从几十个掉到两三个，走位才不会沿格线锯齿走。
- 目标格**没被调整过**时才把精确目标点追加为最后一个路点（尽量贴近）；被调整过就不补（否则朝墙里走）。
- findPath 失败返回 `[]`，调用方直线趋近兜底（和怪物追击同一策略），撞墙交给卡住检测收尾——**不要让寻路失败=呆立**。

## 四、卡住检测（无它则必死循环）

每 `stuckInterval`(500ms) 比对位移，低于 `stuckDistance`(8px) 视为卡住：强制下轮重寻路；连续 `stuckRetryLimit`(3) 次仍无进展 → 放弃当前目标（挂机拉黑换目标，快速攻击结束）。怪物会游走、会被其他怪挡路、会被击推进死角，没有这套机制自动战斗一定卡死。

## 五、给 Node 驱动的角色注入自动移动（最容易做错）

角色位移原本只读键盘（`updateWorldPosition` 里 `keyboardInput.moveDirection → linearVelocity`）。注入自动移动的正确姿势：

- `RoleDisplay.setAutoMove(direction | null, run)`：存字段；**攻击锁期间只记录不表现**；有方向时设 `action=WALK/RUN` + 八方向，**动作与朝向都没变就直接 return**——`appearance.play` 内部是 `crossFade(0.2)`，每帧调用会不停把动画拉回开头（角色看起来定在原地滑行）。
- `updateWorldPosition`：键盘向量优先，键盘无输入才用 autoMove；速度分别取 `isSprinting` / `autoRun`。两路都空才清零速度。
- 停止（传 null）时**不要**直接摆 STAND，要调 `updateAction()+updateDirection()` 按键盘现状恢复——玩家可能正按着方向键。
- 键盘状态传给 AutoBattle.tick（`isMovementKeyDown()`），让「移动键打断快速攻击/暂停挂机」的判断和真实输入一致，而不是各查各的。

## 六、接线清单（组合根）

- `Game.start`：创建主角后 `AutoBattle.setRoleDisplay(roleDisplay)`；`Game.update`：`AutoBattle.tick(roleDisplay.isMovementKeyDown())` 放在 `roleDisplay.update()` 之前；`Game.onDestroy`：`AutoBattle.reset()`。
- `GameMap.loadMap`（TiledMap 挂好、怪刷完之后）：`AutoBattle.setMap(this)`——清旧网格与旧目标；**网格惰性构建**（第一次进自动战斗才建），setMap 只作废。
- 挂机按钮（hud/AutoFightButton）：图标 `main/auto_fight_open/close`（资源里现成的举剑/收剑图），注册 `AutoBattle.setHangStateListener` 同步图标（挂机被内部逻辑关掉时按钮也要刷新），`NODE_DESTROYED` 时注销回调。

## 七、点击寻路（静态目标点，2026-10-03 小地图弹窗接入）

AutoBattle 除了「追怪」还有第三种模式 **pendingPoint（点击寻路）**：`requestMoveTo(worldPoint)` 由 UI 层（小地图弹窗）下发世界坐标点。实现要点：

- **共用走位机制**：把原 `approach(target)` 重构成 `advance(roleDisplay, to: Vec2, repath: () => void, onGiveUp: () => void)`，追怪与点击寻路都走它（卡住检测/按需重算/路点推进原样复用）；`repath(target)` → `repathTo(roleDisplay, to: Vec2)`。**不要为静态目标点复制一份卡住检测**。
- **优先级**：pendingPoint > 战斗（tick 里在选怪之前分支处理）；`requestMoveTo` 清 pendingSkill/target 但**不动挂机开关**——到达或放弃后下一 tick 自动恢复挂机选怪。玩家手动移动（manualMoving）时与 pendingSkill 同待遇：cancel。
- **到达判定**用新配置 `arriveTolerance`（20px，与 waypointTolerance 分开：一个是整段终点、一个是中间路点）；到达/连续卡住放弃都走 `clearRuntimeState()`（pendingPoint 在这里面清，别漏）+ 提示。
- **tick 顶部的零开销返回**要把 pendingPoint 算进去：`if (!hangEnabled && !pendingSkill && !pendingPoint) return;`（漏了就是点击寻路永远不动）。
- **传送落点吸附**（右键飞过去别飞进墙里）：`PathGrid.findNearestWalkablePoint(x, y, radiusCells)`（nearestWalkableCell 的公开包装）+ `AutoBattle.findWalkablePoint(point)`（ensureGrid + rebuild(含怪物动态障碍) 后吸附），调用方拿 null 就退回原始点；传送本体走 `setWorldPositionByTransfer`（复活传送同一套入口，内部已带 LayerManager.move 相机对齐）。
- **UI 点击 → 世界坐标**（本工程 UI 层无缩放、UILayer 世界坐标被主相机直接对齐到主角）：`getHitScreenPoint(event)` 屏幕坐标 → `LayerManager.camera.screenToWorld(new Vec3(x, y, 0), new Vec3())`（**必须传 out**）→ 相对预览图中心的比例 → 乘地图像素范围。取件用 `getPointerButton`/`bindPointerAction`（左右键二选一绑定，见 skill `cocos-mouse-button-input`）。

## 八、路线指示线（把 A* 路径画到大地图与小地图上，2026-10-04）

需求：自动寻路期间要能看到「角色 → 目标」的路线。本工程三处同源（结果一致，绝不各算一套）：

- **唯一数据源**：`AutoBattle.getRoutePoints(): Vec2[]`（世界坐标）。从「正在走向的路点」起（`from = min(pathIndex, path.length - 1)`）取剩余路点，末尾**补实时目标点**（点击寻路取 `pendingPoint`，追怪取 `target.getWorldPosition()`——怪在移动，重寻路间隔内路径末点会滞后）。**无路径（`path.length === 0`，例如已进范围内原地出手）返回空数组**，调用方据此清空，别自己臆测「是否在自动走位」。
- **大地图**：`core/RouteIndicator`（静态控制器，组合根 `Game.update` 每帧调、`onDestroy` reset）。绘制层 = `GameUiHelper.createRouteLineLayer(map)`，**挂在地图节点下的一个 Graphics**：地图层的渲染顺序在怪物层/特效层之前，所以线天然贴地、在角色与怪物之下；换图随旧地图节点销毁，判 `isValid(node) && node.parent === map` 后自动重建。世界 → 地图本地坐标走 `map.getComponent(UITransform).convertToNodeSpaceAR(...)`（缺 UITransform 时退回「减地图节点世界坐标」）。起点取角色当前世界坐标（每帧现取）。
- **小地图（HUD）**：绘制层放进 `mapView`（带 Mask 的裁剪视口）里 → 超出内容区的线被 Mask 裁掉，不用手工剔除；换算 `(world - roleWorld) * getSmallMapScale(contentWidth)`，起点即内容区中心的角色黑点。
- **小地图弹窗**：复用弹窗自己的 `createPreviewMapper`（与黑点/红点同口径），超出地图范围的点被夹到边缘。

**点状线画法（用户要「白色点状线 + 终点稍微大一点的白色圆形」时的落地做法）**：不要用 `stroke()` 画实线，改为沿折线**按弧长等距铺圆点**：每个点 `graphics.circle(x, y, dotRadius)` + `graphics.fill()`（`fillColor` 设一次即可）。跨折点务必**余量结转**，否则拐角处点会挤成一坨或出现大空档：

```ts
let carried = 0;                       // 本段第一个点距段首的距离
for (let i = 1; i < points.length; i++) {
  const from = points[i - 1], to = points[i];
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0) continue;
  if (carried > length) { carried -= length; continue; }   // 本段太短，一个点都放不下
  for (let offset = carried; offset <= length; offset += gap) {
    const k = offset / length;
    graphics.circle(from.x + dx * k, from.y + dy * k, radius);
    graphics.fill();
  }
  carried = gap - ((length - carried) % gap);              // 段末余量折成下一段的段首偏移
}
graphics.circle(end.x, end.y, style.endDotRadius); graphics.fill();
```

- 护栏：`gap = Math.max(dotGap, dotRadius * 2 + 1)`、`radius = Math.max(0.5, dotRadius)`——配置写小了也不会把点状线画成实线或画出半径 0 的隐形点。
- 拐角处相邻两点**直线距离**必然小于 `gap`（弧长是 gap、转了个弯），这是正常的，不要当成 bug 去"修正"。
- 规模参考：世界像素 gap=22/r=3 时，8000px 路线约 360 个点，每点 4 段贝塞尔自适应细分（`helper.ellipse` 实现），单 DrawCall 顶点量完全可接受。

**Graphics 必知**：`circle()` 内部自带 `moveTo`（见引擎 `assembler/graphics/helper.ellipse`）→ 「一串 `circle()+fill()`」互相独立，不会被连成多边形；若改用 `moveTo/lineTo → stroke()` 画折线，则记得 `stroke()/fill()` 提交后下一次 `moveTo` 才开新路径，所以「先折线 stroke、后圆点 fill」也是安全的。

**样式/性能**：颜色/半径/间距全部进配置，三处绘制层各有自己的配置源（**单位随绘制层**，别硬共用）——大地图 `configs/autoBattle.routeLine`（世界像素）、常驻小地图 `configs/smallMap.route*`（屏幕像素）、小地图弹窗 `configs/layout/dialogs.mapPreviewDialogLayout.route`（预览区比小地图大得多，点必须单独放大才看得见）。`drawRouteLine(graphics, points, style)` 收敛成一个 `RouteLineStyle` 对象参数，三处调用点只喂各自配置。
**重绘节流**：大地图按 `routeLine.refreshInterval`（33ms），小地图/弹窗跟随小地图 `refreshInterval`（100ms），别把 `clear()+重画` 每帧铺到所有表面。

## 九、Cocos 编辑器协作坑（本项目高频）

改 `.ts` 时编辑器可能**周期性把旧内容回写覆盖**，且是部分文件、部分段落（同一轮 Edit 有的落地有的丢）。对策：改完立即 `grep` 关键符号清点 → tsc → `sleep 15` 再清点一遍；发现回写就重打补丁再复检，直到两轮一致。
