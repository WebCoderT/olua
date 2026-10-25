/** 数据库行类型（SQLite 列名是 snake_case，与对外 DTO 的 camelCase 分开，避免两套口径混用） */

export interface AccountRow {
  id: string;
  username: string;
  password: string;
  /** 玩家邮箱（个人信息，仅 account:email 权限可见；存量账号为 null，后台可补录） */
  email: string | null;
  /** active | disabled */
  status: string;
  /** 当前选中（在线）的角色 id */
  online_role_id: string | null;
  /**
   * 令牌版本号（改密码时 +1）
   *
   * 令牌是无状态的，光改密码不会让已签发的旧令牌失效；签发时把版本号写进载荷、
   * 每次请求回查库比对，才能做到「改完密码旧设备立刻下线」（见 AuthGuard）。
   */
  token_version: number;
  /**
   * 封禁闭环（未封禁时四个字段都是 null）
   *
   * `ban_until` 与 `status` 的关系：status = disabled 且 ban_until = null 表示永久封禁，
   * 两个都为 null 之外的组合见 common/utils/ban.util（判定一律走那里，别在业务里手写）。
   */
  ban_reason: string | null;
  /** 封禁到期时间（毫秒）；null 且 status=disabled 表示永久封禁 */
  ban_until: number | null;
  /** 执行封禁的管理员账号名（冗余存一份，管理员被删也追得到人） */
  banned_by: string | null;
  banned_at: number | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

export interface RoleRow {
  id: string;
  account_id: string;
  name: string;
  occupation: string;
  sex: string;
  level: number;
  /** 角色完整数据（客户端 entities/Role 的 JSON 快照；服务端按不透明文档存取） */
  data: string;
  /**
   * 修订号（每次落库 +1）
   *
   * 用途是**乐观锁**：客户端推进度时带上它读到的值，服务端发现对不上就拒收（见 BizCode.ROLE_REVISION_CONFLICT）。
   * 没有它的话，「管理员在后台改角色」与「玩家在游戏里每 1.5 秒推一次存档」会互相覆盖，
   * 谁最后写谁赢 —— 后台的改动静默丢失。
   */
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface AdminRow {
  id: string;
  username: string;
  password: string;
  /** active | disabled */
  status: string;
  /** 管理员角色：super_admin | admin | viewer（见 common/constants/permission） */
  role: string;
  /** 令牌版本号（改密码时 +1），含义同 AccountRow.token_version */
  token_version: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

/** 账号行 + 统计出来的角色数（列表接口用） */
export interface AccountWithCountRow extends AccountRow {
  role_count: number;
}

/** 角色行 + 所属账号名 / 账号当前在线角色（管理端列表用，一次查询拿全免得 N+1） */
export interface RoleWithAccountRow extends RoleRow {
  account_name: string | null;
  account_online_role_id: string | null;
}

/**
 * 操作日志行
 *
 * 设计取向：**把「当时发生了什么」原样冻住**，而不是只存外键。
 * `actor_name` / `target_id` 都冗余存一份 —— 操作人可能被删、目标角色可能被删，
 * 只留 id 的话事后谁也认不出这条记录说的是谁。目标当前的名字在查询时按 target_type 关联补。
 */
export interface AuditLogRow {
  id: string;
  /** 操作人 id / 用户名 / 角色（登录失败等匿名事件为空） */
  actor_id: string | null;
  actor_name: string | null;
  actor_role: string | null;
  /** 动作标识，直接复用接口的 operationId（如 adminRole.patch / auth.login） */
  action: string;
  /** 目标类型：account | role | admin（无目标为空） */
  target_type: string | null;
  target_id: string | null;
  /** 附加上下文（JSON 字符串）：请求体（已脱敏）或登录失败的用户名等 */
  detail: string | null;
  ip: string | null;
  method: string | null;
  path: string | null;
  /** HTTP 状态码 */
  status_code: number | null;
  /** 1 成功 / 0 失败 */
  success: number;
  error_code: number | null;
  error_message: string | null;
  created_at: number;
}

/** 操作日志行 + 关联出来的目标当前名字（目标已被删则为 null，界面退回显示 id） */
export interface AuditLogWithNameRow extends AuditLogRow {
  target_name: string | null;
}

/**
 * 公告行
 *
 * 时间窗用**两个可空列**表达，而不是「必填的起止时间」：
 * - `starts_at = null` → 立即生效（发布即上线，运营最常用的路径）
 * - `ends_at = null` → 长期有效（不设截止）
 *
 * 这样「永久公告」「定时公告」「限时公告」是同一条记录的不同取值，不需要额外的状态列 ——
 * 也就不会出现「状态列说启用、时间窗说早就过期」这种自相矛盾的数据。
 */
export interface AnnouncementRow {
  id: string;
  title: string;
  content: string;
  /** normal | important（见 common/constants/announcement） */
  level: string;
  /** 1 启用 / 0 停用（运营手动下线用；与时间窗是两道独立的闸） */
  enabled: number;
  /** 生效开始时间（毫秒）；null = 立即生效 */
  starts_at: number | null;
  /** 生效结束时间（毫秒，不含）；null = 不设截止 */
  ends_at: number | null;
  /** 发布人管理员账号名（冗余存一份，管理员被删后仍可追溯） */
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 邮件投递任务行
 *
 * 发信**不同步阻塞请求**：接口只负责入队（`pending`），真正的投递由后台调度器按节奏做。
 * 这样 SMTP 服务器慢 / 不可达时，运营点下「发送」立刻有响应，而不是卡到网关超时。
 *
 * ## 为什么要落一张表而不是放内存队列
 * 内存队列在进程重启后就消失了 —— 于是「运营以为发出去了、玩家永远没收到」这种事
 * 发生过一次就没人再信这个通道。落表之后每封信都有可查的结局（已发送 / 最终失败 + 原因）。
 *
 * ## 为什么存渲染后的 subject / body
 * 渲染结果**冻在入队那一刻**：模板后来被改了、玩家改名了，重投一封三天前失败的任务
 * 也仍然发的是当时的内容。存模板 key + 变量、投递时再渲染，会让「重投」发出与当时不同的信。
 */
export interface MailQueueRow {
  id: string;
  /** 收件邮箱（**唯一投递凭据**：账号表里没有邮箱字段，邮箱由运营在发信时填写） */
  to_email: string;
  /**
   * 关联的玩家账号（可空）
   *
   * 只为「这封信是发给谁的」留一条可追溯的线（审计目标名、列表里显示账号名）。
   * **不是**投递凭据 —— 有没有 accountId 不影响发不发得出去。
   */
  account_id: string | null;
  /** 模板 key（见 modules/mail/mail-templates） */
  template_key: string;
  /** 渲染后的标题 */
  subject: string;
  /** 渲染后的正文（纯文本，换行用 \n） */
  body: string;
  /** 状态：pending / sending / retrying / sent / failed（见 common/constants/mail） */
  status: string;
  /** 已尝试次数（成功那一次也计入） */
  attempts: number;
  /**
   * 下一次重试的时刻（毫秒）；`pending` 与终态为 null
   *
   * 与「失败次数」分开存：调度器挑任务只看这一列（`next_retry_at <= now`），
   * 不用在 SQL 里重算指数退避 —— 退避公式只在一处实现。
   */
  next_retry_at: number | null;
  /** 最近一次失败的原因（成功为 null；界面要能直接展示） */
  last_error: string | null;
  /** 发起人管理员账号名（冗余存一份，管理员被删后仍可追溯） */
  created_by: string | null;
  created_at: number;
  updated_at: number;
  /** 投递成功的时刻（毫秒）；未成功为 null */
  sent_at: number | null;
}

/** 邮件任务行 + 关联出来的收件账号名（账号被删则为 null，界面退回显示邮箱） */
export interface MailQueueWithAccountRow extends MailQueueRow {
  account_name: string | null;
}

//#region 世界权威（#35）

/** 世界怪物实例行（服务端持有的怪物状态，一行 = 场上一只怪） */
export interface WorldMonsterRow {
  /** 实例 id（服务端发牌，如 "m1_3"：地图 1 的第 3 只；全服唯一且跨重启稳定） */
  instance_id: string;
  map_id: string;
  /** 怪物 key（configs/monster 的关联键，战斗数值查 MONSTER_COMBAT 用） */
  monster_key: string;
  /** 出生点（世界坐标；重生的落点也是它 —— 区域配置在客户端，服务端只记实例自己的位置） */
  x: number;
  y: number;
  hp: number;
  max_hp: number;
  /** 1 = 存活 / 0 = 死亡（等重生） */
  alive: number;
  /** 死亡时刻（毫秒）；存活为 null */
  killed_at: number | null;
  /** 预定重生的时刻（毫秒）；存活为 null */
  respawn_at: number | null;
  updated_at: number;
}

//#endregion

//#region 养成配置（称号 / 战魂）

/**
 * 称号一行（`titles` 表；一行 = 一个等级）
 *
 * `level` 是**主键且序列固定**（1..34）：表里永远只有客户端 configs 定义的那 34 行，
 * 后台只能改内容。`acquire_channel` 的取值域见 common/constants/game-config。
 * 八项属性按「min / max 两列」拍平（区间型六项 + 单值两项 maxHp / hpRecover）。
 */
export interface TitleRow {
  /** 等级（1 起；主键，不可增删行） */
  level: number;
  label: string;
  description: string;
  /** 动画资源目录（resources 相对路径，如 titles/sfx_13009） */
  animation: string;
  animation_frame_rate: number;
  /** 升到该级消耗的绑定元宝（仅 `upgrade` 渠道实际使用；其余渠道保留数值但不展示入口） */
  bind_gold: number;
  /** 获得渠道：upgrade | grant | unavailable（默认 unavailable） */
  acquire_channel: string;
  /**
   * 称号成长列表顺序（1 起；**仅 `upgrade` 渠道的行持有**，其余行为 null）
   *
   * 升级链顺序与等级号解耦：运营在后台拖动成长列表就是在改这一列。
   * 渠道切到 upgrade 时追加到列表尾（max+1）；切走时清空（价格保留）。
   */
  upgrade_order: number | null;
  max_hp: number;
  hp_recover: number;
  physical_attack_min: number;
  physical_attack_max: number;
  magic_attack_min: number;
  magic_attack_max: number;
  taoist_attack_min: number;
  taoist_attack_max: number;
  physical_defense_min: number;
  physical_defense_max: number;
  magic_defense_min: number;
  magic_defense_max: number;
  taoist_defense_min: number;
  taoist_defense_max: number;
  updated_at: number;
}

/**
 * 战魂一行（`souls` 表；一行 = 一阶）
 *
 * 与 `TitleRow` 同构，只少 `acquire_channel` 一列 —— 战魂没有「获得渠道」需求
 * （37 阶逐阶购买，渠道语义就是升级本身）。
 */
export interface SoulRow {
  /** 阶数（1 起；主键，不可增删行） */
  level: number;
  label: string;
  description: string;
  /** 动画资源目录（如 war-soul/sfx_13001） */
  animation: string;
  animation_frame_rate: number;
  /** 升到该阶消耗的绑定元宝 */
  bind_gold: number;
  max_hp: number;
  hp_recover: number;
  physical_attack_min: number;
  physical_attack_max: number;
  magic_attack_min: number;
  magic_attack_max: number;
  taoist_attack_min: number;
  taoist_attack_max: number;
  physical_defense_min: number;
  physical_defense_max: number;
  magic_defense_min: number;
  magic_defense_max: number;
  taoist_defense_min: number;
  taoist_defense_max: number;
  /** 战魂成长列表顺序（#234）：可空；全部行默认按阶数持有序号（1 起），拖动成长列表改的就是它 —— 升级链顺序与阶数解耦 */
  upgrade_order: number | null;
  updated_at: number;
}

//#endregion

//#region 成长曲线（#256）

/** 等级经验一行（`level_exps` 表）：一行 = 一个等级升到下一级所需经验 */
export interface LevelExpRow {
  /** 等级（1 起；主键，不可增删行） */
  level: number;
  /** 升到下一级所需经验（≥ 1；客户端升级判定读的就是它） */
  exp: number;
  updated_at: number;
}

/** 成长曲线分段一行（`growth_segments` 表）：一行 = 某条曲线的一个分段 */
export interface GrowthSegmentRow {
  /** 曲线键（configs/growth 的 roleGrowth 四条：maxHp / attack / defense / killsPerLevel） */
  curve: string;
  /** 段序号（1 起；同曲线内不可增删行，只许改内容） */
  seq: number;
  /** 起始等级（含） */
  from_level: number;
  /** 结束等级（含） */
  to_level: number;
  /** 该段起始等级的值 */
  start_value: number;
  /** 段内每升一级的增量 */
  per_level: number;
  updated_at: number;
}

/** 成长标量参数一行（`growth_scalars` 表）：一行 = 一个可调的数值参数 */
export interface GrowthScalarRow {
  /** 参数键（如 roleMaxLevel / attributeRange.minRate / expGain.expPerLevel） */
  key: string;
  /** 参数值（标量；整数或小数由各键的取值域约束） */
  value: number;
  /** 参数说明（管理端界面直接展示） */
  description: string;
  updated_at: number;
}

/**
 * 军衔一行（`ranks` 表；一行 = 一阶，#250）
 *
 * 与 `SoulRow` 同构（100 阶全量就是成长链，顺序天然按阶，**没有 upgrade_order 列** ——
 * 军衔不需要拖动排序，成长列表只做价格与属性视图）；多一个 `tier` 列（大段名，如「校尉」），
 * 少 animation 两列（军衔外观是头顶一行红字，没有动画资源）。
 */
export interface RankRow {
  /** 阶数（1 起；主键，不可增删行） */
  level: number;
  /** 衔名（如「陪戎校尉」） */
  label: string;
  /** 大段名（如「校尉」；10 段 × 10 阶） */
  tier: string;
  description: string;
  /** 晋到该阶消耗的绑定元宝（rankUpgradePrice 曲线的 seed 值） */
  bind_gold: number;
  max_hp: number;
  hp_recover: number;
  physical_attack_min: number;
  physical_attack_max: number;
  magic_attack_min: number;
  magic_attack_max: number;
  taoist_attack_min: number;
  taoist_attack_max: number;
  physical_defense_min: number;
  physical_defense_max: number;
  magic_defense_min: number;
  magic_defense_max: number;
  taoist_defense_min: number;
  taoist_defense_max: number;
  updated_at: number;
}

/**
 * 装备基础件配置（#252）：管理端「装备配置」的行
 *
 * 主键是**装备基础件 id**（如 `cloth_1`，普通的·人级；变体 `_pXsY` 是它乘前后缀倍率
 * 展开的，不进库）—— id / 部位结构固定，**不可增删行**（与称号 / 战魂 / 军衔同一取向）。
 * 属性列与 TitleRow / RankRow 同构（`SoulRowShape` 那十四列），可复用同一套转换。
 */
export interface EquipmentRow {
  /** 装备基础件 id（如 `cloth_1`；主键，不可增删行） */
  id: string;
  /** 部位（EQUIPMENT_TYPE 的枚举值，如 `cloth`） */
  slot: string;
  /** 穿戴需求等级（唯一定强入口的锚点） */
  level: number;
  /** 售卖价（客户端条目 `sellPirce` 的 seed 值 —— 客户端字段名历史拼写如此） */
  sell_price: number;
  /** 名称（如「青铜重甲」；seed 自客户端条目，暂不开放编辑） */
  label: string;
  max_hp: number;
  hp_recover: number;
  physical_attack_min: number;
  physical_attack_max: number;
  magic_attack_min: number;
  magic_attack_max: number;
  taoist_attack_min: number;
  taoist_attack_max: number;
  physical_defense_min: number;
  physical_defense_max: number;
  magic_defense_min: number;
  magic_defense_max: number;
  taoist_defense_min: number;
  taoist_defense_max: number;
  updated_at: number;
}

/**
 * 药品配置（#253）：管理端「药品配置」的行
 *
 * 主键是药品 id（如 `drug_hp_1`）—— id 清单固定，**不可增删行**（药品 id 被掉落表与
 * 背包引用）。effects 数组按键**求和**拍平成四列（客户端 resolveDrugRecovery 逐项累加，
 * 求和严格等价）；`duration` 是增益类字段，当前配置未用，不进表。
 */
export interface DrugRow {
  /** 药品 id（如 `drug_hp_1`；主键，不可增删行） */
  id: string;
  /** 名称（如「金创药（小）」） */
  label: string;
  /** 描述（运营文案，可编辑） */
  description: string;
  /** 使用等级需求（seed 自客户端条目，暂不开放编辑） */
  level: number;
  /** 售卖价（客户端条目 `sellPirce` 的 seed 值；商城售价归 #251，不在这里） */
  sell_price: number;
  /** 最大叠加数量 */
  max_stack: number;
  /** 使用冷却（秒） */
  cooldown: number;
  /** 固定回复生命 */
  effect_hp: number;
  /** 固定回复魔法 */
  effect_mp: number;
  /** 按角色 maxHp 的百分比回复（50 = 50%） */
  effect_hp_percent: number;
  /** 按角色 maxMp 的百分比回复（50 = 50%） */
  effect_mp_percent: number;
  updated_at: number;
}

//#endregion

//#region 契约类型：筛选条件（住在类型层而不是仓储文件里，好让 DTO 层只引类型不引实现）

/** 角色筛选条件（管理端列表 / 批量操作共用） */
export interface RoleFilter {
  keyword?: string;
  accountId?: string;
  /** true 只看在线角色；false 只看离线角色；不传不筛 */
  online?: boolean;
  occupation?: string;
  sex?: string;
  minLevel?: number;
  maxLevel?: number;
}

//#endregion
