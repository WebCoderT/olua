import { GameConfigApi } from "./Api";
import type { EquipAlignList, EquipInAlignList, GameConfigSnapshot } from "./ApiModels";
import { applyConfigSnapshot, applyEquipAlignRows, applyEquipInAlignRows } from "../../../configs/apply-snapshot";
import { checkSnapshotContract, snapshotContractMessage } from "../../../configs/game-config";
import type { SnapshotProblem } from "../../../configs/game-config";
import { rebuildSkills } from "../../../configs/skill";
import { getText } from "../../../configs/texts";

/**
 * 服务端配置快照加载器（#294 / #513 / #523 / #604）
 *
 * 进游戏拉 `gameConfig.snapshot` + `gameConfig.equipAlign` + `gameConfig.equipInAlign`，
 * 把管理端可改的配置覆写进本地 configs（见 configs/apply-snapshot）。设计要点：
 *
 * - **快照是硬依赖，缺了就进不去**（#604）：客户端那几份出厂表随 #603 逐域退场后，
 *   「拉不到就按本地玩」等于「按空表玩」—— 一个空着却看不出来的游戏比一个炸得响的错误难查。
 *   所以 `loadGameConfig()` 返回结果对象，调用方（Loading 场景）拿到 `ok === false` 就**停在
 *   Loading 界面**并显示明确文案 + 重试，不构建 Game 世界。
 * - **失败分类**（不在日志里混为一谈）：
 *   · `network` —— 请求本身没成（服务端没起、断网、401…），下次进图重试；
 *   · `contract` —— 拿到了但缺段 / 形状不对（服务端代码 bug），逐条列出 key 与中文名。
 *   两类都**不置「已加载」**：一次抖动不该永久退化成空表。
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
 * - **几何失败仍然不致命**（#527）：外观 / 内观缺行 = 按装备表里的出厂几何画，
 *   那本来就是「工作台还没调过」的语义（重置 = 删行），所以只 `console.warn`，不挡进游戏。
 *   但也绝不静默 —— 一个 404 会被当成「保存没生效」，日志里必须留证据。
 * - **去重并发**：同一次进图的重复调用共享同一个 Promise。
 *
 * 三个接口**并行**拉：串行会平白多两个 RTT，而这些 RTT 卡在「进游戏」的路径上。
 * 三者的失败互相独立 —— 内观挂了不影响外观，反之亦然（各自 catch 自己的）。
 */

/** 配置加载结果（#604：调用方必须看 `ok`，别再「静默当成功」） */
export interface GameConfigLoadResult {
  ok: boolean;
  /** 失败分类：network = 请求没成；contract = 拿到了但不符合契约 */
  reason?: "network" | "contract";
  /** contract 失败时的逐条问题（key + 中文名 + 原因） */
  problems?: SnapshotProblem[];
  /** 给人看的一句话（Loading 界面与日志共用同一份措辞） */
  message?: string;
}

let snapshotLoaded = false;
let snapshotLoading: Promise<GameConfigLoadResult> | null = null;
let alignLoading: Promise<void> | null = null;
let inAlignLoading: Promise<void> | null = null;

/**
 * 拉取并落库配置快照 + 外观几何 + 内观几何
 *
 * 不抛异常（几何那两路永不失败）；快照成没成看返回值。
 * 调用方在 `ok === false` 时应该**停住**，别继续构建游戏世界。
 */
export async function loadGameConfig(): Promise<GameConfigLoadResult> {
  const results = await Promise.all([loadSnapshotOnce(), loadAlignEveryEntry(), loadInAlignEveryEntry()]);
  return results[0];
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
      // 几何失败不致命：按装备表里的出厂几何画（也就是「工作台还没调过的样子」）。
      // 但同样要出声 —— 404（服务端旧版本）与「保存没生效」长得一模一样（#527）
      console.warn("[config] 外观几何拉取失败，按出厂几何画：", error);
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

/** 拉一次内观几何并覆写本地配置（失败 warn，不抛 —— 兜底是「按出厂几何画」） */
function fetchInAlignGeometry(): Promise<void> {
  return GameConfigApi.equipInAlign({ silent: true })
    .then((rows: EquipInAlignList) => {
      applyEquipInAlignRows(rows.list);
    })
    .catch((error: unknown) => {
      // 内观失败只影响弹窗里的站位，不该拖累进游戏 —— 但要留证据：
      // 少了这一行，「服务端还是旧版本（404）」会表现成「保存没生效」且日志空白（#527）
      console.warn("[config] 内观几何拉取失败，按出厂几何画：", error);
    });
}

/**
 * 快照拉一次就够（十几张表，只跟服务端版本有关）
 *
 * 成功才置 `snapshotLoaded`：失败（网络或契约）下次进图必须重试，
 * 否则一次抖动就永久停在空表上，而玩家只会看到「背包空了」「技能点不出来」。
 */
function loadSnapshotOnce(): Promise<GameConfigLoadResult> {
  if (snapshotLoaded) return Promise.resolve({ ok: true });
  if (!snapshotLoading) {
    // target 是 ES2015（Cocos 打包基线），Promise 没有 .finally —— 用 then/catch 两段收尾
    snapshotLoading = GameConfigApi.snapshot({ silent: true })
      .then((snapshot: GameConfigSnapshot) => applyLoadedSnapshot(snapshot))
      .catch((error: unknown) => networkFailure(error))
      .then((result: GameConfigLoadResult) => {
        snapshotLoading = null;
        if (result.ok) snapshotLoaded = true;
        return result;
      }) as Promise<GameConfigLoadResult>;
  }
  return snapshotLoading;
}

/** 快照到手：先过契约再落库（顺序不能反 —— applyConfigSnapshot 会再校验一次，双保险） */
function applyLoadedSnapshot(snapshot: GameConfigSnapshot): GameConfigLoadResult {
  const problems = checkSnapshotContract(snapshot);
  if (problems.length > 0) {
    // 服务端少发 / 发错段：这是 bug，不是「环境不好」。日志留全量明细，界面给一句话
    const message = getText("config_snapshot_incomplete", { detail: snapshotContractMessage(problems) });
    console.error(`[config] ${message}`, problems);
    return { ok: false, reason: "contract", problems, message };
  }
  try {
    applyConfigSnapshot(snapshot);
  } catch (error) {
    console.error("[config] 配置快照落库失败：", error);
    return { ok: false, reason: "contract", message: getText("config_snapshot_apply_failed", { detail: String((error as Error)?.message ?? error) }) };
  }
  // 技能与状态覆写的是数据表，而消费者读的是 configs/skill 的 Map ——
  // 不重建就还是旧副本（#367）
  rebuildSkills();
  console.log(`[config] 配置快照已落库（${snapshot.skills.length} 技能 / ${snapshot.equipments.length} 基础件 / ${snapshot.levels.length} 级）`);
  return { ok: true };
}

/** 请求本身失败（服务端没起 / 断网 / 令牌失效）：可以重试，不渲染成「配置有 bug」 */
function networkFailure(error: unknown): GameConfigLoadResult {
  const detail = String((error as Error)?.message ?? error ?? "");
  console.warn("[config] 配置快照拉取失败（将在下次进图重试）：", error);
  return {
    ok: false,
    reason: "network",
    message: detail ? getText("config_snapshot_unreachable_detail", { detail }) : getText("config_snapshot_unreachable"),
  };
}
