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
   * 输入框内层 EditBox 的几何（UiHelper.createInputBox 的调用方按它算宽高）
   * - iconInset：带图标时的左右留白（登录页：左侧图标 + 文字起始位）
   * - plainInset：不带图标时只留边距（创建角色弹窗）
   * - height：EditBox 高度（比背景条略矮，上下各留一点，避免文字贴边）
   *
   * 这两个 inset 之前是写死在 `createInputField` 里的一个 200：弹窗的 240 宽背景条减完
   * 只剩 40，背景看着是整条、实际只有右端一小截能点（#457）
   */
  inputField: {
    iconInset: 200,
    plainInset: 24,
    height: 60,
  },

  /**
   * 飘字（挂特效层、上浮淡出后自动销毁的临时文本）
   * 文案本身见 configs/texts（label_damage / label_skill_release / label_exp_gain）
   * 每个飘字三个几何参数：出生点相对目标的纵向偏移 spawnOffsetY、上浮距离 riseDistance、上浮/淡出时长
   */
  floatingText: {
    /**
     * 伤害飘字（颜色按伤害正负由代码决定：受伤红、MISS 白）
     * blockedColor 是格挡飘字的颜色（状态格挡触发时文案走 label_damage_block，见 GameUiHelper.showDamageText）
     * offsetXs 是连续挨打时的错峰横向偏移（像素，按出场次数轮转取用，见 GameUiHelper.showDamageText）：
     * 连续命中不会都叠在同一个点上糊成一团；数组只有一项时相当于关闭错峰
     */
    damage: {
      color: Color.RED,
      blockedColor: new Color(255, 200, 60, 255),
      fontSize: 18,
      size: new Size(80, 24),
      spawnOffsetY: 40,
      riseDuration: 0.6,
      riseDistance: 40,
      fadeDuration: 0.9,
      offsetXs: [-26, 26, 0],
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
