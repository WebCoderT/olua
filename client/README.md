# client · 客户端（Cocos Creator）

> 这是 **Cocos Creator 工程的根目录** —— 用 Cocos Creator 打开的就是这个目录，不是仓库根。
>
> 项目总览见 [../README.md](../README.md)；客户端的问题见 [FAQ.md](FAQ.md)；
> 服务端 / 管理端 / 跨端的说明见 [../server/](../server/) · [../admin/](../admin/) · [../FAQ.md](../FAQ.md)。

一个基于 **Cocos Creator 3.8.7** 的 2D 角色成长与装备玩法原型，包含登录、选角、地图探索、战斗、背包、商城、
以及三条成长线（战魂 / 称号 / 军衔）。玩家的角色数据以服务端为权威，本地只是缓存。

## 环境要求

- **Cocos Creator 3.8.7**（工程用它的内置 `tsc` 做类型检查，不需要单独装 TypeScript）
- Node.js（只用于跑 `tools/` 下的本地单测与配置生成器，不参与打包）
- 一个运行中的服务端（见 [../server/README.md](../server/README.md)）—— 登录与角色列表要连它

## 怎么打开与预览

1. 安装并打开 Cocos Creator 3.8.7；
2. 通过 Creator 的 **Open Project** 打开 **本目录**（`client/`）；
3. 在编辑器中打开 `assets/scenes` 下的场景；
4. 用预览或播放按钮运行。

> 首次打开时 Creator 会重新生成 `library/` 与 `temp/`（这两个目录不进版本库，已随工程带过来的是缓存，可直接删掉重建）。
>
> 工程没有 npm 脚本：启动与预览一律走 Cocos Creator 编辑器。

## 场景

| 场景 | 作用 |
| --- | --- |
| 登录 | 账号注册 / 登录，连服务端拿令牌 |
| 角色选择 | 角色列表与创建、进入游戏、管理态删除角色；进游戏前从这里拉服务端完整数据 |
| Loading | 切图过渡（带进度显示） |
| 游戏 | 主循环：地图 / 战斗 / HUD / 各种弹窗 |

## 连哪个服务端

**唯一来源是 `assets/configs/network.ts` 的 `baseUrl`**（默认 `http://localhost:3100/api`）。
真机调试改成局域网 IP。代码里没有第二处地址字面量 —— 由 `node ../tools/audit-api-hardcode.cjs` 盯着。

## 三条铁律

1. **核心代码只做「怎么跑」，一切可调的东西都在 `assets/configs`**
   数值、文案、布局、配色、时长、资源路径都不写进逻辑。自查：`node ../tools/audit-config-leak.cjs`
   - 文案统一走 `configs/texts`（模板带 `{占位符}`，取值用 `getText(key, params)`），代码里不写中文
   - 布局统一走 `configs/layout/*`，barrel 出口是 `configs/hudLayout`
   - `configs/` 与 `types/` **不依赖 UI 层**（配置只描述数据，回调与分支留在组件里）
2. **接口文件是生成的，禁止手改**
   `assets/ui/utils/net/{ApiRoutes,ApiModels,Api}.ts` 由服务端 Swagger 文档生成（见 [../FAQ.md](../FAQ.md#接口文件路径--类型--方法为什么是生成的想加一个接口改哪)）。
   要加接口 → 改服务端 → `cd server && npm run gen:api` → 按编译报错改调用点。
3. **可配置项的唯一去处就是 `configs`**，别的地方多存一份必然漂移。`audit-config-leak` 的第 1 段专门抓这个。

## 目录结构

```
client/                          ← Cocos 工程根（用 Creator 打开这里）
├── assets/
│   ├── configs/                 数值与静态配置（按域一文件）
│   │   ├── texts.ts             ← 面向玩家的全部文案
│   │   ├── network.ts           ← 服务端地址唯一来源
│   │   ├── layout/              UI 布局与样式（hud/dialogs/panels/scenes/…）
│   │   ├── growth.ts            成长曲线（等级/装备/怪物/战魂/称号/军衔共用一套分段线性）
│   │   └── …                    role/monster/skill/equipments/items/drop/map/status/border/background/title/light/mall/announcement
│   ├── types/                   纯类型声明
│   ├── entities/                运行时实体（Role）
│   ├── skills/                  技能行为实现（只依赖 SkillContext，不反查全局）
│   ├── ui/
│   │   ├── core/                静态管理器（GameHelper/LayerManager/MonsterManager/MonsterAI/
│   │   │                        DropManager/SkillManager/StatusManager/EffectManager/AutoBattle/
│   │   │                        PreloadManager/StorageManager/RoleUIManager/SceneManager/AnnouncementReadStore）
│   │   ├── components/          按职责分组（hud/panel/dialogs/role/input/map）
│   │   ├── helpers/             UI 生成（UiHelper 基础封装 / GameUiHelper 零件库 / AnimationHelper 帧动画）
│   │   ├── utils/               纯函数工具，按功能域分目录（battle/drop/map/physics/resource/input/cursor/layout/node）
│   │   └── utils/net/           对服务端的全部访问（含 3 个生成物）
│   ├── resources/               资源目录（地图 tmx、帧动画、图集、图标、UI 素材，不进版本库）
│   └── scenes/                  登录、角色选择、Loading、游戏
├── tools/                       客户端专属脚本（见下）
├── settings/ · profiles/ · native/ · .creator/   Cocos 工程配置
├── package.json · tsconfig.json                 Cocos 工程描述（不是 npm 脚本）
└── library/ · temp/ · build/                    Cocos 缓存与构建产物（不进版本库）
```

## 客户端工具（`tools/`）

全部是**本地校验脚本**，不参与打包；在 `client/` 目录下用 `node` 直接跑。

> 仓库根的 `make` 是这些动作的快捷方式：`make client-check`（类型检查）·
> `make client-test` · `make client-test-one T=test-bag-tidy` ·
> `make client-gen-monster` / `make client-gen-drops` ·
> `make client-clean-frames[-apply]` · `make client-open`。`make help` 看全部。

### 单测（25 套）

脚本自己会去找 Cocos Creator 自带的 `tsc`（`TSC=/path/to/tsc node …` 可手动指定）。

```bash
cd client
for t in tools/test-*.cjs; do node "$t" || exit 1; done      # 全跑
node tools/test-bag-tidy.cjs                                 # 单跑一套
```

| 分组 | 脚本 |
| --- | --- |
| 背包 | `test-bag-tidy`（整理排序）· `test-bag-drag`（拖动换格）· `test-bag-recycle`（一键回收）· `test-bag-discard`（丢弃/拖出销毁）· `test-new-role-bag`（新手背包） |
| 装备与物品 | `test-equipment-appearance`（外观切片）· `test-equipment-border`（品质边框）· `test-equipment-detail-background`（详情背景）· `test-equipment-light`（掉落光柱）· `test-good-detail-placement`（详情弹窗摆放）· `test-drop-name`（掉落物名称） |
| 成长 | `test-rank`（军衔）· `test-title`（称号）· `test-hp-recover`（每秒回血）· `test-role-default-cloth`（默认身体） |
| 界面与输入 | `test-dialog-top`（弹窗置顶）· `test-joystick`（操作摇杆）· `test-scene-stage`（登录 / 选角整屏适配）· `test-announcement`（公告展示：排序 / 未读 / 时间窗 / 登录提醒 / 已读记录） |
| 配置与素材 | `test-monster-config`（怪物配置与几何）· `test-role-frames`（角色帧素材）· `test-texts`（文案模板） |
| 网络与存档 | `test-client-net`（网络层：包裹解包 / 令牌 / 静默 / 防抖同步）· `test-role-delete`（删角色与「被踢下线」）· `test-mall`（商城购买链路） |

### 配置生成器（产物禁手改）

| 脚本 | 产出 | 说明 |
| --- | --- | --- |
| `gen-monster-config.cjs` | `assets/configs/monster.ts` | 几何读素材 `.meta` 的 auto-trim 实测（不解码 PNG）；规则写在脚本文件头，改完重跑 |
| `gen-monster-drops.cjs` | `assets/configs/monsterDrops.ts` | 每怪独立掉落表 |
| `clean-role-empty-frames.cjs` | 清理空帧素材 | 先预演列清单，`--apply` 才真动；会先备份到仓库根 `.workbuddy/backup/` |

### 单测沙箱（`tools/lib/`）

`configs-sandbox.cjs` / `storage-sandbox.cjs` / `layer-sandbox.cjs` / `net-sandbox.cjs`
—— 把**真实的核心代码**复制进临时目录、只把指向 UI 层的 import 换成 stub，再用最小 `cc` 垫片顶替引擎，
于是能在 node 里跑真实的配置表、真实的 `StorageManager`、真实的 `LayerManager` 与真实网络层做断言（不是复刻一份逻辑）。
细节见 [FAQ.md](FAQ.md#单测是怎么在-node-里跑真实-cocos-代码的)。

## 类型检查

工程不装 TypeScript，用 Cocos Creator 自带的：

```bash
cd client
/Applications/Cocos/Creator/3.8.7/CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin/tsc \
  -p tools/tsconfig.check.json
```

`tools/tsconfig.check.json` 是手写的检查配置（不是 Cocos 生成的，**随仓库提交**），只开了 `noUnusedLocals`，**路径全部相对**，工程移动位置也不会失效。
它放在 `tools/` 而不是 `temp/`，是因为 `temp/` 被 Cocos 整体重建、也不进版本库。`temp/tsconfig.cocos.json` 才是 Cocos 生成的，`tsconfig.json` 继承了它。

## 客户端专属的几条机制

改客户端代码前值得先知道的（详细踩坑见 [FAQ.md](FAQ.md)）：

- **落盘唯一出口**：`StorageManager.updateOnlineRole` —— 它同时是**同步服务端的唯一触发点**，所以不需要在每个玩法里各写一次保存
- **飘字挂载点**：一律走 `GameUiHelper.createTip / createErrorTip / createTipText / createErrorTipText`，
  由内部按「容器是否在当前场景里」选挂载点（游戏内挂 UI 图层，登录 / 选角挂场景根）。**禁止业务层直接 `addToUILayer(tip)`**
- **弹窗层级 = 点击置顶**：统一走 `LayerManager.addDialogToUILayer` + `GameUiHelper.bindDialogRaiseOnPress`；
  临时层（飘字 / 悬停详情）/ HUD / 死亡遮罩仍走 `addToUILayer`
- **输入三条通道**：键盘 > 摇杆 > 鼠标（`getMoveIntent` 优先级）；只注册 `TOUCH_*`，**绝不在节点上注册 `MOUSE_*`**
  （引擎会把鼠标模拟成 touch，混注册会派发两次；`MOUSE_MOVE` 注册在节点上还会吞掉全局指针追踪）
- **`isValid(node)` 不查「待销毁」**：失效判据要叠数据判据，别只信 `isValid`
- **`[...map.values()]` 禁用**：打包 babel 以 loose 模式会把迭代器展开编译成 `[].concat()`（恒为单元素），
  转数组只用 `Array.from` / `forEach` —— 这个坑只在打包产物上才暴露，且不报错

## 素材

`assets/resources` 体积很大，**不进版本库**（见仓库根 `.gitignore`）。需要素材请联系仓库作者。
删改素材前务必先备份：`assets/resources` 不在 git 保护范围内。

> 注意：**素材的扩展名必须等于真实格式**。历史上曾有一批「`.png` 壳 + BMP 芯」的空帧素材导致 Cocos 刷屏报错，
> 清理工具是 `tools/clean-role-empty-frames.cjs`。

## 相关文档

- [FAQ.md](FAQ.md) —— 预览报错、引擎坑、玩法配置怎么调
- [../README.md](../README.md) —— 项目总览、目录结构、功能清单
- [../FAQ.md](../FAQ.md) —— 跨端机制（地址唯一来源、契约管线、三端联动）
- [../server/README.md](../server/README.md) —— 客户端依赖的服务端
