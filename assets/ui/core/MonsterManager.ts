import { Animation, isValid, Label, Node, ProgressBar, UITransform, Vec2, Vec3 } from "cc";
import { monsters } from "../../configs/monster";
import { ACTION, DIRECTION } from "../../types/animation";
import { Monster } from "../../types/monster";
import { getAnimationName } from "../../configs/animation";
import LayerManager from "./LayerManager";
import GameUiHelper from "../helpers/GameUiHelper";
import BattleHelper from "../utils/BattleHelper";
import { Role } from "../../entities/Role";
import { addObstacleCollider } from "../utils/utils";

/**
 * 怪物管理器（静态类）
 * 统一管理怪物数据与怪物节点的映射：
 * 生成（数据+节点+图层挂载）→ 点击/最近目标查询 → 受击结算（扣血/刷血条/死亡移除）→ 换图清空
 * 所有怪物节点一律挂载到 LayerManager 怪物层（Layer.MONSTER）
 */
export default class MonsterManager {
  /** 已生成怪物：怪物节点 -> 怪物运行时数据 */
  private static monsterMap = new Map<Node, Monster>();

  /** 清空所有怪物（切换地图时调用） */
  static reset() {
    this.monsterMap.forEach((_, node) => {
      if (isValid(node)) node.destroy();
    });
    this.monsterMap.clear();
    LayerManager.clearMonsterLayer();
  }

  /** 生成一只怪物（按配置初始化数据与节点，挂载到怪物层） */
  static spawn(monsterId: string, position: Vec3) {
    const monsterConfig = monsters.get(monsterId);
    if (!monsterConfig) return;
    // 数据：由配置派生运行时数据（满血）
    const monster: Monster = { ...monsterConfig, hp: monsterConfig.maxHp };
    // 节点：创建并挂载到怪物层
    const monsterNode = this.createMonsterNode(monster);
    LayerManager.addToMonsterLayer(monsterNode);
    monsterNode.setWorldPosition(position);
    // 数据与节点建立映射
    this.monsterMap.set(monsterNode, monster);
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
    const head = GameUiHelper.createHead("monster_head", monster.label, monster.hp, monster.maxHp);
    node.addChild(head);
    return node;
  }

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
    const damage = BattleHelper.attributeCalcAfterAttacked(monster, attacker);
    this.hurt(target, damage);
  }

  /** 对目标怪物结算一次伤害（刷新血条，死亡移除） */
  static hurt(target: Node, damage: number) {
    const monster = this.getMonsterData(target);
    if (!monster || monster.hp <= 0) return;
    monster.hp = Math.max(0, monster.hp - damage);
    this.updateHead(target, monster);
    // 死亡：注销数据并移除节点（TODO: 死亡经验/掉落结算）
    if (monster.hp <= 0) {
      this.monsterMap.delete(target);
      target.destroy();
    }
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
