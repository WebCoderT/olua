/**
 * 装备详情背景显示（前后缀决定的品质背景动画，播放在物品详情弹窗自身的精灵上）
 *
 * 背景素材与「哪个前后缀用哪个背景」见 configs/background；
 * 这里只放显示口径。背景帧直接换弹窗节点的 spriteFrame（不是子节点、不参与弹窗 Layout 排版），
 * 弹窗尺寸由内容自适应（ResizeMode.CONTAINER），背景随节点 contentSize 铺满整个面板。
 */
export const equipmentDetailBackgroundLayout = {
  /** 背景动画的片段别名前缀（便于在排查时辨认片段来源） */
  namePrefix: "equipment_detail_background_",
  /** 循环播放帧率（每秒帧数；一轮时长 = 帧数 / 帧率，与装备边框同一档） */
  frameRate: 10,
};
