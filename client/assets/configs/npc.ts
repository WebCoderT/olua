import { Vec3 } from "cc";
import type { NpcData } from "../types/map";
import type { Npc as NpcRow } from "../ui/utils/net/ApiModels";

/**
 * NPC 运行时表（id → 配置）与点击注册表
 *
 * **#603 第七域起客户端不存任何 NPC 数据**（此前是 `configs/npc-data.ts` 的 21 条）：
 * 名称 / 素材目录 / 缩放 / 偏移都在服务端 `npcs` 表（出厂 = `server/src/shared/npc-seed.ts`），
 * 进游戏时由 `GET /game-config` 快照的 `npcs` 段**整表重建**（`applyNpcRows`，先 clear）。
 * 运营在管理端改完，下次进游戏生效 —— 客户端不用重打包。
 *
 * **本文件不许引 UI 组件**：`configs/apply-snapshot` 会引它，而生成器与客户端单测要在
 * Node 垫片里加载那条链（`tools/gen-shared-data.cjs` / `client/tools/*.cjs`）。原来
 * `npc-data.ts` 与 `npc.ts` 分家（#258）就是为了这件事，现在数据搬去服务端，剩下的
 * 点击接线继续留在 `configs/npcClicks.ts`（那边才引弹窗），本文件只放一个注册表。
 *
 * ⚠ 快照到达前这张表是**空的**（不是 bug）：`MapObjectSpawner` 建节点时查不到会跳过该 NPC，
 * `PreloadManager` 也不会预载它的素材 —— 而 `Game.start` 里 `loadGameConfig()` 排在预载**之前**，
 * 所以正常进游戏时表已经满了；只有「Loading 场景先预载」那一趟会漏（`Game` 里那趟会补上）。
 */
export const npcs = new Map<string, NpcData>();

/**
 * id → 点击行为（由 `configs/npcClicks` 在模块加载时登记）
 *
 * 用注册表而不是直接在本文件 import 弹窗：点击行为是 UI，进了这条链 Node 里就加载不了。
 * `npc.onClick` 是**点击那一刻**才查表，所以「注册表晚于快照填充」也不影响 —— 真点了才解析。
 */
export const npcClicks: Record<string, () => void> = {};

/**
 * 快照 npcs 段 → 运行时表（**整表重建**，先 clear）
 *
 * 整表重建而不是「覆写已有行」：客户端已经没有兜底数据，覆写等于「快照缺行就静默少一个 NPC」。
 * 缩放 / 偏移在库里是 NOT NULL（默认 1 / 0），所以这里无条件赋值 —— 与原先把
 * `scale` / `position` 当可选字段时渲染结果一致（setScale(1,1) / setPosition(0,0) 就是原样）。
 */
export function applyNpcRows(rows: NpcRow[]): void {
  npcs.clear();
  rows.forEach((row) => {
    npcs.set(row.id, {
      id: row.id,
      label: row.label,
      src: row.src,
      scale: new Vec3(row.scaleX, row.scaleY),
      position: new Vec3(row.posX, row.posY),
      // 延迟解析：行为在 npcClicks 里，那个文件可能比快照晚加载
      onClick: () => {
        const handler = npcClicks[row.id];
        if (handler) handler();
      },
    });
  });
}
