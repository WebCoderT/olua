import { useCallback, useEffect, useState } from "react";
import { formatTime, growthScalarsApi, PERMISSION } from "../api";
import type { GrowthScalar, PageResult } from "../api";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastError, toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/** 参数键 → 中文名（说明在行里由服务端给，这里只补一个短名，未登记的原样显示键名） */
const SCALAR_LABELS: Record<string, string> = {
  roleMaxLevel: "角色等级上限",
  "attributeRange.minRate": "属性区间下限比例",
  "attributeRange.mpRate": "魔法上限比例",
  "attributeRange.hpRecoverRate": "回血换算比例",
  "expGain.expPerLevel": "每级经验基数",
  "expGain.maxLevelGap": "等级差经验衰减",
  mpRecoverPerSecond: "每秒自然回蓝",
};

/**
 * 成长参数（#256 / #655）
 *
 * **只剩标量参数**：升级经验与每级属性已经搬到「角色等级」页（`role_levels`，60 行逐条），
 * 曲线分段随曲线一起下架 —— 原来这一页能改「10 级这段曲线的斜率」，
 * 改一个数会带动整段等级，出问题要逐级对着表看才知道哪级跳了；现在改哪级就是哪级。
 *
 * 留在这里的都是**全局参数**：等级上限、区间下限比例、经验节奏、自然回蓝 ——
 * 它们的语义本来就是「全线一个数」，没有逐级版本。
 */
export function GrowthPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [keyword, setKeyword] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [data, setData] = useState<PageResult<GrowthScalar> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<GrowthScalar | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await growthScalarsApi.list({ page, size, keyword: query || undefined }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size, query]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="成长参数"
        description={
          <>
            全局数值参数（等级上限 / 区间比例 / 经验节奏 / 回蓝）。每级的具体数值在「角色等级」页逐行配置 —— 曲线已下架。
          </>
        }
      />

      <Card>
        <div className="flex flex-wrap items-end gap-2">
          <Field width="w-56" label="参数键 / 说明">
            <Input
              value={keyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setPage(1);
                  setQuery(keyword.trim());
                }
              }}
            />
          </Field>
          <Button
            onClick={() => {
              setPage(1);
              setQuery(keyword.trim());
            }}
          >
            查询
          </Button>
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
        title="参数列表"
        actions={loading ? <Spinner /> : null}
        description={canWrite ? undefined : "当前角色没有「修改养成配置」权限，列表只读。"}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>参数</th>
                <th className={thClass}>键</th>
                <th className={thClass}>当前值</th>
                <th className={thClass}>说明</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {data?.list.map((row) => (
                <tr key={row.key} className="transition hover:bg-slate-800/30">
                  <td className={`${tdClass} font-medium text-slate-100`}>{SCALAR_LABELS[row.key] ?? row.key}</td>
                  <td className={`${tdClass} font-mono text-xs text-slate-400`}>{row.key}</td>
                  <td className={tdClass}>{row.value}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{row.description}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(row.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={!canWrite} onClick={() => setEditing(row)}>
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!loading && data && data.list.length === 0 ? <EmptyState title="没有匹配的参数" /> : null}

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
        <ScalarDialog
          row={editing}
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
 * 改一个标量参数
 *
 * 只有 `value` 可改（键是接口契约、说明在服务端字典里）。取值域由服务端 DTO 校验，
 * 前端只拦「空 / 非数字」—— 两处都写一遍范围，改口径时会漏掉一边。
 */
function ScalarDialog({ row, onClose, onSaved }: { row: GrowthScalar; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState(String(row.value));
  const [saving, setSaving] = useState(false);

  const parsed = Number(value.trim());
  const valid = value.trim() !== "" && Number.isFinite(parsed);

  const save = async () => {
    if (!valid) {
      toastError("请输入数字");
      return;
    }
    setSaving(true);
    try {
      await growthScalarsApi.update(row.key, { value: parsed });
      toastSuccess(`${SCALAR_LABELS[row.key] ?? row.key} 已改为 ${parsed}`);
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
      size="sm"
      title={`编辑 ${SCALAR_LABELS[row.key] ?? row.key}`}
      hint={row.description}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button disabled={!valid || saving} loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </>
      }
    >
      <Field label="值">
        <Input value={value} inputMode="decimal" onChange={(event) => setValue(event.target.value)} />
      </Field>
    </Modal>
  );
}
