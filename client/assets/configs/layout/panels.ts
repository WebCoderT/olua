import { Size, Vec2 } from "cc";
import { T } from "./tokens";

/**
 * 角色信息弹窗内的面板零件布局
 *
 * 坐标系：子件坐标以**弹窗中心**为原点（弹窗尺寸见 dialogs.dialogFrame.size）
 */

//#region 装备槽分组（左列 / 右列 / 底部横排）

/** 装备槽分组布局（分组顺序与各分组的容器几何） */
export const equipmentSlotLayout = {
  /** 分组排列顺序（与装备槽配置 configs/equipments.equipmentSlots 的 position 对应） */
  sides: ["left", "right", "bottom"] as ("left" | "right" | "bottom")[],
  /** 槽位间距与单个槽位尺寸 */
  slotSpacing: 10,
  slotSize: new Size(50, 50),
  /**
   * 「更好装备」提示角标（背包里有该槽位更好的可穿装备时显示，点击一键换上）：
   * 挂在槽位右上角的小圆牌（Graphics 自绘圆底，不依赖底图），文案见 configs/texts.label_equip_upgrade_hint
   */
  upgradeHint: {
    /** 角标中心相对槽位中心的位置（槽位 50×50，往右上角探出 7px，槽位间距 10 不会压到相邻槽位） */
    position: new Vec2(19, 19),
    /** 圆牌直径与字号 */
    size: new Size(24, 24),
    fontSize: T.fontSize.f13,
    /** 圆底填充与描边（绿 = 变强），文字用白字保对比度 */
    fill: T.jadeDeep,
    borderColor: T.jade,
    borderWidth: 1.5,
    color: T.text[1],
  },
  /**
   * 各分组容器（name = 节点名，horizontal = 横排还是竖排）
   *
   * 几何按 06-role-info 稿的五列结构落（面板 660×520，原点在弹窗中心）：
   * 左装备列 -286 / 内观（服务端 `equip_in_aligns` 的 inPosition，客户端不摆）/ 右装备列 55 /
   * 属性列 165 / 六入口列 285。**内观是服务端对齐数据，这里不参与重排** ——
   * 衣服中心实测在 x -75~-153，人物本体约占 -190~10，与两列都不会压住。
   * 底部三格（衣服 / 其他1 / 其他2）原在旧版底边横排，稿没有这一列，改放到内观列底部
   * （人物脚下），三格 170×50 与左右两列纵向错开。
   */
  groups: {
    left: { name: "equipment_slots_left", position: new Vec2(-286, 20), size: new Size(50, 290), horizontal: false },
    right: { name: "equipment_slots_right", position: new Vec2(55, 20), size: new Size(50, 290), horizontal: false },
    bottom: { name: "equipment_slots_bottom", position: new Vec2(-126, -150), size: new Size(170, 50), horizontal: true },
  },
};

//#endregion

//#region 背包格子网格

/** 背包格子网格布局（弹窗内固定几何；行列数见 configs/role 的 bagRow / bagCol） */
export const bagGridLayout = {
  name: "bag_grid",
  /** 网格中心（稿 05-bag 实测：网格 670..1240 × 353..715，面板 660..1260 × 270..810 → 中心 +6） */
  position: new Vec2(0, 6),
  /** 570×362 = 11×50 + 10×2 宽、7×50 + 6×2 高（与稿的 slot 尺寸/间距一致） */
  size: new Size(570, 362),
  /** 行间距与单行尺寸（行宽 ÷ 格子宽决定每行格子数；稿 gap = 2） */
  rowSpacing: 2,
  rowSize: new Size(570, 50),
  /** 单个格子尺寸（边框由 GameUiHelper 矢量现画，稿 .slot 无底色、只有 1px 金线） */
  cellSize: new Size(50, 50),

  /**
   * 叠加数量角标（可叠加物品格子右下角的数字，内容见 configs/items.getStackBadge）
   *
   * 角标挂在**物品图标**节点下（与装备品质边框同一挂点）：拖动压暗源格图标时角标一起变暗，
   * 格子刷新销毁图标时角标也随子节点一起销毁，不必单独清理。
   * 图标 40×40 居中在 50×50 的格子里，标签框 24×16 摆在右下角（外缘贴格子右下角、留 2px 内缩），
   * 数字右对齐——一位数与三位数都贴着同一个角。
   */
  badge: {
    /** 标签框中心相对物品图标中心的偏移 */
    position: new Vec2(11, -17),
    /** 数字标签的字号与标签框 */
    fontSize: T.fontSize.f14,
    size: new Size(24, 16),
    /** 常规数量颜色 */
    color: T.text[1],
    /** 满叠（数量达到 maxStack）时的颜色 */
    fullColor: T.ember[4],
  },

  /**
   * 物品拖动（按住物品拖到别的格子：空格 = 移动、同种可叠加 = 合并、其余 = 交换）
   *
   * 手势走 touch 通道（鼠标环境由引擎把 MOUSE_* 模拟成 TOUCH_*，触屏原生就是 TOUCH_*，
   * 一套代码两种环境通用；为什么不在节点上监听 MOUSE_MOVE，见 ui/utils/input/Pointer 的说明）：
   * 按下（TOUCH_START）只记起点 → 移动超过 threshold 才算拖动 → 结束（TOUCH_END；松手在起点格
   * 之外时引擎会改判成 TOUCH_CANCEL，两者共用同一落子收尾，见 BagGridView.onCellTouchEnd）
   * 用指针位置找落点。
   * 阈值存在的意义：区分「点一下用掉/穿上」与「拖去别的格子」，手抖几像素不该变成拖动
   */
  drag: {
    /** 触发拖动的位移阈值（屏幕像素；小于它仍按点击处理） */
    threshold: 10,
    /** 跟随指针的幽灵图标：尺寸与不透明度（半透明＝这是个提起来的影子） */
    ghostSize: new Size(50, 50),
    ghostOpacity: 180,
    /** 拖动中源格物品压暗到的不透明度，以及松手/取消后恢复的值 */
    sourceOpacity: 70,
    restoreOpacity: 255,
    /** 落点高亮框：尺寸、描边宽度、相对尺寸的内缩与描边颜色 */
    highlightSize: new Size(50, 50),
    highlightLineWidth: 2,
    highlightInset: 3,
    highlightColor: T.gold[4],
  },
};

//#endregion

//#region 属性列表

/**
 * 属性列表布局（尺寸高度 0 = 由内容自适应）
 *
 * 锚点在**上边中点**（`applyRoleAttributeListStyle` 设 anchorPoint (0.5, 1)），x 是列中心。
 * 列宽按 06-role-info 稿（158）；高度是算出来的：1 个标题 + N 行（N 取 `goodShowAttributesLabel` 条目数）
 *   高度 = 2×padding + titleHeight + N×rowHeight + N×spacing
 * 当前 2×8 + 14 + 8×18 + 8×4 = 206 → 底边 y = 205 - 206 = -1。
 * #1059 起六入口整体挪到最右一列（x 285），属性列与入口列不再纵向争位置（旧版要卡「底边不能让按钮」）。
 */
export const roleAttributeListLayout = {
  name: "role_attributes",
  position: new Vec2(165, 205),
  size: new Size(158, 0),
  /** 条目纵向间距与容器内边距 */
  spacing: 4,
  padding: 8,
  /** 分组标题与属性行的高度 */
  titleHeight: 14,
  rowHeight: 18,
  /** 属性行字号 */
  rowFontSize: 12,
};

//#endregion

//#region 内观（衣服 + 武器）

/** 内观尺寸（衣服与武器共用；内观节点保持弹窗坐标系下的原有位置，见装备配置 in/inPosition） */
export const roleInShowLayout = {
  name: "role_in_show",
  size: new Size(400, 400),
};

//#endregion
