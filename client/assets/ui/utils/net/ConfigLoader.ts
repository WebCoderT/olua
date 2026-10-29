import { GameConfigApi } from "./Api";
import type { EquipAlignList, EquipInAlignList, GameConfigSnapshot } from "./ApiModels";
import { applyConfigSnapshot, applyEquipAlignRows, applyEquipInAlignRows } from "../../../configs/apply-snapshot";
import { rebuildSkills } from "../../../configs/skill";

/**
 * 服务端配置快照加载器（#294 / #513 / #523）
 *
 * 进游戏拉 `gameConfig.snapshot` + `gameConfig.equipAlign` + `gameConfig.equipInAlign`，
 * 把管理端可改的配置覆写进本地 configs（见 configs/apply-snapshot）。设计要点：
 * - **静默失败**：任何一个拉不到（网络抖动 / 服务端旧版本）就整体回落本地静态配置，
 *   游戏照常能玩 —— 配置是「运营调优」不是「必需依赖」，不该因为它挡住进入游戏。
 * - **快照只拉一次，两套几何每次进图都拉**（#513 / #523）：
 *   快照十几张表、只跟版本有关，进程内重复拉纯浪费 RTT；
 *   而装备外观 / 内观几何是「人眼调一版、立刻要看效果」的东西，验收动作就是**退回选角再进图**
 *   （场景重载，JS 上下文不重来）。只拉一次的话，那种重进看不到新位置，
 *   会被当成「保存没生效」—— 33 行 / 31 行的小接口，每次进图拉一次不值得省。
 * - **内观几何还多一次「开弹窗就拉」**（#527）：外观看的是场景里的角色，重进图必然重画；
 *   而内观只在角色信息弹窗里出现，玩家保存完的第一反应是**再点开弹窗看一眼**，
 *   那时人还在同一张图里、场景没重载 —— 只靠进图拉一次就必然「看不到变化」。
 *   于是 `refreshInAlign()` 在每次开弹窗时再拉一次（1 个请求，几百字节），
 *   代价是「弹窗先按旧值建、拉到新值再重建」（见 RoleInfoDialog.open）。
 * - **失败要出声**（#527）：早先几何失败一律 `catch(() => {})`，于是一个 404
 *   （服务端还是旧版本、没有这个接口）表现成「保存没生效」，而日志里一个字都没有。
 *   现在仍然不挡进游戏，但要 `console.warn` —— 静默跳过等于吞掉证据。
 * - **去重并发**：同一次进图的重复调用共享同一个 Promise。
 *
 * 三个接口**并行**拉：串行会平白多两个 RTT，而这些 RTT 卡在「进游戏」的路径上。
 * 三者的失败互相独立 —— 内观挂了不影响外观，反之亦然（各自 catch 自己的）。
 */

let snapshotLoaded = false;
let snapshotLoading: Promise<void> | null = null;
let alignLoading: Promise<void> | null = null;
let inAlignLoading: Promise<void> | null = null;

/** 拉取并落库配置快照 + 外观几何 + 内观几何；失败静默回落本地配置（不抛出，调用方无需 catch） */
export async function loadGameConfig(): Promise<void> {
  await Promise.all([loadSnapshotOnce(), loadAlignEveryEntry(), loadInAlignEveryEntry()]);
}

/** 外观几何：每次进图都拉（见文件头「为什么它和快照的缓存期不一样」） */
function loadAlignEveryEntry(): Promise<void> {
  if (alignLoading) return alignLoading;
  alignLoading = GameConfigApi.equipAlign({ silent: true })
    .then((rows: EquipAlignList) => {
      // 内部会先把上次覆写的值还原成出厂值，所以「管理端删了行」也能在重进时回到默认
      applyEquipAlignRows(rows.list);
    })
    .catch((error: unknown) => {
      // 几何失败不致命：按客户端配置里的几何画（也就是「工作台还没调过的样子」）。
      // 但同样要出声 —— 404（服务端旧版本）与「保存没生效」长得一模一样（#527）
      console.warn("[config] 外观几何拉取失败，按客户端配置画：", error);
    })
    .then(() => {
      alignLoading = null;
    }) as Promise<void>;
  return alignLoading;
}

/** 内观几何：同样每次进图都拉（理由同上；它是弹窗里的位置，重进游戏才能看到新值） */
function loadInAlignEveryEntry(): Promise<void> {
  if (inAlignLoading) return inAlignLoading;
  inAlignLoading = fetchInAlignGeometry().then(() => {
    inAlignLoading = null;
  }) as Promise<void>;
  return inAlignLoading;
}

/**
 * 只刷内观几何（角色信息弹窗每次打开前调一次，#527）
 *
 * 不复用 `inAlignLoading` 那次去重：那是「同一瞬进图」的合并，这里是**用户动作**要的
 * 新鲜数据，被上一次的 Promise 顶掉就等于没拉。永远发新请求、失败出声、永不抛。
 * @returns 应用完成（成功或失败）后 resolve —— 调用方要在这之后重建内观节点
 */
export function refreshInAlign(): Promise<void> {
  return fetchInAlignGeometry();
}

/** 拉一次内观几何并覆写本地配置（失败 warn，不抛 —— 兜底是「按客户端配置画」） */
function fetchInAlignGeometry(): Promise<void> {
  return GameConfigApi.equipInAlign({ silent: true })
    .then((rows: EquipInAlignList) => {
      applyEquipInAlignRows(rows.list);
    })
    .catch((error: unknown) => {
      // 内观失败只影响弹窗里的站位，不该拖累进游戏 —— 但要留证据：
      // 少了这一行，「服务端还是旧版本（404）」会表现成「保存没生效」且日志空白（#527）
      console.warn("[config] 内观几何拉取失败，按客户端配置画：", error);
    });
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
