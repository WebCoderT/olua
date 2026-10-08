import { EventMouse, EventTouch, Graphics, isValid, Node, Sprite, SpriteFrame, UITransform, Vec2, Vec3 } from "cc";
import { maps, tiledGroupNames, tiledObjectClasses, tiledPropertyNames } from "../../../configs/map";
import { monsters } from "../../../configs/monster";
import { npcs } from "../../../configs/npc";
import { mapPreviewImage, mapPreviewDialogLayout } from "../../../configs/hudLayout";
import { smallMapConfig } from "../../../configs/smallMap";
import AutoBattle from "../../core/AutoBattle";
import LayerManager from "../../core/LayerManager";
import MonsterManager from "../../core/MonsterManager";
import StorageManager from "../../core/StorageManager";
import GameUiHelper, { SmallMapDot } from "../../helpers/GameUiHelper";
import { getMapPixelSize, getMapPointPositionOnWorld, getMapRectCenterPositionOnWorld } from "../../utils/map/MapPointMath";
import { getTiledObjects, getTiledObjectsFrom } from "../../utils/map/TiledObjects";
import { bindMousePress, getHitScreenPoint, getPointerButton, HAS_MOUSE, PointerButton } from "../../utils/input/Pointer";
import { loadResourceAsync } from "../../utils/resource/ResourceLoader";
import type RoleDisplay from "../role/RoleDisplay";

/**
 * 小地图弹窗（当前地图的整图预览）
 * 打开方式：点击右上角小地图的地图区域或「世界」入口按钮（见 components/hud/SmallMap，本类只负责弹窗本身）
 * 预览图为当前地图文件夹下的 preview.jpg（取图见 configs/layout/images.mapPreviewImage），整图铺满预览区；
 * 点击按「预览区 ↔ 地图像素范围」的等比映射换算成世界坐标：
 * - 左键：委托 AutoBattle.requestMoveTo 自动寻路走过去（玩家手动移动即打断，到达/放弃有提示）
 * - 右键：落点吸附到最近可站立位置后直接传送（setWorldPositionByTransfer，与复活传送同一套入口）
 * 预览图上实时绘制角色黑点与全图怪物红点（颜色/半径口径沿用 configs/smallMap，刷新频率同 refreshInterval）；
 * 自动寻路期间还会画出路线指示线（角色 → A* 剩余路点 → 目标，与大地图、常驻小地图同一处路线，样式见 layout.route）
 * 另有**静态文字标记层**（开窗时按地图对象组一次性生成，几何见 layout.marker）：
 * - 每个 NPC 一个白点，白点上方紧挨着显示 NPC 名称
 * - 每个刷怪区中心显示该区怪物名称
 * 弹窗由 SmallMap 持有并驱动 update（内部按刷新间隔节流）；关闭按钮销毁节点，引用失效自动清理，可反复打开
 */
export default class MapPreviewDialog {
  /** 弹窗节点（open 时创建，关闭后失效，重开重建） */
  private dialog: Node | null = null;
  /** 主角（角色黑点数据来源；右键传送的执行者） */
  private roleDisplay: RoleDisplay;
  /** 预览图节点（贴图装载、点击换算的载体） */
  private preview: Node | null = null;
  /** 点位绘制层（预览图的子节点，盖在图上） */
  private dotsGraphics: Graphics | null = null;
  /** 路线指示线绘制层（预览图的子节点；在点位层之下，自动寻路期间画） */
  private routeGraphics: Graphics | null = null;
  /** 路线当前是否已画出（无路线时据此决定是否要清空绘制层） */
  private routeDrawn = false;
  /** 上次点位重绘时间戳 */
  private lastRefreshAt = 0;

  constructor(roleDisplay: RoleDisplay) {
    this.roleDisplay = roleDisplay;
  }

  /** 打开弹窗（已打开时跳过） */
  open() {
    if (this.dialog && isValid(this.dialog, true)) return;
    const layout = mapPreviewDialogLayout;
    const role = StorageManager.findOnlineRole();
    // 标题用当前地图名（configs/map.ts 登记），没读到数据时退回兜底文案
    const dialog = GameUiHelper.createDialog(layout.name, (role && maps.get(role.onMap)?.label) || layout.title);
    this.dialog = dialog;
    // 预览区：整张地图的预览图（贴图异步装载；点击换算与点位层都以它为基准）
    const preview = GameUiHelper.createImage(layout.preview.name, "", layout.preview.position, layout.preview.size);
    dialog.addChild(preview);
    this.preview = preview;
    // 路线指示线层（预览图的子节点，在点位层之下：自动寻路期间画「角色 → 目标」的路线）
    this.routeGraphics = GameUiHelper.createSmallMapRouteLayer(new Vec2(), layout.preview.size);
    preview.addChild(this.routeGraphics.node);
    // 点位绘制层（预览图的子节点：盖在图上，点击事件冒泡到预览节点统一处理）
    this.dotsGraphics = GameUiHelper.createSmallMapDotLayer(new Vec2(), layout.preview.size);
    preview.addChild(this.dotsGraphics.node);
    // 静态标记层（NPC 白点 + 名称、刷怪区怪物名称；盖在动态点之上，只随地图数据建一次）
    const markerLayer = GameUiHelper.createSmallMapMarkerLayer(new Vec2(), layout.preview.size);
    preview.addChild(markerLayer);
    this.routeDrawn = false;
    this.buildMarkers(markerLayer);
    // 底部操作提示
    dialog.addChild(GameUiHelper.createText("map_preview_hint", layout.hint.text, layout.hint.fontSize, layout.hint.position, layout.hint.size, layout.hint.color));
    LayerManager.addDialogToUILayer(dialog);
    // 装载预览图并绑定点击（图没就绪时弹窗也可正常打开/关闭）
    this.loadPreviewImage(role ? role.onMap : "", preview);
    this.bindPreviewClick(preview);
  }

  /** 每帧驱动（由 SmallMap.update 带动，内部按刷新间隔节流）：重绘预览图上的角色黑点与全图怪物红点 */
  update() {
    const dialog = this.dialog;
    if (!dialog || !isValid(dialog, true) || !this.dotsGraphics) return;
    const now = Date.now();
    if (now - this.lastRefreshAt < smallMapConfig.refreshInterval) return;
    this.lastRefreshAt = now;
    const rolePosition = this.roleDisplay?.getWorldPosition();
    const transform = this.dotsGraphics.node.getComponent(UITransform);
    if (!rolePosition || !transform) return;
    // 世界坐标 -> 预览图本地坐标：地图像素范围等比映射到预览区，范围外夹到边缘
    const toPreview = this.createPreviewMapper(this.dotsGraphics.node);
    if (!toPreview) return;
    const dots: SmallMapDot[] = [{ ...toPreview(rolePosition.x, rolePosition.y), color: smallMapConfig.roleDotColor, radius: smallMapConfig.roleDotRadius }];
    MonsterManager.getMonsterMap().forEach((monster, node) => {
      if (!isValid(node) || monster.hp <= 0) return;
      const position = node.getWorldPosition();
      dots.push({ ...toPreview(position.x, position.y), color: smallMapConfig.monsterDotColor, radius: smallMapConfig.monsterDotRadius });
    });
    GameUiHelper.drawSmallMapDots(this.dotsGraphics, dots);
    this.updateRoute(toPreview, rolePosition);
  }

  /**
   * 重绘路线指示线（自动寻路期间）：起点为角色黑点，之后依次是 A* 剩余路点与目标点
   * 与点位共用 createPreviewMapper（同一口径），因此路线与点位/底图严格对齐；
   * 超出地图范围的点由换算器夹到边缘，线不会画出预览区
   */
  private updateRoute(toPreview: (worldX: number, worldY: number) => Vec2, rolePosition: Vec3) {
    const graphics = this.routeGraphics;
    if (!graphics || !isValid(graphics.node)) return;
    const route = AutoBattle.getRoutePoints();
    if (route.length === 0) {
      // 无路线（到达/被打断/已进入范围）：立刻清空，避免残线留在图上
      if (this.routeDrawn) {
        graphics.clear();
        this.routeDrawn = false;
      }
      return;
    }
    const points: Vec2[] = [toPreview(rolePosition.x, rolePosition.y)];
    route.forEach((point) => points.push(toPreview(point.x, point.y)));
    const style = mapPreviewDialogLayout.route;
    GameUiHelper.drawRouteLine(graphics, points, {
      color: style.color,
      dotRadius: style.dotRadius,
      dotGap: style.dotGap,
      endDotRadius: style.endDotRadius,
    });
    this.routeDrawn = true;
  }

  /**
   * 世界坐标 -> 预览图本地坐标的换算器（以传入节点的中心为原点，尺寸取该节点内容尺寸）
   * 地图像素范围等比映射到预览区，范围外夹到 0~1（点落在边缘）；
   * 地图未就绪 / 尺寸为 0 时返回 null（调用方跳过本次绘制）
   */
  private createPreviewMapper(node: Node): ((worldX: number, worldY: number) => Vec2) | null {
    const map = AutoBattle.getMapNode();
    const transform = node.getComponent(UITransform);
    if (!map || !transform) return null;
    const size = transform.contentSize;
    if (size.width <= 0 || size.height <= 0) return null;
    const mapSize = getMapPixelSize(map);
    const mapCenter = map.getWorldPosition();
    return (worldX: number, worldY: number): Vec2 => {
      const ratioX = Math.min(1, Math.max(0, (worldX - (mapCenter.x - mapSize.width / 2)) / mapSize.width));
      const ratioY = Math.min(1, Math.max(0, (worldY - (mapCenter.y - mapSize.height / 2)) / mapSize.height));
      return new Vec2((ratioX - 0.5) * size.width, (ratioY - 0.5) * size.height);
    };
  }

  /**
   * 生成预览图上的静态文字标记（开窗时一次性建好，随地图数据固定不变）
   * - NPC：白点画在标记层的 Graphics 上，名称文字紧贴在白点正上方
   * - 刷怪区：区域中心显示该区怪物名称（区域不是矩形 / 怪物编号无配置的跳过，与刷怪生成同一套判据）
   * 坐标一律走 createPreviewMapper（与动态点同一口径），因此标记与红点/黑点位置永远对得上
   */
  private buildMarkers(markerLayer: Node) {
    const map = AutoBattle.getMapNode();
    if (!map) return;
    const toPreview = this.createPreviewMapper(markerLayer);
    if (!toPreview) return;
    const marker = mapPreviewDialogLayout.marker;
    const npcDots: SmallMapDot[] = [];
    // NPC 白点 + 名称（复活点类点位不是 NPC，跳过；名称取 configs/npc 的 label，未配置的跳过）
    getTiledObjectsFrom(map, tiledGroupNames.npc, tiledGroupNames.legacyObjects).forEach((object) => {
      if (object.objectClass === tiledObjectClasses.revive || object.name === tiledObjectClasses.revive) return;
      const npc = npcs.get(`${object.properties[tiledPropertyNames.id] ?? ""}`);
      if (!npc) return;
      const world = getMapPointPositionOnWorld(new Vec3(object.x, object.y), map);
      const local = toPreview(world.x, world.y);
      npcDots.push({ x: local.x, y: local.y, color: marker.npcDotColor, radius: marker.npcDotRadius });
      const labelPosition = new Vec2(local.x, local.y + marker.npcDotRadius + marker.npcLabelGap + marker.labelSize.height / 2);
      markerLayer.addChild(GameUiHelper.createText(`npc_name_${object.name || npc.id}`, npc.label, marker.npcLabelFontSize, labelPosition, marker.labelSize, marker.npcLabelColor));
    });
    GameUiHelper.drawSmallMapDots(markerLayer.addComponent(Graphics), npcDots);
    // 刷怪区中心的怪物名称
    getTiledObjects(map, tiledGroupNames.monster).forEach((object) => {
      if (object.width <= 0 || object.height <= 0) return;
      const monster = monsters.get(`${object.properties[tiledPropertyNames.id] ?? ""}`);
      if (!monster) return;
      const center = getMapRectCenterPositionOnWorld(object.x, object.y, object.width, object.height, map);
      const local = toPreview(center.x, center.y);
      markerLayer.addChild(GameUiHelper.createText(`monster_area_name_${object.name || monster.label}`, monster.label, marker.monsterLabelFontSize, local, marker.labelSize, marker.monsterLabelColor));
    });
  }

  /** 装载预览图（map/<id>/preview/spriteFrame；失败只提示，弹窗仍可正常使用） */
  private loadPreviewImage(mapId: string, preview: Node) {
    if (!mapId) return;
    loadResourceAsync<SpriteFrame>(`${mapPreviewImage(mapId)}/spriteFrame`, SpriteFrame)
      .then((spriteFrame) => {
        // 弹窗可能已被关闭甚至重开过：预览图已不是当初发起加载的那个节点就不再贴图（严格模式判据：当帧销毁也拦得住）
        if (this.preview !== preview || !isValid(preview, true)) return;
        const sprite = preview.getComponent(Sprite);
        if (sprite) sprite.spriteFrame = spriteFrame;
      })
      .catch(() => GameUiHelper.createErrorTip("map_preview_load_error_tip"));
  }

  /** 绑定预览图点击：左键寻路 / 右键传送（触屏环境没有右键，统一按左键寻路处理） */
  private bindPreviewClick(preview: Node) {
    const handleClick = (button: PointerButton, screenPoint: Vec2) => {
      const worldPoint = this.toWorldPoint(preview, screenPoint);
      if (!worldPoint) return;
      if (button === "left") {
        if (!AutoBattle.requestMoveTo(worldPoint)) GameUiHelper.createTip("map_move_refuse_tip");
        return;
      }
      this.teleportTo(worldPoint);
    };
    if (HAS_MOUSE) {
      // PC 只监听鼠标并按左右键区分（引擎会把鼠标事件模拟成 touch，同一节点两套都监听会重复触发）；
      // 走 bindMousePress：按下起点在预览图上才响应这次抬起，抬起的结束一律交还世界侧收尾（见 utils/input/Pointer）
      bindMousePress(
        preview,
        (event: EventMouse) => {
          const button = getPointerButton(event);
          if (button) handleClick(button, getHitScreenPoint(event));
        },
        this,
      );
      return;
    }
    preview.on(Node.EventType.TOUCH_END, (event: EventTouch) => handleClick("left", event.getLocation()), this);
  }

  /**
   * 预览图上的屏幕点击点 -> 地图世界坐标
   * 链路：屏幕坐标（主相机 screenToWorld）-> 世界坐标 -> 相对预览图中心的比例 -> 映射到地图像素范围。
   * 本工程的 UI 层容器被主相机直接对齐到主角（LayerManager.move），UI 节点的世界坐标与世界在同一坐标系且无缩放，
   * 因此可以直接用「比例 × 地图像素范围」换算，不需要经过 UI 相机
   */
  private toWorldPoint(preview: Node, screenPoint: Vec2): Vec2 | null {
    const camera = LayerManager.camera;
    const map = AutoBattle.getMapNode();
    const transform = preview.getComponent(UITransform);
    if (!camera || !isValid(camera.node) || !map || !transform) return null;
    const worldPoint = camera.screenToWorld(new Vec3(screenPoint.x, screenPoint.y, 0), new Vec3());
    const center = preview.getWorldPosition();
    const size = transform.contentSize;
    if (size.width <= 0 || size.height <= 0) return null;
    // 点击点相对预览图中心的比例（点在预览图边缘外时夹到 0~1，取边界落点）
    const ratioX = Math.min(1, Math.max(0, (worldPoint.x - center.x) / size.width + 0.5));
    const ratioY = Math.min(1, Math.max(0, (worldPoint.y - center.y) / size.height + 0.5));
    const mapSize = getMapPixelSize(map);
    const mapCenter = map.getWorldPosition();
    return new Vec2(mapCenter.x - mapSize.width / 2 + ratioX * mapSize.width, mapCenter.y - mapSize.height / 2 + ratioY * mapSize.height);
  }

  /** 右键传送：落点吸附到最近可站立位置后直接飞过去（与复活传送同一套入口），并停掉正在进行的自动移动 */
  private teleportTo(worldPoint: Vec2) {
    if (!isValid(this.roleDisplay)) return;
    if (this.roleDisplay.isDead()) {
      GameUiHelper.createTip("map_teleport_dead_tip");
      return;
    }
    const snapped = AutoBattle.findWalkablePoint(worldPoint) ?? worldPoint;
    AutoBattle.cancel();
    this.roleDisplay.setWorldPositionByTransfer(new Vec3(snapped.x, snapped.y, 0));
  }
}
