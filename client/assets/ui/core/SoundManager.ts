import { AudioClip, AudioSource, Button, Node, director, isValid } from "cc";
import { audioConfigOf, audioConfigs, audioResPathOf, applyAudioRows } from "../../configs/game-config";
import { GameConfigApi } from "../utils/net/Api";
import { loadResourceAsync } from "../utils/resource/ResourceLoader";

/** 按钮点击音的最小间隔（毫秒）：连点 / 双击只响一声，不然一下点两下会出两下声音 */
const CLICK_MIN_GAP_MS = 60;

/**
 * 音效播放（#683）
 *
 * ## 它是什么
 *
 * 运营在管理端「音效配置」里改的 11 项，客户端按 **key** 播 —— 文件路径 / 音量 / 循环 / 开关
 * 全部来自服务端，客户端不存一份默认值（没下发就不响，见 `configs/game-config` 区 21）。
 *
 * 调用点一共 11 个 key，全在「服务端已经确认」的那一行之后（别提前播，那会把「点了但被拒」
 * 演成「成功」）：
 *
 * | key | 调用点 |
 * |---|---|
 * | `login_bgm` | `ui/Login.start` 起播、`ui/core/SceneManager.loadScene` 停 |
 * | `ui_click` | **所有按钮**：`bindClick(node)`（`UiHelper.createButton` / `createToggle` 自动挂，其余手写按钮各自贴一行） |
 * | `warrior_attack` | `skills/warrior.skill_1000`（只对战士） |
 * | `role_die_man` / `role_die_woman` | `ui/Game.checkRoleDeath`（按 `role.sex` 选一个） |
 * | `item_drop` | `ui/core/DropManager.spawnResults`（铺到地上）+ `applyPickedFrame`（捡起来） |
 * | `equip_wear` | `ui/core/StorageManager.equipFromBag` |
 * | `money_change` | `ui/core/StorageManager.applyServerRoleUpdate` |
 * | `bag_resort` | `ui/core/StorageManager.tidyBag`（一键整理）+ `moveBagGood`（拖动搬格） |
 * | `level_up` | `ui/core/StorageManager.applyKillReward` / `applyPartyExpGain` |
 * | `map_teleport` | `ui/Game.start`（**传送后进图、角色显示出来时**，不是点传送的瞬间） |
 *
 * ## 为什么点击音不走「逐个按钮写一行」
 *
 * 按钮散在三十多个文件里，靠人记着挂必然漏。所以口径是：**能走 `UiHelper.createButton` /
 * `createToggle` 的自动带上**（登录、选角、弹窗按钮、底部面板…绝大多数都在这里），
 * 手写的（`Node` 子类、卡片、开关）在构造那里贴一行 `SoundManager.bindClick(this)`。
 * 漏了的表现是「这个按钮不响」而不是报错，所以加新按钮时**顺手看一眼用了哪个创建器**。
 *
 * 不响的三类（有意为之，不是漏）：
 * - **技能快捷栏**（`ShortcutKeySlot`）：战斗中高频连点，点击音会盖住战斗音效；
 * - **世界侧对象**（NPC / 传送点 / 掉落物）：那是场景交互，不是 UI；
 * - **拖拽与摇杆**：一次拖拽会以 TOUCH_END 收尾，绑上去等于松手就响一声。
 *
 * ## 为什么挂在常驻节点上
 *
 * 场景切换（登录 → 选角 → 游戏）会把场景里的节点全销毁，而音效要跨场景响。
 * 所以第一次 `init()` 建一个根节点并 `director.addPersistRootNode()` —— 它是**唯一**在
 * 场景切换中活下来的东西。两个 `AudioSource` 分工：
 * - `music`：循环音（目前只有登录背景音），一次只播一首，切场景要显式 `stopMusic()`；
 * - `sfx`：一次性音，`playOneShot` 可以同时叠很多个（一堆怪同时死、连续普攻都用它）。
 *
 * **必须两个**：`playOneShot` 不会打断 `clip` 的循环播放，但循环音写在同一路的
 * `clip` 上，一旦那一路被 `play()` 重设就会把背景音顶掉。
 *
 * ## 为什么音量走 `volumeScale` 而不是 `source.volume`
 *
 * `playOneShot(clip, volumeScale)` 的最终音量 = `source.volume × volumeScale`。
 * 把 `source.volume` 固定 1、每次播传配置的音量比，改动只对本次生效 ——
 * 否则调一个音效的音量会连带影响同时响的另一个。
 *
 * ## 加载失败就静默
 *
 * 资源包里没这个文件（运营填了路径但没发版）、服务端没下发这个 key、浏览器策略拦住声音，
 * 三种情况都只 `console.warn`，**不弹提示**：音效是表现层，缺一个不该打断玩家。
 * 排查手段是管理端的「试听」（服务端不查文件存在性，那是唯一能当场验证的地方）。
 */
export default class SoundManager {
  /** 常驻节点（跨场景存活；`director.addPersistRootNode` 只认根节点） */
  private static node: Node | null = null;
  /** 循环音（背景音）专用的一路 */
  private static music: AudioSource | null = null;
  /** 一次性音效共用的一路（`playOneShot` 可叠加） */
  private static sfx: AudioSource | null = null;
  /** 已加载的音频（资源路径 → clip）：同一首反复播不该反复 IO */
  private static clips = new Map<string, AudioClip>();
  /** 正在加载的（同一个文件被两处同时点，共用一次加载） */
  private static loading = new Map<string, Promise<AudioClip | null>>();
  /** 当前正在循环的 key（同一个 key 不重复起播，否则每次 `start()` 都会从头再来一遍） */
  private static musicKey: string | null = null;
  /** 拉公开音效配置的进行中请求（登录页可能被重复进入） */
  private static configRequest: Promise<void> | null = null;
  /** 公开接口已经试过一次（失败也不重试：按钮点击音会高频打到这条路上，不能每次点击都发请求） */
  private static configTried = false;
  /** 已绑定点击音的节点（节点销毁后由 WeakSet 自动回收，这里只用于防重复注册） */
  private static clickBound = new WeakSet<Node>();
  /** 每个 key 上一次播放的时间戳（仅用于带 `minGapMs` 的调用，见 `play`） */
  private static lastPlayAt = new Map<string, number>();

  /**
   * 建常驻节点（幂等，第一次调用时生效）
   *
   * 登录场景与游戏场景各调一次即可 —— 第二次进来时节点还在（常驻），直接返回。
   * `director.getScene()` 为空（进程刚起、场景还没挂）时什么都不做：下一次调用会补上。
   */
  static init(): void {
    if (this.node && this.node.isValid) return;
    const scene = director.getScene();
    if (!scene) return;
    const node = new Node("sound_manager");
    scene.addChild(node);
    // 常驻：场景切换时引擎不销毁它，音效才能跨「登录 → 选角 → 游戏」连续播
    director.addPersistRootNode(node);
    this.music = node.addComponent(AudioSource);
    this.music.loop = true;
    this.music.playOnAwake = false;
    this.music.volume = 1;
    this.sfx = node.addComponent(AudioSource);
    this.sfx.loop = false;
    this.sfx.playOnAwake = false;
    this.sfx.volume = 1;
    this.node = node;
  }

  /**
   * 给一个 UI 按钮绑上点击音（`ui_click`）
   *
   * 判据是「这个节点能不能被点」，不是「它叫什么」：
   * - 节点上有 `Button` 组件 → 监听 `Button.EventType.CLICK`。引擎只在**真的点中并松开**
   *   时才 emit 它（`_pressed` + `_interactable` 都过），置灰 / 拖出去松手都不会响；
   * - 没有 `Button`（项目里很多手写按钮就是一个节点 + `TOUCH_END`）→ 退化成 `TOUCH_END`。
   *   这一步会跟着「按下又移开」也响一声，但比漏挂强得多。
   *
   * 重复调用无副作用（`WeakSet` 记着），所以创建器里挂一次、构造里再挂一次也不用担心两声。
   */
  static bindClick(node: Node): void {
    if (!isValid(node)) return;
    if (this.clickBound.has(node)) return;
    this.clickBound.add(node);
    if (node.getComponent(Button)) {
      node.on(Button.EventType.CLICK, () => this.playClick());
      return;
    }
    node.on(Node.EventType.TOUCH_END, () => this.playClick());
  }

  /** 点击音统一出口（只在这一处拼 key：以后要换成「按下音」只改这里） */
  private static playClick(): void {
    void this.play("ui_click", CLICK_MIN_GAP_MS);
  }

  /**
   * 播一个音效（按配置决定循环还是单次）
   *
   * 三道闸门都在 `audioConfigOf` 里：表里没这个 key、`enabled = false`、`filePath` 为空
   * → 返回 null，这里直接不播（调用方不需要各判一遍）。
   *
   * @param minGapMs 最小间隔（毫秒）：小于它就丢弃这一次。给「一堆掉落物同时被捡」「连点按钮」
   *   这类会连着触发很多次的场景用 —— `playOneShot` 是可以叠加的，不限流就成了噪音。
   *   判定放在最前面（`await` 之前），否则同时进来的两次都能通过。
   */
  static async play(key: string, minGapMs: number = 0): Promise<void> {
    if (minGapMs > 0) {
      const now = Date.now();
      const last = this.lastPlayAt.get(key) ?? 0;
      if (now - last < minGapMs) return;
      this.lastPlayAt.set(key, now);
    }
    if (audioConfigs.size === 0) await this.ensureConfig();
    const config = audioConfigOf(key);
    if (!config) return;
    this.init();
    if (!this.node || !this.sfx) return;
    const clip = await this.clipOf(config.filePath);
    if (!clip) return;
    const volume = Math.min(1, Math.max(0, config.volume / 100));
    if (!config.loop) {
      // 一次性：叠着播，互不打断（连续普攻 / 一堆怪同时死）
      this.sfx.playOneShot(clip, volume);
      return;
    }
    // 循环：同一首已经在播就不重来（重复点登录按钮不该让背景音从头开始）
    if (this.musicKey === key && this.music?.playing) return;
    const music = this.music;
    if (!music) return;
    music.stop();
    music.clip = clip;
    music.volume = volume;
    music.play();
    this.musicKey = key;
  }

  /** 停掉循环音（切场景时调：登录背景音不该跟到选角 / 游戏里） */
  static stopMusic(): void {
    this.musicKey = null;
    if (!this.music) return;
    this.music.stop();
    // 清掉 clip 引用：常驻节点不会回收，留着等于让这首 6 MB 的曲子常驻内存
    this.music.clip = null;
  }

  /**
   * 补音效配置（只在配置表为空时发一次请求）
   *
   * 为什么要这个：登录场景**没有玩家令牌**，配置快照拉不到，而登录背景音正是那时要响的。
   * 服务端为此开了 `GET /game-config/audio`（公开，与公告同口径），形状与快照的 `audio` 段一致 ——
   * 所以落库走同一个 `applyAudioRows`，客户端只有一套读法。
   *
   * 进游戏之后表已被快照填好，这个函数一次都不会发请求。
   * 失败静默（服务端没起 / 断网）：登录页照样能用，只是没有背景音。
   *
   * **只试一次**（`configTried`）：`play` 会在表为空时调到这里，而点击音是全站高频路径 ——
   * 不设这个闸门，服务端一挂，玩家每点一下按钮就是一次请求。失败后本场景不再重试，
   * 进游戏拉到快照自然就恢复了。
   */
  static ensureConfig(): Promise<void> {
    if (audioConfigs.size > 0) return Promise.resolve();
    if (this.configRequest) return this.configRequest;
    if (this.configTried) return Promise.resolve();
    this.configTried = true;
    this.configRequest = GameConfigApi.audio({ silent: true })
      .then((result) => {
        applyAudioRows(result?.list ?? []);
      })
      .catch((error: unknown) => {
        console.warn("[sound] 音效配置拉取失败，本次不播：", error);
      })
      // 收尾用 then 而不是 finally：客户端 tsconfig 的 lib 不到 ES2018（TS2550）
      .then(() => {
        this.configRequest = null;
      });
    return this.configRequest;
  }

  /**
   * 取（并缓存）一个音频资源
   *
   * `sounds/login_bg.wav` → `resources.load("sounds/login_bg", AudioClip)`：
   * 服务端存带扩展名的路径（管理端要能拼试听地址），Cocos 认不带扩展名的资源路径，
   * 转换只在 `audioResPathOf` 一处做。
   *
   * @returns clip；加载失败返回 null（调用方不播，不打日志 —— 这里已经 warn 过）
   */
  private static clipOf(filePath: string): Promise<AudioClip | null> {
    const path = audioResPathOf(filePath);
    const cached = this.clips.get(path);
    if (cached) return Promise.resolve(cached);
    const pending = this.loading.get(path);
    if (pending) return pending;
    const task = loadResourceAsync<AudioClip>(path, AudioClip)
      .then((clip) => {
        this.clips.set(path, clip);
        return clip;
      })
      .catch((error: unknown) => {
        // 资源包里没有这个文件是最常见的原因（运营填了路径但没随资源包发版）
        console.warn(`[sound] 音频加载失败，本次不播：${path}`, error);
        return null;
      })
      // 收尾用 then 而不是 finally（客户端 tsconfig 的 lib 不到 ES2018，TS2550）
      .then((clip) => {
        this.loading.delete(path);
        return clip;
      });
    this.loading.set(path, task);
    return task;
  }
}
