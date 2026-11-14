import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { adminRoleLabel, authApi, ensureGameData, ensureMapCatalog, PERMISSION } from "../api";
import type { ZoneOption } from "../api";
import { APP_TITLE } from "../api/config";
import {
  clearSession,
  hasPermission,
  readAdmin,
  readToken,
  readZoneId,
  saveSession,
  saveZoneId,
  subscribeSession,
  subscribeZone,
} from "../store/session";
import { Badge, Button } from "./ui";

/**
 * 导航树及其所需权限点
 *
 * 没有权限点的（概览）始终显示；其余按当前会话的权限点决定是否出现 ——
 * 与后端的 `@RequirePermissions` 一一对应（见服务端 constants/permission）。
 * 「我的账号」不做成导航项：它是每个人的私有页面，放在右上角身份栏更顺手。
 *
 * ## 三层结构（#710 起从「组 → 项」细分成「组 → 小节 → 项」）
 * 页面多了以后单层分组一拉开就是二三十行，所以功能域（组）里再按用途分小节，
 * 小节里才是真正的页面链接；组与小节都是可折叠的按钮，叶子才是路由链接。
 * 路由本身仍是扁平路径（`App.tsx` 不用动），这里的层级只是侧栏的视觉与交互层次。
 */
type NavLeaf = { to: string; label: string; end?: boolean; permission: string | null };
type NavBranch = { label: string; children: NavNode[] };
type NavNode = NavLeaf | NavBranch;

const isBranch = (node: NavNode): node is NavBranch => "children" in node;

/** 顶层独立项：不属于任何功能域、进来第一眼就要看到的入口 */
const NAV_TOP: NavLeaf[] = [{ to: "/", label: "概览", end: true, permission: PERMISSION.STATS_READ as string | null }];

/**
 * 功能域 → 小节 → 页面
 *
 * label 同时是展开态的存储 key 的一部分（key = 各级 label 用 `/` 连接），
 * 改名会重置用户的折叠偏好 —— 无害，只是回到全展开。
 */
const NAV_GROUPS: NavBranch[] = [
  {
    label: "运营管理",
    children: [
      {
        label: "账号与区服",
        children: [
          { to: "/accounts", label: "账号管理", permission: PERMISSION.ACCOUNT_READ },
          { to: "/roles", label: "角色管理", permission: PERMISSION.ROLE_READ },
          { to: "/zones", label: "区服管理", permission: PERMISSION.ZONE_READ },
        ],
      },
      {
        label: "玩家与社区",
        children: [
          { to: "/guilds", label: "帮会管理", permission: PERMISSION.GUILD_READ },
          { to: "/mails", label: "邮件", permission: PERMISSION.MAIL_READ },
          { to: "/mail-send", label: "发消息", permission: PERMISSION.GAME_MAIL_SEND },
          { to: "/reports", label: "玩家举报", permission: PERMISSION.REPORT_READ },
          { to: "/announcements", label: "公告", permission: PERMISSION.ANNOUNCEMENT_READ },
        ],
      },
    ],
  },
  {
    label: "战斗与装备",
    children: [
      {
        label: "装备",
        children: [
          { to: "/equipments", label: "装备配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/equipment-tiers", label: "前后缀管理", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/equipment-settings", label: "槽位与规则", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/equipment-borders", label: "装备边框", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/equipment-backgrounds", label: "装备详情背景", permission: PERMISSION.GAME_CONFIG_READ },
        ],
      },
      {
        label: "对齐工作台",
        children: [
          { to: "/equip-align", label: "装备对齐", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/equip-in-align", label: "内观对齐", permission: PERMISSION.GAME_CONFIG_READ },
        ],
      },
      {
        label: "战斗配置",
        children: [
          { to: "/monsters", label: "怪物配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/skills", label: "技能配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/statuses", label: "状态配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/drops", label: "掉落配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/combat-weights", label: "战斗力权重", permission: PERMISSION.GAME_CONFIG_READ },
        ],
      },
      {
        label: "世界与表现",
        children: [
          { to: "/maps", label: "地图管理", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/npcs", label: "NPC 配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/ui-effects", label: "特效管理", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/audio", label: "音效配置", permission: PERMISSION.GAME_CONFIG_READ },
        ],
      },
      {
        label: "参数与引导",
        children: [
          { to: "/runtime-params", label: "运行时参数", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/guide-steps", label: "新手引导", permission: PERMISSION.GAME_CONFIG_READ },
        ],
      },
    ],
  },
  {
    label: "养成与玩法",
    children: [
      {
        label: "角色养成",
        children: [
          { to: "/titles", label: "称号配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/souls", label: "战魂配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/ranks", label: "军衔配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/growth", label: "成长参数", permission: PERMISSION.GAME_CONFIG_READ },
        ],
      },
      {
        label: "物品与商城",
        children: [
          { to: "/items", label: "物品配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/drugs", label: "药品配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/money-items", label: "货币道具", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/level-scrolls", label: "升级卷轴", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/fashions", label: "时装配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/mall", label: "商城", permission: PERMISSION.GAME_CONFIG_READ },
        ],
      },
      {
        label: "玩法",
        children: [
          { to: "/quests", label: "任务配置", permission: PERMISSION.GAME_CONFIG_READ },
          { to: "/achievements", label: "成就配置", permission: PERMISSION.GAME_CONFIG_READ },
        ],
      },
    ],
  },
  {
    label: "系统管理",
    children: [
      { to: "/admins", label: "管理员", permission: PERMISSION.ADMIN_READ },
      { to: "/audit-logs", label: "操作日志", permission: PERMISSION.AUDIT_READ },
      { to: "/event-logs", label: "玩家行为流水", permission: PERMISSION.EVENT_READ },
      { to: "/config-versions", label: "配置版本", permission: PERMISSION.CONFIG_READ },
      { to: "/system", label: "系统信息", permission: PERMISSION.SYSTEM_READ },
    ],
  },
];

/** 折叠偏好存哪：key 是各级 label 的 `/` 连接串，任何一级改名 = 那棵子树偏好重置 */
const NAV_EXPANDED_KEY = "olua-admin-nav-expanded";

/** 展开 key 的连接符（label 不该含 `/`，这里只是防御） */
const KEY_SEP = "/";

/** 收集一棵导航树里所有分组的展开 key（默认全展开用） */
const collectKeys = (nodes: NavNode[], prefix = ""): string[] =>
  nodes.flatMap((node) =>
    isBranch(node) ? [prefix + node.label, ...collectKeys(node.children, `${prefix}${node.label}${KEY_SEP}`)] : [],
  );

/** 与 NavLink 的 end 语义对齐：非 end 项要连详情页（如 /accounts/:id）一起算「组内有高亮」 */
const isActiveRoute = (item: NavLeaf, pathname: string) =>
  item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);

/** 这棵子树里（含自身）有没有当前路由对应的叶子 */
const hasActiveLeaf = (node: NavNode, pathname: string): boolean =>
  isBranch(node) ? node.children.some((child) => hasActiveLeaf(child, pathname)) : isActiveRoute(node, pathname);

/** 当前路由对应的全部祖先分组 key（换页时自动展开用） */
const activeBranchKeys = (nodes: NavNode[], pathname: string, prefix = ""): string[] =>
  nodes.flatMap((node) => {
    if (!isBranch(node)) return [];
    const key = `${prefix}${node.label}`;
    if (!hasActiveLeaf(node, pathname)) return [];
    return [key, ...activeBranchKeys(node.children, pathname, `${key}${KEY_SEP}`)];
  });

/** 当前页在导航树里的路径（顶栏面包屑用）：`["战斗与装备","装备","装备配置"]` */
const findTrail = (nodes: NavNode[], pathname: string, trail: string[] = []): string[] | null => {
  for (const node of nodes) {
    if (isBranch(node)) {
      const found = findTrail(node.children, pathname, [...trail, node.label]);
      if (found) return found;
    } else if (isActiveRoute(node, pathname)) {
      return [...trail, node.label];
    }
  }
  return null;
};

/** 分组计数：组标题右侧那句「07」是叶子总数，让人知道收起来的是什么规模 */
const leafCount = (node: NavNode): number =>
  isBranch(node) ? node.children.reduce((sum, child) => sum + leafCount(child), 0) : 1;

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
    return new Set(collectKeys(NAV_GROUPS));
  });

  const toggleGroup = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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

  //#region 当前区（#960）

  /** 当前所在的区：只决定「这次请求在哪个区里干活」，不是权限（谁都能切任意区） */
  const [zoneId, setZoneId] = useState<number | null>(() => readZoneId());
  const [zones, setZones] = useState<ZoneOption[]>([]);

  useEffect(() => subscribeZone(setZoneId), []);

  /**
   * 顶栏常驻区切换器：清单只在进布局时拉一次
   *
   * 拉不到就只显示当前区 id —— 切不了区不该挡住后台任何一页（区清单本身是全局模块，
   * 不受当前区影响）。
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await authApi.zones({ silent: true });
        if (!alive) return;
        setZones(list);
        // 本机没记过（换了浏览器 / 清了缓存）→ 用第一个可选区兜底，避免每个请求都 400
        if (readZoneId() === null && list.length > 0) saveZoneId(list[0].id);
      } catch {
        /* 静默：用当前记住的区继续 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  //#endregion

  // 地图名录（#573）：地图名只在服务端，角色详情 / 实体选择器要同步读它 ——
  // 登录后进到布局就拉一次，失败静默（只是名字回落成 id，不挡任何页面）
  useEffect(() => {
    void ensureMapCatalog();
  }, []);

  // 游戏数据字典（#655）：装备 / 物品 / 技能 / 怪物 / NPC 的名字与下拉清单都在数据库，
  // 与地图名录同一个套路 —— 登录后拉一次 `GET /admin/game-data`，之后同步查表。
  // 放在布局里而不是每个页面：这些名字在表格、选择器、详情页到处都要用。
  useEffect(() => {
    void ensureGameData();
  }, []);

  /**
   * 换页面时的三件收尾
   *
   * 1. **内容区回顶部**：滚动容器换成了 `main`（不是文档），浏览器那套「换 URL 自动回顶」
   *    就管不着了 —— 不复位的话从长列表点进下一页会停在半空。
   * 2. **当前项所在的每一层分组自动展开**：直接输 URL / 点旧链接进二级页时，所在组可能收着，
   *    不展开的话当前项根本不在 DOM 里。setState 触发重渲后，下面的滚动收尾会跟着重跑。
   * 3. **导航把当前项滚进视野**：菜单项多且分层，刷新后当前项可能在侧栏可视区外，
   *    看着像「没有任何菜单被选中」。只挪到刚好可见（nearest），不把整列甩到顶。
   */
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    const keys = activeBranchKeys(visibleGroups, location.pathname);
    if (keys.some((key) => !expanded.has(key))) {
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const key of keys) next.add(key);
        return next;
      });
    }
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

  /**
   * 切区
   *
   * **只换 `X-Zone-Id` 并重拉当前页数据，不跳登录**（设计稿口径）。重拉靠下面 `Outlet` 的 key：
   * 换 key = 当前页组件整体重挂载，各页自己的 `useEffect` 拉数都会再跑一遍 ——
   * 比让每个页面订阅「区变了」更省事，也不会漏掉某个页面忘了订阅。
   */
  const switchZone = (next: number) => {
    if (next === zoneId) return;
    saveZoneId(next);
  };

  // 权限过滤递归到叶：子树全被过滤掉的分组整枝隐藏
  const canSee = (leaf: NavLeaf) => !leaf.permission || hasPermission(leaf.permission);
  const prune = (nodes: NavNode[]): NavNode[] =>
    nodes
      .map((node) => (isBranch(node) ? { ...node, children: prune(node.children) } : node))
      .filter((node) => (isBranch(node) ? node.children.length > 0 : canSee(node)));
  const visibleTop = NAV_TOP.filter(canSee);
  const visibleGroups = prune(NAV_GROUPS) as NavBranch[];

  /** 叶子链接：选中时左缘一道金条（设计稿 `.nav-leaf.active`），比整块填充安静 */
  const navLinkClass = (isActive: boolean) =>
    `-ml-px block border-l-2 py-1.5 pl-3 pr-2 text-[12.5px] transition-colors ${
      isActive
        ? "border-gold bg-gradient-to-r from-gold/12 to-transparent font-medium text-gold-hi"
        : "border-transparent text-ink-2 hover:border-line-gold hover:bg-gold-veil hover:text-ink-1"
    }`;

  /** 展开箭头（组与小节共用，尺寸随层级） */
  const chevron = (open: boolean, small: boolean) => (
    <svg
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 transition-transform ${small ? "h-2.5 w-2.5" : "h-3 w-3"} ${open ? "rotate-90" : ""}`}
      aria-hidden="true"
    >
      <path d="M4 2.5 8 6l-4 3.5" />
    </svg>
  );

  /** 递归渲染一个导航节点：branch = 可折叠小节标题，leaf = 路由链接 */
  const renderNode = (node: NavNode, key: string, depth: number) => {
    if (!isBranch(node)) {
      return (
        <NavLink key={key} to={node.to} end={node.end} className={({ isActive }) => navLinkClass(isActive)}>
          {node.label}
        </NavLink>
      );
    }
    const open = expanded.has(key);
    // 这层收着但里面有高亮项时，标题自己亮起来 —— 否则当前页「凭空消失」
    const activeInBranch = !open && hasActiveLeaf(node, location.pathname);
    const topLevel = depth === 0;
    return (
      <div key={key} className={topLevel ? "mt-3" : ""}>
        <button
          type="button"
          onClick={() => toggleGroup(key)}
          aria-expanded={open}
          className={`flex w-full items-center gap-2 rounded-sm transition-colors ${
            topLevel
              ? `px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-[.20em] ${
                  activeInBranch ? "text-gold" : "text-ink-4 hover:text-ink-2"
                }`
              : `ml-1 px-2 py-1 text-[11px] tracking-[.04em] ${activeInBranch ? "text-gold/90" : "text-ink-5 hover:text-ink-3"}`
          }`}
        >
          {chevron(open, !topLevel)}
          <span className="truncate">{node.label}</span>
          {topLevel ? <span className="ml-auto font-mono text-[9px] text-gold-dim">{leafCount(node)}</span> : null}
        </button>
        {open && (
          <div
            className={`mt-0.5 flex flex-col ${
              topLevel ? "ml-3 border-l border-gold/10 pl-1.5" : "ml-3 border-l border-gold/10 pl-1.5"
            }`}
          >
            {node.children.map((child) => renderNode(child, `${key}${KEY_SEP}${child.label}`, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // 顶栏面包屑：管理端 / 组 / 小节 / 页面
  const trail = findTrail([...visibleTop, ...visibleGroups], location.pathname);
  const roleLabel = admin?.role ? adminRoleLabel(admin.role) : "—";
  const initial = (admin?.username ?? "?").slice(0, 1).toUpperCase();

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="legend-side flex w-60 shrink-0 flex-col overflow-hidden">
        {/* 品牌：盾形纹章 + 衬线字标（与登录页同一枚纹章） */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-gold/10 px-[18px] py-5">
          <svg viewBox="0 0 26 31" className="h-[27px] w-[23px] shrink-0" aria-hidden="true">
            <path d="M13 1 25 5v10.5c0 6.6-5 11.6-12 14.5C6 27.1 1 22.1 1 15.5V5L13 1Z" fill="none" stroke="var(--color-gold-dim)" />
            <path d="M13 5.5 21 8.3v7.2c0 4.6-3.4 8.2-8 10.3-4.6-2.1-8-5.7-8-10.3V8.3L13 5.5Z" fill="none" stroke="var(--color-gold)" opacity=".55" />
            <path d="M13 9.5v9M9.5 13.5h7" stroke="var(--color-gold-hi)" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <div className="min-w-0">
            <b className="block truncate font-display text-[15px] font-bold leading-none tracking-[.22em] text-gold-hi">
              {APP_TITLE}
            </b>
            <span className="mt-1.5 block font-mono text-[8.5px] tracking-[.28em] text-ink-4">ADMIN CONSOLE</span>
          </div>
        </div>

        {/* 会话状态条：绿点只表示「令牌有效」，不表示业务在线数 */}
        <div className="mx-3 mt-3 flex shrink-0 items-center gap-2 rounded-sm border border-gold/12 bg-surface-0/30 px-2.5 py-2 font-mono text-[10.5px] tracking-[.04em] text-ink-3">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-jade" />
          <span className="truncate">会话有效 · 权限 {(admin?.permissions ?? []).length} 项</span>
        </div>

        <nav ref={navRef} className="mt-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 py-2 [scrollbar-gutter:stable]">
          {visibleTop.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `-ml-px flex items-center gap-2.5 border-l-2 py-2 pl-3 pr-2 text-[13px] transition-colors ${
                  isActive
                    ? "border-gold bg-gradient-to-r from-gold/15 to-transparent font-medium text-gold-hi"
                    : "border-transparent text-ink-2 hover:border-line-gold hover:bg-gold-veil hover:text-ink-1"
                }`
              }
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-gold" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
                <rect x="1.5" y="1.5" width="5" height="5" />
                <rect x="9.5" y="1.5" width="5" height="5" />
                <rect x="1.5" y="9.5" width="5" height="5" />
                <rect x="9.5" y="9.5" width="5" height="5" />
              </svg>
              {item.label}
            </NavLink>
          ))}
          {visibleGroups.map((group) => renderNode(group, group.label, 0))}
        </nav>

        {/* 身份栏：纹章方块 (首字) + 账号 + 角色 */}
        <div className="flex shrink-0 items-center gap-2.5 border-t border-gold/10 px-3.5 py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm border border-gold-dim bg-gradient-to-b from-gold/15 to-gold/5 font-display text-[13px] text-gold-hi">
            {initial}
          </span>
          <div className="min-w-0">
            <b className="block truncate text-[12.5px] font-semibold text-ink-1">{admin?.username ?? "未知"}</b>
            <span className="block truncate font-mono text-[9.5px] tracking-[.08em] text-ink-4">{roleLabel}</span>
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="legend-topbar flex h-[60px] shrink-0 items-center gap-4 px-6">
          {/* 面包屑：直接输 URL 进来也知道自己在哪一层 */}
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="font-mono text-[10px] tracking-[.16em] text-gold-dim">OLUA</span>
            {(trail ?? ["未知页面"]).map((label, index, all) => (
              <span key={`${label}-${index}`} className="flex min-w-0 items-center gap-2">
                <span className="text-gold-dim">/</span>
                <span className={index === all.length - 1 ? "truncate text-ink-2" : "truncate text-ink-4"}>{label}</span>
              </span>
            ))}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* 区切换器：常驻顶栏（不是权限，是「我现在在哪个区里干活」） */}
            <label className="flex items-center gap-1.5 rounded-sm border border-gold/20 bg-gold-veil px-2 py-1">
              <span className="font-mono text-[9.5px] uppercase tracking-[.16em] text-gold-dim">区服</span>
              <select
                className="bg-transparent pr-1 text-[12px] text-ink-1 outline-none"
                value={zoneId ?? ""}
                aria-label="切换区服"
                onChange={(e) => switchZone(Number(e.target.value))}
              >
                {zones.length === 0 ? <option value={zoneId ?? ""}>{zoneId ?? "—"}</option> : null}
                {zones.map((zone) => (
                  <option key={zone.id} value={zone.id} className="bg-surface-1 text-ink-1">
                    {zone.name}
                  </option>
                ))}
              </select>
            </label>
            {admin?.role ? (
              <span className="hidden sm:inline-flex">
                <Badge tone={admin.role === "super_admin" ? "warn" : admin.role === "viewer" ? "muted" : "gold"}>
                  {roleLabel}
                </Badge>
              </span>
            ) : null}
            <NavLink to="/me">
              {({ isActive }) => <Button variant={isActive ? "primary" : "outline"}>我的账号</Button>}
            </NavLink>
            <Button variant="outline" onClick={logout}>
              退出登录
            </Button>
          </div>
        </header>
        <main ref={mainRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
          {/* key = 当前区：切区后整页重挂载，各页自己的拉数逻辑随之重跑（#960） */}
          <div className="mx-auto w-full max-w-[1440px]" key={zoneId ?? "no-zone"}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
