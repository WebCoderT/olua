import { useCallback, useEffect, useMemo, useState } from "react";
import { formatTime, PERMISSION, runtimeParamsApi } from "../api";
import type {
  AoiParams,
  CastRangeParams,
  MonsterAiParams,
  MovementGuardParams,
  RecommendedRuntimeParams,
  RuntimeParams,
  UpdateAutoBattleParams,
  UpdateAoiParams,
  UpdateCastRangeParams,
  UpdateDropRuntimeParams,
  UpdateGuildRuleParams,
  UpdateMonsterAiParams,
  UpdateMovementGuardParams,
} from "../api";
import { Button, Card, Field, Input, Select, Spinner } from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
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
  // 两道服务端校验闸（#811 移动 / #1030 出手距离）：各自一条接口、各自一份草稿，
  // 与怪物 AI 同一理由 —— 它们都不进客户端快照，改的是服务端判定而不是客户端手感
  const [movementDraft, setMovementDraft] = useState<Record<string, string> | null>(null);
  const [movementSaving, setMovementSaving] = useState(false);
  const [castRangeDraft, setCastRangeDraft] = useState<Record<string, string> | null>(null);
  const [castRangeSaving, setCastRangeSaving] = useState(false);
  // AOI 推送口径（#1170）：同样单独一条接口；四个参数都是纯服务端消费，**重启生效**
  const [aoiDraft, setAoiDraft] = useState<Record<string, string> | null>(null);
  const [aoiSaving, setAoiSaving] = useState(false);
  // 推荐配置（#1185）：只读一份给 hint 标注与「一键还原」的确认文案用
  const [recommended, setRecommended] = useState<RecommendedRuntimeParams | null>(null);
  const [resetTarget, setResetTarget] = useState<ModuleKey | null>(null);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const row = await runtimeParamsApi.get();
      setParams(row);
      setDraft(toDraft(row));
      const ai = await runtimeParamsApi.getMonsterAi();
      setAiDraft(toAiDraft(ai));
      const movement = await runtimeParamsApi.getMovement();
      setMovementDraft(toMovementDraft(movement));
      const castRange = await runtimeParamsApi.getCastRange();
      setCastRangeDraft(toCastRangeDraft(castRange));
      const aoi = await runtimeParamsApi.getAoi();
      setAoiDraft(toAoiDraft(aoi));
      const rec = await runtimeParamsApi.getRecommended();
      setRecommended(rec);
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

  const setMovementField = (key: string, value: string) => {
    setMovementDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const saveMovement = async () => {
    if (!movementDraft) return;
    const payload = buildMovementPayload(movementDraft);
    if (!payload) return;
    setMovementSaving(true);
    try {
      const row = await runtimeParamsApi.updateMovement(payload);
      setMovementDraft(toMovementDraft(row));
      // 这一组也不走快照：移动闸每次 pos 帧现读库，切完档下一帧就按新值判
      toastSuccess("移动校验参数已保存（下一次位移判定即生效）");
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setMovementSaving(false);
    }
  };

  const setCastRangeField = (key: string, value: string) => {
    setCastRangeDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const setAoiField = (key: string, value: string) => {
    setAoiDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const saveAoi = async () => {
    if (!aoiDraft) return;
    const payload = buildAoiPayload(aoiDraft);
    if (!payload) return;
    setAoiSaving(true);
    try {
      const row = await runtimeParamsApi.updateAoi(payload);
      setAoiDraft(toAoiDraft(row));
      // 格子边长变了等于全部格子索引作废 —— 四个参数统一启动时读，保存后要重启才生效
      toastSuccess("AOI 推送口径已保存（重启服务端后生效）");
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setAoiSaving(false);
    }
  };

  //#region 一键还原至推荐配置（#1185）

  /** 七个模块的还原文案（确认弹窗与成功提示共用；生效时机与各组保存按钮一致） */
  const RESET_MODULES: Record<ModuleKey, { title: string; confirm: string; toast: string }> = {
    drop: {
      title: "还原掉落参数",
      confirm: "把掉落手感 10 个字段整体写回推荐值，当前的自定义值会被覆盖；其余模块不受影响。",
      toast: "掉落参数已还原为推荐配置（玩家下次进游戏拉配置时生效）",
    },
    autoBattle: {
      title: "还原自动战斗参数",
      confirm: "把自动战斗与寻路 15 个字段整体写回推荐值，当前的自定义值会被覆盖；其余模块不受影响。",
      toast: "自动战斗参数已还原为推荐配置（玩家下次进游戏拉配置时生效）",
    },
    guild: {
      title: "还原帮会规则",
      confirm: "把帮会规则 6 个字段整体写回推荐值（含建帮门槛 10 级 / 100000 绑定元宝），当前的自定义值会被覆盖；其余模块不受影响。",
      toast: "帮会规则已还原为推荐配置（下次建帮 / 改公告即按推荐值校验）",
    },
    monsterAi: {
      title: "还原怪物 AI 参数",
      confirm: "把怪物 AI 11 个字段整体写回推荐值（含牵引半径 600 / 回家 1.5 倍速 / 20 秒超时），当前的自定义值会被覆盖；其余模块不受影响。",
      toast: "怪物 AI 参数已还原为推荐配置（1 秒内生效，不需要玩家重进）",
    },
    movement: {
      title: "还原移动校验参数",
      confirm: "把移动校验参数整体写回推荐值（档位 log：照判照放行只记账），当前的自定义值会被覆盖；其余模块不受影响。",
      toast: "移动校验参数已还原为推荐配置（下一次位移判定即生效）",
    },
    castRange: {
      title: "还原出手距离闸参数",
      confirm: "把出手距离闸参数整体写回推荐值（档位 log、抖动余量 24px），当前的自定义值会被覆盖；其余模块不受影响。",
      toast: "出手距离闸已还原为推荐配置（下一次出手即生效）",
    },
    aoi: {
      title: "还原 AOI 推送口径",
      confirm: "把 AOI 四个参数整体写回推荐值（格子 512 / 上限 200 / 离开延迟 1 秒 / 节拍 10Hz），当前的自定义值会被覆盖；其余模块不受影响。AOI 参数重启服务端后才生效。",
      toast: "AOI 推送口径已还原为推荐配置（重启服务端后生效）",
    },
  };

  /** 七个 reset 接口与模块名的对应（返回值都是该组生效值；这里只触发，回读统一走 load） */
  const RESET_CALLS: Record<ModuleKey, () => Promise<unknown>> = {
    drop: () => runtimeParamsApi.resetDrop(),
    autoBattle: () => runtimeParamsApi.resetAutoBattle(),
    guild: () => runtimeParamsApi.resetGuild(),
    monsterAi: () => runtimeParamsApi.resetMonsterAi(),
    movement: () => runtimeParamsApi.resetMovement(),
    castRange: () => runtimeParamsApi.resetCastRange(),
    aoi: () => runtimeParamsApi.resetAoi(),
  };

  const confirmReset = async () => {
    if (!resetTarget) return;
    setResetting(true);
    try {
      await RESET_CALLS[resetTarget]();
      await load();
      toastSuccess(RESET_MODULES[resetTarget].toast);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setResetting(false);
      setResetTarget(null);
    }
  };

  /** 卡片右上角那枚「还原推荐」按钮（还原是写操作，只读角色不给） */
  const resetButton = (module: ModuleKey) =>
    canWrite ? (
      <Button variant="outline" disabled={saving !== null || resetting} onClick={() => setResetTarget(module)}>
        还原推荐
      </Button>
    ) : null;

  /** 数值字段的 hint 追加推荐值（「掉落存活时长至少 10 秒…；推荐 180000」） */
  const hintWith = (module: "drop" | "autoBattle" | "guild" | "monsterAi" | "movement" | "castRange" | "aoi", field: FieldSpec): string => {
    if (!recommended) return field.hint;
    const value = (recommended[module] as unknown as Record<string, unknown>)[field.key];
    return value === undefined ? field.hint : `${field.hint}；推荐 ${formatRecValue(value)}`;
  };

  /** 怪物 AI 的区间字段拆成了 Min / Max 两个框，从推荐值的数组里各取一端 */
  const aiHintWith = (field: FieldSpec): string => {
    if (!recommended) return field.hint;
    const pairOf: Record<string, "idleMoveInterval" | "idleMoveDuration"> = {
      idleMoveIntervalMin: "idleMoveInterval",
      idleMoveIntervalMax: "idleMoveInterval",
      idleMoveDurationMin: "idleMoveDuration",
      idleMoveDurationMax: "idleMoveDuration",
    };
    const pair = pairOf[field.key];
    if (!pair) return hintWith("monsterAi", field);
    const value = recommended.monsterAi[pair] as [number, number];
    return `${field.hint}；推荐 ${field.key.endsWith("Min") ? value[0] : value[1]}`;
  };

  /** 推荐值的展示格式：布尔 → 是 / 否，数组 → [a, b]，其余原样 */
  function formatRecValue(value: unknown): string {
    if (typeof value === "boolean") return value ? "是" : "否";
    if (Array.isArray(value)) return `[${value.join(", ")}]`;
    return String(value);
  }

  //#endregion

  const saveCastRange = async () => {
    if (!castRangeDraft) return;
    const payload = buildCastRangePayload(castRangeDraft);
    if (!payload) return;
    setCastRangeSaving(true);
    try {
      const row = await runtimeParamsApi.updateCastRange(payload);
      setCastRangeDraft(toCastRangeDraft(row));
      toastSuccess("出手距离闸已保存（下一次出手即生效）");
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setCastRangeSaving(false);
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
            {params ? <span className="ml-1 text-ink-5">上次修改：{formatTime(params.updatedAt)}</span> : null}
          </>
        }
      />

      <Card
        title="掉落手感与绑定"
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <>
              {resetButton("drop")}
              <Button disabled={!draft || saving !== null} loading={saving === "drop"} onClick={() => void save("drop")}>
                保存掉落参数
              </Button>
            </>
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
            <Field
              label="boss 掉落公告"
              hint={recommended ? `关掉就不发全服公告（只对 boss 档怪生效，30 秒最多一条）；推荐 ${recommended.drop.announceBoss ? "发公告" : "不发"}` : "关掉就不发全服公告（只对 boss 档怪生效，30 秒最多一条）"}
            >
              <Select
                value={draft.drop.announceBoss}
                disabled={!canWrite}
                onChange={(event) => setField("drop", "announceBoss", event.target.value)}
              >
                <option value="true">发公告</option>
                <option value="false">不发</option>
              </Select>
            </Field>
            {DROP_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={hintWith("drop", field)}>
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
            <>
              {resetButton("autoBattle")}
              <Button disabled={!draft || saving !== null} loading={saving === "autoBattle"} onClick={() => void save("autoBattle")}>
                保存自动战斗参数
              </Button>
            </>
          ) : null
        }
        description="超时类参数是毫秒，半径类是世界像素。网格边长调小会更贴合障碍但搜索变慢；卡住阈值调小会让自动走位更容易放弃目标。"
      >
        {draft ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="移动用跑步"
              hint={recommended ? `关闭则自动走位一律用走路速度；推荐 ${recommended.autoBattle.moveByRun ? "跑步" : "走路"}` : "关闭则自动走位一律用走路速度"}
            >
              <Select
                value={draft.autoBattle.moveByRun}
                disabled={!canWrite}
                onChange={(event) => setField("autoBattle", "moveByRun", event.target.value)}
              >
                <option value="true">跑步</option>
                <option value="false">走路</option>
              </Select>
            </Field>
            <Field
              label="经典走路模式"
              hint={
                recommended
                  ? `开启则一格一步（走完一步才走下一步，停点为格心）；推荐${recommended.autoBattle.classicWalkMode ? "开启" : "关闭（连续移动）"}`
                  : "开启则一格一步（走完一步才走下一步，停点为格心）；关闭为连续移动"
              }
            >
              <Select
                value={draft.autoBattle.classicWalkMode}
                disabled={!canWrite}
                onChange={(event) => setField("autoBattle", "classicWalkMode", event.target.value)}
              >
                <option value="true">开启（格子走动）</option>
                <option value="false">关闭（连续移动）</option>
              </Select>
            </Field>
            {AUTO_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={hintWith("autoBattle", field)}>
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
            <>
              {resetButton("guild")}
              <Button disabled={!draft || saving !== null || guildInvalid} loading={saving === "guild"} onClick={() => void save("guild")}>
                保存帮会规则
              </Button>
            </>
          ) : null
        }
        description="服务端校验读的就是这几个数：客户端提示只是提前反馈，能不能建帮 / 发公告由服务端判。"
      >
        {draft ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {GUILD_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={hintWith("guild", field)}>
                <Input
                  type="number"
                  min={0}
                  value={draft.guild[field.key] ?? ""}
                  disabled={!canWrite}
                  onChange={(event) => setField("guild", field.key, event.target.value)}
                />
              </Field>
            ))}
            {guildInvalid ? <p className="text-xs text-warn">最短字数不能大于最长字数，先改回来再保存。</p> : null}
          </div>
        ) : null}
      </Card>

      <Card
        title="怪物 AI 与脱战"
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <>
              {resetButton("monsterAi")}
              <Button disabled={!aiDraft || aiSaving || aiInvalid !== null} loading={aiSaving} onClick={() => void saveAi()}>
                保存怪物 AI 参数
              </Button>
            </>
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
              <Field key={field.key} label={field.label} hint={aiHintWith(field)}>
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
            {aiInvalid ? <p className="text-xs text-warn sm:col-span-2 lg:col-span-4">{aiInvalid}</p> : null}
          </div>
        ) : null}
      </Card>

      <Card
        title="移动校验（服务端）"
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <>
              {resetButton("movement")}
              <Button disabled={!movementDraft || movementSaving} loading={movementSaving} onClick={() => void saveMovement()}>
                保存移动校验参数
              </Button>
            </>
          ) : null
        }
        description={
          canWrite
            ? "玩家位置是客户端上报的，这三道闸是服务端自己的那把尺子：超速 / 穿墙 / 服务端寻路。出厂档位是 log（照判、照接受、只记流水），先看一周误伤率再切 enforce —— enforce 会丢弃该帧并立刻把玩家拉回权威位置。"
            : "当前角色没有「修改养成配置」权限，本页只读。"
        }
      >
        {movementDraft ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="档位"
              hint={recommended ? `off 不校验（回滚用）/ log 只记账放行（出厂）/ enforce 拒绝并拉回；推荐 ${recommended.movement.mode}` : "off 不校验（回滚用）/ log 只记账放行（出厂）/ enforce 拒绝并拉回"}
            >
              <Select
                value={movementDraft.mode}
                disabled={!canWrite}
                onChange={(event) => setMovementField("mode", event.target.value)}
              >
                <option value="off">off · 不校验</option>
                <option value="log">log · 只记账</option>
                <option value="enforce">enforce · 拒绝并拉回</option>
              </Select>
            </Field>
            <Field
              label="是否校验穿墙"
              hint={recommended ? `碰撞数据出问题时可单独关掉，不牵连速度校验；推荐 ${recommended.movement.wallCheck ? "校验" : "不校验"}` : "碰撞数据出问题时可单独关掉，不牵连速度校验"}
            >
              <Select
                value={movementDraft.wallCheck}
                disabled={!canWrite}
                onChange={(event) => setMovementField("wallCheck", event.target.value)}
              >
                <option value="true">校验</option>
                <option value="false">不校验</option>
              </Select>
            </Field>
            {MOVEMENT_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={hintWith("movement", field)}>
                <Input
                  type="number"
                  min={0}
                  step={field.step ?? 1}
                  value={movementDraft[field.key] ?? ""}
                  disabled={!canWrite}
                  onChange={(event) => setMovementField(field.key, event.target.value)}
                />
              </Field>
            ))}
          </div>
        ) : null}
      </Card>

      <Card
        title="出手距离闸（服务端）"
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <>
              {resetButton("castRange")}
              <Button disabled={!castRangeDraft || castRangeSaving} loading={castRangeSaving} onClick={() => void saveCastRange()}>
                保存距离闸参数
              </Button>
            </>
          ) : null
        }
        description={
          canWrite
            ? "判据与客户端一致：把两边的碰撞盒（角色 40×70，怪物取呈现表的 content 尺寸）换成边缘间距，再比技能的施法距离。出厂档位是 log（照判、照放行、只记流水），先跑一周确认没有误伤再切 enforce —— enforce 下超距的出手会被直接拒（玩家看到的是「点了没反应」）。"
            : "当前角色没有「修改养成配置」权限，本页只读。"
        }
      >
        {castRangeDraft ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              label="档位"
              hint={recommended ? `off 不判（回滚用）/ log 只记账放行（出厂）/ enforce 超距即拒；推荐 ${recommended.castRange.mode}` : "off 不判（回滚用）/ log 只记账放行（出厂）/ enforce 超距即拒"}
            >
              <Select
                value={castRangeDraft.mode}
                disabled={!canWrite}
                onChange={(event) => setCastRangeField("mode", event.target.value)}
              >
                <option value="off">off · 不判</option>
                <option value="log">log · 只记账</option>
                <option value="enforce">enforce · 超距即拒</option>
              </Select>
            </Field>
            {CAST_RANGE_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={hintWith("castRange", field)}>
                <Input
                  type="number"
                  min={0}
                  step={field.step ?? 1}
                  value={castRangeDraft[field.key] ?? ""}
                  disabled={!canWrite}
                  onChange={(event) => setCastRangeField(field.key, event.target.value)}
                />
              </Field>
            ))}
          </div>
        ) : null}
      </Card>

      <Card
        title="AOI 推送口径（服务端）"
        actions={
          loading ? (
            <Spinner />
          ) : canWrite ? (
            <>
              {resetButton("aoi")}
              <Button disabled={!aoiDraft || aoiSaving} loading={aoiSaving} onClick={() => void saveAoi()}>
                保存 AOI 参数
              </Button>
            </>
          ) : null
        }
        description={
          canWrite
            ? "地图数据的推送按「玩家所在格 + 周围 8 格」裁剪。四个参数彼此独立；格子边长变了等于把所有已成形的格子索引作废 —— 所以这一组**重启服务端后才生效**（API 与实时两个进程都要重启），页面上改完只落库。"
            : "当前角色没有「修改养成配置」权限，本页只读。"
        }
      >
        {aoiDraft ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {AOI_FIELDS.map((field) => (
              <Field key={field.key} label={field.label} hint={hintWith("aoi", field)}>
                <Input
                  type="number"
                  min={0}
                  value={aoiDraft[field.key] ?? ""}
                  disabled={!canWrite}
                  onChange={(event) => setAoiField(field.key, event.target.value)}
                />
              </Field>
            ))}
          </div>
        ) : null}
      </Card>

      <ConfirmDialog
        open={resetTarget !== null}
        title={resetTarget ? RESET_MODULES[resetTarget].title : ""}
        description={resetTarget ? RESET_MODULES[resetTarget].confirm : ""}
        confirmText="还原为推荐值"
        danger
        loading={resetting}
        onConfirm={() => void confirmReset()}
        onCancel={() => (resetting ? undefined : setResetTarget(null))}
      />
    </div>
  );
}

//#region 字段描述（顺序即页面上的顺序）

type GroupKey = "drop" | "autoBattle" | "guild";

/** 可单独还原的模块名（与服务端七条 reset 路由一一对应；顺序即页面卡片顺序） */
type ModuleKey = "drop" | "autoBattle" | "guild" | "monsterAi" | "movement" | "castRange" | "aoi";

/** 草稿：三组都是「键 → 字符串」（`moveByRun` 也按字符串存 "true"/"false"，统一走一个编辑器） */
type Draft = { drop: Record<string, string>; autoBattle: Record<string, string>; guild: Record<string, string> };

interface FieldSpec {
  key: string;
  label: string;
  hint: string;
}

const DROP_FIELDS: FieldSpec[] = [
  { key: "autoPickupRadius", label: "自动拾取半径（像素）", hint: "脚底距离小于它即拾取" },
  {
    key: "pickAcceptRadius",
    label: "服务端拾取距离闸（像素）",
    hint: "玩家离掉落点超过它，服务端直接拒绝拾取；0 = 关闭校验（别当出货值）",
  },
  { key: "scatterMinDistance", label: "散落最小间距（像素）", hint: "多件掉落物的同心环间距" },
  { key: "pickReplyTimeout", label: "拾取应答超时（毫秒）", hint: "超时视为本轮失败，允许重拾" },
  { key: "fullTipInterval", label: "背包满提示间隔（毫秒）", hint: "防止自动拾取时每帧刷屏" },
  { key: "bindChance", label: "随机绑定概率（%）", hint: "物品与怪物都没写「强制绑定」时，按它掷一次（服务端掉落结算读它）" },
  { key: "ttlMs", label: "掉落存活时长（毫秒）", hint: "到点从地面消失；末段不给任何提示（不闪、不显示秒数）" },
  { key: "protectMs", label: "归属保护期（毫秒）", hint: "这之前只有击杀者与掉落时的同队队友能捡；不得超过存活时长" },
  { key: "maxGroundPerMap", label: "单图地面上限（件）", hint: "超出按落下的先后挤掉最旧的；存活时长调长时建议一起调大" },
];

const AUTO_FIELDS: FieldSpec[] = [
  { key: "maxTargetDistance", label: "选目标最大距离（像素）", hint: "0 = 不限，全图取最近" },
  { key: "cellSize", label: "A* 网格边长（像素）", hint: "越小越贴合障碍、搜索越慢" },
  { key: "classicStepLength", label: "经典模式步长（像素）", hint: "经典走路模式下每一步移动的距离；点击一下走一步，按住连续走步" },
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
  { key: "createLevelMin", label: "建帮最低等级", hint: "角色等级低于它不能建帮；0 = 不限等级" },
  { key: "createCostBindGold", label: "建帮消耗（绑定元宝）", hint: "0 = 免费；扣款与建帮同一事务，扣了就一定建成" },
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
  { key: "attackActionTime", label: "普攻收招 / 施法硬直兜底（毫秒）", hint: "普攻与没配 cast_lock_ms 的技能共用；必须 ≥ 攻击动画时长（1s），配小了走位时动画会被追击打断" },
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

/** 移动校验的数值字段（档位与穿墙开关是下拉，单独画） */
const MOVEMENT_FIELDS: Array<FieldSpec & { step?: number }> = [
  { key: "maxSpeed", label: "速度上限（像素/秒）", hint: "全局尺子：上限×容差×间隔 + 抖动 就是单帧允许的位移", step: 10 },
  { key: "tolerance", label: "容差倍率", hint: "留给刚体加减速与插值；不能小于 1", step: 0.05 },
  { key: "jitterPx", label: "抖动余量（像素）", hint: "抵掉坐标取整与上报相位差" },
  { key: "correctIntervalMs", label: "拉回最小间隔（毫秒）", hint: "同一连接两次 posCorrect 至少隔这么久，防刷帧" },
];

/** 出手距离闸的数值字段（只有档位 + 一个余量：判据本身全部来自配置表） */
const CAST_RANGE_FIELDS: Array<FieldSpec & { step?: number }> = [
  { key: "jitterPx", label: "抖动余量（像素）", hint: "抵掉 10Hz 上报相位差与怪物插值滞后；出厂 24" },
];

const AOI_FIELDS: FieldSpec[] = [
  { key: "cellSize", label: "格子边长（像素）", hint: "8192² 的图按 512 切是 16×16 格；调小视野更贴合但索引更密。重启生效" },
  { key: "maxEntities", label: "单帧实体上限", hint: "一个视野里超出它只留离格心最近的 N 个，防单帧 JSON 顶爆。重启生效" },
  { key: "leaveDelayMs", label: "离开视野延迟（毫秒）", hint: "出视野先记账，期内又看见就取消 —— 站格子边界来回走不闪。重启生效" },
  { key: "broadcastHz", label: "互见广播节拍（Hz）", hint: "格子索引与进出差量每拍刷新；下限 50ms 由服务端夹。重启生效" },
];

//#endregion

//#region 草稿 ↔ 生效值

function toDraft(row: RuntimeParams): Draft {
  return {
    drop: {
      autoPickupRadius: String(row.drop.autoPickupRadius),
      pickAcceptRadius: String(row.drop.pickAcceptRadius ?? 0),
      scatterMinDistance: String(row.drop.scatterMinDistance),
      pickReplyTimeout: String(row.drop.pickReplyTimeout),
      fullTipInterval: String(row.drop.fullTipInterval),
      bindChance: String(row.drop.bindChance ?? 0),
      ttlMs: String(row.drop.ttlMs ?? 0),
      protectMs: String(row.drop.protectMs ?? 0),
      maxGroundPerMap: String(row.drop.maxGroundPerMap ?? 0),
      announceBoss: row.drop.announceBoss === false ? "false" : "true",
    },
    autoBattle: {
      moveByRun: row.autoBattle.moveByRun ? "true" : "false",
      classicWalkMode: row.autoBattle.classicWalkMode ? "true" : "false",
      classicStepLength: String(row.autoBattle.classicStepLength),
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
      createLevelMin: String(row.guild.createLevelMin ?? 0),
      createCostBindGold: String(row.guild.createCostBindGold ?? 0),
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
    const pickAcceptRadius = num("pickAcceptRadius");
    const scatterMinDistance = num("scatterMinDistance");
    const pickReplyTimeout = num("pickReplyTimeout");
    const fullTipInterval = num("fullTipInterval");
    const bindChance = num("bindChance");
    const ttlMs = num("ttlMs");
    const protectMs = num("protectMs");
    const maxGroundPerMap = num("maxGroundPerMap");
    if (
      autoPickupRadius === null ||
      pickAcceptRadius === null ||
      scatterMinDistance === null ||
      pickReplyTimeout === null ||
      fullTipInterval === null ||
      bindChance === null ||
      ttlMs === null ||
      protectMs === null ||
      maxGroundPerMap === null
    ) {
      return null;
    }
    return {
      drop: {
        autoPickupRadius,
        pickAcceptRadius,
        scatterMinDistance,
        pickReplyTimeout,
        fullTipInterval,
        bindChance,
        ttlMs,
        protectMs,
        maxGroundPerMap,
        announceBoss: values.announceBoss === "true",
      },
    };
  }
  if (group === "guild") {
    const nameMin = num("nameMin");
    const nameMax = num("nameMax");
    const noticeMax = num("noticeMax");
    const applicationMessageMax = num("applicationMessageMax");
    const createLevelMin = num("createLevelMin");
    const createCostBindGold = num("createCostBindGold");
    if (
      nameMin === null ||
      nameMax === null ||
      noticeMax === null ||
      applicationMessageMax === null ||
      createLevelMin === null ||
      createCostBindGold === null
    ) {
      return null;
    }
    return { guild: { nameMin, nameMax, noticeMax, applicationMessageMax, createLevelMin, createCostBindGold } };
  }
  const maxTargetDistance = num("maxTargetDistance");
  const cellSize = num("cellSize");
  const classicStepLength = num("classicStepLength");
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
    classicStepLength === null ||
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
      classicWalkMode: values.classicWalkMode === "true",
      classicStepLength,
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

//#region 两道校验闸的草稿 ↔ 生效值

/** 移动校验生效值 → 草稿（模式与开关统一按字符串存，与上面三组共用同一套编辑器） */
function toMovementDraft(row: MovementGuardParams): Record<string, string> {
  return {
    mode: row.mode,
    wallCheck: row.wallCheck ? "true" : "false",
    maxSpeed: String(row.maxSpeed),
    tolerance: String(row.tolerance),
    jitterPx: String(row.jitterPx),
    correctIntervalMs: String(row.correctIntervalMs),
  };
}

/** 移动校验草稿 → 提交体（有一处不是数字就整组不提交） */
function buildMovementPayload(values: Record<string, string>): UpdateMovementGuardParams | null {
  const num = (key: string): number | null => {
    const raw = values[key];
    const parsed = Number(raw);
    return raw !== undefined && raw.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
  };
  const maxSpeed = num("maxSpeed");
  const tolerance = num("tolerance");
  const jitterPx = num("jitterPx");
  const correctIntervalMs = num("correctIntervalMs");
  if (maxSpeed === null || tolerance === null || jitterPx === null || correctIntervalMs === null) return null;
  const mode = values.mode === "off" || values.mode === "enforce" ? values.mode : "log";
  return { mode, wallCheck: values.wallCheck === "true", maxSpeed, tolerance, jitterPx, correctIntervalMs };
}

/** 出手距离闸生效值 → 草稿 */
function toCastRangeDraft(row: CastRangeParams): Record<string, string> {
  return { mode: row.mode, jitterPx: String(row.jitterPx) };
}

/** 出手距离闸草稿 → 提交体 */
function buildCastRangePayload(values: Record<string, string>): UpdateCastRangeParams | null {
  const jitterPx = Number(values.jitterPx);
  if (values.jitterPx === undefined || values.jitterPx.trim() === "" || !Number.isFinite(jitterPx)) return null;
  const mode = values.mode === "off" || values.mode === "enforce" ? values.mode : "log";
  return { mode, jitterPx };
}

//#endregion

//#region AOI 推送口径（#1170）

/** AOI 生效值 → 草稿 */
function toAoiDraft(row: AoiParams): Record<string, string> {
  return {
    cellSize: String(row.cellSize),
    maxEntities: String(row.maxEntities),
    leaveDelayMs: String(row.leaveDelayMs),
    broadcastHz: String(row.broadcastHz),
  };
}

/** AOI 草稿 → 提交体（有一处不是数字就整组不提交） */
function buildAoiPayload(values: Record<string, string>): UpdateAoiParams | null {
  const num = (key: string): number | null => {
    const raw = values[key];
    const parsed = Number(raw);
    return raw !== undefined && raw.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
  };
  const cellSize = num("cellSize");
  const maxEntities = num("maxEntities");
  const leaveDelayMs = num("leaveDelayMs");
  const broadcastHz = num("broadcastHz");
  if (cellSize === null || maxEntities === null || leaveDelayMs === null || broadcastHz === null) return null;
  return { cellSize, maxEntities, leaveDelayMs, broadcastHz };
}

//#endregion
