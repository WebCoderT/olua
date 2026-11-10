import { useCallback, useEffect, useMemo, useState } from "react";
import { formatTime, PERMISSION, runtimeParamsApi } from "../api";
import type {
  MonsterAiParams,
  RuntimeParams,
  UpdateAutoBattleParams,
  UpdateDropRuntimeParams,
  UpdateGuildRuleParams,
  UpdateMonsterAiParams,
} from "../api";
import { Button, Card, Field, Input, Select, Spinner } from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 运行时参数（#605）
 *
 * 这一页收的是三组「原本写死在客户端源码里、运营改不了」的数值：
 * - **掉落手感**（`configs/drop.ts`）：拾取半径 / 散落间距 / 应答超时 / 满包提示间隔；
 * - **自动战斗与寻路**（`configs/autoBattle.ts`）：目标距离 / A* 网格 / 重寻路节奏 / 卡住判定 / 吸附半径；
 * - **帮会规则**（`common/constants/social.ts` 的四个常量）：名字长度 / 公告长度 / 申请留言长度。
 *
 * ## 为什么按组保存、而不是整页一个保存按钮
 * 服务端 PATCH 是**按组部分更新**，三组各管一件事：改掉落手感不该顺带重写帮会门槛
 * （并发编辑两个分组时，整页提交会让后提交的人覆盖前一个人的改动）。
 * 分组保存 + 分组 loading 把「谁改了哪一组」显示清楚，也是审计日志里的粒度。
 *
 * ## 数字先按字符串收
 * 与装备规则页同一手法：`Number("")` 是 0、`Number("1.")` 是 1，边输边转会把半截输入
 * 变成 0 存进草稿（输入框自己跳回 0，看起来像卡住）。保存时统一 parse + 校验。
 *
 * ## 生效时机
 * 帮会那组**保存即生效**（下次建帮 / 改公告就按新长度校验）；
 * 前两组在玩家**下次进游戏拉配置快照**时生效（客户端本地参数被覆写），已在线的人不会立刻变。
 */
export function RuntimeParamsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [params, setParams] = useState<RuntimeParams | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<GroupKey | null>(null);
  // 怪物 AI 那一组走**另一条接口**（不下发客户端），草稿与保存状态也就分开一份。
  // 不单独存「生效值」：这一页只需要草稿，保存后回读的结果直接转成新草稿
  const [aiDraft, setAiDraft] = useState<Record<string, string> | null>(null);
  const [aiSaving, setAiSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const row = await runtimeParamsApi.get();
      setParams(row);
      setDraft(toDraft(row));
      const ai = await runtimeParamsApi.getMonsterAi();
      setAiDraft(toAiDraft(ai));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setField = (group: GroupKey, key: string, value: string) => {
    setDraft((current) => (current ? { ...current, [group]: { ...current[group], [key]: value } } : current));
  };

  const save = async (group: GroupKey) => {
    if (!draft) return;
    const payload = buildPayload(group, draft[group]);
    if (!payload) return;
    setSaving(group);
    try {
      const row = await runtimeParamsApi.update(payload);
      setParams(row);
      setDraft(toDraft(row));
      toastSuccess(
        group === "guild"
          ? "帮会规则已保存（下次建帮 / 改公告即按新长度校验）"
          : "已保存（玩家下次进游戏拉配置时生效）",
      );
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(null);
    }
  };

  const guildInvalid = useMemo(() => {
    if (!draft) return false;
    const min = Number(draft.guild.nameMin);
    const max = Number(draft.guild.nameMax);
    return Number.isFinite(min) && Number.isFinite(max) && min > max;
  }, [draft]);

  const setAiField = (key: string, value: string) => {
    setAiDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const aiInvalid = useMemo(() => (aiDraft ? aiProblemOf(aiDraft) : null), [aiDraft]);

  const saveAi = async () => {
    if (!aiDraft) return;
    const payload = buildAiPayload(aiDraft);
    if (!payload) return;
    setAiSaving(true);
    try {
      const row = await runtimeParamsApi.updateMonsterAi(payload);
      setAiDraft(toAiDraft(row));
      // 这一组不走快照，AI 每 tick 读库（1 秒 TTL）—— 保存即生效，不用等玩家重进
      toastSuccess("怪物 AI 参数已保存（1 秒内生效，不需要玩家重进）");
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setAiSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="运行时参数"
        description={
          <>
            掉落手感与自动战斗参数以前写死在客户端（<span className="font-mono text-xs">configs/drop</span> 与{" "}
            <span className="font-mono text-xs">configs/autoBattle</span>），帮会规则写死在服务端常量里。现在都能在这里改：
            改完不需要重新打客户端包，玩家下次进游戏拉配置时生效（帮会规则是立即生效）。
            {params ? <span className="ml-1 text-slate-500">上次修改：{formatTime(params.updatedAt)}</span> : null}
          </>
        }
      />

      <Card
        title="掉落手感与绑定"
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <Button disabled={!draft || saving !== null} loading={saving === "drop"} onClick={() => void save("drop")}>
              保存掉落参数
            </Button>
          ) : null
        }
        description={
          canWrite
            ? "拾取半径按「图标半宽 20 + 脚部容差 20」定标；散落间距小于图标尺寸时图标会叠在一起。随机绑定概率由服务端掉落结算读取（0 = 从不随机绑定）。"
            : "当前角色没有「修改养成配置」权限，本页只读。"
        }
      >
        {draft ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {DROP_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <Input
                  type="number"
                  min={0}
                  value={draft.drop[field.key] ?? ""}
                  disabled={!canWrite}
                  onChange={(event) => setField("drop", field.key, event.target.value)}
                />
              </Field>
            ))}
          </div>
        ) : null}
      </Card>

      <Card
        title="自动战斗与寻路"
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <Button disabled={!draft || saving !== null} loading={saving === "autoBattle"} onClick={() => void save("autoBattle")}>
              保存自动战斗参数
            </Button>
          ) : null
        }
        description="超时类参数是毫秒，半径类是世界像素。网格边长调小会更贴合障碍但搜索变慢；卡住阈值调小会让自动走位更容易放弃目标。"
      >
        {draft ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="移动用跑步" hint="关闭则自动走位一律用走路速度">
              <Select
                value={draft.autoBattle.moveByRun}
                disabled={!canWrite}
                onChange={(event) => setField("autoBattle", "moveByRun", event.target.value)}
              >
                <option value="true">跑步</option>
                <option value="false">走路</option>
              </Select>
            </Field>
            {AUTO_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <Input
                  type="number"
                  min={0}
                  value={draft.autoBattle[field.key] ?? ""}
                  disabled={!canWrite}
                  onChange={(event) => setField("autoBattle", field.key, event.target.value)}
                />
              </Field>
            ))}
          </div>
        ) : null}
      </Card>

      <Card
        title="帮会规则"
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <Button disabled={!draft || saving !== null || guildInvalid} loading={saving === "guild"} onClick={() => void save("guild")}>
              保存帮会规则
            </Button>
          ) : null
        }
        description="服务端校验读的就是这几个数：客户端提示只是提前反馈，能不能建帮 / 发公告由服务端判。"
      >
        {draft ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {GUILD_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <Input
                  type="number"
                  min={0}
                  value={draft.guild[field.key] ?? ""}
                  disabled={!canWrite}
                  onChange={(event) => setField("guild", field.key, event.target.value)}
                />
              </Field>
            ))}
            {guildInvalid ? <p className="text-xs text-amber-400">最短字数不能大于最长字数，先改回来再保存。</p> : null}
          </div>
        ) : null}
      </Card>

      <Card
        title="怪物 AI 与脱战"
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <Button disabled={!aiDraft || aiSaving || aiInvalid !== null} loading={aiSaving} onClick={() => void saveAi()}>
              保存怪物 AI 参数
            </Button>
          ) : null
        }
        description={
          canWrite
            ? "这一组是**服务端**在跑的手感：怪多久打一下、追多远就放弃、放弃之后多快走回出生点。保存后 1 秒内生效（AI 每 tick 读一次库），不需要重启也不需要玩家重进。"
            : "当前角色没有「修改养成配置」权限，本页只读。"
        }
      >
        {aiDraft ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {AI_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <Input
                  type="number"
                  min={0}
                  step={field.step ?? 1}
                  value={aiDraft[field.key] ?? ""}
                  disabled={!canWrite}
                  onChange={(event) => setAiField(field.key, event.target.value)}
                />
              </Field>
            ))}
            {aiInvalid ? <p className="text-xs text-amber-400 sm:col-span-2 lg:col-span-4">{aiInvalid}</p> : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

//#region 字段描述（顺序即页面上的顺序）

type GroupKey = "drop" | "autoBattle" | "guild";

/** 草稿：三组都是「键 → 字符串」（`moveByRun` 也按字符串存 "true"/"false"，统一走一个编辑器） */
type Draft = { drop: Record<string, string>; autoBattle: Record<string, string>; guild: Record<string, string> };

interface FieldSpec {
  key: string;
  label: string;
  hint: string;
}

const DROP_FIELDS: FieldSpec[] = [
  { key: "autoPickupRadius", label: "自动拾取半径（像素）", hint: "脚底距离小于它即拾取" },
  { key: "scatterMinDistance", label: "散落最小间距（像素）", hint: "多件掉落物的同心环间距" },
  { key: "pickReplyTimeout", label: "拾取应答超时（毫秒）", hint: "超时视为本轮失败，允许重拾" },
  { key: "fullTipInterval", label: "背包满提示间隔（毫秒）", hint: "防止自动拾取时每帧刷屏" },
  { key: "bindChance", label: "随机绑定概率（%）", hint: "物品与怪物都没写「强制绑定」时，按它掷一次（服务端掉落结算读它）" },
];

const AUTO_FIELDS: FieldSpec[] = [
  { key: "maxTargetDistance", label: "选目标最大距离（像素）", hint: "0 = 不限，全图取最近" },
  { key: "cellSize", label: "A* 网格边长（像素）", hint: "越小越贴合障碍、搜索越慢" },
  { key: "clearance", label: "通行余量（像素）", hint: "障碍外扩，避免贴墙卡住" },
  { key: "repathInterval", label: "重寻路间隔（毫秒）", hint: "目标会移动，路径要定期重算" },
  { key: "waypointTolerance", label: "路点判定半径（像素）", hint: "进入半径即走向下一个路点" },
  { key: "stuckInterval", label: "卡住检测间隔（毫秒）", hint: "与下一项配合判卡住" },
  { key: "stuckDistance", label: "卡住位移阈值（像素）", hint: "间隔内位移低于它视为卡住" },
  { key: "stuckRetryLimit", label: "卡住重试上限（次）", hint: "超过则放弃当前目标" },
  { key: "targetBanDuration", label: "放弃目标拉黑（毫秒）", hint: "期间选目标会跳过它" },
  { key: "targetSearchInterval", label: "无目标重找间隔（毫秒）", hint: "避免每帧全图扫描" },
  { key: "arriveTolerance", label: "点击寻路到达半径（像素）", hint: "进入半径即视为到达" },
  { key: "teleportSnapRadius", label: "传送落点吸附（格）", hint: "落点周围找可站立位置" },
  { key: "dashSnapRadius", label: "突进落点吸附（像素）", hint: "突进距离远，范围更大" },
];

const GUILD_FIELDS: FieldSpec[] = [
  { key: "nameMin", label: "帮会名最短（字）", hint: "必须 ≤ 最长" },
  { key: "nameMax", label: "帮会名最长（字）", hint: "必须 ≥ 最短" },
  { key: "noticeMax", label: "公告最长（字）", hint: "0 = 不限" },
  { key: "applicationMessageMax", label: "申请留言最长（字）", hint: "0 = 不限" },
];

/**
 * 怪物 AI 的字段（`runtime_params.monster_ai`，#853 / #854）
 *
 * 两组区间在库里是 `[最小, 最大]` 数组，页面上拆成两个输入框（`idleMoveIntervalMin` /
 * `idleMoveIntervalMax`），草稿是平的字符串表 —— 与另外三组共用同一个编辑器。
 */
const AI_FIELDS: Array<FieldSpec & { step?: number }> = [
  { key: "attackInterval", label: "普攻间隔（毫秒）", hint: "两次普攻之间至少隔这么久" },
  { key: "attackRange", label: "普攻距离（像素）", hint: "进入这个距离才站定出手" },
  { key: "attackActionTime", label: "施法硬直兜底（毫秒）", hint: "技能没配 cast_lock_ms 时用它" },
  { key: "pushDuration", label: "击退时长（毫秒）", hint: "技能只配距离时用它换算击退速度" },
  { key: "idleMoveIntervalMin", label: "游走间隔最小（毫秒）", hint: "待机时两次走动之间至少隔多久" },
  { key: "idleMoveIntervalMax", label: "游走间隔最大（毫秒）", hint: "必须 ≥ 最小" },
  { key: "idleMoveDurationMin", label: "单次游走时长最小（毫秒）", hint: "一次待机游走走多久" },
  { key: "idleMoveDurationMax", label: "单次游走时长最大（毫秒）", hint: "必须 ≥ 最小" },
  { key: "idleMoveSpeedScale", label: "游走速度倍率", hint: "乘在怪物自身 moveSpeed 上（0.5 = 半速晃）", step: 0.1 },
  { key: "wanderRadius", label: "游走半径（像素）", hint: "围绕出生点，走出半径就往回走" },
  { key: "leashRange", label: "牵引半径（像素）", hint: "目标跑出这个距离就脱战回家；必须大于普攻距离", step: 10 },
  { key: "returnSpeedRate", label: "回家速度倍率", hint: "比追击快，免得被玩家拖着遛", step: 0.1 },
  { key: "returnTimeoutMs", label: "回家超时（毫秒）", hint: "到点还没走回出生点就直接吸附回去", step: 1000 },
];

//#endregion

//#region 草稿 ↔ 生效值

function toDraft(row: RuntimeParams): Draft {
  return {
    drop: {
      autoPickupRadius: String(row.drop.autoPickupRadius),
      scatterMinDistance: String(row.drop.scatterMinDistance),
      pickReplyTimeout: String(row.drop.pickReplyTimeout),
      fullTipInterval: String(row.drop.fullTipInterval),
      bindChance: String(row.drop.bindChance ?? 0),
    },
    autoBattle: {
      moveByRun: row.autoBattle.moveByRun ? "true" : "false",
      maxTargetDistance: String(row.autoBattle.maxTargetDistance),
      cellSize: String(row.autoBattle.cellSize),
      clearance: String(row.autoBattle.clearance),
      repathInterval: String(row.autoBattle.repathInterval),
      waypointTolerance: String(row.autoBattle.waypointTolerance),
      stuckInterval: String(row.autoBattle.stuckInterval),
      stuckDistance: String(row.autoBattle.stuckDistance),
      stuckRetryLimit: String(row.autoBattle.stuckRetryLimit),
      targetBanDuration: String(row.autoBattle.targetBanDuration),
      targetSearchInterval: String(row.autoBattle.targetSearchInterval),
      arriveTolerance: String(row.autoBattle.arriveTolerance),
      teleportSnapRadius: String(row.autoBattle.teleportSnapRadius),
      dashSnapRadius: String(row.autoBattle.dashSnapRadius),
    },
    guild: {
      nameMin: String(row.guild.nameMin),
      nameMax: String(row.guild.nameMax),
      noticeMax: String(row.guild.noticeMax),
      applicationMessageMax: String(row.guild.applicationMessageMax),
    },
  };
}

/**
 * 草稿 → 一个分组的提交体
 * **逐字段显式列**而不是 `Object.fromEntries`：拼错一个键会被服务端的白名单静默剥掉，
 * 结果就是「保存成功但没生效」—— 那是最难查的一类问题。显式列出来，拼错在类型层就红。
 * 任何一个字段不是数字就整组不提交（返回 null，按钮本来就是 disabled 状态）。
 */
function buildPayload(
  group: GroupKey,
  values: Record<string, string>,
):
  | { drop: UpdateDropRuntimeParams }
  | { autoBattle: UpdateAutoBattleParams }
  | { guild: UpdateGuildRuleParams }
  | null {
  const num = (key: string): number | null => {
    const raw = values[key];
    const parsed = Number(raw);
    return raw !== undefined && raw.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
  };
  if (group === "drop") {
    const autoPickupRadius = num("autoPickupRadius");
    const scatterMinDistance = num("scatterMinDistance");
    const pickReplyTimeout = num("pickReplyTimeout");
    const fullTipInterval = num("fullTipInterval");
    const bindChance = num("bindChance");
    if (
      autoPickupRadius === null ||
      scatterMinDistance === null ||
      pickReplyTimeout === null ||
      fullTipInterval === null ||
      bindChance === null
    ) {
      return null;
    }
    return { drop: { autoPickupRadius, scatterMinDistance, pickReplyTimeout, fullTipInterval, bindChance } };
  }
  if (group === "guild") {
    const nameMin = num("nameMin");
    const nameMax = num("nameMax");
    const noticeMax = num("noticeMax");
    const applicationMessageMax = num("applicationMessageMax");
    if (nameMin === null || nameMax === null || noticeMax === null || applicationMessageMax === null) return null;
    return { guild: { nameMin, nameMax, noticeMax, applicationMessageMax } };
  }
  const maxTargetDistance = num("maxTargetDistance");
  const cellSize = num("cellSize");
  const clearance = num("clearance");
  const repathInterval = num("repathInterval");
  const waypointTolerance = num("waypointTolerance");
  const stuckInterval = num("stuckInterval");
  const stuckDistance = num("stuckDistance");
  const stuckRetryLimit = num("stuckRetryLimit");
  const targetBanDuration = num("targetBanDuration");
  const targetSearchInterval = num("targetSearchInterval");
  const arriveTolerance = num("arriveTolerance");
  const teleportSnapRadius = num("teleportSnapRadius");
  const dashSnapRadius = num("dashSnapRadius");
  if (
    maxTargetDistance === null ||
    cellSize === null ||
    clearance === null ||
    repathInterval === null ||
    waypointTolerance === null ||
    stuckInterval === null ||
    stuckDistance === null ||
    stuckRetryLimit === null ||
    targetBanDuration === null ||
    targetSearchInterval === null ||
    arriveTolerance === null ||
    teleportSnapRadius === null ||
    dashSnapRadius === null
  ) {
    return null;
  }
  return {
    autoBattle: {
      moveByRun: values.moveByRun === "true",
      maxTargetDistance,
      cellSize,
      clearance,
      repathInterval,
      waypointTolerance,
      stuckInterval,
      stuckDistance,
      stuckRetryLimit,
      targetBanDuration,
      targetSearchInterval,
      arriveTolerance,
      teleportSnapRadius,
      dashSnapRadius,
    },
  };
}

//#endregion

//#region 怪物 AI 草稿（另一条接口，字段拆开存）

/** 生效值 → 草稿（两组区间拆成 最小 / 最大 两个输入框） */
function toAiDraft(row: MonsterAiParams): Record<string, string> {
  return {
    attackInterval: String(row.attackInterval),
    attackRange: String(row.attackRange),
    attackActionTime: String(row.attackActionTime),
    pushDuration: String(row.pushDuration),
    idleMoveIntervalMin: String(row.idleMoveInterval?.[0] ?? ""),
    idleMoveIntervalMax: String(row.idleMoveInterval?.[1] ?? ""),
    idleMoveDurationMin: String(row.idleMoveDuration?.[0] ?? ""),
    idleMoveDurationMax: String(row.idleMoveDuration?.[1] ?? ""),
    idleMoveSpeedScale: String(row.idleMoveSpeedScale),
    wanderRadius: String(row.wanderRadius),
    leashRange: String(row.leashRange),
    returnSpeedRate: String(row.returnSpeedRate),
    returnTimeoutMs: String(row.returnTimeoutMs),
  };
}

/**
 * 草稿里的跨字段问题（没有返回 null）
 *
 * 与另外三组同一分工：单字段上下限由服务端 DTO 校验，这里只挡「保存了必然 40000」的组合，
 * 让运营在点按钮之前就看到哪里不对。服务端仍然会再判一次 —— 页面只是提前反馈。
 */
function aiProblemOf(values: Record<string, string>): string | null {
  const num = (key: string): number => Number(values[key]);
  const keys = AI_FIELDS.map((field) => field.key);
  const missing = keys.filter((key) => values[key] === undefined || values[key].trim() === "" || !Number.isFinite(num(key)));
  if (missing.length > 0) return `还有 ${missing.length} 个字段没填或不是数字，填完再保存。`;
  if (num("idleMoveIntervalMin") > num("idleMoveIntervalMax")) return "游走间隔的最小值不能大于最大值。";
  if (num("idleMoveDurationMin") > num("idleMoveDurationMax")) return "单次游走时长的最小值不能大于最大值。";
  if (num("leashRange") <= num("attackRange")) return "牵引半径必须大于普攻距离，否则怪刚看见人就脱战。";
  return null;
}

/** 草稿 → 提交体（逐字段显式列，拼错在类型层就红；有一处不合法就整组不提交） */
function buildAiPayload(values: Record<string, string>): UpdateMonsterAiParams | null {
  if (aiProblemOf(values) !== null) return null;
  return {
    attackInterval: Number(values.attackInterval),
    attackRange: Number(values.attackRange),
    attackActionTime: Number(values.attackActionTime),
    pushDuration: Number(values.pushDuration),
    idleMoveInterval: [Number(values.idleMoveIntervalMin), Number(values.idleMoveIntervalMax)],
    idleMoveDuration: [Number(values.idleMoveDurationMin), Number(values.idleMoveDurationMax)],
    idleMoveSpeedScale: Number(values.idleMoveSpeedScale),
    wanderRadius: Number(values.wanderRadius),
    leashRange: Number(values.leashRange),
    returnSpeedRate: Number(values.returnSpeedRate),
    returnTimeoutMs: Number(values.returnTimeoutMs),
  };
}

//#endregion
