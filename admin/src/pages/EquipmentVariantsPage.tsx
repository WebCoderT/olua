import { useCallback, useEffect, useMemo, useState } from "react";
import { equipmentMetaApi, equipmentVariantsApi, formatTime, PERMISSION } from "../api";
import type { ConfigAttributes, EquipmentVariant, PageResult } from "../api";
import { AttributesGrid, crossedRangeKeys } from "../components/AttributesEditor";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Badge, Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/** 属性摘要（列表列窄，只报关键几项；完整八项在编辑弹窗里） */
function summaryOf(item: EquipmentVariant): string {
  const a = item.attributes;
  return `生命 ${a.maxHp} · 物攻 ${a.physicalAttack.min}~${a.physicalAttack.max} · 物防 ${a.physicalDefense.min}~${a.physicalDefense.max}`;
}

/**
 * 装备变体逐件配置（#655）
 *
 * 每件基础件展开 5 前缀 × 3 后缀 = 15 行，**每行都是最终值**。
 * 以前变体是「基础件 × 前后缀倍率」在运行时现算的，改一个基础件会连带 15 个变体一起变，
 * 运营想「只把某一件的 +4 前缀调强一点」做不到。现在每行独立可改。
 *
 * ## 品质文案为什么从装备规则里取
 * 前后缀的中文名（普通的 / 精良…）住在 `equipment_meta`（「装备设置」页可改），
 * 变体表只存序号 —— 文案改一次全场跟着变，不需要逐行改。
 *
 * ## 为什么不能新建 / 删除
 * 变体 id 由「基础件 × 前后缀」确定（`cloth_1_p3s2`）；删掉一行会让背包里已存在的
 * 那件装备查不到配置（客户端建表时直接缺项）。要「关掉」一件，改数值即可。
 */
export function EquipmentVariantsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [draft, setDraft] = useState({ keyword: "", baseId: "" });
  const [query, setQuery] = useState({ keyword: "", baseId: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<EquipmentVariant> | null>(null);
  const [loading, setLoading] = useState(true);
  const [labels, setLabels] = useState<{ prefix: string[]; suffix: string[] }>({ prefix: [], suffix: [] });
  const [editing, setEditing] = useState<EquipmentVariant | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await equipmentVariantsApi.list({
          page,
          size,
          keyword: query.keyword || undefined,
          baseId: query.baseId || undefined,
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

  /** 品质文案只拉一次（改文案在「装备设置」页，进本页时取当前值即可） */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const meta = await equipmentMetaApi.get();
        if (alive) setLabels({ prefix: meta.prefixLabels ?? [], suffix: meta.suffixLabels ?? [] });
      } catch {
        /* 文案取不到不影响改数值 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const submitSearch = () => {
    setPage(1);
    setQuery({ keyword: draft.keyword.trim(), baseId: draft.baseId.trim() });
  };

  const resetSearch = () => {
    setDraft({ keyword: "", baseId: "" });
    setPage(1);
    setQuery({ keyword: "", baseId: "" });
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="装备变体"
        description={
          <>
            每件基础件 15 行（5 前缀 × 3 后缀），每行都是最终数值（#655）。
            改哪一件就只影响哪一件；保存后服务端下一笔结算即按新值，玩家下次进游戏拉配置后同步。
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-56" label="变体 id / 名称">
            <Input
              value={draft.keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </Field>
          <Field width="w-44" label="只看某个基础件">
            <Input
              value={draft.baseId}
              placeholder="如 cloth_1"
              onChange={(event) => setDraft({ ...draft, baseId: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
              }}
            />
          </Field>
          <Button onClick={submitSearch}>查询</Button>
          <Button variant="outline" onClick={resetSearch}>
            重置
          </Button>
        </div>
      </Card>

      <Card
        title="变体列表"
        actions={loading ? <Spinner /> : null}
        description={
          canWrite
            ? "「前缀 / 后缀」的中文名在「装备设置」页统一维护，这里按序号显示。"
            : "当前角色没有「修改养成配置」权限，列表只读。"
        }
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>变体 id</th>
                <th className={thClass}>名称</th>
                <th className={thClass}>品质</th>
                <th className={thClass}>等级</th>
                <th className={thClass}>回收价</th>
                <th className={thClass}>属性摘要</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((item) => (
                <tr key={item.id} className="transition hover:bg-slate-800/30">
                  <td className={`${tdClass} font-mono text-xs text-slate-300`}>{item.id}</td>
                  <td className={`${tdClass} font-medium text-slate-100`}>{item.label}</td>
                  <td className={tdClass}>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone="indigo">{labels.prefix[item.prefix] ?? `前缀 ${item.prefix}`}</Badge>
                      <Badge tone="slate">{labels.suffix[item.suffix] ?? `后缀 ${item.suffix}`}</Badge>
                    </div>
                  </td>
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>{item.sellPrice}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{summaryOf(item)}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      disabled={!canWrite}
                      onClick={() => setEditing(item)}
                    >
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? (
          <EmptyState title="没有匹配的变体" description="换个筛选条件试试（基础件 id 形如 cloth_1）" />
        ) : null}

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
      </Card>

      {editing ? (
        <VariantEditDialog
          row={editing}
          labels={labels}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 变体编辑弹窗
 *
 * 开放 `label` / `level` / `sellPrice` / 八项属性（服务端 `UpdateEquipmentVariantDto` 的字段集合）。
 * 显示字段（图标 / 图集 / 几何 / 职业限制）**跟着基础件走**，不在这里改 ——
 * 同一件装备的 15 个变体外观相同，逐个改会立刻产生 15 份不一致。
 */
function VariantEditDialog({
  row,
  labels,
  onClose,
  onSaved,
}: {
  row: EquipmentVariant;
  labels: { prefix: string[]; suffix: string[] };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(row.label);
  const [level, setLevel] = useState(String(row.level));
  const [sellPrice, setSellPrice] = useState(String(row.sellPrice));
  const [attributes, setAttributes] = useState<ConfigAttributes>({ ...row.attributes });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const crossed = useMemo(() => crossedRangeKeys(attributes), [attributes]);

  const levelValid = /^\d+$/.test(level.trim()) && Number(level) >= 1;
  const priceValid = /^\d+$/.test(sellPrice.trim()) && Number(sellPrice) >= 0;
  const labelValid = label.trim().length > 0 && label.trim().length <= 50;
  const canSave = labelValid && levelValid && priceValid && crossed.length === 0 && !saving;

  const save = async () => {
    if (!canSave) {
      setError("名称需为 1~50 字、等级 ≥ 1、回收价 ≥ 0 的整数，且六项区间下限不能大于上限。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await equipmentVariantsApi.update(row.id, {
        label: label.trim(),
        level: Number(level),
        sellPrice: Number(sellPrice),
        attributes,
      });
      toastSuccess(`变体「${label.trim()}」已保存（服务端下一笔结算即按新值；玩家下次进游戏拉配置后同步）`);
      onSaved();
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      title={
        <>
          编辑变体 · <span className="font-mono text-sm text-slate-400">{row.id}</span>
        </>
      }
      hint={
        <>
          品质：{labels.prefix[row.prefix] ?? `前缀 ${row.prefix}`} · {labels.suffix[row.suffix] ?? `后缀 ${row.suffix}`}
          （文案在「装备设置」页改）。图标 / 图集 / 几何跟着基础件 {row.baseId} 走，不在这里改。
        </>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canSave} loading={saving} onClick={() => void save()}>
            保存修改
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="名称">
          <Input value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label="穿戴需求等级">
          <Input value={level} inputMode="numeric" onChange={(event) => setLevel(event.target.value)} />
        </Field>
        <Field label="回收价（绑定元宝）">
          <Input value={sellPrice} inputMode="numeric" onChange={(event) => setSellPrice(event.target.value)} />
        </Field>
      </div>

      <div className="mt-4">
        <AttributesGrid attributes={attributes} onChange={setAttributes} header="八项属性（整份替换）" crossed={crossed} />
      </div>

      {error ? (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>
      ) : null}
    </Modal>
  );
}
