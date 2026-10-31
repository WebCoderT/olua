import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
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
  { to: "/announcements", label: "公告", end: false, permission: PERMISSION.ANNOUNCEMENT_READ as string },
  { to: "/titles", label: "称号配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/souls", label: "战魂配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/ranks", label: "军衔配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/equipments", label: "装备配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/equip-align", label: "装备对齐", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/equip-in-align", label: "内观对齐", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/drugs", label: "药品配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/items", label: "物品配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/monsters", label: "怪物配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/npcs", label: "NPC 配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/skills", label: "技能配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/statuses", label: "状态配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/quests", label: "任务配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/achievements", label: "成就配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/mall", label: "商城定价", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/fashions", label: "时装配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/drops", label: "掉落配置", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/growth", label: "成长曲线", end: false, permission: PERMISSION.GAME_CONFIG_READ as string },
  { to: "/zones", label: "区服管理", end: false, permission: PERMISSION.ZONE_READ as string },
  { to: "/guilds", label: "帮会管理", end: false, permission: PERMISSION.GUILD_READ as string },
  { to: "/mails", label: "邮件", end: false, permission: PERMISSION.MAIL_READ as string },
  { to: "/reports", label: "玩家举报", end: false, permission: PERMISSION.REPORT_READ as string },
  { to: "/admins", label: "管理员", end: false, permission: PERMISSION.ADMIN_READ as string },
  { to: "/audit-logs", label: "操作日志", end: false, permission: PERMISSION.AUDIT_READ as string },
  { to: "/system", label: "系统信息", end: false, permission: PERMISSION.SYSTEM_READ as string },
];

/**
 * 后台骨架：左侧导航 + 顶部身份栏 + 内容区
 *
 * 进来先静默拉一次「当前管理员」：令牌过期 / 被停用时请求层会统一把人送回登录页；
 * 同时把最新的角色与权限点写回会话（管理员被降权后刷新即可看到界面跟着变）。
 *
 * ## 高度：整页不滚，各区域自己滚
 * 外层锁死一屏（`h-screen overflow-hidden`），导航栏与内容区各自 `overflow-y-auto`：
 * 导航项再多也只滚那条侧栏，顶栏身份信息始终看得见；换页面时滚动的只有内容区，
 * 侧栏与顶栏不会跟着上下跑。`min-h-0` 是必须的 —— flex 子项的默认 `min-height:auto`
 * 会让它撑到内容高度，`overflow-y-auto` 就永远不触发（表现为「整页越滚越长」）。
 * 弹窗都是 `fixed`，不受这里的 `overflow-hidden` 影响。
 */
export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const mainRef = useRef<HTMLElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
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

  /**
   * 换页面时的两件收尾
   *
   * 1. **内容区回顶部**：滚动容器换成了 `main`（不是文档），浏览器那套「换 URL 自动回顶」
   *    就管不着了 —— 不复位的话从长列表点进下一页会停在半空。
   * 2. **导航把当前项滚进视野**：29 项里点第 25 项，刷新后当前项在侧栏可视区外，
   *    看着像「没有任何菜单被选中」。只挪到刚好可见（nearest），不把整列甩到顶。
   */
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    const nav = navRef.current;
    // NavLink 选中时自带 aria-current="page"，不用另查 class
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const navBox = nav.getBoundingClientRect();
    const itemBox = active.getBoundingClientRect();
    if (itemBox.top < navBox.top) nav.scrollTop -= navBox.top - itemBox.top;
    else if (itemBox.bottom > navBox.bottom) nav.scrollTop += itemBox.bottom - navBox.bottom;
  }, [location.pathname]);

  const logout = () => {
    clearSession();
    navigate("/login", { replace: true });
  };

  const visibleNav = NAV_ITEMS.filter((item) => !item.permission || hasPermission(item.permission));

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-slate-800 bg-slate-900/50 px-4 py-6">
        <p className="shrink-0 px-2 text-sm font-semibold tracking-wide text-slate-100">{APP_TITLE}</p>
        <nav ref={navRef} className="mt-6 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
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

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-800 bg-slate-900/30 px-6 py-4">
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
        <main ref={mainRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6 [scrollbar-gutter:stable]">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
