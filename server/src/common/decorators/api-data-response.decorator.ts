import { applyDecorators, HttpStatus, Type } from "@nestjs/common";
import { ApiResponse, getSchemaPath } from "@nestjs/swagger";
import { ApiEnvelopeDto } from "../dto/api-envelope.dto";

interface ApiDataResponseOptions {
  /** 接口说明 */
  description?: string;
  /** HTTP 状态码（默认 200） */
  status?: number;
  /** data 是否为数组 */
  isArray?: boolean;
}

/**
 * 描述「统一包裹下的成功响应」
 *
 * 生成的 schema = ApiEnvelopeDto + data 指向业务模型（isArray 时再包一层 array），
 * 这样 Swagger 上不会因为统一包裹而看不到业务字段。
 */
export function ApiDataResponse(model?: Type<unknown>, options: ApiDataResponseOptions = {}) {
  const { description, status = HttpStatus.OK, isArray = false } = options;
  const dataSchema = model ? { $ref: getSchemaPath(model) } : { type: "object", nullable: true, additionalProperties: true };
  return applyDecorators(
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
  );
}

/** 无业务数据的成功响应（删除之类的操作；data 恒为 null） */
export function ApiVoidResponse(description?: string) {
  return ApiDataResponse(undefined, { description });
}
