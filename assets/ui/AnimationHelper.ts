import { Animation, AnimationClip, Node, resources, SpriteFrame } from "cc";

const AnimationHelper = {
  // 加载并仅播放一次后销毁
  playOnce(name: string, node: Node, spriteFramesSrc: string, time: number = 1) {
    resources.loadDir(spriteFramesSrc, SpriteFrame, (err, spriteFrames) => {
      if (err) {
        console.log(`${name}动画帧加载失败：${err.message}`);
        return;
      }
      spriteFrames = spriteFrames.sort((a, b) => Number(a.name) - Number(b.name));
      // 加载成功直接播放
      // 给node添加动画属性
      const animation = node.addComponent(Animation);
      const clip = AnimationClip.createWithSpriteFrames(spriteFrames, spriteFrames.length / time);
      clip.wrapMode = AnimationClip.WrapMode.Normal;
      clip.enableTrsBlending = false;
      clip.name = name;
      animation.addClip(clip, name);
      animation.on(Animation.EventType.FINISHED, () => {
        console.log("播放完成");
        node.destroy();
      });
      animation.play(name);
    });
  },
};

export default AnimationHelper;
