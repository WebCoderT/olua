import { useCallback, useEffect, useState } from "react";
import { formatTime, growthScalarsApi, levelCurvesApi, PERMISSION } from "../api";
import type { GrowthScalar, LevelAttributes, LevelCurve, PageResult } from "../api";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastError, toastSuccess } from "../store/toast";
import { PageHeader } from "../components/PageHeader";

/** 参数键 → 中文名（说明在行里由服务端给，这里只补一个短名，未登记的原样显示键名） */
const SCALAR_LABELS: Record<string, string> = {
  roleMaxLevel: "角色等级上限",
  "expGain.expPerLevel": "每级经验基数",
  "expGain.maxLevelGap": "等级差经验衰减",
  mpRecoverPerSecond: "每秒自然回蓝",
  soakExpPerTick: "泡点·每拍经验",
  soakTickSeconds: "泡点·拍间隔秒",
  // 属性点（#833）：加成的唯一系数与洗点价格都在这里调，客户端只显示四维与余点
  attrPointRatio: "属性点·每点系数",
  attrResetCost: "属性点·洗点花费",
};

/** 曲线键 → 中文名（与服务端 ROLE_LEVEL_CURVE_LABELS 同序同义；未登记的原样显示） */
const CURVE_LABELS: Record<string, string> = {
  exp: "升级经验",
  hp: "生命上限",
  attack_max: "物攻上限",
  defense_max: "物防上限",
};

/** 曲线展示顺序（先经验后属性：运营最常改的是经验） */
const CURVE_ORDER = ["exp", "hp", "attack_max", "defense_max"];

/**
 * 成长参数（#256 / #655 / #786）
 *
 * 这一页现在有两块：
 * 1. **等级曲线**（`role_level_curves`）：4 条曲线 × 6 段定义 1..100 万级。
 *    段内公式 `value = startValue + perLevel * k + accel * k*(k-1)/2`。
 *    改一段只影响那一段等级 —— 改完服务端立刻按新值结算。
 * 2. **全局参数**（`growth_scalars`）：等级上限 / 经验节奏 / 自然回蓝 / 泡点，
 *    语义是「全线一个数」，没有逐级版本。
 *
 * 想知道「第 N 级多少血」→ 中间那块**等级属性计算器**现算（逐级表已随 #786 删除）。
 */
export function GrowthPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="成长参数"
        description={
          <>
            等级数值由「等级曲线」4 条 × 6 段定义（1 ~ 100 万级），改一段就改那一段等级；
            算不准就用下面的计算器现算。全局参数是「全线一个数」的那几个。
          </>
        }
      />

      <LevelCurveCard canWrite={canWrite} />
      <LevelCalculatorCard />
      <ScalarCard canWrite={canWrite} />
    </div>
  );
}

/** 等级曲线：4 条 × 6 段，一条曲线一张小表 */
function LevelCurveCard({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<LevelCurve[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<LevelCurve | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await levelCurvesApi.list();
      setRows(data.list ?? []);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [version]);

  useEffect(() => {
    void load();
  }, [load]);

  const curves = CURVE_ORDER.filter((key) => rows.some((row) => row.curve === key));
  // 服务端以后加了新曲线也不会被前端吃掉（未登记的排在最后）
  for (const row of rows) {
    if (!curves.includes(row.curve)) curves.push(row.curve);
  }

  return (
    <Card
      title="等级曲线"
      description="每条曲线按段定义：段内每升一级加 perLevel，加速度 accel 只有经验用（越涨越快）。最后一段的结束等级就是等级上限，超出按该段公式继续外推。"
      actions={loading ? <Spinner /> : null}
    >
      {curves.length === 0 && !loading ? <EmptyState title="还没有曲线段（检查出厂快照是否导入）" /> : null}

      <div className="flex flex-col gap-5">
        {curves.map((curve) => {
          const segments = rows.filter((row) => row.curve === curve).sort((a, b) => a.seq - b.seq);
          return (
            <div key={curve}>
              <div className="mb-1.5 flex items-baseline gap-2">
                <span className="text-sm font-medium text-slate-200">{CURVE_LABELS[curve] ?? curve}</span>
                <span className="font-mono text-xs text-slate-500">{curve}</span>
              </div>
              <div className="overflow-x-auto">
                <table className={tableClass}>
                  <thead className={theadClass}>
                    <tr>
                      <th className={thClass}>段</th>
                      <th className={thClass}>等级区间</th>
                      <th className={thClass}>区间起始值</th>
                      <th className={thClass}>每级增量</th>
                      <th className={thClass}>加速度</th>
                      <th className={thClass}>更新时间</th>
                      <th className={`${thClass} text-right`}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segments.map((row) => (
                      <tr key={`${row.curve}-${row.seq}`} className="transition hover:bg-slate-800/30">
                        <td className={tdClass}>{row.seq}</td>
                        <td className={`${tdClass} font-mono`}>
                          {row.fromLevel.toLocaleString()} ~ {row.toLevel.toLocaleString()}
                        </td>
                        <td className={tdClass}>{row.startValue.toLocaleString()}</td>
                        <td className={tdClass}>{row.perLevel.toLocaleString()}</td>
                        <td className={`${tdClass} text-slate-400`}>{row.accel}</td>
                        <td className={`${tdClass} text-xs text-slate-400`}>{formatTime(row.updatedAt)}</td>
                        <td className={`${tdClass} text-right`}>
                          <Button
                            variant="outline"
                            className="px-2.5 py-1 text-xs"
                            disabled={!canWrite}
                            onClick={() => setEditing(row)}
                          >
                            编辑
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>

      {editing ? (
        <CurveDialog
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setVersion((n) => n + 1);
          }}
        />
      ) : null}
    </Card>
  );
}

/** 改一段：结束等级 / 起始值 / 每级增量 / 加速度（起点与段序不可改） */
function CurveDialog({ row, onClose, onSaved }: { row: LevelCurve; onClose: () => void; onSaved: () => void }) {
  const [toLevel, setToLevel] = useState(String(row.toLevel));
  const [startValue, setStartValue] = useState(String(row.startValue));
  const [perLevel, setPerLevel] = useState(String(row.perLevel));
  const [accel, setAccel] = useState(String(row.accel));
  const [saving, setSaving] = useState(false);

  /** 四个字段共用一条校验：必须是非负整数；结束等级还不能小于本段起点 */
  const parse = (text: string): number | null => {
    const value = Number(text.trim());
    if (text.trim() === "" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
    return value;
  };
  const parsed = {
    toLevel: parse(toLevel),
    startValue: parse(startValue),
    perLevel: parse(perLevel),
    accel: parse(accel),
  };
  const levelValid = parsed.toLevel !== null && parsed.toLevel >= row.fromLevel;
  const valid = levelValid && parsed.startValue !== null && parsed.perLevel !== null && parsed.accel !== null;

  const save = async () => {
    if (!valid) {
      toastError(levelValid ? "四个字段都必须是非负整数" : `结束等级不能小于本段起点（${row.fromLevel}）`);
      return;
    }
    setSaving(true);
    try {
      await levelCurvesApi.update(row.curve, String(row.seq), {
        toLevel: parsed.toLevel!,
        startValue: parsed.startValue!,
        perLevel: parsed.perLevel!,
        accel: parsed.accel!,
      });
      toastSuccess(
        `${CURVE_LABELS[row.curve] ?? row.curve} 第 ${row.seq} 段已保存（服务端下一笔结算即按新值；玩家重进游戏后画面同步）`,
      );
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
      title={`编辑 ${CURVE_LABELS[row.curve] ?? row.curve} · 第 ${row.seq} 段`}
      hint={`本段从 ${row.fromLevel} 级开始（起点由上一段的结束等级决定，不可改）。改结束等级会连带把下一段的起点挪过去。`}
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
      <div className="grid grid-cols-2 gap-3">
        <Field label="结束等级（含）">
          <Input value={toLevel} inputMode="numeric" onChange={(event) => setToLevel(event.target.value)} />
        </Field>
        <Field label="该级的值">
          <Input value={startValue} inputMode="numeric" onChange={(event) => setStartValue(event.target.value)} />
        </Field>
        <Field label="每级增量">
          <Input value={perLevel} inputMode="numeric" onChange={(event) => setPerLevel(event.target.value)} />
        </Field>
        <Field label="加速度（仅经验）">
          <Input value={accel} inputMode="numeric" onChange={(event) => setAccel(event.target.value)} />
        </Field>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        段内公式：值 = 起始值 + 每级增量 × k + 加速度 × k × (k-1) ÷ 2（k = 等级 − {row.fromLevel}）。
        生命 / 物攻 / 物防这三条曲线的加速度请留 0。
      </p>
    </Modal>
  );
}

/** 等级属性计算器：输入等级，算基础属性（不含装备 / 称号 / 战魂 / 军衔） */
function LevelCalculatorCard() {
  const [level, setLevel] = useState("1");
  const [result, setResult] = useState<LevelAttributes | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const calc = async () => {
    const value = Number(level.trim());
    if (level.trim() === "" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      setError("请输入 1 起的整数等级");
      return;
    }
    setLoading(true);
    setError("");
    try {
      setResult(await levelCurvesApi.preview({ level: value }));
    } catch (e) {
      setResult(null);
      // 请求层的统一提示已经弹过；这里再留一句「算不出来通常是什么原因」
      setError("算不出来：四条曲线里至少有一条没有覆盖到这个等级（检查各段结束等级）");
      void e;
    } finally {
      setLoading(false);
    }
  };

  const ranges = result
    ? [
        { label: "物攻", value: result.physicalAttack },
        { label: "魔攻", value: result.magicAttack },
        { label: "道攻", value: result.taoistAttack },
        { label: "物防", value: result.physicalDefense },
        { label: "魔防", value: result.magicDefense },
        { label: "道防", value: result.taoistDefense },
      ]
    : [];

  return (
    <Card
      title="等级属性计算器"
      description="输入等级算出该级的基础属性（裸属性，不含装备 / 称号 / 战魂 / 军衔）。可以填超过上限的等级 —— 按末段公式外推，用来预演「开到更高等级会是什么数值」。"
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field width="w-44" label="等级">
          <Input
            value={level}
            inputMode="numeric"
            placeholder="如 1000000"
            onChange={(event) => setLevel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void calc();
            }}
          />
        </Field>
        <Button disabled={loading} loading={loading} onClick={() => void calc()}>
          计算
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setLevel("1");
            setResult(null);
            setError("");
          }}
        >
          重置
        </Button>
      </div>

      {error ? <div className="mt-3 rounded-md bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</div> : null}

      {result ? (
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
          <div className="mb-3 flex items-baseline gap-2">
            <span className="text-lg font-semibold text-slate-100">Lv.{result.level.toLocaleString()}</span>
            <span className="text-xs text-slate-400">升到下一级需要 {result.exp.toLocaleString()} 经验</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="生命上限" value={result.maxHp.toLocaleString()} />
            <Stat label="魔法上限" value={result.maxMp.toLocaleString()} />
            <Stat label="每秒回血" value={result.hpRecover.toLocaleString()} />
            <Stat label="—" value="—" />
            {ranges.map((item) => (
              <Stat
                key={item.label}
                label={item.label}
                value={`${item.value.min.toLocaleString()} ~ ${item.value.max.toLocaleString()}`}
              />
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            三系攻 / 三系防出厂同值（下限 = 上限 × 0.7），魔上限 = 生命 ÷ 2，回血 = 生命 ÷ 100（四舍五入）。
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-slate-800/40 px-3 py-2">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-slate-100">{value}</div>
    </div>
  );
}

/** 全局参数（原「参数列表」） */
function ScalarCard({ canWrite }: { canWrite: boolean }) {
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
    <Card
      title="全局参数"
      description="「全线一个数」的参数（等级上限 / 经验节奏 / 回蓝 / 泡点）—— 每级涨多少不在这里，那是上面「等级曲线」的事。"
      actions={loading ? <Spinner /> : null}
    >
      <div className="mb-3 flex flex-wrap items-end gap-2">
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
                <td className={tdClass}>{row.value.toLocaleString()}</td>
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
    </Card>
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
