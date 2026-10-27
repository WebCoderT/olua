import { QuestApi } from "./Api";
import QuestStore from "../../core/QuestStore";

/**
 * 与 NPC 对话（#396）
 *
 * 服务端把「点一下 NPC」当成一次对话：推进进行中的 talk 目标（到量转 ready），
 * 再把该 NPC 名下全部任务的状态带回来。客户端这里只做两件事 ——
 * 发请求、把回来的状态**合并**进 `QuestStore`（对话响应只含这个 NPC 的任务，
 * 不能整份覆盖，否则会把别的 NPC 的进度抹掉）。
 *
 * 失败静默：点 NPC 是高频动作，网络抖一下不该弹窗；玩家的原有点击行为（传送 / 战魂）
 * 也不该因为任务接口失败而被卡住。
 */
export default class QuestTalk {
  static report(npcId: string): void {
    if (!npcId) return;
    void QuestApi.npcTalk({ npcId })
      .then((result) => {
        for (const state of result.quests) QuestStore.applyState(state);
      })
      .catch(() => undefined);
  }
}
