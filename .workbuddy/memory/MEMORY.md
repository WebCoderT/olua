
## 项目约定（Cocos Creator 3.8.7 游戏 olua）
- 组件一律 `export default class X extends Node`（RoleAvatar 写法）：构造函数里建 UI，不导出预建单例实例，哪里用哪里 `new`；文件/类名不带 Frame 后缀。跨组件共享用 RoleUIManager 注册表或构造注入（Game.ts 是组合根）。
- 管理器（core/ 5 个）与 helpers（3 个）全部是静态类：`export default class X` 全 static 成员，直接 `import X from "..."` 后 `X.method()` 使用，不实例化；弹窗为普通 class，实例由 BottomBar/npc 点击处创建。
- cc.Node 子类注意：字段名不能叫 up/right（与 Node 内置属性冲突）；`this` 传给 Node 参数需 `this as Node` 断言（isChildOf 型变）。
- 分层：ui/core（全局管理器）、ui/components（通用组件 + map/ 地图类 + role/ 角色类 + dialogs/ 弹窗）、ui/controllers（场景 Component 控制器）、ui/helpers（UI 工厂，仅 3 个）、ui/utils（纯工具）、configs/types 独立。
- helpers 仅 3 个，不要新建更多：UiHelper（Cocos 基础组件封装）、GameUiHelper（游戏 UI 样式固化）、AnimationHelper（帧动画加载/切割/播放）。新 UI 方法按语义归入对应类；类内用 //#region 分块。
- 移动 assets 下文件必须连同 .meta 一起移动（保留 UUID，场景引用依赖它）；.meta 被 .gitignore 忽略（风险）。
