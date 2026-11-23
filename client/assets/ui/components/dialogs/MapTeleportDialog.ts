import { Node, ScrollView, Size, UIOpacity, Vec2 } from "cc";
import GameUiHelper from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import LayerManager from "../../core/LayerManager";
import StorageManager from "../../core/StorageManager";
import { mapLabelOf, mapLevelLocked, mapTypeGroups, maps } from "../../../configs/game-config";
import { uiSize } from "../../../configs/layout/sizes";
import type { MapId } from "../../../types/map";
import { dialogFrame, mapTeleportDialogLayout } from "../../../configs/hudLayout";

/**
 * 地图传送弹窗
 *
 * 按**类型**分组展示地图：每个分组一个标题 + 网格排列的按钮，内容区纵向排列。
 *
 * 每个地图是一个**按钮格**（#1205）：中键按钮 + 下方一行「进入所需等级」（`Lv.N` /「不限」）。
 * 没达到等级的图按钮置灰、点了只提示原因不发传送（判定口径见 `mapLevelLocked`：
 * 不限等级与「角色等级未知」都不锁 —— 宁可放行让服务端拒，也别把能进的图误置灰）。
 *
 * 内容区是**滚动视图**（不是高度自适应的容器）：62 张图挤在一个分组里就是十几行，
 * 自适应高度会直接顶出 600×500 的弹窗 —— 下半截既看不到也点不到。视口固定
 * 580×430（见 `mapTeleportDialogLayout.content`），分组再多也只是滑。
 *
 * 数据全部来自服务端配置快照（#573）：分组顺序与标题是 `mapTypeGroups`，每张图的名字与
 * 进入条件是 `maps` —— 客户端不再维护任何一张图的配置，加一张图只改服务端（+ 放 TMX 资源）。
 * 所以这份数据为空时（快照还没到 / 拉取失败）**不渲染空白弹窗**，直接告诉玩家稍后再试。
 */
export default class MapTeleportDialog {
  /** 打开弹窗 */
  open() {
    // 布局见 configs/hudLayout.mapTeleportDialogLayout（视口尺寸固定、内容可滚动）
    const layout = mapTeleportDialogLayout;
    const dialog = GameUiHelper.createDialog(layout.name, layout.title, new Vec2(), dialogFrame.size, layout.eyebrow);
    // 配置还没到（快照失败 / 刚启动）：不渲染空弹窗，给一句能看懂的提示
    if (maps.size === 0) {
      // 已经建出来的弹窗不能留成孤儿（没进 UI 层，既不显示也不会被场景销毁）
      dialog.destroy();
      GameUiHelper.createTip("map_config_loading_tip");
      return;
    }
    const view = GameUiHelper.createScrollView(layout.content.name, layout.content.position, layout.content.size, layout.content.groupSpacing);
    // 滚动区的 content 自带纵向 Layout：分组标题与网格直接 addChild 就按顺序往下排
    const content = view.getComponent(ScrollView)?.content;
    if (!content) return;
    // 等级门槛要跟「当前角色等级」比：角色数据没到（0）时 mapLevelLocked 一律放行
    const roleLevel = StorageManager.findOnlineRole()?.level ?? 0;
    const buttonSize = uiSize.middleButtonSize;
    const cellSize = new Size(buttonSize.width, buttonSize.height + layout.cell.levelGap + layout.cell.levelHeight);
    /** 按钮在格子里顶对齐：格子里比按钮多出来的高度全给下面的等级行 */
    const buttonY = (cellSize.height - buttonSize.height) / 2;
    /** 等级行中心（格子底边往上半个行高） */
    const levelY = -(cellSize.height - layout.cell.levelHeight) / 2;
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
        GameUiHelper.createText(`map_group_title_${group.type}`, group.label, layout.groupTitle.fontSize, new Vec2(), new Size(layout.content.size.width, layout.groupTitle.height), layout.groupTitle.color),
      );
      // 地图按钮格网格（宽度固定、高度自适应；格子宽 = 按钮宽，所以每行仍是 4 个）
      const grid = GameUiHelper.createGrid(`map_grid_${group.type}`, layout.grid.spacingX, layout.grid.spacingY, new Vec2(), new Size(layout.content.size.width, 0));
      for (const id of ids) {
        // 进入所需等级（服务端 `maps.level`，0 = 不限）：负数 / 小数按 0 / 向下取整归一
        const required = Math.max(0, Math.floor(maps.get(id)?.level ?? 0));
        const locked = mapLevelLocked(required, roleLevel);
        const cell = UiHelper.createNode(`map_cell_${id}`, new Vec2(), cellSize);
        const button = GameUiHelper.createMiddleButton(`map_button_${id}`, mapLabelOf(id), new Vec2(0, buttonY));
        if (locked) {
          // 置灰只压按钮底板：等级行保持可读 —— 它是「为什么点不动」的唯一解释
          button.addComponent(UIOpacity).opacity = layout.cell.lockedOpacity;
        }
        const levelText = required > 0 ? layout.texts.level.split("{level}").join(`${required}`) : layout.texts.unlimited;
        cell.addChild(button);
        cell.addChild(
          GameUiHelper.createText(
            `map_level_${id}`,
            levelText,
            layout.cell.levelFontSize,
            new Vec2(0, levelY),
            new Size(buttonSize.width, layout.cell.levelHeight),
            locked ? layout.cell.lockedTextColor : layout.cell.levelColor,
          ),
        );
        button.on(Node.EventType.TOUCH_END, () => {
          // 没达到等级：只解释原因，不发传送（服务端也会拒，但按下那一刻就该明白为什么）
          if (locked) {
            GameUiHelper.createTipText(layout.texts.lockedTip.split("{level}").join(`${required}`).split("{map}").join(mapLabelOf(id)));
            return;
          }
          StorageManager.changeOnMap(id as MapId);
        });
        grid.addChild(cell);
      }
      content.addChild(grid);
    }
    dialog.addChild(view);
    LayerManager.addDialogToUILayer(dialog);
  }
}
