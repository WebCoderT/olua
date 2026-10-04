import { Color, Size } from "cc";

/**
 * UI 通用主题（跨界面复用、但既不属于某个界面布局、也不属于某个功能域的样式）
 *
 * 与另外两个配置的分工：
 * - 某个界面的位置/尺寸/配色 → configs/layout/{hud,dialogs,panels,scenes}.ts
 * - 与玩法绑定的表现（飘字、指针、小地图描点）→ 各自的域配置（cursor / smallMap / …）
 * - 剩下的「通用零件默认长相」→ 本文件
 *
 * 约定：核心代码只引用这里的值，**不在零件里写颜色/字号/时长**。
 */
export const uiTheme = {
  /** 空节点调试边框（UiHelper.createEmptyNode：用于确认选择体积） */
  emptyNodeBorder: {
    lineWidth: 4,
    color: new Color(255, 0, 0, 255),
  },

  /** 输入框占位符颜色（UiHelper.createInputBox） */
  inputPlaceholderColor: new Color("#999999"),

  /**
   * 飘字（挂特效层、上浮淡出后自动销毁的临时文本）
   * 文案本身见 configs/texts（label_damage / label_skill_release / label_exp_gain）
   * 每个飘字三个几何参数：出生点相对目标的纵向偏移 spawnOffsetY、上浮距离 riseDistance、上浮/淡出时长
   */
  floatingText: {
    /** 伤害飘字（颜色按伤害正负由代码决定：受伤红、MISS 白） */
    damage: {
      color: Color.RED,
      fontSize: 18,
      size: new Size(80, 24),
      spawnOffsetY: 40,
      riseDuration: 0.6,
      riseDistance: 40,
      fadeDuration: 0.9,
    },
    /** 技能释放飘字（释放者头顶） */
    skill: {
      color: Color.YELLOW,
      fontSize: 14,
      size: new Size(120, 20),
      spawnOffsetY: 40,
      riseDuration: 0.6,
      riseDistance: 30,
      fadeDuration: 0.9,
    },
    /** 经验飘字（被击杀怪物头顶） */
    exp: {
      color: Color.GREEN,
      fontSize: 14,
      size: new Size(100, 20),
      spawnOffsetY: 40,
      riseDuration: 0.6,
      riseDistance: 40,
      fadeDuration: 1,
    },
  },
};
