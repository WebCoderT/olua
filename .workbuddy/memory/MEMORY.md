
## 项目约定（Cocos Creator 3.8.7 游戏 olua）
- 组件一律 `export default class X extends Node`（RoleAvatar 写法）：构造函数里建 UI，不导出预建单例实例，哪里用哪里 `new`；文件/类名不带 Frame 后缀。跨组件共享用 RoleUIManager 注册表或构造注入（Game.ts 是组合根）。
- 管理器（core/ 5 个）与 helpers（3 个）全部是静态类：`export default class X` 全 static 成员，直接 `import X from "..."` 后 `X.method()` 使用，不实例化；弹窗为普通 class，实例由 BottomBar/npc 点击处创建。
- cc.Node 子类注意：字段名不能叫 up/right（与 Node 内置属性冲突）；`this` 传给 Node 参数需 `this as Node` 断言（isChildOf 型变）。
- 分层：ui/core（全局管理器）、ui/components（通用组件 + map/ 地图类 + role/ 角色类 + dialogs/ 弹窗）、ui/controllers（场景 Component 控制器）、ui/helpers（UI 工厂，仅 3 个）、ui/utils（纯工具）、assets/entities（运行时实体，如 Role）、assets/skills（技能行为实现）、configs（纯静态数据，按域一文件）、types（纯类型，按域一文件）。configs 与 types 不互相依赖 UI 层。
- helpers 仅 3 个，不要新建更多：UiHelper（Cocos 基础组件封装，只被 GameUiHelper 引用）、GameUiHelper（UI 零件库）、AnimationHelper（帧动画加载/切割/播放）。新 UI 方法按语义归入对应类；类内用 //#region 分块。规则：生成 UI 样式的代码只允许出现在 UiHelper/GameUiHelper 中；**GameUiHelper 只做单个可复用零件（如 createCurrencyItem/createCombatPower/createEquipmentSlot），不做整页视图生成，拼接组装由各组件自己完成**（需要数据刷新的零件返回 {node, xxxLabel} 形式）。物理碰撞体（RigidBody2D/BoxCollider2D）与 LayerManager 图层容器不算 UI 样式。
- 移动 assets 下文件必须连同 .meta 一起移动（保留 UUID，场景引用依赖它）；.meta 被 .gitignore 忽略（风险）。
- 场景/地图切换一律走 SceneManager.loadScene → Loading 过渡场景（一行文字显示百分比）：场景预加载 0~90%，进 Game 前预载当前地图 TiledMapAsset 90~100%，完成后才进入目标场景；地图切换=保存 onMap 后重进 Game 场景（不存在原地换图）。给场景挂脚本组件：手写脚本 .meta uuid，scene JSON 用压缩 uuid（前 5 hex + 27 hex→108bit base64 18 字符）。
- 静态类跨场景持有节点（LayerManager 图层容器）时必须在 initLayer/进场景时重建（旧场景销毁会连带销毁静态节点，否则黑屏）；相机等由 Game.start 重新注入。全局 input 监听（RoleDisplay 键盘、ScreenClick 鼠标）必须随节点销毁移除（NODE_DESTROYED once / Game.onDestroy），否则重进场景叠加残留。
- GameMap 自身即地图节点：init() 先 await 地图 TiledMapAsset 加载完成，再 addComponent(TiledMap) 挂到自身（组件挂上即地图已就绪，不会黑屏）；不通过 helper 创建地图子节点（UiHelper.createMap/GameUiHelper.createTiledMap 已删）。
- 技能系统：触发统一入口 SkillManager.release(skillId)（校验/冷却/单体目标自动补全/距离校验）；技能实现签名 (context: SkillContext) => void，只依赖上下文不反查全局；上下文由 RoleDisplay.buildSkillContext() 组装、Game.ts 组合根 setContextProvider 注入；受击结算走 Monsters.hurt；伤害计算走 BattleHelper.calcSkillDamage。键盘/鼠标类全局事件必须挂 input 单例（节点上监听不到 KEY_DOWN）。
