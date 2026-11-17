import { _decorator, Color, Component, EditBox, Graphics, Label, Node, Size, Sprite, sys, UIOpacity, UITransform, Vec2, isValid, tween } from "cc";
import GameUiHelper from "./helpers/GameUiHelper";
import UiHelper from "./helpers/UiHelper";
import StorageManager from "./core/StorageManager";
import SceneManager from "./core/SceneManager";
import SoundManager from "./core/SoundManager";
import { loginLayout, tipsLayout } from "../configs/hudLayout";
import { T } from "../configs/layout/tokens";
import { getText } from "../configs/texts";
import { AuthApi, AnnouncementApi, GameConfigApi, ZoneApi } from "./utils/net/Api";
import type { AuthResult, Zone } from "./utils/net/Api";
import type { AnnouncementView } from "../configs/announcement";
import { buildAnnouncementViews } from "../configs/announcement";
import { describeError } from "./utils/net/ApiError";
import { installNetwork } from "./utils/net/NetworkSetup";
import Session from "./utils/net/Session";
import { blockClickThrough } from "./utils/input/UiHit";
import AnnouncementNoticeDialog from "./components/dialogs/AnnouncementNoticeDialog";
import ZoneSelectDialog from "./components/dialogs/ZoneSelectDialog";
import { createRoundedPanel } from "./components/dialogs/tab-kit";
import { buttonTone } from "../configs/layout/sizes";
import ZoneStore from "./core/ZoneStore";
const { ccclass } = _decorator;

/** 「记住账号」的本机键（只记账号名，**密码从不落盘**；空 = 不记住） */
const REMEMBERED_ACCOUNT_KEY = "login_remembered_account";

/**
 * 登录场景（账号登录 / 账号注册）
 *
 * 账号体系统一走服务端（见 ui/utils/net）：登录/注册成功后把令牌存进 Session，
 * 请求层随后自动带上它 —— 客户端不再自己造账号，也不再硬编码任何地址。
 * 登录与注册共用一对输入框，submitting 标记防连点重复提交。
 *
 * **本页就选好区**（#1009）：面板里那颗「选服」按钮点它开选服弹窗。
 * 登录前没有令牌，所以列表用公共的 `GET /zones`（区名 / 状态 / 推荐）——
 * 拿不到「我在这区有几个角色」，也不需要：进哪个区由玩家定，角色列表进选角场景再拉。
 * 登录成功之后先按这个区落一次 `POST /zones/select`（见 submit → applyZone），
 * 选角页的 `GET /roles` 才是这个区的角色。
 *
 * **界面整版对齐设计稿**（#1036，design/olua-login）：1920×1080 绝对坐标四大块 ——
 * 顶栏（配置版本 / 背景音开关）、左侧文案区（眉题 / LOGO 主标 / 简介 /
 * 职业预览标签 / 公告栏）、右侧登录面板（账号 / 密码 / 选服 / 记住账号 / 进入游戏 /
 * 注册与修复入口）、底部条（版权 / 协议入口）。几何 / 配色 / 文案 key / 时长全部来自
 * `configs/layout/scenes.ts` 的 loginLayout 与 `configs/texts.ts`，本文件只负责组装与接线。
 *
 * **图标全部是图片**（设计稿 SVG 导出成 PNG，见 resources/ui/login/icon-*.png），
 * 本文件不再用 Graphics 画任何图标；Graphics 只画线（金线 / 分隔线）与圆角底。
 * 两态图标（眼睛 / 喇叭 / 勾选框）走同一个节点换 spriteFrame，不叠两个节点。
 * 左上品牌 LOGO 已按需求移除，只剩顶栏右侧的版本胶囊与背景音开关。
 *
 * **真实数据**：区服列表 `GET /zones`、公告栏 `GET /announcements/active`（拉不到或没有
 * 生效中公告就整条隐藏）、顶栏版本 `GET /game-config/version`（#1036 起公开，拉不到隐藏
 * 胶囊）、主标与顶栏品牌共用真实 LOGO 图（resources/logo.png）。
 * 「忘记密码 / 游戏修复 / 协议入口」客户端暂无对应功能，先飘字说明（暂时放置，
 * 重开条件：官网账号中心 / 资源校验 / 协议页落地）。
 */
@ccclass("Login")
export class Login extends Component {
  accountInput: Node;
  passwordInput: Node;
  /** 舞台容器（1920×1080 画布，四大块挂在它下面） */
  private stage: Node | null = null;
  /** 是否正在提交（登录与注册互斥） */
  private submitting = false;
  /** 公告提醒弹窗（进登录页时把生效中的重要公告摊开给玩家看，见该类的说明） */
  private announcementNotice = new AnnouncementNoticeDialog();
  /** 选服弹窗（#1009）：点面板里的「选服」按钮才开，不自动弹 */
  private zoneDialog = new ZoneSelectDialog();
  /** 选服按钮上的区名 / 状态字（列表拉到后刷新） */
  private serverNameLabel: Label | null = null;
  private serverStatusLabel: Label | null = null;
  /** 当前选中的区（列表还没拉到 / 拉失败时为 null —— 登录后按服务端记着的区走） */
  private pickedZone: Zone | null = null;
  /** 活区数（≥2 才响应选服按钮；单区服点了也是它） */
  private zoneCount = 0;
  /** 职业预览：标签节点与说明字（点标签换说明） */
  private classDescLabel: Label | null = null;
  private classTabNodes: Array<{ key: string; node: Node; label: Label; icon: Sprite | null }> = [];
  private classDescKeys = new Map<string, string>();
  /** 公告栏：滚动行与待轮换的公告标题 */
  private noticeBar: Node | null = null;
  private noticeLabel: Label | null = null;
  private noticeLines: string[] = [];
  private noticeIndex = 0;
  /** 顶栏版本胶囊（拉取失败整颗隐藏） */
  private versionPill: Node | null = null;
  /** 记住账号勾选态与勾选框（换两态图用） */
  private rememberChecked = false;
  private rememberSprite: Sprite | null = null;
  /** 密码显隐：眼睛图标与当前状态 */
  private passwordVisible = false;
  private eyeSprite: Sprite | null = null;
  /** 背景音开关状态与喇叭图标 */
  private muted = false;
  private musicSprite: Sprite | null = null;
  /** 主按钮（提交期间压暗） */
  private loginButtonNode: Node | null = null;

  start() {
    // 全局接线（幂等）：令牌失效回登录场景、请求失败统一飘字
    installNetwork();
    // 已有登录态（页面被误刷新 / 意外重载）→ 直接回选角，不让人重输账号密码。
    // 令牌若已过期，选角场景的请求会吃 401 → 网络层清会话并送回本场景，过期会话自然兜底
    if (Session.isLoggedIn) {
      SceneManager.loadScene("RoleSelector");
      return;
    }
    // 登录场景背景音（#683）：配置来自公开接口 `GET /game-config/audio`（登录页没有玩家令牌，
    // 快照拉不到），`play` 内部先补配置再播，所以这里不用 await —— 背景音晚半秒起来比登录页
    // 晚半秒出现好。已登录走上面的分支，不会响。
    void SoundManager.play("login_bgm");
    const layout = loginLayout;
    // 背景（不在舞台内：铺满整个屏幕；#1036 起用设计稿 hero-bg，与屏幕同比例不裁切）
    this.node.addChild(GameUiHelper.createFullScreenImage("login_background", layout.background));
    // 背景上的黑色半透明遮罩（设计稿 hero-scrim 的均匀层近似：压暗底图，文案与面板更可读）
    const scrim = new Node(layout.scrim.name);
    scrim.addComponent(UITransform).setContentSize(layout.stageSize.width, layout.stageSize.height);
    this.fillRect(this.addGraphics(scrim), layout.stageSize, layout.scrim.color);
    this.node.addChild(scrim);
    // 舞台容器：1920×1080 画布（不缩放），四大块按 z 顺序挂进来
    this.stage = new Node("login_stage");
    this.stage.addComponent(UITransform).setContentSize(layout.stageSize.width, layout.stageSize.height);
    this.node.addChild(this.stage);
    this.buildTopbar();
    this.buildHero();
    // 职业标签默认激活第一颗（战士）：选中底色 / 描边 / 文字与图标变亮 + 说明文案对齐
    this.selectClass(loginLayout.hero.classTabs.classes[0].key);
    this.buildPanel();
    this.buildBottombar();
    // 走到这里必然没有登录态（上方已拦截直接跳选角）：清掉上个账号的角色缓存与选中标记，
    // 避免换账号时串号 —— 有登录态的刷新不动缓存，回来还在原账号上
    StorageManager.clear();
    // 「记住账号」：把上次记住的账号名填回输入框（密码从不落盘，每次都要重输）
    this.restoreRememberedAccount();
    // 公告提醒：拉取「生效中的重要公告」（公共接口，无需令牌），有就弹、没有或拉取失败就静默 ——
    // 挂在本场景自己的节点上（登录场景没有 UI 图层容器，见 AnnouncementNoticeDialog 的说明），
    // 不 await：公告不该拖慢登录页的出现，也不阻塞账号密码输入
    void this.announcementNotice.open(this.node);
    // 区服列表（公共接口，无需令牌）：不 await 也不阻塞登录 —— 拉不到就不显示区名，
    // 登录后按服务端记着的区走（角色列表本来也按那个区拉）
    void this.loadZones();
    // 公告栏滚动行（公共接口）：与公告提醒弹窗同一份「生效中公告」，只取标题轮换展示
    void this.loadNoticeLines();
    // 顶栏配置版本（#1036 起公开接口）：拉不到就隐藏胶囊，不显示编造的版本号
    void this.loadVersionPill();
  }

  //#region 界面组装

  /** 顶栏：配置版本胶囊 + 背景音开关（左上品牌 LOGO 已移除） */
  private buildTopbar(): void {
    const { topbar, palette, radius } = loginLayout;
    // 版本胶囊：圆角 pill + 文本（值由 loadVersionPill 回填；拉取失败整颗隐藏）
    const pill = createRoundedPanel(topbar.version.name, topbar.version.size, palette.pillFill, palette.line, topbar.version.size.height / 2);
    pill.setPosition(topbar.version.position.x, topbar.version.position.y, 0);
    const versionLabel = UiHelper.createLabel(
      `${topbar.version.name}_label`,
      getText(topbar.version.textKey, { version: getText("login_version_unavailable") }),
      palette.muted,
      topbar.version.fontSize,
      new Vec2(),
      topbar.version.size,
    );
    pill.addChild(versionLabel);
    this.versionPill = pill;
    this.stage!.addChild(pill);
    // 背景音开关：圆角小方框 + 喇叭图（设计稿 PNG，静音换成带叉那张）
    const music = createRoundedPanel(topbar.music.name, topbar.music.size, palette.pillFill, palette.line, radius.control);
    music.setPosition(topbar.music.position.x, topbar.music.position.y, 0);
    const musicIcon = this.createIcon(`${topbar.music.name}_icon`, this.muted ? topbar.music.iconOff : topbar.music.icon, topbar.music.iconSize);
    this.musicSprite = musicIcon.sprite;
    music.addChild(musicIcon.node);
    this.bindClick(music, () => this.toggleMusic());
    this.stage!.addChild(music);
  }

  /** 首屏左列：眉题 / LOGO 主标 / 一句话简介 / 职业预览标签 / 公告栏 */
  private buildHero(): void {
    const { hero, palette, radius } = loginLayout;
    // 眉题：前置金线 + 左对齐小字
    const eyebrowLine = UiHelper.createNode(hero.eyebrow.line.name, hero.eyebrow.line.position, hero.eyebrow.line.size);
    this.fillRect(this.addGraphics(eyebrowLine), hero.eyebrow.line.size, palette.gold);
    this.stage!.addChild(eyebrowLine);
    this.stage!.addChild(this.createAlignedLabel(hero.eyebrow.label, palette.gold, Label.HorizontalAlign.LEFT));
    // 主标题：真实 LOGO 图（设计稿的大字标题用它替换）
    // 主标：金文字「Olua」（原 LOGO 图已换文字，框体同尺寸）
    this.stage!.addChild(
      UiHelper.createLabel(hero.logo.name, getText(hero.logo.textKey), palette.goldLight, hero.logo.fontSize, hero.logo.position, hero.logo.size),
    );
    // 一句话简介：宽度固定、按内容换行
    this.stage!.addChild(
      UiHelper.createWrappedLabel(
        "login_tagline_label",
        getText(hero.tagline.textKey),
        palette.inkSoft,
        hero.tagline.fontSize,
        hero.tagline.lineHeight,
        hero.tagline.position,
        hero.tagline.width,
        Label.HorizontalAlign.LEFT,
      ),
    );
    // 职业预览标签：三颗胶囊横排（从左边缘起等距），图标 + 文字，点它切换说明文案
    const tabSize = hero.classTabs.size;
    const tabIconSize = hero.classTabs.iconSize;
    // 图标中心 = 胶囊左缘 + 内边距 + 半个图标；文字中心 = 图标右侧 8px 之后的剩余宽度里居中
    const iconX = -tabSize.width / 2 + hero.classTabs.iconInset + tabIconSize.width / 2;
    const labelShift = (tabIconSize.width + hero.classTabs.iconGap) / 2;
    hero.classTabs.classes.forEach((cls, index) => {
      const leftEdge = hero.classTabs.firstLeftEdgeX + index * (tabSize.width + hero.classTabs.gap);
      const position = new Vec2(leftEdge + tabSize.width / 2, hero.classTabs.positionY);
      const node = createRoundedPanel(`login_class_tab_${cls.key}`, tabSize, palette.transparent, palette.line, tabSize.height / 2);
      node.setPosition(position.x, position.y, 0);
      const icon = this.createIcon(`login_class_tab_${cls.key}_icon`, cls.icon, tabIconSize, new Vec2(iconX, 0));
      // 图标 PNG 烘的是全亮骨白，未选中时靠 tint 压到 58%（与文字同一套两态）
      icon.sprite.color = palette.muted;
      node.addChild(icon.node);
      const tabLabel = UiHelper.createLabel(
        `login_class_tab_${cls.key}_label`,
        getText(cls.labelKey),
        palette.muted,
        hero.classTabs.fontSize,
        new Vec2(labelShift, 0),
        new Size(tabSize.width - hero.classTabs.iconInset - tabIconSize.width - hero.classTabs.iconGap, tabSize.height),
      );
      node.addChild(tabLabel);
      const label = tabLabel.getComponent(Label)!;
      this.classDescKeys.set(cls.key, cls.descKey);
      this.classTabNodes.push({ key: cls.key, node, label, icon: icon.sprite });
      this.bindClick(node, () => this.selectClass(cls.key));
      this.stage!.addChild(node);
    });
    // 职业说明（默认第一颗；selectClass 会把文案填上）
    const classDesc = this.createAlignedLabel(
      { name: hero.classDesc.name, textKey: hero.classTabs.classes[0].descKey, position: hero.classDesc.position, size: hero.classDesc.size, fontSize: hero.classDesc.fontSize },
      palette.inkSoft,
      Label.HorizontalAlign.LEFT,
    );
    this.classDescLabel = classDesc.getComponent(Label);
    this.stage!.addChild(classDesc);
    // 公告栏：底条 + 朱红左缘 + 「公告」标签 + 滚动行（数据由 loadNoticeLines 回填，没有就整条隐藏）
    const notice = hero.notice;
    const bar = createRoundedPanel(notice.name, notice.size, palette.noticeFill, palette.line, radius.control);
    bar.setPosition(notice.position.x, notice.position.y, 0);
    const accentEdge = this.addGraphics(bar);
    this.fillRect(accentEdge, new Size(notice.edgeWidth, notice.size.height), palette.accent, new Vec2(-notice.size.width / 2 + notice.edgeWidth / 2, 0));
    // 公告图标（设计稿 PNG，15px）+ 「公告」标签
    bar.addChild(GameUiHelper.createImage(notice.icon.name, notice.icon.image, new Vec2(notice.icon.offsetX, 0), notice.icon.size));
    const noticeTitle = UiHelper.createLabel(
      `${notice.name}_label`,
      getText(notice.label.textKey),
      palette.gold,
      notice.label.fontSize,
      new Vec2(notice.label.offsetX, 0),
      notice.label.size,
    );
    bar.addChild(noticeTitle);
    const noticeLine = UiHelper.createLabel(`${notice.name}_line`, "", palette.inkSoft, notice.row.fontSize, new Vec2(notice.row.offsetX, 0), notice.row.size, Label.HorizontalAlign.LEFT);
    bar.addChild(noticeLine);
    this.noticeLabel = noticeLine.getComponent(Label);
    this.noticeBar = bar;
    this.stage!.addChild(bar);
  }

  /** 右侧登录面板：眉题 / 标题 / 输入框 / 选服 / 记住账号 / 主按钮 / 次要入口 / 脚注 */
  private buildPanel(): void {
    const { panel, palette, radius } = loginLayout;
    // 面板壳：矢量底板（主体色 + 顶部亮带 + 1px 金线 + 内侧高光 + 四角铆钉，见 createDialogPanel）
    const panelNode = GameUiHelper.createDialogPanel(panel.name, panel.size);
    panelNode.setPosition(panel.position.x, panel.position.y, 0);
    this.stage!.addChild(panelNode);
    // 左上角小字（ACCOUNT）
    panelNode.addChild(this.createAlignedLabel(panel.eyebrow, palette.goldDark, Label.HorizontalAlign.LEFT));
    // 标题 + 金色下划线
    panelNode.addChild(UiHelper.createLabel(`${panel.name}_title`, getText(panel.title.textKey), palette.ink, panel.title.fontSize, panel.title.position, panel.title.size));
    const underline = UiHelper.createNode(panel.titleUnderline.name, panel.titleUnderline.position, panel.titleUnderline.size);
    this.fillRect(this.addGraphics(underline), panel.titleUnderline.size, palette.gold);
    panelNode.addChild(underline);
    // 账号 / 密码输入框（圆角暗底 + 图标 + EditBox，几何同 configs/uiTheme.inputField 口径）
    const account = this.createField(panel.account);
    this.accountInput = account.input;
    panelNode.addChild(account.node);
    const password = this.createField(panel.password);
    this.passwordInput = password.input;
    panelNode.addChild(password.node);
    // 密码显隐（挂在密码框内右侧；眼睛图标两态换图，点它切换掩码）
    const eye = UiHelper.createNode(panel.eye.name, new Vec2(panel.eye.offsetX, panel.eye.offsetY), panel.eye.size);
    const eyeIcon = this.createIcon(`${panel.eye.name}_icon`, this.passwordVisible ? panel.eye.iconOn : panel.eye.icon, panel.eye.iconSize);
    this.eyeSprite = eyeIcon.sprite;
    eye.addChild(eyeIcon.node);
    // 点击登记在图标节点上：容器只是 30×30 的定位框，没有渲染组件不参与命中
    this.bindClick(eyeIcon.node, () => this.togglePasswordVisible());
    password.node.addChild(eye);
    // 选服按钮（#1009）：地球小图（PNG）+ 区名 / 状态字由 loadZones 回填
    const serverButton = createRoundedPanel(panel.server.name, panel.server.size, palette.fieldFill, palette.line, radius.control);
    serverButton.setPosition(panel.server.position.x, panel.server.position.y, 0);
    serverButton.addChild(GameUiHelper.createImage(`${panel.server.name}_globe`, panel.server.globeIcon, new Vec2(panel.server.globeX, 0), panel.server.globeSize));
    const serverName = UiHelper.createLabel(`${panel.server.name}_name`, getText("login_zone_unknown"), palette.ink, panel.server.fontSize, new Vec2(panel.server.nameX, 0), panel.server.nameSize, Label.HorizontalAlign.LEFT);
    serverButton.addChild(serverName);
    this.serverNameLabel = serverName.getComponent(Label);
    const serverStatus = UiHelper.createLabel(`${panel.server.name}_status`, "", palette.accentText, panel.server.statusFontSize, new Vec2(panel.server.statusX, 0), panel.server.statusSize);
    serverButton.addChild(serverStatus);
    this.serverStatusLabel = serverStatus.getComponent(Label);
    serverButton.addChild(GameUiHelper.createImage(`${panel.server.name}_caret`, panel.server.caretIcon, new Vec2(panel.server.caretX, 0), panel.server.caretSize));
    this.bindClick(serverButton, () => void this.openZonePicker());
    panelNode.addChild(serverButton);
    // 记住账号行：勾选框（两态 PNG）+ 文案（左）/ 忘记密码（右）
    const remember = panel.remember;
    const checkboxIcon = this.createIcon(remember.checkbox.name, this.rememberChecked ? remember.checkbox.iconChecked : remember.checkbox.icon, remember.checkbox.size);
    checkboxIcon.node.setPosition(remember.checkbox.offsetX, remember.positionY, 0);
    this.rememberSprite = checkboxIcon.sprite;
    this.bindClick(checkboxIcon.node, () => this.toggleRemember());
    panelNode.addChild(checkboxIcon.node);
    const rememberLabel = this.createAlignedLabel(
      { name: `${remember.label.textKey}_label`, textKey: remember.label.textKey, position: new Vec2(remember.label.offsetX, remember.positionY), size: remember.label.size, fontSize: remember.label.fontSize },
      palette.muted,
    );
    this.bindClick(rememberLabel, () => this.toggleRemember());
    panelNode.addChild(rememberLabel);
    const forgot = this.createAlignedLabel(
      { name: `${remember.forgot.textKey}_label`, textKey: remember.forgot.textKey, position: new Vec2(remember.forgot.offsetX, remember.positionY), size: remember.forgot.size, fontSize: remember.forgot.fontSize },
      palette.muted,
    );
    this.bindClick(forgot, () => GameUiHelper.createTip("login_forgot_tip"));
    panelNode.addChild(forgot);
    // 主按钮：朱红渐变（矢量底板 + 上半亮带 + 描边，primary 色调）
    const button = GameUiHelper.createToneButton(
      panel.loginButton.name,
      getText(panel.loginButton.textKey),
      panel.loginButton.position,
      panel.loginButton.size,
      panel.loginButton.fontSize,
      buttonTone.primary,
    );
    // 点击音与鼠标通道拦截已在按钮工厂里登记（再调 bindClick 会响两声）
    button.on(Node.EventType.TOUCH_END, () => void this.login(), this);
    this.loginButtonNode = button;
    panelNode.addChild(button);
    // 次要入口行：注册新账号（复用上方输入框）/ 游戏修复（暂时放置 → 飘字）
    const altRow = panel.altRow;
    const register = this.createAlignedLabel(
      { name: `${altRow.register.textKey}_label`, textKey: altRow.register.textKey, position: new Vec2(altRow.register.offsetX, altRow.positionY), size: altRow.register.size, fontSize: altRow.register.fontSize },
      palette.muted,
    );
    this.bindClick(register, () => void this.register());
    panelNode.addChild(register);
    const repair = this.createAlignedLabel(
      { name: `${altRow.repair.textKey}_label`, textKey: altRow.repair.textKey, position: new Vec2(altRow.repair.offsetX, altRow.positionY), size: altRow.repair.size, fontSize: altRow.repair.fontSize },
      palette.muted,
    );
    this.bindClick(repair, () => GameUiHelper.createTip("login_repair_tip"));
    panelNode.addChild(repair);
    // 脚注：1px 分隔线 + 合规文案
    const footLine = UiHelper.createNode(panel.foot.line.name, panel.foot.line.position, panel.foot.line.size);
    this.fillRect(this.addGraphics(footLine), panel.foot.line.size, palette.lineFaint);
    panelNode.addChild(footLine);
    panelNode.addChild(
      UiHelper.createLabel(`${panel.name}_foot`, getText(panel.foot.text.textKey), palette.muted, panel.foot.text.fontSize, panel.foot.text.position, panel.foot.text.size),
    );
  }

  /** 底部条：版权（左）/ 协议入口（右，暂时放置 → 飘字） */
  private buildBottombar(): void {
    const { bottombar, palette } = loginLayout;
    this.stage!.addChild(this.createAlignedLabel(bottombar.copyright, palette.muted));
    bottombar.links.forEach((link) => {
      const node = this.createAlignedLabel(link, palette.muted);
      this.bindClick(node, () => GameUiHelper.createTip("login_link_todo_tip"));
      this.stage!.addChild(node);
    });
  }

  /**
   * 从配置项建文本标签（位置 / 尺寸 / 字号全在配置里，文本 key 同样在配置里）
   *
   * 配置项形状：{ name?, textKey, position, size, fontSize }。
   * 文本节点名优先取配置的 name；没写的（面板内的小字）用「key_label」兜底，
   * 同一个 key 不会在同一次构建里出现两颗。
   */
  private createAlignedLabel(item: { name?: string; textKey: string; position?: Vec2; size: Size; fontSize: number }, color: Color, align: Label["horizontalAlign"] = Label.HorizontalAlign.CENTER): Node {
    const name = item.name ?? `${item.textKey}_label`;
    return UiHelper.createLabel(name, getText(item.textKey), color, item.fontSize, item.position ?? new Vec2(), item.size, align);
  }

  /** 造一个输入框组（圆角暗底 + 左侧图标 + EditBox）；视觉统一走 UiHelper.createVectorInputField */
  private createField(config: {
    name: string;
    placeholder: string;
    position: Vec2;
    size: Size;
    icon: string;
    password: boolean;
    inputFontSize: number;
    inputHeight: number;
    inputInset: number;
  }): { node: Node; input: Node } {
    // 视觉走 UiHelper.createVectorInputField（登录 / 弹窗输入框的唯一视觉来源），本方法只做配置转接
    return UiHelper.createVectorInputField(config.placeholder, config.position, config.size, {
      icon: config.icon,
      password: config.password,
      fontSize: config.inputFontSize,
      inset: config.inputInset,
      height: config.inputHeight,
    });
  }

  //#endregion

  //#region 图片图标与线条（图标一律是设计稿 SVG 导出的 PNG；Graphics 只画线与圆角底）

  /**
   * 造一个图片图标节点（设计稿 SVG 导出的 PNG）
   *
   * 返回节点与 Sprite：两态图标（眼睛 / 喇叭 / 勾选框）由调用方拿 sprite 换图，
   * 不叠两个节点 —— 换图只改 spriteFrame，位置尺寸保持配置里的值。
   */
  private createIcon(name: string, src: string, size: Size, position: Vec2 = new Vec2()): { node: Node; sprite: Sprite } {
    const node = UiHelper.createSprite(name, src, position, size);
    return { node, sprite: node.getComponent(Sprite)! };
  }

  /** 两态换图：加载目标 PNG 后替换 spriteFrame（加载失败保持原图，不闪白） */
  private swapIcon(sprite: Sprite | null, src: string): void {
    if (!sprite || !isValid(sprite, true)) return;
    UiHelper.loadSprite(src, (frame) => {
      if (isValid(sprite, true)) sprite.spriteFrame = frame;
    });
  }

  /** 给节点补一个 Graphics 组件（重复调用复用同一个） */
  private addGraphics(node: Node): Graphics {
    const existing = node.getComponent(Graphics);
    if (existing) return existing;
    return node.addComponent(Graphics) as Graphics;
  }

  /** 以节点中心为原点画一个实心矩形（可带偏移） */
  private fillRect(graphics: Graphics, size: Size, color: Color, offset: Vec2 = new Vec2()): void {
    graphics.fillColor = color;
    graphics.rect(offset.x - size.width / 2, offset.y - size.height / 2, size.width, size.height);
    graphics.fill();
  }

  //#endregion

  //#region 交互接线

  /**
   * 统一的可点元素接线：点击音（#685）+ 鼠标通道拦截（防穿透）+ 触摸响应
   *
   * 与 ZoneSelectDialog 的行同一套口径：blockClickThrough 要在本文件里显式写出来，
   * tools/audit-ui-click-through.cjs 才能在注册点看到鼠标通道登记。
   */
  private bindClick(node: Node, onPress: () => void): void {
    SoundManager.bindClick(node);
    blockClickThrough(node);
    node.on(Node.EventType.TOUCH_END, onPress, this);
  }

  /** 职业预览：换选中态与说明文案 */
  private selectClass(key: string): void {
    const { palette } = loginLayout;
    const tabSize = loginLayout.hero.classTabs.size;
    this.classTabNodes.forEach((tab) => {
      const active = tab.key === key;
      const graphics = this.addGraphics(tab.node);
      graphics.clear();
      // 未选中补半透明暗底（稿的胶囊是暗底描边；纯透明底 + 1px 描边实机不渲染）
      UiHelper.paintRoundedPanel(
        graphics,
        tabSize,
        tabSize.height / 2,
        active ? palette.tabActiveFill : T.surface.scrim,
        active ? palette.gold : palette.line,
      );
      tab.label.color = active ? palette.ink : palette.muted;
      // 图标是图片：靠 tint 跟着文字一起变（烘的是全亮骨白，未选中压到 58%）
      if (tab.icon && isValid(tab.icon, true)) tab.icon.color = active ? palette.ink : palette.muted;
    });
    const descKey = this.classDescKeys.get(key);
    if (descKey && this.classDescLabel && isValid(this.classDescLabel.node, true)) {
      this.classDescLabel.string = getText(descKey);
    }
  }

  /** 密码显隐：切换掩码并换眼睛图（睁眼 = 亮金那张） */
  private togglePasswordVisible(): void {
    this.passwordVisible = !this.passwordVisible;
    this.passwordInput.getComponent(EditBox).inputFlag = this.passwordVisible ? EditBox.InputFlag.DEFAULT : EditBox.InputFlag.PASSWORD;
    this.swapIcon(this.eyeSprite, this.passwordVisible ? loginLayout.panel.eye.iconOn : loginLayout.panel.eye.icon);
  }

  /** 记住账号：切勾选态并换勾选框图（真正落盘在登录成功之后，见 persistRememberedAccount） */
  private toggleRemember(): void {
    this.rememberChecked = !this.rememberChecked;
    const checkbox = loginLayout.panel.remember.checkbox;
    this.swapIcon(this.rememberSprite, this.rememberChecked ? checkbox.iconChecked : checkbox.icon);
  }

  /** 背景音开关：只管登录页这一首背景音（静音 = 停，恢复 = 重播） */
  private toggleMusic(): void {
    this.muted = !this.muted;
    if (this.muted) SoundManager.stopMusic();
    else void SoundManager.play("login_bgm");
    this.swapIcon(this.musicSprite, this.muted ? loginLayout.topbar.music.iconOff : loginLayout.topbar.music.icon);
    GameUiHelper.createTip(this.muted ? "login_music_off_tip" : "login_music_on_tip");
  }

  /** 「记住账号」回填：把上次记住的账号名填进输入框并勾上勾选框 */
  private restoreRememberedAccount(): void {
    const remembered = sys.localStorage.getItem(REMEMBERED_ACCOUNT_KEY);
    if (!remembered) return;
    this.rememberChecked = true;
    this.swapIcon(this.rememberSprite, loginLayout.panel.remember.checkbox.iconChecked);
    if (this.accountInput && isValid(this.accountInput, true)) this.accountInput.getComponent(EditBox).string = remembered;
  }

  /** 登录成功后按勾选态落盘（只记账号名，密码从不落盘） */
  private persistRememberedAccount(username: string): void {
    if (this.rememberChecked) sys.localStorage.setItem(REMEMBERED_ACCOUNT_KEY, username);
    else sys.localStorage.removeItem(REMEMBERED_ACCOUNT_KEY);
  }

  /** 主按钮压暗 / 恢复（提交期间禁止视觉上的重复点击） */
  private setLoginButtonDimmed(dimmed: boolean): void {
    if (!this.loginButtonNode || !isValid(this.loginButtonNode, true)) return;
    const opacity = this.loginButtonNode.getComponent(UIOpacity) ?? this.loginButtonNode.addComponent(UIOpacity);
    opacity.opacity = dimmed ? 140 : 255;
  }

  //#endregion

  //#region 真实数据（区服 / 公告 / 版本）

  /**
   * 拉一次活区列表，选默认区并刷新选服按钮（#1009）
   *
   * 默认区优先级：
   * 1. **本机记着的那个区**（`ZoneStore`，还开放）—— 玩家上次自己选的，最该被尊重；
   * 2. **运营推荐区**（`recommended`，还开放）—— 新玩家 / 记录失效时的落点，运营想让新人
   *    去哪个区用这个标志表达，不靠客户端猜；
   * 3. **最新的开放区**（id 最大 = 最后建的）。
   *
   * 拉不到列表只提示一句、不阻塞登录：这时按钮上不显示区名，登录后按服务端记着的区继续。
   */
  private async loadZones(): Promise<void> {
    let zones: Zone[];
    try {
      zones = await ZoneApi.list();
    } catch (error) {
      console.warn(`[Login] 区服列表加载失败（登录后按服务端记着的区进入）：${describeError(error)}`);
      GameUiHelper.createTip("zone_load_failed_tip");
      return;
    }
    if (!isValid(this.node)) return;
    this.zoneCount = zones.length;
    const target = this.pickDefaultZone(zones);
    if (!target) return;
    this.pickedZone = target;
    // 记在本机：按钮文案与游戏内（榜单 / 帮会标题）都要用区名
    ZoneStore.set(target.id, target.name);
    this.renderServerButton();
  }

  /** 默认区（优先级见 loadZones 的注释）；一个开放区都没有时返回 null */
  private pickDefaultZone(zones: Zone[]): Zone | null {
    const open = zones.filter((zone) => zone.status === "open");
    const remembered = ZoneStore.get();
    const rememberedHit = remembered ? open.find((zone) => zone.id === remembered.id) : undefined;
    if (rememberedHit) return rememberedHit;
    const recommended = open.find((zone) => zone.recommended);
    if (recommended) return recommended;
    // 最新的开放区：id 自增，最大 = 最后建的
    return open.length > 0 ? open.reduce((newest, zone) => (zone.id > newest.id ? zone : newest)) : null;
  }

  /**
   * 刷新选服按钮文案
   *
   * 区名还没拿到时保持「正在获取…」占位；选好区显示区名 + 开放状态。
   * 多区才响应点击（单区服弹出来也只有它自己，见 openZonePicker）。
   */
  private renderServerButton(): void {
    if (!this.serverNameLabel || !isValid(this.serverNameLabel.node, true)) return;
    if (!this.pickedZone) return;
    this.serverNameLabel.string = this.pickedZone.name;
    if (this.serverStatusLabel && isValid(this.serverStatusLabel.node, true)) {
      this.serverStatusLabel.string =
        this.pickedZone.status === "open" ? getText("zone_status_open") : getText("zone_status_maintenance");
    }
  }

  /** 打开选服弹窗（单区服不响应：弹出来也只有它自己） */
  private async openZonePicker(): Promise<void> {
    if (this.zoneCount < 2) return;
    await this.zoneDialog.open(this.node, this.pickedZone?.id ?? null, (zone) => this.onZonePicked(zone));
  }

  /** 选好区之后：只刷新按钮文案（落服务端在登录成功之后，见 applyZone） */
  private onZonePicked(zone: Zone): void {
    this.pickedZone = zone;
    this.renderServerButton();
  }

  /**
   * 公告栏滚动行：拉「生效中的公告」（公共接口，silent —— 拉不到整条隐藏，与公告提醒弹窗同口径），
   * 取标题做轮换文案；一条都没有时整条隐藏，不摆空架子
   */
  private async loadNoticeLines(): Promise<void> {
    let views: AnnouncementView[] = [];
    try {
      const list = await AnnouncementApi.active({ silent: true });
      // 已读记录不参与（登录页的公告栏只是展示，不影响游戏内的已读角标）
      views = buildAnnouncementViews(list, []);
    } catch (error) {
      console.warn(`[Login] 公告栏拉取失败（整条隐藏）：${describeError(error)}`);
      return;
    }
    if (!isValid(this.node)) return;
    this.noticeLines = views.map((view) => view.title);
    if (!this.noticeBar || !isValid(this.noticeBar, true)) return;
    if (this.noticeLines.length === 0) {
      this.noticeBar.active = false;
      return;
    }
    this.noticeIndex = 0;
    this.renderNoticeLine();
    this.scheduleNoticeRoll();
  }

  /** 渲染当前轮到的那条公告标题 */
  private renderNoticeLine(): void {
    if (!this.noticeLabel || !isValid(this.noticeLabel.node, true)) return;
    this.noticeLabel.string = this.noticeLines[this.noticeIndex] ?? "";
  }

  /** 到点轮换下一条（淡出 → 换文案 → 淡入 → 再排下一次）；只有一条公告时不轮换 */
  private scheduleNoticeRoll(): void {
    if (this.noticeLines.length < 2) return;
    this.scheduleOnce(() => this.rollNoticeLine(), loginLayout.hero.notice.rollMs / 1000);
  }

  private rollNoticeLine(): void {
    if (!this.noticeLabel || !isValid(this.noticeLabel.node, true)) return;
    const fade = loginLayout.hero.notice.fadeMs / 1000;
    const opacity = this.noticeLabel.node.getComponent(UIOpacity) ?? this.noticeLabel.node.addComponent(UIOpacity);
    tween(opacity)
      .to(fade, { opacity: 0 })
      .call(() => {
        this.noticeIndex = (this.noticeIndex + 1) % this.noticeLines.length;
        this.renderNoticeLine();
      })
      .to(fade, { opacity: 255 })
      .call(() => this.scheduleNoticeRoll())
      .start();
  }

  /** 顶栏配置版本（#1036 起公开接口）：拉取成功回填文字，失败整颗隐藏 */
  private async loadVersionPill(): Promise<void> {
    try {
      const result = await GameConfigApi.version({ auth: false });
      if (!this.versionPill || !isValid(this.versionPill, true)) return;
      const label = this.versionPill.getChildByName(`${loginLayout.topbar.version.name}_label`);
      if (label) label.getComponent(Label).string = getText(loginLayout.topbar.version.textKey, { version: result.version });
    } catch (error) {
      console.warn(`[Login] 配置版本拉取失败（隐藏版本胶囊）：${describeError(error)}`);
      if (this.versionPill && isValid(this.versionPill, true)) this.versionPill.active = false;
    }
  }

  //#endregion

  //#region 登录 / 注册（逻辑与整版改版前一致）

  /** 登录 */
  async login() {
    const credentials = this.readCredentials();
    if (!credentials) return;
    this.setLoginButtonDimmed(true);
    try {
      await this.submit(() => AuthApi.login({ username: credentials.username, password: credentials.password }));
    } finally {
      this.setLoginButtonDimmed(false);
    }
  }

  /** 注册（成功后直接进选角场景，无需再登录一次） */
  async register() {
    const credentials = this.readCredentials();
    if (!credentials) return;
    // 注册只建账号：区是角色的属性，建角落在登录页选好的那个区（#1009）
    await this.submit(() => AuthApi.register({ username: credentials.username, password: credentials.password }));
  }

  /** 读输入框（为空时提示并返回 null） */
  private readCredentials(): { username: string; password: string } | null {
    const username = this.readUsername();
    const password = this.passwordInput.getComponent(EditBox).string;
    if (!username || !password) {
      GameUiHelper.createTip("login_input_empty_tip");
      return null;
    }
    return { username, password };
  }

  /** 取账号输入框的账号名（落「记住账号」用；已去首尾空白） */
  private readUsername(): string {
    return this.accountInput.getComponent(EditBox).string.trim();
  }

  /**
   * 提交登录 / 注册
   * 成功后存会话、按登录页选的区落一次，再进选角场景；失败由网络层统一飘字
   * （服务端文案如「账号或密码错误」直接展示）
   */
  private async submit(action: () => Promise<AuthResult>) {
    if (this.submitting) return;
    this.submitting = true;
    // 点击音不在这里（#685 移到 SoundManager.bindClick）：本页的可点元素都在 bindClick 里
    // 建好时就带上了；在这里再播一次会响两声
    try {
      const result = await action();
      Session.save(result.token, result.account);
      this.persistRememberedAccount(this.readUsername());
      // 区必须在进选角页之前落地：GET /roles 按「当前浏览区」过滤，晚一步拉到的就是另一个区
      const fellBack = await this.applyZone();
      // 兜底换过区就先等飘字走完：飘字挂在本场景的 Canvas 上，立刻换场景会把它一起销毁
      // （与 RoleSelector.backToLoginWhenUnreachable 同一个坑）
      if (fellBack) await this.waitTipGone();
      SceneManager.loadScene("RoleSelector");
    } catch (error) {
      console.warn(`[Login] 提交失败：${describeError(error)}`);
    } finally {
      this.submitting = false;
    }
  }

  /** 等一条飘字「上浮 + 淡出」走完（时长见 tipsLayout，与 createTip 用的是同一组数） */
  private waitTipGone(): Promise<void> {
    const duration = tipsLayout.messageMoveDuration + tipsLayout.messageFadeDuration;
    return new Promise((resolve) => this.scheduleOnce(() => resolve(), duration));
  }

  /**
   * 把登录页选的区落到服务端（#1009）
   *
   * 登录前没有令牌，只能记在本机；拿到令牌后立刻 `POST /zones/select` ——
   * 之后选角页的 `GET /roles` 拉到的就是这个区的角色（选角页不再自己对齐区）。
   *
   * **失败不挡进游戏**：网络层已经飘过服务端文案（维护 / 关闭 / 已合并）。这时重拉一次
   * 区列表，若这个区确实进不去，就换一个还能进的并飘字说明；换不了就按服务端记着的区继续 ——
   * 区服系统出问题不该让人卡在登录页。
   *
   * @returns 是否换了兜底区（调用方据此决定要不要等飘字走完再换场景）
   */
  private async applyZone(): Promise<boolean> {
    const zone = this.pickedZone;
    if (!zone) return false;
    try {
      await ZoneApi.select({ zoneId: zone.id });
      return false;
    } catch (error) {
      console.warn(`[Login] 选定区服切换失败：${describeError(error)}`);
    }
    const fallback = await this.pickFallbackZone(zone.id);
    if (!fallback) return false;
    try {
      await ZoneApi.select({ zoneId: fallback.id });
      ZoneStore.set(fallback.id, fallback.name);
      GameUiHelper.createTip("zone_fallback_tip", { from: zone.name, to: fallback.name });
      return true;
    } catch (error) {
      console.warn(`[Login] 兜底区服切换失败（按服务端记着的区继续）：${describeError(error)}`);
      return false;
    }
  }

  /**
   * 换一个还能进的区（推荐 → 最新开放区）
   *
   * 两个前提：这个区**确实进不去了**（不在列表里 / 已不是开放状态），而且还有别的开放区。
   * 区还在开放就返回 null —— 那次失败多半是网络抖动，不能因为一次抖动把玩家换到别的区。
   */
  private async pickFallbackZone(failedId: number): Promise<Zone | null> {
    let zones: Zone[];
    try {
      zones = await ZoneApi.list();
    } catch {
      return null;
    }
    const failed = zones.find((zone) => zone.id === failedId);
    if (failed && failed.status === "open") return null;
    const open = zones.filter((zone) => zone.status === "open");
    if (open.length === 0) return null;
    const recommended = open.find((zone) => zone.recommended);
    return recommended ?? open.reduce((newest, zone) => (zone.id > newest.id ? zone : newest));
  }

  //#endregion
}
