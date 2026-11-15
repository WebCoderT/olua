import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { dropApi, itemIconOf, itemText, monsterIcon, PERMISSION } from "../api";
import type { MonsterDropIndexItem, MonsterDropIndexQuery, PageResult } from "../api";
import { FilterBar } from "../components/FilterBar";
import { GameIcon } from "../components/GameImage";
import { Pagination } from "../components/Pagination";
import { PageHeader } from "../components/PageHeader";
import { Badge, Button, Card, EmptyState, Field, Input, Notice, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";

/**
 * 怪物掉落反查（#805）
 *
 * 回答的是「**这件东西都有谁会掉**」—— 与「掉落表配置」页正好反过来：那边从怪物出发
 * 编辑它的池子，这边从物品出发看它散落在哪些怪身上。所以本页**只读**，
 * 改配置一律去怪物页（点行会带着 `?drop=<monsterKey>` 跳过去，那边直接开这只怪的弹窗）。
 *
 * 两种配置写法都摊平：内联条目池（`source=entries`）与引用具名表（`source=table`）。
 * 走兜底表（`source=none`）的怪**不产生行** —— 「走兜底」不是一个能跟别的条目比权重的条目。
 *
 * 反查是**配置**查询，不分区：配置全区共用一份。但管理端没有「无区」会话，
 * 请求头仍带 `X-Zone-Id`（由请求层统一加），本页不拿它筛数据。
 *
 * ```
 * __UI_CAPTURE__（截图清单 —— 截图工具按 id 逐状态出图，供人眼审；纪律：显示效果不写断言）
 *   loading      初始加载：Spinner 可见
 *   empty        没有命中：EmptyState 文案完整
 *   filled       有数据：怪物 × 物品的摊平行 + 权重 / 概率 / 件数 / 绑定
 *   filtered     只看某件物品：只剩引用它的怪
 *   no-perm      只读账号（无 drop:read）：整页换成权限提示
 * ```
 */

/** 每页条数（与服务端默认一致：反查行 = 怪物 × 条目，比配置页的 20 大） */
const PAGE_SIZE = 50;

const EMPTY_DRAFT = { goodId: "", monsterKey: "", keyword: "" };

type Draft = typeof EMPTY_DRAFT;

export function MonsterDropsPage() {
  const canRead = hasPermission(PERMISSION.DROP_READ);
  /** 跳去怪物页改配置要求另一个权限点（`gameConfig:read`），没有就不给跳，免得跳过去吃闭门羹 */
  const canJump = hasPermission(PERMISSION.GAME_CONFIG_READ);
  const navigate = useNavigate();

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [query, setQuery] = useState<Draft>(EMPTY_DRAFT);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<PageResult<MonsterDropIndexItem> | null>(null);
  const [loading, setLoading] = useState(true);

  const queryParams = useCallback(
    (): MonsterDropIndexQuery => ({
      goodId: query.goodId || undefined,
      monsterKey: query.monsterKey || undefined,
      keyword: query.keyword || undefined,
    }),
    [query],
  );

  const load = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    try {
      setData(await dropApi.monsterIndex({ ...queryParams(), page, size }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [canRead, page, size, queryParams]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    setPage(1);
    setQuery({ ...draft });
  };

  const resetSearch = () => {
    setDraft(EMPTY_DRAFT);
    setPage(1);
    setQuery(EMPTY_DRAFT);
  };

  /** 点一行：去怪物页并打开那只怪的掉落弹窗（怪物页读 `?drop=` 并清掉参数） */
  const openMonster = (monsterKey: string) => {
    if (!canJump) return;
    navigate(`/monsters?drop=${encodeURIComponent(monsterKey)}`);
  };

  if (!canRead) {
    return (
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
        <PageHeader title="怪物掉落" description="从物品出发看它散落在哪些怪身上。" />
        <Notice tone="warn" title="没有权限">
          当前账号没有「查看掉落记录」（`drop:read`）权限。
        </Notice>
      </div>
    );
  }

  const rows = data?.list ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <PageHeader
        title="怪物掉落"
        description={
          <>
            把每只怪的掉落池摊平成「怪物 × 物品」一行（含引用具名表的那部分）。
            <strong className="text-ink-4">只读</strong>：改配置去怪物页 —— 点任意一行会带着这只怪的 key
            跳过去并直接打开它的掉落弹窗。
          </>
        }
        actions={
          <Button variant="outline" onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      />

      <FilterBar
        loading={loading}
        onSearch={submitSearch}
        onReset={resetSearch}
        hint={
          canJump
            ? "「物品 id」是精确匹配（查这件东西谁掉），「物品关键字」是模糊匹配（记不全 id 时用）。"
            : "当前账号没有配置写权限，行不可点。"
        }
      >
        <Field label="物品 id" width="w-48">
          <Input
            value={draft.goodId}
            placeholder="精确（如 equip_sword_1）"
            onChange={(event) => setDraft({ ...draft, goodId: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
            }}
          />
        </Field>
        <Field label="物品关键字" width="w-44">
          <Input
            value={draft.keyword}
            placeholder="模糊匹配物品 id"
            onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
            }}
          />
        </Field>
        <Field label="怪物 key" width="w-44">
          <Input
            value={draft.monsterKey}
            placeholder="精确（如 slime_1）"
            onChange={(event) => setDraft({ ...draft, monsterKey: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
            }}
          />
        </Field>
      </FilterBar>

      <Card
        title="怪物 × 物品"
        actions={loading ? <Spinner /> : null}
        description={
          <>
            共 <span className="legend-num text-ink-2">{data?.total ?? 0}</span> 条（当前筛选）。
            按怪物 key、再按物品 id 排序 —— 同一只怪的条目挨在一起。
          </>
        }
      >
        {loading && data === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="没有命中任何掉落条目"
            description="换一个物品 id 试试；也可能这只怪走的是兜底表（兜底不产生反查行）。"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className={tableClass}>
                <thead className={theadClass}>
                  <tr>
                    <th className={thClass}>怪物</th>
                    <th className={thClass}>物品</th>
                    <th className={thClass}>来源</th>
                    <th className={`${thClass} text-right`}>权重</th>
                    <th className={`${thClass} text-right`}>概率</th>
                    <th className={`${thClass} text-right`}>件数</th>
                    <th className={thClass}>绑定</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <IndexRow key={`${row.monsterKey}·${row.goodId}`} row={row} clickable={canJump} onOpen={openMonster} />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              size={size}
              total={data?.total ?? 0}
              onChange={setPage}
              onSizeChange={(next) => {
                setSize(next);
                setPage(1);
              }}
            />
          </>
        )}
      </Card>

      <p className="text-xs text-ink-5">
        名字按**当前**配置查（查不到回落成 id）；权重是同一池内的相对值，概率是「抽中这一条之后再生效」。
        「绑定」= 这只怪强制绑定 **或** 这件物品掉出即绑定，与掉落结算的判定同一口径。
      </p>
    </div>
  );
}

/** 一行反查结果（整行可点：跳到怪物页并打开掉落弹窗） */
function IndexRow({
  row,
  clickable,
  onOpen,
}: {
  row: MonsterDropIndexItem;
  clickable: boolean;
  onOpen: (monsterKey: string) => void;
}) {
  return (
    <tr
      className={clickable ? "cursor-pointer transition hover:bg-surface-4/30" : "transition"}
      title={clickable ? "去怪物配置改这只怪的掉落" : undefined}
      onClick={() => onOpen(row.monsterKey)}
    >
      <td className={tdClass}>
        <span className="flex items-center gap-2">
          <GameIcon path={monsterIcon(row.monsterKey)} alt={row.monsterLabel} size={28} zoomable={false} />
          <span className="flex flex-col">
            <span className="text-ink-1">{row.monsterLabel}</span>
            <span className="font-mono text-xs text-ink-5">{row.monsterKey}</span>
          </span>
        </span>
      </td>
      <td className={tdClass}>
        <span className="flex items-center gap-2">
          <GameIcon path={itemIconOf(row.goodId)} alt={row.goodLabel} size={28} zoomable={false} />
          <span className="flex flex-col">
            <span className="text-ink-1">{row.goodLabel || itemText(row.goodId)}</span>
            <span className="font-mono text-xs text-ink-5">{row.goodId}</span>
          </span>
        </span>
      </td>
      <td className={tdClass}>
        {row.source === "table" ? (
          <span className="flex flex-col">
            <Badge tone="gold">引用具名表</Badge>
            <span className="mt-1 font-mono text-xs text-ink-5">{row.tableId}</span>
          </span>
        ) : (
          <Badge tone="muted">内联条目</Badge>
        )}
      </td>
      <td className={`${tdClass} legend-num text-right text-ink-3`}>{row.weight}</td>
      <td className={`${tdClass} legend-num text-right`}>
        {row.chance >= 1 ? <span className="text-jade">必掉</span> : <span className="text-ink-2">{Math.round(row.chance * 100)}%</span>}
      </td>
      <td className={`${tdClass} legend-num text-right text-ink-3`}>
        {row.minCount === row.maxCount ? row.minCount : `${row.minCount}~${row.maxCount}`}
      </td>
      <td className={tdClass}>
        {row.bound ? (
          <span className="flex flex-col items-start gap-1">
            <Badge tone="warn">绑定</Badge>
            <span className="text-xs text-ink-5">{bindSourceText(row)}</span>
          </span>
        ) : (
          <span className="text-ink-5">不绑</span>
        )}
      </td>
    </tr>
  );
}

/** 绑定是从哪来的：两个开关各自都会导致「掉出来就是绑定的」，分开说清楚才好排查 */
function bindSourceText(row: MonsterDropIndexItem): string {
  if (row.bindDrops && row.bindOnDrop) return "怪物绑定 + 物品绑定";
  if (row.bindDrops) return "怪物掉落强制绑定";
  return "物品掉出即绑定";
}
