import { Graphics, isValid, Label, Node, Size, Sprite, SpriteFrame, UIOpacity, UITransform, Vec2, Vec3 } from "cc";
import { mapLabelOf, maps } from "../../../configs/game-config";
import { getSmallMapScale, smallMapConfig } from "../../../configs/smallMap";
import { T, mapPreviewImage, smallMapLayout } from "../../../configs/hudLayout";
import { buildAnnouncementViews, countUnread } from "../../../configs/announcement";
import { getText } from "../../../configs/texts";
import AutoBattle from "../../core/AutoBattle";
import AnnouncementReadStore from "../../core/AnnouncementReadStore";
import MonsterManager from "../../core/MonsterManager";
import StorageManager from "../../core/StorageManager";
import GameUiHelper, { SmallMapDot } from "../../helpers/GameUiHelper";
import UiHelper from "../../helpers/UiHelper";
import { drawVectorIcon, type VectorIconShape } from "../../helpers/VectorIcon";
import { icons } from "../../../configs/layout/icons";
import { getMapWorldRect } from "../../utils/map/MapPointMath";
import { bindPointerAction } from "../../utils/input/Pointer";
import { loadResourceAsync } from "../../utils/resource/ResourceLoader";
import { AnnouncementApi, GameMailApi } from "../../utils/net/Api";
import CombatChannel from "../../utils/net/CombatChannel";
import AnnouncementBoardDialog from "../dialogs/AnnouncementBoardDialog";
import LeaderboardDialog from "../dialogs/LeaderboardDialog";
import AchievementDialog from "../dialogs/AchievementDialog";
import ChannelSelectDialog from "../dialogs/ChannelSelectDialog";
import MailDialog from "../dialogs/MailDialog";
import MapPreviewDialog from "../dialogs/MapPreviewDialog";
import type RoleDisplay from "../role/RoleDisplay";

/**
 * 小地图组件（右上角常驻 HUD，自身即容器节点）
 * 结构（逐值对照 design/olua-ui/screens/04-hud.html 的 .map 段；子件坐标以面板中心为原点）：
 * - 面板底板：304×250 的铆钉面板（复用弹窗同款 createDialogPanel：r3 + line-3 边 + 四角铆钉）
 * - 标题条（.map-head）：图名（gold-5）+「· N 线」副文字（text-4，分线图才显示）+ 下拉箭头
 * - 功能入口 rail（.map-rail）：面板左外侧的 2 列网格，7 颗 34×34 描边图标
 *   （世界/线路/排行榜/成就/消息+红点/设置/声音）
 * - 地图区域（.map-view）：280×170 视口 —— 径向底色 + 22px 网格 + 真实底图 preview.jpg（opacity .5）
 *   按「内容区 ↔ 世界视野」等比缩放后随角色平移（缩放见 configs/smallMap.getSmallMapScale）+ 内暗角
 * - 底部（.map-foot）：只剩右下角世界坐标 `X 128 Y 96`（排行榜/线路在 rail 里，不在这）
 * 位置、尺寸与配色全部来自 configs/hudLayout.smallMap
 * 地图区域上实时绘制坐标点：角色白点（带外环）固定在内容区中心（底图随之平移，故点位下方永远是角色真实所在位置），
 * 怪物红点 = 怪物世界坐标与角色的差值 × 缩放，因此红点落在底图上的位置即怪物真实位置，
 * 视野（内容区覆盖的世界范围）之外的怪物不显示；底图与点位共用同一个缩放比例，换图/调视野都不会错位
 * 自动寻路期间（点击寻路/追怪）还会画上路线指示线（起点为中心的角色黑点，与大地图同一处路线、同一缩放口径）
 * 地图名称与世界坐标文本同样按 smallMapConfig.refreshInterval 节流刷新
 */
/** rail 入口 key → 描边图标（数据逐字取自 design/olua-ui/screens/04-hud.html 的 .map-rail） */
function railIconOf(key: string): VectorIconShape {
  const map: Record<string, VectorIconShape> = {
    world: icons.mapWorld,
    channel: icons.mapChannel,
    ranking: icons.mapRanking,
    achievement: icons.mapAchievement,
    mail: icons.mapMail,
    config: icons.mapSettings,
    sound: icons.mapSound,
  };
  return map[key] ?? { paths: [] };
}

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
  /** 公告板弹窗（左侧「公告」入口打开；它的未读数回调驱动入口红点） */
  private announcementDialog: AnnouncementBoardDialog;
  /**
   * 排行榜弹窗（#400）
   *
   * 入口是稿 .map-rail 里的「排行榜」描边图标（见 createEntryButtons），原横幅与图标素材已删。
   */
  private leaderboardDialog = new LeaderboardDialog();
  /**
   * 成就面板（#401：rail 里那颗「成就」描边图标，见 createEntryButtons）
   */
  private achievementDialog = new AchievementDialog();
  /**
   * 消息中心（#429：邮件面板，公告板从面板里进）
   *
   * 之前这颗 `mail` 图标只开公告板；现在它是「消息中心」——邮件与公告都是消息，
   * 一颗图标两个入口比在小地图上再挤一颗图标干净（左侧竖排每加一颗都要挪整列）。
   */
  private mailDialog = new MailDialog({
    onUnreadChange: (unread) => this.setMailUnread(unread),
    onOpenAnnouncement: () => this.openAnnouncementDialog(),
  });
  /**
   * 选线弹窗（#1016：rail 里那颗「线路」图标打开）
   *
   * 只在 `maxChannels > 1` 的图上可点（单线图没有可换的东西，标签保持装饰图原样）。
   * 线数读配置快照（`maps`），当前线读 `world` 帧带回的 `channel` —— 开弹窗不拉接口。
   */
  private channelDialog = new ChannelSelectDialog();
  /** 标题条的「· N 线」副文字（分线图上显示真实线号，公共线为空；未建标题条时为 null） */
  private channelLabel: Label | null = null;
  /** 标题条右侧的下拉箭头（有无副文字时位置不同，见 updateChannelTag） */
  private chevronNode: Node | null = null;
  /** 入口红点（未读邮件 + 未领附件 + 未读公告，有任一项才显示） */
  private entryDot: Node | null = null;
  /** 邮件侧待处理数（未读 + 未领，由邮件面板与进游戏时的一次探测维护） */
  private mailUnread = 0;
  /** 公告侧未读数（由公告板与进游戏时的一次探测维护） */
  private announcementUnread = 0;
  /** 上次刷新时间戳 */
  private lastRefreshAt = 0;
  /** 路线当前是否已画出（无路线时据此决定是否要清空绘制层，避免每帧对空层调用 clear） */
  private routeDrawn = false;

  constructor(roleDisplay: RoleDisplay) {
    super("small_map");
    this.roleDisplay = roleDisplay;
    this.mapPreviewDialog = new MapPreviewDialog(roleDisplay);
    // 公告板自己拉公告；未读数变化通过回调回到这里（红点长什么样是 HUD 的事）
    this.announcementDialog = new AnnouncementBoardDialog((unread) => this.setAnnouncementUnread(unread));
    // 主体（尺寸与右上角固定位置：见 configs/hudLayout.smallMap，改位置直接改配置）
    this.addComponent(UITransform).setContentSize(smallMapLayout.size);
    this.setPosition(smallMapLayout.position.x, smallMapLayout.position.y, 0);
    // 面板底板（稿 .map .panel：与弹窗同款铆钉面板，只是尺寸 304×250）
    this.addChild(GameUiHelper.createDialogPanel("small_map_panel", smallMapLayout.size));
    this.createEntryButtons();
    this.createHead();
    this.createMapArea();
    this.createCoordinate();
    // 进游戏先探一次未读（失败静默：拉不到就不显示红点）
    void this.refreshAnnouncementUnread();
    void this.refreshMailUnread();
  }

  /** 打开小地图弹窗（整图预览：左键寻路 / 右键传送） */
  private openMapPreviewDialog() {
    this.mapPreviewDialog.open();
  }

  /** 打开公告板（入口在邮件面板里：消息中心 > 公告） */
  private openAnnouncementDialog() {
    this.announcementDialog.open();
  }

  /**
   * 探一次未读公告数（进游戏时调一次）
   *
   * 之后由公告板自己驱动：打开它就整批标为已读并回调 `setAnnouncementUnread(0)`。
   * 拉取失败静默 —— 红点只是提示，拉不到就当没有未读，不能因此弹提示打断进游戏。
   */
  private async refreshAnnouncementUnread() {
    try {
      // 与公告板同一条（#963）：带上令牌才拿得到「本区」那批，否则红点会漏掉本区公告
      const list = await AnnouncementApi.mine({ silent: true });
      if (!isValid(this)) return;
      this.setAnnouncementUnread(countUnread(buildAnnouncementViews(list, AnnouncementReadStore.getReadIds())));
    } catch {
      /* 静默：入口不显示红点即可 */
    }
  }

  /**
   * 探一次邮件待处理数（进游戏时调一次）
   *
   * 「未读 + 未领」都算要处理：只有未领的邮件（已读过但没领）同样值得一个红点 ——
   * 那正是玩家最需要被提醒的一类（东西还在邮箱里没拿）。
   * 之后由邮件面板自己驱动（打开时回调未读数）。失败静默，与公告同一口径。
   */
  private async refreshMailUnread() {
    try {
      const box = await GameMailApi.mine({ silent: true });
      if (!isValid(this)) return;
      this.setMailUnread(box ? box.unread + box.unclaimed : 0);
    } catch {
      /* 静默：入口不显示红点即可 */
    }
  }

  /** 公告未读数变化 */
  private setAnnouncementUnread(unread: number) {
    this.announcementUnread = unread;
    this.refreshEntryDot();
  }

  /** 邮件侧待处理数变化（由邮件面板回调） */
  private setMailUnread(unread: number) {
    this.mailUnread = unread;
    this.refreshEntryDot();
  }

  /** 红点显隐：两路相加（红点节点是入口按钮的子节点，随按钮一起排布） */
  private refreshEntryDot() {
    if (!this.entryDot || !isValid(this.entryDot)) return;
    this.entryDot.active = this.mailUnread + this.announcementUnread > 0;
  }

  //#region 结构拼装

  /** 左侧：功能入口按钮（两列网格，见 hudLayout.smallMapLayout.entryGrid；顶边与地图面板对齐） */
  private createEntryButtons() {
    const layout = smallMapLayout;
    const grid = layout.entryGrid;
    const rows = Math.ceil(layout.entryIcons.length / grid.columns);
    const gridWidth = grid.columns * grid.buttonSize + (grid.columns - 1) * grid.gap;
    const gridHeight = rows * grid.buttonSize + (rows - 1) * grid.gap;
    // 网格容器：子节点排列完全交给 Layout（按行填充），整体顶边与地图面板顶边对齐
    const container = GameUiHelper.createGrid(
      "small_map_entry_buttons", grid.gap, grid.gap, layout.entryGridPosition, new Size(gridWidth, gridHeight),
    );
    // 「世界」打开小地图弹窗、「线路」分线图上开选线弹窗、「排行榜」打开本区榜、
    // 「成就」打开成就面板、「邮件」打开消息中心（邮件 + 公告入口，见 mailDialog）；config/sound 暂为占位
    layout.entryIcons.forEach((icon) => {
      // rail 是稿 .map-rail 的 7 颗描边图标（34×34、2 列；图标数据见 configs/layout/icons.ts）
      const button = this.createRailIconButton(icon);
      if (icon === "world") bindPointerAction(button, () => this.openMapPreviewDialog(), this);
      if (icon === "channel") bindPointerAction(button, () => this.openChannelSelect(), this);
      if (icon === "ranking") bindPointerAction(button, () => this.leaderboardDialog.open(), this);
      if (icon === "achievement") bindPointerAction(button, () => this.achievementDialog.open(), this);
      if (icon === layout.mailEntry) {
        bindPointerAction(button, () => this.mailDialog.open(), this);
        this.entryDot = this.createEntryDot(button);
      }
      container.addChild(button);
    });
    this.addChild(container);
  }

  /**
   * 文字兜底按钮（排行榜 / 线路没有方形图标）：34×34 玻璃底板 + 居中文字
   * 文字节点名固定 `{key}_text`（线号刷新按名字取件）
   */
  /**
   * rail 里的单颗入口按钮：矢量玻璃底板 + **描边图标**（稿 .map-rail 没有文字）
   *
   * 图标 18px 居中（稿 .ic 默认 18），数据见 configs/layout/icons.ts；未知 key 画空但按钮仍在，
   * 免得新增入口时整列错位
   */
  private createRailIconButton(key: string) {
    const layout = smallMapLayout.entryGrid;
    const button = new Node(`small_map_entry_${key}`);
    button.addComponent(UITransform).setContentSize(layout.buttonSize, layout.buttonSize);
    // 稿 `.map-rail button{background:rgba(22,15,9,.92)}` ≈ surface-2（比 HUD 玻璃底更深一档）
    button.addChild(GameUiHelper.createGlassPlate(`${key}_plate`, new Size(layout.buttonSize, layout.buttonSize), T.radius.r2, T.line[2], T.surface[2]));
    const iconNode = UiHelper.createNode(`${key}_icon`, new Vec2(), new Size(18, 18));
    // 稿 `.map-rail button{color:var(--text-2)}`：rail 图标是**骨白**、不是金色
    // （金色只给底栏导航 `.nbtn .ic`）—— 早前两处都画成 gold[3]，实机上 rail 一片暗棕
    drawVectorIcon(iconNode, railIconOf(key), new Size(18, 18), T.text[2], 2);
    button.addChild(iconNode);
    return button;
  }

  /**
   * 标题条（稿 .map-head：高 40、内容居中）：图名 gold-5 +「· N 线」副文字 + 下拉箭头
   *
   * 副文字与图名分两个 Label（稿里 span 与 b 是两种颜色字号）：名字节点够宽居中摆放，
   * 副文字左对齐、左缘按 3 字图名估算（图名长度变化时会有 ±几像素的间隙差，稿的 flex 居中做不到等价）
   */
  private createHead() {
    const head = smallMapLayout.head;
    this.mapNameLabel = GameUiHelper.createText("small_map_name", "", head.nameFontSize, new Vec2(-14, head.y), new Size(200, 18), head.nameColor).getComponent(Label);
    // 稿 `.map-head b{letter-spacing:.16em}`：图名要拉开字距，否则和副文字挤成一团
    this.mapNameLabel.spacingX = head.nameSpacingX;
    this.addChild(this.mapNameLabel.node);
    this.channelLabel = GameUiHelper.createText(
      "small_map_channel", "", head.channel.fontSize, head.channel.position, head.channel.size, head.channel.color,
      Label.HorizontalAlign.LEFT,
    ).getComponent(Label);
    this.addChild(this.channelLabel.node);
    const chevron = UiHelper.createNode("small_map_chevron", head.chevron.position, head.chevron.size);
    drawVectorIcon(chevron, icons.headChevron, head.chevron.size, head.chevron.color, 2);
    this.chevronNode = chevron;
    this.addChild(chevron);
  }

  /** 消息入口的未读红点（常驻子节点，按未读数切显隐；矢量红点，替代 dot 贴图） */
  private createEntryDot(button: Node) {
    const dot = GameUiHelper.createVectorDot(`${button.name}_unread`, T.ember[3], smallMapLayout.entryDot.position, smallMapLayout.entryDot.size);
    dot.active = false;
    button.addChild(dot);
    return dot;
  }

  /** 中部：地图内容区（稿 .map-view：径向底色 + 网格 + 真实底图视口 + 坐标点 + 内暗角） */
  private createMapArea() {
    const layout = smallMapLayout;
    const view = layout.mapView;
    // 真实小地图：内容区大小的视口（Mask 裁剪）+ 底图（尺寸/缩放/位置由 updateMapImage 逐帧按真实坐标设置）
    this.mapView = GameUiHelper.createSmallMapMapView(layout.contentPosition, layout.contentSize);
    // 径向底色（稿 .map-view 的 background）：放在视口**内部** —— 画在外面时半径 125 的径向圆
    // 会溢出面板下沿、还会盖住标题条（第一版踩过）；视口 Mask 顺带把它裁齐
    this.mapView.addChild(GameUiHelper.createSmallMapBackdrop("small_map_placeholder", new Vec2(), layout.contentSize, view.backdrop));
    const mapImage = GameUiHelper.createSmallMapMapImage(layout.contentSize);
    this.mapImage = mapImage.getComponent(Sprite);
    // 底图压暗到稿的水平（`.map-view .terrain{opacity:.5}`）：地图原画是亮石地，
    // 原样贴上去会成为整个 HUD 最亮的一块，跟旁边暖褐面板完全不是一个调子
    mapImage.addComponent(UIOpacity).opacity = view.imageOpacity;
    this.mapView.addChild(mapImage);
    // 压暗薄纱（稿地形底接近纯黑，半透明实拍图还要再压一层才到同一亮度）
    const scrim = view.scrim.color.clone();
    scrim.a = view.scrim.alpha;
    this.mapView.addChild(GameUiHelper.createSmallMapScrim("small_map_scrim", new Vec2(), layout.contentSize, scrim));
    // 22px 网格：画在底图之上（见 createSmallMapGrid 注释）
    this.mapView.addChild(GameUiHelper.createSmallMapGrid("small_map_grid", new Vec2(), layout.contentSize, view.grid));
    // 路线指示线层：放在视口内 → 超出内容区的路线被 Mask 裁掉；在底图之上、坐标点之下
    this.routeGraphics = GameUiHelper.createSmallMapRouteLayer(layout.contentPosition, layout.contentSize);
    this.mapView.addChild(this.routeGraphics.node);
    this.addChild(this.mapView);
    // 内容区发丝线（稿 `.map-view{border:1px solid var(--line-1)}`）：底图是满幅贴图，
    // 没有这一圈线时地图和面板之间是「硬切」，看不出视口边界
    const frame = GameUiHelper.createGlassPlate("small_map_view_frame", layout.contentSize, T.radius.r2, view.border, T.overlay.transparent);
    frame.setPosition(layout.contentPosition.x, layout.contentPosition.y, 0);
    this.addChild(frame);
    // 坐标点绘制层（角色白点/怪物红点画在内容区尺寸的矩形内，中心与地图中心一致；在视口之上，故点位永远盖在底图上）
    this.dotsGraphics = GameUiHelper.createSmallMapDotLayer(layout.contentPosition, layout.contentSize);
    this.addChild(this.dotsGraphics.node);
    // 内暗角（稿 .vign：inset 26px 黑 .75）：盖在点位之上，边缘渐暗 —— 层叠描边近似
    this.addChild(GameUiHelper.createSmallMapVignette("small_map_vignette", layout.contentPosition, layout.contentSize, view.vignette));
    // 点击地图区域打开小地图弹窗（整图预览：左键寻路 / 右键传送）；点位层盖在底图上，点击由它接收
    bindPointerAction(this.dotsGraphics.node, () => this.openMapPreviewDialog(), this);
  }

  /**
   * 底部世界坐标（稿 .map-foot：只剩右下角坐标，格式 `X 128 Y 96`）
   *
   * 排行榜 / 线路在左侧 rail 里（稿 .map-rail 的 7 颗图标之一），底部没有胶囊 ——
   * 早前「胶囊在地图正下方」是看漏稿，已改回（见 createEntryButtons）
   */
  private createCoordinate() {
    const bar = smallMapLayout.positionBar;
    this.positionLabel = GameUiHelper.createText(
      "small_map_position_text", "", bar.fontSize, bar.position, bar.size, bar.color,
      Label.HorizontalAlign.RIGHT,
    ).getComponent(Label);
    this.addChild(this.positionLabel.node);
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

  /** 刷新地图名称、线号副文字与世界坐标文本 */
  private updateLabels(rolePosition: Vec3) {
    const role = StorageManager.findOnlineRole();
    // 图名是纯名字；线号走标题条右侧的副文字（稿 .map-head 的 span，见 updateChannelTag）
    this.mapNameLabel.string = role ? mapLabelOf(role.onMap) : "";
    // 稿 .map-foot .coord 的格式：`X 128 Y 96`
    this.positionLabel.string = `X ${Math.round(rolePosition.x)} Y ${Math.round(rolePosition.y)}`;
    this.updateChannelTag(role);
  }

  /**
   * 刷新「线路」入口的文字（#1016 口径移到入口按钮上）
   *
   * 分线图（`maxChannels > 1`）且真实线号 > 0 时显示「 · N线」（玩家视角 = 服务端 channel + 1），
   * 公共线 / 单线图 / 配置快照未到都为空（稿 .map-head 的 span 在公共线上没有内容）。
   * 点击行为见 openChannelSelect（入口在 rail 里，单线图守卫 return）
   */
  private updateChannelTag(role: ReturnType<typeof StorageManager.findOnlineRole>) {
    if (!this.channelLabel || !isValid(this.channelLabel.node)) return;
    const config = role ? maps.get(role.onMap) : undefined;
    const channel = config && config.maxChannels > 1 ? CombatChannel.currentChannel : 0;
    const suffix = channel > 0 ? getText("map_channel_suffix", { channel: channel + 1 }) : "";
    this.channelLabel.string = suffix;
    // 没有副文字时箭头紧跟图名，有线号时排在副文字之后（稿是 flex 居中，客户端给两个固定位）
    const head = smallMapLayout.head.chevron;
    this.chevronNode?.setPosition(suffix ? head.position.x : head.aloneX, head.position.y, 0);
  }

  /** 打开选线弹窗（#1016；单线图 / 配置没到时守卫直接 return，标签维持装饰图） */
  private openChannelSelect() {
    const role = StorageManager.findOnlineRole();
    const config = role ? maps.get(role.onMap) : undefined;
    if (!config || config.maxChannels <= 1) return;
    if (this.channelDialog.isOpen()) {
      this.channelDialog.close();
      return;
    }
    this.channelDialog.open(config.maxChannels, CombatChannel.currentChannel);
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
    // 地图在世界里的矩形（#566：原点在左上角，左下角 = 原点 - H）
    const bounds = getMapWorldRect(map);
    if (bounds.width <= 0 || bounds.height <= 0) return;
    // 比例由固定的内容区宽度反推（与 updateDots 同一入口，底图与点位不会各算一套）
    const scale = getSmallMapScale(smallMapLayout.contentSize.width);
    // 底图节点尺寸 = 地图像素尺寸（1 像素对 1 单位），再整体乘缩放 → 与坐标点换算同一个比例
    transform.setContentSize(bounds.width, bounds.height);
    image.node.setScale(scale, scale, 1);
    // 角色相对地图中心的世界偏移 × 缩放 = 角色在底图上的本地坐标，反向平移使角色落在视口中心
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    image.node.setPosition(-(rolePosition.x - centerX) * scale, -(rolePosition.y - centerY) * scale, 0);
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
    const dots: SmallMapDot[] = [
      { x: 0, y: 0, color: smallMapConfig.roleDotColor, radius: smallMapConfig.roleDotRadius, ringRadius: smallMapConfig.roleDotRingRadius },
    ];
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
