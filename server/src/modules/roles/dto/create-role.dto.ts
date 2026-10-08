import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsObject, IsOptional, Min } from "class-validator";

/**
 * 创建角色入参
 *
 * `data` = 客户端按自身配置生成好的**完整角色对象**（entities/Role 的 JSON），
 * 服务端只做结构 / 索引字段 / 归属与上限校验后原样落库（理由见 role-data.util）。
 */
export class CreateRoleDto {
  @ApiProperty({
    description: "角色完整数据（客户端 entities/Role 的 JSON；必须含 id / name / occupation / sex / level）",
    type: "object",
    additionalProperties: true,
    example: { id: "1760000000000", name: "小明", occupation: "1", sex: "1", level: 1, gold: 1000, bag: [] },
  })
  @IsObject({ message: "角色数据必须是对象" })
  data: Record<string, unknown>;
}

/** 保存角色进度入参（全量覆盖；id 以路径参数为准，body 里的 id 会被忽略） */
export class SaveRoleDto {
  @ApiProperty({ description: "角色完整数据（全量覆盖）", type: "object", additionalProperties: true })
  @IsObject({ message: "角色数据必须是对象" })
  data: Record<string, unknown>;

  /**
   * 客户端读到的修订号（可选）
   *
   * 带上它 = 开启乐观锁：与服务端当前值不一致时接口会拒收（20006），
   * 客户端应拉一次角色详情再继续（见客户端 utils/net/RoleSync）。
   * 不传 = 旧行为（最后写入者胜），给还没升级的客户端留后路。
   */
  @ApiPropertyOptional({
    description: "客户端读到的修订号（带上即开启乐观锁：与服务端不一致时返回 20006，需先拉最新数据）",
    example: 3,
  })
  @IsOptional()
  @IsInt({ message: "修订号必须是整数" })
  @Min(0, { message: "修订号不能为负" })
  revision?: number;
}
