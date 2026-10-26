import { Animation, isValid, Label, Node, ProgressBar, Rect, UITransform, Vec2, Vec3 } from "cc";
import { monsters } from "../../configs/monster";
import { skills } from "../../configs/skill";
import { getKillExp } from "../../configs/level";
import { Monster, MonsterSpawnArea } from "../../types/monster";
import { SkillId } from "../../types/skill";
import { skillDamageBand } from "../utils/battle/BattleMath";
import { cursorConfig } from "../../configs/cursor";
import LayerManager from "./LayerManager";
import CursorManager from "./CursorManager";
import DropManager from "./DropManager";
import MonsterAI from "./MonsterAI";
import GameUiHelper from "../helpers/GameUiHelper";
import StorageManager from "./StorageManager";
import { addMonsterCollider } from "../utils/physics/MonsterCollider";
import { getWorldColliderRect } from "../utils/physics/MoveBlocking";
import CombatChannel, { CombatKillReward, WorldSnapshot } from "../utils/net/CombatChannel";

/**
 * 怪物管理器（静态类）
 * 统一管理怪物数据与怪物节点的映射：
 * 生成（数据+节点+图层挂载）→ 点击/最近目标查询 → 受击结算（扣血/刷血条/死亡移除）→ 换图清空
 * 怪物在开图时按地图的刷怪区域生成（#35 起由服务端持有状态：进图 worldJoin 播种，
 * 死亡后由服务端 tick 到点重生并以 world 帧广播，客户端随之补场；通道不可用时退回
 * 本地按区域一次性生成、不刷新的旧口径）
 * 怪物的行为与动画（待机游走/追击玩家/普攻/被击退）由 MonsterAI 每帧驱动，本类只管数据与生命周期
 * 所有怪物节点一律挂载到 LayerManager 怪物层（Layer.MONSTER）
 *
 * 伤害结算（#34）：玩家打怪的伤害由服务端算（见 utils/net/CombatChannel），本类的
 * applyServerSettle 是结果的落点 —— 扣多少血、死没死都以服务端说的为准，本地只做表现
 * 与合法带对账；实时通道不可用时技能实现会退回 hurt()（本地口径，回滚路径）。
 *
 * 世界权威（#35）：进图由 MonsterAreaSpawner 发 worldJoin，本类 applyWorldState 按服务端
 * 快照做差量合并（实例 id 服务端发牌、出生点以快照为准）；游走/追击仍是本地表现层，
 * 服务端持有的「坐标」是出生点。断线重连后 CombatChannel 会自动重发进图登记。
 */
export default class MonsterManager {
  /** 已生成怪物：怪物节点 -> 怪物运行时数据 */
  private static monsterMap = new Map<Node, Monster>();

  /** 实例 id -> 怪物节点（服务端结算按 targetId 找落点；换图清场时一起清） */
  private static instanceIndex = new Map<string, Node>();

  /** 实例 id 发牌器（会话内单调递增；世界权威 #35 后只服务回滚路径，正常发牌归服务端） */
  private static instanceSeq = 0;

  /** 场上怪物（节点 -> 怪物数据），供 MonsterAI 每帧遍历 */
  static getMonsterMap() {
    return this.monsterMap;
  }

  /** 清空所有怪物（切换地图时调用） */
  static reset() {
    this.monsterMap.forEach((_, node) => {
      CursorManager.unregisterHover(node);
      if (isValid(node)) node.destroy();
    });
    this.monsterMap.clear();
    this.instanceIndex.clear();
    LayerManager.clearMonsterLayer();
    // 旧图的目标在服务端那边也一并作废（#34：结算上下文不能跨图延续）
    CombatChannel.resetTargets();
  }

  /** 生成一只怪物（按配置初始化数据与节点，挂载到怪物层）
   *  @param instanceId 实例 id：**服务端发的牌**（世界权威 #35，来自 world 快照）；
   *                    缺省 = 本地发牌（回滚路径：通道不可用、怪还在客户端刷）
   *  @param hp 初始血量：世界权威下用服务端快照的值；缺省按配置满血
   */
  static spawn(monsterId: string, position: Vec3, instanceId?: string, hp?: number) {
    const monsterConfig = monsters.get(monsterId);
    if (!monsterConfig) {
      console.warn(`[MonsterManager] 怪物配置不存在：${monsterId}`);
      return;
    }
    // 数据：由配置派生运行时数据；实例 id 服务端牌优先（本地回滚路径现场发牌，会话内唯一）
    this.instanceSeq += 1;
    const monster: Monster = { ...monsterConfig, id: monsterId, hp: hp ?? monsterConfig.maxHp, instanceId: instanceId ?? `mon_${this.instanceSeq}` };
    // 节点：创建并挂载到怪物层
    const monsterNode = this.createMonsterNode(monster);
    LayerManager.addToMonsterLayer(monsterNode);
    monsterNode.setWorldPosition(position);
    // 数据与节点建立映射（实例索引给服务端结算找落点用）
    this.monsterMap.set(monsterNode, monster);
    this.instanceIndex.set(monster.instanceId, monsterNode);
    // 鼠标移到怪物身上时显示攻击指针（死亡/换图时注销，见 hurt / reset）
    CursorManager.registerHover(monsterNode, cursorConfig.priority.monster, cursorConfig.attack);
  }

  /** 创建怪物节点（身体与头部血条由 GameUiHelper 生成零件拼装） */
  private static createMonsterNode(monster: Monster) {
    const { node, animate } = GameUiHelper.createMonsterBody(monster);
    // 动作动画播完续播当前动作（当前动作由 MonsterAI 维护，它同时负责追击/待机时切动作）
    animate.on(Animation.EventType.FINISHED, () => MonsterAI.replayCurrent(node), node);
    addMonsterCollider(node);
    // 碰撞范围显示（调试用，全部碰撞体共用一套开关）
    GameUiHelper.showColliderRange(node, monster.label);
    // 头顶只保留血条与血量文字；名称显示在身体正中心（主动攻击红色/被动黄色）
    node.addChild(GameUiHelper.createMonsterHead(monster));
    node.addChild(GameUiHelper.createMonsterName(monster));
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

  /**
   * 获取被点击的怪物节点
   * 命中用 hitTest（屏幕坐标口径，内部走相机 screenToWorld），与走路换算同一坐标系；
   * 不能用废弃的 isHit——它吃 UI 空间坐标，窗口尺寸 ≠ 设计分辨率时整体偏移（选不中怪的根因）
   */
  static getClickedMonster(position: Vec2): Node | null {
    for (const node of this.monsterMap.keys()) {
      if (isValid(node) && node.getComponent(UITransform).hitTest(position)) return node;
    }
    return null;
  }

  /**
   * 获取以 position 为中心、distance 范围内最近的存活怪物节点
   * （distance <= 0 不限距离；exclude 用于自动战斗跳过被拉黑的目标）
   */
  static getNearestMonster(position: Vec3, distance: number, exclude?: Set<Node>): Node | null {
    let nearest: Node | null = null;
    let nearestDistance = distance > 0 ? distance : Infinity;
    this.monsterMap.forEach((monster, node) => {
      if (!isValid(node) || monster.hp <= 0) return;
      if (exclude?.has(node)) return;
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

  /**
   * 取所有存活怪物的碰撞盒（世界坐标）
   * 供角色移动做阻挡预测（见 utils/physics/MoveBlocking）：怪与角色的碰撞盒都是传感器，
   * 物理引擎不产生碰撞响应，不能穿过怪物这一条由这里手动保证
   * 自动战斗寻路也用它当动态障碍（exclude 传当前追击目标，让路径能通到目标身边）
   */
  static getBlockingRects(exclude?: Node): Rect[] {
    const rects: Rect[] = [];
    this.monsterMap.forEach((monster, node) => {
      if (!isValid(node) || monster.hp <= 0) return;
      if (node === exclude) return;
      const rect = getWorldColliderRect(node);
      if (rect) rects.push(rect);
    });
    return rects;
  }

  /**
   * 击退怪物（技能造成的位移，场上唯一能推动位置的途径，由 SkillManager 按技能配置 push 调用）
   * @param target 怪物节点
   * @param direction 击退方向（世界坐标，无需归一化）
   * @param distance 击退距离（像素）
   * @param duration 击退时长（毫秒，缺省取 configs/monster 的 monsterAI.pushDuration）
   */
  static push(target: Node, direction: Vec2, distance: number, duration?: number) {
    if (!this.monsterMap.has(target)) return;
    MonsterAI.push(target, direction, distance, duration);
  }

  /** 对目标怪物结算一次伤害（**本地口径**，实时通道不可用时的回滚路径） */
  static hurt(target: Node, damage: number) {
    const monster = this.getMonsterData(target);
    if (!monster || monster.hp <= 0) return;
    this.applyDamage(target, monster, damage, Math.max(0, monster.hp - damage));
  }

  /**
   * 服务端结算结果的落点（#34：伤害由服务端算，这里只把它演出来）
   *
   * 扣多少血、死没死都以结算帧为准（overkill 不截断伤害数字，血量才截断）；
   * 击杀奖励（经验 + 掉落）以 reward 为准（#316：结算在服务端，本地只演不掷）；
   * 同时做一次**合法带对账**：服务端伤害越出客户端口径允许的区间，
   * 以 `combat-parity` 标签记到 console —— 在删掉客户端旧算法之前，这就是发现口径漂移的地方。
   */
  static applyServerSettle(data: { skillId: string; targetId: string; damage: number; hp: number; killed: boolean; reward?: CombatKillReward }) {
    const node = this.instanceIndex.get(data.targetId);
    const monster = node ? this.monsterMap.get(node) : null;
    if (!node || !monster) return; // 换图后到达的迟到结算：目标已不在场，这次出手当作打空
    if (monster.hp <= 0) return; // 本地已经死了（比如本地口径先判到），不再重复演
    // 双跑对账：伤害带由「本地角色属性 × 技能倍率 − 本地怪物配置」推出
    const role = StorageManager.findOnlineRole();
    const skillId = data.skillId as SkillId;
    const config = skills.get(skillId);
    const skillLevel = role ? role.skills[skillId] : 0;
    if (role && config && skillLevel) {
      const rate = config.damageCoefficients[skillLevel - 1]?.baseTypeRate ?? 0;
      const [low, high] = skillDamageBand(role, monster, "physicalAttack", rate);
      if (data.damage < low || data.damage > high) {
        console.warn(
          `[combat-parity] server damage out of band: skill ${data.skillId} target ${data.targetId}(${monster.id}) ` +
            `server=${data.damage} band=[${low}, ${high}] (attribute tables or formula drifted; check MONSTER_COMBAT / role attributes)`,
        );
      }
    }
    this.applyDamage(node, monster, data.damage, data.hp, data.killed, data.reward);
  }

  /**
   * 世界权威快照落场（#35：实例身份与血量以服务端为准，客户端做差量合并）
   *
   * 只处理三件事，血量与身份**不回写**到已存在的节点（那是 applyServerSettle 实时在做的事，
   * 快照可能因为节流而滞后，覆盖反而会造成表现回跳）：
   * - 快照里有、场上没有 → 按服务端牌生成（含重生的怪：死亡时节点已销毁，广播一到就以新实例落场）；
   * - 场上有、快照里活着 → 不动（血量走实时结算）；
   * - 场上有、快照里已死 → 断线期间被队友击杀的兜底：走既有死亡表现清场。
   */
  static applyWorldState(snapshot: WorldSnapshot) {
    const seen = new Set<string>();
    for (const entry of snapshot.monsters) {
      seen.add(entry.instanceId);
      const node = this.instanceIndex.get(entry.instanceId);
      if (node) {
        const monster = node ? this.monsterMap.get(node) : null;
        if (monster && !entry.alive && monster.hp > 0) this.applyDamage(node, monster, 0, 0, true);
        continue;
      }
      if (!entry.alive) continue; // 死亡中的怪不生成；重生广播一到会作为「新增」落场
      this.spawn(entry.monsterKey, new Vec3(entry.x, entry.y), entry.instanceId, entry.hp);
    }
    // 场上有、快照里没有：换图残留之类的兜底，按死亡表现清掉（不演经验与掉落 —— 不是本地击杀）
    this.instanceIndex.forEach((node, instanceId) => {
      if (seen.has(instanceId)) return;
      const monster = this.monsterMap.get(node);
      if (monster && monster.hp > 0) this.applyDamage(node, monster, 0, 0, true);
    });
  }

  /**
   * 把一次伤害落到目标身上（表现与死亡流程的唯一去处，本地口径与服务端结算共用）
   * @param hp 落完后的血量（本地口径传「扣完的值」；服务端结算直接用服务端给的值）
   * @param killed 是否死亡（缺省按 hp <= 0 判 —— 本地口径；服务端结算以服务端判定为准）
   * @param reward 击杀奖励（#316：服务端结算的入账结果；缺省 = 本地口径，走本地经验与掉落表）
   */
  private static applyDamage(target: Node, monster: Monster, damage: number, hp: number, killed?: boolean, reward?: CombatKillReward) {
    // 受伤飘字（需在死亡销毁节点前显示；0 伤不飘 —— 世界快照的兜底清理不是一次真实受击）
    if (damage > 0) GameUiHelper.showDamageText(target, damage);
    monster.hp = Math.max(0, hp);
    this.updateHead(target, monster);
    if (monster.hp > 0 && !killed) {
      // 存活即激怒：被动攻击的怪物被打后记恨攻击者，之后在检测范围内与主动怪一样追击普攻
      // （怪物伤害来源当前只有玩家，攻击者即玩家；主动怪此调用无副作用）
      MonsterAI.provoke(target);
      return;
    }
    // 死亡：先结算击杀奖励再注销数据（经验飘字要借还活着的节点定位）——
    // 服务端结算路径（reward 存在）：经验入账与掉落内容都以服务端给的为准，本地只演；
    // 本地口径回滚路径（实时通道不可用）：按本地经验公式与掉落配置结算（既有行为）
    if (reward) {
      if (reward.exp > 0) {
        // 经验入账后的状态（level / exp / revision）在服务端已落账，照搬即可
        StorageManager.applyKillReward(reward);
        GameUiHelper.showExpGain(target, reward.exp);
      }
      DropManager.spawnResults(reward.drops, target.getWorldPosition());
    } else {
      const role = StorageManager.findOnlineRole();
      if (role) this.awardKillExp(target, monster, role.level);
      // 按掉落配置在地面生成掉落物
      DropManager.drop(monster.drops, target.getWorldPosition(), monster.dropPicks);
    }
    // 注销数据与悬停注册（信息面板/选中光圈/阻挡/点击判定随之失效），
    // 然后播放死亡动画，动画播完才移除节点；缺死亡帧资源的怪直接移除（不播动画也不永久残留）
    this.monsterMap.delete(target);
    this.instanceIndex.delete(monster.instanceId);
    CursorManager.unregisterHover(target);
    // 头顶血条隐藏（死亡后血量已无意义，留着会一直显示 0 / maxHp）
    const head = target.getChildByName("monster_head");
    if (head) head.active = false;
    if (!MonsterAI.die(target)) target.destroy();
  }

  /** 结算击杀经验（**本地口径回滚路径**：实时通道不可用时按本地公式入账；服务端结算在线时走 StorageManager.applyKillReward） */
  private static awardKillExp(target: Node, monster: Monster, roleLevel: number) {
    const exp = getKillExp(roleLevel, monster.level);
    if (exp <= 0) return;
    // 经验入账（升级判定/属性重算/补满血蓝/落盘/UI 刷新都在 StorageManager.onlineRoleGetExp 内完成）
    StorageManager.onlineRoleGetExp(exp);
    GameUiHelper.showExpGain(target, exp);
  }

  /** 刷新怪物头顶血条与血量文字（monster_head 结构：children[0]=血条 children[1]=血量文字，见 GameUiHelper.createMonsterHead） */
  private static updateHead(node: Node, monster: Monster) {
    const head = node.getChildByName("monster_head");
    if (!head) return;
    const hpBar = head.children[0]?.getComponent(ProgressBar);
    if (hpBar) hpBar.progress = monster.hp / monster.maxHp;
    const hpText = head.children[1]?.getComponent(Label);
    if (hpText) hpText.string = `${monster.hp} / ${monster.maxHp}`;
  }
}
