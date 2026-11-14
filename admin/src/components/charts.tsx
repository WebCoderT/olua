/**
 * 看板图表（零依赖，手写 SVG / div）
 *
 * 不引图表库：这里只需要「折线 + 环形 + 条形」三种图形，而引一个库会把打包体积翻几倍，
 * 还得为它单独处理主题色与响应式。手写这几个够用，也更好控制。
 *
 * ## 颜色
 * 一律用 `var(--color-*)` 引用 `index.css` 的 token，**不写第二份色值**：
 * SVG 的 presentation attribute 按 CSS 值解析，所以 `stroke="var(--color-gold)"` 是成立的。
 * 需要两条不同颜色的线时，`currentColor` 解决不了，用变量名最直接。
 */

/** 折线图的一条线 */
export type LineSeries = {
  name: string;
  color: string;
  values: number[];
};

const CHART_W = 720;

/** 折线图的配色（与 legend 语义对齐：金 = 账号、火 = 角色，都是「新增」） */
export const SERIES_COLORS = {
  accounts: "var(--color-gold)",
  roles: "var(--color-ember-hi)",
} as const;

/** 环形图配色：金 → 火 → 玉 → 注意 → 弱墨，超过五类时循环取前五 */
export const SLICE_COLORS = [
  "var(--color-gold)",
  "var(--color-ember-hi)",
  "var(--color-jade)",
  "var(--color-warn)",
  "var(--color-ink-4)",
] as const;

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

/** 折线图：x 轴等距标签，y 轴从 0 起，含网格、面积渐变与末端光点 */
export function LineChart({ labels, series, height = 220 }: { labels: string[]; series: LineSeries[]; height?: number }) {
  const pad = { top: 14, right: 16, bottom: 26, left: 42 };
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

  const lineOf = (values: number[]) => values.map((value, index) => `${xOf(index)},${yOf(value)}`).join(" ");
  const areaOf = (values: number[]) =>
    `M${xOf(0)},${yOf(0)} L${values.map((value, index) => `${xOf(index)},${yOf(value)}`).join(" L")} L${xOf(values.length - 1)},${yOf(0)} Z`;

  return (
    <div className="flex flex-col gap-3">
      <svg viewBox={`0 0 ${CHART_W} ${height}`} className="w-full" role="img" aria-label="趋势折线图">
        <defs>
          {series.map((item, index) => (
            <linearGradient key={item.name} id={`area-${index}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={item.color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={item.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((value) => (
          <g key={value}>
            <line
              x1={pad.left}
              x2={CHART_W - pad.right}
              y1={yOf(value)}
              y2={yOf(value)}
              stroke="var(--color-line)"
              strokeWidth={1}
              strokeDasharray={value === 0 ? undefined : "2 4"}
            />
            <text x={pad.left - 8} y={yOf(value) + 3.5} textAnchor="end" fontSize={9} fill="var(--color-ink-5)" fontFamily="var(--font-mono)">
              {value}
            </text>
          </g>
        ))}
        {labels.map((label, index) => {
          if (index % stride !== 0 && index !== count - 1) return null;
          return (
            <text
              key={`${label}-${index}`}
              x={xOf(index)}
              y={height - 8}
              textAnchor="middle"
              fontSize={9}
              fill="var(--color-ink-5)"
              fontFamily="var(--font-mono)"
            >
              {label}
            </text>
          );
        })}
        {series.map((item, index) => (
          <g key={item.name}>
            <path d={areaOf(item.values)} fill={`url(#area-${index})`} />
            <polyline
              fill="none"
              stroke={item.color}
              strokeWidth={1.8}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={lineOf(item.values)}
            />
            {/* 只标末点：每个点都画会让 30 天视图变成一串珠子 */}
            <circle cx={xOf(count - 1)} cy={yOf(item.values[count - 1] ?? 0)} r={3} fill={item.color} />
          </g>
        ))}
      </svg>
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-ink-3">
        {series.map((item) => (
          <span key={item.name} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3.5" style={{ backgroundColor: item.color }} />
            {item.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * 环形图（分布用，三到五类）
 *
 * 用 `stroke-dasharray` 在圆上切段，不画 path 弧线 —— 段数少时更简单，也不会出现接缝毛边。
 * 中间留空放总数，比在图上飘数字好读。
 */
export function DonutChart({
  items,
  centerLabel,
  size = 168,
}: {
  items: { label: string; value: number }[];
  centerLabel?: string;
  size?: number;
}) {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const stroke = 16;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-5">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90" role="img" aria-label="分布环形图">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--color-surface-4)"
            strokeWidth={stroke}
          />
          {total > 0
            ? items.map((item, index) => {
                const length = (item.value / total) * circumference;
                const dash = `${Math.max(0, length - 2)} ${circumference - Math.max(0, length - 2)}`;
                const circle = (
                  <circle
                    key={item.label}
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke={SLICE_COLORS[index % SLICE_COLORS.length]}
                    strokeWidth={stroke}
                    strokeDasharray={dash}
                    strokeDashoffset={-offset}
                  />
                );
                offset += length;
                return circle;
              })
            : null}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="legend-num text-[20px] leading-none text-ink-1">{total.toLocaleString("zh-CN")}</span>
          {centerLabel ? <span className="mt-1.5 font-mono text-[9px] uppercase tracking-[.16em] text-ink-4">{centerLabel}</span> : null}
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-2">
        {items.map((item, index) => (
          <li key={item.label} className="flex items-center gap-2 text-xs">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: SLICE_COLORS[index % SLICE_COLORS.length] }}
            />
            <span className="truncate text-ink-3">{item.label}</span>
            <span className="legend-num ml-auto text-ink-2">{item.value.toLocaleString("zh-CN")}</span>
            <span className="legend-num w-9 text-right text-ink-5">
              {total > 0 ? `${Math.round((item.value / total) * 100)}%` : "—"}
            </span>
          </li>
        ))}
      </ul>
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
  if (items.length === 0) return <p className="py-6 text-center text-[11.5px] text-ink-5">{emptyText}</p>;

  const max = Math.max(1, ...items.map((item) => item.value));
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const barColor = {
    indigo: "bg-gradient-to-r from-gold/70 to-gold",
    emerald: "bg-gradient-to-r from-jade/60 to-jade",
    amber: "bg-gradient-to-r from-warn/60 to-warn",
  }[tone];

  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => (
        <li key={item.label} className="grid grid-cols-[minmax(64px,96px)_1fr_auto] items-center gap-3 text-xs">
          <span className="truncate text-ink-3" title={item.label}>
            {item.label}
          </span>
          <span className="h-1.5 overflow-hidden rounded-sm bg-surface-4">
            <span className={`block h-full rounded-sm ${barColor}`} style={{ width: `${(item.value / max) * 100}%` }} />
          </span>
          <span className="legend-num text-ink-2">
            {item.value.toLocaleString("zh-CN")}
            <span className="ml-1.5 text-ink-5">{total > 0 ? `${Math.round((item.value / total) * 100)}%` : ""}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
