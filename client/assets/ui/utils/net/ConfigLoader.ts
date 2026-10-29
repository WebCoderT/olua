import { GameConfigApi } from "./Api";
import type { EquipAlignList, GameConfigSnapshot } from "./ApiModels";
import { applyConfigSnapshot, applyEquipAlignRows } from "../../../configs/apply-snapshot";
import { rebuildSkills } from "../../../configs/skill";

/**
 * 服务端配置快照加载器（#294 / #513）
 *
 * 进游戏拉 `gameConfig.snapshot` + `gameConfig.equipAlign`，把管理端可改的配置覆写进本地
 * configs（见 configs/apply-snapshot）。设计要点：
 * - **静默失败**：任何一个拉不到（网络抖动 / 服务端旧版本）就整体回落本地静态配置，
 *   游戏照常能玩 —— 配置是「运营调优」不是「必需依赖」，不该因为它挡住进入游戏。
 * - **快照只拉一次、对齐几何每次进图都拉**（#513）：
 *   快照十几张表、只跟版本有关，进程内重复拉纯浪费 RTT；
 *   而装备外观几何是「人眼调一版、立刻要看效果」的东西，验收动作就是**退回选角再进图**
 *   （场景重载，JS 上下文不重来）。只拉一次的话，那种重进看不到新位置，
 *   会被当成「保存没生效」—— 33 行的小接口，每次进图拉一次不值得省。
 * - **去重并发**：同一次进图的重复调用共享同一个 Promise。
 *
 * 两个接口**并行**拉：串行会平白多一个 RTT，而这个 RTT 卡在「进游戏」的路径上。
 */

let snapshotLoaded = false;
let snapshotLoading: Promise<void> | null = null;
let alignLoading: Promise<void> | null = null;

/** 拉取并落库配置快照 + 外观几何；失败静默回落本地配置（不抛出，调用方无需 catch） */
export async function loadGameConfig(): Promise<void> {
  await Promise.all([loadSnapshotOnce(), loadAlignEveryEntry()]);
}

/** 外观几何：每次进图都拉（见文件头「为什么它和快照的缓存期不一样」） */
function loadAlignEveryEntry(): Promise<void> {
  if (alignLoading) return alignLoading;
  alignLoading = GameConfigApi.equipAlign({ silent: true })
    .then((rows: EquipAlignList) => {
      // 内部会先把上次覆写的值还原成出厂值，所以「管理端删了行」也能在重进时回到默认
      applyEquipAlignRows(rows.list);
    })
    .catch(() => {
      // 几何失败不致命：按客户端配置里的几何画（也就是「工作台还没调过的样子」）
    })
    .then(() => {
      alignLoading = null;
    }) as Promise<void>;
  return alignLoading;
}

/** 快照拉一次就够（十几张表，只跟服务端版本有关） */
function loadSnapshotOnce(): Promise<void> {
  if (snapshotLoaded) return Promise.resolve();
  if (!snapshotLoading) {
    // target 是 ES2015（Cocos 打包基线），Promise 没有 .finally —— 用 then/catch 两段收尾
    snapshotLoading = GameConfigApi.snapshot({ silent: true })
      .then((snapshot: GameConfigSnapshot) => {
        applyConfigSnapshot(snapshot);
        // 技能与状态覆写的是数据表，而消费者读的是 configs/skill 的 Map ——
        // 不重建就还是旧副本（#367）
        rebuildSkills();
        snapshotLoaded = true;
      })
      .catch(() => {
        // 快照失败不致命：本地 configs 就是同一份数据的 seed 源，先按本地值玩；
        // 下次进图再试（没成功就不置 loaded，否则一次抖动会永久回落本地值）
      })
      .then(() => {
        snapshotLoading = null;
      }) as Promise<void>;
  }
  return snapshotLoading;
}
