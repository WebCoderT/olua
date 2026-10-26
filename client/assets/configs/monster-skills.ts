/**
 * 怪物技能挂载表（#372）
 *
 * 定位：**纯数据模块** —— 与 skill-data / status 同一纪律，零引擎 import，可被 Node 沙箱直接 require。
 *
 * 「哪只怪会放哪些技能」与「技能本身长什么样」分开：技能行在 `configs/skill-data`（owner = monster，
 * 9000 段），这里只写挂载关系（技能 id / 优先级 / 冷却覆写）。同一只怪可挂多条，
 * 同一个技能也能挂给多只怪 —— 这正是 #367 坚持技能同表（而不是一怪一张技能表）的原因。
 *
 * 服务端的消费方式（`MonsterAiService`）：
 * - 已进入战斗（有目标）才考虑放技能；
 * - 先试状态型（自己身上的 buff 先上），再试伤害型；同类型内按 `priority` 升序；
 * - 冷却取技能自身的 `cooldown`，条目里的 `cooldown` 可覆写（同一技能给不同怪不同节奏）；
 * - 距离取技能的 `distance`（状态型忽略距离）；全部不可用才走普攻。
 *
 * 管理端看到的是 `monster_skills` 表（seed 自本文件，运营可增删改），所以**改这里只影响新装库**；
 * 已上线的库走管理端。两边口径由 e2e 的「挂载行数 = 生成物」守住。
 */

/** 一条怪物技能挂载 */
export interface MonsterSkillEntry {
  /** 技能 id（必须在 configs/skill-data 里存在，且 owner = monster） */
  skillId: string;
  /** 优先级（越小越先；同优先级按配置顺序） */
  priority: number;
  /** 冷却覆写（秒）；缺省用技能自身的 cooldown */
  cooldown?: number;
}

/**
 * 怪物 key → 技能清单（key 与 configs/monster 的条目一一对应）
 *
 * 首个验证对象是 200「长尾跳鼠怪」（tier = boss，level 10）：三张图的 BOSS 刷新区都有它，
 * 放技能的样子最容易在现场看到。其他怪先不挂 —— 挂载是运营数据，加一只不必改代码。
 */
export const monsterSkills: Record<string, MonsterSkillEntry[]> = {
  "200": [
    // 状态先上：狂怒（攻击 ×1.5）与硬化皮肤（防御 ×1.5）冷却都是 15 秒，互不挤占
    { skillId: "9002", priority: 1 },
    { skillId: "9003", priority: 1 },
    // 然后是伤害技能：6 秒一次，1.8 倍物理攻击
    { skillId: "9001", priority: 2 },
  ],
};
