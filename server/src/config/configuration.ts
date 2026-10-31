import { join } from "node:path";
import { PARTY_MIN_LEVEL_DEFAULT } from "../common/constants/social";

/** 内置的开发用 JWT 密钥（生产必须换掉；唯一出现处，比较也只用 `jwtSecretIsDefault`） */
const DEFAULT_JWT_SECRET = "olua-dev-secret-please-change-me";

/**
 * 应用配置（**唯一来源**）
 *
 * 端口、数据文件、密钥、上限、跨域来源一律从这里取；
 * 代码里不允许出现这些值的字面量（自查见 tools/audit-api-hardcode.cjs）。
 * 取值优先级：环境变量 / .env 文件 → 这里的默认值。
 */
export interface AppConfiguration {
  /** 运行环境 */
  env: string;
  /** 监听端口 */
  port: number;
  /** 全局路由前缀 */
  apiPrefix: string;
  /** SQLite 数据文件路径（:memory: = 内存库） */
  dbPath: string;
  /** JWT 签名密钥 */
  jwtSecret: string;
  /**
   * JWT 密钥是否仍是内置默认值
   *
   * 单独留一个派生字段，是为了让「生产环境忘了改密钥」这件事**可被检查**：
   * 系统信息页据此报警，启动时也据此打一条警告（见 main.ts）。判据只能有一处，
   * 所以由这里算好，别处不许再拿默认值字符串比一次。
   */
  jwtSecretIsDefault: boolean;
  /** JWT 有效期 */
  jwtExpiresIn: string;
  /** 管理端注册码（空串 = 未配置；配了就必须带对码才能注册） */
  adminRegisterCode: string;
  /**
   * 是否允许**玩家**自助注册
   *
   * 默认开（单机 / 内测都靠它开号）。正式服往往要关掉（配合客户端隐藏注册入口），
   * 关掉后只有已注册账号能登录 —— 这是防批量刷号的第一道闸。
   */
  playerRegisterOpen: boolean;
  /**
   * 是否开放**管理端**自助注册（**只在未配置 `ADMIN_REGISTER_CODE` 时生效**）
   *
   * 默认**关**。原来的行为是「没配注册码 = 人人可注册」，而**第一个注册的管理员自动是超级管理员**
   * —— 一个忘记配注册码的公网部署，等于把后台拱手让人。所以默认值反过来：
   * 没配注册码就谁也不许注册，要用 `.env` 里显式打开（或干脆配一个注册码）。
   */
  adminRegisterOpen: boolean;
  /** 允许的跨域来源（["*"] = 全部） */
  corsOrigins: string[];
  /** 是否打印详细日志 */
  logRequests: boolean;
  /**
   * 是否信任反向代理传来的客户端 IP（`X-Forwarded-For`）
   *
   * 生产环境挂在 Nginx / 网关后面时必须开（否则所有请求的来源 IP 都是代理的，
   * 登录限流会把全部玩家当成同一个人，一起锁死）；**直连暴露时不要开** ——
   * 开着等于允许调用方随便伪造 `X-Forwarded-For` 绕过 IP 限流。
   */
  trustProxy: boolean;
  /** 登录限流：同一用户名连续失败多少次锁定 */
  loginMaxFailures: number;
  /** 登录限流：用户名维度的锁定时长（毫秒） */
  loginLockMs: number;
  /** 登录限流：同一 IP 在窗口内失败多少次锁定 */
  loginIpMaxFailures: number;
  /** 登录限流：IP 维度的锁定时长（毫秒） */
  loginIpLockMs: number;
  /** 操作日志保留条数上限（超出后按时间清理最旧的；0 = 不清理） */
  auditLogMaxRows: number;
  /**
   * 操作日志保留天数（早于该天数的日志会被清理；0 = 不按时间清理）
   *
   * 与 `auditLogMaxRows` 是**两道各自独立**的闸：条数上限防「刷爆磁盘」，
   * 天数上限防「量不大但陈年堆积」（一个月只写几百条同样会越攒越多）。
   */
  auditRetentionDays: number;
  /** 一次最多导出多少条操作日志（防止一次「全部条件」导出把几万行塞进内存与响应体） */
  auditExportMaxRows: number;

  //#region 邮件通道
  /** SMTP 主机（空 = 未配置） */
  smtpHost: string;
  /** SMTP 端口 */
  smtpPort: number;
  /** 是否走 TLS（465 是隐式 TLS，587 是 STARTTLS） */
  smtpSecure: boolean;
  /** SMTP 账号 */
  smtpUser: string;
  /** SMTP 密码 / 授权码（**只在配置快照里以「已配置 / 未配置」形态出现**，从不回显原文） */
  smtpPass: string;
  /** 发件人地址（不配则回退到 SMTP 账号） */
  smtpFrom: string;
  /**
   * 邮件通道是否可用（**派生字段**：主机 / 账号 / 密码三者都非空才算配齐）
   *
   * 与「令牌是否仍是默认值」同理 —— 让「能不能发信」这件事**可被检查**且只有一处判据，
   * 别处不许再自己比一次空串。未启用时发信接口直接返回 50003，而不是静默吞掉邮件。
   */
  mailEnabled: boolean;
  /**
   * 发信器实现（**测试注入点**）
   *
   * - `smtp`（默认）：真发信
   * - `fake`：不发信，一律成功 —— e2e 用它验「队列流转到已发送」
   * - `fail`：不发信，一律失败 —— e2e 用它验「重试与用尽上限后标失败」
   *
   * 之所以做成配置而不是在代码里 new：e2e 是**独立进程**起服务，拿不到进程内的对象，
   * 只能靠环境变量把「外部边界」换成可替换实现（与客户端 net-sandbox 同一思路）。
   */
  mailTransport: string;
  /** 单封邮件的最大投递尝试次数（用尽后标为最终失败） */
  mailMaxAttempts: number;
  /** 重试退避基数（毫秒）：第 n 次失败后等待 `base * 2^(n-1)` */
  mailRetryBaseMs: number;
  /** 调度器扫描间隔（毫秒） */
  mailPollMs: number;
  /** 投递记录的保留天数（早于该天数的**终态**记录会被清理；0 = 不按时间清理） */
  mailRetentionDays: number;
  /**
   * 终态投递记录的保留条数上限（超出后清理最旧的；0 = 不清理）
   *
   * 与 `mailRetentionDays` 是**两道各自独立**的闸（与操作日志同一口径）：
   * 条数上限防刷爆磁盘，天数上限防「量不大但陈年堆积」。
   */
  mailQueueMaxRows: number;

  //#region 自动备份
  /**
   * 自动备份间隔（**小时**）；`0` = 关闭自动备份
   *
   * 单位用小时而不是毫秒，是因为备份是「每天一次」这种量级的调度，写成
   * `86400000` 一串零极易手滑少一位 —— 少一位就是每小时备一份。
   */
  backupIntervalHours: number;
  /**
   * 备份保留份数（超出后清最旧的；`0` = 不按份数清理）
   *
   * 淘汰**只在本次备份成功产出之后**才可能发生，且至少留下最新那一份：
   * 一份备份都没守住，比不清理更糟。
   */
  backupKeepCount: number;
  /**
   * 备份保留天数（早于该天数的会被清理；`0` = 不按时间清理）
   *
   * 与 `backupKeepCount` 又是两道独立的闸：份数防刷爆磁盘，天数防「备份一直在失败、
   * 目录里躺着一份三个月前的老备份却被当成最新成果」。
   */
  backupRetentionDays: number;
  /** 备份目录（空 = 跟数据文件同级；容器里必须与数据同卷，否则重建即丢） */
  backupDir: string;
  //#endregion

  //#region 实时通道（WebSocket）
  /**
   * 实时连接票据的有效期（毫秒）
   *
   * 票据只活在「取票据 → 握手」这两步之间，**默认 30 秒**：长到足够走完一次往返，
   * 短到即使被反向代理的访问日志记下来也已经没有价值。这也是不把访问令牌塞 URL 的理由
   * —— 令牌能用 7 天，票据只能用 30 秒且**用过即焚**。
   */
  realtimeTicketTtlMs: number;
  /**
   * 实时连接的存活探测间隔（毫秒）
   *
   * 服务端每这么久 ping 一次，上一轮没还 pong 的连接直接被断开 —— 没有它，
   * 拔网线断掉的连接会一直挂在内存里（socket 层不会自己发现对端已经没了）。
   * 应用层的 `ping`/`pong` 是另一回事：那是给客户端量往返用的（浏览器看不到协议层 ping 帧）。
   */
  realtimeHeartbeatMs: number;
  /**
   * 实时通道是否内嵌在主进程（默认 true）
   *
   * `false` = 独立进程形态：主进程**不装载**实时模块（WS 通道与取票接口都不在），
   * 由 `main.realtime.ts` 单独起一个实时进程。拆进程是 #37 的部署形态：
   * 本地开发与全部既有 e2e 走默认内嵌，行为零变化。
   */
  realtimeEmbedded: boolean;
  /** 实时进程的监听端口（只有独立进程形态会用到；nginx 把 `/api/realtime*` 反代到它） */
  realtimePort: number;
  /**
   * 踢下线巡检间隔（毫秒；`0` = 关闭巡检）
   *
   * 管理端踢下线只写库（清 `online_role_id`），实时进程**轮询库标记**发现
   * 「连接对应的账号已经没有在线角色」后主动断开（4000）。跨进程没有推送通道
   * （SQLite 不做通知），轮询是这个形态下最朴素可靠的做法；默认 3 秒，
   * 意味着踢下线最迟 3 秒 + 一个心跳内生效。
   */
  realtimeKickPollMs: number;
  /**
   * 在线心跳的宽限期（毫秒，#547；`0` = 关闭清算）
   *
   * 「角色在线」以 `accounts.online_role_id` 为准，但玩家崩溃 / 断网后没人清这个标记
   * （断线不立刻清是刻意的：短暂掉线重连不该被拒存档）。所以实时进程给活连接的标记
   * **续心跳**（存活探测每拍一次），超过这个宽限期没有续约的标记被清算判为下线 ——
   * 心跳不在，就是不在了。
   *
   * 取值下限是**两个存活探测周期**：活连接最迟每拍续约一次，比这更短的宽限期会把
   * 一次网络抖动误判成下线。默认 90 秒 = 3 个默认心跳，够覆盖「掉线 → 重连 → 重选角」
   * 整个往返。清算只动库标记，残留连接由踢下线巡检（`realtimeKickPollMs`）收尾。
   */
  realtimeOnlineStaleMs: number;
  /**
   * 角色权威快照（roleUpdate 帧）的轮询间隔（毫秒；`0` = 关闭推送）
   *
   * 角色属性 / 战斗力 / 货币的写点分散在两个进程（存档进程的任务 / 邮件 / 商城 / 后台，
   * 实时进程的升级 / 拾取），进程内事件总线跨不过进程边界 —— 与踢下线感知同一难题、
   * 同一答案：实时进程轮询在线角色的行，`revision / updated_at` 变了才推。
   * 默认 1 秒：属性面板与货币栏的「实时」以这个粒度为准。
   */
  realtimeRoleSyncMs: number;
  //#endregion

  //#region 聊天（#395）
  /**
   * 单条聊天消息的最大长度（字符）
   *
   * 服务端为准——客户端的校验只是省一次往返。净化（trim + 折叠空白）之后才量长度，
   * 所以纯空白的消息活不过「不能为空」那一关，用不着为它再立一条规则。
   */
  chatMaxLength: number;
  /** 限频窗口内的最大发言条数（滑窗；超限回 error 帧，不做静默丢弃——玩家得知道为什么没发出去） */
  chatRateLimit: number;
  /** 限频窗口宽度（毫秒；下限 1000，防把窗口配成 0 等于关掉限频） */
  chatRateWindowMs: number;
  //#endregion

  //#region 世界权威（#35）
  /**
   * 世界 tick 的间隔（毫秒）
   *
   * tick 只做两件事：检查「该重生的怪」（粒度到秒级足够 —— 重生本来就是几十秒的事），
   * 以及按持久化节流把脏实例写回 SQLite。**不做怪物移动**：游走 / 追击仍是客户端的
   * 表现层（坐标不回传），服务端持有的「坐标」是出生点 —— 那是世界里唯一稳定的真相。
   */
  worldTickMs: number;
  /**
   * 世界状态的落盘节流间隔（毫秒）
   *
   * 受击 / 死亡 / 重生只把实例标脏，真正的写库由 tick 按这个间隔批量做 ——
   * 否则一次出手就是一次 SQLite 写，跟玩家存档的 1.5 秒防抖推送叠在一起，写放大明显。
   * 优雅关闭时会**全量 flush**，这个间隔只影响「进程被硬杀时最多丢多少秒的世界状态」。
   */
  worldPersistMs: number;
  /**
   * 怪物死亡后到重生的时间（毫秒）
   *
   * 目前是全服统一值（configs/monster 没有重生字段，区域配置也只在客户端的地图文件里）；
   * 等区域配置进了共享快照，再改成按怪配置。
   */
  worldRespawnMs: number;
  /**
   * 地图实例的空闲回收时间（毫秒）；`0` = 不回收
   *
   * 一张图没有任何账号在看、且持续空闲这么久，就把它的实例从内存卸载（状态已在库里），
   * 下次有人进图再加载 —— 防止「玩家进过的图」在内存里无限累积。卸载期间不跑重生，
   * 重新加载时会按当前时刻一次性补上到期未处理的重生。
   */
  worldMapIdleMs: number;
  //#endregion

  //#region 怪物 AI（#323：目标 / 移动 / 普攻权威在服务端）
  /** AI tick 间隔（毫秒）：移动积分与普攻判定的节拍，粒度到百毫秒级（移动观感） */
  monsterAiTickMs: number;
  /** AI 广播节流（毫秒）：monster-ai 帧只按这个节奏发（位置增量 + 命中事件） */
  monsterAiBroadcastMs: number;
  /** 位置上报的过期时间（毫秒）：超时没上报的玩家视作离场，怪物丢失目标 */
  monsterAiPosStaleMs: number;
  //#endregion

  //#region 玩家互见（#324：同图玩家位置 / 血量 / 移动标记互见）
  /** 互见广播节流（毫秒）：players 帧只按这个节奏发（位置增量 + 离开事件） */
  playerSyncBroadcastMs: number;
  /**
   * 外观懒刷新间隔（毫秒，#383）：在场表按这个节奏重读在线角色，
   * 让「别人换了衣服」最多迟这么久被看到（换装走 HTTP 存档，实时进程不会被告知）
   */
  playerAppearanceRefreshMs: number;
  //#endregion

  //#region 社交（#388：帮会 / #389：好友与敌人）
  /**
   * 帮会人数上限（默认 50）
   *
   * 与帮会等级解耦：等级这一刀没有业务，别让它悄悄决定真实容量（见 common/constants/social）。
   */
  guildMemberLimit: number;
  /**
   * 好友数量上限（默认 100，#389）
   *
   * 与帮会上限同一口径：进配置而不是写死在业务里 —— e2e 把它压小才验得到「满了会拒」，
   * 而生产环境按需调整时不必改代码。
   */
  socialFriendLimit: number;

  /**
   * 黑名单上限（默认 100，#398）
   *
   * 拉黑只影响自己，设上限是为了防刷表（脚本给全服每人写一行）。
   */
  socialBlockLimit: number;

  /**
   * 屏蔽过滤缓存的刷新间隔（毫秒，默认 2000，#398）
   *
   * 实时进程把 `role_blocks` 整表缓存在内存里（聊天投递与互见帧都要按它过滤，
   * 200ms 的互见节拍上没法逐次查库）。这个值决定「拉黑多久生效」：
   * 被拉黑的人在他视野里最多还会出现这么久。
   */
  socialBlockCacheMs: number;
  //#endregion

  //#region 队伍（#399）

  /**
   * 队伍人数上限（默认 4，可用 `PARTY_MEMBER_LIMIT` 覆盖）
   *
   * 脏值（非数字 / 小于 2）回落默认：上限读错不该让「组队」变成「一个人也算满」。
   */
  partyMemberLimit: number;

  /**
   * 邀请有效期（毫秒，默认 30000，#399）
   *
   * 邀请本身存内存（不落库），过期即作废：三十秒没回应，邀请人大概率已经自己打了。
   */
  partyInviteTtlMs: number;

  /**
   * 队友经验分成比例（默认 0.5，#399）
   *
   * 队友拿「按他自己的等级差算出的击杀经验」的这个比例（向下取整）。0 = 只组队不分经验。
   */
  partyExpMateShare: number;

  /**
   * 组队的最低等级（默认 10，`PARTY_MIN_LEVEL`）
   *
   * 与客户端底部导航「组队」入口的 `openLevel` 必须相等（`tools/audit-party-level.cjs`
   * 盯着）：入口按等级锁着，服务端却放行邀请的话，被邀请的低级号连面板都打不开。
   * 脏值（非数字 / 小于 1）回落默认 —— 门槛读错不该让「所有人都不能组队」。
   */
  partyMinLevel: number;
  //#endregion

  //#region 排行榜（#400）

  /**
   * 榜单重算周期（毫秒，默认 60000，`LEADERBOARD_REFRESH_MS`）
   *
   * 榜单是**物化**的（一次重算读全表 + 算战力 + 三个排序），不是每次请求现算。
   * 一分钟是「玩家能接受的名次延迟」与「重算成本」之间的折中：升一级之后最多等一分钟
   * 才看到自己往上挪。压到 0 表示**不启用定时器**（只在首次请求时算一次）——
   * e2e 用它验「快照语义」。
   */
  leaderboardRefreshMs: number;

  /**
   * 物化保留的条数（默认 100，`LEADERBOARD_TOP_N`）
   *
   * 既是「榜有多长」，也是分页 `size` 的实际上限：留 100 条意味着玩家最多翻到第 100 名。
   * 要做到「全服都看得到自己」靠的是 `me` 接口（名次在全量排序里取），不是把 topN 拉大。
   */
  leaderboardTopN: number;
  //#endregion
}

export default function configuration(): AppConfiguration {
  const jwtSecret = process.env.JWT_SECRET ?? DEFAULT_JWT_SECRET;
  const adminRegisterCode = process.env.ADMIN_REGISTER_CODE ?? "";
  return {
    env: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 3100),
    apiPrefix: process.env.API_PREFIX ?? "api",
    dbPath: process.env.DB_PATH ?? join(process.cwd(), "data", "olua.db"),
    jwtSecret,
    jwtSecretIsDefault: jwtSecret === DEFAULT_JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
    adminRegisterCode,
    playerRegisterOpen: (process.env.PLAYER_REGISTER_OPEN ?? "true") === "true",
    adminRegisterOpen: (process.env.ADMIN_REGISTER_OPEN ?? "false") === "true",

    corsOrigins: (process.env.CORS_ORIGINS ?? "*")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    logRequests: (process.env.LOG_REQUESTS ?? "true") === "true",
    trustProxy: (process.env.TRUST_PROXY ?? "false") === "true",
    loginMaxFailures: Number(process.env.LOGIN_MAX_FAILURES ?? 5),
    loginLockMs: Number(process.env.LOGIN_LOCK_MS ?? 10 * 60 * 1000),
    loginIpMaxFailures: Number(process.env.LOGIN_IP_MAX_FAILURES ?? 20),
    loginIpLockMs: Number(process.env.LOGIN_IP_LOCK_MS ?? 10 * 60 * 1000),
    auditLogMaxRows: Number(process.env.AUDIT_LOG_MAX_ROWS ?? 20000),
    auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS ?? 90),
    auditExportMaxRows: Number(process.env.AUDIT_EXPORT_MAX_ROWS ?? 5000),
    smtpHost: process.env.SMTP_HOST ?? "",
    smtpPort: Number(process.env.SMTP_PORT ?? 465),
    smtpSecure: (process.env.SMTP_SECURE ?? "true") === "true",
    smtpUser: process.env.SMTP_USER ?? "",
    smtpPass: process.env.SMTP_PASS ?? "",
    smtpFrom: process.env.SMTP_FROM ?? "",
    mailEnabled: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
    mailTransport: process.env.MAIL_TRANSPORT ?? "smtp",
    mailMaxAttempts: Number(process.env.MAIL_MAX_ATTEMPTS ?? 5),
    mailRetryBaseMs: Number(process.env.MAIL_RETRY_BASE_MS ?? 60 * 1000),
    mailPollMs: Number(process.env.MAIL_POLL_MS ?? 15 * 1000),
    mailRetentionDays: Number(process.env.MAIL_RETENTION_DAYS ?? 90),
    mailQueueMaxRows: Number(process.env.MAIL_QUEUE_MAX_ROWS ?? 20000),
    backupIntervalHours: Number(process.env.BACKUP_INTERVAL_HOURS ?? 24),
    backupKeepCount: Number(process.env.BACKUP_KEEP_COUNT ?? 7),
    backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 30),
    backupDir: process.env.BACKUP_DIR ?? "",
    realtimeTicketTtlMs: Number(process.env.REALTIME_TICKET_TTL_MS ?? 30 * 1000),
    realtimeHeartbeatMs: Number(process.env.REALTIME_HEARTBEAT_MS ?? 30 * 1000),
    realtimeEmbedded: process.env.REALTIME_EMBEDDED !== "false",
    realtimePort: Number(process.env.REALTIME_PORT ?? 3101),
    realtimeKickPollMs: Number(process.env.REALTIME_KICK_POLL_MS ?? 3 * 1000),
    realtimeOnlineStaleMs: Number(process.env.REALTIME_ONLINE_STALE_MS ?? 90 * 1000),
    realtimeRoleSyncMs: Number(process.env.REALTIME_ROLE_SYNC_MS ?? 1 * 1000),
    chatMaxLength: Number(process.env.CHAT_MAX_LENGTH ?? 120),
    chatRateLimit: Number(process.env.CHAT_RATE_LIMIT ?? 5),
    chatRateWindowMs: Number(process.env.CHAT_RATE_WINDOW_MS ?? 10 * 1000),
    worldTickMs: Number(process.env.WORLD_TICK_MS ?? 1000),
    worldPersistMs: Number(process.env.WORLD_PERSIST_MS ?? 5000),
    worldRespawnMs: Number(process.env.WORLD_RESPAWN_MS ?? 30 * 1000),
    worldMapIdleMs: Number(process.env.WORLD_MAP_IDLE_MS ?? 10 * 60 * 1000),
    monsterAiTickMs: Number(process.env.MONSTER_AI_TICK_MS ?? 100),
    monsterAiBroadcastMs: Number(process.env.MONSTER_AI_BROADCAST_MS ?? 200),
    monsterAiPosStaleMs: Number(process.env.MONSTER_AI_POS_STALE_MS ?? 3000),
    playerSyncBroadcastMs: Number(process.env.PLAYER_SYNC_BROADCAST_MS ?? 200),
    playerAppearanceRefreshMs: Number(process.env.PLAYER_APPEARANCE_REFRESH_MS ?? 5000),
    guildMemberLimit: Number(process.env.GUILD_MEMBER_LIMIT ?? 50),
    socialFriendLimit: Number(process.env.SOCIAL_FRIEND_LIMIT ?? 100),
    socialBlockLimit: Number(process.env.SOCIAL_BLOCK_LIMIT ?? 100),
    socialBlockCacheMs: Number(process.env.SOCIAL_BLOCK_CACHE_MS ?? 2000),
    partyMemberLimit: Number(process.env.PARTY_MEMBER_LIMIT ?? 4),
    partyInviteTtlMs: Number(process.env.PARTY_INVITE_TTL_MS ?? 30000),
    partyExpMateShare: Number(process.env.PARTY_EXP_MATE_SHARE ?? 0.5),
    partyMinLevel: Number(process.env.PARTY_MIN_LEVEL ?? PARTY_MIN_LEVEL_DEFAULT),
    leaderboardRefreshMs: Number(process.env.LEADERBOARD_REFRESH_MS ?? 60000),
    leaderboardTopN: Number(process.env.LEADERBOARD_TOP_N ?? 100),
  };
}
