---
name: cocos-ui-layout-config
description: Cocos Creator 3.x 游戏项目里「把散落的可配置项收敛进 configs」的重构做法：UI 位置/尺寸/图片地址的单一入口 barrel（hudLayout.ts）+ 按区域拆分的 configs/layout/*.ts（hud/dialogs/panels/scenes/images/sizes/theme）、面向玩家的文案集中到 configs/texts.ts（key + {占位符} 模板 + getText/TextRef）、颜色/时长/可调数值各自归域、组件层禁止出现绝对坐标与图片路径的判定口径、旧名重命名不带别名以便 tsc 暴露漏改、配置文件的依赖方向（不许 import ui/）、零件隐式默认值搬进配置、搬迁后的死导入清理与 .meta 补齐，以及「配置外泄审计」脚本 + 例外清单 + 文案 key 覆盖反向检查的完整验收闭环。触发场景：用户说"位置尺寸图片地址散落在各个文件/需要统一管理"、"把所有可配置文件集中到 configs"、"核心代码只做代码运行，其他配置全部走 configs"、"UI 常量集中到配置文件"、"文案硬编码要抽出来"、"颜色/时长/阈值写死在代码里"、"新建 layout/文案配置文件"、"把写死的坐标/图片路径抽出来"、"调整界面不用翻组件"、"配置外泄/配置审计"。
agent_created: true
---

# 把散落的 UI 位置/尺寸/图片地址收敛成统一配置（Cocos Creator 3.x 项目）

适用场景：项目里 UI 常量散落——每个弹窗组件顶部一堆 `XXX_POSITION / XXX_SIZE`、各种 `new Vec2(...)` 直接写在
组件里、图片路径以字符串字面量写在各处（`"common/popup-bg"`、`"create_role/bg_dialog"`），
改一个界面要翻好几个文件。目标 = **一处可手改的配置 + 组件只引用**。

## 一、目标结构（本项目已验证的形态）

```
configs/hudLayout.ts          ← 唯一入口（barrel，只做 export *，不写内容）
configs/layout/
  hud.ts       常驻 HUD（角色信息栏 / 底部栏 / 小地图 / 怪物信息面板 / 屏幕提示 / 角色身上挂件）
  dialogs.ts   各类弹窗（通用弹窗框 dialogFrame + 每个弹窗一块 + 物品详情）
  panels.ts    某个大弹窗内部的子面板（装备槽分组 / 背包网格 / 属性列表 / 内观）
  scenes.ts    场景界面（登录 / 选角 / 加载）
  images.ts    取图函数 + 具名图片表（uiImages）
  sizes.ts     跨界面公共尺寸与字号（uiSize）
```

关键决策：**保留原入口文件名做 barrel**，内容搬到子目录。这样所有既有
`import { xxx } from "configs/hudLayout"` **一行都不用改**，重构风险从「全项目改 import」降到
「只改新增引用 + 组件内取值方式」。

```ts
// configs/hudLayout.ts —— 只放导出与说明
export * from "./layout/hud";
export * from "./layout/dialogs";
export * from "./layout/panels";
export * from "./layout/scenes";
export * from "./layout/images";
export * from "./layout/sizes";
```

分层口径（先和用户确认到哪一层，否则容易过度重构）：

| 层 | 内容 | 放哪 |
|---|---|---|
| 界面级 | 弹窗尺寸、各栏/子件坐标、行内间距、场景界面元素 | `configs/layout/*` |
| 图片/字体地址 | 所有资源路径（含零件内部用图） | `layout/images.ts` 的 `uiImages` |
| 公共尺寸 | 按钮大小/字号等跨界面复用 | `layout/sizes.ts` 的 `uiSize` |
| **零件内部微偏移** | 某 label 内缩 8px、某图标下移 3px、飘字偏移 | **留在 helper**（不进配置，否则配置变垃圾桶） |
| 玩法数学 | 碰撞盒尺寸、速度向量、AI 方向、寻路点 | 留在逻辑代码 |

## 二、判定口径：组件层还剩哪些「字面量」算违规

重构后自查命令：

```bash
grep -rn --include="*.ts" -e "new Vec2(" -e "new Size(" assets/ui/components assets/ui/*.ts
# 图片路径残留：按 resources 下的**目录名前缀**逐个扫，比写一条大正则可靠（见坑 7）
grep -rn -e '"common/' -e '"main/' -e '"money/' -e '"buttons/' -e '"login/' \
        -e '"loading/' -e '"create_role/' -e '"effect/' -e '"avatars/' \
        -e '"bottom-nav-bar/' -e '"small-map/' -e '"tips/' -e '"fonts/' -e '"logo"' assets/ui
```

**允许保留**的两类：
1. **由配置派生的计算**：`layout.currencyBar.size.width / CURRENCY_COUNT`、`new Vec2(0, layout.content.top)`；
2. **玩法数学**：`boxCollider.size = new Size(40, 70)`、速度/方向向量。

**必须搬走**的：凡是「传给零件的绝对坐标/尺寸」和「图片路径字符串」。
剩下的命中应该只有**注释里的样例路径**与**节点名**（如 `createSprite("logo", uiImages.gameLogo, ...)` 的第一个参数是节点名，不是图片地址）。

## 三、七个必踩的坑

1. **改名不带别名**：`hudImages → uiImages`、`hudSize → uiSize` 时**故意不留旧名 alias**。
   留了别名，漏改的引用不会报错，等于把错误藏起来；不留别名，`tsc` 会一次性把所有引用点列出来。
   本次改名的文件：GameUiHelper + 5 个 hud 组件（AutoBattleTips / AutoFightButton / RoleInfoBar / RoleMpOrb / SmallMap）。
   ⚠️ `export *` 下**重名会直接编译报错**（Module has already exported a member named ...），所以别同时保留 `hudSize` 和新的 `size`。
2. **配置文件的依赖方向**：`configs/layout/*` 只许 `import { Size, Vec2, Color } from "cc"` 与同目录其他 layout 文件，
   **不许 import ui/**（项目约定「configs/types 不依赖 UI」会被打破）。
   需要 UI 侧类型时（如 `EquipmentSlotSide = "left"|"right"|"bottom"`）在配置里写字面量联合：
   ```ts
   sides: ["left", "right", "bottom"] as ("left" | "right" | "bottom")[],
   ```
   组件侧再 `export const SIDES: EquipmentSlotSide[] = layout.sides;`（结构相同可直接赋值，不用 as unknown）。
3. **零件隐式默认值也要搬**：弹窗尺寸常被写成函数默认参数（`createDialog(..., size = new Size(600,500))`），
   于是调用方「不传参」就依赖了一个看不见的值。搬成 `size: Size = dialogFrame.size` 后，
   这个缺省值出现在配置里，可手调、可 review。同理 `applyRoleAttributeListStyle(..., position = new Vec2(217,205))`
   这类「默认值 + 组件里同值常量」的**双份定义**要合并成配置里的一份。
4. **搬走常量后的死导入**：组件里原来的 `import { Size, Vec2, Color } from "cc"` 往往只剩一两个符号在用，
   必须跑一遍 unused 检查（`tsc -p tsconfig.unused.json`）清掉，否则遗留报错。本次清了 5 处
   （RoleInfoDialog 的 Size/Vec2、WarSoulDialog 的 Size、RoleSelector 的 Size、GameUiHelper 的 math/deathDialogLayout）。
5. **新增目录/文件必须补 `.meta`**（目录用 `importer: "directory"`，ts 用 `importer: "typescript"`，
   `ver` 照抄同目录既有文件），否则 Cocos 编辑器不会导入、运行时报找不到模块。
6. **编辑器回写风险照旧**：改完必须 `grep` 核对磁盘 + `sleep 20` 后第二轮 tsc 复检
   （本项目编辑器会周期性回写覆盖外部修改）。
7. **收尾必做一遍「按资源目录前缀」的图片路径全扫**：只按 `new Vec2/new Size` 统计会漏掉
   「图片路径写在函数第 2 个参数」的调用。本次就漏了一条：
   `GameUiHelper.createGoodDetailDialog` 里 `createSprite("logo", "logo", new Vec2(), new Size(220,120))`
   —— 该处没写 `new Size(...)` 之外的东西，位置也不显眼，grep `"common/` 之类都扫不到（图在 resources 根目录，
   路径就是 `"logo"`）。补法：搬进 `goodDetailLayout.footerLogo = { image: uiImages.gameLogo, size: new Size(220,120) }`。
   结论：**前缀列表要包含根目录裸名（`"logo"` 这类）**，并且要在「所有区域都搬完」之后再扫一遍。
8. **动态挂件挂进已有 FlexCol 容器时，配置项要从「坐标 + 缩放」换成「插入位置」**：
   把某个会增删的挂件（称号名牌、状态图标、buff 条）挂进一个已有布局容器（如角色头顶信息栏 `createHead` 的
   纵向 FlexCol）时，**不要再配 `position` / `scale`**——位置由容器布局算，写死坐标只会被布局覆盖（配了也不生效，
   变成假配置）。配置里留 `siblingIndex`（0 = 最上）+ 占位 `size` 即可。
   配套两条硬要求：
   - **同一个容器里的取件口径必须从「按下标」改成「按名字」**。删掉/插入一个兄弟节点会让 `children[i]` 全部漂移，
     而 `children[2]?.getComponent(XXX)` 这种写法**是静默失效**（拿到 null 就 `if (xxx)` 跳过），
     表现为「血条/血量文字不再刷新」却不报任何错。给子件起稳定名字（建与被读两端同一次改动）+ 用
     `getChildByName`；这条会命中审计的 `nodeName` 规则，按「同一套结构的两端」登记例外清单（与 `monster_head` 同类）。
   - **引擎口径（3.8.7 `cocos/ui/layout.ts` 实读）**：`Layout.Type.VERTICAL` 只改容器 `height`、**从不改 width**；
     `alignHorizontal` 时 `fnPositionX` 直接返回 0（子件横坐标恒为容器原点 → 挂件变宽不会挤动同容器的名称/血条）；
     `ResizeMode.CONTAINER` 只按内容算高度、**不缩放子件**（只有 `CHILDREN` 才会改子件尺寸 → 「不缩放」天然满足）；
     `startPos = (verticalDirection - layout.anchorY) * baseHeight` + `sign = -1` ⇒ **下标 0 在最上**。
     Layout 监听 `CHILD_ADDED / CHILD_REMOVED / CHILDREN_ORDER_CHANGED` ⇒ `insertChild` 会立刻触发重排，不用手动 `updateLayout()`。

## 四、实施顺序（分批 + 每批 tsc）

1. 建目录与 `.meta` → 写 `images.ts` / `sizes.ts`（纯新增，零风险）→ 写 `hud.ts`（把原入口内容原值搬入）→ 原入口改 barrel；
2. 一次性做**改名**（uiImages/uiSize）+ 全项目引用替换，跑 tsc，把漏网点一次性抓完；
3. 逐区域搬：弹窗（含通用弹窗框）→ 面板零件 → 场景界面 → 各处裸图片路径；
4. 每批结束：`tsc` + `unused` 检查 + `grep` 磁盘核对；
5. 全部完成：sleep 20s 第二轮 tsc；抽查 2～3 个配置值与原值逐字一致（搬迁型重构最容易偷偷改数值）。

**搬迁型重构的验收标准**：数值一字不变、视觉零变化，只是「取值位置」变了。
改完让用户自己手调数值，比顺手「优化」几个像素安全得多。

## 五、把范围扩大到「所有可配置项」：文案 / 颜色 / 时长 / 阈值

当用户的要求从「UI 位置尺寸」升级为 **「所有可配置文件集中在 configs，核心代码只做代码运行」** 时，
位置/尺寸/图片只是其中一类，还得把下面几类一起收（用一张审计脚本兜住，见第六节）：

| 类别 | 唯一去处 | 关键做法 |
|---|---|---|
| 面向玩家的**文案** | `configs/texts.ts` | key + `{占位符}` 模板 + `getText(key, params)` |
| 通用零件**样式**（占位色、调试边框、飘字配色与时长） | `configs/layout/theme.ts`（barrel 导出 `uiTheme`） | 某界面专属的仍写各自 layout 块 |
| **调试可视化**的线宽/透明度/配色 | `configs/debug.ts` 的 `rangeStyle` | 与开关同域，关调试不影响 UI 配置 |
| **校验/拒绝原因**（为什么不能穿/不能进图） | `configs/texts.ts` 的 `reject_*` | 校验函数只产出 `TextRef`，不产出中文 |
| 玩法**可调数值**（拾取半径、提示节流、散落间距、操作上限、体型） | 对应域配置（`drop.ts` 的 `dropRuntime`、`role.ts` 的 `roleBody`/`roleRigid`） | 模块级 `const XXX = 40` 一律搬走 |
| **入口表**（底部功能按钮：名称/图标/解锁等级/快捷键） | `configs/bottomNav.ts` | 回调留在组件，用 `Record<key, 回调>` 关联 |

### 文案配置化（本项目已验证的形态）

```ts
// configs/texts.ts —— 唯一来源，纯字符串，不依赖 ui/
export const uiTexts = {
  soul_max_tip: "战魂已满级",
  soul_bind_gold_tip: "绑定元宝不足，升级需要 {need}",
  reject_map_level: "{map} 需要等级达到 {level} 级",
  ...
} as const;

export function getText(key: string, params?: TextParams): string {
  const t = (uiTexts as Record<string, string>)[key];
  if (t === undefined) { console.warn(`[texts] 未登记的文案 key：${key}`); return key; }
  return formatTemplate(t, params);   // 缺参保留 {name}，一眼看出漏传
}
export function textRef(key: string, params?: TextParams): TextRef { return { key, params }; }
```

`TextRef`（`{key, params}`）放 `types/common.ts`。三个关键收益：

1. **提示接口只剩 key**：`GameUiHelper.createTip(name, params?)` 直接按 key 查表，
   调用点从 `createTip("soul_max_tip", "战魂已满级")` 变成 `createTip("soul_max_tip")` —— 文案不再有两份。
2. **校验层零中文**：`GameHelper.getEquipmentRejectReason(): TextRef | null`，
   调用方 `createTip(reason.key, reason.params)`。这比「返回字符串」更彻底：连「需要等级 N」这种拼接都进了配置。
3. **文案单测可跑**：把 `configs/texts.ts` + `types/common.ts` 用 tsc 编成 CommonJS（`types: []`，
   因为纯字符串不碰 `cc`），node 里断言模板替换 / 漏参保留 / 未登记 key 兜底（见 `tools/test-texts.cjs`）。

## 六、配置外泄审计（把「收敛」变成可复跑的验收）

一次性人工 grep 只能证明「这一刻干净」，所以把它固化成脚本 `tools/audit-config-leak.cjs`：

- 扫 `assets/{ui,skills,entities}/**/*.ts`（跳过 `configs/`、`types/`、`unused/`、`resources/`），
  逐行跑规则：`color`（`new Color(r,g,b)` / `"#RRGGBB"`）、`assetPath`、`nodeName`、`time`、`tunable`、`magicCompare`、`cn`（中文文案）
- 命中项要么修，要么登记到 `tools/config-leak-allowlist.json`（`{file, rule, match?, reason}`），
  **reason 必须说清「它是代码的内部身份，不是配置」**
- 反向检查：代码里 `getText("k")` / `createTip("k")` 引用的 key 必须都在 `configs/texts` 登记，
  否则 key 漏登记只会在运行期打一条 warn、页面上直接显示成 key 字符串
- **第二个反向检查（最容易漏）**：`configs/**` 不许 `import ... from "../ui/..."`。
  审计天然只朝一个方向扫（扫 `ui/` 里有没有写死配置），于是「配置反过来依赖 UI」永远不会被报出来。
  实测踩到：`configs/npc.ts` 直接 `import MapTeleportDialog from "../ui/components/dialogs/..."` 并在
  `onClick` 里 `new` 弹窗（`configs/skill.ts` 同理 import `skills/warrior`，而后者又 import `ui/core/*`），
  于是 `configs → ui/core → configs` 成环，配置表不再能被单独加载或跑单测（本项目 `tools/lib/configs-sandbox.cjs`
  的沙箱正是靠「配置不碰 UI」才成立）。
  判定：`grep -rn -e 'from "../ui/' -e 'from "../../ui/' configs/`（BSD grep 无 `\|`，用多 `-e`）。
  修法不是把逻辑搬回组件，而是**配置只留 key、由组件按 key 关联行为**（与 `configs/bottomNav` 同套做法）。

规则设计踩过的坑（**假警比漏报更消耗信任，报假警的规则要当场收紧**）：

1. **排除开发期日志**：`console.*` 里的中文不是玩家可见文案 → `cn` 规则先判 `!/console\./`
2. **排除单位换算与三元兜底**：`* 1000`（秒→毫秒）、`rate > 0 ? rate : 1`（除零保护）不是可调数值
   → `time` 规则只在「定时器第二参数是数字字面量」时报警；`tunable` 规则先排除 `?\s*\w*\s*:\s*\d`
3. **排除 MIME 类型**：`canvas.toDataURL("image/png")` 不是资源路径 → `assetPath` 规则排除 `image|audio|video|text|application/…`
4. **排除位运算枚举**：`1 << 3` 是层级枚举，不是阈值 → `magicCompare` 规则遇 `<<` 直接放行
5. **排除组件私有同名方法**：`this.createTip(name, atlasSrc)`（组件自己的图集提示）不是文案 API
   → key 覆盖检查用负向后顾 `(?<!this\.)`，否则必报假警
6. **不要去搬「内部节点名」**：`new Node("ui_layer")` / `getChildByName("monster_head")` 是代码自己的结构身份
   （建与用两端都在代码里，没有「调它」的场景），登记进例外清单即可；
   真搬进配置只会得到「配置定义名字 → 管理器拿名字建空节点」的空转
7. **审计要能对同类问题复用**：规则表写成 `[{id, label, test(line)}]`，新增一类检查只加一条规则，
   报告按「文件 → 规则」两级汇总 + 退出码非 0，方便挂进 CI 或收尾自检
8. **审计必须双向**：只扫「`ui/` 里有没有写死的配置」会漏掉「`configs/` 反向 import `ui/`」——
   两个方向破坏的是同一件事（配置与代码的边界），规则表里要各有一条；
   收敛「可配置项」时这个漏洞尤其危险：越收敛、`configs` 越像"全能层"，越容易顺手把 UI 依赖也搬进去

**验收组合**（本项目每轮都跑）：`tsc`（0 新错）→ `node tools/audit-config-leak.cjs`（PASS + 文案 key 覆盖 0 漏）→
`node tools/test-texts.cjs` → 既有单测（背包整理/回收等）→ 与业务无关的旧审计（如点击穿透）→ `sleep 20s` 回写复检。

## 七、相关

- 素材/脚本文件级移动、`.meta` 成对搬迁与校验脚本：skill `cocos-asset-refactor`
- 动态视图「用前重读」数据源（配置化之后最容易踩的另一类坑）：skill `cocos-view-lifecycle`
- 常驻 HUD 贴边与屏幕适配（本配置里的 `anchor{edge,marginX,marginY}` 就是这个机制）：skill `cocos-screen-adapt-hud`
