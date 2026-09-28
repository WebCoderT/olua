import { Node, Size, Vec2 } from "cc";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "../utils/LayerManager";
import UiHelper from "../helpers/UiHelper";
import { maps } from "../../configs/map";
import MapFrame from "./MapFrame";
import StorageManager from "../utils/StorageManager";

const MapSelectorDialog = {
  //打开
  open() {
    const dialog = GameUiHelper.createDialog("map_selector", "大陆传送官");
    LayerManager.addToUILayer(dialog);
    MapSelectorDialog.createSelectorButtons(dialog);
  },
  // 添加传送按钮
  createSelectorButtons(dialog: Node) {
    const grid = UiHelper.createFlexCol("grid", 10, new Vec2(0, 198), new Size(580, 0));

    // // 安全区
    // const safe = UiHelper.createLabel("safe", "安全区域", Color.GREEN, 18, new Vec2(), new Size(680, 30));
    // grid.addChild(safe);

    for (const key of maps.keys()) {
      const map = maps.get(key);
      const button = GameUiHelper.createBigButton("map_selector", map.label);
      grid.addChild(button);
      button.on(
        Node.EventType.TOUCH_END,
        () => {
          StorageManager.changeOnMap(key);
          MapFrame.init();
        },
        this,
      );
    }

    dialog.addChild(grid);
  },
};

export default MapSelectorDialog;
