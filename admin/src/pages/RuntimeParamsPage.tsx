import { useCallback, useEffect, useMemo, useState } from "react";
import { formatTime, PERMISSION, runtimeParamsApi } from "../api";
import type { RuntimeParams, UpdateAutoBattleParams, UpdateDropRuntimeParams, UpdateGuildRuleParams } from "../api";
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const row = await runtimeParamsApi.get();
      setParams(row);
      setDraft(toDraft(row));
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
        title="掉落手感"
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <Button disabled={!draft || saving !== null} loading={saving === "drop"} onClick={() => void save("drop")}>
              保存掉落手感
            </Button>
          ) : null
        }
        description={
          canWrite
            ? "拾取半径按「图标半宽 20 + 脚部容差 20」定标；散落间距小于图标尺寸时图标会叠在一起。"
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

//#endregion

//#region 草稿 ↔ 生效值

function toDraft(row: RuntimeParams): Draft {
  return {
    drop: {
      autoPickupRadius: String(row.drop.autoPickupRadius),
      scatterMinDistance: String(row.drop.scatterMinDistance),
      pickReplyTimeout: String(row.drop.pickReplyTimeout),
      fullTipInterval: String(row.drop.fullTipInterval),
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
 *
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
    if (autoPickupRadius === null || scatterMinDistance === null || pickReplyTimeout === null || fullTipInterval === null) return null;
    return { drop: { autoPickupRadius, scatterMinDistance, pickReplyTimeout, fullTipInterval } };
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
