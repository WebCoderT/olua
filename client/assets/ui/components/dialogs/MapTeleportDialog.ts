import { Node, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { mapLabelOf, mapTypeGroups, maps } from "../../../configs/map";
import type { MapId } from "../../../types/map";
import { mapTeleportDialogLayout } from "../../../configs/hudLayout";

/**
 * 地图传送弹窗
 *
 * 按**类型**分组展示地图：每个分组一个标题 + 网格排列的按钮，内容区纵向排列、高度自适应。
 *
 * 数据全部来自服务端配置快照（#573）：分组顺序与标题是 `mapTypeGroups`，每张图的名字与
 * 进入条件是 `maps` —— 客户端不再维护任何一张图的配置，加一张图只改服务端（+ 放 TMX 资源）。
 * 所以这份数据为空时（快照还没到 / 拉取失败）**不渲染空白弹窗**，直接告诉玩家稍后再试。
 */
export default class MapTeleportDialog {
  /** 打开弹窗 */
  open() {
    // 布局见 configs/hudLayout.mapTeleportDialogLayout（内容区宽度固定、高度自适应）
    const layout = mapTeleportDialogLayout;
    const dialog = GameUiHelper.createDialog(layout.name, layout.title);
    const content = GameUiHelper.createColumn(layout.content.name, layout.content.groupSpacing, new Vec2(0, layout.content.top), new Size(layout.content.width, 0));
    // 配置还没到（快照失败 / 刚启动）：不渲染空弹窗，给一句能看懂的提示
    if (maps.size === 0) {
      GameUiHelper.createTip("map_config_loading_tip");
      return;
    }
    // 按地图类型分桶（保持服务端下发的注册顺序）
    const grouped = new Map<string, MapId[]>();
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
        const button = GameUiHelper.createMiddleButton(`map_button_${id}`, mapLabelOf(id));
        grid.addChild(button);
        button.on(Node.EventType.TOUCH_END, () => StorageManager.changeOnMap(id as MapId));
      }
      content.addChild(grid);
    }
    dialog.addChild(content);
    LayerManager.addDialogToUILayer(dialog);
  }
}
