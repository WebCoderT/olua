
## 工程风险（最高优先级，先看这条）
- **Cocos 编辑器运行时会周期性把「上一代」内容回写覆盖外部修改**，症状是文件里新旧内容混合、tsc 报出行号对不上；顽固形态是同一批 Edit 里 import 行 / 类字段 / 构造函数块**分多轮被剥**（每轮 sleep 20s 后才发现缺一块）。改完 assets 下文件必须 Read/sed 核对磁盘实际内容，并**延时几秒再复检**，被覆盖的重新施加；「补 → sleep → 复检 → 再补」循环到 tsc 0 错且连续两轮复检全过，**一次通过不代表稳定**。
- tsc 走 /tmp/tsconfig.check.json（baseUrl 指向工程、cc → `temp/declarations/cc.d.ts`），用 managed node + `~/.workbuddy/binaries/node/workspace/node_modules/typescript/bin/tsc -p`；基线：assets 0 错（引擎声明噪声约 63 条）。macOS BSD grep **不支持** `"a\|b"` 交替（恒 0 命中），须 `grep -c -e A -e B`。


## 项目约定（Cocos Creator 3.8.7 游戏 olua）
路径：`assets/configs`（纯静态数据，按域一文件）、`assets/types`（纯类型）、`assets/entities`（运行时实体）、`assets/skills`（技能行为）、`assets/ui/{core,components,controllers,helpers,utils}`。configs/types 不依赖 UI 层。

- **组件**一律 `export default class X extends Node`（RoleDisplay 写法）：构造函数里建 UI，不导出单例，哪里用哪里 `new`；文件/类名不带 Frame 后缀且**必须完全一致**。跨组件共享用 RoleUIManager 注册表或构造注入（`ui/Game.ts` 是组合根）。cc.Node 子类注意：字段名不能叫 `up/right`（与内置属性冲突）；`this` 传 Node 参数需 `this as Node` 断言。
- **管理器与 helpers 全是静态类**（`export default class X` 全 static，不实例化）：core/ 的 GameHelper/LayerManager/MonsterManager/DropManager/RoleUIManager/SceneManager/SkillManager/StorageManager/AutoBattle/MonsterAI/StatusManager/EffectManager/PreloadManager，helpers/ 的 UiHelper/GameUiHelper/AnimationHelper。弹窗是普通 class，由 BottomBar/npc 点击处创建。
- **helpers 只许 3 个，不要新建**：UiHelper（Cocos 基础封装，只被 GameUiHelper 引用）、GameUiHelper（UI 零件库）、AnimationHelper（帧动画）。生成 UI 样式的代码只允许出现在这两个 Ui* 里；**GameUiHelper 只做单个可复用零件**（createCurrencyItem/createHpText/createStatusIcon…，需刷新数据的返回 `{node, xxxLabel}`），整页拼接由组件自己做。物理碰撞体与图层容器不算 UI 样式。类内用 `//#region` 分块。
- **帧动画唯一入口 = `helpers/AnimationHelper`**（目录帧 `loadFrames`/`useRoleAnimation`/`useMonsterAnimation`/`playLoopWithDir`/`playOnceWithDir`；图集帧 `loadFramesFromAtlas`(`ByAction`)/`playLoopWithFrames`/`playOnceWithFrames`）。**不要再自建「图集帧 + addComponent(Animation) + sample 帧率」的组件脚本**：`assets/scripts/AnimationPlayer.ts` 已删除（连带 `assets/scripts/` 目录与 meta；备份在 `.workbuddy/backup/AnimationPlayer.ts.bak`），选角预览 `GameUiHelper.createRolePreview` 改用 `loadFramesFromAtlas` + `playLoopWithFrames`（帧率 `roleSelectorLayout.previewFrameRate` = 8，替代原 `sample = 8`）。异步装载回调里判节点要**严格模式** `isValid(node, true)`——列表/弹窗刷新是当帧 destroy + 重建，默认模式当帧漏判（skill `cocos-view-lifecycle` 第八节）。
- **components 按职责分子目录**：hud/（常驻 HUD）、panel/、dialogs/、role/、input/、map/。容器组件只聚合与转发（BottomBar 组合 navBar/expBar/hpOrb/shortcutKeyBar 并转发 update），渲染交子组件；子组件节点名与类名同风格（ShortcutKeyBar → `shortcut_key_bar`）。
- **ui/utils 按功能域子目录、一律具名导出纯函数**（不 default 对象、不带 Helper/Util 后缀）：battle/BattleMath、battle/MpHelper、drop/DropRoller、map/MapPointMath、map/TiledObjects、map/PathGrid、physics/ObstacleCollider、physics/MoveBlocking、physics/MonsterCollider、resource/ResourceLoader、input/Pointer、input/UiHit、cursor/CursorPainter、node/NodeTree。`input/Pointer.bindPointerAction`：鼠标环境用 MOUSE_UP 分左右键、触屏用 TOUCH_END 只回调左键，**二选一**（引擎把鼠标事件无条件模拟成 touch，同监听会重复触发）。
- 移动 assets 下文件必须连同 .meta 一起移动（保留 UUID，场景引用依赖它）；.meta 被 .gitignore 忽略（风险）。**新增 assets 下文件必须同时生成 .meta**（复制同类型模板 + uuidgen），否则编辑器会重分配 uuid。

### 场景 / 地图
- 切换一律 `SceneManager.loadScene` → Loading 过渡场景（文字显示百分比）：场景预加载 0~50、游戏资源 50~100，完成后才进目标场景；**地图切换 = 保存 onMap 后重进 Game 场景**（不存在原地换图）。给场景挂脚本：手写 .meta uuid，scene JSON 用压缩 uuid（前 5 hex + 27 hex→108bit base64 18 字符）。
- **GameMap 自身即地图节点**：`await` 地图 TiledMapAsset 加载完成后再 `addComponent(TiledMap)` 挂到自身（挂上即地图已就绪，不黑屏），不通过 helper 建地图子节点。时序：TiledMap 挂载 → MapObjectSpawner（NPC + 复活点）→ CollisionAreaSpawner → MonsterAreaSpawner → `AutoBattle.setMap` → `goToRevivePoint`。
- **loadMap 里任何一步都不许抛异常**：它是无人 `await` 的 async 函数，throw 会静默 reject 并中断其后全部生成（症状：NPC 与碰撞区一起不显示）；缺数据只 `console.warn`。
- **静态类跨场景持有节点（LayerManager 图层容器）必须在 initLayer/进场景时重建**（旧场景销毁会连带销毁静态节点 → 黑屏；把已销毁容器 addChild 到新场景会在 `Node.walk` 读 null children 直接崩）；实现是 private `createLayer(scene,name,layer)`。相机等由 `Game.start` 重新注入。全局 input 监听（RoleDisplay 键盘、ScreenClick 鼠标）必须随节点销毁移除；RoleUIManager 的视图引用在 `Game.onDestroy` 里 `clearViews()`。
- **切场景收尾不得驱动主角**：`Game.onDestroy` 期间主角正在销毁，任何 `setAutoMove/updateAction/play` 都可能命中半销毁状态（`Cannot read properties of null (reading 'play')`）。`AutoBattle.reset()` 只清运行时状态、不碰主角（`cancel()` 才停自动移动）；`RoleDisplay.updateAnimationPlay/updateOutShow` 保留 `isValid(this) || appearance` 守卫。

### 地图对象组与点位
Tiled 约定、坐标换算、对象类被丢弃 / object.y 被翻两次两个坑、碰撞体与调试显示、刷怪区 min/max、以及**类 `revive` 的点作为进图出生位置（含"地图异步加载 vs 角色创建"谁后就绪谁触发的回调式注册）**——完整做法见 skill `cocos-tiledmap-objectgroup`，不要在本文重复。
本文只留结论：读取对象组**唯一入口** `utils/map/TiledObjects`（一律从 `tmxXmlStr` 原文解析，坐标为 Tiled 原始值，组不存在返回空数组、调用方不必判空）；点位统一画在 **npc 对象组**，用**对象类**（`<object>` 的 class/type 属性，**不是**同名自定义属性）区分 `npc`（配 `id` 属性）/ `revive`；`monster` 组是矩形刷怪区（id/min/max），`collision` 组是矩形碰撞区；组名/属性名/类名常量集中在 `configs/map.tiledGroupNames/tiledPropertyNames/tiledObjectClasses`。旧地图兼容走 `getTiledObjectsFrom(map, "npc", "objects")`。
- **碰撞范围可视化统一入口 `GameUiHelper.showColliderRange(node, name?, kind?)`**：读节点的 BoxCollider2D size/offset 画框（Graphics）+ 名称尺寸（Label），显示范围与引擎判定永远一致；开关只有 `configs/debug.debugConfig.colliderRange` 一个（默认开）；Tiled 碰撞区/NPC/怪物/角色（kind="role" 绿色）全部在挂完碰撞体后调用；无碰撞体的节点（掉落物只按距离拾取）自然无框。
- **动态加 UI 的三条坑**（详见 skill `cocos-collider-debug-overlay`）：① 目标是 Layout 容器时后加的子节点会被重排 → 用 `UiHelper.createGroupNode`（不带 UITransform 的纯分组节点，Layout 只排列带 UITransform 的子节点）；② 图层已自动继承——`setNodeToLayer` 会为整棵子树注册 `CHILD_ADDED` 监听，之后动态新建的子节点自动对齐父节点图层（此前症状是「挂载后新建的子节点留在 DEFAULT → 界面整块消失、要关掉弹窗重开」）；只有不在任何图层容器子树内的节点（编辑器手摆）才需手动兜底；③ 重建式刷新**不能用 `removeAllChildren()`**（引擎只摘除不销毁，残留节点且 NODE_DESTROYED 不触发）→ 一律用 `utils/node/NodeTree.clearChildren(node)`。

### 战斗与技能
- **技能触发统一入口 `SkillManager.release(skillId)`**（校验/冷却按 `role.speedRate[config.action]` 折算/单体目标自动补全/距离校验/魔法值校验）。手动与自动两个入口：`release()`（玩家，失败弹提示）与 `releaseAuto()`（AutoBattle 专用，静默失败、**绝不委托自动接战**，防 `release ↔ requestSkill` 递归），收敛到私有 `tryCast(skillId, fromAutoBattle)`。技能实现签名 `(context: SkillContext) => void`，只依赖上下文不反查全局；上下文由 `RoleDisplay.buildSkillContext()` 组装、组合根 `setContextProvider` 注入；动画取 `config.action`；伤害走 `BattleHelper.calcSkillDamage`，受击走 `MonsterManager.hurt`。键盘/鼠标类全局事件必须挂 `input` 单例。
- **魔法值**：`Role.maxMp/mp/mpRecoverAccumulator`（maxMp = maxHp/2，装备不影响）；**读写唯一入口 `utils/battle/MpHelper`**（ensureDefaults/hasEnough/spend/recover）——**绝不在 Role 上挂实例方法**（存储层角色是 `JSON.parse` 普通对象，`role.xxx()` 必崩）；技能消耗字段 `mpCost` 在每个技能配置上；扣蓝后必须 `updateOnlineRole` 落盘。自然回复在 `Game.update` 每秒结算一次（`configs/role.mpRecoverPerSecond`，默认 2）。升级时 `GameHelper.combatCalc` 重算 maxMp，`onlineRoleGetExp` 里补满 mp（与 hp 一起）。
- **自动战斗**（`ui/core/AutoBattle.ts` 静态控制器：快速攻击 pendingSkill + 自动挂机 hangEnabled）与 A* 寻路（`utils/map/PathGrid`，从 TMX 读障碍、动态障碍每次 rebuild、8 向禁切角 + 视线拉直、**卡住检测必须有**）完整做法见 skill `cocos-auto-battle-a-star`。本文只留接线：`Game.update` 里 **`AutoBattle.tick(roleDisplay.isManualMoving())` 放在 `roleDisplay.update` 之前**；挂机按钮 `AutoFightButton` 图标 `main/auto_fight_open/close`，经 `setHangStateListener` 同步；节奏参数在 `configs/autoBattle`。
- **小地图弹窗与点击寻路（2026-10-03 晚）**：`components/dialogs/MapPreviewDialog`（普通类 + open()，实例由 SmallMap 持有并在 SmallMap.update 里驱动点位重绘；**打开入口 = 点小地图点位层或「世界」入口按钮**，由 SmallMap 用 `bindPointerAction` 接线）。预览图 = `resources/map/<地图id>/preview.jpg`（取图 `configs/layout/images.mapPreviewImage`，加载走 `<路径>/spriteFrame`，缺图只提示不阻断）。屏幕点→世界坐标链路：`getHitScreenPoint` → `LayerManager.camera.screenToWorld(new Vec3(...), new Vec3())` → 相对预览图中心的比例 → 地图像素范围（**UI 层无缩放、UILayer 世界坐标=主角世界坐标，直接按比例映射即可，不需要 UI 相机**）。**左键 = `AutoBattle.requestMoveTo`**（pendingPoint 点击寻路：优先于战斗、玩家手动移动即 cancel、到达/连续卡住有提示，与追怪共用重构出的 `advance/repathTo`；tick 顶部零开销返回必须把 pendingPoint 算进去；到达半径 `autoBattle.arriveTolerance=20`）；**右键 = `AutoBattle.findWalkablePoint` 吸附**（`PathGrid.findNearestWalkablePoint`，含怪物动态障碍，网格未就绪退回原始点）后 `setWorldPositionByTransfer` 直接传送（传送前先 `AutoBattle.cancel()`）。弹窗关闭即销毁节点，SmallMap 侧用 `isValid(dialog, true)` 判失效清引用（当帧销毁也拦得住）。
- **角色移动共三种来源，优先级 键盘 > 鼠标按住 > 自动战斗**（skill `cocos-mouse-button-input`）：`RoleDisplay.getMoveIntent()` 是唯一汇聚点（返回 `{vector, run} | null`），`updateAction/updateDirection/updateWorldPosition` 都只读它；键盘八方向那串 if-else 已删（`getDirectionByVector(键盘向量)` 等价）。鼠标操控 = `components/input/RolePointerInput`（左键走/右键跑/抬起停，按下那刻取一次方位 → `camera.screenToWorld` 减角色身体中心（节点世界坐标 + `BoxCollider2D.offset`，别用 `worldAABB`）→ `getDirectionByVector` 量化八方向 + `getVectorByDirection`（BattleMath，八方向单位向量，反向函数）当移动向量；死区 `configs/role.pointerMove.deadZone`）；按下时排除 UI（`isPointOnUi`）与怪物（`getClickedMonster`）。`isMovementKeyDown()` 已更名为 `isManualMoving()`（键盘或鼠标，自动战斗让位判断用）。
- **命中检测取点统一走 `utils/input/Pointer.getHitScreenPoint(event)`（= `event.getLocation()`）**：`UITransform.hitTest` 内部走 `camera.screenToWorld`，吃的是屏幕坐标（物理像素，引擎派发与 Button 判定同口径），`getUILocation()` 是设计分辨率坐标，两者只在画布物理尺寸≈设计分辨率时相等——混用会让命中点整体偏移（窗口越大越明显）。UI 命中/怪物命中/掉落物命中/光标悬停（`CursorManager.setLocation`）全部改走它。
- **选中怪物唯一入口是鼠标点击**：`ScreenClickInput`（全局 `input` MOUSE_UP，**只处理左键**，右键留给界面）→ `RoleDisplay.setTarget(node|null)` → `RoleUIManager.selectMonster` 创建/销毁面板。移动/走路/攻击都不影响选中；目标死亡或移除由 `RoleDisplay.update()` 自动 `setTarget(null)`。脚下选中光圈 `MonsterSelectIndicator`（components/hud，复刻 MonsterInfoPanel 动态视图模式：`setMonsterSelectFactory` 注入挂特效层、select 换目标、update 跟随、失效即销毁），图集/偏移/帧率在 `configs/effect.selectIndicator`（**怪物节点锚点居中=身体中心，与主角/面板的脚底锚点口径不同**，offset 需按怪物体型微调）。
- **动态面板模式（MonsterInfoPanel）**：core 不直接依赖 components——组合根注入 `RoleUIManager.setMonsterInfoFactory((target) => {new + addToUILayer})`，选中时创建、取消/失效/场景卸载时销毁；每帧刷新走 `RoleUIManager.updateMonsterInfo()`（面板 `update()` 返回 false 即销毁）。Node 子类没有 `node` 属性，存活校验用 `isValid(this)`，对外暴露 `isValidNode()`。
- **怪物 AI 分层**（详见 skill `cocos-monster-ai`）：MonsterManager 只管数据与生命周期（Map<Node,Monster>：生成/查询/受击/reset），`ui/core/MonsterAI` 管行为与动画（每帧 `tick`，状态存 `WeakMap<Node, State>`）。移动走运动学刚体 + linearVelocity 且 **BoxCollider2D 一律 `sensor = true`**（否则会顶开主角），「角色不能穿过怪物」由 `MoveBlocking.resolveBlockedVelocity` 手动补（已重叠的放行，否则怪贴上来把角色卡死）。**击退是唯一能推动位置的途径**（`MonsterAI.push`，技能侧 `SkillConfig.push`）。动画铁律：clip 都是 Normal，循环靠 FINISHED 续播 → 只在动作/朝向变化时 crossFade，**绝不每帧 play**，切动作前必须 `getState(name)` 守卫。引擎事实：Collider2D 夹具在 `onEnable → _callAfterStep(_init)` 才创建、一次性读 size/offset/sensor，之后再改必须 `collider.apply()`。
- **状态系统**：唯一注册表 `configs/status.ts`（`StatusId` 在 `types/status.ts`，新增状态 = 两处各加一项）；唯一入口 `StatusManager.apply(id)`（同状态重复获得 = 刷新到期时间、特效节点复用不重建）；技能来源走 `applyStatusOfSkill(skillId)` + `configs/status.skillStatusMap`（只配状态型技能），装备/VIP 来源直接 apply。图标条 `StatusIconBar`（RoleInfoBar 构造创建并注册，`RoleUIManager.updateStatuses(badges)` 重建式刷新）；身上特效挂特效层每帧跟随 owner（偏移/帧率在 `configs/effect.statusEffect`）。状态不落盘、切场景 `reset()` 清空；`has()/getRemainingSeconds()` 查询已预留但**尚未接入伤害/属性结算（描述里的格挡/减伤/加防目前只是文案）**；`SkillType.STATUS` 只是标记，`tryCast` 未按它分流（状态由技能实现自己 apply）。当前只 `skill_1010`（护体神盾→2001）接线，`1011`→2002 在 map 里配了但 onClick 仍是 `skill_1000` 占位。状态图标路径必须写全 `skill/icon/2009`（写成 `skill/2009` 静默失败）。
- **技能特效**：技能配置 `effect`（resources 图集路径，不含扩展名，如 `effect/skill/s_1002@0`）+ `effectIsOnSelf`（挂释放者还是目标，目标无效退回释放者）。统一入口 `EffectManager.play(config, caster, target, role)`，在 `SkillManager.tryCast` 校验通过后调用（不写进各技能实现）。特效节点与角色外观同口径（RAW + trim=false + 锚点居中）→ **不要给特效节点设自定义尺寸**，微调位置改 `configs/effect.selfOffset/targetOffset`。同源图集分页（`@0/@1`）由 `AnimationHelper.loadFramesFromAtlas` 用 `resources.getDirWithPath` 自动合并。
- **动画/特效速度口径**：`createClip` 里 `sample = 帧数 × speedRate` → **角色动作动画总时长 = 1 / speedRate 秒**（speedRate 即每秒循环数，见 `configs/role.defaultRoleSpeedRate`，ATTACK_NEAR=10 即 0.1 秒）。`play/playOnceWithDir/playLoopWithDir/playOnceWithFrames` 的时长参数都是**总时长秒**；只有 `playLoopWithFrames` 第 4 参是**每秒帧数**。
- **进图资源预加载**（skill `cocos-frame-animation-preload`）：帧动画一律**按目录缓存**（AnimationHelper 的 frameCache/clipCache，多节点共用同一批 clip），**禁止再逐节点各自 loadDir**（进图卡顿与"外观没加载出来"的根因）。唯一入口 `PreloadManager.preloadGame(mapSrc, role)`：地图信息 → 从 TMX 原文推导地图内 NPC/怪物外观目录 → 角色穿戴 → 并发池加载。换外观/换装配要**复用动画组件**（`AnimationHelper.useAnimation`）并 `animate.clips = []` 清旧片段。**新增一类外观（新对象组、新装备槽）必须在 PreloadManager 同步加目录推导**。引擎事实：场景 `autoReleaseAssets` 默认 false 且本工程无 release 调用 → JS 侧缓存跨场景有效。

### 数据与 UI 约定
- **物品体系**：`GOOD_TYPE`（EQUIPMENT/DRUG/MATERIAL/OTHER），装备槽位 `EQUIPMENT_TYPE` 挂在 `Equipment.slot`；物品一律按 id 引用，统一登记在 `configs/items.ts`（registerItems 按 `prefix_序号` 生成 id）；`getItem(id)` 返回浅拷贝（防运行时 count 污染配置）。新增物品先写 `configs/{drug,material,equipments}.ts` 再在 items.ts 注册。
- **使用与穿脱统一入口 `StorageManager.useGood(row, col)`**：按 GOOD_TYPE 分发（装备→`equipFromBag`、药品→`useDrug`、其余提示未开放），新类型只在此加分支。`equipFromBag` 把脱下的旧装备放回**刚腾出的原格**（格数守恒）且入槽存 `{...good}` 副本；`unequipToBag` 用 `findEmptyBagCell`，满包只提示；两者走私有 `applyEquipmentChange` 统一收尾（combatCalc → `hp = min(hp,maxHp)` → 落盘 → updateUi/外观/弹窗刷新）。可穿戴校验与文案唯一来源 `GameHelper.getEquipmentRejectReason`。**UI 侧规则不下沉**：BagGridView 只上报 `(row, col, "use"|"equip")`，BagDialog 翻译成方法；装备槽右键脱下由 RoleInfoDialog 注入。
- **掉落体系**：`MonsterConfig.drops?: DropSource`（string 引用 configs/drop 具名表或内联表，未配置走 defaultDropTable）；结算纯逻辑在 `utils/drop/DropRoller.rollDropTable`；节点与拾取在 `DropManager`（Map<Node,DropItem>），挂 Layer.DROP（相机 visibility 必须含 DROP）。怪物死亡在 `MonsterManager.hurt` 的 hp<=0 分支先 drop（取位置须在销毁前）再 destroy；点击拾取在 ScreenClickInput 中优先于怪物选中判定。
- **角色输入三分**：RoleKeyboardInput（只采集按键，暴露 isXxx getter）、RoleAppearance（布衣/武器动画与外显，FINISHED 回调 onAttackFinished）、RoleDisplay（组合体，管动作/方向/位移/攻击锁/选中目标）。新输入或外观逻辑按此归位，不要再往 RoleDisplay 堆。
- **数据读写坑**：`StorageManager.findOnlineRole()` 每次从 localStorage 反序列化出新对象 → 同一操作内必须复用同一实例（如 useDrug 里 consumeBagGood 要显式把 role 传进去，否则消耗不落盘）；批量改装备后统一 updateOnlineRole + updateUi + `RoleUIManager.refreshBag`。`updateOnlineRole` 被升级/任务等大量调用，故「每次变化都落盘」是既有安全约定。
- **长生命周期视图不得缓存角色实例（2026-10-03 战魂外显事故）**：`getRoles()` = `JSON.parse` 每次新对象，`RoleDisplay.this.role` 只是进图时的快照；弹窗（`WarSoulDialog`）改的是它自己新读的那份并落盘 → 主角组件读旧快照，勾选外显后**必须重进游戏才生效**。修法 = 刷新方法「用前重读」：`RoleDisplay.updateSoulShow()` 内部 `const role = StorageManager.findOnlineRole() ?? this.role`（同文件 `buildSkillContext` 早已是这个写法）。**判据：凡方法体内读 `this.role` 决定节点增删/外观的，都要自查是否会被外部落盘改动**——传参版（`updateOutShow(role)`/`updateHead(role)` 由 `RoleUIManager.updateRoleData` 带新对象进来）没这个问题，无参版要自己重读；升级路径尤其要注意（弹窗闭包里的 role 在 `upgradeSoul` 之后也已过期）。
- **资源缺口清单**：武器 `out/005` 缺（weapon_5 `out: ""`，引擎侧空串=隐藏武器节点，PreloadManager 跳过）、`in/021` 缺（weapon_21 `in: ""`）；衣服 011 缺 out、012/013 缺 in；武器每方向 8 帧只有前 4 帧有内容（后 4 为占位）；怪物素材包本身没有攻击动作。
- **旧存档字段补齐唯一入口 `StorageManager.ensureRoleDefaults(role)`**（在 `findOnlineRole` 内调用）：凡「新增角色字段 / 配置数组扩项」（mp/maxMp、快捷键 4→6）都写这里，按初始配置对齐并保留玩家已改的值。**不要只在 Game.start 补**——`changeShortcutKey` 等内部会重新 `findOnlineRole()`，不补齐就 `undefined.skillId` 崩。
- **常驻 HUD 布局与图片来源唯一入口 `configs/hudLayout.ts`**：位置/尺寸/图片来源集中在此，组件与 GameUiHelper 只引用不硬编码。图片按 resources 文件夹收敛成取图函数（`commonImage/mainImage/moneyImage/bottomNavImage/smallMapImage/tipsImage`、`avatarImage(occupation, sex)`），具名图片登记在 `hudImages`。布局块按组件分：roleInfoBarLayout / bottomBarLayout / smallMapLayout / monsterInfoPanelLayout / tipsLayout。模块自己的 config 只留玩法参数（smallMap 只留 viewRadius/点位半径颜色/refreshInterval；autoBattle 只留节奏）。零件内部默认值（图标原尺寸、label 相对偏移）留在 GameUiHelper。弹窗等临时界面由各自组件管理。
- **快捷键槽数量唯一来源** `types/role.ShortcutKeys`（49~54）与 `configs/role.initialShortcutKeys`。`ShortcutKeyBar.slots` 是「按键码→槽」显式映射（类型强制覆盖全部按键码，扩键即编译报错提醒）；容器宽度 = n×40 + (n-1)×6（6 格 270），位置须避开血球（右缘 -375）与功能按键区（左缘 -46.5），现为 (-210,-9)；`SkillShortcutSettingDialog` 弹窗/选项行宽度同步放大（370/350）。
- **点 UI 不影响世界操作**（skill `cocos-mouse-button-input`）：全局 `input.on(MOUSE_UP/TOUCH_*)` **不会**因点中 UI 而自动屏蔽（dispatcher 优先级 UI 1 → GLOBAL 0，且 Button 只注册 TOUCH_*，鼠标 MOUSE_UP 会漏到全局）。世界点击入口必须自查 `LayerManager.isPointOnUi(screenPoint)`（`utils/input/UiHit`，递归 UI 层子树、子节点倒序、activeInHierarchy 过滤），命中即整体 return；不该拦点击的装饰（飘字/升级特效）用 `markClickThrough(node)` 标记穿透（WeakSet）。
- **resources 资源引用的判定口径**（完整做法见 skill `cocos-asset-usage-audit`）：这工程的资源**全部靠代码字符串引用，没有任何场景/prefab 用 uuid 引用**。要点：判定要覆盖路径字面量/模板前缀、图集分页（`x@0` 同基名合并、plist 与 png 成对）、`loadDir` 目录、tmx→tsx→`<image source>`；**按名取图的目录（common/main/money/bottom-nav-bar/small-map/avatars/tips）不能用 `dir/${name}` 模板判**（对每个文件都成立 = 等于没判），只能按代码里被点名的具体名字判，且裸名匹配会被**节点名**（`new Node("hp_bar")`）与**数字字符串**（"1"）污染。未引用资源已归档 `assets/resources/unused/`（连同 .meta、原目录结构保留），清单与还原命令见工程根 `resources-分组报告.md`。

### 屏幕适配与常驻 HUD 贴边（2026-10-03 起）
- **适配策略 = 铺满窗口（NO_BORDER）**：`applyScreenPolicy()`（`ui/utils/layout/ScreenLayout`）在 Login / RoleSelector / Loading / Game 四个场景 start 各调一次（幂等）；项目设置里的 1624×750 只作设计分辨率底数。NO_BORDER 下 scale = max(sw/dw, sh/dh) → **一轴等于设计尺寸、另一轴更小（= 被裁掉的量）**：窗口偏窄（1024×768）→ 可见 1000×750（左右各裁）；窗口偏宽（2560×1080）→ 可见 1624×685（上下各裁）；裁剪对设计中心对称 → **屏幕中心恒为原点**。推论：`UiHelper.getScreenSize()`（返回设计分辨率）给全屏图/遮罩设尺寸仍能铺满，可放心沿用。
- **❗`view.getVisibleSize()` 在 NO_BORDER 下恒返回设计分辨率，不能用它算可见区**（2026-10-03 事故根因）：引擎实现是「把**视口**放大到超出画布、让画布裁掉溢出部分」（`NoBorder.apply`：`contentW/H` 取大的一轴，`_buildResult` 得到负偏移的 viewport），于是 `_visibleRect` 被反算回 designW×designH。症状：窗口变窄后左上/右上两块 HUD 被切掉（1024×768 时越界 293/310px），而`getVisibleSize()` 自己看不出异常。**真实可见区 = `screen.windowSize.width|height / view.getScaleX|getScaleY()`**，与引擎相机口径完全一致（`Canvas._onResizeCamera` 里 `orthoHeight = screen.windowSize.height / view.getScaleY() / 2`，相机 ortho 半宽 = orthoHeight × 画布宽高比 = `windowW / (2·scale)`，两式在 NO_BORDER 下 scaleX≡scaleY 故自洽）。`ScreenLayout.getVisibleSize()` 已按此实现（极端时空值退回 `view.getVisibleSize()`）。
- **`Canvas` 在窗口尺寸变化时会把相机拽走**：`_onResizeCamera`（由 `view.on('canvas-resize')` 触发，且在 `_updateAdaptResult` 内**先于**业务监听执行）会 `camera.orthoHeight = 新可见高/2` 并 `camera.node.setWorldPosition(Canvas 节点世界坐标, 1000)`。本工程相机/UI 层由 `LayerManager.move(主角坐标)` 对齐（**只在主角真的移动/传送时调用，不是每帧**）→ 尺寸变化后必须手动补一次 `LayerManager.move(roleDisplay.getWorldPosition())`，否则地图视野跳到 Canvas 节点位置、UI 也整体错位（见 `Game.start` 的重排回调）。
- **常驻 HUD 三区域（左上角色信息栏 / 右上小地图 / 底部栏）位置不写死坐标**：`configs/hudLayout` 里每块给 `anchor: { edge: "top-left"|"top-right"|"bottom-center", marginX, marginY }`（bottom-center 的 marginY = 区块中心到屏幕下边缘，因为背景下沿本就溢出屏幕），位置由 `getAnchoredPosition(blockSize, getVisibleSize(), edge, marginX, marginY)` 实时算出；组件各自暴露 `applyAnchorPosition()`（RoleInfoBar / BottomBar / SmallMap），GameUiHelper 侧对应 `setBottomBarPosition` / `setSmallMapPosition`（与 addChild 背景的一次性 `apply*BodyStyle` 拆开，避免重排时重复挂背景）。注意区块**声明尺寸小于视觉范围**：状态图标条比信息栏底边低 23px、小地图名称条比顶边高 2.5px（靠 margin 吸收，改 margin 时要一并考虑）。
- **重排触发点**：`Game.start` 里 `onWindowResize(...)`（内部 `screen.on("window-resize")`，3.8 起 `view.setResizeCallback` 已废弃；`screen.windowSize` 为**物理像素**且事件派发前已更新，可直接读）→ 先补 `LayerManager.move(主角)`，再依次调用三个 `applyAnchorPosition()`；`Game.onDestroy` 必须显式取消监听（screen 是单例，不随节点销毁而回收）。
- 坑：`Node.setPosition` **不接受 Vec2**（只吃 Vec3 或 x,y,z 三个数字）→ 计算结果要 `.x/.y` 拆开传。
- 遗留（未做，按需再扩）：`MonsterInfoPanel(0,330)` 与屏幕中间提示仍是固定坐标，超宽窗口（如 21:9，可见高 685）怪物面板会被顶出屏幕；底部栏宽 1100 在 4:3 窗口（可见宽 1000）会左右溢出——要么给这两处也加贴边，要么给底部栏加按可见宽度的缩放/夹取。

### UI 布局 / 尺寸 / 图片地址的集中约定（2026-10-03 结构重构）
- **唯一入口 = `configs/hudLayout.ts`，但它现在只是 barrel**（`export * from "./layout/xxx"`），实际内容按区域拆在 **`configs/layout/`**：
  `hud.ts`（常驻 HUD 三区域 + 怪物信息面板 + 屏幕提示 + 角色身上挂件 roleShowLayout）、
  `dialogs.ts`（通用弹窗框 dialogFrame + 7 个弹窗 + 物品详情）、
  `panels.ts`（装备槽分组 / 背包网格 / 属性列表 / 内观）、
  `scenes.ts`（登录 / 选角 / 加载）、
  `images.ts`（取图函数 + 具名图片表 **uiImages**）、
  `sizes.ts`（跨界面公共尺寸 **uiSize**）。
  好处：组件里 `import { xxx } from "configs/hudLayout"` 的旧路径全部照旧可用（barrel 兼容），新增内容只往 layout/* 加。
- **重命名不带别名**：`hudImages → uiImages`、`hudSize → uiSize`。故意不留旧名别名，让 tsc 一次性把所有引用点暴露出来（`export *` 出来的名字如果留别名，漏改的地方不会报错）。改名时同步改 7 个文件的 import（GameUiHelper / AutoBattleTips / AutoFightButton / RoleInfoBar / RoleMpOrb / SmallMap）。
- **组件层禁止出现坐标/尺寸/图片路径**（用户诉求的硬规则）：判断口径 —— 组件里只允许出现「由配置派生的计算」（如 `layout.currencyBar.size.width / CURRENCY_COUNT`、`new Vec2(0, layout.content.top)`）与**玩法数学**（碰撞盒 40×70、速度向量、AI 方向）；凡是给零件传的绝对坐标/尺寸都要来自配置。
- **零件内部微偏移仍留在 GameUiHelper**（约 125 处 `new Vec2/new Size`）：角色头顶信息栏、伤害/经验飘字、怪物头顶名称血条、技能列表行内部、物品详情行距、掉落物尺寸、调试碰撞范围等。这类「零件自己的排版细节」不进配置，否则配置会变成垃圾桶；要改就改零件，或先把它提升为「界面级几何」再进配置。
- **配置文件的依赖方向**：`configs/layout/*` 只许 import `cc`（Size/Vec2/Color）与同目录的其他 layout 文件；**不许 import ui/**（否则破坏「configs 不依赖 UI」）。需要 UI 侧的类型（如 `EquipmentSlotSide`）时，配置里写字面量联合类型 `["left","right","bottom"] as ("left"|"right"|"bottom")[]`，组件侧再赋给同名 type。
- **零件默认参数可以引用配置**：`static createDialog(name, title, position = new Vec2(), size = dialogFrame.size)`——把「隐式默认值」也变成可手调的（原来 MapTeleport/Bag/RoleInfo 三个弹窗都靠 GameUiHelper 里的 600×500 缺省值，现在缺省值在 dialogFrame）。
- **踩过的小坑**：① 拆 barrel 后 `export *` 有重名会直接编译报错（本次靠命名区分：`hudSize→uiSize` 而不是再加一个 `size`）；② 改完要跑 `tsconfig.unused.json`，搬走常量后组件里的 `Size/Vec2/Color` 导入会变死导入（本次清理了 5 处）；③ 新增目录/文件必须补 `.meta`（directory + typescript 两种模板，见「新增文件」小节）；④ **收尾必须按「资源目录前缀」逐个 grep 扫图片路径**——本次只按 `new Vec2/new Size` 统计，漏掉了「路径写在函数第 2 个参数」的调用：`createGoodDetailDialog` 里 `createSprite("logo", "logo", new Vec2(), new Size(220,120))`（图在 resources 根目录、路径就是裸 `"logo"`，任何前缀正则都扫不到）。已补成 `goodDetailLayout.footerLogo = { image: uiImages.gameLogo, size: new Size(220,120) }`。前缀列表要含根目录裸名。
- **UI 信息的三个去处（别再混）**：界面级布局 → `configs/layout/*`；图片/字体地址 → `layout/images.ts`（uiImages）；玩法数据自带图标（装备/技能/怪物/NPC/状态） → 各自的 configs 数据表，不往 layout 搬。

### 等级 / 怪物 / 战魂 成长曲线（2026-10-03 起）
- **唯一来源 = `configs/growth.ts`**。形态是「分段线性」：每 10 级一档（6 档覆盖 1~60），每档只写两个数 `start`（该档第 1 级的值）与 `perLevel`（档内每级增量）。档内线性好算好调，档间靠 perLevel 突增制造「跳档」的推进感（10 级升 11 级时每级涨的血是之前的 3 倍多）。
- **三条设计目标（改曲线前先看）**：① 打怪节奏 = 角色裸属性普攻同级普通怪正好 5.5 刀（普攻冷却 1 秒 → 5~6 秒一只，实测全等级区间 5.42~5.57 刀）；② 生存节奏 = 角色裸血能扛同级怪 8~13 刀（怪普攻 2 秒一次 → 16~26 秒），前期脆后期肉；③ 升级节奏 = 每级打 10~350 只同级怪，1→60 级 7655 只 ≈ 11.7 小时（1→30 级 1374 只 ≈ 2.1 小时）。
- **关键机制：怪物血量不是直接拍的，而是反推的**。`monsterStats(id)` 先取「同等级角色」的攻击/防御上限当基准，再算 `角色单次普攻平均伤害 = (1+minRate)/2 × (角色攻击上限 − 怪防御上限)`，最后 `怪HP = 该值 × monsterBalance.hitCount(5.5) × 定位系数.hp`。好处：以后改角色曲线，怪的耐打程度自动保持同一手感，不会出现「改了等级曲线结果怪全变豆腐」。
- **三个数字锚点（1 级 → 60 级）**：角色裸属性 maxHp `100 → 98,720`、攻击上限 `20 → 12,540`（三攻同值）、防御上限 `6 → 3,762`（三防同值，恒为攻击的约 30%）；攻击/血量比从 20% 一路降到 12.7%（这是「后期更肉」的来源）。属性区间统一 `[上限×0.7, 上限]`（`attributeRange.minRate`），比旧配置的 `[25%, 100%]` 稳，不会一刀打空。
- **故意做了职业中立**：三项攻击同值、三项防御同值。理由：角色只用自己职业那一项攻击，怪也大多只有物攻，把三项拉开只会制造无意义的职业强弱差；职业差异留给装备与技能倍率。旧配置的 0.10/0.08/0.06 与 0.05/0.04/0.03 是占位产物。
- **怪物等级是「数据字段」，key 只做关联**（2026-10-03 二次改造，原「按编号推等级」已废弃）：`monster.ts` 顶部是 `const monsterData: MonsterData[]`，每条写 `{ key, level, tier?, …表现字段 }`，文件末尾统一 `monsters.set(key, { ...monsterStats(level, tier), ...rest })` 建 Map。原先的 `monsterLevelLadder` / `getMonsterLevel(id)` / `getMonsterTier(id)` 三个「用 key 猜等级」的函数**已全部删除**——key 一旦换成字符串（如 "goblin_chief"）那种写法立刻失效。
- **定位倍率 `monsterTierScale`**：normal ×1 / elite 血×3 攻防×1.3 / boss 血×8 攻×1.5 防×1.4（BOSS 同级要打 44 刀）；定位由条目里的 `tier` 字段决定，也不再由 key 推断。
- **`monster.ts` 条目只写「不能算的东西」**：key（唯一、任意字符串）+ level + tier? + 表现字段（图标/外观/label/移速/AI/选中区域/动作时长）。六项攻防与 maxHp 由 `monsterStats(level, tier)` 按等级生成；条目里若写了同名字段就**覆盖**生成值（法系怪补 `magicAttack`、特例怪补 `maxHp` 都走这条路）。想调强弱只改那条的 `level`，想改定位只改 `tier`，一个数字一处。
- **改造校验手法（值得复用）**：① 改之前先用 `node --experimental-strip-types` 跑旧实现，把 220 只怪的 `(level, tier, 七项属性)` 导出成基线 JSON；改完逐条比 —— 本次 **220/220 零差异**（含 21 只 BOSS 的 boss 倍率没有丢）。② 再把 `monster.ts` 复制到 `/tmp/mcheck/`，用桩替换 `cc`（导出 Size/Vec2）与 `ACTION`（Proxy 返回键名），就能直接 `import` 真实配置，验证构建出的 Map：size=220、必填字段无缺失、`key`/`tier` 没有泄漏进最终配置对象。
  踩坑：`--experimental-strip-types` **不支持 enum 与构造函数参数属性**（`constructor(public x = 0)`），桩文件要写成显式字段赋值；`MonsterData` 若直接 `extends MonsterConfig` 会要求条目写全部战斗属性，须写成 `Omit<MonsterConfig, keyof BattleAttributes> & Partial<BattleAttributes> & { key; tier? }`。
- **经验与击杀数绑死**：`levelMap[level].exp = getLevelKills(level) × (level+1) × expGain.expPerLevel(5)`。左边来自 `roleGrowth.killsPerLevel`（「每级要打几只」），右边正是 `getKillExp` 算同级怪击杀经验的公式，所以「每级要打几只」与实际拿到的经验永远对得上，改一个数两边同步。旧 exp 曲线的问题在高段：60 级那级要 3620 万经验 = 118,700 只同级怪，现在是 106,750 经验 = 350 只。
- **战魂不再自己拍数值**：`soulGrowth` 把「阶」线性映射到一个**等效角色等级**（1 阶≈2 级、37 阶≈60 级），属性 = 该等级角色裸属性 × `rate(0.5)` × 系列系数（灵体 1 / 兽魂 1.15 / 魔神 1.35）。实测满阶 = 角色 60 级裸属性的 68%，逐阶单调递增，20→21 阶因换系列有小跳档。系列系数从原来的 1/2/4 降到 1/1.15/1.35——原来的 ×2 跳档在新曲线下会造成属性断层。
- **顺手改的三处**：① `StorageManager.onlineRoleGetExp` 里的等级上限原来是硬编码 `30`，现改为 `growth.roleMaxLevel`；② `Role` 构造函数 `this.physicalAttack = levelMap.get(1).physicalAttack` 是**直接引用配置数组**（运行时改动会污染配置表），改为 `[...]` 复制；③ 给 200~220 号 BOSS 补了 `drops: "boss"`（原来它们走默认掉落表）。
- **药品重新定标**：`drug.ts` 的回复量按新血量曲线重算（小药 60 ≈ 1 级血的 60%、中药 250、大药 900）。**注意只有 1/5/10 三档**，`resources/item` 里 fs_5~fs_7 / sz_4~sz_7 / tz_3~tz_7 的高级药图标还没用上——掉落表目前不是按怪物等级分档的，等做了等级分档再补 21/31/41/51 级药。
- **装备没动**（用户要自己整理）。曲线是按「角色裸属性」定标的，所以装备整体应该控制在**同级角色裸属性的 30%~100%** 区间：太低没存在感，太高会让不穿装备打不动、穿满一刀秒。现有 36 件装备里有数值的只有 7 件（`cloth_1` 给了 3000 血 + 三攻 100 + 三防 50，在 1 级角色满血 100 的背景下是压倒性的）。
- **已知待处理**：地图 2（10 级图）的 monster 对象组挂的是 200~220 号 BOSS，等级 lv10~60，跨度太大——10 级玩家进图会撞上 lv60 的怪。现在等级是明文数据，直接改那 21 条的 `level`（或把 `.tmx` 的 monster 组换成普通怪 key）都能解决。战魂升级消耗仍是 `300 × 阶²`（满阶 41 万绑定元宝），与现有绑定元宝来源（初始 1 万）对不上，属于经济线待做。
- **校验手法**：`node --experimental-strip-types` 直接跑 `configs/growth.ts`（把类型 import 写成 `import type` 就能脱离 cc 运行），脚本里遍历 1~60 级打印「角色属性 / 同级怪属性 / 击杀刀数 / 能扛刀数 / 每级击杀数 / 全局总时长」并断言单调性——**改曲线后一定要跑一遍**，比肉眼看表格靠谱。

### 装备成长（2026-10-03 晚，`configs/equipments.ts` 重构）
- **形态与 monster.ts 同构**：7 个 `new Map<string, Equipment>([ [key, {...}], ... ])` 全部改成「数据数组 + 统一注入」——
  `const clothesData: EquipmentData[] = [{ key, level, ...表现字段 }]` + `export const clothes = buildEquipmentMap(clothesData)`。
  条目里**只写不能算的东西**（key / level / slot / 图标 / 内外观 / 前后缀 / 标签），战斗属性由 `equipmentStats(level, slot)` 生成；
  条目里若写了同名字段就覆盖生成值。文件 1468 → 1162 行。
- **`level` 是双重语义**：既是**穿戴需求等级**（`GameHelper.getEquipmentRejectReason` 会挡「需要等级 N」），又是**定强入口**。
  所以排等级时要想清楚「这件装备应该在什么等级被拿到」。
- **等级按名称强弱排**（用户选的方案）：武器 20 件 `1 6 10 14 18 22 26 29 32 35 38 41 44 47 50 52 54 56 58 60`
  （`weapon_1` 定海神针是「送给新手的第一件武器」= 1，`weapon_20` 焚世巨剑 = 60；`weapon_18` 紫翼神冠刃是 `weapon_14` 紫翼金冠刃的「真正形态」故排在它之后）；
  衣服 12 件 `1 10 16 22 28 34 38 42 46 50 55 60`；5 件「新手X」配件全 lv1。
- **属性分配（`growth.equipmentSlotShare`，每列合计 100）**：武器只给攻击（52%）、衣服是血防主源（血 30 / 防 30）、
  项链/戒指偏攻击（攻 12 / 血 12 / 防 9）、头盔/腰带/鞋子血量略高于防御。**肩胛/护腕/护腿/饰品留了 0 权重位**（补装备时从上面匀，保持每列 100）。
- **总量 = `equipmentGrowth.setPowerRate`（用户要 200%）**：公式 `数值 = 同级角色裸属性上限 × (部位权重/100) × setPowerRate`。
  实测「全 7 部位同级装备合计 ÷ 裸属性上限」= 血/攻/防 **200%**（30 级以上精确，低等级因取整 ±20%）。
- **数值是固定值** `[v, v]`（装备确定性，与角色等级属性的浮动区间区分）；有份额但算出来 <1 时保底 1。
- 顺手修显示：`GameUiHelper.formatAttributeValue`（min=max 只显示一个数，区间才显示「a - b」），装备行与角色属性行统一走它。

#### ⚠ 两个必须知道的问题（都已量化）
1. **配件内容缺口**：头盔/腰带/鞋子/项链/戒指**各只有 1 件 lv1「新手X」**，所以等级越高「全套」越达不到 200%
   ——实测玩家 20 级只能拿到 血+60%/攻+134%/防+89%，60 级 血+60%/攻+146%/防+90%。要补高档配件才吃满权重。
2. **装备 +200% 打破了怪物的锚点**（怪物是按角色**裸属性** 5.5 刀定标的）。实测（精确期望值）：

   | 等级 | 裸装 击杀/能扛 | 满装 击杀 | 满装 每刀吃 | 满装 能扛 |
   |---|---|---|---|---|
   | 1 | 5.4 刀 / 8.3 刀 | 1.23 刀 | 0.5（原 12） | 630 刀 |
   | 30 | 5.5 刀 / 9.8 刀 | 1.26 刀 | 16（原 286） | 525 刀 |
   | 60 | 5.5 刀 / 13.2 刀 | 1.26 刀 | 454（原 7462） | 653 刀 |

   **根因是「防御是减法」**：角色裸防御只有同级怪攻击的 **30%**，所以防御翻 3 倍后（10157）已接近怪物攻击上限（12540），
   怪每刀只造成原来的 **6%** 伤害。攻击翻 3 倍则让击杀从 5.5 刀降到 1.26 刀。
   → 结论：**「怪物血量锚在裸属性 5.5 刀」与「装备 +200%」在数学上不共存**，必须选一个锚点：
   - A 保持现状：满装割草（1.26 刀）+ 怪几乎打不动你；
   - B 怪物也按满装定标（`monsterBalance` 加 `referencePowerRate` = setPowerRate）：满装回到 5.5 刀手感，但裸装会打不动怪；
   - C 降装备总量（`setPowerRate` 0.6 左右）：满装约 2.7 刀、能扛约 30 刀，裸装保持原样。
- **另一种缓解思路**（如果保留 200%）：装备的**防御份额应该显著调小**——因为怪的防御只有角色的 30%、而怪的攻击是角色的 100%，
  减法公式下防御的边际收益远高于攻击。把防御总量从 +200% 降到 +60% 左右，生存就只膨胀 2 倍而不是 49 倍。

**收口决定（2026-10-03 用户拍板）：选 A「保持现状」** —— 怪物不动、装备 200%。
即接受「满装同级怪 1.3 刀、每刀只吃 6% 伤害」这个后果；装备 = 爽感来源而非必需品。
若以后要改，四个方案的实测数字（满装 / 裸装）：

| 方案 | 满装 击杀 | 满装 能扛 | 裸装 击杀 | 裸装 能扛 |
|---|---|---|---|---|
| A 现状（怪按裸属性） | 1.3 刀 | 170~650 刀 | 5.5 刀 | 13.2 刀 |
| B 怪也按满装定标（`monsterBalance` 里让怪乘 1+setPowerRate） | 4.7 刀 | 13.9 刀 | 97 刀 | 3.4 刀 |
| C 装备压到 60% | 2.7 刀 | 30 刀 | 5.5 刀 | 13.2 刀 |
| D 怪按半套定标 | 2.8 刀 | 28 刀 | 19 刀 | 5.4 刀 |

B 几乎完全还原原设计手感（5.5 / 13.2），代价是裸装打不动怪；C/D 是折中。

### 配置形态统一 + 每怪专属掉落（2026-10-03 深夜）
- **形态定论**：configs 下所有「列表」类配置统一 **「数组为源 + 尾部建 Map」** —— 数组负责书写/顺序/可读，Map 负责 O(1) 按 key 查。此前 monster/equipments 已是此形，本轮把还在裸 `.set()` 的迁齐：
  `npc.ts`（npcData + npcs）、`map.ts`（mapData + maps）、`skill.ts`（skillData + skills，12 条）、`drop.ts`（dropData + dropTables，3 条）、`equipments.ts` 的 equipmentSlots（13 条）。
  导出名全部不变 → 消费方零改动；类型侧 `types/map.ts` 新增 `NpcData` / `MapData`（`{id} & 原接口`）。
  **不是列表的小映射表保持原样**：oeccupationSkills / goodShowAttributes / combatCalc / cursor 颜色 / animation 生成的 Map / levelMap（程序生成）/ items（聚合构建器）。npc.ts 顺带删掉被覆盖的死数据「天界飞升」8001/8002（原文件 set 了两次，Map 后者覆盖前者，行为不变）。
- **每怪专属掉落**（用户：掉落列表都是数组、每件物品单独配权重）：
  - `types/drop.ts`：`DropSource = string | DropTable | DropEntry[]`（数组 = 内联条目池）。
  - `configs/drop.monsterDrops(level, tier): DropEntry[]` —— 每只怪一份**条目数组**，按等级分档：
    药品 ≤20 小药 / 21-40 中药 / 41+ 大药（蓝药只有两档，21+ 用中药）；兽皮/粗布/药草常掉，铁矿 lv10 起，太阳水+宝石 lv21 起（带 chance）；
    装备 `getNearestEquipmentId(slot, level)`（equipments.ts 新增：该部位 level≤目标里最高的那件，全超纲取最低）——boss 武器/衣服 60%、戒指 40%，elite 武器/头盔 12%，normal 鞋子 3%。
  - 抽取次数独立成 `MonsterConfig.dropPicks`（默认 1/2/3 按 tier，`monsterDropPicks`）；`DropManager.drop(source, position, picks?)` 第三参只对数组形态生效（具名表用自己的 picks）。
  - `monster.ts` builder 剥掉原有 23 处共享表引用（20 boss / 2 common / 1 elite），注入 `drops: drops ?? monsterDrops(level, tier)`；条目写 drops/dropPicks 即完全覆盖。
- **校验方法（可复用）**：node strip-types 跑不了带 enum/混写 import 的真实配置 → 用 **tsc 编 CommonJS 到 /tmp**（tsconfig：include 只放 configs/types 相关文件 + ambient `declare module "cc"` + node_modules/cc 运行时桩）后 require 真实配置跑断言：
  **220/220 drops 为数组、goodId 全部在 items 里、weight>0、dropPicks ∈ {1,2,3}**；monsterDrops(1/35/60) 三档抽样打印核对（boss 60 级抽到 weapon_20/cloth_32/ring_1）。全工程 tsc 0 错，sleep 25s 回写复检过。
