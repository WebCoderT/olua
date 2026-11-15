import { useEffect, useState } from "react";
import type { MapInstance, MapInstanceList } from "../../api";
import { mapInstancesApi, PERMISSION } from "../../api";
import { hasPermission } from "../../store/session";
import { toastSuccess } from "../../store/toast";
import { ConfirmDialog } from "../ConfirmDialog";
import { Modal } from "../Modal";
import { Badge, Button, EmptyState, Field as FormField, Input, Notice, Spinner } from "../ui";

/**
 * 副本弹窗（#1001 第二刀 / docs/20 §2.8）
 *
 * ## 为什么单独一个弹窗，而不是并进「玩法规则」
 *
 * 规则是**这张图以后一直怎么运作**；副本是**现在开一场、过一会儿就没了**。
 * 前者的表单里改错一个数字影响很久，后者改错只是这一场的事 —— 混在一起会让运营
 * 对「我这一下改的是永久还是临时」失去判断。何况副本的入口/收场是动作按钮，
 * 跟表单的节奏也不一样。
 *
 * ## 界面上最要紧的三件事
 *
 * - **`instanceId` 要能一键复制**：客户端（或客服脚本）进副本就靠它，肉眼抄一串
 *   `1:3:i7` 容易错；页面上直接给出可选中文本。
 * - **剩余时间要说清「谁在倒计时」**：`expired` 是时限到点自动收（没人进也会收），
 *   `emptied` 是人走光后 30 秒收 —— 两者在列表里长得不一样，文案也不能一样。
 * - **收场是幂等的**：已经收过的场不再给按钮（再点一次只是白跑一趟），但保留在
 *   「最近收场」里让人看见「它为什么没了」。
 */

/** 毫秒 → `mm:ss`（超过一小时给 `h:mm:ss`；副本时限最长的出厂值也就 30 分钟） */
function remainText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (num: number) => String(num).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * 收场原因的人话（服务端只给枚举，句子在客户端拼 —— 与 `mapEnterResult.field` 同一口径）
 *
 * `world_lost` 说得直白一点：那不是「打完了」，是**进程重启把这一场的世界弄丢了**，
 * 运营看到它时该做的是「开一场新的」，而不是去查玩家是不是掉线了。
 */
const CLOSE_REASON_TEXT: Record<string, { label: string; tone: "muted" | "jade" | "warn" | "ember" }> = {
  cleared: { label: "通关", tone: "jade" },
  expired: { label: "到点收场", tone: "muted" },
  emptied: { label: "人走光了", tone: "muted" },
  forced: { label: "运营强制", tone: "warn" },
  world_lost: { label: "世界丢失（进程重启）", tone: "ember" },
};

function closeReasonOf(reason: string | null): { label: string; tone: "muted" | "jade" | "warn" | "ember" } {
  if (!reason) return { label: "还开着", tone: "jade" };
  return CLOSE_REASON_TEXT[reason] ?? { label: reason, tone: "muted" };
}

/** 一场副本的一行（还开着的那些；已收场的走另一段，只读） */
function InstanceRow({
  item,
  nowMs,
  canWrite,
  busy,
  onClose,
}: {
  item: MapInstance;
  nowMs: number;
  canWrite: boolean;
  busy: boolean;
  onClose: (reason: "cleared" | "forced") => void;
}) {
  /** 还没人进过：世界没加载，「在场 0 人」与「没人来过」在这里是同一件事，但文案要分开 */
  const untouched = item.startedAt === null;
  // 剩余时间按**本机的钟现算**，不用响应里的 `remainMs`：那个是拉列表那一刻的值，
  // 弹窗开着不动的话它会一直停在「剩 29:58」，看起来像卡住了（实际早就在跑）
  const remainMs = Math.max(0, item.expiresAt - nowMs);
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <code className="select-all rounded bg-surface-3 px-1.5 py-0.5 text-xs text-gold">{item.instanceId}</code>
        <Badge tone={item.players > 0 ? "jade" : "muted"}>
          {item.players}
          {item.maxPlayers > 0 ? ` / ${item.maxPlayers}` : ""} 人
        </Badge>
        <Badge tone={remainMs === 0 ? "warn" : "muted"}>
          {remainMs === 0 ? "到点了，下一拍收场" : `剩 ${remainText(remainMs)}`}
        </Badge>
        {untouched ? <Badge tone="warn">没人进过</Badge> : null}
        {item.ownerRoleIds.length > 0 ? <Badge tone="gold">名单 {item.ownerRoleIds.length} 人</Badge> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-ink-5">
          散场回 <span className="text-ink-4">{item.originMapId}</span>
          {item.ttlMs > 0 ? <> · 时限 {remainText(item.ttlMs)}</> : null}
          {untouched ? <> · 第一个进场的人进来时才按刷怪区现播种</> : null}
        </p>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" disabled={!canWrite || busy} onClick={() => onClose("cleared")}>
            通关收场
          </Button>
          <Button variant="ghost" disabled={!canWrite || busy} onClick={() => onClose("forced")}>
            强制散场
          </Button>
        </div>
      </div>
    </div>
  );
}

export function MapInstancesDialog({
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
  const [data, setData] = useState<MapInstanceList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  /**
   * 本机的钟（每秒跳一次）：列表里的「剩 mm:ss」按它现算
   *
   * 不用响应里的 `remainMs` 直接显示 —— 那个是拉列表那一刻的值，弹窗开着不动就会一直
   * 停在「剩 29:58」。每秒一次只重渲染这一个弹窗，代价可以忽略。
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  /** 待确认的收场（`null` = 没弹确认框） */
  const [pending, setPending] = useState<{ item: MapInstance; reason: "cleared" | "forced" } | null>(null);
  /** 新建表单（空串 = 用出厂值；提交时再转数字） */
  const [ttlMinutes, setTtlMinutes] = useState("");
  const [maxPlayers, setMaxPlayers] = useState("");
  const [originMapId, setOriginMapId] = useState("");
  const [owners, setOwners] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await mapInstancesApi.list(mapId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "拉取副本列表失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setData(null);
    setPending(null);
    setTtlMinutes("");
    setMaxPlayers("");
    setOriginMapId("");
    setOwners("");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mapId]);

  /** 弹窗开着时每秒走一格（关掉就停：后台不该有个定时器一直在 setState） */
  useEffect(() => {
    if (!open) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const ttlText = ttlMinutes.trim();
      const playerText = maxPlayers.trim();
      const ownerIds = owners
        .split(/[\s,，]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      const created = await mapInstancesApi.create(mapId, {
        ...(ttlText === "" ? {} : { ttlMs: Math.max(1000, Math.floor(Number(ttlText) * 60_000)) }),
        ...(playerText === "" ? {} : { maxPlayers: Math.max(0, Math.floor(Number(playerText))) }),
        ...(originMapId.trim() === "" ? {} : { originMapId: originMapId.trim() }),
        ...(ownerIds.length === 0 ? {} : { ownerRoleIds: ownerIds }),
      });
      toastSuccess(`已开一场副本：${created.instanceId}`);
      await load();
    } catch {
      /* 错误已由请求层统一提示（越界数值 / 权限不足都有中文文案） */
    } finally {
      setCreating(false);
    }
  };

  const confirmClose = async () => {
    if (!pending) return;
    const { item, reason } = pending;
    setBusySlot(item.slot);
    try {
      await mapInstancesApi.close(mapId, item.slot, { reason });
      toastSuccess(reason === "cleared" ? `${item.instanceId} 已按通关收场` : `${item.instanceId} 已强制散场`);
      setPending(null);
      await load();
    } catch {
      /* 错误已由请求层统一提示（没有这一场 = 404 50046） */
    } finally {
      setBusySlot(null);
    }
  };

  return (
    <>
      <Modal
        open={open}
        title={`副本 · ${mapLabel || `#${mapId}`}`}
        hint="一场副本 = 一个独立的世界（各自的怪、各自的人），与公共线及其它场完全隔离。开出来还不会建世界：第一个进来的人进场那一刻才按刷怪区现播种（#1001）。"
        size="lg"
        onClose={onClose}
        footer={
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        }
      >
        <div className="space-y-4">
          {!canWrite ? <Notice tone="warn">你只有配置读权限 —— 可以看，不能开 / 收副本。</Notice> : null}

          <section>
            <h4 className="mb-1.5 text-xs font-medium text-ink-3">
              开一场
              <span className="ml-2 text-[10px] font-normal text-ink-5">
                不填就是出厂：30 分钟 / 6 人 / 谁都能进 / 散场回这张图
              </span>
            </h4>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <FormField label="时限（分钟）" hint="留空 = 30；到点自动收场，收场前会提醒在场的人">
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  disabled={!canWrite}
                  placeholder="30"
                  value={ttlMinutes}
                  onChange={(event) => setTtlMinutes(event.target.value)}
                />
              </FormField>
              <FormField label="人数上限" hint="留空 = 6；0 = 不限（上限 100）">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  disabled={!canWrite}
                  placeholder="6"
                  value={maxPlayers}
                  onChange={(event) => setMaxPlayers(event.target.value)}
                />
              </FormField>
              <FormField label="散场回哪张图" hint="留空 = 这张图；填了就把人送到那张图的公共线">
                <Input
                  disabled={!canWrite}
                  placeholder={mapId}
                  value={originMapId}
                  onChange={(event) => setOriginMapId(event.target.value)}
                />
              </FormField>
              <FormField label="进场名单（角色 id）" hint="留空 = 谁都能进；多个用逗号 / 空格分隔">
                <Input
                  disabled={!canWrite}
                  placeholder="留空 = 公开"
                  value={owners}
                  onChange={(event) => setOwners(event.target.value)}
                />
              </FormField>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button disabled={!canWrite || creating} loading={creating} onClick={() => void create()}>
                开一场副本
              </Button>
              <Button variant="ghost" onClick={() => void load()}>
                刷新
              </Button>
            </div>
          </section>

          <section>
            <h4 className="mb-1.5 text-xs font-medium text-ink-3">
              还开着的
              <span className="ml-2 text-[10px] font-normal text-ink-5">
                人手一走光 30 秒后自动收（防掉线重连）；在场人数是投影，约数
              </span>
            </h4>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-ink-5">
                <Spinner /> 读取副本…
              </div>
            ) : error ? (
              <Notice tone="ember" title="拉不到副本">
                {error}
              </Notice>
            ) : !data || data.open.length === 0 ? (
              <EmptyState title="这张图现在没有开着的副本" description="开一场之后，客户端带 instanceId 就能进" />
            ) : (
              <div className="space-y-2">
                {data.open.map((item) => (
                  <InstanceRow
                    key={item.instanceId}
                    item={item}
                    nowMs={nowMs}
                    canWrite={canWrite}
                    busy={busySlot === item.slot}
                    onClose={(reason) => setPending({ item, reason })}
                  />
                ))}
              </div>
            )}
          </section>

          {data && data.recent.length > 0 ? (
            <section>
              <h4 className="mb-1.5 text-xs font-medium text-ink-3">最近收场的</h4>
              <div className="space-y-1">
                {data.recent.map((item) => {
                  const reason = closeReasonOf(item.closeReason);
                  return (
                    <div key={item.instanceId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-5">
                      <code className="text-ink-4">{item.instanceId}</code>
                      <Badge tone={reason.tone}>{reason.label}</Badge>
                      <span>
                        {item.maxPlayers > 0 ? `${item.maxPlayers} 人上限` : "人数不限"} · 收于{" "}
                        {item.closedAt ? new Date(item.closedAt).toLocaleString() : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          <p className="text-[11px] text-ink-5">
            收场只写登记：真正的「把人送回原图 + 销毁这一场的世界」由实时进程下一拍做，
            所以点完到玩家被送走最多差 1 秒。<b>副本不从库恢复</b> —— 进程重启之后那一场的世界就没了，
            还在里面的人会被送回原图（列表里记为「世界丢失」）。
          </p>
        </div>
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.reason === "cleared" ? "按通关收场？" : "强制散场？"}
        description={
          pending
            ? `${pending.item.instanceId} 里的人会被送回他们各自进副本前那张图（最多 1 秒后生效）。` +
              (pending.reason === "cleared"
                ? "通关是正常结束：记录会标成「通关」。"
                : "强制散场是运营手段：记录会标成「运营强制」，在场的人不会收到倒计时提醒。")
            : undefined
        }
        confirmText={pending?.reason === "cleared" ? "通关收场" : "强制散场"}
        danger={pending?.reason !== "cleared"}
        loading={busySlot !== null}
        onConfirm={() => void confirmClose()}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
