import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, authApi } from "../api";
import { APP_TITLE } from "../api/config";
import { saveSession } from "../store/session";
import { Button, Field, Input } from "../components/ui";

/** 管理端注册页（服务端配了 ADMIN_REGISTER_CODE 时必须填注册码） */
export function RegisterPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [registerCode, setRegisterCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    try {
      const result = await authApi.register({ username, password, registerCode: registerCode || undefined });
      saveSession(result.token, result.admin);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "注册失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/50 p-8 shadow-2xl">
        <h1 className="text-lg font-semibold text-slate-50">{APP_TITLE}</h1>
        <p className="mt-1 text-xs text-slate-500">注册一个管理员账号</p>
        <p className="mt-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs leading-relaxed text-slate-400">
          服务端的第一个管理员会自动成为「超级管理员」（拥有全部权限）；之后注册的都是「管理员」，要提权得由超级管理员在「管理员」页调整。
        </p>

        <div className="mt-6 flex flex-col gap-4">
          <Field label="管理员账号" hint="3~20 位字母、数字或下划线">
            <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="例如 gm001" autoComplete="username" />
          </Field>
          <Field label="密码" hint="6~32 位">
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="确认密码">
            <Input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="注册码" hint="服务端配置了 ADMIN_REGISTER_CODE 时必填">
            <Input value={registerCode} onChange={(event) => setRegisterCode(event.target.value)} placeholder="留空则按服务端配置处理" />
          </Field>
        </div>

        {error ? <p className="mt-4 rounded-lg border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-xs text-rose-200">{error}</p> : null}

        <Button type="submit" className="mt-6 w-full" loading={loading}>
          注册并登录
        </Button>

        <p className="mt-4 text-center text-xs text-slate-500">
          已有账号？
          <Link to="/login" className="ml-1 text-indigo-400 hover:text-indigo-300">
            返回登录
          </Link>
        </p>
      </form>
    </div>
  );
}
