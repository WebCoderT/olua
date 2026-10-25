import { useCallback, useEffect, useRef, useState } from "react";
import { formatTime, PERMISSION, soulsApi } from "../api";
import type { PageResult, Soul } from "../api";
import { GameConfigDialog } from "../components/GameConfigDialog";
import type { GameConfigFormValue } from "../components/GameConfigDialog";
import { Button, Card, EmptyState, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastError, toastSuccess } from "../store/toast";

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
 * **价格口径与称号一致（#232/#234）**：升级消耗只在上方「战魂成长列表」里显示和修改
 * （拖动排序 + 行内改价），主列表与编辑弹窗均不涉及价格。
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

  // —— 战魂成长列表（独立于主列表的「升级链」视图：拖动排序 + 行内改消耗）——
  const [upgradeItems, setUpgradeItems] = useState<Soul[]>([]);
  const [upgradeLoading, setUpgradeLoading] = useState(true);
  /** 正在拖动的行下标（dragstart 记下、drop 消费） */
  const dragFrom = useRef<number | null>(null);
  /** 行内价格草稿：阶数 → 输入框里的字符串（未碰过的行跟随服务端值） */
  const [priceDraft, setPriceDraft] = useState<Record<number, string>>({});
  const [savingPriceLevel, setSavingPriceLevel] = useState<number | null>(null);

  // 一页 100：37 阶全量展示
  const SIZE = 100;

  const loadUpgrade = useCallback(async () => {
    setUpgradeLoading(true);
    try {
      const list = await soulsApi.upgradeList();
      setUpgradeItems(list);
      setPriceDraft(Object.fromEntries(list.map((item) => [item.level, String(item.bindGold)])));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setUpgradeLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUpgrade();
  }, [loadUpgrade]);

  /** 拖动落位：本地先换好顺序（乐观更新），再把整串顺序提交服务端；失败回滚重拉 */
  const handleDrop = async (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to || !canWrite) return;
    const next = [...upgradeItems];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setUpgradeItems(next);
    try {
      await soulsApi.reorderUpgradeList({ levels: next.map((item) => item.level) });
      toastSuccess("成长列表顺序已保存");
    } catch {
      await loadUpgrade();
    }
  };

  /** 行内保存升级消耗（走主列表的部分更新接口，只改 bindGold） */
  const savePrice = async (level: number) => {
    const value = Number(priceDraft[level]);
    if (!Number.isInteger(value) || value < 0) {
      toastError("升级消耗必须是不小于 0 的整数");
      return;
    }
    setSavingPriceLevel(level);
    try {
      await soulsApi.update(String(level), { bindGold: value });
      toastSuccess(`阶数 ${level} 的升级消耗已保存`);
      await loadUpgrade();
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSavingPriceLevel(null);
    }
  };

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
        // 弹窗没有价格输入：原样带回当前值，价格唯一修改口在成长列表（#234）
        bindGold: editing.bindGold,
        attributes: value.attributes,
      });
      toastSuccess(`战魂「${value.label}」已更新`);
      setDialogOpen(false);
      setEditing(null);
      await load();
      await loadUpgrade();
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
          阶数序列固定（1..37），只可编辑、不可新增 / 删除。37 阶全量在上方「战魂成长列表」里，
          拖动顺序构成玩家的升级链（与阶数解耦）；升级消耗只在成长列表里显示和修改（本列表与编辑弹窗均不涉及价格）。
        </p>
      </div>

      <Card
        title="战魂成长列表"
        actions={upgradeLoading ? <Spinner /> : null}
        description={
          canWrite
            ? undefined
            : "当前角色没有「修改养成配置」权限：可以看顺序与消耗，不能拖动或改价。"
        }
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>顺序</th>
                <th className={thClass}>阶数</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>升级消耗</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {upgradeItems.map((item, index) => (
                <tr
                  key={item.level}
                  draggable={canWrite}
                  onDragStart={() => {
                    dragFrom.current = index;
                  }}
                  onDragOver={(event) => {
                    if (canWrite) event.preventDefault();
                  }}
                  onDrop={() => void handleDrop(index)}
                  className={`transition hover:bg-slate-800/30 ${canWrite ? "cursor-grab active:cursor-grabbing" : ""}`}
                >
                  <td className={`${tdClass} tabular-nums text-slate-400`}>{index + 1}</td>
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>
                    <span className="font-medium text-slate-100">{item.label}</span>
                  </td>
                  <td className={tdClass}>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        value={priceDraft[item.level] ?? String(item.bindGold)}
                        disabled={!canWrite}
                        className="w-28"
                        onChange={(event) => setPriceDraft({ ...priceDraft, [item.level]: event.target.value })}
                      />
                      <Button
                        variant="outline"
                        className="px-2.5 py-1 text-xs"
                        loading={savingPriceLevel === item.level}
                        disabled={!canWrite || Number(priceDraft[item.level]) === item.bindGold}
                        onClick={() => void savePrice(item.level)}
                      >
                        保存消耗
                      </Button>
                    </div>
                  </td>
                  <td className={`${tdClass} text-right text-xs text-slate-600`}>
                    {canWrite ? "拖动整行调整顺序" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!upgradeLoading && upgradeItems.length === 0 ? (
          <EmptyState title="成长列表还是空的" description="战魂配置 seed 后 37 阶会自动全量进入这里" />
        ) : null}
      </Card>

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
