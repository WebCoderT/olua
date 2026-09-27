import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "../utils/LayerManager";

const MapSelectorDialog = {
  //打开
  open() {
    const dialog = GameUiHelper.createDialog("map_selector", "大陆传送官");
    LayerManager.addToUILayer(dialog);
  },
};

export default MapSelectorDialog;
