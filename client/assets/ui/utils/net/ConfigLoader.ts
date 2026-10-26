import { GameConfigApi } from "./Api";
import type { GameConfigSnapshot } from "./ApiModels";
import { applyConfigSnapshot } from "../../../configs/apply-snapshot";

/**
 * 服务端配置快照加载器（#294）
 *
 * 进游戏拉一次 `gameConfig.snapshot`，把管理端可改的配置覆写进本地 configs
 * （见 configs/apply-snapshot）。设计要点：
 * - **静默失败**：快照拉不到（网络抖动 / 服务端旧版本）就整体回落本地静态配置，
 *   游戏照常能玩 —— 配置是「运营调优」不是「必需依赖」，不该因为它挡住进入游戏。
 * - **进程内只拉一次**：覆写是幂等的（逐字段赋值），但没必要反复拉；重进游戏
 *   （场景重载）重新走 start() 时靠 loaded 标记短路，改配置后重进即见新值。
 * - **去重并发**：loading 期间重复调用共享同一个 Promise。
 */

let loaded = false;
let loading: Promise<void> | null = null;

/** 拉取并落库配置快照；失败静默回落本地配置（不抛出，调用方无需 catch） */
export async function loadGameConfig(): Promise<void> {
  if (loaded) return;
  if (!loading) {
    // target 是 ES2015（Cocos 打包基线），Promise 没有 .finally —— 用 then/catch 两段收尾
    loading = GameConfigApi.snapshot({ silent: true })
      .then((snapshot: GameConfigSnapshot) => {
        applyConfigSnapshot(snapshot);
        loaded = true;
      })
      .catch(() => {
        // 快照失败不致命：本地 configs 就是同一份数据的 seed 源，先按本地值玩
      })
      .then(() => {
        loading = null;
      }) as Promise<void>;
  }
  return loading;
}
