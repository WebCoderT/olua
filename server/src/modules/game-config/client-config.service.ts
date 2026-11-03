import { Injectable } from "@nestjs/common";
import { MAP_TYPE_GROUPS } from "../../common/constants/map-config";
import { MONSTER_PRESENTATION_ROWS } from "../../shared/monster-presentation.generated";
import { ROLE_LEVEL_ATTRIBUTES } from "../../shared/growth-seed";
import { COMBAT_WEIGHTS } from "../../shared/game-data.generated";
import { MapService } from "../map/map.service";
import { UiEffectService } from "../ui-effect/ui-effect.service";
import { GameConfigService } from "./game-config.service";
import { GrowthConfigService } from "./growth-config.service";
import { MallPricingService } from "./mall-pricing.service";
import { DropConfigService } from "./drop-config.service";
import { RuntimeParamsService } from "./runtime-params.service";
import { GameConfigSnapshotDto } from "./dto/client-config.dto";
import { LevelDto } from "./dto/growth.dto";
import { MonsterPresentationDto } from "./dto/monster.dto";

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
    private readonly runtimeParams: RuntimeParamsService,
    private readonly map: MapService,
    private readonly uiEffect: UiEffectService,
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
      // #588：怪物资源与表现（生成物实测），客户端不再持有怪物数据文件
      monsterPresentations: MONSTER_PRESENTATION_ROWS.map((row) => MonsterPresentationDto.from(row)),
      npcs: this.gameConfig.listNpcs({ ...ALL }).list,
      fashions: this.gameConfig.listFashions({ ...ALL }).list,
      // #590：等级表（属性按曲线展开 + level_exps 最终经验）—— 客户端 levelMap 的唯一来源
      levels: Object.entries(ROLE_LEVEL_ATTRIBUTES).map(([level, attributes]) => {
        const row = this.growth.findLevelExp(Number(level));
        return LevelDto.from(Number(level), attributes, row ? row.exp : Number(attributes.exp));
      }),
      growthScalars: this.growth.listScalars({ ...ALL }).list,
      // #603：战斗力权重（唯一书写处 shared/combat-seed.ts）。客户端不再存倍率，
      // 本地只留空 Map —— 「这件装备是不是更好」的提示用同一组数字判
      combatWeights: COMBAT_WEIGHTS,
      mallPrices: this.mall.listPrices({ ...ALL }).list,
      mallSettings: this.mall.getSettings(),
      dropTables: this.drop.listTables().list,
      monsterDrops: this.drop.listMonsterDrops({ ...ALL }).list,
      // #367：技能与状态的整份配置（角色 + 怪物），客户端按 owner 分流消费
      skills: this.gameConfig.listSkills({ ...ALL }).list,
      statuses: this.gameConfig.listStatuses({ ...ALL }).list,
      // #396：任务配置（主线链 / 日常 / 单目标 / 奖励）
      quests: this.gameConfig.listQuests({ ...ALL }).list,
      // #401：成就配置（条件 / 门槛 / 奖励）；进度与达成状态走 /achievements/me，不在配置快照里
      achievements: this.gameConfig.listAchievements({ ...ALL }).list,
      // #573：地图玩法配置（名称 / 类型 / 进入条件）+ 类型分组顺序。
      // 客户端 `configs/map.ts` 不再存这些 —— 改一个进入等级不用重打客户端包。
      maps: this.map.configs(),
      mapTypes: MAP_TYPE_GROUPS.map((group) => ({ type: group.type, label: group.label })),
      // #594 升级特效 / #634 掉落光效：表现参数（摆位 / 缩放 / 旋转 / 时长 / 开关）—— 特效按服务端参数演
      uiEffects: this.uiEffect.configs(),
      // #603 第九域：槽位表与装备规则（前后缀倍率 / 文案 / 回收价曲线）。
      // 客户端 `configs/equipments` 与 `configs/growth` 不再存这两样 ——
      // 没有它们客户端连 555 个变体都展开不出来（倍率决定展开档数）
      equipmentSlots: this.gameConfig.listEquipmentSlots(),
      equipmentMeta: this.gameConfig.getEquipmentMeta(),
      // #605：运行时参数（掉落手感 / 自动战斗 / 帮会规则）—— 原本写死在客户端的两份参数，
      // 现在由运营在管理端改；客户端进游戏覆写本地（guild 那组同时也是服务端校验门槛）
      runtimeParams: this.runtimeParams.get(),
    };
  }
}
