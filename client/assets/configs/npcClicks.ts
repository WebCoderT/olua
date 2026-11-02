import { npcClicks } from "./game-config";
import MapTeleportDialog from "../ui/components/dialogs/MapTeleportDialog";
import WarSoulDialog from "../ui/components/dialogs/WarSoulDialog";

/**
 * NPC 点击行为（id → 弹窗 / 跳转）
 *
 * 给某个 NPC 加行为就在这里加一条：key = NPC id（数据本身在服务端 `npcs` 表，不在这里）。
 * **单独一个文件**是因为它会引 UI 组件链，而 `configs/npc` 要被生成器与客户端单测在
 * Node 垫片里加载 —— 两者必须分开（#258 的老约束，#603 第七域数据搬走后依然成立）。
 *
 * 谁 import 了它，注册就生效：目前是 `ui/components/map/MapObjectSpawner`（建 NPC 节点的地方）。
 * `npc.onClick` 在点击那一刻才查注册表，所以加载顺序不影响结果。
 */
npcClicks["0002"] = () => new MapTeleportDialog().open();
npcClicks["9002"] = () => new WarSoulDialog().open();

export {};
