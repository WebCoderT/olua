/**
 * 背包与穿戴的服务端算子（#556）
 *
 * ===========================================================================
 * 这一份是什么
 * ===========================================================================
 * `bag` / `equipments` 从 #556 起进服务端权威清单（见 `role-authority.ts`），
 * 于是客户端那 5 个本地背包操作（穿戴 / 卸下 / 丢弃 / 整理 / 搬运）必须换成接口
 * `POST /roles/:id/bag-op`。这个文件是那个接口的**算子层**：
 *
 * | 操作 | 归属 | 为什么 |
 * |---|---|---|
 * | 穿戴 / 卸下 | 服务端**自己算** | 决定战斗数值（属性由 `equipments` 重算），且必须先证明「这件东西真在包里」 |
 * | 丢弃 | 服务端**自己算** | 销毁物品，客户端给什么「结果」都不该被采信 |
 * | 整理 / 搬运 | 客户端给排布，服务端**只验守恒** | 纯排列、不创造价值；复刻一遍 move/merge/swap 只会让两端慢慢漂开 |
 *
 * 守恒判据只有两条，且都只看「值」不看「顺序」：**网格形状不变**、
 * **同 id + 同绑定状态的总件数不变**（#789 起把绑定算进分组，见 `bagGroupKeyOf`）。
 * 搬运合并、交换、整理重排全都满足这两条；少一件、多一件、或者把绑定堆与未绑定堆
 * 互换成另一堆的数量，必然违反其中一条。
 *
 * 本文件是纯函数（不碰数据库、不读配置表）：装备槽位与等级门槛由调用方以回调传入，
 * 于是它可以在单测里直接跑，也免得这里再长出一份「哪些 id 是装备」的知识。
 */

import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";

/** 掉落溯源里两项文字的最大长度（防改包塞几 KB 的字符串进存档） */
export const BAG_ORIGIN_TEXT_MAX = 64;

/**
 * 掉落溯源（只有装备会有，见 `BagCell.from`）
 *
 * 记的是「掉落**当时**的事实」，所以角色改名 / 怪物改配置都不会追改这里 ——
 * 玩家在详情弹窗里看到的是「这件东西是我打那只怪掉的」，不是「现在的说法」。
 */
export interface BagOrigin {
  /** 击杀者角色名（掉落那一刻的名字） */
  role?: string;
  /** 怪物 key（客户端用怪物配置翻成中文名；服务端不存中文，改名即时生效） */
  monster?: string;
  /** 掉落时间（毫秒时间戳） */
  at?: number;
}

/** 有内容的格子（`BagCell` 去掉 null） */
export type FilledBagCell = Exclude<BagCell, null>;

/**
 * 一个背包格子：`null` = 空格（与客户端存档同形状）
 *
 * #789 起多两个**服务端写、客户端只读**的可选字段：
 * - `bound`：**绑定角色**（不可交易）。掉落时按「物品强制绑定 / 怪物掉落强制绑定 /
 *   随机」三选一判定后写进格子，从此跟着这一堆走；缺省 = 未绑定。
 * - `from`：**溯源**，只有装备会有（用户口径：「只有装备会溯源，其他物品只根据是否绑定
 *   分为两个」）。堆叠物品没有「这一件是谁掉的」的概念，所以不写。
 *
 * 为什么放在格子上而不是一张「物品实例表」：掉落链路本来就是纯引用（掉落表只有
 * `goodId/count`，没有实例 id）。要让绑定与来源跟着**这一堆**走，最省的做法就是长在
 * 格子上 —— 搬运 / 整理时它跟着格子换位置，服务端 `reconcileBagCells` 负责挂回来。
 */
export type BagCell = { id: string; count: number; bound?: boolean; from?: BagOrigin } | null;

/** 背包网格（二维，行优先） */
export type BagGrid = BagCell[][];

/** 装备槽位表：槽位 → 那件装备（`null` = 该槽位空着） */
export type WornEquipments = Record<string, WornItem | null>;

/**
 * 一件穿在身上的装备（#816：槽位不再只存裸 id）
 *
 * 为什么要带元数据：属性重算要的是 id，但**绑定与溯源是这件东西的属性**，不是「背包格子
 * 的属性」。槽位只存 id 时，穿上去那一刻 `bound` / `from` 就丢了 —— 脱下来变成一件未绑定、
 * 无溯源的新东西，绑定语义整体失效（五瓶绑定药用到剩一瓶就变可交易，是同一个病的背包版）。
 *
 * 字段口径与 `BagCell` 完全一致（同一个 `BagOrigin`、同样缺省即未绑定），因为穿脱就是
 * 「背包格子 ↔ 槽位」之间搬运：搬运不许改值，只许换地方。
 */
export interface WornItem {
  id: string;
  /** 绑定角色（缺省 = 未绑定）；穿上去按格子里的值搬，脱下来原样带回格子 */
  bound?: boolean;
  /** 掉落溯源（只有装备会有，同 `BagOrigin`） */
  from?: BagOrigin;
}

/** 槽位里的装备 id（空槽 / 形状不对 → null），读属性与展示的统一入口 */
export function wornIdOf(entry: WornItem | null | undefined): string | null {
  if (!entry || typeof entry.id !== "string") return null;
  const id = entry.id.trim();
  return id ? id : null;
}

/**
 * 读背包网格（存档里那一份）
 *
 * 结构不合法直接拒：调用方都是「要动这份数据」的路径，拿一个半坏的对象继续算，
 * 只会把坏数据写到更远的地方（与 `parseStoredRoleData` 对编辑路径不容忍同一理由）。
 * 单格只认 `{ id, count }` 两个**必有**字段，多出来的字段不管（客户端可能带调试字段）；
 * 唯独 `bound` / `from` 例外 —— 它们是服务端自己写进去的元数据，读档要带出来，
 * 否则每次整理 / 搬运都会把绑定丢掉（绑定的意义就是「丢了就再也拿不回来」）。
 */
export function readBagGrid(raw: unknown, label = "背包"): BagGrid {
  if (!Array.isArray(raw)) throw invalid(`${label}数据不完整，无法操作`);
  return raw.map((line) => {
    if (!Array.isArray(line)) throw invalid(`${label}数据不完整，无法操作`);
    return line.map((cell) => {
      if (cell === null || cell === undefined) return null;
      if (typeof cell !== "object") throw invalid(`${label}里有无法识别的格子`);
      const record = cell as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id) throw invalid(`${label}里有无法识别的格子`);
      const count = Math.max(1, Math.floor(Number(record.count) || 1));
      const result: FilledBagCell = { id, count };
      // 只有明确 true 才算绑定：坏值（"1" / 1 / {}）一律当未绑定，不让脏数据变出「不可交易」
      if (record.bound === true) result.bound = true;
      const from = readBagOrigin(record.from);
      if (from) result.from = from;
      return result;
    });
  });
}

/**
 * 读溯源字段（结构不对就当没有）
 *
 * **不抛异常**：溯源是展示字段，坏掉最多是详情弹窗少一行，不该让整份背包读不出来
 * （与 `id`/`count` 的严格口径相反 —— 那两个是业务字段，坏了继续算会出事）。
 * 文字截断到 `BAG_ORIGIN_TEXT_MAX`，时间戳必须为正值。
 */
export function readBagOrigin(raw: unknown): BagOrigin | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const origin: BagOrigin = {};
  for (const key of ["role", "monster"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) origin[key] = value.trim().slice(0, BAG_ORIGIN_TEXT_MAX);
  }
  const at = Math.floor(Number(record.at) || 0);
  if (at > 0) origin.at = at;
  return origin.role || origin.monster || origin.at ? origin : null;
}


/**
 * 读装备槽位表（缺字段 / 不是对象 → 空表，老存档的边角按「什么都没穿」处理）
 *
 * 只认 `{ id, ... }` 的新形状；**唯一例外是裸字符串**（v3 迁移之前的老档）——
 * 那不是「兼容层」，是防呆：迁移漏跑的路径上把它当空槽，等于把玩家身上的装备吃掉。
 * 这里收下它并转成 `{ id }`，迁移（`role-migration.ts` 的 v2→v3）之后不会再产生这种形状。
 */
export function readWornEquipments(raw: unknown): WornEquipments {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: WornEquipments = {};
  for (const [slot, value] of Object.entries(raw as Record<string, unknown>)) {
    // 老档（v3 之前）：裸 id
    if (typeof value === "string") {
      const id = value.trim();
      result[slot] = id ? { id } : null;
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      result[slot] = null;
      continue;
    }
    const record = value as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      result[slot] = null;
      continue;
    }
    const item: WornItem = { id };
    // 只认 `true`：写 0 / "1" / 乱七八糟的真值一律当未绑定（宁可少绑，不凭空锁死玩家的东西）
    if (record.bound === true) item.bound = true;
    const from = readBagOrigin(record.from);
    if (from) item.from = from;
    result[slot] = item;
  }
  return result;
}

/** 取某格（越界 / 空格 → null） */
export function cellAt(grid: BagGrid, row: unknown, col: unknown): BagCell {
  const r = Number(row);
  const c = Number(col);
  if (!Number.isInteger(r) || !Number.isInteger(c)) return null;
  const line = grid[r];
  if (!line || c < 0 || c >= line.length) return null;
  return line[c] ?? null;
}

/** 找第一个空格（行优先；没空格返回 null） */
export function firstEmptyCell(grid: BagGrid): { row: number; col: number } | null {
  for (let row = 0; row < grid.length; row++) {
    const line = grid[row];
    for (let col = 0; col < line.length; col++) {
      if (!line[col]) return { row, col };
    }
  }
  return null;
}

/** 是否为绑定格（`null` / 未写 `bound` 都算未绑定） */
export function isBoundCell(cell: BagCell): boolean {
  return !!cell && cell.bound === true;
}

/**
 * 守恒分组键：**同 id 且同绑定状态**才算同一种东西
 *
 * #789 起把 `bound` 算进来，是因为「整理背包时把绑定堆与未绑定堆互换」是白拿绑定/
 * 白解绑定的口子（未绑定的那堆被标成绑定 = 玩家亏，绑定的那堆被标成未绑定 = 经济漏洞）。
 * 两堆各自的数量必须原样保留，互换就是在数量上对不上。
 *
 * 键里用 `1|` / `0|` 前缀而不是 `id|bool`：id 是用户可控的字符串，放前面怕撞。
 */
export function bagGroupKeyOf(id: string, bound: boolean): string {
  return `${bound ? "1" : "0"}|${id}`;
}

/** 背包内容指纹：**（绑定状态, 物品 id）** → 总件数（不看位置，空格不参与） */
export function bagContentOf(grid: BagGrid): Map<string, number> {
  const content = new Map<string, number>();
  for (const line of grid) {
    for (const cell of line) {
      if (!cell) continue;
      const key = bagGroupKeyOf(cell.id, cell.bound === true);
      content.set(key, (content.get(key) ?? 0) + cell.count);
    }
  }
  return content;
}

/** 两副网格的**内容**是否一致（只看分组键与总件数，不看顺序） */
export function sameBagContent(a: BagGrid, b: BagGrid): boolean {
  const left = bagContentOf(a);
  const right = bagContentOf(b);
  if (left.size !== right.size) return false;
  for (const [key, count] of left) {
    if (right.get(key) !== count) return false;
  }
  return true;
}

/** 两副网格的**形状**是否一致（行数与每行列数） */
export function sameGridShape(a: BagGrid, b: BagGrid): boolean {
  if (a.length !== b.length) return false;
  for (let row = 0; row < a.length; row++) {
    if (a[row].length !== b[row].length) return false;
  }
  return true;
}

/**
 * 找第一个超过单格叠加上限的格子（没有返回 null）
 *
 * #842：move / tidy 只验「同 id + 同绑定态的总件数守恒」，把 10 格 99 件报成一格 999 件
 * 也守恒 —— `maxStack` 不变式（后续所有堆叠逻辑的地基）就是从这儿破的。上报排布落定后
 * 用它扫一遍，`maxStackOf` 由调用方注入（本文件是纯函数，不读配置表）。
 *
 * 装备格 `count > 1` 走的也是这条检查（`resolveMaxStack` 对装备恒 1，#837 口径
 * 「装备在任何情况下都不允许重叠」）—— 一次扫描同时守住两个不变式。
 */
export function findOverstackedCell(
  grid: BagGrid,
  maxStackOf: (id: string) => number,
): { row: number; col: number; id: string; count: number; max: number } | null {
  for (let row = 0; row < grid.length; row++) {
    const line = grid[row];
    for (let col = 0; col < line.length; col++) {
      const cell = line[col];
      if (!cell) continue;
      const max = Math.max(1, Math.floor(maxStackOf(cell.id) || 1));
      if (cell.count > max) return { row, col, id: cell.id, count: cell.count, max };
    }
  }
  return null;
}

/** 溯源指纹（用于「搬动之后认领回原来那一件」） */
function originKeyOf(from: BagOrigin | undefined): string {
  if (!from) return "";
  return `${from.role ?? ""}\u0001${from.monster ?? ""}\u0001${from.at ?? 0}`;
}

/** 旧网格里一个 id 的两个桶：绑定的、未绑定的（同 id 且同绑定状态才算「同一堆」） */
interface BagBucket {
  bound: FilledBagCell[];
  loose: FilledBagCell[];
}

/** 一堆格子的总件数 */
function countOf(cells: readonly FilledBagCell[]): number {
  let total = 0;
  for (const cell of cells) total += cell.count;
  return total;
}

/**
 * 在若干格子里挑一批，使件数之和**正好**等于 `target`（挑不到返回 `null`）
 *
 * 这是「客户端只报格子、绑定由服务端认领」里唯一的数学：重排会改变**每格**的件数
 * （合并两堆、把一堆拆成两格），但**每个桶的总件数是守恒的**——守恒判据本身就建立在
 * 这一点上。所以只要找得到「和为旧桶件数」的那一批格子，就说明它是一次合法重排。
 *
 * 挑不到就说明客户端把两个桶（绑定 + 未绑定）报成了一格（例如 2 件绑定 + 4 件未绑定
 * 报成 6 件），调用方随即放弃标记，让 `sameBagContent` 把它拒掉（20022）。
 *
 * 深搜 + 记忆化：同一 id 的格子最多几十个，件数最大几百，状态量是 `格子数 × 件数`。
 */
function pickSubset(cells: readonly FilledBagCell[], target: number): boolean[] | null {
  const memo = new Map<string, boolean>();
  const walk = (index: number, remain: number): boolean => {
    if (remain === 0) return true;
    if (index >= cells.length || remain < 0) return false;
    const key = `${index}|${remain}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const ok = walk(index + 1, remain - cells[index].count) || walk(index + 1, remain);
    memo.set(key, ok);
    return ok;
  };
  if (!walk(0, target)) return null;
  const picked: boolean[] = [];
  let remain = target;
  for (let index = 0; index < cells.length; index++) {
    const take = remain > 0 && cells[index].count <= remain && walk(index + 1, remain - cells[index].count);
    picked.push(take);
    if (take) remain -= cells[index].count;
  }
  return remain === 0 ? picked : null;
}

/**
 * 把**客户端给的排布**对回**库里的旧网格**，把绑定与溯源挂回去（#789 的核心一步）
 *
 * 为什么不能直接采信客户端带回来的 `bound` / `from`：
 * - `bound` 决定能不能交易 —— 客户端说「这件其实没绑定」，服务端就白送了一个可交易品；
 * - `from` 是「谁掉的」的展示 —— 伪造一个「GM 掉的」虽然不产生数值收益，但很脏。
 *
 * 所以口径是：**客户端只负责「谁在哪个格子」，元数据一律从服务端的旧网格里认领**。
 * 而 `bag-op` 的格子契约（`BagOpCellDto`）里只有 `row/col/id/count`，连 `bound` 都没有，
 * 于是「这一格该不该绑定」只能**推**出来：
 *
 * 1. 旧网格按 id 分两个桶（绑定 / 未绑定），各桶**总件数**是不变量；
 * 2. 新网格按 id 归堆，若该 id 只有一个桶 → 整堆照抄那个桶的状态（最省事的多数情形）；
 * 3. 两个桶都有货时，用 `pickSubset` 找「件数之和 = 绑定桶件数」的那一批新格子，
 *    挑不出来（把两桶报成一格）就整堆留未绑定，交给 `sameBagContent` 拒掉；
 * 4. 同样的和可能有多种派法（两堆各 1 件、位置全变），此时按**位置线索**择优：
 *    落在「旧绑定格原址」的最高优先，落在空格（说明是刚被搬过来的）次之，
 *    落在「旧未绑定格原址」的最低——玩家拖走一堆之后，被拖走的那堆通常才是原来绑定的那堆。
 * 5. 最后逐格认领 `from`：优先原位那一件，其次溯源一致的那一件，再次桶里任意一件；
 *    桶被拆成比旧格子更多的格数时认领不到，那就只保留推出的 `bound`、不编来源。
 *
 * 跨桶（绑定 ↔ 未绑定）合并会在第 3 步被 `sameBagContent` 拒掉 —— 能走到第 5 步的排布，
 * 每个桶的件数都对得上，所以「认领」不会出现「桶里有 5 件却要认领 10 件」的矛盾。
 */
export function reconcileBagCells(previous: BagGrid, next: BagGrid): BagGrid {
  // —— 1. 旧网格分桶 + 记下每个 id 的绑定格位置 ——
  const buckets = new Map<string, BagBucket>();
  const boundPositions = new Map<string, Set<string>>();
  const previousAt = new Map<string, FilledBagCell | null>();
  previous.forEach((line, row) =>
    line.forEach((cell, col) => {
      previousAt.set(`${row},${col}`, cell ?? null);
      if (!cell) return;
      let bucket = buckets.get(cell.id);
      if (!bucket) {
        bucket = { bound: [], loose: [] };
        buckets.set(cell.id, bucket);
      }
      if (cell.bound === true) {
        bucket.bound.push(cell);
        const positions = boundPositions.get(cell.id) ?? new Set<string>();
        positions.add(`${row},${col}`);
        boundPositions.set(cell.id, positions);
      } else {
        bucket.loose.push(cell);
      }
    }),
  );

  // —— 2. 新网格按 id 归堆（保留原始位置，判定结果按位置回填）——
  const nextById = new Map<string, Array<{ cell: FilledBagCell; row: number; col: number }>>();
  next.forEach((line, row) =>
    line.forEach((cell, col) => {
      if (!cell) return;
      const list = nextById.get(cell.id);
      if (list) list.push({ cell, row, col });
      else nextById.set(cell.id, [{ cell, row, col }]);
    }),
  );

  // —— 3 & 4. 每个 id 定一遍「哪些新格子算绑定的」 ——
  /** 位置 → 是否绑定（没写 = 判不出来，按未绑定处理，守恒会拒） */
  const boundAt = new Map<string, boolean>();
  for (const [id, list] of nextById) {
    const bucket = buckets.get(id);
    const nextTotal = countOf(list.map((item) => item.cell));
    const boundTotal = bucket ? countOf(bucket.bound) : 0;
    const looseTotal = bucket ? countOf(bucket.loose) : 0;
    // 件数对不上（凭空多了 / 少了东西，或 id 是客户端编的）→ 不做标记，交给守恒判据拒
    if (!bucket || nextTotal !== boundTotal + looseTotal) continue;
    if (looseTotal === 0) {
      for (const item of list) boundAt.set(`${item.row},${item.col}`, true);
      continue;
    }
    if (boundTotal === 0) continue;
    const positions = boundPositions.get(id) ?? new Set<string>();
    const scoreOf = (item: { row: number; col: number }): number => {
      const key = `${item.row},${item.col}`;
      if (positions.has(key)) return 2;
      const previousCell = previousAt.get(key);
      return previousCell && previousCell.id === id ? 0 : 1;
    };
    const ordered = list
      .slice()
      .sort((a, b) => scoreOf(b) - scoreOf(a) || b.cell.count - a.cell.count);
    const picked = pickSubset(
      ordered.map((item) => item.cell),
      boundTotal,
    );
    // 挑不出来 = 客户端把两个桶报成了一格 → 整堆留未绑定，`sameBagContent` 会拒
    if (!picked) continue;
    ordered.forEach((item, index) => {
      if (picked[index]) boundAt.set(`${item.row},${item.col}`, true);
    });
  }

  // —— 5. 逐格认领旧网格里的溯源 ——
  const claimed = new Set<FilledBagCell>();
  const claim = (id: string, bound: boolean, row: number, col: number, from?: BagOrigin): FilledBagCell | null => {
    const bucket = buckets.get(id);
    if (!bucket) return null;
    const pool = bound ? bucket.bound : bucket.loose;
    const take = (match: (cell: FilledBagCell) => boolean): FilledBagCell | null => {
      for (const cell of pool) {
        if (claimed.has(cell) || !match(cell)) continue;
        claimed.add(cell);
        return cell;
      }
      return null;
    };
    // ① 原位那一件（没动过）② 溯源一致的那一件（装备被搬到别处）③ 桶里任意一件
    const samePlace = previousAt.get(`${row},${col}`);
    if (samePlace && samePlace.id === id && (samePlace.bound === true) === bound && !claimed.has(samePlace)) {
      claimed.add(samePlace);
      return samePlace;
    }
    if (from) {
      const want = originKeyOf(from);
      const byOrigin = take((cell) => originKeyOf(cell.from) === want);
      if (byOrigin) return byOrigin;
    }
    return take(() => true);
  };

  return next.map((line, row) =>
    line.map((cell, col) => {
      if (!cell) return null;
      const bound = boundAt.get(`${row},${col}`) === true;
      const source = claim(cell.id, bound, row, col, cell.from);
      const result: FilledBagCell = { id: cell.id, count: cell.count };
      // 绑定态来自上面的推断，**不依赖**有没有认领到旧格子（拆堆时第二格认领不到）
      if (bound) result.bound = true;
      if (source && source.from) result.from = source.from;
      return result;
    }),
  );
}

/**
 * 穿戴：把格子里的装备挪到槽位，原来穿着的放回**刚腾出来的那一格**
 *
 * 格数守恒（换装不会凭空多/少一件）。
 * 调用方负责先校验「这一格里的东西真的是这个槽位的装备、且等级够」。
 *
 * **元数据跟着这件东西走**（#816）：穿上去把格子里的 `bound` / `from` 搬进槽位，换下来的
 * 那件把槽位里的元数据搬回格子 —— 搬运只换地方，不改值。之前槽位只存裸 id，这两项在穿脱
 * 之间被清掉，等于「穿一次就洗白」（绑定件变可交易、溯源丢失）。
 *
 * **装备堆叠格就地拆散**（#837，口径「装备在任何情况下都不允许重叠」）：一格多件装备只可能
 * 是改包或史前老档造出来的脏数据 —— 正常写路径（拾取 / 购买 / 发奖 / 搬运校验）都保证装备
 * 一格一件。穿戴是玩家唯一的自愈路径：穿走一件，换下来的旧装备占原格，**剩下的逐件拆进
 * 空格**；空格不够就整步失败（20012，调用方不落库，背包原样）—— 绝不把「装备叠在一格」
 * 的状态写回存档，操作成功后背包必然满足不变式。
 *
 * @returns 被换下来的旧装备 id（没有就是 null，仅用于日志 / 提示）
 */
export function equipAt(
  grid: BagGrid,
  equipments: WornEquipments,
  row: number,
  col: number,
  slot: string,
): string | null {
  const cell = grid[row]?.[col];
  if (!cell) throw invalid("这一格没有可以穿戴的装备");
  const worn = equipments[slot] ?? null;
  const wornId = wornIdOf(worn);
  // 这堆装备的公共元数据（同一格里每一件都一样）：拆散成单件时原样跟着走
  const meta: { bound?: true; from?: BagOrigin } = {};
  if (cell.bound === true) meta.bound = true;
  if (cell.from) meta.from = cell.from;
  // 穿走一件进槽位，剩余的从堆里拆出来
  const pieces: WornItem[] = Array.from({ length: Math.max(1, Math.floor(cell.count)) }, () => ({
    id: cell.id,
    ...meta,
  }));
  const head = pieces.shift() as WornItem;
  grid[row][col] = worn && wornId ? toBagCell(worn) : null;
  // 剩余件 + 原格已被旧装备占着 → 每件找一个空格；找不到 = 背包放不下，整步失败
  for (const piece of pieces) {
    const target = firstEmptyCell(grid);
    if (!target) throw BizException.conflict(BizCode.MALL_BAG_FULL, "背包已满，无法拆开这堆装备");
    grid[target.row][target.col] = toBagCell(piece);
  }
  equipments[slot] = head;
  return wornId;
}

/**
 * 卸下：槽位里的装备放进第一个空格
 *
 * 背包满时抛 `MALL_BAG_FULL`（20012）—— 与商城购买、拾取同一套「背包装不下」的码，
 * 客户端只认一个码就能弹出同一条提示。
 * @returns 落点（客户端不必自己再找一遍空格）
 */
export function unequipSlot(
  grid: BagGrid,
  equipments: WornEquipments,
  slot: string,
): { equipmentId: string; row: number; col: number } {
  const worn = equipments[slot] ?? null;
  const equipmentId = wornIdOf(worn);
  if (!worn || !equipmentId) throw invalid("这个槽位是空的，没有可脱下的装备");
  const target = firstEmptyCell(grid);
  if (!target) throw BizException.conflict(BizCode.MALL_BAG_FULL, "背包已满，无法脱下装备");
  grid[target.row][target.col] = toBagCell(worn);
  equipments[slot] = null;
  return { equipmentId, row: target.row, col: target.col };
}

/** 槽位里的一件 → 背包格子（元数据原样搬，数量恒 1：装备不可堆叠） */
function toBagCell(item: WornItem): FilledBagCell {
  const cell: FilledBagCell = { id: item.id, count: 1 };
  if (item.bound === true) cell.bound = true;
  if (item.from) cell.from = item.from;
  return cell;
}

/** 丢弃：整格置空（不返还任何东西） */
export function discardAt(grid: BagGrid, row: number, col: number): { id: string; count: number } {
  const cell = grid[row]?.[col];
  if (!cell) throw invalid("这一格没有可丢弃的物品");
  grid[row][col] = null;
  return { id: cell.id, count: cell.count };
}

/**
 * 只保留「槽位与物品对得上、且同一件只穿一次」的装备
 *
 * 为什么需要：属性重算是**遍历 `equipments` 的所有值**累加的（`collectEquipmentBundles`），
 * 不看键。于是把同一件顶级武器同时写进 5 个槽位，就能把它的属性算 5 遍 ——
 * 改包即可刷战力。收权之后 `equipments` 由本文件的算子写，正常不会出现，
 * 但**老存档**（服务端接管之前上传的）没有经过这层校验，所以读档时统一过一遍。
 *
 * 三条处置口径（宁可留着也不算错，但绝不放过「多算一遍」）：
 * - **认不出的 id 原样保留**：那多半是客户端配置比服务端快照新，删掉等于把玩家的装备吃了
 *   （属性汇总自己会跳过认不出的 id，并记进 notes）；
 * - **部位不符**：能挪到真正的槽位就挪（目标空着才挪），挪不过去才算脏数据；
 * - **同一件出现两次**：留第一个，其余丢掉 —— 只有改包能造出这种情况。
 *
 * @param slotOf id → 槽位（不是装备返回 null）
 * @returns 清理后的表 + 被丢掉的那些（调用方打日志；玩家侧不提示，属于数据修复）
 */
export function sanitizeEquipments(
  equipments: WornEquipments,
  slotOf: (id: string) => string | null,
): { equipments: WornEquipments; dropped: Array<{ slot: string; id: string; reason: string }> } {
  const cleaned: WornEquipments = {};
  const dropped: Array<{ slot: string; id: string; reason: string }> = [];
  const worn = new Set<string>();
  const take = (slot: string, item: WornItem): boolean => {
    if (worn.has(item.id) || cleaned[slot]) return false;
    worn.add(item.id);
    cleaned[slot] = item;
    return true;
  };
  for (const [slot, item] of Object.entries(equipments)) {
    // 空槽 / 形状不对（`{}` 没有 id）统一按空槽写回，别把半截对象留在存档里
    const id = wornIdOf(item);
    if (!item || !id) {
      cleaned[slot] = null;
      continue;
    }
    if (worn.has(id)) {
      dropped.push({ slot, id, reason: "同一件被穿在多个槽位" });
      continue;
    }
    const actual = slotOf(id);
    // 认不出的 id：服务端快照里没有这件装备，判断不了部位，原样留着（连同元数据）
    if (!actual) {
      if (take(slot, item)) continue;
      dropped.push({ slot, id, reason: "槽位已被占用" });
      continue;
    }
    if (actual === slot) {
      if (take(slot, item)) continue;
      dropped.push({ slot, id, reason: "槽位已被占用" });
      continue;
    }
    // 部位不符：挪到真正的槽位（空着才挪），挪不过去就是脏数据
    if (take(actual, item)) continue;
    dropped.push({ slot, id, reason: `部位不符（实际是 ${actual}，该槽位已被占用）` });
  }
  return { equipments: cleaned, dropped };
}

/**
 * 背包尺寸对齐：**内容取库里的，尺寸取客户端这次的**，且**逐格保留坐标**
 *
 * 网格尺寸归客户端配置管（`bagRow × bagCol`，服务端不认识它），所以 `bag` 回填不能像
 * 账本那样整份照抄 —— 否则以后配置把格子改大，老角色的背包永远不长个。
 *
 * 关键是**不许重排**：早先这版把库里的物品按行优先「压紧」进新网格，等于每次存档都把
 * 玩家拖好的位置挤回左上角（拖到第 3 行第 5 格的药，下次存档回来变第 0 行第 0 格）——
 * 位置是玩家的操作结果，服务端凭什么替他整理。
 *
 * 内容装不进新尺寸（配置改小 / 客户端报了个更小的网格）时**保留原网格**：
 * 宁可尺寸不听话，也不静默把玩家的东西挤掉或挪走。
 */
export function adoptBagShape(stored: BagGrid, incoming: BagGrid): BagGrid {
  const rows = incoming.length;
  const cols = incoming.reduce((max, line) => Math.max(max, line.length), 0);
  if (rows <= 0 || cols <= 0) return stored;
  const reshaped: BagGrid = Array.from({ length: rows }, () => new Array<BagCell>(cols).fill(null));
  for (let r = 0; r < stored.length; r++) {
    for (let c = 0; c < stored[r].length; c++) {
      const cell = stored[r][c];
      if (!cell) continue;
      // 新尺寸装不下这一格（行或列越界）→ 整份退回原网格：不静默丢东西，也不替玩家挪位置
      if (r >= rows || c >= cols) return stored;
      reshaped[r][c] = cell;
    }
  }
  return reshaped;
}

/** 目标不合法的统一出口（400 + 可展示的中文） */
function invalid(message: string): BizException {
  return new BizException(BizCode.BAG_TARGET_INVALID, message);
}
