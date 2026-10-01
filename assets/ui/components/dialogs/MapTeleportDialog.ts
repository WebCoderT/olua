import { Node, Vec2, Size } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { maps } from "../../../configs/map";
import { MapId } from "../../../types/map";

/**
 * 地图传送弹窗
 * 弹窗由通用零件（弹窗框/大按钮）拼装，本类负责打开与地图选择事件
 */
export default class MapTeleportDialog {
  /** 打开弹窗 */
  open() {
    const dialog = GameUiHelper.createDialog("map_teleport_dialog", "大陆传送官");
    const grid = GameUiHelper.createColumn("map_teleport_grid", 10, new Vec2(0, 198), new Size(580, 0));
    for (const key of maps.keys()) {
      const button = GameUiHelper.createSmallButtion(`map_button_${key}`, maps.get(key).label);
      grid.addChild(button);
      button.on(Node.EventType.TOUCH_END, () => StorageManager.changeOnMap(key as MapId));
    }
    dialog.addChild(grid);
    LayerManager.addToUILayer(dialog);
  }
}
