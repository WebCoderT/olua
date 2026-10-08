import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * 业务异常
 *
 * 与 HttpException 的区别：额外带一个业务码（响应体的 code），
 * 且 message 一定是可以直接展示给玩家的中文（英文技术细节只进日志）。
 */
export class BizException extends HttpException {
  readonly code: number;
  /** 附加信息（可选，进响应体便于排查；不要放敏感数据） */
  readonly details?: unknown;

  constructor(code: number, message: string, status: HttpStatus = HttpStatus.BAD_REQUEST, details?: unknown) {
    super(message, status);
    this.code = code;
    this.details = details;
  }

  /** 便捷构造：资源不存在（404） */
  static notFound(code: number, message: string): BizException {
    return new BizException(code, message, HttpStatus.NOT_FOUND);
  }

  /** 便捷构造：冲突（409） */
  static conflict(code: number, message: string): BizException {
    return new BizException(code, message, HttpStatus.CONFLICT);
  }

  /** 便捷构造：未认证（401） */
  static unauthorized(code: number, message: string): BizException {
    return new BizException(code, message, HttpStatus.UNAUTHORIZED);
  }

  /** 便捷构造：已认证但无权限（403） */
  static forbidden(code: number, message: string): BizException {
    return new BizException(code, message, HttpStatus.FORBIDDEN);
  }
}
