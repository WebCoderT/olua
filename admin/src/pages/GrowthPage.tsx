import { useCallback, useEffect, useState } from "react";
import { formatTime, growthScalarsApi, growthSegmentsApi, levelExpsApi, PERMISSION } from "../api";
import type { GrowthScalar, GrowthSegment, LevelExp, PageResult } from "../api";
import { Pagination } from "../components/Pagination";
import { Button, Card, EmptyState, Input, Select, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastError, toastSuccess } from "../store/toast";

/** 曲线键 → 中文名（展示用；键清单以服务端 seed 的为准，未登记的原样显示键名） */
const CURVE_LABELS: Record<string, string> = {
  maxHp: "生命曲线",
  attack: "攻击曲线",
  defense: "防御曲线",
  killsPerLevel: "升级节奏曲线",
};

/** 曲线下拉选项的顺序（展示用，不在清单里的键排在最后） */
const CURVE_ORDER = ["maxHp", "attack", "defense", "killsPerLevel"];

/** 军衔映射基准的提示：改曲线 / 标量都会连锁影响军衔等效强度（#250 的映射基准在这里） */
const RANK_IMPACT_HINT = "保存会影响军衔等效强度：军衔属性按阶映射角色等级再打折，曲线一动全线跟着变。";

/**
 * 成长曲线管理（#256）
 *
 * 三块数据都**只可编辑、不可增删**（行的形状由客户端 configs/growth 定义，服务端 seed 固定）：
 * - 升级经验表：每级升到下一级所需经验；
 * - 曲线分段：四条分段线性曲线的段（段间必须首尾相接，服务端做连续性校验）；
 * - 标量参数：等级上限 / 属性区间倍率 / 经验节奏。
 *
 * 写操作要 `gameConfig:write`，只读观察员能看不能改。
 */
export function GrowthPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);

  // —— 升级经验 ——
  const [expPage, setExpPage] = useState(1);
  const [expSize, setExpSize] = useState(20);
  const [exps, setExps] = useState<PageResult<LevelExp> | null>(null);
  const [expLoading, setExpLoading] = useState(true);
  const [expEditing, setExpEditing] = useState<LevelExp | null>(null);

  // —— 曲线分段 ——
  const [segCurve, setSegCurve] = useState("");
  const [segPage, setSegPage] = useState(1);
  const [segSize, setSegSize] = useState(20);
  const [segments, setSegments] = useState<PageResult<GrowthSegment> | null>(null);
  const [segLoading, setSegLoading] = useState(true);
  const [segEditing, setSegEditing] = useState<GrowthSegment | null>(null);

  // —— 标量参数 ——
  const [scalarKeyword, setScalarKeyword] = useState("");
  const [scalarPage, setScalarPage] = useState(1);
  const [scalarSize, setScalarSize] = useState(20);
  const [scalars, setScalars] = useState<PageResult<GrowthScalar> | null>(null);
  const [scalarLoading, setScalarLoading] = useState(true);
  const [scalarEditing, setScalarEditing] = useState<GrowthScalar | null>(null);

  const loadExps = useCallback(async () => {
    setExpLoading(true);
    try {
      setExps(await levelExpsApi.list({ page: expPage, size: expSize }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setExpLoading(false);
    }
  }, [expPage, expSize]);

  const loadSegments = useCallback(async () => {
    setSegLoading(true);
    try {
      setSegments(await growthSegmentsApi.list({ page: segPage, size: segSize, curve: (segCurve || undefined) as GrowthSegment["curve"] }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setSegLoading(false);
    }
  }, [segPage, segSize, segCurve]);

  const loadScalars = useCallback(async () => {
    setScalarLoading(true);
    try {
      setScalars(await growthScalarsApi.list({ page: scalarPage, size: scalarSize, keyword: scalarKeyword || undefined }));
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setScalarLoading(false);
    }
  }, [scalarPage, scalarSize, scalarKeyword]);

  useEffect(() => {
    void loadExps();
  }, [loadExps]);
  useEffect(() => {
    void loadSegments();
  }, [loadSegments]);
  useEffect(() => {
    void loadScalars();
  }, [loadScalars]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">成长曲线</h1>
        <p className="mt-1 text-xs text-slate-500">
          升级经验、角色裸属性曲线与经验节奏收口到后台（#256）。三类数据都只可编辑、不可新增 / 删除；
          改曲线会连锁影响军衔等效强度（军衔按阶映射角色等级再打折）与怪物数值。
        </p>
      </div>

      <Card
        title="升级经验表"
        description="每行是「升到下一级所需经验」；改经验即改升级节奏。"
        actions={expLoading ? <Spinner /> : null}
      >
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>等级</th>
                <th className={thClass}>升到下一级所需经验</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {exps?.list.map((item) => (
                <tr key={item.level} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>{item.level}</td>
                  <td className={tdClass}>{item.exp.toLocaleString()}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      disabled={!canWrite}
                      onClick={() => setExpEditing(item)}
                    >
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!expLoading && exps && exps.list.length === 0 ? <EmptyState title="没有数据" /> : null}
        <Pagination
          page={expPage}
          size={expSize}
          total={exps?.total ?? 0}
          onChange={setExpPage}
          onSizeChange={(next) => {
            setExpSize(next);
            setExpPage(1);
          }}
        />
      </Card>

      <Card
        title="曲线分段"
        description="分段线性曲线：段间首尾相接、连续覆盖 1..等级上限（服务端做连续性校验，改坏了整单拒收）。"
        actions={segLoading ? <Spinner /> : null}
      >
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="w-44">
            <Select
              value={segCurve}
              onChange={(event) => {
                setSegCurve(event.target.value);
                setSegPage(1);
              }}
            >
              <option value="">全部曲线</option>
              {CURVE_ORDER.filter((key) => key in CURVE_LABELS).map((key) => (
                <option key={key} value={key}>
                  {CURVE_LABELS[key]}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>曲线</th>
                <th className={thClass}>段</th>
                <th className={thClass}>等级范围</th>
                <th className={thClass}>起始值</th>
                <th className={thClass}>每级增量</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {segments?.list.map((item) => (
                <tr key={`${item.curve}-${item.seq}`} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>{CURVE_LABELS[item.curve] ?? item.curve}</td>
                  <td className={tdClass}>第 {item.seq} 段</td>
                  <td className={tdClass}>
                    {item.fromLevel} ~ {item.toLevel}
                  </td>
                  <td className={tdClass}>{item.startValue.toLocaleString()}</td>
                  <td className={tdClass}>{item.perLevel.toLocaleString()}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      disabled={!canWrite}
                      onClick={() => setSegEditing(item)}
                    >
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!segLoading && segments && segments.list.length === 0 ? <EmptyState title="没有匹配的分段" /> : null}
        <Pagination
          page={segPage}
          size={segSize}
          total={segments?.total ?? 0}
          onChange={setSegPage}
          onSizeChange={(next) => {
            setSegSize(next);
            setSegPage(1);
          }}
        />
      </Card>

      <Card
        title="标量参数"
        description="等级上限 / 属性区间倍率 / 经验节奏等数值参数；每个键的语义见说明列。"
        actions={scalarLoading ? <Spinner /> : null}
      >
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-slate-400">参数键 / 说明</span>
            <Input
              value={scalarKeyword}
              placeholder="支持模糊匹配"
              onChange={(event) => setScalarKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setScalarPage(1);
                  void loadScalars();
                }
              }}
            />
          </div>
          <Button
            onClick={() => {
              setScalarPage(1);
              void loadScalars();
            }}
          >
            查询
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>参数键</th>
                <th className={thClass}>说明</th>
                <th className={thClass}>值</th>
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {scalars?.list.map((item) => (
                <tr key={item.key} className="transition hover:bg-slate-800/30">
                  <td className={`${tdClass} font-mono text-xs`}>{item.key}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{item.description}</td>
                  <td className={tdClass}>{item.value}</td>
                  <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(item.updatedAt)}</td>
                  <td className={`${tdClass} text-right`}>
                    <Button
                      variant="outline"
                      className="px-2.5 py-1 text-xs"
                      disabled={!canWrite}
                      onClick={() => setScalarEditing(item)}
                    >
                      编辑
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!scalarLoading && scalars && scalars.list.length === 0 ? <EmptyState title="没有匹配的参数" /> : null}
        <Pagination
          page={scalarPage}
          size={scalarSize}
          total={scalars?.total ?? 0}
          onChange={setScalarPage}
          onSizeChange={(next) => {
            setScalarSize(next);
            setScalarPage(1);
          }}
        />
      </Card>

      <NumberEditDialog
        open={expEditing !== null}
        title={`编辑 ${expEditing?.level ?? ""} 级升级经验`}
        hint="经验 ≥ 1；升级节奏建议连同怪物经验产出一起评估。"
        fields={[{ key: "exp", label: "升到下一级所需经验", integer: true, min: 1 }]}
        initial={{ exp: expEditing?.exp ?? 0 }}
        onClose={() => setExpEditing(null)}
        onSubmit={async ({ exp }) => {
          if (!expEditing) return false;
          try {
            await levelExpsApi.update(String(expEditing.level), { exp });
            toastSuccess(`${expEditing.level} 级升级经验已更新`);
            setExpEditing(null);
            await loadExps();
            return true;
          } catch {
            return false;
          }
        }}
      />

      <NumberEditDialog
        open={segEditing !== null}
        title={`编辑 ${CURVE_LABELS[segEditing?.curve ?? ""] ?? segEditing?.curve ?? ""} 第 ${segEditing?.seq ?? ""} 段`}
        hint={RANK_IMPACT_HINT}
        fields={[
          { key: "fromLevel", label: "起始等级（含）", integer: true, min: 1 },
          { key: "toLevel", label: "结束等级（含）", integer: true, min: 1 },
          { key: "startValue", label: "该段起始等级的值", integer: true, min: 0 },
          { key: "perLevel", label: "段内每升一级的增量", integer: true, min: 0 },
        ]}
        initial={{
          fromLevel: segEditing?.fromLevel ?? 0,
          toLevel: segEditing?.toLevel ?? 0,
          startValue: segEditing?.startValue ?? 0,
          perLevel: segEditing?.perLevel ?? 0,
        }}
        onClose={() => setSegEditing(null)}
        onSubmit={async (value) => {
          if (!segEditing) return false;
          try {
            await growthSegmentsApi.update(segEditing.curve, String(segEditing.seq), {
              fromLevel: value.fromLevel,
              toLevel: value.toLevel,
              startValue: value.startValue,
              perLevel: value.perLevel,
            });
            toastSuccess(`${CURVE_LABELS[segEditing.curve] ?? segEditing.curve} 第 ${segEditing.seq} 段已更新`);
            setSegEditing(null);
            await loadSegments();
            return true;
          } catch (error) {
            toastError(error instanceof Error ? error.message : "保存失败");
            return false;
          }
        }}
      />

      <NumberEditDialog
        open={scalarEditing !== null}
        title={`编辑参数 ${scalarEditing?.key ?? ""}`}
        hint={RANK_IMPACT_HINT}
        fields={[{ key: "value", label: "参数值", integer: Number.isInteger(scalarEditing?.value), min: 0 }]}
        initial={{ value: scalarEditing?.value ?? 0 }}
        onClose={() => setScalarEditing(null)}
        onSubmit={async ({ value }) => {
          if (!scalarEditing) return false;
          try {
            await growthScalarsApi.update(scalarEditing.key, { value });
            toastSuccess(`参数 ${scalarEditing.key} 已更新`);
            setScalarEditing(null);
            await loadScalars();
            return true;
          } catch {
            return false;
          }
        }}
      />
    </div>
  );
}

/** 数值字段描述（弹窗按它渲染输入行；integer 决定步进与小数校验交给服务端兜底） */
interface NumberFieldSpec {
  key: string;
  label: string;
  integer: boolean;
  min: number;
}

/**
 * 数值编辑弹窗（本页三块数据共用）
 *
 * 受控开合；每次打开按 initial 重建表单（useEffect([open])），编辑另一条不残留。
 * 提交回调返回 true 才由弹窗关闭；失败就地展示服务端文案（跨行校验的报错都在服务端）。
 */
function NumberEditDialog(props: {
  open: boolean;
  title: string;
  hint?: string;
  fields: NumberFieldSpec[];
  initial: Record<string, number>;
  onClose: () => void;
  onSubmit: (value: Record<string, number>) => Promise<boolean>;
}) {
  const { open, title, hint, fields, initial, onClose, onSubmit } = props;
  const [value, setValue] = useState<Record<string, number>>(initial);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setValue(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setSaving(true);
    try {
      const ok = await onSubmit(value);
      if (!ok) setSaving(false);
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={saving ? undefined : onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-slate-50">{title}</h2>
        {hint ? <p className="mt-1.5 text-xs leading-5 text-amber-400/90">{hint}</p> : null}
        <div className="mt-4 flex flex-col gap-3">
          {fields.map((field) => (
            <label key={field.key} className="block">
              <span className="mb-1.5 block text-xs font-medium text-slate-400">{field.label}</span>
              <Input
                type="number"
                step={field.integer ? 1 : "any"}
                min={field.min}
                value={String(value[field.key] ?? "")}
                onChange={(event) => setValue({ ...value, [field.key]: Number(event.target.value) })}
              />
            </label>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </div>
  );
}
