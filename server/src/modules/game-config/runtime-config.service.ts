import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import {
  applyDrugOverrides,
  applyEquipmentBases,
  applyEquipmentSlotKeys,
  applyEquipmentVariants,
  applyGrowthScalars,
  applyItemOverrides,
  applyRankOverrides,
  applyRoleLevels,
  applySkillOverrides,
  applySoulOverrides,
  applyTitleOverrides,
} from "../../common/runtime-config-cache";
import { DrugRepository } from "../../database/repositories/drug.repository";
import { EquipmentVariantRepository } from "../../database/repositories/equipment-variant.repository";
import { EquipmentRepository } from "../../database/repositories/equipment.repository";
import { GrowthRepository } from "../../database/repositories/growth.repository";
import { ItemRepository } from "../../database/repositories/item.repository";
import { RankRepository } from "../../database/repositories/rank.repository";
import { RoleLevelRepository } from "../../database/repositories/role-level.repository";
import { SkillRepository } from "../../database/repositories/skill.repository";
import { SoulRepository } from "../../database/repositories/soul.repository";
import { TitleRepository } from "../../database/repositories/title.repository";

/** 全量拉取参数：service 层调用不经过 ValidationPipe，size 不受 HTTP 边界的 100 限制 */
const ALL = { page: 1, size: 1_000_000 };

/**
 * 运营配置的运行时装载（#544 / #655）
 *
 * 把库里的当前值装进 `common/runtime-config-cache`，让**服务端结算**与**客户端看到的配置**
 * （快照下发 + apply-snapshot 覆写）用的是同一份数字。不装这一层时，管理端改的装备 /
 * 称号 / 战魂 / 军衔 / 技能 / 药品只在客户端生效，服务端仍按编译期常量算 ——
 * 面板与伤害分裂，且没有任何报错。
 *
 * ## 什么时候装
 * - **启动后**（`onApplicationBootstrap`）：必须晚于出厂快照的自举（`DatabaseService`
 *   构造时就灌完了），否则读到的是空表。
 * - **管理端每次写操作后**：各配置服务的 update / create 末尾调 `refreshAll()`。
 *   数据量小（装备变体 555 + 等级 60 + 称号 34 + 战魂 37 + 军衔 100 + 技能 15 + 药品 8），
 *   全量重装比逐条增量更好维护，也不会漏（漏一条就是「改了不生效」这种最难查的 bug）。
 *
 * ## 为什么不缓存 / 不懒加载
 * 读取方是纯函数（`role-attributes` / 结算服务），拿不到 Nest 的注入；所以装载时机只能
 * 是「启动 + 写操作之后」这两个明确的点。进程重启后 DB 是持久的，重装即恢复。
 */
@Injectable()
export class RuntimeConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RuntimeConfigService.name);

  constructor(
    private readonly equipments: EquipmentRepository,
    private readonly equipmentVariants: EquipmentVariantRepository,
    private readonly roleLevels: RoleLevelRepository,
    private readonly titles: TitleRepository,
    private readonly souls: SoulRepository,
    private readonly ranks: RankRepository,
    private readonly skills: SkillRepository,
    private readonly drugs: DrugRepository,
    private readonly items: ItemRepository,
    private readonly growth: GrowthRepository,
  ) {}

  onApplicationBootstrap(): void {
    this.refreshAll();
  }

  /** 全量重装（启动时一次 + 每次管理端写操作后一次） */
  refreshAll(): void {
    const equipments = this.equipments.list({ ...ALL });
    const variants = this.equipmentVariants.listAll();
    const roleLevels = this.roleLevels.listAll();
    const titles = this.titles.list({ ...ALL });
    const souls = this.souls.list({ ...ALL });
    const ranks = this.ranks.list({ ...ALL });
    const skills = this.skills.listAll();
    const drugs = this.drugs.list({ ...ALL });
    const items = this.items.list({ ...ALL });
    const scalars = this.growth.listScalars({ ...ALL });

    applyEquipmentBases(equipments);
    applyEquipmentSlotKeys(this.equipments.listSlots());
    applyEquipmentVariants(variants);
    applyRoleLevels(roleLevels);
    applyTitleOverrides(titles);
    applySoulOverrides(souls);
    applyRankOverrides(ranks);
    applySkillOverrides(skills);
    applyDrugOverrides(drugs);
    applyItemOverrides(items);
    applyGrowthScalars(scalars);

    // 只记条数不记值：出问题时第一件事就是确认「结算层里到底装没装上」
    this.logger.log(
      `运营配置已装载：装备 ${equipments.length} 件 / 变体 ${variants.length} 件 · 角色等级 ${roleLevels.length} 级 · ` +
        `称号 ${titles.length} 级 · 战魂 ${souls.length} 阶 · 军衔 ${ranks.length} 阶 · ` +
        `技能 ${skills.length} 个 · 药品 ${drugs.length} 种 · 材料 ${items.length} 种 · 成长标量 ${scalars.length} 项`,
    );
    // 空表 = 出厂快照没灌进来（`server/data/config-sync.sql`）。必须喊出来：
    // #655 之后没有「回落生成物」这回事了，空表就是「没配」，属性会算成 0
    this.warnIfEmpty("equipments", equipments.length);
    this.warnIfEmpty("equipment_variants", variants.length);
    this.warnIfEmpty("role_levels", roleLevels.length);
    this.warnIfEmpty("growth_scalars", scalars.length);
  }

  private warnIfEmpty(table: string, count: number): void {
    if (count > 0) return;
    this.logger.warn(`${table} 是空表 —— 相关配置按「没配」处理（跑 make config-import 恢复出厂值）`);
  }
}
