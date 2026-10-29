#!/usr/bin/env node
/**
 * 守卫：服务端内部边界（#36）—— 跨模块 import 只能走白名单边，仓储只由 DatabaseModule 装配
 *
 * ===========================================================================
 * 为什么必须有这个
 * ===========================================================================
 * 服务端在一个进程里已经真的持有战斗（realtime）与世界（world），内部边界划错，
 * 下一步「拆进程」(#37) 就要从「挪目录」变成「重写」。边界最容易腐化的方式不是大改，
 * 而是**顺手多加一条跨模块 import**：某次赶时间直接 `import { RoleRepository }`
 * 进了控制器，边界就破了 —— 而这种事 review 里几乎看不出来，因为它能编译、能跑。
 *
 * 所以把边界钉成机器判据：
 *
 *   1. **跨模块边（deny-by-default）**：modules/ 下的一个域要引另一个域，
 *      只能走下面 `ALLOWED_EDGES` 里显式列出的边。加新边 = 改这个白名单 = 有意识的决策；
 *   2. **仓储装配唯一**：8 个仓储只许在 `database.module.ts` 里出现，业务模块的
 *      providers 里再注册一个同名类，会与全局单例并存出第二个实例（mail 曾踩过）；
 *   3. **combat 是纯函数库**：只许引基础层（common / shared / config），不许引任何
 *      modules 与 database —— 它被三端两侧引用，往上引就会造成环。
 *
 * ===========================================================================
 * 判据口径
 * ===========================================================================
 * - 域 = 文件在 `server/src` 下的目录前缀：modules/<name> 各自成域；
 *   common / shared / config / swagger / token / security / main.ts / app.module.ts 是基础层；
 *   database/ 是持久化层（其中 rows.ts 与 sort-specs.ts 是**契约文件**，谁都可以引）。
 * - 相对 import 按文件位置解析成 src 内绝对路径再判域；跳过 `@generated` 文件。
 * - 白名单按「源域 → 目标路径前缀」列，注释里写清楚这条边为什么存在。
 *
 * 输出风格与 `audit-doc-numbers.cjs` 一致：违规逐条指名道姓，exit 1。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "server", "src");

/** 基础层：谁都可以引，它们自己之间互相引也不算跨域 */
const BASE_DIRS = ["common", "shared", "config", "swagger", "token", "security"];

/** 持久化层的契约文件：只含类型与排序白名单，允许被任何域引 */
const PERSIST_CONTRACT_FILES = ["database/rows.ts", "database/sort-specs.ts"];

/**
 * 跨模块边白名单：`源目录/文件 → 允许引用的目标路径前缀`。
 * 一条边一行，注释写清这条边为什么存在；不在这张表里的跨 modules/ 引用一律违规。
 */
const ALLOWED_EDGES = [
  // admin 复用存档域的「数据形状」与校验口径（管理端改的就是这些数据，形状必须同源）
  { from: "modules/admin", to: "modules/auth/dto/", why: "账号 DTO 形状复用" },
  { from: "modules/admin", to: "modules/roles/role-data.util.ts", why: "角色结构校验与文案复用" },
  { from: "modules/admin", to: "modules/roles/dto/", why: "角色 DTO 形状复用" },
  // 审计是横切能力：登录（auth）与管理端（admin）都要写操作日志（经 AuditModule 导出的服务）
  { from: "modules/auth", to: "modules/audit/audit.service.ts", why: "登录写审计" },
  { from: "modules/admin", to: "modules/audit/audit.service.ts", why: "管理端写审计" },
  // roles 的属性汇总口径来自 combat 纯函数（存档返回值要带战斗力）
  { from: "modules/roles", to: "modules/combat/role-attributes.ts", why: "属性汇总纯函数" },
  { from: "modules/roles", to: "modules/combat/role-attribute-comparison.ts", why: "属性比对纯函数" },
  // 商城购买收权（#304）：扣费与入包在存档域，成交价读 game-config 的定价服务（特殊价/统一价同源）
  { from: "modules/roles", to: "modules/game-config/mall-pricing.service.ts", why: "商城购买读成交价" },
  // 区服（#295）：管理端开区/合并区直接复用 ZoneService 的一份实现（admin 控制器只做鉴权与审计）
  { from: "modules/admin", to: "modules/zone/", why: "区服管理复用 ZoneService 的开区/合并实现" },
  // realtime（gateway+结算）依赖 world 与存档的公开服务，依赖 combat 纯函数
  { from: "modules/realtime", to: "modules/combat/role-attributes.ts", why: "结算取属性汇总" },
  { from: "modules/realtime", to: "modules/world/world.service.ts", why: "世界权威公开服务" },
  { from: "modules/realtime", to: "modules/roles/roles.service.ts", why: "结算读写存档走存档服务" },
  // 社交（#388/#389）：所有帮会 / 好友动作都落在「账号的在线角色」上，
  // 而哪个角色在线只有存档域知道（accounts.online_role_id）—— 不让社交域自己摸账号表
  { from: "modules/social", to: "modules/roles/roles.service.ts", why: "社交动作取账号的在线角色" },
  // 任务（#396）：接取 / 交付落在账号的在线角色上；交付发奖走存档域的单次落库方法
  { from: "modules/quest", to: "modules/roles/roles.service.ts", why: "任务动作取在线角色与交付发奖" },
  { from: "modules/quest", to: "modules/game-config/dto/", why: "任务配置 DTO（管理端编辑入参的形状）" },
  // realtime 结算把击杀事件递给任务服务（进度推进 + quest 帧接线，都经 QuestService 公开口）
  { from: "modules/realtime", to: "modules/quest/quest.service.ts", why: "击杀事件推进任务进度" },
  // 队伍（#399）：队伍动作落在「账号的在线角色」上，与社交同一条理由 —— 不让队伍域自己摸账号表；
  // 队伍帧的形状（party / partyInvite / expGain）与实时通道共用一份类型，所以引 realtime 的协议文件
  { from: "modules/party", to: "modules/roles/roles.service.ts", why: "队伍动作取账号的在线角色与名字" },
  { from: "modules/party", to: "modules/realtime/realtime.protocol.ts", why: "队伍帧形状与实时通道同源" },
  // realtime → party：击杀者的同图队友要分经验（CombatSettlement 调 sharePartyExp），
  // 进图补快照与互见帧的 partyId 也经 PartyService 的只读口
  { from: "modules/realtime", to: "modules/party/party.service.ts", why: "队友分经验 + 队伍快照 + 互见 partyId" },
  // 排行榜（#400）：榜上的「战力」与角色详情里的战斗力必须是同一个数（否则玩家会看到两个战力），
  // 所以直接引 combat 的纯函数，而不是在榜单域里再复刻一份
  { from: "modules/leaderboard", to: "modules/combat/role-attributes.ts", why: "榜单战力与角色属性同源" },
  // 成就（#401）：与任务同一套「落在账号的在线角色上」的理由；
  // 战力类成就的门槛必须与角色详情里的战斗力是同一个数（引 combat 纯函数，不复刻一份）
  { from: "modules/achievement", to: "modules/roles/roles.service.ts", why: "成就取在线角色、查背包、领取走单次落库发奖" },
  { from: "modules/achievement", to: "modules/roles/dto/", why: "在线角色的形状（RoleDto）" },
  { from: "modules/achievement", to: "modules/combat/role-attributes.ts", why: "战力成就的门槛与角色属性同源" },
  // 邮件（#429）：成就领奖背包满时把整份奖励转成邮件（服务端内部降级，客户端不需多一步）
  { from: "modules/achievement", to: "modules/game-mail/game-mail.service.ts", why: "成就领奖背包满 → 整份奖励转邮件" },
  { from: "modules/game-mail", to: "modules/roles/roles.service.ts", why: "附件领取走与任务 / 成就同一个单次落库发奖入口" },
  // 社交（#436）：好友申请给对方留一条社交频道的消息 —— 只是通知，状态仍以 social 表为准
  { from: "modules/social", to: "modules/game-mail/game-mail.service.ts", why: "好友申请 → 一条社交消息（消息中心频道化）" },
  { from: "modules/social", to: "modules/roles/dto/", why: "在线角色的形状（RoleDto）：消息正文要用角色名与等级" },
];

/** 仓储 → 允许注入它的业务模块（持久化实现不许被表外的文件摸到） */
const REPO_EDGES = {
  "database/repositories/account.repository.ts": [
    "modules/auth",
    "modules/roles",
    "modules/admin",
    "modules/mail",
    // 踢下线巡检（#175）：实时进程轮询 online_role_id 断开被踢连接 —— 只读一行，不写账号
    "modules/realtime",
    // 合并区（#295）：搬账号在 ZoneService 的合并事务里（SQL 收在仓储，业务不摸 DatabaseService）
    "modules/zone",
    // 排行榜（#400）：`me` 要知道「当前在线的是哪个角色」，这是 accounts 行上的事实
    "modules/leaderboard",
  ],
  "database/repositories/admin.repository.ts": ["modules/admin"],
  "database/repositories/role.repository.ts": [
    "modules/roles",
    "modules/admin",
    // 聊天（#395）：帮会频道把成员角色映射成账号（findManyByIds）、私聊按 roleId 找收件人
    "modules/realtime",
    // 排行榜（#400）：物化时一次读全表（等级 / 击杀是索引列，战力从存档现算）
    "modules/leaderboard",
  ],
  "database/repositories/audit.repository.ts": ["modules/audit", "modules/admin"],
  "database/repositories/announcement.repository.ts": ["modules/announcement"],
  "database/repositories/mail.repository.ts": ["modules/mail"],
  "database/repositories/system.repository.ts": ["modules/system"],
  "database/repositories/world-monster.repository.ts": [
    "modules/world",
    // 合并区（#295）：重排 from 区世界发牌（instanceId 换 to 区区段）在 ZoneService 事务里
    "modules/zone",
  ],
  // 区服（#295）：注册选区校验活区（auth）、世界代际巡检（world）、开区/合并（zone）
  "database/repositories/zone.repository.ts": ["modules/zone", "modules/auth", "modules/world"],
  // 刷怪区（#295）：播种来源表，与世界实例同属 world 模块
  "database/repositories/map-spawn-area.repository.ts": ["modules/world"],
  // 养成配置（#213）：称号 / 战魂配置的读写只在 game-config 模块内 —— 玩家侧消费走
  // game-data.generated 快照（与角色属性同一来源），不直连这两张表
  "database/repositories/title.repository.ts": ["modules/game-config", "modules/roles"],
  "database/repositories/soul.repository.ts": ["modules/game-config", "modules/roles"],
  // 成长曲线（#256）：等级经验 / 曲线分段 / 标量参数同称号 / 战魂；
  // 击杀经验收权（#316）后存档域（roles）与结算（realtime，读标量算经验）也读
  "database/repositories/growth.repository.ts": ["modules/game-config", "modules/roles", "modules/realtime"],
  "database/repositories/rank.repository.ts": ["modules/game-config", "modules/roles"],
  // 装备基础件（#252）：同称号 / 战魂 / 军衔，只在 game-config 模块内读写；
  // 战斗结算仍走 game-data.generated 的 EQUIPMENT_ATTRIBUTES（客户端对接 #248/#249 未做）
  "database/repositories/equipment.repository.ts": ["modules/game-config"],
  // 装备对齐几何（#513）：只属于 game-config —— 它存的是客户端布局，服务端不参与任何计算，
  // 也就没有第二个域该读它（客户端那条路走的是快照接口，不经过仓储）
  "database/repositories/equip-align.repository.ts": ["modules/game-config"],
  // 装备内观几何（#523）：同上，只有 game-config 读写（客户端走 /game-config/equip-in-align）
  "database/repositories/equip-in-align.repository.ts": ["modules/game-config"],
  // 药品（#253）：game-config 读写；用药收权（#308）后存档域（roles）也读回复量
  "database/repositories/drug.repository.ts": ["modules/game-config", "modules/roles"],
  // 物品与材料（#255）：同上，只在 game-config 模块内读写
  "database/repositories/item.repository.ts": ["modules/game-config"],
  // 怪物基础数据（#258）：game-config 读写之外，世界播种（world）与伤害结算（realtime）
  // 也直读本表 —— 管理端改数值即时生效（快照只作 seed 来源，结算不走生成物）
  "database/repositories/monster.repository.ts": ["modules/game-config", "modules/world", "modules/realtime"],
  // NPC 基础数据（#258）：同称号 / 战魂 / 军衔 / 装备，只在 game-config 模块内读写；
  // 任务（#396）的 npc-talk 也读（对话文案 + 存在性校验）
  "database/repositories/npc.repository.ts": ["modules/game-config", "modules/quest"],
  // 商城定价（#251）：同上，只在 game-config 模块内读写（特殊价行动态增删，商品清单来自生成物）
  "database/repositories/mall.repository.ts": ["modules/game-config"],
  // 时装配置（#257）：同称号 / 战魂 / 军衔 / 装备，只在 game-config 模块内读写
  "database/repositories/fashion.repository.ts": ["modules/game-config"],
  // 掉落配置（#254）：game-config 读写；击杀掉落收权（#316）后结算（realtime）也直读
  // 两表 —— 管理端改掉落即时生效（具名表允许动态增删，每怪行与怪物一一对应）
  "database/repositories/drop-table.repository.ts": ["modules/game-config", "modules/realtime"],
  "database/repositories/monster-drop.repository.ts": ["modules/game-config", "modules/realtime"],
  // 技能与状态（#367）：game-config 读写；怪物侧释放（#372）后 realtime 的 MonsterAiService
  // 也读这两张表（技能行 + 状态修正），1 秒 TTL 缓存，改配置最多 1 秒生效
  "database/repositories/skill.repository.ts": ["modules/game-config", "modules/realtime"],
  "database/repositories/status.repository.ts": ["modules/game-config", "modules/realtime"],
  // 怪物技能挂载（#372）：game-config 管挂载清单（整份替换），realtime 的 AI 读它决定放哪些技能
  "database/repositories/monster-skill.repository.ts": ["modules/game-config", "modules/realtime"],
  // 帮会（#388）：社交域独占三张表的读写（管理端控制器也在 social 域内，不额外开边）
  "database/repositories/guild.repository.ts": ["modules/social", "modules/realtime"],
  // 屏蔽（#398）：社交域读写；实时进程的 BlockService 整表缓存它做过滤（聊天投递 / 互见帧）
  "database/repositories/social.repository.ts": ["modules/social", "modules/realtime"],
  // 举报（#398）：只在大陆侧社交模块内读写（管理端只读列表也在 social 域内）
  "database/repositories/report.repository.ts": ["modules/social"],
  // 任务（#396）：配置表读写归 game-config（管理端页 + seed），进度表归 quest 域；
  // 击杀推进度（realtime 的 QuestService）与删除守卫（game-config 的 deleteQuest）是两条只读例外
  "database/repositories/quest.repository.ts": ["modules/game-config", "modules/quest"],
  "database/repositories/quest-progress.repository.ts": ["modules/quest", "modules/game-config"],
  // 成就（#401）：配置表读写归 game-config（管理端页 + seed），记录表归 achievement 域；
  // game-config 只做删除守卫的只读 count（有玩家记录拒删）
  "database/repositories/achievement.repository.ts": ["modules/game-config", "modules/achievement"],
  "database/repositories/role-achievement.repository.ts": ["modules/achievement", "modules/game-config"],
  // 游戏内邮件（#429）：收件箱只归 game-mail 域读写（成就只通过 GameMailService 发信，不碰表）
  "database/repositories/role-mail.repository.ts": ["modules/game-mail"],
  // 队伍（#399）：队伍与成员两表唯一写者是 party 域（PartyService）；
  // realtime 只读（伤害结算要问「击杀者的同图队友」，进图补快照要问「他在哪个队」）
  "database/repositories/party.repository.ts": ["modules/party", "modules/realtime"],
};

/** 全局守卫回查库是设计行为（两层守卫都住在守卫里），单独开边 */
const EXTRA_FILE_EDGES = [
  { from: "common/guards/auth.guard.ts", to: "database/repositories/", why: "守卫每次请求回查库" },
];

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function srcRel(file) {
  return path.relative(SRC, file).split(path.sep).join("/");
}

function domainOf(rel) {
  if (BASE_DIRS.some((d) => rel === `${d}` || rel.startsWith(`${d}/`))) return "base";
  // modules/ 下的基础设施（JWT 令牌 / 安全装配）按基础层对待：全局模块，谁都可以用
  if (/^modules\/(token|security)\//.test(rel)) return "base";
  if (rel === "main.ts" || rel === "app.module.ts") return "base";
  const m = rel.match(/^modules\/([^/]+)/);
  if (m) return m[1];
  if (rel.startsWith("database/")) return "persist";
  return "unknown";
}

function isContract(rel) {
  return PERSIST_CONTRACT_FILES.includes(rel);
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  // 省略 .js / /index 的两种写法都按 TS 源文件解析
  let target = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    target,
    `${target}.ts`,
    path.join(target, "index.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return srcRel(c);
  }
  return null;
}

const failures = [];

// ── 1. 跨模块 import 边 ────────────────────────────────────────────────────
const files = walk(SRC);
const moduleFiles = [];

for (const file of files) {
  const rel = srcRel(file);
  const text = fs.readFileSync(file, "utf8");
  if (text.includes("@generated")) continue;
  if (/\.module\.ts$/.test(rel)) moduleFiles.push({ rel, text });

  const fromDomain = domainOf(rel);
  if (fromDomain === "base" || fromDomain === "unknown") continue;

  const importRe = /(?:from|import)\s*["'](\.[^"']+)["']/g;
  let m;
  while ((m = importRe.exec(text)) !== null) {
    const target = resolveImport(file, m[1]);
    if (!target) continue;
    // Nest 装配：模块文件 import 另一个模块文件是接线（imports 数组），不是跨域调用
    if (target.endsWith(".module.ts")) continue;
    const targetDomain = domainOf(target);

    // 同域 / 基础层 / 持久化契约文件：放行
    if (targetDomain === fromDomain) continue;
    if (targetDomain === "base") continue;
    if (targetDomain === "persist" && isContract(target)) continue;

    // combat 是纯函数库：除了自己只许引基础层（上面已放行），引别的就是环
    if (fromDomain === "combat") {
      failures.push(`${rel} → ${target}：combat 只许引基础层（common/shared/config），不许引 ${targetDomain}`);
      continue;
    }

    // 持久化实现：统一走仓储边表（world 也一样 —— 它只许摸 world-monster 仓储，
    // 不许因为「我是状态持有者」就连角色表一起翻）
    if (targetDomain === "persist") {
      const allowed = Object.entries(REPO_EDGES).some(([repo, mods]) => target === repo && mods.some((mod) => rel.startsWith(mod)));
      if (allowed) continue;
      failures.push(`${rel} → ${target}：仓储装配/注入不在白名单（REPO_EDGES 无这条边）`);
      continue;
    }

    // 跨业务域：查边白名单
    const edge =
      ALLOWED_EDGES.some((e) => rel.startsWith(e.from) && target.startsWith(e.to)) ||
      EXTRA_FILE_EDGES.some((e) => rel === e.from && target.startsWith(e.to));
    if (edge) continue;

    failures.push(`${rel} → ${target}：跨域 import 不在白名单（ALLOWED_EDGES 无这条边）`);
  }
}

// ── 2. 仓储装配唯一：业务模块不许注册仓储 ──────────────────────────────────
for (const { rel, text } of moduleFiles) {
  if (rel.endsWith("database.module.ts")) continue;
  if (/providers\s*:\s*\[[^\]]*Repository/.test(text)) {
    failures.push(`${rel}：providers 里注册了仓储 —— 8 个仓储只许由全局 DatabaseModule 装配（同名本地注册会造出第二个实例）`);
  }
}

if (failures.length > 0) {
  console.log(`✗ 服务端内部边界违规 ${failures.length} 处：\n`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log("\n跨域引用请走白名单边：改 ALLOWED_EDGES / REPO_EDGES 前先想清楚这条边属于哪个域的合约。");
  process.exit(1);
}

console.log("✔ 服务端内部边界干净（跨模块边走白名单 / 仓储只由 DatabaseModule 装配 / combat 不引实现）");
