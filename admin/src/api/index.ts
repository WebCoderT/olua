/**
 * 接口层统一出口
 *
 * 页面只从这里 import（`import { rolesApi } from "../api"`），
 * 于是「地址从哪来、怎么发、错误怎么归一」永远收在 api/ 目录里。
 *
 * 三块内容各有归属：
 * - **生成物**（禁止手改）：`./endpoints` 接口方法 + `./models` 实体类型 + `./routes` 路径表，
 *   由 `tools/gen-api.cjs` 从服务端 OpenAPI 文档生成；
 * - **公共游戏数据**（也是生成物）：`./gameData` 引用三端共用的那一份快照
 *   （`server/src/shared/game-data.generated.ts`），职业 / 性别 / 装备 / 技能 / 物品 / 地图的名字都在它那里；
 * - **手写**：`./types` 里的错误模型、业务码、权限点、展示字典（服务端文档描述不了它们）；
 * - `./config` / `./http`：地址与请求实现，页面不直接碰。
 */
export {
  announcementsApi,
  authApi,
  accountsApi,
  adminsApi,
  rolesApi,
  auditApi,
  statsApi,
  systemApi,
  mailsApi,
  soulsApi,
  titlesApi,
  ranksApi,
  equipmentsApi,
  drugsApi,
  itemsApi,
  monstersApi,
  npcsApi,
  skillsApi,
  statusesApi,
  questsApi,
  achievementsApi,
  reportsApi,
  mallApi,
  fashionsApi,
  dropApi,
  zonesApi,
  guildsApi,
  levelExpsApi,
  growthSegmentsApi,
  growthScalarsApi,
} from "./endpoints";
export { routes } from "./routes";
export type * from "./models";

export { ApiError } from "./types";
export type { ApiEnvelope, PageResult, PermissionValue } from "./types";
export {
  ACQUIRE_CHANNEL,
  ACQUIRE_CHANNEL_LABELS,
  ADMIN_ROLE,
  ADMIN_ROLE_LABELS,
  adminRoleLabel,
  ANNOUNCEMENT_LEVEL,
  ANNOUNCEMENT_LEVEL_LABELS,
  AUDIT_ACTION_LABELS,
  AUDIT_TARGET_LABELS,
  auditActionLabel,
  auditTargetLabel,
  BAN_DURATION_MAX_HOURS,
  BAN_DURATION_PRESETS,
  BAN_REASON_MAX_LENGTH,
  banStateOf,
  BIZ_CODE,
  formatBytes,
  formatDuration,
  formatTime,
  formatTimeFull,
  localInputToMs,
  msToLocalInput,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PERMISSION,
  PERMISSION_LABELS,
  permissionLabel,
  ROLE_BAG_AXIS_MAX,
  SKILL_CATEGORY_LABELS,
  SKILL_OWNER_LABELS,
  SKILL_OWNER_OPTIONS,
  SKILL_TARGET_TYPE_LABELS,
  STATUS_SOURCE_LABELS,
} from "./types";
// 游戏数据：三端共用的那一份（生成物 + 查表函数）
export {
  EQUIPMENT_DISPLAY_NAMES,
  EQUIPMENT_SLOTS,
  EQUIPMENT_SLOT_OF,
  equipmentText,
  ITEM_LABELS,
  itemText,
  MAP_LABELS,
  mapText,
  OCCUPATION_LABELS,
  occupationLabel,
  RANK_LABELS,
  rankText,
  SEX_LABELS,
  sexLabel,
  SKILL_LABELS,
  skillText,
  slotLabel,
  SOUL_LABELS,
  soulText,
  TITLE_LABELS,
  titleText,
} from "./gameData";
