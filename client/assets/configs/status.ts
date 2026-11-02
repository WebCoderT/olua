import { StatusConfig, StatusId } from "../types/status";

/**
 * 状态运行时表（#603 起客户端**不存任何状态数据**）
 *
 * 状态表（名称 / 图标 / 时长 / 来源 / 特效 / 战斗数值）的唯一书写处是服务端
 * `server/src/shared/status-seed.ts`：生成物 seed 进 statuses 表 → 管理端可改 →
 * 随 `GET /game-config` 快照的 `statuses` 段下发，由 `apply-snapshot.applyStatusRows`
 * 灌进这张表（角色与怪物同表，owner 由服务端行带下来）。
 *
 * 用法不变：消费方（StatusManager / BattleMath / HoverTipManager / MonsterManager）
 * 照旧 `statuses.get(id)`。快照到达前表是空的 —— 与怪物数据同一口径
 * （登录时 `loadGameConfig()` 是必经 await，进游戏前快照一定已灌好）。
 */
export const statuses = new Map<StatusId, StatusConfig>();
