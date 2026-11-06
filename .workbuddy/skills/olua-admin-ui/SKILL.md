---
name: olua-admin-ui
description: olua 管理端（admin/，React 19 + Tailwind 4 + Vite）的**视觉与版式规范**，以及「把存量页面改到规范上」的迁移做法。核心心智模型：同一类东西必须长得一样（页头 / 卡片 / 弹窗 / 字段标签只许各有一个来源），一屏能看完的不要让人滚，要改的才给控件（只读用纯文本而不是灰掉的输入框）。涵盖：token 表（色板只用 slate/indigo/emerald/amber/rose，圆角三档，字阶三档，全局紧凑档：Card 默认 dense px-3.5 py-2 / py-3、Button px-3 py-1.5、控件 px-2.5 py-1.5、表格 px-3 py-2）、两档版式（列表档 gap-4 / 详情档 gap-3 + dense + 一屏不滚）、PageHeader（标题 + 说明 + 右侧操作 + 返回链接，替代三十处手抄 h1）、FilterBar 筛选条（**条件块内部上下结构：标签在上、控件在下；若干块横向排成一行**，右侧 ml-auto 放查询/重置，宽度一律给 Field width —— 因为 Input 自带 w-full）、Card 与 dense（只压内边距、不动层次）、Modal 四档宽度（sm/md/lg/xl，不许页面自己传 max-w-*）、Notice 提示条（amber/red/slate/emerald 四色，替代各页自造的 amber 卡片）、Field 字段与标签（默认上下结构，替代裸 span 标签）、表格 tableClass 系列、Badge tone、EmptyState/Spinner、components/entity 那套可视化实体组件（EntityPicker/EquipSlots/LevelLadder/BagGrid/SkillList，装备与物品一律「用图挑」而不是输 id）、素材预览组件（GameFrame 首帧 / FrameAnimation plist 全帧循环：文档序播放、空帧阈值与客户端同值、共享 rAF、路径缓存，一律走 /game-resources 同源）、只看不改成三件事（去掉 input/select、用纯文本、服务端仍权威）、守点 tools/audit-admin-ui.cjs（页面里禁止手写 fixed 遮罩 / 裸 h1 / 自造卡片 / 裸 span 标签）、迁移手册（页头→PageHeader、弹窗→Modal、筛选区→FilterBar+Field、提示条→Notice、逐页核对）与验收命令（make admin-typecheck / admin-build / make audit + 真机 Chrome 逐路由截图量 scrollHeight）。触发场景：用户说"管理端风格统一""把页面风格改一下""照角色详情那套做""前端太乱""字体大小不一致""弹窗宽窄不一""两个页面长得不一样""抽个公共组件""页头统一""做成组件化""把这次改动做成技能""UI 规范""样式规范""设计系统""视觉规范""列表页和详情页版式""一屏看完""紧凑一点""筛选条件放一行""标签放输入框上面""只读展示""不要输入框"。注意：本技能只管**视觉与版式**，接口 / 权限 / 数据口径归 olua-admin。
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
| 看一眼素材 / 图集首帧 | `GameFrame` | `src`（走 `gameResUrl`）/ `ext`；带 `Lightbox` 可放大 |
| 看**动起来**的图集 | `FrameAnimation` | 全帧循环播放，帧率与客户端同档（见第八点五节） |
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

**按钮必须进 `footer`，不许写在 children 末尾** —— children 是滚动区，长表单一滚按钮就跟着滚走，
表现为「弹窗里找不到保存」。共用表单的 `FormFooter`（`components/form-bits.tsx`）直接塞进 `footer`。
标题过长时「关闭」不许被挤成竖排两个字（`Modal` 里已 `shrink-0 whitespace-nowrap`）。

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

## 八点五、素材预览：同源直读，播放口径必须与客户端一致（#732）

`components/GameImage.tsx` + `components/FrameAnimation.tsx` 是**唯一**的素材读取层，页面与业务组件
都不许自己拼 `/game-resources/...` 路径或自己 `new Image()`：

- **同源**：生产走管理端 nginx 的 `/game-resources/` 反代 game 容器，开发走 `vite.config.ts` 的
  `gameResources()` 中间件 —— **同一个 URL 前缀**，页面里不写环境分支。`fetch` 也只能出现在
  审计白名单那几个文件里（`equipAlign/assets.ts` / `pages/audioSettings/assets.ts` 等）。
- **首帧 vs 全帧**：`GameFrame` 用 `loadFirstFrame`（按名字排序取第一个非空帧，用于列表 / 选择器）；
  装备边框、详情背景这类**动画素材**要看动起来的效果 → `FrameAnimation` 解析 plist 全部帧并按
  **文档序**播放。Cocos 的 `SpriteAtlas.getSpriteFrames()` 就是这个顺序，客户端也不重排，
  所以「页面上看到的顺序 = 游戏里的顺序」；帧名里的 `_0000` 序号是保证这一点的手段。
- **空帧过滤阈值与客户端同值**（`BLANK_FRAME_MAX_AREA = 4`）：1×1 这类占位空图不过滤会夹空白闪帧，
  看起来像「动画卡了一下」。
- **一屏多个播放器不各起一条 `requestAnimationFrame`**：模块级一个共享节拍器，组件挂载订阅、
  卸载退订，最后一个退订时停表；素材（plist 解析 + 图片解码）按路径缓存，翻页来回不打网络。
- **trim 偏移按 `spriteSourceSize` 摆**，画布取全帧最大原始尺寸 —— 裁剪过的帧不会左右抖。

## 八点六、清单型候选：别名 / 分组直接当 label / group（#749）

运营自己维护的清单（`border_items` / `background_items`）没有游戏数据表可查，但它的
`name` / `group` 本来就是管理端属性 —— `catalog.appearanceOptions(kind, items)` 直接把清单条目
映射成 `EntityOption`：**id = key**（客户端只认它）、**label = 别名 || key**、**group = 分组**
（缺省给「未分组」，否则分组 chips 会漏掉这些条目）、**note = `key · 分组`**、检索串含三者。

三个开关，都是为「图本身就是内容」开的，缺省不动其他页面：

- `image.animate = true` → `EntityImage` 走 `FrameAnimation`（边框光效 / 背景流动看首帧判断不了）；
- `EntityPicker` / `EntityPickerList` 的 `imageSize`（默认 32，这类给 56）；
- 棋盘格 / 表单字段用「预览 + 别名 + key」的**整块按钮**，不用 `<Select>`：84 条 key 的下拉
  等于让人背编号，而且 `<Select>` 里放不了图。

反向的一条：**引用已不在清单里时照实显示 key 并标黄**（清单页「从文件夹同步」会连被引用的
素材一起删）—— 客户端对坏 key 是安静跳过，界面装作没事就等于把「哪个品质没边框」藏起来了。

## 九、禁用清单（= `tools/audit-admin-ui.cjs` 的规则）

页面（`admin/src/pages/**`）里不许出现：

1. `fixed inset-0 z-` —— 弹窗一律走 `Modal`；
2. `<h1 className=` —— 页头一律走 `PageHeader`；
3. `rounded-2xl border border-slate-800 bg-slate-900/40` —— 卡片一律走 `Card`；
4. `<span className="mb-1.5 block text-xs font-medium text-slate-400">` —— 字段标签一律走 `Field`；
5. `text-xl` / `text-2xl` 当页面标题、`bg-white`、`text-black`。

`components/**` 里**至少不许 1**（手写遮罩）—— 脚本就是这么跑的：页面查 1~4，组件查 1，
白名单只有 `Modal.tsx`（遮罩的唯一实现）与 `GameImage.tsx`（`z-[100]` 全屏看图，不是表单弹窗）。

为什么组件也要查：五个共用弹窗（封禁 / 重置口令 / 补录邮箱 / 公告 / 养成配置 / 成长列表）曾经**全部**
绕开 `Modal` —— 页面里守住了、组件里漏了，用户看到的是「有的弹窗能按 Esc，有的不能、宽度也不一样」。
共用弹窗是最容易漏的一类，因为写它的人不在 `pages/` 里看。

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
- **「宽度给外层」这条对组件库同样成立**：`AttributesEditor` 里写 `<Input className="w-20">` 时，
  八项属性的标签被压成「物\n攻」竖排、输入框宽度也不受控 —— 改成 `<div className="w-20"><Input/></div>`
  才稳定。扫法：`<Input|Select className="…w-*…">` 一律是可疑点。
- **迁移脚本会把 markdown 的 `**粗体**` 原样搬进 JSX 文本**：用户看到的是字面星号。
  改成 `<strong className="text-slate-400">`，或者删掉强调。
- **页头说明一旦超过两行，右侧动作会换到第二行**：`PageHeader` 里给动作区补了 `ml-auto`（换行后仍贴右），
  但根治办法是把说明压到一行 —— 说明是「为什么 / 边界」，不是规格书。
