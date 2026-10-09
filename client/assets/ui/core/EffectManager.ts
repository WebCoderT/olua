import { isValid, Node, Vec2, Vec3 } from "cc";
import { skillEffect } from "../../configs/effect";
import { Role } from "../../entities/Role";
import { SkillConfig } from "../../types/skill";
import AnimationHelper from "../helpers/AnimationHelper";
import GameUiHelper from "../helpers/GameUiHelper";
import LayerManager from "./LayerManager";

/**
 * 技能特效管理器（静态类）
 * 按技能配置（configs/skill 的 effect / effectIsOnSelf）在特效层播放一次性图集帧动画：
 * - effectIsOnSelf = true 挂在释放者身上；false 挂在目标身上
 *   （没有有效目标时退回释放者，覆盖群体技能与无目标技能）
 * - 播放速度与技能动作动画一致：总时长取 1 / 角色动作速度倍率，
 *   与角色动作动画的总时长是同一算法（见 AnimationHelper 的片段切割），因此特效与动作同时开始、同时结束
 * - 图集帧由 AnimationHelper 按资源路径缓存，播完自动销毁节点；未配特效或加载失败时静默跳过
 * 特效资源命名约定：resources 下 TexturePacker 图集（plist + png 同名），路径不含扩展名，
 * 形如 "effect/skill/s_1002@0"；同一个特效被切成多页（@0/@1）时由 AnimationHelper 自动合并
 */
export default class EffectManager {
  /**
   * 播放一次技能特效
   * @param config 技能配置（effect 为特效图集路径，effectIsOnSelf 决定作用对象）
   * @param caster 释放者节点（角色）
   * @param target 本次技能的目标节点（群体/无目标技能为 null）
   * @param role 释放时读取的角色数据（动作速度倍率的来源）
   */
  static play(config: SkillConfig, caster: Node, target: Node | null, role: Role) {
    if (!config.effect || !isValid(caster)) return;
    // 目标无效（无选中目标/目标已死亡）时退回释放者身上，避免特效出现在无效位置
    const onSelf = config.effectIsOnSelf || !target || !isValid(target);
    const owner = onSelf ? caster : (target as Node);
    const offset = onSelf ? skillEffect.selfOffset : skillEffect.targetOffset;
    // 特效节点与角色外观同一挂点口径（锚点居中），位置取作用对象的世界坐标 + 配置偏移
    const position = owner.getWorldPosition();
    this.playAt(config, position, role, offset);
  }

  /**
   * 在任意世界坐标播放一次技能特效（特效位置由技能实现决定的场景：
   * 位移技能的落点特效等，见 skills/zhan 的十步一杀）
   * @param config 技能配置（effect 为特效图集路径）
   * @param position 特效中心的世界坐标
   * @param role 释放时读取的角色数据（动作速度倍率的来源）
   * @param offset 特效相对 position 的偏移（缺省取释放者挂点偏移）
   */
  static playAt(config: SkillConfig, position: Vec3, role: Role, offset: Vec2 = skillEffect.selfOffset) {
    if (!config.effect) return;
    const name = `skill_effect_${this.effectName(config.effect)}`;
    const node = GameUiHelper.createSkillEffect(name);
    LayerManager.addToEffectLayer(node);
    node.setWorldPosition(position.x + offset.x, position.y + offset.y, position.z);
    AnimationHelper.loadFramesFromAtlas(config.effect).then((frames) => {
      // 场景可能已切换：节点失效就不再装载
      if (!isValid(node)) return;
      if (!frames.length) {
        node.destroy();
        return;
      }
      AnimationHelper.playOnceWithFrames(name, node, frames, this.actionDuration(role, config));
    });
  }

  /** 技能动作动画的总时长（秒）：与 AnimationHelper 的片段切割同一口径（速度倍率 = 每秒循环数） */
  private static actionDuration(role: Role, config: SkillConfig) {
    const rate = role.speedRate[config.action] ?? 1;
    return 1 / (rate > 0 ? rate : 1);
  }

  /** 特效节点名（取图集文件名，便于在场景树里辨认是哪个特效） */
  private static effectName(effect: string) {
    return effect.slice(effect.lastIndexOf("/") + 1);
  }
}
