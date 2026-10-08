import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { AuthenticatedUser } from "../interfaces/api-envelope.interface";

/** 取当前登录者（玩家或管理员，由 AuthGuard 注入） */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedUser => {
  const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
  return request.user as AuthenticatedUser;
});
