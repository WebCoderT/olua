---
name: cocos-view-lifecycle
description: Cocos Creator 3.x 里「随数据出现的动态视图」（选中目标的光圈/信息面板、跟随型特效、指示器）的生命周期做法与必踩坑：引擎 isValid(value, strictMode?) 的 strictMode 没有默认值 → destroy() 当帧 isValid 仍返回 true（只判 Destroyed 不判 ToDestroy），导致有效性判据弱的一方多活一帧；创建分支「面板在→光圈一定在」一次性重建两个视图会把仍存活的旧节点连同引用一起丢弃 → 孤儿节点既不再更新也不再销毁、永久残留在场上（典型症状：怪物死亡后脚下选中光圈还在）。含视图有效性判据与数据判据对齐、面板/光圈各自独立复用与重建、Node 子类视图的 isValidNode 约定，以及第三类症状「视图要重进游戏/重进场景才更新」的成因——宿主组件缓存了数据实例、刷新方法没有「用前重读」（跨操作边界重读、操作内部复用）。触发场景：用户说"怪物死亡后选中效果/光圈还在"、"选中光圈残留/不消失/卡住不动"、"指示器不跟随"、"面板消失了光圈还在"、"动态面板/特效没销毁"、"目标死了特效还在"、"isValid 判断失效不准"、"destroy 之后 isValid 还是 true"、"切换开关/勾选后 UI 不实时更新"、"要重新进游戏才生效"、"改了状态没反应"、"异步装载帧动画的回调里该用什么判据"、"列表/弹窗刷新后动画装到了销毁的节点上"、"删掉自建的 Animation 组件脚本改用 AnimationHelper"。
agent_created: true
---

# Cocos Creator 动态视图（跟随型面板 / 光圈 / 指示器）生命周期

适用对象：**选中目标才出现、目标消失就该消失**的视图——怪物信息面板、脚下选中光圈、
跟随怪物的指示器/血条/标记、跟随角色的状态特效节点等。共同特征：视图的生命周期由**数据**（数据层里目标还在不在）
决定，但代码里往往写成由**节点**（`isValid(node)`）决定，两者不对齐就是各种"残留"的来源。

## 一、核心引擎事实：`isValid` 默认不检查「待销毁」

引擎源码（`cocos/core/data/object.ts`）：

```ts
export function isValid<T> (value: T | null | undefined, strictMode?: boolean): value is T {
    if (typeof value === 'object') {
        return !!value && !((value as any)._objFlags
            & (strictMode ? (CCObjectFlags.Destroyed | CCObjectFlags.ToDestroy) : CCObjectFlags.Destroyed));
    }
    return typeof value !== 'undefined';
}
```

**`strictMode` 没有默认值**，`isValid(node)` 等价于 `isValid(node, undefined)` → falsy → **只判 `Destroyed`，不判 `ToDestroy`**。
而 `Node.destroy()` 是「当帧标记 + 帧末销毁」：

```ts
public destroy (): boolean {
    if (super.destroy()) {      // _objFlags |= ToDestroy，进 objectsToDestroy 队列（帧末 _deferredDestroy 处理）
        this.active = false;    // 立刻不可见，但对象还在
        return true;
    }
    return false;
}
```

结论（第 0 帧死亡、第 1 帧真正销毁）：

| 判定 | 死亡当帧 | 下一帧 |
|---|---|---|
| `isValid(node)` | **true**（坑！） | false |
| `isValid(node, true)` | false | false |
| `node.activeInHierarchy` | false | false（已销毁） |
| 数据层判据（如 `map.get(node)`） | 已删除 → 失效 | 失效 |

所以「目标死了但节点还在同一帧」时，**只看 `isValid` 的代码会以为目标还活着**。

## 二、症状 → 成因（本项目真实案例）

现象：怪物死亡后，怪物信息面板正常消失，但**脚下的选中光圈永久留在原地**（不跟随、不消失，重进游戏才没）。

链路（挂机/快速攻击场景，`Game.update` 里 `AutoBattle.tick` 在 `roleDisplay.update()` **之前**）：

1. 第 0 帧：怪物死亡 → `MonsterManager.hurt` 里 `monsterMap.delete(target)` + `target.destroy()`（`ToDestroy`，`active=false`）。
2. 第 0 帧后续：
   - 面板 `update()`：`isValid(target)` 为 true（坑），但**数据判据 `getMonsterData` 返回 null → 面板销毁**，`monsterInfo = null`；
   - 光圈 `update()`：只判 `isValid(target)` → **true → 光圈继续存活**（判据比面板弱一帧）。
3. 第 1 帧：`AutoBattle.tick` 选了新目标 → `setTarget` → `selectMonster(newTarget)`：

```ts
// 旧写法（错）
if (!this.monsterInfo) {                       // 面板没了 → 走"重建两个"分支
  this.monsterInfo  = infoFactory(target);     // 建新面板
  this.monsterSelect = selectFactory(target);  // 建新光圈 + **直接覆盖引用**
  return;                                      // ← 第 0 帧那个还活着的光圈被丢弃
}
```

4. 被覆盖的旧光圈：**没有任何引用**→ 再也不会被 `update()` 驱动、也永远不会被 `destroy()` → 冻在尸体位置直到换场景。

两个独立的错都要修：**判据不对齐**（第 2 步）+ **重建时覆盖引用**（第 3 步）。只修一个都不彻底。

## 三、写法一：视图有效性判据必须与数据判据一致

面板/光圈这类视图，`update()` 的返回值就是"还该不该活着"，判据要**对齐到最强的那个**（数据层），
不要一半用节点、一半用数据：

```ts
/**
 * 每帧驱动，返回 false = 目标已死亡/移除，视图将被销毁
 * 判据与同类视图（怪物信息面板）完全一致：节点失效 **或** 数据已消失/血量归零
 */
update(): boolean {
    if (!this.target || !isValid(this.target)) return false;          // 节点级
    const monster = MonsterManager.getMonsterData(this.target);       // 数据级（关键）
    if (!monster || monster.hp <= 0) return false;
    // ...跟随/刷新
    return true;
}
```

宿主侧（角色/管理器）对"当前选中目标"的**同一个判据**也要抽成一个函数，别在别处写第二套：

```ts
update() {
    // 选中状态只由点击改变，但目标消失（死亡/移除）必须同步取消
    if (this.target && this.isTargetGone(this.target)) this.setTarget(null);
}

private isTargetGone(target: Node): boolean {
    if (!isValid(target)) return true;
    const monster = MonsterManager.getMonsterData(target);
    return !monster || monster.hp <= 0;      // 引擎的 isValid 默认不判 ToDestroy，只判节点会多残留一帧
}
```

视图数量多时，把这个判据放在**数据层**（管理器的 `isAlive(node)`）供所有视图复用。
只需要"已销毁"语义时写 `isValid(node, true)`，**但要显式传 true**（默认不传就是宽松模式）。

## 四、写法二：多个视图各自独立复用/重建，绝不整体覆盖

同一个目标常常配多个视图（面板 + 光圈 + 标记 + 血条）。**不要让它们共享一个创建分支**：

```ts
static selectMonster(target: Node | null) {
    if (!target) { this.destroyInfo(); this.destroySelect(); return; }
    // 每个视图独立：存活就复用（切目标），失效/缺失就"先销毁残留引用、再新建"
    if (this.info && this.info.isValidNode()) this.info.select(target);
    else { this.destroyInfo(); this.info = this.infoFactory ? this.infoFactory(target) : null; }

    if (this.select && this.select.isValidNode()) this.select.select(target);
    else { this.destroySelect(); this.select = this.selectFactory ? this.selectFactory(target) : null; }
}
```

要点：
- **任何 `this.xxx = factory()` 之前，必须先 `destroyXxx()`**（把旧引用先解掉），否则就是孤儿节点制造机。
- 不要用「A 存在 ⇒ B 一定存在」这种耦合前提做分支；A、B 的生死由各自判据独立决定（见上一节）。
- 每帧巡检（`updateXxx()`）里 `!view.isValidNode() || !view.update()` → 销毁并**置空引用**，保证引用与节点同生命。

## 五、Node 子类视图的约定（本项目）

视图是 `export default class X extends Node`（不是 Component），所以：

```ts
constructor(target: Node) { super("节点名"); /* 建子零件 */ this.select(target); }

select(target: Node) { this.target = target; }      // 复用：只换跟随目标，不重建特效

isValidNode(): boolean { return isValid(this); }    // 供管理器校验并清理引用（Node 子类没有 node 属性）

/** @returns false = 目标失效，调用方销毁本视图 */
update(): boolean { /* 见上一节 */ }
```

- 视图的**驱动**由管理器的每帧 `updateXxx()` 调用，视图自己不做常驻监听；因此**视图节点一旦被丢掉引用就等于石沉大海**——这是"残留"类 bug 的放大器，务必遵守第四节。
- 生命周期覆盖三件事：取消选中（点空地）、目标失效（死亡/移除）、场景卸载（组合根 `clearViews()`）。

## 六、刷新时读的数据必须是最新的（长生命周期组件不得缓存数据实例）

第二类「视图不更新」的成因不在节点判据，而在**数据新鲜度**：宿主组件在进场景时缓存了一份数据实例，
之后外部（弹窗/商店/任务）改的是同一份数据的**另一个实例**并落盘 → 宿主读旧快照 → 视图不刷新。
典型症状：**改完开关/设置要重进游戏（重进场景）才生效**，而数据层其实是写成功的。

本项目实例（2026-10-03 战魂外显）：存储层是「每次读都反序列化」的写法，**每次调用都返回新对象**：

```ts
static getRoles(): Role[] { return JSON.parse(sys.localStorage.getItem("roles") ?? "[]"); }
static findOnlineRole() { return this.getRoles().find((r) => r.id === selectedId); }  // 每次新对象
```

`RoleDisplay.this.role` 只是进图那一刻的快照；战魂弹窗里 `role.soulShow = !role.soulShow` 改的是
它自己刚读到的那份并 `updateOnlineRole` 落盘 → 主角组件读到的 `soulShow` / `soulOfWar` 仍是旧值，
于是「勾选外显」「升级换形态」都要重进游戏才生效。修法 = 视图刷新方法**用前重读**：

```ts
/** 由 UI 层（RoleUIManager.updateSoulShow）触发，签名不带参数 → 必须自己重读最新数据 */
updateSoulShow() {
    const role = StorageManager.findOnlineRole() ?? this.role;   // 用前重读，读不到才退回快照
    if (this.soulShowNode && isValid(this.soulShowNode)) this.soulShowNode.destroy();
    this.soulShowNode = null;
    if (!role.soulShow) return;                                  // 后续判断一律用 role，不用 this.role
    ...
}
```

判定规则（自查清单）：

- 方法体内**读缓存字段（`this.xxx`）来决定节点增删/外观**的，全都要自查是否会被外部落盘改动。
- **能传参就传参**：带参数版（`updateOutShow(role)` / `updateHead(role)`，由 `RoleUIManager.updateRoleData` 带新对象进来）
  天然新鲜；无参版必须自己重读。
- 「先落盘再通知」的路径（升级、购买、兑换）尤其要注意：调用方闭包里的那个实例**在落盘后也已过期**，
  所以「顺手把闭包里的数据传进去」同样是错的，必须重读。
- ⚠️ 与另一条规则不矛盾：**跨操作边界重读，操作内部复用**。同一操作内（读 → 改 → 写）必须复用同一实例，
  否则改动不落盘（见 PROJECT-NOTES「数据读写坑」）。
- 症状鉴别：**要重进游戏/重进场景才生效** = 数据新鲜度问题（本节）；**残留、不消失、冻在原地** = 节点判据/引用问题（第一～四节）。

## 七、排查清单（碰到"视图残留"按顺序查）

1. 残留视图的判据是不是只用了 `isValid(节点)`？（对比同类视图的判据，通常数据判据那个是对的）
2. 是否有多个视图共用创建分支、重建时覆盖引用？（grep `= factory(` / `selectFactory`）
3. 残留节点还 `update()` 吗？如果它冻在原地不动 → 一定是失去了引用（第 2 条），不是判据问题。
4. 数据层和视图层的"在不在"是否同一个判据？两边各写一套必然漂移。
5. 想快速验证成因：在死亡处把 `isValid(x)` 打印出来，死亡当帧打印 true 就是本 skill 第一条。
6. 视图**要重进游戏/重进场景才更新**（不消失也不残留，就是"没变"）→ 查数据新鲜度：宿主是否缓存了数据实例、刷新方法有没有「用前重读」（第六节）。

## 八、异步装载回调（图集帧 / 帧目录）里的节点判据

「先建节点 → 再异步装载帧动画」是工程里的标准写法（`AnimationHelper.loadFramesFromAtlas(...).then(...)`、
`playLoopWithDir` / `playOnceWithDir`）。回调触发时节点可能已经不存在，这里的判据要**显式用严格模式**：

```ts
const node = UiHelper.createSprite(animationName, "");   // 先建节点并挂到父上
AnimationHelper.loadFramesFromAtlas(atlasSrc).then((frames) => {
    // 帧多半有缓存 → 回调就在**当帧的微任务**里执行；若本帧刚 destroy 过同款节点，
    // isValid(node) 仍返回 true（第一节的表），动画会被装到一个已进销毁队列的节点上
    if (!isValid(node, true)) return;
    AnimationHelper.playLoopWithFrames(animationName, node, frames, frameRate);
});
```

- **典型触发场景 = 列表 / 弹窗刷新**：`showXxxUI()` 先 `destroy()` 旧节点、再建新节点，两件事在**同一帧**。
  选角预览、头像、状态图标、怪物列表这类"带帧动画的列表项"都算（本项目实例：`GameUiHelper.createRolePreview`，
  调用方 `RoleSelector.showOwnerRolesUI` 正是当帧先销毁再重建）。
- `playLoopWithFrames` / `playOnceWithFrames` 内部已有 `if (!spriteFrames.length) return;`，回调里不必再判帧数。
- 组件级同理写 `isValid(animate, true)`；只有确实需要"已销毁"语义时才用默认模式。
- 别再自建动画组件脚本来播图集帧（本项目已删掉 `assets/scripts/AnimationPlayer.ts`：它就是"图集帧 + 自建 Animation +
  `sample` 帧率"的写法，与 AnimationHelper 重复）——统一走 AnimationHelper，能吃到帧/片段缓存，也不会往同一节点上叠加第二个 Animation。

## 九、相关

- 动态加 UI 的三条坑（Layout 重排 / 图层继承 / `removeAllChildren` 只摘不销毁）：skill `cocos-collider-debug-overlay`
- 怪物 AI 的行为与动画分层、`WeakMap` 状态表：skill `cocos-monster-ai`
- 自动战斗的选目标/换目标节奏（换目标的时机正是本坑的触发窗口）：skill `cocos-auto-battle-a-star`
