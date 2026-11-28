import { npcClicks, npcFeatureHandlers } from "./game-config";
import MapTeleportDialog from "../ui/components/dialogs/MapTeleportDialog";
import RankUpgradeDialog from "../ui/components/dialogs/RankUpgradeDialog";
import TitleUpgradeDialog from "../ui/components/dialogs/TitleUpgradeDialog";
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
 *
 * #1369 起**运营可配的入口绑定走 `npcFeatureHandlers`**（服务端 `npcs.feature`，管理端
 * 称号 / 战魂 / 军衔三页各选一个 NPC），点击时 feature 优先于这里的 id 硬编码 ——
 * 所以此处只留「运营没法在管理端配」的固有行为（传送官），绑过 feature 的 NPC 不再走这里。
 */
npcClicks["0002"] = () => new MapTeleportDialog().open();
npcClicks["9002"] = () => new WarSoulDialog().open();

/** 入口功能弹窗工厂（#1369）：key = 服务端 npcs.feature 的取值 */
npcFeatureHandlers["title"] = () => new TitleUpgradeDialog().open();
npcFeatureHandlers["soul"] = () => new WarSoulDialog().open();
npcFeatureHandlers["rank"] = () => new RankUpgradeDialog().open();

export {};
