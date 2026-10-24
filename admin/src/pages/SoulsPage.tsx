import { useCallback, useEffect, useState } from "react";
import { formatTime, PERMISSION, soulsApi } from "../api";
import type { PageResult, Soul } from "../api";
import { GameConfigDialog } from "../components/GameConfigDialog";
import type { GameConfigFormValue } from "../components/GameConfigDialog";
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
 */
export function SoulsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [keyword, setKeyword] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PageResult<Soul> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Soul | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // 一页 100：37 阶全量展示
  const SIZE = 100;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await soulsApi.list({ page, size: SIZE, keyword: query || undefined }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setQuery(keyword.trim());
  };

  const submitDialog = async (value: GameConfigFormValue): Promise<boolean> => {
    if (!editing) return false;
    try {
      await soulsApi.update(String(editing.level), {
        label: value.label,
        description: value.description,
        animation: value.animation,
        animationFrameRate: value.animationFrameRate,
        bindGold: value.bindGold,
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
      <div>
        <h1 className="text-lg font-semibold text-slate-50">战魂配置</h1>
        <p className="mt-1 text-xs text-slate-500">
          阶数序列固定（1..37），只可编辑、不可新增 / 删除。「升级消耗」是升到该阶要花的绑定元宝；属性加成随阶递增。
        </p>
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
                <th className={thClass}>阶数</th>
                <th className={thClass}>名称 / 描述</th>
                <th className={thClass}>升级消耗</th>
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
                    <span className="block font-medium text-slate-100">{item.label}</span>
                    <span className="mt-0.5 block max-w-[240px] truncate text-xs text-slate-500" title={item.description}>
                      {item.description}
                    </span>
                  </td>
                  <td className={`${tdClass} tabular-nums`}>{item.bindGold.toLocaleString()}</td>
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

        {data && data.total > SIZE ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            共 {data.total} 条
            <Button variant="outline" className="px-2 py-1 text-xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              上一页
            </Button>
            <span>
              {page} / {Math.ceil(data.total / SIZE)}
            </span>
            <Button
              variant="outline"
              className="px-2 py-1 text-xs"
              disabled={page >= Math.ceil(data.total / SIZE)}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </Button>
          </div>
        ) : null}
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
    </div>
  );
}
