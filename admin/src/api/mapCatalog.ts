import { mapsApi } from "./endpoints";
import type { MapSummary } from "./models";

/**
 * 地图名录（管理端跨页共用的「id → 名字」）
 *
 * 地图名现在**只在服务端**（`maps` 表，#573）：客户端与管理端都不许再存一份 ——
 * 之前管理端靠生成物 `MAP_LABELS` 同步读，那种「代码里写死一份名字」正是这次要消掉的东西。
 *
 * 但管理端有几处**同步渲染**读不出异步接口：角色详情里的「所在地图」、实体选择器的地图下拉。
 * 所以这里做一层进程内缓存：登录后拉一次 `GET /admin/maps`，之后同步读；
 * 地图页保存成功后调 `refreshMapCatalog()`，其它页面下次渲染就是新名字。
 *
 * 缓存空的时候返回 id 本身（`mapText("3")` → `"3"`）—— 那一眼能看出「名字没加载」，
 * 而不是显示一个假装正确的空串。
 */
let catalog: MapSummary[] = [];
let loading: Promise<void> | null = null;

/** 地图 id → 名字（缓存没到时回落 id） */
export function mapText(id: string): string {
  if (!id) return "";
  return catalog.find((item) => item.id === id)?.label || id;
}

/** 全部地图 id（顺序 = 服务端给的 id 数值升序，实体选择器直接拿来当选项） */
export function mapIds(): string[] {
  return catalog.map((item) => item.id);
}

/** 名录是否已加载（页面禁用「保存」之类的判据不该用它，只用于展示兜底） */
export function mapCatalogLoaded(): boolean {
  return catalog.length > 0;
}

/**
 * 保证名录已加载（幂等；失败静默 —— 名录只影响「名字显示」，不该挡住后台其它页面）
 *
 * 由 `Layout` 在挂载时调一次：登录后必有布局，那时拉最省事，也不用每个页面各写一遍。
 */
export function ensureMapCatalog(): Promise<void> {
  if (catalog.length) return Promise.resolve();
  if (!loading) {
    loading = mapsApi
      .list()
      .then((result) => {
        catalog = result.list;
      })
      .catch(() => {
        // 名录拉不到就按 id 显示：这不是错误状态，只是少了个好听的名字
      })
      .then(() => {
        loading = null;
      });
  }
  return loading;
}

/** 重新拉一次（地图页保存成功后调，让其它页面看到新名字） */
export function refreshMapCatalog(): Promise<void> {
  catalog = [];
  return ensureMapCatalog();
}
