import { NpcData } from "../types/map";
import MapTeleportDialog from "../ui/components/dialogs/MapTeleportDialog";
import WarSoulDialog from "../ui/components/dialogs/WarSoulDialog";
import { npcData } from "./npc-data";

/**
 * NPC 配置（id → 配置）：由 npcData 统一构建，消费方照旧 npcs.get(id)
 *
 * **数据与行为分家（#258）**：纯数据（id / label / src / scale / position）在
 * `configs/npc-data` —— 那份要被 `tools/gen-shared-data.cjs` 在 Node 里加载生成
 * 三端公共快照，不能引任何 UI 组件。点击行为在这里按 id 接线：想给某个 NPC
 * 加行为，往 NPC_CLICKS 加一条（key = NPC id）即可，不用动数据文件。
 */

/** id → 点击行为（想在客户端给 NPC 挂弹窗 / 跳转就在这里接） */
const NPC_CLICKS: Record<string, () => void> = {
  "0002": () => new MapTeleportDialog().open(),
  "9002": () => new WarSoulDialog().open(),
};

export const npcs = new Map<string, NpcData>();
for (const npc of npcData) {
  const onClick = NPC_CLICKS[npc.id];
  npcs.set(npc.id, onClick ? { ...npc, onClick } : npc);
}
