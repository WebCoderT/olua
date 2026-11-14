import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AdminRole } from "../common/constants/permission";
import { AnnouncementLevel } from "../common/constants/announcement";
import { MONEY_ITEM_SEEDS } from "../common/constants/money-items";
import { LEVEL_SCROLL_SEEDS } from "../common/constants/level-scrolls";
import { ROLE_LEVEL_CURVE_SEEDS } from "../common/constants/role-level-curve";
import {
  COMBAT_SKILL_NUMBER_SEEDS,
  COMBAT_SKILL_STATUS_SEEDS,
  COMBAT_STATUS_SEEDS,
} from "../common/constants/combat-status-seed";
import { resetDayOf } from "../common/utils/daily-clock";
import { PUBLIC_SLOT, instanceIdOf } from "../common/utils/room-key.util";
import { bootstrapConfigSnapshot } from "./config-snapshot";

/** 可绑定的参数值（node:sqlite 支持的类型） */
export type SqlParam = string | number | bigint | null | Uint8Array;

/**
 * world_monsters.instanceId 的三种格式（#809 起只有 `m<map>_z<zone>_c<slot>_<n>`；
 * 前两种只在存量库里出现，由 `migrateWorldMonsterInstanceIds` 归一到最新一种）
 */
const WORLD_INSTANCE_ROOM_FORMAT = /^m(.+)_z(\d+)_[ci]\d+_\d+$/;
const WORLD_INSTANCE_NEW_FORMAT = /^m(.+)_z(\d+)_(\d+)$/;
const WORLD_INSTANCE_OLD_FORMAT = /^m(.+)_(\d+)$/;

/**
 * SQLite 连接（Node 22 内置 `node:sqlite`，**零原生依赖**）
 *
 * 只做「连接 + 建表 + 薄封装」，SQL 一律写在各 Repository 里（便于全文检索某张表的用法）。
 * 数据文件路径来自配置（DB_PATH），`:memory:` 表示内存库（e2e 测试用）。
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  private db!: DatabaseSync;
  /** 当前事务嵌套深度（见 `transaction`）：0 = 不在事务里，> 0 = 已在事务里，再调并入外层 */
  private txDepth = 0;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const path = this.config.get<string>("dbPath") ?? ":memory:";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL 提升并发读性能；外键打开后删账号会级联删角色
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    // busy_timeout（#35 起服务端有了常驻写）：写操作撞上锁时等一等再报错，而不是立刻抛
    // SQLITE_BUSY。世界状态的节流落盘与玩家存档防抖推送可能同时写，SQLite 单文件一锁全库，
    // 没有这个等待的话偶发的并发写就会变成玩家看到的报错。5 秒足够越过一次备份 checkpoint。
    if (path !== ":memory:") this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
    // 建表之后、任何 service 的 onModuleInit 之前：空库先灌出厂快照。
    // 之后所有配置读的都是库，代码里不再有第二份数值副本（#655）。
    const bootstrap = bootstrapConfigSnapshot(this.db, this.logger);
    if (bootstrap.status === "imported") this.logger.log("出厂数据自举完成（空库首启，只发生一次）");
    this.logger.log(`SQLite 就绪：${path}`);
  }

  /**
   * 优雅关闭：把 WAL 合并回主文件并关掉连接
   *
   * 不这么做的话，进程被 kill 时 `-wal` / `-shm` 会**留在磁盘上**（只有干净的 close 才会
   * checkpoint 并删掉它们）。它们本身不丢数据，但会让运维分不清「服务是不是还在跑」——
   * 备份/恢复脚本正是拿这个当信号用的，误报多了那个保护就等于没有。
   *
   * 依赖 `main.ts` 里的 `app.enableShutdownHooks()`（否则这个钩子根本不会被调用）。
   */
  onApplicationShutdown() {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.logger.log("已把 WAL 合并回主文件");
    } catch (error) {
      this.logger.warn(`WAL 合并失败（不影响已提交的数据）：${error instanceof Error ? error.message : String(error)}`);
    }
    this.db.close();
  }

  /** 建表（IF NOT EXISTS，可重复执行；新增字段时在此加 ALTER 并做存在性判断） */
  private migrate() {
    // 旧库升级前置（#350 / #809）：exec 块里有引用 zone_id（idx_world_monsters_zone）与
    // slot（idx_world_monsters_room）的索引，而这两列的 ALTER 原本排在 exec 之后——
    // 旧 schema 的库（无该列）会在建索引时直接炸 no such column，起不了服。
    // 这里赶在建索引前对「已存在的旧表」补列；新库没有这两张表，跳过，exec 后段的
    // ensureColumn 幂等兜底。
    if (this.count("SELECT COUNT(1) AS total FROM sqlite_master WHERE type = 'table' AND name = ?", ["accounts"]) > 0) {
      // #957：账号不再属于区 —— 这一列降级成「当前浏览区」，名字也跟着改，免得有人拿它当归属读。
      // 旧库就地改名（SQLite 3.25+ 的 RENAME COLUMN，值不丢），新库由下面的 ALTER 补。
      if (this.hasColumn("accounts", "zone_id") && !this.hasColumn("accounts", "active_zone_id")) {
        this.db.exec("ALTER TABLE accounts RENAME COLUMN zone_id TO active_zone_id");
        this.logger.log("accounts.zone_id → active_zone_id（降级为「当前浏览区」，角色归属见 roles.zone_id， #957）");
      }
      this.ensureColumn("accounts", "active_zone_id", "INTEGER NOT NULL DEFAULT 1");
    }
    // 角色带区（#957）：加列 + 按「账号当时的区」回填。只在**第一次**加列时回填 ——
    // 之后再跑会拿账号的当前浏览区覆盖角色的真实归属（合并区之后就错得更远）。
    if (this.hasTable("roles") && !this.hasColumn("roles", "zone_id")) {
      this.ensureColumn("roles", "zone_id", "INTEGER NOT NULL DEFAULT 1");
      // 注意列名是**改名之后**的 active_zone_id：上面那一步已经把 accounts.zone_id 就地改掉了，
      // 这里再写旧名会「no such column」直接启动失败（升级路径，新库走不到这一段）
      this.db.exec(
        "UPDATE roles SET zone_id = COALESCE((SELECT a.active_zone_id FROM accounts a WHERE a.id = roles.account_id), 1)",
      );
      this.logger.log("roles.zone_id 已加列，并按账号原区回填（#957）");
    }
    // 帮会绑区（#958）：加列 + 按**帮主角色的区**回填，然后把跨区成员踢出去并发一封系统邮件。
    // 只在第一次加列时做这三件事：之后再跑会拿「现在的区」重新裁一遍成员，
    // 而合区之后本来合法的成员正是「从 from 区搬过来」的那批人。
    if (this.hasTable("guilds") && !this.hasColumn("guilds", "zone_id")) {
      this.ensureColumn("guilds", "zone_id", "INTEGER NOT NULL DEFAULT 1");
      // 帮主的区就是帮会的区：帮主是唯一必须有区的人（帮会没有区之前，成员可以来自任何区）
      this.db.exec(
        "UPDATE guilds SET zone_id = COALESCE((SELECT r.zone_id FROM roles r WHERE r.id = guilds.leader_id), 1)",
      );
      this.evictCrossZoneGuildMembers();
      this.logger.log("guilds.zone_id 已加列，按帮主角色区回填并移出跨区成员（#958）");
    }
    if (this.hasTable("world_monsters")) {
      this.ensureColumn("world_monsters", "zone_id", "INTEGER NOT NULL DEFAULT 1");
      // slot 也要在 exec 之前补：下面立刻给 (zone_id, map_id, slot) 建索引
      this.ensureColumn("world_monsters", "slot", "TEXT NOT NULL DEFAULT '0'");
    }
    // 监控投影表的主键 #809 起是三列（含 slot，按线各存一份）。SQLite 改不了主键，而这张表是
    // **运行时投影**（每秒被覆盖写一次）：丢一帧没有任何损失，所以直接 DROP 让下面的
    // CREATE 建新形状 —— 不写「建新表 + 搬数据 + 改名」那套（为一个可以随便丢的表做搬迁不划算）。
    if (this.hasTable("map_monitor_state") && !this.hasColumn("map_monitor_state", "slot")) {
      this.db.exec("DROP TABLE map_monitor_state");
      this.logger.log("map_monitor_state 主键扩成三列（含 slot）：旧投影已丢弃（运行时投影，一秒后重建）");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id             TEXT PRIMARY KEY,
        username       TEXT NOT NULL UNIQUE,
        password       TEXT NOT NULL,
        email          TEXT,
        status         TEXT NOT NULL DEFAULT 'active',
        online_role_id TEXT,
        online_heartbeat_at INTEGER,
        token_version  INTEGER NOT NULL DEFAULT 0,
        ban_reason     TEXT,
        ban_until      INTEGER,
        banned_by      TEXT,
        banned_at      INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        last_login_at  INTEGER
      );

      CREATE TABLE IF NOT EXISTS roles (
        id         TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        -- 区（#957）：**角色属于区**，账号不再属于区（accounts.zone_id 降级为「当前浏览区」，
        -- 改名 active_zone_id）。一个账号可以在各区各建角色，所以区必须落在这一行上。
        zone_id    INTEGER NOT NULL DEFAULT 1,
        name       TEXT NOT NULL,
        occupation TEXT NOT NULL DEFAULT '',
        sex        TEXT NOT NULL DEFAULT '',
        level      INTEGER NOT NULL DEFAULT 1,
        kills      INTEGER NOT NULL DEFAULT 0,
        data       TEXT NOT NULL,
        revision   INTEGER NOT NULL DEFAULT 1,
        corrupted  INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_roles_account ON roles(account_id);
      -- 按区索引（#959）：分区榜每次重算读**整区**角色，区名查重 / 按名找人也都按它收口。
      -- 没有这条索引时「一区一查」会退化成全表扫 + 过滤，区一多就是「扫 N 遍全表」。
      CREATE INDEX IF NOT EXISTS idx_roles_zone ON roles(zone_id);

      CREATE TABLE IF NOT EXISTS admins (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password      TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'active',
        role          TEXT NOT NULL DEFAULT '${AdminRole.ADMIN}',
        token_version INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id            TEXT PRIMARY KEY,
        actor_id      TEXT,
        actor_name    TEXT,
        actor_role    TEXT,
        action        TEXT NOT NULL,
        target_type   TEXT,
        target_id     TEXT,
        detail        TEXT,
        ip            TEXT,
        method        TEXT,
        path          TEXT,
        -- 这次操作发生在哪个区（#960）：跨区追责要能答「这个客服在几区干过什么」。
        -- 全区性接口（配置 / 管理员 / 区目录）与登录失败这类没有区的请求为空。
        zone_id       INTEGER,
        status_code   INTEGER,
        success       INTEGER NOT NULL DEFAULT 1,
        error_code    INTEGER,
        error_message TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);
      CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);

      -- 玩家行为流水（#886 / J3）。与 audit_logs 刻意分开：
      -- audit_logs 回答「**管理员**点了什么」，event_logs 回答「**玩家**做了什么」——
      -- 操作人、目标、保留期、查询页、权限点全不同，合表会让审计页被拾取流水刷没。
      -- role_name 冗余存名字：角色被删后只留 id 谁也认不出这条记的是谁。
      CREATE TABLE IF NOT EXISTS event_logs (
        id         TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        account_id TEXT,
        role_id    TEXT,
        role_name  TEXT,
        zone_id    INTEGER,
        map_id     TEXT,
        target     TEXT,
        amount     INTEGER,
        detail     TEXT,
        ip         TEXT,
        success    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_event_created ON event_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_event_role ON event_logs(role_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_event_type ON event_logs(type, created_at DESC);

      CREATE TABLE IF NOT EXISTS announcements (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        content    TEXT NOT NULL,
        level      TEXT NOT NULL DEFAULT '${AnnouncementLevel.NORMAL}',
        enabled    INTEGER NOT NULL DEFAULT 1,
        starts_at  INTEGER,
        ends_at    INTEGER,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- 生效中公告的取数条件就是 (enabled, starts_at, ends_at) 三列，按这个顺序建索引让它走同一棵树
      CREATE INDEX IF NOT EXISTS idx_announcements_window ON announcements(enabled, starts_at, ends_at);

      -- 邮件投递队列：status + next_retry_at 是调度器挑任务的全部条件（到期未发 & 待重试）
      CREATE TABLE IF NOT EXISTS mail_queue (
        id            TEXT PRIMARY KEY,
        to_email      TEXT NOT NULL,
        account_id    TEXT,
        template_key  TEXT NOT NULL,
        subject       TEXT NOT NULL,
        body          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        attempts      INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        last_error    TEXT,
        created_by    TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        sent_at       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_mail_queue_due ON mail_queue(status, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_mail_queue_created ON mail_queue(created_at DESC);

      -- 世界权威（#35）：服务端持有的怪物实例状态。
      -- 一行 = 一只场上怪：身份 / 所属区 + 地图 + 线 / 出生点 / 血量 / 存活与重生时刻。
      -- instanceId 带区段与线（#295 阶段二 / #809：m<mapId>_z<zone>_c<slot>_<n>），
      -- 同一张图各区各线各发各的牌。服务端是唯一写者（客户端只通过实时通道间接改它），
      -- 所以不需要乐观锁列。
      CREATE TABLE IF NOT EXISTS world_monsters (
        instance_id TEXT PRIMARY KEY,
        map_id      TEXT NOT NULL,
        zone_id     INTEGER NOT NULL DEFAULT 1,
        -- 线（#809）：'0' = 公共线，'1'.. = 分线，'i<seq>' = 副本。本刀只产出 '0'
        slot        TEXT NOT NULL DEFAULT '0',
        monster_key TEXT NOT NULL,
        area_id     INTEGER,
        x           REAL NOT NULL,
        y           REAL NOT NULL,
        hp          REAL NOT NULL,
        max_hp      REAL NOT NULL,
        alive       INTEGER NOT NULL DEFAULT 1,
        killed_at   INTEGER,
        respawn_at  INTEGER,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_world_monsters_map ON world_monsters(map_id);
      CREATE INDEX IF NOT EXISTS idx_world_monsters_zone ON world_monsters(zone_id, map_id);
      -- 重载与按房间读（#809）：删一间房的实例是 WHERE zone_id=? AND map_id=? AND slot=?
      CREATE INDEX IF NOT EXISTS idx_world_monsters_room ON world_monsters(zone_id, map_id, slot);

      -- 单图热重载请求（#809，收 #669）
      --
      -- 为什么不用 zones.epoch 做单图重载：epoch 是**全局**代际，动它等于把所有图的
      -- 内存世界全作废（合并区才付得起这个代价）。改一块刷怪区只该影响那一个房间，
      -- 所以走一张请求表 —— 跨进程（管理端在 3100 写、实时进程在 3101 读）。
      --
      -- mode：'respawn' = 只重播刷怪区（保留实例血量？**不保留**，整份重播）；
      --       'reload'  = 连 AI 运行时一起重载（与 respawn 的差别在 AI 侧的重建）。
      -- status：'pending' → 'done' / 'failed'。同一 (zone,map,slot) 的多次请求在写库时合并。
      CREATE TABLE IF NOT EXISTS world_reload_requests (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id      INTEGER NOT NULL,
        map_id       TEXT    NOT NULL,
        slot         TEXT    NOT NULL DEFAULT '0',
        mode         TEXT    NOT NULL,
        requested_by TEXT    NOT NULL,
        requested_at INTEGER NOT NULL,
        -- 等空窗的截止时刻：到点强制执行（在场玩家会看到怪整体重刷一次，并收到提示）
        force_at     INTEGER NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'pending',
        done_at      INTEGER,
        -- 执行结果摘要（'done' 时是重播只数，'failed' 时是最后一次错误）
        detail       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_world_reload_pending ON world_reload_requests(status, requested_at);

      -- 实时地图监控（#665）：世界进程每秒把「这张图现在长什么样」投影成一行，管理端只读它。
      --
      -- 为什么还要一张镜像表（world_monsters 不是已经有状态了吗）：那张表的 x/y 是**出生点**
      -- （世界里唯一稳定的真相），而监控要看的是**此刻**的位置 —— 怪物 AI 的模拟坐标只活在
      -- 实时进程内存里，且不落盘（见 monster-ai.service 的 MonsterRuntime）。管理端接口在
      -- 存档进程（3100），两个进程之间只有 SQLite 这一条路，所以这里做一份高频镜像：
      -- 它是**运行时投影，不是配置**，config-sync 的配置表里没有它，重启清空也无所谓。
      --
      -- 主键 #809 起是三列（含 slot）：分线之后「这张图此刻什么样」要按线各存一份。
      CREATE TABLE IF NOT EXISTS map_monitor_state (
        zone_id    INTEGER NOT NULL,
        map_id     TEXT    NOT NULL,
        slot       TEXT    NOT NULL DEFAULT '0',
        -- JSON：{ monsters: [...], players: [...], sampledAt }
        payload    TEXT    NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (zone_id, map_id, slot)
      );

      -- 实时地图监控的文字流（#665）：一次击杀 / 一只怪重生 = 一行。
      -- 存库而不是只放内存环形缓冲：管理端可能「刚打开页面」，这时它需要知道**它没看见的
      -- 那几分钟发生过什么**；内存缓冲对「后来的人」等于不存在。行数按 (区, 图) 裁剪到上限。
      CREATE TABLE IF NOT EXISTS map_monitor_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        zone_id INTEGER NOT NULL,
        map_id  TEXT    NOT NULL,
        at      INTEGER NOT NULL,
        -- kill = 击杀（自带掉落与两个坐标）/ respawn = 刷新
        kind    TEXT    NOT NULL,
        payload TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_map_monitor_events_map ON map_monitor_events(zone_id, map_id, id);
      -- 时间闸（#887）按 at 扫全表：没有这条索引就是「每次清理全表读一遍」，图越多越慢。
      -- 上面那条是 (zone_id, map_id, id)，前缀用不上 —— 时间闸与图无关。
      CREATE INDEX IF NOT EXISTS idx_map_monitor_events_at ON map_monitor_events(at);

      -- 角色位置快照（#930 的产物，服务 #862/#863 的距离校验）：
      -- 一行 = 一个进过图的角色的最新坐标 + 那一次的时刻。
      --
      -- 为什么要落一份到库：位置唯一副本在**实时进程**的 PlayerPresenceService 内存里，
      -- 而 NPC 对话 / 接取任务这些 HTTP 接口跑在**存档进程**（3100），两个进程只有 SQLite
      -- 一条路。不落库的话「玩家隔着半张图点 NPC」根本无从判断（#817 拾取距离也是缺这一块）。
      --
      -- 写入方只有实时进程（1 秒节流），读取方是任务域；**运行时投影不是配置**，
      -- config-sync 的表清单里没有它，重启清空也无所谓（人会重新进图）。
      -- updated_at 是**判新鲜度的唯一依据**：超过 NPC 交互的新鲜窗口就当「不知道他在哪」，
      -- 掉线 / 崩溃留下的行不会变成一张永久有效的通行证。
      CREATE TABLE IF NOT EXISTS role_positions (
        role_id    TEXT PRIMARY KEY,
        map_id     TEXT NOT NULL,
        x          REAL NOT NULL,
        y          REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- 刷怪区（#295 阶段一 / #667 后台绘制）：一行 = 地图上一个矩形区域。
      -- #667 起由**管理端地图页拖框建/改/删**（POST/PATCH/DELETE /admin/maps/:id/spawn-areas），
      -- TMX 的 monster 对象组不再是来源，导入工具也不写这张表（审计守点盯着）。
      -- 坐标口径与客户端世界坐标一致（cx/cy 区域中心、w/h 尺寸），播种时区域内随机取点。
      -- (map_id, name) 唯一：同名区域在一张图里没有并存的意义（接口先查再插，翻成中文 409）。
      CREATE TABLE IF NOT EXISTS map_spawn_areas (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        map_id      TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        monster_key TEXT    NOT NULL,
        min         INTEGER NOT NULL DEFAULT 0,
        max         INTEGER NOT NULL DEFAULT 0,
        cx          REAL    NOT NULL,
        cy          REAL    NOT NULL,
        w           REAL    NOT NULL,
        h           REAL    NOT NULL,
        density_peak REAL,
        density_off  REAL,
        peak_hours   TEXT,
        updated_at  INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_map_spawn_areas_natural ON map_spawn_areas(map_id, name);
      CREATE INDEX IF NOT EXISTS idx_map_spawn_areas_map ON map_spawn_areas(map_id);

      -- NPC 点位（#672）：一行 = 「某个 NPC 站在某张图的某个点上」。
      -- #672 之前这张表不存在：点位写在 TMX 的 npc 对象组里（属性 id 关联 npcs 表），
      -- 客户端四处读它（生成节点 / 预加载动画 / 寻路障碍 / 小地图标记）。
      -- 现在**点位归后台**：TMX 里的对象组只剩资源对照，没有消费方。
      -- 坐标是世界坐标（原点 = 地图左上角、y 轴向上，cy 为负），与 map_spawn_areas 同口径：
      -- 写进来的与读出去的同构，Tiled 口径的换算只在管理端画布那一处。
      -- (map_id, npc_id) 唯一：同一个 NPC 在一张图摆两份没有意义（多张图各一份是正常的，比如传送使者）。
      -- NPC 的外观（label / src / scale / 偏移）在 npcs 表，这张表只管「站在哪」。
      CREATE TABLE IF NOT EXISTS map_npcs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        map_id     TEXT    NOT NULL,
        npc_id     TEXT    NOT NULL,
        cx         REAL    NOT NULL,
        cy         REAL    NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_map_npcs_natural ON map_npcs(map_id, npc_id);
      CREATE INDEX IF NOT EXISTS idx_map_npcs_map ON map_npcs(map_id);

      -- 碰撞盒（#676）：一行 = 一个轴对齐阻挡矩形，坐标是世界坐标（中心 + 尺寸）。
      -- 以前这批矩形只活在 TMX 的 collision 对象组里（客户端两处读：生成静态碰撞体、
      -- 自动战斗的静态障碍），后台只能看不能改。现在归这张表，TMX 只留瓦片 ——
      -- 「地图文件只做显示，所有数据在管理端」这条边界就是这张表换来的。
      -- **允许超出地图边界**：现有每张图的四面围墙本来就画在图外（x=-64、宽 8320），
      -- 那是「把玩家关在图里」的手段，不是数据错误，所以这里没有越界拒绝，只有一个
      -- 「整块在图外」的展示标记（完全看不到的框要能一眼认出来）。
      -- 没有名字列：碰撞盒是匿名的（Tiled 里这批对象也都没起名），页面按 id 指认。
      CREATE TABLE IF NOT EXISTS map_collisions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        map_id     TEXT    NOT NULL,
        cx         REAL    NOT NULL,
        cy         REAL    NOT NULL,
        w          REAL    NOT NULL,
        h          REAL    NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_map_collisions_map ON map_collisions(map_id);

      -- 地图玩法配置（#573）：一行 = 一张图的「整理结果」。
      -- 客户端只存资源本体（TMX / 图 / 预览图），名称 / 类型 / 进入条件这些**玩法数据**归服务端，
      -- 管理端「地图管理」页可视化地改它们，客户端进游戏时随配置快照拉走（configs/apply-snapshot）。
      -- map_id 与 resources/map/<id>/<id>.tmx 的目录名对应 —— 资源清单的真相仍在客户端，
      -- 所以这里**没有「新建地图」接口**：新图要先把 TMX 放进资源包，再跑工具，行由 seed 补出来。
      -- 没有 sort_order：地图 id 是数字字符串，界面与接口一律按数值升序（10 排在 9 后面）。
      CREATE TABLE IF NOT EXISTS maps (
        map_id      TEXT    PRIMARY KEY,
        label       TEXT    NOT NULL DEFAULT '',
        type        TEXT    NOT NULL DEFAULT '0',
        level       INTEGER NOT NULL DEFAULT 0,
        combat      INTEGER NOT NULL DEFAULT 0,
        soul_of_war INTEGER NOT NULL DEFAULT 0,
        -- 地图几何（#655）：以前是 'map-sizes.generated.ts' / 'map-content.generated.ts'
        -- 两份编译期快照（源自 Tiled 的 TMX 头），现在只是这一行的列。
        -- 判据没变：几何来自资源，运营不改它；运营改的是上面五行。
        grid_cols   INTEGER NOT NULL DEFAULT 0,
        grid_rows   INTEGER NOT NULL DEFAULT 0,
        tile_width  INTEGER NOT NULL DEFAULT 128,
        tile_height INTEGER NOT NULL DEFAULT 128,
        pixel_width INTEGER NOT NULL DEFAULT 0,
        pixel_height INTEGER NOT NULL DEFAULT 0,
        -- 图层结构（JSON：'{ layers: [...], groups: [...] }'）—— 管理端详情页的「图层」块渲染它。
        -- #676 起 TMX 里的对象组已经整组删掉（点位 / 刷怪区 / 碰撞盒全在各自的表里），
        -- 所以 groups 现在恒为空数组：留着这个键只是为了让老库的 JSON 还能被同一个解析器读。
        -- 刷怪区 / NPC / 碰撞盒各有一张表，不在这里。
        content     TEXT    NOT NULL DEFAULT '{"layers":[],"groups":[]}',
        -- 复活点（#672）：每张图最多一个，NULL = 这张图没有复活点（客户端不进图定位、不回点复活）。
        -- 以前是 TMX 里 class=revive 的那个点，现在归后台；单值跟地图同生命周期，就不单开表了
        revive_cx   REAL,
        revive_cy   REAL,
        updated_by  TEXT    NOT NULL DEFAULT '',
        updated_at  INTEGER NOT NULL DEFAULT 0
      );

      -- 地图级玩法规则（#809 / docs/20 §2.2）：一行 = 一张图的规则覆盖。
      --
      -- **一行不存在 = 全默认**（新建图不用先填 15 个字段）—— 这是这张表最重要的口径：
      -- 读的一方一律「取行，取不到就用这里的默认值」，不靠 seed 补行。
      --
      -- 为什么不给 maps 加 15 个列：列一多就没人敢动，而且绝大多数图只用默认值；
      -- 规则是「玩法」不是「几何」，与 maps 那张纯配置表的修改频率差一个量级。
      --
      -- 倍率（exp/drop/money）**只在服务端结算时乘，不下发客户端** —— 否则「客户端算出来的
      -- 经验」和「服务端给的经验」迟早不一致。本刀（#809）只消费者 capacity 三项：
      -- max_players_per_room / max_channels / simulate_when_empty；其余列先到位，
      -- 消费方见 docs/20 §5.5（结算倍率）与 §2.6（分线），属于第④刀。
      CREATE TABLE IF NOT EXISTS map_rules (
        map_id                 TEXT    PRIMARY KEY,
        exp_rate               REAL    NOT NULL DEFAULT 1.0,
        drop_rate              REAL    NOT NULL DEFAULT 1.0,
        money_rate             REAL    NOT NULL DEFAULT 1.0,
        allow_pk               INTEGER NOT NULL DEFAULT 0,
        allow_auto_battle      INTEGER NOT NULL DEFAULT 1,
        allow_recall           INTEGER NOT NULL DEFAULT 1,
        allow_drop             INTEGER NOT NULL DEFAULT 1,
        -- 容量（#809）：0 = 不限；出厂 30。分线数量 >1 才真的会开新线（第④刀）
        max_players_per_room   INTEGER NOT NULL DEFAULT 30,
        max_channels           INTEGER NOT NULL DEFAULT 1,
        transfer_cost_money    INTEGER NOT NULL DEFAULT 0,
        transfer_cooldown_ms   INTEGER NOT NULL DEFAULT 0,
        deny_transfer_in_combat INTEGER NOT NULL DEFAULT 0,
        -- 中间级重生时长（NULL = 继承全局 worldRespawnMs；见 docs/27 §2.2.2 的三级继承）
        respawn_ms_override    INTEGER,
        -- 无人时冻结（0 = 冻结，现状）还是低频 tick（1 = 继续跑世界事件）
        simulate_when_empty    INTEGER NOT NULL DEFAULT 0,
        updated_by             TEXT    NOT NULL DEFAULT '',
        updated_at             INTEGER NOT NULL DEFAULT 0
      );

      -- 特效配置（#594 升级特效 / #634 掉落光效）：一行 = 一个特效 key 的「摆位 / 缩放 / 旋转 / 时长 / 开关」
      -- （与武器外观同一套取向）。图集本体在客户端资源包里，路径是两端约定
      -- effect/<key>/<key>.plist —— **不入库**（#573 同一条纪律：存了只会让人把客户端
      -- 指到不存在的图上）。行由启动 seed 按 UI_EFFECT_DEFAULTS 补出来，
      -- 一个 key 存在的前提是客户端有消费代码，所以没有「新建 / 删除特效」接口。
      CREATE TABLE IF NOT EXISTS ui_effects (
        effect_key  TEXT    PRIMARY KEY,
        offset_x    INTEGER NOT NULL DEFAULT 0,
        offset_y    INTEGER NOT NULL DEFAULT 0,
        scale_x     REAL    NOT NULL DEFAULT 1,
        scale_y     REAL    NOT NULL DEFAULT 1,
        rotate      INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 1000,
        enabled     INTEGER NOT NULL DEFAULT 1,
        updated_by  TEXT    NOT NULL DEFAULT '',
        updated_at  INTEGER NOT NULL DEFAULT 0
      );

      -- 音效配置（#680）：一行 = 一个音效项的「用哪个文件 / 多大声 / 循环不循环 / 开不开」。
      -- 文件本体在客户端资源包里（client/assets/resources/audio/），这里只存**资源相对路径**
      -- （带扩展名，如 'audio/login-bg.wav'）—— 换一首曲子只要新文件已进资源包，不必重打客户端。
      -- file_path 允许空串（= 未配置，这一项不响）；行由启动 seed 按 AUDIO_DEFAULTS 补出来，
      -- 一个 key 存在的前提是客户端有播它的代码，所以没有「新建 / 删除音效」接口。
      CREATE TABLE IF NOT EXISTS audio_settings (
        audio_key  TEXT    PRIMARY KEY,
        file_path  TEXT    NOT NULL DEFAULT '',
        volume     INTEGER NOT NULL DEFAULT 100,
        loop       INTEGER NOT NULL DEFAULT 0,
        enabled    INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT    NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      -- 区服（#295 阶段二）：一行 = 一个游戏区。账号注册时选定归属区，
      -- 各区的世界（怪物实例）相互独立；合并区后 from 区在此打 merged_into 标记
      -- （不删行：区号是历史事实，管理端列表还要展示「已并入 X 区」）。
      -- 名字唯一：区服列表是给玩家选的，重名没有意义。
      CREATE TABLE IF NOT EXISTS zones (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL UNIQUE,
        -- 运营状态（#960）：open / closed。已合并看 merged_into，两者不是一回事
        status      TEXT    NOT NULL DEFAULT 'open',
        -- 下拉排序（#960）：升序，同值按 id
        sort        INTEGER NOT NULL DEFAULT 0,
        merged_into INTEGER,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      -- 一区恒在（id=1，账号默认区）：seed 在 migrate 里做，CREATE 单独兜底
      INSERT OR IGNORE INTO zones (id, name, merged_into, created_at, updated_at) VALUES (1, '一区', NULL, 0, 0);

      -- 世界代际（#295 阶段二）：单行表（id 恒为 1），epoch 每次合并区 +1。
      -- 世界服务的内存态跨「合并区」会变陈旧（instanceId 被改写、账号换了区），
      -- 而 API 进程与实时进程各持一份内存 —— 跨进程通知靠轮询这张表：
      -- tick 发现 epoch 变了就把整份内存世界作废（不落盘），下次 join 从库重载。
      CREATE TABLE IF NOT EXISTS world_meta (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        epoch INTEGER NOT NULL DEFAULT 0,
        -- 世界坐标口径（#566）：topleft = 地图左上角为原点（当前口径），
        -- center = 旧口径（地图中心为原点，存量库补列时落到这个值，然后被一次性迁移抹平）
        coord_origin TEXT NOT NULL DEFAULT 'topleft'
      );
      INSERT OR IGNORE INTO world_meta (id, epoch) VALUES (1, 0);

      -- 装备对齐几何（#513）：一行 = 一件衣服 / 一把武器 / 一套裸模的外观几何。
      -- 为什么进库而不是只留在客户端配置：位置要能"管理端调完立刻生效"，而客户端配置是
      -- 打包进 bundle 的（改一行要重打 3G 的包）。所以把"布局覆盖"也当配置下发，客户端进游戏
      -- 时套一遍（configs/apply-snapshot 的 applyEquipAlignRows）。
      -- id 形如 cloth:cloth_1 / weapon:weapon_1 / role:1（裸模按性别）；**没有行 = 用客户端配置里的值**，
      -- 所以"重置"就是删行，不需要存一份"默认值"的副本。
      -- out_positions 是 8 个方向的 [x, y]（顺序见 configs/animation 的 directions）。
      -- 只有**外观**：内观（角色信息弹窗里站在圆盘上那套）走下面单独一张表 ——
      -- 两者字段形状完全不同（8 向 vs 单帧、位置 vs 缩放），混在一行会让「只调了外观」
      -- 和「只调了内观」都要存一份对方字段的副本。
      CREATE TABLE IF NOT EXISTS equip_aligns (
        id            TEXT    PRIMARY KEY,
        out_scale     REAL    NOT NULL DEFAULT 1,
        out_positions TEXT    NOT NULL,
        out_manual    INTEGER NOT NULL DEFAULT 0,
        updated_by    TEXT,
        updated_at    INTEGER NOT NULL
      );

      -- 装备内观几何（#523）：一行 = 一件衣服 / 一把武器在角色信息弹窗里的位置与缩放。
      -- 与 equip_aligns 分开的理由见上一条注释；两表的 id 形态也略窄（内观没有裸模）。
      -- in_position 拍成两列而不是 JSON：内观只有**一个**位置，塞 JSON 只是给自己加解析负担。
      -- in_manual 只对武器有意义：true = 用手调的绝对位置（工作台调过），
      -- false/缺省 = 客户端仍按「当前衣服的内容 bbox」自动算（#505 的算法），渐进替换。
      -- **没有行 = 用客户端配置里的值**，所以"重置"就是删行。
      CREATE TABLE IF NOT EXISTS equip_in_aligns (
        id          TEXT    PRIMARY KEY,
        in_scale_x  REAL    NOT NULL DEFAULT 1,
        in_scale_y  REAL    NOT NULL DEFAULT 1,
        in_x        REAL    NOT NULL DEFAULT 0,
        in_y        REAL    NOT NULL DEFAULT 0,
        in_manual   INTEGER NOT NULL DEFAULT 0,
        updated_by  TEXT,
        updated_at  INTEGER NOT NULL
      );

      -- 养成配置（#213）：称号 / 战魂的等级序列**固定**（level 是主键，行只能来自 seed，
      -- 后台只改内容），所以没有 created_at，只有 updated_at。
      -- 八项属性拍平成 min/max 两列（区间型六项 + 单值两项），避免 JSON 列没法建索引与校验。
      CREATE TABLE IF NOT EXISTS titles (
        level                INTEGER PRIMARY KEY,
        label                TEXT    NOT NULL,
        description          TEXT    NOT NULL DEFAULT '',
        animation            TEXT    NOT NULL DEFAULT '',
        animation_frame_rate INTEGER NOT NULL DEFAULT 10,
        bind_gold            INTEGER NOT NULL DEFAULT 0,
        acquire_channel      TEXT    NOT NULL DEFAULT 'unavailable',
        max_hp               INTEGER NOT NULL DEFAULT 0,
        hp_recover           INTEGER NOT NULL DEFAULT 0,
        physical_attack_min  INTEGER NOT NULL DEFAULT 0,
        physical_attack_max  INTEGER NOT NULL DEFAULT 0,
        magic_attack_min     INTEGER NOT NULL DEFAULT 0,
        magic_attack_max     INTEGER NOT NULL DEFAULT 0,
        taoist_attack_min    INTEGER NOT NULL DEFAULT 0,
        taoist_attack_max    INTEGER NOT NULL DEFAULT 0,
        physical_defense_min INTEGER NOT NULL DEFAULT 0,
        physical_defense_max INTEGER NOT NULL DEFAULT 0,
        magic_defense_min    INTEGER NOT NULL DEFAULT 0,
        magic_defense_max    INTEGER NOT NULL DEFAULT 0,
        taoist_defense_min   INTEGER NOT NULL DEFAULT 0,
        taoist_defense_max   INTEGER NOT NULL DEFAULT 0,
        -- 称号成长列表顺序（#230）：可空；仅 acquire_channel='upgrade' 的行持有（1 起），
        -- 升级链顺序与等级号解耦，运营拖动成长列表改的就是它；部分唯一索引防重号
        upgrade_order        INTEGER,
        updated_at           INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS souls (
        level                INTEGER PRIMARY KEY,
        label                TEXT    NOT NULL,
        description          TEXT    NOT NULL DEFAULT '',
        animation            TEXT    NOT NULL DEFAULT '',
        animation_frame_rate INTEGER NOT NULL DEFAULT 10,
        bind_gold            INTEGER NOT NULL DEFAULT 0,
        max_hp               INTEGER NOT NULL DEFAULT 0,
        hp_recover           INTEGER NOT NULL DEFAULT 0,
        physical_attack_min  INTEGER NOT NULL DEFAULT 0,
        physical_attack_max  INTEGER NOT NULL DEFAULT 0,
        magic_attack_min     INTEGER NOT NULL DEFAULT 0,
        magic_attack_max     INTEGER NOT NULL DEFAULT 0,
        taoist_attack_min    INTEGER NOT NULL DEFAULT 0,
        taoist_attack_max    INTEGER NOT NULL DEFAULT 0,
        physical_defense_min INTEGER NOT NULL DEFAULT 0,
        physical_defense_max INTEGER NOT NULL DEFAULT 0,
        magic_defense_min    INTEGER NOT NULL DEFAULT 0,
        magic_defense_max    INTEGER NOT NULL DEFAULT 0,
        taoist_defense_min   INTEGER NOT NULL DEFAULT 0,
        taoist_defense_max   INTEGER NOT NULL DEFAULT 0,
        -- 战魂成长列表顺序（#234）：可空；37 阶全量进成长列表，seed/回填都按阶数给初值，
        -- 升级链顺序与阶数解耦，运营拖动成长列表改的就是它；部分唯一索引防重号
        upgrade_order        INTEGER,
        updated_at           INTEGER NOT NULL DEFAULT 0
      );

      -- 角色等级曲线（#786）：一行 = 一条曲线（exp / hp / attack_max / defense_max）的一段。
      -- 公式：value(level) = start_value + per_level*k + accel*k*(k-1)/2（k = level - from_level）。
      -- 4 条 × 6 段 = 24 行就定义了 1..100 万级 —— #786 起**不再逐级存表**：
      -- 旧的 role_levels（60 行）已删除，逐级存 100 万行要 60MB 库 / 1.5GB 快照，不可行。
      -- 求值在 common/constants/role-level-curve.ts（服务端与生成脚本共用同一份）。
      CREATE TABLE IF NOT EXISTS role_level_curves (
        curve       TEXT    NOT NULL,
        seq         INTEGER NOT NULL,
        from_level  INTEGER NOT NULL,
        to_level    INTEGER NOT NULL,
        start_value INTEGER NOT NULL DEFAULT 0,
        per_level   INTEGER NOT NULL DEFAULT 0,
        accel       INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (curve, seq)
      );

      -- #786：逐级表已废弃（等级改由曲线派生）。存量库把这张表删掉 ——
      -- 留着它没有读方，但会让人以为「改这里有用」。
      DROP TABLE IF EXISTS role_levels;

      -- 装备变体表（#655）：一行 = 一件**具体可掉落/可穿戴**的装备（基础件 × 前后缀，
      -- 基础件数 × 15 行）。这是「移除变体倍率」后的唯一书写处：不再由基础件乘倍率现算，
      -- 每行的属性 / 卖价 / 穿戴等级都可单独改。equipments 只留基础件（模板与名称）。
      CREATE TABLE IF NOT EXISTS equipment_variants (
        id                   TEXT    PRIMARY KEY,
        base_id              TEXT    NOT NULL,
        prefix               INTEGER NOT NULL DEFAULT 0,
        suffix               INTEGER NOT NULL DEFAULT 0,
        label                TEXT    NOT NULL DEFAULT '',
        level                INTEGER NOT NULL DEFAULT 1,
        sell_price           INTEGER NOT NULL DEFAULT 0,
        max_hp               INTEGER NOT NULL DEFAULT 0,
        hp_recover           INTEGER NOT NULL DEFAULT 0,
        physical_attack_min  INTEGER NOT NULL DEFAULT 0,
        physical_attack_max  INTEGER NOT NULL DEFAULT 0,
        magic_attack_min     INTEGER NOT NULL DEFAULT 0,
        magic_attack_max     INTEGER NOT NULL DEFAULT 0,
        taoist_attack_min    INTEGER NOT NULL DEFAULT 0,
        taoist_attack_max    INTEGER NOT NULL DEFAULT 0,
        physical_defense_min INTEGER NOT NULL DEFAULT 0,
        physical_defense_max INTEGER NOT NULL DEFAULT 0,
        magic_defense_min    INTEGER NOT NULL DEFAULT 0,
        magic_defense_max    INTEGER NOT NULL DEFAULT 0,
        taoist_defense_min   INTEGER NOT NULL DEFAULT 0,
        taoist_defense_max   INTEGER NOT NULL DEFAULT 0,
        updated_at           INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_equipment_variants_base ON equipment_variants(base_id);

      -- 成长标量（#256）：等级上限 / 区间倍率 / 经验节奏 / 回蓝这类**非曲线**参数。
      -- #786 起等级本身也回到曲线（role_level_curves）：这里是「全线一个数」的那几个，
      -- 每级涨多少由曲线段决定。
      CREATE TABLE IF NOT EXISTS growth_scalars (
        key         TEXT PRIMARY KEY,
        value       REAL    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        updated_at  INTEGER NOT NULL DEFAULT 0
      );

      -- 泡点活动参数（#722）：出厂默认 rate=0（活动关闭）。这里 INSERT OR IGNORE
      -- 每次启动都跑：存量库（快照灌库早于这两个键）也能拿到可编辑的行，
      -- 管理端「成长参数」页才改得到（updateScalar 对不存在的键是 404）。
      INSERT OR IGNORE INTO growth_scalars (key, value, description, updated_at) VALUES
        ('soakExpPerTick', 0, '泡点活动：在线角色每拍获得的经验（0 = 活动关闭；服务端定时发放，走击杀同一套升级链路）', 0),
        ('soakTickSeconds', 10, '泡点活动：发经验的拍间隔（秒；与上一条配合出「每 M 秒发 N 点」的速率）', 0),
        -- 暴击（#826）：出厂 0（新号不暴击，22 篇口径）/ 1.5 倍。
        -- 这两行同样是 INSERT OR IGNORE —— 存量库也能在「成长参数」页改到
        ('critRate', 0, '角色基础暴击率（0~1；与技能自带的暴击率相加。出厂 0 = 新号不暴击）', 0),
        ('critDamage', 1.5, '角色基础暴击倍率（> 1 才生效；技能配了自己的倍率则以技能为准。出厂 1.5 倍）', 0),
        -- 属性点（#833）：每点加成系数与洗点花费。同样每次启动 INSERT OR IGNORE ——
        -- 存量库（快照灌库早于这两个键）也能在管理端改到，且改过的值不会被覆盖
        ('attrPointRatio', 0.005, '属性点：每点加成系数（0.005 = 每点 0.5%；力量→物攻、体质→生命+物防、精神→法攻+道攻+法力按等级曲线基础值放大，敏捷→暴击率按绝对百分点）', 0),
        ('attrResetCost', 500, '属性点：洗点花费的绑定元宝（0 = 免费洗点；四维归零、已分配点数全部退还）', 0),
        -- 等级差（#834）：出厂 0.05 = 每越 1 级压 5%（越 20 级打不动）。
        -- 改动前这个系数是代码里的字面量，运营调不了
        ('levelGapSuppress', 0.05, '等级差：目标每比角色高 1 级，伤害乘数 −该值（0.05 = 每级 −5%，越 20 级归零；0 = 不压制）', 0);

      -- 军衔配置（#250）：与 titles / souls 同构（100 阶全量就是成长链，顺序天然按阶，
      -- 没有 upgrade_order 列 —— 军衔不拖动排序）；多 tier 列（大段名），少 animation 两列。
      CREATE TABLE IF NOT EXISTS ranks (
        level                INTEGER PRIMARY KEY,
        label                TEXT    NOT NULL,
        tier                 TEXT    NOT NULL DEFAULT '',
        description          TEXT    NOT NULL DEFAULT '',
        bind_gold            INTEGER NOT NULL DEFAULT 0,
        max_hp               INTEGER NOT NULL DEFAULT 0,
        hp_recover           INTEGER NOT NULL DEFAULT 0,
        physical_attack_min  INTEGER NOT NULL DEFAULT 0,
        physical_attack_max  INTEGER NOT NULL DEFAULT 0,
        magic_attack_min     INTEGER NOT NULL DEFAULT 0,
        magic_attack_max     INTEGER NOT NULL DEFAULT 0,
        taoist_attack_min    INTEGER NOT NULL DEFAULT 0,
        taoist_attack_max    INTEGER NOT NULL DEFAULT 0,
        physical_defense_min INTEGER NOT NULL DEFAULT 0,
        physical_defense_max INTEGER NOT NULL DEFAULT 0,
        magic_defense_min    INTEGER NOT NULL DEFAULT 0,
        magic_defense_max    INTEGER NOT NULL DEFAULT 0,
        taoist_defense_min   INTEGER NOT NULL DEFAULT 0,
        taoist_defense_max   INTEGER NOT NULL DEFAULT 0,
        updated_at           INTEGER NOT NULL DEFAULT 0
      );

      -- 装备基础件配置（#252）：主键是基础件 id（如 cloth_1），id / 部位结构固定不可增删行；
      -- 属性列与 titles / souls / ranks 同构（SoulRowShape 十四列），变体不进库
      --
      -- #603 第九域起**显示与规则字段也在库里**（此前只有名称与数值，图标 / 图集 / 缩放 /
      -- 8 向位置 / 职业性别限制全写死在客户端 configs/equipments）：客户端对应文件只剩
      -- 纯函数与空运行时表，改这些值不再需要重新打包。
      -- 几何是**出厂值**：管理端「装备对齐 / 内观对齐」工作台的保存结果落在 equip_aligns /
      -- equip_in_aligns 表、每次进图另发（覆盖语义），这里改了只在「没调过对齐」的装备上可见。
      -- 列名用 in_atlas / out_atlas 而不是 in / out（in 是 SQL 关键字）
      CREATE TABLE IF NOT EXISTS equipments (
        id                   TEXT    PRIMARY KEY,
        slot                 TEXT    NOT NULL,
        level                INTEGER NOT NULL DEFAULT 1,
        sell_price           INTEGER NOT NULL DEFAULT 0,
        label                TEXT    NOT NULL DEFAULT '',
        occupation           TEXT    NOT NULL DEFAULT '4',
        sex                  TEXT    NOT NULL DEFAULT '3',
        description          TEXT    NOT NULL DEFAULT '',
        icon                 TEXT    NOT NULL DEFAULT '',
        in_atlas             TEXT    NOT NULL DEFAULT '',
        out_atlas            TEXT    NOT NULL DEFAULT '',
        tags                 TEXT    NOT NULL DEFAULT '[]',
        in_pos_x             REAL    NOT NULL DEFAULT 0,
        in_pos_y             REAL    NOT NULL DEFAULT 0,
        in_scale_x           REAL    NOT NULL DEFAULT 1,
        in_scale_y           REAL    NOT NULL DEFAULT 1,
        in_rotate            REAL    NOT NULL DEFAULT 0,
        out_scale            REAL    NOT NULL DEFAULT 1,
        out_positions        TEXT    NOT NULL DEFAULT '[]',
        max_hp               INTEGER NOT NULL DEFAULT 0,
        hp_recover           INTEGER NOT NULL DEFAULT 0,
        physical_attack_min  INTEGER NOT NULL DEFAULT 0,
        physical_attack_max  INTEGER NOT NULL DEFAULT 0,
        magic_attack_min     INTEGER NOT NULL DEFAULT 0,
        magic_attack_max     INTEGER NOT NULL DEFAULT 0,
        taoist_attack_min    INTEGER NOT NULL DEFAULT 0,
        taoist_attack_max    INTEGER NOT NULL DEFAULT 0,
        physical_defense_min INTEGER NOT NULL DEFAULT 0,
        physical_defense_max INTEGER NOT NULL DEFAULT 0,
        magic_defense_min    INTEGER NOT NULL DEFAULT 0,
        magic_defense_max    INTEGER NOT NULL DEFAULT 0,
        taoist_defense_min   INTEGER NOT NULL DEFAULT 0,
        taoist_defense_max   INTEGER NOT NULL DEFAULT 0,
        updated_at           INTEGER NOT NULL DEFAULT 0,
        -- 掉落强制绑定（#789）：1 = 这件装备掉出来就绑定角色、不可交易。
        -- **必须放在最后一列**：存量库是 ALTER TABLE ADD COLUMN 补的，只能追加在末尾，
        -- 新库若把它写在中间，两边的 SELECT * 列序不同，配置导出会是一整份假 diff
        bind_on_drop         INTEGER NOT NULL DEFAULT 0
      );

      -- 装备槽位表（#603 第九域）：13 行，主键是 EQUIPMENT_TYPE 的枚举值。
      -- 顺序即角色弹窗的槽位排列与背包「一键整理」的部位序（sort_order）；
      -- 表结构固定不可增删行（枚举是封闭的，新增部位属于代码改动）
      CREATE TABLE IF NOT EXISTS equipment_slots (
        key        TEXT    PRIMARY KEY,
        label      TEXT    NOT NULL DEFAULT '',
        image_src  TEXT    NOT NULL DEFAULT '',
        position   TEXT    NOT NULL DEFAULT 'bottom',
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      -- 装备规则（#603 第九域）：单行表（id 恒为 1），存前后缀倍率 / 文案 / 文字颜色（#720）。
      -- 六个数组都是 JSON 文本 —— 它们是「一组同长的表」，拆成列反而要多维护行数约束。
      -- 回收价曲线 #655 下架（逐条价在 equipment_variants.sell_price），老库那列由 ensure 段删掉
      CREATE TABLE IF NOT EXISTS equipment_meta (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        prefix_rates  TEXT    NOT NULL DEFAULT '[]',
        suffix_rates  TEXT    NOT NULL DEFAULT '[]',
        prefix_labels TEXT    NOT NULL DEFAULT '[]',
        suffix_labels TEXT    NOT NULL DEFAULT '[]',
        prefix_colors TEXT    NOT NULL DEFAULT '[]',
        suffix_colors TEXT    NOT NULL DEFAULT '[]',
        updated_at    INTEGER NOT NULL DEFAULT 0
      );

      -- 药品配置（#253）：主键是药品 id（如 drug_hp_1），id 清单固定不可增删行；
      -- effects 数组按键求和拍平成四列（与客户端 resolveDrugRecovery 累加口径等价）
      CREATE TABLE IF NOT EXISTS drugs (
        id                 TEXT    PRIMARY KEY,
        label              TEXT    NOT NULL DEFAULT '',
        description        TEXT    NOT NULL DEFAULT '',
        icon               TEXT    NOT NULL DEFAULT '',
        level              INTEGER NOT NULL DEFAULT 1,
        sell_price         INTEGER NOT NULL DEFAULT 0,
        max_stack          INTEGER NOT NULL DEFAULT 99,
        cooldown           INTEGER NOT NULL DEFAULT 0,
        effect_hp          INTEGER NOT NULL DEFAULT 0,
        effect_mp          INTEGER NOT NULL DEFAULT 0,
        effect_hp_percent  INTEGER NOT NULL DEFAULT 0,
        effect_mp_percent  INTEGER NOT NULL DEFAULT 0,
        updated_at         INTEGER NOT NULL DEFAULT 0,
        -- 掉落强制绑定（#789），语义同 equipments.bind_on_drop（同样必须在最后一列）
        bind_on_drop       INTEGER NOT NULL DEFAULT 0
      );

      -- 物品与材料配置（#255）：主键是物品 id（如 material_hide），id 清单固定不可增删行；
      -- 只收 MATERIAL / OTHER 大类（装备与药品各有自己的表）
      CREATE TABLE IF NOT EXISTS items (
        id           TEXT    PRIMARY KEY,
        type         TEXT    NOT NULL DEFAULT 'material',
        label        TEXT    NOT NULL DEFAULT '',
        description  TEXT    NOT NULL DEFAULT '',
        icon         TEXT    NOT NULL DEFAULT '',
        level        INTEGER NOT NULL DEFAULT 1,
        sell_price   INTEGER NOT NULL DEFAULT 0,
        max_stack    INTEGER NOT NULL DEFAULT 99,
        updated_at   INTEGER NOT NULL DEFAULT 0,
        bind_on_drop INTEGER NOT NULL DEFAULT 0
      );

      -- 货币物品（#785）：使用后直接给角色账本入账
      -- 货币收敛（#843、#844）：唯一币种 bindGold（绑定元宝），旧币种字段已整体移除
      -- 与药品 / 物品不同，**可以增删行** —— 面值由运营在「货币物品」页自己开
      CREATE TABLE IF NOT EXISTS money_items (
        id          TEXT    PRIMARY KEY,
        label       TEXT    NOT NULL DEFAULT '',
        description TEXT    NOT NULL DEFAULT '',
        icon        TEXT    NOT NULL DEFAULT '',
        currency    TEXT    NOT NULL DEFAULT 'bindGold',
        amount      INTEGER NOT NULL DEFAULT 0,
        max_stack   INTEGER NOT NULL DEFAULT 999,
        sell_price  INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL DEFAULT 0,
        bind_on_drop INTEGER NOT NULL DEFAULT 0
      );

      -- 升级卷轴（#787）：使用后硬性 +1 级，带等级区间（min_level ~ max_level）
      -- 与货币物品同一取向 —— **可以增删行**：等级上限调大后运营自己再开一卷
      CREATE TABLE IF NOT EXISTS level_scrolls (
        id          TEXT    PRIMARY KEY,
        label       TEXT    NOT NULL DEFAULT '',
        description TEXT    NOT NULL DEFAULT '',
        icon        TEXT    NOT NULL DEFAULT '',
        min_level   INTEGER NOT NULL DEFAULT 1,
        max_level   INTEGER NOT NULL DEFAULT 1,
        max_stack   INTEGER NOT NULL DEFAULT 999,
        sell_price  INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL DEFAULT 0,
        bind_on_drop INTEGER NOT NULL DEFAULT 0
      );
      -- 怪物基础数据（#258）：主键是怪物 key（configs/monster 的关联键），清单固定不可增删行；
      -- 战斗数值 seed 自生成物 MONSTERS，世界播种与伤害结算直读本表（改值即时生效）
      CREATE TABLE IF NOT EXISTS monsters (
        id                   TEXT    PRIMARY KEY,
        label                TEXT    NOT NULL DEFAULT '',
        tier                 TEXT    NOT NULL DEFAULT 'normal',
        level                INTEGER NOT NULL DEFAULT 1,
        max_hp               INTEGER NOT NULL DEFAULT 1,
        physical_attack_min  INTEGER NOT NULL DEFAULT 0,
        physical_attack_max  INTEGER NOT NULL DEFAULT 0,
        magic_attack_min     INTEGER NOT NULL DEFAULT 0,
        magic_attack_max     INTEGER NOT NULL DEFAULT 0,
        taoist_attack_min    INTEGER NOT NULL DEFAULT 0,
        taoist_attack_max    INTEGER NOT NULL DEFAULT 0,
        physical_defense_min INTEGER NOT NULL DEFAULT 0,
        physical_defense_max INTEGER NOT NULL DEFAULT 0,
        magic_defense_min    INTEGER NOT NULL DEFAULT 0,
        magic_defense_max    INTEGER NOT NULL DEFAULT 0,
        taoist_defense_min   INTEGER NOT NULL DEFAULT 0,
        taoist_defense_max   INTEGER NOT NULL DEFAULT 0,
        updated_at           INTEGER NOT NULL DEFAULT 0
      );

      -- 怪物表现 / 资源（#588 / #655）：一行 = 一只怪的图集路径 + 基准帧几何 + AI 视觉参数。
      -- 以前是生成物 'monster-presentation.generated.ts'（生成器实测图集基准帧的 trim），
      -- 现在只是表 —— 客户端从快照拿它拼资源，服务端权威 AI 读 aggressive / detectRange / moveSpeed。
      -- **数值不在这张表**（label / level / 六项在 'monsters'），这里只有「长什么样、怎么动」。
      CREATE TABLE IF NOT EXISTS monster_presentation (
        id             TEXT    PRIMARY KEY,
        icon           TEXT    NOT NULL DEFAULT '',
        out            TEXT    NOT NULL DEFAULT '',
        out_offset_x   INTEGER NOT NULL DEFAULT 0,
        out_offset_y   INTEGER NOT NULL DEFAULT 0,
        content_width  INTEGER NOT NULL DEFAULT 0,
        content_height INTEGER NOT NULL DEFAULT 0,
        move_speed     REAL    NOT NULL DEFAULT 0,
        aggressive     INTEGER NOT NULL DEFAULT 0,
        detect_range   INTEGER NOT NULL DEFAULT 0,
        -- 可选的速度倍率覆写（动作名 → 倍率），空 JSON = 全用默认
        speed_rate     TEXT    NOT NULL DEFAULT '{}',
        updated_at     INTEGER NOT NULL DEFAULT 0
      );

      -- NPC 数据（#258 / #603 第七域）：主键是 NPC id（Tiled 对象组的关联键），清单固定不可增删行；
      -- label / dialog / src / scale / position 全是运营可改的表现数据（客户端不再存一份），
      -- 进游戏由 GET /game-config 快照下发；src 是 resources 下的素材目录（图集动画）
      CREATE TABLE IF NOT EXISTS npcs (
        id         TEXT    PRIMARY KEY,
        label      TEXT    NOT NULL DEFAULT '',
        dialog     TEXT    NOT NULL DEFAULT '',
        src        TEXT    NOT NULL DEFAULT '',
        scale_x    REAL    NOT NULL DEFAULT 1,
        scale_y    REAL    NOT NULL DEFAULT 1,
        pos_x      REAL    NOT NULL DEFAULT 0,
        pos_y      REAL    NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      -- 商城分类（#758）：**运营自建**（动态增删行）—— 分类只是陈列分组，不带数值；
      -- 删除前 service 层校验分类下没有上架商品
      CREATE TABLE IF NOT EXISTS mall_categories (
        id         TEXT    PRIMARY KEY,
        label      TEXT    NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      -- 商城上架商品（#758）：主键是商品 id（装备变体 id），**运营手动上架/下架** ——
      -- 商品本体（名称/图标/部位）是装备数据，这里只存售价与购买等级两个运营字段；
      -- 不在表里的商品不在商城售卖（客户端陈列与购买都以这张表为准）
      --
      -- 限购与库存（#846）是**纯配置**，卖出去的计数不在这张表里（见下面 mall_sales / mall_stock）：
      -- 这张表进 config-sync.sql，把 sold 写进来会被「导入 / 回滚 / 另一台机器的快照」盖回去。
      -- 语义：daily_limit = 0 = 不限购（与 drugs.cooldown = 0 同口径）；stock = -1 = 不限量，
      -- 0 才是「售罄停售」—— 两者默认值不同是因为「限购 0 次」没有意义，而「库存 0 件」有。
      CREATE TABLE IF NOT EXISTS mall_goods (
        id             TEXT    PRIMARY KEY,
        category_id    TEXT    NOT NULL,
        price          INTEGER NOT NULL DEFAULT 0,
        required_level INTEGER NOT NULL DEFAULT 0,
        daily_limit    INTEGER NOT NULL DEFAULT 0,
        stock          INTEGER NOT NULL DEFAULT -1,
        updated_at     INTEGER NOT NULL DEFAULT 0
      );

      -- 每日限购计数（#846）：**运行时**表，不进 config-sync.sql
      -- 主键 (role_id, good_id, day)：一个角色一件商品一天一行，天号来自 common/utils/daily-clock
      -- （每日 05:00 切日，与日常任务同一把尺子）。跨天不需要结算 —— 天号对不上就是新的一天，
      -- 旧行由购买链路顺手清掉（限购只对今天有意义，留着也没人读）。
      CREATE TABLE IF NOT EXISTS mall_sales (
        role_id    TEXT    NOT NULL,
        good_id    TEXT    NOT NULL,
        day        INTEGER NOT NULL,
        count      INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (role_id, good_id, day)
      );
      CREATE INDEX IF NOT EXISTS idx_mall_sales_day ON mall_sales(day);

      -- 全服库存计数（#846）：**运行时**表，不进 config-sync.sql
      -- 只记「卖了几件」，总量在 mall_goods.stock（运营改小 = 立刻停售，改大 = 续货）。
      -- 单独一张表而不是 mall_goods 一列：同上的快照覆盖问题，且这样「重置库存」= 把这里清零，
      -- 与「改配置」是两件不同的事（后者会让客户端配置版本 +1）。
      CREATE TABLE IF NOT EXISTS mall_stock (
        good_id    TEXT    PRIMARY KEY,
        sold       INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      -- 时装配置（#257）：主键是时装 id（config-sync.sql），清单固定不可增删行；
      -- 名称 / 文案 / 售卖价 / 属性 / 获得渠道 seed 自生成物 FASHIONS，运营可改；
      -- icon / in / out 是客户端资源路径（表现层），后台不改
      CREATE TABLE IF NOT EXISTS fashions (
        id                   TEXT    PRIMARY KEY,
        label                TEXT    NOT NULL DEFAULT '',
        description          TEXT    NOT NULL DEFAULT '',
        icon                 TEXT    NOT NULL DEFAULT '',
        in_res               TEXT    NOT NULL DEFAULT '',
        out_res              TEXT    NOT NULL DEFAULT '',
        sell_price           INTEGER NOT NULL DEFAULT 0,
        acquire_channel      TEXT    NOT NULL DEFAULT 'unavailable',
        max_hp               INTEGER NOT NULL DEFAULT 0,
        hp_recover           INTEGER NOT NULL DEFAULT 0,
        physical_attack_min  INTEGER NOT NULL DEFAULT 0,
        physical_attack_max  INTEGER NOT NULL DEFAULT 0,
        magic_attack_min     INTEGER NOT NULL DEFAULT 0,
        magic_attack_max     INTEGER NOT NULL DEFAULT 0,
        taoist_attack_min    INTEGER NOT NULL DEFAULT 0,
        taoist_attack_max    INTEGER NOT NULL DEFAULT 0,
        physical_defense_min INTEGER NOT NULL DEFAULT 0,
        physical_defense_max INTEGER NOT NULL DEFAULT 0,
        magic_defense_min    INTEGER NOT NULL DEFAULT 0,
        magic_defense_max    INTEGER NOT NULL DEFAULT 0,
        taoist_defense_min   INTEGER NOT NULL DEFAULT 0,
        taoist_defense_max   INTEGER NOT NULL DEFAULT 0,
        updated_at           INTEGER NOT NULL DEFAULT 0
      );

      -- 具名掉落表（#254）：主键是表 id（出厂值见 config-sync.sql 的 common/elite/boss + 兜底 default）；
      -- **允许动态增删**（运营自建新表给多怪复用，同 mall_prices 定位），
      -- 被 monster_drops.table_id 引用中的行在 service 拒删
      CREATE TABLE IF NOT EXISTS drop_tables (
        id         TEXT    PRIMARY KEY,
        picks      TEXT    NOT NULL DEFAULT '1',
        entries    TEXT    NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      -- 每怪掉落配置（#254）：主键是怪物 key（= monsters.id，与怪物一一对应不可增删行）；
      -- source 标注 table / entries / none 三态，seed 自生成物 MONSTER_DROPS（220 只全内联）；
      -- 后台 PATCH 整份替换，将来的服务端掉落结算直读本表
      CREATE TABLE IF NOT EXISTS monster_drops (
        monster_key TEXT    PRIMARY KEY,
        source      TEXT    NOT NULL DEFAULT 'none',
        table_id    TEXT,
        picks       TEXT,
        entries     TEXT,
        updated_at  INTEGER NOT NULL DEFAULT 0,
        -- 掉落整体强制绑定（#789）：1 = 这只怪掉出来的东西一律绑定角色（同样必须在最后一列）
        bind_drops  INTEGER NOT NULL DEFAULT 0
      );

      -- 技能（#367）：owner 区分角色 / 怪物，同一张表 —— 技能对两边完全同构，
      -- 拆两张表只会让「同一个技能既给人又给怪」变成复制。
      -- 角色行 seed 自生成物 SKILLS（id 被技能栏 / 快捷键 / 角色存档引用，不可增删）；
      -- damage_coefficients 是 JSON（下标 = 技能等级），status_id 非空 = 释放后给自己挂状态。
      CREATE TABLE IF NOT EXISTS skills (
        id                  TEXT    PRIMARY KEY,
        owner               TEXT    NOT NULL DEFAULT 'role',
        label               TEXT    NOT NULL DEFAULT '',
        icon                TEXT    NOT NULL DEFAULT '',
        category            TEXT    NOT NULL DEFAULT 'attack',
        target_type         TEXT    NOT NULL DEFAULT 'single',
        action              TEXT    NOT NULL DEFAULT '',
        effect              TEXT    NOT NULL DEFAULT '',
        effect_on_self      INTEGER NOT NULL DEFAULT 0,
        cooldown            REAL    NOT NULL DEFAULT 1,
        mp_cost             INTEGER NOT NULL DEFAULT 0,
        distance            REAL    NOT NULL DEFAULT 0,
        level_req           INTEGER NOT NULL DEFAULT 1,
        description         TEXT    NOT NULL DEFAULT '',
        damage_coefficients TEXT    NOT NULL DEFAULT '[]',
        status_id           TEXT    NOT NULL DEFAULT '',
        cast_lock_ms        INTEGER NOT NULL DEFAULT 0,
        require_target      INTEGER NOT NULL DEFAULT 1,
        can_auto            INTEGER NOT NULL DEFAULT 0,
        occupation          TEXT    NOT NULL DEFAULT '4',
        push_distance       REAL    NOT NULL DEFAULT 0,
        push_chance         REAL    NOT NULL DEFAULT 1,
        -- 暴击与破防（#826）：技能自带的暴击率 / 暴击倍率 / 无视防御比例。
        -- crit_damage = 0 表示「用角色那一份」，不覆盖角色属性；def_ignore = 1 等于无视全部防御。
        crit_rate           REAL    NOT NULL DEFAULT 0,
        crit_damage         REAL    NOT NULL DEFAULT 0,
        def_ignore          REAL    NOT NULL DEFAULT 0,
        -- 两段连击（#826 第三批）：第二段的伤害 = 第一段 × 这个系数，0 = 没有第二段。
        -- 系数而不是绝对伤害：第一段吃攻击区间随机与暴击，第二段必须跟着同一份随机走，
        -- 否则「同一次出手两段伤害差得比换装备还多」。
        second_hit_ratio    REAL    NOT NULL DEFAULT 0,
        -- 拉人（#826 第三批）：把目标朝施法者拉回多少像素，0 = 不拉。与 push_distance
        -- 方向相反（推是远离施法者），两者可以同时配（先拉后推这种技能不常见，但语义不冲突）
        pull_distance       REAL    NOT NULL DEFAULT 0,
        updated_at          INTEGER NOT NULL DEFAULT 0
      );

      -- 状态（#367）：同样 owner 区分角色 / 怪物；combat 是 JSON 数值修正
      -- （格挡概率 / 格挡系数 / 防御倍率，口径见客户端 types/status 与 BattleMath）
      CREATE TABLE IF NOT EXISTS statuses (
        id               TEXT    PRIMARY KEY,
        owner            TEXT    NOT NULL DEFAULT 'role',
        label            TEXT    NOT NULL DEFAULT '',
        icon             TEXT    NOT NULL DEFAULT '',
        duration         REAL    NOT NULL DEFAULT 0,
        source           TEXT    NOT NULL DEFAULT 'skill',
        description      TEXT    NOT NULL DEFAULT '',
        effect           TEXT    NOT NULL DEFAULT '',
        effect_hold_last INTEGER NOT NULL DEFAULT 0,
        combat           TEXT    NOT NULL DEFAULT '{}',
        -- 三类状态 + 周期效果 + 控制（#826 第三批，docs/22 §2.3）
        -- kind：damage（周期伤害）/ control（控制）/ speed（加减速）/ buff（纯数值，默认）
        kind             TEXT    NOT NULL DEFAULT 'buff',
        -- 最大层数：1 = 不叠（旧行为）。同 id 再加一层 → +1 并刷新到期，不超过这个数
        max_stacks       INTEGER NOT NULL DEFAULT 1,
        -- 周期触发间隔（毫秒，0 = 无周期）与每拍做什么：{hp:-50} / {mp:+20} / {hpPercent:-0.02}
        tick_ms          INTEGER NOT NULL DEFAULT 0,
        tick_effect      TEXT    NOT NULL DEFAULT '{}',
        -- 控制标记：{stun:1, root:1, silence:1}。stun = 禁移动 + 禁出手，root = 只禁移动，
        -- silence = 只禁出手。眩晕与麻痹在服务端是同一条判据（都是 stun），只是来源 / 图标不同
        control_flags    TEXT    NOT NULL DEFAULT '{}',
        updated_at       INTEGER NOT NULL DEFAULT 0
      );

      -- 怪物技能挂载（#372）：哪只怪放哪些技能 + 优先级 + 冷却覆写。
      -- 与技能表分家的原因：技能行可被多只怪共用（同表 owner=monster），挂载是关系不是属性。
      -- 复合主键 = 一只怪同一个技能只能挂一次；整份替换时删掉的行就是「不放了」。
      CREATE TABLE IF NOT EXISTS monster_skills (
        monster_key      TEXT    NOT NULL,
        skill_id         TEXT    NOT NULL,
        priority         INTEGER NOT NULL DEFAULT 0,
        cooldown         REAL,
        updated_at       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (monster_key, skill_id)
      );

      -- 帮会（#388，社交 epic #387 刀一）：一个角色只能在一个帮会里，
      -- 这条由 guild_members 的唯一索引约束，不靠业务自觉。
      -- level / funds 只占位（帮会等级与资金不在这一刀），写业务前先想清楚它们由谁改。
      CREATE TABLE IF NOT EXISTS guilds (
        id         TEXT PRIMARY KEY,
        -- 所属区（#958）：建帮时取帮主角色的区，成员 / 列表 / 申请全按它收口。
        -- 名字仍然**全局唯一**（跨区同名会让搜索、举报、客服沟通无法区分）
        zone_id    INTEGER NOT NULL DEFAULT 1,
        name       TEXT NOT NULL UNIQUE,
        notice     TEXT NOT NULL DEFAULT '',
        leader_id  TEXT NOT NULL,
        level      INTEGER NOT NULL DEFAULT 1,
        funds      INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- 成员：复合主键 = 同一个人在同一个帮会里只有一行；role_id 唯一 = 一个人只能在一个帮会
      CREATE TABLE IF NOT EXISTS guild_members (
        guild_id  TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        role_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        rank      TEXT NOT NULL DEFAULT 'member',
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, role_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_members_role ON guild_members(role_id);

      -- 入帮申请：同一人对同一帮会只留一条（重复申请 = 覆盖留言，不堆积）
      CREATE TABLE IF NOT EXISTS guild_applications (
        guild_id   TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
        role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        message    TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, role_id)
      );

      -- 社交：好友与敌人（#389）
      CREATE TABLE IF NOT EXISTS role_friends (
        role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        friend_id  TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        -- pending 待处理 / accepted 已互为好友
        status     TEXT NOT NULL DEFAULT 'pending',
        -- 这一对是谁发起的（同意 / 拒绝都要知道「谁在等我」）
        requested_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (role_id, friend_id)
      );
      CREATE TABLE IF NOT EXISTS role_enemies (
        role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        enemy_id   TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (role_id, enemy_id)
      );

      -- 屏蔽 / 拉黑（#398）：单向一行（同 role_enemies 口径）——我拉黑我的，对方既不知道
      -- 也不受影响。过滤由服务端做（聊天投递前剔除、互见帧按观看者剔除），客户端拿不到
      -- 「谁拉黑了我」这层信息，也就没法据此反制
      CREATE TABLE IF NOT EXISTS role_blocks (
        role_id         TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        blocked_role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (role_id, blocked_role_id)
      );
      -- 反查「谁拉黑了我」：聊天 / 互见的过滤只看正向（我拉黑了谁），
      -- 这个索引留给好友申请的准入判定（他不该看到我拉黑他的人发来的申请）
      CREATE INDEX IF NOT EXISTS idx_role_blocks_blocked ON role_blocks(blocked_role_id);

      -- 举报（#398）：只落库 + 管理端只读列表，**不做自动处罚**（判定交给人）
      -- 刻意不加角色外键：被举报的人 / 举报的人被删号后，这条记录仍要能查（证据不该随人消失），
      -- 名字在查询时 LEFT JOIN 出来，查不到就显示 id
      CREATE TABLE IF NOT EXISTS role_reports (
        id               TEXT PRIMARY KEY,
        role_id          TEXT NOT NULL,
        target_role_id   TEXT NOT NULL,
        category         TEXT NOT NULL DEFAULT 'other',
        reason           TEXT NOT NULL DEFAULT '',
        status           TEXT NOT NULL DEFAULT 'pending',
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_role_reports_created ON role_reports(created_at);
      CREATE INDEX IF NOT EXISTS idx_role_reports_pair ON role_reports(role_id, target_role_id);

      -- 队伍（#399）：两张表 —— 队伍本体（谁建的 / 谁是队长）与成员表（谁在队里）
      -- 与聊天 / 拾取那种纯内存账本不同，队伍**落库**：实时进程一重启就把所有人的队伍清空
      -- 说不过去（重连回来还在同一个队才符合预期），而且存档进程也要能读到它。
      -- 队长的唯一写者就是 parties.leader_role_id（成员表不存 is_leader，否则两个写者会漂）
      CREATE TABLE IF NOT EXISTS parties (
        id             TEXT PRIMARY KEY,
        leader_role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        created_at     INTEGER NOT NULL
      );
      -- role_id UNIQUE = 一个角色只能在一个队里：把「一人一队」交给数据库，
      -- 业务代码就不用每次并发加入前先查一遍再写（查了也会被并发穿过去）
      CREATE TABLE IF NOT EXISTS party_members (
        party_id  TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        role_id   TEXT NOT NULL UNIQUE REFERENCES roles(id) ON DELETE CASCADE,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (party_id, role_id)
      );
      CREATE INDEX IF NOT EXISTS idx_party_members_party ON party_members(party_id);

      -- 任务配置（#396，epic #394）：quests 表是管理端「任务配置」的可改层，
      -- seed 来自共享快照 QUESTS（INSERT OR IGNORE，运营改过的行不会被重启覆盖）；
      -- 允许动态增删，被 quest_progress 引用中的行在业务层拒删
      CREATE TABLE IF NOT EXISTS quests (
        id              TEXT    PRIMARY KEY,
        kind            TEXT    NOT NULL DEFAULT 'main',
        label           TEXT    NOT NULL DEFAULT '',
        description     TEXT    NOT NULL DEFAULT '',
        prev_quest_id   TEXT    NOT NULL DEFAULT '',
        min_level       INTEGER NOT NULL DEFAULT 1,
        npc_id          TEXT    NOT NULL DEFAULT '',
        objective_type  TEXT    NOT NULL DEFAULT 'kill',
        objective_target TEXT   NOT NULL DEFAULT '',
        objective_count INTEGER NOT NULL DEFAULT 1,
        reward_bind_gold INTEGER NOT NULL DEFAULT 0,
        reward_exp      INTEGER NOT NULL DEFAULT 0,
        reward_items    TEXT    NOT NULL DEFAULT '[]',
        updated_at      INTEGER NOT NULL DEFAULT 0
      );

      -- 任务进度状态机（#396）：可接 = 无行；accepted 进行中 → ready 可交付 → claimed 已领奖。
      -- **daily 与 main 一样保留 claimed 行**（#815）：删行就把「今天领过」的证据一起删了，
      -- 闸门只能另建计数器。保留行 + reset_day（每日 05:00 切日）天然一行一状态、天然可审计。
      -- 不加 REFERENCES quests(id) 外键：任务下架不该连带抹掉玩家进度历史
      CREATE TABLE IF NOT EXISTS quest_progress (
        role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        quest_id   TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'accepted',
        progress   INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER,
        reset_day  INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (role_id, quest_id)
      );
      CREATE INDEX IF NOT EXISTS idx_quest_progress_quest ON quest_progress(quest_id);

      -- 成就配置（#401，epic #394）：achievements 表是管理端「成就配置」的可改层，
      -- seed 来自共享快照 ACHIEVEMENTS（INSERT OR IGNORE，运营改过的行不会被重启覆盖）；
      -- 允许动态增删，被 role_achievements 引用中的行在业务层拒删
      CREATE TABLE IF NOT EXISTS achievements (
        id               TEXT    PRIMARY KEY,
        category         TEXT    NOT NULL DEFAULT 'battle',
        label            TEXT    NOT NULL DEFAULT '',
        description      TEXT    NOT NULL DEFAULT '',
        condition_type   TEXT    NOT NULL DEFAULT 'kill',
        condition_target TEXT    NOT NULL DEFAULT '',
        condition_count  INTEGER NOT NULL DEFAULT 1,
        reward_bind_gold INTEGER NOT NULL DEFAULT 0,
        reward_exp       INTEGER NOT NULL DEFAULT 0,
        reward_items     TEXT    NOT NULL DEFAULT '[]',
        sort_order       INTEGER NOT NULL DEFAULT 0,
        hidden           INTEGER NOT NULL DEFAULT 0,
        updated_at       INTEGER NOT NULL DEFAULT 0
      );

      -- 成就进度（#401）：只有**累计型**条件（kill / quest）在这里落进度 ——
      -- 状态型（level / combat / collect）每次查询按角色当前状态现算，存投影只会得到
      -- 「角色变强了进度没动」的死数据。
      -- achieved_at 非空 = 已达成（可领）；claimed_at 非空 = 已领奖（不可重复领）。
      -- 不加 REFERENCES achievements(id) 外键：成就下架不该连带抹掉玩家的达成记录
      CREATE TABLE IF NOT EXISTS role_achievements (
        role_id        TEXT    NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        achievement_id TEXT    NOT NULL,
        progress       INTEGER NOT NULL DEFAULT 0,
        achieved_at    INTEGER,
        claimed_at     INTEGER,
        updated_at     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (role_id, achievement_id)
      );
      CREATE INDEX IF NOT EXISTS idx_role_achievements_achievement ON role_achievements(achievement_id);

      -- 游戏内邮件（#429）：与上面的 mail_queue（外发 SMTP 投递队列）**不是一回事** ——
      -- 那张表是「把信发到玩家注册邮箱」，这张表是「玩家在游戏里打开的收件箱」。
      -- 附件（绑定元宝 / 经验 / attachments）在**领取时**才入包：先领后删，未领的邮件带着附件留在箱里。
      CREATE TABLE IF NOT EXISTS role_mails (
        id          TEXT    PRIMARY KEY,
        role_id     TEXT    NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        -- 玩家看到的频道（#436）：system / reward / social / combat，四个枚举必须收敛
        channel     TEXT    NOT NULL DEFAULT 'system',
        kind        TEXT    NOT NULL DEFAULT 'system',
        title       TEXT    NOT NULL DEFAULT '',
        body        TEXT    NOT NULL DEFAULT '',
        bind_gold   INTEGER NOT NULL DEFAULT 0,
        exp         INTEGER NOT NULL DEFAULT 0,
        attachments TEXT    NOT NULL DEFAULT '[]',
        read_at     INTEGER,
        claimed_at  INTEGER,
        -- 收件箱保质期（#439）：毫秒时间戳，NULL = 永不过期。
        -- 与 mail_queue 的 MAIL_RETENTION_DAYS（投递记录保留期）是两件事，别混
        expires_at  INTEGER,
        -- 过期前自动入包（#867）：到期前 3 天由 GameMailAutoClaimService 把奖励塞进背包。
        -- 只存「结果」两列，不存「计划时刻」—— 那个由 expires_at 减 3 天唯一决定，
        -- 落库就是第二份真相（改了提前量还得刷全表）。0 = 还没成功过
        auto_claimed_at     INTEGER NOT NULL DEFAULT 0,
        -- 失败次数（背包满 / 乐观锁冲突）。到上限就停手，邮件留在箱里等人工 —— 绝不「悄悄删掉」
        auto_attempts       INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL DEFAULT 0
      );
      -- 收件箱永远按「这个角色 + 时间倒序」取，未领数也用得上 claimed_at
      CREATE INDEX IF NOT EXISTS idx_role_mails_box ON role_mails(role_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_role_mails_unclaimed ON role_mails(role_id, claimed_at);
      -- 自动入包的扫描键：只有「有保质期且还没领」的行会被扫到（部分索引，别全表扫）
      CREATE INDEX IF NOT EXISTS idx_role_mails_auto ON role_mails(expires_at) WHERE claimed_at IS NULL;

      -- 客户端运行时参数（#605）：单行表（id 恒为 1），三个分组各一列 JSON。
      -- drop / autoBattle 服务端不消费（只随配置快照下发，客户端用来调手感）；
      -- guild 是**服务端校验门槛**（帮会名 / 公告 / 申请留言长度），客户端读到只为提前提示。
      -- 存 JSON 而不是 22 个列：参数按分组增删频繁，加一个参数不该动表结构。
      CREATE TABLE IF NOT EXISTS runtime_params (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        -- 列名带后缀：drop 是 SQL 保留字，裸用会让整段建表 SQL 语法错（第一次就踩了）
        drop_params TEXT    NOT NULL DEFAULT '{}',
        auto_battle TEXT    NOT NULL DEFAULT '{}',
        guild_rules TEXT    NOT NULL DEFAULT '{}',
        -- 怪物 AI（#655）：攻击间隔 / 攻击距离 / 游荡半径… 原本是生成物 'MONSTER_AI'
        -- 的六个常量，服务端权威 AI 每 tick 读它。进这里而不是另开一张表：它同样是
        -- 「一进程一份、运营可调的参数」，与上面三组同性质
        monster_ai  TEXT    NOT NULL DEFAULT '{}',
        -- 位移校验（#811）：档位 + 速度上限 + 容差 + 穿墙开关 + 拉回节流。
        -- 与 monster_ai 同性质（一进程一份、运营可调、服务端独占、不进客户端快照），
        -- 所以进这一行而不是另开一张表
        movement    TEXT    NOT NULL DEFAULT '{}',
        updated_at  INTEGER NOT NULL DEFAULT 0
      );

      -- 战斗力权重（#605）：属性名 → 倍率，**一个属性一行**。
      -- 为什么是 KV 行而不是单行宽表：键就是属性名（maxHp / physicalAttack …），
      -- 与快照 combatWeights 段（Record<string, number>）1:1，将来多一个权重属性
      -- 只多一行、不动表结构；读写都是「按 key 取」，不需要知道总共有几列。
      -- 出厂值在 config-sync.sql（生成物 COMBAT_WEIGHTS 的源头），缺行回落出厂。
      CREATE TABLE IF NOT EXISTS combat_weights (
        key        TEXT PRIMARY KEY,
        weight     REAL    NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      -- 新手引导步骤（#605）：单行表，整张步骤表存一列 JSON 数组。
      -- 为什么整表一列而不是一行一步：步骤是**有序的一小张表**（出厂 6 步、上限 64 步），
      -- 运营调的是「顺序 / 文案 / 高亮位 / 推进事件」，整份保存比逐行增删更贴近编辑动作
      -- （与 equipment_meta 的回收价曲线同一手法）。行内顺序即体验顺序。
      CREATE TABLE IF NOT EXISTS guide_settings (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        steps      TEXT    NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      -- 装备外观（#695）：单行表，「哪个前后缀组合用哪个边框 / 详情背景」+「哪件特殊装备单独用哪个」。
      -- 四组各存一列 JSON 数组（15 组合 ×2 + 特殊装备自定义 ×2）；素材本体在客户端资源包，
      -- 服务端只存 key 字符串（与音效路径入库同一取向）。出厂值由服务常量 seed（INSERT OR IGNORE）。
      CREATE TABLE IF NOT EXISTS equipment_appearance (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        borders             TEXT    NOT NULL DEFAULT '[]',
        backgrounds         TEXT    NOT NULL DEFAULT '[]',
        custom_borders      TEXT    NOT NULL DEFAULT '[]',
        custom_backgrounds  TEXT    NOT NULL DEFAULT '[]',
        border_items        TEXT    NOT NULL DEFAULT '[]',
        background_items    TEXT    NOT NULL DEFAULT '[]',
        updated_at          INTEGER NOT NULL DEFAULT 0
      );

      -- 角色身上生效中的状态（#822 / docs/22 A4）：**运行时表**，不是配置表 ——
      -- 不进快照、不进 config-sync，也不参与存档 v3 的迁移（存档里的 roles.data 没有它）。
      -- 一条 = 一个角色身上的一个状态（同 id 不并存：重复获得是叠层 + 刷新到期，不是新增行），
      -- 到期由读取方惰性清理 + 服务端每 5 秒扫一次（见 RoleStatusService）。
      -- 为什么落库而不是进程内 Map：怪物那份状态是「这只怪这一轮的表现」，掉线/重启丢掉无所谓；
      -- 角色状态会改结算（防御倍率 / 格挡），重启后凭空消失等于「登录即被白打一刀」，
      -- 而它又要跨两个进程读（存档进程死亡清、实时进程结算读），只能落库。
      CREATE TABLE IF NOT EXISTS role_status (
        role_id      TEXT    NOT NULL,
        status_id    TEXT    NOT NULL,
        stacks       INTEGER NOT NULL DEFAULT 1,
        expire_at    INTEGER NOT NULL,          -- 毫秒；服务端权威时间，不看客户端时钟
        source_skill TEXT    NOT NULL DEFAULT '',
        -- 周期效果的记账（#826 第三批）：上一次结算到的时刻（毫秒）。用「上次结算点 + tick_ms」
        -- 而不是「到期时间取模」—— 后者在重复获得刷新到期后，会把已经算过的拍子重算一遍
        ticked_at    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (role_id, status_id)
      );
      -- 清扫与「这个角色现在还有什么」都按这两列走
      CREATE INDEX IF NOT EXISTS idx_role_status_expire ON role_status(expire_at);
    `);

    // 存量库补列（CREATE TABLE IF NOT EXISTS 不会改已有表结构）
    // 边框 / 背景的实体注册表（#714）：清单本体住在列表页，棋盘与自定义表只引用 key ——
    // 出厂空表，读取时自动把被引用的 key 补进清单（老数据与 config-sync 出厂数据都不用迁移）
    this.ensureColumn("equipment_appearance", "border_items", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("equipment_appearance", "background_items", "TEXT NOT NULL DEFAULT '[]'");
    // 暴击 / 破防（#826）：存量库补列后默认 0 —— 老行等于「不暴击、不破防」，行为与改动前一致
    this.ensureColumn("skills", "crit_rate", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("skills", "crit_damage", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("skills", "def_ignore", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("admins", "role", `TEXT NOT NULL DEFAULT '${AdminRole.ADMIN}'`);
    // 修订号（乐观锁）：存量库补列后老角色都是 1，客户端读到 1 推回来也是 1，不会误判冲突
    this.ensureColumn("roles", "revision", "INTEGER NOT NULL DEFAULT 1");
    // 令牌版本号（改密即失效旧令牌）：存量库补列后默认 0，而存量令牌里没有 ver 字段也按 0 处理，两者一致
    this.ensureColumn("accounts", "token_version", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("admins", "token_version", "INTEGER NOT NULL DEFAULT 0");
    // 上次作业区（#960）：管理端不绑区，但下拉框要记住上次的选择。存量管理员留 NULL，
    // 登录页会回退到第一个可选区（不写死 1：一区可能已经被合并了）
    this.ensureColumn("admins", "last_zone_id", "INTEGER");
    this.ensureColumn("audit_logs", "zone_id", "INTEGER");
    // 区服运营字段（#960）：P5 的开区 / 关区 / 排序先只需要这两个 ——
    // 存量区一律 open（历史上没有「关区」这个概念）
    this.ensureColumn("zones", "status", "TEXT NOT NULL DEFAULT 'open'");
    this.ensureColumn("zones", "sort", "INTEGER NOT NULL DEFAULT 0");
    // 封禁闭环：原因 / 到期时间（null = 永久）/ 执行人 / 执行时间
    this.ensureColumn("accounts", "ban_reason", "TEXT");
    this.ensureColumn("accounts", "ban_until", "INTEGER");
    this.ensureColumn("accounts", "banned_by", "TEXT");
    this.ensureColumn("accounts", "banned_at", "INTEGER");
    // 玩家邮箱（个人信息）：可空；大小写不敏感唯一（同一邮箱只绑一个账号，未填写不限）
    this.ensureColumn("accounts", "email", "TEXT");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(LOWER(email)) WHERE email IS NOT NULL;",
    );
    // 当前浏览区（#295 阶段二 → #957 降级）：存量账号全部归入一区。
    // **它不是归属**：角色属于哪个区只认 `roles.zone_id`；这一列只决定「选角页拉哪个区的角色」。
    this.ensureColumn("accounts", "active_zone_id", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("world_monsters", "zone_id", "INTEGER NOT NULL DEFAULT 1");
    // 在线心跳（#547）：与 online_role_id 同生同灭。补列后存量在线标记的心跳是 NULL，
    // 而「NULL 心跳」在清算判据里等于已过期 —— 直接上线会把所有在线玩家 mass kick。
    // 这里垫成启动时刻，给活连接一个完整宽限窗让实时进程接管续约；真死连接宽限期后照清。
    this.ensureColumn("accounts", "online_heartbeat_at", "INTEGER");
    this.db
      .prepare("UPDATE accounts SET online_heartbeat_at = ? WHERE online_role_id IS NOT NULL AND online_heartbeat_at IS NULL")
      .run(Date.now());

    // 消息频道（#436）：存量邮件按 kind 回填一次 —— 成就兜底的邮件属于「奖励」频道，
    // 其余留在「系统」。幂等：只动「还是默认值且来源已明确」的行
    this.ensureColumn("role_mails", "channel", "TEXT NOT NULL DEFAULT 'system'");
    this.db.exec("UPDATE role_mails SET channel = 'reward' WHERE kind = 'achievement' AND channel = 'system'");
    // 收件箱保质期（#439）：存量行全是 NULL = 永不过期（与「没有该字段」同义，老邮件不因为补列而消失）
    this.ensureColumn("role_mails", "expires_at", "INTEGER");
    // 过期前自动入包（#867）：两列都是「结果」，0 = 没有过。存量行不动（老邮件按老口径走：
    // 没 `expires_at` 就不会被扫到）。部分索引也在这里补 —— 老库的 CREATE TABLE 阶段过去了
    this.ensureColumn("role_mails", "auto_claimed_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("role_mails", "auto_attempts", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_role_mails_auto ON role_mails(expires_at) WHERE claimed_at IS NULL",
    );
    // 击杀数（#400）：排行榜的原料。放在 roles 行上而不是独立表 —— 写路径唯一（结算时 +1），
    // 客户端的存档覆盖（PUT /roles/:id 换 data）压根碰不到这一列，多一张表只会多一次 join。
    this.ensureColumn("roles", "kills", "INTEGER NOT NULL DEFAULT 0");
    // 坏档标记（#819 / I6）：`data` 这列解析不出来时置 1，进入游戏直接被拒（20029），
    // 等人工把 JSON 修好、下一次解析成功再自动清掉。**不删行、不改 data** ——
    // 删行是「毁掉证据」，改 data 是「把坏档洗成空档」，两者都让事后查不清发生了什么
    this.ensureColumn("roles", "corrupted", "INTEGER NOT NULL DEFAULT 0");
    // NPC 外观（#603 第七域）：客户端不再存素材目录 / 缩放 / 偏移，老库补列；
    // src 先落空串，随后由 GameConfigService.seedNpcs 的 backfillAppearance 填（只在空串时填）
    this.ensureColumn("npcs", "src", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("npcs", "scale_x", "REAL NOT NULL DEFAULT 1");
    this.ensureColumn("npcs", "scale_y", "REAL NOT NULL DEFAULT 1");
    this.ensureColumn("npcs", "pos_x", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("npcs", "pos_y", "REAL NOT NULL DEFAULT 0");
    // 装备显示与规则字段（#603 第九域）：老库只有名称与数值，补列后由 seedEquipments 的
    // backfillAppearance 一次性回填（只在 icon 还是空串时填 —— 见那个方法的注释）
    this.ensureColumn("equipments", "occupation", "TEXT NOT NULL DEFAULT '4'");
    this.ensureColumn("equipments", "sex", "TEXT NOT NULL DEFAULT '3'");
    this.ensureColumn("equipments", "description", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("equipments", "icon", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("equipments", "in_atlas", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("equipments", "out_atlas", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("equipments", "tags", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("equipments", "in_pos_x", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("equipments", "in_pos_y", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("equipments", "in_scale_x", "REAL NOT NULL DEFAULT 1");
    this.ensureColumn("equipments", "in_scale_y", "REAL NOT NULL DEFAULT 1");
    this.ensureColumn("equipments", "in_rotate", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("equipments", "out_scale", "REAL NOT NULL DEFAULT 1");
    this.ensureColumn("equipments", "out_positions", "TEXT NOT NULL DEFAULT '[]'");
    // 线（#809）：存量行全落公共线 `'0'`（分线 / 副本是本刀之后的事）。补列必须在这条
    // 迁移之前 —— 它要把 slot 一起写进新的 instanceId（`m3_z1_c0_12`）
    this.ensureColumn("world_monsters", "slot", "TEXT NOT NULL DEFAULT '0'");
    this.migrateWorldMonsterInstanceIds();
    // 药品 / 物品图标（#603 第十域）：客户端不再存图标（它拼不出 `item/drug-hp-1` 这类路径，
    // 与地图 / 特效那种「能按 id 推导」的不同）—— 老库补列后由 seedDrugs / seedItems
    // 的 backfillIcon 一次性回填（只在 icon 还是空串时填）
    this.ensureColumn("drugs", "icon", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("items", "icon", "TEXT NOT NULL DEFAULT ''");
    // 技能职业归属与击退距离（#603 第十一域）：客户端技能栏按 occupation 重建「职业→技能」映射，
    // push_distance 以前只写在客户端配置里（快照不覆盖它），不补列这两项会一起丢
    this.ensureColumn("skills", "occupation", "TEXT NOT NULL DEFAULT '4'");
    this.ensureColumn("skills", "push_distance", "REAL NOT NULL DEFAULT 0");
    // 撞飞概率（#826 第二批）：0 = 从不撞飞，1 = 必撞；带 DEFAULT，存量行自动补 1（必推，与旧行为一致）
    this.ensureColumn("skills", "push_chance", "REAL NOT NULL DEFAULT 1");
    // 两段连击 / 拉人（#826 第三批）：默认 0 = 都没有，存量行行为不变
    this.ensureColumn("skills", "second_hit_ratio", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("skills", "pull_distance", "REAL NOT NULL DEFAULT 0");
    // 状态的三类 + 层数 + 周期 + 控制（#826 第三批）：默认值都是「旧行为」——
    // kind=buff（不参与任何分流）、max_stacks=1（不叠）、tick_ms=0（无周期）、flags 空（无控制）
    this.ensureColumn("statuses", "kind", "TEXT NOT NULL DEFAULT 'buff'");
    this.ensureColumn("statuses", "max_stacks", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("statuses", "tick_ms", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("statuses", "tick_effect", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("statuses", "control_flags", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("role_status", "ticked_at", "INTEGER NOT NULL DEFAULT 0");
    // 世界坐标口径（#566）：存量库补列时落到旧口径 'center'，紧接着由 migrateMapCoordinateOrigin 抹平
    this.ensureColumn("world_meta", "coord_origin", "TEXT NOT NULL DEFAULT 'center'");
    this.migrateMapCoordinateOrigin();
    // 复活点（#672）：可空 —— NULL 就是「这张图没有复活点」，不能垫 0（(0,0) 是图左上角那个点，
    // 会变成「一进图就飞到角上」）。存量库的初值由 migrate-map-points.cjs 从 TMX 对象组灌一次
    this.ensureColumn("maps", "revive_cx", "REAL");
    this.ensureColumn("maps", "revive_cy", "REAL");
    // 曲线退场的收尾（#655）：老库的这两张表还留着就会让人以为「还能改」—— 每次启动顺手清掉
    // （`IF EXISTS`，新库就是两条空操作；数据早已由快照灌进 role_levels）
    this.db.exec("DROP TABLE IF EXISTS level_exps; DROP TABLE IF EXISTS growth_segments;");
    // 回收价曲线同样下架（#655）：老库 equipment_meta 里还留着 recycle_curve 列，
    // 导出是 `SELECT *`，不删列它就会一直躺在 config-sync.sql 里
    this.dropColumnIfExists("equipment_meta", "recycle_curve");
    // 品质文字颜色收管理端（#720）：存量库补列（空数组 = 客户端按内置色渲染，零迁移）
    this.ensureColumn("equipment_meta", "prefix_colors", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("equipment_meta", "suffix_colors", "TEXT NOT NULL DEFAULT '[]'");
    // 称号成长列表顺序（#230）：存量库补列；部分唯一索引保证 upgrade 渠道的行不重号（可空行不参与）
    this.ensureColumn("titles", "upgrade_order", "INTEGER");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_titles_upgrade_order ON titles(upgrade_order) WHERE upgrade_order IS NOT NULL;",
    );
    // 战魂成长列表顺序（#234）：存量库补列 + 按阶数回填（37 阶全量在成长列表里，初值 = 阶数）；
    // 正常状态要么全 NULL（新列）、要么全有值（已托管），不会撞部分唯一索引
    this.ensureColumn("souls", "upgrade_order", "INTEGER");
    this.db.exec("UPDATE souls SET upgrade_order = level WHERE upgrade_order IS NULL");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_souls_upgrade_order ON souls(upgrade_order) WHERE upgrade_order IS NOT NULL;",
    );
    // 地图几何 / 对象组（#655）：存量库补列，值由 `node scripts/absorb-generated.cjs` 一次性灌；
    // 新库由 config-sync.sql 直接带过来（快照里就有这几列）
    this.ensureColumn("maps", "grid_cols", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("maps", "grid_rows", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("maps", "tile_width", "INTEGER NOT NULL DEFAULT 128");
    this.ensureColumn("maps", "tile_height", "INTEGER NOT NULL DEFAULT 128");
    this.ensureColumn("maps", "pixel_width", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("maps", "pixel_height", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("maps", "content", `TEXT NOT NULL DEFAULT '{"layers":[],"groups":[]}'`);
    // 怪物 AI 参数（#655）：原本是生成物 `MONSTER_AI` 的六个常量，现在并进运行时参数单行表
    this.ensureColumn("runtime_params", "monster_ai", "TEXT NOT NULL DEFAULT '{}'");
    // 位移校验参数（#811）：存量库补一列空的 '{}'，读取侧缺键按「最小可用值」兜住
    // （`MovementGuardService`），跑一次 `make config-import` 才有出厂档位 `log`
    this.ensureColumn("runtime_params", "movement", "TEXT NOT NULL DEFAULT '{}'");
    // 掉落强制绑定（#789）：五张道具表各一列「掉出来就绑定」+ 每怪一列「这只怪掉的东西都绑定」。
    // 默认 0 = 不强制 —— 存量库补列后行为与之前完全一样（绑定只由 drop_params.bindChance 掷）
    this.ensureColumn("equipments", "bind_on_drop", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("drugs", "bind_on_drop", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("items", "bind_on_drop", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("money_items", "bind_on_drop", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("level_scrolls", "bind_on_drop", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("monster_drops", "bind_drops", "INTEGER NOT NULL DEFAULT 0");
    // 商城限购与库存（#846）：两列都是**配置**，老库存量行补成「不限购 / 不限量」——
    // 与加列前的行为完全一致（否则上线瞬间所有商品都会变成买不了）
    this.ensureColumn("mall_goods", "daily_limit", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("mall_goods", "stock", "INTEGER NOT NULL DEFAULT -1");
    // 日常日切（#815）：存量库补列后老行都是 0（真实天号在 20000 以上），一次性垫成今天 ——
    // 昨天接的日常今天还能交一次，而不是凭空从面板上消失。幂等：天号 0 只可能是补列那一批
    this.ensureColumn("quest_progress", "reset_day", "INTEGER NOT NULL DEFAULT 0");
    // 投放密度曲线与世界侧的区归属（#852）：三列系数空 = 1.0（不改行为），
    // area_id 让 tick 能按区数「这一区现在几只」；存量实例没有值，按出生点反查回填
    this.ensureColumn("map_spawn_areas", "density_peak", "REAL");
    this.ensureColumn("map_spawn_areas", "density_off", "REAL");
    this.ensureColumn("map_spawn_areas", "peak_hours", "TEXT");
    this.ensureColumn("world_monsters", "area_id", "INTEGER");
    // 老行是「表单只有一个数量框 → min = max」，密度上线后这条下限会把系数顶死
    // （`density_off` 再小也降不下来）。一次性抹平，幂等：改成 0 之后不再满足 `min = max`
    this.db.prepare("UPDATE map_spawn_areas SET min = 0 WHERE min = max AND min > 0").run();

    // 货币统一命名（#843、#844）：奖励列与邮件附件列统一挂 bindGold 语汇（存量库一次性改名，幂等）
    this.renameColumnIfExists("quests", "reward_gold", "reward_bind_gold");
    this.renameColumnIfExists("achievements", "reward_gold", "reward_bind_gold");
    this.renameColumnIfExists("role_mails", "gold", "bind_gold");
    this.db.prepare("UPDATE quest_progress SET reset_day = ? WHERE reset_day = 0").run(resetDayOf(Date.now()));
    // 配置版本链（#881 / #882）：两张**运行时**表（不进 config-sync.sql）
    //
    // - `config_version`：单行自增计数器。每次配置写成功后 +1（`ConfigVersionService`），
    //   快照的 ETag 与客户端的「配置是不是变了」都以它为唯一判据 —— 不按时间、不按内容哈希。
    // - `config_revisions`：每层一份**全量配置 JSON**（38 张配置表整块），保留最近 20 层。
    //   存全量而不是 diff：回滚要「一键」，diff 回滚需要按顺序重放，任一环失败就是半套配置。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config_version (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        version    INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS config_revisions (
        version     INTEGER PRIMARY KEY,
        label       TEXT NOT NULL DEFAULT '',
        payload     TEXT NOT NULL,
        byte_size   INTEGER NOT NULL DEFAULT 0,
        table_count INTEGER NOT NULL DEFAULT 0,
        row_count   INTEGER NOT NULL DEFAULT 0,
        created_by  TEXT NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL
      );
    `);
    this.db.exec("INSERT OR IGNORE INTO config_version (id, version, updated_at, updated_by) VALUES (1, 0, 0, '');");
    this.migrateLegacyMallPricing();
    this.ensureRoleNameUnique();
    this.ensureSuperAdmin();
    this.purgeLegacyMoneyItems();
    this.seedMoneyItemsOnce();
    this.seedLevelScrollsOnce();
    this.seedLevelCurvesOnce();
    this.seedCombatStatusesOnce();
    this.seedSkillPointsOnce();
    this.seedAttrPointsOnce();
  }

  /**
   * 帮会绑区的一次性清理（#958）：把「角色区 ≠ 帮会区」的成员与申请移出去
   *
   * 什么时候会存在这些人：帮会绑区之前，成员可以来自任何区（那时帮会没有区），
   * 于是 2 区的角色可能在 1 区的帮会里。绑区之后这些人就成了漏洞 ——
   * 帮会频道跨区喊话、经验分成跨区、列表里出现别区的名字。
   *
   * 处理方式：**移出**而不是给帮会补区，也不是让成员带着帮会跨区搬 ——
   * 帮会归属已按帮主定了，成员只是「站错了地方」。移出必须让玩家知道原因，
   * 所以每人发一封系统邮件（`role_mails` 直插：这一步在启动迁移里，拿不到业务层的服务）。
   *
   * 幂等：清理完之后再跑一次查不到任何行。只在第一次加列时调用（见 onModuleInit）。
   */
  private evictCrossZoneGuildMembers(): void {
    const evicted = this.db
      .prepare(
        `SELECT m.role_id AS role_id, r.name AS role_name, g.name AS guild_name,
                g.zone_id AS guild_zone, r.zone_id AS role_zone
           FROM guild_members m
           JOIN roles r ON r.id = m.role_id
           JOIN guilds g ON g.id = m.guild_id
          WHERE r.zone_id <> g.zone_id`,
      )
      .all() as Array<{
      role_id: string;
      role_name: string;
      guild_name: string;
      guild_zone: number;
      role_zone: number;
    }>;
    if (evicted.length === 0) return;
    const withMail = this.hasTable("role_mails");
    const now = Date.now();
    for (const row of evicted) {
      this.db.prepare("DELETE FROM guild_members WHERE role_id = ?").run(row.role_id);
      if (!withMail) continue;
      this.db
        .prepare(
          `INSERT INTO role_mails
             (id, role_id, channel, kind, title, body, bind_gold, exp, attachments, read_at, claimed_at, expires_at, created_at)
           VALUES (?, ?, 'system', 'guild_zone_reset', ?, ?, 0, 0, '[]', NULL, NULL, NULL, ?)`,
        )
        .run(
          randomUUID(),
          row.role_id,
          "帮会调整通知",
          `你所在的帮会「${row.guild_name}」属于 ${row.guild_zone} 区，而你所在的 ${row.role_zone} 区与它不同区，` +
            `因此已自动退出该帮会。可以在本区重新创建或申请帮会。`,
          now,
        );
    }
    // 跨区申请一并作废（申请本身不跨区，留着只会在审批时炸）
    this.db
      .prepare(
        `DELETE FROM guild_applications
          WHERE role_id IN (SELECT r.id FROM roles r JOIN guilds g ON g.id = guild_applications.guild_id
                             WHERE r.zone_id <> g.zone_id)`,
      )
      .run();
    this.logger.warn(`移出 ${evicted.length} 名跨区帮会成员（已发系统邮件），并清掉跨区入帮申请（#958）`);
  }

  /**
   * 角色名唯一索引：`UNIQUE(account_id, zone_id, name)`（#878 / I3，区维度见 #957）
   *
   * 每区各自唯一：同一个账号在 1 区叫「张三」、2 区也叫「张三」是允许的（区是独立服，
   * 玩家进新区当然想用老名字）。反过来，**同区同账号**重名必须拦住——客户端选角页
   * 只显示名字，同区重名会让人分不清哪个是自己的。
   *
   * 以前重名只靠 `RolesService.create` 里的一次「查了再插」—— 两条并发请求可以双双查到
   * 「没有」，然后各插一行。表上没有约束，应用层的检查就只是**概率**上的检查。
   *
   * 为什么先查重复再建索引：存量库若有并发残留的重复行，直接 `CREATE UNIQUE INDEX` 会抛，
   * 而这一步在 `onModuleInit` 里 —— 崩的是整个进程（服起不来），代价远大于收益。
   * 所以这里的取舍是**不擅自改玩家名字**：报一条 ERROR 把账号与名字列出来、本次不建索引
   * （应用层查重照旧），人工在管理端改名后重启即自动补上。
   */
  private ensureRoleNameUnique(): void {
    const duplicates = this.db
      .prepare(
        "SELECT account_id, zone_id, name, COUNT(1) AS total FROM roles GROUP BY account_id, zone_id, name HAVING COUNT(1) > 1",
      )
      .all() as { account_id: string; zone_id: number; name: string; total: number }[];
    if (duplicates.length > 0) {
      const detail = duplicates.map((row) => `${row.account_id} / z${row.zone_id} / ${row.name} ×${row.total}`).join("；");
      this.logger.error(
        `角色名唯一索引未建立：库里有 ${duplicates.length} 组同账号同名角色（${detail}）。` +
          "这是并发建号留下的重复行 —— 在管理端把这些角色改名后重启即可自动建索引；" +
          "在此之前重名只有应用层查重这一道闸",
      );
      return;
    }
    // 旧的两列索引要显式删掉：同名索引不冲突，但它在的每一天都在阻止「同账号跨区同名」
    this.db.exec("DROP INDEX IF EXISTS idx_roles_account_name");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_account_zone_name ON roles(account_id, zone_id, name)",
    );
  }

  /**
   * 清掉存量库遗留的 legacy 货币物品行（2026-11-11 货币收敛 #843、#844）
   *
   * 货币收敛后 `money_items.currency` 取值域只剩 `bindGold`：旧库里的
   * 旧币种道具行**直接删除**，不做兼容 —— 玩家背包里
   * 已持有的这类道具随之变成死道具（使用时按「格子不是货币道具」拒用）。
   *
   * **每次启动都跑**（不走 `config_meta` marker）：删除是幂等的，残留行多留一秒
   * 就多一秒被使用/被管理端看到的机会；删光后此查询零命中，零成本。
   */
  private purgeLegacyMoneyItems(): void {
    const removed = this.execute("DELETE FROM money_items WHERE currency NOT IN ('bindGold')", []).changes;
    if (removed > 0) this.logger.log(`货币收敛清理：删除旧币种货币物品  条`);
  }

  /**
   * 存量库补「货币物品」出厂 8 条（#785；2026-11-11 收敛后只留绑定元宝 8 档）
   *
   * 这张表是后加的：已经跑过很久的库不会再自举（`config_meta.bootstrap_at` 有值），
   * 只改 `config-sync.sql` 的话存量库重启后表是空的 —— 管理端「货币物品」页空白、
   * 玩家用货币道具也入不了账，而且没有任何报错。
   *
   * **只跑一次**，靠 `config_meta` 的 marker 判定：否则运营删掉一条面值，下次重启它又回来了
   * （INSERT OR IGNORE 只在「已存在」时跳过，管不了「被删过」）。空库不用管 ——
   * `config_meta` 还不存在时直接跳过，随后自举会把快照整份灌进去（DELETE + INSERT）。
   */
  private seedMoneyItemsOnce(): void {
    const hasMeta =
      this.count("SELECT COUNT(1) AS total FROM sqlite_master WHERE type = 'table' AND name = 'config_meta'") > 0;
    if (!hasMeta) return;
    if (this.get<{ value: string }>("SELECT value FROM config_meta WHERE key = ?", ["money_items_seeded"])) return;
    let added = 0;
    // 时间戳取补数据这一刻：管理端「更新时间」列显示 —（1970）会被当成 bug 来报
    const now = Date.now();
    for (const item of MONEY_ITEM_SEEDS) {
      added += this.execute(
        `INSERT OR IGNORE INTO money_items
           (id, label, description, icon, currency, amount, max_stack, sell_price, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [item.id, item.label, item.description, item.icon, item.currency, item.amount, item.maxStack, item.sellPrice, now],
      ).changes;
    }
    this.run("INSERT OR REPLACE INTO config_meta (key, value) VALUES (?, ?)", [
      "money_items_seeded",
      `count:${added}`,
    ]);
    this.logger.log(`存量库补货币物品出厂数据：新增 ${added} 条`);
  }

  /**
   * 存量库补「升级卷轴」出厂 7 卷（#787）
   *
   * 与货币物品同一个套路（表是后加的，存量库不会再自举）。漏了的表现是
   * 管理端「升级卷轴」页空白、玩家拿到卷轴点不动，且没有任何报错。
   *
   * **只跑一次**（`config_meta.level_scrolls_seeded`）：否则运营调过的区间 / 删掉的卷
   * 会在下次重启被出厂值悄悄改回去。
   */
  private seedLevelScrollsOnce(): void {
    const hasMeta =
      this.count("SELECT COUNT(1) AS total FROM sqlite_master WHERE type = 'table' AND name = 'config_meta'") > 0;
    if (!hasMeta) return;
    if (this.get<{ value: string }>("SELECT value FROM config_meta WHERE key = ?", ["level_scrolls_seeded"])) return;
    let added = 0;
    const now = Date.now();
    for (const scroll of LEVEL_SCROLL_SEEDS) {
      added += this.execute(
        `INSERT OR IGNORE INTO level_scrolls
           (id, label, description, icon, min_level, max_level, max_stack, sell_price, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          scroll.id,
          scroll.label,
          scroll.description,
          scroll.icon,
          scroll.minLevel,
          scroll.maxLevel,
          scroll.maxStack,
          scroll.sellPrice,
          now,
        ],
      ).changes;
    }
    this.run("INSERT OR REPLACE INTO config_meta (key, value) VALUES (?, ?)", [
      "level_scrolls_seeded",
      `count:${added}`,
    ]);
    this.logger.log(`存量库补升级卷轴出厂数据：新增 ${added} 条`);
  }

  /**
   * 存量库补「等级曲线」出厂 24 段（#786）
   *
   * 与货币物品同一个套路：表是后加的，存量库不会再自举；只改 `config-sync.sql`
   * 的话重启后 `role_level_curves` 是空的 —— 全服角色属性算成 0、升级永远升不动，
   * 而且没有任何报错（`refreshAll` 只 warn 一行）。
   *
   * **只跑一次**（`config_meta.role_level_curves_seeded`）：否则运营调过的段
   * 会在下次重启被出厂值悄悄改回去。
   */
  private seedLevelCurvesOnce(): void {
    const hasMeta =
      this.count("SELECT COUNT(1) AS total FROM sqlite_master WHERE type = 'table' AND name = 'config_meta'") > 0;
    if (!hasMeta) return;
    if (this.get<{ value: string }>("SELECT value FROM config_meta WHERE key = ?", ["role_level_curves_seeded"])) return;
    const now = Date.now();
    let added = 0;
    for (const segment of ROLE_LEVEL_CURVE_SEEDS) {
      added += this.execute(
        `INSERT OR IGNORE INTO role_level_curves
           (curve, seq, from_level, to_level, start_value, per_level, accel, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          segment.curve,
          segment.seq,
          segment.from_level,
          segment.to_level,
          segment.start_value,
          segment.per_level,
          segment.accel,
          now,
        ],
      ).changes;
    }
    this.run("INSERT OR REPLACE INTO config_meta (key, value) VALUES (?, ?)", [
      "role_level_curves_seeded",
      `count:${added}`,
    ]);
    this.logger.log(`存量库补等级曲线出厂数据：新增 ${added} 段`);
  }

  /**
   * 存量库补「战斗状态」三条出厂行 + 技能侧的新列取值（#826 第三批）
   *
   * 为什么需要：`statuses` 表里 2003 灼烧 / 2004 眩晕 / 2005 麻痹 是这一批新加的**行**，
   * 而 `config-sync.sql` 只在**空库首启**时整份灌入（`config_meta.bootstrap_at` 有值之后
   * 再也不灌）。只改快照的话，存量库重启后的表现是：管理端状态页少三条，
   * 而 1001 / 1004 / 1007 / 9001 的 `status_id` 指向不存在的状态 —— 技能照放、伤害照出，
   * **就是不挂状态**，而且没有任何报错。同一批的 `skills.second_hit_ratio` /
   * `pull_distance` 也吃这个亏（列由 `ensureColumn` 补上了，值还是默认 0）。
   *
   * 两条口径：
   * - 状态行 `INSERT OR IGNORE`：运营自己建过同 id 的行就不动它；
   * - 技能值**只在还是出厂空值时**才写（`status_id = ''` / 系数 = 0 / 距离 = 0），
   *   运营调过的（比如把 1004 的拉人距离改成 200）一律不覆盖。
   *
   * **只跑一次**（`config_meta.combat_statuses_seeded`）：否则运营删掉「眩晕」这条状态，
   * 下次重启又会冒出来。
   */
  private seedCombatStatusesOnce(): void {
    const hasMeta =
      this.count("SELECT COUNT(1) AS total FROM sqlite_master WHERE type = 'table' AND name = 'config_meta'") > 0;
    if (!hasMeta) return;
    if (this.get<{ value: string }>("SELECT value FROM config_meta WHERE key = ?", ["combat_statuses_seeded"])) return;
    const now = Date.now();
    let added = 0;
    for (const status of COMBAT_STATUS_SEEDS) {
      added += this.execute(
        `INSERT OR IGNORE INTO statuses
           (id, owner, label, icon, duration, source, description, effect, effect_hold_last, combat, updated_at,
            kind, max_stacks, tick_ms, tick_effect, control_flags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          status.id,
          status.owner,
          status.label,
          status.icon,
          status.duration,
          status.source,
          status.description,
          status.effect,
          status.effectHoldLast,
          status.combat,
          now,
          status.kind,
          status.maxStacks,
          status.tickMs,
          status.tickEffect,
          status.controlFlags,
        ],
      ).changes;
    }
    // 技能侧的出厂接线（只在「运营还没配」时补）：两个 UPDATE 各自带默认值判据
    let wired = 0;
    for (const entry of COMBAT_SKILL_STATUS_SEEDS) {
      wired += this.execute("UPDATE skills SET status_id = ? WHERE id = ? AND status_id = ''", [
        entry.statusId,
        entry.id,
      ]).changes;
    }
    for (const entry of COMBAT_SKILL_NUMBER_SEEDS) {
      // 列名来自本文件的字面量清单（不是外部输入），值走参数绑定
      wired += this.execute(`UPDATE skills SET ${entry.column} = ? WHERE id = ? AND ${entry.column} = 0`, [
        entry.value,
        entry.id,
      ]).changes;
    }
    this.run("INSERT OR REPLACE INTO config_meta (key, value) VALUES (?, ?)", [
      "combat_statuses_seeded",
      `statuses:${added},skills:${wired}`,
    ]);
    this.logger.log(`存量库补战斗状态出厂数据：新增状态 ${added} 条，补齐技能接线 ${wired} 处`);
  }

  /**
   * 存量库一次性补发技能点（#828）
   *
   * 技能点是「每级 +1」的**累计量**（建号 1 点 + 每升 1 级 +1 ≈ 等级），但 #828 之前
   * 建的老号存档里根本没有 `skillPoints` 这个键 —— 不补的话，一个 60 级的老号手上是
   * **0 点**：技能面板里每个技能都只能显示「点数不足」，而按口径他本该有 60 点。
   * 补发量取 `roles.level` 列（权威、且与「每级 +1」同一条尺子），不是「从 0 开始重新攒」。
   *
   * 三条边界：
   * - **已经有这个键的行一律不碰**：那是玩家真的花过点之后的余额（60 级的号学了几级技能、
   *   只剩 5 点），按等级重算等于把他花掉的点白送回去；
   * - **存档解析不出来就跳过**（`roles.corrupted` 那批）：坏 JSON 归人工处理，
   *   自动改写只会把「还能救的档」变成「救不回来的档」；
   * - **不推修订号**（只动 `updated_at`）：与存档版本迁移同一纪律 —— 玩家没做任何操作，
   *   不该让他下一次保存撞 20006。改动落库后，下次选角 / 存档回填就会带上新点数。
   *
   * **只跑一次**（`config_meta.skill_points_seeded`）：否则玩家把点花光后重启服务，
   * 点数又回满 —— 那等于无限技能点。
   */
  private seedSkillPointsOnce(): void {
    const hasMeta =
      this.count("SELECT COUNT(1) AS total FROM sqlite_master WHERE type = 'table' AND name = 'config_meta'") > 0;
    if (!hasMeta) return;
    if (this.get<{ value: string }>("SELECT value FROM config_meta WHERE key = ?", ["skill_points_seeded"])) return;
    const now = Date.now();
    let roles = 0;
    let points = 0;
    for (const row of this.all<{ id: string; level: number; data: string }>("SELECT id, level, data FROM roles")) {
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(row.data ?? ""));
        // 数组 / null / 标量都不是存档 —— 与 `decodeStoredRoleDataStrict` 同一条判据
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        data = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(data, "skillPoints")) continue;
      const level = Math.max(1, Math.floor(Number(row.level) || 1));
      data.skillPoints = level;
      this.run("UPDATE roles SET data = ?, updated_at = ? WHERE id = ?", [JSON.stringify(data), now, row.id]);
      roles += 1;
      points += level;
    }
    this.run("INSERT OR REPLACE INTO config_meta (key, value) VALUES (?, ?)", [
      "skill_points_seeded",
      `roles:${roles},points:${points}`,
    ]);
    if (roles > 0) this.logger.log(`存量库补发技能点：${roles} 个角色，共 ${points} 点（每级 1 点）`);
  }

  /**
   * 存量库一次性补发属性点（#833）
   *
   * 与 `seedSkillPointsOnce` 同一个形状、同一个理由：#833 之前的老号存档里没有
   * `attrPoints`，不补的话 60 级的老号手上是 **0 点** ——「属性点」面板永远是灰的。
   * 补发量取 `roles.level` 列（与「建号 1 点 + 每级 1 点」同一条尺子，总点数 = 等级）。
   *
   * 三条边界与技能点完全一致，只有一处差别值得写下来：
   * - **只判 `attrPoints` 缺不缺，不看 `attrs`**：`attrs` 缺失本来就等价于「四维全 0」
   *   （`attrAllocationOf` 按 0 读），补一个全 0 的 `attrs` 进去只是让存档多一行噪音；
   * - 老号补的是「可分配点数」，**不会**自动帮他加到某一项上 —— 那是玩家的选择。
   *
   * **只跑一次**（`config_meta.attr_points_seeded`）：否则玩家点完、洗点、重启，
   * 点数又按等级补一遍 —— 那等于无限属性点。
   */
  private seedAttrPointsOnce(): void {
    const hasMeta =
      this.count("SELECT COUNT(1) AS total FROM sqlite_master WHERE type = 'table' AND name = 'config_meta'") > 0;
    if (!hasMeta) return;
    if (this.get<{ value: string }>("SELECT value FROM config_meta WHERE key = ?", ["attr_points_seeded"])) return;
    const now = Date.now();
    let roles = 0;
    let points = 0;
    for (const row of this.all<{ id: string; level: number; data: string }>("SELECT id, level, data FROM roles")) {
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(String(row.data ?? ""));
        // 数组 / null / 标量都不是存档 —— 与 `decodeStoredRoleDataStrict` 同一条判据
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        data = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(data, "attrPoints")) continue;
      const level = Math.max(1, Math.floor(Number(row.level) || 1));
      data.attrPoints = level;
      this.run("UPDATE roles SET data = ?, updated_at = ? WHERE id = ?", [JSON.stringify(data), now, row.id]);
      roles += 1;
      points += level;
    }
    this.run("INSERT OR REPLACE INTO config_meta (key, value) VALUES (?, ?)", [
      "attr_points_seeded",
      `roles:${roles},points:${points}`,
    ]);
    if (roles > 0) this.logger.log(`存量库补发属性点：${roles} 个角色，共 ${points} 点（每级 1 点）`);
  }

  /**
   * 商城改版一次性迁移（#758，幂等）：老的「统一价 + 特殊价」模型搬进新模型
   *
   * 老表还在（存量库）就把特殊价行搬进「默认分类」（购买等级 0，运营随后自行调整），然后
   * 删掉两张老表 —— 表没了这个迁移自然不会再跑，无需额外标记。新库没有老表，全程跳过。
   */
  private migrateLegacyMallPricing(): void {
    const hasLegacy =
      this.count("SELECT COUNT(1) AS total FROM sqlite_master WHERE type = 'table' AND name = 'mall_prices'") > 0;
    if (!hasLegacy) return;
    this.run(
      "INSERT OR IGNORE INTO mall_categories (id, label, sort_order, updated_at) VALUES ('default', '默认分类', 0, 0)",
    );
    this.db.exec(
      "INSERT OR IGNORE INTO mall_goods (id, category_id, price, required_level, updated_at) " +
        "SELECT id, 'default', price, 0, updated_at FROM mall_prices",
    );
    this.db.exec("DROP TABLE IF EXISTS mall_prices; DROP TABLE IF EXISTS mall_settings;");
    const moved = this.count("SELECT COUNT(1) AS total FROM mall_goods");
    this.logger.log(`商城改版迁移完成：老特殊价已并入「默认分类」（当前上架 ${moved} 件），老表已删除`);
  }

  /**
   * 存量库兜底：老库没有 role 列，补列后所有管理员都成了「管理员」——
   * 那样**没人有 admin:manage**，等于后台再也管不了管理员。
   * 所以库里有管理员却一个超管都没有时，把最早创建的那位提为超管（一次性）。
   * 新库不受影响：第一个注册的管理员本来就是超管（见 AdminAuthService.register）。
   */
  private ensureSuperAdmin(): void {
    if (this.count("SELECT COUNT(1) AS total FROM admins WHERE role = ?", [AdminRole.SUPER]) > 0) return;
    const oldest = this.get<{ id: string }>("SELECT id FROM admins ORDER BY created_at ASC LIMIT 1");
    if (!oldest) return;
    this.run("UPDATE admins SET role = ? WHERE id = ?", [AdminRole.SUPER, oldest.id]);
    this.logger.log(`存量库没有超级管理员，已把最早创建的管理员提升为超级管理员（${oldest.id}）`);
  }

  /**
   * world_monsters.instanceId 的格式归一（#295 阶段二引入区段、#809 引入线，幂等）
   *
   * 三种格式都在野外出现过，一律归到 `m<mapId>_z<zone>_c<slot>_<n>`：
   * - `m<mapId>_<n>`（#295 之前）
   * - `m<mapId>_z<zone>_<n>`（#295 阶段二 ~ #809 之前，**现网就是这个**）
   * - `m<mapId>_z<zone>_c<slot>_<n>` / `_i<seq>_<n>`（#809 起）
   *
   * 识别口径**先细后粗**：带 slot 段的先排除，剩下的按「有区段」→「无区段」两档改写。
   * 反过来（先粗后细）会把 `m1_z1_c0_3` 的 mapId 段读成 `1_z1_c0`，改出一条错 id。
   *
   * 为什么要改写存量行而不是「新老并存」：观战中的客户端手里握着 instanceId，两种格式
   * 并存时 `parseInstanceSeq()` 虽然都认，但**同一只怪在两批日志里长得不一样**会让人
   * 以为出了两只怪。改写是幂等的，代价是一次 epoch +1（世界内存按库重载一次）。
   */
  private migrateWorldMonsterInstanceIds(): void {
    const rows = this.all<{ instance_id: string; zone_id: number; slot: string | null }>(
      "SELECT instance_id, zone_id, slot FROM world_monsters",
    );
    let migrated = 0;
    for (const row of rows) {
      if (WORLD_INSTANCE_ROOM_FORMAT.test(row.instance_id)) continue;
      // 空串当公共线：`slot TEXT NOT NULL DEFAULT '0'` 正常写不出空串，但手工改库 / 老备份
      // 里出现过就麻烦了 —— 空串会成为一个「谁也不认识、谁也不进去」的独立房间
      const slot = row.slot ? row.slot : PUBLIC_SLOT;
      let next: string | null = null;
      const withZone = WORLD_INSTANCE_NEW_FORMAT.exec(row.instance_id);
      if (withZone) {
        next = instanceIdOf(withZone[1], row.zone_id, slot, Number(withZone[2]));
      } else {
        const legacy = WORLD_INSTANCE_OLD_FORMAT.exec(row.instance_id);
        if (!legacy) {
          this.logger.warn(`world_monsters 存在无法识别的 instanceId（${row.instance_id}），跳过线段改写`);
          continue;
        }
        next = instanceIdOf(legacy[1], row.zone_id, slot, Number(legacy[2]));
      }
      if (this.count("SELECT COUNT(1) AS total FROM world_monsters WHERE instance_id = ?", [next]) > 0) {
        this.logger.warn(`world_monsters 改写目标 id 已存在（${row.instance_id} → ${next}），跳过（理论不可达，报出来便于排查）`);
        continue;
      }
      this.run("UPDATE world_monsters SET instance_id = ?, slot = ? WHERE instance_id = ?", [next, slot, row.instance_id]);
      migrated += 1;
    }
    if (migrated > 0) {
      // 改写之后，**已经跑着的实时进程**手里还是旧 id：epoch +1 让它在下一个 tick 把手上的
      // 世界整份作废并按库重载（#851 的收口路径）。不 bump 的话，那些进程要到「分域空闲卸载」
      // 或重启才换过来 —— 而它们手里旧 id 的怪在库里已经不存在，出手就是 20008。
      this.run("UPDATE world_meta SET epoch = epoch + 1");
      this.logger.log(`world_monsters 存量 instanceId 已补线段（改写 ${migrated} 行，世界代际 +1 以作废在跑的旧内存）`);
    }
  }

  /**
   * 世界坐标口径升级（#566）：地图原点从「地图中心」改成「地图左上角」
   *
   * 客户端把 `TiledMap` 节点的锚点设成 (0,1)，瓦片从此铺在 `x∈[0,W]`、`y∈[-H,0]` ——
   * Tiled 坐标只差一次 y 取反就能用，不再需要「减半宽、翻半高」。代价是**同一个世界位置的
   * 数值整体平移了** `(W/2, -H/2)`（8192 像素的图就是 +4096 / -4096），
   * 而库里存着两批旧口径的坐标：`map_spawn_areas`（刷怪区中心）与 `world_monsters`（怪物落点）。
   * 不平移的话，升级后怪物会按旧坐标出现在离正确位置半张图远的地方（多半在地图外）。
   *
   * 平移不可重复执行（再来一次就整体偏半张图），所以用 `world_meta.coord_origin` 打标记：
   * 只在它还是 'center' 时做一次，做完置 'topleft'。地图尺寸读 `maps` 的几何列
   * （`tools/import-map-resources.cjs` 从 TMX 头写进来的），认不出的 map_id 只 warn、不动数据。
   */
  private migrateMapCoordinateOrigin(): void {
    const pending = this.count("SELECT COUNT(1) AS total FROM world_meta WHERE coord_origin = 'center'");
    if (pending === 0) return;
    const sizes = this.all<{ map_id: string; pixel_width: number; pixel_height: number }>(
      "SELECT map_id, pixel_width, pixel_height FROM maps",
    );
    let moved = 0;
    this.transaction(() => {
      for (const size of sizes) {
        if (size.pixel_width <= 0 || size.pixel_height <= 0) continue;
        const dx = size.pixel_width / 2;
        const dy = -size.pixel_height / 2;
        moved += this.execute("UPDATE map_spawn_areas SET cx = cx + ?, cy = cy + ? WHERE map_id = ?", [dx, dy, size.map_id]).changes;
        moved += this.execute("UPDATE world_monsters SET x = x + ?, y = y + ? WHERE map_id = ?", [dx, dy, size.map_id]).changes;
      }
      this.run("UPDATE world_meta SET coord_origin = 'topleft' WHERE id = 1");
    });
    const known = new Set(sizes.filter((row) => row.pixel_width > 0).map((row) => row.map_id));
    const unknown = this.all<{ map_id: string }>(
      "SELECT DISTINCT map_id FROM world_monsters UNION SELECT DISTINCT map_id FROM map_spawn_areas",
    ).filter((row) => !known.has(row.map_id));
    if (unknown.length > 0) {
      this.logger.warn(`地图原点迁移：这些 map_id 没有几何（先跑 node tools/import-map-resources.cjs），坐标未平移 —— ${unknown.map((row) => row.map_id).join(", ")}`);
    }
    this.logger.log(`地图原点已改为左上角：平移 ${moved} 条世界坐标（${known.size} 张图）`);
  }

  /** 给已有表补一列（列已存在则不动；SQLite 的 ADD COLUMN 带 NOT NULL 必须有默认值） */
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    this.logger.log(`表 ${table} 补列：${column}`);
  }

  /** 这张表在不在（迁移要「表存在才处理」时用；比 `SELECT` 一条空表便宜也更直白） */
  private hasTable(table: string): boolean {
    return this.count("SELECT COUNT(1) AS total FROM sqlite_master WHERE type = 'table' AND name = ?", [table]) > 0;
  }

  /** 这张表有没有这一列（与 `ensureColumn` 同一口径的只读版） */
  private hasColumn(table: string, column: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    return columns.some((item) => item.name === column);
  }

  /**
   * 删掉一张表上已经没有消费方的列（只在列还在时动作）
   *
   * 为什么需要它：配置快照是 `SELECT *` 导出的 —— 表里留着一列没人读的字段，
   * 它就会一直出现在 `config-sync.sql` 里，下一个人会以为那还是个旋钮。
   */
  private dropColumnIfExists(table: string, column: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    this.logger.log(`表 ${table} 删列：${column}（已无消费方）`);
  }

  /** 给已有表改列名（新列名已存在则不动；货币统一命名 #843、#844 的存量迁移用） */
  private renameColumnIfExists(table: string, from: string, to: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
    if (!columns.some((item) => item.name === from) || columns.some((item) => item.name === to)) return;
    this.db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
    this.logger.log(`表 ${table} 改列名：${from} → ${to}`);
  }

  /** 执行写语句（无返回） */
  run(sql: string, params: SqlParam[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  /** 执行写语句并返回影响行数（用于判断是否存在） */
  execute(sql: string, params: SqlParam[] = []): { changes: number } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  /** 执行插入语句并返回自增主键（zones 这类自增 id 表用；TEXT 主键的表用不到它） */
  insertReturningId(sql: string, params: SqlParam[] = []): number {
    const result = this.db.prepare(sql).run(...params);
    return Number(result.lastInsertRowid);
  }

  /** 取一行（无结果返回 undefined） */
  get<T>(sql: string, params: SqlParam[] = []): T | undefined {
    const row = this.db.prepare(sql).get(...params);
    // node:sqlite 返回 null 原型对象，转成普通对象免得下游（如 JSON 序列化、展开）踩坑
    return row ? ({ ...row } as unknown as T) : undefined;
  }

  /** 取多行 */
  all<T>(sql: string, params: SqlParam[] = []): T[] {
    return (this.db.prepare(sql).all(...params) as unknown as Record<string, unknown>[]).map((row) => ({ ...row }) as unknown as T);
  }

  /** 取单个数值（COUNT 之类） */
  count(sql: string, params: SqlParam[] = []): number {
    const row = this.get<Record<string, number>>(sql, params);
    if (!row) return 0;
    const value = Object.values(row)[0];
    return Number(value ?? 0);
  }

  /**
   * 事务（回调内抛异常会整体回滚）
   *
   * **可重入**（#868）：已经在事务里再调一次不会发第二个 `BEGIN` —— SQLite 对嵌套 BEGIN
   * 直接报 `cannot start a transaction within a transaction`，而调用方往往把这个异常
   * 当「日志写失败」warn 吞掉，结果就是**静默丢数据**（`EventLogService.recordMany`
   * 内部自己包了一层事务，行数 > 1 时走的就是那条路；e2e-event-log 抓到过
   * 「邮件附件另记 gain」四条全空）。现在内层并入外层：回滚只有一个，由最外层决定。
   *
   * 需要「内层失败但外层继续」请用 `SAVEPOINT`，这里刻意不做 —— 现有调用方都不需要，
   * 加了反而让人以为内层能单独回滚。
   */
  transaction<T>(work: () => T): T {
    if (this.txDepth > 0) return work();
    this.db.exec("BEGIN");
    this.txDepth += 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }
}
