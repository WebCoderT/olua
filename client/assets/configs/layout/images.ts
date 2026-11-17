/**
 * 图片与字体地址的唯一来源
 *
 * 约定：
 * - 资源按 resources 下的文件夹收敛成取图函数（uiHud / uiMoney / ...），
 *   同一文件夹里的图统一走对应那一个函数按名字取，不在各处拼字符串
 * - 界面里 eui 用到的具体图统一登记在 uiImages，代码里**不允许再出现裸路径字符串**
 * - 玩法数据自带的图标（装备/技能/怪物/NPC/状态等）属于各自配置表的数据字段，
 *   由服务端快照下发（见 configs/game-config.ts），不往这里搬
 * - **界面零件一律矢量**（#1059 起）：弹窗框 / 按钮 / 血条 / 格子 / 圆点等都由 Graphics 现画，
 *   本表只登记「照片级」素材（登录背景照 / 登录页设计稿导出的图标）与装备物品类图标，
 *   旧的按钮底图、九宫格弹窗框、格子图等已全部删除
 *
 * 目录口径见 client/RESOURCES.md：**界面零件全部收在 ui/ 下**，实体（monster / npc /
 * item / equipment / title / soul / wing…）与特效（effect/）按域平铺，方便一眼找到。
 */

//#region 取图函数（resources 下的文件夹 → 按名字取图）

/** resources/ui/hud：主界面 HUD（摇杆） */
export const uiHud = (name: string) => `ui/hud/${name}`;
/** resources/ui/money：货币与 VIP 图标 */
export const uiMoney = (name: string) => `ui/money/${name}`;
/** resources/ui/login：登录界面资源 */
export const uiLogin = (name: string) => `ui/login/${name}`;
/** resources/ui/create-role：选角 / 创建角色界面资源（预览图集在 preview/ 下） */
export const uiCreateRole = (name: string) => `ui/create-role/${name}`;
/** resources/effect：特效图集（border / background / light / skill / status / aura / select / upgrade） */
export const effectImage = (name: string) => `effect/${name}`;
/** resources/map/<地图id>/preview：地图预览图（小地图弹窗底图，每个地图文件夹下一张） */
export const mapPreviewImage = (id: string) => `map/${id}/preview`;
/** resources/ui/avatar：角色头像（按「职业-性别」取图） */
export const avatarImage = (occupation: string, sex: string) => `ui/avatar/${occupation}-${sex}`;
/** 选角界面的角色站立帧动画图集（按「职业-性别」取图；未选中时循环播放） */
export const createRolePreviewImage = (occupation: string, sex: string) => uiCreateRole(`preview/${occupation}-${sex}-stand@0`);
/** 选角界面的角色展示帧动画图集（按「职业-性别」取图；选中时循环播放，与站立图集同一块 800×800 画布，切换不位移） */
export const createRoleShowImage = (occupation: string, sex: string) => uiCreateRole(`preview/${occupation}-${sex}-show@0`);
/**
 * 选中光标图集：**角色选中与怪物选中放在一起**（`effect/select/`），
 * 一个 `player@0`（选角界面脚下一圈地面光标）、一个 `monster@0`（地图上点中的怪）
 */
export const effectSelectImage = (name: string) => effectImage(`select/${name}`);
/** 选角界面的「已选中」脚下特效图集（effect/select/player@0：一圈地面光标） */
export const roleSelectEffectImage = effectSelectImage("player@0");

//#endregion

//#region 具名图片表（全部由上面的取图函数生成）

export const uiImages = {
  // ---------------- 通用 ----------------
  /** 默认字体（Label 未指定字体时使用） */
  defaultFont: "font/msyh",
  /** 绑定元宝（唯一货币） */
  bindGold: uiMoney("bind-gold"),
  /** 界面特效：升级/强化 */
  upgradeEffect: effectImage("upgrade"),

  // ---------------- 底部栏（移动端操作） ----------------
  /** 操作摇杆：底座底图 / 可拖动手柄 */
  joystickBackground: uiHud("joystick-bg"),
  joystickHandle: uiHud("joystick"),

  // ---------------- 登录界面 ----------------
  /** 登录背景（#1036：设计稿 hero-bg，黄昏沙城；**上下黑边已裁掉**，现 1600×680） */
  loginBackground: uiLogin("hero-bg"),
  /** 输入框图标（账号 / 密码）—— 设计稿 SVG 导出的 PNG，不再自绘 */
  loginAccountIcon: uiLogin("icon-account"),
  loginPasswordIcon: uiLogin("icon-password"),
  /** 图标一律用 PNG（设计稿 SVG 导出）：眼睛两态 / 地球 / 箭头 / 喇叭两态 / 勾选框两态 / 职业三枚 / 公告 */
  loginEyeIcon: uiLogin("icon-eye"),
  loginEyeOnIcon: uiLogin("icon-eye-on"),
  loginGlobeIcon: uiLogin("icon-globe"),
  loginCaretIcon: uiLogin("icon-caret"),
  loginSpeakerIcon: uiLogin("icon-speaker"),
  loginSpeakerOffIcon: uiLogin("icon-speaker-off"),
  loginCheckboxIcon: uiLogin("icon-checkbox"),
  loginCheckboxCheckedIcon: uiLogin("icon-checkbox-checked"),
  loginClassWarriorIcon: uiLogin("icon-class-warrior"),
  loginClassMageIcon: uiLogin("icon-class-mage"),
  loginClassTaoistIcon: uiLogin("icon-class-taoist"),
  loginNoticeIcon: uiLogin("icon-notice"),
};

//#endregion
