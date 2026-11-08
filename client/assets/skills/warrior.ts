import { isValid, Vec2, Vec3 } from "cc";
import { autoBattle } from "../configs/autoBattle";
import { SkillContext } from "../types/skill";
import AutoBattle from "../ui/core/AutoBattle";
import CursorManager from "../ui/core/CursorManager";
import EffectManager from "../ui/core/EffectManager";
import LayerManager from "../ui/core/LayerManager";
import SoundManager from "../ui/core/SoundManager";
import CombatChannel from "../ui/utils/net/CombatChannel";
import { getDirectionByVector, getDirectionToTarget } from "../ui/utils/battle/BattleMath";
import { HAS_MOUSE } from "../ui/utils/input/Pointer";

/** ‌基础剑术：对单体目标造成一次物理伤害（伤害与物理攻击相关） */
export function skill_1000(context: SkillContext) {
  const { config, caster, target, monsters } = context;
  if (!target) return;
  // 普攻音效（#683）：只有**战士的普通攻击**响这一声。
  // 按 `config.id` 过滤而不是按函数：1002~1011 都复用本实现（配置里换的是动作与数值），
  // 而「战士普通攻击」这个音效项指的就是 id 1000（基础剑术，occupation = 战士）。
  if (config.id === "1000") void SoundManager.play("warrior_attack");
  // 面向目标播放技能配置的动作动画（config.action）——表现立刻走，不等服务端的往返
  caster.playSkillAttack(config.action, getDirectionToTarget(target, caster), config.castLockMs);
  const monster = monsters.getMonsterData(target);
  if (!monster) return;
  // 伤害结算上移服务端（#34）：出手打上去，扣血 / 飘字 / 死亡等 settle 帧回来后演
  // （MonsterManager.applyServerSettle 是结果的落点）。
  //
  // **没有本地结算分支**（#581）：怪物只在服务端生成（进图 worldJoin → 服务端播种 → world 帧），
  // 通道不在线时场上根本没有怪可打，所以「关掉开关回到纯客户端」那条路不是降级，是空转；
  // 留着它只会让人以为客户端还能自己打怪。真断线时出手会走 sendCast 的失败提示。
  CombatChannel.sendCast(config.id, monster.instanceId, monster.id);
}

/** 烈火剑法：对单体目标造成一次强化物理伤害 */
export function skill_1001(context: SkillContext) {
  skill_1000(context);
}

/**
 * 状态型技能（护体神盾 / 金刚护体等）：只发一次出手，状态由服务端施加（#822）
 *
 * 以前这里是本地 `StatusManager.apply(statusId)` —— 客户端自己亮图标，服务端完全不知道，
 * 于是「护体神盾」既没真正生效（受击不吃格挡），又在结算里被当伤害技能打成了 300% 核弹。
 * 现在服务端按 `skills.category = "2"` 分流：不掷伤害，只把 `status_id` 挂到自己身上，
 * 回执里带回整份状态快照，客户端照它重建图标（`StatusManager.applyFromServer`）。
 *
 * 没有目标：`requireTarget = false` 的技能在 `SkillManager.tryCast` 里本来就不找目标，
 * 这里送空串，服务端也不按目标校验（自身施法）。
 */
export function skill_1010(context: SkillContext) {
  CombatChannel.sendCast(context.config.id, "", "");
}

/**
 * 十步一杀：朝鼠标悬停位置突进
 * - 悬停点在施法距离（config.distance）内：瞬移到鼠标位置
 * - 悬停点在范围外：沿「角色 → 悬停点」方向取距离上限处为落点
 * 落点先吸附到最近可行走位置（避免扎进墙/障碍），瞬移后面向突进方向播放技能动作，
 * 并在落点播放一次特效（区域技能的特效位置由技能实现决定，SkillManager 不代播）
 *
 * **出手也要报给服务端**（#824）：这个技能 `damage_coefficients` 是空数组（纯位移、不掷伤害），
 * 但冷却与法力是服务端的账 —— 不报等于「服务端不知道他放过这一手」，改包就能无限突进。
 * 服务端按 `target_type = 0` 走区域那条路：不查目标、不掷伤害，只过六道闸并回 `noDamage`。
 * 位移本身仍在本地（落点校验要等 #811 位置源收口，服务端现在没有权威坐标可比）。
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
  // 落点一并上报：服务端会按施法距离再夹一次（与上面 travel 的截断同一口径），
  // 所以两端算出的是同一个点；改包报一个远处落点也打不到射程外
  CombatChannel.sendCast(config.id, "", "", { x: landing.x, y: landing.y });
}
