
## 项目约定（Cocos Creator 3.8.7 游戏 olua）
- 组件一律 `export default class X extends Node`（RoleAvatar 写法）：构造函数里建 UI，不导出预建单例实例，哪里用哪里 `new`；文件/类名不带 Frame 后缀。跨组件共享用 RoleUIManager 注册表或构造注入（Game.ts 是组合根）。
- 管理器（core/ 5 个）与 helpers（3 个）全部是静态类：`export default class X` 全 static 成员，直接 `import X from "..."` 后 `X.method()` 使用，不实例化；弹窗为普通 class，实例由 BottomBar/npc 点击处创建。
- cc.Node 子类注意：字段名不能叫 up/right（与 Node 内置属性冲突）；`this` 传给 Node 参数需 `this as Node` 断言（isChildOf 型变）。
- 分层：ui/core（全局管理器）、ui/components（通用组件 + map/ 地图类 + role/ 角色类 + dialogs/ 弹窗）、ui/controllers（场景 Component 控制器）、ui/helpers（UI 工厂，仅 3 个）、ui/utils（纯工具）、assets/entities（运行时实体，如 Role）、assets/skills（技能行为实现）、configs（纯静态数据，按域一文件）、types（纯类型，按域一文件）。configs 与 types 不互相依赖 UI 层。
- helpers 仅 3 个，不要新建更多：UiHelper（Cocos 基础组件封装，只被 GameUiHelper 引用）、GameUiHelper（UI 零件库）、AnimationHelper（帧动画加载/切割/播放）。新 UI 方法按语义归入对应类；类内用 //#region 分块。规则：生成 UI 样式的代码只允许出现在 UiHelper/GameUiHelper 中；**GameUiHelper 只做单个可复用零件（如 createCurrencyItem/createCombatPower/createEquipmentSlot），不做整页视图生成，拼接组装由各组件自己完成**（需要数据刷新的零件返回 {node, xxxLabel} 形式）。物理碰撞体（RigidBody2D/BoxCollider2D）与 LayerManager 图层容器不算 UI 样式。
- 移动 assets 下文件必须连同 .meta 一起移动（保留 UUID，场景引用依赖它）；.meta 被 .gitignore 忽略（风险）。
