import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { adminRoleLabel, ApiError, authApi, formatTime, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, permissionLabel } from "../api";
import type { AdminInfo } from "../api";
import { Badge, Button, Card, Field, Input, Spinner } from "../components/ui";
import { readAdmin, readToken, saveSession } from "../store/session";
import { toastSuccess } from "../store/toast";

/**
 * 我的账号（每个管理员都能进，不需要额外权限点）
 *
 * 这里只做一件事：**改自己的密码**。为什么要单独一个页面，而不复用管理员列表里的
 * 「重置密码」？因为两者的后果完全不同：
 * - 别人重置我 = 我手里的令牌当场作废 → 我应该被送回登录页；
 * - 我自己改   = 服务端会**回一个新令牌** → 这次会话要接着用下去（换掉本地旧令牌）。
 * 把「改自己的」放在这里，就不会出现「管理员改完自己的密码，立刻被自己踢出后台」。
 */
export function MyAccountPage() {
  const [info, setInfo] = useState<AdminInfo | null>(readAdmin());
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ oldPassword: "", newPassword: "", confirm: "" });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await authApi.me();
      setInfo(me);
      // 顺手把最新的角色 / 权限点写回会话：被超管改了角色时，进这个页面就能看到界面跟着变
      const token = readToken();
      if (token) saveSession(token, me);
    } catch {
      /* 错误已由请求层统一处理（需要时自动回登录页） */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    // 前端先拦一道明显写错的（服务端仍会独立校验）
    if (form.newPassword.length < PASSWORD_MIN_LENGTH || form.newPassword.length > PASSWORD_MAX_LENGTH) {
      setError(`新密码需要 ${PASSWORD_MIN_LENGTH}~${PASSWORD_MAX_LENGTH} 位`);
      return;
    }
    if (form.newPassword !== form.confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    if (form.newPassword === form.oldPassword) {
      setError("新密码不能与原密码相同");
      return;
    }

    setSubmitting(true);
    try {
      // 静默：这类错误（原密码不对 / 新旧相同）要在表单里就地显示，不适合全局再飘一条
      const result = await authApi.changePassword({ oldPassword: form.oldPassword, newPassword: form.newPassword }, { silent: true });
      // 关键：用返回的**新令牌**覆盖本地会话（旧令牌此刻已经失效了）
      saveSession(result.token, result.admin);
      setInfo(result.admin);
      setForm({ oldPassword: "", newPassword: "", confirm: "" });
      toastSuccess("密码已修改，本次登录不受影响");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "修改失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-50">我的账号</h1>
        <p className="mt-1 text-xs text-slate-500">改密码需要先验证原密码；改完服务端会下发新令牌，本次登录继续有效。</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="当前身份">
          <div className="flex flex-col gap-3 text-sm text-slate-200">
            <p className="flex items-center gap-2">
              <span className="font-medium text-slate-100">{info?.username ?? "—"}</span>
              {info?.role ? <Badge tone={info.role === "super_admin" ? "amber" : info.role === "viewer" ? "slate" : "indigo"}>{adminRoleLabel(info.role)}</Badge> : null}
            </p>
            <p className="text-xs text-slate-400">账号 id：{info?.id ?? "—"}</p>
          </div>
        </Card>
        <Card title="登录情况">
          <div className="flex flex-col gap-3 text-sm text-slate-200">
            <p>最近登录：{formatTime(info?.lastLoginAt)}</p>
            <p className="text-xs text-slate-400">账号创建：{formatTime(info?.createdAt)}</p>
          </div>
        </Card>
        <Card title="状态">
          <p className="text-sm text-slate-200">{info?.status === "active" ? <Badge tone="green">正常</Badge> : <Badge tone="red">已停用</Badge>}</p>
        </Card>
      </div>

      <Card title="我的权限点" description="界面按权限显隐，服务端独立校验——这里的清单就是服务端下发的权威值。">
        {loading && !info ? (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Spinner /> 加载中…
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(info?.permissions ?? []).map((item) => (
              <Badge key={item} tone="indigo">
                {permissionLabel(item)}
              </Badge>
            ))}
            {(info?.permissions ?? []).length === 0 ? <p className="text-sm text-slate-400">没有任何权限点</p> : null}
          </div>
        )}
      </Card>

      <Card title="修改密码" description={`新密码 ${PASSWORD_MIN_LENGTH}~${PASSWORD_MAX_LENGTH} 位。`}>
        <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
          <Field label="当前密码">
            <Input type="password" value={form.oldPassword} autoComplete="current-password" onChange={(event) => setForm({ ...form, oldPassword: event.target.value })} />
          </Field>
          <Field label="新密码">
            <Input type="password" value={form.newPassword} autoComplete="new-password" onChange={(event) => setForm({ ...form, newPassword: event.target.value })} />
          </Field>
          <Field label="确认新密码">
            <Input type="password" value={form.confirm} autoComplete="new-password" onChange={(event) => setForm({ ...form, confirm: event.target.value })} />
          </Field>

          {error ? <p className="rounded-lg border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-xs text-rose-200">{error}</p> : null}

          <Button type="submit" loading={submitting} className="self-start">
            修改密码
          </Button>
        </form>
      </Card>

      <p className="text-xs text-slate-500">忘了密码？只能请超级管理员在「管理员」页里重置（重置后你手里的令牌会立即失效，需要用新口令重新登录）。</p>
    </div>
  );
}
