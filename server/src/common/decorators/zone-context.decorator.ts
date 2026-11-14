import { createParamDecorator, ExecutionContext } from "@nestjs/common";

/**
 * 取当前请求的区（#960）
 *
 * 值由 `ZoneContextGuard` 放进 `request.zoneId` —— 所以**必须先挂守卫**。
 * 没挂守卫就取，说明这个路由忘了声明自己是「要在某个区里干活」的：直接抛出来，
 * 而不是回一个 `undefined` 让下游把 `WHERE zone_id = undefined` 查成空集
 * （空集看起来像「这个区没有数据」，是最难查的那种错）。
 */
export const ZoneContext = createParamDecorator((_data: unknown, context: ExecutionContext): number => {
  const request = context.switchToHttp().getRequest<{ zoneId?: number }>();
  if (typeof request.zoneId !== "number") {
    throw new Error("ZoneContext 用在了没有 ZoneContextGuard 的路由上（先在控制器上 @UseGuards(ZoneContextGuard)）");
  }
  return request.zoneId;
});
