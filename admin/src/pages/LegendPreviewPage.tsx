/**
 * legend 组件试衣间（#946 阶段一验收用，免登录路由）
 *
 * 把 ui.tsx 的每个组件按真实页面用法摆出来，数据硬编码，不依赖后端。
 * 用途：token 换皮后逐一人眼核对比度与层次；后续阶段四把 __UI_CAPTURE__
 * 状态清单接进来后，它就是设计系统的活文档。
 */
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Select, Spinner, StatCard, tdClass, thClass, theadClass, tableClass } from "../components/ui";

const ROWS = [
  { id: 1, name: "龙傲天", level: 87, cls: "战士", gold: 128_400, ban: "正常", at: "2026-11-14 09:12" },
  { id: 2, name: "沙城之主", level: 90, cls: "法师", gold: 2_140_000, ban: "封禁中", at: "2026-11-13 22:41" },
  { id: 3, name: "一刀999", level: 45, cls: "道士", gold: 9_800, ban: "正常", at: "2026-11-14 08:05" },
];

export function LegendPreviewPage() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <PageHeader title="legend 组件试衣间" description="token 换皮验收（#946 阶段一）· 数据硬编码 · 免登录" />

      <div className="grid grid-cols-4 gap-4">
        <StatCard label="账号总数" value="12,847" hint="今日 +36" />
        <StatCard label="角色总数" value="18,932" hint="今日 +52" />
        <StatCard label="在线账号" value="1,284" />
        <StatCard label="封禁中" value="7" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card title="按钮 · 字段" description="primary 金底深字 / outline / ghost / danger">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Button>主操作</Button>
              <Button variant="outline">次级</Button>
              <Button variant="ghost">幽灵</Button>
              <Button variant="danger">封禁</Button>
              <Button loading>加载中</Button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="账号" hint="3-20 字符"><Input placeholder="请输入账号" /></Field>
              <Field label="等级区间"><Select><option>全部</option><option>1-40</option></Select></Field>
              <Field label="只读展示" hint="要改的才给控件"><span className="text-sm text-ink-3">龙傲天</span></Field>
            </div>
          </div>
        </Card>

        <Card title="徽章 · 提示条" description="五 tone 徽章 / 四色提示条">
          <div className="flex flex-col gap-3">
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

      <Card title="角色列表" description="表格 + 排序头 + 选中行 + 行内动作（tableClass 系列的真实用法）">
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
                <tr key={r.id} className={i === 1 ? "bg-surface-3/60" : "hover:bg-surface-3/40"}>
                  <td className={tdClass}>
                    <span className="flex items-center gap-2">
                      <span className="inline-flex h-8 w-8 items-center justify-center border border-line bg-surface-3 text-xs text-ink-5">图</span>
                      <span className="text-ink-1">{r.name}</span>
                    </span>
                  </td>
                  <td className={tdClass}>{r.level}</td>
                  <td className={tdClass}>{r.cls}</td>
                  <td className={tdClass}>{r.gold.toLocaleString("en-US")}</td>
                  <td className={tdClass}><Badge tone={r.ban === "封禁中" ? "red" : "green"}>{r.ban}</Badge></td>
                  <td className={tdClass}>{r.at}</td>
                  <td className={tdClass}>
                    <span className="flex gap-1.5">
                      <Button variant="ghost" className="px-2 py-1 text-xs">查看</Button>
                      <Button variant="outline" className="px-2 py-1 text-xs">改数值</Button>
                      {r.ban === "封禁中" ? null : <Button variant="danger" className="px-2 py-1 text-xs">封禁</Button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card title="空态 / 加载">
          <div className="grid grid-cols-2 gap-3">
            <EmptyState title="暂无数据" description="调整筛选后重试" />
            <div className="flex items-center justify-center gap-2 py-12 text-ink-5"><Spinner /> 正在加载…</div>
          </div>
        </Card>
        <Card title="色阶" description="surface 0-4 · ink 1-6 · line 三档">
          {/* 类名必须写全字面量：Tailwind JIT 扫不到 `bg-${c}` 这种动态拼接 */}
          <div className="flex gap-1">
            <div className="h-8 flex-1 bg-surface-0" title="surface-0" />
            <div className="h-8 flex-1 bg-surface-1" title="surface-1" />
            <div className="h-8 flex-1 bg-surface-2" title="surface-2" />
            <div className="h-8 flex-1 bg-surface-3" title="surface-3" />
            <div className="h-8 flex-1 bg-surface-4" title="surface-4" />
          </div>
          <div className="mt-2 flex gap-1">
            <div className="h-6 flex-1 bg-ink-1" title="ink-1" />
            <div className="h-6 flex-1 bg-ink-2" title="ink-2" />
            <div className="h-6 flex-1 bg-ink-3" title="ink-3" />
            <div className="h-6 flex-1 bg-ink-4" title="ink-4" />
            <div className="h-6 flex-1 bg-ink-5" title="ink-5" />
            <div className="h-6 flex-1 bg-ink-6" title="ink-6" />
          </div>
          <div className="mt-2 flex gap-2 text-xs">
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
