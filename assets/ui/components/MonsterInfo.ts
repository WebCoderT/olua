import { Color, isValid, Label, Node, ProgressBar, Size, Vec2 } from "cc";
import MonsterManager from "../core/MonsterManager";
import GameUiHelper from "../helpers/GameUiHelper";

/** 面板背景节点名（重建动态内容时保留） */
const BACKGROUND_NAME = "monster_info_background";

/**
 * 怪物信息面板组件（自身即面板节点，位于 UI 中间顶部）
 * 动态创建：选中怪物时由创建器（RoleUIManager 注入）new 出来，取消选中或目标失效时由 RoleUIManager 销毁
 * 展示内容：背景（common/monster_bg）+ 左侧头像 + 名称 + 血量 + 技能
 * 面板样式全部由 GameUiHelper 零件拼装
 */
export default class MonsterInfo extends Node {
  /** 当前选中的怪物节点 */
  private target: Node | null = null;
  /** 血量进度条 */
  private hpBar: ProgressBar | null = null;
  /** 血量文字 */
  private hpText: Label | null = null;

  constructor(target: Node) {
    super("monster_info");
    // 面板主体（尺寸/位置/背景）由 GameUiHelper 生成
    GameUiHelper.createMonsterInfoBody(this);
    this.select(target);
  }

  /** 切换展示的怪物（同一面板复用），按怪物数据重建内容 */
  select(target: Node) {
    this.target = target;
    const monster = isValid(target) ? MonsterManager.getMonsterData(target) : null;
    this.clearContent();
    if (!monster) return;
    // 左侧头像
    this.addChild(GameUiHelper.createMonsterAvatar(monster));
    // 名称
    this.addChild(GameUiHelper.createText("monster_name", monster.label, 14, new Vec2(20, 22), new Size(150, 16), Color.WHITE, Label.HorizontalAlign.LEFT));
    // 血量条
    const hpBar = GameUiHelper.createHpBar("monster_hp", monster.hp / monster.maxHp, new Vec2(40, 2), new Size(140, 12));
    this.hpBar = hpBar.getComponent(ProgressBar);
    this.addChild(hpBar);
    // 血量文字
    this.hpText = GameUiHelper.createText("monster_hp_text", `${monster.hp} / ${monster.maxHp}`, 12, new Vec2(-5, -18), new Size(80, 12), Color.WHITE, Label.HorizontalAlign.LEFT).getComponent(Label);
    this.addChild(this.hpText.node);
    // 技能行（怪物未配置技能则不渲染）
    this.addChild(GameUiHelper.createMonsterSkillRow(monster));
  }

  /** 面板节点是否仍存活（Node 子类无 node 属性，供管理器校验并清理引用） */
  isValidNode(): boolean {
    return isValid(this);
  }

  /**
   * 每帧刷新血量
   * @returns 是否仍需显示：返回 false 表示选中目标已死亡/移除，面板将被销毁
   */
  update(): boolean {
    if (!this.target || !isValid(this.target)) return false;
    const monster = MonsterManager.getMonsterData(this.target);
    if (!monster) return false;
    if (this.hpBar) this.hpBar.progress = monster.hp / monster.maxHp;
    if (this.hpText) this.hpText.string = `${monster.hp} / ${monster.maxHp}`;
    return true;
  }

  /** 清理动态内容（保留面板背景），同时释放引用 */
  private clearContent() {
    this.children.slice().forEach((child) => {
      if (child.name !== BACKGROUND_NAME) child.destroy();
    });
    this.hpBar = null;
    this.hpText = null;
  }
}
