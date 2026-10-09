import { Graphics, isValid, Label, Node, Size, Sprite, SpriteFrame, UITransform, Vec2, Vec3 } from "cc";
import { maps } from "../../../configs/map";
import { getSmallMapScale, smallMapConfig } from "../../../configs/smallMap";
import { uiImages, mapPreviewImage, smallMapImage, smallMapLayout } from "../../../configs/hudLayout";
import AutoBattle from "../../core/AutoBattle";
import MonsterManager from "../../core/MonsterManager";
import StorageManager from "../../core/StorageManager";
import GameUiHelper, { SmallMapDot } from "../../helpers/GameUiHelper";
import { getMapPixelSize } from "../../utils/map/MapPointMath";
import { bindPointerAction } from "../../utils/input/Pointer";
import { loadResourceAsync } from "../../utils/resource/ResourceLoader";
import MapPreviewDialog from "../dialogs/MapPreviewDialog";
import type RoleDisplay from "../role/RoleDisplay";

/**
 * 小地图组件（右上角常驻 HUD，自身即容器节点）
 * 结构（所有子节点位置均以「地图内容区中心」为原点）：
 * - 地图名称条：紧挨地图内容区上方（贴住上边缘）
 * - 功能入口按钮：单列竖排的布局容器（Layout 纵向），位于地图内容区左侧
 * - 地图区域：真实小地图——当前地图的 preview.jpg，裁剪在内容区大小（layout.contentSize）的视口内，
 *   按「内容区 ↔ 世界视野」等比缩放后随角色平移（缩放见 configs/smallMap.getSmallMapScale）
 * - 地图正下方：服务器线路与排行榜（横向布局容器，排行榜在左）
 * - 最下方：世界坐标条
 * 位置、尺寸与图片来源全部来自 configs/hudLayout.smallMap（入口图标按名字走 smallMapImage 取图）
 * 地图区域上实时绘制坐标点：角色黑点固定在内容区中心（底图随之平移，故黑点下方永远是角色真实所在位置），
 * 怪物红点 = 怪物世界坐标与角色的差值 × 缩放，因此红点落在底图上的位置即怪物真实位置，
 * 视野（内容区覆盖的世界范围）之外的怪物不显示；底图与点位共用同一个缩放比例，换图/调视野都不会错位
 * 自动寻路期间（点击寻路/追怪）还会画上路线指示线（起点为中心的角色黑点，与大地图同一处路线、同一缩放口径）
 * 地图名称与世界坐标文本同样按 smallMapConfig.refreshInterval 节流刷新
 */
export default class SmallMap extends Node {
  /** 地图名称文本 */
  private mapNameLabel: Label;
  /** 世界坐标文本 */
  private positionLabel: Label;
  /** 坐标点绘制层 */
  private dotsGraphics: Graphics;
  /** 路线指示线绘制层（自动寻路期间画在小地图上；在视口内，超出内容区的部分被 Mask 裁掉） */
  private routeGraphics: Graphics | null = null;
  /** 底图视口（内容区大小的裁剪容器；底图按视野缩放并在其内平移，底图未就绪时露出下面的占位图） */
  private mapView: Node | null = null;
  /** 小地图底图（当前地图 preview.jpg；真实位置对应关系由它的缩放 + 位置决定） */
  private mapImage: Sprite | null = null;
  /** 底图已装载的地图 id（与当前地图不一致时重新装载，避免换图后仍显示旧地图） */
  private loadedMapId = "";
  /** 主角组件（世界坐标与附近怪物判定的基准） */
  private roleDisplay: RoleDisplay;
  /** 小地图弹窗（整图预览：左键点击寻路 / 右键点击传送；由本组件驱动点位刷新） */
  private mapPreviewDialog: MapPreviewDialog;
  /** 上次刷新时间戳 */
  private lastRefreshAt = 0;
  /** 路线当前是否已画出（无路线时据此决定是否要清空绘制层，避免每帧对空层调用 clear） */
  private routeDrawn = false;

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

  /** 中部：地图名称条（紧贴地图内容区上方）+ 真实地图底图（视口裁剪）+ 坐标点绘制层 */
  private createMapArea() {
    const layout = smallMapLayout;
    // 地图框底图（装饰与占位：真实底图未装载/加载失败时露出的就是它，其中心即本组件所有子节点位置的坐标原点）
    this.addChild(GameUiHelper.createImage("small_map_placeholder", uiImages.smallMapFrame, new Vec2(), layout.mapFrameSize));
    // 真实小地图：内容区大小的视口（Mask 裁剪）+ 底图（尺寸/缩放/位置由 updateMapImage 逐帧按真实坐标设置）
    this.mapView = GameUiHelper.createSmallMapMapView(new Vec2(), layout.contentSize);
    const mapImage = GameUiHelper.createSmallMapMapImage(layout.contentSize);
    this.mapImage = mapImage.getComponent(Sprite);
    this.mapView.addChild(mapImage);
    // 路线指示线层：放在视口内 → 超出内容区的路线被 Mask 裁掉；在底图之上、坐标点之下
    this.routeGraphics = GameUiHelper.createSmallMapRouteLayer(new Vec2(), layout.contentSize);
    this.mapView.addChild(this.routeGraphics.node);
    this.addChild(this.mapView);
    // 地图名称条：底边与地图内容区上边缘齐平（紧挨着上方）
    const nameBar = GameUiHelper.createImage("small_map_name_bar", uiImages.smallMapNameBar, layout.nameBar.position, layout.nameBar.size);
    this.mapNameLabel = GameUiHelper.createText("small_map_name", "", layout.nameBar.fontSize, new Vec2(), layout.nameBar.size, layout.nameBar.color).getComponent(Label);
    nameBar.addChild(this.mapNameLabel.node);
    this.addChild(nameBar);
    // 坐标点绘制层（角色黑点/怪物红点画在内容区尺寸的矩形内，中心与地图中心一致；在视口之上，故点位永远盖在底图上）
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
    this.updateMapImage(rolePosition);
    this.updateRoute(rolePosition);
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

  /**
   * 刷新真实小地图底图：换图时装载当前地图的 preview.jpg，
   * 按「地图像素尺寸 × 小地图缩放」设置底图显示尺寸，并把角色真实位置平移到底图视口中心
   * （角色在地图上往哪走，底图就往反方向移，于是中心黑点下方永远是对应的真实地貌）
   */
  private updateMapImage(rolePosition: Vec3) {
    const image = this.mapImage;
    const map = AutoBattle.getMapNode();
    const role = StorageManager.findOnlineRole();
    if (!image || !map || !role) return;
    const transform = image.node.getComponent(UITransform);
    if (!transform) return;
    // 换图才重新装载（异步；装载完成前保持上一张底图，首张未就绪时露出占位底图）
    if (this.loadedMapId !== role.onMap) {
      this.loadedMapId = role.onMap;
      this.loadMapImage(role.onMap, image);
    }
    const mapSize = getMapPixelSize(map);
    if (mapSize.width <= 0 || mapSize.height <= 0) return;
    // 比例由固定的内容区宽度反推（与 updateDots 同一入口，底图与点位不会各算一套）
    const scale = getSmallMapScale(smallMapLayout.contentSize.width);
    // 底图节点尺寸 = 地图像素尺寸（1 像素对 1 单位），再整体乘缩放 → 与坐标点换算同一个比例
    transform.setContentSize(mapSize.width, mapSize.height);
    image.node.setScale(scale, scale, 1);
    // 角色相对地图中心的世界偏移 × 缩放 = 角色在底图上的本地坐标，反向平移使角色落在视口中心
    const mapCenter = map.getWorldPosition();
    image.node.setPosition(-(rolePosition.x - mapCenter.x) * scale, -(rolePosition.y - mapCenter.y) * scale, 0);
  }

  /** 装载指定地图的小地图底图（map/<id>/preview；失败只提示，小地图退化为占位底图） */
  private loadMapImage(mapId: string, image: Sprite) {
    if (!mapId) return;
    loadResourceAsync<SpriteFrame>(`${mapPreviewImage(mapId)}/spriteFrame`, SpriteFrame)
      .then((spriteFrame) => {
        // 装载期间可能已换图或组件已销毁：底图不是当初那张 / 已切到别的地图时丢弃
        if (this.mapImage !== image || this.loadedMapId !== mapId || !isValid(image, true)) return;
        image.spriteFrame = spriteFrame;
      })
      .catch(() => console.warn(`[SmallMap] 小地图底图加载失败：${mapId}`));
  }

  /**
   * 重绘路线指示线（自动寻路期间）：起点是内容区中心的角色黑点，之后依次为 A* 剩余路点与目标点
   * 与底图/坐标点同一缩放口径（getSmallMapScale），所以线走的正是底图上的真实路线；
   * 超出内容区的部分由视口的 Mask 裁掉，无需手工剔除
   */
  private updateRoute(rolePosition: Vec3) {
    const graphics = this.routeGraphics;
    if (!graphics || !isValid(graphics.node)) return;
    const route = AutoBattle.getRoutePoints();
    if (route.length === 0) {
      // 无路线（到达/被打断/已进入范围）：立刻清空，避免残线留在地图上
      if (this.routeDrawn) {
        graphics.clear();
        this.routeDrawn = false;
      }
      return;
    }
    const scale = getSmallMapScale(smallMapLayout.contentSize.width);
    const points: Vec2[] = [new Vec2()];
    route.forEach((point) => points.push(new Vec2((point.x - rolePosition.x) * scale, (point.y - rolePosition.y) * scale)));
    GameUiHelper.drawRouteLine(graphics, points, {
      color: smallMapConfig.routeColor,
      dotRadius: smallMapConfig.routeDotRadius,
      dotGap: smallMapConfig.routeDotGap,
      endDotRadius: smallMapConfig.routeEndDotRadius,
    });
    this.routeDrawn = true;
  }

  /**
   * 重绘坐标点：角色黑点固定在内容区中心，视野内怪物按真实相对位置画红点
   * 换算比例与底图完全一致（getSmallMapScale），因此红点落在底图上的位置就是怪物真实所在位置
   */
  private updateDots(rolePosition: Vec3) {
    const halfWidth = smallMapLayout.contentSize.width / 2;
    const halfHeight = smallMapLayout.contentSize.height / 2;
    const scale = getSmallMapScale(smallMapLayout.contentSize.width);
    const dots: SmallMapDot[] = [{ x: 0, y: 0, color: smallMapConfig.roleDotColor, radius: smallMapConfig.roleDotRadius }];
    MonsterManager.getMonsterMap().forEach((monster, node) => {
      if (!isValid(node) || monster.hp <= 0) return;
      const monsterPosition = node.getWorldPosition();
      const x = (monsterPosition.x - rolePosition.x) * scale;
      const y = (monsterPosition.y - rolePosition.y) * scale;
      // 视野（内容区覆盖的世界范围）之外的怪物不显示
      if (Math.abs(x) > halfWidth || Math.abs(y) > halfHeight) return;
      dots.push({ x, y, color: smallMapConfig.monsterDotColor, radius: smallMapConfig.monsterDotRadius });
    });
    GameUiHelper.drawSmallMapDots(this.dotsGraphics, dots);
  }

  //#endregion
}
