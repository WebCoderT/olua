import { Camera, isValid, Node, Vec2, Vec3 } from "cc";
import { isPointOnUi as uiHitTest, isPointOnWorldInteractive as worldInteractiveHitTest } from "../utils/input/UiHit";

export enum Layer {
  MAP = 1 << 0,
  DROP = 1 << 1,
  GAME = 1 << 2,
  MONSTER = 1 << 3,
  EFFECT = 1 << 4,
  UI = 1 << 5,
}

/**
 * 图层管理器
 * 负责场景内各渲染图层（地图层/掉落层/怪物层/游戏层/特效层/UI层）的初始化与元素挂载
 * 图层容器为静态节点，会随场景销毁，因此每次进场景（initLayer）都必须重建
 */
export default class LayerManager {
  /** 相机（初始化后可用） */
  static camera: Camera | null = null;

  /** 已注册图层继承监听的节点（弱引用，节点销毁后自动回收） */
  private static layerWatchers = new WeakSet<Node>();

  /** 地图层 */
  static MapLayer: Node = new Node("map_layer");
  /** 掉落层（怪物死亡掉落物） */
  static DropLayer: Node = new Node("drop_layer");
  /** 游戏层 */
  static GameLayer: Node = new Node("game_layer");
  /** 怪物层 */
  static MonsterLayer: Node = new Node("monster_layer");
  /** 特效层 */
  static EffectLayer: Node = new Node("effect_layer");
  /** UI层 */
  static UILayer: Node = new Node("ui_layer");

  /**
   * 循环元素下所有元素添加至指定图层
   * 同时为整棵子树注册「新增子节点自动继承图层」监听
   * （引擎新建节点的 layer 恒为 DEFAULT，不在相机 visibility 内，且不会随父节点继承，
   * 挂载图层之后再动态新建的子节点会渲染不出来，例如背包刷新、装备槽换装、属性列表重建）
   */
  static setNodeToLayer(node: Node, layer: Layer) {
    node.layer = layer;
    this.watchChildAdded(node, layer);
    node.children.forEach((child) => {
      this.setNodeToLayer(child, layer);
    });
  }

  /**
   * 为节点注册一次「新增子节点自动继承图层」监听（同一节点只注册一次）
   * 节点销毁时监听随之回收，不会残留
   */
  private static watchChildAdded(node: Node, layer: Layer) {
    if (this.layerWatchers.has(node)) return;
    this.layerWatchers.add(node);
    node.on(Node.EventType.CHILD_ADDED, (child: Node) => {
      // 节点已被移出该图层时跳过，避免残留监听把子节点刷回旧图层
      if (!isValid(node) || node.layer !== layer) return;
      this.setNodeToLayer(child, layer);
    });
  }

  /**
   * 初始化所有图层
   * 图层容器是静态节点，上个场景销毁时会被连带销毁，因此这里必须重建，
   * 不能把已销毁的旧容器再挂到新场景（会触发 Node.walk 读取 null children 崩溃）
   */
  static initLayer(scene: Node, camera: Camera) {
    this.camera = camera;
    // 摄像机设置可视图层
    camera.visibility = Layer.UI | Layer.EFFECT | Layer.MAP | Layer.DROP | Layer.GAME | Layer.MONSTER;
    // 重建全部图层容器
    this.MapLayer = this.createLayer(scene, "map_layer", Layer.MAP);
    this.DropLayer = this.createLayer(scene, "drop_layer", Layer.DROP);
    this.GameLayer = this.createLayer(scene, "game_layer", Layer.GAME);
    this.MonsterLayer = this.createLayer(scene, "monster_layer", Layer.MONSTER);
    this.EffectLayer = this.createLayer(scene, "effect_layer", Layer.EFFECT);
    this.UILayer = this.createLayer(scene, "ui_layer", Layer.UI);
    // 注意：UI 根**没有 UITransform**，绝不能在它上面注册任何鼠标事件——
    // 引擎的 pointer-event-dispatcher 整理鼠标监听节点列表时会读 `trans!.cameraPriority`（非空断言），
    // 没有 UITransform 的节点会让每次鼠标事件都抛「Cannot read properties of null (reading 'cameraPriority')」，
    // 整个预览的鼠标交互全废（详见 utils/input/Pointer.ensureMouseHitTestable 的说明）。
    // 「按压起点」因此改由各个在鼠标通道上有监听的界面元素自己登记（utils/input/Pointer.trackUiPress）。
  }

  /** 创建图层容器并挂到场景下 */
  private static createLayer(scene: Node, name: string, layer: Layer): Node {
    // 同一场景内重复初始化时，先移除仍然有效的旧同名容器，避免出现两份
    const existed = scene.getChildByName(name);
    if (existed && isValid(existed)) existed.removeFromParent();
    const node = new Node(name);
    scene.addChild(node);
    // 容器自身与后续动态新增的子节点都对齐到该图层
    this.setNodeToLayer(node, layer);
    return node;
  }

  /** 清除地图层 */
  static clearMapLayer() {
    if (isValid(this.MapLayer)) this.MapLayer.removeAllChildren();
  }

  /** 添加元素至地图层 */
  static addToMapLayer(node: Node) {
    this.setNodeToLayer(node, Layer.MAP);
    this.MapLayer.addChild(node);
  }

  /** 添加元素至游戏层 */
  static addToGameLayer(node: Node) {
    this.setNodeToLayer(node, Layer.GAME);
    this.GameLayer.addChild(node);
  }

  /** 清除掉落层 */
  static clearDropLayer() {
    if (isValid(this.DropLayer)) this.DropLayer.removeAllChildren();
  }

  /** 添加元素至掉落层 */
  static addToDropLayer(node: Node) {
    this.setNodeToLayer(node, Layer.DROP);
    this.DropLayer.addChild(node);
  }

  /** 清除怪物层 */
  static clearMonsterLayer() {
    if (isValid(this.MonsterLayer)) this.MonsterLayer.removeAllChildren();
  }

  /** 添加元素至怪物层 */
  static addToMonsterLayer(node: Node) {
    this.setNodeToLayer(node, Layer.MONSTER);
    this.MonsterLayer.addChild(node);
  }

  /** 添加元素至特效层 */
  static addToEffectLayer(node: Node) {
    this.setNodeToLayer(node, Layer.EFFECT);
    this.EffectLayer.addChild(node);
  }

  /** 添加元素至UI层 */
  static addToUILayer(node: Node) {
    this.setNodeToLayer(node, Layer.UI);
    this.UILayer.addChild(node);
  }

  //#region 弹窗层级（点击置顶）

  /**
   * UI 层里的弹窗（按挂载顺序累计）
   *
   * 只有登记进这份清单的节点参与「点击置顶」（见 raiseDialog）—— 飘字提示、悬停物品详情、
   * 死亡遮罩这类**临时层/盖在最上的遮罩**不登记：它们在弹窗之后创建，本就该保持在上层。
   */
  private static dialogNodes: Node[] = [];

  /**
   * 把弹窗挂到 UI 层：比 addToUILayer 多一步登记（同屏多弹窗时点哪个哪个浮到其它弹窗之上，见 raiseDialog）
   * 顺手清掉已销毁的登记项，长时间挂机也不会让清单越积越长
   */
  static addDialogToUILayer(node: Node) {
    this.addToUILayer(node);
    this.dialogNodes = this.dialogNodes.filter((item) => isValid(item));
    this.dialogNodes.push(node);
  }

  /**
   * 把弹窗浮到其它弹窗之上（后绘制在上，改兄弟序号即可）
   *
   * 入参可以是弹窗自身，也可以是弹窗里的任意节点（沿祖先找到所属弹窗）—— 后者给那些
   * **把触摸收住、不让事件冒泡到弹窗根**的手势区域用（如背包网格，见 BagGridView.setupTouchOwnership）。
   *
   * 目标位置 = 当前**已登记弹窗**里最上层的那个所在位置，因此：
   * · 只在弹窗之间排序（不越过飘字提示/悬停详情这类临时层，它们仍盖在弹窗之上）；
   * · 已经在最上层时什么都不做（引擎按 index !== oldIndex 判断，这里提前返回省一次遍历）；
   * · 不在任何弹窗里（HUD、临时层）的节点即使被点到也保持原位。
   *
   * 模态遮挡不受影响：遮罩命中最上层时，事件只在**它自己这条祖先链**上冒泡，
   * 下面的弹窗是兄弟节点、不在冒泡链上（见 utils/input/UiHit / Pointer 的说明），
   * 所以确认框、死亡遮罩打开期间点遮罩不会把下层弹窗提上来。
   */
  static raiseDialog(node: Node) {
    const dialog = this.findDialog(node);
    if (!dialog) return;
    const parent = dialog.parent;
    if (!parent || !isValid(parent)) return;
    const index = dialog.getSiblingIndex();
    let topIndex = -1;
    for (const item of this.dialogNodes) {
      if (item === dialog || !isValid(item) || item.parent !== parent) continue;
      topIndex = Math.max(topIndex, item.getSiblingIndex());
    }
    if (topIndex <= index) return;
    dialog.setSiblingIndex(topIndex);
  }

  /** 取节点所在的弹窗：自身是弹窗就返回自身，否则沿祖先找最近的一个已登记弹窗，都没有返回 null */
  private static findDialog(node: Node): Node | null {
    let current: Node | null = node;
    while (current && isValid(current)) {
      if (this.dialogNodes.indexOf(current) !== -1) return current;
      current = current.parent;
    }
    return null;
  }

  //#endregion

  /** 地图与UI层跟随角色移动 */
  static move(position: Vec3) {
    // 场景切换过程中容器可能已销毁，校验后再使用
    if (isValid(this.UILayer)) this.UILayer.setWorldPosition(position);
    if (!this.camera || !isValid(this.camera.node)) return;
    const cameraPosition = this.camera.node.getWorldPosition();
    this.camera.node.setWorldPosition(position.x, position.y, cameraPosition.z);
  }

  /**
   * 屏幕坐标点是否落在 UI 层元素上
   * 用途：世界点击（选中怪物/拾取掉落物）据此忽略 UI 上的点击，避免点界面时打断角色正在进行的操作
   * 判定细节见 utils/input/UiHit
   * @param screenPoint 屏幕坐标点（EventMouse.getLocation()）
   */
  static isPointOnUi(screenPoint: Vec2): boolean {
    return uiHitTest(this.UILayer, screenPoint);
  }

  /**
   * 屏幕坐标点是否落在「世界侧可交互对象」上（NPC 这类：不在 UI 层，点一下有自己的反应）
   * 用途：· 按下这类对象属于交互（点开对话/传送），世界侧不接管成「按住走路」；
   *      · 点它也不改变世界侧的选中目标、不打断正在进行的战斗
   * 判定细节见 utils/input/UiHit（标记见 markWorldInteractive）
   * @param screenPoint 屏幕坐标点（EventMouse.getLocation()）
   */
  static isPointOnWorldInteractive(screenPoint: Vec2): boolean {
    return worldInteractiveHitTest(this.MapLayer, screenPoint);
  }
}
