import { LeaderboardApi } from "../utils/net/Api";
import type { LeaderboardPage, LeaderboardSelf } from "../utils/net/ApiModels";

/**
 * 三个榜（与服务端 `LEADERBOARD_BOARD` 同值；协议里是 `:board` 路径参数，所以只能是字符串）
 *
 * 客户端这边不重新定义「有哪几个榜」—— 页签顺序与这里的顺序一致，
 * 加一个榜就是服务端加一项、这里加一项、布局里加一列文案。
 */
export const LEADERBOARD_BOARD = {
  LEVEL: "level",
  COMBAT: "combat",
  KILLS: "kills",
} as const;
export type LeaderboardBoard = (typeof LEADERBOARD_BOARD)[keyof typeof LEADERBOARD_BOARD];

/** 全部榜（页签顺序即这个顺序） */
export const LEADERBOARD_BOARDS: LeaderboardBoard[] = [LEADERBOARD_BOARD.LEVEL, LEADERBOARD_BOARD.COMBAT, LEADERBOARD_BOARD.KILLS];

/** 一个榜在本地的一份状态 */
export interface LeaderboardBoardState {
  /** 榜单分页（null = 还没取到） */
  page: LeaderboardPage | null;
  /** 我的名次（null = 还没取到） */
  self: LeaderboardSelf | null;
  /** 正在请求（列表据此显示「正在取榜…」而不是空列表） */
  loading: boolean;
  /** 上一次请求失败了（列表显示「没取到，稍后再试」，而不是装作榜是空的） */
  failed: boolean;
}

/**
 * 排行榜仓（#400）
 *
 * ## 为什么不和实时帧一起放
 * 榜是 **HTTP 拉的**（`GET /leaderboards/:board`），不是推下来的：它一分钟才变一次，
 * 开面板时拉一次就够，没必要为它开一条帧 —— 那只会让「谁在什么时候看到哪一版榜」变得随机。
 *
 * ## 缓存口径
 * - 切页签**就重拉**（`reload`），不走「有数据就不拉」的缓存：玩家打开榜就是想看新的，
 *   缓存只会让他怀疑「我升级了怎么没动」；
 * - 请求带 `size=50`：榜本身最多 `LEADERBOARD_TOP_N`（默认 100）条，五十条足够玩家
 *   往下翻一段；再往后的人看的是底部那条「我的名次」，不是榜的尾巴。
 *
 * ## 为什么 `self` 与 `page` 一起拉
 * 两者是同一份快照（服务端两个接口都返回同一个 `computedAt`）。分开拉会有窗口期
 * 让「我第 37 名」和列表里第 37 名不是同一个人 —— 而那是这个面板最刺眼的不一致。
 */
export default class LeaderboardStore {
  private static states = new Map<LeaderboardBoard, LeaderboardBoardState>();
  private static listeners: Array<() => void> = [];

  /** 某个榜的当前状态（取不到时给一份空的，界面不必判 null） */
  static state(board: LeaderboardBoard): LeaderboardBoardState {
    return this.states.get(board) ?? { page: null, self: null, loading: false, failed: false };
  }

  /** 强制重拉（每次打开面板、每次切页签都走这里；正在拉的同一榜不叠加请求） */
  static reload(board: LeaderboardBoard): void {
    if (this.state(board).loading) return;
    void this.load(board);
  }

  /** 切角色 / 回登录：榜是「这个角色的名次」，不能带给下一个角色 */
  static clear(): void {
    this.states.clear();
    this.emit();
  }

  /** 订阅变化（弹窗打开期间挂在上面；返回退订函数） */
  static onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  /**
   * 拉一个榜（列表 + 我的名次，两次请求并发）
   *
   * 失败**不清旧数据**：一次网络抖动不该把玩家正在看的榜擦成空白 ——
   * 只置 `failed`，界面据此在顶部提示一句「没取到」，旧的那份继续显示。
   */
  private static async load(board: LeaderboardBoard): Promise<void> {
    this.states.set(board, { ...this.state(board), loading: true, failed: false });
    this.emit();
    try {
      const [page, self] = await Promise.all([
        LeaderboardApi.page(board, { page: 1, size: 50 }),
        LeaderboardApi.me(board),
      ]);
      this.states.set(board, { page: page ?? null, self: self ?? null, loading: false, failed: false });
    } catch {
      this.states.set(board, { ...this.state(board), loading: false, failed: true });
    }
    this.emit();
  }

  private static emit(): void {
    for (const listener of this.listeners) listener();
  }
}
