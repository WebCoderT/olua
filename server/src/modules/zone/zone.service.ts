import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { AccountRepository } from "../../database/repositories/account.repository";
import { RoleRepository } from "../../database/repositories/role.repository";
import { ROLE_NAME_MAX_LENGTH } from "../roles/role-data.util";
import { WorldMonsterRepository } from "../../database/repositories/world-monster.repository";
import { instanceIdOf } from "../../common/utils/room-key.util";
import { resolveZoneId } from "../../common/guards/zone-context.guard";
import { ZoneRepository } from "../../database/repositories/zone.repository";
import { GuildRepository } from "../../database/repositories/guild.repository";
import { MapMonitorRepository } from "../../database/repositories/map-monitor.repository";
import { RolePositionRepository } from "../../database/repositories/role-position.repository";
import { WorldReloadRequestRepository } from "../../database/repositories/world-reload-request.repository";
import { ZoneRow } from "../../database/rows";
import { ZONE_STATUS, ZONE_STATUS_ALL as ALL_STATUS } from "../../common/constants/zone-status";
import {
  AdminZoneDto,
  CreateZoneDto,
  MergePrecheckDto,
  MergeReportDto,
  MyZoneDto,
  UpdateZoneDto,
  ZoneDto,
  ZoneOptionDto,
  ZoneStatusDto,
} from "./dto/zone.dto";

/** 区服运营状态（#961 状态机：open ⇄ maintenance → closed）—— 定义在 common，玩家侧 / 实时侧共用 */
export { ZONE_STATUS, ZONE_STATUS_ALL, isPlayableStatus } from "../../common/constants/zone-status";

/** 从 instanceId 解析发牌序号（与 WorldService 内部同一口径：取最后一个 `_` 之后的数字） */
function parseSeq(instanceId: string): number {
  const at = instanceId.lastIndexOf("_");
  if (at < 0) return 0;
  const seq = Number(instanceId.slice(at + 1));
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
}

/**
 * 区服（#295 阶段二：多开区 / 合并区；#961：运营状态 / 维护 / 合区向导）
 *
 * ## 多开区
 * 账号注册时选定归属区；世界按区隔离（每个区的每张图都独立播种一份怪物实例）。
 * 登录不换区 —— 归属区只在「合并区」时变（管理员操作，玩家自己换不了）。
 *
 * ## 状态机（#961）
 * ```
 * open ──维护──▶ maintenance ──恢复──▶ open
 *   │                 │
 *   └──────关闭───────┴──▶ closed（不可逆）
 * ```
 * 维护**不冻结世界**：世界照常 tick 与落盘，只是「新人进不来」；在线的人收到倒计时后
 * 被断开（见 `ZoneMaintenanceService`）。`closed` 是「这个区不再对外」——
 * 数据还在（客服能查历史），但玩家侧选不到、进不去。
 *
 * ## 合并区
 * 把 from 区并入 to 区，一个事务里做六件事：
 * 1. **搬角色**（#957：区归属的唯一权威是 `roles.zone_id`），同账号同名自动改名；
 * 2. **搬账号**（只剩「当前浏览区」语义：这些人下次登录默认落在 to 区）；
 * 3. **重排世界发牌**：from 区的怪物实例改挂 to 区，instanceId 重写为 to 区的区段
 *    （`m<map>_z<to>_c<slot>_<n>`），序号接着 to 区同图已有实例往下编 —— 保证全服不重号；
 * 4. **搬帮会**（#958：`guilds.zone_id`）；
 * 5. **清残留**：源区的重载请求置 failed（否则实时进程会在死区上重载并重新播种）、
 *    监控投影与角色位置直接删（都是运行时投影，重启清空也无所谓）；
 * 6. **打标记 + 只 bump 这两个区的代际**（#961：以前是全服 epoch+1，合并一次所有图都白重建）。
 */
@Injectable()
export class ZoneService {
  private readonly logger = new Logger(ZoneService.name);

  constructor(
    private readonly zones: ZoneRepository,
    private readonly worldMonsters: WorldMonsterRepository,
    private readonly accounts: AccountRepository,
    private readonly roles: RoleRepository,
    private readonly guilds: GuildRepository,
    private readonly mapMonitor: MapMonitorRepository,
    private readonly rolePositions: RolePositionRepository,
    private readonly reloadRequests: WorldReloadRequestRepository,
  ) {}

  /** 活区列表（玩家注册下拉框：只列未合并的） */
  listLive(): ZoneDto[] {
    return this.zones.listLive().map(ZoneDto.from);
  }

  /** 全部区服（管理端列表：含已合并的，附聚合列） */
  listAll(): AdminZoneDto[] {
    return this.zones.listAll().map((row) => this.adminDtoOf(row));
  }

  /** 可选区（#960：登录页下拉；未合并 + 按 sort，含 closed，字段见 ZoneOptionDto） */
  options(): ZoneOptionDto[] {
    return this.zones.listSelectable().map((row) => ZoneOptionDto.from(row));
  }

  /**
   * 校验并返回区 id（登录时用；四条拒绝理由与守卫**同一句话**）
   *
   * 复用守卫里那个 `resolveZoneId`，而不是另写一份判断 —— 两处各写一份的话，
   * 迟早出现「登录能选的区，进去第一个请求就 400」。
   *
   * 放在 service 而不是让登录直接注入 `ZoneRepository`：仓储是 zone 模块的私产，
   * 跨模块直接装配会被 `audit-server-boundaries` 拦（也确实该拦）。
   */
  assertSelectable(raw: string | number | undefined): number {
    return resolveZoneId(this.zones, raw);
  }

  /** 开新区（名字查重后落库；区 id 自增，注册端立即可选） */
  create(dto: CreateZoneDto): AdminZoneDto {
    const trimmed = dto.name.trim();
    if (this.zones.findByName(trimmed)) throw BizException.conflict(BizCode.ZONE_NAME_EXISTS, "该区服名已存在");
    const now = Date.now();
    const id = this.zones.create(trimmed, now, {
      openedAt: dto.openedAt ?? now,
      sort: dto.sort ?? 0,
      recommended: dto.recommended ?? false,
      note: dto.note ?? null,
    });
    this.logger.log(`开新区：${trimmed}（id=${id}）`);
    return this.adminDtoOf(this.zones.findById(id) as ZoneRow);
  }

  /** 改运营字段（排序 / 推荐 / 备注 / 开服时间；改名刻意不提供，见 ZoneRepository.updateSettings） */
  update(id: number, dto: UpdateZoneDto): AdminZoneDto {
    const zone = this.mustZone(id);
    if (zone.merged_into !== null) {
      throw new BizException(BizCode.ZONE_MERGED, `区服「${zone.name}」已并入其他区，不能再改设置`, HttpStatus.CONFLICT);
    }
    this.zones.updateSettings(
      id,
      { sort: dto.sort, recommended: dto.recommended, note: dto.note, openedAt: dto.openedAt },
      Date.now(),
    );
    return this.adminDtoOf(this.zones.findById(id) as ZoneRow);
  }

  /**
   * 改状态（#961 状态机，非法迁移在这里拦住）
   *
   * - `closed` 是**终点**：已经关了就不能再开（数据还在但对外永久关闭；真要重开只能开新区）。
   *   这条不是洁癖 —— 允许「关→开」等于允许运营把一批老玩家拉回一个世界已经很久没落盘的区，
   *   而那个区的怪物实例还是几个月前的状态。
   * - 合并过的区不许改状态：它已经是历史行。
   * - 目标状态必须是三值之一（DTO 只做字符串校验，取值域在这里收）。
   */
  setStatus(id: number, status: string, reason?: string): AdminZoneDto {
    const zone = this.mustZone(id);
    if (!ALL_STATUS.includes(status)) {
      throw new BizException(BizCode.ZONE_STATUS_INVALID, `未知的区服状态：${status}`, HttpStatus.BAD_REQUEST);
    }
    if (zone.merged_into !== null) {
      throw new BizException(BizCode.ZONE_MERGED, `区服「${zone.name}」已并入其他区，状态不可再改`, HttpStatus.CONFLICT);
    }
    if (zone.status === status) return this.adminDtoOf(zone);
    if (zone.status === ZONE_STATUS.CLOSED) {
      throw new BizException(BizCode.ZONE_STATUS_INVALID, `区服「${zone.name}」已关闭，关闭不可逆`, HttpStatus.CONFLICT);
    }
    this.zones.setStatus(id, status, Date.now());
    this.logger.log(`区服状态变更：${zone.name}（id=${id}）${zone.status} → ${status}${reason ? `，原因：${reason}` : ""}`);
    return this.adminDtoOf(this.zones.findById(id) as ZoneRow);
  }

  /**
   * 合区预检（#961：**不通过不给点**）
   *
   * 事务外能查的全查一遍，把「点了才知道要重来」的坑提前到按钮上：两区都必须 `open`、
   * 不能是同一个、源区还有多少在线（会被断开）、多少条待执行重载（会作废）、多少帮会
   * （会搬走）。帮会撞名**恒为空**：帮会名是全服唯一的（#958），合并也不可能撞。
   */
  precheckMerge(fromZoneId: number, toZoneId: number): MergePrecheckDto {
    const blockers: string[] = [];
    const from = this.zones.findById(fromZoneId);
    const to = this.zones.findById(toZoneId);
    if (!from) blockers.push(`源区 ${fromZoneId} 不存在`);
    if (!to) blockers.push(`目标区 ${toZoneId} 不存在`);
    if (from && to && from.id === to.id) blockers.push("源区与目标区不能是同一个");
    // 已合并就到此为止：再补一句「当前是 closed，先恢复」是**错指引** —— 区已经不存在了，
    // 运营照着做只会去点一个必然失败的恢复。状态检查只对「还活着但没开放」的区有意义。
    const fromMerged = !!from && from.merged_into !== null;
    const toMerged = !!to && to.merged_into !== null;
    if (fromMerged) blockers.push(`源区「${from.name}」已并入其他区`);
    if (toMerged) blockers.push(`目标区「${to.name}」已并入其他区`);
    if (from && !fromMerged && from.status !== ZONE_STATUS.OPEN) {
      blockers.push(`源区「${from.name}」当前是 ${from.status}，合区要求两个区都 open（先恢复）`);
    }
    if (to && !toMerged && to.status !== ZONE_STATUS.OPEN) {
      blockers.push(`目标区「${to.name}」当前是 ${to.status}，合区要求两个区都 open（先恢复）`);
    }

    const dto = new MergePrecheckDto();
    dto.fromZoneId = fromZoneId;
    dto.toZoneId = toZoneId;
    dto.fromName = from?.name ?? "";
    dto.toName = to?.name ?? "";
    dto.fromStatus = from?.status ?? "";
    dto.toStatus = to?.status ?? "";
    dto.onlineCount = from ? this.accounts.countOnline(fromZoneId) : 0;
    dto.pendingReloads = from ? this.reloadRequests.countPendingOfZone(fromZoneId) : 0;
    dto.accountCount = from ? this.zones.countAccounts(fromZoneId) : 0;
    dto.roleCount = from ? this.roles.countAll(fromZoneId) : 0;
    dto.guildCount = from ? this.guilds.countByZone(fromZoneId) : 0;
    dto.monsterCount = from ? this.worldMonsters.countByZone(fromZoneId) : 0;
    dto.guildConflicts = [];
    dto.blockers = blockers;
    dto.ok = blockers.length === 0;
    return dto;
  }

  /** 合并区（见类注释的六步；from / to 的边界都在事务外先校验，事务里只做搬家） */
  merge(fromZoneId: number, toZoneId: number): MergeReportDto {
    if (fromZoneId === toZoneId) {
      throw new BizException(BizCode.ZONE_MERGE_SAME, "不能把区合并进它自己", HttpStatus.CONFLICT);
    }
    // 存在性 / 已合并 / 维护中这三种拒绝**先单独判**，各自给最精确的码 ——
    // 预检（precheckMerge）是给向导页看的「能不能点」，它把所有原因揉成一句话；
    // 真合并时调用方需要知道「到底是区没了，还是区在维护」，两者处理方式完全不同。
    const from = this.assertMergeable(fromZoneId, "要并入的源区");
    const to = this.assertMergeable(toZoneId, "并入的目标区");
    const precheck = this.precheckMerge(fromZoneId, toZoneId);
    if (!precheck.ok) {
      throw new BizException(BizCode.ZONE_MERGE_BLOCKED, `合区预检不通过：${precheck.blockers.join("；")}`, HttpStatus.CONFLICT);
    }
    const now = Date.now();

    const movedAccounts = this.zones.countAccounts(fromZoneId);
    let renamedRoles: Array<{ id: string; name: string; renamed: string }> = [];
    let movedGuilds = 0;
    let failedReloads = 0;
    let positionsRemoved = 0;
    let monitorStates = 0;
    let monitorEvents = 0;
    const movedMonsters = this.zones.transaction(() => {
      // ⓪ 位置行必须在搬角色**之前**删：这张表没有 zone_id，只能反查 roles.zone_id
      positionsRemoved = this.rolePositions.removeByZoneRoles(fromZoneId);

      // ① 先搬**角色**（#957：区归属的唯一权威是 roles.zone_id）。
      // 同账号在两个区同名时会撞 UNIQUE(account_id, zone_id, name)，那是改名那一步解决的
      // （口径：系统自动改名，后缀 = 源区名；清单进合并报告）。必须在搬账号之前，
      // 因为改名的判据是「to 区已有同名」，而搬账号不影响角色行。
      renamedRoles = this.roles.moveZoneOfRoles(fromZoneId, toZoneId, `·${from.name}`, ROLE_NAME_MAX_LENGTH, now);

      // ② 搬账号（只剩「当前浏览区」语义：这些人下次登录默认落在 to 区）
      this.accounts.moveAllAccounts(fromZoneId, toZoneId, now);

      // ③ 重排 from 区的世界发牌：instanceId 换成 to 区的区段，序号接着 to 区同图的已有实例续
      const monsters = this.worldMonsters.listByZone(fromZoneId);
      const seqByMap = new Map<string, number>();
      for (const row of monsters) {
        if (!seqByMap.has(row.map_id)) {
          // 首遇这张图：从 to 区同图实例里找最大序号（instanceId 尾段，parseSeq 口径与 WorldService 一致）
          let maxSeq = 0;
          for (const existing of this.worldMonsters.listByRoom(toZoneId, row.map_id, row.slot)) {
            maxSeq = Math.max(maxSeq, parseSeq(existing.instance_id));
          }
          seqByMap.set(row.map_id, maxSeq);
        }
        const nextSeq = (seqByMap.get(row.map_id) ?? 0) + 1;
        seqByMap.set(row.map_id, nextSeq);
        this.worldMonsters.rekey(row.instance_id, {
          ...row,
          instance_id: instanceIdOf(row.map_id, toZoneId, row.slot, nextSeq),
          zone_id: toZoneId,
          updated_at: now,
        });
      }

      // ④ 搬帮会（#958 起帮会绑区）
      movedGuilds = this.guilds.moveZoneOfGuilds(fromZoneId, toZoneId, now);

      // ⑤ 清残留：待执行重载作废（留着会给死区重新播种）、监控投影删掉
      failedReloads = this.reloadRequests.failPendingOfZone(fromZoneId, "zone_merged", now);
      const monitor = this.mapMonitor.removeZone(fromZoneId);
      monitorStates = monitor.states;
      monitorEvents = monitor.events;

      // ⑥ 打合并标记 + **只** bump 这两个区的代际（#961：不再全服作废）
      this.zones.markMerged(fromZoneId, toZoneId, now);
      this.zones.bumpEpochs([fromZoneId, toZoneId]);
      return monsters.length;
    });

    this.logger.log(
      `合并区：${from.name}（id=${fromZoneId}）→ ${to.name}（id=${toZoneId}），搬账号 ${movedAccounts} 个、` +
        `角色 ${precheck.roleCount} 个（改名 ${renamedRoles.length}）、帮会 ${movedGuilds} 个、世界实例 ${movedMonsters} 只、` +
        `作废重载请求 ${failedReloads} 条、清监控 ${monitorStates} 行快照 / ${monitorEvents} 条事件、` +
        `清位置 ${positionsRemoved} 行，代际只动 ${fromZoneId} / ${toZoneId}`,
    );
    const report = new MergeReportDto();
    report.fromZoneId = fromZoneId;
    report.toZoneId = toZoneId;
    report.fromName = from.name;
    report.toName = to.name;
    report.accountCount = movedAccounts;
    report.roleCount = precheck.roleCount;
    report.monsterCount = movedMonsters;
    report.guildCount = movedGuilds;
    report.renamedRoles = renamedRoles;
    report.failedReloads = failedReloads;
    report.removedMonitorStates = monitorStates;
    report.removedMonitorEvents = monitorEvents;
    report.removedPositions = positionsRemoved;
    report.onlineDisconnected = precheck.onlineCount;
    report.mergedAt = now;
    return report;
  }

  /**
   * 我的区服（#957）：`GET /zones/mine`
   *
   * 账号级聚合，是玩家侧**唯一**一次返回多个区的接口 —— 它只带「我在这个区有几个角色」，
   * 不含任何别的区的游戏数据，用来渲染选服弹窗。`status`（#961）让客户端能把维护 / 关闭
   * 的区置灰。
   */
  mine(accountId: string): MyZoneDto[] {
    const account = this.accounts.findById(accountId);
    if (!account) throw BizException.notFound(BizCode.ACCOUNT_NOT_FOUND, "账号不存在");
    return this.zones
      .listLive()
      .map((row) => MyZoneDto.of(row, this.roles.countByAccountAndZone(row.id, accountId), row.id === account.active_zone_id));
  }

  /**
   * 选服（#957）：`POST /zones/select`
   *
   * 只改**当前浏览区**（`accounts.active_zone_id`），不改任何角色归属 —— 区是角色的属性，
   * 玩家换区玩就是换一组角色，不是「搬家」。校验一条：区**现在开放**（#961 起维护中 /
   * 已关闭都不许进 —— 这条就是当初留在代码里的 TODO）。
   *
   * **换区会清掉「当前在线角色」**：在线角色在 A 区、人却在 B 区浏览，会让
   * `GET /roles/online` 与实时进图各说各话（`GET /roles` 出 B 区、进图按在线角色落 A 区）。
   * 换区的语义本来就是「换一组角色」，所以清空是最诚实的做法 —— 客户端在新区重新选角。
   * 选的是同一个区则什么都不动（避免重复点一下就把人踢出角色）。
   */
  select(accountId: string, zoneId: number): { zoneId: number } {
    const account = this.accounts.findById(accountId);
    if (!account) throw BizException.notFound(BizCode.ACCOUNT_NOT_FOUND, "账号不存在");
    const zone = this.assertOpen(zoneId, "所选区服");
    const patch: Parameters<AccountRepository["updateById"]>[1] = { active_zone_id: zone.id, updated_at: Date.now() };
    if (account.active_zone_id !== zone.id) patch.online_role_id = null;
    this.accounts.updateById(accountId, patch);
    return { zoneId: zone.id };
  }

  /**
   * 玩家侧闸门：这个区**现在能进吗**（#961）
   *
   * 三种拒绝分开说：不存在（404）→ 已合并（409）→ 维护 / 关闭（`ZONE_UNAVAILABLE`）。
   * 与守卫那套「四种理由同一句话」不同：这里是玩家自己选的区，说清楚原因他才知道等一等
   * 还是换个区。
   */
  assertOpen(zoneId: number, label: string): ZoneRow {
    const row = this.zones.findById(zoneId);
    if (!row) throw BizException.notFound(BizCode.ZONE_NOT_FOUND, `${label}不存在`);
    if (row.merged_into !== null) {
      throw new BizException(BizCode.ZONE_MERGED, `${label}（${row.name}）已并入其他区`, HttpStatus.CONFLICT);
    }
    if (row.status === ZONE_STATUS.MAINTENANCE) {
      throw new BizException(BizCode.ZONE_UNAVAILABLE, `${label}（${row.name}）正在维护，请稍后再进`, HttpStatus.CONFLICT);
    }
    if (row.status === ZONE_STATUS.CLOSED) {
      throw new BizException(BizCode.ZONE_UNAVAILABLE, `${label}（${row.name}）已关闭`, HttpStatus.CONFLICT);
    }
    return row;
  }

  /** 区状态快照（实时进程的维护巡检用；区数个位数，直接给全表） */
  states(): Array<{ id: number; name: string; status: string; mergedInto: number | null }> {
    return this.zones.listStates().map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      mergedInto: row.merged_into,
    }));
  }

  /** 单个区的状态（进图闸门用；不存在返回 null） */
  statusOf(zoneId: number): ZoneStatusDto | null {
    const row = this.zones.stateOf(zoneId);
    if (!row) return null;
    const dto = new ZoneStatusDto();
    dto.id = row.id;
    dto.name = row.name;
    dto.status = row.status;
    dto.mergedInto = row.merged_into;
    return dto;
  }

  /** 聚合列（管理端列表 / 单区详情共用） */
  private adminDtoOf(row: ZoneRow): AdminZoneDto {
    return AdminZoneDto.from(row, {
      accountCount: this.zones.countAccounts(row.id),
      roleCount: this.roles.countAll(row.id),
      onlineCount: this.accounts.countOnline(row.id),
      monsterCount: this.worldMonsters.countByZone(row.id),
      guildCount: this.guilds.countByZone(row.id),
      pendingReloads: this.reloadRequests.countPendingOfZone(row.id),
    });
  }

  /** 断言「这个区能参与合区」：存在、未合并、开放中（三种拒绝各给精确的码） */
  private assertMergeable(zoneId: number, label: string): ZoneRow {
    const row = this.zones.findById(zoneId);
    if (!row) throw BizException.notFound(BizCode.ZONE_NOT_FOUND, `${label}不存在`);
    if (row.merged_into !== null) {
      throw new BizException(BizCode.ZONE_MERGED, `${label}（${row.name}）已并入其他区`, HttpStatus.CONFLICT);
    }
    if (row.status !== ZONE_STATUS.OPEN) {
      const why = row.status === ZONE_STATUS.MAINTENANCE ? "正在维护" : "已关闭";
      throw new BizException(
        BizCode.ZONE_UNAVAILABLE,
        `${label}（${row.name}）${why} —— 先恢复到 open 再合区`,
        HttpStatus.CONFLICT,
      );
    }
    return row;
  }

  private mustZone(zoneId: number): ZoneRow {
    const row = this.zones.findById(zoneId);
    if (!row) throw BizException.notFound(BizCode.ZONE_NOT_FOUND, "区服不存在");
    return row;
  }
}
