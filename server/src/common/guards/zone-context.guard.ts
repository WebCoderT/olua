import { CanActivate, ExecutionContext, HttpStatus, Injectable } from "@nestjs/common";
import { BizCode } from "../constants/biz-code";
import { BizException } from "../errors/biz.exception";
import { ZoneRepository } from "../../database/repositories/zone.repository";

/**
 * 管理端「单区上下文」守卫（#960 / docs/39 §3.8）
 *
 * ===========================================================================
 * 为什么管理端要有一个必填的区
 * ===========================================================================
 * 口径已经拍过：**不绑区**（任何管理员都能看所有区，含 `closed` 区），但**一次只在一个区里干活**。
 * 于是「区」不是权限，是**上下文** —— 和「你在哪个文件夹里」一样，请求必须说明它。
 *
 * 没有这个头会出两种错，而且都是静默的：
 *   - 列表把 A 区和 B 区的角色混在一起，「第 3 页」到底是谁的第 3 页说不清；
 *   - 写操作拿 A 区页面上的按钮去改 B 区的 id —— 它能成功，因为服务端从没要求过区。
 *
 * 所以这里是**必填**：缺失 / 不是正整数 / 区不存在 / 区已合并 → 400 `ZONE_REQUIRED`。
 * **没有「全部区」这个值**（白名单接口除外，见 tools/audit-admin-zone.cjs）。
 *
 * ===========================================================================
 * 只做一件事：这个区存在吗
 * ===========================================================================
 * 守卫**不判资源归属** —— 「这个角色属不属于当前区」是各 service 的事（跨区写要 404）。
 * 把归属判断塞进守卫，等于让守卫去认每种资源的 id 形状，那它就变成了半个业务层。
 *
 * `closed` 区**允许**通过：客服要能进去查历史（关区只是停止注册 / 不再推荐新人）。
 * 已合并的区不通过：它的数据已经被搬走了，在它下面看什么都是空的。
 */
@Injectable()
export class ZoneContextGuard implements CanActivate {
  constructor(private readonly zones: ZoneRepository) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined>; zoneId?: number }>();
    const raw = request.headers["x-zone-id"];
    request.zoneId = resolveZoneId(this.zones, Array.isArray(raw) ? raw[0] : raw);
    return true;
  }
}

/**
 * 把 `X-Zone-Id` 解成区 id（四处拒绝理由对客户端是同一句话）
 *
 * 单独导出是为了让**登录**（`POST /admin/auth/login`，此时还没有守卫可言）与守卫
 * 用同一套校验 —— 登录页选了一个不存在的区，不该等到下一个请求才炸。
 */
export function resolveZoneId(zones: ZoneRepository, raw: string | number | undefined): number {
  const zoneId = Number(raw);
  if (!raw || !Number.isInteger(zoneId) || zoneId <= 0) {
    throw new BizException(BizCode.ZONE_REQUIRED, "管理端请求必须带 X-Zone-Id（先选一个区服）", HttpStatus.BAD_REQUEST);
  }
  if (!zones.findLiveById(zoneId)) {
    throw new BizException(
      BizCode.ZONE_REQUIRED,
      `X-Zone-Id 指向的区服不存在或已合并（${zoneId}）—— 先选一个区服`,
      HttpStatus.BAD_REQUEST,
    );
  }
  return zoneId;
}
