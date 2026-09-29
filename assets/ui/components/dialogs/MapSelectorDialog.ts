import { Node, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import UiHelper from "../../helpers/UiHelper";
import { maps } from "../../../configs/map";
import StorageManager from "../../core/StorageManager";

/**
 * 地图传送弹窗
 * 使用处临时实例化（如 NPC 点击时 new），不导出全局单例
 */
export default class MapSelectorDialog {
  /** 打开弹窗 */
  open() {
    const dialog = GameUiHelper.createDialog("map_selector", "大陆传送官");
    this.createSelectorButtons(dialog);
    LayerManager.addToUILayer(dialog);
  }

  /** 添加传送按钮 */
  private createSelectorButtons(dialog: Node) {
    const grid = UiHelper.createFlexCol("grid", 10, new Vec2(0, 198), new Size(580, 0));

    for (const key of maps.keys()) {
      const map = maps.get(key);
      const button = GameUiHelper.createBigButton("map_selector", map.label);
      grid.addChild(button);
      button.on(
        Node.EventType.TOUCH_END,
        () => {
          // 切换地图后由 StorageManager 的地图变更回调触发重新加载
          StorageManager.changeOnMap(key);
        },
        this,
      );
    }

    dialog.addChild(grid);
  }
}
