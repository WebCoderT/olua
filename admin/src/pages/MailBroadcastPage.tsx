import { useCallback, useEffect, useMemo, useState } from "react";
import { gameMailsApi, PERMISSION, zonesApi } from "../api";
import type { BroadcastPreviewResult, BroadcastView } from "../api";
import { PageHeader } from "../components/PageHeader";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EntityPickButton } from "../components/entity/EntityPickButton";
import { entityOptions } from "../components/entity/catalog";
import type { EntityOption } from "../components/entity/catalog";
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { formatTime } from "../api";
import { hasPermission, readZoneId } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 消息群发（#438）
 *
 * 一个批次 = 一次点击，落进**每个角色**的收件箱各一封（与单发同一个落库口子）。
 * 三件运营必须知道的事，界面上都要说清：
 * - **不可撤回**：发出去就归玩家（#437 的口径），所以发送走二次确认；
 * - **`batchId` 是幂等的钥匙**：进页面生成一次，发送成功才换新的 —— 网络断了重试同一个号
 *   不会让玩家多收一封；这也是「重试」按钮能直接复用同一个批号的原因；
 * - **人数先看再发**：预估与真正发送用同一套筛选条件（服务端同一个方法），
 *   所以「预计 N 人」与实际写入的封数应当一致，不一致只说明期间有人建号 / 删号。
 *
 * ```
 * __UI_CAPTURE__（截图清单 —— 截图工具按 id 逐状态出图，供人眼审；纪律：显示效果不写断言）
 *   form         表单空态：范围 / 等级段 / 内容 / 附件
 *   previewed    预估过人数：人数的展示与「再发」提示
 *   sent         发送结果：批次号 / 目标 / 实发 / 完成时刻
 *   history      批次列表：有历史批次时的表格（含「中断」徽章的那一行）
 *   readonly     无权限：发送与预估按钮置灰 + 提示条
 * ```
 */

/** 附件候选：与单发页同一份（物品总表 + 时装） */
function attachOptions(): EntityOption[] {
  return [...entityOptions("item"), ...entityOptions("fashion")];
}

interface ItemLine {
  goodId: string;
  count: string;
}

/** 浏览器原生 uuid：服务端要求 8~64 位字母 / 数字 / - / _ */
function newBatchId(): string {
  return crypto.randomUUID();
}

export function MailBroadcastPage() {
  const canBroadcast = hasPermission(PERMISSION.GAME_MAIL_BROADCAST);
  const canBroadcastAll = hasPermission(PERMISSION.GAME_MAIL_BROADCAST_ALL);
  const currentZoneId = readZoneId();
  const options = useMemo(attachOptions, []);

  // 表单
  const [scope, setScope] = useState<"zone" | "all">("zone");
  const [minLevel, setMinLevel] = useState("");
  const [maxLevel, setMaxLevel] = useState("");
  const [channel, setChannel] = useState<string>("reward");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [bindGold, setBindGold] = useState("");
  const [exp, setExp] = useState("");
  const [items, setItems] = useState<ItemLine[]>([]);

  // 批次号：进页面一个，发送成功换一个（失败保留 = 重试幂等）
  const [batchId, setBatchId] = useState(newBatchId);

  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<BroadcastPreviewResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<BroadcastView | null>(null);

  const [history, setHistory] = useState<BroadcastView[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [zoneNames, setZoneNames] = useState<Record<number, string>>({});

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      setHistory(await gameMailsApi.broadcasts());
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    if (canBroadcast) void loadHistory();
    else setLoadingHistory(false);
  }, [canBroadcast, loadHistory]);

  // 区名只用来显示（批次列表刻意跨区，得说清「这批发在哪个区」）
  useEffect(() => {
    let alive = true;
    void zonesApi
      .list()
      .then((list) => {
        if (!alive) return;
        const map: Record<number, string> = {};
        for (const zone of list) map[zone.id] = zone.name;
        setZoneNames(map);
      })
      .catch(() => {
        /* 拿不到区名就退化成 id，不影响发送 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const currentZoneName = (currentZoneId !== null ? zoneNames[currentZoneId] : undefined) ?? "当前区";

  /** 空串 = 不传；「没填」与「填了 0」在等级段里都表示不限（等级从 1 起，0 没有意义） */
  const numeric = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    const value = Number(trimmed);
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
  };

  const range = { minLevel: numeric(minLevel), maxLevel: numeric(maxLevel) };
  const rangeInvalid = range.minLevel !== undefined && range.maxLevel !== undefined && range.minLevel > range.maxLevel;

  const buildMail = () => ({
    batchId,
    scope,
    minLevel: range.minLevel,
    maxLevel: range.maxLevel,
    channel: channel as "system" | "reward",
    title: title.trim(),
    body: body.trim() || undefined,
    bindGold: numeric(bindGold),
    exp: numeric(exp),
    items: items
      .filter((line) => line.goodId.trim() && Number(line.count) >= 1)
      .map((line) => ({ goodId: line.goodId.trim(), count: Math.floor(Number(line.count)) })),
  });

  /** 预估：只发范围与等级段，正文没写也能先看人数（服务端就是这么设计的） */
  const runPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await gameMailsApi.previewBroadcast({ scope, ...range }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setPreviewing(false);
    }
  };

  const submit = async () => {
    setConfirming(false);
    setSending(true);
    try {
      const result = await gameMailsApi.broadcast(buildMail());
      setSent(result);
      setPreview(null);
      if (result.duplicated) {
        // 批次号重了 = 这批之前已经发过，页面不该装作「刚发出去」
        toastSuccess(`批次 ${result.batchId} 之前已经发过，本次没有再写任何一封`);
      } else {
        toastSuccess(`已写入 ${result.sentCount} 封（批次 ${result.batchId}）`);
        // 只有真的发出去了才换批号：失败时保留，重试才是幂等的
        setBatchId(newBatchId());
        setTitle("");
        setBody("");
        setBindGold("");
        setExp("");
        setItems([]);
      }
      void loadHistory();
    } catch {
      /* 错误已由请求层统一提示；batchId 保持不变，重试不会重复发 */
    } finally {
      setSending(false);
    }
  };

  const canSubmit = canBroadcast && !!title.trim() && !sending && !rangeInvalid && (scope === "zone" || canBroadcastAll);

  const scopeText = (row: BroadcastView) => {
    if (row.filter.scope === "all") return "全服";
    const zoneId = row.filter.zoneId;
    return zoneId === null ? "区已未知" : (zoneNames[zoneId] ?? `区 #${zoneId}`);
  };

  const levelText = (row: BroadcastView) => {
    const { minLevel: min, maxLevel: max } = row.filter;
    if (min === undefined && max === undefined) return "不限";
    if (min !== undefined && max !== undefined) return `${min} ~ ${max} 级`;
    return min !== undefined ? `${min} 级以上` : `${max} 级以下`;
  };

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <PageHeader
        title="消息群发"
        description="一次给一批角色各发一封游戏内消息（收件箱「系统 / 奖励」两栏）。邮件不可撤回；附件要玩家点领取才真的到手。"
      />

      {canBroadcast ? null : <Notice tone="warn">当前管理员角色没有 gameMail:broadcast 权限点，这一页只能看不能发。</Notice>}

      <Card className="flex flex-col gap-4 p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="投放范围"
            hint={canBroadcastAll ? undefined : "「全服」需要超级管理员权限；没有就一个区一个区地发"}
          >
            <Select value={scope} onChange={(event) => setScope(event.target.value === "all" ? "all" : "zone")} disabled={!canBroadcast}>
              <option value="zone">当前区（{currentZoneName}）</option>
              <option value="all" disabled={!canBroadcastAll}>
                全服（所有区）
              </option>
            </Select>
          </Field>
          <Field label="最低等级（可选）" hint="含本级；留空 = 不限">
            <Input type="number" min={1} value={minLevel} onChange={(event) => setMinLevel(event.target.value)} placeholder="例如 30" disabled={!canBroadcast} />
          </Field>
          <Field label="最高等级（可选）" hint="含本级；留空 = 不限">
            <Input type="number" min={1} value={maxLevel} onChange={(event) => setMaxLevel(event.target.value)} placeholder="例如 60" disabled={!canBroadcast} />
          </Field>
        </div>

        {rangeInvalid ? <Notice tone="ember">最低等级不能大于最高等级 —— 填反了会「成功发送 0 封」。</Notice> : null}

        {scope === "all" ? (
          <Notice tone="warn">
            这一批会打进 <span className="font-medium">所有区</span> 的玩家收件箱：一次几万封，且不可撤回。
            只想补偿某个区，把范围换成「当前区」。
          </Notice>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="频道" hint="social / combat 是系统事实记录，不开放人工群发">
            <Select value={channel} onChange={(event) => setChannel(event.target.value)} disabled={!canBroadcast}>
              <option value="reward">奖励（reward）</option>
              <option value="system">系统（system）</option>
            </Select>
          </Field>
          <Field label="批次号" hint="自动生成；发送失败重试会沿用同一个号，不会重复发">
            <Input value={batchId} readOnly className="font-mono text-xs" />
          </Field>
        </div>

        <Field label="标题" hint="最长 60 字">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={60} placeholder="开服福利" disabled={!canBroadcast} />
        </Field>

        <Field label="正文（可选）" hint="纯文本，最长 1000 字">
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={1000}
            rows={4}
            placeholder="写点说明，玩家在消息中心能看到。"
            disabled={!canBroadcast}
            className="w-full rounded-lg border border-line-strong bg-surface-2/60 px-3 py-2 text-sm text-ink-1 outline-none placeholder:text-ink-6 focus:border-gold disabled:opacity-50"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="附件绑定元宝（可选）">
            <Input type="number" min={0} value={bindGold} onChange={(event) => setBindGold(event.target.value)} placeholder="不填 = 没有" disabled={!canBroadcast} />
          </Field>
          <Field label="附件经验（可选）">
            <Input type="number" min={0} value={exp} onChange={(event) => setExp(event.target.value)} placeholder="不填 = 没有" disabled={!canBroadcast} />
          </Field>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-ink-4">附件物品（可选，最多 20 条）</p>
            <Button variant="outline" onClick={() => setItems((prev) => [...prev, { goodId: "", count: "1" }])} disabled={!canBroadcast || items.length >= 20}>
              加一件
            </Button>
          </div>
          {items.length === 0 ? (
            <p className="text-xs text-ink-6">没有物品附件 —— 纯通知、只发元宝 / 经验也都可以。</p>
          ) : (
            items.map((line, index) => (
              <div key={index} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <EntityPickButton
                    value={line.goodId}
                    options={options}
                    kind="item"
                    pickerTitle={`选择第 ${index + 1} 件附件`}
                    hint="物品（装备 / 药品 / 材料）与时装都在这里；玩家点领取才真的到手。"
                    emptyHint="附件清单是空的 —— 确认客户端配置已生成"
                    disabled={!canBroadcast}
                    onChange={(goodId) => setItems((prev) => prev.map((item, i) => (i === index ? { ...item, goodId } : item)))}
                  />
                </div>
                <Input
                  type="number"
                  min={1}
                  value={line.count}
                  onChange={(event) => setItems((prev) => prev.map((item, i) => (i === index ? { ...item, count: event.target.value } : item)))}
                  className="w-24 shrink-0"
                  disabled={!canBroadcast}
                />
                <Button variant="ghost" onClick={() => setItems((prev) => prev.filter((_, i) => i !== index))} disabled={!canBroadcast}>
                  删除
                </Button>
              </div>
            ))
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={runPreview} disabled={!canBroadcast || previewing || rangeInvalid}>
            {previewing ? "统计中…" : "预估影响人数"}
          </Button>
          <Button variant="primary" onClick={() => setConfirming(true)} disabled={!canSubmit}>
            {sending ? "发送中…" : "群发"}
          </Button>
          {preview ? (
            <p className="text-sm text-ink-3">
              预计影响 <span className="legend-num text-gold">{preview.targetCount}</span> 个角色
              {preview.zoneIds.length > 1 ? `（覆盖 ${preview.zoneIds.length} 个区）` : null}
            </p>
          ) : null}
        </div>
      </Card>

      {sent ? (
        <Card className="flex flex-col gap-2 p-5">
          <p className={`text-sm font-medium ${sent.duplicated ? "text-warn" : "text-jade"}`}>
            {sent.duplicated ? "这个批次号之前已经发过，本次没有再写任何一封" : "已写入收件箱"}
          </p>
          <p className="text-xs text-ink-4">
            批次号 <span className="font-mono text-ink-2">{sent.batchId}</span> · 目标 {sent.targetCount} 人 · 实发 {sent.sentCount} 封 ·{" "}
            {sent.finishedAt === null ? "写入中断（已完成的部分算数，未完成的不补）" : `完成于 ${formatTime(sent.finishedAt)}`}
          </p>
        </Card>
      ) : null}

      <Card
        title="最近批次"
        description="最近 50 批（跨区可见）。实发与目标不等只说明发送期间有人建号 / 删号；没有完成时刻的那一行是写到一半中断的批次。"
        actions={loadingHistory ? <Spinner /> : null}
      >
        {history !== null && history.length === 0 ? (
          <EmptyState title="还没有群发记录" description="发出去的每一批都会在这里留一行，含批次号与实发封数。" />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableClass}>
              <thead className={theadClass}>
                <tr>
                  <th className={thClass}>批次号</th>
                  <th className={thClass}>范围</th>
                  <th className={thClass}>等级段</th>
                  <th className={thClass}>标题</th>
                  <th className={`${thClass} text-right`}>目标 / 实发</th>
                  <th className={thClass}>操作人</th>
                  <th className={thClass}>状态</th>
                  <th className={thClass}>发起时间</th>
                </tr>
              </thead>
              <tbody>
                {(history ?? []).map((row) => (
                  <tr key={row.batchId} className="transition hover:bg-surface-4/30">
                    <td className={`${tdClass} font-mono text-xs text-ink-3`}>{row.batchId}</td>
                    <td className={tdClass}>{scopeText(row)}</td>
                    <td className={tdClass}>{levelText(row)}</td>
                    <td className={`${tdClass} font-medium text-ink-1`}>{row.title}</td>
                    <td className={`${tdClass} legend-num text-right text-ink-3`}>
                      {row.targetCount} / {row.sentCount}
                    </td>
                    <td className={tdClass}>{row.operatorName || "—"}</td>
                    <td className={tdClass}>
                      {row.finishedAt === null ? <Badge tone="warn">中断</Badge> : <Badge tone="jade">已完成</Badge>}
                    </td>
                    <td className={`${tdClass} legend-num text-ink-4`}>{formatTime(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirming}
        title="确认群发？"
        description={`范围：${scope === "all" ? "全服（所有区）" : `当前区（${currentZoneName}）`}${
          preview ? `，预计影响 ${preview.targetCount} 个角色` : ""
        }。邮件发出后不可撤回。`}
        confirmText="确认群发"
        loading={sending}
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
