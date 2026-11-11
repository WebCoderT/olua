import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";
import { RoleRow } from "../../../database/rows";
import { type AttrAllocation, ATTR_KEYS } from "../../../common/utils/attr-points.util";
import { RoleDto } from "./role.dto";

/**
 * 加点请求（#833）
 *
 * 只报**这次每项加几点**（增量），不报「加完是多少」：报绝对值就等于让改包
 * 直接把四维写成想要的数字，绕过「点数够不够」。剩余点数也不报 —— 它在服务端。
 *
 * 四项都可省略（省略 = 这一项不加），但**加起来必须 ≥ 1**，否则 20038。
 * 上限用 `ATTR_POINT_MAX_PER_REQUEST` 夹一道：真实上限取决于等级（每级 1 点），
 * 这里只拦「一个离谱的大数」，剩下的额度由余额判定回答（20037）。
 */
export class AttrAllocateDto {
  @ApiPropertyOptional({ description: "本次加给力量的点数（缺省 = 0）", minimum: 0, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "str 必须是整数" })
  @Min(0)
  @Max(10000)
  str?: number;

  @ApiPropertyOptional({ description: "本次加给敏捷的点数（缺省 = 0）", minimum: 0, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "agi 必须是整数" })
  @Min(0)
  @Max(10000)
  agi?: number;

  @ApiPropertyOptional({ description: "本次加给体质的点数（缺省 = 0）", minimum: 0, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "vit 必须是整数" })
  @Min(0)
  @Max(10000)
  vit?: number;

  @ApiPropertyOptional({ description: "本次加给精神的点数（缺省 = 0）", minimum: 0, maximum: 10000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "spi 必须是整数" })
  @Min(0)
  @Max(10000)
  spi?: number;

  @ApiProperty({
    description: "修订号（乐观锁，必填）：客户端读到的值，与服务端不一致时 20006，需先拉最新存档（B62 / #820）",
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number;
}

/** 洗点请求（#833）：没有参数，只有乐观锁 */
export class AttrResetDto {
  @ApiProperty({
    description: "修订号（乐观锁，必填）：与服务端不一致时 20006，需先拉最新存档（B62 / #820）",
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision!: number;
}

/**
 * 四维点数（#833）
 *
 * 单独做成类而不是 `Record` 类型别名：接口契约里要有**具名模型**，客户端的
 * 生成物才是 `{ str: number; agi: number; ... }` 而不是 `unknown`（后者会让每个
 * 消费点都手写一次类型断言，等于没有类型）。
 */
export class AttrAllocationDto {
  @ApiProperty({ description: "力量已分配点数（物攻）", example: 3 })
  str: number;

  @ApiProperty({ description: "敏捷已分配点数（暴击率）", example: 1 })
  agi: number;

  @ApiProperty({ description: "体质已分配点数（生命上限 + 物防）", example: 0 })
  vit: number;

  @ApiProperty({ description: "精神已分配点数（法攻 + 道攻 + 法力上限）", example: 0 })
  spi: number;

  static from(attrs: AttrAllocation): AttrAllocationDto {
    const dto = new AttrAllocationDto();
    // 按 ATTR_KEYS 固定键序出一份：客户端表格按它渲染，多一个键就多一行空行
    for (const key of ATTR_KEYS) dto[key] = attrs[key] ?? 0;
    return dto;
  }
}

/**
 * 加点 / 洗点的结果（#833）
 *
 * 继承 `RoleDto`：`data.attrs` / `data.attrPoints` / `data.bindGold` 已经是写库后的权威值，
 * 客户端**整份抄回去**（与技能升级、背包操作同一纪律：只照搬，不重算）。
 * 三个平铺字段只说明「这一次发生了什么」：
 *
 * - `spent`：这次花掉多少属性点（洗点为 0）；
 * - `refund`：这次退还多少属性点（加点为 0，洗点 = 洗点前的四维之和）；
 * - `cost`：这次花掉多少绑定元宝（加点恒为 0，洗点 = `growth_scalars.attrResetCost`）——
 *   客户端不需要知道洗点价格，成功回执里就有。
 */
export class AttrChangeResultDto extends RoleDto {
  @ApiProperty({ description: "写库后的四维（已分配点数）", type: AttrAllocationDto })
  attrs: AttrAllocationDto;

  @ApiProperty({ description: "写库后还剩多少未分配属性点" })
  attrPoints: number;

  @ApiProperty({ description: "本次消耗的属性点（洗点恒为 0）" })
  spent: number;

  @ApiProperty({ description: "本次退还的属性点（加点恒为 0）" })
  refund: number;

  @ApiProperty({ description: "本次消耗的绑定元宝（加点恒为 0；洗点取 `growth_scalars.attrResetCost`）" })
  cost: number;

  static fromRow(
    row: RoleRow,
    onlineRoleId: string | null,
    detail: { attrs: AttrAllocation; attrPoints: number; spent: number; refund: number; cost: number },
  ): AttrChangeResultDto {
    const dto = new AttrChangeResultDto();
    Object.assign(dto, RoleDto.from(row, onlineRoleId));
    dto.attrs = AttrAllocationDto.from(detail.attrs);
    dto.attrPoints = detail.attrPoints;
    dto.spent = detail.spent;
    dto.refund = detail.refund;
    dto.cost = detail.cost;
    return dto;
  }
}
