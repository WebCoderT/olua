import { Animation, AnimationClip, isValid, Node, resources, SpriteAtlas, SpriteFrame } from "cc";
import { monsterAnimation, roleAnimationMap } from "../../configs/animation";
import { AnimationKind, SpeedRate } from "../../types/animation";

/**
 * 动画助手（静态类）
 * 帧动画的加载、切割与播放，并对**目录**做两级缓存，避免同一套帧被反复加载与切割：
 * - 帧序列缓存：一个目录只向引擎请求一次（同一套外观被多只怪物/多个 NPC 引用时不再重复扫描与解码）
 * - 动画片段缓存：一个目录按动画表只切割一次，多个节点共用同一批片段（节点只是 addClip 引用，不重复造片段）
 * 预加载（core/PreloadManager）先调用 prepare* 之后，节点创建时动画是**同步**建好的，
 * 不再出现"先生成节点、动画稍后异步补上"的空档与卡顿；
 * 没有预加载的目录仍走异步加载兜底（例如运行中换上的新装备外观）
 * 缓存不释放：工程内没有任何 release/autoRelease 调用（场景 autoReleaseAssets 默认 false），
 * 帧与片段在切场景后依然有效，可以放心复用
 */
export default class AnimationHelper {
  /** 帧序列缓存：目录 -> 已按帧序号排序的帧列表（空数组表示该目录没有可用帧，同样缓存以免反复请求） */
  private static frameCache = new Map<string, SpriteFrame[]>();
  /** 加载中的目录（同一目录并发请求只真正加载一次） */
  private static frameLoading = new Map<string, Promise<SpriteFrame[]>>();
  /** 片段缓存：缓存键 -> 动画名 -> 片段 */
  private static clipCache = new Map<string, Map<string, AnimationClip>>();
  /** 图集帧缓存：图集资源路径 -> 已按帧序号排序的帧列表（空数组同样缓存以免反复请求） */
  private static atlasFrameCache = new Map<string, SpriteFrame[]>();
  /** 加载中的图集（同一图集并发请求只真正加载一次） */
  private static atlasFrameLoading = new Map<string, Promise<SpriteFrame[]>>();

  //#region 预加载与缓存

  /**
   * 取一个目录的帧序列（已缓存则立即返回；并发请求同一目录只会加载一次）
   * @param dirSrc 帧动画目录（resources 下的路径）
   */
  static loadFrames(dirSrc: string): Promise<SpriteFrame[]> {
    const cached = this.frameCache.get(dirSrc);
    if (cached) return Promise.resolve(cached);
    const loading = this.frameLoading.get(dirSrc);
    if (loading) return loading;
    const task = new Promise<SpriteFrame[]>((resolve) => {
      resources.loadDir(dirSrc, SpriteFrame, (err, spriteFrames) => {
        if (err) {
          // 空结果同样入缓存：目录配错时只报一次错，不会因为每次生成节点都重试而刷屏
          console.error(`${dirSrc} 动画帧加载失败：${err.message}`);
          this.frameCache.set(dirSrc, []);
          resolve([]);
          return;
        }
        // 目录帧名兼容两种形态：纯数字（0000）与前缀名（sfx_13001_0_0003），统一取末尾连续数字排序
        const frames = (spriteFrames ?? []).sort((a, b) => this.nameOrder(a.name) - this.nameOrder(b.name));
        this.frameCache.set(dirSrc, frames);
        resolve(frames);
      });
    }).then((frames) => {
      this.frameLoading.delete(dirSrc);
      return frames;
    });
    this.frameLoading.set(dirSrc, task);
    return task;
  }

  /**
   * 预加载一个目录：先取帧序列，再按动画表把整包片段切割并缓存
   * 重复调用是廉价的（已缓存时立即返回）；"frames" 种类只缓存帧序列（整包循环播放的动画如 NPC 外观）
   * @param dirSrc 帧动画目录
   * @param kind 动画种类（决定用哪张动画表切割）
   * @param speedRate 速度倍率（role/monster 切割片段用，缺省按每秒 1 帧）
   */
  static async prepare(dirSrc: string, kind: AnimationKind, speedRate?: SpeedRate): Promise<void> {
    const frames = await this.loadFrames(dirSrc);
    const animationMap = getAnimationMap(kind);
    if (!animationMap || !frames.length) return;
    this.buildClips(animationMap, frames, this.clipKey(dirSrc, kind, speedRate), speedRate);
  }

  /**
   * 片段缓存键：动画种类 + 目录 + 速度倍率
   * 速度倍率影响每帧时长，因此不同倍率不能共用同一批片段（角色换装/改速度后仍能取到正确的片段）
   */
  private static clipKey(dirSrc: string, kind: AnimationKind, speedRate?: SpeedRate) {
    // 缓存键里要拼上整套速度倍率，逐项拼接用 for in（工程 tsconfig 的 lib 不含 Object.values）
    let rate = "";
    for (const action in speedRate) rate += `${action}=${speedRate[action]};`;
    return `${kind}|${dirSrc}|${rate}`;
  }

  /** 目录帧排序序号：取帧名末尾的连续数字（纯数字名与前缀名通用），取不到按 0 处理 */
  private static nameOrder(name: string) {
    const match = name.match(/(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  /** 切割并缓存整包片段（已缓存时直接返回） */
  private static buildClips(animationMap: Map<string, number[]>, spriteFrames: SpriteFrame[], cacheKey: string, speedRate?: SpeedRate) {
    const cached = this.clipCache.get(cacheKey);
    if (cached) return cached;
    const clips = new Map<string, AnimationClip>();
    animationMap.forEach((frameIndexes, name) => {
      // 有效动画帧过滤（帧序号命中该动作，且帧本身不是空图）
      const validSpriteFrames = spriteFrames.filter((spriteFrame) => frameIndexes.indexOf(Number(spriteFrame.name)) >= 0 && spriteFrame.getRect().width > 1 && spriteFrame.getRect().height > 1);
      if (validSpriteFrames.length) clips.set(name, this.createClip(name, validSpriteFrames, this.getFrameTime(name, speedRate)));
    });
    this.clipCache.set(cacheKey, clips);
    return clips;
  }

  /** 取动作的每帧时长（速度倍率中的键名被动画名包含即命中，缺省 1 秒/帧） */
  private static getFrameTime(name: string, speedRate?: SpeedRate) {
    let time = 1;
    for (const rate in speedRate) {
      if (name.includes(rate)) time = speedRate[rate];
    }
    return time;
  }

  /** 创建动画片段（片段由缓存持有并被多个节点共用，创建后不再修改） */
  private static createClip(name: string, spriteFrames: SpriteFrame[], time: number) {
    const clip = AnimationClip.createWithSpriteFrames(spriteFrames, spriteFrames.length * time);
    clip.wrapMode = AnimationClip.WrapMode.Normal;
    clip.enableTrsBlending = false;
    clip.name = name;
    return clip;
  }

  /** 把整包片段装到动画组件上（同名片段重复装载是安全的：引擎会先停掉旧状态再覆盖） */
  private static applyClips(animate: Animation, clips: Map<string, AnimationClip>) {
    // 复用动画组件的节点（如换装后的角色）必须先清掉旧片段：
    // 旧外观里有、新外观里没有的动作会残留下来，play 时会被播成上一套外观的动画
    if (animate.clips.length) animate.clips = [];
    clips.forEach((clip, name) => animate.addClip(clip, name));
  }

  /** 取节点上的动画组件（已有则复用，避免同一节点上叠加多个 Animation 互相抢帧） */
  private static useAnimation(node: Node) {
    return node.getComponent(Animation) ?? node.addComponent(Animation);
  }

  //#endregion

  //#region 图集帧（TexturePacker plist 图集）

  /**
   * 取一个 TexturePacker 图集（plist）里的全部帧（已按帧序号排序；缓存规则与目录帧一致）
   * 同一个动画被切成多页时（如 s_1102@0 / s_1102@1）会把各页合并成一整条帧序列
   * @param atlasSrc 图集资源路径（resources 下 plist 的路径，不含扩展名，如 "effect/skill/s_1002@0"）
   */
  static loadFramesFromAtlas(atlasSrc: string): Promise<SpriteFrame[]> {
    const cached = this.atlasFrameCache.get(atlasSrc);
    if (cached) return Promise.resolve(cached);
    const loading = this.atlasFrameLoading.get(atlasSrc);
    if (loading) return loading;
    const task = this.loadAtlasFrames(atlasSrc).then((frames) => {
      // 空结果同样入缓存：路径写错时只报一次错，不会因为每次生成节点都重试而刷屏
      if (!frames.length) console.error(`${atlasSrc} 图集帧加载失败`);
      this.atlasFrameCache.set(atlasSrc, frames);
      this.atlasFrameLoading.delete(atlasSrc);
      return frames;
    });
    this.atlasFrameLoading.set(atlasSrc, task);
    return task;
  }

  /** 加载图集的全部分页帧（同一个动画被切成多页时合并成一整条帧序列） */
  private static async loadAtlasFrames(atlasSrc: string): Promise<SpriteFrame[]> {
    const frames: SpriteFrame[] = [];
    for (const page of this.atlasPagePaths(atlasSrc)) {
      const atlas = await this.loadAtlas(page);
      if (atlas) this.collectFrames(atlas, frames);
    }
    return frames.length ? this.sortFrames(frames) : this.loadFramesByDir(atlasSrc);
  }

  /** 图集动作帧缓存：图集路径|动作名 -> 该动作的帧列表（空数组同样缓存以免反复请求） */
  private static atlasActionFrameCache = new Map<string, SpriteFrame[]>();

  /**
   * 取一个图集里某个动作的全部帧（帧名含「/动作名/」即命中，如 wing/100001/stand/40000.png）
   * 图集本身含多套动作（attack/run/stand…），整条播放会串动作，因此按动作过滤；已按帧序号排序
   * @param atlasSrc 图集资源路径（resources 下 plist 的路径，不含扩展名）
   * @param action 动作名（图集帧路径里的一段，如 "stand"）
   */
  static async loadFramesFromAtlasByAction(atlasSrc: string, action: string): Promise<SpriteFrame[]> {
    const cacheKey = `${atlasSrc}|${action}`;
    const cached = this.atlasActionFrameCache.get(cacheKey);
    if (cached) return cached;
    const frames = (await this.loadFramesFromAtlas(atlasSrc)).filter((frame) => frame.name.includes(`/${action}/`));
    this.atlasActionFrameCache.set(cacheKey, frames);
    return frames;
  }

  /**
   * 取同名图集的全部分页路径（含传入的那一页，如 effect/skill/s_1102@0 / s_1102@1）
   * 目录索引是同步查询：不加载资源、缺页也不会报错；索引拿不到时只加载传入的那一页
   */
  private static atlasPagePaths(atlasSrc: string): string[] {
    const slash = atlasSrc.lastIndexOf("/");
    if (slash < 0) return [atlasSrc];
    const page = atlasSrc.slice(slash + 1);
    const name = page.split("@")[0];
    const paths = resources
      .getDirWithPath(atlasSrc.slice(0, slash), SpriteAtlas)
      .map((info) => info.path)
      .filter((path) => {
        const pageName = path.slice(path.lastIndexOf("/") + 1);
        return pageName === page || pageName.startsWith(`${name}@`);
      })
      .sort();
    return paths.length ? paths : [atlasSrc];
  }

  /** 加载一页图集（加载不到返回 null） */
  private static loadAtlas(atlasSrc: string): Promise<SpriteAtlas | null> {
    return new Promise((resolve) => {
      resources.load(atlasSrc, SpriteAtlas, (err, atlas) => resolve(!err && atlas ? atlas : null));
    });
  }

  /**
   * 退路：按目录加载图集，再用帧名前缀匹配目标（同名 png 与 plist 路径相同，路径查询可能命中图片资源）
   * 帧名前缀 = 图集文件名去掉 @分页 后缀（auto_attack@0 -> 帧名 auto_attack/00000）
   */
  private static loadFramesByDir(atlasSrc: string): Promise<SpriteFrame[]> {
    return new Promise((resolve) => {
      const slash = atlasSrc.lastIndexOf("/") + 1;
      const prefix = atlasSrc.slice(slash).split("@")[0];
      resources.loadDir(atlasSrc.slice(0, slash - 1), SpriteAtlas, (err, atlases) => {
        const target = (atlases ?? []).find((item) => (item.getSpriteFrames().find((frame) => !!frame)?.name ?? "").startsWith(`${prefix}/`));
        if (err || !target) {
          resolve([]);
          return;
        }
        const frames: SpriteFrame[] = [];
        this.collectFrames(target, frames);
        resolve(this.sortFrames(frames));
      });
    });
  }

  /** 收集一页图集里的有效帧（spriteFrames 属性是名字字典，取数组用 getSpriteFrames） */
  private static collectFrames(atlas: SpriteAtlas, out: SpriteFrame[]) {
    atlas.getSpriteFrames().forEach((frame) => {
      if (frame) out.push(frame);
    });
  }

  /**
   * 帧序列排序：按帧名末尾的帧序号升序
   * 帧名形如 "auto_attack/00000" 或 "1002/attack/00000.png"（带扩展名），取不到序号时按 0 处理
   */
  private static sortFrames(frames: SpriteFrame[]) {
    return frames.sort((a, b) => this.frameOrder(a) - this.frameOrder(b));
  }

  /** 帧序号：帧名最后一段去掉扩展名后的数字 */
  private static frameOrder(frame: SpriteFrame) {
    const order = Number((frame.name.split("/").pop() ?? "").replace(/\.[^.]*$/, ""));
    return order > 0 ? order : 0;
  }

  //#endregion

  //#region 一次性 / 循环播放

  /**
   * 通过文件夹加载帧动画并仅播放一次后销毁节点
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param duration 动画总时长（秒）
   */
  static playOnceWithDir(name: string, node: Node, dirSrc: string, duration: number = 1) {
    const animate = this.useAnimation(node);
    this.loadFrames(dirSrc).then((spriteFrames) => {
      if (!isValid(node) || !isValid(animate) || !spriteFrames.length) return;
      this.play(name, node, animate, spriteFrames, duration, AnimationClip.WrapMode.Normal);
    });
  }

  /**
   * 通过文件夹加载帧动画并循环播放
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param duration 动画总时长（秒）
   */
  static playLoopWithDir(name: string, node: Node, dirSrc: string, duration: number = 1) {
    const animate = this.useAnimation(node);
    this.loadFrames(dirSrc).then((spriteFrames) => {
      if (!isValid(node) || !isValid(animate) || !spriteFrames.length) return;
      this.play(name, node, animate, spriteFrames, duration, AnimationClip.WrapMode.Loop);
    });
  }

  /**
   * 使用已有帧列表循环播放（图集帧等非目录来源，见 loadFramesFromAtlas）
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param spriteFrames 帧列表（顺序即播放顺序）
   * @param frameRate 每秒帧数（如 20 表示每秒 20 帧，一轮循环时长 = 帧数 / 帧率）
   */
  static playLoopWithFrames(name: string, node: Node, spriteFrames: SpriteFrame[], frameRate: number) {
    if (!spriteFrames.length) return;
    const animate = this.useAnimation(node);
    this.play(name, node, animate, spriteFrames, spriteFrames.length / this.normalizeFrameRate(frameRate), AnimationClip.WrapMode.Loop);
  }

  /**
   * 使用已有帧列表播放一次后销毁节点（图集帧等非目录来源，如技能特效）
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param spriteFrames 帧列表（顺序即播放顺序）
   * @param duration 动画总时长（秒）：与角色动作动画同一口径
   *        （角色动作动画总时长 = 1 / speedRate，见 configs/role 的 defaultRoleSpeedRate）
   */
  static playOnceWithFrames(name: string, node: Node, spriteFrames: SpriteFrame[], duration: number) {
    if (!spriteFrames.length) return;
    const animate = this.useAnimation(node);
    this.play(name, node, animate, spriteFrames, duration > 0 ? duration : spriteFrames.length, AnimationClip.WrapMode.Normal);
  }

  /**
   * 使用已有帧列表播放一次并停在尾帧（图集帧等非目录来源，如状态特效）
   * 与 playOnceWithFrames 的区别：播完后**不销毁节点**，保留尾帧画面（护体神盾这类「驻场」特效用）
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param spriteFrames 帧列表（顺序即播放顺序）
   * @param frameRate 每秒帧数（如 12 表示每秒 12 帧，一轮时长 = 帧数 / 帧率）
   */
  static playOnceHoldWithFrames(name: string, node: Node, spriteFrames: SpriteFrame[], frameRate: number) {
    if (!spriteFrames.length) return;
    const animate = this.useAnimation(node);
    const clip = AnimationClip.createWithSpriteFrames(spriteFrames, this.normalizeFrameRate(frameRate));
    // Normal 播完停在尾帧（引擎行为）；不注册 FINISHED 销毁，让画面驻留
    clip.wrapMode = AnimationClip.WrapMode.Normal;
    clip.enableTrsBlending = false;
    clip.name = name;
    animate.addClip(clip, name);
    animate.play(name);
  }

  /** 帧率合法性归一（非正数视为每秒 1 帧，避免除零） */
  private static normalizeFrameRate(frameRate: number) {
    return frameRate > 0 ? frameRate : 1;
  }

  //#endregion

  //#region 帧动画切割

  /**
   * 使用角色动画（按游戏配置 roleAnimationMap 切割帧动画）
   * @param name 首次播放动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param speedRate 速度倍率
   */
  static useRoleAnimation(name: string, node: Node, dirSrc: string, speedRate: SpeedRate) {
    return this.useManyNameAnimation(name, node, dirSrc, speedRate, "role");
  }

  /**
   * 使用怪物动画（按游戏配置 monsterAnimation 切割帧动画）
   * @param name 首次播放动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param speedRate 速度倍率
   */
  static useMonsterAnimation(name: string, node: Node, dirSrc: string, speedRate: SpeedRate) {
    return this.useManyNameAnimation(name, node, dirSrc, speedRate, "monster");
  }

  /**
   * 按名称映射表将整包帧动画切割为多段动画并加载
   * 已预加载（片段有缓存）时同步装好片段并播放；未预加载时异步加载并在完成后补上（节点已返回，调用方可先挂事件）
   * @param name 首次播放动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param speedRate 速度倍率
   * @param kind 动画种类
   */
  static useManyNameAnimation(name: string, node: Node, dirSrc: string, speedRate: SpeedRate, kind: AnimationKind) {
    const animate = this.useAnimation(node);
    const clips = this.clipCache.get(this.clipKey(dirSrc, kind, speedRate));
    if (clips) {
      this.applyClips(animate, clips);
      animate.play(name);
      return animate;
    }
    this.prepare(dirSrc, kind, speedRate).then(() => {
      if (!isValid(node) || !isValid(animate)) return;
      const prepared = this.clipCache.get(this.clipKey(dirSrc, kind, speedRate));
      if (!prepared) return;
      this.applyClips(animate, prepared);
      animate.play(name);
    });
    return animate;
  }

  //#endregion

  //#region 播放

  /**
   * 播放帧动画（整包帧按顺序切成一段）
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param animate 动画组件
   * @param spriteFrames 动画帧列表
   * @param duration 动画总时长（秒）：引擎的片段帧率按「帧数 / 时长」折算
   * @param wrapMode 播放模式（Normal 播完自动销毁节点）
   */
  private static play(name: string, node: Node, animate: Animation, spriteFrames: SpriteFrame[], duration: number, wrapMode: AnimationClip.WrapMode) {
    const clip = AnimationClip.createWithSpriteFrames(spriteFrames, spriteFrames.length / duration);
    clip.wrapMode = wrapMode;
    clip.enableTrsBlending = false;
    clip.name = name;
    animate.addClip(clip, name);
    if (wrapMode === AnimationClip.WrapMode.Normal)
      animate.on(Animation.EventType.FINISHED, () => {
        node.destroy();
      });
    animate.play(name);
  }

  //#endregion
}

/** 取动画种类对应的动画表（frames 种类不切割，只需帧序列） */
function getAnimationMap(kind: AnimationKind) {
  if (kind === "role") return roleAnimationMap;
  if (kind === "monster") return monsterAnimation;
  return null;
}
