import { AchievementApi } from "../utils/net/Api";
import type { MyAchievements } from "../utils/net/ApiModels";

/** 成就仓的本地状态 */
export interface AchievementState {
  /** 服务端给的整份快照（null = 还没取到） */
  data: MyAchievements | null;
  /** 正在请求（列表显示「正在取成就…」而不是空列表） */
  loading: boolean;
  /** 上一次请求失败了（显示「没取到」，不装作「一个成就都没有」） */
  failed: boolean;
  /** 正在领取的成就 id（防连点；空串 = 空闲） */
  busyId: string;
}

/**
 * 成就仓（#401）
 *
 * ## 为什么是「整份快照」而不是按条缓存
 * 服务端 `GET /achievements/me` 一次返回全量（几十条），而面板就是「一屏成就墙」——
 * 按条增量缓存只会让「刚领完的那条」和「别处的进度」有机会不一致。
 * 领取接口也返回整份，所以领完直接覆盖，不需要本地拼装。
 *
 * ## 为什么不缓存（有数据就不拉）
 * 与排行榜同一取向：打开面板就是想看「我现在达成到哪了」，而状态型成就的进度
 * 完全取决于角色当前状态（等级 / 战力 / 背包），缓存一份十秒前的只会显示旧进度。
 * 每次打开、每次切页签都重拉。
 */
export default class AchievementStore {
  private static state: AchievementState = { data: null, loading: false, failed: false, busyId: "" };
  private static listeners: Array<() => void> = [];

  static get(): AchievementState {
    return this.state;
  }

  /** 强制重拉（打开面板 / 切页签走这里；正在拉的请求不叠加） */
  static reload(): void {
    if (this.state.loading) return;
    void this.load();
  }

  /**
   * 领取
   *
   * 成功后**直接用返回值覆盖整份快照**（服务端返回的就是最新全量）。
   * 失败只把 `busyId` 清掉、状态原样保留 —— 背包满（20012）时玩家清完格子
   * 直接再点一次就行，界面不该因为一次失败就变成空列表。
   *
   * @returns 成功与否 + 业务码（0 = 成功；20012 = 背包放不下），由调用方决定飘什么字
   */
  static async claim(achievementId: string): Promise<{ ok: boolean; code: number }> {
    if (this.state.busyId) return { ok: false, code: 0 };
    this.state = { ...this.state, busyId: achievementId };
    this.emit();
    try {
      const data = await AchievementApi.claim({ achievementId });
      this.state = { data: data ?? this.state.data, loading: false, failed: false, busyId: "" };
      this.emit();
      return { ok: true, code: 0 };
    } catch (error) {
      // 业务码在 ApiError 上（20012 = 背包放不下）；拿不到就当一般失败
      const code = (error as { code?: number }).code ?? 0;
      this.state = { ...this.state, busyId: "" };
      this.emit();
      return { ok: false, code };
    }
  }

  /** 切角色 / 回登录：成就墙是「这个角色的」，不能带给下一个角色 */
  static clear(): void {
    this.state = { data: null, loading: false, failed: false, busyId: "" };
    this.emit();
  }

  /** 订阅变化（弹窗打开期间挂上；返回退订函数） */
  static onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  private static async load(): Promise<void> {
    this.state = { ...this.state, loading: true, failed: false };
    this.emit();
    try {
      const data = await AchievementApi.mine();
      this.state = { data: data ?? null, loading: false, failed: false, busyId: "" };
    } catch {
      this.state = { ...this.state, loading: false, failed: true };
    }
    this.emit();
  }

  private static emit(): void {
    for (const listener of this.listeners) listener();
  }
}
