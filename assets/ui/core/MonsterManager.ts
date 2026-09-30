import { Animation, isValid, Label, Node, ProgressBar, UITransform, Vec2, Vec3 } from "cc";
import { monsters } from "../../configs/monster";
import { ACTION, DIRECTION } from "../../types/animation";
import { Monster, MonsterSpawnArea } from "../../types/monster";
import { getAnimationName } from "../../configs/animation";
import { cursorConfig } from "../../configs/cursor";
import LayerManager from "./LayerManager";
import CursorManager from "./CursorManager";
import DropManager from "./DropManager";
import GameUiHelper from "../helpers/GameUiHelper";
import { calcSkillDamage } from "../utils/battle/BattleMath";
import { addObstacleCollider } from "../utils/physics/ObstacleCollider";
import { Role } from "../../entities/Role";

/**
 * 怪物管理器（静态类）
 * 统一管理怪物数据与怪物节点的映射：
 * 生成（数据+节点+图层挂载）→ 点击/最近目标查询 → 受击结算（扣血/刷血条/死亡移除）→ 换图清空
 * 怪物只在开图时按地图的刷怪区域生成一次，之后不做刷新/补充（数量策略待重新设计）
 * 所有怪物节点一律挂载到 LayerManager 怪物层（Layer.MONSTER）
 */
export default class MonsterManager {
  /** 已生成怪物：怪物节点 -> 怪物运行时数据 */
  private static monsterMap = new Map<Node, Monster>();

  /** 清空所有怪物（切换地图时调用） */
  static reset() {
    this.monsterMap.forEach((_, node) => {
      CursorManager.unregisterHover(node);
      if (isValid(node)) node.destroy();
    });
    this.monsterMap.clear();
    LayerManager.clearMonsterLayer();
  }

  /** 生成一只怪物（按配置初始化数据与节点，挂载到怪物层） */
  static spawn(monsterId: string, position: Vec3) {
    const monsterConfig = monsters.get(monsterId);
    if (!monsterConfig) {
      console.warn(`[MonsterManager] 怪物配置不存在：${monsterId}`);
      return;
    }
    // 数据：由配置派生运行时数据（满血）
    const monster: Monster = { ...monsterConfig, id: monsterId, hp: monsterConfig.maxHp };
    // 节点：创建并挂载到怪物层
    const monsterNode = this.createMonsterNode(monster);
    LayerManager.addToMonsterLayer(monsterNode);
    monsterNode.setWorldPosition(position);
    // 数据与节点建立映射
    this.monsterMap.set(monsterNode, monster);
    // 鼠标移到怪物身上时显示攻击指针（死亡/换图时注销，见 hurt / reset）
    CursorManager.registerHover(monsterNode, cursorConfig.priority.monster, cursorConfig.attack);
  }

  /** 创建怪物节点（身体与头部血条由 GameUiHelper 生成零件拼装） */
  private static createMonsterNode(monster: Monster) {
    const { node, animate } = GameUiHelper.createMonsterBody(monster);
    // 动作动画播放完成后回到待机
    animate.on(
      Animation.EventType.FINISHED,
      (_, { name }: { name: string }) => {
        animate.play(getAnimationName(ACTION.STAND, DIRECTION.DOWN));
      },
      node,
    );
    addObstacleCollider(node);
    // 碰撞范围显示（调试用，全部碰撞体共用一套开关）
    GameUiHelper.showColliderRange(node, monster.label);
    const head = GameUiHelper.createHead("monster_head", monster.label, monster.hp, monster.maxHp);
    node.addChild(head);
    return node;
  }

  //#region 按刷怪区域生成

  /**
   * 按地图的刷怪区域生成怪物（开图时由地图的 MonsterAreaSpawner 调用，只生成这一次）
   * 每个区域按 max 在其矩形范围内随机落点生成对应编号的怪物，之后不再补充
   * @param areas 地图 monster 对象组解析出的区域列表（空数组表示该地图不刷怪）
   */
  static spawnByAreas(areas: MonsterSpawnArea[]) {
    areas.forEach((area) => {
      for (let index = 0; index < area.max; index++) this.spawnInArea(area);
    });
  }

  /** 在区域内的随机位置生成一只怪物 */
  private static spawnInArea(area: MonsterSpawnArea) {
    this.spawn(area.monsterId, this.getRandomAreaPosition(area));
  }

  /** 取区域内随机一点的坐标（地图节点未旋转缩放，在区域矩形内均匀取值即可） */
  private static getRandomAreaPosition(area: MonsterSpawnArea) {
    const { center, size } = area;
    return new Vec3(center.x + (Math.random() - 0.5) * size.width, center.y + (Math.random() - 0.5) * size.height);
  }

  //#endregion

  /** 获取被点击的怪物节点 */
  static getClickedMonster(position: Vec2): Node | null {
    for (const node of this.monsterMap.keys()) {
      if (isValid(node) && node.getComponent(UITransform).isHit(position)) return node;
    }
    return null;
  }

  /** 获取以 position 为中心、distance 范围内最近的存活怪物节点（distance <= 0 不限距离，技能自动选目标用） */
  static getNearestMonster(position: Vec3, distance: number): Node | null {
    let nearest: Node | null = null;
    let nearestDistance = distance > 0 ? distance : Infinity;
    this.monsterMap.forEach((monster, node) => {
      if (!isValid(node) || monster.hp <= 0) return;
      const current = Vec3.distance(position, node.getWorldPosition());
      if (current <= nearestDistance) {
        nearestDistance = current;
        nearest = node;
      }
    });
    return nearest;
  }

  /** 获取目标节点的怪物数据 */
  static getMonsterData(target: Node): Monster | null {
    return this.monsterMap.get(target) ?? null;
  }

  /** 普通攻击结算：按攻击者属性对目标怪物结算一次伤害 */
  static attack(target: Node, attacker: Role) {
    const monster = this.getMonsterData(target);
    if (!monster) return;
    // 只计算伤害，扣血统一由 hurt 处理（避免重复扣血）
    const damage = calcSkillDamage(attacker, monster);
    this.hurt(target, damage);
  }

  /** 对目标怪物结算一次伤害（特效层显示受伤飘字，刷新血条，死亡结算掉落并移除） */
  static hurt(target: Node, damage: number) {
    const monster = this.getMonsterData(target);
    if (!monster || monster.hp <= 0) return;
    // 受伤飘字（需在死亡销毁节点前显示）
    GameUiHelper.showDamageText(target, damage);
    monster.hp = Math.max(0, monster.hp - damage);
    this.updateHead(target, monster);
    if (monster.hp > 0) return;
    // 死亡：先按掉落配置在地面生成掉落物，再注销数据与悬停注册并移除节点
    DropManager.drop(monster.drops, target.getWorldPosition());
    this.monsterMap.delete(target);
    CursorManager.unregisterHover(target);
    target.destroy();
  }

  /** 刷新怪物头顶血条与血量文字 */
  private static updateHead(node: Node, monster: Monster) {
    const head = node.getChildByName("monster_head");
    if (!head) return;
    const hpBar = head.children[2]?.getComponent(ProgressBar);
    if (hpBar) hpBar.progress = monster.hp / monster.maxHp;
    const hpText = head.children[3]?.getComponent(Label);
    if (hpText) hpText.string = `${monster.hp} / ${monster.maxHp}`;
  }
}
