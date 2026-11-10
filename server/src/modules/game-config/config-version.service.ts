import { Injectable } from "@nestjs/common";
import { ConfigRevisionRepository } from "../../database/repositories/config-revision.repository";

/** 改配置的人（管理端令牌里解出来的身份；自举 / 脚本没有操作人时传 null） */
export interface ConfigActor {
  id?: string;
  username: string;
}

/**
 * 配置版本（#881 / J1）—— **一个自增数字**，不是时间戳也不是内容哈希
 *
 * ===========================================================================
 * 它解决的是哪两件事
 * ===========================================================================
 * 1. **客户端不知道自己是不是最新**：以前快照没有版本号，客户端拉一次就再也不问，
 *    运营改了技能伤害，在线玩家打到下次重登都还是旧数值。
 * 2. **每次请求都全量物化 13k 行**：没有版本号就没有「这份快照能不能复用」的判据，
 *    `GET /game-config` 每次都要把 12 个 service 的列表重新拼一遍。
 *
 * 有了它：快照的 `ETag` 就是 `W/"cfg-<version>"`（见 `ClientConfigController`），
 * 客户端带上 `If-None-Match` 直接拿 304；服务端按 version 缓存物化结果，
 * 版本不变就不重新拼。
 *
 * ## 谁 +1
 *
 * **不是每个 service 自己写**，而是 `ConfigVersionInterceptor` 一处统一做：
 * 管理端写接口（带 `gameConfig:write` 权限点）成功之后 `bump()`。
 * 判据是**权限点**而不是路径前缀 —— 配置写接口散在 game-config / map / ui-effect /
 * audio-setting 四个模块里，按路径列清单一定会漏（漏了就是「改了配置但客户端不知道」，
 * 静默且难查）。
 *
 * ## 为什么不按时间过期
 *
 * 缓存按时间过期会有两种错：配置刚改完还在 TTL 内 → 客户端拿到旧值（明明版本变了）；
 * 配置一年没改但 TTL 到期 → 白重新物化一次。按 version 失效两边都不发生。
 *
 * ## SQL 在哪
 *
 * 全在 `ConfigRevisionRepository`：这两张表是运行时表，读写都很短，但「谁存的」要
 * 与回滚历史同一处（版本号与分析 payload 的行是同一笔账）。
 */
@Injectable()
export class ConfigVersionService {
  constructor(private readonly revisions: ConfigRevisionRepository) {}

  /** 当前版本号（0 = 从没改过，出厂快照刚灌进来的状态） */
  current(): number {
    this.revisions.ensureVersionRow();
    return this.revisions.currentVersion();
  }

  /**
   * 版本 +1 并记下是谁改的
   *
   * 调用点在拦截器里（写接口成功之后），**不在事务里** —— 配置本身已经提交了，
   * 版本号晚一毫秒无所谓；反倒不该因为版本号写失败把一次成功的配置写入变成报错。
   */
  bump(actor?: ConfigActor | null): number {
    this.revisions.ensureVersionRow();
    return this.revisions.bumpVersion(actor?.username ?? "", Date.now());
  }

  /** 把版本垫到至少 `version`（导入别人的快照后跟上对方的计数，见 #883） */
  adopt(version: number): number {
    this.revisions.ensureVersionRow();
    if (!Number.isFinite(version) || version <= 0) return this.current();
    this.revisions.raiseVersionTo(Math.trunc(version), Date.now());
    return this.current();
  }
}
