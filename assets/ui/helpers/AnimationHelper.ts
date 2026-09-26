import { Animation, AnimationClip, Node, resources, SpriteFrame } from "cc";

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
      AnimationHelper.playOnce(name, node, spriteFrames, time);
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
   * 播放一次的方法
   * @param name 动画名称
   * @param node 播放动画的节点
   * @param spriteFrames 动画帧列表
   * @param time 动画播放时间
   */
  playOnce(name: string, node: Node, spriteFrames: SpriteFrame[], time: number = 1) {
    const animation = node.addComponent(Animation);
    const clip = AnimationClip.createWithSpriteFrames(spriteFrames, spriteFrames.length / time);
    clip.wrapMode = AnimationClip.WrapMode.Normal;
    clip.enableTrsBlending = false;
    clip.name = name;
    animation.addClip(clip, name);
    animation.on(Animation.EventType.FINISHED, () => {
      node.destroy();
    });
    animation.play(name);
  },
};

export default AnimationHelper;
