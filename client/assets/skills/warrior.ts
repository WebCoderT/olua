import { isValid, Vec2, Vec3 } from "cc";
import { autoBattle } from "../configs/autoBattle";
import { SkillContext } from "../types/skill";
import AutoBattle from "../ui/core/AutoBattle";
import CursorManager from "../ui/core/CursorManager";
import EffectManager from "../ui/core/EffectManager";
import LayerManager from "../ui/core/LayerManager";
import MonsterManager from "../ui/core/MonsterManager";
import StatusManager from "../ui/core/StatusManager";
import CombatChannel from "../ui/utils/net/CombatChannel";
import { calcSkillDamage, getDirectionByVector, getDirectionToTarget } from "../ui/utils/battle/BattleMath";
import { HAS_MOUSE } from "../ui/utils/input/Pointer";

/** ‌基础剑术：对单体目标造成一次物理伤害（伤害与物理攻击相关） */
export function skill_1000(context: SkillContext) {
  const { config, level, role, caster, target, monsters } = context;
  if (!target) return;
  // 面向目标播放技能配置的动作动画（config.action）——表现立刻走，不等服务端的往返
  caster.playSkillAttack(config.action, getDirectionToTarget(target, caster), config.castLockMs);
  const monster = monsters.getMonsterData(target);
  if (!monster) return;
  const rate = config.damageCoefficients[level - 1].baseTypeRate;
  // 伤害结算上移服务端（#34）：出手打上去，扣血/飘字/死亡等 settle 帧回来后演
  // （MonsterManager.applyServerSettle 是结果的落点；实时通道不可用时退回本地口径）
  if (CombatChannel.active) {
    CombatChannel.sendCast(config.id, monster.instanceId, monster.id);
    return;
  }
  // 本地结算（回滚路径：与上移前同一套公式，关掉开关就回到纯客户端）
  const damage = calcSkillDamage(role, monster, "physicalAttack", rate);
  MonsterManager.hurt(target, damage);
}

/** 烈火剑法：对单体目标造成一次强化物理伤害 */
export function skill_1001(context: SkillContext) {
  skill_1000(context);
}

/**
 * 状态型技能（护体神盾 / 金刚护体等）：给自身挂技能配置里的 statusId（#367）
 * 挂哪个状态由配置决定，不再在代码里写死技能 id —— 后台改 statusId 即换状态，
 * 新增状态型技能也不用改这里。没配 statusId 时什么都不做（配置型技能的合理空缺）。
 */
export function skill_1010(context: SkillContext) {
  const statusId = context.config.statusId;
  if (statusId) StatusManager.apply(statusId);
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
