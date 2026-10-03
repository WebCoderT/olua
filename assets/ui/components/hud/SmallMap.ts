import { Graphics, isValid, Label, Node, Size, Vec2, Vec3 } from "cc";
import { maps } from "../../../configs/map";
import { smallMapConfig } from "../../../configs/smallMap";
import { uiImages, smallMapImage, smallMapLayout } from "../../../configs/hudLayout";
import MonsterManager from "../../core/MonsterManager";
import StorageManager from "../../core/StorageManager";
import GameUiHelper, { SmallMapDot } from "../../helpers/GameUiHelper";
import { bindPointerAction } from "../../utils/input/Pointer";
import MapPreviewDialog from "../dialogs/MapPreviewDialog";
import type RoleDisplay from "../role/RoleDisplay";

/**
 * 小地图组件（右上角常驻 HUD，自身即容器节点）
 * 结构（所有子节点位置均以「地图内容区中心」为原点）：
 * - 地图名称条：紧挨地图内容区上方（贴住上边缘）
 * - 功能入口按钮：单列竖排的布局容器（Layout 纵向），位于地图内容区左侧
 * - 地图区域：底图暂为空图片（map-frame 占位，后续按地图替换缩略图）
 * - 地图正下方：服务器线路与排行榜（横向布局容器，排行榜在左）
 * - 最下方：世界坐标条
 * 位置、尺寸与图片来源全部来自 configs/hudLayout.smallMap（入口图标按名字走 smallMapImage 取图）
 * 地图区域上实时绘制坐标点：角色黑点固定在内容区中心，附近怪物按相对位置显示红点（不显示朝向），
 * 视野为以角色为中心、smallMapConfig.viewRadius 为半径的方形世界范围，范围外的怪物不显示
 * 地图名称与世界坐标文本同样按 smallMapConfig.refreshInterval 节流刷新
 */
export default class SmallMap extends Node {
  /** 地图名称文本 */
  private mapNameLabel: Label;
  /** 世界坐标文本 */
  private positionLabel: Label;
  /** 坐标点绘制层 */
  private dotsGraphics: Graphics;
  /** 主角组件（世界坐标与附近怪物判定的基准） */
  private roleDisplay: RoleDisplay;
  /** 小地图弹窗（整图预览：左键点击寻路 / 右键点击传送；由本组件驱动点位刷新） */
  private mapPreviewDialog: MapPreviewDialog;
  /** 上次刷新时间戳 */
  private lastRefreshAt = 0;

  constructor(roleDisplay: RoleDisplay) {
    super("small_map");
    this.roleDisplay = roleDisplay;
    this.mapPreviewDialog = new MapPreviewDialog(roleDisplay);
    // 主体（尺寸与屏幕右上角位置）
    GameUiHelper.applySmallMapBodyStyle(this);
    this.createEntryButtons();
    this.createMapArea();
    this.createBottomInfo();
  }

  /** 打开小地图弹窗（整图预览：左键寻路 / 右键传送） */
  private openMapPreviewDialog() {
    this.mapPreviewDialog.open();
  }

  //#region 结构拼装

  /** 贴边定位（贴屏幕右上角按可见尺寸重算）——窗口尺寸变化时由组合根调用 */
  applyAnchorPosition() {
    GameUiHelper.setSmallMapPosition(this);
  }

  /** 左侧：功能入口按钮（单列竖排的纵向布局容器，整体对齐地图内容区中心） */
  private createEntryButtons() {
    const layout = smallMapLayout;
    const count = layout.entryIcons.length;
    const columnHeight = count * layout.entryIconSize + (count - 1) * layout.entryIconGap;
    const column = GameUiHelper.createColumn("small_map_entry_buttons", layout.entryIconGap, layout.entryColumnPosition, new Size(layout.entryIconSize, columnHeight));
    // 按钮位置由 Layout 统一排列；「世界」入口打开小地图弹窗，其余入口暂为占位（与底部栏未开放按钮一致）
    layout.entryIcons.forEach((icon) => {
      const button = GameUiHelper.createTexturedButton(`small_map_entry_${icon}`, smallMapImage(icon), "", new Vec2(), new Size(layout.entryIconSize, layout.entryIconSize));
      if (icon === "world") bindPointerAction(button, () => this.openMapPreviewDialog(), this);
      column.addChild(button);
    });
    this.addChild(column);
  }

  /** 中部：地图名称条（紧贴地图内容区上方）+ 地图占位底图（空图片）+ 坐标点绘制层 */
  private createMapArea() {
    const layout = smallMapLayout;
    // 地图占位底图（其中心即本组件所有子节点位置的坐标原点）
    this.addChild(GameUiHelper.createImage("small_map_placeholder", uiImages.smallMapFrame, new Vec2(), layout.mapFrameSize));
    // 地图名称条：底边与地图内容区上边缘齐平（紧挨着上方）
    const nameBar = GameUiHelper.createImage("small_map_name_bar", uiImages.smallMapNameBar, layout.nameBar.position, layout.nameBar.size);
    this.mapNameLabel = GameUiHelper.createText("small_map_name", "", layout.nameBar.fontSize, new Vec2(), layout.nameBar.size, layout.nameBar.color).getComponent(Label);
    nameBar.addChild(this.mapNameLabel.node);
    this.addChild(nameBar);
    // 坐标点绘制层（角色黑点/怪物红点画在内容区尺寸的矩形内，中心与地图中心一致）
    this.dotsGraphics = GameUiHelper.createSmallMapDotLayer(new Vec2(), layout.contentSize);
    this.addChild(this.dotsGraphics.node);
    // 点击地图区域打开小地图弹窗（整图预览：左键寻路 / 右键传送）；点位层盖在底图上，点击由它接收
    bindPointerAction(this.dotsGraphics.node, () => this.openMapPreviewDialog(), this);
  }

  /** 底部：服务器线路与排行榜（横向布局容器）+ 世界坐标条 */
  private createBottomInfo() {
    const layout = smallMapLayout;
    // 线路/排行榜：横向布局容器，子节点排列完全交给 Layout（排行榜在左、服务器线在右）
    // 容器宽度取两颗标签加空档的总宽，从而整体相对地图内容区居中
    const tagRow = layout.tagRow;
    const tags = GameUiHelper.createRow("small_map_tags", tagRow.gap, tagRow.position, new Size(tagRow.size.width * 2 + tagRow.gap, tagRow.size.height));
    tags.addChild(GameUiHelper.createImage("small_map_ranking_list", uiImages.smallMapRankingList, new Vec2(), tagRow.size));
    tags.addChild(GameUiHelper.createImage("small_map_server_line", uiImages.smallMapServerLine, new Vec2(), tagRow.size));
    this.addChild(tags);
    // 世界坐标条：线路/排行榜下方
    const positionFrame = GameUiHelper.createImage("small_map_position", uiImages.smallMapPosition, layout.positionBar.position, layout.positionBar.size);
    this.positionLabel = GameUiHelper.createText("small_map_position_text", "", layout.positionBar.fontSize, new Vec2(), layout.positionBar.size).getComponent(Label);
    positionFrame.addChild(this.positionLabel.node);
    this.addChild(positionFrame);
  }

  //#endregion

  //#region 实时刷新

  /** 每帧驱动（由组合根调用）：内部按 refreshInterval 节流，只定期重绘文本与坐标点；并带动小地图弹窗的点位刷新 */
  update() {
    const now = Date.now();
    if (now - this.lastRefreshAt < smallMapConfig.refreshInterval) return;
    this.lastRefreshAt = now;
    const rolePosition = this.roleDisplay?.getWorldPosition();
    if (!rolePosition) return;
    this.updateLabels(rolePosition);
    this.updateDots(rolePosition);
    // 小地图弹窗开着时重绘其上的全图点位（弹窗未打开时内部直接跳过；关闭后引用失效自动清理）
    this.mapPreviewDialog.update();
  }

  /** 刷新地图名称与世界坐标文本 */
  private updateLabels(rolePosition: Vec3) {
    const role = StorageManager.findOnlineRole();
    this.mapNameLabel.string = (role && maps.get(role.onMap)?.label) || "";
    this.positionLabel.string = `${Math.round(rolePosition.x)}, ${Math.round(rolePosition.y)}`;
  }

  /** 重绘坐标点：角色黑点固定在内容区中心，视野内怪物按相对位置画红点 */
  private updateDots(rolePosition: Vec3) {
    const halfWidth = smallMapLayout.contentSize.width / 2;
    const halfHeight = smallMapLayout.contentSize.height / 2;
    const dots: SmallMapDot[] = [{ x: 0, y: 0, color: smallMapConfig.roleDotColor, radius: smallMapConfig.roleDotRadius }];
    MonsterManager.getMonsterMap().forEach((monster, node) => {
      if (!isValid(node) || monster.hp <= 0) return;
      const monsterPosition = node.getWorldPosition();
      const offsetX = monsterPosition.x - rolePosition.x;
      const offsetY = monsterPosition.y - rolePosition.y;
      // 视野（以角色为中心、viewRadius 为半径的方形世界范围）外的怪物不显示
      if (Math.abs(offsetX) > smallMapConfig.viewRadius || Math.abs(offsetY) > smallMapConfig.viewRadius) return;
      dots.push({
        x: (offsetX / smallMapConfig.viewRadius) * halfWidth,
        y: (offsetY / smallMapConfig.viewRadius) * halfHeight,
        color: smallMapConfig.monsterDotColor,
        radius: smallMapConfig.monsterDotRadius,
      });
    });
    GameUiHelper.drawSmallMapDots(this.dotsGraphics, dots);
  }

  //#endregion
}
