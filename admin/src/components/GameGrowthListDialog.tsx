import { useCallback, useEffect, useRef, useState } from "react";
import { soulsApi, titlesApi } from "../api";
import { Button, EmptyState, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "./ui";
import { toastError, toastSuccess } from "../store/toast";

/** 成长列表一行的最小形状（Title / Soul 在这里的字段同构） */
interface GrowthItem {
  level: number;
  label: string;
  bindGold: number;
}

/** 两种成长列表的文案与接口适配（字段同构，只有称呼不同） */
const KIND_CONF = {
  title: {
    heading: "称号成长列表",
    levelLabel: "等级",
    priceLabel: "升级价格",
    saveLabel: "保存价格",
    priceInvalid: "升级价格必须是不小于 0 的整数",
    savedPrice: (level: number) => `等级 ${level} 的升级价格已保存`,
    fetch: () => titlesApi.upgradeList(),
    reorder: (levels: number[]) => titlesApi.reorderUpgradeList({ levels }),
    updatePrice: (level: number, bindGold: number) => titlesApi.update(String(level), { bindGold }),
    empty: {
      title: "成长列表还是空的",
      description: "在称号列表里把某个称号的获得渠道改为「称号升级」，它就会出现在这里",
    },
  },
  soul: {
    heading: "战魂成长列表",
    levelLabel: "阶数",
    priceLabel: "升级消耗",
    saveLabel: "保存消耗",
    priceInvalid: "升级消耗必须是不小于 0 的整数",
    savedPrice: (level: number) => `阶数 ${level} 的升级消耗已保存`,
    fetch: () => soulsApi.upgradeList(),
    reorder: (levels: number[]) => soulsApi.reorderUpgradeList({ levels }),
    updatePrice: (level: number, bindGold: number) => soulsApi.update(String(level), { bindGold }),
    empty: {
      title: "成长列表还是空的",
      description: "战魂配置 seed 后 37 阶会自动全量进入这里",
    },
  },
} as const;

/**
 * 成长列表弹窗（称号 / 战魂共用，#239）
 *
 * 独立于主列表的「升级链」视图：拖动整行调顺序（与等级号解耦）+ 行内改价格。
 * 价格唯一显示/修改口就在这里（#232/#234）；数据在**每次打开时**现拉，
 * 弹窗自己管自己的状态，页面只负责开关 —— 主列表的编辑保存不影响它。
 *
 * 权限：无 `gameConfig:write` 的观察员可以看顺序与价格，拖动与改价都被禁用。
 */
export function GameGrowthListDialog({
  kind,
  open,
  canWrite,
  onClose,
}: {
  kind: "title" | "soul";
  open: boolean;
  canWrite: boolean;
  onClose: () => void;
}) {
  const conf = KIND_CONF[kind];
  const [items, setItems] = useState<GrowthItem[]>([]);
  const [loading, setLoading] = useState(true);
  /** 正在拖动的行下标（dragstart 记下、drop 消费） */
  const dragFrom = useRef<number | null>(null);
  /** 行内价格草稿：等级 → 输入框里的字符串（未碰过的行跟随服务端值） */
  const [priceDraft, setPriceDraft] = useState<Record<number, string>>({});
  const [savingPriceLevel, setSavingPriceLevel] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await conf.fetch();
      setItems(list);
      setPriceDraft(Object.fromEntries(list.map((item) => [item.level, String(item.bindGold)])));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [conf]);

  // 每次打开都现拉一份（价格可能在主列表编辑或上次弹窗后被改过）
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  /** 拖动落位：本地先换好顺序（乐观更新），再把整串顺序提交服务端；失败回滚重拉 */
  const handleDrop = async (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to || !canWrite) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setItems(next);
    try {
      await conf.reorder(next.map((item) => item.level));
      toastSuccess("成长列表顺序已保存");
    } catch {
      await load();
    }
  };

  /** 行内保存价格（走主列表的部分更新接口，只改 bindGold） */
  const savePrice = async (level: number) => {
    const value = Number(priceDraft[level]);
    if (!Number.isInteger(value) || value < 0) {
      toastError(conf.priceInvalid);
      return;
    }
    setSavingPriceLevel(level);
    try {
      await conf.updatePrice(level, value);
      toastSuccess(conf.savedPrice(level));
      await load();
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSavingPriceLevel(null);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold text-slate-100">{conf.heading}</h3>
          {loading ? <Spinner /> : null}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {canWrite
            ? "拖动整行调整升级顺序；价格在这里显示和修改（主列表与编辑弹窗均不涉及价格）。"
            : "当前角色没有「修改养成配置」权限：可以看顺序与价格，不能拖动或改价。"}
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>顺序</th>
                <th className={thClass}>{conf.levelLabel}</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>{conf.priceLabel}</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, index) => (
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
                        {conf.saveLabel}
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

        {!loading && items.length === 0 ? <EmptyState title={conf.empty.title} description={conf.empty.description} /> : null}

        <div className="mt-5 flex justify-end">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
