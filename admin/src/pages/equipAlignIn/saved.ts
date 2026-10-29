import { useCallback, useEffect, useState } from "react";
import { ApiError, equipInAlignsApi } from "../../api";
import type { EquipInAlign, SaveEquipInAlign } from "../../api";
import type { InGeometry, Vec2 } from "./model";
import { round2 } from "./model";

/**
 * 服务端已保存的内观几何（#523）
 *
 * 与外观工作台（`equipAlign/saved.ts`）同一套路：catalog.json 是出厂值，服务端这张表是当前值，
 * 任何一件的基线都是 `saved[id] ?? catalog.base` —— 少了这层，第二次进页面会把上次调好的位置
 * 当成「没调过」显示。
 *
 * 只在这一个模块里碰接口：页面不 fetch，`audit-api-hardcode` 只需要盯着这里。
 */
export type SavedInMap = Record<string, InGeometry>;

/** 页面几何 → 接口入参（2 位小数：与外观工作台同精度） */
export function toPayload(geometry: InGeometry): SaveEquipInAlign {
  return {
    inScaleX: round2(geometry.inScaleX),
    inScaleY: round2(geometry.inScaleY),
    inPosition: { x: round2(geometry.inPosition[0]), y: round2(geometry.inPosition[1]) },
    inManual: geometry.manual,
  };
}

/** 接口返回 → 页面几何（坏缩放过 0 会让节点消失，兜回 1） */
export function fromRow(row: EquipInAlign): InGeometry {
  return {
    inScaleX: row.inScaleX > 0 ? row.inScaleX : 1,
    inScaleY: row.inScaleY > 0 ? row.inScaleY : 1,
    inPosition: [Number(row.inPosition?.x) || 0, Number(row.inPosition?.y) || 0] as Vec2,
    manual: row.inManual === true,
  };
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export interface InAlignStore {
  /** 已保存的内观几何（按页面 id 索引，如 `cloth:cloth_1`）；没有 key = 这件没调过 */
  saved: SavedInMap;
  loading: boolean;
  error: string;
  /** 正在保存 / 重置的目标 id */
  pending: string | null;
  save: (id: string, geometry: InGeometry) => Promise<boolean>;
  reset: (id: string) => Promise<boolean>;
  reload: () => void;
  clearError: () => void;
}

/**
 * 内观几何的服务端读写
 *
 * 保存 / 重置都是**单条**操作（工作台的节奏是「调一件、存一件」）；批量保存由页面循环调用。
 */
/**
 * 武器保存时强制 `inManual = true`（衣服不动）
 *
 * 为什么必须在写库这一层兜：`inManual = false` 的武器行，客户端**根本不会读** ——
 * `RoleInShowView.alignWeapon()` 会按当前衣服的内容 bbox 现算。于是「拖好了、点保存、
 * 服务端也有行」，但游戏里一动不动，而且从页面到接口的每一层都看不出来（#527）。
 *
 * 想回到自动算的语义只有一种：**删行**（`还原本件`），不是存一份 `inManual = false`。
 * 所以这里不是「忽略用户意图」，而是「把用户意图翻译成客户端真会读的那一种」。
 */
function withManualForWeapon(id: string, geometry: InGeometry): InGeometry {
  if (!id.startsWith("weapon:") || geometry.manual === true) return geometry;
  return { ...geometry, manual: true };
}

export function useInAlignStore(): InAlignStore {
  const [saved, setSaved] = useState<SavedInMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError("");
    equipInAlignsApi
      .list({ silent: true })
      .then((result) => {
        const next: SavedInMap = {};
        for (const row of result.list) next[row.id] = fromRow(row);
        setSaved(next);
      })
      .catch((reason: unknown) => setError(`读取已保存的内观几何失败：${errorText(reason)}`))
      .then(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = useCallback(async (id: string, geometry: InGeometry): Promise<boolean> => {
    setPending(id);
    try {
      const row = await equipInAlignsApi.save(id, toPayload(withManualForWeapon(id, geometry)));
      setSaved((prev) => ({ ...prev, [id]: fromRow(row) }));
      return true;
    } catch (reason) {
      setError(`保存 ${id} 失败：${errorText(reason)}`);
      return false;
    } finally {
      setPending(null);
    }
  }, []);

  const reset = useCallback(async (id: string): Promise<boolean> => {
    setPending(id);
    try {
      await equipInAlignsApi.reset(id);
      setSaved((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return true;
    } catch (reason) {
      setError(`重置 ${id} 失败：${errorText(reason)}`);
      return false;
    } finally {
      setPending(null);
    }
  }, []);

  const clearError = useCallback(() => setError(""), []);

  return { saved, loading, error, pending, save, reset, reload, clearError };
}
