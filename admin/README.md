# admin · 管理端（React）

> 运营后台：账号 / 角色 / 管理员 / 公告 / 操作日志五块。界面按**权限点**显隐，服务端独立校验。
>
> 项目总览见 [../README.md](../README.md)；管理端的问题见 [FAQ.md](FAQ.md)；
> 客户端 / 服务端 / 跨端见 [../client/](../client/) · [../server/](../server/) · [../FAQ.md](../FAQ.md)。

## 技术栈

- **React 19** + **TypeScript** + **Vite**
- **Tailwind CSS v4**（`@tailwindcss/vite` 插件，无 `tailwind.config.js`，主题写在 `src/index.css`）
- **react-router-dom v7**（路由即权限外壳，见下）
- 接口层**不手写路径与类型**：`src/api/{routes,models,endpoints}.ts` 由服务端的 `openapi.json` 生成

## 环境要求

- **Node.js 20+**（与 Vite / React 19 要求一致）
- 服务端需先跑起来（默认 `http://localhost:3100`）

## 快速开始

```bash
cd admin
npm install
cp .env.example .env.development   # 首次：接口根地址在这里（VITE_API_BASE_URL）
npm run dev                        # 开发（默认 5173）；npm run build 产出 dist/
```

- 注册需要在 `server/.env` 里配 `ADMIN_REGISTER_CODE`（留空 = 开放注册），注册时填同一个注册码
- **第一个**注册的管理员自动成为超级管理员（全部权限），之后的都是普通管理员，要提权由超管在「管理员」页调整

## npm 脚本

| 脚本 | 作用 |
| --- | --- |
| `npm run dev` | 开发服务器（Vite，热更新） |
| `npm run build` | **类型检查 + 构建**（`tsc --noEmit && vite build`，产出 `dist/`） |
| `npm run preview` | 预览已构建产物 |
| `npm run typecheck` | 只做类型检查（不产出） |

> 仓库根的 `make` 是这些脚本的快捷方式：`make admin-dev` / `make admin-build` /
> `make admin-typecheck`；`make dev` 还能把服务端与管理端一起起来。`make help` 看全部。

## 环境变量

全部在 `admin/.env.development`（开发）与 `.env.production`（生产），模板见 `.env.example`。
代码里不允许再出现接口地址字面量 —— `node ../tools/audit-api-hardcode.cjs` 会检查「用到的键是否都在 `.env.example` 里登记过」。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:3100/api` | **接口地址唯一来源**（`src/api/config.ts` 只读它） |
| `VITE_API_TIMEOUT` | `15000` | 请求超时（毫秒） |
| `VITE_APP_TITLE` | `olua 管理端` | 页面标题（顶栏与浏览器标题） |

## 目录结构

```
admin/
├── src/
│   ├── main.tsx                    入口（挂载 App + 全局样式）
│   ├── App.tsx                     路由表 + 两处全局接线（需要重登 / 出错弹提示）
│   ├── index.css                   Tailwind 入口 + 主题变量
│   ├── api/
│   │   ├── config.ts               ← 接口地址 / 超时 / 标题的唯一读取处
│   │   ├── http.ts                 请求层：拦截器 / 超时 / 包裹解包 / 错误归一 / 401 跳登录
│   │   ├── routes.ts               ⚠️ 生成物：接口路径表
│   │   ├── models.ts               ⚠️ 生成物：接口类型（服务端 DTO 的镜像）
│   │   ├── endpoints.ts            ⚠️ 生成物：接口方法（accountsApi/adminsApi/announcementsApi/auditApi/authApi/rolesApi/statsApi/systemApi）
│   │   ├── types.ts                手写：业务码 / 权限点 / 动作与目标的中文字典 / 时间工具
│   │   └── index.ts                统一出口（页面只从这里 import）
│   ├── pages/                      页面（见下表）
│   ├── components/                 Layout / Pagination / ConfirmDialog / ResetPasswordDialog / BanDialog / BanStatus / AnnouncementDialog / sortable / charts / ToastHost / ui
│   └── store/
│       ├── session.ts              令牌与管理员的读写（含订阅机制 + hasPermission）
│       └── toast.ts                全局提示（成功 / 失败）
├── index.html
└── .env.example · vite.config.ts · tsconfig.json · package.json
```

## 页面

| 页面 | 路由 | 需要的权限点 | 能做什么 |
| --- | --- | --- | --- |
| 登录 / 注册 | `/login` · `/register` | 无（公开） | 管理员登录；注册（首个注册者成为超管） |
| 概览 | `/` | `stats:read` | 账号 / 角色总量概览 |
| 账号管理 | `/accounts` | `account:read` | 分页检索（账号名模糊 + 状态）、封禁 / 解封、删除账号 |
| 账号详情 | `/accounts/:id` | `account:read` | 看名下角色、**重置玩家口令**、**踢下线**、清空该账号全部角色 |
| 角色管理 | `/roles` | `role:read` | 六维筛选（关键字 / 在线状态 / 职业 / 性别 / 等级区间 / 账号）、多选批量删除 |
| 角色详情 | `/roles/:id` | `role:read` | 改基础信息与常用数值；**装备 / 技能 / 背包结构化编辑**（清单以客户端配置为唯一真相） |
| 管理员 | `/admins` | `admin:read` | 看管理员列表；改角色 / 启停 / **重置密码** / 删除（写操作另需 `admin:manage`） |
| 公告 | `/announcements` | `announcement:read` | 发布 / 编辑 / 删除公告、启停、按关键字 / 级别 / 启停 / 生效状态筛选；**「生效中」用服务端返回的 `active` 列**（判据与玩家侧拉取接口同源，不靠本地时钟）（写操作另需 `announcement:write`） |
| 操作日志 | `/audit-logs` | `audit:read` | 7 项筛选（关键字 / 动作 / 目标类型 / 结果 / 起止时间 / 目标 id）+ 分页 + 展开看请求体 |
| 我的账号 | `/me` | **不需要权限点** | 看自己的身份 / 登录情况 / 权限点；**自助改密**（要验原密码） |

写操作会按权限点禁用按钮（`disabled`）并在表格上方提示「当前角色权限不足」；直接改地址栏硬闯，`RequirePermission` 外壳会就地给出「没有访问权限」而不是白屏。

## 权限模型

界面显隐**只是体验**，**服务端才是权威**。

- 权限点唯一来源在**服务端**（`server/src/common/constants/permission.ts`，15 个权限点 / 3 种角色）；管理端 `src/api/types.ts` 的 `PERMISSION` 是它的镜像，一一对应
- 管理员信息随令牌一起在响应里下发，落到 `store/session`；`hasPermission(点)` 直接查这份数组
- **脏会话兜底**：`admin.permissions` 缺失时按**空数组**处理（最小权限），不会因为会话不完整而放开界面
- 导航项带 `permission` 字段，`Layout` 过滤后再渲染；`App.tsx` 的 `RequirePermission` 外壳守住直达路由
- **加管理端接口时**：服务端 `@ApiAdminDoc({ permissions: [Permission.X] })`（漏了就是真放行），管理端再在 `types.ts` 里补权限点常量（生成物不含权限点字典）

## 口令管理的两个入口（别混）

| 入口 | 在哪 | 校验 | 结果 |
| --- | --- | --- | --- |
| **重置别人** | 账号详情页 / 管理员列表行内 | 不需要原密码（凭权限点） | 前端生成随机口令、**只显示一次**；对方此前签发的令牌**全部作废**，需要重新登录 |
| **改自己** | 「我的账号」页 | **要验原密码** | 服务端**下发新令牌**，前端覆盖本地会话 —— 否则改完立刻被自己踢回登录页 |

管理员列表里「重置密码」对自己那一行是禁用的（提示去「我的账号」）。`ResetPasswordDialog` 是两阶段弹窗：先确认，成功后把口令**显示一次**并支持复制。

## 相关文档

- [FAQ.md](FAQ.md) —— 启动、权限、页面与接口层的具体问题
- [../FAQ.md](../FAQ.md) —— 跨端机制（地址唯一来源、契约管线、三端联动、环境坑）
- [../README.md](../README.md) —— 项目总览、三端索引、目录结构
- [../server/README.md](../server/README.md) —— 这些接口的服务端
