import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { adminRoleLabel, authApi, PERMISSION } from "../api";
import { APP_TITLE } from "../api/config";
import { clearSession, hasPermission, readAdmin, readToken, saveSession, subscribeSession } from "../store/session";
import { Badge, Button } from "./ui";

/**
 * 导航项及其所需权限点
 *
 * 没有权限点的（概览）始终显示；其余按当前会话的权限点决定是否出现 ——
 * 与后端的 `@RequirePermissions` 一一对应（见服务端 constants/permission）。
 * 「我的账号」不做成导航项：它是每个人的私有页面，放在右上角身份栏更顺手。
 */
const NAV_ITEMS = [
  { to: "/", label: "概览", end: true, permission: PERMISSION.STATS_READ as string | null },
  { to: "/accounts", label: "账号管理", end: false, permission: PERMISSION.ACCOUNT_READ as string },
  { to: "/roles", label: "角色管理", end: false, permission: PERMISSION.ROLE_READ as string },
  { to: "/admins", label: "管理员", end: false, permission: PERMISSION.ADMIN_READ as string },
  { to: "/audit-logs", label: "操作日志", end: false, permission: PERMISSION.AUDIT_READ as string },
];

/**
 * 后台骨架：左侧导航 + 顶部身份栏 + 内容区
 *
 * 进来先静默拉一次「当前管理员」：令牌过期 / 被停用时请求层会统一把人送回登录页；
 * 同时把最新的角色与权限点写回会话（管理员被降权后刷新即可看到界面跟着变）。
 */
export function Layout() {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState(readAdmin());

  useEffect(() => {
    let alive = true;
    authApi
      .me()
      .then((info) => {
        if (!alive) return;
        setAdmin(info);
        const token = readToken();
        if (token) saveSession(token, info);
      })
      .catch(() => {
        /* 错误已由请求层统一处理（需要时自动回登录页） */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 会话变化（「我的账号」里改完密码换了新令牌 / 被重置后清会话）→ 顶部身份栏跟着刷新
  useEffect(() => subscribeSession(setAdmin), []);

  const logout = () => {
    clearSession();
    navigate("/login", { replace: true });
  };

  const visibleNav = NAV_ITEMS.filter((item) => !item.permission || hasPermission(item.permission));

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-900/50 px-4 py-6">
        <p className="px-2 text-sm font-semibold tracking-wide text-slate-100">{APP_TITLE}</p>
        <nav className="mt-6 flex flex-col gap-1">
          {visibleNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 text-sm transition ${
                  isActive ? "bg-indigo-500/15 font-medium text-indigo-300" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-slate-800 bg-slate-900/30 px-6 py-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate text-sm text-slate-300">
              当前管理员：<span className="font-medium text-slate-100">{admin?.username ?? "未知"}</span>
              {admin?.role ? <Badge tone={admin.role === "super_admin" ? "amber" : admin.role === "viewer" ? "slate" : "indigo"}>{adminRoleLabel(admin.role)}</Badge> : null}
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              权限点 {(admin?.permissions ?? []).length} 项 · 界面按权限显隐，服务端独立校验
            </p>
          </div>
          <div className="flex items-center gap-2">
            <NavLink to="/me">
              {({ isActive }) => (
                <Button variant={isActive ? "primary" : "outline"}>我的账号</Button>
              )}
            </NavLink>
            <Button variant="outline" onClick={logout}>
              退出登录
            </Button>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
