import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatTime, OCCUPATION_LABELS, PERMISSION, rolesApi, SEX_LABELS } from "../api";
import type { AdminRole, RolePatchPayload } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Spinner } from "../components/ui";
import { hasPermission } from "../store/session";
import { toastSuccess } from "../store/toast";

/** 表单初值：只放管理端可改的字段（字符串形态，便于受控输入） */
interface RoleForm {
  name: string;
  occupation: string;
  sex: string;
  level: string;
  gold: string;
  bindGold: string;
  silver: string;
  exp: string;
  soulOfWar: string;
  title: string;
  rank: string;
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

function toForm(role: AdminRole): RoleForm {
  const read = (key: string) => {
    const value = role.data[key];
    return typeof value === "number" ? String(value) : "";
  };
  return {
    name: role.name,
    occupation: role.occupation,
    sex: role.sex,
    level: String(role.level),
    gold: read("gold"),
    bindGold: read("bindGold"),
    silver: read("silver"),
    exp: read("exp"),
    soulOfWar: read("soulOfWar"),
    title: read("title"),
    rank: read("rank"),
  };
}

/** 只提交真正改动过的字段（避免把并发改动覆盖掉） */
function buildPatch(role: AdminRole, form: RoleForm): RolePatchPayload {
  const original = toForm(role);
  const patch: RolePatchPayload = {};
  if (form.name.trim() !== original.name) patch.name = form.name.trim();
  if (form.occupation !== original.occupation) patch.occupation = form.occupation;
  if (form.sex !== original.sex) patch.sex = form.sex;
  for (const { key } of NUMBER_FIELDS) {
    if (form[key] === original[key]) continue;
    const value = Number(form[key]);
    if (form[key] === "" || Number.isNaN(value)) continue;
    patch[key as keyof RolePatchPayload] = value as never;
  }
  return patch;
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
      toastSuccess("已保存，游戏内下次同步即生效");
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

  const update = (key: keyof RoleForm, value: string) => setForm({ ...form, [key]: value });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-50">
            {role.name}
            {role.online ? <Badge tone="indigo">在线</Badge> : null}
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

      <Card
        title="可编辑字段"
        description={
          canWrite
            ? "保存时只提交改动的字段；未列出的字段（背包 / 装备 / 技能…）原样保留。"
            : "当前角色没有「修改角色」权限，字段只读（服务端同样会拒绝保存请求）。"
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
          {NUMBER_FIELDS.map(({ key, label }) => (
            <Field key={key} label={label}>
              <Input
                inputMode="numeric"
                disabled={!canWrite}
                value={form[key]}
                onChange={(event) => update(key, event.target.value.replace(/[^\d]/g, ""))}
              />
            </Field>
          ))}
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

      <Card title="完整角色数据（只读）" description="客户端 entities/Role 的原始快照，改动请用上面的表单。">
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
