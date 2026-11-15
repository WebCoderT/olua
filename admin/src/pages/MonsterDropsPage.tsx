import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { dropApi, itemText } from "../api";
import type { MonsterDropIndexPage } from "../api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Spinner,
  tableClass,
  tdClass,
  thClass,
  theadClass,
} from "../components/ui";
import { FilterBar } from "../components/FilterBar";
import { Pagination } from "../components/Pagination";
import { PageHeader } from "../components/PageHeader";

const PAGE_SIZE = 50;

const EMPTY_DRAFT = { goodId: "", monsterKey: "" };

type Draft = typeof EMPTY_DRAFT;

/**
 * 怪物掉落反查（#805）—— 「这件东西都有谁会掉」
 *
 * 把每只怪的掉落池**摊平**成「怪物 × 物品」的行：内联条目池与引用具名表两种写法都在这里
 * 展开（只看「怪物配置页里手写的那几条」会漏掉引用表的怪）。所以这一页是**配置的横向视图**，
 * 不是运行数据 —— 要看「实际掉过什么」去「掉落流水」。
 *
 * 绑定是「合成结论」：怪物级 `bind_drops` 与物品级 `bind_on_drop` 取「或」，任一为真掉出来
 * 就是绑定的。两列都列出来，是为了回答「为什么这件是绑定的」。
 *
 * 配置不分区（全区共用一份），所以切区不影响这一页的内容。
 *
 * ```
 * __UI_CAPTURE__（截图清单 —— 截图工具按 id 逐状态出图，供人眼审；纪律：显示效果不写断言）
 *   loading      初始加载：Spinner 可见
 *   empty        空数据：EmptyState 文案完整
 *   filled       有数据：表格行（含来源徽章与绑定列）
 *   filtered     按物品 / 怪物筛选后的结果
 * ```
 */
export function MonsterDropsPage() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [query, setQuery] = useState<Draft>(EMPTY_DRAFT);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<MonsterDropIndexPage | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await dropApi.monsterIndex({
        goodId: query.goodId || undefined,
        monsterKey: query.monsterKey || undefined,
        page,
        size,
      });
      setData(result);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, query, size]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.list ?? [];

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4">
      <PageHeader
        title="怪物掉落"
        description="按「怪物 × 物品」摊平的配置反查：这件东西谁会掉、权重多少、掉出来绑不绑（配置全区共用，不随切区变化）"
      />

      <FilterBar
        onSearch={() => {
          setQuery(draft);
          setPage(1);
        }}
        onReset={() => {
          setDraft(EMPTY_DRAFT);
          setQuery(EMPTY_DRAFT);
          setPage(1);
        }}
        loading={loading}
      >
        <Field label="物品 id" width="w-56">
          <Input
            value={draft.goodId}
            onChange={(event) => setDraft({ ...draft, goodId: event.target.value })}
            placeholder="精确匹配，如 equip_sword_01"
          />
        </Field>
        <Field label="怪物 key" width="w-48">
          <Input
            value={draft.monsterKey}
            onChange={(event) => setDraft({ ...draft, monsterKey: event.target.value })}
            placeholder="精确匹配，如 slime_1"
          />
        </Field>
      </FilterBar>

      <Card
        title="掉落反查"
        actions={loading ? <Spinner /> : null}
        description="一行 = 一只怪 × 一件物品。引用具名表的怪也会展开（来源列显示表 id）。改配置请去怪物配置页。"
      >
        {loading && data === null ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="没有匹配的掉落条目"
            description="换物品 id 或怪物 key 试试；也可能这只怪没配掉落（走兜底表，不会出现在这张反查里）"
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
                    <th className={thClass}>权重</th>
                    <th className={thClass}>概率</th>
                    <th className={thClass}>件数</th>
                    <th className={thClass}>绑定</th>
                    <th className={`${thClass} text-right`}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.monsterKey}::${row.goodId}`} className="transition hover:bg-surface-4/30">
                      <td className={`${tdClass} font-medium text-ink-1`}>
                        {row.monsterLabel}
                        <span className="ml-2 font-mono text-[11px] text-ink-5">{row.monsterKey}</span>
                      </td>
                      <td className={tdClass}>
                        {itemText(row.goodId)}
                        <span className="ml-2 font-mono text-[11px] text-ink-5">{row.goodId}</span>
                      </td>
                      <td className={tdClass}>
                        {row.source === "table" ? (
                          <Badge tone="gold">引用表 {row.tableId ?? "?"}</Badge>
                        ) : (
                          <Badge tone="muted">内联</Badge>
                        )}
                      </td>
                      <td className={`${tdClass} legend-num`}>{row.weight}</td>
                      <td className={`${tdClass} legend-num`}>{(row.chance * 100).toFixed(1)}%</td>
                      <td className={`${tdClass} legend-num`}>
                        {row.minCount === row.maxCount ? row.minCount : `${row.minCount}~${row.maxCount}`}
                      </td>
                      <td className={tdClass}>
                        {row.bound ? (
                          <Badge tone="ember">{row.bindDrops ? "怪物强制" : "物品绑定"}</Badge>
                        ) : (
                          <span className="text-ink-5">可交易</span>
                        )}
                      </td>
                      <td className={`${tdClass} text-right`}>
                        <Button
                          variant="ghost"
                          className="px-2 py-1 text-xs"
                          onClick={() => navigate(`/monsters?open=${encodeURIComponent(row.monsterKey)}`)}
                        >
                          去怪物配置
                        </Button>
                      </td>
                    </tr>
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
      <p className="text-[11px] text-ink-5">
        概率 = 抽中后再判定的 `chance`（不是「这件东西占总掉落的百分比」）；权重同一池内才有可比性。
      </p>
    </div>
  );
}
