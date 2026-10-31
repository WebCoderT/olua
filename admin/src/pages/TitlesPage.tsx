import { useCallback, useEffect, useState } from "react";
import { ACQUIRE_CHANNEL_LABELS, formatTime, PERMISSION, titleAnimation, titlesApi } from "../api";
import type { PageResult, Title, TitleQuery } from "../api";
import { GameConfigDialog } from "../components/GameConfigDialog";
import { GameFrame } from "../components/GameImage";
import type { GameConfigFormValue } from "../components/GameConfigDialog";
import { GameGrowthListDialog } from "../components/GameGrowthListDialog";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 渠道徽章配色：可升级的绿、赠送的蓝、暂不放出的灰 */
const CHANNEL_TONE: Record<string, "green" | "indigo" | "slate"> = {
  upgrade: "green",
  grant: "indigo",
  unavailable: "slate",
};

/** 属性摘要（列表列太窄，只报几个关键数；完整数值在编辑弹窗里） */
function attributeSummary(item: Title): string {
  const a = item.attributes;
  return `生命 ${a.maxHp} · 物攻 ${a.physicalAttack.min}~${a.physicalAttack.max} · 物防 ${a.physicalDefense.min}~${a.physicalDefense.max}`;
}

/**
 * 称号配置管理（养成配置第一页）
 *
 * **没有「新建」「删除」**：称号等级序列固定（1..34，来自客户端配置，启动时 seed 落库），
 * 这里只有「编辑」——这是需求方明确的边界，不是漏了（服务端也没有 POST/DELETE 路由）。
 * 写操作要 `gameConfig:write`，只读观察员能看不能改；越权会被服务端拦成 403 / 30006。
 *
 * 成长列表（升级链：拖动排序 + 行内改价）以弹窗形式打开（#239），不在页面上常驻。
 */
export function TitlesPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", channel: "" });
  const [query, setQuery] = useState({ keyword: "", channel: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [data, setData] = useState<PageResult<Title> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Title | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [growthOpen, setGrowthOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await titlesApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          acquireChannel: (query.channel || undefined) as TitleQuery["acquireChannel"],
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
    setQuery({ keyword: draft.keyword.trim(), channel: draft.channel });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", channel: "" });
    setPage(1);
    setQuery({ keyword: "", channel: "" });
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  /** 编辑弹窗提交（部分更新：只发弹窗里有的字段；属性整份替换） */
  const submitDialog = async (value: GameConfigFormValue): Promise<boolean> => {
    if (!editing) return false;
    try {
      await titlesApi.update(String(editing.level), {
        label: value.label,
        description: value.description,
        animation: value.animation,
        animationFrameRate: value.animationFrameRate,
        // 弹窗没有价格输入：原样带回当前值，价格唯一修改口在成长列表（#232）
        bindGold: editing.bindGold,
        acquireChannel: value.acquireChannel as Title["acquireChannel"],
        attributes: value.attributes,
      });
      toastSuccess(`称号「${value.label}」已更新`);
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
          <h1 className="text-lg font-semibold text-slate-50">称号配置</h1>
          <p className="mt-1 text-xs text-slate-500">
            等级序列固定（1..34），只可编辑、不可新增 / 删除。获得渠道默认「无法获取」，由运营逐个开放（系统赠送的发放逻辑暂未实现）；
            升级价格在「称号成长列表」弹窗里显示和修改。
          </p>
        </div>
        <Button variant="outline" onClick={() => setGrowthOpen(true)}>
          称号成长列表
        </Button>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">名称 / 描述</span>
            <Input
              value={draft.keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <div className="w-36">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">获得渠道</span>
            <Select value={draft.channel} onChange={(event) => setDraft({ ...draft, channel: event.target.value })}>
              <option value="">全部</option>
              {Object.entries(ACQUIRE_CHANNEL_LABELS).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="称号列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>图</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>名称 / 描述</th>
                <th className={thClass}>获得渠道</th>
                <th className={thClass}>属性摘要</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.level} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <GameFrame atlas={titleAnimation(item.level)} alt={item.label} />
                  </td>
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>
                    <span className="block font-medium text-slate-100">{item.label}</span>
                    <span className="mt-0.5 block max-w-[240px] truncate text-xs text-slate-500" title={item.description}>
                      {item.description}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <Badge tone={CHANNEL_TONE[item.acquireChannel] ?? "slate"}>
                      {ACQUIRE_CHANNEL_LABELS[item.acquireChannel] ?? item.acquireChannel}
                    </Badge>
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

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的称号" description="换个筛选条件试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <GameConfigDialog
        kind="title"
        open={dialogOpen}
        initial={editing}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSubmit={submitDialog}
      />

      <GameGrowthListDialog kind="title" open={growthOpen} canWrite={canWrite} onClose={() => setGrowthOpen(false)} />
    </div>
  );
}
