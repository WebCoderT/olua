/**
 * 怪物与 NPC 零件：怪物身体/头顶/NPC 节点/碰撞与刷怪区调试
 *
 * 由 GameUiHelper.ts 按域拆出（epic #1115 批次 1，机械搬移零行为变化）：
 * 原类 static 方法改为模块函数；调用方仍经 GameUiHelper 默认导出使用，本文件不直接消费。
 */


import { Animation, BoxCollider2D, Color, Graphics, Node, PolygonCollider2D, Size, Sprite, UITransform, Vec2 } from "cc";
import UiHelper from ".././UiHelper";
import AnimationHelper from ".././AnimationHelper";
import { debugConfig } from "../../../configs/debug";
import { getAnimationName } from "../../../configs/animation";
import { ACTION, DIRECTION } from "../../../types/animation";
import { Monster } from "../../../types/monster";
import { NPC } from "../../../types/map";
import { SkillId } from "../../../types/skill";
import { skills } from "../../../configs/skill";
import LayerManager from "../../core/LayerManager";
import { monsterInfoPanelLayout, T } from "../../../configs/hudLayout";
import { createHpBar } from "./role-parts";

/** 范围标注样式（线宽/填充透明度/名称字号与尺寸 + 三套配色，见 configs/debug 的 rangeStyle） */
const rangeStyle = debugConfig.rangeStyle;

/** 碰撞范围显示类别（决定配色：静态障碍 / 角色自身） */
export type ColliderRangeKind = "obstacle" | "role";

  /** 创建怪物节点主体（身体 + 待机动画），碰撞体与点击事件由调用方处理 */
export function createMonsterBody(monster: Monster): { node: Node; animate: Animation } {
    const node = UiHelper.createNode("monster", new Vec2(), monster.contentSize);
    const animationNode = UiHelper.createNode("monster_animation");
    animationNode.addComponent(Sprite);
    // 外观偏移：画布中心默认落在节点原点，身体在画布里不居中 → 外观节点按 outOffset 回摆，
    // 让可见身体中心正好落在节点原点（碰撞盒/点选/头顶血条/名字全都以原点为基准，见 configs/monster）
    animationNode.setPosition(monster.outOffset.x, monster.outOffset.y, 0);
    const animate = AnimationHelper.useMonsterAnimation(getAnimationName(ACTION.STAND, DIRECTION.DOWN), animationNode, monster.out, monster.speedRate);
    node.addChild(animationNode);
    return { node, animate };
  }

  /**
   * 创建怪物头顶信息栏（只有血条与血量文字；名称单独显示在身体正中心，见 createMonsterName）
   * 位置在怪物上缘之外一点：怪物节点锚点居中（即身体中心），按 contentSize 高度的一半上移
   * 结构固定：children[0]=血条 children[1]=血量文字（MonsterManager.updateHead 按此刷新）
   */
export function createMonsterHead(monster: Monster) {
    const head = UiHelper.createFlexCol("monster_head", 3, new Vec2(0, monster.contentSize.height / 2 + 14), new Size(100, 0));
    head.getComponent(UITransform).setAnchorPoint(0.5, 0);
    const hpBar = createHpBar("monster_hp_bar", monster.hp / monster.maxHp, new Vec2(), new Size(80, 4));
    head.addChild(hpBar);
    const hpText = UiHelper.createLabel("monster_hp_text", `${monster.hp} / ${monster.maxHp}`, Color.WHITE, 8, new Vec2(), new Size(100, 8));
    head.addChild(hpText);
    return head;
  }

  /**
   * 创建怪物名称（显示在怪物正中心：怪物节点锚点居中，名称挂在原点即身体中心）
   * 主动攻击的怪物红色、不主动攻击的黄色（aggressive，见 types/monster）
   */
export function createMonsterName(monster: Monster) {
    const color = monster.aggressive ? Color.RED : Color.YELLOW;
    return UiHelper.createLabel("monster_name", monster.label, color, 12, new Vec2(), new Size(120, 14));
  }

  /** 创建NPC节点主体（名字 + 外观动画），位置与点击事件由调用方处理 */
export function createNpcNode(npc: NPC) {
    const npcNode = UiHelper.createFlexCol("npc_node", 0, new Vec2(), new Size(100, 170));
    npcNode.addChild(UiHelper.createLabel("npc_label", npc.label, Color.WHITE, 12, new Vec2(), new Size(100, 20)));
    const npcSpriteNode = UiHelper.createSprite("npc_sprite_node", "", new Vec2(), new Size(100, 150));
    const npcSprite = UiHelper.createSprite("npc_sprite", "");
    npc.scale && npcSprite.setScale(npc.scale);
    npc.position && npcSprite.setPosition(npc.position);
    AnimationHelper.playLoopWithDir("npc", npcSprite, npc.src);
    npcSpriteNode.addChild(npcSprite);
    npcNode.addChild(npcSpriteNode);
    return npcNode;
  }



  /**
   * 创建碰撞区域节点（节点尺寸即碰撞范围，本体不含任何显示元素）
   * 用于把 Tiled collision 对象组里的矩形实例化成游戏内的碰撞范围，
   * 碰撞体由调用方（CollisionAreaSpawner）通过 addObstacleCollider 添加
   * @param name 对象名称（仅用于命名节点，便于在层级中定位）
   * @param size 区域尺寸
   */
export function createCollisionAreaNode(name: string, size: Size) {
    return UiHelper.createNode(`collision_${name}`, new Vec2(), size);
  }



  /**
   * 创建刷怪区域节点（节点尺寸即区域范围，本体不含任何显示元素）
   * 用于把 Tiled monster 对象组里的矩形实例化成怪物落点范围，
   * 怪物本身的生成由 MonsterManager 按区域完成，区域范围显示见 showAreaRange
   * @param label 区域名称（用于命名节点与调试显示）
   * @param size 区域尺寸
   */
export function createMonsterAreaNode(label: string, size: Size) {
    return UiHelper.createNode(`monster_area_${label}`, new Vec2(), size);
  }



  /**
   * 显示节点的碰撞范围：范围框 + 名称 + 尺寸，用于核对游戏内实际的碰撞范围
   * 直接读取节点上 BoxCollider2D 的 size 与 offset 绘制，因此显示范围与引擎实际判定范围永远一致
   * （角色碰撞体相对脚下原点有偏移，范围框与名称都按该偏移摆放）
   * 所有碰撞体（Tiled 碰撞区 / NPC / 怪物 / 角色）统一走本方法，由 debugConfig.colliderRange 一个开关控制
   * @param node 已挂载 BoxCollider2D 的节点（没有碰撞体则不做任何事）
   * @param name 显示名称（缺省取节点名；传空串则只画范围框）
   * @param kind 类别（role 使用另一种配色，便于与静态障碍区分）
   * @return 显示节点（无碰撞体或开关关闭时为 null）
   */
export function showColliderRange(node: Node, name?: string, kind: ColliderRangeKind = "obstacle") {
    if (!debugConfig.colliderRange) return null;
    const color = kind === "role" ? rangeStyle.roleColor : rangeStyle.obstacleColor;
    // #1190：碰撞多边形（PolygonCollider2D）优先 —— 顶点是相对量，按顶点画多边形轮廓
    const polygon = node.getComponent(PolygonCollider2D);
    if (polygon) return drawPolygonRange(node, polygon.points, color, name ?? node.name);
    const collider = node.getComponent(BoxCollider2D);
    if (!collider) return null;
    return drawRange(node, collider.size, collider.offset, color, name ?? node.name);
  }

  /**
   * 显示区域的范围（范围框 + 名称 + 尺寸），用于没有碰撞体的区域（如怪物刷怪区域）
   * 取节点 UITransform 的尺寸绘制，尺寸即区域的落点范围
   * 由 debugConfig.areaRange 一个开关控制
   * @param node 区域节点（带 UITransform，其尺寸即区域尺寸）
   * @param name 显示名称（缺省取节点名）
   * @return 显示节点（开关关闭或无 UITransform 时为 null）
   */
export function showAreaRange(node: Node, name?: string) {
    if (!debugConfig.areaRange) return null;
    const uiTransform = node.getComponent(UITransform);
    if (!uiTransform) return null;
    return drawRange(node, uiTransform.contentSize, new Vec2(), rangeStyle.areaColor, name ?? node.name);
  }

  /**
   * 在节点上绘制范围框与名称尺寸（碰撞范围显示与区域范围显示共用的绘制实现）
   * 直接绘制在目标节点自身，因此显示范围与节点的实际尺寸/碰撞体偏移永远一致
   * @param node 目标节点
   * @param size 范围尺寸
   * @param offset 范围相对节点原点的偏移（碰撞体偏移，无偏移传 Vec2.ZERO）
   * @param color 范围框与名称颜色
   * @param label 名称（空串则只画范围框）
   * @return 承载名称的显示节点
   */
export function drawRange(node: Node, size: Size, offset: Vec2, color: Color, label: string) {
    /** 范围框：按偏移换算矩形左下角（组件绘制在节点自身，不受子节点布局影响） */
    const graphics = node.addComponent(Graphics);
    graphics.lineWidth = rangeStyle.lineWidth;
    graphics.strokeColor = color;
    graphics.fillColor = new Color(color.r, color.g, color.b, rangeStyle.fillAlpha);
    graphics.rect(offset.x - size.width / 2, offset.y - size.height / 2, size.width, size.height);
    graphics.fill();
    graphics.stroke();

    /** 名称与尺寸：挂在纯分组节点上，避免目标节点是布局容器（如 NPC 节点）时子节点被 Layout 重排 */
    const view = UiHelper.createGroupNode("collider_range_view", offset);
    node.addChild(view);
    // 图层挂载完成后再创建显示节点时也要跟随所在图层，否则会留在默认图层而不可见
    LayerManager.setNodeToLayer(view, node.layer);
    if (label)
      view.addChild(
        UiHelper.createLabel(
          "collider_range_name",
          `${label} ${Math.round(size.width)}×${Math.round(size.height)}`,
          color,
          rangeStyle.nameFontSize,
          new Vec2(),
          rangeStyle.nameSize,
        ),
      );
    return view;
  }

  /**
   * 绘制多边形碰撞范围（#1190：`showColliderRange` 的多边形分支用）
   *
   * 与 `drawRange` 同一套样式（线宽 / 填充透明度 / 名称字号），差别只在形状：
   * Graphics 按 `points`（相对节点原点的顶点序列）moveTo / lineTo / close 画轮廓；
   * 名称标注按顶点包围盒的尺寸显示。
   * @param node 已挂载 PolygonCollider2D 的节点
   * @param points 碰撞体顶点（相对节点原点，首尾自动闭合）
   * @param color 范围框与名称颜色
   * @param label 名称（空串则只画范围框）
   */
export function drawPolygonRange(node: Node, points: Vec2[], color: Color, label: string) {
    if (points.length < 3) return null;
    const graphics = node.addComponent(Graphics);
    graphics.lineWidth = rangeStyle.lineWidth;
    graphics.strokeColor = color;
    graphics.fillColor = new Color(color.r, color.g, color.b, rangeStyle.fillAlpha);
    graphics.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) graphics.lineTo(points[i].x, points[i].y);
    graphics.close();
    graphics.fill();
    graphics.stroke();

    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const view = UiHelper.createGroupNode("collider_range_view", new Vec2());
    node.addChild(view);
    LayerManager.setNodeToLayer(view, node.layer);
    if (label)
      view.addChild(
        UiHelper.createLabel(
          "collider_range_name",
          `${label} ${Math.round(width)}×${Math.round(height)}`,
          color,
          rangeStyle.nameFontSize,
          new Vec2(),
          rangeStyle.nameSize,
        ),
      );
    return view;
  }



  /** 创建怪物头像（左侧，取怪物图标；位置与尺寸见 hudLayout.monsterInfoPanel.avatar） */
export function createMonsterAvatar(monster: Monster, position: Vec2 = monsterInfoPanelLayout.avatar.position, size: Size = monsterInfoPanelLayout.avatar.size) {
    const layout = monsterInfoPanelLayout.avatar;
    const frame = UiHelper.createNode("monster_avatar", position, size);
    const graphics = frame.addComponent(Graphics);
    // 稿 `.monster .face`：1px 朱红半透明边 + 径向深褐底（1px 描边用填两块画）
    graphics.fillColor = layout.border;
    graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, T.radius.r2);
    graphics.fill();
    graphics.fillColor = T.surface[2];
    graphics.roundRect(-size.width / 2 + 1, -size.height / 2 + 1, size.width - 2, size.height - 2, Math.max(0, T.radius.r2 - 1));
    graphics.fill();
    frame.addChild(UiHelper.createSprite("monster_face", monster.icon, new Vec2(), new Size(size.width - 4, size.height - 4)));
    return frame;
  }

  /**
   * 创建怪物技能行（怪物技能图标，未配置技能则不渲染）
   * @param monster 怪物数据
   * @param position 行位置（缺省取 hudLayout.monsterInfoPanel.skillRow）
   * @param slotSize 单个技能图标尺寸
   * @param spacing 图标间距
   */
export function createMonsterSkillRow(
    skillIds: SkillId[],
    position: Vec2 = monsterInfoPanelLayout.skillRow.position,
    slotSize: number = monsterInfoPanelLayout.skillRow.slotSize,
    spacing: number = monsterInfoPanelLayout.skillRow.spacing,
  ) {
    const row = UiHelper.createNode("monster_skills", position, new Size(monsterInfoPanelLayout.size.width, slotSize));
    // #588：Monster 实例不再带 skills 字段（旧字段从未被赋过值，本行一直是空的）；
    // 怪物技能挂载映射在服务端（monster_skills 表），要下发时从这里接上
    skillIds.forEach((skillId, index) => {
      const skillConfig = skills.get(skillId);
      if (!skillConfig) return;
      const slot = UiHelper.createSprite(skillId, skillConfig.icon, new Vec2((index - (skillIds.length - 1) / 2) * (slotSize + spacing), 0), new Size(slotSize, slotSize));
      row.addChild(slot);
    });
    return row;
  }
