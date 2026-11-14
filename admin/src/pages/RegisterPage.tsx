import { useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, authApi } from "../api";
import { APP_TITLE } from "../api/config";
import { saveSession } from "../store/session";
import { Button, Field, Input, Notice } from "../components/ui";

/** 管理端注册页（能不能注册、要不要注册码，全由服务端配置决定） */
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
      // 静默：注册页自己就地展示错误，不需要全局提示再弹一次
      const result = await authApi.register({ username, password, registerCode: registerCode || undefined }, { silent: true });
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
      <form onSubmit={submit} className="legend-card w-full max-w-sm p-8">
        <h1 className="font-display text-xl font-semibold tracking-wide text-ink-1">{APP_TITLE}</h1>
        <p className="mt-1 text-xs text-ink-5">注册一个管理员账号</p>
        <div className="mt-3 flex flex-col gap-2">
          <Notice tone="muted">
            服务端的第一个管理员会自动成为「超级管理员」（拥有全部权限）；之后注册的都是「管理员」，要提权得由超级管理员在「管理员」页调整。
          </Notice>
          <Notice tone="warn">
            <span className="font-medium">注册默认是关的</span>：服务端配了 <code>ADMIN_REGISTER_CODE</code> 时按注册码放行；没配的话需要显式打开{" "}
            <code>ADMIN_REGISTER_OPEN</code>，否则这个接口会直接拒绝（那是运维在 <code>.env</code> 里的开关）。
          </Notice>
        </div>

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
          <Field label="注册码" hint="服务端配了 ADMIN_REGISTER_CODE 时必填；没配注册码时，要看服务端有没有开 ADMIN_REGISTER_OPEN">
            <Input value={registerCode} onChange={(event) => setRegisterCode(event.target.value)} placeholder="按服务端配置填写" />
          </Field>
        </div>

        {error ? <p className="mt-4 rounded-lg border border-ember/40 bg-ember/15 px-3 py-2 text-xs text-ember-hi">{error}</p> : null}

        <Button type="submit" className="mt-6 w-full" loading={loading}>
          注册并登录
        </Button>

        <p className="mt-4 text-center text-xs text-ink-5">
          已有账号？
          <Link to="/login" className="ml-1 text-gold-hi hover:text-gold">
            返回登录
          </Link>
        </p>
      </form>
    </div>
  );
}
