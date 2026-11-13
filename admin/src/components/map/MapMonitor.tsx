import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mapPreview, mapsApi } from "../../api";
import type { MapMonitor, MapMonitorEvent, MapMonitorMonster, MapMonitorPlayer } from "../../api";
import { EntityImage } from "../entity/EntityImage";
import { entityImage } from "../entity/catalog";
import { gameResUrl } from "../GameImage";
import { Modal } from "../Modal";
import { Badge, Button, EmptyState, Notice, Select, Spinner } from "../ui";

/**
 * 实时地图监控（#665 / 精细日志 #745）
 *
 * ## 它回答什么问题
 *
 * 「这张图现在什么情况」—— 而不是「这张图的配置对不对」（那是详情页的事）：
 * 哪只怪站在哪儿、哪些已经倒了还要多久刷、谁在图里、刚才谁对谁做了什么。
 *
 * ## 数据从哪来（决定了这个页面的三个行为）
 *
 * 实时进程每秒把世界状态投影进库，管理端只读（见服务端 `MapMonitorService` 顶部）。
 * 于是有三件事必须照实显示，不能假装数据是连续的：
 *
 * 1. **轮询而不是推送**：1200ms 一次（服务端 1000ms 采一次）。选轮询不选第二条 WS：
 *    监控是「看」不是「玩」，多一条实时连接就多一套鉴权、重连、跨域；
 * 2. **陈旧要写在脸上**（`staleMs`）：没人在那张图里时采集器不采样，快照会停住 ——
 *    页面显示「最后采样 N 秒前」，否则一张停更十小时的图看起来跟「图里没有任何怪」一模一样；
 * 3. **事件按游标增量拉**：刚打开页面就能看到最近 60 条（包括它没看见的那几分钟），
 *    之后只拉新的；暂停再继续也不会漏。
 *
 * ## 文字流为什么有六种事件（#745）
 *
 * 前三类（击杀 / 刷新 / 伤害）回答「数值怎么变的」，后三类（追击起止 / 怪物技能 / 怪物普攻）
 * 回答「怪为什么动、为什么停下」。两种口径的来源不同，页面不能混为一谈：
 *
 * - **数值来自结算**（`CombatSettlementService`）：掉多少血、血量前后、推开多远 —— 快照差分
 *   只说得清「掉了血」，说不出「谁打的、用什么技能、这一下多少」。所以 `hpBefore` 是服务端
 *   从 `hpAfter + amount` 反推的，页面上「65 → 56（-9）」三个数**永远自洽**；
 * - **过程来自 AI**（`MonsterAiService` 的 `onLog` 回调）：追击开始与结束带**成困**（进入检测
 *   范围 / 被打之后记恨 / 目标倒下 / 目标离线 / 目标换图 / 位置上报超时 / 怪物被击杀）——
 *   这是排查「怪为什么追着我不放」「怪怎么突然不追了」的唯一线索。
 *
 * 所以时间要显示到**毫秒**，并给出与上一条的间隔：一秒内可能连发三四条（普攻 → 掉血 →
 * 目标倒下 → 结束追击），只显示到秒就看不出先后。
 *
 * ## 坐标
 *
 * 服务端给的是**世界坐标**（原点 = 左上角、y 轴向上，同刷怪区）。画到 SVG 上要
 * `tiledY = -worldY` —— 与 `MapCanvas` 里刷怪区的换算一致，两处必须是同一个口径。
 */

/** 轮询间隔（毫秒）：服务端 1 秒采一次，这里 1.2 秒 —— 稍微松一点，避免读到同一帧两次 */
const POLL_MS = 1200;
/** 页面上最多留多少条事件（再多浏览器只是变慢；服务端每图留 2000 条，一次只拉 60 条） */
const MAX_EVENTS = 300;
/** 陈旧阈值（毫秒）：超过它就明说「采集停了」，不再假装是「此刻」 */
const STALE_WARN_MS = 5000;

const COLOR = {
  alive: "#fb7185", // rose-400：场上的怪
  dead: "#64748b", // slate-500：倒了还没刷
  player: "#38bdf8", // sky-400：玩家
};

/**
 * 六类事件的样式：圆点、文字色、中文名。
 *
 * 颜色只在这里定义一次（图例、筛选 chips、每一行都取这里）。筛选 chip 的 `dot` 必须是
 * **字面量** class —— Tailwind 扫的是源码文本，拼出来的类名不会被生成。
 */
const KIND_META: Record<string, { label: string; dot: string; text: string }> = {
  kill: { label: "击杀", dot: "bg-rose-400", text: "text-rose-300" },
  damage: { label: "伤害", dot: "bg-amber-400", text: "text-amber-300" },
  cast: { label: "怪物技能", dot: "bg-violet-400", text: "text-violet-300" },
  hit: { label: "怪物普攻", dot: "bg-pink-400", text: "text-pink-300" },
  chase: { label: "追击", dot: "bg-sky-400", text: "text-sky-300" },
  respawn: { label: "刷新", dot: "bg-emerald-400", text: "text-emerald-300" },
};

/** chips 的排列顺序 = 「一件事从开打走向结局」的顺序，不是字母序也不是服务端写入顺序 */
const KIND_ORDER = ["kill", "damage", "cast", "hit", "chase", "respawn"];

/** 时间戳 → 本地 `HH:MM:SS.mmm`（毫秒是 #745 的硬要求：一秒内会连发好几条） */
function clockOf(at: number): string {
  const date = new Date(at);
  const pad = (num: number, width = 2) => String(num).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** 只到秒的版本（「下次刷新 10:20:30」这种不需要毫秒的场合） */
function clockShort(at: number): string {
  return clockOf(at).slice(0, 8);
}

/** 与上一条的间隔：`+8ms` / `+1.4s` / `+2m`（让人一眼看出这是一串连锁反应还是一件孤立的事） */
function deltaText(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 1000) return `+${Math.round(value)}ms`;
  if (value < 60_000) return `+${(value / 1000).toFixed(1)}s`;
  return `+${Math.round(value / 60_000)}m`;
}

/** 剩余毫秒 → `12s` / `1m20s`（重生倒计时用；不显示毫秒，跳得太快反而看不清） */
function remainText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

/** 「最后采样多久之前」的人话（`4 秒前` / `3 分钟前` / `2 小时前`） */
function agoText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** `65 → 56 / 120`（血量前后 + 上限，三个数都取整） */
function hpText(before: number, after: number, maxHp: number): string {
  return `${Math.round(before)} → ${Math.round(after)} / ${Math.round(maxHp)}`;
}

/** 剩余百分比（上限为 0 时给 `—`，别显示 `NaN%`） */
function percentOf(hp: number, maxHp: number): string {
  if (maxHp <= 0) return "—";
  return `${Math.round((Math.max(0, hp) / maxHp) * 100)}%`;
}

/** 聚焦态：点地图上某只怪 → 文字流只留它的事（换图/关窗即失效，实例 id 是图内唯一的） */
interface Focus {
  instanceId: string;
  label: string;
}

export function MapMonitorDialog({
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
  const [data, setData] = useState<MapMonitor | null>(null);
  const [events, setEvents] = useState<MapMonitorEvent[]>([]);
  const [zone, setZone] = useState<number | undefined>(undefined);
  const [slot, setSlot] = useState<string>("0");
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 类型筛选：默认全开，关掉一个就少一类（关光了显示空态提示，而不是假装「没有事件」） */
  const [kinds, setKinds] = useState<string[]>(KIND_ORDER);
  const [focus, setFocus] = useState<Focus | null>(null);

  // 轮询依赖的三个值走 ref：把它们放进 effect 依赖会让每次响应都重建定时器
  const cursorRef = useRef(0);
  const zoneRef = useRef<number | undefined>(undefined);
  const slotRef = useRef<string>("0");
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  /** 换图 / 换区 / 重新打开：游标与事件清空，从头拉一份「最近发生的事」 */
  useEffect(() => {
    cursorRef.current = 0;
    zoneRef.current = undefined;
    slotRef.current = "0";
    setZone(undefined);
    setSlot("0");
    setEvents([]);
    setData(null);
    setError(null);
    setFocus(null); // 实例 id 只在同一张图同一区内有效，留着会「筛出来永远 0 条」
  }, [open, mapId]);

  /** 选区：只有服务端返回过多个区时才显示下拉 */
  const changeZone = (next: number) => {
    zoneRef.current = next;
    setZone(next);
    cursorRef.current = 0;
    setEvents([]);
    setFocus(null);
  };

  /** 选线：与选区同款 —— 清游标重拉；没被采样过的线服务端返回空帧，不拿别的线的帧顶替 */
  const changeSlot = (next: string) => {
    slotRef.current = next;
    setSlot(next);
    cursorRef.current = 0;
    setEvents([]);
    setFocus(null);
  };

  const poll = useCallback(async () => {
    if (!open || !mapId || pausedRef.current) return;
    try {
      // 不按类型拉：混着拉下来才能让「关掉某一类」的 chips 立刻生效（筛选只改显示，不改游标）
      const next = await mapsApi.monitor(mapId, { zone: zoneRef.current, slot: slotRef.current, since: cursorRef.current, limit: 60 });
      setData(next);
      setError(null);
      // 第一次拿到区号就锁住它：之后即使别的区也有快照，也不跟着「最新一帧」乱跳
      if (zoneRef.current === undefined) {
        zoneRef.current = next.zoneId;
        setZone(next.zoneId);
      }
      if (next.events.length > 0) {
        setEvents((previous) => {
          const seen = new Set(previous.map((event) => event.id));
          const merged = [...previous, ...next.events.filter((event) => !seen.has(event.id))];
          return merged.slice(-MAX_EVENTS);
        });
      }
      cursorRef.current = next.cursor || cursorRef.current;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "拉取监控数据失败");
    }
  }, [open, mapId]);

  useEffect(() => {
    if (!open || !mapId) return;
    setLoading(true);
    void poll().finally(() => setLoading(false));
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, mapId, zone, slot, poll]);

  const monsters = data?.monsters ?? [];
  const players = data?.players ?? [];
  const alive = monsters.filter((monster) => monster.alive).length;
  const stale = data?.staleMs ?? null;
  const isStale = stale !== null && stale > STALE_WARN_MS;

  /**
   * 筛选在**上层**做（而不是塞进 `EventFeed`）：底栏要显示「显示 N / 共 M 条」，
   * 两处各自过滤会出现「底栏说 12 条、流里只有 8 条」这种自相矛盾。
   */
  const visible = useMemo(
    () => events.filter((event) => kinds.includes(event.kind) && (!focus || event.instanceId === focus.instanceId)),
    [events, kinds, focus],
  );

  /** 每个类型的条数（永远按**全量**算：筛选后还要知道「关掉的那类有多少」才敢关） */
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const event of events) map[event.kind] = (map[event.kind] ?? 0) + 1;
    return map;
  }, [events]);

  const toggleKind = (kind: string) => {
    setKinds((previous) => (previous.includes(kind) ? previous.filter((item) => item !== kind) : [...previous, kind]));
  };

  const toggleFocus = (monster: MapMonitorMonster) => {
    setFocus((previous) =>
      previous?.instanceId === monster.instanceId ? null : { instanceId: monster.instanceId, label: monster.label },
    );
  };

  return (
    <Modal
      open={open}
      title={
        <>
          实时监控 · {mapLabel || `#${mapId}`}
          {data ? <Badge tone={isStale ? "amber" : "green"}>{isStale ? "采集已停" : "实时"}</Badge> : null}
        </>
      }
      hint="每秒采样一次：怪物位置 / 血量 / 重生倒计时 + 玩家位置 + 事件流（击杀、每一下伤害、怪物技能与普攻、追击起止，时间到毫秒）。数据来自实时进程，没人在图里时采集会停（看右下角「最后采样」）。"
      size="xl"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
            <span>存活 {alive}</span>
            <span>倒下 {monsters.length - alive}</span>
            <span>玩家 {players.length}</span>
            <span>
              事件 {visible.length}
              {visible.length === events.length ? ` / ${events.length}` : <span className="text-slate-600"> / 共 {events.length}</span>}
            </span>
            {stale !== null ? <span className={isStale ? "text-amber-300" : undefined}>最后采样 {agoText(stale)}</span> : null}
          </span>
          <Button variant="outline" onClick={() => setPaused((value) => !value)}>
            {paused ? "继续" : "暂停"}
          </Button>
          <Button variant="outline" onClick={() => setEvents([])} disabled={events.length === 0}>
            清空文字流
          </Button>
          <Button onClick={onClose}>关闭</Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
              <Legend color={COLOR.alive} label="存活的怪" />
              <Legend color={COLOR.dead} label="倒下（等重生）" hollow />
              <Legend color={COLOR.player} label="玩家" square />
            </div>
            {(data?.zones.length ?? 0) > 1 ? (
              <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                区
                <Select className="w-24" value={String(zone ?? "")} onChange={(event) => changeZone(Number(event.target.value))}>
                  {data?.zones.map((item) => (
                    <option key={item} value={item}>
                      {item} 区
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {(data?.slots.length ?? 0) > 1 ? (
              <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                线
                <Select className="w-24" value={slot} onChange={(event) => changeSlot(event.target.value)}>
                  {data?.slots.map((item) => (
                    <option key={item} value={item}>
                      {item === "0" ? "公共线" : item.startsWith("i") ? `副本 ${item}` : `${item} 线`}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
          </div>

          {loading && !data ? (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-950/40 py-16 text-xs text-slate-500">
              <Spinner /> 读取世界快照…
            </div>
          ) : error ? (
            <Notice tone="red" title="拉不到监控数据">
              {error}
            </Notice>
          ) : !data || data.sampledAt === null ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950/40">
              <EmptyState
                title="这张图还没有世界快照"
                description="没人在里面时实时进程不播种也不采样；等有人进图（或确认实时进程在跑）再刷新。"
              />
            </div>
          ) : (
            <LiveMap
              width={data.width}
              height={data.height}
              mapId={data.mapId}
              monsters={monsters}
              players={players}
              focus={focus?.instanceId ?? null}
              onPick={toggleFocus}
            />
          )}

          <p className="text-[11px] text-slate-500">
            坐标是世界坐标（原点 = 左上角、y 轴向上，与刷怪区同一口径）。鼠标停在点上能看到实例 id 与血量；
            <span className="text-slate-400">点一只怪可以只看它的日志</span>（再点一次取消）。
          </p>
        </div>

        <EventFeed
          events={visible}
          total={events.length}
          counts={counts}
          kinds={kinds}
          onToggleKind={toggleKind}
          focus={focus}
          onClearFocus={() => setFocus(null)}
          paused={paused}
        />
      </div>
    </Modal>
  );
}

/** 图例（色块 + 名字：颜色只在上面那一处定义，改色改一处） */
function Legend({ color, label, hollow = false, square = false }: { color: string; label: string; hollow?: boolean; square?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`inline-block h-2.5 w-2.5 shrink-0 ${square ? "rounded-sm" : "rounded-full"}`}
        style={{ background: hollow ? "transparent" : color, border: `2px solid ${color}` }}
      />
      {label}
    </span>
  );
}

/**
 * 实时地图（底图 + 点位叠加）
 *
 * 与 `MapCanvas` 的分工：那个画**配置**（刷怪区 / NPC / 碰撞盒，用来核对导入对不对），
 * 这个画**此刻**（怪在哪、活没活、谁在图里）。两者共用同一套坐标换算，但互不复用 DOM ——
 * 一个页面上同时要看配置与实时，各自的重绘频率差三个数量级（配置只在切图时变）。
 */
function LiveMap({
  mapId,
  width,
  height,
  monsters,
  players,
  focus,
  onPick,
}: {
  mapId: string;
  width: number;
  height: number;
  monsters: MapMonitorMonster[];
  players: MapMonitorPlayer[];
  focus: string | null;
  onPick: (monster: MapMonitorMonster) => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const ratio = height > 0 ? width / height : 1;
  // 半径按图宽算（与 MapCanvas 同一条理由：写死 40 在 8192 的图上只有半个像素）
  const radius = Math.max(10, width / 150);
  const labelSize = Math.max(18, width / 90);

  return (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950"
      style={{ aspectRatio: `${ratio}`, maxWidth: "min(100%, 58vh)" }}
    >
      {imageFailed ? (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-slate-600">
          预览图加载失败（map/{mapId}/preview.jpg）—— 点位照常显示
        </div>
      ) : (
        <img
          alt={`${mapId} 地图`}
          src={gameResUrl(mapPreview(mapId), "jpg")}
          onError={() => setImageFailed(true)}
          className="absolute inset-0 h-full w-full object-contain"
          draggable={false}
        />
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-label="实时怪物与玩家位置"
      >
        {/* 玩家先画（在怪下面）：玩家是「谁在图里」，怪的层更值得看见 */}
        {players.map((player) => {
          const x = player.x;
          const y = -player.y;
          return (
            <g key={player.accountId}>
              <rect
                x={x - radius}
                y={y - radius}
                width={radius * 2}
                height={radius * 2}
                rx={radius * 0.3}
                fill={COLOR.player}
                fillOpacity={0.85}
                stroke="#0f172a"
                strokeWidth={radius * 0.18}
                vectorEffect="non-scaling-stroke"
              >
                <title>{`${player.name}\n(${Math.round(player.x)}, ${Math.round(player.y)}) · 血量 ${Math.round(player.hp)}/${Math.round(player.maxHp)}`}</title>
              </rect>
              <text x={x} y={y - radius * 1.8} fill="#e0f2fe" fontSize={labelSize} textAnchor="middle" stroke="#0f172a" strokeWidth={labelSize * 0.12} paintOrder="stroke">
                {player.name}
              </text>
            </g>
          );
        })}

        {monsters.map((monster) => {
          const x = monster.x;
          const y = -monster.y;
          const hpRatio = monster.maxHp > 0 ? Math.max(0, Math.min(1, monster.hp / monster.maxHp)) : 0;
          const focused = focus === monster.instanceId;
          // 聚焦时其余的怪退到背景：一眼看出「这只」在哪儿，而不是在一片同样颜色的圆里找
          const dimmed = focus !== null && !focused;
          return (
            <g
              key={monster.instanceId}
              onClick={() => onPick(monster)}
              className="cursor-pointer"
              opacity={dimmed ? 0.3 : 1}
            >
              {focused ? (
                <circle
                  cx={x}
                  cy={y}
                  r={radius * 1.9}
                  fill="none"
                  stroke="#f8fafc"
                  strokeWidth={Math.max(2, radius * 0.12)}
                  strokeDasharray={`${radius * 0.45} ${radius * 0.3}`}
                />
              ) : null}
              <circle
                cx={x}
                cy={y}
                r={radius}
                fill={monster.alive ? COLOR.alive : "transparent"}
                fillOpacity={monster.alive ? 0.35 + 0.55 * hpRatio : 0}
                stroke={monster.alive ? COLOR.alive : COLOR.dead}
                strokeWidth={monster.alive ? radius * 0.2 : radius * 0.16}
                strokeDasharray={monster.alive ? undefined : `${radius * 0.5} ${radius * 0.4}`}
                vectorEffect="non-scaling-stroke"
              >
                <title>
                  {`${monster.label}（${monster.instanceId}）\n(${Math.round(monster.x)}, ${Math.round(monster.y)}) · ` +
                    (monster.alive
                      ? `血量 ${Math.round(monster.hp)}/${Math.round(monster.maxHp)}`
                      : `已倒下 · ${remainText(monster.respawnInMs ?? 0)} 后重生`) +
                    "\n点击只看这只怪的日志"}
                </title>
              </circle>
              {monster.alive ? null : (
                <text x={x} y={y + labelSize * 0.35} fill="#94a3b8" fontSize={labelSize} textAnchor="middle" stroke="#020617" strokeWidth={labelSize * 0.12} paintOrder="stroke">
                  {remainText(monster.respawnInMs ?? 0)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * 文字流（右侧）
 *
 * 一行 = 一件事，按时间升序。**不合并同类事件**：这一栏要回答的是「刚才发生了什么、按什么顺序」，
 * 合并之后就看不出节奏（同一只怪被反复刷、某个角落一直在掉同一件东西、一秒内连吃了三下普攻）。
 *
 * 头部的 chips 是**类型筛选**（不是分页）：细到每一下伤害之后条数涨了一个数量级，
 * 「只想看这只怪为什么追我」时得能一键把伤害与刷新挡掉。
 */
function EventFeed({
  events,
  total,
  counts,
  kinds,
  onToggleKind,
  focus,
  onClearFocus,
  paused,
}: {
  events: MapMonitorEvent[];
  total: number;
  counts: Record<string, number>;
  kinds: string[];
  onToggleKind: (kind: string) => void;
  focus: Focus | null;
  onClearFocus: () => void;
  paused: boolean;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(true);

  // 自动滚到底，但**用户往上翻时不要抢**：只有他本来就在底部才跟着新事件走
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !stickBottomRef.current) return;
    box.scrollTop = box.scrollHeight;
  }, [events]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    stickBottomRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  };

  return (
    <div className="flex h-[58vh] min-h-[240px] flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40">
      <div className="border-b border-slate-800 px-2.5 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-slate-300">文字流</span>
          <span className="text-[11px] text-slate-500">
            {paused ? "已暂停（不拉新数据）" : `显示 ${events.length} / 共 ${total} 条`}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {KIND_ORDER.map((kind) => (
            <KindChip
              key={kind}
              kind={kind}
              count={counts[kind] ?? 0}
              active={kinds.includes(kind)}
              onClick={() => onToggleKind(kind)}
            />
          ))}
        </div>
        {focus ? (
          <div className="mt-1 flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-200">
            只看 <span className="font-medium">{focus.label}</span>
            <span className="font-mono text-[10px] text-sky-400/70">{focus.instanceId}</span>
            <button type="button" onClick={onClearFocus} className="ml-auto text-sky-300 hover:text-white" title="取消聚焦">
              取消
            </button>
          </div>
        ) : null}
      </div>
      <div ref={boxRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <p className="px-3 py-8 text-center text-[11px] text-slate-500">
            {total > 0 ? (
              <>当前筛选下没有事件（共 {total} 条被筛掉）—— 把上面的类型 chips 打开，或取消聚焦。</>
            ) : (
              <>
                还没有事件。这条流只记世界进程看到的事：谁对哪只怪做了什么、怪什么时候刷新。空着说明这张图最近没人打怪
                —— 也可能是采集停了（看底部「最后采样」）。
              </>
            )}
          </p>
        ) : (
          events.map((event, index) => (
            <EventRow
              key={event.id}
              event={event}
              deltaMs={index === 0 ? null : event.at - events[index - 1].at}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** 类型筛选 chip：关掉的一律半透明（不用 line-through，中文压一条横线后基本读不清） */
function KindChip({ kind, count, active, onClick }: { kind: string; count: number; active: boolean; onClick: () => void }) {
  const meta = KIND_META[kind] ?? { label: kind, dot: "bg-slate-500", text: "text-slate-400" };
  return (
    <button
      type="button"
      onClick={onClick}
      title={active ? `隐藏${meta.label}事件` : `显示${meta.label}事件`}
      className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition ${
        active ? "border-slate-600 bg-slate-800/80 text-slate-200" : "border-slate-800 text-slate-600 opacity-60 hover:opacity-100"
      }`}
    >
      <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${active ? meta.dot : "bg-slate-700"}`} />
      {meta.label}
      <span className="font-mono text-slate-500">{count}</span>
    </button>
  );
}

/**
 * 一条事件
 *
 * 六种类型共用「时间列 + 主句 + 详情行」的骨架，主句与详情各按类型分支：
 *
 * - 主句回答「谁对谁做了什么」（一眼扫过去的节奏）；
 * - 详情回答「具体多少、在哪儿」（停下来核对数字时才看）。
 *
 * 时间列下面那行是**与上一条的间隔** —— 一秒内连发四条时，「+0ms / +3ms」比四个相同的时间戳有用得多。
 */
function EventRow({ event, deltaMs }: { event: MapMonitorEvent; deltaMs: number | null }) {
  const meta = KIND_META[event.kind] ?? { label: event.kind, dot: "bg-slate-500", text: "text-slate-300" };
  const respawnIn = event.respawnAt > 0 ? event.respawnAt - Date.now() : 0;
  const coords = `(${Math.round(event.x)}, ${Math.round(event.y)})`;

  return (
    <div className="flex gap-2 border-b border-slate-800/60 px-2.5 py-1.5 last:border-b-0">
      <div className="w-[68px] shrink-0">
        <div className="font-mono text-[10px] leading-4 text-slate-400" title={new Date(event.at).toLocaleString()}>
          {clockOf(event.at)}
        </div>
        <div className="font-mono text-[9px] leading-3 text-slate-600">{deltaMs === null ? "" : deltaText(deltaMs)}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-1 text-[11px]">
          <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
          <EventHead event={event} coords={coords} />
        </div>
        <EventDetail event={event} coords={coords} respawnIn={respawnIn} />
      </div>
    </div>
  );
}

/** 主句：一行说清「谁 → 对谁 → 做了什么」 */
function EventHead({ event, coords }: { event: MapMonitorEvent; coords: string }) {
  if (event.kind === "kill") {
    return (
      <>
        <span className="text-slate-200">{event.label}</span>
        <span className="text-slate-500">被</span>
        <span className="text-indigo-300">{event.killer || "（未知）"}</span>
        <span className="text-slate-500">打死</span>
        <span className="font-mono text-[10px] text-slate-500">{coords}</span>
      </>
    );
  }
  if (event.kind === "respawn") {
    return (
      <>
        <span className="text-slate-200">{event.label}</span>
        <span className="text-emerald-300">刷新了</span>
        <span className="font-mono text-[10px] text-slate-500">{coords}</span>
      </>
    );
  }
  if (event.kind === "damage") {
    // 「被 … 用 … 打了」：三个主体（怪 / 人 / 技能）缺一个就看不清这一下是怎么来的
    return (
      <>
        <span className="text-slate-200">{event.label}</span>
        <span className="text-slate-500">被</span>
        <span className="text-indigo-300">{event.attacker || "（未知）"}</span>
        <span className="text-slate-500">用</span>
        <span className="text-slate-300">{event.skillLabel || event.skillId || "（未知技能）"}</span>
        <span className="text-slate-500">打了</span>
        <span className="font-mono text-amber-300">-{Math.round(event.amount)}</span>
      </>
    );
  }
  if (event.kind === "chase") {
    const ended = event.phase === "end";
    return (
      <>
        <span className="text-slate-200">{event.label}</span>
        <span className={ended ? "text-amber-300" : "text-emerald-300"}>{ended ? "结束追击" : "开始追击"}</span>
        <span className="text-sky-300">{event.target || "（未知）"}</span>
        <span className="text-slate-500">·</span>
        <span className="text-slate-400">{event.reason || "（无成因）"}</span>
        {event.distance > 0 ? <span className="font-mono text-[10px] text-slate-500">{Math.round(event.distance)}px</span> : null}
      </>
    );
  }
  if (event.kind === "cast") {
    return (
      <>
        <span className="text-slate-200">{event.label}</span>
        <span className="text-slate-500">对</span>
        <span className="text-sky-300">{event.target || "（未知）"}</span>
        <span className="text-slate-500">放</span>
        <span className="text-violet-300">{event.skillLabel || event.skillId || "（未知技能）"}</span>
        <span className="font-mono text-violet-200">-{Math.round(event.amount)}</span>
      </>
    );
  }
  if (event.kind === "hit") {
    return (
      <>
        <span className="text-slate-200">{event.label}</span>
        <span className="text-slate-500">普攻</span>
        <span className="text-sky-300">{event.target || "（未知）"}</span>
        <span className="font-mono text-pink-300">-{Math.round(event.amount)}</span>
      </>
    );
  }
  return <span className="text-slate-500">（未知事件类型 {event.kind}）</span>;
}

/** 详情行：数字与落点（击杀还带掉落） */
function EventDetail({ event, coords, respawnIn }: { event: MapMonitorEvent; coords: string; respawnIn: number }) {
  if (event.kind === "kill") {
    return (
      <>
        <div className="mt-0.5 text-[10px] text-slate-500">
          怪物位置 {coords} · 下次刷新 {clockShort(event.respawnAt)}（剩 {remainText(respawnIn)}）
        </div>
        {event.drops.length === 0 ? (
          <div className="mt-0.5 text-[10px] text-slate-600">没有掉落</div>
        ) : (
          <div className="mt-1 flex flex-wrap gap-1">
            {event.drops.map((drop, index) => (
              <span
                key={`${drop.goodId}-${index}`}
                className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900/60 py-0.5 pl-0.5 pr-1.5"
                title={`${drop.label || drop.goodId}（${drop.goodId}）×${drop.count}\n落点 (${Math.round(drop.x)}, ${Math.round(drop.y)})—— 客户端在这一点的周围铺开`}
              >
                <EntityImage image={entityImage("item", drop.goodId)} alt={drop.label} size={16} />
                <span className="text-[10px] text-slate-300">{drop.label || drop.goodId}</span>
                <span className="font-mono text-[10px] text-slate-500">×{drop.count}</span>
                <span className="font-mono text-[10px] text-slate-600">
                  @{Math.round(drop.x)},{Math.round(drop.y)}
                </span>
              </span>
            ))}
          </div>
        )}
      </>
    );
  }

  if (event.kind === "respawn") {
    return (
      <div className="mt-0.5 text-[10px] text-slate-500">
        出生点 {coords} · 满血 {Math.round(event.maxHp)}
      </div>
    );
  }

  if (event.kind === "damage") {
    // 三个数字（前 / 后 / 上限）+ 条 + 百分比：服务端保证 `hpBefore - hpAfter === amount`
    return (
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
        <span className="font-mono text-slate-400">{hpText(event.hpBefore, event.hpAfter, event.maxHp)}</span>
        <span className="font-mono text-slate-500">{percentOf(event.hpAfter, event.maxHp)}</span>
        <HpBar hp={event.hpAfter} maxHp={event.maxHp} tone="bg-amber-400" />
        {event.pushDistance > 0 ? (
          <span>推开 {Math.round(event.pushDistance)}px</span>
        ) : (
          <span className="text-slate-600">没推开</span>
        )}
        {event.killed ? <span className="text-rose-300">这一下打死了</span> : null}
        <span className="font-mono text-slate-600">{coords}</span>
      </div>
    );
  }

  if (event.kind === "cast" || event.kind === "hit") {
    // 这里掉血的是**玩家**（怪出手），所以条走玫红 —— 与上面「怪掉血」的琥珀色区分开
    return (
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
        <span className="text-slate-600">玩家血量</span>
        <span className="font-mono text-slate-400">{hpText(event.hpBefore, event.hpAfter, event.maxHp)}</span>
        <span className="font-mono text-slate-500">{percentOf(event.hpAfter, event.maxHp)}</span>
        <HpBar hp={event.hpAfter} maxHp={event.maxHp} tone="bg-rose-400" />
        {event.killed ? <span className="text-rose-300">这一下把玩家打倒了</span> : null}
        <span className="font-mono text-slate-600">{coords}</span>
      </div>
    );
  }

  if (event.kind === "chase") {
    return (
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-500">
        <span className="font-mono text-slate-600">{coords}</span>
        {event.targetAccountId ? <span className="font-mono text-slate-600">{event.targetAccountId}</span> : null}
        {event.distance > 0 ? null : <span className="text-slate-600">目标位置已不可知</span>}
      </div>
    );
  }

  return null;
}

/** 血量条：静态宽度百分比（不带动画 —— 一次轮询会重排几十行，动画反而更花） */
function HpBar({ hp, maxHp, tone }: { hp: number; maxHp: number; tone: string }) {
  const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 0;
  return (
    <span className="inline-block h-1.5 w-14 overflow-hidden rounded-full bg-slate-800 align-middle">
      <span className={`block h-full ${tone}`} style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}
