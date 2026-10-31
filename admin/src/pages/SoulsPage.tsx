import { useCallback, useEffect, useState } from "react";
import { formatTime, PERMISSION, soulAnimation, soulsApi } from "../api";
import type { PageResult, Soul } from "../api";
import { GameConfigDialog } from "../components/GameConfigDialog";
import { GameFrame } from "../components/GameImage";
import type { GameConfigFormValue } from "../components/GameConfigDialog";
import { GameGrowthListDialog } from "../components/GameGrowthListDialog";
import { Pagination } from "../components/Pagination";
import { Button, Card, EmptyState, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 属性摘要（列表列太窄，只报几个关键数；完整数值在编辑弹窗里） */
function attributeSummary(item: Soul): string {
  const a = item.attributes;
  return `生命 ${a.maxHp} · 魔攻 ${a.magicAttack.min}~${a.magicAttack.max} · 魔防 ${a.magicDefense.min}~${a.magicDefense.max}`;
}

/**
 * 战魂配置管理
 *
 * 与称号页同构：等级（阶）序列固定（1..37，客户端配置 seed 落库），只有编辑、
 * 没有新建 / 删除；写操作要 `gameConfig:write`。战魂没有获得渠道概念
 * （获取走玩法），所以比称号页少一列与一个下拉。
 *
 * 成长列表（升级链：拖动排序 + 行内改消耗）以弹窗形式打开（#239），不在页面上常驻；
 * 升级消耗只在成长列表里显示和修改（#234 口径）。
 */
export function SoulsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [keyword, setKeyword] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [data, setData] = useState<PageResult<Soul> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Soul | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [growthOpen, setGrowthOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await soulsApi.list({ page, size, keyword: query || undefined }));
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
    setQuery(keyword.trim());
  };

  /** 每页条数变化：回第一页再拉（条数变了页码语义也变了） */
  const handleSizeChange = (next: number) => {
    setSize(next);
    setPage(1);
  };

  const submitDialog = async (value: GameConfigFormValue): Promise<boolean> => {
    if (!editing) return false;
    try {
      await soulsApi.update(String(editing.level), {
        label: value.label,
        description: value.description,
        animation: value.animation,
        animationFrameRate: value.animationFrameRate,
        // 弹窗没有价格输入：原样带回当前值，价格唯一修改口在成长列表（#234）
        bindGold: editing.bindGold,
        attributes: value.attributes,
      });
      toastSuccess(`战魂「${value.label}」已更新`);
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
          <h1 className="text-lg font-semibold text-slate-50">战魂配置</h1>
          <p className="mt-1 text-xs text-slate-500">
            阶数序列固定（1..37），只可编辑、不可新增 / 删除；属性加成随阶递增。
            升级消耗在「战魂成长列表」弹窗里显示和修改。
          </p>
        </div>
        <Button variant="outline" onClick={() => setGrowthOpen(true)}>
          战魂成长列表
        </Button>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">名称 / 描述</span>
            <Input
              value={keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </div>
          <Button onClick={submitSearch}>查询</Button>
          <Button
            variant="outline"
            onClick={() => {
              setKeyword("");
              setPage(1);
              setQuery("");
            }}
          >
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="战魂列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>图</th>
                <th className={thClass}>阶数</th>
                <th className={thClass}>名称 / 描述</th>
                <th className={thClass}>属性摘要</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.level} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>
                    <GameFrame atlas={soulAnimation(item.level)} alt={item.label} />
                  </td>
                  <td className={tdClass}>{item.level}</td>
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

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的战魂" description="换个关键字试试" /> : null}

        <Pagination page={page} size={size} total={data?.total ?? 0} onChange={setPage} onSizeChange={handleSizeChange} />
      </Card>

      <GameConfigDialog
        kind="soul"
        open={dialogOpen}
        initial={editing}
        onCancel={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSubmit={submitDialog}
      />

      <GameGrowthListDialog kind="soul" open={growthOpen} canWrite={canWrite} onClose={() => setGrowthOpen(false)} />
    </div>
  );
}
