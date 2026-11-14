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
   * 在线心跳（毫秒时间戳，#547）：最后一次确认「这条连接还活着」的时刻
   *
   * 与 `online_role_id` **同生同灭**（置标记一起写、清算一起清）：实时进程的存活探测
   * 每拍给活连接续约，宽限期内没有续约的标记被清算判为下线 —— 崩溃 / 断网留下的
   * 残留标记不会永远「在线」。只清标记不放心跳（或反过来）会出现「标记没了心跳还在」
   * 的半截状态，所以写点集中在 `AccountRepository.setOnlineRole`，别绕开它。
   */
  online_heartbeat_at: number | null;
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
  /**
   * 归属区（#295 阶段二）：注册时选定，之后只随「合并区」变化（合并是管理员操作，
   * 玩家自己换不了区）。各区只有一行的世界里，账号的世界就是它归属区的世界。
   */
  active_zone_id: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

/** 区服一行（`zones` 表；#295 阶段二：多开区 / 合并区） */
export interface ZoneRow {
  id: number;
  /** 区名（如「一区」；唯一，给玩家注册时选） */
  name: string;
  /**
   * 运营状态（#960 / #961）：`open` | `maintenance` | `closed`
   *
   * **已合并不塞进这里**：那是 `merged_into` 的事。一个区可以先 `closed`（停止注册、
   * 不推荐新人）再合并，两者是不同维度 —— 混在一个字段里会写出「关了就一定没数据」的错判。
   */
  status: string;
  /** 登录页 / 注册下拉的排序（升序；同值按 id。运营用它把新区顶上去） */
  sort: number;
  /** 开服时间（毫秒，#961）：区别于 `created_at`（建行时刻，一区是 0）—— 用来算开服天数 / 活动周期 */
  opened_at: number;
  /** 推荐区（1 = 选服弹窗里标「推荐」；`0` 与 `1` 两个值，客户端只做标记不做排序） */
  recommended: number;
  /** 运营备注（内部可见；客户端拿不到） */
  note: string | null;
  /** 已并入哪个区（合并区的标记；NULL = 还是一个活区） */
  merged_into: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * 区级世界代际（`zone_world_meta` 表，#961）
 *
 * 合并区只该作废**参与的这两个区**的内存世界。原来的 `world_meta.epoch` 是全局单值，
 * 合并一次全服所有图都白重建一遍（玩家看到本图怪整体重刷）。这里按区各存一行。
 *
 * 没有行 = 该区还没有代际记录（新开的区），读作 0。
 *
 * 注：`world_meta` 表本身还在，但只剩 `coord_origin`（坐标系平移的一次性标记）；
 * 它的 `epoch` 列已无人读（代际按区了），所以这里不再有对应的行接口。
 */
export interface ZoneWorldMetaRow {
  zone_id: number;
  epoch: number;
}

export interface RoleRow {
  id: string;
  account_id: string;
  /** 角色所属区（#957）：**区归属的唯一权威**；账号行上的 active_zone_id 只是「当前浏览区」 */
  zone_id: number;
  name: string;
  occupation: string;
  sex: string;
  level: number;
  /**
   * 击杀数（#400）
   *
   * 与 `level` 一样是**索引列**：等级从存档里的 `exp` 推出来，击杀数无处可推 ——
   * 所以由服务端结算路径自己数（`RolesService.recordKill`，唯一写者）。
   * 玩家保存进度走 `replace()`，那条 SQL 不碰这一列，客户端上报什么都改不到它。
   */
  kills: number;
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
  /**
   * 坏档标记（#819 / I6）
   *
   * `data` 这列解析不出来时置 1：进入游戏被拒（20029），等人工把 JSON 修好、
   * 下一次解析成功再自动清回 0。**不删行、不改 data** —— 删行毁证据，改 data
   * 是把坏档洗成空档（后者正是 B61 里那条提权通道的入口）。
   */
  corrupted: number;
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
  /**
   * 上次作业的区（#960）
   *
   * 管理端不绑区，但「上次在哪个区干活」要记住：换一台浏览器登录也该回到那个区。
   * 登录时写入（登录必带区），**不参与鉴权** —— 它只是下拉框的默认值。
   */
  last_zone_id: number | null;
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
 * 排行榜候选行（#400；#959 起按区取）
 *
 * 只取三个榜要用的东西：等级 / 击杀数是索引列，战力得靠 `data` 里的装备与养成项
 * 现算（`summarizeRoleAttributes`）。`zone_id` 是 `roles.zone_id`（#957 之后的唯一权威，
 * 不再 join 账号行）：榜是**分区榜**，查询本身就按它过滤，带出来只为让条目自己说清所属区。
 *
 * **刻意不带 `account_id`**：榜单是对外数据，账号 id 属于没必要暴露的关联键。
 */
export interface RoleLeaderboardRow {
  id: string;
  name: string;
  occupation: string;
  level: number;
  kills: number;
  /** 角色存档（算战力用；解析失败的角色跳过，不让它把整次重算带崩） */
  data: string;
  /** 归属区（`roles.zone_id`；角色带区后这一列就是唯一权威，不再 join 账号） */
  zone_id: number;
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
  /**
   * 这次操作发生在哪个区（#960）。
   *
   * **不是归属，是现场**：跨区追责要能答「这个客服在几区干过什么」。
   * 全区性的接口（配置、管理员、区目录）与登录失败这类没有区的请求为空。
   */
  zone_id: number | null;
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
 * 玩家行为流水行（#886 / J3）
 *
 * 与 `AuditLogRow` 的差别是「主语不同」：这张表的主语是**玩家角色**，所以没有
 * actor/action/path 那一套管理端字段，换成 role / map / target / amount 这类
 * 「做了什么、对谁、多少」的业务维度。
 */
export interface EventLogRow {
  id: string;
  /** 事件类型（见 common/constants/event-type 的 EVENT_TYPE） */
  type: string;
  account_id: string | null;
  role_id: string | null;
  /** 角色名（冗余：角色可能被删，只留 id 事后认不出是谁） */
  role_name: string | null;
  zone_id: number | null;
  map_id: string | null;
  /** 关键对象：怪物 key / 物品 id / 任务 id / 邮件 id（各类型语义不同，见 DTO 注释） */
  target: string | null;
  /** 数量 / 经验 / 金额（该类型有「多少」这个维度时才有值） */
  amount: number | null;
  /** 其余载荷（JSON 字符串） */
  detail: string | null;
  ip: string | null;
  /** 1 成功 / 0 失败（目前只有登录失败会写 0） */
  success: number;
  created_at: number;
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
  /** 实例 id（服务端发牌，如 "m1_z1_c0_3"：地图 1、一区公共线的第 3 只；全服唯一且跨重启稳定） */
  instance_id: string;
  map_id: string;
  /** 归属区（#295 阶段二；同一张图各区各有一份独立世界） */
  zone_id: number;
  /** 归属线（#809：'0' 公共线 / '1'.. 分线 / 'i<seq>' 副本） */
  slot: string;
  /** 怪物 key（configs/monster 的关联键，战斗数值查 monsters 表） */
  monster_key: string;
  /**
   * 归属刷怪区（`map_spawn_areas.id`；#852 起播种时写入，之后不变）。
   *
   * 为什么要这一列：密度补种要按**区**统计「这一区现在有几只」，而同一 `monster_key`
   * 可能在多个区复用 —— 按 key 反查会算到隔壁区去。老档（#852 之前播种的行）没有值，
   * 按出生点反查命中就回填，命中不了（区域已删）保持 null，那几只不计入任何区的配额。
   */
  area_id: number | null;
  /** 出生点（世界坐标；重生的落点也是它 —— 播种时由服务端在刷怪区内随机取点） */
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

/**
 * 角色位置快照（`role_positions` 表；#862/#863 的距离校验输入）
 *
 * 一行 = 一个**进过图**的角色最新被接受的坐标。写入方只有实时进程的
 * `PlayerPresenceService`（1 秒节流），读取方是任务域 —— 它回答的是
 * 「这个人在哪张图的哪个点上」，不是权威移动状态：坐标本质上是客户端自报 +
 * 最小仲裁（#596）的结果，只用来挡「隔着半张图点 NPC」，不做任何结算。
 *
 * 判新鲜度只看 `updated_at`：超过窗口就当「不知道他在哪」（拒绝交互），
 * 免得掉线 / 崩溃留下的最后一行变成永久通行证。
 */
export interface RolePositionRow {
  role_id: string;
  map_id: string;
  x: number;
  y: number;
  /** 最后一次写入的时刻（毫秒） */
  updated_at: number;
}

/**
 * 实时地图监控的一帧镜像（`map_monitor_state` 表；#665）
 *
 * 高频写、只读展示：**不是一个权威来源**，重启后为空也无所谓（实时进程下一次采样就会补上）。
 * `payload` 的形状见 `common/map-monitor.ts` 的 `MapMonitorSnapshot`（跨进程契约）。
 */
export interface MapMonitorStateRow {
  zone_id: number;
  map_id: string;
  /** 线（#809：'0' 公共线，分线 / 副本各占一行） */
  slot: string;
  /** JSON：{ monsters, players, sampledAt } */
  payload: string;
  updated_at: number;
}

/** 地图级玩法规则（`map_rules` 表；#809 / docs/20 §2.2，一行不存在 = 全默认） */
export interface MapRuleRow {
  map_id: string;
  exp_rate: number;
  drop_rate: number;
  money_rate: number;
  allow_pk: number;
  allow_auto_battle: number;
  allow_recall: number;
  allow_drop: number;
  max_players_per_room: number;
  max_channels: number;
  transfer_cost_money: number;
  transfer_cooldown_ms: number;
  deny_transfer_in_combat: number;
  respawn_ms_override: number | null;
  simulate_when_empty: number;
  updated_by: string;
  updated_at: number;
}

/** 单图热重载请求（`world_reload_requests` 表；#809，跨进程的一张待办表） */
export interface WorldReloadRequestRow {
  id: number;
  zone_id: number;
  map_id: string;
  slot: string;
  /** 'respawn' = 只重播刷怪区 / 'reload' = 连 AI 运行时一起重载 */
  mode: string;
  requested_by: string;
  requested_at: number;
  /** 等空窗的截止时刻（到点强制执行） */
  force_at: number;
  /** 'pending' / 'done' / 'failed' */
  status: string;
  done_at: number | null;
  /** 执行结果摘要（done 时是重播只数，failed 时是最后一次错误） */
  detail: string | null;
}

/** 实时地图监控的一条文字事件（`map_monitor_events` 表；#665；`payload` 见 `MapMonitorEvent`） */
export interface MapMonitorEventRow {
  id: number;
  zone_id: number;
  map_id: string;
  /** 事件时刻（毫秒） */
  at: number;
  /** kill = 击杀 / respawn = 刷新 */
  kind: string;
  payload: string;
}

/**
 * 刷怪区一行（`map_spawn_areas` 表；#295 阶段一：刷怪区配置归服务端）
 *
 * 一行 = Tiled monster 对象组里的一个矩形区域（从 TMX 导入一次后归服务端）。
 * 行只能来自启动 seed（`seedRow`，INSERT OR IGNORE 幂等）或导入工具整份替换，
 * 后台接口暂不开放增删（后续收口成管理页时再补）。
 */
export interface MapSpawnAreaRow {
  id: number;
  map_id: string;
  /** 区域名（Tiled 对象名，如「1号怪物」） */
  name: string;
  /** 怪物 key（configs/monster 的关联键；播种时对照 monsters 表，不认识的跳过） */
  monster_key: string;
  /** 区域允许的最少怪物数（密度目标的下限；管理端表单从小程序化起固定写 0） */
  min: number;
  /** 区域允许的最多怪物数（密度目标 = max × 时段系数 × 人数系数，仍以它为基准） */
  max: number;
  /** 高峰系数（null = 1.0；#852 起由 tick 按它算目标数，管理端可改） */
  density_peak: number | null;
  /** 低谷系数（null = 1.0） */
  density_off: number | null;
  /** 高峰时段（`"19:00-23:00"`，null / 空串 = 无峰谷；跨零点写成 `"22:00-02:00"`） */
  peak_hours: string | null;
  /** 区域中心 x（世界坐标口径，与快照 x/y 同一坐标系） */
  cx: number;
  /** 区域中心 y（世界坐标口径） */
  cy: number;
  /** 区域宽 */
  w: number;
  /** 区域高 */
  h: number;
  updated_at: number;
}

/**
 * 地图玩法配置一行（`maps` 表；#573：地图的整理结果归服务端）
 *
 * 一行 = 一张图的「名称 / 类型 / 进入条件」。资源本体（TMX / 底图 / 预览图）仍在客户端
 * 资源包里，`map_id` 就是 `resources/map/<id>/<id>.tmx` 的目录名 —— 所以**没有新建语义**：
 * 行由启动 seed 按资源清单（`MAP_CONTENTS` 的键）补出来，运营只改不改增。
 */
export interface MapRow {
  map_id: string;
  /** 地图名称（传送弹窗、小地图、公告等处显示的就是它） */
  label: string;
  /** 类型码（取值域见 common/constants/map-config 的 `MapType`） */
  type: string;
  /** 进入所需等级（0 = 无限制） */
  level: number;
  /** 进入所需战斗力（0 = 无限制） */
  combat: number;
  /** 进入所需战魂阶（0 = 无限制） */
  soul_of_war: number;
  /** 横向格数（几何来自 TMX，运营不改） */
  grid_cols: number;
  /** 纵向格数 */
  grid_rows: number;
  /** 单格宽（像素） */
  tile_width: number;
  /** 单格高（像素） */
  tile_height: number;
  /** 地图像素宽（= grid_cols × tile_width） */
  pixel_width: number;
  /** 地图像素高（= grid_rows × tile_height） */
  pixel_height: number;
  /**
   * 图层结构（JSON：`{ layers, groups }`，管理端详情页只渲染 `layers`）
   *
   * #676 起 `groups` **恒为空数组** —— TMX 里的对象组已由 `tools/strip-map-objects.cjs`
   * 整组删除，碰撞盒也搬进了 `map_collisions`。字段留着是为了存量库的老 content 仍能解析
   * （读方只看 `layers`，多出来的 `groups` 没人消费）。
   */
  content: string;
  /**
   * 复活点世界坐标（#672；两个都可能是 null）
   *
   * `null` = 这张图没有复活点 —— 与「(0,0) 那个点」是两件事，所以列是可空的（垫 0 会让
   * 玩家一进图就飞到左上角）。两列同生同灭，写的一侧必须是 `MapRepository.setRevivePoint(…, null)`。
   */
  revive_cx: number | null;
  revive_cy: number | null;
  /** 最后一个改它的管理员账号名（追账用；与 audit_logs 能对上） */
  updated_by: string;
  updated_at: number;
}

/**
 * NPC 点位一行（`map_npcs` 表；#672 起由管理端放置）
 *
 * 一行 = 「某个 NPC 站在某张图的某个点上」。外观（label / src / 缩放 / 偏移）在 `npcs` 表，
 * 这张表只管「站在哪」：`(map_id, npc_id)` 唯一，同一个 NPC 能在多张图各放一个（传送使者就是）。
 * 坐标是世界坐标（原点 = 地图左上角、y 轴向上，`cy` 为负）。
 */
export interface MapNpcRow {
  /** 行 id（接口路由用它定位，不用 npc_id —— 换 NPC 时 id 不变更好对账） */
  id: number;
  /** 地图 id（= resources/map 下的目录名） */
  map_id: string;
  /** NPC id（`npcs` 表的主键） */
  npc_id: string;
  /** 世界坐标 x（左上角原点向右） */
  cx: number;
  /** 世界坐标 y（y 轴向上，故为负） */
  cy: number;
  updated_at: number;
}

/**
 * 碰撞盒一行（`map_collisions` 表；#676 起由管理端绘制）
 *
 * 一行 = 一个轴对齐阻挡矩形（中心 + 尺寸，世界坐标，`cy` 为负）。以前这批矩形只在 TMX 的
 * `collision` 对象组里 —— 客户端两处读（生成静态碰撞体 / 自动战斗的静态障碍），后台只能看。
 *
 * **允许超出地图边界**：每张图的四面围墙本来就画在图外（`x = -64`、宽 8320），那是「把玩家
 * 关在图里」的手段。所以没有越界拒绝，界面上只有一个「整块在图外」的展示标记。
 */
export interface MapCollisionRow {
  /** 行 id（改 / 删用它定位；Tiled 里这批对象都没有名字，页面按 id 指认） */
  id: number;
  /** 地图 id（= resources/map 下的目录名） */
  map_id: string;
  /** 矩形中心 x（世界坐标，左上角原点向右） */
  cx: number;
  /** 矩形中心 y（世界坐标，y 轴向上，故为负） */
  cy: number;
  /** 矩形宽（像素） */
  w: number;
  /** 矩形高（像素） */
  h: number;
  updated_at: number;
}

/**
 * 特效配置一行（`ui_effects` 表；#594 升级特效 / #634 掉落光效）
 *
 * 一行 = 一个特效 key 的「摆位 / 缩放 / 旋转 / 时长 / 开关」（与武器外观同一套取向）。
 * 图集路径**不在表里** —— 那是两端约定 `effect/<key>/<key>.plist`，存了只会让人把客户端
 * 指到不存在的图上（#573 同一条纪律）。行由启动 seed 按 `UI_EFFECT_DEFAULTS` 补出来，
 * **没有新建 / 删除语义**：一个 key 存在的前提是客户端有这个特效的消费代码。
 */
export interface UiEffectRow {
  /** 特效 key（如 upgrade；取值域见 common/constants/ui-effect 的 UI_EFFECT_KEYS） */
  effect_key: string;
  /** 摆位偏移 X（像素，相对 UI 层锚点） */
  offset_x: number;
  /** 摆位偏移 Y（像素，y 向上为正） */
  offset_y: number;
  /** 横向缩放（1 = 原始尺寸） */
  scale_x: number;
  /** 纵向缩放（1 = 原始尺寸） */
  scale_y: number;
  /** 旋转（度，顺时针） */
  rotate: number;
  /** 一轮播放总时长（毫秒）；帧率由帧数 / 时长推出 */
  duration_ms: number;
  /** 开关（0 = 关：升级不播特效） */
  enabled: number;
  /** 最后一个改它的管理员账号名（追账用；与 audit_logs 能对上） */
  updated_by: string;
  updated_at: number;
}

/**
 * 音效配置一行（`audio_settings` 表；#680）
 *
 * 一行 = 一个音效项的「用哪个文件 / 多大声 / 循环不循环 / 开不开」。音频**文件本体**在
 * 客户端资源包里（`client/assets/resources/audio/`），这里只存资源相对路径 —— 与特效
 * 「只存表现参数」同一条纪律：二进制不进库、路径可换可不重打包。
 * 行由启动 seed 按 `AUDIO_DEFAULTS` 补出来，没有新建 / 删除语义（key 由客户端消费代码决定）。
 */
export interface AudioSettingRow {
  /** 音效 key（登录背景音 login_bgm、按钮点击音 ui_click；取值域见 common/constants/audio） */
  audio_key: string;
  /** 资源相对路径（带扩展名，如 `audio/login-bg.wav`；**空串 = 未配置，这一项不响**） */
  file_path: string;
  /** 音量百分比（0~100，100 = 原始音量） */
  volume: number;
  /** 是否循环（背景音 1、点击音 0） */
  loop: number;
  /** 开关（0 = 关：客户端连文件都不读） */
  enabled: number;
  /** 最后一个改它的管理员账号名（追账用；与 audit_logs 能对上） */
  updated_by: string;
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
  /** 动画资源目录（resources 相对路径，如 title/13009） */
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
  /** 动画资源目录（如 soul/13001） */
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

/**
 * 角色等级曲线的一段（`role_level_curves` 表；#786）
 *
 * 一行 = 一条曲线在某段等级上的线性/二阶公式：
 * `value(level) = start_value + per_level * k + accel * k * (k - 1) / 2`（k = level - from_level）。
 * 4 条曲线（exp / hp / attack_max / defense_max）× 6 段 = 24 行就把 1..100 万级全定义了；
 * 求值见 `common/constants/role-level-curve.ts`。
 */
export interface RoleLevelCurveRow {
  /** 曲线 key（exp / hp / attack_max / defense_max；登记在 ROLE_LEVEL_CURVES） */
  curve: string;
  /** 段序号（同一曲线内 1 起，段按 from_level 升序且首尾相接） */
  seq: number;
  from_level: number;
  /** 结束等级；最后一段是出厂上限（超出的等级按该段公式继续外推） */
  to_level: number;
  /** `from_level` 处的值 */
  start_value: number;
  /** 每级增量 */
  per_level: number;
  /** 每级增量的增量（二阶；exp 用，其余为 0） */
  accel: number;
  updated_at: number;
}

/**
 * 某一级的**求值结果**（#786：**不是表行**）
 *
 * 由 `buildRoleLevelRow()` 按 4 条曲线现算出来的形状 —— 结算、快照、管理端计算器
 * 都吃这一种形状，好处是「算出来的」与「存进去的」在类型上没有区别。
 * 数据库里没有对应表：`role_levels` 已随 #786 删除（100 万级存不下）。
 */
export interface RoleLevelRow {
  level: number;
  /** 升到下一级所需经验（曲线 `exp` 的值） */
  exp: number;
  max_hp: number;
  max_mp: number;
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
  /** 名称（如「青铜重甲」；管理端可改） */
  label: string;
  /** 职业限制（OECCUPATION 的枚举值：1 战士 / 2 法师 / 3 道士 / 4 不限） */
  occupation: string;
  /** 性别限制（SEX 的枚举值：1 男 / 2 女 / 3 不限） */
  sex: string;
  /** 描述（详情弹窗正文） */
  description: string;
  /** 图标（resources 相对路径，如 `equipment/clothes/icon/005`） */
  icon: string;
  /** 内观图集（列名避开 SQL 关键字 in） */
  in_atlas: string;
  /** 外观图集 */
  out_atlas: string;
  /** 标签 JSON 数组文本（如 `["第一大陆"]`） */
  tags: string;
  /** 内观锚点（弹窗坐标系，原点 = 弹窗中心、y 向上） */
  in_pos_x: number;
  in_pos_y: number;
  /** 内观缩放（1 = 原尺寸） */
  in_scale_x: number;
  in_scale_y: number;
  /** 内观旋转角度（度，0 = 不转） */
  in_rotate: number;
  /** 外观缩放 */
  out_scale: number;
  /** 外观 8 向绝对位置 JSON 数组文本（`[{"x":..,"y":..}, …]`，顺序 up → left_up） */
  out_positions: string;
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
  /**
   * 掉落时**强制绑定**（#789）：1 = 这件装备一旦掉出来就绑定角色、不可交易
   *
   * 三种绑定判定之一（另两个：怪物侧的 `monster_drops.bind_drops`、`drop_params` 的随机概率），
   * 任一为真即绑定；三个都不为真时按 `bindChance` 掷一次。
   * 列**追加在建表语句末尾**，与 `ALTER TABLE ADD COLUMN` 补出来的顺序一致 ——
   * 否则新库与存量库的 `SELECT *` 列序不同，`make config-check` 会报一整份假 diff。
   */
  bind_on_drop: number;
}

/**
 * 装备变体一行（`equipment_variants` 表；#655）
 *
 * 一行 = 一件**具体可掉落 / 可穿戴**的装备（基础件 × 前后缀 = 每件基础件 15 行）。
 * 以前是「基础件属性 × 前后缀倍率」在运行时现算，现在每一行都是独立配置：
 * 属性、卖价、穿戴等级都可单独改，`equipments` 只留基础件当模板与名称来源。
 */
export interface EquipmentVariantRow {
  /** 变体 id（基础件原 id，或 `cloth_1_p3s2`；主键 = 物品 id） */
  id: string;
  /** 基础件 id（`equipments.id`；用于按基础件筛变体 / 连带改名） */
  base_id: string;
  /** 前缀序号（0 = 普通；下标与品质文案、颜色对齐） */
  prefix: number;
  /** 后缀序号（0 = 人级） */
  suffix: number;
  /** 完整名称（已拼好，如「精良的青铜重甲」—— 消费方不必再拼） */
  label: string;
  /** 穿戴需求等级 */
  level: number;
  /** 回收价（货币 = 绑定元宝；一键回收按它结算） */
  sell_price: number;
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
 * 装备槽位（#603 第九域）：13 行，主键是 EQUIPMENT_TYPE 的枚举值
 *
 * `sort_order` 同时是角色弹窗的槽位排列顺序与背包「一键整理」的部位序 ——
 * 「顺序」只有这一份，客户端 `equipmentSlotOrder` 是它的派生。
 */
export interface EquipmentSlotRow {
  /** 槽位 key（EQUIPMENT_TYPE 的枚举值，如 `cloth`；主键，不可增删行） */
  key: string;
  /** 槽位中文名（如「衣服」） */
  label: string;
  /** 槽位底图（resources 相对路径） */
  image_src: string;
  /** 在角色弹窗里的位置分组（left / right / bottom / custom） */
  position: string;
  /** 排序序号（从 0 起，越界由 seed 兜底） */
  sort_order: number;
  updated_at: number;
}

/**
 * 装备规则（#603 第九域）：单行表（id 恒 1）
 *
 * 五列都是 JSON 文本 —— 它们是「一组等长的表」（前后缀倍率 / 文案 / 回收价曲线的分段），
 * 拆成行反而要额外维护「档数必须一致」的约束。
 */
export interface EquipmentMetaRow {
  id: number;
  /** 前缀倍率 JSON（`[1, 1.1, 1.2, 1.3, 1.4]`） */
  prefix_rates: string;
  /** 后缀倍率 JSON（`[1, 2, 3]`） */
  suffix_rates: string;
  /** 前缀文案 JSON（`["普通的", …]`，与倍率同长） */
  prefix_labels: string;
  /** 后缀文案 JSON（`["人级", "天级", "神级"]`） */
  suffix_labels: string;
  /** 前缀文字颜色 JSON（#720，`["#DDDDDD", …]`，与文案同长；空数组 = 客户端内置色） */
  prefix_colors: string;
  /** 后缀文字颜色 JSON（#720，同上） */
  suffix_colors: string;
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
  /** 图标资源路径（resources 相对路径，如 `item/drug-hp-1`；#603 第十域起由服务端持有并下发） */
  icon: string;
  /** 使用等级需求（seed 自 item-seed.ts，暂不开放编辑） */
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
  /** 掉落时强制绑定（语义同 `EquipmentRow.bind_on_drop`；#789） */
  bind_on_drop: number;
}

/**
 * 物品与材料配置（#255）：管理端「物品配置」的行
 *
 * 主键是物品 id（如 `material_hide`）—— id 清单固定，**不可增删行**（掉落表与脚本引用）。
 * 只收 **MATERIAL / OTHER** 大类（装备 / 药品字段形态不同，各有自己的表与 issue）。
 */
export interface ItemRow {
  /** 物品 id（如 `material_hide`；主键，不可增删行） */
  id: string;
  /** 物品大类（GOOD_TYPE 的枚举值，如 `material`；结构字段不开放编辑） */
  type: string;
  /** 名称 */
  label: string;
  /** 描述 */
  description: string;
  /** 图标资源路径（resources 相对路径，如 `item/2010210`；#603 第十域起由服务端持有并下发） */
  icon: string;
  /** 等级需求（seed 自 item-seed.ts，暂不开放编辑） */
  level: number;
  /** 售卖价（客户端条目 `sellPirce` 的 seed 值；商城售价归 #251，不在这里） */
  sell_price: number;
  /** 最大叠加数量 */
  max_stack: number;
  updated_at: number;
  /** 掉落时强制绑定（语义同 `EquipmentRow.bind_on_drop`；#789） */
  bind_on_drop: number;
}

/**
 * 货币物品（#785）：背包里「使用后直接入账」的道具
 *
 * 与药品 / 物品的区别就在 `currency` + `amount` 两列：使用时不结算血蓝、也不进商城售价体系，
 * 而是给角色账本的 `bindGold` 加一笔（唯一货币，#843、#844 收敛后 旧币种字段已删；
 * 服务端权威，见 `RolesService.useMoneyItem`）。
 *
 * **可增删行**（与药品 / 物品的「id 清单固定」不同）：运营在管理端「货币物品」页自己开面值。
 * 删行不碰玩家存档 —— 背包里还引用已删 id 的格子只是「认不出的道具」，用不了也不报错。
 */
export interface MoneyItemRow {
  /** 物品 id（如 `money_bind_gold_10`；主键） */
  id: string;
  /** 名称（如「绑定元宝（10）」） */
  label: string;
  /** 描述（运营文案） */
  description: string;
  /** 图标资源路径（resources 相对路径，如 `item/currency/bind-gold-10`） */
  icon: string;
  /** 入账到哪个账本字段（收敛后只有 bindGold） */
  currency: string;
  /** 单件入账金额（> 0） */
  amount: number;
  /** 最大叠加数量 */
  max_stack: number;
  /** 售卖价（0 = 不可出售；货币道具默认 0） */
  sell_price: number;
  updated_at: number;
  /** 掉落时强制绑定（语义同 `EquipmentRow.bind_on_drop`；#789） */
  bind_on_drop: number;
}

/**
 * 升级卷轴（#787）：使用后**硬性提升 1 级**，带等级区间限制
 *
 * 与货币道具同形（可增删行的道具表），区别是两列等级区间：
 * `min_level ~ max_level` 之内的角色才能用 —— Lv1 只在 1~999 级可用，
 * 升到 1000 级就得换 Lv2（见 `common/constants/level-scrolls.ts` 的出厂切法）。
 *
 * 区间列**不随等级上限自动改写**：运营调 `roleMaxLevel` 只是在后面多出可升的空间，
 * 想让人升到 8000 级还得自己再开一卷（或把末卷的 max 调大）。
 */
export interface LevelScrollRow {
  /** 物品 id（如 `level_scroll_1`；主键，背包按它引用） */
  id: string;
  /** 名称（如「升级卷轴 Lv1」） */
  label: string;
  /** 描述（运营文案） */
  description: string;
  /** 图标资源路径（resources 相对路径，一卷一张：`item/scroll/level-scroll-1` …） */
  icon: string;
  /** 可用等级下限（含） */
  min_level: number;
  /** 可用等级上限（含） */
  max_level: number;
  /** 最大叠加数量 */
  max_stack: number;
  /** 售卖价（0 = 不可出售；出厂 0） */
  sell_price: number;
  updated_at: number;
  /** 掉落时强制绑定（语义同 `EquipmentRow.bind_on_drop`；#789） */
  bind_on_drop: number;
}

/**
 * 怪物基础数据（#258）：管理端「怪物配置」的行，也是世界权威 / 战斗结算的数值来源
 *
 * 主键是怪物 key（configs/monster 的关联键，如 "1"）—— 清单固定，**不可增删行**
 * （地图刷怪点 / 掉落表 / 技能引用）。战斗数值 seed 自生成物 MONSTERS
 * （monsterStats 打底 + 条目覆盖的展开结果）；改这里的值**即时生效** ——
 * 世界播种与伤害结算都直读本表（两进程共享同一个 SQLite 文件）。
 */
export interface MonsterRow {
  /** 怪物 key（configs/monster 的关联键；主键，不可增删行） */
  id: string;
  /** 名称（头顶名牌，后台可改） */
  label: string;
  /** 定位（normal / elite / boss；不参与数值展开，但决定 BOSS 判定 —— 击杀 BOSS 才发的邮件读它。#751 起可改） */
  tier: string;
  /** 等级（客户端按它排怪显示；可编辑） */
  level: number;
  /** 最大生命 */
  max_hp: number;
  /** 物理攻击区间 [min, max] */
  physical_attack_min: number;
  physical_attack_max: number;
  /** 魔法攻击区间 */
  magic_attack_min: number;
  magic_attack_max: number;
  /** 道术攻击区间 */
  taoist_attack_min: number;
  taoist_attack_max: number;
  /** 物理防御区间 */
  physical_defense_min: number;
  physical_defense_max: number;
  /** 魔法防御区间 */
  magic_defense_min: number;
  magic_defense_max: number;
  /** 道术防御区间 */
  taoist_defense_min: number;
  taoist_defense_max: number;
  updated_at: number;
}

/**
 * NPC 基础数据（#258）：管理端「NPC 配置」的行
 *
 * 主键是 NPC id（Tiled 对象组的关联键，如 "0002"）—— 清单固定，**不可增删行**
 * （地图对象组引用）。`dialog` 是对话文案列：客户端目前没有对话数据形态
 * （都写死在弹窗组件里），seed 为空串，运营在这里维护，客户端消费等对接。
 */
export interface NpcRow {
  /** NPC id（如 "0002"；主键，不可增删行） */
  id: string;
  /** 名称（后台可改） */
  label: string;
  /** 对话文案（seed 为空串，客户端消费等 #248/#249） */
  dialog: string;
  /** 素材目录（resources 相对路径，图集动画；#603 第七域起客户端不再存这份） */
  src: string;
  /** 精灵缩放（1 = 原尺寸） */
  scale_x: number;
  scale_y: number;
  /** 精灵在节点内的偏移（0,0 = 不偏移） */
  pos_x: number;
  pos_y: number;
  updated_at: number;
}

/**
 * 商城分类（#758）：运营自建的陈列分组（动态增删行）
 *
 * 分类只是陈列分组，不带任何数值；商品属于哪个分类由 `mall_goods.category_id` 标注。
 * 删除前 service 层校验分类下没有上架商品。
 */
export interface MallCategoryRow {
  /** 分类 id（自建时生成，如 `mc_xxx`） */
  id: string;
  /** 显示名（管理端与客户端页签共用） */
  label: string;
  /** 排序值（小者在先；同值按 id） */
  sort_order: number;
  updated_at: number;
}

/**
 * 商城上架商品（#758）：运营手动上架的装备变体（动态增删行）
 *
 * 商品本体（名称/图标/部位）是装备数据，不在这里复制 —— 这里只存**售价**与**购买等级**
 * 两个运营字段。不在表里的商品不在商城售卖（客户端陈列与购买都以这张表为准）。
 */
export interface MallGoodRow {
  /** 商品 id（装备变体 id，如 `cloth_1_p3s2`；主键，一件装备在商城只挂一行） */
  id: string;
  /** 所属分类（`mall_categories.id`） */
  category_id: string;
  /** 售价（绑定元宝/件；0 = 免费领取也合法） */
  price: number;
  /** 购买等级（角色等级不足时客户端禁用购买按钮、服务端拒绝成交） */
  required_level: number;
  /**
   * 每日限购件数（#846）：`0` = 不限购。
   *
   * 计数不在这一行（`mall_sales` 按「角色 + 商品 + 天号」记），这里的值只是**上限**。
   * 与 `drugs.cooldown = 0` 同口径：0 表示「这条规则不生效」。
   */
  daily_limit: number;
  /**
   * 全服库存件数（#846）：`-1` = 不限量，`0` = 售罄停售。
   *
   * 与 `daily_limit` 的默认值不同是**故意的**：限购 0 次没有意义（所以 0 = 无限购），
   * 而库存 0 件有意义（运营想立刻停售时把它改成 0 比下架更轻）。已卖件数在 `mall_stock`。
   */
  stock: number;
  updated_at: number;
}

/**
 * 每日限购计数（#846，**运行时**表 `mall_sales`，不进 config-sync.sql）
 *
 * 一行 = 一个角色在某一天买了某件商品几次。天号来自 `common/utils/daily-clock`
 * （每日 05:00 切日，与日常任务同尺）：天号对不上就是新的一天，不需要任何结算动作。
 */
export interface MallSaleRow {
  role_id: string;
  good_id: string;
  /** 天号（`resetDayOf` 的结果；绝对值无意义，只做比较） */
  day: number;
  /** 这一天买了几件 */
  count: number;
  updated_at: number;
}

/**
 * 全服库存计数（#846，**运行时**表 `mall_stock`，不进 config-sync.sql）
 *
 * 只记「卖了几件」，总量在 `mall_goods.stock`。运营把 stock 改小 = 立刻停售；
 * 「重置库存」= 把这行的 sold 清零（与改配置是两件事，后者会让客户端配置版本 +1）。
 */
export interface MallStockRow {
  good_id: string;
  sold: number;
  updated_at: number;
}

/**
 * 客户端运行时参数（#605）：单行配置（id 恒为 1），三个分组各一列 JSON
 *
 * 列里存的是「运营改过的部分」，缺键回落到 `config-sync.sql` 的出厂值 ——
 * 这样加一个参数不用给存量库补列，也不用写迁移。
 */
export interface RuntimeParamsRow {
  /** 恒为 1（单行表） */
  id: number;
  /** 掉落物手感参数（`DropRuntimeParams` 的 JSON）。`drop` 是 SQL 保留字，列名带后缀 */
  drop_params: string;
  /** 自动战斗 / 寻路参数（`AutoBattleParams` 的 JSON） */
  auto_battle: string;
  /** 帮会规则门槛（`GuildRuleParams` 的 JSON；服务端校验读它） */
  guild_rules: string;
  /** 怪物 AI 参数（`MonsterAiParams` 的 JSON；服务端权威 AI 每 tick 读它） */
  monster_ai: string;
  /** 位移校验参数（`MovementGuardParams` 的 JSON；#811，服务端消费、不下发客户端） */
  movement: string;
  updated_at: number;
}

/**
 * 怪物表现 / 资源（`monster_presentation` 表；#655）
 *
 * 一行 = 一只怪的图集路径 + 基准帧几何 + AI 视觉参数。数值在 `monsters`，这里只有
 * 「长什么样、怎么动」——
 *
 * - **几何**（`icon` / `out` / 偏移 / 身体尺寸）是素材事实：只有 `client/tools/gen-monster-config.cjs`
 *   实测图集后写，管理端只读；
 * - **行为**（`move_speed` / `aggressive` / `detect_range` / `speed_rate`）是运营旋钮（#751）：
 *   管理端 PATCH /admin/monsters/:id 的 `presentation` 段写，服务端 AI 与客户端表现各读一份。
 */
export interface MonsterPresentationRow {
  id: string;
  icon: string;
  out: string;
  out_offset_x: number;
  out_offset_y: number;
  content_width: number;
  content_height: number;
  move_speed: number;
  aggressive: number;
  detect_range: number;
  /** 动作名 → 速度倍率的 JSON（空对象 = 全用默认） */
  speed_rate: string;
  updated_at: number;
}

/** `monster_presentation` 的**可写子集**（#751：行为参数；几何列一律不在这里，别顺手加进来） */
export type MonsterBehaviorRow = Pick<
  MonsterPresentationRow,
  "id" | "aggressive" | "detect_range" | "move_speed" | "speed_rate" | "updated_at"
>;

/**
 * 战斗力权重（#605）：`combat_weights` 表的一行 = 一个属性
 *
 * 出厂值来自 `config-sync.sql`（`COMBAT_WEIGHTS_SEED`，生成物 `COMBAT_WEIGHTS` 的源头），
 * seed 幂等（INSERT OR IGNORE），后台只改 `weight`、不增删行。
 * 表里缺某个 key 时由 service 回落出厂值 —— 与运行时参数同一套「缺键回落」口径。
 */
export interface CombatWeightRow {
  /** 属性名（`maxHp` / `physicalAttack` / …），与生成物 `COMBAT_WEIGHTS` 的键完全一致 */
  key: string;
  /** 每 1 点该属性折算多少战斗力（区间属性按上下限之和再乘） */
  weight: number;
  updated_at: number;
}

/**
 * 新手引导步骤（#605）：`guide_settings` 单行表
 *
 * 整张步骤表存在 `steps` 一列 JSON 数组里（有序，数组顺序即体验顺序）。
 * 出厂值来自 `config-sync.sql`，缺行 / 坏 JSON 时 service 回落出厂值。
 */
export interface GuideSettingsRow {
  /** 恒为 1（单行表） */
  id: number;
  /** `GuideStepSeed[]` 的 JSON（`id` / `title` / `desc` / `spot` / `trigger`） */
  steps: string;
  updated_at: number;
}

/**
 * 装备外观（#695）：`equipment_appearance` 表的一行
 *
 * 四组映射各存一列 JSON 数组（前后缀→边框 / 前后缀→详情背景 / 特殊装备→边框 / 特殊装备→详情背景），
 * 外加两边各自的**实体注册表**（#714：边框 / 背景清单本体，棋盘与自定义表只引用 key）。
 * 出厂值来自服务常量（seed `INSERT OR IGNORE`），缺行由 service 在启动时补上。
 */
export interface EquipmentAppearanceRow {
  /** 恒为 1（单行表） */
  id: number;
  /** `AppearanceAssignmentSeed[]` 的 JSON（`prefix` / `suffix` / `key`，15 条） */
  borders: string;
  /** 同上，指向详情背景 key（15 条） */
  backgrounds: string;
  /** `CustomAppearanceSeed[]` 的 JSON（`equipment` / `key`） */
  custom_borders: string;
  /** 同上，指向详情背景 key */
  custom_backgrounds: string;
  /** `AppearanceItemSeed[]` 的 JSON（`key` / `effect?`）：边框清单本体（#714；出厂空，读取时自动并入被引用的 key） */
  border_items: string;
  /** 同上：详情背景清单本体 */
  background_items: string;
  updated_at: number;
}

/**
 * 具名掉落表（#254）：`drop_tables` 表的一行
 *
 * 一行 = 一张可被多怪复用的掉落表（seed 自生成物 DROP_TABLES 的 common / elite / boss，
 * 外加兜底表 default）。**与配置表相反，这一张允许动态增删**（运营自建新表给多怪复用，
 * 同 mall_prices 的定位）——但被 `monster_drops.table_id` 引用中的行拒绝删除。
 *
 * `picks` / `entries` 存 JSON 字符串（生成物里已把 weight / chance / count 规整为全显式；
 * 结构校验在 service：picks 是数字或 [min, max]，entries 每条 goodId 必须在物品总表里）。
 */
export interface DropTableRow {
  /** 表 id（如 "common"；主键，可动态增删） */
  id: string;
  /** 抽取次数 JSON：数字（固定件数）或 [min, max]（件数区间） */
  picks: string;
  /** 条目池 JSON：DropEntry[]（{goodId, weight, chance, count:[min,max]} 全显式形状） */
  entries: string;
  updated_at: number;
}

/**
 * 每怪掉落配置（#254）：`monster_drops` 表的一行
 *
 * 主键是怪物 key（= monsters.id，清单固定**不可增删行**，与怪物一一对应）。
 * `source` 是语义标注：`table` = 引用具名表（`table_id` 非空）；`entries` = 内联条目池
 * （`entries` 非空）；`none` = 未配置（走兜底表）。picks 只在内联或表引用覆盖件数时非空。
 * seed 自生成物 MONSTER_DROPS（220 只全内联）；后台 PATCH **整份替换**，改表即时生效
 * （将来的服务端掉落结算直读本表，与 monsters 表同一读法）。
 */
export interface MonsterDropRow {
  /** 怪物 key（= monsters.id；主键，不可增删行） */
  monster_key: string;
  /** 语义标注：table | entries | none */
  source: string;
  /** 引用的具名表 id（source = table 时非空） */
  table_id: string | null;
  /** 抽取次数 JSON（内联时必填；表引用时可覆盖件数，null = 用表自己的） */
  picks: string | null;
  /** 内联条目池 JSON（source = entries 时非空） */
  entries: string | null;
  updated_at: number;
  /**
   * 这只怪的掉落**整体强制绑定**（#789）：1 = 它掉出来的东西一律绑定角色
   *
   * 与物品侧的 `bind_on_drop` 是「或」的关系（用户口径：物品本身有强制绑定、掉它的怪也有
   * 强制绑定标记，两者都不为真时才随机）。放在每怪这一行而不是掉落条目上：条目池可能是
   * 多怪共用的具名表，而「这只怪掉的东西绑不绑」是它的属性。
   */
  bind_drops: number;
}

/**
 * 时装配置（#257）：管理端「时装配置」的行
 *
 * 主键是时装 id（config-sync.sql，如 "cloth_2"）—— 清单固定，**不可增删行**。
 * 名称 / 文案 / 售卖价 / 属性 / 获得渠道 seed 自生成物 FASHIONS（属性当前全 0），
 * 运营可改；`icon` / `in_res` / `out_res` 是客户端资源路径（表现层），后台不改。
 * `acquire_channel` 的取值域复用称号的 AcquireChannel（见 common/constants/game-config，
 * 默认 unavailable；渠道中文名在管理端按时装语境另配）。
 */
export interface FashionRow {
  /** 时装 id（如 "cloth_2"；主键，不可增删行） */
  id: string;
  /** 名称（后台可改） */
  label: string;
  /** 描述文案（后台可改） */
  description: string;
  /** 图标资源路径（resources 相对路径；后台可改，空串 = 不显示） */
  icon: string;
  /** 内观资源路径（空串 = 无；后台可改） */
  in_res: string;
  /** 外观资源路径（空串 = 无；后台可改） */
  out_res: string;
  /** 售卖价（绑定元宝/件；后台可改） */
  sell_price: number;
  /** 获得渠道：upgrade | grant | unavailable（默认 unavailable；后台可改） */
  acquire_channel: string;
  /** 最大生命加成 */
  max_hp: number;
  /** 每秒回血加成 */
  hp_recover: number;
  /** 物理攻击区间 [min, max] */
  physical_attack_min: number;
  physical_attack_max: number;
  /** 魔法攻击区间 */
  magic_attack_min: number;
  magic_attack_max: number;
  /** 道术攻击区间 */
  taoist_attack_min: number;
  taoist_attack_max: number;
  /** 物理防御区间 */
  physical_defense_min: number;
  physical_defense_max: number;
  /** 魔法防御区间 */
  magic_defense_min: number;
  magic_defense_max: number;
  /** 道术防御区间 */
  taoist_defense_min: number;
  taoist_defense_max: number;
  updated_at: number;
}

/**
 * 技能（#367）：`skills` 表的一行
 *
 * **角色与怪物同一张表**，靠 `owner` 区分 —— 技能这件事两边完全同构（一个动作 + 一套倍率 /
 * 或一段状态），分成两张表只会让「同一个技能既给怪又给人」变成复制。角色行 seed 自客户端
 * `configs/skill-data`（id 被技能栏 / 快捷键 / 角色存档引用，**不可增删**）；
 * 怪物行的增删与施放走 #12 主体那一刀（同样不在这里）。
 *
 * `damage_coefficients` 存 JSON（`[{baseType, baseTypeRate}]`，下标 = 技能等级）；
 * `status_id` 非空 = 释放成功后给**自身**挂这个状态（替代客户端原来手写的 skillStatusMap）。
 * `cast_lock_ms` 是释放动作锁（0 = 跟动画时长，>0 = 覆写），`require_target` 关掉后
 * 自身 / 状态型技能不再要求选中目标。
 */
export interface SkillRow {
  /** 技能 id（如 "1000"；主键，角色行不可增删） */
  id: string;
  /** 归属：role | monster（同一张表，管理端可切换查看） */
  owner: string;
  /** 技能名（后台可改） */
  label: string;
  /** 技能图标资源路径（resources 相对路径） */
  icon: string;
  /** 分类：存客户端 SkillType 原值（"0" 主动 / "1" 被动 / "2" 状态 / "3" 回复） */
  category: string;
  /** 目标类型：存客户端 SkillTargetType 原值（"0" 区域 / "1" 单体 / "2" 群体 / "3" 自身） */
  target_type: string;
  /** 施法动作（客户端动画动作键，如 attack_near） */
  action: string;
  /** 技能特效图集路径（空串 = 无） */
  effect: string;
  /** 特效是否播在自己身上（1 = 是） */
  effect_on_self: number;
  /** 冷却（秒） */
  cooldown: number;
  /** 释放一次消耗的魔法值 */
  mp_cost: number;
  /** 施法距离（0 = 不限距离） */
  distance: number;
  /** 学习 / 开启等级 */
  level_req: number;
  /** 描述文案（后台可改） */
  description: string;
  /** 伤害系数 JSON：[{baseType, baseTypeRate}]，下标 = 技能等级 - 1 */
  damage_coefficients: string;
  /** 释放成功后给自身挂的状态 id（空串 = 不挂） */
  status_id: string;
  /** 释放动作锁时长（毫秒；0 = 跟动画时长） */
  cast_lock_ms: number;
  /** 是否要求有合法目标（0 = 自身 / 状态型技能，不需要目标） */
  require_target: number;
  /** 是否可被自动战斗 / 挂机释放（1 = 可以） */
  can_auto: number;
  /** 职业归属（"1" 战士 / "2" 法师 / "3" 道士 / "4" 全职业；#603 第十一域：客户端技能栏按它重建映射） */
  occupation: string;
  /** 命中后的击退距离（像素；0 = 不击退。只对单体技能生效） */
  push_distance: number;
  /** 撞飞概率（0~1；0 = 从不撞飞，1 = 必撞。#826 第二批：还要求施法者等级 > 怪物等级） */
  push_chance: number;
  /**
   * 技能自带的暴击率（0~1，与角色暴击率**相加**；#826）
   *
   * 写成「技能带多少」而不是「技能是否必爆」：`desc` 里写的是「附带 15% 暴击率」，
   * 那是叠加在角色暴击之上的 15 个百分点，不是替换。
   */
  crit_rate: number;
  /**
   * 技能自带的暴击倍率（> 1 才生效；0 = 用角色那一份）
   *
   * 0 是「没配」，不是「倍率 0」—— 配了 0 会让暴击打出 0 伤害，那是运营手滑的形态，
   * 不该成为默认值。
   */
  crit_damage: number;
  /** 无视防御比例（0~1；1 = 完全无视，0 = 正常吃防御。只影响这一发） */
  def_ignore: number;
  /**
   * 两段连击的第二段系数（#826 第三批；0 = 没有第二段）
   *
   * 第二段伤害 = 第一段 × 这个系数，**不再单独掷攻击区间**：同一次出手的两段必须跟同一份
   * 随机走，否则「两刀差得比换装备还多」。第二段仍各自判命中后的死亡（第一段打死就不打第二段）。
   */
  second_hit_ratio: number;
  /** 拉人距离（像素；0 = 不拉。方向 = 目标朝施法者。与 `push_distance` 方向相反） */
  pull_distance: number;
  updated_at: number;
}

/**
 * 状态（#367）：`statuses` 表的一行
 *
 * 状态 = 一段持续效果（身上特效 + 图标栏徽标 + 战斗数值修正）。与技能同一取向：
 * **角色与怪物同表，靠 `owner` 区分** —— 怪物状态要参与服务端伤害结算，角色状态目前
 * 仍由客户端口径消费（服务端权威化另开一刀）。
 *
 * `combat` 存 JSON（`{blockChance, blockFactor, defenseMultiplier, attackMultiplier}`，见
 * `client/assets/types/status.StatusCombatConfig`）：状态在数值上意味着什么，
 * 角色侧的结算口径在客户端 BattleMath，怪物侧在 `MonsterAiService`（#372）。
 */
export interface StatusRow {
  /** 状态 id（如 "2001"；主键，角色行不可增删） */
  id: string;
  /** 归属：role | monster */
  owner: string;
  /** 状态名（后台可改） */
  label: string;
  /** 图标资源路径（resources 相对路径） */
  icon: string;
  /** 持续时间（秒；重复获得时从头计时） */
  duration: number;
  /** 来源：skill | equipment | privilege | other */
  source: string;
  /** 描述文案（后台可改） */
  description: string;
  /** 身上特效图集路径（空串 = 只在图标栏显示） */
  effect: string;
  /** 身上特效是否只播一遍停在尾帧（1 = 是） */
  effect_hold_last: number;
  /** 战斗数值修正 JSON（{blockChance, blockFactor, defenseMultiplier, attackMultiplier}） */
  combat: string;
  /**
   * 分类（#826 第三批）：`damage` 周期伤害 / `control` 控制 / `speed` 加减速 / `buff` 纯数值
   *
   * 只用于分流与前端分组，**判据不靠它**：控制看 `control_flags`、周期看 `tick_ms`。
   * 分类和实际行为不一致时，行为按 flags / tick 走 —— 那是运营手滑，不该让玩家技能失灵。
   */
  kind: string;
  /** 最大层数（1 = 不叠。同 id 再加一层 → +1 并刷新到期，不超过这个数） */
  max_stacks: number;
  /** 周期触发间隔（毫秒；0 = 无周期） */
  tick_ms: number;
  /** 每拍做什么 JSON（`{hp:-50}` / `{mp:+20}` / `{hpPercent:-0.02}`；`hpPercent` 按最大血量的比例） */
  tick_effect: string;
  /** 控制标记 JSON（`{stun:1, root:1, silence:1}`；stun 既禁移动也禁出手） */
  control_flags: string;
  updated_at: number;
}

/**
 * 怪物技能挂载（#372）：`monster_skills` 表的一行
 *
 * 「哪只怪放哪些技能」与「技能本身长什么样」分家：技能行在 `skills`（owner=monster），
 * 这里只存挂载关系。**可动态增删**（怪物技能天然会加，与角色技能清单固定相反）：
 * 管理端整份替换某只怪的清单，没有的行即删除。
 */
export interface MonsterSkillRow {
  /** 怪物 key（与 monsters 表主键、生成物 MONSTERS 的键一致） */
  monster_key: string;
  /** 技能 id（必须在 skills 表里存在且 owner=monster） */
  skill_id: string;
  /** 优先级（越小越先；状态型整体先于伤害型尝试） */
  priority: number;
  /** 冷却覆写（秒；null = 用技能自身的 cooldown） */
  cooldown: number | null;
  updated_at: number;
}

//#endregion

//#region 社交：帮会（#388）

/** 帮会一行（`guilds` 表） */
export interface GuildRow {
  id: string;
  /**
   * 所属区（#958）：建帮时取帮主角色的区，**不接受前端传**。
   *
   * 帮会不跨区 —— 成员只能来自本区，列表 / 申请 / 审批全部按它收口。
   * 名字仍然全局唯一（跨区同名会让搜索、举报、客服沟通无法区分）。
   */
  zone_id: number;
  /** 帮会名（全局唯一，2~12 字） */
  name: string;
  /** 公告（0~200 字） */
  notice: string;
  /** 帮主角色 id（与 guild_members.rank='leader' 的那行同一个人） */
  leader_id: string;
  /** 帮会等级（占位：本刀没有等级业务，写之前先定义它由谁改） */
  level: number;
  /** 帮会资金（同上，占位） */
  funds: number;
  created_at: number;
  updated_at: number;
}

/** 帮会成员一行（`guild_members` 表；role_id 全表唯一 = 一个人只能在一个帮会） */
export interface GuildMemberRow {
  guild_id: string;
  role_id: string;
  /** leader | vice | member（见 common/constants/social.ts 的 GUILD_RANK） */
  rank: string;
  joined_at: number;
}

/**
 * 成员 + 角色索引字段（列表展示用：名字与等级是 `roles` 表上的冗余列）
 *
 * 只在查询里 join 出来，不落盘 —— 角色的名字/等级改了就跟着变，不需要同步第二份。
 */
export interface GuildMemberWithRoleRow extends GuildMemberRow {
  role_name: string;
  role_level: number;
  role_occupation: string;
}

/** 入帮申请一行（`guild_applications` 表；(guild_id, role_id) 主键） */
export interface GuildApplicationRow {
  guild_id: string;
  role_id: string;
  message: string;
  created_at: number;
}

/** 申请 + 申请人名字（审批列表展示用） */
export interface GuildApplicationWithRoleRow extends GuildApplicationRow {
  role_name: string;
  role_level: number;
}

/** 帮会列表一行（帮会 + 人数 + 帮主名；人数用来排序与「满员」判断） */
export interface GuildListRow extends GuildRow {
  member_count: number;
  leader_name: string;
}

//#endregion

//#region 社交：好友与敌人（#389）

/**
 * 好友关系一行（`role_friends` 表）
 *
 * **镜像两行**：A 加 B 会在库里写 `(A,B)` 与 `(B,A)` 两条，`status` 同步（pending → accepted）。
 * 为什么不存一行再按方向查：好友列表与「谁在等我」都是一次主键前缀查询，
 * 不用 `WHERE role_id = ? OR friend_id = ?` 再自己判方向（那种写法还要在代码里拼两半边）。
 */
export interface RoleFriendRow {
  role_id: string;
  friend_id: string;
  /** pending 待处理 / accepted 已互为好友（见 common/constants/social.ts 的 FRIEND_STATUS） */
  status: string;
  /** 这一对是谁发起的（拒绝时也要知道「拒的是谁」，所以两边都记同一份） */
  requested_by: string;
  created_at: number;
  updated_at: number;
}

/** 好友关系 + 对方的角色索引字段（列表展示用，join 出来不落盘） */
export interface RoleFriendWithRoleRow extends RoleFriendRow {
  friend_name: string;
  friend_level: number;
  friend_occupation: string;
}

/** 敌人一行（`role_enemies` 表，单向：我标我的，对方不知道也不受影响） */
export interface RoleEnemyRow {
  role_id: string;
  enemy_id: string;
  created_at: number;
}

/** 敌人 + 对方的角色索引字段 */
export interface RoleEnemyWithRoleRow extends RoleEnemyRow {
  enemy_name: string;
  enemy_level: number;
  enemy_occupation: string;
}

//#endregion

//#region 屏蔽与举报（#398）

/**
 * 屏蔽一行（`role_blocks` 表，单向：我拉黑我的）
 *
 * 与 `role_enemies` 同构，但语义更硬：**服务端按它过滤内容**（聊天投递、互见帧），
 * 敌人只影响名字颜色。
 */
export interface RoleBlockRow {
  role_id: string;
  blocked_role_id: string;
  created_at: number;
}

/** 屏蔽 + 对方的角色索引字段（黑名单列表展示用） */
export interface RoleBlockWithRoleRow extends RoleBlockRow {
  blocked_name: string;
  blocked_level: number;
  blocked_occupation: string;
}

/** 举报一行（`role_reports` 表） */
export interface RoleReportRow {
  id: string;
  /** 举报人角色 id（不加外键：删号后记录仍要能查） */
  role_id: string;
  target_role_id: string;
  /** abuse / cheat / name / other（见 common/constants/social.ts 的 REPORT_CATEGORY） */
  category: string;
  reason: string;
  /** pending / handled / dismissed（v1 只写 pending） */
  status: string;
  created_at: number;
}

/** 举报 + 双方当前的角色名（LEFT JOIN：任一方被删则为 null，界面退回显示 id） */
export interface RoleReportWithNameRow extends RoleReportRow {
  role_name: string | null;
  target_name: string | null;
}

//#endregion

//#region 队伍（#399）

/**
 * 队伍本体一行（`parties` 表）
 *
 * **队长只有一个写者**：`leader_role_id`。成员表刻意不存 `is_leader` ——
 * 两份「谁是队长」在转让时必然会漂一次，而漂的表现是「两个人都能踢人」。
 */
export interface PartyRow {
  id: string;
  leader_role_id: string;
  created_at: number;
}

/** 队伍成员一行（`party_members` 表；`role_id` 唯一 = 一人一队，交给数据库约束） */
export interface PartyMemberRow {
  party_id: string;
  role_id: string;
  joined_at: number;
}

/**
 * 成员 + 角色当前的名字 / 等级（队伍快照展示用，读时 JOIN）
 *
 * 名字 / 等级不冗余进成员表：改名与升级是常态，冗余一份就得在每个改名 / 升级路径上同步，
 * 而队伍快照是低频帧（只在变化时发一次），JOIN 一次读库完全够。
 */
export interface PartyMemberWithRoleRow extends PartyMemberRow {
  role_name: string | null;
  level: number | null;
}

//#endregion

//#region 任务（#396）

/** 任务配置一行（`quests` 表；seed 来自共享快照 QUESTS，管理端可改可增删） */
export interface QuestRow {
  id: string;
  /** main 主线（一次性，prev_quest_id 链门控）/ daily 日常（领奖后删行可重接） */
  kind: string;
  label: string;
  description: string;
  /** 主线链前置任务 id（空串 = 无前置） */
  prev_quest_id: string;
  /** 接取最低等级 */
  min_level: number;
  /** 发布 NPC（npcs 表的 id；客户端头顶标记与对话入口的依据） */
  npc_id: string;
  /** kill | talk | collect（单目标，v1 边界） */
  objective_type: string;
  /** kill = monster key / talk = npc id / collect = 物品 id */
  objective_target: string;
  objective_count: number;
  reward_bind_gold: number;
  reward_exp: number;
  /** JSON：[{ goodId, count }] */
  reward_items: string;
  updated_at: number;
}

/**
 * 任务进度一行（`quest_progress` 表；(role_id, quest_id) 主键）
 *
 * 状态机：可接 = 无行 → accepted 进行中 → ready 可交付 → claimed 已领奖。
 * collect 任务没有独立 ready 态：交付时查背包判定，够就一步到 claimed。
 *
 * **daily 与 main 一样保留 claimed 行**（#815）：领奖只改状态，不删行。
 * 「今天领过没有」由 `reset_day`（每日 05:00 切日，见 `common/utils/daily-clock`）判定 ——
 * 删行会把证据一起删掉，闸门就只能靠另建计数器，而计数器与进度行迟早对不上。
 * `reset_day` 落后于今天的日常行**等价于可接**（不删也不清，`accept` 时覆盖重置）。
 */
export interface QuestProgressRow {
  role_id: string;
  quest_id: string;
  /** accepted | ready | claimed */
  status: string;
  progress: number;
  claimed_at: number | null;
  /** 这一行属于哪一天（05:00 切日的天号）；main 不参与比较，只是同列同源 */
  reset_day: number;
  created_at: number;
  updated_at: number;
}

/**
 * 成就配置一行（`achievements` 表，主键 id）
 *
 * 条件与奖励的形状与 `QuestRow` 同规格（单条件 + 三件套奖励），
 * 但**条件分两类**：
 * - 累计型（kill / quest）→ 需要 `role_achievements.progress` 记账；
 * - 状态型（level / combat / collect）→ 查询时按角色当前状态现算，不落进度。
 */
export interface AchievementRow {
  id: string;
  /** battle 战斗 / growth 成长 / explore 探索（面板页签） */
  category: string;
  label: string;
  description: string;
  /** kill 累计击杀 / quest 累计交付任务 / level 等级 / combat 战力 / collect 持有物品 */
  condition_type: string;
  /** kill = 怪物 key（"*" 任意）/ collect = 物品 id / 其余空串 */
  condition_target: string;
  /** 门槛值（累计型 = 需要多少次，状态型 = 需要到多少） */
  condition_count: number;
  reward_bind_gold: number;
  reward_exp: number;
  /** JSON：[{ goodId, count }] */
  reward_items: string;
  /** 分类内展示顺序（小的在前） */
  sort_order: number;
  /** 1 = 未达成时默认折叠（不剧透条件） */
  hidden: number;
  updated_at: number;
}

/**
 * 成就进度一行（`role_achievements` 表；(role_id, achievement_id) 主键）
 *
 * 只有累计型条件会写 `progress`；状态型条件这一列恒 0（读的时候现算，不读它）。
 * 行**不会因为达成而删除**：`achieved_at` / `claimed_at` 就是玩家的成就墙，
 * 删掉等于「领完就忘了自己拿过」。
 */
export interface RoleAchievementRow {
  role_id: string;
  achievement_id: string;
  /** 累计型条件的计数（状态型恒 0） */
  progress: number;
  /** 达成时刻（null = 未达成） */
  achieved_at: number | null;
  /** 领奖时刻（null = 未领） */
  claimed_at: number | null;
  updated_at: number;
}

//#endregion

//#region 游戏内邮件（#429）

/**
 * 玩家收件箱里的一封邮件
 *
 * 与 `MailQueueRow`（外发 SMTP 投递队列）没有任何关系：那是「发到注册邮箱」，
 * 这是「游戏里打开的箱子」。附件在**领取时**才入包，所以 `claimed_at` 为空的行
 * 带着一份还没到手的奖励 —— 删除接口因此只允许删「已领或无附件」的行。
 */
export interface RoleMailRow {
  id: string;
  role_id: string;
  /** 玩家看到的频道（#436）：system / reward / social / combat（四个枚举，见 `mail-channel.ts`） */
  channel: string;
  /** 更细的来源标签：system 系统 / achievement 成就兜底 / friend 好友申请 / boss 击杀… */
  kind: string;
  title: string;
  body: string;
  bind_gold: number;
  exp: number;
  /** 物品附件（JSON 列，`[{ goodId, count }]`） */
  attachments: string;
  /** 已读时刻（null = 未读） */
  read_at: number | null;
  /** 领取时刻（null = 附件还没领；无附件的邮件也走领取，语义是「已处理」） */
  claimed_at: number | null;
  /**
   * 收件箱保质期（#439，毫秒时间戳；null = 永不过期）
   *
   * 由**投递方**在 send 时给定（不同来源的保质期不同），清理任务只按它删。
   * 带**未领附件**的行不允许过期（过期等于替玩家扔奖励），判据在清理 SQL 里。
   */
  expires_at: number | null;
  /**
   * 自动入包成功时刻（#867；0 = 还没成功过）
   *
   * 与 `claimed_at` 是两件事：`claimed_at` 是「奖励发过了」的统一标记（人工领取与自动入包
   * 都会写），这列只回答「是不是系统替玩家塞进背包的」—— 玩家看邮件时正文里那句
   * 「附件已于 X 自动入包」就靠它，运营排查「东西怎么自己进包了」也只看它。
   */
  auto_claimed_at: number;
  /** 自动入包失败次数（#867）：背包满 / 乐观锁冲突都算；到上限就停手，等人工 */
  auto_attempts: number;
  created_at: number;
}

/**
 * 装备对齐几何行（#513）
 *
 * 一件衣服 / 一把武器 / 一套裸模的**外观**几何。`id` 形如 `cloth:cloth_1` /
 * `weapon:weapon_1` / `role:1`；**没有行 = 用客户端配置里的值**（所以没有"默认值"副本，
 * 重置就是删行）。`out_positions` 存 8 个方向的 `[x, y]`（方向顺序见 configs/animation 的 directions）。
 *
 * 只有外观：内观（弹窗转盘上的位置）走 `EquipInAlignRow`，两者形状不同（8 向 vs 单帧）。
 */
export interface EquipAlignRow {
  id: string;
  out_scale: number;
  out_positions: string;
  /** 1 = out_positions 是绝对位置；0 = 运行时按身体帧自动算（武器的渐进语义） */
  out_manual: number;
  /** 最后修改人（管理员账号名；账号被删后仍可追溯） */
  updated_by: string | null;
  updated_at: number;
}

/**
 * 装备内观几何行（#523）
 *
 * 一件衣服 / 一把武器的**内观**几何（角色信息弹窗里站在圆盘上的那份）。`id` 形如
 * `cloth:cloth_1` / `weapon:weapon_1`；**没有行 = 用客户端配置里的值**（重置 = 删行）。
 *
 * 与 `EquipAlignRow` 分开存：外观是「8 个方向 + 一个缩放」，内观是「一个位置 + 两轴缩放」，
 * 字段对不上；混在一行会让「只调了外观」也要存一份内观副本（反之亦然）。
 */
export interface EquipInAlignRow {
  id: string;
  /** 内观横向缩放（客户端 `inScaleX`，缺省 1） */
  in_scale_x: number;
  /** 内观纵向缩放（客户端 `inScaleY`，缺省 1） */
  in_scale_y: number;
  /** 内观位置（弹窗坐标系，y 向上） */
  in_x: number;
  in_y: number;
  /** 1 = 用手调绝对位置；0 = 客户端按当前衣服的内容 bbox 自动算（只对武器有意义） */
  in_manual: number;
  /** 最后修改人（管理员账号名；账号被删后仍可追溯） */
  updated_by: string | null;
  updated_at: number;
}

//#endregion

//#region 契约类型：角色身上生效中的状态（#822 / docs/22 A4）

/**
 * 一行 = 一个角色身上的一个状态（`role_status`，**运行时表**）
 *
 * 与 `StatusRow`（配置表，定义「这个状态是什么」）分开：这里是「谁此刻挂着它、还剩多久」。
 * `stacks` 目前恒为 1（A4 只落了叠加所需的列，层数封顶规则等 docs/22 §2.3 的周期/控制类状态
 * 一起做 —— 重开条件写在那篇的落地顺序里）。
 */
export interface RoleStatusRow {
  role_id: string;
  /** 状态 id（statuses.id） */
  status_id: string;
  stacks: number;
  /** 到期时刻（毫秒，服务端时钟） */
  expire_at: number;
  /** 挂上它的技能 id（复盘用；同一状态被换技能刷新时记最后一个） */
  source_skill: string;
  /**
   * 周期效果结算到哪一刻（毫秒；0 = 还没结算过一次，#826 第三批）
   *
   * 记账而不是用 `expire_at` 取模：重复获得会刷新到期时间，取模会把已经算过的拍子重算一遍，
   * 表现是「叠了一层就多掉一次血」。0 表示「下一次结算从挂上的那一刻开始算」。
   */
  ticked_at: number;
}

//#endregion

//#region 契约类型：筛选条件（住在类型层而不是仓储文件里，好让 DTO 层只引类型不引实现）

/** 角色筛选条件（管理端列表 / 批量操作共用） */
export interface RoleFilter {
  /**
   * 当前作业区（#960，**必填**）
   *
   * 管理端一次只在一个区里干活：列表 / 计数 / 批量删都必须带它。
   * 设成必填而不是可选，是为了让「漏传区」在编译期就暴露 —— 可选参数会静默变成「全区」。
   */
  zoneId: number;
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
