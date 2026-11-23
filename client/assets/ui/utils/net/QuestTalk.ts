import { QuestApi } from "./Api";
import QuestStore from "../../core/QuestStore";

/** 服务端 talk 距离闸的业务码（`BizCode.QUEST_NOT_NEAR_NPC`，20032）：客户端不引服务端码表，字面量对齐 */
const BIZ_NOT_NEAR_NPC = 20032;

/**
 * 距离闸拒绝后的重试延迟（毫秒）
 *
 * #1210：触发用的是客户端坐标，服务端按 `role_positions` 位置快照判距离，快照写库有
 * 最多 1 秒的滞后 —— 玩家刚走完最后一步就触发时，服务端眼里他还在 120px 之外。
 * 等这一拍落库后重试必过闸；800ms 在快照写库节拍之内，又不至于让人感觉卡顿。
 */
const NOT_NEAR_RETRY_DELAY_MS = 800;

/**
 * 与 NPC 对话（#396）
 *
 * 服务端把「点一下 NPC」当成一次对话：推进进行中的 talk 目标（到量转 ready），
 * 再把该 NPC 名下全部任务的状态带回来。客户端这里只做两件事 ——
 * 发请求、把回来的状态**合并**进 `QuestStore`（对话响应只含这个 NPC 的任务，
 * 不能整份覆盖，否则会把别的 NPC 的进度抹掉）。
 *
 * 失败静默：点 NPC 是高频动作，网络抖一下不该弹窗；玩家的原有点击行为（传送 / 战魂）
 * 也不该因为任务接口失败而被卡住。静默靠**请求层**的 `silent` 完成 —— 业务层的
 * `.catch(() => undefined)` 只是不再二次处理，拦不住 `HttpClient` 全局失败出口
 * （#1210 实测：没带 silent 时「离 NPC 太远了」红字就是从那里弹出来的）。
 */
export default class QuestTalk {
  static report(npcId: string): void {
    this.talk(npcId, false);
  }

  /** 发一次对话上报：`retried` 防递归 —— 重试那次再被距离闸拒绝就认了，不再弹也不再试 */
  private static talk(npcId: string, retried: boolean): void {
    if (!npcId) return;
    void QuestApi.npcTalk({ npcId }, { silent: true })
      .then((result) => {
        for (const state of result.quests) QuestStore.applyState(state);
      })
      .catch((error: { code?: number }) => {
        // 服务端距离闸拒绝：位置快照滞后导致的假拒，等一拍重试一次（仍静默），
        // talk 型任务的进度不因这次抖动丢失；其余失败（网络抖动等）照旧静默
        if (!retried && error?.code === BIZ_NOT_NEAR_NPC) {
          setTimeout(() => this.talk(npcId, true), NOT_NEAR_RETRY_DELAY_MS);
        }
      });
  }
}
