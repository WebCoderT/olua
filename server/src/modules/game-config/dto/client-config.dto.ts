import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ValidateNested } from "class-validator";
import { DrugDto } from "./drug.dto";
import { DropTableDto, MonsterDropDto } from "./drop.dto";
import { EquipmentDto, EquipmentMetaDto, EquipmentSlotDto } from "./equipment.dto";
import { FashionDto } from "./fashion.dto";
import { GrowthScalarDto, LevelDto } from "./growth.dto";
import { ItemDto } from "./item.dto";
import { MallPriceItemDto, MallSettingsDto } from "./mall.dto";
import { MapConfigDto, MapTypeGroupDto } from "../../map/dto/map.dto";
import { UiEffectConfigDto } from "../../ui-effect/dto/ui-effect.dto";
import { MonsterDto, MonsterPresentationDto } from "./monster.dto";
import { NpcDto } from "./npc.dto";
import { RankDto } from "./rank.dto";
import { SkillDto } from "./skill.dto";
import { StatusDto } from "./status.dto";
import { QuestDto } from "./quest.dto";
import { AchievementDto } from "./achievement.dto";
import { SoulDto } from "./soul.dto";
import { TitleDto } from "./title.dto";

/**
 * 玩家侧配置快照（#294）
 *
 * 管理端可改的全部运营配置，一次下发（客户端进游戏拉一次存内存）。
 * 各表形状与管理端列表接口的行一致（camelCase），**不做裁剪**——
 * 里面没有任何敏感字段（都是游戏数值与文案），客户端直接重建本地配置数据。
 *
 * 掉落表随快照一起下发是给客户端兜底展示用的；**掉落结算的权威在服务端**
 * （客户端不再本地掷表，见 #254 的结算切换），这份快照只保证「新怪新表」的
 * 展示信息（图标 / 名字）能对上。
 */
export class GameConfigSnapshotDto {
  @ApiProperty({ description: "称号配置（34 阶，含渠道与升级链顺序）", type: [TitleDto] })
  @Type(() => TitleDto)
  titles!: TitleDto[];

  @ApiProperty({ description: "战魂配置（37 阶，含升级链顺序）", type: [SoulDto] })
  @Type(() => SoulDto)
  souls!: SoulDto[];

  @ApiProperty({ description: "军衔配置（100 阶）", type: [RankDto] })
  @Type(() => RankDto)
  ranks!: RankDto[];

  @ApiProperty({ description: "装备基础件配置（555 件变体由客户端按前后缀倍率展开）", type: [EquipmentDto] })
  @Type(() => EquipmentDto)
  equipments!: EquipmentDto[];

  @ApiProperty({ description: "药品配置", type: [DrugDto] })
  @Type(() => DrugDto)
  drugs!: DrugDto[];

  @ApiProperty({ description: "物品与材料配置（MATERIAL / OTHER 大类）", type: [ItemDto] })
  @Type(() => ItemDto)
  items!: ItemDto[];

  @ApiProperty({ description: "怪物基础数据（名称 / 等级 / 战斗数值）", type: [MonsterDto] })
  @Type(() => MonsterDto)
  monsters!: MonsterDto[];

  @ApiProperty({
    description:
      "怪物资源与表现（#588：icon / out / 几何 / 移动 / AI 参数）。**客户端没有怪物数据文件** —— " +
      "数值在本快照的 monsters 段（monsters 表），资源与表现在这段，客户端运行时两段合体",
    type: [MonsterPresentationDto],
  })
  @Type(() => MonsterPresentationDto)
  monsterPresentations!: MonsterPresentationDto[];

  @ApiProperty({ description: "NPC 基础数据（名称 / 对话文案）", type: [NpcDto] })
  @Type(() => NpcDto)
  npcs!: NpcDto[];

  @ApiProperty({ description: "时装配置", type: [FashionDto] })
  @Type(() => FashionDto)
  fashions!: FashionDto[];

  @ApiProperty({
    description:
      "等级表（#590：1..roleMaxLevel 每级的裸属性与最终升级经验）。**客户端不再自己派生** —— " +
      "属性由服务端 growth-seed 按曲线展开，exp 取 level_exps 表（管理端可改）；" +
      "客户端 levelMap 整表由这段填充，曲线与标量不再下发",
    type: [LevelDto],
  })
  @Type(() => LevelDto)
  levels!: LevelDto[];

  @ApiProperty({ description: "成长标量参数（键值对；客户端只消费 roleMaxLevel，其余键服务端自用）", type: [GrowthScalarDto] })
  @Type(() => GrowthScalarDto)
  growthScalars!: GrowthScalarDto[];

  @ApiProperty({
    description:
      "战斗力权重（属性名 → 倍率；#603：唯一书写处是服务端 shared/combat-seed.ts）。" +
      "服务端用它算角色战斗力，客户端只用它算「这件装备是不是更好」——" +
      "客户端 configs/battle 不再存倍率，进游戏由这段整表填充。hpRecover 不在表里（回血不计战斗力）",
    additionalProperties: { type: "number" },
  })
  combatWeights!: Record<string, number>;

  @ApiProperty({ description: "商城全部商品定价（price = null 走统一价）", type: [MallPriceItemDto] })
  @Type(() => MallPriceItemDto)
  mallPrices!: MallPriceItemDto[];

  @ApiProperty({ description: "商城统一价（单行）" })
  @ValidateNested()
  @Type(() => MallSettingsDto)
  mallSettings!: MallSettingsDto;

  @ApiProperty({ description: "具名掉落表（含 default 兜底）", type: [DropTableDto] })
  @Type(() => DropTableDto)
  dropTables!: DropTableDto[];

  @ApiProperty({ description: "每怪掉落配置（怪物 key → 三选一来源）", type: [MonsterDropDto] })
  @Type(() => MonsterDropDto)
  monsterDrops!: MonsterDropDto[];

  @ApiProperty({ description: "技能配置（角色与怪物同表，owner 区分；含释放限制与挂载状态）", type: [SkillDto] })
  @Type(() => SkillDto)
  skills!: SkillDto[];

  @ApiProperty({ description: "状态配置（角色与怪物同表，owner 区分）", type: [StatusDto] })
  @Type(() => StatusDto)
  statuses!: StatusDto[];

  @ApiProperty({ description: "任务配置（#396：主线链 / 日常 / 单目标 / 奖励）", type: [QuestDto] })
  @Type(() => QuestDto)
  quests!: QuestDto[];

  @ApiProperty({
    description:
      "成就配置（#401：分类 / 条件 / 门槛 / 奖励）。进度与达成状态走 `/achievements/me`，不在配置快照里",
    type: [AchievementDto],
  })
  @Type(() => AchievementDto)
  achievements!: AchievementDto[];

  @ApiProperty({
    description:
      "地图玩法配置（#573：名称 / 类型 / 进入条件）。**客户端不再自己存这些** —— " +
      "`configs/map.ts` 只剩 TMX 的约定与运行时表，进游戏时按 id 覆写；" +
      "资源路径由客户端按 `resources/map/<id>/<id>` 拼，不在下发范围里",
    type: [MapConfigDto],
  })
  @Type(() => MapConfigDto)
  maps!: MapConfigDto[];

  @ApiProperty({
    description: "地图类型分组（顺序即传送弹窗的分组顺序；类型文案的唯一来源在服务端）",
    type: [MapTypeGroupDto],
  })
  @Type(() => MapTypeGroupDto)
  mapTypes!: MapTypeGroupDto[];

  @ApiProperty({
    description:
      "特效的表现参数（#594 升级特效 / #634 掉落光效：摆位 / 缩放 / 旋转 / 时长 / 开关）。与武器外观同一套取向 —— " +
      "调一次摆位不用重打客户端包；图集路径不在下发范围里（客户端资源约定：升级 `effect/<key>/<key>.plist`、掉落光效 `effect/light/<key>.plist`）",
    type: [UiEffectConfigDto],
  })
  @Type(() => UiEffectConfigDto)
  uiEffects!: UiEffectConfigDto[];

  @ApiProperty({
    description:
      "装备槽位表（#603 第九域，13 行）：槽位名 / 底图 / 位置分组 / 顺序。" +
      "客户端 `equipmentSlots` 与 `equipmentSlotOrder` 都按它整表重建（缓存里没有本地兜底）",
    type: [EquipmentSlotDto],
  })
  @Type(() => EquipmentSlotDto)
  equipmentSlots!: EquipmentSlotDto[];

  @ApiProperty({
    description:
      "装备规则（#603 第九域，单行）：前后缀属性倍率 / 品质文案 / 回收价曲线。" +
      "客户端靠倍率才知道要把每件基础件展开成几档变体，靠曲线算回收价 —— 缺这一段装备表整个是空的",
    type: EquipmentMetaDto,
  })
  @Type(() => EquipmentMetaDto)
  equipmentMeta!: EquipmentMetaDto;
}
