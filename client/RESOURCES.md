# 客户端资源目录（`client/assets/resources/`）

> **素材不入库**（约 2.4 GB / 11 651 个文件）。分发靠仓库根的 `resources.manifest.json`
> 与 `client/tools/resources_sync.py`（`manifest` / `verify` / `pack` / `extract`）。
> 动过目录或文件名之后必须重新生成清单并升版本 —— 否则别人 `verify` 会缺文件：
>
> ```bash
> python3 client/tools/resources_sync.py manifest --version 2026-11-06-1
> ```
>
> 「资源路径」在代码里分三处出现：客户端 `configs/`（取图函数 + 具名表）、服务端库表
> （19 个路径列 + `equipment_appearance` 的 6 个 JSON 列 key）、以及
> `server/data/config-sync.sql`（库的投影）。改名要三处一起动，靠
> `node tools/audit-resource-refs.cjs` 兜底（它会逐条核对磁盘上真有这个文件）。

## 一、顶层只分「域」，界面零件全收在 `ui/`

一眼能看清的代价是**同一层不许混两类东西**：界面零件（按钮、底图、图标）全部进 `ui/`，
实体与特效按域平铺。19 个顶层项 = 14 个目录 + `logo.png` + 两份清单。

| 目录 | 装什么 | 代码入口 |
| --- | --- | --- |
| `audio/` | 12 个音效 / 音乐（`wav` / `mp3`，**文件路径入库**，运营在管理端挑） | `configs/audio`（快照 `audio` 段）→ `ui/core/SoundManager` |
| `effect/` | 特效图集，按用途八分：`background` / `border` / `light` / `select` / `skill` / `status` / `aura`（氛围光环）/ `upgrade`。`select/` 收**两种地面光标**：`player@0`（选角界面选中角色）与 `monster@0`（地图上点中怪），同类放一起 | `configs/layout/images.effectImage`、`effectSelectImage`、`configs/{border,background,light}` |
| `equipment/` | 装备，**一个部位一个目录**（目录名用复数）：`clothes/`、`weapons/` 各三套（`icon` 图标 / `in` 内观 / `out` 外观）；`belts/`、`helmets/`、`necklaces/`、`rings/`、`shoes/`、`wristbands/` 只有扁平图标（这批素材没给内外观）。图标一律 `<编号>.png`，编号即装备 id 的数字部分 | 快照 `equipments.{icon,in_atlas,out_atlas}` |
| `font/` | `msyh.ttf`（Label 未指定字体时的默认字体） | `uiImages.defaultFont` |
| `item/` | 物品图标，按**大类**分层：`consumable/drugs/` 收全部药品（`drug-hp-1` 这类语义名）、`currency/` 收货币道具（`gold-100` 这类，见下面「六」）、`scroll/` 收升级卷轴（`level-scroll` 一张共用，见下面「七」）。装备图标不放这里 —— 那是 `equipment/<部位>/` 的事（#777 迁走） | 快照 `drugs.icon` / `moneyItems.icon` / `levelScrolls.icon` / `items.icon` |
| `map/` | 每张地图一个目录：`<id>.tmx` + 图块 `*.tsx` / `*.jpg` + `preview.jpg` | `images.mapPreviewImage`；`map/` **不参与改名**（Tiled 工程内部互相引用） |
| `monster/` | `icon/` 头像 + `out/` 地图上的八方向动作 | 快照 `monster_presentation.{icon,out}` |
| `npc/` | NPC 外观图集（`2108.plist` 平铺） | 快照 `npcs.src` |
| `role/` | 主角本体：`boy/` / `girl/` 各一套动作目录 | `configs/role`、`configs/animation` |
| `skill/icon/` | 技能图标（1011 个，编号 = 技能 id） | 快照 `skills.icon` |
| `soul/` | 战魂动画图集（`13001.plist` 平铺） | 快照 `souls.animation` |
| `title/` | 称号动画图集（`13009.plist` 平铺） | 快照 `titles.animation` |
| `ui/` | **全部界面零件**，见下表 | `configs/layout/images.ts` 的取图函数 |
| `wing/` | 翅膀外观图集（`wing_100004@1` 这种多段） | 快照 `fashions.{icon,in_res,out_res}` |
| `logo.png` | 各端图标统一取这张（官网同款） | 构建脚本 / `admin` / 下载站 |

`ui/` 之下（每个子目录对应 `images.ts` 里一个取图函数，**代码里不许再出现裸路径字符串**）：

| 子目录 | 取图函数 | 内容 |
| --- | --- | --- |
| `ui/avatar/` | `avatarImage(职业, 性别)` | 角色头像 `1-1` ~ `3-2` |
| `ui/button/` | `uiButton` | 按钮背景 |
| `ui/common/` | `uiCommon` | 通用框、底图、血条底 / 填充、格子、圆点、关闭键 |
| `ui/create-role/` | `uiCreateRole` | 选角 / 建角整套；`preview/` 下是 `1-1-stand@0` 这类预览图集 |
| `ui/dialog/` | `uiDialog` | 通用弹窗的九宫拆块（`popup-{header,body,footer}-{left,center,right}`） |
| `ui/hud/` | `uiHud` | 主界面：摇杆、挂机开关、头顶血条、`number/` 飘字数字、`panel/` 面板底 |
| `ui/loading/` | `uiLoading` | 加载界面 |
| `ui/login/` | `uiLogin` | 登录界面 |
| `ui/mall/` | `uiMall` | 商城门面背景（`bg`） |
| `ui/minimap/` | `uiMinimap` | 小地图整套：底图、名称条、线路、排行榜 / 成就 / 邮件等入口图标 |
| `ui/money/` | `uiMoney` | 货币与 VIP 图标 |
| `ui/nav/` | `uiNav` | 底部功能栏图标与底图 |
| `ui/slot/` | —（路径入库） | 各部位底图（`cloth` / `belt` / `accessories` …），由快照 `equipment_slots.image_src` 下发 |
| `ui/tips/` | `uiTips` | 屏幕中央提示图集（`auto-attack@0` 等） |

## 二、命名规范

改名的目标只有一个：**看名字能猜出它在哪、是谁**。规矩如下（2026-11 统一，共 863 次改名）。

| 规则 | 例子 | 说明 |
| --- | --- | --- |
| 目录与文件名**全小写 + 连字符** | `create-role` / `auto-fight-close` | 不用下划线、不用大写、不用拼音缩写 |
| 图集 **`.plist` 与 `.png` 同名成对** | `border-30123.plist` + `border-30123.png` | 帧名在 plist 内部是 `<基名>_0000` |
| 一套画多张表时加 `@<序号>` | `wing_100004@0` / `@1`、`monster@0` | 序号是**表**的序号，不是帧号 |
| 语义前缀代替原始编号 | `border-30123` / `bg-16000` / `light-1` | 原来是 `sfx_30123_0`（`sfx` = sound effect，被错用在图上）；现在前缀说清用途，编号（美术资产号）保留 |
| 光柱六档 | `light-1` … `light-6` | key 同时是 `ui_effects` 的行键与素材名，**不含斜杠**（会拼进节点名） |
| 纯数字名保留 | `title/13009`、`soul/13001`、`npc/2108`、`equipment/rings/2010210`、`monster/1`、`skill/icon/1001`、`map/1` | 这些编号是配置里的 id（装备的编号就是 id 的数字部分），改名等于改数据；只把它们**收进有意义的目录** |
| 禁止出现的东西 | `sfx_` 前缀、非 ASCII、空格 | 审计会拦 |

## 三、图集在磁盘上有两种形态

代码只调一个入口 `AnimationHelper.loadLoopFrames(src)`，两种形态都吃 —— 因为它先
`resources.getInfoWithPath(candidate, SpriteAtlas)` 探一遍 `[src, src/<基名>]`，
命中就按图集加载，否则回退「目录里的散帧」。

1. **平铺**：`effect/border/border-30123.plist`（同目录一堆平级的图集）
   用于 `effect/{border,background,light}`、`title`、`soul`、`npc`、`wing`。
2. **目录内同名**：`role/boy/stand/stand.plist`、`equipment/clothes/out/005/stand/stand.plist`、
   `ui/create-role/preview/1-1-stand@0.plist`
   用于「一个动作一个目录」的成套动画。

> 平铺图集曾经是踩过坑的地方：老代码只看 `getDirWithPath(src, SpriteAtlas)`，
> 平铺目录里没有同名图集，于是把标题 / 战魂 / NPC / 边框 / 背景全当「没图集」回退散帧目录，
> 一律加载失败。新增平铺目录时务必确认走的是上面的两形态入口。

## 四、`.meta` 是 uuid 载体

- **改名必须连 `.meta` 一起改**（`x.png` → `x.png.meta`）；目录改名同步目录级 `.meta`。
- 孤立 `.meta`（对应文件已不存在）与空目录要清掉，否则编辑器里留一堆空节点。
- 不要手写 uuid；缺 `.meta` 的目录交给编辑器在导入时生成即可。

## 五、改名 / 搬家的固定动作

1. **磁盘**：`tools/oneoff-migrate-resources.cjs` 是这次搬迁的规则表（声明式 `LAYOUT`，
   最长前缀命中，带干跑与冲突检测）。一次性脚本，留作记录，不挂 CI。
2. **plist 自引用**：`realTextureFileName` / `textureFileName` 与每帧 key 都带图集基名。
   只改文件名不改 plist ⇒ 运行时「图集在、贴图找不到」。按 `oldBase → newBase` 全文替换。
3. **库**：19 个路径列 + 6 个 JSON 列 key（`tools/oneoff-migrate-resource-paths.cjs`）。
   同一套正则必须**同时**跑 `server/data/config-sync.sql` 与本地库，否则两边漂移。
4. **客户端**：`configs/layout/images.ts` 的取图函数与具名表、`configs/{border,background,light,role,animation}`、
   `types/*` 注释。
5. **门禁**：`node tools/audit-resource-refs.cjs`（静态字面量 + 展开型引用 + 磁盘结构自检 + 快照 key 点名）
   与 `make test-changed`。
6. **清单**：`resources_sync.py manifest --version <新版本>`。

零引用素材**不删只归档**：移到 `_loose_frames_archive/orphans-<年月>/`（该目录 gitignored，
同卷移动可随时移回）。

## 六、货币道具图标（`item/currency/`，#785）

货币道具（绑定元宝 / 元宝 / 银子）是**可使用的背包道具**，用法与药品同类：格子里的
图标 = 这张图，使用后往角色账本入账。它和 HUD 上那一排「货币数量小图标」
（`ui/money/`，那是界面零件）是两回事 —— 别放反了。

- **放哪里**：`client/assets/resources/item/currency/`（目录已建好，把图丢进去即可）
- **叫什么**：`<货币>-<面值>.png`
  - 货币：`bind-gold`（绑定元宝）/ `gold`（元宝）/ `silver`（银子）
  - 面值：`10` / `50` / `100` / `200` / `500` / `1000` / `5000` / `100000`
- **要几张**：3 × 8 = **24 张**（正好是出厂清单的 24 行）
- **格式**：`.png`，透明底，正方形（与 `item/consumable/drugs/` 那批同尺寸即可）
- 全名清单：

```
bind-gold-10.png      bind-gold-50.png      bind-gold-100.png      bind-gold-200.png
bind-gold-500.png     bind-gold-1000.png    bind-gold-5000.png     bind-gold-100000.png
gold-10.png           gold-50.png           gold-100.png           gold-200.png
gold-500.png          gold-1000.png         gold-5000.png          gold-100000.png
silver-10.png         silver-50.png         silver-100.png         silver-200.png
silver-500.png        silver-1000.png       silver-5000.png        silver-100000.png
```

> 路径不是写死在代码里的：库表 `money_items.icon` 存的就是上面的相对路径（不含扩展名）。
> 所以在管理端「货币道具」页新建一档面值时，图标默认按同一规则派生
> （`item/currency/<货币>-<面值>`）；也可以点「图标」的**选择**按钮从磁盘里挑，
> 或者自己填别的路径 —— 图片换名 / 换位置只影响这一列。
>
> 素材不进库：`.meta` 交给 Cocos 导入时生成；新增整批素材后要重新出清单
> （`resources_sync.py manifest --version <新版本>`），否则别人 `verify` 会缺这 24 张。

## 七、升级卷轴图标（`item/scroll/`，#787）

升级卷轴（硬性 +1 级、带等级区间）也是**可使用的背包道具**，格子里的图标 = 这张图。

- **放哪里**：`client/assets/resources/item/scroll/`（目录已建好）
- **叫什么**：`level-scroll-1.png` … `level-scroll-7.png` —— **一卷一张**（按卷号分文件；
  想合并成一张也行，在管理端「升级卷轴」页逐卷点图标的**选择**按钮改路径即可）
- **格式**：`.png`，透明底，正方形（与 `item/consumable/drugs/` 那批同尺寸即可）
- 路径同样**不是写死在代码里**：`level_scrolls.icon` 存相对路径（不含扩展名），
  新建一卷时缺省按卷号派生 `item/scroll/level-scroll-N`（见 `levelScrollIconOf`）。
- **待办**：现在这 7 张都是脚本画的占位图（米黄卷纸 + 金轴头 + 红系带 + 金星），美术出图后直接换同名文件即可，
  库里的路径不用改。
