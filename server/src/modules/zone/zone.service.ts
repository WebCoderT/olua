import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";
import { AccountRepository } from "../../database/repositories/account.repository";
import { WorldMonsterRepository } from "../../database/repositories/world-monster.repository";
import { ZoneRepository } from "../../database/repositories/zone.repository";
import { ZoneRow } from "../../database/rows";
import { AdminZoneDto, ZoneDto } from "./dto/zone.dto";

/** 从 instanceId 解析发牌序号（与 WorldService 内部同一口径：取最后一个 `_` 之后的数字） */
function parseSeq(instanceId: string): number {
  const at = instanceId.lastIndexOf("_");
  if (at < 0) return 0;
  const seq = Number(instanceId.slice(at + 1));
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
}

/**
 * 区服（#295 阶段二：多开区 / 合并区）
 *
 * ## 多开区
 * 账号注册时选定归属区；世界按区隔离（每个区的每张图都独立播种一份怪物实例）。
 * 登录不换区 —— 归属区只在「合并区」时变（管理员操作，玩家自己换不了）。
 *
 * ## 合并区
 * 把 from 区并入 to 区，一个事务里做三件事：
 * 1. **搬账号**：`accounts.zone_id` 全部改成 to；
 * 2. **重排世界发牌**：from 区的怪物实例改挂 to 区，instanceId 重写为 to 区的区段
 *    （`m<map>_z<to>_<n>`），序号接着 to 区同图已有实例往下编 —— 保证全服不重号；
 * 3. **打标记 + 升代际**：`zones.merged_into` 记下去向，`world_meta.epoch` +1。
 *
 * epoch 是给**两个进程的世界内存**看的失效信号（API 进程执行合并、实时进程正在跑世界）：
 * 世界服务 tick 巡检到 epoch 变了就把内存里的世界作废（不落盘），玩家下次进图按库重载。
 * 代价是合并瞬间各图「未落盘的几秒内伤害变化」被丢弃 —— 稀有运营操作可接受。
 */
@Injectable()
export class ZoneService {
  private readonly logger = new Logger(ZoneService.name);

  constructor(
    private readonly zones: ZoneRepository,
    private readonly worldMonsters: WorldMonsterRepository,
    private readonly accounts: AccountRepository,
  ) {}

  /** 活区列表（玩家注册下拉框：只列未合并的） */
  listLive(): ZoneDto[] {
    return this.zones.listLive().map(ZoneDto.from);
  }

  /** 全部区服（管理端列表：含已合并的，附当前账号数） */
  listAll(): AdminZoneDto[] {
    return this.zones.listAll().map((row) => AdminZoneDto.from(row, this.zones.countAccounts(row.id)));
  }

  /** 开新区（名字查重后落库；区 id 自增，注册端立即可选） */
  create(name: string): AdminZoneDto {
    const trimmed = name.trim();
    if (this.zones.findByName(trimmed)) throw BizException.conflict(BizCode.ZONE_NAME_EXISTS, "该区服名已存在");
    const id = this.zones.create(trimmed, Date.now());
    this.logger.log(`开新区：${trimmed}（id=${id}）`);
    const row = this.zones.findById(id) as ZoneRow;
    return AdminZoneDto.from(row, 0);
  }

  /** 合并区（见类注释的三步；from / to 的边界都在事务外先校验，事务里只做搬家） */
  merge(fromZoneId: number, toZoneId: number): AdminZoneDto {
    if (fromZoneId === toZoneId) {
      throw new BizException(BizCode.ZONE_MERGE_SAME, "不能把区合并进它自己", HttpStatus.CONFLICT);
    }
    const from = this.assertLive(fromZoneId, "要并入的源区");
    const to = this.assertLive(toZoneId, "并入的目标区");
    const now = Date.now();

    const movedAccounts = this.zones.countAccounts(fromZoneId);
    const movedMonsters = this.zones.transaction(() => {
      // ① 搬账号（世界是按账号行解析区的，搬完它们下一次 worldJoin 就落在 to 区）
      this.accounts.moveAllAccounts(fromZoneId, toZoneId, now);

      // ② 重排 from 区的世界发牌：instanceId 换成 to 区的区段，序号接着 to 区同图的已有实例续
      const monsters = this.worldMonsters.listByZone(fromZoneId);
      const seqByMap = new Map<string, number>();
      for (const row of monsters) {
        if (!seqByMap.has(row.map_id)) {
          // 首遇这张图：从 to 区同图实例里找最大序号（instanceId 尾段，parseSeq 口径与 WorldService 一致）
          let maxSeq = 0;
          for (const existing of this.worldMonsters.listByZoneMap(toZoneId, row.map_id)) {
            maxSeq = Math.max(maxSeq, parseSeq(existing.instance_id));
          }
          seqByMap.set(row.map_id, maxSeq);
        }
        const nextSeq = (seqByMap.get(row.map_id) ?? 0) + 1;
        seqByMap.set(row.map_id, nextSeq);
        this.worldMonsters.rekey(row.instance_id, {
          ...row,
          instance_id: `m${row.map_id}_z${toZoneId}_${nextSeq}`,
          zone_id: toZoneId,
          updated_at: now,
        });
      }

      // ③ 打合并标记 + 升代际（两个进程的世界内存靠 epoch 变化作废，见类注释）
      this.zones.markMerged(fromZoneId, toZoneId, now);
      this.zones.bumpEpoch();
      return monsters.length;
    });

    this.logger.log(`合并区：${from.name}（id=${fromZoneId}）→ ${to.name}（id=${toZoneId}），搬账号 ${movedAccounts} 个、世界实例 ${movedMonsters} 只，代际已 +1`);
    const merged = this.zones.findById(fromZoneId) as ZoneRow;
    return AdminZoneDto.from(merged, 0);
  }

  /** 断言「id 存在且还是活区」，否则按场景报错（不存在 vs 已合并给不同文案） */
  private assertLive(zoneId: number, label: string): ZoneRow {
    const row = this.zones.findById(zoneId);
    if (!row) throw BizException.notFound(BizCode.ZONE_NOT_FOUND, `${label}不存在`);
    if (row.merged_into !== null) {
      throw new BizException(BizCode.ZONE_MERGED, `${label}（${row.name}）已并入其他区`, HttpStatus.CONFLICT);
    }
    return row;
  }
}
