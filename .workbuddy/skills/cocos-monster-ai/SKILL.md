---
name: cocos-monster-ai
description: Cocos Creator 3.x 里给怪物/NPC 加「AI 行为」的成套做法：待机（原地换动作 + 偶尔小范围游走）、主动攻击（玩家进入检测范围追人、离开就停在原地）、普攻（含动画与伤害结算）、技能击退；以及一组必踩的引擎坑——AI 位移必须用运动学刚体 + linearVelocity（静态刚体挪不动）、运动学刚体会把动态刚体主角顶开（要"谁都不推动谁"得用 collider.sensor + MoveBlocking 手动阻挡预测）、Collider2D 的夹具在下一次物理步之后才建（addComponent 同帧写 size/sensor 有效，之后再改必须 apply()）、AnimationHelper 切出的 clip 是 WrapMode.Normal 只能靠 FINISHED 续播（每帧 play 会永远停在第 1 帧）、受伤这类一次性动作要单独回待机否则一直续播、怪物帧资源常常只有 stand/walk/run 齐全必须 getState 守卫并回退待机。触发场景：用户提到"怪物 AI"、"怪物追人"、"主动攻击"、"仇恨/检测范围"、"待机游走/巡逻"、"怪物移动速度"、"怪物打玩家"、"NPC 走动"、"怪物推动角色/被怪物挤开"、"角色不能穿过怪物"、"技能击退/击退怪物"、"怪物动画不播放/卡在第一帧"等。
agent_created: true
---

# Cocos Creator 怪物 AI（待机游走 / 追击玩家 / 普攻）

> **前置认知（#323 起）**：怪物行为权威已经搬到服务端 `MonsterAiService` —— 客户端**不再跑本地 AI**，
> 下面的「本地状态机」只剩两个用途：① 理解历史实现的语义（服务端那套是同口径重写）；
> ② `MonsterAI.stepServer` 做**位置趋近演出**（服务端发什么就走向哪，不做决策）。
>
> **#372 起怪物还会放技能**，客户端要做的三件事：
> - `monster-ai` 帧的 **`casts`**（`{instanceId, skillId, statusId?}`）= 放技能了 → 播动作 + 特效。
>   动作取技能配置的 `action`（`MonsterManager.playServerCast` → `MonsterAI.playServerAction`），
>   特效走 `EffectManager.playAt`（`SkillEffectConfig` / `SkillEffectActor` 是 `Pick<>` 收窄过的类型，
>   让 `SkillData`（没有 `onClick`）也能传）；
> - **普攻没有单独的出手事件**：用同帧 `hits` 反推，凡是没被 `casts` 覆盖的 instanceId 补播
>   `ACTION.ATTACK_NEAR`（用 `castIds` 集合去重，别让一次出手播两遍动作）；
> - **状态型技能**（如狂怒 / 硬化皮肤）没有伤害，只有 `casts.statusId` → 在怪物身上挂一份
>   循环特效节点（子节点，随怪物移动 / 销毁），台账放 `MonsterManager.statusEffects`，
>   每帧按 `expireAt` 清理。**不要复用 `StatusManager`**：它是「单 owner + 图标栏」的形状，
>   怪物需要每只一份且没有图标栏。


## 一、先分好层：数据归管理器，行为归 AI 静态类

- **管理器（如 MonsterManager）只管数据与生命周期**：生成、按区域刷怪、节点↔数据映射（`Map<Node, Monster>`）、查询、受击结算、换图 reset。不要往里塞行为逻辑。
- **AI 单独一个静态类（如 `ui/core/MonsterAI.ts`）管行为与动画**：
  - 入口 `static tick(monsters, player)`，由**组合根**（Game.update）每帧调用；`static replayCurrent(node)` 由怪物动画的 FINISHED 事件调用。
  - 每只怪的状态放 `private static states = new WeakMap<Node, MonsterAIState>()`，**节点销毁自动回收**，怪物数据对象上不挂运行时字段（数据要能直接存档/序列化）。
  - **参数由 tick 显式传入，不要做 provider 注入**：静态类跨场景活着，模块级持有节点/回调引用会留悬挂引用；`tick(map, this.roleDisplay)` 这种写法最省事。
  - 依赖方向保持单向：AI 不 import 管理器（`Game` 同时 import 两者并接线）。否则管理器 → AI → 管理器成环。

状态字段（时间一律用 `Date.now()` 毫秒时间戳，比累加 deltaTime 好调试）：

```ts
interface MonsterAIState {
  action: ACTION; direction: DIRECTION;      // 当前动作/朝向（动画续播要用）
  anchor: Vec3;                              // 停留点（生成位置 / 失去玩家时的位置）
  nextIdleAnimationAt: number;               // 下次换动作
  nextIdleMoveAt: number;                    // 下次随机走动
  idleMoveEndAt: number;                     // 本次走动结束（已过期=没在走）
  idleMoveDirection: Vec2;
  attackEndAt: number; nextAttackAt: number; attackPending: boolean;
}
```

## 二、位移：必须运动学刚体（Kinematic）+ linearVelocity

```ts
// ui/utils/physics/MonsterCollider.ts
export function addMonsterCollider(node: Node) {
  const rigidBody = node.addComponent(RigidBody2D);
  rigidBody.type = ERigidBody2DType.Kinematic;       // ← 关键：静态体挪不动
  const collider = node.addComponent(BoxCollider2D);
  collider.size = node.getComponent(UITransform).contentSize;
}
```

```ts
// 移动/停下（与主角 RoleDisplay 同一套做法）
const body = node.getComponent(RigidBody2D);
body.linearVelocity = new Vec2(dir.x * speed, dir.y * speed); // dir 为单位向量
body.linearVelocity = Vec2.ZERO;                              // 停下
```

- **别用静态刚体（Static）做会动的怪**：`addObstacleCollider`（Static）只能当不动的障碍，必须在节点上设 `linearVelocity` 才会位移。
- **⚠️ 运动学刚体会把主角顶开**（本技能早期版本写反了）：主角是**动态刚体**（`RigidBody2D` 默认 Dynamic + `gravityScale = 0`），Box2D 里运动学体质量无限大，撞上动态体时会**把它挤开**。两个人都在动就是"怪推着角色滑"。要"谁都不推动谁"必须走第三条（传感器 + 手动阻挡）。
- 两个非动态刚体之间确实**不产生碰撞**：怪彼此不互相阻挡、也不会被静态障碍挡住（跑动时会穿树穿墙，见"已知限制"）。
- 速度单位 = 刚体线速度（引擎 1 米 = 32 像素，与主角的 `ROLE_WALK_SPEED` 同口径即可直接比较快慢：怪 2、角色走 2、角色跑 4 → 跑能脱战）。**检测范围/攻击距离这类"地图尺度"的东西用像素**（Tiled 对象组坐标本来就是像素），不要和线速度混用一套单位。
- 每帧 `Vec2.ZERO` 与 `new Vec2(...)` 反复赋值是安全的（Box2D `SetLinearVelocity` 非零时会唤醒休眠体）。

### 碰撞盒属性什么时候生效（必踩）

`Collider2D` 的夹具不是在 `addComponent` 时建的：`onLoad` 只 `createShape()` 建壳，**真正的夹具在 `onEnable → PhysicsSystem2D._callAfterStep(this._init)`（下一次物理步之后）才创建**，`_init` 里一次性读走 `comp.size / comp.offset / comp.sensor / comp.group`。

- 所以 `addComponent` 之后**同一帧内**接着写 `collider.size = ...`、`collider.sensor = true` 是有效的（现有 `addObstacleCollider` / 角色碰撞体都靠这个）；
- 但如果夹具已经建好了再改：`set size` / `set sensor` **只改组件字段、不碰夹具**（`set size (v) { this._size = v; }`），必须显式 `collider.apply()`（内部 `_destroy()` + `_init()` 重建夹具）。
- `worldAABB`/`getWorldPoints` 读的是**实际夹具**，不会被组件字段骗到；反之调试显示若只读 `collider.size`，就可能和真实夹具不一致。

## 三、谁推动谁（角色 ↔ 怪物的碰撞关系）

需求常见表述："怪不会推动角色，追到就停下攻击；角色和怪都推不动对方，只有技能能推动"。三条物理关系分开处理：

| 关系 | 做法 |
| --- | --- |
| 静态障碍（树/墙/NPC） | 静态刚体 `addObstacleCollider`，引擎自带阻挡，角色推不动它 |
| 怪物 ↔ 角色 | 怪物 `Kinematic` + **`collider.sensor = true`**（无碰撞响应，谁都不推动谁）+ **手动阻挡预测** |
| 技能击退 | 唯一能推动位置的途径，脚本位移（见第五节） |

```ts
// 怪物：形状要留着（攻击距离判定读 worldAABB、调试显示读 size），但不要碰撞响应
collider.sensor = true;
```

手动阻挡放在 `ui/utils/physics/MoveBlocking.ts`（纯函数，角色与怪物共用）：

```ts
/** 速度驱动型移动的统一入口：用速度×帧时长预估位移，撞上就取消/沿单轴滑开，再换算回速度 */
export function resolveBlockedVelocity(node: Node, velocity: Vec2, blockings: Rect[]): Vec2 {
  if (!blockings.length || (velocity.x === 0 && velocity.y === 0)) return velocity;
  const self = getWorldColliderRect(node);                  // 自身 BoxCollider2D.worldAABB 的副本
  if (!self) return velocity;
  const step = Math.min(game.deltaTime, 0.05);              // 卡顿帧封顶，别一口气跳过阻挡物
  const allowed = resolveBlockedMove(self, new Vec2(velocity.x * step, velocity.y * step), blockings);
  return new Vec2(allowed.x / step, allowed.y / step);
}
```

`resolveBlockedMove` 的两条关键规则（缺一条都会出 bug）：

1. **只挡"本来没重叠、这一步会重叠"的移动**：已经重叠的阻挡物直接放行 —— 否则怪贴到角色身上时，角色任何方向都被判碰撞，被永久卡死。
2. **整体位移被挡就依次试单轴**（`(dx,0)` / `(0,dy)`）→ 贴着怪侧滑，而不是整帧停住。
   `Rect.intersects` 用严格 `<` 比较，**边贴边也算相交** → 正好停在贴身处、不会穿模。

角色侧（`RoleDisplay.updateWorldPosition`）：`rigidBody.linearVelocity = resolveBlockedVelocity(this, 期望速度, MonsterManager.getBlockingRects())`；管理器只是把 `monsterMap` 里存活怪的 `worldAABB` 收集成 `Rect[]`（每帧几十个小对象，开销可忽略）。

**追击不要套阻挡**：`attackRange`（如 60px）常常**小于双方体积之和**（怪 100×100 + 角色 40 → 中心距要 ≥70 才不重叠），一按体积挡，大体积怪会停在攻击距离之外、永远打不到人。要被推的只有"怪踩到人身上"，所以只在**待机随机走动**时避开玩家，追击照旧直线贴近。同理，怪物被击退时也**不做阻挡**（击退就是要位移穿过去）。

**已知取舍**：怪贴上来时和角色是**重叠**的（不再互相挤开）；此时角色仍能走开（已重叠放行），但也可以从怪身上穿过去 —— 这是"不推动"约束下的必然结果。

### 技能击退（唯一能推动位置的途径）

击退写成"状态 + 时长"，而不是一次性设位置（否则撞上别的逻辑会被覆盖）：

```ts
// MonsterAIState 增加：pushEndAt / pushDirection(单位向量) / pushSpeed
static push(node, direction, distance, duration = monsterAI.pushDuration) {
  const len = Math.hypot(direction.x, direction.y);
  if (!isValid(node) || len <= 0 || distance <= 0 || duration <= 0) return;
  const state = this.getState(node);
  state.pushDirection = new Vec2(direction.x / len, direction.y / len);
  state.pushSpeed = distance / (duration / 1000);   // 距离/时长 = 匀速速度
  state.pushEndAt = Date.now() + duration;
  state.attackEndAt = 0; state.attackPending = false;   // 打断手上的普攻（被推着还打人很怪）
}
```

- `tickMonster` 里**击退判定放最前面**（优先级高于"普攻动作中"），击退期间 `return`，不推进任何别的行为（否则 AI 会立刻把速度改回追击/待机）；击退期间照旧更新 `anchor`（落点成为新的游走中心）。
- 触发链建议：技能配置上加可选字段 `push?: { distance; duration? }` → `SkillManager.release` 在调用技能实现后统一处理（方向 = 施法者 → 目标），技能实现里也能自行 `monsters.push(...)`（群体/区域技能）。`SkillMonsterProvider` 加 `push(...)` 即可，怪物管理器转发给 AI。
- **一次性动作要单独处理**：击退期间播的是受伤动作（`ACTION.INJURED`），它播完会被 `replayCurrent` 当成循环动作**一直续播受伤**（看着像怪卡在挨打）。在 `replayCurrent` 里维护一个 `ONCE_ACTIONS` 名单（`[ACTION.INJURED]`），命中就切回该朝向的 stand 并改 `state.action`，不要 `play` 回去。
- 早期 `Array.prototype.includes` 在本题库的 `tsconfig.check.json`（lib 低于 es2016）会报 TS2550，用 `indexOf(...) >= 0`。

## 四、动画状态机（最容易做错的地方）

**引擎事实**：`AnimationHelper.createAnimation` 建出的 clip 一律 `WrapMode.Normal`（播一次就停），**播放器不会自己循环**。循环是靠 `FINISHED` 事件里重新 `play(当前动作名)` 实现的（RoleAppearance 就是这么做的）。

所以 AI 里：

```ts
/** 只有动作或朝向变了才切；缺帧回退待机；播完由 FINISHED → replayCurrent 续播 */
private static playAction(animate: Animation, state: MonsterAIState, action: ACTION, direction: DIRECTION) {
  const resolved = animate.getState(getAnimationName(action, direction)) ? action : ACTION.STAND;
  if (state.action === resolved && state.direction === direction) return;   // ← 不加这句必卡第 1 帧
  state.action = resolved; state.direction = direction;
  animate.crossFade(getAnimationName(resolved, direction), 0.2);
}

static replayCurrent(node: Node) {   // 挂在动画节点的 FINISHED 上
  const animate = this.getAnimate(node); if (!animate) return;
  const s = this.states.get(node);
  const name = getAnimationName(s?.action ?? ACTION.STAND, s?.direction ?? DIRECTION.DOWN);
  if (animate.getState(name)) animate.play(name);
}
```

- **绝不能每帧 `play()/crossFade()`**：每帧重启 → 动画永远停在第一帧（症状就是"怪走路像贴图"）。
- `Animation.getState(name)` 在 clip 不存在时**返回 null（.d.ts 骗人说是 AnimationState）**，一定要用它做守卫，否则 `play()` 刷 "animation not found" 警告，且动画停留在最后一帧不动。
- 切换动作前先问"这个方向有帧吗"：实测 220 个怪物帧目录里**只有 stand/walk/run/test1 八向齐全**，`attack_near` 只有部分方向，`attack_skill_1/test3/attack_far/injured/a1/die` 全无 → 缺帧一律回退该朝向的 stand。查帧是否齐全用 bin 目录里 PNG 的序号区间（一个动作占 `8 方向 × 10 帧 = 80` 个序号，方向顺序 UP、RIGHT_UP、RIGHT、RIGHT_DOWN、DOWN、LEFT_DOWN、LEFT、LEFT_UP）。

## 五、行为循环的形态

```ts
tickMonster(node, monster, player) {
  if (!isValid(node) || monster.hp <= 0) return;            // 死亡/销毁的怪直接跳过
  const animate = getAnimate(node); if (!animate) return;
  const now = Date.now(); const state = getState(node);
  if (now < state.attackEndAt) { stop(node); return; }      // 出手期间站定把动作打完
  if (state.attackPending) { state.attackPending = false; hitPlayer(...); }
  const d = player ? distance(node, player) : Infinity;
  if (monster.aggressive && player && d <= monster.detectRange) {
    state.anchor.set(当前坐标);                             // 停留点跟着走 → 失去目标即停在这
    state.idleMoveEndAt = 0;                                // 打断正在进行的游走
    state.nextIdleMoveAt = Math.max(state.nextIdleMoveAt, now + idleMoveInterval[0]);
    return chase(...);
  }
  stayIdle(node, monster, state, animate, now);
}
```

- **追击**：`d > attackRange` → 朝玩家移动 + `WALK` 朝玩家；`d <= attackRange` → 停下 + 按 `attackInterval` 出手（出手期间 `attackEndAt` 锁住移动，避免边打边走）。
- **伤害在动作播完后结算**（与角色打怪一致：挥击 → 结算），用一个 `attackPending` 标记；结算时再校验一次距离，玩家跑掉就落空。
- **待机**：站定 + 到点随机换动作（动作与朝向都随机，动作池可配）+ 到点朝随机方向小走一段（减速倍率）。随机走动要**限制在停留点附近**：

```ts
// 离 anchor 超过 wanderRadius 就朝回走，否则完全随机 → 怪不会越走越远
const dx = p.x - anchor.x, dy = p.y - anchor.y, len = Math.hypot(dx, dy);
const dir = len > wanderRadius ? new Vec2(-dx / len, -dy / len) : randomUnitVector();
```

- 进入追击时把待机计时往后推（`Math.max`），这样玩家跑掉后怪会先原地站一会儿再游走，观感更像"停下来张望"。

## 六、怪打玩家（结算 + 刷新）

```ts
const role = StorageManager.findOnlineRole();              // ← 只在结算时读，别每帧读（localStorage 反序列化）
if (!role || role.hp <= 0) return;
const damage = applyHitDamage(role, monster);              // 与角色打怪同一套 BattleMath
GameUiHelper.showDamageText(player, damage);
StorageManager.updateOnlineRole(role);                     // 落盘
StorageManager.updateUi(role);                             // 血球/信息栏
```

## 七、给配置加字段（批量改 200+ 条）

怪物配置按 id 一条条手写时，加字段用脚本插到每条固定行之后（本例插在 `label:` 行后），并按 `monsters.set("id"` 跟踪当前 id 以便给个别怪开特殊值：

```python
cur = {"id": None}
for line in src.split("\n"):
    m = re.match(r'monsters\.set\("(\d+)"', line)
    if m: cur["id"] = m.group(1)
    out.append(line)
    if re.match(r'^\s*label: "', line):
        out += ["  moveSpeed: 2,", f'  aggressive: {"true" if cur["id"] in ON else "false"},', "  detectRange: 200,"]
```

- 字段设成**必填**（接口不写 `?`）能靠 tsc 兜住"新增怪忘配"；批量插入后跑一次 tsc 就知道了。
- 行为节奏这类**全员共用**的参数不要塞进每条配置，另外导出一个 `monsterAI = {...}` 常量块（普攻间隔/距离/动作时长、待机动作池、游走间隔与半径），文档注释写清单位。

## 八、验证清单（Cocos 项目专用）

1. `NODE_PATH=... node .../typescript/bin/tsc -p /tmp/tsconfig.check.json`，**看总数是否等于基线**（本机基线 63 条全是引擎 cc.d.ts/jsb.d.ts 噪声），过滤出非引擎行必须为空。
2. 新增 assets 文件必须补 `.meta`（复制同类型模板、随机 uuid、检查与既有 uuid 不重复），否则编辑器重分配 uuid。
3. 批量改动后计数校验：`grep -c "moveSpeed: 2,"` 应等于配置条目数。
4. **Cocos 编辑器运行时会周期性把旧内容回写覆盖外部修改** → 改完 `sleep 10~15` 后再复检一次（异常症状：同一次编辑里靠前的改动被覆盖、行号对不上）。
5. 多模式搜索用 `grep -E`（本环境 shell 的 grep 不支持 `\|` 交替，会静默假阴性，容易误判"改动被回写"），或直接用编辑器的 Grep 工具。

## 九、已知限制（提前跟用户讲清，别当成 bug）

- **无寻路**：直线追击。Kinematic 刚体**不与静态障碍（树/墙）发生碰撞解析** → 怪可能穿树穿墙；要绕障得引入寻路或射线避让。
- 检测只针对**传入的那个玩家节点**；多玩家需把 tick 的 player 改成"返回最近玩家"的查询。
- 玩家死亡流程若未实现，血量到 0 后怪不再造成伤害但仍会追（可自行在 hitPlayer 里对 hp<=0 提前返回）。
- 怪物 `contentSize` 若是 `new Size()`（0×0），碰撞盒与点击区就是个点——这是配置缺口，不是 AI 的问题。**注意 0×0 的怪既不会推人、也几乎挡不住角色**（传感器形状退化成一个点），用户报"怪推人"时先看是哪几只（`contentSize` 有实尺寸的那几只才是元凶）。
- 传感器碰撞盒不能让角色穿过怪，但**角色从别的怪身上"被压住"时允许走开**（MoveBlocking 的已重叠放行）——所以视觉上会看到角色与怪重叠，这是设计取舍，不是漏判。
