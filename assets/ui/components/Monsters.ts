import { Animation, Node, Sprite, UITransform, Vec2, Vec3 } from "cc";
import monsters from "../../configs/monster";
import { ACTION, DIRECTION, Monster, MonsterConfig } from "../../types/common";
import AnimationHelper from "../helpers/AnimationHelper";
import { getAnimationName } from "../../configs/game";
import LayerManager from "../utils/LayerManager";
import { addObstacleCollider } from "../utils/utils";
import GameUiHelper from "../helpers/GameUiHelper";
import { Role } from "../../configs/role";

const Monsters = {
  /** 已生成怪物数据列表 */
  monsters: [] as Monster[],

  /** 已生成怪物节点列表 */
  monsterNodes: [] as Node[],

  /** 创建某个怪物 */
  createOneMonster(monsterId: string, position: Vec3) {
    const monster = monsters.get(monsterId);
    const m: Monster = { ...monster, hp: monster.maxHp };
    Monsters.monsters.push(m);
    const monsterNode = Monsters.createMonsterNode(m);
    monsterNode.setWorldPosition(position);
    Monsters.monsterNodes.push(monsterNode);
    LayerManager.addToGameLayer(monsterNode);
  },

  /** 创建怪物节点 */
  createMonsterNode(monster: Monster) {
    const node = new Node();
    const uitransform = node.addComponent(UITransform);
    uitransform.setContentSize(monster.contentSize);
    const animationNode = new Node();
    animationNode.addComponent(Sprite);
    console.log(monster.speedRate);
    const animate = AnimationHelper.useMonsterAnimation(getAnimationName(ACTION.STAND, DIRECTION.DOWN), animationNode, monster.out, monster.speedRate);
    animate.on(
      Animation.EventType.FINISHED,
      (_, { name }: { name: string }) => {
        if (name.includes("attack")) console.log("播放完成：" + name);
        /** 播放完成后更换当前最新动画 */
        animate.play(getAnimationName(ACTION.STAND, DIRECTION.DOWN));
      },
      this,
    );
    node.addChild(animationNode);
    addObstacleCollider(node);
    const head = GameUiHelper.createHead("monster_head", monster.label, monster.hp, monster.maxHp);
    node.addChild(head);
    return node;
  },

  /** 判断点击的是哪个怪物 */
  checkWhichMonterBeClicked(position: Vec2) {
    return Monsters.monsterNodes.find((node) => {
      return node.getComponent(UITransform).isHit(position);
    });
  },

  /** 怪物属性更改 */
  monsterUpdate(uuid: string, attack: Role) {
    Monsters.monsterNodes.forEach((node, index) => {
      if (node.uuid === uuid) {
        console.log(node);
      }
    });
  },
};

export default Monsters;
