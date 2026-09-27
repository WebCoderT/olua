import GameEffectUiHelper from "../helpers/GameEffectUiHelper";
import LayerManager from "../utils/LayerManager";

const EffectFrame = {
  // 自己升级特效播放
  selfUpgrade() {
    LayerManager.addToUILayer(GameEffectUiHelper.createUpgradeEffect());
  },
};

export default EffectFrame;
