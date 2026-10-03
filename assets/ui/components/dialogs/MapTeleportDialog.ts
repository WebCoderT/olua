import { Color, Node, Size, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { mapTypeGroups, maps } from "../../../configs/map";
import { MapId, MapType } from "../../../types/map";

/** 地图按钮每行 4 个（网格从左到右排满换行）：4 × 123 + 3 × 20 = 552，在 580 容器内水平居中 */
const MAP_BUTTON_SPACING_X = 20;
/** 地图按钮纵向间距 */
const MAP_BUTTON_SPACING_Y = 12;
/** 各地图分组之间的间距（分组标题与按钮网格同处一个纵向容器，共用该间距） */
const GROUP_SPACING = 16;
/** 内容区宽度（弹窗 600，左右各留 10） */
const CONTENT_WIDTH = 580;
/** 内容区顶部位置（弹窗高 500，弹窗标题下方起排） */
const CONTENT_TOP = 215;
/** 分组标题颜色（金色，与弹窗标题区分层级） */
const GROUP_TITLE_COLOR = new Color(255, 214, 102);

/**
 * 地图传送弹窗
 * 按 MapType 分组展示所有地图：每个分组一个标题 + 网格排列的地图按钮，
 * 内容区纵向排列、高度自适应，新增地图只需在 configs/map.ts 登记配置
 */
export default class MapTeleportDialog {
  /** 打开弹窗 */
  open() {
    const dialog = GameUiHelper.createDialog("map_teleport_dialog", "大陆传送官");
    const content = GameUiHelper.createColumn("map_teleport_content", GROUP_SPACING, new Vec2(0, CONTENT_TOP), new Size(CONTENT_WIDTH, 0));
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
      content.addChild(GameUiHelper.createText(`map_group_title_${group.type}`, group.label, 14, new Vec2(), new Size(CONTENT_WIDTH, 20), GROUP_TITLE_COLOR));
      // 地图按钮网格（宽度固定、高度自适应）
      const grid = GameUiHelper.createGrid(`map_grid_${group.type}`, MAP_BUTTON_SPACING_X, MAP_BUTTON_SPACING_Y, new Vec2(), new Size(CONTENT_WIDTH, 0));
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
