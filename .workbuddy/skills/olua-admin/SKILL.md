---
name: olua-admin
description: olua 项目管理端（React 19 + TypeScript + Vite + Tailwind CSS v4，目录 admin/）的开发做法。核心心智模型：界面按权限显隐只是体验，服务端才是权威；接口路径 / 方法 / 实体类型全部由服务端 Swagger 文档生成，禁止手写。涵盖：api 目录的生成物与手写边界（routes routes.ts 路径表 / models.ts 类型 / endpoints.ts 接口方法 authApi accountsApi adminsApi rolesApi auditApi 都是生成物，config.ts http.ts types.ts index.ts 是手写）、地址唯一来源 admin/.env 的 VITE_API_BASE_URL（代码只读 src/api/config.ts）、请求唯一出口 http.ts（请求与响应拦截器 / AbortController 超时 / 统一包裹解包 / ApiError 归一 / ApiError.needRelogin 触发重新登录 / 错误观察者单槽位 / HttpOptions 的 auth 与 silent）、按权限渲染（api/types.ts 的 PERMISSION 与服务端一一对应 + store/session.hasPermission 脏会话兜底空数组即最小权限 + 导航项带 permission 过滤 + 写按钮 disabled + App.tsx 的 RequirePermission 外壳）、页面结构（Dashboard / Accounts / AccountDetail / Roles / RoleDetail / Admins / Audit / MyAccount / Login / Register）、口令管理（AccountDetailPage 的重置密码 + 踢下线、AdminsPage 的重置密码且对自己置灰、MyAccountPage 的自助改密必须用返回的新令牌覆盖会话）、操作日志页（筛选 + 分页 + 展开请求体、动作中文名走 api/types 的 AUDIT_ACTION_LABELS 字典而动作清单从接口拉）、重置口令弹窗 ResetPasswordDialog 的两阶段（确认时前端生成随机口令、成功后只显示一次）、会话变化订阅 subscribeSession 让顶部身份栏跟着刷新、角色运行时数据编辑（KeyValueEditor 编辑装备与技能、背包稀疏格子编辑器含清空背包、buildPatch 对结构化字段整体提交其余只提交改动项）、业务码与展示字典（BIZ_CODE RELOGIN_CODES ADMIN_ROLE_LABELS PERMISSION_LABELS AUDIT_ACTION_LABELS AUDIT_TARGET_LABELS OCCUPATION_LABELS SEX_LABELS ROLE_BAG_AXIS_MAX PASSWORD_MIN_LENGTH formatTime formatTimeFull msToLocalInput localInputToMs）、枚举字段必须收口（as XxxQuery 字段名）、生成类型必须是 type 不能是 interface、新增页面或接口的标准步骤、验证命令 npm run build 等于 tsc --noEmit 加 vite build、每处理完一个问题按功能提交一次代码。触发场景：用户说"改管理端页面""加一个管理端功能""后台要能改角色属性""加筛选条件""加批量操作""权限按钮不该显示""登录后跳转不对""管理端类型报错""新接口管理端调不到""按权限显隐菜单""后台重置密码""踢下线按钮""操作日志页""看谁改了什么""改自己的密码""管理端登录被锁"。
agent_created: true
---

# olua 管理端（React + Vite）：后台角色 / 账号 / 管理员

`admin/` 与 `server/`（NestJS）、客户端（Cocos 工程，在 `client/`）是**三个平级子工程**，各自有 README 与 FAQ；仓库根只放总 README / FAQ 与跨端 `tools/`。

```bash
cd admin
npm install
cp .env.example .env.development   # 首次：接口根地址在这里（VITE_API_BASE_URL）
npm run dev                        # 开发；npm run build 产出 dist（= tsc --noEmit && vite build）
```

## 一、两条必须记住的边界

1. **界面按权限显隐只是体验，服务端才是权威。** 即使按钮被强行点出来，请求也会被 `PermissionGuard` 拦成 `403` + `30006`。
2. **接口路径 / 方法 / 实体类型全部是生成物，禁止手写。** 改接口只改服务端，然后 `cd server && npm run gen:api`。

## 二、`src/api` 的分工（生成物 / 手写）

| 文件 | 来源 | 干什么 |
|---|---|---|
| `routes.ts` | **生成**（禁止手改） | 路径表 —— 唯一的接口路径来源 |
| `models.ts` | **生成** | 实体类型（服务端 DTO 的镜像） |
| `endpoints.ts` | **生成** | 接口方法：`authApi` / `accountsApi` / `adminsApi` / `rolesApi` / `auditApi` |
| `config.ts` | 手写 | 读 `VITE_API_BASE_URL` + `buildUrl` + `API_TIMEOUT`（地址唯一来源） |
| `http.ts` | 手写 | 请求唯一出口（见下） |
| `types.ts` | 手写 | **服务端文档里没有的东西**：`ApiEnvelope` / `PageResult<T>` / `ApiError` / `BIZ_CODE` / `RELOGIN_CODES` / `PERMISSION` / 权限点与审计动作的中文名字典 / 时间与输入框换算 |
| `index.ts` | 手写 | barrel —— **页面 import 统一走 `../api`**，换生成物时页面一行都不用改 |

守卫（在**仓库根**跑）：`node tools/audit-api-generated.cjs`（生成物逐字节一致 + 生成标记 + 路径只在路径表）、
`node tools/audit-api-hardcode.cjs`（地址 / 请求 / 路径的唯一来源，且**唯一来源文件必须带生成标记**）。

## 三、请求层口径（`http.ts`）

- 唯一出口；令牌注入在默认请求拦截器里（`auth: false` 的接口不带）。
- 超时用 `AbortController`；**统一包裹解包**：拿不到 `{code, message, data, timestamp}` 就说明这条链路不是后端给的（网关 502 之类），按业务异常处理。
- 失败统一归一成 `ApiError`（`code` / `status` / `needRelogin`）；页面只写一种 `catch`。
- `ApiError.needRelogin` → 调 `reloginHandler`（由入口接到路由跳转，**http 层不依赖路由**）。
- 错误观察者**单槽位**（重复注册即替换，避免组件重复挂载弹两次）；`silent: true` 时跳过全局提示。
- 业务侧可传的选项统一是 `HttpOptions`（`query` / `auth` / `silent`），**`path` / `method` / `body` 由生成的方法填好**。

```ts
await rolesApi.batchRemove({ ids });                  // body 是结构化对象
await accountsApi.updateStatus(id, { status: next }); // 不是裸值
await authApi.login({ username, password }, { silent: true }); // 表单自己就地展示错误
```

## 四、按权限渲染

- `api/types.ts` 的 `PERMISSION`（与服务端 `common/constants/permission.ts` **一一对应**，现 13 个：多出 `account:password` 重置玩家口令、`audit:read` 查操作日志与 `system:read` 看系统信息）；
- `store/session.hasPermission`（**脏会话兜底空数组 = 最小权限**）；
- 导航项带 `permission` 过滤；写操作用 `disabled`；`App.tsx` 用 `RequirePermission` 外壳包住页面；
- **不需要权限点的页面**（如「我的账号」）直接挂路由，不进 `NAV_ITEMS`（它是每个人的私有页，放顶部身份栏更顺手）；
- 新增需要权限的界面：先在服务端加权限点 → 同步 `PERMISSION` → 再在导航 / 按钮 / 外壳上引用。

## 五、页面

| 页面 | 干什么 |
|---|---|
| `LoginPage` / `RegisterPage` | 登录注册（注册需服务端 `ADMIN_REGISTER_CODE`；**第一个注册者自动是超管**） |
| `DashboardPage` | 概览统计（`stats:read`） |
| `AccountsPage` | 账号列表：分页 + 状态检索 + 封禁 / 解封 + 删除 |
| `AccountDetailPage` | 账号信息 + 名下角色概要 + **重置密码** + **踢下线** + **清空该账号全部角色** |
| `RolesPage` | 角色列表：**六维筛选**（关键字 / 账号 / 在线 / 职业 / 性别 / 等级区间）+ 多选 + 批量删除确认框（列出角色名）+「修订」列 |
| `RoleDetailPage` | 三块卡片：基础信息 / 常用数值 / **运行时数据**（`KeyValueEditor` 编辑装备与技能、背包稀疏格子编辑器含「清空背包」） |
| `AdminsPage` | 管理员列表与改角色 / 启停 / **重置密码**（自己那一行置灰）/ 删除（`admin:manage`） |
| `AuditPage` | **操作日志**：关键字（操作人 / 动作 / 目标 id / 路径）+ 动作下拉（清单从接口拉）+ 目标类型 + 结果 + 时间范围 + 目标 id → 分页表格，行可展开看请求体（`audit:read`） |
| `MyAccountPage` | **我的账号**：身份 / 权限点 / 自助改密（不需权限点，任何已登录管理员都能进） |

**口令管理的两个入口，别混**（详见 skill `olua-server` 的底座一节）：

- **重置别人的**（`AccountDetailPage` / `AdminsPage`）：弹 `ResetPasswordDialog` → 前端生成随机口令（只显示一次）→ 对方旧令牌当场全废，他需要重新登录。**「管理员列表」里对自己那一行要禁用**（改自己的密码走「我的账号」，那边会回新令牌续上会话）；
- **改自己的**（`MyAccountPage`）：验原密码 → `authApi.changePassword` → **必须 `saveSession(result.token, result.admin)` 覆盖本地令牌**，否则改完立刻被自己踢回登录页。成功后会 `emitSession`，顶部身份栏跟着刷新（`Layout` 里 `useEffect(() => subscribeSession(setAdmin), [])`）。

**`ResetPasswordDialog` 的两个阶段**：先给一个可「换一个」的随机口令 + 说明后果 → 确认后进「结果」阶段把口令**显示一次**并给复制按钮（服务端只存哈希，关掉就查不到了）。

**`AuditPage` 的两条约定**：
- 动作的中文名只是 `api/types.ts` 里的展示字典（`auditActionLabel`，未登记的原样显示标识符）；**动作清单从 `/admin/audit-logs/actions` 拉**，界面不写死；
- 时间范围用 `<input type="datetime-local">`（本地时间），提交前用 `localInputToMs` 换算；`min > max` 就地拦下不提交。

**`RoleDetailPage` 的两条约定**：
- 结构化字段（装备 / 技能 / 背包）**整体提交**；其余字段**只提交改动项**（`buildPatch`）；
- 装备与技能的键**按角色自己数据里已有的键渲染，不硬编码清单** —— 服务端不认识客户端配置，硬编码清单一定会漂移。

**筛选表单与查询分离**：表单状态与「已应用的查询」分开（`applied`），点「查询」才生效；刷新列表要**清空多选**。

## 六、必踩的坑

1. **生成的类型必须是 `type` 不是 `interface`**。`interface` 没有隐式索引签名，赋给请求层的 `Record<string, string | number | null | undefined>`（query 参数）会被 TS 拒。生成器已经统一产出 `export type X = { ... }`，别再手写回 interface。
2. **受控表单的枚举字段要收口**：下拉 / 输入框给的是字符串，赋值时写 `as XxxQuery["field"]` / `as XxxPatch["field"]`（非法值服务端也会拒，但类型层面必须过）。
3. **分页结果用 `PageResult<T>`**（与服务端 `XxxPageDto` 结构一致，可互相赋值）。
4. **业务码 / 权限点改动要同步**：服务端在 `server/src/common/constants/`，管理端在 `src/api/types.ts`，两边的值与文案要一起改（数字对不上就是静默失效）。
5. **`npm run build` 自带 `tsc --noEmit`**，所以「build 过了」就等于类型也过了；改完页面**必须跑一次**。
6. 页面里**不要出现路径字面量**（如 `"/admin/roles"`）——只允许调 `endpoints.ts` 里的方法。
7. **JSX 文本里写 `**加粗**` 会原样显示星号**：markdown 只在 `.md` 里生效，页面上要写成 `<strong>`。
8. **`ApiError.needRelogin` 判的是 `status === 401 || RELOGIN_CODES`** —— 所以新增的「令牌作废」码（`40103`）即使不加进 `RELOGIN_CODES` 也会回登录页（因为它就是 401）。加进去是为了让意图显式，别把它当唯一开关。
9. **改自己的密码不能用「重置密码」那套**：服务端会作废旧令牌，所以必须用返回的新令牌覆盖会话（`saveSession(result.token, result.admin)`）；否则请求一发完，下一次点击就把自己送回登录页。
10. **生成随机口令用 `crypto.getRandomValues`**，别用 `Math.random`；字符集去掉 `0/O`、`1/l/I` 这类念给玩家容易听错的字符（口令是要线下念的）。

## 七、加一个管理端功能的步骤

1. 服务端：写 DTO（含嵌套对象时用带装饰器的 DTO 类 + `@ValidateNested` + `@Type`）+ 控制器方法（`@ApiAdminDoc({ operationId, permissions })` + `@ApiQueryModel` / `@ApiDataResponse`）→ 必要时先在 `permission.ts` 加权限点。
2. `cd server && npm run gen:api` 重新产出文档与两端接口文件。
3. 管理端：`npx tsc --noEmit` 看报错，按生成的方法签名改调用点；新增页面走 `RequirePermission` 外壳 + `PERMISSION` 常量。
4. `npm run build` + 服务端 `npm run verify`。
5. 仓库根有 Makefile，等价目标：`make admin-build` / `make admin-typecheck` / `make gen-api` / `make verify`（全门禁）；`make help` 列全部。

## 八、提交纪律（强制）

**每处理完一个问题，就按功能提交一次代码 —— 不要攒着。**

- 一个功能一个 commit，**改完立刻提交**；不要把多个不相关改动混在一次提交里（这样「哪次改动引入了回归」永远能二分出来）。
- 提交前把该跑的验证跑绿（`npm run build` + 服务端 `npm run verify`），**全绿才提交**。
- 提交信息用 `feat|fix|refactor|docs|test|chore(端): 一句话说清做了什么`（`chore` 用于构建 / 工具 / 依赖），正文列关键改动与验证结果；管理端的端名取 `admin`。
- 涉及多端的同一功能拆成几个提交，顺序按依赖（服务端先，再 `admin` / `client`，最后 `docs`）。

```bash
cd /Users/tz/workspace/olua
git add admin && git commit -F - <<'EOF'
feat(admin): 操作日志查询页与我的账号自助改密

- AuditPage 7 项筛选 + 展开请求体；MyAccountPage 改密后用新令牌覆盖会话
- 验证：npm run build 通过（48 modules / gzip 101 kB）
EOF
```

## 九、相关

- 契约从哪来（`operationId` / 装饰器 / 生成器 / 守卫）：skill `olua-server` 的 `references/contract-pipeline.md`
- 服务端权限模型与接口写法：skill `olua-server`
- 客户端怎么消费同一份生成物：skill `olua-client`
