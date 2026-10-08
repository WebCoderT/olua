import { Type } from "@nestjs/common";
import { ApiExtension, getSchemaPath } from "@nestjs/swagger";

/**
 * 声明「这个接口的 query 参数来自哪个 DTO」
 *
 * 为什么需要：`@Query() dto: RoleQueryDto` 在文档里会被摊成一条条**散装** query 参数
 * （page / size / keyword / ...），DTO 类名就此丢失。而客户端 / 管理端的接口文件是从文档
 * 生成的（见 tools/gen-api.cjs），没有类名就只能给查询类型现造一个名字。
 * 这里补一个机器可读的扩展把 DTO 挂回去，生成的类型名与字段就与 DTO 完全一致。
 */
export function ApiQueryModel(model: Type<unknown>) {
  return ApiExtension("x-olua-query-schema", { $ref: getSchemaPath(model) });
}
