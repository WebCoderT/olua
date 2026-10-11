# olua 客户端玩法约定（Cocos 3.8.7）

> 从项目记忆 `.workbuddy/memory/MEMORY.md` 移出的**纯客户端玩法约定**（不涉及三端联动）。
> 这些是「改动时容易踩」的不变量，不是完整设计文档；配合 skill `cocos-*` 系列与 `client/README.md` 看。

## 目录与总约定

- 目录：`configs` / `types` / `entities` / `skills` + `ui/{core,components,helpers,utils}`。
- `configs` / `types` **不依赖 UI**；组件 = `class extends Node`；`core` / `helpers` **全静态**。
- **可配置项唯一去处 = `client/assets/configs`**（布局 / 文案 `texts` / 数值 `growth`）；统一「**数组为源 + 尾部建 Map**」。
  自查：`node client/tools/../..`→ 实际在仓库根跑 `node tools/audit-config-leak.cjs`，文案键覆盖跑 `cd client && node tools/test-texts.cjs`。

## 装备与素材

- **装备**：每件 15 变体（前缀 5 × 后缀 3；基础件 = 普通·人级，`getEquipmentVariantKey` / `getEquipmentBaseKey`）；**遍历前 `getBaseEquipments`**；新 assets **必带 `.meta`**；`getItem` **返回副本**（单测禁比身份）；新角色出生 51 件；背包硬上限 77。
- **素材 trim 三类规则相反**（改动前先确认是哪一类）：
  - `border`（品质边框）：图集未裁剪但 offset≠0 → **trim=true**，挂图标子节点，`playLoopAtlas`；
  - `background`（详情背景）：真裁剪 + offset≠0 → **trim=false**，换弹窗自身精灵帧，`playLoopDir`；
  - `light`（掉落光柱）：同背景 trim=false；光柱在图标**之前** addChild = 下层；前缀 5 档 → `light/1~5`，`light/6` 留 `customEquipmentLightData`。
  - 均 10fps、进图 `PreloadManager` 预载。
- **素材扩展名必须等于真实格式**（role/{1,2} 曾混 368 个「.png 壳 + BMP 芯」→ Cocos 刷屏报错，工具 `client/tools/clean-role-empty-frames.cjs`）。**`resources/` 不被 git 追踪，删前必备份**。
- **帧号基准 `configs/animation.animationFrameBases`**（role/2 = role/1 + 600）：按动作表切割的素材若与别目录连号**必登记**，`buildClips` 匹配前先减；**不减则片段全空且静默**。整包循环播放的（光柱等）不需要。
- **默认外观按性别**：`configs/role.roleDefaultCloths: Map<SEX,…>`（BOY→role/1、GRIL→role/2，未登记回落男性）；字段用 `types/good.OutTransform`；`RoleAppearance` 穿衣用装备变换、裸衣用默认身体，同一套 `applyOutTransform`。守卫 `test-role-default-cloth.cjs`。

## 成长线与属性

- **`growth.sampleGrowth` 只吃整数等级**：曲线段间不连续（第 10 级 262 血 / 第 11 级 330 血），分数等级会拿下一段斜率外推。按分数等效等级取属性必须**两侧整数等级线性插值**（`configs/rank.getEquivalentAttributes`，test-rank 钉死）。
- **三条成长线同构**（战魂 `soul` 37 阶 / 称号 `title` 34 阶 / 军衔 `rank` 100 阶 = 10 大段 × 10 阶）：
  都 = 「等效等级裸属性 × rate × 系列/大段 factor」（rate 0.5 / 0.3 / 0.35）；都消耗**绑定元宝**、价格 = `priceBase × N²`（300 / 200 / 30）；都计 `GameHelper.combatCalc`、都要 `StorageManager.ensureRoleDefaults` 补 0、都走 `StorageManager.upgradeXxx()`（先扣款再落阶再重算再 updateUi）。
- **`hpRecover`（点/秒）**：单值属性（**不进 `attributeKeys` 区间循环**）。五来源 = 等级（`maxHp × hpRecoverRate`，默认 0.01）+ **防御装备**（衣 40% / 头 20% / 腰带 20% / 鞋 20%，**不保底 1**）+ 战魂 / 称号 / 军衔。汇总在 `combatCalc`、结算 `HpHelper.recover`（`hp<=0` 不回、攒余数）、与 `MpHelper` 共用一次落盘。**不计战斗力**、怪物恒 0。守卫 `test-hp-recover.cjs`。

## 显示与交互

- **军衔外显 = 头顶红字（无素材）**：`GameUiHelper.createHead(name, hp, maxHp, rank)`（**签名里已无 label**），按名字取 `role_hp_bar` / `role_hp_text` / `role_rank`，**禁用下标**；文案 `label_rank_head:"【{rank}】"`，rank=0 留空。
- **角色名称在人物区域正中间**（与 `createMonsterName` 同口径）：`roleBody.size.height / 2`，零件 `GameUiHelper.createRoleName(role)` 挂 `RoleDisplay.createBody`，**不进头顶信息栏 `role_head`**。
- **飘字挂载点**：`LayerManager.UILayer` 只在游戏场景存在。飘字一律走 `GameUiHelper.createTip / createErrorTip / createTipText / createErrorTipText`；**禁业务层直接 `addToUILayer(tip)`**。
- **弹窗层级 = 点击置顶**：挂载统一走 `LayerManager.addDialogToUILayer`（登记 `dialogNodes`），`raiseDialog(node)` 可传弹窗内任意节点（沿祖先 `findDialog` 定位）；事件绑 `GameUiHelper.bindDialogRaiseOnPress`（TOUCH_START + MOUSE_DOWN，**禁注册 MOUSE_MOVE**）。自有底图的弹窗（MallDialog）与收住触摸的手势容器（BagGridView）各自补挂。**临时层 / HUD / 飘字 / 悬停详情 / 死亡遮罩 / 升级特效仍走 `addToUILayer`**。
- **长列表弹窗别重建**（建节点才是卡顿根因）：100 阶军衔列表只在打开时建一次，切换选中只改两张卡的颜色/描边；滚动定位先 `Layout.updateLayout(true)` 强制排版，再按卡片实际 y 算偏移（CONTAINER 尺寸下一帧才有，直接 scroll 会被夹在顶部）。
- 角色信息弹窗三入口竖排相邻（几何全来自 `roleInfoDialogLayout`：`titleButton` / `soulButton` / `rankButton`）；商城卡片网格分页（3 列 × 2 行/页，**不用 ScrollView**，翻页先 `removeFromParent()` 再 `destroy()`）；全屏模态必须两路独占输入（`blockClickThrough` + 四个 TOUCH_* `propagationStopped`）。
- **`isValid` 不查「待销毁」** → 失效判据要叠数据判据（`isValid(value)` 的 strictMode 没有默认值）。
- 悬浮详情摆位走 `ScreenLayout.getPopupPosition`（屏幕中心系），**禁 `worldToScreen` 减设计分辨率**；只 `setPosition` 禁改锚点。
- **拖动手势走 TOUCH 通道**（节点禁注册 MOUSE_MOVE）；子手势容器四个 TOUCH_* `propagationStopped`；事件坐标向量跨事件必须 clone。

## 操作摇杆 / 输入

- **摇杆（左下角常驻）**：零件 `components/hud/Joystick`（`GameUiHelper.applyJoystickBodyStyle` = 底座 `main/joystick_bg` + 手柄 `main/joystick`，返回手柄）；贴边 `joystickLayout.anchor.edge="bottom-left"` → `ScreenLayout.getAnchoredPosition` 新增该档（语义 = 区块下边缘到屏幕下边缘，**bottom-center 旧义不动**）。
- 输入 `components/input/RoleJoystickInput`（宿主 = 底座，手柄注入）：**只注册 TOUCH_{START,MOVE,END,CANCEL}，绝不注册 MOUSE_***（引擎在 mouse-down 后把 mouse-move/up 模拟成 touch-move/end，混注册会派发两次，且 MOUSE_MOVE 注册在节点上会吞掉指针追踪与按住走路）。
- 判定纯函数在 `utils/input/Joystick.ts`：`clampJoystickOffset`（夹进 `joystickLayout.radius`）+ `resolveJoystickMove`（< `configs/role.joystickMove.deadZone` 原地 / 之间走路 / ≥ `runThreshold` 跑动）。摇杆在 **UI 层**（不随角色），输入由 `RoleDisplay.setJoystick(stick, handle)` 注入；`getMoveIntent` 优先级 **键盘 > 摇杆 > 鼠标**。守卫 `server` 无关，跑 `cd client && node tools/test-joystick.cjs`。
- **世界点击要看「按压起点」**：`Pointer.isUiPressOnUiElement()`（= pressTarget 非空）供 `ScreenClickInput` 跳过「起点在界面元素上」的那次抬起。

## 怪物 / 战斗 / 掉落

- **怪物配置由生成器产出**：`client/tools/gen-monster-config.cjs` 重写 `configs/monster.ts`（规则在文件头，改后重跑；保留手工字段）。**几何读素材 .meta 不解码 PNG**（Cocos 对怪物帧 `trimType:"auto"`，帧 .meta 的 `offsetX/offsetY` 即渲染用裁剪数据，offset y 向上为正）；基准帧 00040；contentSize = trim 尺寸（碰撞盒/点选/血条全靠它，曾有 216 只 0×0 点不中）；outOffset = `(-offsetX,-offsetY)`，消费点 `createMonsterBody`。**speedRate = 每秒循环数**；默认表 `monsterDefaultSpeedRate` + 条目 Partial 覆盖。**运行时 Map 条目没有 key/tier**（建表解构丢弃，单测要 tier 从源码解析）。主动怪 = body 宽 ≥ 250 或 boss；售价 = level × {2,5,20}。守卫 `test-monster-config.cjs`。
- 掉落链 `monster.drops → DropManager → DropRoller → DropScatter`；**地面掉落名三段着色走 `getEquipmentNameParts`**（禁另写色表），各段 `Label.Overflow.NONE`（CLAMP 会压成 0）。
- TiledMap 必关裁剪（`enableCulling=false`）；**伤害唯一入口 = 技能系统**（普攻 "1000"）；伤害 `max(0, 攻 - 防)`；**角色是 JSON 禁挂方法**。
- `findOnlineRole()` 每次返回新对象（**长命视图别缓存**）；`deleteRole` 必清 `selectedRole`。

## 单测沙箱（`client/tools/lib/`）

| 沙箱 | 用真实什么 | 敏感点 |
|---|---|---|
| `configs-sandbox.cjs` | 纯配置 | `prepare(name, extraEntries, ccExtra)` 可编译任意只依赖 cc 的模块 |
| `storage-sandbox.cjs` | 真实核心类 | **改 `StorageManager` 的 import 就要同步它 `STUB_IMPORTS`**，否则 7 套 storage 系单测一起挂 |
| `layer-sandbox.cjs` | 真实 `LayerManager` + 引擎语义 Node 垫片 | stub 路径要写 `"../../stubs/UiHit"`（写成 `../stubs/` 会解析到 `ui/stubs/`） |
| `net-sandbox.cjs` | 真实请求层 | `XMLHttpRequest` 由测试注入 |

现 **24 套** `client/tools/test-*.cjs` + **5 套** `tools/audit-*.cjs`（审计在仓库根）。
`test-client-net` / `test-dialog-top` / `test-rank` / `test-title` / `test-bag-discard` 含**源码接线断言**（改签名要同步）。
