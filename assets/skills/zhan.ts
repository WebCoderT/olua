import { isValid, Vec2, Vec3 } from "cc";
import { autoBattle } from "../configs/autoBattle";
import { SkillContext } from "../types/skill";
import AutoBattle from "../ui/core/AutoBattle";
import CursorManager from "../ui/core/CursorManager";
import EffectManager from "../ui/core/EffectManager";
import LayerManager from "../ui/core/LayerManager";
import StatusManager from "../ui/core/StatusManager";
import { calcSkillDamage, getDirectionByVector, getDirectionToTarget } from "../ui/utils/battle/BattleMath";
import { HAS_MOUSE } from "../ui/utils/input/Pointer";

/** ‌基础剑术：对单体目标造成一次物理伤害（伤害与物理攻击相关） */
export function skill_1000(context: SkillContext) {
  const { config, level, role, caster, target, monsters } = context;
  if (!target) return;
  // 面向目标播放技能配置的动作动画（config.action）
  caster.playSkillAttack(config.action, getDirectionToTarget(target, caster));
  // 物理伤害结算
  const monster = monsters.getMonsterData(target);
  if (!monster) return;
  const rate = config.damageCoefficients[level - 1].baseTypeRate;
  const damage = calcSkillDamage(role, monster, "physicalAttack", rate);
  monsters.hurt(target, damage);
}

/** 烈火剑法：对单体目标造成一次强化物理伤害 */
export function skill_1001(context: SkillContext) {
  skill_1000(context);
}

/** 护体神盾：给自身添加护体神盾状态（身上循环特效 + 头像下方图标；重复释放刷新持续时间，见 core/StatusManager） */
export function skill_1010(context: SkillContext) {
  StatusManager.applyStatusOfSkill("1010");
}

/**
 * 十步一杀：朝鼠标悬停位置突进
 * - 悬停点在施法距离（config.distance）内：瞬移到鼠标位置
 * - 悬停点在范围外：沿「角色 → 悬停点」方向取距离上限处为落点
 * 落点先吸附到最近可行走位置（避免扎进墙/障碍），瞬移后面向突进方向播放技能动作，
 * 并在落点播放一次特效（区域技能的特效位置由技能实现决定，SkillManager 不代播）
 */
export function skill_1008(context: SkillContext) {
  const { config, role, caster } = context;
  // 定向依赖鼠标悬停位置：触屏环境与开局未动过鼠标时没有悬停点，放弃本次释放
  if (!HAS_MOUSE) return;
  const screenPoint = CursorManager.getMouseScreenPoint();
  const camera = LayerManager.camera;
  if (!screenPoint || !camera || !isValid(caster)) return;
  const pointerWorld = camera.screenToWorld(new Vec3(screenPoint.x, screenPoint.y, 0), new Vec3());
  const position = caster.getWorldPosition();
  const offset = new Vec2(pointerWorld.x - position.x, pointerWorld.y - position.y);
  const distance = offset.length();
  // 落点：范围内取悬停点，范围外沿方向取距离上限（鼠标踩在角色身上时原地起跳）
  const travel = Math.min(distance, config.distance);
  const landing = distance > 0.001
    ? new Vec3(position.x + (offset.x / distance) * travel, position.y + (offset.y / distance) * travel, 0)
    : new Vec3(position.x, position.y, 0);
  // 落点吸附到可行走位置（网格未就绪或附近没有可站立位置时保持原落点）
  const walkable = AutoBattle.findWalkablePoint(new Vec2(landing.x, landing.y), autoBattle.dashSnapRadius);
  if (walkable) landing.set(walkable.x, walkable.y, 0);
  // 瞬移（相机同步跟随）→ 面向突进方向播放技能动作 → 落点特效
  caster.setWorldPositionByTransfer(landing);
  caster.playSkillAttack(config.action, getDirectionByVector(offset));
  EffectManager.playAt(config, landing, role);
}
