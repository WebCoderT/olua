import { ApiProperty } from "@nestjs/swagger";
import { PageMetaDto } from "../../../common/dto/api-envelope.dto";
import { AccountDto } from "../../auth/dto/account.dto";
import { AdminRoleDto } from "../../roles/dto/role.dto";
import { AdminDto } from "./admin.dto";

/**
 * 分页列表的响应模型（每个列表接口一个）
 *
 * 为什么不用泛型 `PageResult<T>`：泛型进不了 OpenAPI —— 文档里只会剩一个空对象，
 * 客户端与管理端的接口类型又都是从文档生成的，于是列表就会退化成「一个数组」，
 * 把 `total / page / size` 丢掉。写成一个具体类，生成器就能产出准确类型。
 */
export class AccountPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的账号列表", type: [AccountDto] })
  list: AccountDto[];
}

export class AdminPageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的管理员列表", type: [AdminDto] })
  list: AdminDto[];
}

export class AdminRolePageDto extends PageMetaDto {
  @ApiProperty({ description: "当前页的角色列表", type: [AdminRoleDto] })
  list: AdminRoleDto[];
}
