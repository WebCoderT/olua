import { Node, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { mapTypeGroups, maps } from "../../../configs/map";
import { MapId, MapType } from "../../../types/map";
import { mapTeleportDialogLayout } from "../../../configs/hudLayout";

/**
 * 地图传送弹窗
 * 按 MapType 分组展示所有地图：每个分组一个标题 + 网格排列的地图按钮，
 * 内容区纵向排列、高度自适应，新增地图只需在 configs/map.ts 登记配置
 */
export default class MapTeleportDialog {
  /** 打开弹窗 */
  open() {
    // 布局见 configs/hudLayout.mapTeleportDialogLayout（内容区宽度固定、高度自适应）
    const layout = mapTeleportDialogLayout;
    const dialog = GameUiHelper.createDialog(layout.name, layout.title);
    const content = GameUiHelper.createColumn(layout.content.name, layout.content.groupSpacing, new Vec2(0, layout.content.top), new Size(layout.content.width, 0));
    // 按地图类型分桶（保持 configs/map.ts 的登记顺序）
    const grouped = new Map<MapType, MapId[]>();
    maps.forEach((config, id) => {
      const ids = grouped.get(config.type) ?? [];
      ids.push(id);
      grouped.set(config.type, ids);
    });
    for (const group of mapTypeGroups) {
      const ids = grouped.get(group.type);
      if (!ids || !ids.length) continue;
      // 分组标题
      content.addChild(
        GameUiHelper.createText(`map_group_title_${group.type}`, group.label, layout.groupTitle.fontSize, new Vec2(), new Size(layout.content.width, layout.groupTitle.height), layout.groupTitle.color),
      );
      // 地图按钮网格（宽度固定、高度自适应）
      const grid = GameUiHelper.createGrid(`map_grid_${group.type}`, layout.grid.spacingX, layout.grid.spacingY, new Vec2(), new Size(layout.content.width, 0));
      for (const id of ids) {
        const button = GameUiHelper.createMiddleButton(`map_button_${id}`, maps.get(id).label);
        grid.addChild(button);
        button.on(Node.EventType.TOUCH_END, () => StorageManager.changeOnMap(id as MapId));
      }
      content.addChild(grid);
    }
    dialog.addChild(content);
    LayerManager.addToUILayer(dialog);
  }
}
