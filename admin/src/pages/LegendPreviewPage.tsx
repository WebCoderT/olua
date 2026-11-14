/**
 * legend 组件试衣间（#946 阶段验收用，免登录路由 `/legend-preview`）
 *
 * 把 `components/` 的每个组件按真实页面用法摆出来，数据硬编码，不依赖后端。
 * 用途：改完 token / 组件后逐段人眼核对（对比度、层次、间距、圆角），
 * 并作为设计系统的活文档 —— 新页面要什么控件，先在这里看到它长什么样。
 *
 * **不做像素断言**：显示效果由人看，自动化只保证「能构建、不报错」（纪律见 MEMORY）。
 */
import { BarList, DonutChart, LineChart, SERIES_COLORS } from "../components/charts";
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Select, Spinner, StatCard, tdClass, thClass, theadClass, tableClass } from "../components/ui";

const ROWS = [
  { id: 1, name: "龙傲天", level: 87, cls: "战士", gold: 128_400, ban: "正常", at: "2026-11-14 09:12" },
  { id: 2, name: "沙城之主", level: 90, cls: "法师", gold: 2_140_000, ban: "封禁中", at: "2026-11-13 22:41" },
  { id: 3, name: "一刀999", level: 45, cls: "道士", gold: 9_800, ban: "正常", at: "2026-11-14 08:05" },
  { id: 4, name: "沉默的羔羊", level: 12, cls: "战士", gold: 320, ban: "正常", at: "2026-11-12 19:30" },
];

/** 固定序列：试衣间不引入随机，每次刷新形状一致才能比对 */
const TREND_LABELS = Array.from({ length: 14 }, (_, i) => `11-${String(i + 1).padStart(2, "0")}`);
const TREND_ACCOUNTS = [12, 18, 9, 24, 31, 22, 27, 35, 29, 41, 38, 46, 52, 44];
const TREND_ROLES = [8, 14, 6, 19, 25, 17, 21, 30, 24, 33, 31, 39, 44, 37];

export function LegendPreviewPage() {
  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-4 px-6 py-5">
      <PageHeader
        title="legend 组件试衣间"
        description="设计系统验收页 · 数据硬编码 · 免登录。控件形状与色阶都在这里定稿，页面只做布局。"
        actions={<Badge tone="indigo">#946</Badge>}
      />

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="账号总数" value={12847} hint="今日新增 36" />
        <StatCard label="角色总数" value={18932} hint="今日新增 52" />
        <StatCard label="在线账号" value={1284} hint="已选中在线角色" />
        <StatCard label="封禁中" value={7} hint="含永久与未到期临时封禁" />
      </div>

      <div className="grid grid-cols-12 gap-3.5">
        <div className="col-span-12 xl:col-span-8">
          <Card
            title="增长趋势"
            description="近 14 天：新增账号 456 · 新增角色 348"
            actions={
              <div className="inline-flex overflow-hidden rounded-sm border border-line">
                <button type="button" className="legend-num px-2.5 py-1 text-[11px] text-ink-4 hover:bg-gold-veil">
                  7 天
                </button>
                <button type="button" className="legend-num border-l border-line bg-gradient-to-b from-gold-hi to-gold px-2.5 py-1 text-[11px] font-semibold text-surface-0">
                  14 天
                </button>
                <button type="button" className="legend-num border-l border-line px-2.5 py-1 text-[11px] text-ink-4 hover:bg-gold-veil">
                  30 天
                </button>
              </div>
            }
          >
            <LineChart
              labels={TREND_LABELS}
              series={[
                { name: "新增账号", color: SERIES_COLORS.accounts, values: TREND_ACCOUNTS },
                { name: "新增角色", color: SERIES_COLORS.roles, values: TREND_ROLES },
              ]}
            />
          </Card>
        </div>
        <div className="col-span-12 xl:col-span-4">
          <Card title="职业分布" description="环形图：最多五类，超出取前五">
            <DonutChart
              items={[
                { label: "战士", value: 7820 },
                { label: "法师", value: 6410 },
                { label: "道士", value: 4702 },
              ]}
              centerLabel="角色"
            />
          </Card>
        </div>
        <div className="col-span-12 lg:col-span-6">
          <Card title="等级分布" description="横向条：金 = 主指标">
            <BarList
              items={[
                { label: "1-10 级", value: 1840 },
                { label: "11-20 级", value: 2410 },
                { label: "21-30 级", value: 1980 },
                { label: "31-40 级", value: 1520 },
                { label: "41-50 级", value: 980 },
              ]}
            />
          </Card>
        </div>
        <div className="col-span-12 lg:col-span-6">
          <Card title="所在地图" description="横向条：注意色 = 非阻断异常 / 次要维度">
            <BarList
              tone="amber"
              items={[
                { label: "地图 1", value: 3200 },
                { label: "地图 3", value: 2100 },
                { label: "地图 7", value: 1400 },
                { label: "地图 12", value: 620 },
              ]}
            />
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <Card title="按钮 · 字段" description="primary 金底深字 / outline / ghost / danger / 加载">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button>主操作</Button>
              <Button variant="outline">次级</Button>
              <Button variant="ghost">幽灵</Button>
              <Button variant="danger">封禁</Button>
              <Button loading>加载中</Button>
              <Button disabled>禁用</Button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="账号">
                <Input placeholder="请输入账号" />
              </Field>
              <Field label="等级区间">
                <Select defaultValue="all">
                  <option value="all">全部</option>
                  <option value="1-40">1-40 级</option>
                  <option value="41-80">41-80 级</option>
                </Select>
              </Field>
              <Field label="只读展示" hint="要改的才给控件">
                <span className="text-sm text-ink-3">龙傲天</span>
              </Field>
            </div>
          </div>
        </Card>

        <Card title="徽章 · 提示条" description="五 tone 徽章 / 四色提示条：左缘竖条标严重度">
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap gap-2">
              <Badge>默认</Badge>
              <Badge tone="indigo">金 · 选中</Badge>
              <Badge tone="green">在线</Badge>
              <Badge tone="amber">注意</Badge>
              <Badge tone="red">封禁</Badge>
            </div>
            <Notice tone="slate">说明：数值不锁出厂值，改库后 1s TTL 现取。</Notice>
            <Notice tone="amber">注意：本次重构不含行为变更，只换视觉。</Notice>
            <Notice tone="emerald">正常：服务在线，实时通道已连接。</Notice>
            <Notice tone="red">错误：封禁失败，该账号已解封。</Notice>
          </div>
        </Card>
      </div>

      <Card title="角色列表" description="表格 + 选中行 + 行内动作（tableClass 系列的真实用法）">
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>角色</th>
                <th className={thClass}>等级 ↓</th>
                <th className={thClass}>职业</th>
                <th className={thClass}>金币</th>
                <th className={thClass}>状态</th>
                <th className={thClass}>最后登录</th>
                <th className={thClass}>操作</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r, i) => (
                <tr key={r.id} className={i === 1 ? "bg-gold/6" : "hover:bg-surface-3/40"}>
                  <td className={tdClass}>
                    <span className="flex items-center gap-2">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-sm border border-line bg-surface-3 text-xs text-ink-5">
                        图
                      </span>
                      <span className="text-ink-1">{r.name}</span>
                    </span>
                  </td>
                  <td className={`${tdClass} legend-num`}>{r.level}</td>
                  <td className={tdClass}>{r.cls}</td>
                  <td className={`${tdClass} legend-num`}>{r.gold.toLocaleString("zh-CN")}</td>
                  <td className={tdClass}>
                    <Badge tone={r.ban === "封禁中" ? "red" : "green"}>{r.ban}</Badge>
                  </td>
                  <td className={`${tdClass} legend-num text-[11.5px] text-ink-4`}>{r.at}</td>
                  <td className={tdClass}>
                    <span className="flex gap-1.5">
                      <Button variant="ghost" className="px-2 py-1 text-xs">
                        查看
                      </Button>
                      <Button variant="outline" className="px-2 py-1 text-xs">
                        改数值
                      </Button>
                      {r.ban === "封禁中" ? null : (
                        <Button variant="danger" className="px-2 py-1 text-xs">
                          封禁
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <Card title="空态 / 加载">
          <div className="grid grid-cols-2 gap-3">
            <EmptyState title="暂无数据" description="调整筛选后重试" />
            <div className="flex items-center justify-center gap-2 py-12 text-ink-5">
              <Spinner /> 正在加载…
            </div>
          </div>
        </Card>
        <Card title="色阶" description="surface 0-4 · ink 1-6 · 语义色（类名必须写全字面量，JIT 扫不到动态拼接）">
          <div className="flex gap-1">
            <div className="h-8 flex-1 rounded-sm bg-surface-0" title="surface-0" />
            <div className="h-8 flex-1 rounded-sm bg-surface-1" title="surface-1" />
            <div className="h-8 flex-1 rounded-sm bg-surface-2" title="surface-2" />
            <div className="h-8 flex-1 rounded-sm bg-surface-3" title="surface-3" />
            <div className="h-8 flex-1 rounded-sm bg-surface-4" title="surface-4" />
          </div>
          <div className="mt-2 flex gap-1">
            <div className="h-6 flex-1 bg-ink-1" title="ink-1" />
            <div className="h-6 flex-1 bg-ink-2" title="ink-2" />
            <div className="h-6 flex-1 bg-ink-3" title="ink-3" />
            <div className="h-6 flex-1 bg-ink-4" title="ink-4" />
            <div className="h-6 flex-1 bg-ink-5" title="ink-5" />
            <div className="h-6 flex-1 bg-ink-6" title="ink-6" />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-3 text-xs">
            <span className="text-gold">gold 主色</span>
            <span className="text-gold-hi">gold-hi</span>
            <span className="text-ember">ember 危险</span>
            <span className="text-ember-hi">ember-hi</span>
            <span className="text-jade">jade 在线</span>
            <span className="text-warn">warn 注意</span>
          </div>
        </Card>
      </div>
    </div>
  );
}
