import { Size } from "cc";

/**
 * 装备光柱显示（装备掉在地面上时，画在掉落物装备图标上的品质光效）
 *
 * 光柱素材与「哪个前缀用哪个光柱」见 configs/light；
 * 这里只放显示口径。位置不在这里配：光柱与图标**同中心**，坐标跟随掉落物布局
 * （configs/layout/hud 的 dropItemLayout.iconOffsetY）。光柱是掉落物节点的第一个子节点，
 * 排在图标之前 → 画在图标**下层**，图标始终清晰可辨。
 */
export const equipmentLightLayout = {
  /** 光柱节点名前缀（节点名 = 前缀 + 光柱 key，便于在编辑器里辨认与排查） */
  namePrefix: "drop_light_",
  /**
   * 光柱显示尺寸：素材是 400×400 原始画布（帧内为竖直光柱，内容约 219×361），
   * 取图标（dropItemLayout.iconSize 40×40）的两倍 = 80×80 —— 光柱高约 72、从图标上下各透出一截，
   * 又不至于糊住图标与下方的名称行
   */
  size: new Size(400, 400),
  /** 循环播放帧率（每秒帧数；一轮时长 = 帧数 / 帧率，与装备边框 / 详情背景同一档） */
  frameRate: 10,
};
