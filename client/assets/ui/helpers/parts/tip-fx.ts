/**
 * Tip 浮层与战斗反馈：错误提示/浮动提示/伤害飘字/受击红闪/技能提示/经验（含两个节流字段）
 *
 * 由 GameUiHelper.ts 按域拆出（epic #1115 批次 1，机械搬移零行为变化）：
 * 原类 static 方法改为模块函数；调用方仍经 GameUiHelper 默认导出使用，本文件不直接消费。
 */


import { Animation, Canvas, Color, director, Graphics, isValid, Label, Node, Size, Sprite, tween, UIOpacity, UITransform, Vec2, Vec3 } from "cc";
import UiHelper from ".././UiHelper";
import { getText, TextParams } from "../../../configs/texts";
import { hitScreenFlash } from "../../../configs/game-config";
import { StatusBadge } from "../../../types/status";
import { markClickThrough } from "../../utils/input/UiHit";
import LayerManager from "../../core/LayerManager";
import { designResolution } from "../../utils/layout/ScreenLayout";
import { roleInfoBarLayout, tipsLayout, T, uiTheme } from "../../../configs/hudLayout";
import { createGlassPlate } from "./dialog-builder";
import { createVectorDot } from "./role-parts";

/** 伤害飘字的错峰轮转序号（全局累计，见 showDamageText 与 uiTheme.floatingText.damage.offsetXs） */
let damageTextSeq = 0;

  /** 上一次受击红闪的时刻（毫秒时间戳，见 showHitScreenFlash 与 configs/effect.hitScreenFlash.cooldownMs） */
let lastHitFlashAt = 0;



  /**
   * 创建错误提示（红色飘字）
   * @param name 文案 key（configs/texts 的 uiTexts）
   * @param params 模板参数（文案里写 {key}，这里给值）
   */
export function createErrorTip(name: string, params?: TextParams) {
    createFloatingTip(name, getText(name, params), tipsLayout.errorColor, tipsLayout.errorMoveDuration, tipsLayout.errorFadeDuration);
  }

  /** 错误提示（文案直接给定：服务端返回的提示语属于「数据」，不是界面固定文案） */
export function createErrorTipText(text: string) {
    createFloatingTip("error_tip", text, tipsLayout.errorColor, tipsLayout.errorMoveDuration, tipsLayout.errorFadeDuration);
  }

  /**
   * 创建提示（普通飘字）
   * @param name 文案 key（configs/texts 的 uiTexts）
   * @param params 模板参数（文案里写 {key}，这里给值）
   */
export function createTip(name: string, params?: TextParams) {
    createFloatingTip(name, getText(name, params), tipsLayout.messageColor, tipsLayout.messageMoveDuration, tipsLayout.messageFadeDuration);
  }

  /** 普通提示（文案直接给定：同上，用于服务端返回的提示语） */
export function createTipText(text: string) {
    createFloatingTip("message_tip", text, tipsLayout.messageColor, tipsLayout.messageMoveDuration, tipsLayout.messageFadeDuration);
  }

  /**
   * 飘字公共实现（提示与错误提示只有配色与时长不同）
   *
   * 文案由调用方传入：登记在 configs/texts 的固定文案走 createTip / createErrorTip（内部 getText 取），
   * 服务端返回的动态文案走 createTipText / createErrorTipText —— 核心代码里仍然没有面向玩家的中文。
   */
export function createFloatingTip(name: string, text: string, color: Color, moveDuration: number, fadeDuration: number) {
    const tip = UiHelper.createTipLabel(name, text, color, tipsLayout.fontSize, tipsLayout.size);
    // 描边：飘字落在屏幕中心，那里常压着深色/同色面板（登录页那条深红装饰板），
    // 不加描边的纯色小字基本读不出来（见 tipsLayout.outline 与 #457）
    const label = tip.getComponent(Label);
    if (label) {
      label.enableOutline = true;
      label.outlineWidth = tipsLayout.outline.width;
      label.outlineColor = tipsLayout.outline.color;
    }
    // 飘字是临时装饰（屏幕中间上浮 1~3 秒，拾取/提示时高频出现），标为点击穿透：不遮挡世界点击
    markClickThrough(tip);
    const uiOpacity = tip.addComponent(UIOpacity);
    tween(tip)
      .to(moveDuration, { position: new Vec3(0, tipsLayout.risePositionY, 0) })
      .start();
    tween(uiOpacity)
      .to(fadeDuration, { opacity: 0 })
      .call(() => {
        tip.destroy();
      })
      .start();
    mountFloatingTip(tip);
  }

  /**
   * 挂载飘字（**跨场景**：游戏内挂 UI 图层，登录/选角这类没有图层容器的场景挂场景里的 Canvas）
   *
   * 游戏场景的图层容器由 LayerManager.initLayer 建在场景里（飘字挂它才有正确的图层位）；
   * 而登录/选角场景从不调 initLayer —— 那个静态 UILayer 根本没进场景树，直接挂上去的飘字
   * 既不渲染也不跟随任何东西，玩家看不到任何提示（服务端返回的「账号或密码错误」这类提示会全丢）。
   *
   * 但只换挂载点还不够，**坐标口径是第二层坑**：飘字的坐标以**屏幕中心为原点**设计
   * （见 configs/layout/hud.tipsLayout：起点 (0, 0)、上浮到 (0, risePositionY)），这套口径在游戏内成立
   * 是因为 UILayer 被 LayerManager.move 搬到角色位置上（= 屏幕中心）。挂在**场景根**上时局部 (0, 0)
   * 是**世界原点**，而登录 / 选角的 UI 相机是 Canvas 的子节点、世界位置在 Canvas 中心（约设计尺寸的一半），
   * 于是飘字被摆到相对相机中心偏了「半个屏幕」的地方 —— 正好压在屏幕左下角顶点上，大半个在屏外。
   * 症状就是：控制台里有 [net] 请求失败，界面却一个字都没有（飘字其实建出来了，只是看不见）。
   *
   * 所以非游戏场景挂 **Canvas 节点**：它的原点就是屏幕中心（与游戏内的坐标口径一致），
   * 且 alignCanvasWithScreen 会随窗口重设自身位置与尺寸，窗口缩放后飘字仍然居中，不必自己跟 resize。
   * 顺手把图层对齐宿主：新建节点恒为 DEFAULT，能看见只是碰巧场景相机的 visibility 里带着 DEFAULT，
   * 显式跟随宿主（Canvas 是 UI_2D）就不必赌这件事。
   *
   * 判据用「容器是否在场景里」而不是「当前是哪个场景」，以后新增场景不必再回来改这里。
   */
export function mountFloatingTip(tip: Node) {
    const uiLayer = LayerManager.UILayer;
    if (uiLayer && isValid(uiLayer) && uiLayer.scene) {
      LayerManager.addToUILayer(tip);
      return;
    }
    const scene = director.getScene();
    if (!scene || !isValid(scene)) return;
    // 非游戏场景：脚本挂载之前场景里已经有 Canvas（引擎的 UI 根），按结构找它，找不到才退回场景根
    const host = scene.children.find((child) => !!child.getComponent(Canvas)) ?? scene;
    tip.layer = host.layer;
    host.addChild(tip);
  }

  /**
   * 创建自动战斗提示动画节点（"自动战斗中/自动寻路中"，屏幕中间循环播放的图集帧动画）
   * 帧来自 TexturePacker 图集且各帧源画布尺寸一致（800×800，内容居中），
   * 用 tipsLayout.autoTipSize 的自定义尺寸 + 不裁剪：每帧都按源画布等比缩放到该尺寸，
   * 逐帧内容位置与缩放比稳定不抖动（若裁剪，各帧裁剪矩形不同会被拉伸成不同缩放比而抖动）
   * 节点默认隐藏，帧动画由调用方通过 AnimationHelper.playLoopWithFrames 装载
   */
  /**
   * 创建自动战斗状态提示（跟随主角的矢量胶囊：暗底 + 描边 + 状态文字，替代原帧动画图集）
   * @param name 元素名称
   * @param text 状态文字（自动战斗中 / 自动寻路中）
   * @param accent 描边与文字的强调色（战斗 = 金、寻路 = 灰）
   */
export function createAutoBattleTip(name: string, text: string, accent: Color): Node {
    const node = UiHelper.createNode(name, new Vec2(), tipsLayout.autoTipSize);
    node.addChild(createGlassPlate(`${name}_plate`, tipsLayout.autoTipSize, tipsLayout.autoTipRadius, accent));
    node.addChild(createVectorDot(`${name}_dot`, accent, new Vec2(-tipsLayout.autoTipSize.width / 2 + 16, 0), new Size(8, 8)));
    node.addChild(UiHelper.createLabel(`${name}_label`, text, accent, tipsLayout.autoTipFontSize, new Vec2(6, 0), new Size(tipsLayout.autoTipSize.width - 28, tipsLayout.autoTipSize.height)));
    node.active = false;
    return node;
  }



  /**
   * 创建技能特效节点（图集帧动画，挂在特效层由 core/EffectManager 播放，播完自动销毁）
   * 与角色外观同一套口径：原始尺寸（RAW）+ 不裁剪，因此特效与角色美术天然对齐、逐帧不抖动
   * （特效图集各帧源画布尺寸一致，如 800×700/800×800，内容位置由帧自带的 offset 决定）
   */
export function createSkillEffect(name: string): Node {
    const node = UiHelper.createSprite(name, "");
    const sprite = node.getComponent(Sprite)!;
    sprite.sizeMode = Sprite.SizeMode.RAW;
    sprite.trim = false;
    node.addComponent(Animation);
    return node;
  }

  /**
   * 创建状态图标零件（头像下方状态图标条的一项，见 ui/components/hud/StatusIconBar）
   * 图标来源为状态配置（configs/status 的 icon，resources 下精灵路径）；
   * 稿 `.buff` 是 26×26 的深褐小方块 + 1px line-3 金线框，图标缩在内侧（28 → 26 后留 2px 边）
   */
export function createStatusIcon(badge: StatusBadge): Node {
    const size = roleInfoBarLayout.statusBar.iconSize;
    const node = UiHelper.createNode(`status_icon_${badge.id}`, new Vec2(), size);
    node.addChild(createGlassPlate("status_plate", size, T.radius.r1, T.line[3], T.surface[2]));
    node.addChild(UiHelper.createSprite("status_art", badge.icon, new Vec2(), new Size(size.width - 6, size.height - 6)));
    return node;
  }

  /**
   * 在受伤物体位置显示受伤飘字（挂特效层，上浮淡出后自动销毁）
   * @param target 受伤物体节点
   * @param damage 受到的伤害数值
   * @param blocked 是否触发了格挡（#14 状态数值：格挡时文案用 label_damage_block、颜色用 blockedColor）
   * @param suppressed 是否吃了等级压制（#826 第三批：文案用 label_damage_suppressed；
   *   数值已经被服务端压过，这里**只换说法**，不乘任何系数）
   */
export function showDamageText(target: Node, damage: number, blocked = false, suppressed = false) {
    if (!isValid(target)) return;
    const style = uiTheme.floatingText.damage;
    // 受伤为红色扣血飘字；格挡为 blockedColor；未命中（伤害 <= 0）为白色 MISS
    const color = blocked ? style.blockedColor : damage > 0 ? style.color : Color.WHITE;
    // 压制的优先级低于格挡：格挡是「这一下被挡了」，压制是「打不动」，两个都命中时说格挡更准
    const label = blocked ? "label_damage_block" : suppressed ? "label_damage_suppressed" : "label_damage";
    const text = damage > 0 ? getText(label, { value: damage }) : getText("label_damage_miss");
    const damageText = UiHelper.createLabel("damage_text", text, color, style.fontSize, new Vec2(), style.size);
    LayerManager.addToEffectLayer(damageText);
    // 位置与受伤物体保持一致；横向按出场次数在 offsetXs 里轮转错峰 ——
    // 连续挨打时数字不会都叠在同一点上糊成一团（轮转序号是全局的：多个目标同时飘也互相错开）
    const offsetXs = style.offsetXs.length ? style.offsetXs : [0];
    const offsetX = offsetXs[damageTextSeq++ % offsetXs.length];
    damageText.setWorldPosition(target.getWorldPosition().x + offsetX, target.getWorldPosition().y, target.getWorldPosition().z);
    const uiOpacity = damageText.addComponent(UIOpacity);
    tween(damageText)
      .to(style.riseDuration, { position: new Vec3(damageText.position.x, damageText.position.y + style.riseDistance, 0) })
      .start();
    tween(uiOpacity)
      .to(style.fadeDuration, { opacity: 0 })
      .call(() => {
        damageText.destroy();
      })
      .start();
  }

  /**
   * 战斗力变化飘字（#732：挂在锚点节点下，上浮淡出后自动销毁）
   *
   * 锚点是信息栏的战斗力零件节点（RoleInfoBar 传入）——飘字作为它的子节点，
   * 用局部坐标即可，不必换算世界坐标。上升绿 / 下降红（configs/theme floatingText.combat），
   * 文案 ±delta 在这里拼；`delta = 0` 不显示。调用方只在**战斗力真的变了**时调用
   * （见 RoleInfoBar.updateCombat）
   */
export function showCombatDelta(anchor: Node, delta: number) {
    if (!delta || !isValid(anchor)) return;
    const style = uiTheme.floatingText.combat;
    const up = delta > 0;
    const text = `${up ? "+" : "-"}${Math.abs(delta)}`;
    const node = UiHelper.createLabel("combat_delta", text, up ? style.upColor : style.downColor, style.fontSize, new Vec2(style.spawnOffsetX, style.spawnOffsetY), style.size);
    anchor.addChild(node);
    const uiOpacity = node.addComponent(UIOpacity);
    tween(node)
      .to(style.riseDuration, { position: new Vec3(node.position.x, node.position.y + style.riseDistance, 0) })
      .start();
    tween(uiOpacity)
      .to(style.fadeDuration, { opacity: 0 })
      .call(() => {
        node.destroy();
      })
      .start();
  }

  /**
   * 受击屏幕反馈：全屏薄红闪一下（挂特效层、以相机为中心铺满可视区，淡入即淡出后自毁）
   * 由怪物普攻命中玩家时调用（服务端 monster-ai 帧的 hits → MonsterManager.onPlayerServerHit，
   * 接线在 Game.start）；按配置限频 —— 被围殴时不重触发，避免红屏常驻。参数见 configs/effect.hitScreenFlash
   */
export function showHitScreenFlash() {
    const config = hitScreenFlash;
    const now = Date.now();
    if (now - lastHitFlashAt < config.cooldownMs) return;
    lastHitFlashAt = now;
    // 图层容器没进场景（登录/选角这类）或场景正在切换时不闪
    const effectLayer = LayerManager.EffectLayer;
    if (!effectLayer || !isValid(effectLayer) || !effectLayer.scene) return;
    const camera = LayerManager.camera;
    if (!camera || !isValid(camera.node)) return;
    const size = designResolution;
    const flash = new Node("hit_screen_flash");
    const transform = flash.addComponent(UITransform);
    const width = size.width * config.overscan;
    const height = size.height * config.overscan;
    transform.setContentSize(width, height);
    const graphics = flash.addComponent(Graphics);
    graphics.fillColor = config.color;
    graphics.rect(-width / 2, -height / 2, width, height);
    graphics.fill();
    flash.addComponent(UIOpacity);
    LayerManager.addToEffectLayer(flash);
    // 屏幕中心即相机中心（与 AutoBattleTips 同一口径），铺在特效层最上但不盖 UI
    flash.setWorldPosition(camera.node.getWorldPosition());
    // 临时装饰：不参与点击命中，别让一闪而过的红层挡住世界点击
    markClickThrough(flash);
    const opacity = flash.getComponent(UIOpacity)!;
    tween(opacity)
      .to(config.fadeIn, { opacity: 255 * config.maxOpacity })
      .to(config.fadeOut, { opacity: 0 })
      .call(() => flash.destroy())
      .start();
  }

  /**
   * 在技能释放者位置显示技能释放提示（挂特效层，上浮淡出后自动销毁）
   * @param caster 技能释放者节点
   * @param skillName 技能名称
   */
export function showSkillTip(caster: Node, skillName: string) {
    if (!isValid(caster)) return;
    const style = uiTheme.floatingText.skill;
    const skillTip = UiHelper.createLabel("skill_tip", getText("label_skill_release", { skill: skillName }), style.color, style.fontSize, new Vec2(), style.size);
    LayerManager.addToEffectLayer(skillTip);
    // 位置在释放者头顶（上移角色身高的一半）
    const casterPosition = caster.getWorldPosition();
    skillTip.setWorldPosition(casterPosition.x, casterPosition.y + style.spawnOffsetY, casterPosition.z);
    const uiOpacity = skillTip.addComponent(UIOpacity);
    tween(skillTip)
      .to(style.riseDuration, { position: new Vec3(skillTip.position.x, skillTip.position.y + style.riseDistance, 0) })
      .start();
    tween(uiOpacity)
      .to(style.fadeDuration, { opacity: 0 })
      .call(() => {
        skillTip.destroy();
      })
      .start();
  }

  /**
   * 在击杀位置显示经验获取飘字（挂特效层，上浮淡出后自动销毁；经验为 0 时不显示）
   * @param target 被击杀的怪物节点
   * @param exp 获得的经验值
   */
export function showExpGain(target: Node, exp: number) {
    if (exp <= 0 || !isValid(target)) return;
    const style = uiTheme.floatingText.exp;
    const expText = UiHelper.createLabel("exp_gain_text", getText("label_exp_gain", { exp }), style.color, style.fontSize, new Vec2(), style.size);
    LayerManager.addToEffectLayer(expText);
    // 位置在被击杀怪物头顶
    const targetPosition = target.getWorldPosition();
    expText.setWorldPosition(targetPosition.x, targetPosition.y + style.spawnOffsetY, targetPosition.z);
    const uiOpacity = expText.addComponent(UIOpacity);
    tween(expText)
      .to(style.riseDuration, { position: new Vec3(expText.position.x, expText.position.y + style.riseDistance, 0) })
      .start();
    tween(uiOpacity)
      .to(style.fadeDuration, { opacity: 0 })
      .call(() => {
        expText.destroy();
      })
      .start();
  }
