import { join } from "node:path";
import { ROLE_MAX_PER_ACCOUNT_DEFAULT } from "../common/constants/role";
import { PARTY_EXP_SHARE_DISTANCE_DEFAULT, PARTY_MIN_LEVEL_DEFAULT } from "../common/constants/social";

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
  /**
   * 监听地址（空串 = 交给 Node 决定，即所有网卡）
   *
   * 局域网真机调试必须听所有网卡，手机才连得上；手机上能登录、一进图就掉线
   * 通常是**实时进程**还只听回环（见 main.realtime.ts）。要收紧成只本机时设
   * `SERVER_HOST=127.0.0.1`。默认空而不是写死一个地址，是因为代码里不允许出现
   * 回环 / 通配地址字面量（tools/audit-api-hardcode.cjs 盯着）。
   */
  host: string;
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
  /** 模块日志目录（相对当前工作目录） */
  logDir: string;
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

  //#region 玩家行为流水（#886）
  /**
   * 行为流水保留条数上限（超出清最旧；0 = 不按条数清理）
   *
   * 比 `auditLogMaxRows`（2 万）大一个量级：一次群攻就是 8 条击杀、一次批量回收是 N 条消耗，
   * 这张表的写入量是审计表的几十倍。10 万行约 20MB，仍属「一个 SQLite 文件能随手备份」的范围。
   */
  eventLogMaxRows: number;
  /** 行为流水保留天数（早于该天数的记录会被清理；0 = 不按时间清理） */
  eventLogRetentionDays: number;
  //#endregion

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
  /**
   * 收件箱过期清理的批大小（#439）：一次最多删这么多行
   *
   * 与 `mailRetentionDays`（外发投递记录的保留期）**是两件事**：那个管 SMTP 队列的历史，
   * 这个管玩家游戏内收件箱的保质期回收。
   */
  mailPurgeBatch: number;
  /** 收件箱过期清理的扫描间隔（毫秒；≤ 0 = 不启动清理任务） */
  mailPurgeIntervalMs: number;
  /**
   * 过期前自动入包的扫描间隔（毫秒；≤ 0 = 不启动，#867）
   *
   * 默认 1 小时：提前量是「3 天」，扫得再勤也没有额外收益；扫太勤只会反复打同一批
   * 背包满的行（失败也要记 `auto_attempts`，扫勤了等于把 5 次机会几分钟用光）。
   */
  mailAutoClaimIntervalMs: number;
  /** 过期前多久开始自动入包（毫秒，默认 3 天）：`expires_at - 这个数 <= now` 就排上（#867） */
  mailAutoClaimLeadMs: number;
  /** 自动入包的批大小（#867）：一轮最多处理这么多行 */
  mailAutoClaimBatch: number;
  /** 自动入包失败重试上限（#867）：到这次数就停手，邮件留着等人工，**不删** */
  mailAutoClaimMaxAttempts: number;
  /**
   * 收件箱默认保质期（毫秒，#867）
   *
   * 投递方不显式给 TTL 时用它（30 天）。**人工补发走 0 = 永久**：运营发的补偿不该过期。
   */
  mailDefaultTtlMs: number;

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
   * 区状态巡检间隔（毫秒，#961）
   *
   * 实时进程按它轮询 `zones`：某个区转 `maintenance` → 广播 `zoneMaintenance` 倒计时，
   * 到点断开该区连接；某个区被合并 → 发 `zoneMerged` 立即断开。跨进程（管理端在 3100
   * 改状态、连接在 3101）没有推送通道，轮询是唯一办法；区数个位数，读全表可忽略。
   */
  zoneStatusPollMs: number;
  /**
   * 维护倒计时多久后强制断线（毫秒，#961；`0` = 立刻断）
   *
   * 出厂 60 秒：正在打怪的人需要时间收手（打完这一只、把东西捡了）。断得太干脆，
   * 玩家会认为「掉线了」而不是「服在维护」。
   */
  zoneMaintenanceKickMs: number;
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
  /**
   * 实时进程定期重装运营配置的间隔（毫秒；`0` = 关闭定期重装）
   *
   * 运营配置（装备变体 / 称号 / 战斗力权重……）的写点在存档进程：管理端每次写操作后
   * 由 `RuntimeConfigService.refreshAll()` 重装 —— 但那是**进程内**的缓存，跨进程传不过去。
   * 实时进程不定期重装的话，管理端改完配置它仍按启动时的旧值现算属性与战斗力：
   * roleUpdate 帧与操作应答各执一份值，客户端战斗力显示在两个数之间来回翻（先降后升的「抖动」）。
   * 默认 10 秒：配置改动最迟一个间隔后在实时侧生效（表都很小，全量重装很轻）。
   */
  realtimeConfigRefreshMs: number;
  realtimeStatsIntervalMs: number;
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

  //#region 实时地图监控（#665：把内存里的世界投影成管理端可读的两张表）
  /**
   * 采样间隔（毫秒）
   *
   * 监控页的刷新节奏就是它：1 秒一帧够看清「哪儿有怪、谁死了」，再快只是给 SQLite
   * 加写放大；再慢（> 3 秒）图上就要靠猜了。
   */
  mapMonitorMs: number;
  /**
   * 每区每图保留多少条文字事件（击杀 / 刷新 / 伤害 / 追击 / 技能 / 命中）
   *
   * #745 起日志细到「每一下伤害一行」，条数消耗比原来快一个数量级：300 条在激烈战斗里
   * 只够十几秒。2000 条 ≈ 几分钟的可追溯窗口，单行几百字节，几十张图也就几 MB。
   * 再往前的事该去看运维日志，不是监控页。
   */
  mapMonitorEventKeep: number;
  /** 攒够多少条新事件才裁一次旧记录（每杀一只都 DELETE 会让 WAL 白涨；细粒度日志同理） */
  mapMonitorTrimEvery: number;
  /**
   * 文字事件的**时间**保留期（天；#887）
   *
   * 条数上限（`mapMonitorEventKeep`）只在**写入时**触发裁剪，它管不住一种情况：某张图
   * 从此没人进，那 2000 条就永远躺在库里 —— 没有人在写，也就没有人去裁。所以再加一道
   * 时间闸，按 `at` 删除，与图有没有人看无关。
   *
   * 两道闸**取先到**：条数闸保活跃图不无限长，时间闸保死图不会永远占着库。
   */
  mapMonitorRetentionDays: number;
  /**
   * 时间闸多久扫一次（毫秒；默认 6 小时）
   *
   * 独立定时器，不挂在采样上：采样循环只遍历「有人看的图」，全服没人时一次都不进循环，
   * 挂在它里面就等于「没人玩时永远不清」。
   */
  mapMonitorPruneMs: number;
  //#endregion

  //#region 社交（#388：帮会 / #389：好友与敌人）
  /**
   * 帮会人数上限（默认 50）
   *
   * 与帮会等级解耦：等级这一刀没有业务，别让它悄悄决定真实容量（见 common/constants/social）。
   */
  guildMemberLimit: number;

  /**
   * 每帮待处理申请上限（默认 50，#873）
   *
   * 申请无上限时一人可向全服帮会各写一条，帮主面板被刷满。脏值回落默认。
   */
  guildApplicationLimitPerGuild: number;

  /**
   * 每角色同时挂着的申请数上限（默认 5，#873）
   *
   * 广撒网有限度。脏值回落默认。
   */
  guildApplicationLimitPerRole: number;

  /**
   * 入帮申请有效期（毫秒，默认 24h，#873）
   *
   * 过期走懒清理（申请 / 审批 / 看名单时顺手删），不挂定时器。
   */
  guildApplicationTtlMs: number;
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

  /** 队友分成的距离阈值（px，默认 800，#877）：距击杀点超过它的队友不分 */
  partyExpShareDistance: number;

  /**
   * 队长离线接管阈值（毫秒，默认 300000 = 5 分钟，#875）
   *
   * 队长离线满这个时长，自动把队长转给最早加入的成员；全队都离线满这个时长则解散。
   * 脏值（非数字 / ≤0）回落默认：读错不该让「掉线接管」静默失效。
   */
  partyLeaderOfflineMs: number;

  /**
   * 离线接管扫描周期（毫秒，默认 30000，#875）
   *
   * 只影响接管 / 解散晚到多久；e2e 压到几百毫秒。
   */
  partySweepIntervalMs: number;

  /**
   * 组队的最低等级（默认 10，`PARTY_MIN_LEVEL`）
   *
   * 与客户端底部导航「组队」入口的 `openLevel` 必须相等（`tools/audit-party-level.cjs`
   * 盯着）：入口按等级锁着，服务端却放行邀请的话，被邀请的低级号连面板都打不开。
   * 脏值（非数字 / 小于 1）回落默认 —— 门槛读错不该让「所有人都不能组队」。
   */
  partyMinLevel: number;
  //#endregion

  //#region 角色
  /**
   * 一个账号最多几个角色（默认 6，`ROLE_MAX_PER_ACCOUNT`，#878 / I3）
   *
   * 以前这里没有这条闸：建号只校验结构与重名，脚本可以给一个账号刷出上万行角色。
   * 脏值（非数字 / 小于 1）回落默认 —— 读错不该让「建号」变成「一个也建不了」。
   */
  roleMaxPerAccount: number;
  //#endregion

  //#region 配置版本链（#881 / #882）

  /**
   * 回滚历史保留层数（默认 20，`CONFIG_REVISION_RETAIN`）
   *
   * payload 是**全量配置 JSON**（38 张表），每层约几 MB —— 20 层 ≤ 100MB 是可接受的代价，
   * 换来的是「一键回到 10 分钟前」不需要按 diff 顺序重放。
   */
  configRevisionRetain: number;

  /**
   * 同一操作人的连点合并窗口（毫秒，默认 10000，`CONFIG_REVISION_THROTTLE_MS`）
   *
   * 管理端「保存」按钮连点 8 次不该吃掉 8 层历史：窗口内同一人的多次写**合并成一层**
   * （保留最新内容、沿用最新版本号）。跨人的改动从不合并 —— 合并会丢掉一方的 diff 归属。
   * 压到 0 = 每次写都单独成层（e2e 用它验「一层一次改动」）。
   */
  configRevisionThrottleMs: number;
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
    // 不填 = 空串 = 交给 Node 听所有网卡（局域网真机调试要的就是这个）
    host: process.env.SERVER_HOST ?? "",
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
    logDir: process.env.LOG_DIR ?? join(process.cwd(), "logs"),
    trustProxy: (process.env.TRUST_PROXY ?? "false") === "true",
    loginMaxFailures: Number(process.env.LOGIN_MAX_FAILURES ?? 5),
    loginLockMs: Number(process.env.LOGIN_LOCK_MS ?? 10 * 60 * 1000),
    loginIpMaxFailures: Number(process.env.LOGIN_IP_MAX_FAILURES ?? 20),
    loginIpLockMs: Number(process.env.LOGIN_IP_LOCK_MS ?? 10 * 60 * 1000),
    auditLogMaxRows: Number(process.env.AUDIT_LOG_MAX_ROWS ?? 20000),
    auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS ?? 90),
    auditExportMaxRows: Number(process.env.AUDIT_EXPORT_MAX_ROWS ?? 5000),
    eventLogMaxRows: Number(process.env.EVENT_LOG_MAX_ROWS ?? 100000),
    eventLogRetentionDays: Number(process.env.EVENT_LOG_RETENTION_DAYS ?? 30),
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
    mailPurgeBatch: Number(process.env.MAIL_PURGE_BATCH ?? 500),
    mailPurgeIntervalMs: Number(process.env.MAIL_PURGE_INTERVAL_MS ?? 60 * 1000),
    mailAutoClaimIntervalMs: Number(process.env.MAIL_AUTO_CLAIM_INTERVAL_MS ?? 60 * 60 * 1000),
    mailAutoClaimLeadMs: Number(process.env.MAIL_AUTO_CLAIM_LEAD_MS ?? 3 * 24 * 60 * 60 * 1000),
    mailAutoClaimBatch: Number(process.env.MAIL_AUTO_CLAIM_BATCH ?? 200),
    mailAutoClaimMaxAttempts: Number(process.env.MAIL_AUTO_CLAIM_MAX_ATTEMPTS ?? 5),
    mailDefaultTtlMs: Number(process.env.MAIL_DEFAULT_TTL_MS ?? 30 * 24 * 60 * 60 * 1000),
    backupIntervalHours: Number(process.env.BACKUP_INTERVAL_HOURS ?? 24),
    backupKeepCount: Number(process.env.BACKUP_KEEP_COUNT ?? 7),
    backupRetentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? 30),
    backupDir: process.env.BACKUP_DIR ?? "",
    realtimeTicketTtlMs: Number(process.env.REALTIME_TICKET_TTL_MS ?? 30 * 1000),
    realtimeHeartbeatMs: Number(process.env.REALTIME_HEARTBEAT_MS ?? 30 * 1000),
    realtimeEmbedded: process.env.REALTIME_EMBEDDED !== "false",
    realtimePort: Number(process.env.REALTIME_PORT ?? 3101),
    realtimeKickPollMs: Number(process.env.REALTIME_KICK_POLL_MS ?? 3 * 1000),
    /**
     * 区状态巡检间隔（毫秒，#961）
     *
     * 实时进程按它轮询 `zones`：发现某个区转 `maintenance` 就广播倒计时，
     * 发现某个区被合并就发 `zoneMerged` 并断线。区数个位数，读全表的代价可以忽略；
     * e2e 把它调到 200ms，让「切维护 → 收到帧」不用等 5 秒。
     */
    zoneStatusPollMs: Number(process.env.ZONE_STATUS_POLL_MS ?? 5 * 1000),
    /**
     * 维护倒计时多久后强制断线（毫秒，#961）
     *
     * 出厂 60 秒：正在打怪的人需要时间收手（打完这一只、把东西捡了）。断得太干脆，
     * 玩家会以为「掉线了」而不是「服在维护」。设 0 = 立刻断（e2e 用）。
     */
    zoneMaintenanceKickMs: Number(process.env.ZONE_MAINTENANCE_KICK_MS ?? 60 * 1000),
    realtimeOnlineStaleMs: Number(process.env.REALTIME_ONLINE_STALE_MS ?? 90 * 1000),
    realtimeRoleSyncMs: Number(process.env.REALTIME_ROLE_SYNC_MS ?? 1 * 1000),
    realtimeConfigRefreshMs: Number(process.env.REALTIME_CONFIG_REFRESH_MS ?? 10 * 1000),
    realtimeStatsIntervalMs: Number(process.env.REALTIME_STATS_INTERVAL_MS ?? 10 * 1000),
    chatMaxLength: Number(process.env.CHAT_MAX_LENGTH ?? 120),
    chatRateLimit: Number(process.env.CHAT_RATE_LIMIT ?? 5),
    chatRateWindowMs: Number(process.env.CHAT_RATE_WINDOW_MS ?? 10 * 1000),
    worldTickMs: Number(process.env.WORLD_TICK_MS ?? 1000),
    worldPersistMs: Number(process.env.WORLD_PERSIST_MS ?? 5000),
    worldRespawnMs: Number(process.env.WORLD_RESPAWN_MS ?? 30 * 1000),
    worldMapIdleMs: Number(process.env.WORLD_MAP_IDLE_MS ?? 10 * 60 * 1000),
    monsterAiTickMs: Number(process.env.MONSTER_AI_TICK_MS ?? 100),
    monsterAiBroadcastMs: Number(process.env.MONSTER_AI_BROADCAST_MS ?? 100),
    monsterAiPosStaleMs: Number(process.env.MONSTER_AI_POS_STALE_MS ?? 3000),
    playerSyncBroadcastMs: Number(process.env.PLAYER_SYNC_BROADCAST_MS ?? 100),
    playerAppearanceRefreshMs: Number(process.env.PLAYER_APPEARANCE_REFRESH_MS ?? 5000),
    mapMonitorMs: Number(process.env.MAP_MONITOR_MS ?? 1000),
    mapMonitorEventKeep: Number(process.env.MAP_MONITOR_EVENT_KEEP ?? 2000),
    mapMonitorTrimEvery: Number(process.env.MAP_MONITOR_TRIM_EVERY ?? 100),
    mapMonitorRetentionDays: Number(process.env.MAP_MONITOR_RETENTION_DAYS ?? 7),
    mapMonitorPruneMs: Number(process.env.MAP_MONITOR_PRUNE_MS ?? 6 * 60 * 60 * 1000),
    guildMemberLimit: Number(process.env.GUILD_MEMBER_LIMIT ?? 50),
    guildApplicationLimitPerGuild: Number(process.env.GUILD_APPLICATION_LIMIT_PER_GUILD ?? 50),
    guildApplicationLimitPerRole: Number(process.env.GUILD_APPLICATION_LIMIT_PER_ROLE ?? 5),
    guildApplicationTtlMs: Number(process.env.GUILD_APPLICATION_TTL_MS ?? 86400000),
    socialFriendLimit: Number(process.env.SOCIAL_FRIEND_LIMIT ?? 100),
    socialBlockLimit: Number(process.env.SOCIAL_BLOCK_LIMIT ?? 100),
    socialBlockCacheMs: Number(process.env.SOCIAL_BLOCK_CACHE_MS ?? 2000),
    partyMemberLimit: Number(process.env.PARTY_MEMBER_LIMIT ?? 4),
    partyInviteTtlMs: Number(process.env.PARTY_INVITE_TTL_MS ?? 30000),
    partyExpMateShare: Number(process.env.PARTY_EXP_MATE_SHARE ?? 0.5),
    partyExpShareDistance: Number(process.env.PARTY_EXP_SHARE_DISTANCE ?? PARTY_EXP_SHARE_DISTANCE_DEFAULT),
    partyLeaderOfflineMs: Number(process.env.PARTY_LEADER_OFFLINE_MS ?? 300000),
    partySweepIntervalMs: Number(process.env.PARTY_SWEEP_INTERVAL_MS ?? 30000),
    partyMinLevel: Number(process.env.PARTY_MIN_LEVEL ?? PARTY_MIN_LEVEL_DEFAULT),
    roleMaxPerAccount: Number(process.env.ROLE_MAX_PER_ACCOUNT ?? ROLE_MAX_PER_ACCOUNT_DEFAULT),
    // 配置版本链（#881 / #882）：回滚历史保留层数与「同一人连点合并」的节流窗
    configRevisionRetain: Number(process.env.CONFIG_REVISION_RETAIN ?? 20),
    configRevisionThrottleMs: Number(process.env.CONFIG_REVISION_THROTTLE_MS ?? 10 * 1000),
    leaderboardRefreshMs: Number(process.env.LEADERBOARD_REFRESH_MS ?? 60000),
    leaderboardTopN: Number(process.env.LEADERBOARD_TOP_N ?? 100),
  };
}
