/**
 * 看板图表（零依赖，手写 SVG / div）
 *
 * 不引图表库：这里只需要「折线 + 条形」两种图形，而引一个库会把打包体积翻几倍，
 * 还得为它单独处理主题色与响应式。手写这两个够用，也更好控制。
 *
 * 颜色写死十六进制而不是用 Tailwind class —— SVG 属性不吃 class，
 * 只有 `currentColor` 例外，而这里需要多条不同颜色的线。
 */

/** 折线图的一条线 */
export type LineSeries = {
  name: string;
  color: string;
  values: number[];
};

const CHART_W = 720;

/** 折线图的配色（与 Tailwind 的 indigo-400 / emerald-400 一致） */
export const SERIES_COLORS = {
  accounts: "#818cf8",
  roles: "#34d399",
} as const;

/**
 * 把最大值收成「好看」的刻度步长（1 / 2 / 5 × 10^n）
 *
 * 直接用 max/4 当步长会出现「3.7」这种刻度，读图的人要自己算。
 */
function niceStep(maxValue: number): number {
  const rough = maxValue / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, rough)));
  for (const factor of [1, 2, 5, 10]) {
    if (rough <= factor * magnitude) return factor * magnitude;
  }
  return 10 * magnitude;
}

/** 折线图：x 轴等距标签，y 轴从 0 起，含网格与图例 */
export function LineChart({ labels, series, height = 200 }: { labels: string[]; series: LineSeries[]; height?: number }) {
  const pad = { top: 12, right: 14, bottom: 26, left: 38 };
  const innerW = CHART_W - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const maxValue = Math.max(1, ...series.flatMap((item) => item.values));
  const step = niceStep(maxValue);
  const yMax = Math.max(step, step * Math.ceil(maxValue / step));
  const count = labels.length;

  const xOf = (index: number) => pad.left + (count <= 1 ? innerW / 2 : (index * innerW) / (count - 1));
  const yOf = (value: number) => pad.top + innerH - (value / yMax) * innerH;

  const ticks: number[] = [];
  for (let value = 0; value <= yMax; value += step) ticks.push(value);

  // 标签太密就抽稀：大约每 7 个显示一个，末位始终保留
  const stride = Math.max(1, Math.ceil(count / 7));

  return (
    <div className="flex flex-col gap-3">
      <svg viewBox={`0 0 ${CHART_W} ${height}`} className="w-full" role="img" aria-label="趋势折线图">
        {ticks.map((value) => (
          <g key={value}>
            <line x1={pad.left} x2={CHART_W - pad.right} y1={yOf(value)} y2={yOf(value)} stroke="#1e293b" strokeWidth={1} />
            <text x={pad.left - 6} y={yOf(value) + 3.5} textAnchor="end" fontSize={10} fill="#64748b">
              {value}
            </text>
          </g>
        ))}
        {labels.map((label, index) => {
          if (index % stride !== 0 && index !== count - 1) return null;
          return (
            <text key={label} x={xOf(index)} y={height - 8} textAnchor="middle" fontSize={10} fill="#64748b">
              {label}
            </text>
          );
        })}
        {series.map((item) => (
          <g key={item.name}>
            <polyline
              fill="none"
              stroke={item.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={item.values.map((value, index) => `${xOf(index)},${yOf(value)}`).join(" ")}
            />
            {item.values.map((value, index) => (
              <circle key={index} cx={xOf(index)} cy={yOf(value)} r={2.5} fill={item.color} />
            ))}
          </g>
        ))}
      </svg>
      <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400">
        {series.map((item) => (
          <span key={item.name} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />
            {item.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 水平条形列表（分布用）：名称 + 条 + 数量与占比 */
export function BarList({
  items,
  tone = "indigo",
  emptyText = "暂无数据",
}: {
  items: { label: string; value: number }[];
  tone?: "indigo" | "emerald" | "amber";
  emptyText?: string;
}) {
  if (items.length === 0) return <p className="py-6 text-center text-xs text-slate-500">{emptyText}</p>;

  const max = Math.max(1, ...items.map((item) => item.value));
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const barColor = { indigo: "bg-indigo-500/70", emerald: "bg-emerald-500/70", amber: "bg-amber-500/70" }[tone];

  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => (
        <li key={item.label} className="grid grid-cols-[minmax(68px,100px)_1fr_auto] items-center gap-3 text-xs">
          <span className="truncate text-slate-400" title={item.label}>
            {item.label}
          </span>
          <span className="h-2 overflow-hidden rounded-full bg-slate-800">
            <span className={`block h-full rounded-full ${barColor}`} style={{ width: `${(item.value / max) * 100}%` }} />
          </span>
          <span className="tabular-nums text-slate-300">
            {item.value}
            <span className="ml-1 text-slate-500">{total > 0 ? `${Math.round((item.value / total) * 100)}%` : ""}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
