import { Color } from "cc";

/**
 * 小地图配置（右上角常驻 HUD）
 * 底图用当前地图文件夹下的 preview.jpg（取图见 configs/layout/images.mapPreviewImage，与小地图弹窗同一张图）；
 * 底图按「内容区 ↔ 世界视野」等比缩放后随角色平移，因此图上任意一点都与世界坐标一一对应：
 * 角色黑点在内容区中心，视野内的怪物按真实相对位置画红点（不显示朝向），视野外的怪物不显示
 * 位置、尺寸与图片来源见 configs/layout/hud.smallMapLayout 与同级的 images，本文件只管视野、点位与刷新频率
 */
export const smallMapConfig = {
  /**
   * 视野半径（世界单位）：内容区**横向**覆盖的世界范围 = 2 × 视野半径
   * 纵轴按同一比例缩放（等比，不拉伸地图），可见世界范围 = 2 × 视野半径 × 内容区高 / 内容区宽
   * 想让整张地图都装进小地图 → 把它调到「地图宽度的一半」以上（本工程地图 8192 像素宽，取 4200 即全图）
   */
  viewRadius: 600,
  /** 角色黑点半径（像素） */
  roleDotRadius: 4,
  /** 怪物红点半径（像素） */
  monsterDotRadius: 3,
  /** 角色点颜色 */
  roleDotColor: Color.BLACK,
  /** 怪物点颜色 */
  monsterDotColor: Color.RED,
  /** 刷新间隔（毫秒）：坐标文本与红点的重绘频率（怪物移动平滑度与重绘开销的平衡） */
  refreshInterval: 100,
};

/**
 * 小地图缩放（内容区像素 / 世界单位）
 * 由「内容区横向覆盖 2 × viewRadius 的世界范围」反推；底图缩放与坐标点换算都用它，
 * 保证底图上任一点与红点/黑点永远落在同一处（换 viewRadius 即整体放大/缩小，点位不会跑偏）
 * @param contentWidth 内容区宽度（像素，见 configs/layout/hud.smallMapLayout.contentSize）
 */
export function getSmallMapScale(contentWidth: number) {
  return contentWidth / (2 * smallMapConfig.viewRadius);
}
