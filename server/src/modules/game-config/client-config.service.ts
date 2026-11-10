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
import { MoneyItemDto } from "./dto/money-item.dto";
import { LevelScrollDto } from "./dto/level-scroll.dto";
import { LevelCurveDto } from "./dto/growth.dto";
import { MonsterPresentationDto } from "./dto/monster.dto";
import { ConfigVersionService } from "./config-version.service";

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
  /** 按版本缓存（#881）：`{version, dto}` —— 版本没变就复用，见 snapshot() 的注释 */
  private cache: { version: number; dto: GameConfigSnapshotDto } | null = null;

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
    private readonly versions: ConfigVersionService,
  ) {}

  /** 当前配置版本（快照 ETag 与 `GET /game-config/version` 都用它） */
  version(): number {
    return this.versions.current();
  }

  /**
   * 快照（**按版本缓存**，#881）
   *
   * 以前每次请求都把 12 个 service 的列表重新拼一遍（38 张表 / 约 13k 行）——
   * 客户端进游戏会连着打十几次，全是重复劳动。现在按 `config_version` 缓存：
   * 版本没变直接返回同一份物化结果，变了才重拼。
   *
   * **为什么不按时间过期**：时间窗内改了配置 → 客户端拿到旧值；一年没改 → 白拼一次。
   * 版本号是「配置有没有变」的唯一判据（写接口成功后由拦截器 +1，见 ConfigVersionInterceptor）。
   *
   * 返回的是同一个对象引用：调用方只做序列化，不许改它。
   */
  snapshot(): GameConfigSnapshotDto {
    const version = this.version();
    if (this.cache && this.cache.version === version) return this.cache.dto;
    const dto = this.build();
    this.cache = { version, dto };
    return dto;
  }

  private build(): GameConfigSnapshotDto {
    return {
      titles: this.gameConfig.listTitles({ ...ALL }).list,
      souls: this.gameConfig.listSouls({ ...ALL }).list,
      ranks: this.gameConfig.listRanks({ ...ALL }).list,
      equipments: this.gameConfig.listEquipmentVariants(),
      drugs: this.gameConfig.listDrugs({ ...ALL }).list,
      // #785：货币物品（绑定元宝 / 元宝 / 银子）。客户端背包与图鉴按这段陈列，
      // 使用结算读库（服务端）—— 运营改面值不用重打客户端包
      moneyItems: this.gameConfig.listMoneyItemRows().map((row) => MoneyItemDto.from(row)),
      // #787：升级卷轴（硬性 +1 级，带等级区间）。客户端用区间做本地预检，
      // 真正的 +1 与区间判定在服务端（读库，改完不用重打客户端包）
      levelScrolls: this.gameConfig.listLevelScrollRows().map((row) => LevelScrollDto.from(row)),
      items: this.gameConfig.listItems({ ...ALL }).list,
      monsters: this.gameConfig.listMonsters({ ...ALL }).list,
      // #588 / #655：怪物资源与表现读 `monster_presentation` 表（生成器直接写库），
      // 客户端不再持有怪物数据文件
      monsterPresentations: this.monsterPresentations.listAll().map((row) => MonsterPresentationDto.from(row)),
      npcs: this.gameConfig.listNpcs({ ...ALL }).list,
      fashions: this.gameConfig.listFashions({ ...ALL }).list,
      // #786：等级改回**曲线**下发（4 条 × 6 段 = 24 行）。逐级表已删 ——
      // 100 万级不可能整表下发（250MB JSON / 客户端几百 MB 内存），
      // 客户端拿到段参数后自己按需求值（`levelConfigOf`），与服务端同一套公式。
      levelCurves: this.growth.listLevelCurveRows().map(LevelCurveDto.from),
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
      // 没有它们客户端连变体都展开不出来（倍率决定展开档数）
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
}
