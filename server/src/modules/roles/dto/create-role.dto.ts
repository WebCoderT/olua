import { ApiProperty } from "@nestjs/swagger";
import { IsObject } from "class-validator";

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
}
