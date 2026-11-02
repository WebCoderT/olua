import type { GameConfigSnapshot } from "../ui/utils/net/ApiModels";

/**
 * 配置快照的**显式契约**（#604）
 *
 * ## 为什么要有这个文件
 *
 * #294 时代快照的每一段都是「可选」的：`if (snapshot.skills) {...}` 缺段静默跳过，
 * 客户端继续用内置出厂表。那是**容错设计** —— 代价是客户端里活着一份影子数据：
 * 平时被快照盖住，快照缺段 / 缺行时悄悄顶上，表现为「运营在管理端改了，游戏里没变」，
 * 而且日志里一个字都没有。
 *
 * #603 把出厂数据的书写处逐域搬到服务端之后，客户端那几份影子数据**已经退场**：
 * `configs/` 里相应表是空的，回落 = 回落到空表 = 一个空着却看不出来的游戏。
 * 所以这里改成**显式契约**：段必须存在、形状必须正确，缺了就当场抛错。
 *
 * 判据的分界线（很重要，别把两者混起来）：
 * - **契约破坏**（段缺失 / 不是数组 / 关键段空表）→ 服务端代码有 bug，应该炸在 CI 或登录时，
 *   而不是被客户端兜住 —— 所以这里报错，`ConfigLoader` 把玩家挡在 Loading 界面并给重试；
 * - **合法数据状态**（运营把某张表清空 / 下架全部药品）→ 不是契约问题，`minRows` 只给
 *   那些「空 = 客户端立刻算不出来」的段（等级表、槽位表）留着。
 *
 * ## 与哪些地方联动（改这里的清单要一起过一遍）
 * - `tools/audit-snapshot-contract.cjs`：本清单 == 服务端 `GameConfigSnapshotDto` 的字段
 *   == `client-config.service.snapshot()` 实际返回的键。**这条是「服务端少发一段」的守点**。
 * - `configs/apply-snapshot.ts`：`applyConfigSnapshot` 第一句就调 `checkSnapshotContract`，
 *   校验不过直接抛 —— 所以函数体里不再有「缺段跳过」的分支。
 * - `ui/utils/net/ConfigLoader.ts`：把失败分成 network / contract 两类，都**不置「已加载」**，
 *   下次进图重试（一次抖动不该永久退化成空表）。
 */

/** 段形状：数组表 / 单值对象 */
export type SnapshotSectionKind = "array" | "object";

/** 契约里的一段 */
export interface SnapshotSectionSpec {
  /** 快照字段名（= 服务端 DTO 属性名 = `apply*` 消费的键） */
  key: keyof GameConfigSnapshot;
  /** 中文名（报错时给人看，别让玩家对着 `monsterPresentations` 猜） */
  label: string;
  /** 数组表还是单值对象 */
  kind: SnapshotSectionKind;
  /** 至少几行/几个键（缺省 0 = 允许空表）。**只给「空 = 客户端立刻算不出来」的段** */
  minRows?: number;
}

/**
 * 契约清单（**唯一书写处**）
 *
 * 顺序与 `server/src/modules/game-config/client-config.service.ts` 的返回顺序一致，
 * 便于两边对读；`tools/audit-snapshot-contract.cjs` 按下面的字面量形式解析，
 * 加段时保持「一段一行、key/label/kind 按此顺序」。
 */
export const SNAPSHOT_SECTIONS: SnapshotSectionSpec[] = [
  { key: "titles", label: "称号配置", kind: "array" },
  { key: "souls", label: "战魂配置", kind: "array" },
  { key: "ranks", label: "军衔配置", kind: "array" },
  { key: "equipments", label: "装备基础件", kind: "array" },
  { key: "drugs", label: "药品配置", kind: "array" },
  { key: "items", label: "物品与材料", kind: "array" },
  { key: "monsters", label: "怪物基础数据", kind: "array" },
  { key: "monsterPresentations", label: "怪物资源与表现", kind: "array" },
  { key: "npcs", label: "NPC 数据", kind: "array" },
  { key: "fashions", label: "时装配置", kind: "array" },
  { key: "levels", label: "等级表", kind: "array", minRows: 1 },
  { key: "growthScalars", label: "成长标量", kind: "array" },
  { key: "combatWeights", label: "战斗力权重", kind: "object" },
  { key: "mallPrices", label: "商城定价", kind: "array" },
  { key: "mallSettings", label: "商城统一价", kind: "object" },
  // 下面三段客户端**不消费**（掉落结算在服务端、成就进度走 /achievements/me），
  // 但照样列进契约：它们少发说明 `snapshot()` 的 return 被人动过 ——
  // 那是「所有段都可能缺」的早期信号，比事后追某一段为什么没到便宜得多。
  { key: "dropTables", label: "具名掉落表", kind: "array" },
  { key: "monsterDrops", label: "每怪掉落配置", kind: "array" },
  { key: "skills", label: "技能配置", kind: "array" },
  { key: "statuses", label: "状态配置", kind: "array" },
  { key: "quests", label: "任务配置", kind: "array" },
  { key: "achievements", label: "成就配置", kind: "array" },
  { key: "maps", label: "地图玩法配置", kind: "array" },
  { key: "mapTypes", label: "地图类型分组", kind: "array" },
  { key: "uiEffects", label: "界面特效参数", kind: "array" },
  { key: "equipmentSlots", label: "装备槽位表", kind: "array", minRows: 1 },
  { key: "equipmentMeta", label: "装备规则", kind: "object" },
];

/** 一处契约问题（key + 中文名 + 原因，直接拼进日志与界面） */
export interface SnapshotProblem {
  key: string;
  label: string;
  reason: string;
}

/**
 * 校验快照是否符合契约，返回**全部**问题（空数组 = 通过）
 *
 * 一次列全而不是遇到第一个就抛：服务端漏发往往是「某次改动把 return 里几行一起删了」，
 * 只报第一条会让人改一轮跑一轮。
 */
export function checkSnapshotContract(snapshot: unknown): SnapshotProblem[] {
  const problems: SnapshotProblem[] = [];
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return [{ key: "snapshot", label: "配置快照", reason: `不是一个对象（拿到的是 ${describeValue(snapshot)}）` }];
  }
  const source = snapshot as Record<string, unknown>;
  for (const spec of SNAPSHOT_SECTIONS) {
    const raw = source[spec.key as string];
    if (raw === undefined || raw === null) {
      problems.push({ key: spec.key as string, label: spec.label, reason: "整段缺失" });
      continue;
    }
    if (spec.kind === "array") {
      if (!Array.isArray(raw)) {
        problems.push({ key: spec.key as string, label: spec.label, reason: `应该是数组，拿到的是 ${describeValue(raw)}` });
        continue;
      }
      if (spec.minRows && raw.length < spec.minRows) {
        problems.push({ key: spec.key as string, label: spec.label, reason: `至少要有 ${spec.minRows} 行，实际 ${raw.length} 行` });
      }
      continue;
    }
    if (Array.isArray(raw) || typeof raw !== "object") {
      problems.push({ key: spec.key as string, label: spec.label, reason: `应该是对象，拿到的是 ${describeValue(raw)}` });
      continue;
    }
    // 单值对象目前只有两段，各自的形状要求写在这里（比泛型写法好读）
    if (spec.key === "equipmentMeta") collectEquipmentMetaProblems(raw as Record<string, unknown>, problems);
    if (spec.key === "mallSettings") {
      if (typeof (raw as Record<string, unknown>).defaultPrice !== "number") {
        problems.push({ key: "mallSettings", label: spec.label, reason: "缺少 defaultPrice（统一价），商城会算不出价" });
      }
    }
  }
  return problems;
}

/**
 * 装备规则的形状检查（#603 第九域踩过的坑）
 *
 * 倍率数组是**展开档数**的依据：空了客户端一件变体都展开不出来，装备表整个是空的，
 * 而且不报错 —— 正是「必须由契约拦住」的那一类。文案数组必须与倍率同长，
 * 否则某一档的品质名会取到 undefined（背包里显示成空字符串）。
 */
function collectEquipmentMetaProblems(meta: Record<string, unknown>, problems: SnapshotProblem[]): void {
  const pairs: Array<[string, string]> = [
    ["prefixRates", "prefixLabels"],
    ["suffixRates", "suffixLabels"],
  ];
  for (const [ratesKey, labelsKey] of pairs) {
    const rates = meta[ratesKey] as unknown;
    const labels = meta[labelsKey] as unknown;
    if (!Array.isArray(rates) || rates.length === 0) {
      problems.push({ key: "equipmentMeta", label: "装备规则", reason: `${ratesKey} 为空（倍率决定展开档数，空了一件变体都出不来）` });
      continue;
    }
    // 落库时 <= 0 的倍率会被 filter 掉（见 growth.applyEquipmentRules）——
    // 全 0 的倍率数组在契约层看着「有值」，落完却仍是空表，属于同一类静默失败
    if (rates.some((rate) => typeof rate !== "number" || !(rate > 0))) {
      problems.push({ key: "equipmentMeta", label: "装备规则", reason: `${ratesKey} 里有非正数（落库时会被滤掉，变成空倍率）` });
      continue;
    }
    if (!Array.isArray(labels) || labels.length !== rates.length) {
      problems.push({
        key: "equipmentMeta",
        label: "装备规则",
        reason: `${labelsKey} 与 ${ratesKey} 长度不一致（${Array.isArray(labels) ? labels.length : "非数组"} vs ${rates.length}）`,
      });
    }
  }
  if (!Array.isArray(meta.recycleCurve) || meta.recycleCurve.length === 0) {
    problems.push({ key: "equipmentMeta", label: "装备规则", reason: "recycleCurve 为空（回收价算不出来）" });
  }
}

/** 值的人话描述（报错用：区分 undefined / null / 字符串 / 数字） */
function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `数组(${value.length})`;
  return typeof value;
}

/**
 * 把问题拼成一行行可读文本（日志与界面共用同一份措辞）
 *
 * 每行形如 `缺少「技能配置」（skills）：整段缺失` —— 报错里带 key 与中文名两样，
 * 服务端开发按 key 找代码、运营 / 玩家按中文名知道是哪块内容。
 */
export function snapshotContractMessage(problems: SnapshotProblem[]): string {
  if (problems.length === 0) return "";
  return problems
    .map((problem) => `${problem.reason === "整段缺失" ? "缺少" : "异常"}「${problem.label}」（${problem.key}）：${problem.reason}`)
    .join("；");
}
