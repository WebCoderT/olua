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
 *
 * 29 项按功能分成四个可折叠分组 + 一个顶层独立项（概览）：
 * 路由本身仍是扁平路径（`App.tsx` 不用动），分组只是侧栏的视觉与交互层次。
 */
type NavItem = { to: string; label: string; end?: boolean; permission: string | null };

/** 顶层独立项：不属于任何功能域、进来第一眼就要看到的入口 */
const NAV_TOP: NavItem[] = [{ to: "/", label: "概览", end: true, permission: PERMISSION.STATS_READ as string | null }];

/** 二级分组：label 同时是展开态的存储 key，改名会重置用户的折叠偏好 */
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "运营管理",
    items: [
      { to: "/accounts", label: "账号管理", permission: PERMISSION.ACCOUNT_READ },
      { to: "/roles", label: "角色管理", permission: PERMISSION.ROLE_READ },
      { to: "/zones", label: "区服管理", permission: PERMISSION.ZONE_READ },
      { to: "/guilds", label: "帮会管理", permission: PERMISSION.GUILD_READ },
      { to: "/mails", label: "邮件", permission: PERMISSION.MAIL_READ },
      { to: "/reports", label: "玩家举报", permission: PERMISSION.REPORT_READ },
      { to: "/announcements", label: "公告", permission: PERMISSION.ANNOUNCEMENT_READ },
    ],
  },
  {
    label: "战斗与装备",
    items: [
      { to: "/equipments", label: "装备配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/equip-align", label: "装备对齐", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/equip-in-align", label: "内观对齐", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/monsters", label: "怪物配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/npcs", label: "NPC 配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/skills", label: "技能配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/statuses", label: "状态配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/drops", label: "掉落配置", permission: PERMISSION.GAME_CONFIG_READ },
    ],
  },
  {
    label: "养成与玩法",
    items: [
      { to: "/titles", label: "称号配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/souls", label: "战魂配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/ranks", label: "军衔配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/drugs", label: "药品配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/items", label: "物品配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/fashions", label: "时装配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/growth", label: "成长曲线", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/quests", label: "任务配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/achievements", label: "成就配置", permission: PERMISSION.GAME_CONFIG_READ },
      { to: "/mall", label: "商城定价", permission: PERMISSION.GAME_CONFIG_READ },
    ],
  },
  {
    label: "系统管理",
    items: [
      { to: "/admins", label: "管理员", permission: PERMISSION.ADMIN_READ },
      { to: "/audit-logs", label: "操作日志", permission: PERMISSION.AUDIT_READ },
      { to: "/system", label: "系统信息", permission: PERMISSION.SYSTEM_READ },
    ],
  },
];

/** 折叠偏好存哪：key 里带 label，分组改名 = 偏好重置（回到全展开） */
const NAV_EXPANDED_KEY = "olua-admin-nav-expanded";

/** 与 NavLink 的 end 语义对齐：非 end 项要连详情页（如 /accounts/:id）一起算「组内有高亮」 */
const isActiveRoute = (item: NavItem, pathname: string) =>
  item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);

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
  /** 各分组展开态：默认全展开（与改版前一致的可见性），折叠偏好记在 localStorage */
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(NAV_EXPANDED_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      /* 坏数据当没存过，走默认全展开 */
    }
    return new Set(NAV_GROUPS.map((g) => g.label));
  });

  const toggleGroup = (label: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      try {
        localStorage.setItem(NAV_EXPANDED_KEY, JSON.stringify([...next]));
      } catch {
        /* 存不进去只影响下次刷新，不影响本次交互 */
      }
      return next;
    });
  };

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
   * 换页面时的三件收尾
   *
   * 1. **内容区回顶部**：滚动容器换成了 `main`（不是文档），浏览器那套「换 URL 自动回顶」
   *    就管不着了 —— 不复位的话从长列表点进下一页会停在半空。
   * 2. **当前项所在分组自动展开**：直接输 URL / 点旧链接进二级页时，那个组可能是收着的，
   *    不展开的话当前项根本不在 DOM 里。setState 触发重渲后，下面的滚动收尾会跟着重跑。
   * 3. **导航把当前项滚进视野**：29 项里点第 25 项，刷新后当前项在侧栏可视区外，
   *    看着像「没有任何菜单被选中」。只挪到刚好可见（nearest），不把整列甩到顶。
   */
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    const group = visibleGroups.find((g) => g.items.some((item) => isActiveRoute(item, location.pathname)));
    if (group && !expanded.has(group.label)) setExpanded((prev) => new Set(prev).add(group.label));
  }, [location.pathname]);

  useEffect(() => {
    const nav = navRef.current;
    // NavLink 选中时自带 aria-current="page"，不用另查 class
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const navBox = nav.getBoundingClientRect();
    const itemBox = active.getBoundingClientRect();
    if (itemBox.top < navBox.top) nav.scrollTop -= navBox.top - itemBox.top;
    else if (itemBox.bottom > navBox.bottom) nav.scrollTop += itemBox.bottom - navBox.bottom;
  }, [location.pathname, expanded]);

  const logout = () => {
    clearSession();
    navigate("/login", { replace: true });
  };

  // 权限过滤递归到组：子项全被过滤掉的分组整组隐藏
  const canSee = (item: NavItem) => !item.permission || hasPermission(item.permission);
  const visibleTop = NAV_TOP.filter(canSee);
  const visibleGroups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter(canSee) })).filter((g) => g.items.length > 0);

  const navLinkClass = (isActive: boolean) =>
    `rounded-lg px-3 py-2 text-sm transition ${
      isActive ? "bg-indigo-500/15 font-medium text-indigo-300" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
    }`;

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-slate-800 bg-slate-900/50 px-4 py-6">
        <p className="shrink-0 px-2 text-sm font-semibold tracking-wide text-slate-100">{APP_TITLE}</p>
        <nav ref={navRef} className="mt-6 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
          {visibleTop.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => navLinkClass(isActive)}>
              {item.label}
            </NavLink>
          ))}
          {visibleGroups.map((group) => {
            const open = expanded.has(group.label);
            // 组收着但里面有高亮项时，组标题自己亮起来 —— 否则当前页「凭空消失」
            const activeInGroup = !open && group.items.some((item) => isActiveRoute(item, location.pathname));
            return (
              <div key={group.label}>
                <button
                  type="button"
                  onClick={() => toggleGroup(group.label)}
                  aria-expanded={open}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold tracking-wide transition ${
                    activeInGroup ? "text-indigo-300" : "text-slate-500 hover:bg-slate-800/60 hover:text-slate-200"
                  }`}
                >
                  {group.label}
                  <svg
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
                    aria-hidden="true"
                  >
                    <path d="M4 2.5 8 6l-4 3.5" />
                  </svg>
                </button>
                {open && (
                  <div className="mt-0.5 flex flex-col gap-0.5 border-l border-slate-800 ml-3 pl-2">
                    {group.items.map((item) => (
                      <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => navLinkClass(isActive)}>
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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
