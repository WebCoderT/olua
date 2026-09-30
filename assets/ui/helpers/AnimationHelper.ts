import { Animation, AnimationClip, isValid, Node, resources, SpriteFrame } from "cc";
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
        const frames = (spriteFrames ?? []).sort((a, b) => Number(a.name) - Number(b.name));
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

  //#region 一次性 / 循环播放

  /**
   * 通过文件夹加载帧动画并仅播放一次后销毁节点
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param time 动画播放时间（每帧时长）
   */
  static playOnceWithDir(name: string, node: Node, dirSrc: string, time: number = 1) {
    const animate = this.useAnimation(node);
    this.loadFrames(dirSrc).then((spriteFrames) => {
      if (!isValid(node) || !isValid(animate) || !spriteFrames.length) return;
      this.play(name, node, animate, spriteFrames, time, AnimationClip.WrapMode.Normal);
    });
  }

  /**
   * 通过文件夹加载帧动画并循环播放
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param time 动画播放时间（每帧时长）
   */
  static playLoopWithDir(name: string, node: Node, dirSrc: string, time: number = 1) {
    const animate = this.useAnimation(node);
    this.loadFrames(dirSrc).then((spriteFrames) => {
      if (!isValid(node) || !isValid(animate) || !spriteFrames.length) return;
      this.play(name, node, animate, spriteFrames, time, AnimationClip.WrapMode.Loop);
    });
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
   * @param time 动画播放时间（每帧时长）
   * @param wrapMode 播放模式（Normal 播完自动销毁节点）
   */
  private static play(name: string, node: Node, animate: Animation, spriteFrames: SpriteFrame[], time: number, wrapMode: AnimationClip.WrapMode) {
    const clip = AnimationClip.createWithSpriteFrames(spriteFrames, spriteFrames.length / time);
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
