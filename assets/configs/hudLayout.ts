/**
 * UI 布局、尺寸与图片来源的**统一入口**（barrel）
 *
 * 所有界面的位置、尺寸、图片/字体地址都集中在这里（具体内容按区域拆在 configs/layout/ 下）：
 * - layout/hud.ts      常驻 HUD（角色信息栏 / 底部栏 / 小地图 / 怪物信息面板 / 屏幕提示）+ 角色身上的挂件
 * - layout/dialogs.ts  各类弹窗（通用弹窗框、战魂、大陆传送官、角色信息、背包、技能、快捷键设置、死亡、物品详情）
 * - layout/panels.ts   角色信息弹窗内的面板零件（装备槽分组 / 背包网格 / 属性列表 / 内观）
 * - layout/borders.ts  装备边框显示（外框尺寸与帧率；素材与前后缀映射见 configs/border）
 * - layout/backgrounds.ts 装备详情背景显示（帧率；素材与前后缀映射见 configs/background）
 * - layout/lights.ts   装备光柱显示（尺寸与帧率；素材与前缀映射见 configs/light）
 * - layout/scenes.ts   场景界面（登录 / 选角 / 加载）
 * - layout/images.ts   图片与字体地址（取图函数 + 具名图片表 uiImages）
 * - layout/sizes.ts    跨界面复用的尺寸与字号（uiSize）
 * - layout/theme.ts    通用零件样式（空节点调试边框 / 输入框占位色 / 飘字配色与时长）
 *
 * 约定：组件与零件只引用这里的值，**不在组件里写坐标、尺寸或图片路径**；
 * 要调界面先改这里（改数据不生效的另说，见各块的注释）。
 *
 * 兼容说明：本文件原为「常驻 HUD 布局 + 图片来源」的实际内容，现改为统一导出入口，
 * 因此原有的 `import { xxx } from "configs/hudLayout"` 全部照旧可用。
 * （原 `hudImages` / `hudSize` 已更名为 `uiImages` / `uiSize`：前者不再只管 HUD 的图，
 *   后者是跨界面公共尺寸；旧名字不再保留别名，避免两套名字并存。）
 */

export * from "./layout/hud";
export * from "./layout/dialogs";
export * from "./layout/panels";
export * from "./layout/borders";
export * from "./layout/backgrounds";
export * from "./layout/lights";
export * from "./layout/scenes";
export * from "./layout/images";
export * from "./layout/sizes";
export * from "./layout/theme";
