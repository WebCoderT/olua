import { networkConfig } from "../../../configs/network";
import { Role } from "../../../entities/Role";
import { RoleApi } from "./Api";
import type { RoleDetail } from "./Api";
import ApiError from "./ApiError";
import { ROLE_SYNC_BIZ_CODES } from "./ApiCodes";

/**
 * 角色进度同步（把本地存档写穿到服务端）
 *
 * **为什么必须防抖**：角色落盘的唯一收口是 `StorageManager.updateOnlineRole`，
 * 打怪升级、拾取掉落、买卖东西都会触发它 —— 每触发一次就发一次请求会把服务端打爆。
 * 所以这里只记住「最后一份数据」，等操作停下来（networkConfig.roleSyncDelay）再推一次。
 *
 * 失败不重排、不阻塞：本地存档已经落盘，下一次改动（或下次进游戏）会重新推；
 * 请求本身走**静默模式**（见 HttpClient 的 silent），提示只在**第一次**失败时给一条 ——
 * 否则后端一挂，打怪期间会每 1.5 秒弹一次。onFailed 由游戏场景接上飘字（见 ui/Game.start）。
 *
 * **乐观锁（revision）**：推送时带上本地这份数据基于的服务端修订号。
 * 对不上说明「玩家在游戏里、管理员在后台改过这个角色」—— 本地那份是改之前的基线，
 * 直接推上去会把后台的改动整体抹掉，所以服务端拒收（20006 / 见 ROLE_SYNC_BIZ_CODES），
 * 这里改为拉一次最新数据、交给 onConflict（后台改动优先，玩家这 1.5 秒内的改动让位）。
 * 服务端每次落库都会 +1，所以**推成功后必须记住新值**（onSaved），否则下一次推送会拿旧值撞自己。
 *
 * 另外两类「本地已经不是服务端现状」的失败各走各的出口（见 ApiCodes.ROLE_SYNC_BIZ_CODES）：
 * 角色被删 → onMissing（本地缓存一并删掉）；角色被管理员下线 → onKicked（**只清在线标记，不删角色**）。
 *
 * 什么时候必须 flush：会重建/销毁游戏场景的时机（切地图、退出），
 * 否则防抖窗口里那点改动会随场景一起没掉（见 ui/Game.onDestroy）。
 */
export default class RoleSync {
  /** 同步失败提示出口（不接则只打日志） */
  static onFailed: ((error: ApiError) => void) | null = null;
  /** 推送成功：服务端给了新的修订号（存储层要记下来当下一次的基线） */
  static onSaved: ((roleId: string, revision: number) => void) | null = null;
  /** 撞上乐观锁且已拉到服务端最新数据（后台改过这个角色） */
  static onConflict: ((fresh: RoleDetail) => void) | null = null;
  /** 角色在服务端已不存在（被后台删了）：本地不该继续玩一个不存在的角色 */
  static onMissing: ((roleId: string) => void) | null = null;
  /** 角色被管理员下线（角色还在，但账号的在线角色已被清）：回选角界面重选一次即可 */
  static onKicked: ((roleId: string) => void) | null = null;

  /** 待同步的数据（只记最后一份） */
  private static pending: Role | null = null;
  private static timer: ReturnType<typeof setTimeout> | null = null;
  private static notified = false;

  /** 安排一次同步（重复安排只推最后一次） */
  static schedule(role: Role) {
    this.pending = role;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, networkConfig.roleSyncDelay);
  }

  /** 立即推送（切地图这类会重建场景的时机调用，别让防抖窗口里的改动丢掉） */
  static async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const role = this.pending;
    this.pending = null;
    if (!role) return;
    // 版本号未知（这次改动之前没拿到过服务端版本，比如旧存档）就不带它：
    // 不带 = 服务端按旧行为处理（最后写入者胜），比拿一个瞎猜的版本号去撞乐观锁强
    const revision = typeof role.revision === "number" ? role.revision : undefined;
    try {
      const saved = await RoleApi.save(
        role.id,
        // 角色对象是 entities/Role 的实例，服务端只把它当不透明文档，所以按记录类型交给请求层
        { data: role as unknown as Record<string, unknown>, revision },
        { silent: true },
      );
      if (saved && typeof saved.revision === "number") {
        role.revision = saved.revision;
        this.onSaved?.(role.id, saved.revision);
      }
      this.notified = false;
    } catch (error) {
      if (error instanceof ApiError && (await this.handleStateConflict(error, role))) return;
      console.warn(`[RoleSync] 角色进度同步失败：${error instanceof ApiError ? `${error.kind}/${error.code}` : String(error)}`);
      if (!this.notified && this.onFailed && error instanceof ApiError) {
        this.notified = true;
        this.onFailed(error);
      }
    }
  }

  /**
   * 处理「本地存档已经不代表服务端现状」的三类失败
   *
   * @returns 是否已被接管（接管了就不再走普通失败提示）
   */
  private static async handleStateConflict(error: ApiError, role: Role): Promise<boolean> {
    if (error.code === ROLE_SYNC_BIZ_CODES.missing) {
      // 角色没了：玩下去只会一路同步失败，交给上层退出到选角场景
      console.warn(`[RoleSync] 角色已不存在（${role.id}），交由上层处理`);
      this.onMissing?.(role.id);
      return true;
    }
    if (error.code === ROLE_SYNC_BIZ_CODES.kicked) {
      // 被管理员下线：角色还在（别删本地数据），只是账号的在线角色被清了 ——
      // 玩家重新选一次这个角色就能继续（选角时会调 RoleApi.select 重新认领）
      console.warn(`[RoleSync] 角色已被管理员下线（${role.id}），交由上层处理`);
      this.onKicked?.(role.id);
      return true;
    }
    if (error.code !== ROLE_SYNC_BIZ_CODES.revisionConflict) return false;
    // 撞版本：以服务端最新数据为基线（后台改动优先），本轮这份改动丢弃
    try {
      // 静默：这条请求是「自愈流程」的一部分，失败提示由本流程统一给（见下面的 console.warn），
      // 走默认出口会在玩家已经看到「已同步最新」之后又弹一条报错
      const fresh = await RoleApi.detail(role.id, { silent: true });
      console.warn(`[RoleSync] 角色已在后台被修改（${role.id}），已同步到最新数据`);
      this.onConflict?.(fresh);
      this.notified = false;
    } catch (detailError) {
      // 拉最新数据也失败：留给下一轮改动重试（这里不再提示，避免刷屏）
      console.warn(`[RoleSync] 冲突后拉取最新数据失败：${detailError instanceof ApiError ? detailError.kind : String(detailError)}`);
    }
    return true;
  }
}
