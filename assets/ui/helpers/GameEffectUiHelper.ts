import { Size, Vec2 } from "cc";
import UiHelper from "./UiHelper";
import AnimationHelper from "./AnimationHelper";

const GameEffectUiHelper = {
  /**
   * 创建升级特效
   */
  createUpgradeEffect(position: Vec2 = new Vec2()) {
    const upgrade = UiHelper.createSprite("upgrade_effect", "", new Vec2(0, 90), new Size(284, 380));
    AnimationHelper.playOnceWithDir("upgrade", upgrade, "effect/upgrade", 1);
    return upgrade;
  },
};

export default GameEffectUiHelper;
