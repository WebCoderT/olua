import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AdminRole } from "../common/constants/permission";
import { AnnouncementLevel } from "../common/constants/announcement";
import { bootstrapConfigSnapshot } from "./config-snapshot";

/** 可绑定的参数值（node:sqlite 支持的类型） */
export type SqlParam = string | number | bigint | null | Uint8Array;

/** world_monsters.instanceId 的两种格式（#295 阶段二起只有新格式；旧格式只在存量库里出现） */
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
    // 旧库升级前置（#350）：exec 块里有引用 zone_id 的索引（idx_world_monsters_zone 等），
    // 而 zone_id 的补列（ALTER）原本排在 exec 之后——旧 schema 的库（无该列）会在建索引时
    // 直接炸 no such column，起不了服。这里赶在建索引前对「已存在的旧表」补列；
    // 新库没有这两张表，跳过，exec 后段的 ensureColumn 幂等兜底。
    for (const [table, definition] of [
      ["accounts", "INTEGER NOT NULL DEFAULT 1"],
      ["world_monsters", "INTEGER NOT NULL DEFAULT 1"],
    ] as const) {
      const exists =
        this.count("SELECT COUNT(1) AS total FROM sqlite_master WHERE type = 'table' AND name = ?", [table]) > 0;
      if (exists) this.ensureColumn(table, "zone_id", definition);
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
        name       TEXT NOT NULL,
        occupation TEXT NOT NULL DEFAULT '',
        sex        TEXT NOT NULL DEFAULT '',
        level      INTEGER NOT NULL DEFAULT 1,
        kills      INTEGER NOT NULL DEFAULT 0,
        data       TEXT NOT NULL,
        revision   INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_roles_account ON roles(account_id);

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
        status_code   INTEGER,
        success       INTEGER NOT NULL DEFAULT 1,
        error_code    INTEGER,
        error_message TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);
      CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);

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
      -- 一行 = 一只场上怪：身份 / 所属区 + 地图 / 出生点 / 血量 / 存活与重生时刻。
      -- instanceId 带区段（#295 阶段二：m<mapId>_z<zone>_<n>），同一张图各区各发各的牌。
      -- 服务端是唯一写者（客户端只通过实时通道间接改它），所以不需要乐观锁列。
      CREATE TABLE IF NOT EXISTS world_monsters (
        instance_id TEXT PRIMARY KEY,
        map_id      TEXT NOT NULL,
        zone_id     INTEGER NOT NULL DEFAULT 1,
        monster_key TEXT NOT NULL,
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

      -- 实时地图监控（#665）：世界进程每秒把「这张图现在长什么样」投影成一行，管理端只读它。
      --
      -- 为什么还要一张镜像表（world_monsters 不是已经有状态了吗）：那张表的 x/y 是**出生点**
      -- （世界里唯一稳定的真相），而监控要看的是**此刻**的位置 —— 怪物 AI 的模拟坐标只活在
      -- 实时进程内存里，且不落盘（见 monster-ai.service 的 MonsterRuntime）。管理端接口在
      -- 存档进程（3100），两个进程之间只有 SQLite 这一条路，所以这里做一份高频镜像：
      -- 它是**运行时投影，不是配置**，config-sync 的 33 张表里没有它，重启清空也无所谓。
      CREATE TABLE IF NOT EXISTS map_monitor_state (
        zone_id    INTEGER NOT NULL,
        map_id     TEXT    NOT NULL,
        -- JSON：{ monsters: [...], players: [...], sampledAt }
        payload    TEXT    NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (zone_id, map_id)
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
      -- 文件本体在客户端资源包里（client/assets/resources/sounds/），这里只存**资源相对路径**
      -- （带扩展名，如 'sounds/login_bg.wav'）—— 换一首曲子只要新文件已进资源包，不必重打客户端。
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

      -- 角色等级表（#655）：一行 = 一个等级的**最终裸属性 + 升级经验**。
      -- 这是「移除成长曲线」后的唯一书写处：曲线（growth_segments）不再参与运行时，
      -- 60 行数值由 server/scripts/migrate-derived-tables.cjs 一次性展开写入，
      -- 之后只由管理端「角色等级」页逐行改。运行时 / 快照都只读这张表。
      CREATE TABLE IF NOT EXISTS role_levels (
        level                INTEGER PRIMARY KEY,
        exp                  INTEGER NOT NULL DEFAULT 1,
        max_hp               INTEGER NOT NULL DEFAULT 0,
        max_mp               INTEGER NOT NULL DEFAULT 0,
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

      -- 装备变体表（#655）：一行 = 一件**具体可掉落/可穿戴**的装备（基础件 × 前后缀，
      -- 37 × 15 = 555 行）。这是「移除变体倍率」后的唯一书写处：不再由基础件乘倍率现算，
      -- 每行的属性 / 卖价 / 穿戴等级都可单独改。equipments 只留 37 个基础件（模板与名称）。
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
      -- 曲线（growth_segments）与旧经验表（level_exps）已在 #655 删除 —— 经验并进
      -- role_levels.exp，属性逐级写在 role_levels，运行时不再采样插值。
      CREATE TABLE IF NOT EXISTS growth_scalars (
        key         TEXT PRIMARY KEY,
        value       REAL    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        updated_at  INTEGER NOT NULL DEFAULT 0
      );

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
        updated_at           INTEGER NOT NULL DEFAULT 0
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

      -- 装备规则（#603 第九域）：单行表（id 恒为 1），存前后缀倍率 / 文案。
      -- 四个数组都是 JSON 文本 —— 它们是「一组同长的表」，拆成列反而要多维护行数约束。
      -- 回收价曲线 #655 下架（逐条价在 equipment_variants.sell_price），老库那列由 ensure 段删掉
      CREATE TABLE IF NOT EXISTS equipment_meta (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        prefix_rates  TEXT    NOT NULL DEFAULT '[]',
        suffix_rates  TEXT    NOT NULL DEFAULT '[]',
        prefix_labels TEXT    NOT NULL DEFAULT '[]',
        suffix_labels TEXT    NOT NULL DEFAULT '[]',
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
        updated_at         INTEGER NOT NULL DEFAULT 0
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
        updated_at   INTEGER NOT NULL DEFAULT 0
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

      -- 商城特殊定价（#251）：主键是商品 id（装备变体 id）；**允许动态增删** ——
      -- 定价是运营数据，商品本体（装备清单）来自生成物；不在表里的商品走统一价
      CREATE TABLE IF NOT EXISTS mall_prices (
        id         TEXT    PRIMARY KEY,
        price      INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );

      -- 商城统一价（#251）：单行表（id 恒为 1），seed 自生成物 MALL_DEFAULT_PRICE，运营可改
      CREATE TABLE IF NOT EXISTS mall_settings (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        default_price INTEGER NOT NULL DEFAULT 1,
        updated_at    INTEGER NOT NULL DEFAULT 0
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
        updated_at  INTEGER NOT NULL DEFAULT 0
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
        reward_gold     INTEGER NOT NULL DEFAULT 0,
        reward_exp      INTEGER NOT NULL DEFAULT 0,
        reward_items    TEXT    NOT NULL DEFAULT '[]',
        updated_at      INTEGER NOT NULL DEFAULT 0
      );

      -- 任务进度状态机（#396）：可接 = 无行；accepted 进行中 → ready 可交付 → claimed 已领奖。
      -- daily 领奖后整行删除（可重接、进度清零）；main 保留 claimed 行作链门控。
      -- 不加 REFERENCES quests(id) 外键：任务下架不该连带抹掉玩家进度历史
      CREATE TABLE IF NOT EXISTS quest_progress (
        role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        quest_id   TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'accepted',
        progress   INTEGER NOT NULL DEFAULT 0,
        claimed_at INTEGER,
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
        reward_gold      INTEGER NOT NULL DEFAULT 0,
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
      -- 附件（gold / exp / attachments）在**领取时**才入包：先领后删，未领的邮件带着附件留在箱里。
      CREATE TABLE IF NOT EXISTS role_mails (
        id          TEXT    PRIMARY KEY,
        role_id     TEXT    NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        -- 玩家看到的频道（#436）：system / reward / social / combat，四个枚举必须收敛
        channel     TEXT    NOT NULL DEFAULT 'system',
        kind        TEXT    NOT NULL DEFAULT 'system',
        title       TEXT    NOT NULL DEFAULT '',
        body        TEXT    NOT NULL DEFAULT '',
        gold        INTEGER NOT NULL DEFAULT 0,
        exp         INTEGER NOT NULL DEFAULT 0,
        attachments TEXT    NOT NULL DEFAULT '[]',
        read_at     INTEGER,
        claimed_at  INTEGER,
        -- 收件箱保质期（#439）：毫秒时间戳，NULL = 永不过期。
        -- 与 mail_queue 的 MAIL_RETENTION_DAYS（投递记录保留期）是两件事，别混
        expires_at  INTEGER,
        created_at  INTEGER NOT NULL DEFAULT 0
      );
      -- 收件箱永远按「这个角色 + 时间倒序」取，未领数也用得上 claimed_at
      CREATE INDEX IF NOT EXISTS idx_role_mails_box ON role_mails(role_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_role_mails_unclaimed ON role_mails(role_id, claimed_at);

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
        updated_at          INTEGER NOT NULL DEFAULT 0
      );
    `);

    // 存量库补列（CREATE TABLE IF NOT EXISTS 不会改已有表结构）
    this.ensureColumn("admins", "role", `TEXT NOT NULL DEFAULT '${AdminRole.ADMIN}'`);
    // 修订号（乐观锁）：存量库补列后老角色都是 1，客户端读到 1 推回来也是 1，不会误判冲突
    this.ensureColumn("roles", "revision", "INTEGER NOT NULL DEFAULT 1");
    // 令牌版本号（改密即失效旧令牌）：存量库补列后默认 0，而存量令牌里没有 ver 字段也按 0 处理，两者一致
    this.ensureColumn("accounts", "token_version", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("admins", "token_version", "INTEGER NOT NULL DEFAULT 0");
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
    // 区服（#295 阶段二）：存量账号全部归入一区（zone_id=1 与 zones seed 对齐，注册入参可指定）
    this.ensureColumn("accounts", "zone_id", "INTEGER NOT NULL DEFAULT 1");
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
    // 击杀数（#400）：排行榜的原料。放在 roles 行上而不是独立表 —— 写路径唯一（结算时 +1），
    // 客户端的存档覆盖（PUT /roles/:id 换 data）压根碰不到这一列，多一张表只会多一次 join。
    this.ensureColumn("roles", "kills", "INTEGER NOT NULL DEFAULT 0");
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
    this.migrateWorldMonsterInstanceIds();
    // 药品 / 物品图标（#603 第十域）：客户端不再存图标（它拼不出 `item/fs_2` 这类路径，
    // 与地图 / 特效那种「能按 id 推导」的不同）—— 老库补列后由 seedDrugs / seedItems
    // 的 backfillIcon 一次性回填（只在 icon 还是空串时填）
    this.ensureColumn("drugs", "icon", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("items", "icon", "TEXT NOT NULL DEFAULT ''");
    // 技能职业归属与击退距离（#603 第十一域）：客户端技能栏按 occupation 重建「职业→技能」映射，
    // push_distance 以前只写在客户端配置里（快照不覆盖它），不补列这两项会一起丢
    this.ensureColumn("skills", "occupation", "TEXT NOT NULL DEFAULT '4'");
    this.ensureColumn("skills", "push_distance", "REAL NOT NULL DEFAULT 0");
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
    this.ensureSuperAdmin();
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
   * world_monsters.instanceId 引入区段（#295 阶段二的一次性改写，幂等）
   *
   * 旧格式 `m<mapId>_<n>` → 新格式 `m<mapId>_z<zone>_<n>`。识别口径**先新后旧**：
   * 新格式（`m1_z1_3`）也能被「旧格式」的正则匹配上（mapId 段读成 `1_z1`），
   * 所以先按新格式排除，剩下的才当旧格式改写 —— 重启多少次都只改一次。
   */
  private migrateWorldMonsterInstanceIds(): void {
    const rows = this.all<{ instance_id: string; zone_id: number }>("SELECT instance_id, zone_id FROM world_monsters");
    let migrated = 0;
    for (const row of rows) {
      if (WORLD_INSTANCE_NEW_FORMAT.test(row.instance_id)) continue;
      const match = WORLD_INSTANCE_OLD_FORMAT.exec(row.instance_id);
      if (!match) {
        this.logger.warn(`world_monsters 存在无法识别的 instanceId（${row.instance_id}），跳过区段改写`);
        continue;
      }
      const next = `m${match[1]}_z${row.zone_id}_${match[2]}`;
      if (this.count("SELECT COUNT(1) AS total FROM world_monsters WHERE instance_id = ?", [next]) > 0) {
        this.logger.warn(`world_monsters 改写目标 id 已存在（${row.instance_id} → ${next}），跳过（理论不可达，报出来便于排查）`);
        continue;
      }
      this.run("UPDATE world_monsters SET instance_id = ? WHERE instance_id = ?", [next, row.instance_id]);
      migrated += 1;
    }
    if (migrated > 0) this.logger.log(`world_monsters 存量 instanceId 已补区段（改写 ${migrated} 行）`);
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

  /** 事务（回调内抛异常会整体回滚） */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
