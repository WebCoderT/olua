---
name: olua-admin-ui
description: olua 管理端（admin/，React 19 + Tailwind 4 + Vite）的**视觉与版式规范**，以及「把存量页面改到规范上」的迁移做法。核心心智模型：同一类东西必须长得一样（页头 / 卡片 / 弹窗 / 字段标签只许各有一个来源），一屏能看完的不要让人滚，要改的才给控件（只读用纯文本而不是灰掉的输入框）。涵盖：token 表（色板只用 slate/indigo/emerald/amber/rose，圆角三档，字阶三档，全局紧凑档：Card 默认 dense px-3.5 py-2 / py-3、Button px-3 py-1.5、控件 px-2.5 py-1.5、表格 px-3 py-2）、两档版式（列表档 gap-4 / 详情档 gap-3 + dense + 一屏不滚）、PageHeader（标题 + 说明 + 右侧操作 + 返回链接，替代三十处手抄 h1）、FilterBar 筛选条（**条件块内部上下结构：标签在上、控件在下；若干块横向排成一行**，右侧 ml-auto 放查询/重置，宽度一律给 Field width —— 因为 Input 自带 w-full）、Card 与 dense（只压内边距、不动层次）、Modal 四档宽度（sm/md/lg/xl，不许页面自己传 max-w-*）、Notice 提示条（amber/red/slate/emerald 四色，替代各页自造的 amber 卡片）、Field 字段与标签（默认上下结构，替代裸 span 标签）、表格 tableClass 系列、Badge tone、EmptyState/Spinner、components/entity 那套可视化实体组件（EntityPicker/EquipSlots/LevelLadder/BagGrid/SkillList，装备与物品一律「用图挑」而不是输 id）、只看不改成三件事（去掉 input/select、用纯文本、服务端仍权威）、守点 tools/audit-admin-ui.cjs（页面里禁止手写 fixed 遮罩 / 裸 h1 / 自造卡片 / 裸 span 标签）、迁移手册（页头→PageHeader、弹窗→Modal、筛选区→FilterBar+Field、提示条→Notice、逐页核对）与验收命令（make admin-typecheck / admin-build / make audit + 真机 Chrome 逐路由截图量 scrollHeight）。触发场景：用户说"管理端风格统一""把页面风格改一下""照角色详情那套做""前端太乱""字体大小不一致""弹窗宽窄不一""两个页面长得不一样""抽个公共组件""页头统一""做成组件化""把这次改动做成技能""UI 规范""样式规范""设计系统""视觉规范""列表页和详情页版式""一屏看完""紧凑一点""筛选条件放一行""标签放输入框上面""只读展示""不要输入框"。注意：本技能只管**视觉与版式**，接口 / 权限 / 数据口径归 olua-admin。
agent_created: true
---

# 管理端视觉规范（`admin/src`）：同形、一屏、可复用

这份规范从 #562 的「角色详情可视化一屏版式」里提炼出来，再用 #564 铺到全站。
它不是美学意见，而是**能被脚本检查的约束** —— 每条「不许」都对应守点脚本里的一条规则。

```bash
cd admin
npm run dev            # 开发（接口根地址在 .env.development）
npm run build          # = tsc --noEmit && vite build（等于 make admin-build）
cd .. && make audit    # 跨端审计，含 tools/audit-admin-ui.cjs
```

## 零、三条原则（其余都是它的推论）

1. **同一类东西只有一个来源。** 页头、卡片、弹窗、字段标签，全站各只有一处实现。
   页面里出现第二份「长得差不多」的拷贝，就是下一次不一致的起点。
2. **一屏能看完的不要让人滚。** 先问「这一屏要回答什么问题」，再决定哪些内容进弹窗。
   滚动的代价不是操作次数，而是**对照关系丢失**（上下两段数值看不到彼此）。
3. **要改的才给控件。** 只读字段用纯文本，不要用 `disabled` 的输入框 ——
   灰输入框看起来像「你没权限」，会让人去找解锁开关；纯文本才是「这里本来就不改」。

## 一、token：只用下面这些，页面里不许新造

色板、圆角、字阶全部落在 `components/ui.tsx` 与 `index.css` 里，页面只消费。

| 用途 | 类名 | 备注 |
|---|---|---|
| 页面底 | `#020617` | `index.css` 的 `body`，页面不写背景 |
| 卡片外壳 | `rounded-2xl border border-slate-800 bg-slate-900/40 shadow-lg shadow-black/20` | `Card` 内置 |
| 卡片头 / 身 | `px-3.5 py-2` / `px-3.5 py-3` | `Card` **默认 `dense`**（全局紧凑）；`dense={false}` 回到 `px-5 py-4` / `p-5` |
| 分隔线 | `border-slate-800` | 表格行内 `border-slate-800/60` |
| 页头标题 | `text-lg font-semibold text-slate-50` | 只由 `PageHeader` 产出 |
| 页头说明 | `mt-0.5 text-xs text-slate-500` | ≤ 2 行；再长就写进卡片 `description` |
| 卡片标题 / 说明 | `text-sm font-semibold text-slate-100` / `mt-1 text-xs text-slate-500` | `Card` 内置 |
| 字段标签 | `text-xs font-medium text-slate-400` | `Field` 内置 |
| 正文 / 次要 | `text-sm text-slate-300` / `text-xs text-slate-500` | |
| 链接 | `text-indigo-300 hover:text-indigo-200` | 表格里的行内跳转 |
| 主色 | `indigo-500` | 主按钮、聚焦环、选中态 |
| 语义色 | `emerald` 成功 / `amber` 注意 / `rose` 危险 | 只经 `Badge`、`Notice` |
| 圆角 | 卡片 `2xl`、控件 `lg`、徽标 `md`、提示条 `xl` | 不许出现 `rounded-3xl` / `rounded-none` |
| 字阶 | `text-lg` / `text-sm` / `text-xs` | 密集详情可加 `text-[10px]`，**不许多出第四档** |
| 间距 | 页面块间 `gap-4`（详情档 `gap-3`）；表单栅格 `gap-3` / `gap-4` | |
| 控件内边距 | `Button` `px-3 py-1.5`；`Input` / `Select` `px-2.5 py-1.5` | 全局紧凑的唯一来源 |
| 表格单元格 | `px-3 py-2` | `thClass` / `tdClass` 内置 |

**不许**：写 `bg-white` / `text-black` / `slate-100` 当标题色（那是 `slate-50`）、
`text-base` 当卡片标题、`py-6` 这种非档位内边距。深色主题只有一个，不做明暗切换。

## 二、版式两档：先选档，再排内容

### 列表档（默认，绝大多数页面）

```tsx
<div className="flex flex-col gap-4">
  <PageHeader title="角色管理" description="…" actions={<Button …/>} />
  <FilterBar loading={loading} onSearch={submitSearch} onReset={resetSearch}>…</FilterBar>
  <Card title="角色列表（N）" actions={…}>
    <div className="overflow-x-auto"><table className={tableClass}>…</table></div>
    <EmptyState … />
    <Pagination … />
  </Card>
</div>
```

列表页也走全局紧凑档（`Card` 默认 `dense`、表格 `px-3 py-2`）：后台最常见的动作是「扫一遍列表」，
多出来的内边距只会让人多滚两次。**紧凑不等于挤** —— 层次靠标题栏与分隔线，不靠空白。

### 详情档（详情 / 工作台，目标「一屏不滚」）

```tsx
<div className="flex flex-col gap-3">
  <PageHeader back={{ to: "/roles" }} title={…} description={…} actions={…} />
  <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(340px,420px)_minmax(0,1fr)]">
    <Card dense title="角色" description="只读：…">…</Card>
    <Card dense title="装备">…</Card>
  </div>
</div>
```

判据是**实测**：`main.scrollHeight === main.clientHeight`（1440×900 与 1280×800 两档都要成立）。
省高度只有三个杠杆，别乱试：

1. `Card dense`（只压内边距 —— 四张卡的内边距比内容更吃高度）；
2. 空态压扁（13 个装备槽里常有 11 个空着，别用大卡占四行）；
3. 大块内容进弹窗（背包网格、技能列表、原始 JSON）。

窄栏里**不要用多列表格**：`text-sm` 的三列表头在 380px 会被折成「服务端重 / 算」，数值区间
`406 ~ 550` 也会折行，一折行每行变两三行高。窄栏用**竖排列表**（一行一个属性，值靠右）。

## 三、组件映射：要什么用什么

| 场景 | 用什么 | 关键 props |
|---|---|---|
| 页面标题区 | `PageHeader` | `title`（可塞 `Badge`）/ `description` / `actions` / `back` |
| 筛选条件 | `FilterBar` + `Field` | `onSearch` / `onReset` / `extra` / `hint`；宽度给 `Field width` |
| 内容分组 | `Card` | `title` / `description` / `actions` / `dense` |
| 字段 | `Field` | `label` / `hint` / `width` / `inline`（**默认上下结构**，标签不许自己写 `<span>`） |
| 1~3 个数字概览 | `StatCard` | `label` / `value` / `hint` |
| 表格 | `tableClass` / `theadClass` / `thClass` / `tdClass` | 拼接，不新写 |
| 排序列头 | `SortableTh` | `field` / `sort` / `order` / `onToggle` |
| 分页 | `Pagination` | 服务端分页，`10/20/50/100` |
| 状态徽标 | `Badge` | `tone`: `green`/`red`/`slate`/`indigo`/`amber` |
| 提示 / 警告条 | `Notice` | `tone`: `amber`/`red`/`slate`/`emerald` |
| 空态 | `EmptyState` | `title` / `description`，别用「加载中」的样式冒充 |
| 加载 | `Spinner` | 行内 `h-4 w-4`；整块加载居中 `py-16` |
| 任意内容弹窗 | `Modal` | `size`: `sm`/`md`/`lg`/`xl`，`footer`，Esc 与遮罩关闭 |
| 确认危险操作 | `ConfirmDialog` | `confirmText` 写明动作（「确认删除」而非「确定」） |
| 挑一个游戏实体 | `EntityPicker` | 见第八节 |
| 页面级提示 | `toastSuccess` / `toastError` | 不要自己 setState 一个横幅 |

### 筛选条：块内上下结构，整组一行

```tsx
<FilterBar loading={loading} onSearch={submitSearch} onReset={resetSearch}
  extra={<Button onClick={openCreate}>新建</Button>}>
  <Field label="角色名 / id" width="w-48"><Input … aria-label="角色名或 id" /></Field>
  <Field label="在线" width="w-24"><Select …>…</Select></Field>
  <Field label="最低等级" width="w-24"><Input type="number" … /></Field>
  <Field label="最高等级" width="w-24"><Input type="number" … /></Field>
</FilterBar>
```

四条约束（这里是**用户明确纠正过**的地方，别再改回去）：

1. **块内是上下结构**：标签一行、控件一行。标签左置（`Field inline`）会让标签吃掉控件宽度，
   输入框反而更窄；标签一长整条就换行 —— 「一行」是靠**块本身窄 + 块排成一行**实现的。
2. **整组排成一行**：条件块 `flex-wrap`，右侧 `ml-auto` 放「新建 / 查询 / 重置」。
   判据：1440 宽下角色管理页 6 个条件 + 查询/重置不折行（实测 `FilterBar` 高度 < 80px）。
3. **宽度只给 `Field width`**：`Input` / `Select` 自带 `w-full`，控件上再写 `w-*` 是同属性冲突。
   短枚举 `w-20`~`w-24`、文本搜索 `w-40`~`w-56`。
4. **区间拆两个字段**：「最低等级 / 最高等级」两个块，不要一个块里塞两个框 + 一个「~」。

筛选条不放说明文字（除了 `hint` 那种「当前只显示某账号的角色」）；筛选逻辑的解释归页头 `description`。

## 四、`PageHeader`：三十个页面只有一个页头

```tsx
<PageHeader
  title="角色管理"                        // ReactNode：可塞 <Badge> 和编号
  description="关键字同时匹配角色名与角色 id；…"  // 这页为什么长这样 / 有什么坑
  actions={<Button onClick={submit}>查询</Button>} // 右侧操作，自动 flex-wrap
  back={{ to: "/roles", label: "角色列表" }}       // 详情页才有
/>
```

规矩：

- **标题只有 `text-lg` 一档**。列表页用 `text-xl`、详情页用 `text-base` 都会让切换页面时「字在跳」。
- **说明写「为什么 / 边界」，不写「这里可以改什么」**（后者界面自己会说）。
- **操作放右侧**，主操作（新建 / 查询 / 保存）在最右；页头不放危险操作（删除归行内或底部条）。

## 五、弹窗：`Modal` 四档，不许页面自定宽度

| 档 | 宽度 | 用在哪 |
|---|---|---|
| `sm` | `max-w-md` | 确认、单字段、重置口令 |
| `md` | `max-w-2xl` | 普通编辑表单（物品 / 药品 / 时装 / NPC） |
| `lg` | `max-w-3xl` | 长表单、列表型编辑（技能 / 状态 / 任务 / 掉落） |
| `xl` | `max-w-5xl` | 表格型工作台（装备对齐） |

行为由 `Modal` 统一提供：Esc 关闭、点遮罩关闭、内容区独立滚动、footer 固定、`role="dialog"`。
**页面里不许再出现 `fixed inset-0 z-…`** —— 那样每多一个弹窗，就多一套「宽度 / 内边距 / 关不关得上」的差异。

弹窗里的表单仍用 `Field`；底部按钮顺序固定：右起「保存类」→「取消」。

## 六、表格与列表

- 列头 `theadClass`（`text-xs uppercase tracking-wide text-slate-500`），行 `hover:bg-slate-800/30`。
- 操作列固定在最右、`text-right`，按钮 `px-2.5 py-1 text-xs`。
- 第一列放**能认出来的东西**（图 / 名字 + id 小字），不要第一列就是 id。
- 一列里塞两种信息用「主 + 次」两行（`font-medium text-slate-100` + `mt-0.5 text-xs text-slate-500`），
  不要用 `·` 连成一句长串。

## 七、只读 vs 可编辑

| 情况 | 做法 |
|---|---|
| 这一页整体只读（没权限） | 卡片 `description` 写明「没有 X 权限，只读」，控件不渲染（或整块纯文本） |
| 某一段只读（如派生属性） | 纯文本；断言这段里 `input/select` 数量 = 0 |
| 可改 | 控件只出现在可改的那张卡，保存条只在有改动时出现 |
| 服务端会拒 | 界面之外仍要在文案里说清「服务端同样会拒绝」 |

**灰掉的输入框只用于「暂时不能改，但改了就会生效」**（比如没选前置项）；永久只读一律纯文本。

## 八、可视化实体（`components/entity/`）

装备 / 物品 / 技能 / 地图 / 时装 / 称号 / 战魂 / 军衔一律**用图挑**，不输入 id。
唯一数据来源是 `api/gameData.ts`（客户端配置的生成物），页面与组件都不许自带一份字典。

```tsx
<EntityPicker open={open} title="选择装备" options={entityOptions("equipment")}
  current={id} onSelect={setId} onClose={…} />
```

分层：`catalog`（目录与查表）→ `EntityImage`（单图 / 图集首帧 / 空值虚线方块）→
`EntityCard` → `EntityPickerList`（无壳）/ `EntityPicker`（`Modal` 壳）→
业务 `EquipSlots` / `LevelLadder` / `SkillList` / `BagGrid`。

两条必须守的细节：

- **空值画虚线方块，不画「无图」占位** —— 后者看起来像资源缺失。
- **选择器里文字必须能分辨同名项**：15 个装备变体在总表里同名，label 要取带前后缀的显示名，
  note 补「部位 · 等级」。

## 九、禁用清单（= `tools/audit-admin-ui.cjs` 的规则）

页面（`admin/src/pages/**`）里不许出现：

1. `fixed inset-0 z-` —— 弹窗一律走 `Modal`；
2. `<h1 className=` —— 页头一律走 `PageHeader`；
3. `rounded-2xl border border-slate-800 bg-slate-900/40` —— 卡片一律走 `Card`；
4. `<span className="mb-1.5 block text-xs font-medium text-slate-400">` —— 字段标签一律走 `Field`；
5. `text-xl` / `text-2xl` 当页面标题、`bg-white`、`text-black`。

`components/**` 里同样不许 1~4（`Modal` / `Card` / `PageHeader` 自己是唯一实现）。
组件内部要写这些 class 是正当的 —— 但那就等于又造了一份，改之前先问「能不能复用」。

## 十、迁移手册（存量页面怎么改到规范上）

按这个顺序做，每一步都能独立验证，不要一口气改完再跑类型检查。

1. **页头**：`<div><h1 …/><p …/></div>` → `<PageHeader title description actions back />`。
   顺手统一容器 `gap-4`（详情页 `gap-3`）。注意四个例外：`LoginPage` / `RegisterPage` 是登录壳、
   `GuildsPage` 原来是 `text-xl`、`SystemPage` 是 `text-slate-100` —— 一律回到 `text-lg`/`text-slate-50`。
2. **弹窗**：手写 `fixed inset-0` 外壳 → `Modal`。把 `<div className="max-h-[90vh] …overflow-y-auto">`
   里的内容整段搬进 `<Modal>` 的 children，标题与说明搬进 `title` / `hint`，底部按钮搬进 `footer`。
   **顺手补上 Esc 与遮罩关闭** —— 手写弹窗经常只有「取消」一条路。
3. **提示条**：自造的 `border-amber-500/40 bg-amber-500/10` 块 → `Notice tone="amber"`。
4. **字段标签**：裸 `<span className="mb-1.5 block text-xs font-medium text-slate-400">` → `<Field label>`。
5. **筛选区**：整块换成 `<FilterBar onSearch onReset extra>`，条件用 `<Field label width>`（上下结构）；
   容器对齐 `items-end`（块底对齐），「查询」在主按钮位，「重置」用 `outline`。
6. **表格**：确认用了 `tableClass` 系列、操作列在最右、第一列是「认得出的东西」。

## 十一、验收：眼睛 + 脚本，缺一不可

```bash
make admin-typecheck      # tsc --noEmit
make admin-build          # 构建（含 tsc）
make audit                # 跨端审计（含 audit-admin-ui）
```

真机检查用 playwright-core + 真实 Chrome（`headless: false` 才能验自适应）：

```js
const b = await chromium.launch({ headless: false, channel: "chrome" });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
// 登录态：localStorage 的 olua.admin.token / olua.admin.profile
```

逐页要看的四件事：

1. `main.scrollHeight === main.clientHeight`（详情档必须） / 列表页不横向溢出；
2. `pageerror` 为 0；
3. 页头字号与间距**在所有页面一致**（对比截图，`text-lg` vs `text-xl` 一眼就能看出来）；
4. 弹窗宽度只有四档（量 `getBoundingClientRect().width`）。

**别只信截图**：截图看不出「点了保存没落库」。写操作要读服务端确认，再按备份还原。

## 十二、踩过的坑

- **`Input` / `Select` 自带 `w-full`**：页面上再写 `w-11` 是同一属性的冲突，谁生效看 CSS 生成顺序。
  实测把 `flex-1` 的技能卡挤成 10px 宽、文字全被 truncate。**宽度只能给外层定容器的 `div` / `Field width`。**
- **筛选条「一行」不等于「标签与控件同一行」**：把 `Field` 写成 `inline` 后，标签吃掉宽度、
  6 个条件在 1440 下折成两行；正确做法是块内上下、块排一行。同理 `w-56` 套 `w-56`
  的双层定宽会把控件压窄 —— 宽度只许给一层（`Field width`）。
- **`overflow-y-auto` 不生效**：父级 `flex-1` 但自身没有 `h-full` 时，子项按内容撑高，滚动永不触发
  （表现为「列表长出去把底部按钮压走」）。
- **窄栏用表格 = 白长一倍**：三列表头在 380px 折行，10 行吃掉 300px；同宽度用竖排列表只要一半。
- **`sticky bottom-0` 的保存条会压住最后一行内容**（页面上永远差一点看不到）。要么预留 `pb`，
  要么不用 sticky。
- **`disabled` 输入框 ≠ 只读**：前者暗示「有开关能解锁」，后者才是「这里不改」。
- **弹窗里再放 `Card`**：双层圆角+边框，看着像套娃。弹窗内部用分隔线（`border-t border-slate-800`）分组。
