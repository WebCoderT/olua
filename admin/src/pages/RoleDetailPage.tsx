import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatTime, OCCUPATION_LABELS, PERMISSION, ROLE_BAG_AXIS_MAX, rolesApi, SEX_LABELS } from "../api";
import type { AdminRole, RoleBagCell, RolePatchPayload } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 装备槽位行 / 技能等级行 / 背包格子行（都是「键值对」的可编辑列表） */
interface KeyValueRow {
  key: string;
  value: string;
}

/** 背包格子行（行列也做成输入框，便于整格搬家） */
interface BagRow {
  row: string;
  col: string;
  id: string;
  count: string;
}

/** 表单初值：全部是字符串，便于受控输入 */
interface RoleForm {
  // 基础信息
  name: string;
  occupation: string;
  sex: string;
  level: string;
  /** 空串 = 没有时装（提交时转成 null） */
  fashionCloth: string;
  avatar: string;
  onMap: string;
  // 常用数值
  gold: string;
  bindGold: string;
  silver: string;
  exp: string;
  soulOfWar: string;
  title: string;
  rank: string;
  // 运行时数据
  equipments: KeyValueRow[];
  skills: KeyValueRow[];
  bag: BagRow[];
}

const NUMBER_FIELDS: { key: keyof RoleForm; label: string }[] = [
  { key: "level", label: "等级" },
  { key: "gold", label: "金币" },
  { key: "bindGold", label: "绑定元宝" },
  { key: "silver", label: "银两" },
  { key: "exp", label: "经验" },
  { key: "soulOfWar", label: "战魂等级" },
  { key: "title", label: "称号等级" },
  { key: "rank", label: "军衔阶数" },
];

/** 取 data 里的数字字段（缺失 / 非数字 → 空串，界面上就是空输入框） */
function readNumber(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "number" ? String(value) : "";
}

/**
 * 把 data 里的键值对象读成可编辑行
 *
 * 键来自**角色自己的数据**（不是管理端硬编码的清单）：装备槽位与技能 id 的权威定义在客户端配置里，
 * 服务端与后台都不复制一份，所以这里只呈现「这个角色实际有的那些键」。
 */
function readKeyValueRows(data: Record<string, unknown>, key: string): KeyValueRow[] {
  const source = data[key];
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  return Object.entries(source as Record<string, unknown>).map(([name, value]) => ({
    key: name,
    value: typeof value === "number" ? String(value) : typeof value === "string" ? value : "",
  }));
}

/** 把二维背包读成稀疏格子行（只列有东西的格子） */
function readBagRows(data: Record<string, unknown>): BagRow[] {
  const bag = data.bag;
  if (!Array.isArray(bag)) return [];
  const rows: BagRow[] = [];
  bag.forEach((rowValue, row) => {
    if (!Array.isArray(rowValue)) return;
    rowValue.forEach((cell, col) => {
      if (!cell || typeof cell !== "object" || Array.isArray(cell)) return;
      const item = cell as { id?: unknown; count?: unknown };
      if (typeof item.id !== "string" || !item.id) return;
      rows.push({ row: String(row), col: String(col), id: item.id, count: String(typeof item.count === "number" ? item.count : 1) });
    });
  });
  return rows;
}

function toForm(role: AdminRole): RoleForm {
  const data = role.data;
  return {
    name: role.name,
    occupation: role.occupation,
    sex: role.sex,
    level: String(role.level),
    fashionCloth: typeof data.fashionCloth === "number" ? String(data.fashionCloth) : "",
    avatar: readNumber(data, "avatar"),
    onMap: typeof data.onMap === "string" ? data.onMap : "",
    gold: readNumber(data, "gold"),
    bindGold: readNumber(data, "bindGold"),
    silver: readNumber(data, "silver"),
    exp: readNumber(data, "exp"),
    soulOfWar: readNumber(data, "soulOfWar"),
    title: readNumber(data, "title"),
    rank: readNumber(data, "rank"),
    equipments: readKeyValueRows(data, "equipments"),
    skills: readKeyValueRows(data, "skills"),
    bag: readBagRows(data),
  };
}

/** 数值文本 → 数字（空串 / 非数字返回 undefined，调用方据此跳过该字段） */
function toNumber(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 两批键值行是否等价（顺序无关，值按字符串比） */
function sameRows(current: KeyValueRow[], original: KeyValueRow[]): boolean {
  if (current.length !== original.length) return false;
  return current.every((row) => {
    const target = original.find((item) => item.key === row.key);
    return !!target && target.value === row.value;
  });
}

/** 两批背包格子是否等价（顺序无关） */
function sameBag(current: BagRow[], original: BagRow[]): boolean {
  if (current.length !== original.length) return false;
  return current.every((row) =>
    original.some((item) => item.row === row.row && item.col === row.col && item.id === row.id && item.count === row.count),
  );
}

/**
 * 只提交真正改动过的字段
 *
 * 结构化字段（装备 / 技能 / 背包）例外：服务端是**整体替换**这三项，所以只要有一处改动就提交完整的一份。
 */
function buildPatch(role: AdminRole, form: RoleForm): RolePatchPayload {
  const original = toForm(role);
  const patch: RolePatchPayload = {};

  if (form.name.trim() !== original.name) patch.name = form.name.trim();
  if (form.occupation !== original.occupation) patch.occupation = form.occupation;
  if (form.sex !== original.sex) patch.sex = form.sex;
  if (form.onMap.trim() !== original.onMap) patch.onMap = form.onMap.trim();

  if (form.fashionCloth !== original.fashionCloth) {
    const value = toNumber(form.fashionCloth);
    patch.fashionCloth = value === undefined ? null : value;
  }
  for (const { key } of NUMBER_FIELDS) {
    if (form[key] === original[key]) continue;
    const value = toNumber(form[key] as string);
    if (value === undefined) continue;
    patch[key as "level" | "gold" | "bindGold" | "silver" | "exp" | "soulOfWar" | "title" | "rank"] = value;
  }

  if (!sameRows(form.equipments, original.equipments)) {
    const equipments: Record<string, string | null> = {};
    for (const row of form.equipments) {
      const slot = row.key.trim();
      if (!slot) continue;
      equipments[slot] = row.value.trim() || null;
    }
    patch.equipments = equipments;
  }
  if (!sameRows(form.skills, original.skills)) {
    const skills: Record<string, number> = {};
    for (const row of form.skills) {
      const id = row.key.trim();
      const level = toNumber(row.value);
      if (!id || level === undefined) continue;
      skills[id] = level;
    }
    patch.skills = skills;
  }
  if (!sameBag(form.bag, original.bag)) {
    patch.bag = form.bag
      .map<RoleBagCell | null>((row) => {
        const rowIndex = toNumber(row.row);
        const colIndex = toNumber(row.col);
        const count = toNumber(row.count);
        if (rowIndex === undefined || colIndex === undefined || count === undefined || !row.id.trim()) return null;
        return { row: rowIndex, col: colIndex, id: row.id.trim(), count };
      })
      .filter((item): item is RoleBagCell => item !== null);
  }
  return patch;
}

/** 键值行编辑表（装备槽 / 技能等级共用一套交互） */
function KeyValueEditor({
  rows,
  keyLabel,
  valueLabel,
  keyPlaceholder,
  valuePlaceholder,
  disabled,
  onChange,
}: {
  rows: KeyValueRow[];
  keyLabel: string;
  valueLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  disabled: boolean;
  onChange: (rows: KeyValueRow[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={`${row.key}-${index}`} className="flex items-center gap-2">
          <Input
            value={row.key}
            placeholder={keyPlaceholder}
            disabled={disabled}
            aria-label={`${keyLabel} ${index + 1}`}
            onChange={(event) => onChange(rows.map((item, position) => (position === index ? { ...item, key: event.target.value } : item)))}
          />
          <Input
            value={row.value}
            placeholder={valuePlaceholder}
            disabled={disabled}
            aria-label={`${valueLabel} ${index + 1}`}
            onChange={(event) => onChange(rows.map((item, position) => (position === index ? { ...item, value: event.target.value } : item)))}
          />
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, position) => position !== index))}
          >
            移除
          </Button>
        </div>
      ))}
      <div>
        <Button variant="outline" className="px-2.5 py-1 text-xs" disabled={disabled} onClick={() => onChange([...rows, { key: "", value: "" }])}>
          添加一行
        </Button>
      </div>
    </div>
  );
}

/** 角色详情与编辑（表单按「修改角色」权限点决定可编辑性） */
export function RoleDetailPage() {
  const canWrite = hasPermission(PERMISSION.ROLE_WRITE);
  const canSelect = hasPermission(PERMISSION.ROLE_SELECT);
  const canDelete = hasPermission(PERMISSION.ROLE_DELETE);
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [role, setRole] = useState<AdminRole | null>(null);
  const [form, setForm] = useState<RoleForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await rolesApi.detail(id);
      setRole(data);
      setForm(toForm(data));
    } catch {
      /* 统一提示 */
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!role || !form) return;
    const patch = buildPatch(role, form);
    if (Object.keys(patch).length === 0) {
      toastSuccess("没有需要保存的改动");
      return;
    }
    setSaving(true);
    try {
      const updated = await rolesApi.patch(role.id, patch);
      setRole(updated);
      setForm(toForm(updated));
      toastSuccess("已保存；角色在线时玩家会在下一次同步拿到最新数据");
    } catch {
      /* 统一提示 */
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!role) return;
    setDeleting(true);
    try {
      await rolesApi.remove(role.id);
      toastSuccess(`已删除角色 ${role.name}`);
      navigate("/roles", { replace: true });
    } catch {
      /* 统一提示 */
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const setOnline = async () => {
    if (!role) return;
    try {
      const updated = await rolesApi.select(role.id);
      setRole(updated);
      toastSuccess(`已把「${updated.name}」设为该账号的在线角色`);
    } catch {
      /* 统一提示 */
    }
  };

  if (loading && !role) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Spinner /> 加载中…
      </div>
    );
  }

  if (!role || !form) return <EmptyState title="角色不存在" description="它可能已经被删除了" />;

  const update = <K extends keyof RoleForm>(key: K, value: RoleForm[K]) => setForm({ ...form, [key]: value });
  const readonlyHint = canWrite ? undefined : "当前角色没有「修改角色」权限，字段只读（服务端同样会拒绝保存请求）。";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-50">
            {role.name}
            {role.online ? <Badge tone="indigo">在线</Badge> : null}
            <span className="text-xs font-normal text-slate-500">修订 #{role.revision}</span>
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            角色 id：{role.id} · 所属账号：
            {role.accountName ? (
              <Link to={`/accounts/${role.accountId}`} className="text-indigo-300 hover:text-indigo-200">
                {role.accountName}
              </Link>
            ) : (
              "—"
            )}
            {" · "}更新时间：{formatTime(role.updatedAt)}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/roles">
            <Button variant="outline">返回列表</Button>
          </Link>
          <Button variant="outline" onClick={() => void setOnline()} disabled={!canSelect || role.online}>
            设为在线角色
          </Button>
          <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={!canDelete}>
            删除角色
          </Button>
        </div>
      </div>

      <Card title="基础信息" description={readonlyHint ?? "改名仍受「同一账号下不重名」约束；所在地图是客户端 configs/map 的 key。"}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="角色名">
            <Input value={form.name} disabled={!canWrite} onChange={(event) => update("name", event.target.value)} />
          </Field>
          <Field label="职业">
            <Select value={form.occupation} disabled={!canWrite} onChange={(event) => update("occupation", event.target.value)}>
              {Object.entries(OCCUPATION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="性别">
            <Select value={form.sex} disabled={!canWrite} onChange={(event) => update("sex", event.target.value)}>
              {Object.entries(SEX_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="等级">
            <Input inputMode="numeric" value={form.level} disabled={!canWrite} onChange={(event) => update("level", event.target.value.replace(/[^\d]/g, ""))} />
          </Field>
          <Field label="时装 id" hint="留空 = 没有时装">
            <Input
              inputMode="numeric"
              value={form.fashionCloth}
              placeholder="无"
              disabled={!canWrite}
              onChange={(event) => update("fashionCloth", event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="头像编号">
            <Input
              inputMode="numeric"
              value={form.avatar}
              placeholder="0"
              disabled={!canWrite}
              onChange={(event) => update("avatar", event.target.value.replace(/[^\d]/g, ""))}
            />
          </Field>
          <Field label="所在地图" hint="改完玩家重进地图生效">
            <Input value={form.onMap} placeholder="0" disabled={!canWrite} onChange={(event) => update("onMap", event.target.value)} />
          </Field>
        </div>
      </Card>

      <Card title="常用数值" description={readonlyHint}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {NUMBER_FIELDS.filter((item) => item.key !== "level").map(({ key, label }) => (
            <Field key={key} label={label}>
              <Input
                inputMode="numeric"
                disabled={!canWrite}
                value={form[key] as string}
                onChange={(event) => update(key, event.target.value.replace(/[^\d]/g, ""))}
              />
            </Field>
          ))}
        </div>
      </Card>

      <Card
        title="运行时数据"
        description={
          readonlyHint ??
          "装备槽位与技能 id 的清单来自这个角色自己的数据（权威定义在客户端配置里，后台不复制一份）；背包按「有东西的格子」编辑，清空全部格子即清空背包。"
        }
      >
        <div className="flex flex-col gap-6">
          <div>
            <p className="mb-2 text-xs font-medium text-slate-400">装备穿戴（槽位 → 装备 id；值留空 = 卸下）</p>
            {form.equipments.length === 0 ? (
              <p className="mb-2 text-xs text-slate-500">该角色数据里没有装备表（可能是旧存档或数据异常）。</p>
            ) : null}
            <KeyValueEditor
              rows={form.equipments}
              keyLabel="装备槽位"
              valueLabel="装备 id"
              keyPlaceholder="槽位名"
              valuePlaceholder="装备 id"
              disabled={!canWrite}
              onChange={(rows) => update("equipments", rows)}
            />
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-slate-400">技能等级（技能 id → 等级）</p>
            {form.skills.length === 0 ? <p className="mb-2 text-xs text-slate-500">该角色数据里没有技能表。</p> : null}
            <KeyValueEditor
              rows={form.skills}
              keyLabel="技能 id"
              valueLabel="技能等级"
              keyPlaceholder="技能 id"
              valuePlaceholder="等级"
              disabled={!canWrite}
              onChange={(rows) => update("skills", rows)}
            />
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-slate-400">
                背包（第 {form.bag.length} 格有物品；行 / 列上限 {ROLE_BAG_AXIS_MAX}）
              </p>
              <Button
                variant="outline"
                className="px-2.5 py-1 text-xs"
                disabled={!canWrite || form.bag.length === 0}
                onClick={() => update("bag", [])}
              >
                清空背包
              </Button>
            </div>
            {form.bag.map((row, index) => (
              <div key={`bag-${index}`} className="mb-2 flex flex-wrap items-center gap-2">
                <Input
                  className="w-20"
                  inputMode="numeric"
                  value={row.row}
                  aria-label={`第 ${index + 1} 格行号`}
                  disabled={!canWrite}
                  onChange={(event) =>
                    update(
                      "bag",
                      form.bag.map((item, position) => (position === index ? { ...item, row: event.target.value.replace(/[^\d]/g, "") } : item)),
                    )
                  }
                />
                <Input
                  className="w-20"
                  inputMode="numeric"
                  value={row.col}
                  aria-label={`第 ${index + 1} 格列号`}
                  disabled={!canWrite}
                  onChange={(event) =>
                    update(
                      "bag",
                      form.bag.map((item, position) => (position === index ? { ...item, col: event.target.value.replace(/[^\d]/g, "") } : item)),
                    )
                  }
                />
                <Input
                  className="flex-1"
                  value={row.id}
                  placeholder="物品 id"
                  aria-label={`第 ${index + 1} 格物品 id`}
                  disabled={!canWrite}
                  onChange={(event) =>
                    update(
                      "bag",
                      form.bag.map((item, position) => (position === index ? { ...item, id: event.target.value } : item)),
                    )
                  }
                />
                <Input
                  className="w-24"
                  inputMode="numeric"
                  value={row.count}
                  placeholder="数量"
                  aria-label={`第 ${index + 1} 格数量`}
                  disabled={!canWrite}
                  onChange={(event) =>
                    update(
                      "bag",
                      form.bag.map((item, position) => (position === index ? { ...item, count: event.target.value.replace(/[^\d]/g, "") } : item)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  className="px-2 py-1 text-xs"
                  disabled={!canWrite}
                  onClick={() => update("bag", form.bag.filter((_, position) => position !== index))}
                >
                  移除
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              className="px-2.5 py-1 text-xs"
              disabled={!canWrite}
              onClick={() => update("bag", [...form.bag, { row: "0", col: "0", id: "", count: "1" }])}
            >
              添加一个格子
            </Button>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setForm(toForm(role))} disabled={!canWrite || saving}>
            重置
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={!canWrite}>
            保存改动
          </Button>
        </div>
      </Card>

      <Card title="完整角色数据（只读）" description="客户端 entities/Role 的原始快照；上面三项结构化编辑之外的内容（快捷键绑定、速度倍率…）请用游戏内功能改。">
        <pre className="max-h-96 overflow-auto rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs leading-relaxed text-slate-400">
          {JSON.stringify(role.data, null, 2)}
        </pre>
      </Card>

      <ConfirmDialog
        open={confirmDelete}
        title="删除角色"
        description={`将删除角色「${role.name}」，操作不可恢复。`}
        confirmText="确认删除"
        loading={deleting}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
