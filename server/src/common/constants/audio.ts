/**
 * 可配置音效的 key、出厂值与路径口径（**唯一书写处**）
 *
 * ## 为什么是固定清单，不是自由增删
 *
 * 与特效管理（`UI_EFFECT_KEYS`）同一取向：一个 key 存在的前提是**客户端有播它的代码**。
 * 后台凭空加一行「战斗背景音」，客户端不认识这个 key，就是一个永远不响的开关。
 * 所以加音效 = 客户端写播放入口 + 这里登记 key 与出厂值，管理端页面自动多一项。
 *
 * ## 管的是「用哪个文件 + 多大声 + 循环不循环 + 开不开」
 *
 * 音频文件本体在客户端资源包里（`client/assets/resources/sounds/`），服务端不存二进制。
 * 存的是**资源相对路径**（`file_path`），运营可以换文件 —— 这是本配置的核心：
 * 换一首登录曲不需要重打客户端包，只要新文件已经在资源包里。
 *
 * ## 路径口径（与用户 2026-11-04 的约定一致）
 *
 * - 相对 `client/assets/resources/`，**带扩展名**：`sounds/login_bg.wav`；
 *   带扩展名的理由：与文件系统一一对应，管理端的目录列表 / 试听地址可以直接拼，
 *   不用「先猜扩展名再试」；客户端对接时按 `resources.load(去掉扩展名的路径, AudioClip)` 读。
 * - 只允许 `sounds/` 开头：音效文件就是放这里的，限制前缀能挡住「误填成图片路径」。
 * - 空串 = **未配置**（这一项不响），不是错误 —— 新加的音效通常先留空等美术给文件。
 */

/** 可配置音效的 key（登记顺序 = 管理端展示顺序） */
export const AUDIO_KEYS = ["login_bgm", "login_click"] as const;

/** 音效 key 类型（`AUDIO_KEYS` 派生，别处不要手抄字面量） */
export type AudioKey = (typeof AUDIO_KEYS)[number];

/** 音效配置的取值范围（DTO 校验、服务端兜底、管理端表单提示共用） */
export const AUDIO_LIMITS = {
  /** 音量下限（0 = 静音，仍然可以「启用但听不见」——排查时有用） */
  volumeMin: 0,
  /** 音量上限（百分比，100 = 原始音量） */
  volumeMax: 100,
  /** 路径最大长度（够长到能写下多级目录，又不至于塞进一整段文本） */
  pathMaxLength: 200,
  /** 音效文件的根目录（resources 相对；用户定：音效都放这里） */
  rootDir: "sounds",
  /** 允许的音频扩展名（Cocos 能直接解码的几种） */
  extensions: [".wav", ".mp3", ".ogg", ".m4a"] as const,
} as const;

/** 一个音效项的出厂值 */
export interface AudioPreset {
  /** 管理端展示名（中文，随接口下发；页面不写死文案） */
  label: string;
  /** 资源相对路径（带扩展名；空串 = 未配置） */
  filePath: string;
  /** 音量百分比（0~100） */
  volume: number;
  /** 是否循环播放（背景音 true、点击音 false） */
  loop: boolean;
  /** 开关（false = 客户端整个不播，连文件都不读） */
  enabled: boolean;
}

/**
 * 出厂值
 *
 * 两项都指向资源包里**已有**的文件（2026-11-04 运营放进 `sounds/` 的那批）：
 * 背景音是 `login_bg.wav`（6 MB 的长曲），点击音是 `click_button.wav`。
 * 指向真实文件的好处是「装完就有声音」，运营只需要改想改的那一项 ——
 * 编一个不存在的文件名只会得到「配置看着对、进游戏没声音」。
 */
export const AUDIO_DEFAULTS: Record<AudioKey, AudioPreset> = {
  login_bgm: {
    label: "登录场景背景音",
    filePath: "sounds/login_bg.wav",
    volume: 60,
    loop: true,
    enabled: true,
  },
  login_click: {
    label: "登录场景点击登录按钮音",
    filePath: "sounds/click_button.wav",
    volume: 80,
    loop: false,
    enabled: true,
  },
};

/** key → 展示名（未知 key 回落成 key 本身：宁可显示得难看，也不要显示成「未命名」） */
export function audioLabelOf(key: string): string {
  return (AUDIO_DEFAULTS as Record<string, AudioPreset>)[key]?.label ?? key;
}

/**
 * 校验并规范化一个音效路径，返回**人话**错误（null = 合法）
 *
 * 不抛异常：调用方（service）要把问题转成 400 + 业务码，测试也要能单独断言判据。
 * 规范化只做一件事：反斜杠转正斜杠（Windows 上复制来的路径），并去掉首尾空白。
 */
export function audioPathProblem(rawPath: string): string | null {
  const path = rawPath.trim().replace(/\\/g, "/");
  // 空串是合法的「未配置」
  if (path === "") return null;
  if (path.length > AUDIO_LIMITS.pathMaxLength) {
    return `路径太长（${path.length} 个字符，最多 ${AUDIO_LIMITS.pathMaxLength}）`;
  }
  if (path.startsWith("/")) {
    return "不要以 / 开头：路径是相对 client/assets/resources/ 的（例如 sounds/login_bg.wav）";
  }
  if (path.split("/").some((segment) => segment === ".." || segment === ".")) {
    return "路径里不许出现 . 或 ..（只能指向 resources 目录里面）";
  }
  if (!path.startsWith(`${AUDIO_LIMITS.rootDir}/`)) {
    return `音效只能放在 ${AUDIO_LIMITS.rootDir}/ 下（例如 sounds/login_bg.wav）`;
  }
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (!path.includes(".") || !AUDIO_LIMITS.extensions.includes(ext as (typeof AUDIO_LIMITS.extensions)[number])) {
    return `只支持 ${AUDIO_LIMITS.extensions.join(" / ")} 这几种音频格式`;
  }
  // 文件名只允许英文 / 数字 / 下划线 / 短横线（用户 2026-11-04 定）：
  // Cocos 资源包按路径建索引，中文与空格在打包 / 热更时容易出岔子；资源目录里临时放的中文名
  // 要先改成英文名再配上来（管理端的选择器会把不合规的文件名挡掉）。
  if (!/^sounds\/[A-Za-z0-9_\-/]+\.[A-Za-z0-9]+$/.test(path)) {
    return "路径只能用字母、数字、下划线、短横线与斜杠（中文或空格的文件名请先改成英文名）";
  }
  return null;
}
