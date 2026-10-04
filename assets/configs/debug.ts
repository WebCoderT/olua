import { Color, Size } from "cc";

/**
 * 调试配置（纯静态数据）
 * 只服务于开发期核对，不参与任何游戏逻辑；核对完成后置 false 即可整体关闭
 */
export const debugConfig = {
  /**
   * 是否显示碰撞体的碰撞范围（范围框 + 名称 + 尺寸）
   * 覆盖全部碰撞体：Tiled collision 对象组 / NPC / 怪物 / 角色自身
   */
  colliderRange: true,
  /**
   * 是否显示怪物刷怪区域的范围（区域框 + 名称 + 尺寸 + 怪物编号与数量区间）
   * 刷怪区域本身没有碰撞体，只作为怪物落点范围使用
   */
  areaRange: true,

  /**
   * 范围标注的样式（范围框 + 名称文本）
   * 配色口径：静态障碍红、角色自身绿、刷怪区域黄（三者常同屏出现，用颜色区分来源）
   */
  rangeStyle: {
    /** 范围框线宽（像素） */
    lineWidth: 3,
    /** 范围框填充透明度（低透明度，避免遮挡地图与角色） */
    fillAlpha: 40,
    /** 名称字号与文本尺寸（窄区域下允许超出宽度，保证名称完整可读） */
    nameFontSize: 14,
    nameSize: new Size(260, 18),
    /** 静态障碍（Tiled 碰撞区 / NPC / 怪物） */
    obstacleColor: new Color(255, 64, 64),
    /** 角色自身 */
    roleColor: new Color(64, 255, 128),
    /** 怪物刷怪区域（无碰撞体，与碰撞体区分） */
    areaColor: new Color(255, 208, 64),
  },
};
