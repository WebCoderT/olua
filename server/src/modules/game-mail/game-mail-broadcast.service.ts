import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { Permission, roleHasPermission } from "../../common/constants/permission";
import { AuthenticatedUser } from "../../common/interfaces/api-envelope.interface";
import { MailBroadcastRepository } from "../../database/repositories/mail-broadcast.repository";
import { RoleMailRepository } from "../../database/repositories/role-mail.repository";
import { RolesService } from "../roles/roles.service";
import { ZoneService } from "../zone/zone.service";
import { GameMailService, SendMailInput } from "./game-mail.service";
import { MailChannel } from "./mail-channel";
import {
  AdminBroadcastMailDto,
  BroadcastFilterDto,
  BroadcastPreviewDto,
  BroadcastPreviewResultDto,
  BroadcastScope,
  BroadcastViewDto,
  BROADCAST_SCOPES,
} from "./dto/game-mail-broadcast.dto";

/** 一个群发批次的正文模板（一次群发内所有行共用；`batchId` 单独穿参） */
type BroadcastTemplate = Omit<SendMailInput, "batchId">;

/**
 * 运营群发（#438）
 *
 * ## 三条定死的口径（issue 正文要求动手前写清楚）
 *
 * 1. **落库形态 = 每个角色一行**。`role_mails` 本来就有 `(role_id, created_at DESC)` 索引，
 *    已读 / 已领 / 过期 / 自动入包全按行工作；改成「一份公告 + 每人状态表」等于把上面四条
 *    全部重写一遍，收益只是省行数。真到百万行量级再说（重开条件：单批次 > 50 万行）。
 * 2. **幂等靠批次号**：`mail_broadcasts.id` 是主键，重复提交同一批次**一行都不写**，
 *    直接返回既有结果（`duplicated: true`）。不按「标题 + 正文」去重 —— 运营完全可能
 *    连着发两条一模一样的补偿，内容不是身份。
 * 3. **离线角色照发**：筛的是 `roles` 表全量，不看在线状态。邮件本来就是异步的。
 *    写入**分批**（默认 500 行一个事务）：一次几万行会长时间持着写锁，卡住实时进程的存档写入。
 *
 * ## 为什么要 `await`（同步驱动的坑）
 *
 * `DatabaseService` 是同步的（node:sqlite / better-sqlite3 风格），一个 `for` 循环写完几十批
 * 期间**事件循环完全不转**：同一进程里的 HTTP 请求、健康检查、定时任务全被堵住，
 * 管理端会看到「点了发送，整个后台卡 20 秒」。所以每批之间 `await setImmediate` 让一次。
 * 这不是「为了异步而异步」，是这个驱动模型下的必需品。
 *
 * ## 中断怎么办
 *
 * 进程挂在中间时 `finished_at` 停在 NULL，已经写出去的邮件**仍然算数**（不删）：
 * 删掉等于「玩家看到过一封，后来又消失了」。重提同一批次号会返回 `duplicated: true`，
 * 不会补发剩下的那些人 —— 补一半的批次该由人看着办（改条件重发新批次，或接受现状）。
 */
@Injectable()
export class GameMailBroadcastService {
  /** 管理端列表最多回这么多条（够看，不做分页 —— 群发本来就是低频动作） */
  private static readonly RECENT_LIMIT = 50;

  constructor(
    private readonly mails: RoleMailRepository,
    private readonly broadcasts: MailBroadcastRepository,
    private readonly gameMail: GameMailService,
    private readonly roles: RolesService,
    private readonly zones: ZoneService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 「预计影响 N 人」
   *
   * 发送前先算、且**与真正发送用同一套条件**（都走 `RolesService.countForBroadcast`）：
   * 两套 WHERE 迟早会分叉，分叉的表现是「预计 3000、实发 2987」，然后没人再信这个数字。
   */
  preview(actor: AuthenticatedUser, currentZoneId: number, dto: BroadcastPreviewDto): BroadcastPreviewResultDto {
    const range = this.rangeOf(dto.minLevel, dto.maxLevel);
    const zoneIds = this.zoneIdsOfScope(actor, dto.scope, currentZoneId);
    const result = new BroadcastPreviewResultDto();
    result.zoneIds = zoneIds;
    result.targetCount = zoneIds.reduce((sum, zoneId) => sum + this.roles.countForBroadcast(zoneId, range), 0);
    return result;
  }

  /**
   * 发一批（同步等它写完再返回）
   *
   * 返回时 `finishedAt` 已经落库：调用方拿到的就是最终结果，不需要再轮询。
   */
  async broadcast(
    actor: AuthenticatedUser,
    currentZoneId: number,
    dto: AdminBroadcastMailDto,
  ): Promise<BroadcastViewDto> {
    const range = this.rangeOf(dto.minLevel, dto.maxLevel);
    const zoneIds = this.zoneIdsOfScope(actor, dto.scope, currentZoneId);

    // 先看这个批次号是不是发过：发过就一行都不写，原样把上次的结果还给运营
    const existing = this.broadcasts.findByKey(dto.batchId);
    if (existing) return BroadcastViewDto.of(existing, true);

    const now = Date.now();
    const filter: BroadcastFilterDto = {
      scope: dto.scope as BroadcastScope,
      // scope = all 时记 null：历史批次要能解释成「当时所有未合并的区」，而不是「当时那个区」
      zoneId: dto.scope === "all" ? null : currentZoneId,
      minLevel: dto.minLevel,
      maxLevel: dto.maxLevel,
    };
    const claimed = this.broadcasts.tryInsert({
      id: dto.batchId,
      channel: dto.channel,
      kind: "admin-broadcast",
      title: dto.title,
      body: dto.body ?? "",
      bind_gold: Math.max(0, Math.floor(dto.bindGold ?? 0)),
      exp: Math.max(0, Math.floor(dto.exp ?? 0)),
      attachments: JSON.stringify(dto.items ?? []),
      filter: JSON.stringify(filter),
      target_count: zoneIds.reduce((sum, zoneId) => sum + this.roles.countForBroadcast(zoneId, range), 0),
      sent_count: 0,
      operator_id: actor.id ?? "",
      operator_name: actor.username ?? "",
      created_at: now,
      finished_at: null,
    });
    if (!claimed) {
      // 并发：另一个请求刚用同一个批次号赢了这一行。**不重试、不补发**，把赢家的结果还回去
      const row = this.broadcasts.findByKey(dto.batchId);
      if (row) return BroadcastViewDto.of(row, true);
      // 抢不到又读不到是极怪的状态（库刚被外部清过），当成参数问题报出来，别静默成功
      throw new BizException(BizCode.PARAM_INVALID, "批次号刚刚被占用且读不到结果，请刷新后确认是否已发出");
    }

    const template: BroadcastTemplate = {
      channel: dto.channel as MailChannel,
      kind: "admin-broadcast",
      title: dto.title,
      body: dto.body,
      bindGold: dto.bindGold,
      exp: dto.exp,
      items: dto.items,
      // 群发一律**永久**（#867 的反面写法）：开服福利 / 维护补偿不该因为玩家两周没上线就消失。
      // 它与单发补偿（`sendFromAdmin` 给 0）同一个理由，只是量级大得多
      ttlMs: 0,
    };

    for (const zoneId of zoneIds) {
      await this.sendZone(dto.batchId, zoneId, range, template);
    }
    this.broadcasts.markFinished(dto.batchId, Date.now());

    const row = this.broadcasts.findByKey(dto.batchId);
    // 刚写进去的行读不到只可能是库被外部清空；给 500 比给一个空对象诚实
    if (!row) throw new BizException(BizCode.PARAM_INVALID, "批次写完后读不到结果，请用批次号在列表里核对");
    return BroadcastViewDto.of(row);
  }

  /** 最近批次（管理端列表） */
  list(): BroadcastViewDto[] {
    return this.broadcasts.listRecent(GameMailBroadcastService.RECENT_LIMIT).map((row) => BroadcastViewDto.of(row));
  }

  //#region 内部

  /**
   * 发一个区（keyset 分页，一批一个事务）
   *
   * 事务里同时干两件事：插这批 `role_mails` + 累加批次表的 `sent_count`。
   * 同一个连接（`DatabaseService` 是全局单例）所以真的在一个事务里 ——
   * 分开写的话，崩在两者之间就会出现「行发了、进度没加」，而对账时两个数都会骗人。
   *
   * @returns 本区写入的封数
   */
  private async sendZone(
    batchId: string,
    zoneId: number,
    range: { minLevel?: number; maxLevel?: number },
    template: BroadcastTemplate,
  ): Promise<number> {
    const batchSize = this.batchSize();
    let afterId: string | null = null;
    let written = 0;
    for (;;) {
      const roleIds = this.roles.listIdsForBroadcast(zoneId, range, afterId, batchSize);
      if (roleIds.length === 0) break;
      // 一批共用一个时刻：界面上的「收到时间」整齐，收件箱排序也稳
      const createdAt = Date.now();
      this.mails.transaction(() => {
        const rows = roleIds.map((roleId) => this.gameMail.compose(roleId, { ...template, batchId }, createdAt));
        this.mails.insertMany(rows);
        this.broadcasts.addSent(batchId, rows.length);
      });
      written += roleIds.length;
      afterId = roleIds[roleIds.length - 1];
      // 让出事件循环（见类注释「为什么要 await」）：不这样的话几万行期间整个进程是死的
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return written;
  }

  /** 每批封数（配置值兜底 500；配歪了按 1 处理，宁可慢也不能「一批写一万行」） */
  private batchSize(): number {
    const configured = Number(this.config.get<number>("gameMailBroadcastBatchSize") ?? 500);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 500;
  }

  /**
   * 范围 → 区清单
   *
   * `all` 是**影响面权限**（`gameMail:broadcast-all`，只给超管）：管理员能切区、能一个区一个区地发，
   * 但「一键打到所有区」是另一件事。与 #963 的公告口径一致，所以判断写在业务里
   * （同一个接口按入参决定要不要权限，路由装饰器表达不了）。
   *
   * `all` 走「遍历所有**未合并**的区」而不是一条不带 `zone_id` 的 SQL：
   * 合并掉的区已经没有角色（合区事务会把它们搬走），残留行是死数据；而且这样每个查询都带区，
   * 静态守点（`audit-zone-scope`）不需要为群发开豁免。
   */
  private zoneIdsOfScope(actor: AuthenticatedUser, scope: string, currentZoneId: number): number[] {
    if (!BROADCAST_SCOPES.includes(scope as BroadcastScope)) {
      throw new BizException(BizCode.PARAM_INVALID, `投递范围只能是 ${BROADCAST_SCOPES.join(" / ")}`);
    }
    if (scope !== "all") return [currentZoneId];
    if (!roleHasPermission(actor.role, Permission.GAME_MAIL_BROADCAST_ALL)) {
      throw BizException.forbidden(
        BizCode.ADMIN_PERMISSION_DENIED,
        "「全服群发」会影响所有区，需要超级管理员权限；只想发当前区，把范围换成「当前区」即可",
      );
    }
    return this.zones
      .states()
      .filter((zone) => zone.mergedInto === null)
      .map((zone) => zone.id);
  }

  /**
   * 等级段（两端都可不传）
   *
   * `min > max` 是最常见的输入错误（两个框填反），必须当场 400 ——
   * 放过它的表现是「预计影响 0 人，发送成功 0 封」，运营以为发出了。
   */
  private rangeOf(minLevel?: number, maxLevel?: number): { minLevel?: number; maxLevel?: number } {
    if (minLevel !== undefined && maxLevel !== undefined && minLevel > maxLevel) {
      throw new BizException(BizCode.PARAM_INVALID, `最低等级（${minLevel}）不能大于最高等级（${maxLevel}）`);
    }
    return { minLevel, maxLevel };
  }

  //#endregion
}
