import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsObject, IsOptional, IsString, Min } from "class-validator";

/**
 * 创建角色入参（#597：建号职责整体搬到服务端）
 *
 * 客户端只传它自己才知道的三样 —— 输入框里的名字、选中的职业与性别；
 * 初始数据（背包 / 装备 / 货币 / 技能 / 引导…）由服务端构造（见 `initial-role.ts`），
 * 客户端不再本地 `new Role(...)` 拼完整存档。
 */
export class CreateRoleDto {
  @ApiProperty({ description: "角色名（同一账号内唯一；去空白后 1~12 字）", example: "小明" })
  @IsString({ message: "角色名必须是字符串" })
  name: string;

  @ApiProperty({ description: "职业（客户端 OECCUPATION 枚举值）", example: "1" })
  @IsString({ message: "职业必须是字符串" })
  occupation: string;

  @ApiProperty({ description: "性别（客户端 SEX 枚举值）", example: "1" })
  @IsString({ message: "性别必须是字符串" })
  sex: string;
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
