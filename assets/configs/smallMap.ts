import { Color, Size } from "cc";

/**
 * 小地图配置（右上角常驻 HUD）
 * 地图底图暂为空图片（resources/small-map/map-frame 占位），后续按地图替换成对应缩略图；
 * 点位在其上实时绘制：角色黑点固定在内容区中心，附近怪物按相对位置显示红点（不显示朝向）
 */
export const smallMapConfig = {
  /** 小地图距屏幕右上角的边距（像素） */
  screenMargin: 10,
  /** 视野半径（世界像素）：以角色为中心的方形世界范围映射到地图内容区，范围外的怪物不显示 */
  viewRadius: 600,
  /** 地图内容区尺寸（底图去除边框后的可绘制区域，红点/黑点画在这里） */
  contentSize: new Size(200, 180),
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
