---
name: cocos-bag-tidy
description: 给 Cocos Creator 3.x 游戏做「背包 / 仓库一键整理」与「一键回收 / 批量出售」这类**批量背包操作**的成套做法：搬运（合并同类可叠加物 → 按等级/类型排序 → 空格沉底；或按条件整格取走）抽成**纯函数**；排序规则、部位顺序、回收价各自收敛到唯一来源（成长曲线 × 前后缀倍率）；数据层只做「有变动才落盘」的薄封装；UI 入口用工厂按钮（自带穿透拦截）；**不可撤销的操作用两步确认而不是新弹窗**（第一次点击报数并改按钮文案，超时/关窗复位）；「丢弃 / 清理物品」这类**背包没有选中态**的操作用**模式开关**（按钮文案在「丢弃 ⇄ 退出丢弃」间切换）+ 同一套两步确认，且「点别的格子」直接换目标（别逼玩家等超时）；**「拖动改变格子」这类手势操作**：手势走 touch 通道（鼠标环境引擎会把 MOUSE_* 模拟成 TOUCH_*，一套代码两端通用）、位移阈值区分点击与拖动、同一次按压拖动过就不再算点击（`pressDragged` 只在下一次按下复位）、**MOUSE_MOVE 绝不能注册在节点上**（会吞掉全局指针追踪，光标样式与按住走路一起卡住）、事件里的坐标向量必须 clone、幽灵图标/落点高亮/源格压暗的数值全进布局配置、**网格区域内的触摸必须收在网格里**（父级弹窗挂的「整窗拖动」组件会收到冒泡上来的 TOUCH_*，把窗口跟着一起拖走：网格容器把四个触摸事件停在自己这里，整窗拖动组件再补一条「按下点自带拖动手势就不抢」的兜底）；落点规则（空格 = 移动 / 同种可叠加 = 合并且吃不完留原格 / 其余 = 交换）同样抽成纯函数，并且**「整理」必须从第一个格子起连续铺满**（不许中间带空洞）。并给出**在 node 里单测配置层的通用技巧**：把 `configs/*.ts` 用 tsc 编成 CommonJS，再拿一个只实现 `Vec2/Vec3/Size/Color` 的 `cc` 垫片顶替引擎，于是能直接跑真实配置表与真实函数（不是复刻逻辑），断言「行列不变 / 数量守恒 / 无效 id 保留 / 非目标物品连引用都不动 / 幂等」这类不变量；这套沙箱应抽成共用模块（olua 是 `tools/lib/configs-sandbox.cjs`）供多个单测复用，别一个脚本抄一遍。含必踩的坑：打包 loose 编译把 `[...map.values()]` 降级成 `[].concat(迭代器)`、解析不出配置的物品被误当「不可叠加」而拆堆、按价格而非按类型判断「该不该回收」、`Color` 的两种构造写法、脚本要自动探测 tsc（Cocos 自带的就够用）、配置层不能依赖 UI。触发场景：用户说「背包一键整理」「整理背包」「背包排序」「装备按等级排序」「按等级和类型排序」「合并同类物品」「叠加物品合并」「仓库整理」「背包乱了」「背包满了想省格子」「一键排序」「一键回收」「回收价格」「装备回收」「把背包里的装备卖了」「装备换元宝」「绑定元宝回收」「批量出售」「丢弃物品」「丢掉东西」「清背包」「清理杂物」「背包怎么丢东西」，或问「怎么单测配置表 / 纯函数」「node 里跑 Cocos 配置」「给 configs 写测试」「怎么验证排序算法」「拖动物品」「拖动换格子」「拖动物品调位置」「背包拖拽」「拖拽排序」「拖动松手变成点击/顺手用掉了」「拖动没反应」「拖动物品时整个弹窗也跟着拖」「拖拽带动整个窗口」「拖东西把窗口拖跑了」「整理后没有从第一个格子开始 / 中间还有空格」。 
agent_created: true
---

# Cocos Creator：背包「一键整理 / 一键回收」

## 一句话结论

把批量背包操作拆成 **「纯函数搬运 + 配置化规则（排序 / 定价）+ 薄数据层 + 工厂按钮」** 四层；搬运逻辑写成纯函数后，就能用一个 `cc` 垫片在 node 里跑**真实配置表 + 真实函数**的单测 —— 这类 bug（数量丢失、无效 id 被拆碎、排序不稳定、回收吞掉非目标物品）静态检查和 `tsc` 全绿也发现不了。**不可撤销的操作（回收 / 出售 / 分解）要两步确认**，别让一次手滑清空玩家的背包。

## 一、分层（改哪层都清楚）

### 1. 搬运 = 纯函数，放配置层，不放数据层

```ts
// configs/items.ts（无 UI 依赖，才能被 node 单测）
export function tidyBagGrid(bag: BagCell[][]): BagCell[][] {
  // ① 展平（背包只有 bagRow × bagCol 格）：线性扫描
  // ② 合并：同 id 的「可叠加」物品并进同一堆（换新对象，不动原数组引用）
  // ③ 拆堆：超过 maxStack 的再拆成多格
  // ④ 排序：见 compareBagGoods
  // ⑤ 铺回：从左上角按行铺满，剩余格子清空
  // 返回全新数组；行列数与入参一致
}
```

- **不要**把这段写进 `StorageManager` 之类的数据层：那里连着 `sys.localStorage`、UI 刷新、提示弹窗，抽不出可测的边界。
- 输入输出都是「二维背包数组」，不接角色对象 —— 单测直接喂数组，不需要造存档。

### 2. 排序规则 = 一个比较器（唯一定义处）

```ts
export function compareBagGoods(a: Goods, b: Goods): number {
  // 大类：装备 → 药品 → 材料 → 其他（bagTidyTypeOrder，数组为源 + 尾部建 Map）
  // 装备：「等级降序 → 部位 → 前缀降序 → 后缀降序」
  // 非装备：等级降序
  // 兜底：id 字典序 —— 同种物品必然相邻、结果与输入顺序无关（可复现）
}
```

- **id 兜底很重要**：没有它，`Array.sort` 在「所有键都相等」的元素上顺序不确定，同种物品可能被拆到背包两头；有了它，同 id 的格子比较结果恒为 0 → 必然相邻（比较函数只依赖那几个键，等价元素不可能被非等价元素隔开）。
- 想换口味（等级升序、药品排装备前面）**只改这一处比较方向**，别去动搬运流程。

### 3. 部位 / 类型顺序：复用既有配置顺序，**不要另写一份**

```ts
// configs/equipments.ts —— 序号直接由已有槽位配置的顺序生成
export const equipmentSlotOrder = new Map<EQUIPMENT_TYPE, number>();
for (const slot of equipmentSlotData) equipmentSlotOrder.set(slot.key, equipmentSlotOrder.size);
```

好处：改槽位配置的顺序时，「装备界面的槽位排列」与「背包整理顺序」一起变，永远不会分叉。

### 4. 数据层 = 薄封装：**有变动才落盘**

```ts
static tidyBag(): boolean {
  const role = this.findOnlineRole();
  if (!role) return false;
  if (this.bagIsEmpty(role.bag)) return false;      // 空背包：用独立方法判，别拿空串兼作「空背包」
  const before = this.bagSignature(role.bag);       // 逐格拼接，**空格也占一位**（见坑 14）
  role.bag = tidyBagGrid(role.bag);
  if (this.bagSignature(role.bag) === before) return false;   // 已经很整齐：不写存储、不刷 UI
  this.updateOnlineRole(role);
  RoleUIManager.refreshBag();
  GameUiHelper.createTip("bag_tidy_tip", "背包已整理");
  return true;
}
```

UI 侧配合：返回 `false` 时补一句「背包已经很整齐了」，否则玩家会以为按钮没反应。

**指纹必须包含空格位置**：否则「顺序没变、只是散着放」的背包会被判成「已整齐」而整理不动（坑 14）。

### 5. UI 入口 = 工厂按钮

用项目里已有的按钮工厂（olua 是 `GameUiHelper.createMiddleButton` → `UiHelper.createButton`），它内部已经做了 mouse 通道的穿透拦截（`blockClickThrough`）—— **不要为了加个按钮去裸写 `node.on(TOUCH_END)` 或自己注册鼠标事件**，那会绕过穿透拦截、也可能踩「节点必须挂 UITransform」的雷（见 skill `cocos-mouse-button-input`）。

按钮位置写进布局配置（olua 是 `configs/layout/dialogs.ts` 的 `bagDialogLayout.tidyButton`），组件里不写死坐标。

## 一点五、姊妹操作：「一键回收 / 批量出售」（不可撤销）

整理是「不丢东西的重排」，回收是「把东西换钱」—— 共用同一套分层，但多了三件事要处理：**判定**、**定价**、**确认**。

### 1. 判定：按**类型**决定搬不搬，不按价格

```ts
// configs/items.ts
export function recycleBagEquipmentGrid(bag: BagCell[][]) {
  let count = 0, totalPrice = 0;
  const result: BagCell[][] = [];            // 返回新数组，不改入参
  bag.forEach((row) => {
    const line: BagCell[] = [];
    row.forEach((cell) => {
      const good = cell ? getItem(cell.id) : null;
      if (!cell || !good || !isEquipment(good)) {
        line.push(cell ?? null);             // 非目标 / 空 / 无效 id：连引用都不换
        return;
      }
      const pieces = Math.max(1, cell.count); // 理论上恒 1；脏数据宁可多给钱，也不白拿走
      count += pieces;
      totalPrice += getRecyclePrice(good) * pieces;
      line.push(null);
    });
    result.push(line);
  });
  return { bag: result, count, totalPrice };
}
```

- **千万别写成 `if (price > 0) 拿走`**：定价为 0 的目标物品（活动白送、被单独配成 0）会被漏掉，而「价格」是数值口径、「是装备」是类型口径，两者不是一回事。
- **非目标物品保留同一个对象引用**（不是深拷贝、也不是 `{...cell}`）：单测可以直接断言 `result.bag[r][c] === 原cell`，一行就锁死「没动别人的东西」。
- **无效 id 单独分支**（同上：不认识它就不替它决定），与整理完全一致。

### 2. 定价：**曲线 × 倍率**，越贵的东西越不能逐件手写

```ts
// configs/growth.ts —— 与角色/怪物曲线同一形态（分段线性，档内线性 + 档间跳档）
export const equipmentRecyclePriceCurve: GrowthSegment[] = [
  { from: 1, to: 10, start: 10, perLevel: 5 },
  // …6 档，60 级约 4 万
];
export function equipmentRecyclePrice(level: number) { return Math.max(0, Math.round(sampleGrowth(equipmentRecyclePriceCurve, level))); }
```

- 类型层把字段设成**可选**（`Equipment.recyclePrice?: number`）→ 逐件不写就按等级生成，想单独定价才写 —— 与「战斗属性可写可不写」的既有套路完全一致（`buildEquipmentMap` 里 `entry.recyclePrice ?? equipmentRecyclePrice(level)`）。
- **前后缀变体乘同一个 rate**（与属性、名称品质同一口径）：超神·神级 = 基础价 × 4.2。这样「越强的装备越值钱」不需要额外规则。
- 定价函数放**已经引用了 growth 的那个配置模块**（olua 放 `configs/equipments`），别为一个 getter 新开模块依赖边。
- 写清量级锚点（回收价 vs 主要消耗货币的总量），否则以后没人敢调这条曲线。

### 3. 确认：不可撤销的操作用**两步确认**，别新造确认弹窗

```ts
// 第一次点击：不改数据，只报数 + 改文案 + 起超时
const summary = StorageManager.getBagRecycleSummary();
if (!summary.count) { GameUiHelper.createTip(TIP, "背包里没有可回收的装备"); return; }
this.pending = true;
this.setButtonText("确认回收");
GameUiHelper.createTip(TIP, `将回收 ${summary.count} 件，可得 ${summary.totalPrice} 元宝（再点一次确认）`);
this.timer = setTimeout(() => this.cancelConfirm(), layout.recycleButton.confirmTimeout);   // 3s
// 第二次点击：先复位再回收
```

- **为什么不用弹确认框**：多一层节点就要多处理层级、穿透与按压归属（见 skill `cocos-mouse-button-input` —— 那套坑刚踩过两轮）。两步确认零新增节点、零新增鼠标监听。
- **复位要处理三种出口**：超时、关弹窗、场景切换。`cancelConfirm()` 里**先清定时器、再判 `isValid(node)` 才碰节点** —— 定时器回调可能在节点销毁后才到（原生/浏览器 `setTimeout` 都在，引擎核心自己也在用）。
- **预览与实际回收必须复用同一个函数**：`summarizeBagRecycle(bag)` 直接调 `recycleBagEquipmentGrid(bag)` 再丢掉新背包，保证「按钮上写的数」和「真正到账的数」不可能对不上。

## 一点六、姊妹操作二：「丢弃物品」（不可撤销，且**没有选中态**）

整理是「不丢东西的重排」，回收是「把东西换钱」，丢弃是「把东西扔了」—— 第三件事，麻烦在**交互**而不是搬运：背包没有「选中格子」这个概念，也没有第三个鼠标键可用（左键已给「使用」、右键已给「穿戴」）。

### 1. 交互：模式开关 + 两步确认，零新增节点

```
底部按钮「丢弃」→ 进入丢弃模式（按钮文案变「退出丢弃」+ 飘字说明）
  → 点格子（第一次）：只报「名 ×数量」，记住这一格，起 3s 超时
  → 3s 内再点同一格：真的丢弃
  → 点别的格子：直接换成新目标（不逼玩家等超时）
  → 超时 / 点整理·回收 / 关弹窗：放弃待确认
```

- **为什么不用「长按物品」或「选中格子 + 确认框」**：长按要自己造计时与取消（触屏/鼠标两套）；确认框盖在弹窗上要额外处理层级、点击穿透与按压归属（见 skill `cocos-mouse-button-input`，那两轮坑刚踩过）。模式开关 **零新增节点、零新增鼠标监听**，代价只有一个按钮。
- **模式状态必须与其它操互斥**：点「一键整理 / 一键回收」时先 `exitDiscardMode()` —— 否则玩家整理完再点格子又把东西丢了。
- **模式要让状态可见**：按钮文案跟着切（`label_xxx` / `label_xxx_exit`，两份文案都在 `configs/texts`），进模式时再飘一句说明。只靠颜色/光标变化不够。
- **组件侧只做模式分流**，判定与提示全在数据层：

```ts
private onCellAction(row: number, col: number, action: BagCellAction) {
  if (this.discardMode) { this.onDiscardCell(row, col); return; }   // 丢弃模式下左右键都当丢弃
  if (action === "equip") StorageManager.equipFromBag(row, col);     // 原行为原样保留
  else StorageManager.useGood(row, col);
}
```

### 2. 数据层：拆成「预览 / 执行」两个方法（因为要两步）

```ts
// 报数用：看一眼不动数据（和回收的 summarize 同一思路）
static getBagDiscardPreview(row, col): { label: string; count: number } | null {
  const cell = this.findOnlineRole()?.bag[row]?.[col];
  if (!cell) return null;                                  // 空格 / 越界 → null，调用方据此提示
  return { label: getItem(cell.id)?.label ?? cell.id, count: Math.max(1, cell.count) };
}

// 执行：整格置空（**不做数量拆分**）
static discardBagGood(row, col): boolean {
  const role = this.findOnlineRole();
  const cell = role?.bag[row]?.[col];
  if (!role || !cell) { GameUiHelper.createTip(TIP_EMPTY); return false; }
  … 取名字与数量 → role.bag[row][col] = null → updateOnlineRole → RoleUIManager.refreshBag() → createTip(TIP_DONE)
  // 丢弃不动属性/战力，别顺手调 updateUi
}
```

- **搬运简单也别硬造纯函数**：与整理/回收不同，丢弃只是「把一格置空」，没有可测的搬运规则；这时**改用能跑真实数据层的沙箱**（`tools/lib/storage-sandbox.cjs`，见 skill `cocos-node-sandbox-test`），而不是为了统一形式再抽一个纯函数。
- **`getItem` 解析不出的 id 要允许清掉**：这类格子玩家根本看不见（视图层跳过不渲染），但它占着存档格子，允许用 id 当名字丢弃才是正确行为。
- **不动装备槽**：身上穿着的不在 `role.bag` 里，天然不受影响 —— 但要在单测里断言一次，防止以后有人「顺手也把槽位清了」。
- **不做「只丢几个」**：可叠加物品一次丢整格。要支持它得先引入数量输入控件，别在丢弃这条路上悄悄改语义（把口径写进提示文案：`…×{count}，丢弃后无法恢复`）。

## 一点七、姊妹操作三：「拖动改变格子」（规则是纯函数，难点在手势）

整理是「不丢东西的重排」、回收是「换钱」、丢弃是「扔掉」，拖动是「把东西挪个位置」—— 搬运最简单（一个 `moveBagCellGrid` 纯函数就够），难点全在**手势**：既要能拖，又不能把原来的「左键使用 / 右键穿戴」弄坏。

### 1. 落点规则：三类，按顺序判（纯函数）

```ts
// configs/items.ts
export function moveBagCellGrid(bag, from, to): { bag: BagCell[][]; moved: boolean } {
  const result = bag.map((row) => row.slice());             // 恒返回新数组，不改入参
  if (from 与 to 同一格) return { bag: result, moved: false };
  if (!source || target === undefined) return 同上;          // 起点为空 / 落点越界 → 什么都不做
  if (!target) { ① 落点是空格：整格搬过去（数量不变） }
  if (可合并(source.id, target.id)) { ② 同种可叠加：按 maxStack 合并，吃不完的留在原格 }
  return { ③ 其余（不同种 / 装备这类不可叠加 / 认不出的 id）：两格交换 };
}
```

- **合并要处理「吃不完」**：`merged = min(maxStack, 源 + 目标)`，超出部分**留在原格**（不是丢弃、也不是拒绝这次拖动）。只测「合并成功」会漏掉这个分支 —— 单测必须专门覆盖「落点格已经是 99 个」这一条。
- **「可合并」只有一种情况**：同 id **且**配置里 `stackable`。装备、认不出的 id 一律走交换 —— 不认识它就不替它决定数量（与整理/回收同一条老规矩）。
- **恒返回新数组、除起终点外其余格子连引用都不换**：单测用 `after[r][c] === before[r][c]` 断言，一行锁死「没动别人的东西」。

### 2. 手势：走 touch 通道（**别用鼠标通道**）

```ts
cell.on(Node.EventType.TOUCH_START, ..., this);   // 记起点（必须 clone，见坑 11）
cell.on(Node.EventType.TOUCH_MOVE,  ..., this);   // 超阈值才算拖动 → 建幽灵/高亮/压暗
cell.on(Node.EventType.TOUCH_END,   ..., this);   // 用指针位置 hitTest 找落点 → moveBagGood
cell.on(Node.EventType.TOUCH_CANCEL, ..., this);  // 打断也要收干净
```

三条理由（细节见 skill `cocos-mouse-button-input` 的「按住拖动一个 UI 元素」）：

1. 鼠标环境引擎会把 `MOUSE_DOWN/MOVE/UP` **模拟**成 `TOUCH_START/MOVE/END`（`input._simulateEventTouch`）→ 一套手势代码鼠标与触屏通用（项目里弹窗拖动 `Draggable` 也是这么写的）；
2. touch 通道的 `TOUCH_START` 命中节点**独占整段触摸** → 指针拖到哪儿、松在谁身上，`TOUCH_END` 都回到**起点格**（途中路过的按钮抢不走这次抬起）；代价是**落点必须自己算**：遍历格子用 `UITransform.hitTest(screenPoint)`（屏幕坐标口径），别指望"松手时命中的节点就是落点"；
3. **`MOUSE_MOVE` 绝不能注册在节点上**：节点一旦命中就吞掉它，全局的指针追踪（光标样式、按住走路的方向）会一起卡住。

### 3. 与「点击」共存：阈值 + `pressDragged`

- 位移小于阈值（写进配置，olua 用 10 屏幕像素）就当点击 → 原有 `bindPointerAction` 照常走（左键使用 / 右键穿戴）；这样「点错了变成拖动」不会发生；
- **进过拖动的这一次抬起不能再算点击**（否则松手会顺手把物品用掉/穿上）：用一个 `pressDragged` 标记，进入拖动时置位、**在下一次按下（TOUCH_START）时复位**。不要在落点处理里清 —— 鼠标环境 `MOUSE_UP` 与 `TOUCH_END` 的执行顺序（引擎当前是 TOUCH 先）不该成为前提；
- **右键不拖动**：`TOUCH_*` 事件不带按键（`_simulateEventTouch` 全程不看 `getButton()`），所以在鼠标通道的 `MOUSE_DOWN` 里记一个 `rightPress` 把它挡掉，保住「右键 = 穿戴」。

### 4. 表现：幽灵 + 高亮 + 压暗，数值全进配置

- **幽灵图标**跟着指针：挂在**弹窗/容器**下并**最后 addChild**（渲染在最上层），坐标用 `parent.getComponent(UITransform).convertToNodeSpaceAR(camera.screenToWorld(point))` 换算（父节点自己也可能被拖过，别省这步），再 `markClickThrough(ghost)` 让它不参与「点是否落在 UI 上」的判定；
- **落点高亮框**：Graphics 描边，摆到指针下的格子上（同上换算）；
- **源格物品**用 `UIOpacity` 压暗，松手/取消恢复（落子后会刷新重建，天然复原）；
- 阈值、幽灵尺寸/不透明度、压暗值、高亮尺寸/描边/颜色**全部写进布局配置**（olua：`bagGridLayout.drag`），组件里一个数值都不留。

### 5. 两个容易漏的收尾

- **背包一变，其它「待确认」状态全部复位**：拖动落子会刷新背包，`refresh()` 里顺手清掉「确认回收」的待确认与「待丢弃的那一格」—— 否则目标格的东西被换走/挪走后，玩家再点一次会误伤（两步确认的前提是「目标还是原来那个」）。
- **旧存档的背包尺寸要对齐**：读档时按 `bagRow × bagCol` 补齐/裁掉（olua：`normalizeBagGrid`）。尺寸不符时，整理与拖动会按**存档自己的尺寸**铺回，而界面格子是按当前配置生成的 → 物品会「铺进界面没有的格子」，看起来就像丢了东西。

### 6. 触摸归属：父级（弹窗）也在拖 → 「拖物品连带把窗口拖走」

这不是格子手势的锅，是**冒泡**：节点 `TOUCH_*` 在引擎派发时一律 `event.bubbles = true`（`node-event-processor` 的 `_handleTouchStart/Move/End`），格子上的触摸会沿 格子 → 行容器 → 网格 → **弹窗背景** 一路冒上去。而弹窗背景上通常挂着「按住可拖动整个窗口」的组件（olua：`components/input/Draggable`），它的 `TOUCH_START` 收到冒泡来的事件就把 `dragging` 置上，随后的 `TOUCH_MOVE` 把整个弹窗拖走 —— 现象就是「拖物品时窗口跟着跑」。

**修在网格容器上（一处），别改到每个格子上**：容器把四个触摸事件全收住。

```ts
// 网格容器（构造时登记一次，之后 refresh 重建格子也不影响）
this.on(Node.EventType.TOUCH_START,  this.stopTouchBubble, this);
this.on(Node.EventType.TOUCH_MOVE,   this.stopTouchBubble, this);
this.on(Node.EventType.TOUCH_END,    this.stopTouchBubble, this);
this.on(Node.EventType.TOUCH_CANCEL, this.stopTouchBubble, this);
private stopTouchBubble(event: EventTouch) { event.propagationStopped = true; }
```

为什么登记在容器上能一次兜住两种按下：

| 按下位置 | 谁独占这次触摸 | 事件怎么被停下 |
| --- | --- | --- |
| 有物品的格子 | 格子（它也注册了 `TOUCH_START`，命中列表里**更深的节点优先**） | 事件从格子往上冒泡，路过容器时被 `propagationStopped` 停下 → 弹窗收不到 |
| 空格子 / 网格空白处 | **容器自己**（没有更深的节点认领） | 事件在容器上就地停住 |

两条硬要求：

- **容器必须先有 `UITransform` 再登记触摸**（olua 是先 `applyColumnStyle(this, ...)` 再登记，顺序别调）。引擎 `pointer-event-dispatcher._sortPointerEventProcessorList()` 对列表里**每个**节点读 `trans!.cameraPriority`（非空断言），节点没有 `UITransform` 时**每次指针事件都抛空指针**（mouse / touch 事件都会触发这次排序）→ 整个预览的鼠标交互全废。这条同样是「给不带 UITransform 的节点注册鼠标事件」的坑，只是触摸也会踩。
- **只收 touch 通道**：鼠标通道的穿透拦截是另一条线（`utils/input/UiHit.blockClickThrough`），别混在一起，也别顺手注册 `MOUSE_MOVE`（它会吞掉全局指针追踪）。

**反向兜底（推荐一起做）**：让「整窗拖动」的组件在按下那一刻判一下 —— 按下点**自带拖动手势**（注册过 `TOUCH_MOVE`）时就不抢这次拖动：

```ts
private onTouchStart(event: EventTouch) {
  this.dragging = false;                     // 每次按下都从「不拖」开始（别留上一次的残留）
  if (event.target && event.target !== this.node
      && event.target.hasEventListener(Node.EventType.TOUCH_MOVE)) return;   // 子节点自己的手势优先
  this.dragging = true;
  event.propagationStopped = true;
}
```

`!== this.node` 不能省：拖拽柄（弹窗自己）也注册了 `TOUCH_MOVE`，一并拦掉弹窗就永远拖不动了。有了这条，以后往弹窗里塞滚动视图、滑条这类子手势不会再踩同一个坑（`ScrollView` / `Slider` 内部都注册 `TOUCH_MOVE`）。判的是 `event.target`（引擎给的**最初命中目标**，冒泡全程不变），不是 `currentTarget`。

> 别顺手把这个模式套到「弹窗里任何子节点」上：只有**自己有拖动/滑动/长按手势**的子节点才需要收住触摸或拒绝被抢。点击类子节点（按钮）本来就该让弹窗能拖 —— 玩家按在按钮上想搬窗口是很正常的操作。

数据层入口：`StorageManager.moveBagGood(from, to)` 只做「取角色 → 调纯函数 → **真的动了才落盘刷新**」；与整理同一口径 **不弹提示**（拖动的反馈就是位置/数量变化本身），无效拖动（拖空格 / 拖回原格 / 越界）静默返回 `false`。

单测：`node tools/test-bag-drag.cjs`（三类落点规则 + 合并溢出 + 认不出的 id + 无效拖动 + `normalizeBagGrid` + 存储搬运 + 接线断言）。**顺带把整理的「全部重排」口径也用断言钉住**：排完之后必须从第一个格子（0 行 0 列）起按行连续铺满、空格一律沉底（`isPackedPrefix`），别写出「带洞的整理」。

## 二、不变量（写的时候就盯住，单测逐条断言）

1. **行列数与入参一致**（别顺手把网格拍平成一维）
2. **数量守恒**：按 id 汇总 count，整理前后完全相等（这是「不丢物品」的唯一硬证据）
3. **配置表里查不到的 id 原样保留**：不合并、不拆堆，排在最后（老存档 / 已下架物品）
4. **不可叠加物品一格一件**（数量恒 1，不参与合并）
5. **可叠加物合并后按 maxStack 拆堆**（`250 → 99 / 99 / 52`）
6. **幂等**：连点两次整理，结果 `JSON.stringify` 完全一致

回收（不可撤销）另外这几条，一条都不能省：

7. **非目标物品连引用都不变**：位置、数量、对象身份三样都要断言（比「内容相等」更严格）
8. **件数与合计价 = 逐件累加**：用与实现不同的方式独立算一遍（直接从配置表取单价相加）来对照
9. **计价口径**：基础件 = 曲线值、每个变体 = 基础价 × 倍率、等级越高越贵（每条装备都断言，覆盖全部装备而不是抽样）
10. **幂等**：回收后的背包再结算必为空（`count 0 / totalPrice 0`）
11. **预览 = 实际**：`summarize` 与真正回收的结果逐字段相等
12. **边界四连**：空背包 / 只有非目标物品 / 装满目标物品 / 脏数据（叠着的不可叠加物）

丢弃（同样不可撤销）再加这几条：

13. **整格数量一起丢**：丢一格后可叠加物品**没有残留**（断言「包里已无该物品」，比「该格为 null」更能抓住「只减了 1 个」这类 bug）
14. **只动目标格**：邻格与另一角的物品，位置 / 数量 / id 三样都不变
15. **幂等 + 防御**：同一格再丢 → `false`；空格 / 负行号 / 越界行列 → `false` 且不抛异常
16. **只动在线角色、不动装备槽**：另一角色的背包原样；`equipments[slot]` 不变（防以后有人「顺手连槽位一起清」）

拖动（换格子）再加这几条：

17. **三类落点各断言一遍**：空格 → 整格搬（数量不变）；同种可叠加 → 合并成两格之和；其余 → 交换（起点拿到落点原来的物品）
18. **合并溢出**：落点已满 `maxStack` 时，超出的数量**留在原格**（断言落点 = maxStack、原格 = 剩余、总量守恒）
19. **无效拖动什么都不做**：起点为空 / 起终点同格 / 行列越界 → `moved === false`，且背包内容与格子引用全不变（不抛异常）
20. **可逆 + 除起终点外引用不变**：同一个物品拖过去再拖回来，背包 `JSON` 完全回到原状；其余格子 `after[r][c] === before[r][c]`

整理侧还要钉住一条**玩家口径**（用户明确提过）：

21. **从第一个格子起连续铺满**：整理后展平序列的前 n 格都有物品、其余全空（`isPackedPrefix`），第一个格子（0,0）就是排在最前的那件 —— 「整理 = 全部重排」，不许出现中间带空洞的结果

触摸归属（父级也在拖的场景）再加这两条：

22. **网格区域内的触摸不外传**：四个 `TOUCH_*` 都登记在**网格容器**上并 `propagationStopped = true`；且容器登记触摸**之前**已经拿到 `UITransform`（源码断言顺序，见坑 15）
23. **整窗拖动的组件不抢子节点的手势**：`onTouchStart` 里「按下点注册过 `TOUCH_MOVE` → 直接 return」，且判的是 `!== this.node`（弹窗自己仍可拖）

## 三、在 node 里单测配置层（本项目最值钱的通用技巧）

思路：配置表只用到引擎的 `Vec2 / Vec3 / Size / Color` 四个**纯数据类**，没有任何引擎行为 —— 用一个最小垫片顶替，就能把真实配置表拉进 node。

**这套引导代码要抽成共用模块**，别每个单测脚本抄一遍：

```
tools/lib/configs-sandbox.cjs     # 共用：findTsc + 垫片 + 编译沙箱 + check/finish 断言风格
tools/test-bag-tidy.cjs           # const outDir = prepare("olua-bag-tidy"); 然后 require(outDir + "/configs/items.js")
tools/test-bag-recycle.cjs        # 同上，只是沙箱目录名换成 olua-bag-recycle（互不干扰）
  └─ 运行时在 os.tmpdir()/<沙箱名> 下生成
       ├─ node_modules/cc/index.js   ← 垫片（Vec2/Vec3/Size/Color）
       └─ tsconfig.json              ← rootDir=assets, outDir=out, module=CommonJS
```

要点：

- **垫片**：`Color` 必须同时能吃 `new Color(255,255,255)` 与 `new Color("#DDDDDD")` 两种写法（配置表两种都用）；`Color.WHITE` 之类静态成员用后置赋值补上。
- **tsconfig**：`module: CommonJS`、`target: ES2019`（`?.` / `??` 会被降级）、`rootDir: <项目>/assets`、`outDir: <临时目录>/out`、`paths: { cc: [<项目>/temp/declarations/cc.d.ts] }`（类型仍用工程自己的声明）、`files: [assets/configs/items.ts]`（入口一个，依赖自动带上）。
- **运行时解析**：编译产物里是 `require("cc")`；把垫片放在 `<沙箱>/node_modules/cc/index.js`，产物在 `<沙箱>/out/...` 下就能自然解析到（不必配 `NODE_PATH`）。
- **tsc 自动探测**（工程里通常没装 typescript，Cocos 自带就够）：
  1. 环境变量 `TSC`
  2. `<项目>/node_modules/typescript/bin/tsc`
  3. `/Applications/Cocos/Creator/<版本>/CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin/tsc`
  - 都找不到就打印「用 `TSC=... node tools/xxx.cjs` 指定」并退出码 1，不要静默跳过。
- **跑法**：`node tools/test-bag-tidy.cjs` / `node tools/test-bag-recycle.cjs`，断言失败 `process.exitCode = 1`（能进 CI）。
- **操作不是纯函数时别硬抽**：像「丢弃」这种只是「把一格置空」、没有可测搬运规则的操作，改用 **storage-sandbox**（跑真实 `StorageManager` + 内存 `sys.localStorage`，见 skill `cocos-node-sandbox-test`），断言直接核对存档 —— 形式统一不如测到真东西。
- **共用模块只放「与用例无关」的东西**（找 tsc / 建沙箱 / `check` / `finish`）；断言与场景留在各自的单测脚本里 —— 而 `failed` 计数器这类状态放共用模块可以让两个脚本打印风格统一、互不影响（各自一个进程）。
- **配置层的硬前提**：`configs/` 不能依赖 `ui/`。这条约定在这个技巧下从「风格」变成「可测性」的硬要求（olua 的 `configs/types/entities/skills + ui/*` 正好满足）。

断言写法（别只断言「结果等于预期数组」—— 那种断言在数据变化后就失效，且说不清为什么不变量被破坏）：

```js
check(sameShape(grid, after), "行列数与入参一致");
check(totalsEqual(totalsOf(grid), totalsOf(after)), "物品一件不丢（按 id 汇总数量守恒）");
assertEquipmentOrder(flatOf(after), "场景 A");   // 装备排最前 / 等级降序 / 同等级按部位顺序
check(JSON.stringify(tidyBagGrid(after)) === JSON.stringify(after), "幂等");
```

场景至少覆盖：乱序混合（多类型 + 无效 id）、满包（77 格同种药 → 1 格 + 76 空位）、maxStack 拆堆、部位顺序、前后缀强度、同 id 装备不合并、幂等。回收侧再加：只搬目标类型、非目标引用不变、定价与倍率、预览 = 实际、空 / 只有非目标 / 满 / 脏数据。

**覆盖面比「挑几个用例」更值钱**：像「每件装备都有回收价」「所有变体的价 = 基础价 × 倍率」这类，直接**遍历整张配置表**断言（olua 是 555 件）—— 一条断言就能防住「以后新加装备忘了配价」。

## 四、踩过的坑

1. **解析不出配置的 id 被拆碎**：拆堆时写 `const maxStack = good?.stackable ? ... : 1;`，`good` 为 `null`（已下架物品）时兜底成 1 → 1 格 `ghost_item×2` 变成两格 ×1。正确做法是**先把 `!good` 单独分支出去原样保留**，再处理正常物品。这条只有「无效 id 原样保留」的断言能抓到。
2. **打包 loose 编译**：`[...map.values()]` 会被降级成 `[].concat(迭代器)` → 恒为空（编辑器里正常，打包后静默少数据）。配置层遍历一律 `map.forEach` / `Array.from`。
3. **`getItem` 返回副本时别在比较函数里反复调用**：77 个元素排序约 500 次比较 × 2 次浅拷贝；排序前建 `Map<id, good>` 缓存（注意用 `undefined` 判「未缓存」，因为 `null` 也是合法缓存值）。
4. **「已经很整齐」的判定**：用 ids/counts 拼指纹比对，别用 `JSON.stringify(role)`（装备/快捷键等无关字段一变就误判）。
5. **合并是「有损外观、无损数据」的**：格子数变少、空格变多，数量变化必须让玩家看得见 —— olua 已加「叠加数量角标」（`configs/items.getStackBadge` 判定 + `GameUiHelper.createGood` 渲染，`test-bag-stack-badge.cjs` 盯着），整理/合并/拆堆走 `refresh` 全量重建，角标自动跟随。
6. **回收按「价格 > 0」判定会漏物品**：定价是数值口径、类型是类型口径。判定必须用 `isXxx(good)`，价格只用来算钱。同理「非目标物品保留原引用」比「内容相等」更严格，也就更容易被单测抓到。
7. **不可撤销操作忘了复位状态**：两步确认的「确认中」状态有四个出口（超时 / 关弹窗 / 场景切换 / 真的回收），少一个就会留下一个挂着「确认回收」文案的按钮，反而更容易被误点。定时器回调必须先判 `isValid` 再碰节点。
8. **静态工具报假警时先怀疑工具**：olua 的点击穿透审计脚本按「名字 → 最近赋值」回溯节点来源，原本取**文件里首个**匹配，被同名的 `this.xxx = null`（清理残留引用那一句）抢先，把工厂产出的按钮判成「未登记」。改法：**从注册行往前**取最近一次赋值。加新 UI 元素时被审计拦下，先看一眼是不是这类「同名多赋值」的假警，别急着重构成工厂调用。
9. **沙箱单测里「新建角色」不是空背包**：`new Role(...)` 自带初始装备（初始武器 / 衣服等），于是「丢空格子返回 false」「丢完背包为空」这类断言会莫名失败 —— 失败的不是实现，是测试的初始条件。每次 seed 先清空：`role.bag = role.bag.map((row) => row.map(() => null))`（保持 7×11 结构），并**顺手加一条探测断言**把这个前提写进用例（「新角色自带初始装备（测试需先清空背包）」），免得后人再踩一次。
10. **回写复检别在后台 shell 里拼多文件**：`md5 -q $FILES` 在 `run_in_background` 的命令里会把整串当成一个文件名（报 `No such file or directory`），复检静默失败等于没复检。改**前台 python + hashlib**：先逐个算一遍指纹、`time.sleep(26)`、再算一遍比对（olua 一直用这个写法）。
11. **事件里的坐标向量是「复用的同一个对象」**：`event.getLocation()`（以及 `getUILocation()`）返回的是引擎内部那个 `Vec2`，会被下一次事件改写。拖动起点要跨事件留着比较，就必须 `.clone()` —— 不 clone 的话阈值判定永远为 0（起点被实时刷新成当前位置），表现为「怎么拖都不进入拖动」这种很难查的症状。
12. **拖完松手顺手把物品用掉了**：拖动与点击共用一次抬起（鼠标环境 `TOUCH_END` 与 `MOUSE_UP` 都会来）。只在落点处理里「结束拖动」是不够的 —— 拦不住随后到达的点击回调。要在点击入口用 `pressDragged` 这类标记拦（标记在**下一次按下**复位，别依赖两个事件的先后顺序）。同理，**拖动落子会刷新背包**，别忘了把「待确认回收 / 待丢弃那一格」一起复位。
13. **审计脚本报「点击元素未登记鼠标通道」时先看节点是不是经 `bindPointerAction` 登记的**：olua 的点击穿透审计原本只认 `blockClickThrough` 与工厂函数，格子上新增 `TOUCH_START/TOUCH_END`（拖动手势）后被判成漏登记 —— 其实 `bindPointerAction` 内部就完成了「鼠标通道 MOUSE_UP + trackUiPress 起点留痕」，与 `blockClickThrough` 等价。改法是让审计**认这个项目统一入口**（判定「该变量是不是它的第一个实参」，别用文件级 includes，不然同文件别的节点会被一起放过），而不是去加白名单或重复登记。
14. **「有变动才落盘」的指纹不能忽略空格**（真实用户反馈：「整理背包需要全部重新排列，物品从第一个格子开始重新排列」）：判定指纹若只拼「非空格物品」（`id×count,`），位置就不敏感 —— 「物品顺序没变、只是散着放」（把第 3 格的药拖到第 8 格）的指纹与整理完之后**完全一致**，`tidyBag` 判成「已经很整齐」直接 `return`，玩家点整理看不到东西回到第一格，容易误判成「按钮失效/整理没实现」。指纹要**逐格拼接、空格占一位**（`·`），并把「空背包」判断拆成独立方法（别拿空串兼作空背包）。单测必须覆盖「顺序没变只空着」「拖动后再整理」两种情形 —— 只测「乱序混合」是抓不到这个 bug 的。
15. **拖物品把整个弹窗一起拖走了**（真实用户反馈：「拖拽物品时，整个弹窗也会跟着拖拽」）：格子的拖动手势本身没问题 —— 是**触摸冒泡**到了弹窗背景的「整窗拖动」组件上（`TOUCH_START` 一到，它就认为玩家在搬窗口）。别去怀疑阈值、`hitTest` 或数据层；直接看「按住弹窗空白处能不能拖动窗口」：能，就是这条。修法见一点七·6（网格容器收住四个触摸事件 + 整窗拖动组件拒绝抢子手势）。**顺带记住那条连带坑**：容器要在**拿到 `UITransform` 之后**再登记触摸，否则引擎每次排序监听列表都会抛 `cameraPriority` 空指针。
16. **「点击元素漏了鼠标通道登记」被自己的审计脚本误报**：新增的「只停冒泡」触摸登记（容器不收点击、只做 `propagationStopped = true`）会被审计第 1 项判成「点击元素未登记鼠标通道」。这类登记**不是点击元素**（鼠标通道的穿透由它所在的外层弹窗面板负责），正解是给审计加一条**严判定**：回调必须是本文件里「只写了 `event.propagationStopped = true`」的方法（或同样只停冒泡的箭头函数），只要还干了别的事就仍按点击元素要求登记 —— 别加白名单（会让以后真的漏登记的同类节点一起被放过）。

## 五、自检清单

1. 搬运是纯函数吗？（不读存档、不刷 UI、不弹提示，入参出参都是二维数组）
2. 排序规则只有一处吗？改动排序不需要碰搬运流程吗？
3. 部位/类型顺序是复用既有配置顺序，还是又抄了一份？定价是不是也收敛成一处曲线（而不是逐件手写 / 逐件改）？
4. 「无效 id」有没有单独分支？（不合并、不拆堆、排最后；回收时原样留着）
5. 数据层有没有「无变动就 return」？（避免每次点都写 localStorage + 重建网格）
6. UI 按钮走的是工厂（自带穿透拦截）吗？坐标写在布局配置里吗？
7. 不可撤销的操作有没有二次确认？「确认中」状态的出口（超时 / 关窗 / 场景切换）都复位了吗？定时器回调判 `isValid` 了吗？
8. 预览用的数与实际执行的数是不是同一个函数算的？
9. 单测跑过吗？`node tools/test-bag-tidy.cjs` / `node tools/test-bag-recycle.cjs` / `node tools/test-bag-discard.cjs` 的不变量全绿吗？新加的同类操作是复用共用沙箱还是又抄了一遍引导代码？
10. 「没有选中态」的操作用模式开关了吗？模式与其它按钮互斥吗（点整理/回收先退出模式）？按钮文案能看出当前处于什么模式吗？
11. 拖动换格子：手势走的是 **touch 通道**吗（节点上有没有误注册 `MOUSE_MOVE`）？落点是**自己 hitTest 算**的吗（不是"松手命中的节点"）？阈值、幽灵/高亮/压暗的数值都在配置里吗？拖动过的那次抬起**能不能被点击逻辑吞掉**（`pressDragged`，且只在下一次按下复位）？拖动起点坐标 `clone` 了吗？右键能不能拖动（不该能）？
12. 背包内容变更后，「待确认回收 / 待丢弃那一格」复位了吗？旧存档的背包尺寸对齐了 `bagRow × bagCol` 吗？
13. `node tools/test-bag-tidy.cjs` 里有没有「从第一格起连续铺满」的断言（`isPackedPrefix`）？新加的拖动是复用共用沙箱还是又抄了一份引导代码？
14. 网格区域内的触摸收住了吗（四个 `TOUCH_*` 登记在**容器**上、`propagationStopped = true`，且容器已有 `UITransform`）？整窗拖动的组件有没有「按下点自带拖动手势就不抢」这条兜底？按住物品拖时窗口会不会跟着动？
15. 改完 assets 后 `grep` 核对磁盘 + `sleep 20s` 复检 md5（编辑器会周期性回写覆盖外部修改）。
