import GameEffectUiHelper from "../helpers/GameEffectUiHelper";
import LayerHelper from "../helpers/LayerHelper";

const EffectFrame = {
  // 自己升级特效播放
  selfUpgrade() {
    LayerHelper.addToUILayer(GameEffectUiHelper.createUpgradeEffect());
  },
};

export default EffectFrame;
