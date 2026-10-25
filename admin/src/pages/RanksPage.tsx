import { useCallback, useEffect, useState } from "react";
import { formatTime, PERMISSION, ranksApi } from "../api";
import type { PageResult, Rank, RankQuery } from "../api";
import { GameConfigDialog } from "../components/GameConfigDialog";
import type { GameConfigFormValue } from "../components/GameConfigDialog";
import { GameGrowthListDialog } from "../components/GameGrowthListDialog";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 属性摘要（列表列太窄，只报几个关键数；完整数值在编辑弹窗里） */
function attributeSummary(item: Rank): string {
  const a = item.attributes;
  return `生命 ${a.maxHp} · 物攻 ${a.physicalAttack.min}~${a.physicalAttack.max} · 物防 ${a.physicalDefense.min}~${a.physicalDefense.max}`;
}

/**
 * 军衔配置管理（#250，养成配置第三页）
 *
 * **没有「新建」「删除」**：军衔阶数序列固定（1..100，来自客户端配置，启动时 seed 落库），
 * 只有「编辑」。军衔 100 阶全量就是成长链、顺序天然按阶 —— **没有拖动排序**，
 * 成长列表（弹窗）只做晋升价格与属性视图；主列表不显示价格（#250 口径与 #232/#234 一致）。
 * 写操作要 `gameConfig:write`，只读观察员能看不能改。
 */
export function RanksPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", tier: "" });
  const [query, setQuery] = useState({ keyword: "", tier: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<Rank> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Rank | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [growthOpen, setGrowthOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await ranksApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          tier: (query.tier || undefined) as RankQuery["tier"],
        }),
      );
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setQuery({ keyword: draft.keyword.trim(), tier: draft.tier });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", tier: "" });
    setPage(1);
    setQuery({ keyword: "", tier: "" });
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  /** 编辑弹窗提交（部分更新：只发弹窗里有的字段；属性整份替换；价格原样带回） */
  const submitDialog = async (value: GameConfigFormValue): Promise<boolean> => {
    if (!editing) return false;
    try {
      await ranksApi.update(String(editing.level), {
        label: value.label,
        tier: value.tier,
        description: value.description,
        // 弹窗没有价格输入：原样带回当前值，价格唯一修改口在成长列表（#250）
        bindGold: editing.bindGold,
        attributes: value.attributes,
      });
      toastSuccess(`军衔「${value.label}」已更新`);
      setDialogOpen(false);
      setEditing(null);
      await load();
      return true;
    } catch {
      return false;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-50">军衔配置</h1>
          <p className="mt-1 text-xs text-slate-500">
            阶数序列固定（1..100，10 大段 × 10 阶），只可编辑、不可新增 / 删除。晋升价格在「军衔成长列表」弹窗里显示和修改；
            军衔属性按阶映射角色等级再打折（#256 的成长曲线是它的基准），改曲线会连锁影响军衔强度。
          </p>
        </div>
        <Button variant="outline" onClick={() => setGrowthOpen(true)}>
          军衔成长列表
        </Button>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">衔名 / 大段 / 描述</span>
            <Input
              value={draft.keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="军衔列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>阶数</th>
                <th className={thClass}>大段</th>
                <th className={thClass}>名称 / 描述</th>
                <th className={thClass}>属性摘要</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.level} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>
                    <Badge tone="slate">{item.tier}</Badge>
                  </td>
                  <td className={tdClass}>
                    <span className="block font-medium text-slate-100">{item.label}</span>
                    <span className="mt-0.5 block max-w-[240px] truncate text-xs text-slate-500" title={item.description}>
                      {item.description}
                    </span>
                  </td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{attributeSummary(item)}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      disabled={!canWrite}
                      onClick={() => {
                        setEditing(item);
                        setDialogOpen(true);
                      }}
                    >
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的军衔" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <GameConfigDialog
        kind="rank"
        open={dialogOpen}
        initial={editing}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSubmit={submitDialog}
      />

      <GameGrowthListDialog kind="rank" open={growthOpen} canWrite={canWrite} onClose={() => setGrowthOpen(false)} />
    </div>
  );
}
