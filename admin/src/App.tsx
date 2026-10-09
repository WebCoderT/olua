import { useEffect } from "react";
import type { ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { PERMISSION } from "./api";
import { setErrorObserver, setReloginHandler } from "./api/http";
import { Layout } from "./components/Layout";
import { ToastHost } from "./components/ToastHost";
import { EmptyState } from "./components/ui";
import { AccountDetailPage } from "./pages/AccountDetailPage";
import { AccountsPage } from "./pages/AccountsPage";
import { AdminsPage } from "./pages/AdminsPage";
import { AuditPage } from "./pages/AuditPage";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import { MyAccountPage } from "./pages/MyAccountPage";
import { RegisterPage } from "./pages/RegisterPage";
import { RoleDetailPage } from "./pages/RoleDetailPage";
import { RolesPage } from "./pages/RolesPage";
import { SystemPage } from "./pages/SystemPage";
import { clearSession, hasPermission, isLoggedIn } from "./store/session";
import { toastError } from "./store/toast";

/** 需要登录的页面外壳（未登录直接弹回登录页） */
function RequireAuth({ children }: { children: ReactNode }) {
  if (!isLoggedIn()) return <Navigate to="/login" replace />;
  return children;
}

/**
 * 需要某权限点的页面外壳
 *
 * 只是体验层：真正的判定在服务端（权限守卫返回 403 / 30006）。
 * 直接改地址栏闯进来时，这里就地给出提示而不是白屏。
 */
function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
  if (!hasPermission(permission)) {
    return <EmptyState title="没有访问权限" description="当前管理员角色无法查看这个页面，请联系超级管理员。" />;
  }
  return children;
}

/**
 * 应用根：路由表 + 两处全局接线
 *
 * 1. 请求层「需要重新登录」→ 清会话 + 回登录页（http 层不认识路由，所以由这里接）
 * 2. 请求层「出错」→ 统一弹提示（silent 的请求除外，如登录表单自己就地展示）
 */
export function App() {
  const navigate = useNavigate();

  useEffect(() => {
    setReloginHandler(() => {
      clearSession();
      navigate("/login", { replace: true });
    });
    setErrorObserver((error) => toastError(error.message));
  }, [navigate]);

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route
            index
            element={
              <RequirePermission permission={PERMISSION.STATS_READ}>
                <DashboardPage />
              </RequirePermission>
            }
          />
          <Route
            path="accounts"
            element={
              <RequirePermission permission={PERMISSION.ACCOUNT_READ}>
                <AccountsPage />
              </RequirePermission>
            }
          />
          <Route
            path="accounts/:id"
            element={
              <RequirePermission permission={PERMISSION.ACCOUNT_READ}>
                <AccountDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="roles"
            element={
              <RequirePermission permission={PERMISSION.ROLE_READ}>
                <RolesPage />
              </RequirePermission>
            }
          />
          <Route
            path="roles/:id"
            element={
              <RequirePermission permission={PERMISSION.ROLE_READ}>
                <RoleDetailPage />
              </RequirePermission>
            }
          />
          <Route
            path="admins"
            element={
              <RequirePermission permission={PERMISSION.ADMIN_READ}>
                <AdminsPage />
              </RequirePermission>
            }
          />
          <Route
            path="audit-logs"
            element={
              <RequirePermission permission={PERMISSION.AUDIT_READ}>
                <AuditPage />
              </RequirePermission>
            }
          />
          <Route
            path="system"
            element={
              <RequirePermission permission={PERMISSION.SYSTEM_READ}>
                <SystemPage />
              </RequirePermission>
            }
          />
          {/* 我的账号：任何已登录管理员都能进，不需要权限点 */}
          <Route path="me" element={<MyAccountPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ToastHost />
    </>
  );
}
