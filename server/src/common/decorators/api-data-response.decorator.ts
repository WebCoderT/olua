import { applyDecorators, HttpStatus, Type } from "@nestjs/common";
import { ApiExtension, ApiResponse, getSchemaPath } from "@nestjs/swagger";
import { ApiEnvelopeDto } from "../dto/api-envelope.dto";

interface ApiDataResponseOptions {
  /** 接口说明 */
  description?: string;
  /** HTTP 状态码（默认 200） */
  status?: number;
  /** data 是否为数组 */
  isArray?: boolean;
  /** data 是否可能为 null（如「无在线角色」） */
  nullable?: boolean;
}

/**
 * 描述「统一包裹下的成功响应」
 *
 * 生成两样东西：
 * 1. **给人看的** Swagger schema = ApiEnvelopeDto + data 指向业务模型（isArray 时再包一层 array），
 *    这样 Swagger 上不会因为统一包裹而看不到业务字段；
 * 2. **给代码生成器看的** 扩展字段：
 *    - `x-olua-data-schema`：data 的原始 schema（`$ref` 或 array）；
 *      不写 = 该接口没有业务数据（data 恒为 null）。
 *    - `x-olua-data-nullable`：data 是否可能为 null。
 *
 * 为什么要第 2 项：客户端与管理端的接口文件由 `tools/gen-api.cjs` 从文档生成，
 * 生成器需要「这个接口的 data 到底是什么类型」这个**机器可读**的答案 ——
 * 让它去猜 `allOf` 里哪一段是业务模型，迟早会在某次重构里猜错。
 */
export function ApiDataResponse(model?: Type<unknown>, options: ApiDataResponseOptions = {}) {
  const { description, status = HttpStatus.OK, isArray = false, nullable = false } = options;
  const dataSchema = model ? { $ref: getSchemaPath(model) } : { type: "object", nullable: true, additionalProperties: true };
  const wrappedData = model ? (isArray ? { type: "array", items: { $ref: getSchemaPath(model) } } : dataSchema) : dataSchema;

  const decorators = [
    // 没有业务数据的接口（删除之类的 void 响应）不写这个扩展，生成器据此产出 `null`
    ...(model ? [ApiExtension("x-olua-data-schema", wrappedData)] : []),
    ApiExtension("x-olua-data-nullable", nullable || !model),
    ApiResponse({
      status,
      description,
      schema: {
        allOf: [
          { $ref: getSchemaPath(ApiEnvelopeDto) },
          { properties: { data: isArray ? { type: "array", items: dataSchema } : dataSchema } },
        ],
      },
    }),
  ];

  return applyDecorators(...decorators);
}

/** 无业务数据的成功响应（删除之类的操作；data 恒为 null） */
export function ApiVoidResponse(description?: string) {
  return ApiDataResponse(undefined, { description });
}
