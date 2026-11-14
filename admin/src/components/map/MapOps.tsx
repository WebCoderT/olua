import { useEffect, useState } from "react";
import type { MapReloadBatch, MapReloadResult, MapRules, SaveMapRules } from "../../api";
import { mapsApi, PERMISSION } from "../../api";
import { hasPermission } from "../../store/session";
import { toastSuccess } from "../../store/toast";
import { Modal } from "../Modal";
import { Badge, Button, EmptyState, Field as FormField, Input, Notice, Select, Spinner } from "../ui";

/**
 * 地图运营弹窗（#809）：单图热重载 + 地图玩法规则
 *
 * ## 为什么是两个独立弹窗而不是一个「运营面板」
 *
 * 它们的**使用节奏完全不同**：
 * - 重载是「改完刷怪区 → 立刻点一下」的一次性动作，弹窗里最重要的是**回执**
 *   （哪些区排了队、哪些区立刻执行、到几点强制）；
 * - 规则是「坐下来慢慢调」的表单，弹窗里最重要的是**控件分组**（倍率 / 开关 / 容量与传送）。
 *   挤在一个弹窗里，两边都显得又长又急。
 *
 * ## 权限
 *
 * 两个动作都挂在 `gameConfig:write` 上（与服务端 `@ApiAdminDoc` 的 `permissions` 同一口径）：
 * 只有读权限的管理员能打开规则弹窗看数值，但保存按钮置灰。
 */

/** 毫秒时间戳 → 本地 `HH:MM`（回执里「到几点强制」不需要秒） */
function clockMinute(at: number): string {
  const date = new Date(at);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `plan` 的人话：管理端进程读不到实时进程的世界内存，这里给的是「会不会排队」 */
function planOf(item: MapReloadResult): { label: string; tone: "jade" | "warn" } {
  if (item.plan === "immediate") return { label: "下一轮就执行（房里没人 / 立刻模式）", tone: "jade" };
  return { label: "有人在线，先排队等空窗", tone: "warn" };
}

/** 提交重载后的按区回执（每个存活区一条 —— 刷怪区是全服共用配置，但世界按区分份） */
function ReloadReceipt({ batch }: { batch: MapReloadBatch }) {
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-ink-3">
        提交结果
        <Badge tone={batch.items.some((item) => item.merged) ? "warn" : "jade"}>
          {batch.items.length} 个存活区
        </Badge>
      </div>
      {batch.items.map((item) => {
        const plan = planOf(item);
        return (
          <div key={item.roomId} className="rounded-xl border border-line bg-surface-2/40 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="font-mono text-ink-3">{item.roomId}</span>
              {item.merged ? <Badge tone="warn">已并入 pending</Badge> : null}
              <Badge tone={item.mode === "reload" ? "ember" : "muted"}>
                {item.mode === "reload" ? "整体重载" : "只重播"}
              </Badge>
              <Badge tone={plan.tone}>{plan.label}</Badge>
            </div>
            <p className="mt-1 text-[11px] text-ink-5">
              {item.plan === "queued" ? (
                <>
                  排队截止 <span className="font-mono text-ink-4">{clockMinute(item.forceAt)}</span>
                  （到点房里还有人也会强制重刷；房里先空出来就立刻执行）
                </>
              ) : (
                <>实时进程下一个轮询周期执行，房里的人会收到一帧 world.reload</>
              )}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function ReloadWorldDialog({
  open,
  mapId,
  mapLabel,
  onClose,
}: {
  open: boolean;
  mapId: string;
  mapLabel: string;
  onClose: () => void;
}) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [mode, setMode] = useState<"respawn" | "reload">("respawn");
  /** 空串 = 用出厂 5 分钟；填 0 = 立刻强制（房里有人也马上重刷） */
  const [forceAfter, setForceAfter] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [batch, setBatch] = useState<MapReloadBatch | null>(null);

  // 重新打开：上次的结果清掉（回执描述的是「上一次点击」，挂在旧结果上会误导）
  useEffect(() => {
    if (open) {
      setBatch(null);
      setMode("respawn");
      setForceAfter("");
    }
  }, [open, mapId]);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const body = {
        mode,
        slot: "0",
        ...(forceAfter === "" ? {} : { forceAfterMs: Math.max(0, Math.floor(Number(forceAfter))) }),
      };
      const next = await mapsApi.reloadWorld(mapId, body);
      setBatch(next);
      toastSuccess(
        `重载请求已提交：${next.items.length} 个存活区${next.items.some((item) => item.merged) ? "（部分并入已排队的请求）" : ""}`,
      );
    } catch {
      /* 错误已由请求层统一提示（图不存在 / 权限不足都有中文文案） */
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`重载世界 · ${mapLabel || `#${mapId}`}`}
      hint="让这张图的房间按**现在**的刷怪区重新播种（#809）。不点它也不会错 —— 下次有人进图会按新区域播种，只是在图里的玩家会继续看到改之前的怪。"
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={submitting} onClick={onClose}>
            关闭
          </Button>
          <Button disabled={submitting || !canWrite} loading={submitting} onClick={() => void submit()}>
            提交重载请求
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!canWrite ? <Notice tone="warn">你只有配置读权限 —— 可以看回执，不能提交重载。</Notice> : null}
        <FormField label="重载模式" hint="reload 连 AI 运行时一起重载，怪整体重刷一次（掉落 / 血量不保留）；respawn 只按新刷怪区对齐数量。">
          <Select value={mode} onChange={(event) => setMode(event.target.value === "reload" ? "reload" : "respawn")}>
            <option value="respawn">respawn · 按新刷怪区重播（可等空窗）</option>
            <option value="reload">reload · 整体重载（立刻执行）</option>
          </Select>
        </FormField>
        {mode === "respawn" ? (
          <FormField
            label="等空窗的上限（毫秒）"
            hint="房里没人就立刻执行；有人就排队，到这个上限强制重刷（客户端会收到 forced 通知）。留空 = 出厂 5 分钟；填 0 = 立刻强制。"
          >
            <Input
              type="number"
              min={0}
              step={1000}
              placeholder="300000"
              value={forceAfter}
              onChange={(event) => setForceAfter(event.target.value)}
            />
          </FormField>
        ) : null}
        <p className="text-[11px] text-ink-5">
          一次发给<b>每一个存活区</b>（每个区各有一份这张图的世界）。重复提交会与已排队的请求合并，不会刷两次。
          其它图、其它区的世界完全不受影响。
        </p>
        {batch ? <ReloadReceipt batch={batch} /> : null}
      </div>
    </Modal>
  );
}

/** 表单里数值字段的形状（string 便于输入框编辑，提交时再转数字） */
interface RulesForm {
  expRate: string;
  dropRate: string;
  moneyRate: string;
  maxPlayersPerRoom: string;
  maxChannels: string;
  transferCostMoney: string;
  transferCooldownMs: string;
  respawnMsOverride: string;
  allowPk: boolean;
  allowAutoBattle: boolean;
  allowRecall: boolean;
  allowDrop: boolean;
  denyTransferInCombat: boolean;
  simulateWhenEmpty: boolean;
}

function formOf(rules: MapRules): RulesForm {
  return {
    expRate: String(rules.expRate),
    dropRate: String(rules.dropRate),
    moneyRate: String(rules.moneyRate),
    maxPlayersPerRoom: String(rules.maxPlayersPerRoom),
    maxChannels: String(rules.maxChannels),
    transferCostMoney: String(rules.transferCostMoney),
    transferCooldownMs: String(rules.transferCooldownMs),
    // null（继承全局）显示为空串 —— 「没填」与「0 毫秒」是两回事
    respawnMsOverride: rules.respawnMsOverride === null ? "" : String(rules.respawnMsOverride),
    allowPk: rules.allowPk,
    allowAutoBattle: rules.allowAutoBattle,
    allowRecall: rules.allowRecall,
    allowDrop: rules.allowDrop,
    denyTransferInCombat: rules.denyTransferInCombat,
    simulateWhenEmpty: rules.simulateWhenEmpty,
  };
}

/** 数字输入的解析：空 / 非法一律回退到当前值（提交前每格都有独立校验，这里只做兜底） */
function numOr(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 一个开关（checkbox + 说明 —— 说明比标题更重要，开关本身谁都会点） */
function RuleToggle({
  checked,
  title,
  hint,
  disabled,
  onChange,
}: {
  checked: boolean;
  title: string;
  hint: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface-2/40 px-2.5 py-2 text-xs ${disabled ? "cursor-not-allowed opacity-60" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-gold"
      />
      <span>
        <span className="text-ink-2">{title}</span>
        <span className="block text-[10px] leading-4 text-ink-5">{hint}</span>
      </span>
    </label>
  );
}

export function MapRulesDialog({
  open,
  mapId,
  mapLabel,
  onClose,
}: {
  open: boolean;
  mapId: string;
  mapLabel: string;
  onClose: () => void;
}) {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [rules, setRules] = useState<MapRules | null>(null);
  const [form, setForm] = useState<RulesForm | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时拉一次当前规则；换图重开时旧表单清掉
  useEffect(() => {
    if (!open) return;
    setRules(null);
    setForm(null);
    setError(null);
    setLoading(true);
    mapsApi
      .rules(mapId)
      .then((next) => {
        setRules(next);
        setForm(formOf(next));
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "拉取规则失败"))
      .finally(() => setLoading(false));
  }, [open, mapId]);

  const patch = <K extends keyof RulesForm>(key: K, value: RulesForm[K]) => {
    setForm((previous) => (previous ? { ...previous, [key]: value } : previous));
  };

  const save = async () => {
    if (!form || saving) return;
    setSaving(true);
    try {
      const expRate = numOr(form.expRate, 1);
      const dropRate = numOr(form.dropRate, 1);
      const moneyRate = numOr(form.moneyRate, 1);
      const respawn = form.respawnMsOverride.trim();
      const body: SaveMapRules = {
        expRate,
        dropRate,
        moneyRate,
        allowPk: form.allowPk,
        allowAutoBattle: form.allowAutoBattle,
        allowRecall: form.allowRecall,
        allowDrop: form.allowDrop,
        maxPlayersPerRoom: Math.max(0, Math.floor(numOr(form.maxPlayersPerRoom, 0))),
        maxChannels: Math.max(1, Math.floor(numOr(form.maxChannels, 1))),
        transferCostMoney: Math.max(0, Math.floor(numOr(form.transferCostMoney, 0))),
        transferCooldownMs: Math.max(0, Math.floor(numOr(form.transferCooldownMs, 0))),
        denyTransferInCombat: form.denyTransferInCombat,
        // 空串 = 显式回退到「继承全局」；数字 = 这张图自己的重生时长
        respawnMsOverride: respawn === "" ? null : Math.max(0, Math.floor(numOr(respawn, 0))),
        simulateWhenEmpty: form.simulateWhenEmpty,
      };
      const saved = await mapsApi.saveRules(mapId, body);
      setRules(saved);
      setForm(formOf(saved));
      toastSuccess(`「${mapLabel || mapId}」的玩法规则已保存`);
    } catch {
      /* 错误已由请求层统一提示（越界数值 / 权限不足都有中文文案） */
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (saving) return;
    onClose();
  };

  return (
    <Modal
      open={open}
      title={`玩法规则 · ${mapLabel || `#${mapId}`}`}
      hint="map_rules 一行（#809）：结算倍率只在服务端乘（不进客户端快照）；开关与容量实时生效。一行不存在 = 全默认（inherited）。"
      size="lg"
      onClose={close}
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={close}>
            取消
          </Button>
          <Button disabled={!form || saving || !canWrite} loading={saving} onClick={() => void save()}>
            保存（整份覆盖）
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-xs text-ink-5">
          <Spinner /> 读取当前规则…
        </div>
      ) : error ? (
        <Notice tone="ember" title="拉不到规则">
          {error}
        </Notice>
      ) : !rules || !form ? (
        <EmptyState title="没有数据" />
      ) : (
        <div className="space-y-4">
          {rules.inherited ? (
            <Notice tone="warn">
              这张图<b>没有单独的规则行</b>（inherited）—— 下面显示的全是出厂默认值。保存后才会落一行；
              在那之前改全局默认值，这张图会跟着变。
            </Notice>
          ) : (
            <div className="text-[11px] text-ink-5">
              这张图有<b className="text-ink-3">单独的规则行</b>
              {rules.updatedBy ? <>（最后由 {rules.updatedBy} 修改）</> : null}。
            </div>
          )}

          <section>
            <h4 className="mb-1.5 text-xs font-medium text-ink-3">结算倍率（服务端结算时乘）</h4>
            <div className="grid grid-cols-3 gap-2">
              <FormField label="经验">
                <Input type="number" min={0} max={100} step={0.1} value={form.expRate} onChange={(event) => patch("expRate", event.target.value)} />
              </FormField>
              <FormField label="掉落">
                <Input type="number" min={0} max={100} step={0.1} value={form.dropRate} onChange={(event) => patch("dropRate", event.target.value)} />
              </FormField>
              <FormField label="金钱">
                <Input type="number" min={0} max={100} step={0.1} value={form.moneyRate} onChange={(event) => patch("moneyRate", event.target.value)} />
              </FormField>
            </div>
          </section>

          <section>
            <h4 className="mb-1.5 text-xs font-medium text-ink-3">规则开关</h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <RuleToggle checked={form.allowPk} hint="允许同图玩家互相攻击" title="允许 PK" disabled={!canWrite} onChange={(next) => patch("allowPk", next)} />
              <RuleToggle checked={form.allowAutoBattle} hint="关闭后这张图的自动挂机不生效" title="允许自动挂机" disabled={!canWrite} onChange={(next) => patch("allowAutoBattle", next)} />
              <RuleToggle checked={form.allowRecall} hint="允许被拉人 / 回城" title="允许召回" disabled={!canWrite} onChange={(next) => patch("allowRecall", next)} />
              <RuleToggle checked={form.allowDrop} hint="false = 活动图：怪倒了不掉东西" title="这张图掉落物品" disabled={!canWrite} onChange={(next) => patch("allowDrop", next)} />
              <RuleToggle checked={form.denyTransferInCombat} hint="战斗中禁止传送出图" title="战斗中禁传送" disabled={!canWrite} onChange={(next) => patch("denyTransferInCombat", next)} />
              <RuleToggle checked={form.simulateWhenEmpty} hint="没人时也 tick（泡点 / 定时事件图用）；关着 = 冻结省 CPU" title="无人时继续跑世界" disabled={!canWrite} onChange={(next) => patch("simulateWhenEmpty", next)} />
            </div>
          </section>

          <section>
            <h4 className="mb-1.5 text-xs font-medium text-ink-3">容量与传送</h4>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <FormField label="单房人数上限">
                <Input type="number" min={0} max={1000} value={form.maxPlayersPerRoom} onChange={(event) => patch("maxPlayersPerRoom", event.target.value)} />
              </FormField>
              <FormField label="分线数量上限">
                <Input type="number" min={1} max={20} value={form.maxChannels} onChange={(event) => patch("maxChannels", event.target.value)} />
              </FormField>
              <FormField label="传送花费（铜钱）">
                <Input type="number" min={0} value={form.transferCostMoney} onChange={(event) => patch("transferCostMoney", event.target.value)} />
              </FormField>
              <FormField label="传送冷却（毫秒）">
                <Input type="number" min={0} step={1000} value={form.transferCooldownMs} onChange={(event) => patch("transferCooldownMs", event.target.value)} />
              </FormField>
            </div>
            <FormField
              label="这张图的重生时长（毫秒）"
              hint="留空 = 继承全局 worldRespawnMs；填了就覆盖中间级重生时长（活动图重刷快一点用）"
            >
              <Input
                type="number"
                min={0}
                step={1000}
                placeholder="继承全局"
                value={form.respawnMsOverride}
                onChange={(event) => patch("respawnMsOverride", event.target.value)}
              />
            </FormField>
          </section>

          <p className="text-[11px] text-ink-5">
            保存是<b>整份覆盖</b>：没提到的字段按页面上显示的值落库。容量与传送开关在下次进图 / 传送校验时生效；
            倍率在下一笔结算就生效。
          </p>
        </div>
      )}
    </Modal>
  );
}
