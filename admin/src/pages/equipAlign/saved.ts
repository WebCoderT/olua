import { useCallback, useEffect, useState } from "react";
import { ApiError, equipAlignsApi } from "../../api";
import type { EquipAlign, SaveEquipAlign } from "../../api";
import type { Geometry, Vec2 } from "./model";
import { normalizePositions, round2 } from "./model";

/**
 * 服务端已保存的对齐几何（#513）
 *
 * 工作台从「调完导出 JSON、再去项目根跑脚本写回源码」改成「点保存直连服务端」之后，
 * 页面就多了一份真相：**catalog.json 是出厂值，服务端那张表是当前值**。
 * 于是任何一件装备的基线都是 `saved[id] ?? catalog.base`，而不是 catalog 本身 ——
 * 少了这层，第二次进页面会把上次调好的位置当成「没调过」显示。
 *
 * 只在这一个模块里碰接口：页面不 fetch，`audit-api-hardcode` 也就只需要盯着这里。
 */
export type SavedMap = Record<string, Geometry>;

/** 页面几何 → 接口入参（2 位小数：与 `tools/apply-equip-align.cjs` 写回源码时同口径） */
export function toPayload(geometry: Geometry): SaveEquipAlign {
  return {
    outScale: round2(geometry.outScale),
    outPositions: geometry.outPositions.map((pos) => ({ x: round2(pos[0]), y: round2(pos[1]) })),
    outManual: geometry.manual,
  };
}

/** 接口返回 → 页面几何（8 项长度兜底：服务端存的就是 8 个，但手工改过库也不该让页面崩） */
export function fromRow(row: EquipAlign): Geometry {
  return {
    outScale: row.outScale > 0 ? row.outScale : 1,
    outPositions: normalizePositions(row.outPositions.map((point) => [point.x, point.y] as Vec2)),
    manual: row.outManual,
  };
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export interface AlignStore {
  /** 已保存的对齐（按页面 id 索引，如 `cloth:cloth_1`）；没有 key = 这件没调过 */
  saved: SavedMap;
  loading: boolean;
  /** 读 / 写失败的提示（单个横幅，不逐条弹） */
  error: string;
  /** 正在保存 / 重置的目标 id（按钮禁用 + 「保存中」文案） */
  pending: string | null;
  save: (id: string, geometry: Geometry) => Promise<boolean>;
  reset: (id: string) => Promise<boolean>;
  reload: () => void;
  clearError: () => void;
}

/**
 * 对齐几何的服务端读写
 *
 * 保存 / 重置都是**单条**操作：工作台的真实节奏是「调一件、存一件」，不是批量提交；
 * 批量保存由页面自己循环调用 `save`（逐条进度可显示、一条失败不拖累其它条）。
 */
export function useAlignStore(): AlignStore {
  const [saved, setSaved] = useState<SavedMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError("");
    equipAlignsApi
      .list({ silent: true })
      .then((result) => {
        const next: SavedMap = {};
        for (const row of result.list) next[row.id] = fromRow(row);
        setSaved(next);
      })
      .catch((reason: unknown) => setError(`读取已保存的对齐失败：${errorText(reason)}`))
      .then(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = useCallback(async (id: string, geometry: Geometry): Promise<boolean> => {
    setPending(id);
    try {
      const row = await equipAlignsApi.save(id, toPayload(geometry));
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
      await equipAlignsApi.reset(id);
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
