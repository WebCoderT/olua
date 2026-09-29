import { Animation, isValid, Label, Node, ProgressBar, UITransform, Vec2, Vec3 } from "cc";
import monsters from "../../../configs/monster";
import { ACTION, DIRECTION } from "../../../types/animation";
import { Monster } from "../../../types/monster";
import { getAnimationName } from "../../../configs/animation";
import LayerManager, { Layer } from "../../core/LayerManager";
import { addObstacleCollider } from "../../utils/utils";
import GameUiHelper from "../../helpers/GameUiHelper";
import { Role } from "../../../entities/Role";

/**
 * 怪物容器组件
 * 挂载于游戏层的节点容器，负责怪物的创建、点击检测与受击结算
 */
export default class Monsters extends Node {
  /** 已生成怪物数据列表 */
  private monsters: Monster[] = [];

  /** 已生成怪物节点列表 */
  private monsterNodes: Node[] = [];

  constructor() {
    super("monsters");
  }

  /** 清空所有怪物（切换地图时调用） */
  reset() {
    this.destroyAllChildren();
    this.monsters.length = 0;
    this.monsterNodes.length = 0;
  }

  /** 创建某个怪物 */
  createOneMonster(monsterId: string, position: Vec3) {
    const monsterConfig = monsters.get(monsterId);
    const monster: Monster = { ...monsterConfig, hp: monsterConfig.maxHp };
    this.monsters.push(monster);
    const monsterNode = this.createMonsterNode(monster);
    this.addChild(monsterNode);
    monsterNode.setWorldPosition(position);
    this.monsterNodes.push(monsterNode);
  }

  /** 创建怪物节点 */
  private createMonsterNode(monster: Monster) {
    // 身体与待机动画由 GameUiHelper 生成
    const { node, animate } = GameUiHelper.createMonsterBody(monster);
    animate.on(
      Animation.EventType.FINISHED,
      (_, { name }: { name: string }) => {
        /** 播放完成后更换当前最新动画 */
        animate.play(getAnimationName(ACTION.STAND, DIRECTION.DOWN));
      },
      this,
    );
    addObstacleCollider(node);
    const head = GameUiHelper.createHead("monster_head", monster.label, monster.hp, monster.maxHp);
    node.addChild(head);
    LayerManager.setNodeToLayer(node, Layer.GAME);
    return node;
  }

  /** 获取被点击的怪物节点 */
  getClickedMonster(position: Vec2) {
    return this.monsterNodes.find((node) => {
      return node.getComponent(UITransform).isHit(position);
    });
  }

  /** 怪物受击结算（TODO: 根据攻击者属性扣除血量并刷新血条） */
  monsterUpdate(uuid: string, attack: Role) {
    this.monsterNodes.forEach((node) => {
      if (node.uuid === uuid) {
        // TODO: 结算伤害并更新怪物血条
      }
    });
  }

  /** 获取以 position 为中心、distance 范围内最近的存活怪物节点（distance <= 0 不限距离，技能自动选目标用） */
  getNearestMonster(position: Vec3, distance: number): Node | null {
    let nearest: Node | null = null;
    let nearestDistance = distance > 0 ? distance : Infinity;
    this.monsterNodes.forEach((node, index) => {
      if (!isValid(node) || this.monsters[index].hp <= 0) return;
      const current = Vec3.distance(position, node.getWorldPosition());
      if (current <= nearestDistance) {
        nearestDistance = current;
        nearest = node;
      }
    });
    return nearest;
  }

  /** 获取目标节点的怪物数据 */
  getMonsterData(target: Node): Monster | null {
    const index = this.monsterNodes.indexOf(target);
    return index === -1 ? null : this.monsters[index];
  }

  /** 对目标怪物结算一次伤害（刷新血条，死亡移除） */
  hurt(target: Node, damage: number) {
    const monster = this.getMonsterData(target);
    if (!monster) return;
    monster.hp = Math.max(0, monster.hp - damage);
    this.updateHead(target, monster);
    // 死亡：移除怪物（TODO: 死亡经验/掉落结算）
    if (monster.hp <= 0) {
      const index = this.monsterNodes.indexOf(target);
      this.monsterNodes.splice(index, 1);
      this.monsters.splice(index, 1);
      target.destroy();
    }
  }

  /** 刷新怪物头顶血条与血量文字 */
  private updateHead(node: Node, monster: Monster) {
    const head = node.getChildByName("monster_head");
    if (!head) return;
    const hpBar = head.children[2]?.getComponent(ProgressBar);
    if (hpBar) hpBar.progress = monster.hp / monster.maxHp;
    const hpText = head.children[3]?.getComponent(Label);
    if (hpText) hpText.string = `${monster.hp} / ${monster.maxHp}`;
  }
}
