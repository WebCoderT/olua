import { useCallback, useEffect, useState } from "react";
import { formatTime, PERMISSION, roleLevelsApi } from "../api";
import type { PageResult, RoleLevel } from "../api";
import { Modal } from "../components/Modal";
import { Pagination } from "../components/Pagination";
import { Button, Card, EmptyState, Field, Input, Spinner, tableClass, tdClass, thClass, theadClass } from "../components/ui";
import { PageHeader } from "../components/PageHeader";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 六项攻防区间：草稿里拆成 min / max 两个字符串（与接口字段一一对应） */
const RANGES = [
  { key: "physicalAttack", min: "physicalAttackMin", max: "physicalAttackMax", label: "物攻" },
  { key: "magicAttack", min: "magicAttackMin", max: "magicAttackMax", label: "魔攻" },
  { key: "taoistAttack", min: "taoistAttackMin", max: "taoistAttackMax", label: "道攻" },
  { key: "physicalDefense", min: "physicalDefenseMin", max: "physicalDefenseMax", label: "物防" },
  { key: "magicDefense", min: "magicDefenseMin", max: "magicDefenseMax", label: "魔防" },
  { key: "taoistDefense", min: "taoistDefenseMin", max: "taoistDefenseMax", label: "道防" },
] as const;

/** 单值字段（生命 / 魔法 / 回血 / 经验） */
const SINGLES = [
  { key: "exp", label: "升到下一级所需经验" },
  { key: "maxHp", label: "生命上限" },
  { key: "maxMp", label: "魔法上限" },
  { key: "hpRecover", label: "每秒回血" },
] as const;

type Draft = Record<string, string>;

/**
 * 角色等级表（#655）
 *
 * 60 行 = 每级的**最终裸属性 + 升级经验**。这张表是战斗结算与客户端等级表的唯一来源：
 * 成长曲线（分段线性采样）已从运行时移除，改哪一级就只影响哪一级。
 *
 * ## 为什么逐级改而不是「改曲线」
 * 曲线的问题是「改一个参数、10 级一起变」，而且改完要看半天才发现某级跳档跳坏了。
 * 逐级配置之后，运营调「第 30 级应该多硬」就是改第 30 行 —— 服务端立刻按新值结算
 * （不用重启），客户端下次进游戏拉配置快照时同步。
 *
 * ## 数字先按字符串收
 * 与运行时参数页同一手法：`Number("")` 是 0、`Number("1.")` 是 1，边输边转会把半截输入
 * 变成 0 存进草稿（输入框自己跳回 0，看起来像卡住）。保存时统一 parse + 校验。
 */
export function RoleLevelsPage() {
  const canWrite = hasPermission(PERMISSION.GAME_CONFIG_WRITE);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(60);
  const [rows, setRows] = useState<PageResult<RoleLevel> | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<RoleLevel | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await roleLevelsApi.list({ page, size });
      setRows(data);
    } catch {
      /* 错误已由请求层统一提示 */
    } finally {
      setLoading(false);
    }
  }, [page, size]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="角色等级"
        description={
          <>
            每级一行：裸属性（血 / 蓝 / 回血 / 六项攻防区间）+ 升到下一级所需经验（#655）。
            曲线已从运行时移除 —— 改哪一级就只影响哪一级，保存后服务端立刻按新值结算。
          </>
        }
      />

      <Card title="等级表" description="区间列显示「下限 ~ 上限」；点编辑逐项改。" actions={loading ? <Spinner /> : null}>
        <div className="overflow-x-auto">
          <table className={tableClass}>
            <thead className={theadClass}>
              <tr>
                <th className={thClass}>等级</th>
                <th className={thClass}>升级经验</th>
                <th className={thClass}>生命</th>
                <th className={thClass}>魔法</th>
                <th className={thClass}>回血</th>
                {RANGES.map((range) => (
                  <th key={range.key} className={thClass}>
                    {range.label}
                  </th>
                ))}
                <th className={thClass}>更新时间</th>
                <th className={`${thClass} text-right`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows?.list.map((row) => (
                <tr key={row.level} className="transition hover:bg-slate-800/30">
                  <td className={tdClass}>{row.level}</td>
                  <td className={tdClass}>{row.exp.toLocaleString()}</td>
                  <td className={tdClass}>{row.maxHp.toLocaleString()}</td>
                  <td className={tdClass}>{row.maxMp.toLocaleString()}</td>
                  <td className={tdClass}>{row.hpRecover}</td>
                  {RANGES.map((range) => {
                    const value = row[range.key as keyof RoleLevel] as { min: number; max: number };
                    return (
                      <td key={range.key} className={tdClass}>
                        {value.min.toLocaleString()} ~ {value.max.toLocaleString()}
                      </td>
                    );
                  })}
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
        {!loading && rows && rows.list.length === 0 ? <EmptyState title="没有数据" /> : null}
        <Pagination
          page={page}
          size={size}
          total={rows?.total ?? 0}
          onChange={setPage}
          onSizeChange={(next) => {
            setSize(next);
            setPage(1);
          }}
        />
      </Card>

      {editing ? (
        <RoleLevelDialog
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

/** 编辑一个等级（部分更新：服务端只改传了的字段，这里整份提交也没什么坏处 —— 值都来自当前行） */
function RoleLevelDialog({ row, onClose, onSaved }: { row: RoleLevel; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(row));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const setField = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const save = async () => {
    const payload = buildPayload(draft);
    if (typeof payload === "string") {
      setError(payload);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await roleLevelsApi.update(String(row.level), payload);
      toastSuccess(`第 ${row.level} 级已保存（服务端下一笔结算即按新值；玩家下次进游戏拉配置后同步）`);
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
      size="md"
      title={`编辑第 ${row.level} 级`}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <div className="rounded-md bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</div> : null}

        <div className="grid grid-cols-2 gap-3">
          {SINGLES.map((field) => (
            <Field key={field.key} label={field.label}>
              <Input
                value={draft[field.key] ?? ""}
                inputMode="numeric"
                onChange={(event) => setField(field.key, event.target.value)}
              />
            </Field>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3">
          {RANGES.map((range) => (
            <div key={range.key} className="grid grid-cols-2 gap-3">
              <Field label={`${range.label}下限`}>
                <Input
                  value={draft[range.min] ?? ""}
                  inputMode="numeric"
                  onChange={(event) => setField(range.min, event.target.value)}
                />
              </Field>
              <Field label={`${range.label}上限`}>
                <Input
                  value={draft[range.max] ?? ""}
                  inputMode="numeric"
                  onChange={(event) => setField(range.max, event.target.value)}
                />
              </Field>
            </div>
          ))}
        </div>

        <p className="text-xs text-slate-400">
          区间属性的下限不能大于上限；经验至少为 1。改完保存即生效（服务端重装覆盖层，不用重启）。
        </p>
      </div>
    </Modal>
  );
}

function toDraft(row: RoleLevel): Draft {
  const draft: Draft = {
    exp: String(row.exp),
    maxHp: String(row.maxHp),
    maxMp: String(row.maxMp),
    hpRecover: String(row.hpRecover),
  };
  for (const range of RANGES) {
    const value = row[range.key as keyof RoleLevel] as { min: number; max: number };
    draft[range.min] = String(value.min);
    draft[range.max] = String(value.max);
  }
  return draft;
}

/** 草稿 → 接口载荷；返回字符串表示校验失败（错误文案） */
function buildPayload(draft: Draft): Record<string, number> | string {
  const payload: Record<string, number> = {};
  for (const [key, text] of Object.entries(draft)) {
    const value = Number(text.trim());
    if (text.trim() === "" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      return `「${key}」必须是非负整数（当前：${text || "空"}）`;
    }
    payload[key] = value;
  }
  if (payload.exp < 1) return "升到下一级所需经验至少为 1（0 经验永远升不上去）";
  for (const range of RANGES) {
    if (payload[range.min] > payload[range.max]) {
      return `${range.label}的下限（${payload[range.min]}）不能大于上限（${payload[range.max]}）`;
    }
  }
  return payload;
}
