import GameEffectUiHelper from "../GameEffectUiHelper";
import LayerHelper from "../LayerHelper";

const EffectFrame = {
  // 自己升级特效播放
  selfUpgrade() {
    LayerHelper.addToUILayer(GameEffectUiHelper.createUpgradeEffect());
  },
};

export default EffectFrame;
