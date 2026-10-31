import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { DrugRepository } from "../../database/repositories/drug.repository";
import { EquipmentRepository } from "../../database/repositories/equipment.repository";
import { ItemRepository } from "../../database/repositories/item.repository";
import { RankRepository } from "../../database/repositories/rank.repository";
import { SkillRepository } from "../../database/repositories/skill.repository";
import { SoulRepository } from "../../database/repositories/soul.repository";
import { TitleRepository } from "../../database/repositories/title.repository";
import {
  applyDrugOverrides,
  applyEquipmentOverrides,
  applyItemOverrides,
  applyRankOverrides,
  applySkillOverrides,
  applySoulOverrides,
  applyTitleOverrides,
} from "../../shared/runtime-overrides";

/** 全量拉取参数：service 层调用不经过 ValidationPipe，size 不受 HTTP 边界的 100 限制 */
const ALL = { page: 1, size: 1_000_000 };

/**
 * 运营配置的运行时装载（#544）
 *
 * 把库里的当前值装进 `shared/runtime-overrides` 的覆盖层，让**服务端结算**与
 * **客户端看到的配置**（快照下发 + apply-snapshot 覆写）用的是同一份数字。
 * 不装这一层时，管理端改的装备 / 称号 / 战魂 / 军衔 / 技能 / 药品只在客户端生效，
 * 服务端仍按编译期生成物算 —— 面板与伤害分裂，且没有任何报错。
 *
 * ## 什么时候装
 * - **启动后**（`onApplicationBootstrap`）：必须晚于各配置服务的 `onModuleInit` seed，
 *   否则读到的是空表 —— 覆盖层为空虽然无害（回落生成物），但运营改过的值会在重启后
 *   「悄悄消失」。这是本类唯一容易写错的地方。
 * - **管理端每次写操作后**：`GameConfigService` 的 update / create 末尾调 `refreshAll()`。
 *   数据量小（装备 37 + 称号 34 + 战魂 37 + 军衔 100 + 技能 15 + 药品 8），全量重装比
 *   逐条增量更好维护，也不会漏（漏一条就是「改了不生效」这种最难查的 bug）。
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
    private readonly titles: TitleRepository,
    private readonly souls: SoulRepository,
    private readonly ranks: RankRepository,
    private readonly skills: SkillRepository,
    private readonly drugs: DrugRepository,
    private readonly items: ItemRepository,
  ) {}

  onApplicationBootstrap(): void {
    this.refreshAll();
  }

  /** 全量重装（启动时一次 + 每次管理端写操作后一次） */
  refreshAll(): void {
    const equipments = this.equipments.list({ ...ALL });
    const titles = this.titles.list({ ...ALL });
    const souls = this.souls.list({ ...ALL });
    const ranks = this.ranks.list({ ...ALL });
    const skills = this.skills.listAll();
    const drugs = this.drugs.list({ ...ALL });
    const items = this.items.list({ ...ALL });
    applyEquipmentOverrides(equipments);
    applyTitleOverrides(titles);
    applySoulOverrides(souls);
    applyRankOverrides(ranks);
    applySkillOverrides(skills);
    applyDrugOverrides(drugs);
    applyItemOverrides(items);
    // 只记条数不记值：出问题时第一件事就是确认「覆盖层里到底装没装上」
    this.logger.log(
      `运营配置已装载：装备 ${equipments.length} 件（含变体展开）· 称号 ${titles.length} 级 · ` +
        `战魂 ${souls.length} 阶 · 军衔 ${ranks.length} 阶 · 技能 ${skills.length} 个 · ` +
        `药品 ${drugs.length} 种 · 材料 ${items.length} 种`,
    );
  }
}
