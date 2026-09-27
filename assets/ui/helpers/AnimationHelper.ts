import { Animation, AnimationClip, isValid, Node, resources, SpriteFrame } from "cc";
import { roleAnimationMap } from "../../configs/game";

const AnimationHelper = {
  /**
   * 通过文件夹加载并仅播放一次后销毁
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param time 动画播放时间
   */
  playOnceWithDir(name: string, node: Node, dirSrc: string, time: number = 1) {
    resources.loadDir(dirSrc, SpriteFrame, (err, spriteFrames) => {
      if (err) {
        console.error(`${name}动画帧加载失败：${err.message}`);
        return;
      }
      spriteFrames = spriteFrames.sort((a, b) => Number(a.name) - Number(b.name));
      AnimationHelper.play(name, node, spriteFrames, time, AnimationClip.WrapMode.Normal);
    });
  },

  /**
   * 通过plist加载并仅播放一次后销毁
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param plistsrc 动画帧地址
   * @param time 动画播放时间
   */
  playOnceWithPlist(name: string, node: Node, plistsrc: string, time: number = 1) {},

  /**
   * 播放的方法
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param spriteFrames 动画帧列表
   * @param time 动画播放时间
   * @param wrapMode 播放模式
   */
  play(name: string, node: Node, spriteFrames: SpriteFrame[], time: number = 1, wrapMode: AnimationClip.WrapMode) {
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
  },

  /**
   *
   * 通过文件夹加载并循环播放
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param time 动画播放时间
   */
  playLoopWithDir(name: string, node: Node, dirSrc: string, time: number = 1) {
    resources.loadDir(dirSrc, SpriteFrame, (err, spriteFrames) => {
      if (err) {
        console.error(`${name}动画帧加载失败：${err.message}`);
        return;
      }
      spriteFrames = spriteFrames.sort((a, b) => Number(a.name) - Number(b.name));
      AnimationHelper.play(name, node, spriteFrames, time, AnimationClip.WrapMode.Loop);
    });
  },

  /**
   * 使用角色动画
   * @param name 首次播放动画名称
   * @param node 播放动画的节点
   * @param dirSrc 动画帧存放的文件夹
   * @param time 动画播放时间
   */
  useRoleAnimation(name: string, node: Node, dirSrc: string, time: number = 1) {
    const animate = node.addComponent(Animation);
    resources.loadDir(dirSrc, SpriteFrame, (err, spriteFrames) => {
      if (err) {
        console.error(`${name}动画帧加载失败：${err.message}`);
        return;
      }
      if (!isValid(node) || !isValid(animate) || !spriteFrames?.length) return;
      AnimationHelper.spliceAnimation(roleAnimationMap, spriteFrames, animate);
      animate.play(name);
    });
    return animate;
  },

  /**
   * 动画切割成多个
   */
  spliceAnimation(animationMap: Map<string, number[]>, spriteFrames: SpriteFrame[], animate: Animation) {
    animationMap.forEach((value, key) => {
      // 有效动画帧过滤
      const validSpriteFrames = spriteFrames.filter((spriteFrame) => value.indexOf(Number(spriteFrame.name)) >= 0 && spriteFrame.getRect().width > 1 && spriteFrame.getRect().height > 1);
      if (validSpriteFrames.length > 0) AnimationHelper.createAnimation(key, validSpriteFrames, animate);
    });
    // // 完成后首次播放动画
    // RoleDisplayFrame.updateAnimationPlay();
  },
  /**
   * 切割后创建动画
   * @param name 动画名称
   * @param spriteFrames 动画帧
   */
  createAnimation(name: string, spriteFrames: SpriteFrame[], animate: Animation) {
    const clip = AnimationClip.createWithSpriteFrames(spriteFrames, spriteFrames.length);
    clip.wrapMode = AnimationClip.WrapMode.Loop;
    clip.enableTrsBlending = false;
    clip.name = name;
    animate.addClip(clip, name);
  },
};

export default AnimationHelper;
