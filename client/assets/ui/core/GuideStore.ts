import type { Role } from "../../entities/Role";
import { guideConfig, guideStepAt, guideStepCount } from "../../configs/guide";
import type { GuideStepConfig } from "../../configs/guide";
import { advanceGuide, normalizeGuideProgress, shouldRunGuide, skipGuide } from "../utils/guide/guide-progress";
import type { GuideEvent, GuideProgress } from "../../types/guide";
import StorageManager from "./StorageManager";

/**
 * 新手引导仓（#402）
 *
 * 只做三件事：**从存档读进度、收事件推进、把新进度写回存档**。
 * 推进规则在 `ui/utils/guide/guide-progress`（纯函数，单测直接拿真逻辑跑），
 * 怎么画在 `ui/components/GuideOverlay`（订阅本仓，变了就重绘）。
 *
 * ## 为什么进度放存档而不放服务端表
 * 引导没有奖励、没有结算，纯粹是「这个人见过没见过这几句话」——
 * 放 `role.guide` 的好处是换设备 / 重连 / 重启都自然续走，且不需要为它多一张表；
 * 服务端只校验结构与体量（见 server 的 `parseRoleData`），不做业务判定。
 *
 * ## 为什么推进靠事件不靠点击
 * 「点下一步」的引导玩家会一路点到尾、一句没看；而「自己走两步 / 打倒一只怪」
 * 是真做到了才前进。代价是每一步都得有可观测的触发点 —— 这就是那六个事件。
 */
export default class GuideStore {
  private static listeners: Array<() => void> = [];
  /** 当前角色的引导进度（null = 还没 start，此时任何事件都不该推进） */
  private static progress: GuideProgress | null = null;
  /** 移动事件的累积距离（世界坐标像素；到阈值才当一次「会走路了」） */
  private static moved = 0;

  /**
   * 进游戏时调一次：从存档取进度并规整
   *
   * 这里再 normalize 一遍不是多余 —— 存档可能是别的版本写的（或被改过），
   * 而 `ensureRoleDefaults` 只在选角/读档时跑。两处都过同一个纯函数，口径不会分叉。
   */
  static start(role: Role | null | undefined): void {
    this.progress = role ? normalizeGuideProgress(role.guide, guideStepCount()) : null;
    this.moved = 0;
    this.emit();
  }

  /** 离开游戏时清掉（下个角色重新 start；不清会出现「上一个角色的第 4 步」） */
  static reset(): void {
    this.progress = null;
    this.moved = 0;
    this.emit();
  }

  /** 当前进度（界面读它画「第几步 / 共几步」） */
  static current(): GuideProgress | null {
    return this.progress;
  }

  /** 当前这一步（走完 / 跳过 / 没 start 都是 null） */
  static currentStep(): GuideStepConfig | null {
    if (!this.progress || !shouldRunGuide(this.progress, guideStepCount())) return null;
    return guideStepAt(this.progress.step);
  }

  /** 现在要不要显示引导 */
  static visible(): boolean {
    return this.currentStep() !== null;
  }

  /**
   * 收一个推进事件
   *
   * **只有当前步的 trigger 命中才前进**（判定在纯函数里）：玩家先去点了背包，
   * 「走路 / 打怪 / 拾取」三步不会被一起吃掉。
   */
  static notify(event: GuideEvent): void {
    const progress = this.progress;
    const step = this.currentStep();
    if (!progress || !step) return;
    const next = advanceGuide(progress, step.trigger, event, guideStepCount());
    if (!next) return;
    this.apply(next);
  }

  /**
   * 累计移动距离（`Game.update` 每帧喂进来）
   *
   * 单独一个入口而不是让 Game 自己判阈值：阈值是配置（`guideConfig.tuning.moveDistance`），
   * 判断只该有一处。
   */
  static notifyMove(delta: number): void {
    if (!this.visible() || !Number.isFinite(delta) || delta <= 0) return;
    this.moved += delta;
    if (this.moved < guideConfig.tuning.moveDistance) return;
    this.moved = 0;
    this.notify("move");
  }

  /** 玩家点了「跳过引导」：落成 skipped，之后不再弹也不再自动开始 */
  static skip(): void {
    const progress = this.progress;
    if (!progress || !shouldRunGuide(progress, guideStepCount())) return;
    this.apply(skipGuide(progress));
  }

  /** 订阅进度变化（界面打开期间挂着；返回退订函数） */
  static onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  /** 落进度：先写存档（会经 RoleSync 防抖推服务端），再通知界面 */
  private static apply(next: GuideProgress): void {
    this.progress = next;
    const role = StorageManager.findOnlineRole();
    if (role) {
      role.guide = next;
      // 走的是标准落盘路径：属性重算 / UI 刷新 / 推送服务端都由它负责，
      // 引导不该自己再开一条「只写本地」的旁路
      StorageManager.updateOnlineRole(role);
    }
    this.emit();
  }

  private static emit(): void {
    for (const listener of this.listeners) listener();
  }
}
