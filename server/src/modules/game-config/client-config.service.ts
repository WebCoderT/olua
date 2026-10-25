import { Injectable } from "@nestjs/common";
import { GameConfigService } from "./game-config.service";
import { GrowthConfigService } from "./growth-config.service";
import { MallPricingService } from "./mall-pricing.service";
import { DropConfigService } from "./drop-config.service";
import { GameConfigSnapshotDto } from "./dto/client-config.dto";

/** 快照全量拉取的分页参数：service 层调用不经过 ValidationPipe，size 不受 HTTP 边界 100 的限制 */
const ALL = { page: 1, size: 1_000_000 };

/**
 * 玩家侧配置快照（#294）
 *
 * 只做**编排**：逐表调各配置服务的列表方法（camelCase DTO 形状与管理端一致），
 * 不引入第二套 row → DTO 映射 —— 管理端看到什么形状，客户端快照就是什么形状。
 * 各服务的 `onModuleInit` 负责幂等 seed，快照永远有数据可发。
 */
@Injectable()
export class ClientConfigService {
  constructor(
    private readonly gameConfig: GameConfigService,
    private readonly growth: GrowthConfigService,
    private readonly mall: MallPricingService,
    private readonly drop: DropConfigService,
  ) {}

  snapshot(): GameConfigSnapshotDto {
    return {
      titles: this.gameConfig.listTitles({ ...ALL }).list,
      souls: this.gameConfig.listSouls({ ...ALL }).list,
      ranks: this.gameConfig.listRanks({ ...ALL }).list,
      equipments: this.gameConfig.listEquipments({ ...ALL }).list,
      drugs: this.gameConfig.listDrugs({ ...ALL }).list,
      items: this.gameConfig.listItems({ ...ALL }).list,
      monsters: this.gameConfig.listMonsters({ ...ALL }).list,
      npcs: this.gameConfig.listNpcs({ ...ALL }).list,
      fashions: this.gameConfig.listFashions({ ...ALL }).list,
      levelExps: this.growth.listLevelExps({ ...ALL }).list,
      growthSegments: this.growth.listSegments({ ...ALL }).list,
      growthScalars: this.growth.listScalars({ ...ALL }).list,
      mallPrices: this.mall.listPrices({ ...ALL }).list,
      mallSettings: this.mall.getSettings(),
      dropTables: this.drop.listTables().list,
      monsterDrops: this.drop.listMonsterDrops({ ...ALL }).list,
    };
  }
}
