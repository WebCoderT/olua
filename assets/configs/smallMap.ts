import { Color } from "cc";

/**
 * 小地图配置（右上角常驻 HUD）
 * 地图底图暂为空图片（configs/layout/images.uiImages.smallMapFrame 占位），后续按地图替换成对应缩略图；
 * 点位在其上实时绘制：角色黑点固定在内容区中心，附近怪物按相对位置显示红点（不显示朝向）
 * 位置、尺寸与图片来源见 configs/layout/hud.smallMapLayout 与本文件同级的 images，本文件只管视野、点位与刷新频率
 */
export const smallMapConfig = {
  /** 视野半径（世界像素）：以角色为中心的方形世界范围映射到地图内容区，范围外的怪物不显示 */
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
