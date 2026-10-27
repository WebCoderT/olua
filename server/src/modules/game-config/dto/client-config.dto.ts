import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ValidateNested } from "class-validator";
import { DrugDto } from "./drug.dto";
import { DropTableDto, MonsterDropDto } from "./drop.dto";
import { EquipmentDto } from "./equipment.dto";
import { FashionDto } from "./fashion.dto";
import { GrowthScalarDto, LevelExpDto, GrowthSegmentDto } from "./growth.dto";
import { ItemDto } from "./item.dto";
import { MallPriceItemDto, MallSettingsDto } from "./mall.dto";
import { MonsterDto } from "./monster.dto";
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

  @ApiProperty({ description: "NPC 基础数据（名称 / 对话文案）", type: [NpcDto] })
  @Type(() => NpcDto)
  npcs!: NpcDto[];

  @ApiProperty({ description: "时装配置", type: [FashionDto] })
  @Type(() => FashionDto)
  fashions!: FashionDto[];

  @ApiProperty({ description: "升级经验表（一行 = 升到下一级所需经验）", type: [LevelExpDto] })
  @Type(() => LevelExpDto)
  levelExps!: LevelExpDto[];

  @ApiProperty({ description: "成长曲线分段", type: [GrowthSegmentDto] })
  @Type(() => GrowthSegmentDto)
  growthSegments!: GrowthSegmentDto[];

  @ApiProperty({ description: "成长标量参数（键值对）", type: [GrowthScalarDto] })
  @Type(() => GrowthScalarDto)
  growthScalars!: GrowthScalarDto[];

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
}
