import { Animation, Node, UITransform, Vec2, Vec3 } from "cc";
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
}
