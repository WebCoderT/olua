import { Animation, AnimationClip, isValid, Node, resources, SpriteFrame } from "cc";
import { monsterAnimation, roleAnimationMap } from "../../configs/animation";
import { SpeedRate } from "../../types/animation";

/**
 * 动画助手（静态类）
 * 帧动画的加载、切割与播放
 */
export default class AnimationHelper {
  //#region 一次性 / 循环播放

  /**
   * 通过文件夹加载帧动画并仅播放一次后销毁节点
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param time 动画播放时间
   */
  static playOnceWithDir(name: string, node: Node, dirSrc: string, time: number = 1) {
    resources.loadDir(dirSrc, SpriteFrame, (err, spriteFrames) => {
      if (err) {
        console.error(`${name}动画帧加载失败：${err.message}`);
        return;
      }
      spriteFrames = spriteFrames.sort((a, b) => Number(a.name) - Number(b.name));
      this.play(name, node, spriteFrames, time, AnimationClip.WrapMode.Normal);
    });
  }

  /**
   * 通过文件夹加载帧动画并循环播放
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param time 动画播放时间
   */
  static playLoopWithDir(name: string, node: Node, dirSrc: string, time: number = 1) {
    resources.loadDir(dirSrc, SpriteFrame, (err, spriteFrames) => {
      if (err) {
        console.error(`${name}动画帧加载失败：${err.message}`);
        return;
      }
      spriteFrames = spriteFrames.sort((a, b) => Number(a.name) - Number(b.name));
      this.play(name, node, spriteFrames, time, AnimationClip.WrapMode.Loop);
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
    return this.useManyNameAnimation(name, node, dirSrc, speedRate, roleAnimationMap);
  }

  /**
   * 使用怪物动画（按游戏配置 monsterAnimation 切割帧动画）
   * @param name 首次播放动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param speedRate 速度倍率
   */
  static useMonsterAnimation(name: string, node: Node, dirSrc: string, speedRate: SpeedRate) {
    return this.useManyNameAnimation(name, node, dirSrc, speedRate, monsterAnimation);
  }

  /**
   * 按名称映射表将整包帧动画切割为多段动画并加载
   * @param name 首次播放动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param speedRate 速度倍率
   * @param map 动画名称到帧序号列表的映射
   */
  static useManyNameAnimation(name: string, node: Node, dirSrc: string, speedRate: SpeedRate, map: Map<string, number[]>) {
    const animate = node.addComponent(Animation);
    resources.loadDir(dirSrc, SpriteFrame, (err, spriteFrames) => {
      if (err) {
        console.error(`${name}动画帧加载失败：${err.message}`);
        return;
      }
      if (!isValid(node) || !isValid(animate) || !spriteFrames?.length) return;
      this.spliceAnimation(map, spriteFrames, animate, speedRate);
      animate.play(name);
    });
    return animate;
  }

  /**
   * 动画切割成多个
   */
  static spliceAnimation(animationMap: Map<string, number[]>, spriteFrames: SpriteFrame[], animate: Animation, speedRate: SpeedRate) {
    animationMap.forEach((value, key) => {
      // 有效动画帧过滤
      const validSpriteFrames = spriteFrames.filter((spriteFrame) => value.indexOf(Number(spriteFrame.name)) >= 0 && spriteFrame.getRect().width > 1 && spriteFrame.getRect().height > 1);
      let time = 1;
      for (const rate in speedRate) {
        const element = speedRate[rate];
        if (key.includes(rate)) {
          time = element;
        }
      }
      if (validSpriteFrames.length > 0) this.createAnimation(key, validSpriteFrames, animate, time);
    });
  }

  /**
   * 切割后创建动画片段
   * @param name 动画名称
   * @param spriteFrames 动画帧
   */
  static createAnimation(name: string, spriteFrames: SpriteFrame[], animate: Animation, time: number = 1) {
    const clip = AnimationClip.createWithSpriteFrames(spriteFrames, spriteFrames.length * time);
    clip.wrapMode = AnimationClip.WrapMode.Normal;
    clip.enableTrsBlending = false;
    clip.name = name;
    animate.addClip(clip, name);
  }

  //#endregion

  //#region 播放

  /**
   * 播放帧动画
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param spriteFrames 动画帧列表
   * @param time 动画播放时间
   * @param wrapMode 播放模式（Normal 播完自动销毁节点）
   */
  static play(name: string, node: Node, spriteFrames: SpriteFrame[], time: number = 1, wrapMode: AnimationClip.WrapMode) {
    const animation = node.addComponent(Animation);
    const clip = AnimationClip.createWithSpriteFrames(spriteFrames, spriteFrames.length / time);
    clip.wrapMode = wrapMode;
    clip.enableTrsBlending = false;
    clip.name = name;
    animation.addClip(clip, name);
    if (wrapMode === AnimationClip.WrapMode.Normal)
      animation.on(Animation.EventType.FINISHED, () => {
        node.destroy();
      });
    animation.play(name);
  }

  //#endregion
}
