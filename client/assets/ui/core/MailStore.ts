import { GameMailApi } from "../utils/net/Api";
import type { MailBox } from "../utils/net/ApiModels";

/** 邮件仓的本地状态 */
export interface MailState {
  /** 服务端给的整份收件箱（null = 还没取到） */
  data: MailBox | null;
  /** 正在请求（列表显示「正在取邮件…」而不是「空箱子」） */
  loading: boolean;
  /** 上一次请求失败了（显示「没取到」，不装作「一封邮件都没有」） */
  failed: boolean;
  /** 正在处理的邮件 id（防连点；空串 = 空闲） */
  busyId: string;
}

/** 一次「有反馈」的操作结果（弹窗据此决定飘什么字） */
export interface MailActionResult {
  ok: boolean;
  /** 业务码：0 成功 / 20012 背包满 / 50142 已领 / 50143 附件没领不能删 */
  code: number;
}

/** 一键领取的结果（多两个字段：领了几封、是不是被背包满中断） */
export interface MailClaimAllOutcome extends MailActionResult {
  claimedCount: number;
  stoppedByBag: boolean;
}

/**
 * 邮件仓（#429）
 *
 * 与成就 / 排行榜同一取向：**整份快照、不缓存**。`GET /mails/me` 一次给全量，
 * 领取 / 已读 / 删除也都返回整份，所以成功路径直接覆盖，不需要本地拼装，
 * 也不会出现「刚领完那封还显示未领」。
 *
 * 失败路径反过来：**只清 `busyId`，状态原样保留**。背包满（20012）时玩家清完格子
 * 直接再点一次就行，界面不该因为一次失败变成空列表 —— 那会让人以为邮件丢了。
 */
export default class MailStore {
  private static state: MailState = { data: null, loading: false, failed: false, busyId: "" };
  private static listeners: Array<() => void> = [];

  static get(): MailState {
    return this.state;
  }

  /** 重拉（打开面板 / 领取后补一次都走这里；正在拉的请求不叠加） */
  static reload(): void {
    if (this.state.loading) return;
    void this.load();
  }

  /** 标已读（打开一封邮件时调；重复标服务端不会改写第一次的时刻） */
  static async read(id: string): Promise<MailActionResult> {
    return this.run(id, async () => GameMailApi.read(id));
  }

  /** 领一封的附件 */
  static async claim(id: string): Promise<MailActionResult> {
    return this.run(id, async () => GameMailApi.claim(id));
  }

  /** 删一封（附件没领会被服务端拒掉，50143） */
  static async remove(id: string): Promise<MailActionResult> {
    return this.run(id, async () => GameMailApi.remove(id));
  }

  /**
   * 一键领取
   *
   * `busyId` 用 `"*"` 占位：它和单封操作互斥（同一封邮件被两条路径同时发奖是完全可以避免的）。
   */
  static async claimAll(): Promise<MailClaimAllOutcome> {
    if (this.state.busyId) return { ok: false, code: 0, claimedCount: 0, stoppedByBag: false };
    this.state = { ...this.state, busyId: "*" };
    this.emit();
    try {
      const result = await GameMailApi.claimAll();
      this.state = { data: toBox(result), loading: false, failed: false, busyId: "" };
      this.emit();
      return { ok: true, code: 0, claimedCount: result.claimedCount, stoppedByBag: result.stoppedByBag };
    } catch (error) {
      this.state = { ...this.state, busyId: "" };
      this.emit();
      return { ok: false, code: codeOf(error), claimedCount: 0, stoppedByBag: false };
    }
  }

  /** 切角色 / 回登录：收件箱是「这个角色的」 */
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

  /** 单封动作的公共壳：置忙 → 请求 → 成功覆盖整份 / 失败保留旧数据 */
  private static async run(id: string, call: () => Promise<MailBox | MailClaimResultLike>): Promise<MailActionResult> {
    if (this.state.busyId) return { ok: false, code: 0 };
    this.state = { ...this.state, busyId: id };
    this.emit();
    try {
      const result = await call();
      this.state = { data: toBox(result), loading: false, failed: false, busyId: "" };
      this.emit();
      return { ok: true, code: 0 };
    } catch (error) {
      this.state = { ...this.state, busyId: "" };
      this.emit();
      return { ok: false, code: codeOf(error) };
    }
  }

  private static async load(): Promise<void> {
    this.state = { ...this.state, loading: true, failed: false };
    this.emit();
    try {
      const data = await GameMailApi.mine();
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

/** 领取结果比收件箱多几个字段，但「箱子」那三个字段一直在 —— 只取这三个 */
interface MailClaimResultLike {
  mails: MailBox["mails"];
  unread: number;
  unclaimed: number;
}

/**
 * 各种响应形状 → 收件箱快照
 *
 * 领取接口返回的是「箱子 + 本次到手」，`mails` / `unread` / `unclaimed` 三个字段
 * 与 `GET /mails/me` 完全一致；这里只挑这三个，免得本地多出一份「本次领了多少」
 * 的临时状态 —— 那是弹窗飘字用的，不该进仓。
 */
function toBox(result: MailBox | MailClaimResultLike): MailBox {
  return { mails: result.mails, unread: result.unread, unclaimed: result.unclaimed };
}

/** 业务码在 ApiError 上；拿不到就当一般失败（0） */
function codeOf(error: unknown): number {
  return (error as { code?: number }).code ?? 0;
}
