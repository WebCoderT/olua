import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  LEADERBOARD_BOARDS,
  LEADERBOARD_BOARD,
  LEADERBOARD_BOARD_LABELS,
  LEADERBOARD_NO_RANK,
  LEADERBOARD_REFRESH_MS_DEFAULT,
  LEADERBOARD_TOP_N_DEFAULT,
  type LeaderboardBoard,
} from "../../common/constants/leaderboard";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { AccountRepository } from "../../database/repositories/account.repository";
import { RoleRepository } from "../../database/repositories/role.repository";
import { RoleLeaderboardRow } from "../../database/rows";
import { summarizeRoleAttributes } from "../combat/role-attributes";
import { LeaderboardEntryDto, LeaderboardPageDto, LeaderboardQueryDto, LeaderboardSelfDto } from "./dto/leaderboard.dto";

/** 一个角色的三个榜共用的「算好的原料」（一次扫描只算一遍战力，三个榜共享） */
interface ScoredRole {
  roleId: string;
  name: string;
  occupation: string;
  level: number;
  kills: number;
  zoneId: number;
  /** 战斗力（等级不在成长曲线里 / 存档解析失败时为 0 —— 见 `combatOf`） */
  combat: number;
}

/** 一个榜的一份快照（物化产物；不可变，重算时整份替换） */
interface BoardSnapshot {
  /**
   * 榜本身（**截断到 topN**，按名次升序）
   *
   * 分页从这里切片；`total` 也就等于它的长度 —— 「榜有多长」由配置定，
   * 不因为角色多就无限长（谁想看第 5000 名？他要看的是自己那一条，走 `me`）。
   */
  entries: LeaderboardEntryDto[];
  /**
   * 全量索引（roleId → 条目）
   *
   * 比 `entries` 大（每个角色都有），但 `me` 要靠它：名次是在**全量排序**里算出来的，
   * 一个排在 3000 名的玩家也要能看到「你是第 3000 名」。条目对象只分配一次，
   * `entries` 是同一批对象的切片，所以内存开销约等于「一份全量 + 一条指针数组」。
   */
  byRole: Map<string, LeaderboardEntryDto>;
  /** 这份快照算出来的时刻（毫秒） */
  computedAt: number;
}

/**
 * 排行榜（#400）
 *
 * ===========================================================================
 * 口径（写进 #400 认领留言，改这里先改那边）
 * ===========================================================================
 * 三个榜：等级 / 战力 / 击杀。**并列同分同名次**（竞赛排名 1、2、2、4），
 * 同分再按 `roleId` 升序 —— 这条二次键的意义不是「公平」，是**稳定**：
 * 没有它，两次重算之间同分的人会互换位置，玩家看到自己的名次上下抖，
 * 而实际什么都没变。
 *
 * 离线也上榜：读的是 `roles` 存档表，不要求在线（离线玩家也是榜的一部分）。
 *
 * ===========================================================================
 * 为什么是「进程内物化」而不是每次现算，也不是落一张快照表
 * ===========================================================================
 * - **不每次现算**：一次现算 = 全表读 + 逐行解析存档 + 三个排序。榜会被频繁打开
 *   （点一下就刷），而榜单的价值恰恰是「所有人看到同一份」——现算等于每人一份，
 *   还顺带把「谁先打开谁看到旧名次」变成随机现象。
 * - **不落快照表**：榜是 `roles` 的**纯派生数据**。落库就多出第二个真相：
 *   角色升了级而快照表没跟上，两者谁对？派生数据不落库，就没有这个问题。
 *   进程重启的代价是「第一分钟算不出来」——而首次请求是惰性算的，实际是零等待。
 * - **重算不撕裂**：整份快照（三个榜）一次性算完，最后**一次赋值**换掉引用。
 *   读侧永远拿到「某个完整时刻的三个榜」，不会读到「等级榜是新的、战力榜是旧的」，
 *   也不会读到算了一半的数组。
 *
 * ===========================================================================
 * 定时器为什么在「第一次有人看榜」时才起
 * ===========================================================================
 * 这个模块在两个进程里都会被装载（`AppModule` 无条件 import），但只有 API 进程
 * 会收到 HTTP 请求。若在 `onApplicationBootstrap` 起定时器，**实时进程**会白白
 * 每分钟扫一次全表、算三遍战力，算完还没有任何读者。
 * 所以：首次请求 → 算一次 → 顺手起定时器（`unref`，不阻止进程退出）。
 * 实时进程从不请求，就永远不扫。`LEADERBOARD_REFRESH_MS=0` 表示「不起定时器」，
 * 只有首次那一份快照 —— e2e 用它把「快照语义」测出来（升级之后榜不变，重算之后才变）。
 */
@Injectable()
export class LeaderboardService implements OnApplicationShutdown {
  private readonly logger = new Logger(LeaderboardService.name);
  /** 物化快照（null = 还没算过；首次请求时算） */
  private cache: Record<LeaderboardBoard, BoardSnapshot> | null = null;
  /** 重算定时器（只有被请求过才会存在） */
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly roles: RoleRepository,
    private readonly accounts: AccountRepository,
  ) {}

  /** 进程退出前收掉定时器（e2e 起停多台服务，留着会拖住事件循环） */
  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 分页读一个榜
   *
   * `size` 超过 `LEADERBOARD_TOP_N` 时**夹到上限**而不是报错：客户端把 size 写大了
   * 是他自己的事，榜本来就只有这么长，给满是更友好的回应。
   */
  page(board: LeaderboardBoard, query: LeaderboardQueryDto): LeaderboardPageDto {
    const snapshot = this.snapshotOf(board);
    const size = Math.min(Math.max(1, Math.floor(query.size ?? 20)), this.topN());
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const start = (page - 1) * size;
    return {
      list: snapshot.entries.slice(start, start + size),
      total: snapshot.entries.length,
      page,
      size,
      computedAt: snapshot.computedAt,
    };
  }

  /**
   * 我在这个榜上的位置
   *
   * 取**当前在线角色**：玩家在游戏里看榜，关心的是「我这个角色第几」。
   * 没有在线角色（没进游戏 / 被踢）→ `rank = 0`，不是 404：
   * 界面上「你还没有名次」是正常状态，客户端不必为它写一条错误分支。
   */
  me(board: LeaderboardBoard, accountId: string): LeaderboardSelfDto {
    const snapshot = this.snapshotOf(board);
    const account = this.accounts.findById(accountId);
    const roleId = account?.online_role_id ?? "";
    const entry = roleId ? (snapshot.byRole.get(roleId) ?? null) : null;
    return {
      rank: entry ? entry.rank : LEADERBOARD_NO_RANK,
      entry,
      computedAt: snapshot.computedAt,
    };
  }

  /** 路由参数校验（非法值是 40000 + 说清有哪几个榜，而不是让它静默返回空榜） */
  assertBoard(value: string): LeaderboardBoard {
    if (!(LEADERBOARD_BOARDS as string[]).includes(value)) {
      const names = LEADERBOARD_BOARDS.map((board) => `${board}（${LEADERBOARD_BOARD_LABELS[board]}）`).join(" / ");
      throw new BizException(BizCode.PARAM_INVALID, `未知的榜单：${value}（可选：${names}）`);
    }
    return value as LeaderboardBoard;
  }

  //#region 物化

  /** 取一份快照（没有就现场算；算完顺手起定时器） */
  private snapshotOf(board: LeaderboardBoard): BoardSnapshot {
    if (!this.cache) {
      this.cache = this.recompute();
      this.startTimer();
    }
    return this.cache[board];
  }

  /**
   * 起重算定时器（只在第一次被请求后调）
   *
   * `unref()`：定时器存在不代表「进程还有活干」，否则 e2e 的 `child.kill()` 之后
   * 进程要等这个 interval 到点才退。
   */
  private startTimer(): void {
    if (this.timer) return;
    const interval = this.refreshMs();
    if (interval <= 0) return;
    this.timer = setInterval(() => this.refresh(), interval);
    this.timer.unref?.();
  }

  /** 定时重算：失败只记日志，旧快照继续服务（榜单挂了不该把接口拖垮） */
  private refresh(): void {
    try {
      this.cache = this.recompute();
    } catch (error) {
      this.logger.warn(`榜单重算失败，继续用上一份快照：${(error as Error).message}`);
    }
  }

  /**
   * 重算三个榜（一次扫描，三个排序）
   *
   * 顺序是「先读 → 再算 → 最后一次性换引用」：中途抛异常时 `this.cache` 仍是旧的那份，
   * 读者不会看到空榜。
   */
  private recompute(): Record<LeaderboardBoard, BoardSnapshot> {
    const startedAt = Date.now();
    const rows = this.roles.listForLeaderboard();
    const scored: ScoredRole[] = rows.map((row) => this.scoreOf(row));
    const computedAt = startedAt;
    const next = {} as Record<LeaderboardBoard, BoardSnapshot>;
    for (const board of LEADERBOARD_BOARDS) {
      next[board] = this.buildBoard(board, scored, computedAt);
    }
    const top = Math.max(...LEADERBOARD_BOARDS.map((board) => next[board].entries.length));
    this.logger.debug(`榜单重算完成：${scored.length} 个角色，耗时 ${Date.now() - startedAt}ms，最长榜 ${top} 条`);
    return next;
  }

  /**
   * 把一个榜排出来（排序 + 竞赛排名 + 截断）
   *
   * 名次按**下标 + 1** 起算，遇到「分数与上一条不同」才换名次 —— 这就是 1、2、2、4
   * （竞赛排名）：并列的人占掉同名次，后面那位跳过被占的名次。
   */
  private buildBoard(board: LeaderboardBoard, scored: ScoredRole[], computedAt: number): BoardSnapshot {
    const sorted = [...scored].sort((left, right) => this.compare(board, left, right));
    const all: LeaderboardEntryDto[] = [];
    const byRole = new Map<string, LeaderboardEntryDto>();
    let rank = 0;
    let previous: number | null = null;
    sorted.forEach((item, index) => {
      const score = this.scoreOfBoard(board, item);
      if (previous === null || score !== previous) rank = index + 1;
      previous = score;
      const entry: LeaderboardEntryDto = {
        rank,
        roleId: item.roleId,
        name: item.name,
        occupation: item.occupation,
        level: item.level,
        combat: item.combat,
        kills: item.kills,
        zoneId: item.zoneId,
      };
      all.push(entry);
      byRole.set(item.roleId, entry);
    });
    return { entries: all.slice(0, this.topN()), byRole, computedAt };
  }

  /** 榜的排序：分数降序，同分按 roleId 升序（稳定，见类注释） */
  private compare(board: LeaderboardBoard, left: ScoredRole, right: ScoredRole): number {
    const diff = this.scoreOfBoard(board, right) - this.scoreOfBoard(board, left);
    if (diff !== 0) return diff;
    return left.roleId < right.roleId ? -1 : left.roleId > right.roleId ? 1 : 0;
  }

  /** 该榜用的分数（三个榜各自一个字段，没有加权合成 —— 加权会让「名次」变得无法解释） */
  private scoreOfBoard(board: LeaderboardBoard, role: ScoredRole): number {
    if (board === LEADERBOARD_BOARD.LEVEL) return role.level;
    if (board === LEADERBOARD_BOARD.COMBAT) return role.combat;
    return role.kills;
  }

  //#endregion

  //#region 原料

  /**
   * 一行存档 → 三个榜的原料
   *
   * 战力靠 `summarizeRoleAttributes` 现算（它与客户端 `combatCalc` 是同源的两份实现，
   * `make audit-combat-parity` 逐位比对）。**算不出来就给 0**，不让它把整次重算带崩：
   * 等级超出成长曲线（旧存档 / 后台手工改过）、存档 JSON 坏掉，都属于「这一个角色数据有问题」，
   * 不该让全服榜一起没了。
   */
  private scoreOf(row: RoleLeaderboardRow): ScoredRole {
    return {
      roleId: row.id,
      name: row.name,
      occupation: row.occupation,
      level: Math.max(0, Math.floor(row.level) || 0),
      kills: Math.max(0, Math.floor(row.kills) || 0),
      zoneId: row.zone_id,
      combat: this.combatOf(row),
    };
  }

  /**
   * 战力（读存档里的四项养成项）
   *
   * 只取算战力要用的字段，不把整份 `data` 传下去 —— 存档里有背包 / 技能栏 / 任务，
   * 那些跟战力无关，传进去只会让人以为它们算数。
   */
  private combatOf(row: RoleLeaderboardRow): number {
    const data = this.parseStoredData(row.data);
    if (!data) return 0;
    const summary = summarizeRoleAttributes({
      level: row.level,
      equipments: (data.equipments as Record<string, string | null> | undefined) ?? null,
      soulOfWar: typeof data.soulOfWar === "number" ? data.soulOfWar : undefined,
      title: typeof data.title === "number" ? data.title : undefined,
      rank: typeof data.rank === "number" ? data.rank : undefined,
    });
    return summary ? Math.max(0, Math.floor(summary.combat) || 0) : 0;
  }

  /** 解析存档文档（坏数据返回 null，由调用方给 0 —— 见 `scoreOf`） */
  private parseStoredData(raw: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  //#endregion

  //#region 配置

  /** 上榜条数（脏值回落默认：榜读错配置不该变成空榜） */
  private topN(): number {
    const raw = Number(this.config.get<number>("leaderboardTopN"));
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : LEADERBOARD_TOP_N_DEFAULT;
  }

  /** 重算周期（0 = 不起定时器，只有首次那份快照） */
  private refreshMs(): number {
    const raw = Number(this.config.get<number>("leaderboardRefreshMs"));
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : LEADERBOARD_REFRESH_MS_DEFAULT;
  }

  //#endregion
}
