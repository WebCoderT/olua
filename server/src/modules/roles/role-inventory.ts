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
 * **同 id 的总件数不变**。搬运合并、交换、整理重排全都满足这两条；
 * 少一件或多一件必然违反其中一条。
 *
 * 本文件是纯函数（不碰数据库、不读配置表）：装备槽位与等级门槛由调用方以回调传入，
 * 于是它可以在单测里直接跑，也免得这里再长出一份「哪些 id 是装备」的知识。
 */

import { BizCode } from "../../common/constants/biz-code";
import { BizException } from "../../common/errors/biz.exception";

/** 一个背包格子：`null` = 空格（与客户端存档同形状） */
export type BagCell = { id: string; count: number } | null;

/** 背包网格（二维，行优先） */
export type BagGrid = BagCell[][];

/** 装备槽位表：槽位 → 装备 id（`null` = 该槽位空着） */
export type WornEquipments = Record<string, string | null>;

/**
 * 读背包网格（存档里那一份）
 *
 * 结构不合法直接拒：调用方都是「要动这份数据」的路径，拿一个半坏的对象继续算，
 * 只会把坏数据写到更远的地方（与 `parseStoredRoleData` 对编辑路径不容忍同一理由）。
 * 单格只认 `{ id: string, count: number }`，多出来的字段不管（客户端可能带调试字段）。
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
      return { id, count };
    });
  });
}

/** 读装备槽位表（缺字段 / 不是对象 → 空表，老存档的边角按「什么都没穿」处理） */
export function readWornEquipments(raw: unknown): WornEquipments {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: WornEquipments = {};
  for (const [slot, value] of Object.entries(raw as Record<string, unknown>)) {
    result[slot] = typeof value === "string" && value.trim() ? value.trim() : null;
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

/** 背包内容指纹：物品 id → 总件数（不看位置，空格不参与） */
export function bagContentOf(grid: BagGrid): Map<string, number> {
  const content = new Map<string, number>();
  for (const line of grid) {
    for (const cell of line) {
      if (!cell) continue;
      content.set(cell.id, (content.get(cell.id) ?? 0) + cell.count);
    }
  }
  return content;
}

/** 两副网格的**内容**是否一致（只看 id 与总件数） */
export function sameBagContent(a: BagGrid, b: BagGrid): boolean {
  const left = bagContentOf(a);
  const right = bagContentOf(b);
  if (left.size !== right.size) return false;
  for (const [id, count] of left) {
    if (right.get(id) !== count) return false;
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
 * 穿戴：把格子里的装备挪到槽位，原来穿着的放回**刚腾出来的那一格**
 *
 * 格数守恒（换装不会凭空多/少一件）：格子存的是 id + 数量，槽位也是 id。
 * 调用方负责先校验「这一格里的东西真的是这个槽位的装备、且等级够」。
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
  grid[row][col] = worn ? { id: worn, count: 1 } : null;
  equipments[slot] = cell.id;
  return worn;
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
  const equipmentId = equipments[slot];
  if (!equipmentId) throw invalid("这个槽位是空的，没有可脱下的装备");
  const target = firstEmptyCell(grid);
  if (!target) throw BizException.conflict(BizCode.MALL_BAG_FULL, "背包已满，无法脱下装备");
  grid[target.row][target.col] = { id: equipmentId, count: 1 };
  equipments[slot] = null;
  return { equipmentId, row: target.row, col: target.col };
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
  const take = (slot: string, id: string): boolean => {
    if (worn.has(id) || cleaned[slot]) return false;
    worn.add(id);
    cleaned[slot] = id;
    return true;
  };
  for (const [slot, id] of Object.entries(equipments)) {
    if (!id) {
      cleaned[slot] = null;
      continue;
    }
    if (worn.has(id)) {
      dropped.push({ slot, id, reason: "同一件被穿在多个槽位" });
      continue;
    }
    const actual = slotOf(id);
    // 认不出的 id：服务端快照里没有这件装备，判断不了部位，原样留着
    if (!actual) {
      if (take(slot, id)) continue;
      dropped.push({ slot, id, reason: "槽位已被占用" });
      continue;
    }
    if (actual === slot) {
      if (take(slot, id)) continue;
      dropped.push({ slot, id, reason: "槽位已被占用" });
      continue;
    }
    // 部位不符：挪到真正的槽位（空着才挪），挪不过去就是脏数据
    if (take(actual, id)) continue;
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
