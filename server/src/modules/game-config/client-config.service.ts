import { Injectable } from "@nestjs/common";
import { MAP_TYPE_GROUPS } from "../../common/constants/map-config";
import { MapService } from "../map/map.service";
import { UiEffectService } from "../ui-effect/ui-effect.service";
import { MonsterPresentationRepository } from "../../database/repositories/monster-presentation.repository";
import { GameConfigService } from "./game-config.service";
import { GrowthConfigService } from "./growth-config.service";
import { MallPricingService } from "./mall-pricing.service";
import { DropConfigService } from "./drop-config.service";
import { RuntimeParamsService } from "./runtime-params.service";
import { CombatWeightsService } from "./combat-weights.service";
import { GuideSettingsService } from "./guide-settings.service";
import { EquipmentAppearanceService } from "./equipment-appearance.service";
import { AudioSettingService } from "../audio-setting/audio-setting.service";
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
 * 数据全部来自数据库（出厂快照 `server/data/config-sync.sql` 在空库首启时灌入），
 * 所以「快照里有几条」就等于「库里有几条」——没有第二份代码常量可能对不上。
 */
@Injectable()
export class ClientConfigService {
  constructor(
    private readonly gameConfig: GameConfigService,
    private readonly growth: GrowthConfigService,
    private readonly mall: MallPricingService,
    private readonly drop: DropConfigService,
    private readonly runtimeParams: RuntimeParamsService,
    private readonly combatWeights: CombatWeightsService,
    private readonly guide: GuideSettingsService,
    private readonly equipmentAppearance: EquipmentAppearanceService,
    private readonly audio: AudioSettingService,
    private readonly map: MapService,
    private readonly uiEffect: UiEffectService,
    private readonly monsterPresentations: MonsterPresentationRepository,
  ) {}

  snapshot(): GameConfigSnapshotDto {    return {
      titles: this.gameConfig.listTitles({ ...ALL }).list,
      souls: this.gameConfig.listSouls({ ...ALL }).list,
      ranks: this.gameConfig.listRanks({ ...ALL }).list,
      equipments: this.gameConfig.listEquipmentVariants(),
      drugs: this.gameConfig.listDrugs({ ...ALL }).list,
      items: this.gameConfig.listItems({ ...ALL }).list,
      monsters: this.gameConfig.listMonsters({ ...ALL }).list,
      // #588 / #655：怪物资源与表现读 `monster_presentation` 表（生成器直接写库），
      // 客户端不再持有怪物数据文件
      monsterPresentations: this.monsterPresentations.listAll().map((row) => MonsterPresentationDto.from(row)),
      npcs: this.gameConfig.listNpcs({ ...ALL }).list,
      fashions: this.gameConfig.listFashions({ ...ALL }).list,
      // #655：等级表直接读 `role_levels`（60 行逐级配置，曲线已从运行时移除）——
      // 客户端 levelMap 的唯一来源。表为空（迁移没跑）才回落到曲线展开，保证空库能进游戏。
      levels: this.snapshotLevels(),
      growthScalars: this.growth.listScalars({ ...ALL }).list,
      // #603 战斗力权重 / #605 可配化：出厂值在 `config-sync.sql`，当前值在
      // `combat_weights` 表（管理端「战斗力权重」页可改）。客户端本地只留空 Map ——
      // 「这件装备是不是更好」的提示与服务端算战力用同一组数字
      combatWeights: this.combatWeights.weights(),
      mallCategories: this.mall.listCategories(),
      mallGoods: this.mall.snapshotGoods(),
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
      // #605：新手引导步骤（出厂值在 config-sync.sql，运营在管理端「新手引导」页改）。
      // 客户端本地不再存这张表 —— 改一句新手文案不用重打客户端包
      guideSteps: this.guide.steps(),
      // #683：音效配置（文件路径 / 音量 / 循环 / 开关）。客户端没有本地兜底表 ——
      // 空 `filePath` 就是「这一项不播」；登录场景另走公开接口 `GET /game-config/audio`
      audio: this.audio.configs(),
      // #695：装备外观（哪个前后缀组合 / 哪件特殊装备用哪个边框、详情背景）。
      // 素材与资源清单在客户端，这里只下发 key 映射 —— 运营换组合不重打客户端包
      equipmentAppearance: this.equipmentAppearance.appearance(),
    };
  }

  /**
   * 快照 `levels` 段（#655）
   *
   * 唯一来源是 `role_levels` 的 60 行（管理端逐行改，改完快照即变）。
   * 表不会为空：建库 seed 与迁移脚本都保证 60 行（见 `GrowthConfigService.seedRoleLevels`）。
   */
  private snapshotLevels(): LevelDto[] {
    return this.growth.listRoleLevelRows().map(LevelDto.fromRow);
  }
}
