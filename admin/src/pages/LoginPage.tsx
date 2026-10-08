import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, authApi } from "../api";
import { APP_TITLE } from "../api/config";
import { saveSession } from "../store/session";
import { Button, Field, Input } from "../components/ui";

/** 管理端登录页 */
export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      // 静默：登录页自己就地展示错误，不需要全局提示再弹一次
      const result = await authApi.login({ username, password }, { silent: true });
      saveSession(result.token, result.admin);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "登录失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/50 p-8 shadow-2xl">
        <h1 className="text-lg font-semibold text-slate-50">{APP_TITLE}</h1>
        <p className="mt-1 text-xs text-slate-500">账号与角色管理后台</p>

        <div className="mt-6 flex flex-col gap-4">
          <Field label="管理员账号">
            <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="3~20 位字母、数字或下划线" autoComplete="username" />
          </Field>
          <Field label="密码">
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入密码" autoComplete="current-password" />
          </Field>
        </div>

        {error ? <p className="mt-4 rounded-lg border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-xs text-rose-200">{error}</p> : null}

        <Button type="submit" className="mt-6 w-full" loading={loading}>
          登录
        </Button>

        <p className="mt-4 text-center text-xs text-slate-500">
          还没有账号？
          <Link to="/register" className="ml-1 text-indigo-400 hover:text-indigo-300">
            注册管理员
          </Link>
        </p>
      </form>
    </div>
  );
}
