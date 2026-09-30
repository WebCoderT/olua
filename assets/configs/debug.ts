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
};
