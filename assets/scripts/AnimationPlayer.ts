import { _decorator, Animation, AnimationClip, AnimationState, AssetManager, Component, resources, SpriteAtlas } from "cc";
const { ccclass, property } = _decorator;

@ccclass("AnimationPlayer")
export class AnimationPlayer extends Component {
  // 动画名称
  public animationName: string = "";

  // 帧率
  public sample: number = 1;

  // 动画组件播放模式
  public wrapMode: AnimationClip.WrapMode = AnimationClip.WrapMode.Normal;

  // 动画组件
  private animate: Animation;

  // 加载动画
  private loadAnimation() {
    resources.load(this.animationName, SpriteAtlas, (err, spriteAtlas: SpriteAtlas) => {
      if (err) {
        console.error(`${this.animationName} 加载失败`, err);
        return;
      }
      console.log(`${this.animationName} 加载成功`);
      this.createAnimation(spriteAtlas);
    });
  }

  // 创建动画
  private createAnimation(spriteAtlas: SpriteAtlas) {
    const spriteFrames = spriteAtlas.getSpriteFrames();
    // 生成动画剪辑
    const clip = AnimationClip.createWithSpriteFrames(spriteFrames, this.sample);
    clip.wrapMode = this.wrapMode;
    clip.enableTrsBlending = false;
    clip.name = this.animationName;
    this.animate.addClip(clip, this.animationName);
    this.animate.play(this.animationName);
    console.log(`播放：${this.animationName}`);
    // 如果是单次播放，默认播放结束后移除元素
    if (this.wrapMode === AnimationClip.WrapMode.Normal) this.animate.on(Animation.EventType.FINISHED, this.playFinished, this);
  }

  // 播放结束直接销毁当前节点
  private playFinished() {
    this.node.destroy();
  }

  protected start(): void {
    this.animate = this.node.addComponent(Animation);
    this.loadAnimation();
  }
}
