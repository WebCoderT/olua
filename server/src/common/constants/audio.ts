/**
 * 可配置音效的 key、分类、出厂值与路径口径（**唯一书写处**）
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
 * - 相对 `client/assets/resources/`，**带扩展名**：`sounds/login_bgm.wav`；
 *   带扩展名的理由：与文件系统一一对应，管理端的目录列表 / 试听地址可以直接拼，
 *   不用「先猜扩展名再试」；客户端对接时按 `resources.load(去掉扩展名的路径, AudioClip)` 读。
 * - 只允许 `sounds/` 开头：音效文件就是放这里的，限制前缀能挡住「误填成图片路径」。
 * - 空串 = **未配置**（这一项不响），不是错误 —— 新加的音效通常先留空等美术给文件。
 * - **命名约定：文件名与 key 同名**（`ui_click` → `sounds/ui_click.wav`，#685 用户授权改名后统一）。
 *   不是校验规则（运营可以换成任何合规文件名），纯粹为了对齐：翻资源目录时一眼看出
 *   「这个文件是哪个配置项」，反过来也一样。改 key 时顺手把文件也改掉。扩展名不统一
 *   （素材给的是 wav 就是 wav），所以路径里必须带扩展名。
 *
 * ## 分类为什么也在这里
 *
 * 分类只影响管理端的 tab 与展示分组，不影响客户端播放（客户端按 key 取，不认分类）。
 * 所以它和展示名一样属于**服务端常量**，不进库：库里的行是「运营改过的值」，
 * 分类是「这个东西属于哪一类」—— 后者要改，意味着清单本身变了（客户端也得跟着改）。
 * 落在表里的后果是：新加一项时，别处机器上那行不存在，分类 tab 就少一个。
 */

/** 音效分类（顺序 = 管理端 tab 顺序） */
export const AUDIO_CATEGORIES = [
  // 「界面与交互」：登录背景音 + 全站按钮点击音。按钮音不只登录页用（#685 起所有按钮都响），
  // 所以这一类的名字不能再叫「登录与界面」—— 分类名是给运营看的，得说清它管的是什么
  { key: "login", label: "界面与交互" },
  { key: "combat", label: "战斗与角色" },
  { key: "item", label: "物品与货币" },
  { key: "growth", label: "成长与传送" },
] as const;

/** 分类 key 类型 */
export type AudioCategory = (typeof AUDIO_CATEGORIES)[number]["key"];

/**
 * 可配置音效的 key（登记顺序 = 管理端展示顺序；**按分类成组，不要打散**）
 *
 * 每个 key 都必须有客户端的调用点，否则就是永远不响的开关。对照表：
 * - `login_bgm` → `ui/Login.start`（进登录场景起播）、`ui/core/SceneManager.loadScene`（离场停）
 * - `ui_click` → `ui/core/SoundManager.bindClick`（**所有按钮**：`UiHelper.createButton` / `createToggle`
 *   自动挂，手写按钮各自贴一行；技能快捷栏与世界对象不算按钮，不响）
 * - `warrior_attack` → `skills/warrior.skill_1000`（战士基础剑术，仅战士）
 * - `role_die_man` / `role_die_woman` → `ui/Game.checkRoleDeath`（按 `role.sex` 选一个）
 * - `item_drop` → `ui/core/DropManager.spawnResults`（掉落物铺到地上）+ `applyPickedFrame`（捡起来）
 * - `equip_wear` → `ui/core/StorageManager.equipFromBag`（服务端接受之后）
 * - `money_change` → `ui/core/StorageManager.applyServerRoleUpdate`（三种货币任一变化）
 * - `bag_resort` → `ui/core/StorageManager.tidyBag`（一键整理）+ `moveBagGood`（拖动搬格）
 * - `level_up` → `ui/core/StorageManager.applyKillReward` / `applyPartyExpGain`（`leveledUp`）
 * - `map_teleport` → `ui/Game.start`（传送后进图、角色显示出来时；不是点传送的瞬间）
 */
export const AUDIO_KEYS = [
  // 界面与交互
  "login_bgm",
  "ui_click",
  // 战斗与角色
  "warrior_attack",
  "role_die_man",
  "role_die_woman",
  // 物品与货币
  "item_drop",
  "equip_wear",
  "money_change",
  "bag_resort",
  // 成长与传送
  "level_up",
  "map_teleport",
] as const;

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
  /** 所属分类（管理端 tab 分组；客户端不消费） */
  category: AudioCategory;
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
 * 全部指向资源包里**已有**的文件（2026-11-04 运营放进 `sounds/` 的那批，
 * 其中 `warrior_attack.wav` 原名 `木剑砍击音效.wav`，用户指定它就是战士普攻音）：
 * 指向真实文件的好处是「装完就有声音」，运营只需要改想改的那一项 ——
 * 编一个不存在的文件名只会得到「配置看着对、进游戏没声音」。
 *
 * 音量取 60~80：登录曲是唯一的长音（60，压低一点不吵）；`item_drop` 会连响
 * （一堆怪同时死）所以给 70 而不是 100。
 */
export const AUDIO_DEFAULTS: Record<AudioKey, AudioPreset> = {
  login_bgm: {
    label: "登录场景背景音",
    category: "login",
    filePath: "sounds/login_bgm.wav",
    volume: 60,
    loop: true,
    enabled: true,
  },
  ui_click: {
    // 名字是「按钮点击音」而不是「登录按钮音」（#685）：它现在挂在所有按钮上，
    // 展示名跟着真实用途走，运营看到名字就知道改它会波及全站
    label: "按钮点击音",
    category: "login",
    filePath: "sounds/ui_click.wav",
    volume: 80,
    loop: false,
    enabled: true,
  },
  warrior_attack: {
    label: "战士普通攻击音",
    category: "combat",
    filePath: "sounds/warrior_attack.wav",
    volume: 70,
    loop: false,
    enabled: true,
  },
  role_die_man: {
    label: "男角色死亡音",
    category: "combat",
    filePath: "sounds/role_die_man.wav",
    volume: 80,
    loop: false,
    enabled: true,
  },
  role_die_woman: {
    label: "女角色死亡音",
    category: "combat",
    filePath: "sounds/role_die_woman.wav",
    volume: 80,
    loop: false,
    enabled: true,
  },
  item_drop: {
    label: "物品掉落音",
    category: "item",
    filePath: "sounds/item_drop.wav",
    volume: 70,
    loop: false,
    enabled: true,
  },
  equip_wear: {
    label: "穿戴装备成功音",
    category: "item",
    filePath: "sounds/equip_wear.mp3",
    volume: 75,
    loop: false,
    enabled: true,
  },
  money_change: {
    label: "金钱更新音",
    category: "item",
    filePath: "sounds/money_change.mp3",
    volume: 70,
    loop: false,
    enabled: true,
  },
  bag_resort: {
    label: "背包整理成功音",
    category: "item",
    filePath: "sounds/bag_resort.wav",
    volume: 65,
    loop: false,
    enabled: true,
  },
  level_up: {
    label: "升级成功音",
    category: "growth",
    filePath: "sounds/level_up.wav",
    volume: 80,
    loop: false,
    enabled: true,
  },
  map_teleport: {
    label: "传送成功音",
    category: "growth",
    filePath: "sounds/map_teleport.mp3",
    volume: 75,
    loop: false,
    enabled: true,
  },
};

/** key → 展示名（未知 key 回落成 key 本身：宁可显示得难看，也不要显示成「未命名」） */
export function audioLabelOf(key: string): string {
  return (AUDIO_DEFAULTS as Record<string, AudioPreset>)[key]?.label ?? key;
}

/** key → 分类 key（未知 key 落到第一个分类，保证管理端的 tab 总能装下它） */
export function audioCategoryOf(key: string): AudioCategory {
  return (AUDIO_DEFAULTS as Record<string, AudioPreset>)[key]?.category ?? AUDIO_CATEGORIES[0].key;
}

/** 分类 → 展示名（未知分类回落成分类 key 本身，理由同 `audioLabelOf`） */
export function audioCategoryLabelOf(category: string): string {
  return AUDIO_CATEGORIES.find((item) => item.key === category)?.label ?? category;
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
    return "不要以 / 开头：路径是相对 client/assets/resources/ 的（例如 sounds/login_bgm.wav）";
  }
  if (path.split("/").some((segment) => segment === ".." || segment === ".")) {
    return "路径里不许出现 . 或 ..（只能指向 resources 目录里面）";
  }
  if (!path.startsWith(`${AUDIO_LIMITS.rootDir}/`)) {
    return `音效只能放在 ${AUDIO_LIMITS.rootDir}/ 下（例如 sounds/login_bgm.wav）`;
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
