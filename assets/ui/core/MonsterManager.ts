import { Animation, isValid, Label, Node, ProgressBar, UITransform, Vec2, Vec3 } from "cc";
import { getMonsterRespawnInterval, monsters } from "../../configs/monster";
import { ACTION, DIRECTION } from "../../types/animation";
import { Monster, MonsterSpawnArea } from "../../types/monster";
import { getAnimationName } from "../../configs/animation";
import LayerManager from "./LayerManager";
import DropManager from "./DropManager";
import GameUiHelper from "../helpers/GameUiHelper";
import { calcSkillDamage } from "../utils/battle/BattleMath";
import { addObstacleCollider } from "../utils/physics/ObstacleCollider";
import { Role } from "../../entities/Role";

/**
 * 怪物管理器（静态类）
 * 统一管理怪物数据与怪物节点的映射：
 * 生成（数据+节点+图层挂载）→ 点击/最近目标查询 → 受击结算（扣血/刷血条/死亡移除）→ 换图清空
 * 同时按地图的刷怪区域维护怪物数量：开图时按区域刷满，之后按重生时间检测并补充
 * 所有怪物节点一律挂载到 LayerManager 怪物层（Layer.MONSTER）
 */
export default class MonsterManager {
  /** 已生成怪物：怪物节点 -> 怪物运行时数据 */
  private static monsterMap = new Map<Node, Monster>();

  /** 刷怪区域（按怪物编号聚合：编号 -> 该编号的全部区域，同一编号可能分布在多个区域） */
  private static spawnGroups = new Map<string, MonsterSpawnArea[]>();

  /** 各编号怪物距下次补充检测的剩余时间（秒） */
  private static respawnTimers = new Map<string, number>();

  /** 清空所有怪物（切换地图时调用，同时清空刷怪区域与重生计时） */
  static reset() {
    this.monsterMap.forEach((_, node) => {
      if (isValid(node)) node.destroy();
    });
    this.monsterMap.clear();
    this.spawnGroups.clear();
    this.respawnTimers.clear();
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

  //#region 刷怪区域与重生（补充）

  /**
   * 设置刷怪区域并刷出初始怪物（换图时由地图的 MonsterAreaSpawner 注入）
   * 每个区域按 max 刷满，之后的增减交给 update 按重生时间维持
   * @param areas 地图 monster 对象组解析出的区域列表（空数组表示该地图不刷怪）
   */
  static setSpawnAreas(areas: MonsterSpawnArea[]) {
    this.spawnGroups.clear();
    this.respawnTimers.clear();
    areas.forEach((area) => {
      const group = this.spawnGroups.get(area.monsterId);
      if (group) group.push(area);
      else this.spawnGroups.set(area.monsterId, [area]);
      // 重生计时从开图起算
      this.respawnTimers.set(area.monsterId, getMonsterRespawnInterval(area.monsterId));
      for (let index = 0; index < area.max; index++) this.spawnInArea(area);
    });
  }

  /**
   * 重生检测（每帧驱动，由组合根在 Game.update 中调用）
   * 按编号逐个检查：到达该编号的重生时间后统计存活数，少于各区域 min 之和即补充到 max 之和，
   * 并把计时重置为下一个周期（同一编号的多个区域共用一份计时与数量约束）
   * @param deltaTime 距上一帧的秒数
   */
  static update(deltaTime: number) {
    this.spawnGroups.forEach((areas, monsterId) => {
      const interval = getMonsterRespawnInterval(monsterId);
      const remaining = (this.respawnTimers.get(monsterId) ?? interval) - deltaTime;
      if (remaining > 0) {
        this.respawnTimers.set(monsterId, remaining);
        return;
      }
      this.respawnTimers.set(monsterId, interval);
      this.replenish(monsterId, areas);
    });
  }

  /** 统计某编号怪物当前在地图中的存活数量（跨区域统计） */
  static countAlive(monsterId: string): number {
    let count = 0;
    this.monsterMap.forEach((monster, node) => {
      if (isValid(node) && monster.hp > 0 && monster.id === monsterId) count++;
    });
    return count;
  }

  /**
   * 补充某编号怪物：存活数少于各区域 min 之和时，按区域补到各区域 max 之和
   * min 为 0 表示不设下限（该编号允许被清空，不做补充）
   */
  private static replenish(monsterId: string, areas: MonsterSpawnArea[]) {
    const alive = this.countAlive(monsterId);
    const min = areas.reduce((total, area) => total + area.min, 0);
    if (alive >= min) return;
    const max = areas.reduce((total, area) => total + area.max, 0);
    for (let index = alive; index < max; index++) {
      // 落点在哪个区域随机，同一编号分散在各区域更自然
      this.spawnInArea(areas[Math.floor(Math.random() * areas.length)]);
    }
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
    // 死亡：先按掉落配置在地面生成掉落物，再注销数据并移除节点
    DropManager.drop(monster.drops, target.getWorldPosition());
    this.monsterMap.delete(target);
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
