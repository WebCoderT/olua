import { isValid, Node } from "cc";
import { selectIndicator } from "../../../configs/effect";
import MonsterManager from "../../core/MonsterManager";
import AnimationHelper from "../../helpers/AnimationHelper";
import GameUiHelper from "../../helpers/GameUiHelper";

/**
 * 选中怪物指示器组件（怪物脚下的循环光圈）
 * 选中怪物时由创建器（RoleUIManager 注入）new 出来挂特效层，取消选中/目标失效时由 RoleUIManager 销毁；
 * 已有指示器时切换目标只改跟随对象（select），不重建特效
 * 光圈图集/挂点偏移/帧率统一在 configs/effect.selectIndicator
 */
export default class MonsterSelectIndicator extends Node {
  /** 当前跟随的怪物节点 */
  private target: Node | null = null;
  /** 光圈精灵节点（图集帧动画的载体，跟随由本组件统一驱动） */
  private effectNode: Node;

  constructor(target: Node) {
    super("monster_select_indicator");
    // 光圈零件（锚点居中、原始尺寸，与角色/怪物外观同一套口径），位置随本节点移动
    this.effectNode = GameUiHelper.createSkillEffect("monster_select_effect");
    this.addChild(this.effectNode);
    this.select(target);
    // 图集帧异步加载：加载完成后循环播放（期间可能已被销毁/换图，装载前校验）
    AnimationHelper.loadFramesFromAtlas(selectIndicator.atlas).then((frames) => {
      if (!isValid(this.effectNode) || !frames.length) return;
      AnimationHelper.playLoopWithFrames(this.effectNode.name, this.effectNode, frames, selectIndicator.frameRate);
    });
  }

  /** 切换跟随的怪物（同一指示器复用，仅改跟随目标，下一帧 update 生效） */
  select(target: Node) {
    this.target = target;
  }

  /** 指示器节点是否仍存活（Node 子类无 node 属性，供管理器校验并清理引用） */
  isValidNode(): boolean {
    return isValid(this);
  }

  /**
   * 每帧跟随目标脚下
   * @returns 是否仍需显示：返回 false 表示目标已死亡/移除，指示器将被销毁
   */
  update(): boolean {
    // 判据与怪物信息面板（MonsterInfoPanel.update）完全一致：节点失效 **或** 怪物数据已消失/血量归零都算失效。
    // 只判 isValid(节点) 不够——引擎的 isValid 默认不检查「已标记待销毁」(ToDestroy)，
    // 怪物死亡当帧节点仍算有效，光圈会比信息面板多活一帧；
    // 那一帧若正好有新目标接管选中，旧光圈就会失去引用被永久留在场上（见 core/RoleUIManager.selectMonster）
    if (!this.target || !isValid(this.target)) return false;
    const monster = MonsterManager.getMonsterData(this.target);
    if (!monster || monster.hp <= 0) return false;
    const position = this.target.getWorldPosition();
    this.setWorldPosition(position.x + selectIndicator.offset.x, position.y + selectIndicator.offset.y, position.z);
    return true;
  }
}
