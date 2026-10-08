import { networkConfig } from "../../../configs/network";
import { Role } from "../../../entities/Role";
import { RoleApi } from "./Api";
import ApiError from "./ApiError";

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
 * 什么时候必须 flush：会重建/销毁游戏场景的时机（切地图、退出），
 * 否则防抖窗口里那点改动会随场景一起没掉（见 ui/Game.onDestroy）。
 */
export default class RoleSync {
  /** 同步失败提示出口（不接则只打日志） */
  static onFailed: ((error: ApiError) => void) | null = null;

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
    try {
      await RoleApi.save(role.id, role, true);
      this.notified = false;
    } catch (error) {
      console.warn(`[RoleSync] 角色进度同步失败：${error instanceof ApiError ? `${error.kind}/${error.code}` : String(error)}`);
      if (!this.notified && this.onFailed && error instanceof ApiError) {
        this.notified = true;
        this.onFailed(error);
      }
    }
  }
}
