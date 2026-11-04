/**
 * 装备详情背景显示（前后缀决定的品质背景动画，播放在物品详情弹窗自身的精灵上）
 *
 * 背景素材与「哪个前后缀用哪个背景」见 configs/background；
 * 这里只放显示口径。背景是详情弹窗的独立子节点（不参与内容排版），
 * **宽度贴弹窗面板、高度按第一帧原始宽高比自适应**（素材宽高比不一，铺满面板
 * 会把有的拉高、有的压扁）；每条配置的显示效果（偏移/缩放）乘在面板宽度上，
 * 口径见 GameUiHelper.createEquipmentDetailBackground。
 */
export const equipmentDetailBackgroundLayout = {
  /** 背景动画的片段别名前缀（便于在排查时辨认片段来源） */
  namePrefix: "equipment_detail_background_",
  /** 循环播放帧率（每秒帧数；一轮时长 = 帧数 / 帧率，与装备边框同一档） */
  frameRate: 10,
};
