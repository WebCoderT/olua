import { useCallback, useEffect, useRef, useState } from "react";
import { mapPreview, mapsApi } from "../../api";
import type { MapMonitor, MapMonitorEvent, MapMonitorMonster, MapMonitorPlayer } from "../../api";
import { EntityImage } from "../entity/EntityImage";
import { entityImage } from "../entity/catalog";
import { gameResUrl } from "../GameImage";
import { Modal } from "../Modal";
import { Badge, Button, EmptyState, Notice, Select, Spinner } from "../ui";

/**
 * 实时地图监控（#665）
 *
 * ## 它回答什么问题
 *
 * 「这张图现在什么情况」—— 而不是「这张图的配置对不对」（那是详情页的事）：
 * 哪只怪站在哪儿、哪些已经倒了还要多久刷、谁在图里、刚才谁打死了什么掉了什么。
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
 * ## 坐标
 *
 * 服务端给的是**世界坐标**（原点 = 左上角、y 轴向上，同刷怪区）。画到 SVG 上要
 * `tiledY = -worldY` —— 与 `MapCanvas` 里刷怪区的换算一致，两处必须是同一个口径。
 */

/** 轮询间隔（毫秒）：服务端 1 秒采一次，这里 1.2 秒 —— 稍微松一点，避免读到同一帧两次 */
const POLL_MS = 1200;
/** 页面上最多留多少条事件（再多浏览器只是变慢；服务端每图也只留 300 条） */
const MAX_EVENTS = 300;
/** 陈旧阈值（毫秒）：超过它就明说「采集停了」，不再假装是「此刻」 */
const STALE_WARN_MS = 5000;

const COLOR = {
  alive: "#fb7185", // rose-400：场上的怪
  dead: "#64748b", // slate-500：倒了还没刷
  player: "#38bdf8", // sky-400：玩家
};

/** 时间戳 → 本地 `HH:MM:SS`（监控看的是「刚才」，日期只在 title 里给全） */
function clockOf(at: number): string {
  const date = new Date(at);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 轮询依赖的三个值走 ref：把它们放进 effect 依赖会让每次响应都重建定时器
  const cursorRef = useRef(0);
  const zoneRef = useRef<number | undefined>(undefined);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  /** 换图 / 换区 / 重新打开：游标与事件清空，从头拉一份「最近发生的事」 */
  useEffect(() => {
    cursorRef.current = 0;
    zoneRef.current = undefined;
    setZone(undefined);
    setEvents([]);
    setData(null);
    setError(null);
  }, [open, mapId]);

  /** 选区：只有服务端返回过多个区时才显示下拉 */
  const changeZone = (next: number) => {
    zoneRef.current = next;
    setZone(next);
    cursorRef.current = 0;
    setEvents([]);
  };

  const poll = useCallback(async () => {
    if (!open || !mapId || pausedRef.current) return;
    try {
      const next = await mapsApi.monitor(mapId, { zone: zoneRef.current, since: cursorRef.current, limit: 60 });
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
  }, [open, mapId, zone, poll]);

  const monsters = data?.monsters ?? [];
  const players = data?.players ?? [];
  const alive = monsters.filter((monster) => monster.alive).length;
  const stale = data?.staleMs ?? null;
  const isStale = stale !== null && stale > STALE_WARN_MS;

  return (
    <Modal
      open={open}
      title={
        <>
          实时监控 · {mapLabel || `#${mapId}`}
          {data ? <Badge tone={isStale ? "amber" : "green"}>{isStale ? "采集已停" : "实时"}</Badge> : null}
        </>
      }
      hint="每秒采样一次：怪物位置 / 血量 / 重生倒计时 + 玩家位置 + 击杀与掉落文字流。数据来自实时进程，没人在图里时采集会停（看右下角「最后采样」）。"
      size="xl"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto flex items-center gap-3 text-[11px] text-slate-500">
            <span>存活 {alive}</span>
            <span>倒下 {monsters.length - alive}</span>
            <span>玩家 {players.length}</span>
            <span>事件 {events.length}</span>
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
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
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
            />
          )}

          <p className="text-[11px] text-slate-500">
            坐标是世界坐标（原点 = 左上角、y 轴向上，与刷怪区同一口径）。鼠标停在点上能看到实例 id 与血量。
          </p>
        </div>

        <EventFeed events={events} paused={paused} />
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
}: {
  mapId: string;
  width: number;
  height: number;
  monsters: MapMonitorMonster[];
  players: MapMonitorPlayer[];
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
          return (
            <g key={monster.instanceId}>
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
                      : `已倒下 · ${remainText(monster.respawnInMs ?? 0)} 后重生`)}
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
 * 一行 = 一件事，按时间升序。**不合并同物品的多次击杀**：这一栏要回答的是「刚才发生了什么」，
 * 合并之后就看不出节奏（同一只怪被反复刷、某个角落一直在掉同一件东西）。
 */
function EventFeed({ events, paused }: { events: MapMonitorEvent[]; paused: boolean }) {
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
      <div className="flex items-center justify-between border-b border-slate-800 px-2.5 py-1.5">
        <span className="text-xs font-medium text-slate-300">文字流</span>
        <span className="text-[11px] text-slate-500">{paused ? "已暂停（不拉新数据）" : "鼠标悬停物品可看图"}</span>
      </div>
      <div ref={boxRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <p className="px-3 py-8 text-center text-[11px] text-slate-500">
            还没有事件。这条流只记世界进程看到的事：有人打死怪、怪刷新。空着说明这张图最近没人打怪 ——
            也可能是采集停了（看底部「最后采样」）。
          </p>
        ) : (
          events.map((event) => <EventRow key={event.id} event={event} />)
        )}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: MapMonitorEvent }) {
  const isKill = event.kind === "kill";
  const respawnIn = event.respawnAt > 0 ? event.respawnAt - Date.now() : 0;
  return (
    <div className="flex gap-2 border-b border-slate-800/60 px-2.5 py-1.5 last:border-b-0">
      <span className="w-[52px] shrink-0 font-mono text-[10px] leading-4 text-slate-500" title={new Date(event.at).toLocaleString()}>
        {clockOf(event.at)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-1 text-[11px]">
          <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${isKill ? "bg-rose-400" : "bg-emerald-400"}`} />
          <span className="text-slate-200">{event.label}</span>
          {isKill ? (
            <>
              <span className="text-slate-500">被</span>
              <span className="text-indigo-300">{event.killer || "（未知）"}</span>
              <span className="text-slate-500">打死</span>
            </>
          ) : (
            <span className="text-slate-500">刷新了</span>
          )}
          <span className="font-mono text-[10px] text-slate-500">
            ({Math.round(event.x)}, {Math.round(event.y)})
          </span>
        </div>

        {isKill ? (
          <>
            <div className="mt-0.5 text-[10px] text-slate-500">
              怪物位置 ({Math.round(event.x)}, {Math.round(event.y)}) · 下次刷新 {clockOf(event.respawnAt)}（剩 {remainText(respawnIn)}）
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
        ) : null}
      </div>
    </div>
  );
}
