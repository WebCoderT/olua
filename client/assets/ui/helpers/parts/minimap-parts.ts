/**
 * 小地图与路线：点层/网格/晕影/路线指示线
 *
 * 由 GameUiHelper.ts 按域拆出（epic #1115 批次 1，机械搬移零行为变化）：
 * 原类 static 方法改为模块函数；调用方仍经 GameUiHelper 默认导出使用，本文件不直接消费。
 */


import { Color, Graphics, Mask, Node, Size, Vec2 } from "cc";
import UiHelper from ".././UiHelper";
import LayerManager from "../../core/LayerManager";
import { T } from "../../../configs/hudLayout";

/**
 * 路线指示线样式（点状线）
 * 路线不是实线，而是沿折线等距铺一串圆点，终点再画一个更大的圆点表示目的地；
 * 颜色/半径/间距都由调用方的配置传进来（绘制层坐标单位：大地图是世界像素，小地图/预览是像素）
 */
export interface RouteLineStyle {
  /** 点与终点圆点的颜色 */
  color: Color;
  /** 单个点半径 */
  dotRadius: number;
  /** 相邻点间距（需大于 2 × dotRadius，否则点会连成一团） */
  dotGap: number;
  /** 终点圆点半径（比普通点大一圈，一眼看出目的地） */
  endDotRadius: number;
}

/** 小地图坐标点（地图内容区本地坐标，调用方负责把世界坐标换算过来） */
export interface SmallMapDot {
  /** 相对内容区中心的横向偏移 */
  x: number;
  /** 相对内容区中心的纵向偏移 */
  y: number;
  /** 点颜色 */
  color: Color;
  /** 点半径 */
  radius: number;
  /**
   * 外环半径（可选；稿 `.map-view .me::after`：玩家点带一圈半透明细环，怪物点没有）
   * 环宽恒 1px，颜色与点同色、alpha 减半
   */
  ringRadius?: number;
}



  /**
   * 创建小地图坐标点绘制层（单个 Graphics 节点，占满内容区）
   * 点位由 drawSmallMapDots 整体重绘，避免按怪物增删节点
   */
export function createSmallMapDotLayer(position: Vec2, size: Size) {
    const node = UiHelper.createNode("small_map_dots", position, size);
    return node.addComponent(Graphics);
  }

  /** 在绘制层上重绘全部坐标点（先清空再画，重绘频率由调用方节流） */
export function drawSmallMapDots(graphics: Graphics, dots: SmallMapDot[]) {
    graphics.clear();
    dots.forEach((dot) => {
      if (dot.ringRadius) {
        graphics.lineWidth = 1;
        graphics.strokeColor = (() => {
          const ring = dot.color.clone();
          ring.a = Math.round(ring.a * 0.5);
          return ring;
        })();
        graphics.circle(dot.x, dot.y, dot.ringRadius);
        graphics.stroke();
      }
      graphics.fillColor = dot.color;
      graphics.circle(dot.x, dot.y, dot.radius);
      graphics.fill();
    });
  }

  /**
   * 小地图内容区的径向底色 + 22px 网格（稿 `.map-view` 的 background + .grid）
   *
   * Graphics 没有径向渐变：外圈整块 rect（最暗）+ 两层同心圆（逐层提亮）近似；
   * 网格线是稿 `repeating-linear-gradient` 22px 一道的等价画法（金线 alpha 在配置里已折算）
   */
export function createSmallMapBackdrop(name: string, position: Vec2, size: Size, spec: {
    outer: Color; mid: Color; midRadius: number; inner: Color; innerRadius: number;
  }) {
    const node = UiHelper.createNode(name, position, size);
    const g = node.addComponent(Graphics);
    g.fillColor = spec.outer;
    g.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, T.radius.r2);
    g.fill();
    g.fillColor = spec.mid;
    g.circle(0, 0, spec.midRadius);
    g.fill();
    g.fillColor = spec.inner;
    g.circle(0, 0, spec.innerRadius);
    g.fill();
    return node;
  }

  /**
   * 小地图内容区的 22px 网格（稿 `.map-view .grid`）
   *
   * 单独一层、**画在底图之上**：稿里网格在 .terrain 之下（地形只是稀疏折线），客户端底图是满幅
   * 不透明贴图，网格压在图下就完全看不见了
   */
export function createSmallMapGrid(name: string, position: Vec2, size: Size, spec: { step: number; color: Color; alpha: number }) {
    const node = UiHelper.createNode(name, position, size);
    const g = node.addComponent(Graphics);
    const color = spec.color.clone();
    color.a = spec.alpha;
    g.lineWidth = 1;
    g.strokeColor = color;
    for (let x = -size.width / 2 + spec.step; x < size.width / 2; x += spec.step) {
      g.moveTo(x, -size.height / 2);
      g.lineTo(x, size.height / 2);
    }
    for (let y = -size.height / 2 + spec.step; y < size.height / 2; y += spec.step) {
      g.moveTo(-size.width / 2, y);
      g.lineTo(size.width / 2, y);
    }
    g.stroke();
    return node;
  }

  /** 小地图压暗薄纱（稿地形底是近黑；实拍底图半透明贴上去仍偏亮，再压一层才到稿的调子） */
export function createSmallMapScrim(name: string, position: Vec2, size: Size, color: Color) {
    const node = UiHelper.createNode(name, position, size);
    const g = node.addComponent(Graphics);
    g.fillColor = color;
    g.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, T.radius.r2);
    g.fill();
    return node;
  }

  /**
   * 小地图内容区的内暗角（稿 `.map-view .vign` 的 `inset 0 0 26px rgba(0,0,0,.75)`）
   *
   * Graphics 没有内阴影：从边缘向内画 steps 圈逐层减淡的描边近似（每层 width px，
   * alpha 线性衰减到 0），叠出来的观感与 CSS inset shadow 相当
   */
export function createSmallMapVignette(name: string, position: Vec2, size: Size, spec: { steps: number; width: number; color: Color }) {
    const node = UiHelper.createNode(name, position, size);
    const g = node.addComponent(Graphics);
    // 四条边各画 steps 条实心窄条，alpha 由外向内线性衰减 → 观感接近 CSS inset shadow；
    // 用描边圆角矩形叠会留下可见的同心底纹（第一版踩过）
    const left = -size.width / 2;
    const bottom = -size.height / 2;
    for (let i = 0; i < spec.steps; i++) {
      const inset = i * spec.width;
      const color = spec.color.clone();
      color.a = Math.round((spec.color.a * (spec.steps - i)) / spec.steps);
      g.fillColor = color;
      // 上 / 下（整幅宽）
      g.rect(left + inset, bottom + size.height - inset - spec.width, size.width - inset * 2, spec.width);
      g.fill();
      g.rect(left + inset, bottom + inset, size.width - inset * 2, spec.width);
      g.fill();
      // 左 / 右（跳过上下条占掉的高度，否则四角会叠成明显的三角形）
      const sideY = bottom + inset + spec.width;
      const sideH = size.height - (inset + spec.width) * 2;
      if (sideH <= 0) continue;
      g.rect(left + inset, sideY, spec.width, sideH);
      g.fill();
      g.rect(left + size.width - inset - spec.width, sideY, spec.width, sideH);
      g.fill();
    }
    return node;
  }

  /**
   * 创建路线指示线绘制层（自动寻路时的路线；小地图与预览弹窗共用，坐标为相对内容区中心）
   * 与坐标点层分开：路线每帧变（角色在移动），点位有各自的刷新节奏，两者互不干扰
   */
export function createSmallMapRouteLayer(position: Vec2, size: Size) {
    const node = UiHelper.createNode("small_map_route", position, size);
    return node.addComponent(Graphics);
  }

  /**
   * 在绘制层上重绘路线指示线（传入已换算到本绘制层的坐标点，起点即角色所在点）
   * 画法为「点状线」：沿折线按弧长等距铺一串圆点，最后在终点画一个更大的圆点；
   * 跨折点用「余量结转」保证两段交界处的点间距与本段一致，不会在拐角处挤成一坨；
   * 每个圆点内部自带 moveTo（引擎 helper.ellipse 实现），所以点与点之间不会被连成多边形
   * @param points 路线坐标点（本绘制层坐标系，至少 1 个点）
   * @param style 样式（颜色 / 点半径 / 点间距 / 终点半径）
   */
export function drawRouteLine(graphics: Graphics, points: Vec2[], style: RouteLineStyle) {
    graphics.clear();
    if (points.length === 0) return;
    const radius = Math.max(0.5, style.dotRadius);
    // 间距至少为点直径 + 1，避免配置写小了把点状线画成一条实线
    const gap = Math.max(style.dotGap, radius * 2 + 1);
    graphics.fillColor = style.color;
    if (points.length > 1) {
      /** 本段第一个点距段首的距离（跨段结转，保证折点两侧的点间距均匀） */
      let carried = 0;
      for (let i = 1; i < points.length; i++) {
        const from = points[i - 1];
        const to = points[i];
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length <= 0) continue;
        // 本段比待走的距离还短：一个点都放不下，把待走距离扣掉后直接进下一段
        if (carried > length) {
          carried -= length;
          continue;
        }
        for (let offset = carried; offset <= length; offset += gap) {
          const ratio = offset / length;
          graphics.circle(from.x + dx * ratio, from.y + dy * ratio, radius);
        }
        // 段末距本段最后一个点的余量 → 折算成下一段从段首起多远放点
        carried = gap - ((length - carried) % gap);
      }
      // #1352：所有圆点一次 fill（圆点各自带 moveTo 不会连成多边形）——
      // 大图整幅路线 270+ 个点逐点 fill 是 30 次重绘/秒 × 270 次提交，批量后一次提交
      graphics.fill();
    }
    // 终点圆点：比途中的点大一圈，标出目的地
    const end = points[points.length - 1];
    graphics.circle(end.x, end.y, style.endDotRadius);
    graphics.fill();
  }


  /**
   * 创建小地图静态标记层（占满内容区的空节点，作为预览图的子节点）
   * 与坐标点层分开：标记（NPC 白点 + 名称、刷怪区名称）只随地图变化建一次，
   * 坐标点（角色/怪物）每帧节流重绘，互不干扰；标记永远盖在动态点上
   */
export function createSmallMapMarkerLayer(position: Vec2, size: Size) {
    return UiHelper.createNode("small_map_markers", position, size);
  }

  /**
   * 创建小地图底图视口（内容区大小的裁剪容器，常驻 HUD 用）
   * Mask 的裁剪范围即本节点内容尺寸：底图可远大于内容区（整张地图预览图），
   * 但只露出角色周围一块，不会溢出到名称条/功能按钮上
   */
export function createSmallMapMapView(position: Vec2, size: Size) {
    const node = UiHelper.createNode("small_map_view", position, size);
    node.addComponent(Mask);
    return node;
  }

  /**
   * 创建小地图底图（真实地图预览图）
   * 节点尺寸先按传入值建立，实际显示尺寸由组件按「地图像素尺寸 × 小地图缩放」实时设置，
   * 因此节点自带 UITransform 且 sprite 为 CUSTOM 尺寸模式，方便逐帧改尺寸与缩放
   */
export function createSmallMapMapImage(size: Size) {
    return UiHelper.createSprite("small_map_image", "", new Vec2(), size);
  }



  /**
   * 创建大地图上的路线指示线绘制层（自动寻路时画在地面之上的路线）
   * 挂在地图节点下：本地坐标即地图节点坐标系（见 core/RouteIndicator 的坐标换算），
   * 画出的线贴在地面上、位于角色与怪物之下（地图层的渲染顺序先于怪物层/特效层），换图时随旧地图节点一起销毁
   * @param map 地图节点（挂载的宿主）
   */
export function createRouteLineLayer(map: Node) {
    const node = UiHelper.createNode("route_line", new Vec2(), new Size(1, 1));
    map.addChild(node);
    // 地图节点挂在 MAP 层，动态新增的子节点要对齐图层才可见（LayerManager 的监听之外再显式一次，避免依赖时序）
    LayerManager.setNodeToLayer(node, map.layer);
    return node.addComponent(Graphics);
  }
